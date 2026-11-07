//! cli_integration.rs -- R3 gate: subprocess integration tests for `sajimora check-contract`.
//!
//! Gate R3 scenarios covered:
//!  . valid artifacts -> LIKELY_PRESERVED or INCONCLUSIVE
//!  . breaking change -> LIKELY_VIOLATED with findings
//!  . malformed JSON -> nonzero exit with error
//!  . tampered (digest mismatch) -> ANALYSIS_ERROR or nonzero exit
//!  . incomplete artifact -> INCONCLUSIVE, exit 0 (advisory)
//!  . --out flag -> file written, stdout empty
//!  . missing required flag -> nonzero exit
//!  . --help -> exit 0, mentions check-contract
//!  . --version -> exit 0, emits version string
//!  . wrong artifact kind as target -> ANALYSIS_ERROR
//!  . deterministic: two identical runs produce identical JSON
//!  . Unicode path with spaces
//!  . --trust-policy and --trusted-local are mutually exclusive
//!  . binary executes without Node

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn binary() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().unwrap().parent().unwrap();
    workspace.join("target").join("debug").join("sajimora.exe")
}

fn fixtures() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

fn env_path(name: &str) -> PathBuf {
    fixtures().join("envelopes").join(name)
}

fn trust_path(name: &str) -> PathBuf {
    fixtures().join("trust").join(name)
}

fn run(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(binary())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("NODE_PATH")
        .output()
        .unwrap_or_else(|e| panic!("failed to run {:?}: {e}", binary()));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code().unwrap_or(-1);
    (code, stdout, stderr)
}

fn parse_json(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).unwrap_or_else(|e| {
        panic!(
            "stdout not valid JSON: {e}\n---\n{}",
            &stdout[..stdout.len().min(500)]
        )
    })
}

// ------------------------------------------------------------------
// --help and --version
// ------------------------------------------------------------------

#[test]
fn help_exits_zero() {
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0, "expected exit 0 from --help");
    assert!(
        stdout.contains("check-contract") || stdout.contains("check_contract"),
        "--help should mention check-contract, got:\n{stdout}"
    );
}

#[test]
fn version_exits_zero() {
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, 0, "expected exit 0 from --version");
    assert!(!stdout.is_empty(), "--version should emit something");
}

// ------------------------------------------------------------------
// Invocation errors
// ------------------------------------------------------------------

#[test]
fn missing_required_flags_exits_nonzero() {
    let (code, _, _) = run(&["check-contract"]);
    assert_ne!(code, 0, "missing required args must exit nonzero");
}

#[test]
fn trust_policy_and_trusted_local_mutually_exclusive() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let tp = trust_path("trust_open.json");
    let (code, _, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trust-policy",
        tp.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_ne!(code, 0, "conflicting trust flags should fail");
}

#[test]
fn no_trust_flag_exits_nonzero() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, _, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
    ]);
    assert_ne!(code, 0, "no trust flag should exit nonzero");
}

// ------------------------------------------------------------------
// Malformed / missing input
// ------------------------------------------------------------------

#[test]
fn malformed_json_exits_nonzero() {
    let malformed = env_path("malformed.json");
    let cand = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, _, stderr) = run(&[
        "check-contract",
        "--base",
        malformed.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_ne!(code, 0, "malformed base should exit nonzero");
    assert!(
        !stderr.is_empty(),
        "expected error on stderr for malformed input"
    );
}

#[test]
fn nonexistent_file_exits_nonzero() {
    let (code, _, _) = run(&[
        "check-contract",
        "--base",
        "does-not-exist.json",
        "--candidate",
        "also-missing.json",
        "--target",
        "nope.json",
        "--trusted-local",
    ]);
    assert_ne!(code, 0, "missing files should exit nonzero");
}

// ------------------------------------------------------------------
// Tampered (digest mismatch)
// ------------------------------------------------------------------

#[test]
fn tampered_artifact_admission_error() {
    let tampered = env_path("tampered.json");
    let cand = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        tampered.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    let is_error_exit = code != 0;
    let is_analysis_error = stdout.contains("ANALYSIS_ERROR");
    assert!(
        is_error_exit || is_analysis_error,
        "tampered should produce ANALYSIS_ERROR or nonzero exit; code={code}; stdout={}",
        &stdout[..stdout.len().min(500)]
    );
}

// ------------------------------------------------------------------
// Incomplete artifact
// ------------------------------------------------------------------

#[test]
fn incomplete_artifact_inconclusive_exits_zero() {
    let incomplete = env_path("backend_incomplete.json");
    let fe = env_path("frontend_complete.json");
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        incomplete.to_str().unwrap(),
        "--candidate",
        incomplete.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_eq!(code, 0, "advisory: incomplete artifact report exits 0");
    let report = parse_json(&stdout);
    let verdict = report["verdict"].as_str().unwrap_or("");
    assert!(
        verdict == "INCONCLUSIVE" || verdict == "ANALYSIS_ERROR",
        "expected INCONCLUSIVE or ANALYSIS_ERROR, got {verdict}"
    );
}

// ------------------------------------------------------------------
// Wrong kind as target (backend used where frontend is required)
// ------------------------------------------------------------------

#[test]
fn wrong_kind_target_analysis_error() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_same.json");
    let wrong = env_path("wrong_kind_target.json");
    let args = [
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        wrong.to_str().unwrap(),
        "--trusted-local",
    ];

    // Default local advisory mode (spec §8.1): ANALYSIS_ERROR allows the
    // commit with exit 0 and prints the recovery banner.
    let (code, stdout, stderr) = run(&args);
    assert_eq!(code, 0, "ANALYSIS_ERROR exits 0 in default advisory mode");
    let report = parse_json(&stdout);
    let verdict = report["verdict"].as_str().unwrap_or("");
    assert_eq!(
        verdict, "ANALYSIS_ERROR",
        "wrong kind target should produce ANALYSIS_ERROR, got {verdict}"
    );
    assert!(
        stderr.contains("Sajimora Advisory"),
        "advisory banner expected on stderr, got: {stderr}"
    );

    // --strict escalation (spec §8): ANALYSIS_ERROR fails closed with exit 3.
    let mut strict_args = args.to_vec();
    strict_args.push("--strict");
    let (strict_code, _, _) = run(&strict_args);
    assert_eq!(strict_code, 3, "ANALYSIS_ERROR exits 3 under --strict");
}

// ------------------------------------------------------------------
// Invalid --policy-mode is a USAGE_ERROR (spec §8.2, exit 2)
// ------------------------------------------------------------------

#[test]
fn invalid_policy_mode_is_usage_error_exit_2() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, _, stderr) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
        "--policy-mode",
        "bogus-mode",
    ]);
    assert_eq!(
        code, 2,
        "invalid --policy-mode must exit with USAGE_ERROR (2)"
    );
    assert!(
        stderr.contains("invalid --policy-mode"),
        "expected usage error message on stderr, got: {stderr}"
    );
}

// ------------------------------------------------------------------
// No change -> LIKELY_PRESERVED or INCONCLUSIVE
// ------------------------------------------------------------------

#[test]
fn same_backend_preserved_or_inconclusive() {
    let base = env_path("backend_complete.json");
    let same = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        same.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_eq!(code, 0);
    let report = parse_json(&stdout);
    let verdict = report["verdict"].as_str().unwrap_or("");
    assert!(
        verdict == "LIKELY_PRESERVED" || verdict == "INCONCLUSIVE",
        "same backend should be LIKELY_PRESERVED or INCONCLUSIVE, got {verdict}"
    );
}

// ------------------------------------------------------------------
// Breaking change -> LIKELY_VIOLATED with findings
// ------------------------------------------------------------------

#[test]
fn breaking_change_likely_violated() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_candidate.json"); // name -> displayName
    let fe = env_path("frontend_complete.json"); // expects {id, name}
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_eq!(code, 0, "advisory: LIKELY_VIOLATED exits 0");
    let report = parse_json(&stdout);
    let verdict = report["verdict"].as_str().unwrap_or("");
    assert_eq!(
        verdict,
        "LIKELY_VIOLATED",
        "field rename should be LIKELY_VIOLATED, got {verdict};\nreport={}",
        &stdout[..stdout.len().min(800)]
    );
    let findings = report["findings"]
        .as_array()
        .expect("findings must be array");
    assert!(!findings.is_empty(), "LIKELY_VIOLATED must have findings");
}

// ------------------------------------------------------------------
// Finding structure
// ------------------------------------------------------------------

#[test]
fn finding_has_required_fields() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_candidate.json");
    let fe = env_path("frontend_complete.json");
    let (_, stdout, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    let report = parse_json(&stdout);
    let findings = report["findings"].as_array().expect("findings array");
    assert!(!findings.is_empty());
    for f in findings {
        let id = f["id"].as_str().unwrap_or("");
        assert!(!id.is_empty(), "finding must have non-empty id");
        assert_eq!(id.len(), 16, "finding id must be 16 hex chars, got {id:?}");
        assert!(f["endpoint"].is_object(), "finding must have endpoint");
        assert!(
            f["wirePath"].as_str().is_some(),
            "finding must have wirePath"
        );
        assert!(f["change"].is_object(), "finding must have change");
        assert!(
            f["repairHint"].as_str().is_some(),
            "finding must have repairHint"
        );
    }
}

// ------------------------------------------------------------------
// Report structure invariants
// ------------------------------------------------------------------

#[test]
fn report_has_required_top_level_fields() {
    let base = env_path("backend_complete.json");
    let same = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        same.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    assert_eq!(code, 0);
    let report = parse_json(&stdout);
    assert!(
        report["schemaVersion"].as_str().is_some(),
        "schemaVersion required"
    );
    assert!(report["assurance"].as_str().is_some(), "assurance required");
    assert!(report["verdict"].as_str().is_some(), "verdict required");
    assert!(report["property"].as_str().is_some(), "property required");
    assert!(
        report["verdictScope"].as_str() == Some("Static Compatibility Supported"),
        "verdictScope must carry the spec §4 scope label, got {:?}",
        report["verdictScope"]
    );
    assert!(report["findings"].is_array(), "findings must be array");
    assert!(report["blockers"].is_array(), "blockers must be array");
    assert!(report["counts"].is_object(), "counts must be object");
    assert!(
        report["repository"].is_object(),
        "repository must be object"
    );
}

// ------------------------------------------------------------------
// --out flag
// ------------------------------------------------------------------

#[test]
fn out_flag_writes_file_stdout_is_empty() {
    let base = env_path("backend_complete.json");
    let same = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let tmp = std::env::temp_dir().join("sajimora_r3_out_test");
    fs::create_dir_all(&tmp).unwrap();
    let out_file = tmp.join("report.json");
    let _ = fs::remove_file(&out_file);

    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        same.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
        "--out",
        out_file.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "expected exit 0 with --out");
    assert!(
        stdout.trim().is_empty(),
        "stdout should be empty when --out used, got: {stdout}"
    );
    assert!(out_file.exists(), "--out file should exist");
    let content = fs::read_to_string(&out_file).unwrap();
    let report = parse_json(&content);
    assert!(
        report["verdict"].as_str().is_some(),
        "report in file should have verdict"
    );
    let _ = fs::remove_file(&out_file);
}

// ------------------------------------------------------------------
// Deterministic output
// ------------------------------------------------------------------

#[test]
fn output_is_deterministic() {
    let base = env_path("backend_complete.json");
    let cand = env_path("backend_candidate.json");
    let fe = env_path("frontend_complete.json");
    let args = [
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        cand.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ];
    let (_, stdout1, _) = run(&args);
    let (_, stdout2, _) = run(&args);
    assert_eq!(
        stdout1, stdout2,
        "two identical runs must produce identical output"
    );
}

// ------------------------------------------------------------------
// Unicode path with spaces
// ------------------------------------------------------------------

#[test]
fn unicode_path_with_spaces_works() {
    let source = env_path("backend_complete.json");
    let tmp_dir = std::env::temp_dir().join("sajimora r3 тест юникод");
    fs::create_dir_all(&tmp_dir).unwrap();
    let dest = tmp_dir.join("base artifact file.json");
    fs::copy(&source, &dest).unwrap();

    let same = env_path("backend_same.json");
    let fe = env_path("frontend_complete.json");
    let (code, stdout, _) = run(&[
        "check-contract",
        "--base",
        dest.to_str().unwrap(),
        "--candidate",
        same.to_str().unwrap(),
        "--target",
        fe.to_str().unwrap(),
        "--trusted-local",
    ]);
    let report = parse_json(&stdout);
    assert!(
        report["verdict"].as_str().is_some(),
        "expected valid report for unicode path; code={code}"
    );
}

// ------------------------------------------------------------------
// Node-free: binary exists and is executable
// ------------------------------------------------------------------

#[test]
fn binary_executable_without_node() {
    let bin = binary();
    assert!(
        bin.exists(),
        "sajimora binary must exist at {}",
        bin.display()
    );
    // --help should work in an environment without Node on PATH
    let output = Command::new(&bin)
        .args(["--help"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("PATH")
        .env("PATH", "") // empty PATH -> no Node
        .output()
        .expect("binary should execute");
    assert_eq!(
        output.status.code().unwrap_or(-1),
        0,
        "sajimora --help should work without Node on PATH"
    );
}

#[test]
fn test_invalid_trust_policy_path_fails_with_exit_code_4() {
    let base = env_path("backend_same.json");
    let candidate = env_path("backend_candidate.json");
    let target = env_path("frontend_complete.json");

    let (code, _, stderr) = run(&[
        "check-contract",
        "--base",
        base.to_str().unwrap(),
        "--candidate",
        candidate.to_str().unwrap(),
        "--target",
        target.to_str().unwrap(),
        "--trust-policy",
        "non_existent_policy_file_xyz123.json",
    ]);

    assert_eq!(
        code, 4,
        "Invalid trust policy path must exit with code 4, got code: {code}, stderr: {stderr}"
    );
    assert!(
        stderr.contains("failed to read trust policy")
            || stderr.contains("Failed to read --trust-policy file"),
        "stderr must report trust policy read error: {stderr}"
    );
}
