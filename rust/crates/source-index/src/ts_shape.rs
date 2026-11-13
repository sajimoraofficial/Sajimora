//! ts_shape.rs — shared object-literal shape inference for the TypeScript
//! provider lanes.
//!
//! Provider handlers commonly return an inline JSON literal
//! (`res.json({ id, name })`, `NextResponse.json({ ok: true })`). Without
//! reading that literal, a route can only be extracted as an untyped endpoint.
//! This module keeps the inference grammar-only: literals, arrays, nested
//! objects, and path/query parameter reads are modelled; anything computed is
//! represented as `Unknown` so the artifact is marked incomplete rather than
//! guessing a shape.

use contract_core::ir::{
    ArrayWireType, ObjectWireType, PrimitiveScalar, PrimitiveWireType, SourceLanguage,
    SourceProvenance, UnknownWireType, WirePropertyContract, WireType,
};
use tree_sitter::Node;

pub(crate) struct ShapeContext<'a> {
    pub content: &'a str,
    pub file: &'a str,
    pub sha256: Option<&'a str>,
}

impl ShapeContext<'_> {
    fn prov(&self, node: Node, identity: &str) -> SourceProvenance {
        SourceProvenance {
            language: SourceLanguage::TypeScript,
            file: self.file.to_string(),
            line: node.start_position().row as u32 + 1,
            column: None,
            ast_identity: Some(identity.to_string()),
            annotation_or_schema: None,
            sha256: self.sha256.map(|s| s.to_string()),
            evidence_classification: None,
        }
    }
}

fn text<'a>(node: Node<'a>, content: &'a str) -> &'a str {
    &content[node.start_byte()..node.end_byte()]
}

fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('`') && trimmed.ends_with('`'))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn primitive(node: Node, scalar: PrimitiveScalar, ctx: &ShapeContext) -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar,
        format: None,
        provenance: Some(ctx.prov(node, &text(node, ctx.content))),
    })
}

fn unknown(node: Node, reason: &str, ctx: &ShapeContext) -> WireType {
    WireType::Unknown(UnknownWireType {
        reason: reason.to_string(),
        provenance: Some(ctx.prov(node, &text(node, ctx.content))),
    })
}

/// Try to read a JSON object literal. Returns `None` when the node is not an
/// object at all; an object with an unsupported member is still returned, with
/// that member typed as `Unknown`, so the caller can mark the endpoint
/// incomplete instead of silently dropping the member.
pub(crate) fn object_literal(node: Node, ctx: &ShapeContext) -> Option<WireType> {
    let node = unwrap_expression(node);
    if node.kind() != "object" {
        return None;
    }
    let mut properties = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "pair" => {
                let Some(key_node) = child.child_by_field_name("key") else {
                    continue;
                };
                let Some(value_node) = child.child_by_field_name("value") else {
                    continue;
                };
                let wire_name = unquote(text(key_node, ctx.content));
                let value = value_wire(value_node, ctx);
                properties.push(WirePropertyContract {
                    wire_name: wire_name.clone(),
                    aliases: Vec::new(),
                    r#type: value,
                    optional: false,
                    nullable: false,
                    server_assigned: false,
                    validation_constraints: Vec::new(),
                    provenance: Some(ctx.prov(key_node, &wire_name)),
                });
            }
            "shorthand_property_identifier" | "shorthand_property_identifier_pattern" => {
                let wire_name = text(child, ctx.content).trim().to_string();
                let wire_type = resolve_local_identifier(child, &wire_name, ctx).unwrap_or_else(|| {
                    unknown(
                        child,
                        "shorthand property has no statically known value",
                        ctx,
                    )
                });
                properties.push(WirePropertyContract {
                    wire_name: wire_name.clone(),
                    aliases: Vec::new(),
                    r#type: wire_type,
                    optional: false,
                    nullable: false,
                    server_assigned: false,
                    validation_constraints: Vec::new(),
                    provenance: Some(ctx.prov(child, &wire_name)),
                });
            }
            "spread_element" => {
                let mut resolved_spread = false;
                if let Some(spread_expr) = child.named_child(0) {
                    let spread_expr = unwrap_expression(spread_expr);
                    if spread_expr.kind() == "identifier" {
                        let ident_name = text(spread_expr, ctx.content).trim();
                        if let Some(WireType::Object(obj)) = resolve_local_identifier(spread_expr, ident_name, ctx) {
                            properties.extend(obj.properties);
                            resolved_spread = true;
                        }
                    }
                }
                if !resolved_spread {
                    properties.push(WirePropertyContract {
                        wire_name: "...".to_string(),
                        aliases: Vec::new(),
                        r#type: unknown(child, "object spread is not expanded statically", ctx),
                        optional: false,
                        nullable: false,
                        server_assigned: false,
                        validation_constraints: Vec::new(),
                        provenance: Some(ctx.prov(child, "...")),
                    });
                }
            }
            _ => {}
        }
    }
    Some(WireType::Object(ObjectWireType {
        name: None,
        properties,
        strict: Some(false),
        provenance: Some(ctx.prov(node, "object-literal")),
    }))
}

fn value_wire(node: Node, ctx: &ShapeContext) -> WireType {
    let node = unwrap_expression(node);
    match node.kind() {
        "string" | "template_string" => primitive(node, PrimitiveScalar::String, ctx),
        "number" => primitive(node, PrimitiveScalar::Number, ctx),
        "true" | "false" => primitive(node, PrimitiveScalar::Boolean, ctx),
        "object" => object_literal(node, ctx)
            .unwrap_or_else(|| unknown(node, "object literal could not be read", ctx)),
        "array" => {
            let mut cursor = node.walk();
            let first = node.named_children(&mut cursor).next();
            let element_type = first
                .map(|child| value_wire(child, ctx))
                .unwrap_or_else(|| unknown(node, "empty array has no element type", ctx));
            WireType::Array(ArrayWireType {
                element_type: Box::new(element_type),
                is_stream_or_flux: Some(false),
                provenance: Some(ctx.prov(node, "array-literal")),
            })
        }
        "member_expression" => {
            let raw = text(node, ctx.content);
            if raw.contains(".params.") || raw.contains(".query.") {
                primitive(node, PrimitiveScalar::String, ctx)
            } else {
                unknown(
                    node,
                    "member expression has no statically known wire type",
                    ctx,
                )
            }
        }
        "unary_expression" => {
            let raw = text(node, ctx.content).trim();
            if raw.starts_with('-') && raw[1..].trim().parse::<f64>().is_ok() {
                primitive(node, PrimitiveScalar::Number, ctx)
            } else {
                unknown(
                    node,
                    "unary expression has no statically known wire type",
                    ctx,
                )
            }
        }
        "binary_expression" => {
            let raw = text(node, ctx.content);
            if raw.contains('\'') || raw.contains('"') || raw.contains('`') {
                primitive(node, PrimitiveScalar::String, ctx)
            } else if raw
                .split(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
                .filter(|part| !part.is_empty())
                .count()
                >= 2
            {
                primitive(node, PrimitiveScalar::Number, ctx)
            } else {
                unknown(
                    node,
                    "binary expression has no statically known wire type",
                    ctx,
                )
            }
        }
        "null" => unknown(node, "null literal has no non-null wire type", ctx),
        "identifier" => {
            let ident_name = text(node, ctx.content).trim();
            resolve_local_identifier(node, ident_name, ctx)
                .unwrap_or_else(|| unknown(node, "value is computed at runtime", ctx))
        }
        "call_expression" | "new_expression" => {
            unknown(node, "value is computed at runtime", ctx)
        }
        _ => unknown(node, "value expression is not modelled", ctx),
    }
}

fn unwrap_expression(node: Node) -> Node {
    let mut current = node;
    loop {
        match current.kind() {
            "parenthesized_expression"
            | "as_expression"
            | "satisfies_expression"
            | "type_assertion"
            | "non_null_expression" => {
                let Some(inner) = current.named_child(0) else {
                    return current;
                };
                current = inner;
            }
            _ => return current,
        }
    }
}

/// Whether a synthesized shape contains a position no static reader resolved.
/// Such an endpoint stays complete only if the extractor can prove every
/// property; an `Unknown` anywhere makes the artifact incomplete.
pub(crate) fn contains_unknown(wire: &WireType) -> bool {
    contains_unknown_at(wire, 0)
}

fn contains_unknown_at(wire: &WireType, depth: usize) -> bool {
    if depth > 16 {
        return true;
    }
    match wire {
        WireType::Unknown(_) => true,
        WireType::Primitive(p) => matches!(p.scalar, PrimitiveScalar::Any),
        WireType::Object(object) => object
            .properties
            .iter()
            .any(|property| contains_unknown_at(&property.r#type, depth + 1)),
        WireType::Array(array) => contains_unknown_at(&array.element_type, depth + 1),
        WireType::Union(union) => union
            .types
            .iter()
            .any(|member| contains_unknown_at(member, depth + 1)),
        WireType::Nullable(nullable) => contains_unknown_at(&nullable.inner_type, depth + 1),
        WireType::Optional(optional) => contains_unknown_at(&optional.inner_type, depth + 1),
        WireType::Map(map) => contains_unknown_at(&map.value_type, depth + 1),
        _ => false,
    }
}

fn type_annotation_to_wire(type_node: Node, ctx: &ShapeContext) -> Option<WireType> {
    let raw = text(type_node, ctx.content)
        .trim()
        .trim_start_matches(':')
        .trim();
    match raw {
        "string" => Some(primitive(type_node, PrimitiveScalar::String, ctx)),
        "number" => Some(primitive(type_node, PrimitiveScalar::Number, ctx)),
        "boolean" => Some(primitive(type_node, PrimitiveScalar::Boolean, ctx)),
        "bigint" => Some(primitive(type_node, PrimitiveScalar::BigInt, ctx)),
        "void" => Some(primitive(type_node, PrimitiveScalar::Void, ctx)),
        _ => None,
    }
}

fn inspect_statement_for_ident(stmt: Node, ident_name: &str, ctx: &ShapeContext) -> Option<WireType> {
    let stmt = unwrap_expression(stmt);
    match stmt.kind() {
        "lexical_declaration" | "variable_declaration" => {
            let mut cursor = stmt.walk();
            for decl in stmt.named_children(&mut cursor) {
                if decl.kind() == "variable_declarator" {
                    if let Some(name_node) = decl.child_by_field_name("name") {
                        match name_node.kind() {
                            "identifier" => {
                                if text(name_node, ctx.content).trim() == ident_name {
                                    if let Some(type_ann) = decl.child_by_field_name("type") {
                                        if let Some(wire) = type_annotation_to_wire(type_ann, ctx) {
                                            return Some(wire);
                                        }
                                    }
                                    if let Some(val) = decl.child_by_field_name("value") {
                                        if val.kind() == "as_expression" || val.kind() == "satisfies_expression" {
                                            if let Some(type_child) = val.named_child(1) {
                                                if let Some(wire) = type_annotation_to_wire(type_child, ctx) {
                                                    return Some(wire);
                                                }
                                            }
                                        }
                                        let wire = value_wire(val, ctx);
                                        if !matches!(wire, WireType::Unknown(_)) {
                                            return Some(wire);
                                        }
                                    }
                                }
                            }
                            "object_pattern" => {
                                let mut pat_cursor = name_node.walk();
                                for pat_child in name_node.named_children(&mut pat_cursor) {
                                    match pat_child.kind() {
                                        "shorthand_property_identifier_pattern"
                                        | "shorthand_property_identifier" => {
                                            if text(pat_child, ctx.content).trim() == ident_name {
                                                if let Some(val) = decl.child_by_field_name("value") {
                                                    let val_raw = text(val, ctx.content);
                                                    if val_raw.contains(".params") || val_raw.contains(".query") {
                                                        return Some(primitive(pat_child, PrimitiveScalar::String, ctx));
                                                    }
                                                }
                                            }
                                        }
                                        "pair_pattern" => {
                                            if let Some(val_pat) = pat_child.child_by_field_name("value") {
                                                if text(val_pat, ctx.content).trim() == ident_name {
                                                    if let Some(val) = decl.child_by_field_name("value") {
                                                        let val_raw = text(val, ctx.content);
                                                        if val_raw.contains(".params") || val_raw.contains(".query") {
                                                            return Some(primitive(val_pat, PrimitiveScalar::String, ctx));
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        _ => {}
    }
    None
}

fn inspect_params_for_ident(params_node: Node, ident_name: &str, ctx: &ShapeContext) -> Option<WireType> {
    let mut cursor = params_node.walk();
    for param in params_node.named_children(&mut cursor) {
        match param.kind() {
            "required_parameter" | "optional_parameter" => {
                if let Some(pattern) = param.child_by_field_name("pattern") {
                    if text(pattern, ctx.content).trim() == ident_name {
                        if let Some(type_ann) = param.child_by_field_name("type") {
                            if let Some(wire) = type_annotation_to_wire(type_ann, ctx) {
                                return Some(wire);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn resolve_local_identifier(ident_node: Node, ident_name: &str, ctx: &ShapeContext) -> Option<WireType> {
    let mut current = ident_node.parent();
    while let Some(parent) = current {
        if parent.kind() == "statement_block" || parent.kind() == "program" {
            let mut cursor = parent.walk();
            for stmt in parent.named_children(&mut cursor) {
                if stmt.end_byte() > ident_node.start_byte() {
                    continue;
                }
                if let Some(resolved) = inspect_statement_for_ident(stmt, ident_name, ctx) {
                    return Some(resolved);
                }
            }
        } else if parent.kind() == "arrow_function"
            || parent.kind() == "function_declaration"
            || parent.kind() == "function_expression"
            || parent.kind() == "method_definition"
        {
            if let Some(params) = parent.child_by_field_name("parameters") {
                if let Some(resolved) = inspect_params_for_ident(params, ident_name, ctx) {
                    return Some(resolved);
                }
            }
        }
        current = parent.parent();
    }
    None
}
