//! inclusion.rs -- Directional wire-type inclusion checking.
//!
//! Exact port of WireInclusion.ts.
//!
//! All values produced must be admitted by the accepted type.
//! Unsupported facts remain UNRESOLVED (unresolved=true in WireIssue).
//!
//! Key rules (frozen in R0 spec):
//! - UNKNOWN or scalar=any at any position -> UNRESOLVED issue (not a mismatch)
//! - depth > 80 -> budget exceeded, UNRESOLVED
//! - null/optional wrapper mismatch -> definite issues
//! - Union on accepted side: check if ANY branch covers produced; all fail -> issue
//! - Produced union: each branch must be covered by accepted
//! - LITERAL: check exact value match, enum membership, or typeof == primitive scalar
//! - OBJECT: check each required accepted field; strict extra-field rejection

use crate::ir::{NullableWireType, OptionalWireType, WirePropertyContract, WireType};
use serde_json::Value;

// ---------------------------------------------------------------------------
// WireIssue
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct WireIssue {
    pub path: String,
    pub reason: String,
    pub before: String,
    pub after: String,
    /// True = unresolved fact (INCONCLUSIVE), false = definite mismatch (LIKELY_VIOLATED)
    pub unresolved: bool,
}

impl WireIssue {
    fn new(path: &str, reason: &str, before: &str, after: &str) -> Self {
        WireIssue {
            path: path.to_string(),
            reason: reason.to_string(),
            before: before.to_string(),
            after: after.to_string(),
            unresolved: false,
        }
    }
    fn unresolved(path: &str, reason: &str, before: &str, after: &str) -> Self {
        WireIssue {
            path: path.to_string(),
            reason: reason.to_string(),
            before: before.to_string(),
            after: after.to_string(),
            unresolved: true,
        }
    }
}

// ---------------------------------------------------------------------------
// propertyType -- mirrors WireInclusion.ts:propertyType
// ---------------------------------------------------------------------------

/// Normalize field metadata: optional means omitted, never null.
pub fn property_type(p: &WirePropertyContract) -> WireType {
    let mut t = p.r#type.clone();
    if p.nullable && !matches!(t, WireType::Nullable(_)) {
        t = WireType::Nullable(NullableWireType {
            inner_type: Box::new(t),
            provenance: None,
        });
    }
    if p.optional && !matches!(t, WireType::Optional(_)) {
        t = WireType::Optional(OptionalWireType {
            inner_type: Box::new(t),
            provenance: None,
        });
    }
    t
}

// ---------------------------------------------------------------------------
// unwrap -- strip nullable/optional wrappers
// ---------------------------------------------------------------------------

fn unwrap_type(mut t: &WireType) -> (&WireType, bool, bool) {
    let mut nullable = false;
    let mut optional = false;
    loop {
        match t {
            WireType::Nullable(n) => {
                nullable = true;
                t = &n.inner_type;
            }
            WireType::Optional(o) => {
                optional = true;
                t = &o.inner_type;
            }
            _ => break,
        }
    }
    (t, nullable, optional)
}

fn wrap_type(t: WireType, nullable: bool, optional: bool) -> WireType {
    let mut result = t;
    if nullable {
        result = WireType::Nullable(NullableWireType {
            inner_type: Box::new(result),
            provenance: None,
        });
    }
    if optional {
        result = WireType::Optional(OptionalWireType {
            inner_type: Box::new(result),
            provenance: None,
        });
    }
    result
}

/// Whether any accepted union branch admits `null`. Optional branches admit omission, not
/// null, so the two axes stay independent -- matching the wrapper checks on non-union types.
fn union_accepts_null(types: &[WireType]) -> bool {
    types.iter().any(|t| {
        let (inner, nullable, _) = unwrap_type(t);
        nullable || matches!(inner, WireType::Union(u) if union_accepts_null(&u.types))
    })
}

/// Whether any accepted union branch admits an omitted value.
fn union_accepts_omission(types: &[WireType]) -> bool {
    types.iter().any(|t| {
        let (inner, _, optional) = unwrap_type(t);
        optional || matches!(inner, WireType::Union(u) if union_accepts_omission(&u.types))
    })
}

// ---------------------------------------------------------------------------
// wire_inclusion -- mirrors WireInclusion.ts:wireInclusion exactly
// ---------------------------------------------------------------------------

pub fn wire_inclusion(
    produced: &WireType,
    accepted: &WireType,
    path: &str,
    depth: usize,
) -> Vec<WireIssue> {
    if depth > 80 {
        return vec![WireIssue::unresolved(
            path,
            "wire recursion budget exceeded",
            &kind_name(produced),
            &kind_name(accepted),
        )];
    }

    let (p_inner, p_nullable, p_optional) = unwrap_type(produced);
    let (a_inner, a_nullable, a_optional) = unwrap_type(accepted);

    // UNKNOWN or any -> UNRESOLVED. An UNKNOWN carries the extractor's own
    // reason; it is part of the evidence, so the unresolved issue names it
    // instead of collapsing every abstention to the same sentence.
    if matches!(p_inner, WireType::Unknown(_)) || matches!(a_inner, WireType::Unknown(_)) {
        let mut causes: Vec<String> = Vec::new();
        if let WireType::Unknown(unknown) = p_inner {
            causes.push(format!("producer: {}", unknown.reason));
        }
        if let WireType::Unknown(unknown) = a_inner {
            causes.push(format!("consumer: {}", unknown.reason));
        }
        let reason = if causes.is_empty() {
            "wire contract is unresolved".to_string()
        } else {
            format!("wire contract is unresolved ({})", causes.join("; "))
        };
        return vec![WireIssue::unresolved(
            path,
            &reason,
            &kind_name(p_inner),
            &kind_name(a_inner),
        )];
    }
    if is_any_primitive(p_inner) || is_any_primitive(a_inner) {
        return vec![WireIssue::unresolved(
            path,
            "wire contract is unresolved",
            &kind_name(p_inner),
            &kind_name(a_inner),
        )];
    }

    // Accepted is UNION -- try each branch.
    //
    // Nullability and optionality belong to the union as a whole: a produced nullable value is
    // accepted when ANY branch (or the union itself) accepts null. Probing every branch with the
    // wrapped produced type reported the same wrapper mismatch once per branch, and the enum
    // fallback below then repeated it once per enum value, collapsing a single nullable-to-
    // non-nullable disagreement into a pile of identical `LITERAL -> UNION` findings. Decide the
    // wrappers once, then test branch coverage on the unwrapped core so value coverage and
    // wrapper acceptance cannot contaminate each other.
    if let WireType::Union(a_union) = a_inner {
        let mut wrapper_issues: Vec<WireIssue> = vec![];
        if p_nullable && !(a_nullable || union_accepts_null(&a_union.types)) {
            wrapper_issues.push(WireIssue::new(
                path,
                "consumer does not accept null",
                "non-null",
                "nullable",
            ));
        }
        if p_optional && !(a_optional || union_accepts_omission(&a_union.types)) {
            wrapper_issues.push(WireIssue::new(
                path,
                "consumer does not accept omission",
                "required",
                "optional",
            ));
        }

        let core = wrap_type(p_inner.clone(), false, false);
        let trials: Vec<Vec<WireIssue>> = a_union
            .types
            .iter()
            .map(|t| {
                let wrapped = wrap_type(t.clone(), a_nullable, a_optional);
                wire_inclusion(&core, &wrapped, path, depth + 1)
            })
            .collect();

        // Any branch covers the produced value -> only a wrapper disagreement can remain
        if trials.iter().any(|t| t.is_empty()) {
            return wrapper_issues;
        }

        // Produced union: each branch must be covered by one of the accepted branches
        if let WireType::Union(p_union) = p_inner {
            let mut issues = wrapper_issues;
            for t in &p_union.types {
                issues.extend(wire_inclusion(t, accepted, path, depth + 1));
            }
            return issues;
        }

        // One issue per position, not one per enum value: the produced enum's values all fail
        // for the same reason, and per-value collection only manufactured colliding finding ids.
        let has_unresolved = trials.iter().any(|t| t.iter().any(|i| i.unresolved));
        wrapper_issues.push(WireIssue {
            path: path.to_string(),
            reason: "no accepted union branch covers produced values".to_string(),
            before: kind_name(p_inner),
            after: "UNION".to_string(),
            unresolved: has_unresolved,
        });
        return wrapper_issues;
    }

    let mut issues: Vec<WireIssue> = vec![];

    // Nullable/optional wrapper checks
    if p_nullable && !a_nullable {
        issues.push(WireIssue::new(
            path,
            "consumer does not accept null",
            "non-null",
            "nullable",
        ));
    }
    if p_optional && !a_optional {
        issues.push(WireIssue::new(
            path,
            "consumer does not accept omission",
            "required",
            "optional",
        ));
    }

    let x = p_inner;
    let y = a_inner;

    // Produced union: each branch against accepted
    if let WireType::Union(p_union) = x {
        let extra: Vec<WireIssue> = p_union
            .types
            .iter()
            .flat_map(|t| wire_inclusion(t, accepted, path, depth + 1))
            .collect();
        issues.extend(extra);
        return issues;
    }

    // Produced enum: each value as literal against accepted
    if let WireType::Enum(p_enum) = x {
        let extra: Vec<WireIssue> = p_enum
            .values
            .iter()
            .flat_map(|v| {
                let lit = WireType::Literal(crate::ir::LiteralWireType {
                    value: v.clone(),
                    provenance: None,
                });
                wire_inclusion(&lit, y, path, depth + 1)
            })
            .collect();
        issues.extend(extra);
        return issues;
    }

    // LITERAL inclusion
    if let WireType::Literal(p_lit) = x {
        let ok = match y {
            WireType::Literal(a_lit) => literal_eq(&p_lit.value, &a_lit.value),
            WireType::Enum(a_enum) => a_enum.values.iter().any(|v| literal_eq(&p_lit.value, v)),
            WireType::Primitive(a_prim) => typeof_matches_scalar(&p_lit.value, &a_prim.scalar),
            _ => false,
        };
        if !ok {
            issues.push(WireIssue::new(
                path,
                "literal value is rejected",
                &serde_json::to_string(&p_lit.value).unwrap_or_default(),
                &kind_name(y),
            ));
        }
        return issues;
    }

    // PRIMITIVE vs PRIMITIVE
    if let (WireType::Primitive(px), WireType::Primitive(ay)) = (x, y) {
        if px.scalar != ay.scalar {
            issues.push(WireIssue::new(
                path,
                "primitive type mismatch",
                serde_json::to_value(&ay.scalar).unwrap().as_str().unwrap(),
                serde_json::to_value(&px.scalar).unwrap().as_str().unwrap(),
            ));
        }
        return issues;
    }

    // ARRAY vs ARRAY
    if let (WireType::Array(pa), WireType::Array(aa)) = (x, y) {
        let sub = wire_inclusion(
            &pa.element_type,
            &aa.element_type,
            &format!("{}[]", path),
            depth + 1,
        );
        issues.extend(sub);
        return issues;
    }

    // OBJECT vs OBJECT
    if let (WireType::Object(po), WireType::Object(ao)) = (x, y) {
        use std::collections::{HashMap, HashSet};
        // Only the wire name is emitted on the wire. Aliases are deserialization-only
        // (Jackson `@JsonAlias`), so a producer alias must not stand in for a field the
        // consumer actually reads; that would hide a field the consumer never receives.
        let mut supplied: HashMap<&str, &WirePropertyContract> = HashMap::new();
        for p in &po.properties {
            supplied.insert(p.wire_name.as_str(), p);
        }
        let required: HashSet<&str> = ao.properties.iter().map(|p| p.wire_name.as_str()).collect();

        // Declaration order, not hash order: report bytes must not depend on a
        // per-process hash seed.
        for target in &ao.properties {
            let name = target.wire_name.as_str();
            let field_path = format!("{}.{}", path, name);
            let accepted_type = property_type(target);
            let (_, _, a_opt) = unwrap_type(&accepted_type);
            let source_opt = supplied.get(name).copied().or_else(|| {
                target
                    .aliases
                    .iter()
                    .find_map(|a| supplied.get(a.as_str()).copied())
            });
            match source_opt {
                None => {
                    if !a_opt {
                        issues.push(WireIssue::new(
                            &field_path,
                            "required field is absent",
                            "required",
                            "missing",
                        ));
                    }
                }
                Some(source) => {
                    let produced_type = property_type(source);
                    let sub =
                        wire_inclusion(&produced_type, &accepted_type, &field_path, depth + 1);
                    issues.extend(sub);
                    // Validation constraint propagation
                    for constraint in &target.validation_constraints {
                        let proven = source
                            .validation_constraints
                            .iter()
                            .any(|c| c.kind == constraint.kind && c.value == constraint.value);
                        if !proven {
                            issues.push(WireIssue::unresolved(
                                &field_path,
                                &format!(
                                    "unresolved accepted constraint {}",
                                    serde_json::to_value(&constraint.kind)
                                        .unwrap()
                                        .as_str()
                                        .unwrap()
                                ),
                                "constraint",
                                "unproven",
                            ));
                        }
                    }
                }
            }
        }

        // Strict extra-field rejection
        if ao.strict.unwrap_or(false) {
            for source in &po.properties {
                if !required.contains(source.wire_name.as_str()) {
                    issues.push(WireIssue::new(
                        &format!("{}.{}", path, source.wire_name),
                        "strict decoder rejects extra field",
                        "absent",
                        "added",
                    ));
                }
            }
        }
        return issues;
    }

    // MAP vs MAP
    if let (WireType::Map(pm), WireType::Map(am)) = (x, y) {
        let key_issues = wire_inclusion(
            &pm.key_type,
            &am.key_type,
            &format!("{}.key", path),
            depth + 1,
        );
        let val_issues = wire_inclusion(
            &pm.value_type,
            &am.value_type,
            &format!("{}.*", path),
            depth + 1,
        );
        issues.extend(key_issues);
        issues.extend(val_issues);
        return issues;
    }

    // Same kind but not handled above -> UNRESOLVED
    if kind_name(x) == kind_name(y) {
        issues.push(WireIssue::unresolved(
            path,
            "unsupported wire inclusion",
            &kind_name(x),
            &kind_name(y),
        ));
        return issues;
    }

    // Shape mismatch
    issues.push(WireIssue::new(
        path,
        "shape mismatch",
        &kind_name(y),
        &kind_name(x),
    ));
    issues
}

fn kind_name(t: &WireType) -> String {
    match t {
        WireType::Primitive(_) => "PRIMITIVE".to_string(),
        WireType::Object(_) => "OBJECT".to_string(),
        WireType::Array(_) => "ARRAY".to_string(),
        WireType::Union(_) => "UNION".to_string(),
        WireType::Enum(_) => "ENUM".to_string(),
        WireType::Nullable(_) => "NULLABLE".to_string(),
        WireType::Optional(_) => "OPTIONAL".to_string(),
        WireType::Map(_) => "MAP".to_string(),
        WireType::Literal(_) => "LITERAL".to_string(),
        WireType::Unknown(_) => "UNKNOWN".to_string(),
        WireType::Ref(_) => "REF".to_string(),
    }
}

fn is_any_primitive(t: &WireType) -> bool {
    matches!(t, WireType::Primitive(p) if matches!(p.scalar, crate::ir::PrimitiveScalar::Any))
}

fn literal_eq(a: &Value, b: &Value) -> bool {
    // Exact deep equality (matches JS ===)
    a == b
}

fn typeof_matches_scalar(v: &Value, scalar: &crate::ir::PrimitiveScalar) -> bool {
    use crate::ir::PrimitiveScalar;
    match scalar {
        PrimitiveScalar::String => v.is_string(),
        PrimitiveScalar::Number => v.is_number(),
        PrimitiveScalar::Boolean => v.is_boolean(),
        PrimitiveScalar::Any | PrimitiveScalar::Void | PrimitiveScalar::BigInt => false,
    }
}

// ---------------------------------------------------------------------------
// Public convenience: compute verdict from issues
// ---------------------------------------------------------------------------

pub fn issues_verdict(issues: &[WireIssue]) -> crate::envelope::ArtifactComparisonVerdict {
    if issues.iter().any(|i| !i.unresolved) {
        crate::envelope::ArtifactComparisonVerdict::LikelyViolated
    } else if issues.iter().any(|i| i.unresolved) {
        crate::envelope::ArtifactComparisonVerdict::Inconclusive
    } else {
        crate::envelope::ArtifactComparisonVerdict::LikelyPreserved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::*;
    use serde_json::json;

    fn prim(scalar: PrimitiveScalar) -> WireType {
        WireType::Primitive(PrimitiveWireType {
            scalar,
            format: None,
            provenance: None,
        })
    }
    fn string() -> WireType {
        prim(PrimitiveScalar::String)
    }
    fn number() -> WireType {
        prim(PrimitiveScalar::Number)
    }
    fn lit(v: serde_json::Value) -> WireType {
        WireType::Literal(LiteralWireType {
            value: v,
            provenance: None,
        })
    }
    fn nullable(t: WireType) -> WireType {
        WireType::Nullable(NullableWireType {
            inner_type: Box::new(t),
            provenance: None,
        })
    }
    #[allow(dead_code)]
    fn optional(t: WireType) -> WireType {
        WireType::Optional(OptionalWireType {
            inner_type: Box::new(t),
            provenance: None,
        })
    }
    fn unknown(reason: &str) -> WireType {
        WireType::Unknown(UnknownWireType {
            reason: reason.to_string(),
            provenance: None,
        })
    }

    fn object(fields: Vec<(&str, WireType)>, strict: bool) -> WireType {
        WireType::Object(ObjectWireType {
            name: None,
            properties: fields
                .into_iter()
                .map(|(name, r#type)| WirePropertyContract {
                    wire_name: name.to_string(),
                    aliases: vec![],
                    r#type,
                    optional: false,
                    nullable: false,
                    server_assigned: false,
                    validation_constraints: vec![],
                    provenance: None,
                })
                .collect(),
            strict: Some(strict),
            provenance: None,
        })
    }

    /// Even the *order* of report evidence is part of the determinism promise. Object
    /// fields are declared in a `Vec`, so collected issues must follow that order and
    /// never a per-process hash seed.
    #[test]
    fn object_field_issues_follow_declaration_order() {
        let produced = object(vec![], false);
        let accepted = object(
            vec![
                ("zeta", unknown("test")),
                ("alpha", unknown("test")),
                ("mike", unknown("test")),
            ],
            false,
        );
        for _ in 0..16 {
            let issues = wire_inclusion(&produced, &accepted, "$", 0);
            let paths: Vec<&str> = issues.iter().map(|i| i.path.as_str()).collect();
            assert_eq!(paths, vec!["$.zeta", "$.alpha", "$.mike"]);
        }
    }

    #[test]
    fn strict_extra_field_issues_follow_producer_declaration_order() {
        let produced = object(
            vec![("zeta", string()), ("alpha", string()), ("mike", string())],
            false,
        );
        let accepted = object(vec![], true);
        for _ in 0..16 {
            let issues = wire_inclusion(&produced, &accepted, "$", 0);
            let paths: Vec<&str> = issues.iter().map(|i| i.path.as_str()).collect();
            assert_eq!(paths, vec!["$.zeta", "$.alpha", "$.mike"]);
        }
    }

    #[test]
    fn identical_primitives_no_issues() {
        assert!(wire_inclusion(&string(), &string(), "$", 0).is_empty());
    }

    #[test]
    fn primitive_mismatch() {
        let issues = wire_inclusion(&string(), &number(), "$", 0);
        assert_eq!(issues.len(), 1);
        assert!(!issues[0].unresolved);
        assert_eq!(issues[0].reason, "primitive type mismatch");
    }

    #[test]
    fn unknown_produced_is_unresolved() {
        let issues = wire_inclusion(&unknown("x"), &string(), "$", 0);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].unresolved);
    }

    #[test]
    fn nullable_produced_not_accepted_is_issue() {
        let issues = wire_inclusion(&nullable(string()), &string(), "$", 0);
        assert!(issues.iter().any(|i| i.reason.contains("null")));
    }

    #[test]
    fn nullable_produced_nullable_accepted_ok() {
        let issues = wire_inclusion(&nullable(string()), &nullable(string()), "$", 0);
        assert!(issues.is_empty());
    }

    #[test]
    fn literal_string_vs_string_primitive_ok() {
        let issues = wire_inclusion(&lit(json!("hello")), &string(), "$", 0);
        assert!(issues.is_empty());
    }

    #[test]
    fn literal_mismatch_rejected() {
        let issues = wire_inclusion(&lit(json!("hello")), &number(), "$", 0);
        assert!(!issues.is_empty());
        assert!(!issues[0].unresolved);
    }

    #[test]
    fn depth_budget_exceeded() {
        let issues = wire_inclusion(&string(), &string(), "$", 81);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].unresolved);
        assert!(issues[0].reason.contains("budget"));
    }

    #[test]
    fn union_accepted_covers_produced() {
        let accepted = WireType::Union(UnionWireType {
            types: vec![string(), number()],
            provenance: None,
        });
        let issues = wire_inclusion(&string(), &accepted, "$", 0);
        assert!(issues.is_empty());
    }

    #[test]
    fn union_accepted_no_branch_covers() {
        let accepted = WireType::Union(UnionWireType {
            types: vec![
                number(),
                WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Boolean,
                    format: None,
                    provenance: None,
                }),
            ],
            provenance: None,
        });
        let issues = wire_inclusion(&string(), &accepted, "$", 0);
        assert!(!issues.is_empty());
    }

    fn enum_of(values: &[&str]) -> WireType {
        WireType::Enum(EnumWireType {
            name: None,
            values: values.iter().map(|v| json!(*v)).collect(),
            provenance: None,
        })
    }

    fn union(types: Vec<WireType>) -> WireType {
        WireType::Union(UnionWireType {
            types,
            provenance: None,
        })
    }

    /// A nullable producer over a covering union is a nullability disagreement, not a value
    /// rejection. Reporting it per branch/per enum value produced duplicate findings and the
    /// misleading `LITERAL -> UNION` change class (seen in the ThingsBoard pair run).
    #[test]
    fn nullable_enum_over_covering_union_reports_nullability_once() {
        let produced = nullable(enum_of(&["A", "B"]));
        let accepted = union(vec![enum_of(&["A", "B"]), enum_of(&["B", "C"])]);
        let issues = wire_inclusion(&produced, &accepted, "$.type", 0);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].reason, "consumer does not accept null");
        assert_eq!(issues[0].before, "non-null");
        assert_eq!(issues[0].after, "nullable");
    }

    #[test]
    fn nullable_enum_over_union_missing_value_reports_null_and_coverage_once() {
        let produced = nullable(enum_of(&["A", "B"]));
        let accepted = union(vec![enum_of(&["A"])]);
        let issues = wire_inclusion(&produced, &accepted, "$.type", 0);
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert_eq!(issues[0].reason, "consumer does not accept null");
        assert_eq!(
            issues[1].reason,
            "no accepted union branch covers produced values"
        );
        assert_eq!(issues[1].before, "ENUM");
        assert_eq!(issues[1].after, "UNION");
    }

    #[test]
    fn nullable_union_branch_admits_nullable_produced() {
        let produced = nullable(enum_of(&["A"]));
        let accepted = union(vec![nullable(enum_of(&["A"])), string()]);
        let issues = wire_inclusion(&produced, &accepted, "$.type", 0);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn optional_enum_over_covering_union_reports_omission_once() {
        let produced = optional(enum_of(&["A"]));
        let accepted = union(vec![enum_of(&["A"]), string()]);
        let issues = wire_inclusion(&produced, &accepted, "$.type", 0);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].reason, "consumer does not accept omission");
    }

    #[test]
    fn property_alias_matches_accepted_property() {
        // Produced wire has "user_name"
        let produced = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "user_name".to_string(),
                aliases: vec![],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        // Accepted expects "userName" with alias "user_name"
        let accepted = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "userName".to_string(),
                aliases: vec!["user_name".to_string(), "login".to_string()],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        let issues = wire_inclusion(&produced, &accepted, "$", 0);
        assert!(
            issues.is_empty(),
            "Alias match must satisfy accepted property: {:?}",
            issues
        );
    }

    #[test]
    fn property_alias_mismatch_fails() {
        // Produced wire has "wrong_field"
        let produced = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "wrong_field".to_string(),
                aliases: vec![],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        // Accepted expects "userName" with aliases
        let accepted = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "userName".to_string(),
                aliases: vec!["user_name".to_string()],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        let issues = wire_inclusion(&produced, &accepted, "$", 0);
        assert!(
            !issues.is_empty(),
            "Incompatible field name without matching alias must fail"
        );
        assert!(issues
            .iter()
            .any(|i| i.reason.contains("required field is absent")));
    }

    #[test]
    fn producer_alias_does_not_satisfy_accepted_property() {
        // Java produces `userName` and declares `login` only as a deserialization alias.
        // Only `userName` reaches the wire, so a consumer that reads `login` is broken.
        let produced = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "userName".to_string(),
                aliases: vec!["login".to_string()],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        let accepted = WireType::Object(ObjectWireType {
            name: None,
            properties: vec![WirePropertyContract {
                wire_name: "login".to_string(),
                aliases: vec![],
                r#type: string(),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            }],
            strict: Some(false),
            provenance: None,
        });

        let issues = wire_inclusion(&produced, &accepted, "$", 0);
        assert_eq!(
            issues.len(),
            1,
            "producer alias must not satisfy the consumer: {:?}",
            issues
        );
        assert_eq!(issues[0].path, "$.login");
        assert!(!issues[0].unresolved);
        assert!(issues[0].reason.contains("required field is absent"));
    }
}
