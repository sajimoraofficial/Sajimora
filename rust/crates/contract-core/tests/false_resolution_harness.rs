//! UNKNOWN_REDUCTION_PLAN.md §0.4 — negative-mutation false-resolution harness.
//!
//! Drives `wire_inclusion` (the algebra every verdict claim funnels through) with
//! producer mutations of two kinds:
//! - BENIGN: changes a consumer cannot observe. Must add zero definite findings.
//! - SEEDED: breaks a contract the consumer does observe. Must add exactly the
//!   finding named in the row, at the exact path.
//!
//! A new inference rule is only allowed to raise the resolved count if it keeps
//! every row here green; suppressing a seeded finding to make a benign row pass is
//! the failure mode this file exists to catch.

use contract_core::inclusion::{wire_inclusion, WireIssue};
use contract_core::ir::{
    ArrayWireType, EnumWireType, ObjectWireType, PrimitiveScalar, PrimitiveWireType, RefWireType,
    UnionWireType, UnknownWireType, ValidationConstraint, ValidationConstraintKind,
    WirePropertyContract, WireType,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

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

fn boolean() -> WireType {
    prim(PrimitiveScalar::Boolean)
}

fn any() -> WireType {
    prim(PrimitiveScalar::Any)
}

fn unknown(reason: &str) -> WireType {
    WireType::Unknown(UnknownWireType {
        reason: reason.to_string(),
        provenance: None,
    })
}

fn field(name: &str, ty: WireType) -> WirePropertyContract {
    field_with(name, ty, false, false)
}

fn field_with(name: &str, ty: WireType, optional: bool, nullable: bool) -> WirePropertyContract {
    WirePropertyContract {
        wire_name: name.to_string(),
        aliases: vec![],
        r#type: ty,
        optional,
        nullable,
        server_assigned: false,
        validation_constraints: vec![],
        provenance: None,
    }
}

fn field_named(
    name: &str,
    ty: WireType,
    optional: bool,
    nullable: bool,
    constraints: Vec<ValidationConstraint>,
) -> WirePropertyContract {
    WirePropertyContract {
        wire_name: name.to_string(),
        aliases: vec![],
        r#type: ty,
        optional,
        nullable,
        server_assigned: false,
        validation_constraints: constraints,
        provenance: None,
    }
}

fn obj(name: Option<&str>, properties: Vec<WirePropertyContract>) -> WireType {
    obj_strict(name, properties, None)
}

fn obj_strict(
    name: Option<&str>,
    properties: Vec<WirePropertyContract>,
    strict: Option<bool>,
) -> WireType {
    WireType::Object(ObjectWireType {
        name: name.map(|n| n.to_string()),
        properties,
        strict,
        provenance: None,
    })
}

fn array(element: WireType, is_stream: Option<bool>) -> WireType {
    WireType::Array(ArrayWireType {
        element_type: Box::new(element),
        is_stream_or_flux: is_stream,
        provenance: None,
    })
}

fn union(types: Vec<WireType>) -> WireType {
    WireType::Union(UnionWireType {
        types,
        provenance: None,
    })
}

fn enum_of(values: Vec<&str>) -> WireType {
    WireType::Enum(EnumWireType {
        name: None,
        values: values.iter().map(|v| json!(*v)).collect(),
        provenance: None,
    })
}

fn min_constraint() -> Vec<ValidationConstraint> {
    vec![ValidationConstraint {
        kind: ValidationConstraintKind::Min,
        value: Some(json!(1)),
        message: None,
        provenance: None,
    }]
}

// ---------------------------------------------------------------------------
// Case table
// ---------------------------------------------------------------------------

struct Case {
    name: &'static str,
    consumer: WireType,
    producer_before: WireType,
    producer_after: WireType,
    /// (path, reason) pairs that MUST be reported as definite after the mutation.
    expected: &'static [(&'static str, &'static str)],
}

fn consumer_shape() -> WireType {
    obj(
        Some("ConsumerView"),
        vec![field("id", string()), field("name", string())],
    )
}

fn producer_clean() -> WireType {
    obj(
        Some("ProducerDto"),
        vec![
            field("id", string()),
            field("name", string()),
            field("internalNote", string()),
        ],
    )
}

fn benign_cases() -> Vec<Case> {
    vec![
        Case {
            name: "rename a field no consumer reads",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field("name", string()),
                    field("internalMemo", string()),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "drop a field no consumer reads",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![field("id", string()), field("name", string())],
            ),
            expected: &[],
        },
        Case {
            name: "add a field the non-strict consumer ignores",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field("name", string()),
                    field("internalNote", string()),
                    field("newFlag", boolean()),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "narrow a produced union to a branch the consumer accepts",
            consumer: obj(
                Some("ConsumerView"),
                vec![
                    field("id", string()),
                    field("value", union(vec![string(), number()])),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field("value", union(vec![string(), number()])),
                ],
            ),
            producer_after: obj(None, vec![field("id", string()), field("value", string())]),
            expected: &[],
        },
        Case {
            name: "reorder enum values without changing the set",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field("state", enum_of(vec!["a", "b"])),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field("state", enum_of(vec!["a", "b"])),
                ],
            ),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field("state", enum_of(vec!["b", "a"])),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "stop emitting null where the consumer tolerates it",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field_with("name", string(), false, true),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field_with("name", string(), false, true),
                ],
            ),
            producer_after: obj(None, vec![field("id", string()), field("name", string())]),
            expected: &[],
        },
        Case {
            name: "stop omitting a field the consumer treats as optional",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field_with("name", string(), true, false),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field_with("name", string(), true, false),
                ],
            ),
            producer_after: obj(None, vec![field("id", string()), field("name", string())]),
            expected: &[],
        },
        Case {
            name: "add a producer-side constraint the consumer never asked for",
            consumer: obj(
                Some("ConsumerView"),
                vec![field("id", string()), field("count", number())],
            ),
            producer_before: obj(None, vec![field("id", string()), field("count", number())]),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field_named("count", number(), false, false, min_constraint()),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "serve the same array elements as a stream",
            consumer: obj(
                None,
                vec![field("id", string()), field("items", array(string(), None))],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field("items", array(string(), Some(false))),
                ],
            ),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field("items", array(string(), Some(true))),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "rename the producer type and provenance only",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDtoRenamed"),
                vec![
                    field("id", string()),
                    field("name", string()),
                    field("internalNote", string()),
                ],
            ),
            expected: &[],
        },
        Case {
            name: "type a field precisely that the consumer declared any",
            consumer: obj(None, vec![field("id", string()), field("meta", any())]),
            producer_before: obj(None, vec![field("id", string()), field("meta", string())]),
            producer_after: obj(None, vec![field("id", string()), field("meta", number())]),
            expected: &[],
        },
        Case {
            name: "rename an unread field nested inside a consumed object",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(Some("Address"), vec![field("city", string())]),
                    ),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(
                            Some("Address"),
                            vec![field("city", string()), field("line1", string())],
                        ),
                    ),
                ],
            ),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(
                            Some("Address"),
                            vec![field("city", string()), field("line2", string())],
                        ),
                    ),
                ],
            ),
            expected: &[],
        },
    ]
}

fn seeded_cases() -> Vec<Case> {
    vec![
        Case {
            name: "remove a field the consumer reads",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![field("id", string()), field("internalNote", string())],
            ),
            expected: &[("$.name", "required field is absent")],
        },
        Case {
            name: "rename a field the consumer reads",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field("title", string()),
                    field("internalNote", string()),
                ],
            ),
            expected: &[("$.name", "required field is absent")],
        },
        Case {
            name: "change the scalar of a consumed field",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field("name", number()),
                    field("internalNote", string()),
                ],
            ),
            expected: &[("$.name", "primitive type mismatch")],
        },
        Case {
            name: "emit null for a field the consumer rejects null on",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field_with("name", string(), false, true),
                    field("internalNote", string()),
                ],
            ),
            expected: &[("$.name", "consumer does not accept null")],
        },
        Case {
            name: "omit a field the consumer requires",
            consumer: consumer_shape(),
            producer_before: producer_clean(),
            producer_after: obj(
                Some("ProducerDto"),
                vec![
                    field("id", string()),
                    field_with("name", string(), true, false),
                    field("internalNote", string()),
                ],
            ),
            expected: &[("$.name", "consumer does not accept omission")],
        },
        Case {
            name: "replace a consumed object with a scalar",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field("user", obj(Some("User"), vec![field("name", string())])),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field("user", obj(Some("User"), vec![field("name", string())])),
                ],
            ),
            producer_after: obj(None, vec![field("id", string()), field("user", string())]),
            expected: &[("$.user", "shape mismatch")],
        },
        Case {
            name: "change the element type of a consumed array",
            consumer: obj(
                None,
                vec![field("id", string()), field("items", array(string(), None))],
            ),
            producer_before: obj(
                None,
                vec![field("id", string()), field("items", array(string(), None))],
            ),
            producer_after: obj(
                None,
                vec![field("id", string()), field("items", array(number(), None))],
            ),
            expected: &[("$.items[]", "primitive type mismatch")],
        },
        Case {
            name: "add an enum value the consumer cannot decode",
            consumer: obj(
                None,
                vec![field("id", string()), field("state", enum_of(vec!["open"]))],
            ),
            producer_before: obj(
                None,
                vec![field("id", string()), field("state", enum_of(vec!["open"]))],
            ),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field("state", enum_of(vec!["open", "archived"])),
                ],
            ),
            expected: &[("$.state", "literal value is rejected")],
        },
        Case {
            name: "add a field to a strict consumer",
            consumer: obj_strict(
                Some("StrictDecoder"),
                vec![field("id", string()), field("name", string())],
                Some(true),
            ),
            producer_before: obj(None, vec![field("id", string()), field("name", string())]),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field("name", string()),
                    field("surprise", string()),
                ],
            ),
            expected: &[("$.surprise", "strict decoder rejects extra field")],
        },
        Case {
            name: "remove a field nested inside a consumed object",
            consumer: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(
                            Some("Address"),
                            vec![field("city", string()), field("zip", string())],
                        ),
                    ),
                ],
            ),
            producer_before: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(
                            Some("Address"),
                            vec![field("city", string()), field("zip", string())],
                        ),
                    ),
                ],
            ),
            producer_after: obj(
                None,
                vec![
                    field("id", string()),
                    field(
                        "address",
                        obj(Some("Address"), vec![field("zip", string())]),
                    ),
                ],
            ),
            expected: &[("$.address.city", "required field is absent")],
        },
    ]
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

fn definite(issues: &[WireIssue]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = issues
        .iter()
        .filter(|i| !i.unresolved)
        .map(|i| (i.path.clone(), i.reason.clone()))
        .collect();
    out.sort();
    out
}

fn unresolved(issues: &[WireIssue]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = issues
        .iter()
        .filter(|i| i.unresolved)
        .map(|i| (i.path.clone(), i.reason.clone()))
        .collect();
    out.sort();
    out
}

fn check(case: &Case) {
    // Non-vacuity: a consumer with no required field cannot observe anything, so a
    // zero-finding result would prove nothing.
    let WireType::Object(consumer_obj) = &case.consumer else {
        panic!("{}: consumer fixture must be an OBJECT", case.name);
    };
    assert!(
        !consumer_obj.properties.is_empty(),
        "{}: consumer fixture has no properties",
        case.name
    );

    let clean = definite(&wire_inclusion(
        &case.producer_before,
        &case.consumer,
        "$",
        0,
    ));
    assert!(
        clean.is_empty(),
        "{}: unbroken fixture already reports {:?}",
        case.name,
        clean
    );

    let after = definite(&wire_inclusion(
        &case.producer_after,
        &case.consumer,
        "$",
        0,
    ));
    let expected: Vec<(String, String)> = case
        .expected
        .iter()
        .map(|(p, r)| (p.to_string(), r.to_string()))
        .collect();
    assert_eq!(
        after, expected,
        "{}: definite findings after mutation",
        case.name
    );
}

#[test]
fn benign_mutations_add_no_findings() {
    let cases = benign_cases();
    assert_eq!(cases.len(), 12, "benign table row count changed");
    for case in &cases {
        assert!(
            case.expected.is_empty(),
            "{}: benign row declares an expected finding; it belongs in SEEDED",
            case.name
        );
        check(case);
    }
}

#[test]
fn seeded_breaks_are_caught_exactly_once() {
    let cases = seeded_cases();
    assert_eq!(cases.len(), 10, "seeded table row count changed");
    for case in &cases {
        assert!(
            case.expected.len() == 1,
            "{}: seeded row must name exactly one expected finding",
            case.name
        );
        check(case);
    }
}

/// Every row's findings are pinned, so a change to the algebra that invents or
/// suppresses a verdict anywhere in this table has to be declared here.
#[test]
fn finding_totals_are_ratcheted() {
    let benign: usize = benign_cases()
        .iter()
        .map(|c| definite(&wire_inclusion(&c.producer_after, &c.consumer, "$", 0)).len())
        .sum();
    let seeded_cases = seeded_cases();
    let seeded: usize = seeded_cases
        .iter()
        .map(|c| definite(&wire_inclusion(&c.producer_after, &c.consumer, "$", 0)).len())
        .sum();

    assert_eq!(benign, 0, "benign mutations must never produce findings");
    assert_eq!(
        seeded,
        seeded_cases.len(),
        "each seeded break must produce exactly one finding"
    );
}

// ---------------------------------------------------------------------------
// Abstention must not become a violation
// ---------------------------------------------------------------------------

#[test]
fn unknown_positions_report_unresolved_never_a_violation() {
    let consumer = obj(
        None,
        vec![
            field("id", string()),
            field("name", unknown("response type could not be resolved")),
            field("state", string()),
        ],
    );
    let produced = obj(
        None,
        vec![
            field("id", string()),
            field("name", number()),
            field(
                "state",
                unknown("request body expression not statically resolvable"),
            ),
        ],
    );

    let issues = wire_inclusion(&produced, &consumer, "$", 0);
    assert!(
        definite(&issues).is_empty(),
        "UNKNOWN produced a definite finding: {:?}",
        definite(&issues)
    );
    let mut paths: Vec<String> = unresolved(&issues).into_iter().map(|(p, _)| p).collect();
    paths.sort();
    assert_eq!(paths, vec!["$.name".to_string(), "$.state".to_string()]);
}

#[test]
fn recursion_budget_reports_unresolved_never_a_violation() {
    let mut consumer = obj(Some("L"), vec![field("leaf", string())]);
    let mut produced = obj(Some("P"), vec![field("leaf", number())]); // mismatch waiting below the budget
    for _ in 0..90 {
        consumer = obj(Some("L"), vec![field("wrap", consumer)]);
        produced = obj(Some("P"), vec![field("wrap", produced)]);
    }

    let issues = wire_inclusion(&produced, &consumer, "$", 0);
    let definite_issues = definite(&issues);
    assert!(
        definite_issues.is_empty(),
        "budget-truncated traversal produced a definite finding: {:?}",
        definite_issues
    );
    assert!(
        unresolved(&issues)
            .iter()
            .any(|(_, reason)| reason == "wire recursion budget exceeded"),
        "budget exhaustion must be recorded as unresolved, got {:?}",
        issues
    );
}

// ---------------------------------------------------------------------------
// Gap ledger — behaviour recorded so it is measured, not believed
// ---------------------------------------------------------------------------

/// A consumer shape with no properties admits every object, so nothing below it can
/// be observed. Tracked by task #61: such shapes must not be counted as assertable.
#[test]
fn gap_property_less_consumer_shape_observes_nothing() {
    let consumer = obj(Some("BareInterface"), vec![]);
    let produced = producer_clean();
    let issues = wire_inclusion(&produced, &consumer, "$", 0);
    assert!(
        issues.is_empty(),
        "property-less consumer was expected to be blind, got {:?}",
        issues
    );
}

/// `expand_type_pool` bails on a dangling `REF` before comparison, so this definite
/// mismatch is only reachable if that guard is bypassed. Pinned so the guard's
/// removal cannot be mistaken for a soundness improvement.
#[test]
fn gap_unexpanded_ref_reads_as_a_shape_mismatch() {
    let consumer = consumer_shape();
    let produced = WireType::Ref(RefWireType {
        r#ref: "ts:missing.ts#Gone".to_string(),
        provenance: None,
    });
    let issues = definite(&wire_inclusion(&produced, &consumer, "$", 0));
    assert_eq!(
        issues,
        vec![("$".to_string(), "shape mismatch".to_string())],
        "unexpanded REF must not silently become resolvable"
    );
}
