use verifier::bisim::{verify_method_behavior, BehaviorVerdict};

#[test]
fn test_behavioral_divergence_counterexample() {
    let base_source = r#"package com.example.service;

public class FeeCalculator {
    public double calculateFee(double amount) {
        if (amount > 100.0) {
            return 0.02;
        }
        return 0.05;
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class FeeCalculator {
    public double calculateFee(double amount) {
        if (amount > 100.0) {
            return 0.03; // Regression! Fee changed from 0.02 to 0.03
        }
        return 0.05;
    }
}
"#;

    let verdict = verify_method_behavior(
        "src/main/java/com/example/service/FeeCalculator.java",
        "calculateFee",
        base_source,
        cand_source,
        "commit-r1-hash",
        "commit-r2-hash",
        50,
    );

    match verdict {
        BehaviorVerdict::Counterexample(witness) => {
            assert_eq!(witness.method_name, "calculateFee");
            assert_eq!(witness.base_output, "0.02");
            assert_eq!(witness.candidate_output, "0.03");
            assert_eq!(witness.base_revision, "commit-r1-hash");
            assert_eq!(witness.candidate_revision, "commit-r2-hash");
            assert_eq!(
                witness.witness_sha256.len(),
                64,
                "SHA-256 witness must be 64-char hex"
            );
            assert!(
                witness.inputs.contains_key("amount"),
                "Expected concrete input 'amount'"
            );
        }
        other => panic!("Expected Counterexample, got {:?}", other),
    }
}

#[test]
fn test_behavioral_equivalence_sound_proof() {
    let base_source = r#"package com.example.service;

public class FeeCalculator {
    public double calculateFee(double amount) {
        if (amount > 100.0) {
            return 0.02;
        }
        return 0.05;
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class FeeCalculator {
    public double calculateFee(double amount) {
        // Equivalent formatting/comments
        if (amount > 100.0) {
            return 0.02;
        }
        return 0.05;
    }
}
"#;

    let verdict = verify_method_behavior(
        "FeeCalculator.java",
        "calculateFee",
        base_source,
        cand_source,
        "rev-a",
        "rev-b",
        50,
    );

    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { method_name, .. } => {
            assert_eq!(method_name, "calculateFee");
        }
        other => panic!("Expected SoundProofOfEquivalence, got {:?}", other),
    }
}

#[test]
fn test_behavioral_signature_mismatch() {
    let base_source = r#"package com.example.service;

public class ServiceA {
    public void existingMethod() {}
}
"#;

    let cand_source = r#"package com.example.service;

public class ServiceA {
    public void differentMethod() {}
}
"#;

    let verdict = verify_method_behavior(
        "ServiceA.java",
        "existingMethod",
        base_source,
        cand_source,
        "rev-a",
        "rev-b",
        50,
    );

    match verdict {
        BehaviorVerdict::SignatureMismatch {
            method_name,
            reason,
        } => {
            assert_eq!(method_name, "existingMethod");
            assert!(reason.contains("not found in candidate revision"));
        }
        other => panic!("Expected SignatureMismatch, got {:?}", other),
    }
}

#[test]
fn test_commutative_refactoring_not_flagged_as_regression() {
    let base_source = r#"package com.example.service;

public class MathUtil {
    public int computeSum(int a, int b) {
        return a + b;
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class MathUtil {
    public int computeSum(int a, int b) {
        return b + a; // Commutative refactoring! Not a regression
    }
}
"#;

    let verdict = verify_method_behavior(
        "MathUtil.java",
        "computeSum",
        base_source,
        cand_source,
        "rev-1",
        "rev-2",
        50,
    );

    // Must NOT flag a Counterexample regression
    match verdict {
        BehaviorVerdict::SoundProofOfEquivalence { .. } => {}
        BehaviorVerdict::LikelyEquivalentBounded { .. } => {}
        BehaviorVerdict::Counterexample(w) => {
            panic!(
                "False positive regression flagged on commutative refactoring: base='{}' cand='{}'",
                w.base_output, w.candidate_output
            );
        }
        other => panic!("Unexpected verdict: {:?}", other),
    }
}

#[test]
fn test_nested_if_else_path_traversal() {
    let base_source = r#"package com.example.service;

public class TierService {
    public int getTier(int score) {
        if (score > 100) {
            return 1;
        } else {
            return 2;
        }
    }
}
"#;

    let cand_source = r#"package com.example.service;

public class TierService {
    public int getTier(int score) {
        if (score > 100) {
            return 1;
        } else {
            return 3; // Regression in the else branch!
        }
    }
}
"#;

    let verdict = verify_method_behavior(
        "TierService.java",
        "getTier",
        base_source,
        cand_source,
        "rev-1",
        "rev-2",
        50,
    );

    // Must catch regression in the else branch!
    match verdict {
        BehaviorVerdict::Counterexample(w) => {
            assert_eq!(w.method_name, "getTier");
            assert_eq!(w.base_output, "2");
            assert_eq!(w.candidate_output, "3");
            assert!(w.candidate_path_condition.contains("!(score > 100)"));
        }
        other => panic!("Expected regression in else branch, got {:?}", other),
    }
}
