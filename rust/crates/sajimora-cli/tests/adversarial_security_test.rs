//! adversarial_security_test.rs — Adversarial Security, Path Traversal & Sandbox Enforcement
//!
//! Evaluates Sajimora's defenses against malicious repository inputs:
//! 1. Path traversal attacks (`../../etc/passwd` directory escape).
//! 2. Symlinks pointing outside the repository boundary.
//! 3. Circular symlink loops (`loop -> loop`) designed to cause infinite recursion.
//! 4. Resource exhaustion (oversized artifacts exceeding aggregate memory budgets).
//! 5. Malicious JSON payloads with duplicate keys (RFC 8785 compliance).
//! 6. Null-byte poison attacks in file paths.

use contract_core::canonical::check_no_duplicate_keys;
use contract_core::service::{
    run_check_contract_service, validate_path_under_roots, CheckContractServiceRequest,
};
use source_index::java_routes::JavaRouteExtractor;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora-sec-qa-{tag}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn test_path_traversal_outside_allowed_roots() {
    let tmp = TempDirGuard::new("path-traversal");
    let sandbox = tmp.path.join("sandbox");
    let outside = tmp.path.join("outside");
    fs::create_dir_all(&sandbox).unwrap();
    fs::create_dir_all(&outside).unwrap();

    let outside_file = outside.join("secret.json");
    fs::write(&outside_file, b"{\"secret\": true}").unwrap();

    let malicious_escape_path = sandbox.join("../outside/secret.json");

    let allowed_roots = vec![sandbox.clone()];
    let result = validate_path_under_roots(&malicious_escape_path, &allowed_roots);

    assert!(
        result.is_err(),
        "Path traversal escape must be strictly blocked by allowed_roots"
    );
    let err_msg = result.err().unwrap().to_string();
    assert!(
        err_msg.contains("outside all allowed roots"),
        "Expected error message indicating outside allowed roots, got: {err_msg}"
    );
}

#[test]
fn test_symlink_pointing_outside_repository() {
    let tmp = TempDirGuard::new("symlink-escape");
    let repo_dir = tmp.path.join("repo");
    let secret_dir = tmp.path.join("secret_target");
    fs::create_dir_all(&repo_dir).unwrap();
    fs::create_dir_all(&secret_dir).unwrap();

    let secret_file = secret_dir.join("confidential.txt");
    fs::write(&secret_file, b"CONFIDENTIAL_DATA").unwrap();

    // Create a symlink inside the repository that points outside
    let symlink_path = repo_dir.join("symlink_to_secret.txt");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret_file, &symlink_path).expect("create symlink");

    let allowed_roots = vec![repo_dir.clone()];
    let result = validate_path_under_roots(&symlink_path, &allowed_roots);

    assert!(
        result.is_err(),
        "Symlink pointing outside allowed root must be rejected upon canonicalization"
    );
}

#[test]
fn test_circular_symlink_loop_resilience() {
    let tmp = TempDirGuard::new("symlink-loop");
    let repo_dir = tmp.path.join("repo");
    let src_dir = repo_dir.join("src").join("loop_dir");
    fs::create_dir_all(&src_dir).unwrap();

    // Create a real source file to extract
    fs::write(
        repo_dir.join("src").join("ValidController.java"),
        r#"package com.demo;
import org.springframework.web.bind.annotation.*;
@RestController
public class ValidController {
    @GetMapping("/api/safe")
    public String safe() { return "ok"; }
}
"#,
    )
    .unwrap();

    // Create a recursive circular symlink inside src: loop_dir/sub_loop -> ../loop_dir
    #[cfg(unix)]
    {
        let loop_link = src_dir.join("sub_loop");
        let _ = std::os::unix::fs::symlink(&src_dir, &loop_link);
    }

    // Run JavaRouteExtractor: must terminate within milliseconds without infinite loop or stack overflow
    let start = std::time::Instant::now();
    let extractor = JavaRouteExtractor::new(repo_dir.clone(), &repo_dir.join("src"))
        .expect("create java extractor");
    let (payload, completeness) = extractor.extract_payload("sha1");
    let elapsed = start.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "Extraction must not stall on circular symlinks (took {:?})",
        elapsed
    );
    assert_eq!(payload.endpoints.len(), 1, "Must extract the 1 safe endpoint cleanly");
    assert!(completeness.complete, "Completeness must be true");

    // Run TypeScriptRouteExtractor: must also terminate safely
    let ts_extractor = TypeScriptRouteExtractor::new(repo_dir.clone(), &repo_dir.join("src"))
        .expect("create ts extractor");
    let (ts_payload, _) = ts_extractor.extract_payload("test-service", "sha1");
    assert_eq!(ts_payload.client_contracts.len(), 0, "TS extractor must also handle circular symlinks without hang");
}

#[test]
fn test_oversized_artifact_budget_exhaustion() {
    let tmp = TempDirGuard::new("budget-exhaustion");
    let allowed_dir = tmp.path.join("sandbox");
    fs::create_dir_all(&allowed_dir).unwrap();

    let base_file = allowed_dir.join("base.json");
    let cand_file = allowed_dir.join("cand.json");
    let target_file = allowed_dir.join("target.json");

    // Write a dummy artifact file of 2 KB
    let dummy_payload = vec![b' '; 2048];
    fs::write(&base_file, &dummy_payload).unwrap();
    fs::write(&cand_file, &dummy_payload).unwrap();
    fs::write(&target_file, &dummy_payload).unwrap();

    // Set max_artifact_bytes to 512 bytes (smaller than the file)
    let req = CheckContractServiceRequest {
        base_path: base_file,
        candidate_path: cand_file,
        target_paths: vec![target_file],
        base_target_paths: None,
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        allowed_roots: Some(vec![allowed_dir]),
        max_artifact_bytes: Some(512),
        telemetry_path: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
    };

    let result = run_check_contract_service(req);
    assert!(result.is_err(), "Artifact exceeding byte budget must be rejected");
    let err = result.err().unwrap().to_string();
    assert!(
        err.contains("exceeded budget") || err.contains("budget"),
        "Expected budget exhaustion error, got: {err}"
    );
}

#[test]
fn test_crafted_duplicate_json_keys_rejected() {
    // RFC 8785 Canonical JSON explicitly forbids duplicate keys (prevents parser confusion attacks)
    let duplicate_key_json = r#"{"key": 1, "key": 2}"#;
    let result = check_no_duplicate_keys(duplicate_key_json);

    assert!(
        result.is_err(),
        "RFC 8785 parser must strictly reject duplicate JSON keys to prevent semantic confusion"
    );
}

#[test]
fn test_null_byte_path_injection_rejected() {
    let tmp = TempDirGuard::new("null-byte");
    let path_with_null = tmp.path.join("test\0injection.json");
    let allowed_roots = vec![tmp.path.clone()];

    let result = validate_path_under_roots(&path_with_null, &allowed_roots);
    assert!(
        result.is_err(),
        "Paths with null bytes must be rejected by the OS or normalizer"
    );
}
