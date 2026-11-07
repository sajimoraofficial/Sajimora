//! Tier 1 Bounded Finite-Domain & Interval SMT Constraint Solver.
//!
//! Solves linear inequalities, boolean propositions, string literals, and enum matches:
//! - Heuristic boundary testing and interval constraint propagation.
//! - Floating-point 0-equality and positive inequalities.
//! - Boolean algebra (AND, OR, NOT).
//! - String literal equality and `.isEmpty()`.
//! - Dynamic Enum variant extraction from constraint trees.
//! - Bounded wall-clock budget (default 50ms) with fail-closed UNKNOWN on expiration.
//! - Uses `BTreeMap` exclusively for 100% deterministic replay.
//! - Concrete candidate verification gate before emitting any counterexample.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConcreteValue {
    Int(i64),
    Float(f64),
    Bool(bool),
    String(String),
    Enum(String),
}

impl std::fmt::Display for ConcreteValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConcreteValue::Int(i) => write!(f, "{}", i),
            ConcreteValue::Float(v) => write!(f, "{:.2}", v),
            ConcreteValue::Bool(b) => write!(f, "{}", b),
            ConcreteValue::String(s) => write!(f, "\"{}\"", s),
            ConcreteValue::Enum(e) => write!(f, "{}", e),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Term {
    Var(String),
    LitInt(i64),
    LitFloat(f64),
    LitBool(bool),
    LitString(String),
    LitEnum(String),
    Add(Box<Term>, Box<Term>),
    Sub(Box<Term>, Box<Term>),
    MulConst(Box<Term>, i64),
    MulFloat(Box<Term>, f64),
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Constraint {
    Cmp(Term, CmpOp, Term),
    And(Vec<Constraint>),
    Or(Vec<Constraint>),
    Not(Box<Constraint>),
    StringIsEmpty(String),
    StringEquals(String, String),
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SolverVerdict {
    /// Soundly proven unsatisfiable or tautology under Tier 1 arithmetic axioms.
    Proven,
    /// Concrete input assignment that satisfies the constraint path condition.
    Counterexample(BTreeMap<String, ConcreteValue>),
    /// Out of scope or budget exceeded (fails closed).
    Unknown { reason: String },
}

pub struct Tier1Solver {
    pub budget_ms: u64,
}

impl Default for Tier1Solver {
    fn default() -> Self {
        Self { budget_ms: 50 }
    }
}

impl Tier1Solver {
    pub fn new(budget_ms: u64) -> Self {
        Self { budget_ms }
    }

    /// Solves the given constraint set within the configured wall-clock budget.
    pub fn solve(&self, constraints: &[Constraint]) -> SolverVerdict {
        let start = Instant::now();

        // 1. Audit constraint set for any out-of-scope non-linear expressions
        for c in constraints {
            if let Some(reason) = check_unsupported(c) {
                return SolverVerdict::Unknown { reason };
            }
        }

        // Check for syntactic/direct contradiction (e.g. C && !C)
        if is_provably_unsatisfiable(constraints) {
            return SolverVerdict::Proven;
        }

        // 2. Collect all variables
        let mut vars = BTreeMap::new();
        for c in constraints {
            collect_vars(c, &mut vars);
        }

        // 3. Solve via bounded interval search & constraint propagation
        let mut assignment = BTreeMap::new();
        let solved = self.solve_recursive(constraints, &vars, &mut assignment, start);

        if start.elapsed().as_millis() as u64 >= self.budget_ms {
            return SolverVerdict::Unknown {
                reason: "BUDGET_EXCEEDED".to_string(),
            };
        }

        match solved {
            Some(true) => {
                // Critical Verification Gate: Re-evaluate constraint with concrete values
                if verify_solution(&assignment, constraints) {
                    SolverVerdict::Counterexample(assignment)
                } else {
                    SolverVerdict::Unknown {
                        reason: "COUNTEREXAMPLE_VERIFICATION_FAILED".to_string(),
                    }
                }
            }
            Some(false) => {
                let all_finite_domains = !vars.is_empty()
                    && vars
                        .values()
                        .all(|t| matches!(t, VarType::Bool | VarType::Enum));
                if all_finite_domains {
                    SolverVerdict::Proven
                } else {
                    SolverVerdict::Unknown {
                        reason: "BOUNDED_CANDIDATES_EXHAUSTED".to_string(),
                    }
                }
            }
            None => SolverVerdict::Unknown {
                reason: "SEARCH_SPACE_EXHAUSTED".to_string(),
            },
        }
    }

    fn solve_recursive(
        &self,
        constraints: &[Constraint],
        vars: &BTreeMap<String, VarType>,
        assignment: &mut BTreeMap<String, ConcreteValue>,
        start: Instant,
    ) -> Option<bool> {
        if start.elapsed().as_millis() as u64 >= self.budget_ms {
            return None;
        }

        // Pick next unassigned variable
        let next_var = vars.keys().find(|k| !assignment.contains_key(*k));
        let var_name = match next_var {
            Some(v) => v.clone(),
            None => {
                // All variables assigned; check if all constraints hold
                return Some(verify_solution(assignment, constraints));
            }
        };

        let var_type = &vars[&var_name];
        let candidates = generate_candidates(var_type, constraints, &var_name);

        for cand in candidates {
            if start.elapsed().as_millis() as u64 >= self.budget_ms {
                return None;
            }

            assignment.insert(var_name.clone(), cand);
            if let Some(true) = self.solve_recursive(constraints, vars, assignment, start) {
                return Some(true);
            }
            assignment.remove(&var_name);
        }

        Some(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
enum VarType {
    Int,
    Float,
    Bool,
    String,
    Enum,
}

fn invert_cmp_op(op: CmpOp) -> CmpOp {
    match op {
        CmpOp::Eq => CmpOp::Ne,
        CmpOp::Ne => CmpOp::Eq,
        CmpOp::Lt => CmpOp::Ge,
        CmpOp::Le => CmpOp::Gt,
        CmpOp::Gt => CmpOp::Le,
        CmpOp::Ge => CmpOp::Lt,
    }
}

pub fn is_provably_unsatisfiable(constraints: &[Constraint]) -> bool {
    let mut normalized = Vec::new();
    for c in constraints {
        match c {
            Constraint::Not(inner) => match inner.as_ref() {
                Constraint::Cmp(l, op, r) => {
                    normalized.push(Constraint::Cmp(l.clone(), invert_cmp_op(*op), r.clone()));
                }
                _ => normalized.push(c.clone()),
            },
            _ => normalized.push(c.clone()),
        }
    }

    for i in 0..normalized.len() {
        for j in (i + 1)..normalized.len() {
            let c1 = &normalized[i];
            let c2 = &normalized[j];

            // 1. Direct contradiction: C and Not(C)
            if let Constraint::Not(inner) = c2 {
                if inner.as_ref() == c1 {
                    return true;
                }
            }
            if let Constraint::Not(inner) = c1 {
                if inner.as_ref() == c2 {
                    return true;
                }
            }

            // 2. Comparison contradiction with same variable on left
            if let (Constraint::Cmp(l1, op1, r1), Constraint::Cmp(l2, op2, r2)) = (c1, c2) {
                if l1 == l2 {
                    if r1 == r2 {
                        let contradictory = match (op1, op2) {
                            (CmpOp::Eq, CmpOp::Ne) | (CmpOp::Ne, CmpOp::Eq) => true,
                            (CmpOp::Gt, CmpOp::Le) | (CmpOp::Le, CmpOp::Gt) => true,
                            (CmpOp::Lt, CmpOp::Ge) | (CmpOp::Ge, CmpOp::Lt) => true,
                            (CmpOp::Gt, CmpOp::Lt) | (CmpOp::Lt, CmpOp::Gt) => true,
                            (CmpOp::Eq, CmpOp::Gt) | (CmpOp::Gt, CmpOp::Eq) => true,
                            (CmpOp::Eq, CmpOp::Lt) | (CmpOp::Lt, CmpOp::Eq) => true,
                            _ => false,
                        };
                        if contradictory {
                            return true;
                        }
                    } else if let (Term::LitInt(n1), Term::LitInt(n2)) = (r1, r2) {
                        // Integer interval contradiction: e.g. x > 10 && x < 5
                        let (lower, upper) = match (op1, op2) {
                            (CmpOp::Gt, CmpOp::Lt) => {
                                (Some(n1.saturating_add(1)), Some(n2.saturating_sub(1)))
                            }
                            (CmpOp::Gt, CmpOp::Le) => (Some(n1.saturating_add(1)), Some(*n2)),
                            (CmpOp::Ge, CmpOp::Lt) => (Some(*n1), Some(n2.saturating_sub(1))),
                            (CmpOp::Ge, CmpOp::Le) => (Some(*n1), Some(*n2)),
                            (CmpOp::Lt, CmpOp::Gt) => {
                                (Some(n2.saturating_add(1)), Some(n1.saturating_sub(1)))
                            }
                            (CmpOp::Le, CmpOp::Gt) => (Some(n2.saturating_add(1)), Some(*n1)),
                            (CmpOp::Lt, CmpOp::Ge) => (Some(*n2), Some(n1.saturating_sub(1))),
                            (CmpOp::Le, CmpOp::Ge) => (Some(*n2), Some(*n1)),
                            _ => (None, None),
                        };
                        if let (Some(l), Some(u)) = (lower, upper) {
                            if l > u {
                                return true;
                            }
                        }
                    } else if let (Term::LitFloat(f1), Term::LitFloat(f2)) = (r1, r2) {
                        // Float interval contradiction
                        let is_contradiction = match (op1, op2) {
                            (CmpOp::Gt, CmpOp::Lt)
                            | (CmpOp::Gt, CmpOp::Le)
                            | (CmpOp::Ge, CmpOp::Lt) => f1 >= f2,
                            (CmpOp::Ge, CmpOp::Le) => f1 > f2,
                            (CmpOp::Lt, CmpOp::Gt)
                            | (CmpOp::Le, CmpOp::Gt)
                            | (CmpOp::Lt, CmpOp::Ge) => f2 >= f1,
                            (CmpOp::Le, CmpOp::Ge) => f2 > f1,
                            _ => false,
                        };
                        if is_contradiction {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

fn check_unsupported(c: &Constraint) -> Option<String> {
    match c {
        Constraint::Unsupported(msg) => Some(msg.clone()),
        Constraint::Cmp(left, _, right) => {
            if let Some(msg) = check_term_unsupported(left) {
                return Some(msg);
            }
            if let Some(msg) = check_term_unsupported(right) {
                return Some(msg);
            }
            None
        }
        Constraint::And(list) | Constraint::Or(list) => {
            for item in list {
                if let Some(msg) = check_unsupported(item) {
                    return Some(msg);
                }
            }
            None
        }
        Constraint::Not(inner) => check_unsupported(inner),
        Constraint::StringIsEmpty(_) | Constraint::StringEquals(_, _) => None,
    }
}

fn check_term_unsupported(t: &Term) -> Option<String> {
    match t {
        Term::Unsupported(msg) => Some(msg.clone()),
        Term::Add(l, r) | Term::Sub(l, r) => {
            check_term_unsupported(l).or_else(|| check_term_unsupported(r))
        }
        Term::MulConst(l, _) => check_term_unsupported(l),
        _ => None,
    }
}

fn collect_vars(c: &Constraint, vars: &mut BTreeMap<String, VarType>) {
    match c {
        Constraint::Cmp(Term::Var(v), _, Term::LitFloat(_))
        | Constraint::Cmp(Term::LitFloat(_), _, Term::Var(v)) => {
            vars.insert(v.clone(), VarType::Float);
        }
        Constraint::Cmp(Term::Var(v), _, Term::LitBool(_))
        | Constraint::Cmp(Term::LitBool(_), _, Term::Var(v)) => {
            vars.insert(v.clone(), VarType::Bool);
        }
        Constraint::Cmp(Term::Var(v), _, Term::LitEnum(_))
        | Constraint::Cmp(Term::LitEnum(_), _, Term::Var(v)) => {
            vars.insert(v.clone(), VarType::Enum);
        }
        Constraint::Cmp(Term::Var(v), _, Term::LitString(_))
        | Constraint::Cmp(Term::LitString(_), _, Term::Var(v)) => {
            vars.insert(v.clone(), VarType::String);
        }
        Constraint::Cmp(left, _, right) => {
            collect_term_vars(left, vars);
            collect_term_vars(right, vars);
        }
        Constraint::And(list) | Constraint::Or(list) => {
            for item in list {
                collect_vars(item, vars);
            }
        }
        Constraint::Not(inner) => collect_vars(inner, vars),
        Constraint::StringIsEmpty(var) => {
            vars.insert(var.clone(), VarType::String);
        }
        Constraint::StringEquals(var, _) => {
            vars.insert(var.clone(), VarType::String);
        }
        Constraint::Unsupported(_) => {}
    }
}

pub(crate) fn collect_term_vars_names(t: &Term, out: &mut Vec<String>) {
    match t {
        Term::Var(name) => out.push(name.clone()),
        Term::Add(l, r) | Term::Sub(l, r) => {
            collect_term_vars_names(l, out);
            collect_term_vars_names(r, out);
        }
        Term::MulConst(l, _) | Term::MulFloat(l, _) => collect_term_vars_names(l, out),
        _ => {}
    }
}

fn collect_term_vars(t: &Term, vars: &mut BTreeMap<String, VarType>) {
    match t {
        Term::Var(name) => {
            // Default to Int unless specified
            vars.entry(name.clone()).or_insert(VarType::Int);
        }
        Term::Add(l, r) | Term::Sub(l, r) => {
            collect_term_vars(l, vars);
            collect_term_vars(r, vars);
        }
        Term::MulConst(l, _) => collect_term_vars(l, vars),
        Term::MulFloat(l, _) => {
            collect_term_vars(l, vars);
            if let Term::Var(name) = l.as_ref() {
                vars.insert(name.clone(), VarType::Float);
            }
        }
        _ => {}
    }
}

fn generate_candidates(
    var_type: &VarType,
    constraints: &[Constraint],
    var_name: &str,
) -> Vec<ConcreteValue> {
    match var_type {
        VarType::Bool => vec![ConcreteValue::Bool(true), ConcreteValue::Bool(false)],
        VarType::Int => {
            let mut vals = vec![0, 1, -1, 10, 100, 1000];
            // Extract literals compared against this variable
            for c in constraints {
                collect_int_literals(c, var_name, &mut vals);
            }
            vals.sort_unstable();
            vals.dedup();
            vals.into_iter().map(ConcreteValue::Int).collect()
        }
        VarType::Float => {
            let mut vals = vec![0.0, 1.0, -1.0];
            for c in constraints {
                collect_float_literals(c, var_name, &mut vals);
            }
            vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            vals.dedup();
            vals.into_iter().map(ConcreteValue::Float).collect()
        }
        VarType::String => {
            let mut vals = vec!["".to_string(), "test".to_string()];
            for c in constraints {
                if let Constraint::StringEquals(name, lit) = c {
                    if name == var_name {
                        vals.push(lit.clone());
                    }
                }
            }
            vals.into_iter().map(ConcreteValue::String).collect()
        }
        VarType::Enum => {
            let mut vals = Vec::new();
            for c in constraints {
                collect_enum_literals(c, var_name, &mut vals);
            }
            if vals.is_empty() {
                vals.push("UNKNOWN_VARIANT".to_string());
            }
            vals.sort();
            vals.dedup();
            vals.into_iter().map(ConcreteValue::Enum).collect()
        }
    }
}

fn collect_enum_literals(c: &Constraint, var_name: &str, out: &mut Vec<String>) {
    match c {
        Constraint::Cmp(Term::Var(v), _, Term::LitEnum(e))
        | Constraint::Cmp(Term::LitEnum(e), _, Term::Var(v))
            if v == var_name =>
        {
            out.push(e.clone());
        }
        Constraint::And(list) | Constraint::Or(list) => {
            for item in list {
                collect_enum_literals(item, var_name, out);
            }
        }
        Constraint::Not(inner) => collect_enum_literals(inner, var_name, out),
        _ => {}
    }
}

fn collect_int_literals(c: &Constraint, var_name: &str, out: &mut Vec<i64>) {
    match c {
        Constraint::Cmp(Term::Var(v), _, Term::LitInt(n))
        | Constraint::Cmp(Term::LitInt(n), _, Term::Var(v))
            if v == var_name =>
        {
            out.push(*n);
            out.push(n.saturating_add(1));
            out.push(n.saturating_sub(1));
        }
        Constraint::And(list) | Constraint::Or(list) => {
            for item in list {
                collect_int_literals(item, var_name, out);
            }
        }
        Constraint::Not(inner) => collect_int_literals(inner, var_name, out),
        _ => {}
    }
}

fn collect_float_literals(c: &Constraint, var_name: &str, out: &mut Vec<f64>) {
    match c {
        Constraint::Cmp(Term::Var(v), _, Term::LitFloat(n))
        | Constraint::Cmp(Term::LitFloat(n), _, Term::Var(v))
            if v == var_name =>
        {
            out.push(*n);
            out.push(*n + 1.0);
            out.push(*n - 1.0);
            out.push(*n + 10.0);
            out.push(*n - 10.0);
        }
        Constraint::And(list) | Constraint::Or(list) => {
            for item in list {
                collect_float_literals(item, var_name, out);
            }
        }
        Constraint::Not(inner) => collect_float_literals(inner, var_name, out),
        _ => {}
    }
}

fn verify_solution(
    assignment: &BTreeMap<String, ConcreteValue>,
    constraints: &[Constraint],
) -> bool {
    constraints.iter().all(|c| eval_constraint(c, assignment))
}

fn eval_constraint(c: &Constraint, assignment: &BTreeMap<String, ConcreteValue>) -> bool {
    match c {
        Constraint::Cmp(left, op, right) => {
            let lv = eval_term(left, assignment);
            let rv = eval_term(right, assignment);
            match (lv, rv) {
                (Some(ConcreteValue::Int(a)), Some(ConcreteValue::Int(b))) => match op {
                    CmpOp::Eq => a == b,
                    CmpOp::Ne => a != b,
                    CmpOp::Lt => a < b,
                    CmpOp::Le => a <= b,
                    CmpOp::Gt => a > b,
                    CmpOp::Ge => a >= b,
                },
                (Some(ConcreteValue::Float(a)), Some(ConcreteValue::Float(b))) => match op {
                    CmpOp::Eq => (a - b).abs() < f64::EPSILON,
                    CmpOp::Ne => (a - b).abs() >= f64::EPSILON,
                    CmpOp::Lt => a < b,
                    CmpOp::Le => a <= b,
                    CmpOp::Gt => a > b,
                    CmpOp::Ge => a >= b,
                },
                (Some(ConcreteValue::Bool(a)), Some(ConcreteValue::Bool(b))) => match op {
                    CmpOp::Eq => a == b,
                    CmpOp::Ne => a != b,
                    _ => false,
                },
                (Some(ConcreteValue::String(a)), Some(ConcreteValue::String(b))) => match op {
                    CmpOp::Eq => a == b,
                    CmpOp::Ne => a != b,
                    _ => false,
                },
                (Some(ConcreteValue::Enum(a)), Some(ConcreteValue::Enum(b))) => match op {
                    CmpOp::Eq => a == b,
                    CmpOp::Ne => a != b,
                    _ => false,
                },
                _ => false,
            }
        }
        Constraint::And(list) => list.iter().all(|item| eval_constraint(item, assignment)),
        Constraint::Or(list) => list.iter().any(|item| eval_constraint(item, assignment)),
        Constraint::Not(inner) => !eval_constraint(inner, assignment),
        Constraint::StringIsEmpty(var) => match assignment.get(var) {
            Some(ConcreteValue::String(s)) => s.is_empty(),
            _ => false,
        },
        Constraint::StringEquals(var, lit) => match assignment.get(var) {
            Some(ConcreteValue::String(s)) => s == lit,
            _ => false,
        },
        Constraint::Unsupported(_) => false,
    }
}

pub(crate) fn eval_term(
    t: &Term,
    assignment: &BTreeMap<String, ConcreteValue>,
) -> Option<ConcreteValue> {
    match t {
        Term::Var(name) => assignment.get(name).cloned(),
        Term::LitInt(n) => Some(ConcreteValue::Int(*n)),
        Term::LitFloat(f) => Some(ConcreteValue::Float(*f)),
        Term::LitBool(b) => Some(ConcreteValue::Bool(*b)),
        Term::LitString(s) => Some(ConcreteValue::String(s.clone())),
        Term::LitEnum(e) => Some(ConcreteValue::Enum(e.clone())),
        Term::Add(l, r) => match (eval_term(l, assignment)?, eval_term(r, assignment)?) {
            (ConcreteValue::Int(a), ConcreteValue::Int(b)) => {
                Some(ConcreteValue::Int(a.saturating_add(b)))
            }
            (ConcreteValue::Float(a), ConcreteValue::Float(b)) => Some(ConcreteValue::Float(a + b)),
            _ => None,
        },
        Term::Sub(l, r) => match (eval_term(l, assignment)?, eval_term(r, assignment)?) {
            (ConcreteValue::Int(a), ConcreteValue::Int(b)) => {
                Some(ConcreteValue::Int(a.saturating_sub(b)))
            }
            (ConcreteValue::Float(a), ConcreteValue::Float(b)) => Some(ConcreteValue::Float(a - b)),
            _ => None,
        },
        Term::MulConst(l, c) => match eval_term(l, assignment)? {
            ConcreteValue::Int(a) => Some(ConcreteValue::Int(a.saturating_mul(*c))),
            ConcreteValue::Float(a) => Some(ConcreteValue::Float(a * (*c as f64))),
            _ => None,
        },
        Term::MulFloat(l, f) => match eval_term(l, assignment)? {
            ConcreteValue::Float(a) => Some(ConcreteValue::Float(a * f)),
            ConcreteValue::Int(a) => Some(ConcreteValue::Float((a as f64) * f)),
            _ => None,
        },
        Term::Unsupported(_) => None,
    }
}
