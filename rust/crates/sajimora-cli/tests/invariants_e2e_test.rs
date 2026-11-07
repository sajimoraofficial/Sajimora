//! invariants_e2e_test.rs — Comprehensive end-to-end test suite for
//! `sajimora gen-invariants` metamorphic property synthesis.
//!
//! Validates:
//! 1. Mathematical Idempotence Invariant synthesis (f(f(x)) == f(x))
//! 2. Null-Safety Invariant synthesis (@NonNull / @NotNull evidence required)
//! 3. Strict Abstention on side-effecting methods (@Transactional, .save(), etc.)
//! 4. Structured JSON report output

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
        "sajimora-inv-{tag}-{}-{}",
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_gen_invariants(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("gen-invariants")
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
fn test_gen_invariants_idempotence_and_null_safety() {
    let dir = unique_dir("idempotence");
    let file_path = dir.join("UserService.java");

    let source = r#"package com.example.service;

import org.springframework.lang.NonNull;
import org.springframework.transaction.annotation.Transactional;

public class UserService {
    // Pure Normalizer: Idempotence Invariant must be synthesized
    public String normalizeEmail(String email) {
        if (email == null) return "";
        return email.trim().toLowerCase();
    }

    // Explicit @NonNull: Null-safety invariant must be synthesized
    public UserProfile updateProfile(@NonNull String userId, @NonNull String displayName) {
        return new UserProfile(userId, displayName);
    }

    // Side-Effecting method: Must strictly abstain with INVARIANT_SIDE_EFFECTS
    @Transactional
    public void deleteUser(String userId) {
        userRepository.delete(userId);
    }
}
"#;

    fs::write(&file_path, source).unwrap();

    let (code, stdout, stderr) =
        run_gen_invariants(&["--file", file_path.to_str().unwrap(), "--json"]);

    assert_eq!(code, 0, "gen-invariants failed: {stderr}");

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON report output");

    let invariants = json_val["invariants_discovered"].as_array().unwrap();
    assert!(invariants
        .iter()
        .any(|i| i["method_name"] == "normalizeEmail" && i["kind"] == "Idempotence"));
    assert!(invariants
        .iter()
        .any(|i| i["method_name"] == "updateProfile" && i["kind"] == "NullSafety"));

    // Verify strict abstention on deleteUser
    let abstentions = json_val["abstentions"].as_array().unwrap();
    assert!(
        abstentions
            .iter()
            .any(|a| a["method_name"] == "deleteUser" && a["code"] == "INVARIANT_SIDE_EFFECTS"),
        "deleteUser must be strictly abstained from invariant generation"
    );

    // Verify synthesized jqwik Java source code
    let synthesized_source = json_val["synthesized_source"].as_str().unwrap();
    assert!(synthesized_source.contains("@Property"));
    assert!(synthesized_source.contains("void idempotence_normalizeEmail(@ForAll String input)"));
    assert!(synthesized_source.contains("assertEquals(first, second"));
    assert!(synthesized_source.contains("void nullSafety_updateProfile()"));
    assert!(synthesized_source.contains("assertThrows(Exception.class"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_gen_invariants_writes_to_output_file() {
    let dir = unique_dir("out-file");
    let file_path = dir.join("FormatterService.java");
    let out_test_path = dir.join("FormatterServiceInvariantsTest.java");

    let source = r#"package com.example.service;

public class FormatterService {
    public String sanitizeHandle(String raw) {
        return raw.replace("@", "").trim();
    }
}
"#;

    fs::write(&file_path, source).unwrap();

    let (code, stdout, stderr) = run_gen_invariants(&[
        "--file",
        file_path.to_str().unwrap(),
        "--out",
        out_test_path.to_str().unwrap(),
    ]);

    assert_eq!(code, 0, "Failed: {stderr}");
    assert!(stdout.contains("Successfully wrote synthesized property tests"));

    assert!(out_test_path.exists(), "Output test file must exist");
    let content = fs::read_to_string(&out_test_path).unwrap();
    assert!(content.contains("public class FormatterServiceInvariantsTest"));
    assert!(content.contains("idempotence_sanitizeHandle"));

    let _ = fs::remove_dir_all(dir);
}
