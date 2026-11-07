//! Isolated method signature extraction and diff computation for Java & TypeScript.
//!
//! Provides deterministic detection of:
//! - Added parameters with type-safe default inference
//! - Removed parameters
//! - Parameter reordering
//!
//! Strictly adheres to P1-A (no unverified default invention) and P1-C (fail-closed side-effect checks).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParamDef {
    pub name: String,
    pub type_name: String,
    pub annotations: Vec<String>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MethodSignatureFact {
    pub method_name: String,
    pub class_name: Option<String>,
    pub return_type: String,
    pub params: Vec<ParamDef>,
    pub annotations: Vec<String>,
    pub is_static: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MethodSignatureChange {
    pub method_name: String,
    pub class_name: Option<String>,
    pub old_params: Vec<ParamDef>,
    pub new_params: Vec<ParamDef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignatureDiffOp {
    AddParam {
        index: usize,
        name: String,
        type_name: String,
        inferred_default: Option<String>,
    },
    RemoveParam {
        index: usize,
        name: String,
    },
    ReorderParams {
        old_indices: Vec<usize>,
    },
}

/// Infers a deterministic zero/empty default value for primitives and standard library types.
/// Returns None for arbitrary domain objects to guarantee P1-A safety.
pub fn infer_default_value(type_name: &str) -> Option<String> {
    let clean = type_name.trim();
    match clean {
        "boolean" | "Boolean" => Some("false".to_string()),
        "byte" | "Byte" | "short" | "Short" | "int" | "Integer" => Some("0".to_string()),
        "long" | "Long" => Some("0L".to_string()),
        "float" | "Float" => Some("0.0f".to_string()),
        "double" | "Double" => Some("0.0d".to_string()),
        "char" | "Character" => Some("'\\0'".to_string()),
        "String" | "java.lang.String" => Some("\"\"".to_string()),
        _ if clean.starts_with("Optional<") || clean == "Optional" => {
            Some("java.util.Optional.empty()".to_string())
        }
        _ if clean.starts_with("List<") || clean == "List" => {
            Some("java.util.Collections.emptyList()".to_string())
        }
        _ if clean.starts_with("Set<") || clean == "Set" => {
            Some("java.util.Collections.emptySet()".to_string())
        }
        _ if clean.starts_with("Map<") || clean == "Map" => {
            Some("java.util.Collections.emptyMap()".to_string())
        }
        _ => None,
    }
}

/// Computes the exact deterministic diff operations between an old and new method signature.
pub fn diff_signatures(
    old_sig: &MethodSignatureFact,
    new_sig: &MethodSignatureFact,
) -> Vec<SignatureDiffOp> {
    let mut ops = Vec::new();

    // 1. Single parameter added at end or specific position
    if new_sig.params.len() == old_sig.params.len() + 1 {
        // Find which index was inserted
        for (i, new_p) in new_sig.params.iter().enumerate() {
            let mut matches_old = true;
            let mut old_idx = 0;
            for (curr_idx, p) in new_sig.params.iter().enumerate() {
                if curr_idx == i {
                    continue;
                }
                if old_idx >= old_sig.params.len() || old_sig.params[old_idx].name != p.name {
                    matches_old = false;
                    break;
                }
                old_idx += 1;
            }

            if matches_old {
                ops.push(SignatureDiffOp::AddParam {
                    index: i,
                    name: new_p.name.clone(),
                    type_name: new_p.type_name.clone(),
                    inferred_default: new_p
                        .default_value
                        .clone()
                        .or_else(|| infer_default_value(&new_p.type_name)),
                });
                return ops;
            }
        }
    }

    // 2. Single parameter removed
    if old_sig.params.len() == new_sig.params.len() + 1 {
        for (i, old_p) in old_sig.params.iter().enumerate() {
            let mut matches_new = true;
            let mut new_idx = 0;
            for (curr_idx, p) in old_sig.params.iter().enumerate() {
                if curr_idx == i {
                    continue;
                }
                if new_idx >= new_sig.params.len() || new_sig.params[new_idx].name != p.name {
                    matches_new = false;
                    break;
                }
                new_idx += 1;
            }

            if matches_new {
                ops.push(SignatureDiffOp::RemoveParam {
                    index: i,
                    name: old_p.name.clone(),
                });
                return ops;
            }
        }
    }

    // 3. Reordering check
    if old_sig.params.len() == new_sig.params.len() {
        let mut old_indices = Vec::new();
        let mut is_pure_reorder = true;
        for new_p in &new_sig.params {
            if let Some(pos) = old_sig.params.iter().position(|p| p.name == new_p.name) {
                old_indices.push(pos);
            } else {
                is_pure_reorder = false;
                break;
            }
        }
        if is_pure_reorder && old_indices != (0..old_sig.params.len()).collect::<Vec<_>>() {
            ops.push(SignatureDiffOp::ReorderParams { old_indices });
            return ops;
        }
    }

    // General fallback: for each new param not found in old, mark as AddParam
    for (i, p) in new_sig.params.iter().enumerate() {
        if !old_sig.params.iter().any(|op| op.name == p.name) {
            ops.push(SignatureDiffOp::AddParam {
                index: i,
                name: p.name.clone(),
                type_name: p.type_name.clone(),
                inferred_default: p
                    .default_value
                    .clone()
                    .or_else(|| infer_default_value(&p.type_name)),
            });
        }
    }

    ops
}

/// Parses Java source code and extracts all method and constructor signatures.
pub fn extract_java_method_signatures(source: &str) -> Result<Vec<MethodSignatureFact>> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .context("Failed to load tree-sitter-java grammar")?;

    let tree = parser
        .parse(source.as_bytes(), None)
        .context("Failed to parse Java source")?;

    let mut signatures = Vec::new();
    let root = tree.root_node();
    walk_java_signatures(source, root, None, &mut signatures);

    Ok(signatures)
}

fn walk_java_signatures(
    source: &str,
    node: Node,
    current_class: Option<&str>,
    results: &mut Vec<MethodSignatureFact>,
) {
    match node.kind() {
        "class_declaration" | "interface_declaration" | "record_declaration" => {
            let class_name = node
                .child_by_field_name("name")
                .map(|n| &source[n.start_byte()..n.end_byte()]);

            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                walk_java_signatures(source, child, class_name.or(current_class), results);
            }
        }
        "method_declaration" => {
            if let Some(fact) = parse_method_declaration(source, node, current_class) {
                results.push(fact);
            }
        }
        "constructor_declaration" => {
            if let Some(fact) = parse_constructor_declaration(source, node, current_class) {
                results.push(fact);
            }
        }
        _ => {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                walk_java_signatures(source, child, current_class, results);
            }
        }
    }
}

fn parse_method_declaration(
    source: &str,
    node: Node,
    class_name: Option<&str>,
) -> Option<MethodSignatureFact> {
    let name_node = node.child_by_field_name("name")?;
    let method_name = source[name_node.start_byte()..name_node.end_byte()].to_string();

    let return_type = node
        .child_by_field_name("type")
        .map(|n| source[n.start_byte()..n.end_byte()].to_string())
        .unwrap_or_else(|| "void".to_string());

    let mut is_static = false;
    let mut annotations = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for m in child.children(&mut mod_cursor) {
                match m.kind() {
                    "static" => is_static = true,
                    "marker_annotation" | "annotation" => {
                        let text = source[m.start_byte()..m.end_byte()].to_string();
                        annotations.push(text);
                    }
                    _ => {}
                }
            }
        }
    }

    let mut params = Vec::new();
    if let Some(params_node) = node.child_by_field_name("parameters") {
        let mut p_cursor = params_node.walk();
        for param_child in params_node.children(&mut p_cursor) {
            if param_child.kind() == "formal_parameter" || param_child.kind() == "spread_parameter"
            {
                if let Some(param_def) = parse_formal_parameter(source, param_child) {
                    params.push(param_def);
                }
            }
        }
    }

    Some(MethodSignatureFact {
        method_name,
        class_name: class_name.map(|s| s.to_string()),
        return_type,
        params,
        annotations,
        is_static,
    })
}

fn parse_constructor_declaration(
    source: &str,
    node: Node,
    class_name: Option<&str>,
) -> Option<MethodSignatureFact> {
    let name_node = node.child_by_field_name("name")?;
    let method_name = source[name_node.start_byte()..name_node.end_byte()].to_string();

    let mut params = Vec::new();
    if let Some(params_node) = node.child_by_field_name("parameters") {
        let mut p_cursor = params_node.walk();
        for param_child in params_node.children(&mut p_cursor) {
            if param_child.kind() == "formal_parameter" || param_child.kind() == "spread_parameter"
            {
                if let Some(param_def) = parse_formal_parameter(source, param_child) {
                    params.push(param_def);
                }
            }
        }
    }

    Some(MethodSignatureFact {
        method_name: method_name.clone(),
        class_name: class_name.map(|s| s.to_string()),
        return_type: method_name,
        params,
        annotations: Vec::new(),
        is_static: false,
    })
}

fn parse_formal_parameter(source: &str, node: Node) -> Option<ParamDef> {
    let name_node = node.child_by_field_name("name")?;
    let name = source[name_node.start_byte()..name_node.end_byte()].to_string();

    let type_node = node.child_by_field_name("type")?;
    let type_name = source[type_node.start_byte()..type_node.end_byte()].to_string();

    let mut annotations = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "marker_annotation" || child.kind() == "annotation" {
            annotations.push(source[child.start_byte()..child.end_byte()].to_string());
        } else if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for m in child.children(&mut mod_cursor) {
                if m.kind() == "marker_annotation" || m.kind() == "annotation" {
                    annotations.push(source[m.start_byte()..m.end_byte()].to_string());
                }
            }
        }
    }

    Some(ParamDef {
        name,
        type_name,
        annotations,
        default_value: None,
    })
}
