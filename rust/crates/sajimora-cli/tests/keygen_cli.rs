//! keygen_cli.rs — `sajimora keygen` must emit a keypair that the rest of the
//! native lane can actually use: the private key loads through the same loader
//! as `sajimora sign`, the public key verifies its signatures, and the emitted
//! trust policy parses as an `ArtifactTrustPolicy` without hand editing.

use contract_core::admission::{
    load_signing_key, sign_ed25519, verify_ed25519_signature, ArtifactTrustPolicy,
};
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
        "sajimora-keygen-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_keygen(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("keygen")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn keygen_writes_a_usable_keypair_and_policy() {
    let dir = unique_dir("usable");
    let keys = dir.join("keys");
    let (code, stdout, stderr) = run_keygen(&[
        "--out-dir",
        keys.to_str().unwrap(),
        "--repo-id",
        "acme/orders",
        "--service-id",
        "orders-api",
    ]);
    assert_eq!(
        code, 0,
        "keygen failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    let private_path = keys.join("sajimora-private.pem");
    let public_path = keys.join("sajimora-public.pem");
    let policy_path = keys.join("trust-policy.json");
    for path in [&private_path, &public_path, &policy_path] {
        assert!(
            path.exists(),
            "expected keygen output at {}",
            path.display()
        );
    }

    let private_pem = fs::read_to_string(&private_path).unwrap();
    let public_pem = fs::read_to_string(&public_path).unwrap();
    let policy: ArtifactTrustPolicy =
        serde_json::from_str(&fs::read_to_string(&policy_path).unwrap())
            .expect("trust-policy.json must deserialize as ArtifactTrustPolicy");

    assert_eq!(policy.producers.len(), 1);
    assert_eq!(policy.producers[0].repository_id, "acme/orders");
    assert_eq!(policy.producers[0].service_id, "orders-api");
    assert!(
        policy.require_signatures,
        "generated policy must require signatures"
    );
    assert_eq!(
        policy.producers[0].public_key_pem.as_deref(),
        Some(public_pem.as_str())
    );

    let signing_key = load_signing_key(&private_pem)
        .expect("generated private key must load through the signer's loader");
    let digest = "ab".repeat(32);
    let signature = sign_ed25519(digest.as_bytes(), &signing_key);
    verify_ed25519_signature(&digest, &signature, &public_pem).expect(
        "a signature from the generated private key must verify against the generated public key",
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&private_path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "private key must be owner-only on Unix"
        );
    }
}

#[test]
fn keygen_refuses_to_overwrite_an_existing_private_key() {
    let dir = unique_dir("overwrite");
    let keys = dir.join("keys");
    let (code, _, stderr) = run_keygen(&[
        "--out-dir",
        keys.to_str().unwrap(),
        "--repo-id",
        "acme/orders",
        "--service-id",
        "orders-api",
    ]);
    assert_eq!(code, 0, "first keygen failed: {stderr}");
    let private_path = keys.join("sajimora-private.pem");
    let original = fs::read_to_string(&private_path).unwrap();

    let (code, stdout, stderr) = run_keygen(&[
        "--out-dir",
        keys.to_str().unwrap(),
        "--repo-id",
        "acme/orders",
        "--service-id",
        "orders-api",
    ]);

    assert_ne!(code, 0, "keygen must not silently destroy an existing key");
    assert!(
        stdout.contains("already exists") || stderr.contains("already exists"),
        "the refusal must explain the collision.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert_eq!(
        fs::read_to_string(&private_path).unwrap(),
        original,
        "an existing private key must be left byte-identical"
    );
}

#[test]
fn keygen_prints_json_when_no_out_dir_is_given() {
    let (code, stdout, stderr) = run_keygen(&[]);
    assert_eq!(code, 0, "keygen failed.\nstderr:\n{stderr}");

    let value: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout must be a JSON document");
    assert!(value["privateKeyPem"]
        .as_str()
        .unwrap()
        .contains("BEGIN PRIVATE KEY"));
    assert!(value["publicKeyPem"]
        .as_str()
        .unwrap()
        .contains("BEGIN PUBLIC KEY"));
    assert_eq!(value["trustPolicy"]["requireSignatures"], true);
    assert_eq!(
        value["trustPolicy"]["producers"][0]["repositoryId"],
        "example-org/repo"
    );
}

#[test]
fn keygen_records_an_operator_supplied_key_id() {
    let dir = unique_dir("key-id");
    let keys = dir.join("keys");
    let (code, _, stderr) = run_keygen(&[
        "--out-dir",
        keys.to_str().unwrap(),
        "--repo-id",
        "acme/orders",
        "--service-id",
        "orders-api",
        "--key-id",
        "release-key-2026",
    ]);
    assert_eq!(code, 0, "keygen failed: {stderr}");

    let policy: ArtifactTrustPolicy =
        serde_json::from_str(&fs::read_to_string(keys.join("trust-policy.json")).unwrap()).unwrap();
    assert_eq!(
        policy.producers[0].public_key_id.as_deref(),
        Some("release-key-2026"),
        "an operator-assigned key id must be recorded in the policy"
    );
}
