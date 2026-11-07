//! Bounded Differential Behavioral Equivalence Gate (Bisimulation).
//!
//! Complies strictly with Section 7 of `L2_IMPLEMENTATION_READINESS_REPORT.md`:
//! - Compares dual revisions ($R-1$ and $R$) along basic block execution paths.
//! - Distinguishes between:
//!   * `SOUND PROOF OF EQUIVALENCE`: Structural algebraic proof that return expressions are identical.
//!   * `COUNTEREXAMPLE`: Concrete input causing behavioral divergence, sealed in a SHA-256 Incompatibility Witness.
//!   * `LIKELY_EQUIVALENT (bounded)`: Advisory signal only (failed on strict gate).
//!   * `UNKNOWN`: Fails closed when encountering unmodeled local mutations or budget exhaustion.

use crate::solver::{eval_term, ConcreteValue, Constraint, SolverVerdict, Term, Tier1Solver};
use crate::symbolic::{parse_java_condition, parse_java_expression, strip_enclosing_parens};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Instant;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncompatibilityWitness {
    pub file: String,
    pub method_name: String,
    pub base_revision: String,
    pub candidate_revision: String,
    pub inputs: BTreeMap<String, ConcreteValue>,
    pub base_output: String,
    pub candidate_output: String,
    pub base_path_condition: String,
    pub candidate_path_condition: String,
    pub witness_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BehaviorVerdict {
    /// Formal algebraic proof that all inputs produce identical outputs across revisions.
    SoundProofOfEquivalence {
        method_name: String,
        paths_evaluated: usize,
        proof_axioms: String,
    },
    /// Concrete diverging input discovered, sealed with SHA-256 witness.
    Counterexample(IncompatibilityWitness),
    /// Bounded search found no diverging input within domain/budget. Permitted as advisory only.
    LikelyEquivalentBounded {
        method_name: String,
        paths_evaluated: usize,
        reason: String,
    },
    /// Method signatures or parameter types differed between revisions.
    SignatureMismatch { method_name: String, reason: String },
    /// Out of scope or budget exceeded (fails closed).
    Unknown { method_name: String, reason: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct MethodPathSummary {
    pub path_id: usize,
    pub condition_expr: String,
    pub constraints: Vec<Constraint>,
    pub return_expr: String,
}

/// Verifies behavioral equivalence of a method across dual Git/file revisions.
pub fn verify_method_behavior(
    file_path: &str,
    target_method: &str,
    base_source: &str,
    candidate_source: &str,
    base_rev: &str,
    candidate_rev: &str,
    budget_ms: u64,
) -> BehaviorVerdict {
    let start_time = Instant::now();
    let solver = Tier1Solver::new(budget_ms);

    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .is_err()
    {
        return BehaviorVerdict::Unknown {
            method_name: target_method.to_string(),
            reason: "Failed to load tree-sitter-java grammar".to_string(),
        };
    }

    let base_tree = match parser.parse(base_source.as_bytes(), None) {
        Some(t) => t,
        None => {
            return BehaviorVerdict::Unknown {
                method_name: target_method.to_string(),
                reason: "Failed to parse base source revision".to_string(),
            }
        }
    };

    let cand_tree = match parser.parse(candidate_source.as_bytes(), None) {
        Some(t) => t,
        None => {
            return BehaviorVerdict::Unknown {
                method_name: target_method.to_string(),
                reason: "Failed to parse candidate source revision".to_string(),
            }
        }
    };

    let base_m_node = match find_method_node(base_tree.root_node(), base_source, target_method) {
        Some(n) => n,
        None => {
            return BehaviorVerdict::SignatureMismatch {
                method_name: target_method.to_string(),
                reason: format!("Method `{}` not found in base revision", target_method),
            }
        }
    };

    let cand_m_node = match find_method_node(cand_tree.root_node(), candidate_source, target_method)
    {
        Some(n) => n,
        None => {
            return BehaviorVerdict::SignatureMismatch {
                method_name: target_method.to_string(),
                reason: format!("Method `{}` not found in candidate revision", target_method),
            }
        }
    };

    // Strict signature check: verify parameter names, types, and counts match between revisions
    let base_params = extract_param_specs(base_m_node, base_source);
    let cand_params = extract_param_specs(cand_m_node, candidate_source);
    if base_params != cand_params {
        return BehaviorVerdict::SignatureMismatch {
            method_name: target_method.to_string(),
            reason: format!(
                "Method parameter signature or parameter order changed: {:?} vs {:?}",
                base_params, cand_params
            ),
        };
    }

    // Fail-closed on unmodeled local mutations: if local variables are reassigned,
    // comparing return expressions without SSA data-flow is unsound.
    if has_unmodeled_local_mutations(base_m_node) || has_unmodeled_local_mutations(cand_m_node) {
        return BehaviorVerdict::Unknown {
            method_name: target_method.to_string(),
            reason:
                "Method body contains local variable assignments not modeled by pure symbolic terms"
                    .to_string(),
        };
    }

    // Extract execution paths and return values for both revisions
    let base_paths = extract_method_paths(base_source, base_m_node);
    let cand_paths = extract_method_paths(candidate_source, cand_m_node);

    if base_paths.is_empty() || cand_paths.is_empty() {
        return BehaviorVerdict::Unknown {
            method_name: target_method.to_string(),
            reason: "No basic block execution paths with return statements extracted".to_string(),
        };
    }

    let mut paths_checked = 0;
    let mut all_paths_provably_identical = true;

    // Cross-product check of all paths:
    // If path conditions can overlap (satisfiable), their return expressions must be equivalent
    for b_path in &base_paths {
        for c_path in &cand_paths {
            if start_time.elapsed().as_millis() as u64 >= budget_ms {
                return BehaviorVerdict::Unknown {
                    method_name: target_method.to_string(),
                    reason: "BUDGET_EXCEEDED".to_string(),
                };
            }

            // Path feasibility condition: b_cond && c_cond
            let mut combined_constraints = b_path.constraints.clone();
            combined_constraints.extend(c_path.constraints.clone());

            let verdict = solver.solve(&combined_constraints);
            paths_checked += 1;

            match verdict {
                SolverVerdict::Counterexample(inputs) => {
                    let b_ret_clean = clean_return_expr(&b_path.return_expr);
                    let c_ret_clean = clean_return_expr(&c_path.return_expr);

                    let b_term = parse_java_expression(&b_ret_clean);
                    let c_term = parse_java_expression(&c_ret_clean);

                    let mut evaluates_identically = false;
                    let mut diverging_inputs: Option<BTreeMap<String, ConcreteValue>> = None;

                    match (&b_term, &c_term) {
                        (Some(bt), Some(ct)) => {
                            if are_terms_algebraically_equivalent(bt, ct) {
                                evaluates_identically = true;
                            } else {
                                // If not proven algebraically identical, we cannot claim sound proof!
                                all_paths_provably_identical = false;

                                let mut free_vars = Vec::new();
                                crate::solver::collect_term_vars_names(bt, &mut free_vars);
                                crate::solver::collect_term_vars_names(ct, &mut free_vars);
                                free_vars.sort();
                                free_vars.dedup();

                                // Diverse asymmetric test vectors so v_i != v_j
                                let test_vectors: Vec<Vec<i64>> = vec![
                                    vec![1, 2, 3, 4, 5],
                                    vec![2, 1, 0, 10, -5],
                                    vec![10, 0, 42, 1, -1],
                                    vec![-5, 42, 1, 0, 10],
                                    vec![0, 10, -5, 42, 1],
                                    vec![100, 200, 300, 400, 500],
                                    vec![7, 13, 19, 23, 29],
                                    vec![0, 0, 0, 0, 0],
                                ];

                                let mut all_samples_match = true;

                                for vec in &test_vectors {
                                    let mut sample_inputs = inputs.clone();
                                    for (i, v) in free_vars.iter().enumerate() {
                                        let val = vec[i % vec.len()];
                                        sample_inputs.insert(v.clone(), ConcreteValue::Int(val));
                                    }

                                    match (
                                        eval_term(bt, &sample_inputs),
                                        eval_term(ct, &sample_inputs),
                                    ) {
                                        (Some(bv), Some(cv)) => {
                                            let matches = match (&bv, &cv) {
                                                (
                                                    ConcreteValue::Float(f1),
                                                    ConcreteValue::Float(f2),
                                                ) => (f1 - f2).abs() < f64::EPSILON,
                                                _ => bv == cv,
                                            };
                                            if !matches {
                                                all_samples_match = false;
                                                diverging_inputs = Some(sample_inputs);
                                                break;
                                            }
                                        }
                                        _ => {
                                            all_samples_match = false;
                                            diverging_inputs = Some(sample_inputs);
                                            break;
                                        }
                                    }
                                }
                                evaluates_identically = all_samples_match;
                            }
                        }
                        _ => {
                            all_paths_provably_identical = false;
                        }
                    };

                    if b_ret_clean != c_ret_clean && !evaluates_identically {
                        let final_inputs = diverging_inputs.unwrap_or(inputs);
                        let witness_preimage = format!(
                            "{}:{}:{}:{}:{}:{}:{:?}:{}",
                            file_path,
                            target_method,
                            base_rev,
                            candidate_rev,
                            b_ret_clean,
                            c_ret_clean,
                            final_inputs,
                            b_path.condition_expr
                        );
                        let witness_sha256 =
                            hex::encode(Sha256::digest(witness_preimage.as_bytes()));

                        return BehaviorVerdict::Counterexample(IncompatibilityWitness {
                            file: file_path.to_string(),
                            method_name: target_method.to_string(),
                            base_revision: base_rev.to_string(),
                            candidate_revision: candidate_rev.to_string(),
                            inputs: final_inputs,
                            base_output: b_ret_clean,
                            candidate_output: c_ret_clean,
                            base_path_condition: b_path.condition_expr.clone(),
                            candidate_path_condition: c_path.condition_expr.clone(),
                            witness_sha256,
                        });
                    }
                }
                SolverVerdict::Proven => {
                    // Path intersection is infeasible (mutually exclusive paths)
                }
                SolverVerdict::Unknown { reason } => {
                    all_paths_provably_identical = false;
                    if reason.contains("BUDGET") {
                        return BehaviorVerdict::Unknown {
                            method_name: target_method.to_string(),
                            reason: "BUDGET_EXCEEDED".to_string(),
                        };
                    }
                }
            }
        }
    }

    if all_paths_provably_identical {
        BehaviorVerdict::SoundProofOfEquivalence {
            method_name: target_method.to_string(),
            paths_evaluated: paths_checked,
            proof_axioms:
                "Presburger linear arithmetic & algebraic term equivalence (all paths bisimilar)"
                    .to_string(),
        }
    } else {
        BehaviorVerdict::LikelyEquivalentBounded {
            method_name: target_method.to_string(),
            paths_evaluated: paths_checked,
            reason: format!(
                "No diverging input found within solver domain and {}ms budget (advisory only)",
                budget_ms
            ),
        }
    }
}

fn clean_return_expr(s: &str) -> String {
    s.trim()
        .trim_start_matches("return")
        .trim_end_matches(';')
        .trim()
        .to_string()
}

fn are_terms_algebraically_equivalent(t1: &Term, t2: &Term) -> bool {
    if t1 == t2 {
        return true;
    }
    match (t1, t2) {
        (Term::Add(l1, r1), Term::Add(l2, r2)) => {
            (are_terms_algebraically_equivalent(l1, l2)
                && are_terms_algebraically_equivalent(r1, r2))
                || (are_terms_algebraically_equivalent(l1, r2)
                    && are_terms_algebraically_equivalent(r1, l2))
        }
        (Term::MulConst(l1, c1), Term::MulConst(l2, c2)) => {
            c1 == c2 && are_terms_algebraically_equivalent(l1, l2)
        }
        (Term::MulFloat(l1, f1), Term::MulFloat(l2, f2)) => {
            (f1 - f2).abs() < f64::EPSILON && are_terms_algebraically_equivalent(l1, l2)
        }
        _ => false,
    }
}

fn extract_param_specs(node: Node, source: &str) -> Vec<(String, String)> {
    let mut params = Vec::new();
    if let Some(params_node) = node.child_by_field_name("parameters") {
        let mut cursor = params_node.walk();
        for child in params_node.named_children(&mut cursor) {
            if child.kind() == "formal_parameter" {
                let name_str = child
                    .child_by_field_name("name")
                    .map(|n| source[n.start_byte()..n.end_byte()].trim().to_string())
                    .unwrap_or_default();
                let type_str = child
                    .child_by_field_name("type")
                    .map(|n| source[n.start_byte()..n.end_byte()].trim().to_string())
                    .unwrap_or_default();
                params.push((name_str, type_str));
            }
        }
    }
    params
}

fn has_unmodeled_local_mutations(node: Node) -> bool {
    if node.kind() == "assignment_expression" {
        return true;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if has_unmodeled_local_mutations(child) {
            return true;
        }
    }
    false
}

fn node_contains_return(node: Node) -> bool {
    if node.kind() == "return_statement" {
        return true;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if node_contains_return(child) {
            return true;
        }
    }
    false
}

fn find_method_node<'a>(root: Node<'a>, source: &str, method_name: &str) -> Option<Node<'a>> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "class_declaration"
            || child.kind() == "interface_declaration"
            || child.kind() == "record_declaration"
            || child.kind() == "enum_declaration"
        {
            if let Some(found) = find_method_in_type(child, source, method_name) {
                return Some(found);
            }
        }
    }
    None
}

fn find_method_in_type<'a>(
    type_node: Node<'a>,
    source: &str,
    method_name: &str,
) -> Option<Node<'a>> {
    let body = type_node.child_by_field_name("body")?;
    let mut b_cursor = body.walk();
    for m in body.children(&mut b_cursor) {
        if m.kind() == "method_declaration" {
            if let Some(name_n) = m.child_by_field_name("name") {
                let name = &source[name_n.start_byte()..name_n.end_byte()];
                if name == method_name {
                    return Some(m);
                }
            }
        } else if m.kind() == "class_declaration"
            || m.kind() == "interface_declaration"
            || m.kind() == "record_declaration"
            || m.kind() == "enum_declaration"
        {
            if let Some(nested) = find_method_in_type(m, source, method_name) {
                return Some(nested);
            }
        }
    }
    None
}

fn extract_method_paths(source: &str, method_node: Node) -> Vec<MethodPathSummary> {
    let mut paths = Vec::new();
    let body_node = match method_node.child_by_field_name("body") {
        Some(b) => b,
        None => return paths,
    };

    let mut current_conditions = Vec::new();
    let mut current_constraints = Vec::new();

    traverse_node_paths(
        source,
        body_node,
        &mut current_conditions,
        &mut current_constraints,
        &mut paths,
    );

    paths
}

fn traverse_node_paths(
    source: &str,
    node: Node,
    current_conditions: &mut Vec<String>,
    current_constraints: &mut Vec<Constraint>,
    paths: &mut Vec<MethodPathSummary>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "if_statement" => {
                if let Some(cond_n) = child.child_by_field_name("condition") {
                    let raw_cond = &source[cond_n.start_byte()..cond_n.end_byte()];
                    let cond_str = strip_enclosing_parens(raw_cond).trim().to_string();

                    if let Some(c) = parse_java_condition(source, cond_n) {
                        // 1. Traverse consequence (then block) with condition C
                        if let Some(consequent) = child.child_by_field_name("consequence") {
                            let cond_len = current_conditions.len();
                            let constr_len = current_constraints.len();

                            current_conditions.push(cond_str.clone());
                            current_constraints.push(c.clone());

                            traverse_node_paths(
                                source,
                                consequent,
                                current_conditions,
                                current_constraints,
                                paths,
                            );

                            current_conditions.truncate(cond_len);
                            current_constraints.truncate(constr_len);
                        }

                        // 2. Traverse alternative (else or else if block) with condition !C
                        if let Some(alternative) = child.child_by_field_name("alternative") {
                            let cond_len = current_conditions.len();
                            let constr_len = current_constraints.len();

                            current_conditions.push(format!("!({})", cond_str));
                            current_constraints.push(Constraint::Not(Box::new(c.clone())));

                            traverse_node_paths(
                                source,
                                alternative,
                                current_conditions,
                                current_constraints,
                                paths,
                            );

                            current_conditions.truncate(cond_len);
                            current_constraints.truncate(constr_len);
                        } else if let Some(consequent) = child.child_by_field_name("consequence") {
                            // Downstream statements after if without else ONLY assume !C if the consequent returned
                            if node_contains_return(consequent) {
                                current_conditions.push(format!("!({})", cond_str));
                                current_constraints.push(Constraint::Not(Box::new(c)));
                            }
                        }
                    }
                }
            }
            "return_statement" => {
                let ret_str = source[child.start_byte()..child.end_byte()].to_string();
                paths.push(MethodPathSummary {
                    path_id: paths.len() + 1,
                    condition_expr: if current_conditions.is_empty() {
                        "true".to_string()
                    } else {
                        current_conditions.join(" && ")
                    },
                    constraints: current_constraints.clone(),
                    return_expr: ret_str,
                });
            }
            "block" => {
                traverse_node_paths(
                    source,
                    child,
                    current_conditions,
                    current_constraints,
                    paths,
                );
            }
            _ => {}
        }
    }
}
