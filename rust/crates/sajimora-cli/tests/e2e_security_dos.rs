//! e2e_security_dos.rs — Security, adversarial input, and DoS boundary end-to-end tests.
//!
//! Validates:
//! 1. Tamper Resistance: 1-byte modification of contract payload is rejected with exit code 4 (ADMISSION_ERROR) and diagnostic.
//! 2. Signature Forgery: Contract signed by untrusted Key A fails admission against Trust Policy B (exit code 4).
//! 3. Key Expiry: Trust policy with expired `validUntil` rejects validly signed artifact (exit code 4).
//! 4. Corrupted Trust Policy: Malformed JSON policy is rejected with exit code 4 (ADMISSION_ERROR) and diagnostic.
//! 5. CLI Usage Isolation: Omitted required arguments exit with code 2 (USAGE_ERROR) with specific clap error.
//! 6. Filesystem Path Isolation: Pointing to non-existent target files triggers filesystem read error.
//! 7. DoS Resource Limit: Exceeding maximum allowed target artifacts (> 64) is rejected at admission boundary.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// RAII guard for temporary test directories, ensuring automatic cleanup on normal exit or panic.
pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-e2e-sec-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

#[test]
fn test_security_tampered_payload_triggers_admission_error() {
    let temp_guard = TempDirGuard::new("tamper-admission");
    let temp = temp_guard.path();

    let base_src = fixtures().join("envelopes/backend_complete.json");
    let candidate_src = fixtures().join("envelopes/backend_complete.json");
    let target_src = fixtures().join("envelopes/frontend_complete.json");

    let base_file = temp.join("base.json");
    let candidate_file = temp.join("candidate.json");
    let target_file = temp.join("target.json");

    fs::copy(&base_src, &base_file).unwrap();
    fs::copy(&target_src, &target_file).unwrap();

    // Tamper the candidate JSON by modifying the payload text without re-signing or updating hash
    let mut candidate_json: Value =
        serde_json::from_str(&fs::read_to_string(&candidate_src).unwrap()).unwrap();
    candidate_json["payload"]["endpoints"][0]["route"] = json!("/api/injected-tampered-route");
    fs::write(
        &candidate_file,
        serde_json::to_string_pretty(&candidate_json).unwrap(),
    )
    .unwrap();

    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&candidate_file)
        .arg("--target")
        .arg(&target_file)
        .arg("--trusted-local")
        .output()
        .expect("check-contract failed to execute");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let code = output.status.code().unwrap_or(-1);

    assert_eq!(
        code, 4,
        "Tampered artifact must trigger exit code 4 (ADMISSION_ERROR), got code {code}: stdout={stdout}, stderr={stderr}"
    );
    assert!(
        stdout.contains("admission failed")
            || stdout.contains("digest mismatch")
            || stderr.contains("digest mismatch"),
        "Report must flag admission failure / digest mismatch: stdout={stdout}, stderr={stderr}"
    );
}

#[test]
fn test_security_signature_forgery_fails_closed() {
    let temp_guard = TempDirGuard::new("sig-forgery");
    let temp = temp_guard.path();

    // 1. Generate Keypair A
    let keypair_a_dir = temp.join("key_a");
    let status_a = Command::new(cli_bin())
        .arg("keygen")
        .arg("--out-dir")
        .arg(&keypair_a_dir)
        .arg("--key-id")
        .arg("key-producer-a")
        .status()
        .unwrap();
    assert!(status_a.success(), "Keygen A must succeed");

    // 2. Generate Keypair B (Attacker / Different Producer)
    let keypair_b_dir = temp.join("key_b");
    let status_b = Command::new(cli_bin())
        .arg("keygen")
        .arg("--out-dir")
        .arg(&keypair_b_dir)
        .arg("--key-id")
        .arg("key-producer-b")
        .status()
        .unwrap();
    assert!(status_b.success(), "Keygen B must succeed");

    // 3. Take candidate artifact and sign it using Key B (Attacker Key)
    let candidate_src = fixtures().join("envelopes/backend_complete.json");
    let signed_by_b_file = temp.join("signed_by_b.json");
    let sign_status = Command::new(cli_bin())
        .arg("sign")
        .arg("--artifact")
        .arg(&candidate_src)
        .arg("--key")
        .arg(keypair_b_dir.join("sajimora-private.pem"))
        .arg("--out")
        .arg(&signed_by_b_file)
        .status()
        .unwrap();
    assert!(sign_status.success(), "Signing with Key B must succeed");

    // 4. Validate signed artifact against Keypair A's trust policy (must FAIL)
    let base_file = fixtures().join("envelopes/backend_complete.json");
    let target_file = fixtures().join("envelopes/frontend_complete.json");

    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&signed_by_b_file)
        .arg("--target")
        .arg(&target_file)
        .arg("--trust-policy")
        .arg(keypair_a_dir.join("trust-policy.json"))
        .output()
        .unwrap();

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        code, 4,
        "Forged/untrusted signature must trigger exit code 4 (ADMISSION_ERROR), got {code}: stdout={stdout}, stderr={stderr}"
    );
    assert!(
        stdout.contains("admission failed")
            || stdout.contains("untrusted")
            || stderr.contains("admission failed")
            || stderr.contains("untrusted"),
        "Failure must specifically report untrusted signer: stdout={stdout}, stderr={stderr}"
    );
}

#[test]
fn test_security_expired_trust_policy_rejects_admission() {
    let temp_guard = TempDirGuard::new("expired-key");
    let temp = temp_guard.path();

    // 1. Generate keypair
    let keypair_dir = temp.join("keys");
    let status = Command::new(cli_bin())
        .arg("keygen")
        .arg("--out-dir")
        .arg(&keypair_dir)
        .arg("--key-id")
        .arg("test-key")
        .status()
        .unwrap();
    assert!(status.success());

    // 2. Sign candidate artifact
    let candidate_src = fixtures().join("envelopes/backend_complete.json");
    let signed_file = temp.join("signed.json");
    let sign_status = Command::new(cli_bin())
        .arg("sign")
        .arg("--artifact")
        .arg(&candidate_src)
        .arg("--key")
        .arg(keypair_dir.join("sajimora-private.pem"))
        .arg("--out")
        .arg(&signed_file)
        .status()
        .unwrap();
    assert!(sign_status.success());

    // 3. Mutate trust-policy.json to set validUntil to an instant in the past (e.g. year 2020)
    let policy_path = keypair_dir.join("trust-policy.json");
    let mut policy_json: Value =
        serde_json::from_str(&fs::read_to_string(&policy_path).unwrap()).unwrap();
    policy_json["producers"][0]["validUntil"] = json!(1577836800); // 2020-01-01 00:00:00 UTC
    fs::write(
        &policy_path,
        serde_json::to_string_pretty(&policy_json).unwrap(),
    )
    .unwrap();

    // 4. Verify candidate against expired trust policy
    let base_file = fixtures().join("envelopes/backend_complete.json");
    let target_file = fixtures().join("envelopes/frontend_complete.json");

    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&signed_file)
        .arg("--target")
        .arg(&target_file)
        .arg("--trust-policy")
        .arg(&policy_path)
        .output()
        .unwrap();

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        code, 4,
        "Expired key in trust policy must exit with code 4 (ADMISSION_ERROR), got code {code}"
    );
    assert!(
        stdout.contains("admission failed")
            || stdout.contains("expired")
            || stderr.contains("admission failed"),
        "Must diagnostic admission failure due to expired key: stdout={stdout}, stderr={stderr}"
    );
}

#[test]
fn test_security_corrupted_trust_policy_fails_admission() {
    let temp_guard = TempDirGuard::new("corrupt-policy");
    let temp = temp_guard.path();

    let corrupt_policy = temp.join("corrupted-policy.json");
    fs::write(&corrupt_policy, "{ malformed: json not valid ...").unwrap();

    let base_file = fixtures().join("envelopes/backend_complete.json");
    let candidate_file = fixtures().join("envelopes/backend_complete.json");
    let target_file = fixtures().join("envelopes/frontend_complete.json");

    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&candidate_file)
        .arg("--target")
        .arg(&target_file)
        .arg("--trust-policy")
        .arg(&corrupt_policy)
        .output()
        .unwrap();

    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        code, 4,
        "Corrupted trust policy must exit with code 4 (ADMISSION_ERROR), got {code}"
    );
    assert!(
        stderr.contains("trust policy")
            && (stderr.contains("key must be a string")
                || stderr.contains("malformed")
                || stderr.contains("failed to read")),
        "Must flag malformed trust policy in stderr: {stderr}"
    );
}

#[test]
fn test_security_usage_error_on_missing_required_argument() {
    // Isolates argument-syntax validation: omit required --target argument
    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg("some_base.json")
        .arg("--candidate")
        .arg("some_candidate.json")
        .arg("--trusted-local")
        .output()
        .unwrap();

    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        code, 2,
        "Omitted required CLI argument (--target) must exit with code 2 (USAGE_ERROR)"
    );
    assert!(
        stderr.contains("--target") && (stderr.contains("required") || stderr.contains("error:")),
        "Clap error must report missing required --target argument: {stderr}"
    );
}

#[test]
fn test_security_error_on_non_existent_target_path() {
    // Isolates filesystem validation: all CLI arguments provided, but target path does not exist
    let base_file = fixtures().join("envelopes/backend_complete.json");
    let candidate_file = fixtures().join("envelopes/backend_complete.json");

    let output = Command::new(cli_bin())
        .arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&candidate_file)
        .arg("--target")
        .arg("non_existent_target_file_never_created.json")
        .arg("--trusted-local")
        .output()
        .unwrap();

    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_ne!(
        code, 0,
        "Non-existent target file must cause command to fail"
    );
    assert!(
        stderr.contains("failed to read")
            || stderr.contains("Reading target artifact")
            || stderr.contains("cannot find")
            || stderr.contains("No such file"),
        "Must report specific file read failure in stderr: {stderr}"
    );
}

#[test]
fn test_security_dos_excessive_target_artifacts_rejected() {
    // Validates DoS resource limits: maximum 64 target artifacts allowed per service invocation
    let base_file = fixtures().join("envelopes/backend_complete.json");
    let candidate_file = fixtures().join("envelopes/backend_complete.json");
    let target_file = fixtures().join("envelopes/frontend_complete.json");

    let mut cmd = Command::new(cli_bin());
    cmd.arg("check-contract")
        .arg("--base")
        .arg(&base_file)
        .arg("--candidate")
        .arg(&candidate_file)
        .arg("--trusted-local");

    // Pass 65 target artifacts (exceeding budget limit of 64)
    for _ in 0..65 {
        cmd.arg("--target").arg(&target_file);
    }

    let output = cmd.output().unwrap();
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        code, 1,
        "Exceeding maximum target artifacts must exit with code 1"
    );
    assert!(
        stderr.contains("Too many target artifacts") || stderr.contains("maximum 64 allowed"),
        "Must report excessive artifact boundary rejection: {stderr}"
    );
}
