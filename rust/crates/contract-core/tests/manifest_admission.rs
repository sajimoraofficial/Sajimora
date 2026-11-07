use contract_core::{
    build_sign_payload, canonical_manifest_bytes, compute_manifest_digest,
    verify_manifest_admission, verify_shard_content, AdmissionError, ArtifactTrustPolicy,
    TrustedProducer,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/envelope_v2")
}

fn load_vector(filename: &str) -> Value {
    let path = fixtures_dir().join(filename);
    let bytes =
        std::fs::read(&path).unwrap_or_else(|e| panic!("failed to read fixture {path:?}: {e}"));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("failed to parse JSON from {path:?}: {e}"))
}

fn policy_for_vector(vector: &Value) -> ArtifactTrustPolicy {
    let key_id = vector["publicKeyId"].as_str().unwrap().to_string();
    let der_hex = vector["publicKeyDerHex"].as_str().unwrap().to_string();

    ArtifactTrustPolicy {
        producers: vec![TrustedProducer {
            repository_id: "test-org/test-repo".to_string(),
            service_id: "test-service".to_string(),
            public_key_pem: None,
            trusted_digests: None,
            public_key_id: Some(key_id),
            public_key_der_hex: Some(der_hex),
            valid_until: None,
            environments: None,
            signature_format: None,
        }],
        require_signatures: true,
        ..Default::default()
    }
}

#[test]
fn test_vector_01_two_shard_happy_path_succeeds() {
    let vector = load_vector("vector_01_two_shard_happy_path.json");
    assert_eq!(vector["expectedVerificationResult"].as_str(), Some("VALID"));

    let policy = policy_for_vector(&vector);
    let signed_manifest_str = serde_json::to_string(&vector["signedManifest"]).unwrap();

    let admitted = verify_manifest_admission(
        &signed_manifest_str,
        &policy,
        Some("test-org/test-repo"),
        Some("aabbccddaabbccddaabbccddaabbccddaabbccdd"),
    )
    .expect("vector_01 should succeed admission");

    // Verify fields on admitted manifest
    assert_eq!(admitted.repository_id, "test-org/test-repo");
    assert_eq!(
        admitted.revision,
        "aabbccddaabbccddaabbccddaabbccddaabbccdd"
    );
    assert_eq!(admitted.shards.len(), 2);
    assert_eq!(admitted.shards[0].path, "shard-001.json");
    assert_eq!(admitted.shards[0].byte_length, 1024);
    assert_eq!(admitted.shards[1].path, "shard-002.json");
    assert_eq!(admitted.shards[1].byte_length, 512);

    // Verify RFC 8785 canonical bytes match fixture
    let unsigned = admitted.to_unsigned();
    let canonical_bytes = canonical_manifest_bytes(&unsigned).unwrap();
    assert_eq!(
        hex::encode(&canonical_bytes),
        vector["canonicalManifestHex"].as_str().unwrap()
    );

    // Verify SHA-256 digest of canonical bytes matches fixture
    let digest = compute_manifest_digest(&unsigned).unwrap();
    assert_eq!(digest, vector["manifestDigestHex"].as_str().unwrap());

    // Verify sign payload construction matches fixture
    let payload = build_sign_payload(
        &admitted.repository_id,
        &admitted.revision,
        &admitted.envelope_version,
        &digest,
    );
    assert_eq!(
        hex::encode(&payload),
        vector["signPayloadHex"].as_str().unwrap()
    );
}

#[test]
fn test_vector_02_tampered_repo_fails_with_signature_verification_failed() {
    let vector01 = load_vector("vector_01_two_shard_happy_path.json");
    let vector02 = load_vector("vector_02_tampered_repo.json");
    assert_eq!(
        vector02["expectedVerificationResult"].as_str(),
        Some("CRYPTO_VERIFICATION_FAILED")
    );

    // Policy recognizes legitimate producer public key from vector_01
    let policy = policy_for_vector(&vector01);
    let signed_manifest_str = serde_json::to_string(&vector02["signedManifest"]).unwrap();

    let result = verify_manifest_admission(&signed_manifest_str, &policy, None, None);
    assert!(
        result.is_err(),
        "vector_02 must fail admission due to tampered repositoryId"
    );
    assert_eq!(
        result.unwrap_err(),
        AdmissionError::SignatureVerificationFailed
    );

    // Also fails with expected repo specified
    let result_with_expected = verify_manifest_admission(
        &signed_manifest_str,
        &policy,
        Some("test-org/test-repo"),
        Some("aabbccddaabbccddaabbccddaabbccddaabbccdd"),
    );
    assert_eq!(
        result_with_expected.unwrap_err(),
        AdmissionError::SignatureVerificationFailed
    );
}

#[test]
fn test_vector_03_unknown_key_fails_with_unauthorized_producer() {
    let vector01 = load_vector("vector_01_two_shard_happy_path.json");
    let vector03 = load_vector("vector_03_unknown_key.json");
    assert_eq!(
        vector03["expectedVerificationResult"].as_str(),
        Some("CRYPTO_UNKNOWN_KEY")
    );

    // Policy recognizes legitimate key, not sha256:000...
    let policy = policy_for_vector(&vector01);
    let signed_manifest_str = serde_json::to_string(&vector03["signedManifest"]).unwrap();

    let result = verify_manifest_admission(&signed_manifest_str, &policy, None, None);
    assert!(
        result.is_err(),
        "vector_03 must fail admission due to unknown public key"
    );
    assert_eq!(result.unwrap_err(), AdmissionError::UnauthorizedProducer);
}

#[test]
fn test_vector_04_duplicate_shard_path_fails_with_manifest_validation_failed() {
    let vector04 = load_vector("vector_04_duplicate_shard_path.json");
    assert_eq!(
        vector04["expectedVerificationResult"].as_str(),
        Some("MANIFEST_VALIDATION_FAILED")
    );

    let policy = policy_for_vector(&vector04);
    let signed_manifest_str = serde_json::to_string(&vector04["signedManifest"]).unwrap();

    let result = verify_manifest_admission(&signed_manifest_str, &policy, None, None);
    assert!(
        result.is_err(),
        "vector_04 must fail admission due to duplicate shard path"
    );
    match result.unwrap_err() {
        AdmissionError::ManifestValidationFailed(msg) => {
            assert!(
                msg.contains("duplicate shard path"),
                "error message should indicate duplicate shard path: {msg}"
            );
        }
        other => panic!("expected ManifestValidationFailed, got {other:?}"),
    }
}

#[test]
fn test_vector_05_malformed_digest_fails_with_manifest_validation_failed() {
    let vector05 = load_vector("vector_05_malformed_digest.json");
    assert_eq!(
        vector05["expectedVerificationResult"].as_str(),
        Some("MANIFEST_VALIDATION_FAILED")
    );

    let policy = policy_for_vector(&vector05);
    let signed_manifest_str = serde_json::to_string(&vector05["signedManifest"]).unwrap();

    let result = verify_manifest_admission(&signed_manifest_str, &policy, None, None);
    assert!(
        result.is_err(),
        "vector_05 must fail admission due to malformed sha256"
    );
    match result.unwrap_err() {
        AdmissionError::ManifestValidationFailed(msg) => {
            assert!(
                msg.contains("shard sha256 is not 64 lowercase hex characters"),
                "error message should indicate malformed sha256: {msg}"
            );
        }
        other => panic!("expected ManifestValidationFailed, got {other:?}"),
    }
}

#[test]
fn test_vector_06_bytelength_mismatch_fails_with_manifest_validation_failed() {
    let vector06 = load_vector("vector_06_bytelength_mismatch.json");
    assert_eq!(
        vector06["expectedVerificationResult"].as_str(),
        Some("MANIFEST_VALIDATION_FAILED")
    );

    let policy = policy_for_vector(&vector06);
    let signed_manifest_str = serde_json::to_string(&vector06["signedManifest"]).unwrap();

    let result = verify_manifest_admission(&signed_manifest_str, &policy, None, None);
    assert!(
        result.is_err(),
        "vector_06 must fail admission due to byteLength exceeding 20 MiB"
    );
    match result.unwrap_err() {
        AdmissionError::ManifestValidationFailed(msg) => {
            assert!(
                msg.contains("out of bounds"),
                "error message should indicate byteLength out of bounds: {msg}"
            );
        }
        other => panic!("expected ManifestValidationFailed, got {other:?}"),
    }
}

#[test]
fn test_shard_path_traversal_rejected() {
    let vector01 = load_vector("vector_01_two_shard_happy_path.json");
    let policy = policy_for_vector(&vector01);

    let bad_paths = [
        "../secrets.json",
        "subdir/shard-001.json",
        "subdir\\shard-001.json",
        "shard-1.json",
        "shard-0001.json",
        "shard-abc.json",
        "",
    ];

    for bad_path in bad_paths {
        let mut manifest = vector01["signedManifest"].clone();
        manifest["shards"][0]["path"] = Value::String(bad_path.to_string());
        let json_str = serde_json::to_string(&manifest).unwrap();

        let result = verify_manifest_admission(&json_str, &policy, None, None);
        assert!(
            result.is_err(),
            "path {bad_path:?} must be rejected by admission"
        );
    }
}

#[test]
fn test_expected_repo_and_revision_mismatch_rejected() {
    let vector01 = load_vector("vector_01_two_shard_happy_path.json");
    let policy = policy_for_vector(&vector01);
    let signed_manifest_str = serde_json::to_string(&vector01["signedManifest"]).unwrap();

    let repo_mismatch = verify_manifest_admission(
        &signed_manifest_str,
        &policy,
        Some("wrong-org/wrong-repo"),
        Some("aabbccddaabbccddaabbccddaabbccddaabbccdd"),
    );
    assert!(matches!(
        repo_mismatch.unwrap_err(),
        AdmissionError::ManifestValidationFailed(_)
    ));

    let rev_mismatch = verify_manifest_admission(
        &signed_manifest_str,
        &policy,
        Some("test-org/test-repo"),
        Some("0000000000000000000000000000000000000000"),
    );
    assert!(matches!(
        rev_mismatch.unwrap_err(),
        AdmissionError::ManifestValidationFailed(_)
    ));
}

#[test]
fn test_verify_shard_content() {
    let vector01 = load_vector("vector_01_two_shard_happy_path.json");
    let policy = policy_for_vector(&vector01);
    let signed_manifest_str = serde_json::to_string(&vector01["signedManifest"]).unwrap();

    let admitted = verify_manifest_admission(&signed_manifest_str, &policy, None, None).unwrap();

    // Shard 001 expects length 1024, sha256 "aaaa...aaaa"
    let corrupted_content = vec![0u8; 1024];
    let err = admitted.verify_shard_content("shard-001.json", &corrupted_content);
    assert_eq!(err.unwrap_err(), AdmissionError::IntegrityFailed);

    let wrong_length_content = vec![0u8; 500];
    let err2 = admitted.verify_shard_content("shard-001.json", &wrong_length_content);
    assert_eq!(err2.unwrap_err(), AdmissionError::IntegrityFailed);

    // Correct content matching sha256 and byteLength
    use sha2::{Digest, Sha256};
    let shard_bytes = b"sample shard payload data";
    let hash = hex::encode(Sha256::digest(shard_bytes));
    let custom_shard = contract_core::envelope::ShardDescriptor {
        path: "shard-001.json".to_string(),
        sha256: hash,
        byte_length: shard_bytes.len() as u64,
    };
    assert!(verify_shard_content(&custom_shard, shard_bytes).is_ok());
}
