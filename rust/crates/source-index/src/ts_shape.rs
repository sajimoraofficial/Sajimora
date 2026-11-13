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
    ArrayWireType, ObjectWireType, PrimitiveScalar, PrimitiveWireType, RefWireType,
    SourceLanguage, SourceProvenance, UnionWireType, UnknownWireType, WirePropertyContract,
    WireType,
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
    if node.kind() == "as_expression" || node.kind() == "satisfies_expression" {
        if let Some(type_child) = node.child_by_field_name("type").or_else(|| node.named_child(1)) {
            let type_str = text(type_child, ctx.content).trim();
            if type_str != "const" {
                if let Some(wire) = type_annotation_to_wire(type_child, ctx) {
                    return wire;
                }
            }
        }
    }
    if node.kind() == "type_assertion" {
        if let Some(type_child) = node.child_by_field_name("type").or_else(|| node.named_child(0)) {
            if let Some(wire) = type_annotation_to_wire(type_child, ctx) {
                return wire;
            }
        }
    }

    let node = unwrap_expression(node);
    match node.kind() {
        "string" | "template_string" => primitive(node, PrimitiveScalar::String, ctx),
        "number" => primitive(node, PrimitiveScalar::Number, ctx),
        "true" | "false" => primitive(node, PrimitiveScalar::Boolean, ctx),
        "object" => object_literal(node, ctx)
            .unwrap_or_else(|| unknown(node, "object literal could not be read", ctx)),
        "array" => {
            let mut cursor = node.walk();
            let mut elements = Vec::new();
            for child in node.named_children(&mut cursor) {
                let wire = value_wire(child, ctx);
                elements.push(wire);
            }
            let element_type = if elements.is_empty() {
                unknown(node, "empty array has no element type", ctx)
            } else {
                let mut combined = elements.remove(0);
                for next in elements {
                    combined = merge_wire_types(combined, next);
                }
                combined
            };
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

fn merge_wire_types(mut a: WireType, b: WireType) -> WireType {
    if a == b {
        return a;
    }
    match (&mut a, &b) {
        (WireType::Object(ref mut obj_a), WireType::Object(obj_b)) => {
            for prop_b in &obj_b.properties {
                if let Some(prop_a) = obj_a.properties.iter_mut().find(|p| p.wire_name == prop_b.wire_name) {
                    if prop_a.r#type != prop_b.r#type {
                        prop_a.r#type = WireType::Union(UnionWireType {
                            types: vec![prop_a.r#type.clone(), prop_b.r#type.clone()],
                            provenance: prop_a.provenance.clone(),
                        });
                    }
                } else {
                    let mut optional_prop = prop_b.clone();
                    optional_prop.optional = true;
                    obj_a.properties.push(optional_prop);
                }
            }
            a
        }
        (WireType::Unknown(_), _) => b,
        (_, WireType::Unknown(_)) => a,
        _ => WireType::Union(UnionWireType {
            types: vec![a, b],
            provenance: None,
        }),
    }
}

fn is_valid_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' || c == '$' => {
            chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        }
        _ => false,
    }
}

fn is_reserved_type_keyword(s: &str) -> bool {
    matches!(
        s,
        "any"
            | "unknown"
            | "never"
            | "object"
            | "Function"
            | "Record"
            | "null"
            | "undefined"
            | "true"
            | "false"
            | "const"
    )
}

fn strip_outer_parens(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.starts_with('(') && trimmed.ends_with(')') {
        let mut depth = 0;
        for (i, c) in trimmed.char_indices() {
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
                if depth == 0 && i < trimmed.len() - 1 {
                    return trimmed;
                }
            }
        }
        if depth == 0 {
            return strip_outer_parens(&trimmed[1..trimmed.len() - 1]);
        }
    }
    trimmed
}

fn parse_type_annotation_str(raw: &str, node: Node, ctx: &ShapeContext) -> Option<WireType> {
    let trimmed = raw.trim().trim_start_matches(':').trim();
    if trimmed.is_empty() {
        return None;
    }
    let trimmed = strip_outer_parens(trimmed);

    // Array types: T[]
    if trimmed.ends_with("[]") {
        let inner = trimmed[..trimmed.len() - 2].trim();
        let elem_wire = parse_type_annotation_str(inner, node, ctx)?;
        return Some(WireType::Array(ArrayWireType {
            element_type: Box::new(elem_wire),
            is_stream_or_flux: Some(false),
            provenance: Some(ctx.prov(node, trimmed)),
        }));
    }

    // Generic Array: Array<T> or ReadonlyArray<T>
    if trimmed.starts_with("Array<") && trimmed.ends_with('>') {
        let inner = trimmed[6..trimmed.len() - 1].trim();
        let elem_wire = parse_type_annotation_str(inner, node, ctx)?;
        return Some(WireType::Array(ArrayWireType {
            element_type: Box::new(elem_wire),
            is_stream_or_flux: Some(false),
            provenance: Some(ctx.prov(node, trimmed)),
        }));
    }
    if trimmed.starts_with("ReadonlyArray<") && trimmed.ends_with('>') {
        let inner = trimmed[14..trimmed.len() - 1].trim();
        let elem_wire = parse_type_annotation_str(inner, node, ctx)?;
        return Some(WireType::Array(ArrayWireType {
            element_type: Box::new(elem_wire),
            is_stream_or_flux: Some(false),
            provenance: Some(ctx.prov(node, trimmed)),
        }));
    }

    // Inline object type: { id: string; name: string }
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let body = &trimmed[1..trimmed.len() - 1].trim();
        let mut properties = Vec::new();
        for field_part in body.split(|c| c == ';' || c == ',') {
            let part = field_part.trim();
            if part.is_empty() {
                continue;
            }
            if let Some(colon_idx) = part.find(':') {
                let name_part = part[..colon_idx].trim();
                let type_part = part[colon_idx + 1..].trim();
                let is_optional = name_part.ends_with('?');
                let wire_name = name_part.trim_end_matches('?').trim().to_string();
                if let Some(prop_wire) = parse_type_annotation_str(type_part, node, ctx) {
                    properties.push(WirePropertyContract {
                        wire_name: wire_name.clone(),
                        aliases: Vec::new(),
                        r#type: prop_wire,
                        optional: is_optional,
                        nullable: false,
                        server_assigned: false,
                        validation_constraints: Vec::new(),
                        provenance: Some(ctx.prov(node, &wire_name)),
                    });
                }
            }
        }
        if !properties.is_empty() {
            return Some(WireType::Object(ObjectWireType {
                name: None,
                properties,
                strict: Some(false),
                provenance: Some(ctx.prov(node, trimmed)),
            }));
        }
    }

    // Primitives
    match trimmed {
        "string" => return Some(primitive(node, PrimitiveScalar::String, ctx)),
        "number" => return Some(primitive(node, PrimitiveScalar::Number, ctx)),
        "boolean" => return Some(primitive(node, PrimitiveScalar::Boolean, ctx)),
        "bigint" => return Some(primitive(node, PrimitiveScalar::BigInt, ctx)),
        "void" => return Some(primitive(node, PrimitiveScalar::Void, ctx)),
        "any" => return Some(primitive(node, PrimitiveScalar::Any, ctx)),
        _ => {}
    }

    // Single type identifier reference e.g. UserDto
    if is_valid_ident(trimmed) && !is_reserved_type_keyword(trimmed) {
        return Some(WireType::Ref(RefWireType {
            r#ref: trimmed.to_string(),
            provenance: Some(ctx.prov(node, trimmed)),
        }));
    }

    None
}

fn type_annotation_to_wire(type_node: Node, ctx: &ShapeContext) -> Option<WireType> {
    let raw = text(type_node, ctx.content)
        .trim()
        .trim_start_matches(':')
        .trim();
    parse_type_annotation_str(raw, type_node, ctx)
}

fn is_empty_or_unknown_array(wire: &WireType) -> bool {
    match wire {
        WireType::Array(arr) => contains_unknown(&arr.element_type),
        _ => false,
    }
}

fn find_array_mutations(
    scope_node: Node,
    ident_name: &str,
    after_byte: usize,
    before_byte: usize,
    ctx: &ShapeContext,
) -> Option<WireType> {
    let mut cursor = scope_node.walk();
    let mut inferred_elements: Vec<WireType> = Vec::new();

    for child in scope_node.named_children(&mut cursor) {
        if child.end_byte() <= after_byte {
            continue;
        }
        if child.start_byte() >= before_byte {
            break;
        }
        collect_mutations_recursive(child, ident_name, ctx, &mut inferred_elements);
    }

    if inferred_elements.is_empty() {
        return None;
    }

    let mut combined = inferred_elements.remove(0);
    for next in inferred_elements {
        combined = merge_wire_types(combined, next);
    }

    Some(WireType::Array(ArrayWireType {
        element_type: Box::new(combined),
        is_stream_or_flux: Some(false),
        provenance: Some(ctx.prov(scope_node, "array-inferred-mutation")),
    }))
}

fn collect_mutations_recursive(
    node: Node,
    ident_name: &str,
    ctx: &ShapeContext,
    out: &mut Vec<WireType>,
) {
    if node.kind() == "call_expression" {
        if let Some(func) = node.child_by_field_name("function") {
            if func.kind() == "member_expression" {
                if let (Some(obj), Some(prop)) = (
                    func.child_by_field_name("object"),
                    func.child_by_field_name("property"),
                ) {
                    if text(obj, ctx.content).trim() == ident_name {
                        let method_name = text(prop, ctx.content).trim();
                        if method_name == "push" || method_name == "unshift" {
                            if let Some(args) = node.child_by_field_name("arguments") {
                                let mut arg_cursor = args.walk();
                                for arg in args.named_children(&mut arg_cursor) {
                                    let wire = value_wire(arg, ctx);
                                    if !contains_unknown(&wire) {
                                        out.push(wire);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if node.kind() == "assignment_expression" {
        if let (Some(left), Some(right)) = (
            node.child_by_field_name("left"),
            node.child_by_field_name("right"),
        ) {
            if text(left, ctx.content).trim() == ident_name {
                let right_wire = value_wire(right, ctx);
                if let WireType::Array(arr) = right_wire {
                    if !contains_unknown(&arr.element_type) {
                        out.push(*arr.element_type);
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_mutations_recursive(child, ident_name, ctx, out);
    }
}

fn inspect_statement_for_ident(
    stmt: Node,
    ident_name: &str,
    scope_block: Node,
    ident_node: Node,
    ctx: &ShapeContext,
) -> Option<WireType> {
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
                                            if let Some(type_child) = val.child_by_field_name("type").or_else(|| val.named_child(1)) {
                                                if let Some(wire) = type_annotation_to_wire(type_child, ctx) {
                                                    return Some(wire);
                                                }
                                            }
                                        }
                                        let wire = value_wire(val, ctx);
                                        if is_empty_or_unknown_array(&wire) {
                                            if let Some(inferred_arr) = find_array_mutations(
                                                scope_block,
                                                ident_name,
                                                stmt.end_byte(),
                                                ident_node.start_byte(),
                                                ctx,
                                            ) {
                                                return Some(inferred_arr);
                                            }
                                        }
                                        if !matches!(wire, WireType::Unknown(_)) {
                                            return Some(wire);
                                        }
                                    } else {
                                        if let Some(inferred_arr) = find_array_mutations(
                                            scope_block,
                                            ident_name,
                                            stmt.end_byte(),
                                            ident_node.start_byte(),
                                            ctx,
                                        ) {
                                            return Some(inferred_arr);
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
                if let Some(resolved) = inspect_statement_for_ident(stmt, ident_name, parent, ident_node, ctx) {
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

/// Read an object literal, array literal, or identifier response body.
pub(crate) fn response_shape_wire(node: Node, ctx: &ShapeContext) -> Option<WireType> {
    if let Some(shape) = object_literal(node, ctx) {
        return Some(shape);
    }
    let unwrapped = unwrap_expression(node);
    if unwrapped.kind() == "array" {
        return Some(value_wire(node, ctx));
    }
    if unwrapped.kind() == "identifier" {
        let ident_name = text(unwrapped, ctx.content).trim();
        if let Some(resolved) = resolve_local_identifier(unwrapped, ident_name, ctx) {
            return Some(resolved);
        }
    }
    None
}
