use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes")
        .join(format!("{name}.json"));
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn test_cli_sign_and_verify_envelope_lifecycle() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-sign-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let artifact_path = tmp_dir.join("artifact.json");
    let signed_path = tmp_dir.join("signed_artifact.json");
    let key_path = tmp_dir.join("ed25519.key");
    let pubkey_path = tmp_dir.join("ed25519.pub");

    // 32-byte secret seed in hex
    let seed_hex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    fs::write(&key_path, seed_hex).unwrap();

    // Load signing key to get public key PEM
    let signing_key = contract_core::admission::load_signing_key(seed_hex).unwrap();
    let verifying_key = signing_key.verifying_key();
    let pub_pem = {
        use ed25519_dalek::pkcs8::EncodePublicKey;
        verifying_key
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap()
    };
    fs::write(&pubkey_path, &pub_pem).unwrap();

    let raw_artifact = fixture("backend_same");
    fs::write(
        &artifact_path,
        serde_json::to_string_pretty(&raw_artifact).unwrap(),
    )
    .unwrap();

    // 1. Run sign command via CLI binary
    let sign_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "sign",
            "--artifact",
            artifact_path.to_str().unwrap(),
            "--key",
            key_path.to_str().unwrap(),
            "--out",
            signed_path.to_str().unwrap(),
        ])
        .status()
        .expect("failed to run sajimora sign");
    assert!(sign_status.success());
    assert!(signed_path.exists());

    // 2. Run verify-envelope command on the signed artifact
    let verify_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "verify-envelope",
            "--artifact",
            signed_path.to_str().unwrap(),
            "--public-key",
            pubkey_path.to_str().unwrap(),
        ])
        .status()
        .expect("failed to run sajimora verify-envelope");
    assert!(verify_status.success());

    // 3. Tamper with the artifact content
    let mut tampered_val: serde_json::Value =
        serde_json::from_slice(&fs::read(&signed_path).unwrap()).unwrap();
    tampered_val["payload"]["baseUrls"] = serde_json::json!(["http://tampered-url.com"]);
    let tampered_path = tmp_dir.join("tampered.json");
    fs::write(
        &tampered_path,
        serde_json::to_string_pretty(&tampered_val).unwrap(),
    )
    .unwrap();

    // Verification must fail closed on tampered artifact
    let failed_verify = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "verify-envelope",
            "--artifact",
            tampered_path.to_str().unwrap(),
            "--public-key",
            pubkey_path.to_str().unwrap(),
        ])
        .status()
        .expect("failed to run sajimora verify-envelope");
    assert!(!failed_verify.success());

    let _ = fs::remove_dir_all(&tmp_dir);
}
