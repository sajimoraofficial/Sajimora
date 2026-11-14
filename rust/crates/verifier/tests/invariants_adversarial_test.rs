use verifier::invariants::{
    check_boundary_range_eligibility, check_idempotence_eligibility,
    check_monotonicity_eligibility, check_null_safety_eligibility, InvariantKind,
};

#[test]
fn test_idempotence_pure_normalizer_qualifies() {
    let result = check_idempotence_eligibility(
        "normalizeString",
        "String",
        &["String"],
        false, // no side effects
    );

    assert!(result.is_ok());
    let inv = result.unwrap();
    assert_eq!(inv.kind, InvariantKind::Idempotence);
    assert!(inv.description.contains("f(f(x)) == f(x)"));
}

#[test]
fn test_idempotence_rejected_when_side_effects_exist() {
    let result = check_idempotence_eligibility(
        "saveAndNormalize",
        "String",
        &["String"],
        true, // has side effects
    );

    assert!(result.is_err());
    let abstention = result.unwrap_err();
    assert_eq!(abstention.code, "INVARIANT_SIDE_EFFECTS");
    assert!(abstention.reason.contains("side-effects"));
}

#[test]
fn test_idempotence_rejected_when_signature_mismatches() {
    // Return type String vs Param type int
    let result = check_idempotence_eligibility(
        "formatNumber",
        "String",
        &["int"],
        false,
    );

    assert!(result.is_err());
    let abstention = result.unwrap_err();
    assert_eq!(abstention.code, "INVARIANT_SIGNATURE_MISMATCH");

    // Multiple params
    let multi_param = check_idempotence_eligibility(
        "combine",
        "String",
        &["String", "String"],
        false,
    );
    assert!(multi_param.is_err());
}

#[test]
fn test_null_safety_qualifies_with_explicit_annotation() {
    let annotations = vec![
        vec!["@NonNull".to_string()],
        vec!["@Nullable".to_string()],
    ];

    let result = check_null_safety_eligibility("processOrder", &annotations, false);
    assert!(result.is_ok());
    let inv = result.unwrap();
    assert_eq!(inv.kind, InvariantKind::NullSafety);
}

#[test]
fn test_null_safety_abstains_without_annotations() {
    let empty_annotations = vec![vec![], vec![]];
    let result = check_null_safety_eligibility("rawCall", &empty_annotations, false);

    assert!(result.is_err());
    let abstention = result.unwrap_err();
    assert_eq!(abstention.code, "INVARIANT_MISSING_NULL_ANNOTATION");
}

#[test]
fn test_null_safety_rejected_with_side_effects() {
    let annotations = vec![vec!["@NotNull".to_string()]];
    let result = check_null_safety_eligibility("mutateState", &annotations, true);

    assert!(result.is_err());
    let abstention = result.unwrap_err();
    assert_eq!(abstention.code, "INVARIANT_SIDE_EFFECTS");
}

#[test]
fn test_monotonicity_qualifies_for_positive_linear_arithmetic() {
    let result = check_monotonicity_eligibility(
        "computeTierDiscount",
        &["int"],
        "double",
        true,  // is_positive_linear_transformation
        false, // has_side_effects
    );

    assert!(result.is_ok());
    let inv = result.unwrap();
    assert_eq!(inv.kind, InvariantKind::Monotonicity);
    assert!(inv.description.contains("a <= b => f(a) <= f(b)"));
}

#[test]
fn test_monotonicity_abstains_for_non_numeric_and_non_monotonic() {
    // Non-numeric return type
    let non_numeric = check_monotonicity_eligibility(
        "computeLabel",
        &["int"],
        "String",
        true,
        false,
    );
    assert!(non_numeric.is_err());
    assert_eq!(non_numeric.unwrap_err().code, "INVARIANT_NON_NUMERIC_TYPE");

    // Non-monotonic operation (e.g. modular arithmetic or inverted branches)
    let non_monotonic = check_monotonicity_eligibility(
        "hashSlot",
        &["int"],
        "int",
        false, // NOT positive linear
        false,
    );
    assert!(non_monotonic.is_err());
    assert_eq!(non_monotonic.unwrap_err().code, "INVARIANT_NON_MONOTONIC_TRANSFORMATION");
}

#[test]
fn test_boundary_range_qualifies_with_proven_finite_interval() {
    let result = check_boundary_range_eligibility(
        "clampPercentage",
        "double",
        Some(0.0),
        Some(100.0),
        false,
    );

    assert!(result.is_ok());
    let inv = result.unwrap();
    assert_eq!(inv.kind, InvariantKind::BoundaryRange);
    assert!(inv.description.contains("[0.00, 100.00]"));
}

#[test]
fn test_boundary_range_abstains_when_unbounded_or_inverted() {
    // Lower bound only (no upper bound)
    let unbounded = check_boundary_range_eligibility(
        "positiveOnly",
        "int",
        Some(0.0),
        None,
        false,
    );
    assert!(unbounded.is_err());
    assert_eq!(unbounded.unwrap_err().code, "INVARIANT_UNBOUNDED_RANGE");

    // Inverted bounds (low > high)
    let inverted = check_boundary_range_eligibility(
        "brokenBounds",
        "int",
        Some(100.0),
        Some(10.0),
        false,
    );
    assert!(inverted.is_err());
    assert_eq!(inverted.unwrap_err().code, "INVARIANT_UNBOUNDED_RANGE");
}
