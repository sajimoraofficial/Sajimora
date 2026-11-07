use verifier::invariants::{
    check_boundary_range_eligibility, check_idempotence_eligibility,
    check_monotonicity_eligibility, check_null_safety_eligibility, InvariantKind,
};
use verifier::mock_budget::{MockBudgetGovernor, MockDecision};
use verifier::solver::{CmpOp, ConcreteValue, Constraint, SolverVerdict, Term, Tier1Solver};

#[test]
fn test_solver_integer_linear_inequality() {
    let solver = Tier1Solver::default();

    // Constraint: x > 10 && x < 20
    let constraints = vec![
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Gt, Term::LitInt(10)),
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Lt, Term::LitInt(20)),
    ];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            if let Some(ConcreteValue::Int(val)) = model.get("x") {
                assert!(*val > 10 && *val < 20, "x = {val} satisfies constraints");
            } else {
                panic!("Expected integer assignment for x");
            }
        }
        other => panic!("Expected Counterexample, got {:?}", other),
    }
}

#[test]
fn test_solver_integer_contradiction() {
    let solver = Tier1Solver::default();

    // Contradiction: x > 10 && x < 5
    let constraints = vec![
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Gt, Term::LitInt(10)),
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Lt, Term::LitInt(5)),
    ];

    let verdict = solver.solve(&constraints);
    assert_eq!(verdict, SolverVerdict::Proven);
}

#[test]
fn test_solver_string_equality() {
    let solver = Tier1Solver::default();

    let constraints = vec![Constraint::StringEquals(
        "promoCode".to_string(),
        "SUMMER10".to_string(),
    )];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(
                model.get("promoCode"),
                Some(&ConcreteValue::String("SUMMER10".to_string()))
            );
        }
        other => panic!("Expected Counterexample, got {:?}", other),
    }
}

#[test]
fn test_solver_unsupported_non_linear_fails_closed() {
    let solver = Tier1Solver::default();

    // Out-of-scope non-linear constraint: Math.sqrt or non-linear term
    let constraints = vec![Constraint::Unsupported(
        "Non-linear polynomial d * e not supported in Tier 1".to_string(),
    )];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Unknown { reason } => {
            assert!(reason.contains("Non-linear"));
        }
        other => panic!("Expected Unknown, got {:?}", other),
    }
}

#[test]
fn test_mock_budget_governor_strict_2_hop_demeter() {
    let governor = MockBudgetGovernor::default();

    // Hop 1: direct dependency mock
    let chain1 = vec!["userRepository".to_string(), "findById".to_string()];
    assert_eq!(
        governor.check_call_chain(&chain1),
        MockDecision::Allowed { hop_depth: 1 }
    );

    // Hop 2: immediate entity getter
    let chain2 = vec![
        "userRepository".to_string(),
        "findById".to_string(),
        "getStatus".to_string(),
    ];
    assert_eq!(
        governor.check_call_chain(&chain2),
        MockDecision::Allowed { hop_depth: 2 }
    );

    // Hop 3: transitive call chain beyond 2 hops (violation of Demeter)
    let chain3 = vec![
        "userRepository".to_string(),
        "findById".to_string(),
        "getPaymentGateway".to_string(),
        "fetchBalance".to_string(),
    ];
    match governor.check_call_chain(&chain3) {
        MockDecision::Abstain(exceeded) => {
            assert_eq!(exceeded.depth, 3);
            assert_eq!(exceeded.max_allowed, 2);
            assert!(exceeded.reason.contains("exceeds mock budget"));
        }
        MockDecision::Allowed { .. } => panic!("Expected Abstain for depth 3"),
    }
}

#[test]
fn test_idempotence_eligibility_enforcement() {
    // Pure normalizer: String -> String, no side effects
    let ok_res = check_idempotence_eligibility("normalizeEmail", "String", &["String"], false);
    assert!(ok_res.is_ok());
    let inv = ok_res.unwrap();
    assert_eq!(inv.kind, InvariantKind::Idempotence);

    // Side-effecting method: must strictly abstain
    let err_res = check_idempotence_eligibility("deleteUser", "void", &["String"], true);
    assert!(err_res.is_err());
    let abstention = err_res.unwrap_err();
    assert_eq!(abstention.code, "INVARIANT_SIDE_EFFECTS");
}

#[test]
fn test_solver_dynamic_enum_variant_matching() {
    let solver = Tier1Solver::default();

    // Custom domain enum: OrderStatus.SHIPPED (not hardcoded ACTIVE/PENDING)
    let constraints = vec![Constraint::Cmp(
        Term::Var("status".to_string()),
        CmpOp::Eq,
        Term::LitEnum("OrderStatus.SHIPPED".to_string()),
    )];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(
                model.get("status"),
                Some(&ConcreteValue::Enum("OrderStatus.SHIPPED".to_string())),
                "Solver must dynamically extract OrderStatus.SHIPPED from constraints"
            );
        }
        other => panic!("Expected Counterexample for dynamic enum, got {:?}", other),
    }
}

#[test]
fn test_null_safety_and_monotonicity_and_boundary_invariants() {
    // 1. Null-Safety: Requires @NonNull annotation
    let null_ok = check_null_safety_eligibility(
        "updateProfile",
        &[vec!["@NonNull".to_string()], vec![]],
        false,
    );
    assert!(null_ok.is_ok());
    assert_eq!(null_ok.unwrap().kind, InvariantKind::NullSafety);

    let null_missing = check_null_safety_eligibility("getProfile", &[vec![]], false);
    assert!(null_missing.is_err());
    assert_eq!(
        null_missing.unwrap_err().code,
        "INVARIANT_MISSING_NULL_ANNOTATION"
    );

    // 2. Monotonicity: Requires positive linear scale
    let mono_ok = check_monotonicity_eligibility("scaleScore", &["int"], "int", true, false);
    assert!(mono_ok.is_ok());
    assert_eq!(mono_ok.unwrap().kind, InvariantKind::Monotonicity);

    let mono_bad = check_monotonicity_eligibility("invertScore", &["int"], "int", false, false);
    assert!(mono_bad.is_err());
    assert_eq!(
        mono_bad.unwrap_err().code,
        "INVARIANT_NON_MONOTONIC_TRANSFORMATION"
    );

    // 3. Boundary Range: Interval [0.0, 1.0]
    let bound_ok =
        check_boundary_range_eligibility("clampProbability", "double", Some(0.0), Some(1.0), false);
    assert!(bound_ok.is_ok());
    assert_eq!(bound_ok.unwrap().kind, InvariantKind::BoundaryRange);

    let bound_unbounded =
        check_boundary_range_eligibility("freeFloat", "double", None, None, false);
    assert!(bound_unbounded.is_err());
    assert_eq!(
        bound_unbounded.unwrap_err().code,
        "INVARIANT_UNBOUNDED_RANGE"
    );
}
