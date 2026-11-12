//! Isolated AST call-site extraction for Java & TypeScript test healing.
//! Strictly read-only; extracts method invocations and exact argument byte-spans.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ByteRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallSiteRecord {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub receiver: Option<String>,
    pub method_name: String,
    pub is_constructor: bool,
    pub invocation_span: ByteRange,
    pub argument_list_span: ByteRange,
    pub argument_spans: Vec<ByteRange>,
    pub argument_texts: Vec<String>,
}

/// Extracts all method invocations and constructor calls from Java source code.
pub fn extract_java_call_sites(file_path: &str, source: &str) -> Result<Vec<CallSiteRecord>> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .context("Failed to load tree-sitter-java grammar")?;

    let tree = parser
        .parse(source.as_bytes(), None)
        .context("Failed to parse Java source with tree-sitter")?;

    let mut call_sites = Vec::new();
    let root = tree.root_node();
    if root.has_error() {
        anyhow::bail!("Java syntax error detected in source file: {}", file_path);
    }
    walk_java_call_sites(file_path, source, root, &mut call_sites);

    Ok(call_sites)
}

fn walk_java_call_sites(
    file_path: &str,
    source: &str,
    node: Node,
    results: &mut Vec<CallSiteRecord>,
) {
    match node.kind() {
        "method_invocation" => {
            if let Some(record) = parse_java_method_invocation(file_path, source, node) {
                results.push(record);
            }
        }
        "object_creation_expression" => {
            if let Some(record) = parse_java_object_creation(file_path, source, node) {
                results.push(record);
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_java_call_sites(file_path, source, child, results);
    }
}

fn parse_java_method_invocation(
    file_path: &str,
    source: &str,
    node: Node,
) -> Option<CallSiteRecord> {
    let name_node = node.child_by_field_name("name")?;
    let method_name = source
        .get(name_node.start_byte()..name_node.end_byte())?
        .to_string();

    let receiver = node.child_by_field_name("object").and_then(|obj| {
        source
            .get(obj.start_byte()..obj.end_byte())
            .map(|s| s.to_string())
    });

    let args_node = node.child_by_field_name("arguments")?;
    let (argument_spans, argument_texts) = extract_argument_list(source, args_node)?;

    let pos = node.start_position();
    Some(CallSiteRecord {
        file: file_path.to_string(),
        line: pos.row + 1,
        column: pos.column + 1,
        receiver,
        method_name,
        is_constructor: false,
        invocation_span: ByteRange {
            start: node.start_byte(),
            end: node.end_byte(),
        },
        argument_list_span: ByteRange {
            start: args_node.start_byte(),
            end: args_node.end_byte(),
        },
        argument_spans,
        argument_texts,
    })
}

fn parse_java_object_creation(file_path: &str, source: &str, node: Node) -> Option<CallSiteRecord> {
    let type_node = node.child_by_field_name("type")?;
    let method_name = source
        .get(type_node.start_byte()..type_node.end_byte())?
        .to_string();

    let args_node = node.child_by_field_name("arguments")?;
    let (argument_spans, argument_texts) = extract_argument_list(source, args_node)?;

    let pos = node.start_position();
    Some(CallSiteRecord {
        file: file_path.to_string(),
        line: pos.row + 1,
        column: pos.column + 1,
        receiver: None,
        method_name,
        is_constructor: true,
        invocation_span: ByteRange {
            start: node.start_byte(),
            end: node.end_byte(),
        },
        argument_list_span: ByteRange {
            start: args_node.start_byte(),
            end: args_node.end_byte(),
        },
        argument_spans,
        argument_texts,
    })
}

fn extract_argument_list(source: &str, args_node: Node) -> Option<(Vec<ByteRange>, Vec<String>)> {
    let mut argument_spans = Vec::new();
    let mut argument_texts = Vec::new();

    let mut cursor = args_node.walk();
    for child in args_node.named_children(&mut cursor) {
        // Comments inside the argument list (e.g. /* reason */) are named nodes in tree-sitter
        // but are NOT argument expressions. They must be skipped.
        if child.kind() == "block_comment" || child.kind() == "line_comment" {
            continue;
        }
        let start = child.start_byte();
        let end = child.end_byte();
        if let Some(text) = source.get(start..end) {
            argument_spans.push(ByteRange { start, end });
            argument_texts.push(text.to_string());
        }
    }

    Some((argument_spans, argument_texts))
}

/// Extracts all function calls, method invocations, and constructor calls from TypeScript/JavaScript source code.
pub fn extract_ts_call_sites(file_path: &str, source: &str) -> Result<Vec<CallSiteRecord>> {
    let mut parser = Parser::new();
    let is_tsx = file_path.ends_with(".tsx") || file_path.ends_with(".jsx");
    let language: tree_sitter::Language = if is_tsx {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    parser
        .set_language(&language)
        .context("Failed to load tree-sitter-typescript grammar")?;

    let tree = parser
        .parse(source.as_bytes(), None)
        .context("Failed to parse TypeScript source with tree-sitter")?;

    let mut call_sites = Vec::new();
    let root = tree.root_node();
    if root.has_error() {
        anyhow::bail!("TypeScript syntax error detected in source file: {}", file_path);
    }
    walk_ts_call_sites(file_path, source, root, &mut call_sites);

    Ok(call_sites)
}

fn walk_ts_call_sites(
    file_path: &str,
    source: &str,
    node: Node,
    results: &mut Vec<CallSiteRecord>,
) {
    match node.kind() {
        "call_expression" => {
            if let Some(record) = parse_ts_call_expression(file_path, source, node) {
                results.push(record);
            }
        }
        "new_expression" => {
            if let Some(record) = parse_ts_new_expression(file_path, source, node) {
                results.push(record);
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_ts_call_sites(file_path, source, child, results);
    }
}

fn parse_ts_call_expression(
    file_path: &str,
    source: &str,
    node: Node,
) -> Option<CallSiteRecord> {
    let func_node = node.child_by_field_name("function")?;
    let (receiver, method_name) = match func_node.kind() {
        "identifier" => {
            let name = source.get(func_node.start_byte()..func_node.end_byte())?.to_string();
            (None, name)
        }
        "member_expression" => {
            let prop_node = func_node.child_by_field_name("property")?;
            let obj_node = func_node.child_by_field_name("object")?;
            let prop_name = source.get(prop_node.start_byte()..prop_node.end_byte())?.to_string();
            let obj_name = source.get(obj_node.start_byte()..obj_node.end_byte())?.to_string();
            (Some(obj_name), prop_name)
        }
        _ => return None,
    };

    let args_node = node.child_by_field_name("arguments")?;
    let (argument_spans, argument_texts) = extract_argument_list(source, args_node)?;

    let pos = node.start_position();
    Some(CallSiteRecord {
        file: file_path.to_string(),
        line: pos.row + 1,
        column: pos.column + 1,
        receiver,
        method_name,
        is_constructor: false,
        invocation_span: ByteRange {
            start: node.start_byte(),
            end: node.end_byte(),
        },
        argument_list_span: ByteRange {
            start: args_node.start_byte(),
            end: args_node.end_byte(),
        },
        argument_spans,
        argument_texts,
    })
}

fn parse_ts_new_expression(
    file_path: &str,
    source: &str,
    node: Node,
) -> Option<CallSiteRecord> {
    let constructor_node = node.child_by_field_name("constructor")?;
    let method_name = match constructor_node.kind() {
        "identifier" => source.get(constructor_node.start_byte()..constructor_node.end_byte())?.to_string(),
        "member_expression" => {
            let prop_node = constructor_node.child_by_field_name("property")?;
            source.get(prop_node.start_byte()..prop_node.end_byte())?.to_string()
        }
        _ => return None,
    };

    let (argument_list_span, argument_spans, argument_texts) = if let Some(args_node) = node.child_by_field_name("arguments") {
        let (spans, texts) = extract_argument_list(source, args_node)?;
        (
            ByteRange {
                start: args_node.start_byte(),
                end: args_node.end_byte(),
            },
            spans,
            texts,
        )
    } else {
        (
            ByteRange {
                start: node.end_byte(),
                end: node.end_byte(),
            },
            Vec::new(),
            Vec::new(),
        )
    };

    let pos = node.start_position();
    Some(CallSiteRecord {
        file: file_path.to_string(),
        line: pos.row + 1,
        column: pos.column + 1,
        receiver: None,
        method_name,
        is_constructor: true,
        invocation_span: ByteRange {
            start: node.start_byte(),
            end: node.end_byte(),
        },
        argument_list_span,
        argument_spans,
        argument_texts,
    })
}
