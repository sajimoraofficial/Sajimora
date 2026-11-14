use verifier::mock_budget::{MockBudgetGovernor, MockDecision};
use verifier::solver::{CmpOp, ConcreteValue, Constraint, SolverVerdict, Term, Tier1Solver};

#[test]
fn test_solver_integer_boundary_saturating_and_zero() {
    let solver = Tier1Solver::default();

    // Constraint: x > 0 && x <= 1 -> candidate must be 1
    let constraints = vec![
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Gt, Term::LitInt(0)),
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Le, Term::LitInt(1)),
    ];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("x"), Some(&ConcreteValue::Int(1)));
        }
        other => panic!("Expected Counterexample with x=1, got {:?}", other),
    }

    // Constraint: negative boundary x >= -10 && x <= -9
    let neg_constraints = vec![
        Constraint::Cmp(Term::Var("neg".to_string()), CmpOp::Ge, Term::LitInt(-10)),
        Constraint::Cmp(Term::Var("neg".to_string()), CmpOp::Le, Term::LitInt(-9)),
    ];
    let neg_verdict = solver.solve(&neg_constraints);
    match neg_verdict {
        SolverVerdict::Counterexample(model) => {
            if let Some(ConcreteValue::Int(val)) = model.get("neg") {
                assert!(*val == -10 || *val == -9);
            } else {
                panic!("Expected integer assignment for neg");
            }
        }
        other => panic!("Expected Counterexample with negative int, got {:?}", other),
    }
}

#[test]
fn test_solver_disjunction_and_conjunction() {
    let solver = Tier1Solver::default();

    // (x == 1 || x == 2) && x > 1 -> x must be 2
    let constraints = vec![
        Constraint::Or(vec![
            Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Eq, Term::LitInt(1)),
            Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Eq, Term::LitInt(2)),
        ]),
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Gt, Term::LitInt(1)),
    ];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("x"), Some(&ConcreteValue::Int(2)));
        }
        other => panic!("Expected Counterexample with x=2, got {:?}", other),
    }
}

#[test]
fn test_solver_boolean_propositions_and_contradiction() {
    let solver = Tier1Solver::default();

    // Satisfying boolean assignment
    let constraints = vec![
        Constraint::Cmp(Term::Var("isActive".to_string()), CmpOp::Eq, Term::LitBool(true)),
        Constraint::Cmp(Term::Var("isDeleted".to_string()), CmpOp::Eq, Term::LitBool(false)),
    ];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("isActive"), Some(&ConcreteValue::Bool(true)));
            assert_eq!(model.get("isDeleted"), Some(&ConcreteValue::Bool(false)));
        }
        other => panic!("Expected Counterexample, got {:?}", other),
    }

    // Direct contradiction: flag == true && flag == false
    let contradiction = vec![
        Constraint::Cmp(Term::Var("flag".to_string()), CmpOp::Eq, Term::LitBool(true)),
        Constraint::Cmp(Term::Var("flag".to_string()), CmpOp::Eq, Term::LitBool(false)),
    ];
    let c_verdict = solver.solve(&contradiction);
    assert_eq!(c_verdict, SolverVerdict::Proven);
}

#[test]
fn test_solver_dynamic_enum_variant_matching() {
    let solver = Tier1Solver::default();

    // status == "ACTIVE" || status == "PENDING", with NOT(status == "PENDING")
    let constraints = vec![
        Constraint::Or(vec![
            Constraint::Cmp(
                Term::Var("status".to_string()),
                CmpOp::Eq,
                Term::LitEnum("ACTIVE".to_string()),
            ),
            Constraint::Cmp(
                Term::Var("status".to_string()),
                CmpOp::Eq,
                Term::LitEnum("PENDING".to_string()),
            ),
        ]),
        Constraint::Not(Box::new(Constraint::Cmp(
            Term::Var("status".to_string()),
            CmpOp::Eq,
            Term::LitEnum("PENDING".to_string()),
        ))),
    ];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(
                model.get("status"),
                Some(&ConcreteValue::Enum("ACTIVE".to_string()))
            );
        }
        other => panic!("Expected Counterexample with status=ACTIVE, got {:?}", other),
    }
}

#[test]
fn test_solver_string_is_empty_and_equals() {
    let solver = Tier1Solver::default();

    // String isEmpty check
    let empty_constraints = vec![Constraint::StringIsEmpty("apiKey".to_string())];
    let verdict = solver.solve(&empty_constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("apiKey"), Some(&ConcreteValue::String("".to_string())));
        }
        other => panic!("Expected Counterexample with apiKey='', got {:?}", other),
    }

    // String equals check
    let eq_constraints = vec![Constraint::StringEquals("env".to_string(), "production".to_string())];
    let eq_verdict = solver.solve(&eq_constraints);
    match eq_verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(
                model.get("env"),
                Some(&ConcreteValue::String("production".to_string()))
            );
        }
        other => panic!("Expected Counterexample with env='production', got {:?}", other),
    }
}

#[test]
fn test_solver_linear_arithmetic_terms() {
    let solver = Tier1Solver::default();

    // x + 10 == 20 -> x should be 10
    let constraints = vec![Constraint::Cmp(
        Term::Add(Box::new(Term::Var("x".to_string())), Box::new(Term::LitInt(10))),
        CmpOp::Eq,
        Term::LitInt(20),
    )];

    let verdict = solver.solve(&constraints);
    match verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("x"), Some(&ConcreteValue::Int(10)));
        }
        other => panic!("Expected Counterexample with x=10, got {:?}", other),
    }

    // x - 5 == 5 -> x should be 10
    let sub_constraints = vec![Constraint::Cmp(
        Term::Sub(Box::new(Term::Var("x".to_string())), Box::new(Term::LitInt(5))),
        CmpOp::Eq,
        Term::LitInt(5),
    )];

    let sub_verdict = solver.solve(&sub_constraints);
    match sub_verdict {
        SolverVerdict::Counterexample(model) => {
            assert_eq!(model.get("x"), Some(&ConcreteValue::Int(10)));
        }
        other => panic!("Expected Counterexample with x=10, got {:?}", other),
    }
}

#[test]
fn test_solver_timeout_and_unsupported_fail_closed() {
    // 0ms budget -> instant timeout
    let solver = Tier1Solver::new(0);
    let constraints = vec![
        Constraint::Cmp(Term::Var("x".to_string()), CmpOp::Gt, Term::LitInt(100)),
        Constraint::Cmp(Term::Var("y".to_string()), CmpOp::Gt, Term::LitInt(200)),
    ];
    let verdict = solver.solve(&constraints);
    assert!(matches!(verdict, SolverVerdict::Unknown { .. }));

    // Unsupported expression
    let normal_solver = Tier1Solver::default();
    let unsupported = vec![Constraint::Unsupported("BigInteger modular arithmetic".to_string())];
    let u_verdict = normal_solver.solve(&unsupported);
    match u_verdict {
        SolverVerdict::Unknown { reason } => {
            assert!(reason.contains("BigInteger"));
        }
        other => panic!("Expected Unknown for unsupported term, got {:?}", other),
    }
}

#[test]
fn test_mock_budget_governor_strict_hop_depths() {
    let governor = MockBudgetGovernor::default();

    // 0-hop: empty chain or single receiver
    let hop0: Vec<String> = vec![];
    assert_eq!(governor.check_call_chain(&hop0), MockDecision::Allowed { hop_depth: 0 });

    // 1-hop: direct injected collaborator (receiver + method)
    let hop1 = vec!["orderRepository".to_string(), "findById".to_string()];
    assert_eq!(governor.check_call_chain(&hop1), MockDecision::Allowed { hop_depth: 1 });

    // 2-hop: entity returned from collaborator, and getter invoked
    let hop2 = vec![
        "orderRepository".to_string(),
        "findById".to_string(),
        "getStatus".to_string(),
    ];
    assert_eq!(governor.check_call_chain(&hop2), MockDecision::Allowed { hop_depth: 2 });

    // 3-hop: Demeter law violation (train-wreck call chain) -> Abstains!
    let hop3 = vec![
        "orderRepository".to_string(),
        "findById".to_string(),
        "getCustomer".to_string(),
        "getAddress".to_string(),
    ];
    match governor.check_call_chain(&hop3) {
        MockDecision::Abstain(exceeded) => {
            assert_eq!(exceeded.depth, 3);
            assert_eq!(exceeded.max_allowed, 2);
        }
        other => panic!("Expected Abstain for 3-hop call chain, got {:?}", other),
    }

    // 4-hop: deeply nested transitive call chain
    let hop4 = vec![
        "orderRepository".to_string(),
        "findById".to_string(),
        "getCustomer".to_string(),
        "getAddress".to_string(),
        "getPostalCode".to_string(),
    ];
    match governor.check_call_chain(&hop4) {
        MockDecision::Abstain(exceeded) => {
            assert_eq!(exceeded.depth, 4);
        }
        other => panic!("Expected Abstain for 4-hop call chain, got {:?}", other),
    }
}
