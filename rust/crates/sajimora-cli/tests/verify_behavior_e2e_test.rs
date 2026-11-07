//! verify_behavior_e2e_test.rs — Comprehensive end-to-end test suite for
//! `sajimora verify-behavior` (Bounded Differential Regression Gate).
//!
//! Validates:
//! 1. Catching calculation logic regressions across dual revisions.
//! 2. Emission of concrete counterexample inputs and cryptographic SHA-256 witness.
//! 3. Sound mathematical proof of behavioral equivalence on refactored methods.
//! 4. Fail-closed behavior on signature mismatch.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "sajimora-bisim-{tag}-{}-{}",
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_verify_behavior(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("verify-behavior")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn test_verify_behavior_catches_regression() {
    let dir = unique_dir("catch-regression");
    let base_file = dir.join("TaxCalculatorOld.java");
    let cand_file = dir.join("TaxCalculatorNew.java");

    let base_src = r#"package com.example.service;

public class TaxCalculator {
    public double calculateTax(double grossIncome) {
        if (grossIncome > 50000.0) {
            return 0.15;
        }
        return 0.05;
    }
}
"#;

    let cand_src = r#"package com.example.service;

public class TaxCalculator {
    public double calculateTax(double grossIncome) {
        if (grossIncome > 50000.0) {
            return 0.18; // Regression! Tax rate accidentally raised to 18%
        }
        return 0.05;
    }
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, _stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "calculateTax",
        "--json",
    ]);

    assert_eq!(code, 1, "Behavioral regression must exit non-zero (1)");

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON output");

    let counterexample = json_val
        .get("Counterexample")
        .expect("Expected Counterexample verdict");
    assert_eq!(counterexample["method_name"], "calculateTax");
    assert_eq!(counterexample["base_output"], "0.15");
    assert_eq!(counterexample["candidate_output"], "0.18");

    let witness_sha256 = counterexample["witness_sha256"].as_str().unwrap();
    assert_eq!(
        witness_sha256.len(),
        64,
        "SHA-256 witness hash must be 64-char hex"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_verify_behavior_proves_sound_equivalence() {
    let dir = unique_dir("sound-proof");
    let base_file = dir.join("TaxCalculatorOld.java");
    let cand_file = dir.join("TaxCalculatorNew.java");

    let base_src = r#"package com.example.service;

public class TaxCalculator {
    public double calculateTax(double grossIncome) {
        if (grossIncome > 50000.0) {
            return 0.15;
        }
        return 0.05;
    }
}
"#;

    let cand_src = r#"package com.example.service;

public class TaxCalculator {
    public double calculateTax(double grossIncome) {
        // Refactored with comments and clean formatting; mathematically equivalent
        if (grossIncome > 50000.0) {
            return 0.15;
        }
        return 0.05;
    }
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "calculateTax",
        "--json",
    ]);

    assert_eq!(
        code, 0,
        "Equivalent revisions must pass with exit 0. Stderr: {stderr}"
    );

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON output");

    let proof = json_val
        .get("SoundProofOfEquivalence")
        .expect("Expected SoundProofOfEquivalence verdict");
    assert_eq!(proof["method_name"], "calculateTax");
    assert!(proof["proof_axioms"]
        .as_str()
        .unwrap()
        .contains("Presburger"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_verify_behavior_signature_mismatch_exits_nonzero() {
    let dir = unique_dir("sig-mismatch");
    let base_file = dir.join("ServiceOld.java");
    let cand_file = dir.join("ServiceNew.java");

    let base_src = r#"package com.example.service;
public class ServiceOld {
    public void compute() {}
}
"#;

    let cand_src = r#"package com.example.service;
public class ServiceNew {
    public void otherMethod() {}
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, _stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "compute",
        "--json",
    ]);

    assert_eq!(code, 1, "Signature mismatch must exit non-zero (1)");

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON output");

    assert!(json_val.get("SignatureMismatch").is_some());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_verify_behavior_catches_return_variable_divergence() {
    let dir = unique_dir("ret-var-divergence");
    let base_file = dir.join("Base.java");
    let cand_file = dir.join("Cand.java");

    let base_src = r#"package com.example;
public class Svc {
    public int choose(int a, int b) {
        return a;
    }
}
"#;
    let cand_src = r#"package com.example;
public class Svc {
    public int choose(int a, int b) {
        return b;
    }
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, _stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "choose",
        "--strict",
        "--json",
    ]);

    assert_eq!(code, 1, "return a vs return b must fail verification");
    let json_val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON");
    assert!(
        json_val.get("SoundProofOfEquivalence").is_none(),
        "Must NEVER prove equivalence when return expressions differ across free variables"
    );
    assert!(
        json_val.get("Counterexample").is_some(),
        "Expected Counterexample witness with asymmetric sample inputs"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_verify_behavior_catches_local_mutation_regression() {
    let dir = unique_dir("local-mutation");
    let base_file = dir.join("Base.java");
    let cand_file = dir.join("Cand.java");

    let base_src = r#"package com.example;
public class Svc {
    public int calc(int x) {
        int y = 0;
        if (x > 0) {
            y = 2;
        }
        return y;
    }
}
"#;
    let cand_src = r#"package com.example;
public class Svc {
    public int calc(int x) {
        int y = 0;
        if (x > 0) {
            y = 999;
        }
        return y;
    }
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, _stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "calc",
        "--strict",
        "--json",
    ]);

    assert_eq!(
        code, 1,
        "Unmodeled local mutation must fail closed in strict mode"
    );
    let json_val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON");
    assert!(
        json_val.get("SoundProofOfEquivalence").is_none(),
        "Must NEVER prove equivalence when unmodeled local mutations exist"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_verify_behavior_catches_parameter_reorder_regression() {
    let dir = unique_dir("param-reorder");
    let base_file = dir.join("Base.java");
    let cand_file = dir.join("Cand.java");

    let base_src = r#"package com.example;
public class Svc {
    public int diff(int a, int b) {
        return a - b;
    }
}
"#;
    let cand_src = r#"package com.example;
public class Svc {
    public int diff(int b, int a) {
        return a - b;
    }
}
"#;

    fs::write(&base_file, base_src).unwrap();
    fs::write(&cand_file, cand_src).unwrap();

    let (code, stdout, _stderr) = run_verify_behavior(&[
        "--base",
        base_file.to_str().unwrap(),
        "--candidate",
        cand_file.to_str().unwrap(),
        "--method",
        "diff",
        "--strict",
        "--json",
    ]);

    assert_eq!(
        code, 1,
        "Parameter reordering diff(a, b) vs diff(b, a) must fail"
    );
    let json_val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON");
    assert!(
        json_val.get("SoundProofOfEquivalence").is_none(),
        "Parameter reorder must NEVER be marked SoundProofOfEquivalence"
    );
    assert!(
        json_val.get("SignatureMismatch").is_some() || json_val.get("Counterexample").is_some(),
        "Expected SignatureMismatch or Counterexample on parameter reorder"
    );

    let _ = fs::remove_dir_all(dir);
}
