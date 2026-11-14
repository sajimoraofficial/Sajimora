use verifier::bisim::{verify_method_behavior, BehaviorVerdict};

#[test]
fn test_inverted_if_else_branches_are_equivalent() {
    let base_source = r#"package com.example.service;

public class DiscountService {
    public double getDiscount(int years) {
        if (years <= 5) {
            return 0.05;
        } else {
            return 0.15;
        }
    }
}
"#;

    // Refactored inverted condition: if (years > 5) return 0.15; else return 0.05;
    let cand_source = r#"package com.example.service;

public class DiscountService {
    public double getDiscount(int years) {
        if (years > 5) {
            return 0.15;
        } else {
            return 0.05;
        }
    }
}
"#;

    let verdict = verify_method_behavior(
        "DiscountService.java",
        "getDiscount",
        base_source,
        cand_source,
        "rev-a",
        "rev-b",
        50,
    );

    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { method_name, .. } => {
            assert_eq!(method_name, "getDiscount");
        }
        BehaviorVerdict::LikelyEquivalentBounded { method_name, .. } => {
            assert_eq!(method_name, "getDiscount");
        }
        other => panic!("Expected equivalence for inverted branch refactoring, got {:?}", other),
    }
}

#[test]
fn test_off_by_one_boundary_regression_caught() {
    let base_source = r#"package com.example.service;

public class AgeGate {
    public boolean isEligible(int age) {
        if (age > 18) {
            return true;
        }
        return false;
    }
}
"#;

    // Off-by-one regression: age >= 18 instead of age > 18
    let cand_source = r#"package com.example.service;

public class AgeGate {
    public boolean isEligible(int age) {
        if (age >= 18) {
            return true;
        }
        return false;
    }
}
"#;

    let verdict = verify_method_behavior(
        "AgeGate.java",
        "isEligible",
        base_source,
        cand_source,
        "base-rev",
        "cand-rev",
        50,
    );

    match verdict {
        BehaviorVerdict::Counterexample(witness) => {
            assert_eq!(witness.method_name, "isEligible");
            assert_eq!(witness.base_output, "false");
            assert_eq!(witness.candidate_output, "true");
            assert_eq!(witness.inputs.get("age"), Some(&verifier::solver::ConcreteValue::Int(18)));
            assert_eq!(witness.witness_sha256.len(), 64);
        }
        other => panic!("Expected Counterexample witness for age=18, got {:?}", other),
    }
}

#[test]
fn test_multi_tier_rating_equivalence() {
    let base_source = r#"package com.example.service;

public class RatingService {
    public String calculateTier(int points) {
        if (points >= 1000) {
            return "PLATINUM";
        } else if (points >= 500) {
            return "GOLD";
        } else {
            return "STANDARD";
        }
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class RatingService {
    public String calculateTier(int points) {
        // Semantically identical logic with clean variable extraction or formatting
        if (points >= 1000) {
            return "PLATINUM";
        }
        if (points >= 500) {
            return "GOLD";
        }
        return "STANDARD";
    }
}
"#;

    let verdict = verify_method_behavior(
        "RatingService.java",
        "calculateTier",
        base_source,
        cand_source,
        "rev-1",
        "rev-2",
        50,
    );

    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { .. } | BehaviorVerdict::LikelyEquivalentBounded { .. } => {}
        other => panic!("Expected rating service equivalence, got {:?}", other),
    }
}

#[test]
fn test_string_literal_output_divergence() {
    let base_source = r#"package com.example.service;

public class StatusService {
    public String getStatus(boolean active) {
        if (active) {
            return "ONLINE";
        }
        return "OFFLINE";
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class StatusService {
    public String getStatus(boolean active) {
        if (active) {
            return "READY"; // Divergence: ONLINE -> READY
        }
        return "OFFLINE";
    }
}
"#;

    let verdict = verify_method_behavior(
        "StatusService.java",
        "getStatus",
        base_source,
        cand_source,
        "r1",
        "r2",
        50,
    );

    match verdict {
        BehaviorVerdict::Counterexample(w) => {
            assert_eq!(w.base_output, "\"ONLINE\"");
            assert_eq!(w.candidate_output, "\"READY\"");
        }
        other => panic!("Expected Counterexample for status string mutation, got {:?}", other),
    }
}

#[test]
fn test_algebraic_expression_equivalence() {
    let base_source = r#"package com.example.service;

public class CalcService {
    public int computeFee(int basePrice) {
        if (basePrice > 100) {
            return basePrice * 2 + 15;
        }
        return basePrice + 5;
    }
}
"#;

    // Cand swaps term order: 15 + 2 * basePrice and 5 + basePrice
    let cand_source = r#"package com.example.service;

public class CalcService {
    public int computeFee(int basePrice) {
        if (basePrice > 100) {
            return 15 + 2 * basePrice;
        }
        return 5 + basePrice;
    }
}
"#;

    let verdict = verify_method_behavior(
        "CalcService.java",
        "computeFee",
        base_source,
        cand_source,
        "v1",
        "v2",
        50,
    );

    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { method_name, paths_evaluated, .. } => {
            assert_eq!(method_name, "computeFee");
            assert_eq!(paths_evaluated, 4); // 2 paths in base x 2 paths in candidate
        }
        other => panic!("Expected SoundProofOfEquivalence for algebraic commutativity, got {:?}", other),
    }
}

#[test]
fn test_parameter_signature_mismatch_fails_closed() {
    let base_source = r#"package com.example.service;

public class UserService {
    public boolean checkAccess(int userId, String role) {
        return true;
    }
}
"#;

    // Changed int userId -> long userId
    let cand_source = r#"package com.example.service;

public class UserService {
    public boolean checkAccess(long userId, String role) {
        return true;
    }
}
"#;

    let verdict = verify_method_behavior(
        "UserService.java",
        "checkAccess",
        base_source,
        cand_source,
        "v1",
        "v2",
        50,
    );

    match verdict {
        BehaviorVerdict::SignatureMismatch { method_name, reason } => {
            assert_eq!(method_name, "checkAccess");
            assert!(reason.contains("parameter signature"));
        }
        other => panic!("Expected SignatureMismatch, got {:?}", other),
    }
}

#[test]
fn test_unmodeled_local_mutations_fail_closed_as_unknown() {
    let base_source = r#"package com.example.service;

public class MutationService {
    public int calculateTotal(int amount) {
        int bonus = 5;
        bonus += 10; // Local mutation!
        return amount + bonus;
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class MutationService {
    public int calculateTotal(int amount) {
        return amount + 15;
    }
}
"#;

    let verdict = verify_method_behavior(
        "MutationService.java",
        "calculateTotal",
        base_source,
        cand_source,
        "v1",
        "v2",
        50,
    );

    match verdict {
        BehaviorVerdict::Unknown { method_name, reason } => {
            assert_eq!(method_name, "calculateTotal");
            assert!(reason.contains("local variable assignments"));
        }
        other => panic!("Expected Unknown due to unmodeled mutation, got {:?}", other),
    }
}

#[test]
fn test_complex_4tier_else_if_with_fallthrough_equivalence() {
    let base_source = r#"package com.example.service;

public class TaxService {
    public int computeTaxBracket(int income) {
        if (income >= 100000) {
            return 37;
        } else if (income >= 50000) {
            return 24;
        } else if (income >= 25000) {
            return 12;
        }
        return 0;
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class TaxService {
    public int computeTaxBracket(int income) {
        if (income >= 100000) return 37;
        if (income >= 50000) return 24;
        if (income >= 25000) return 12;
        return 0;
    }
}
"#;

    let verdict = verify_method_behavior(
        "TaxService.java",
        "computeTaxBracket",
        base_source,
        cand_source,
        "v1",
        "v2",
        50,
    );

    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { paths_evaluated, .. }
        | BehaviorVerdict::LikelyEquivalentBounded { paths_evaluated, .. } => {
            assert_eq!(paths_evaluated, 16); // 4 paths x 4 paths
        }
        other => panic!("Expected 4-tier tax bracket equivalence, got {:?}", other),
    }
}

