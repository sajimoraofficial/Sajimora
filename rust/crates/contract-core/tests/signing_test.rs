use contract_core::{
    admission::{
        admit_artifact, sign_envelope_value, verify_ed25519_signature, AdmissionError,
        ArtifactTrustPolicy, TrustedProducer,
    },
    envelope::{parse_envelope, ContractArtifactEnvelope},
};
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};

fn sample_envelope() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes/backend_same.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn test_ed25519_envelope_signing_and_verification() {
    // Generate deterministic 32-byte secret seed for testing
    let seed = [42u8; 32];
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();
    let public_key_pem = verifying_key
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();

    let mut envelope_val = sample_envelope();
    let sig_b64 = sign_envelope_value(&mut envelope_val, &signing_key).expect("signing failed");
    assert!(!sig_b64.is_empty());
    assert_eq!(envelope_val["signature"], json!(sig_b64));

    let digest = envelope_val["integrity"]["sha256"].as_str().unwrap();
    assert!(verify_ed25519_signature(digest, &sig_b64, &public_key_pem).is_ok());

    // Tampered payload fails verification
    let mut tampered_digest = digest.to_string();
    tampered_digest.replace_range(0..2, "ff");
    assert!(verify_ed25519_signature(&tampered_digest, &sig_b64, &public_key_pem).is_err());
}

#[test]
fn test_admission_policy_enforces_required_signature() {
    let seed = [7u8; 32];
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();
    let public_key_pem = verifying_key
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();

    let mut envelope_val = sample_envelope();
    let _ = sign_envelope_value(&mut envelope_val, &signing_key).unwrap();

    let envelope: ContractArtifactEnvelope =
        parse_envelope(&serde_json::to_vec(&envelope_val).unwrap()).unwrap();

    let policy = ArtifactTrustPolicy {
        producers: vec![TrustedProducer {
            repository_id: envelope.snapshot.repository_id.clone(),
            service_id: envelope.snapshot.service_id.clone(),
            trusted_digests: None,
            public_key_pem: Some(public_key_pem),
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        }],
        require_signatures: true,
        ..Default::default()
    };

    // Valid signed envelope admitted
    assert!(admit_artifact(&envelope, &policy, false).is_ok());

    // Tampered signature rejected
    let mut bad_envelope = envelope.clone();
    bad_envelope.signature = Some("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=".into());
    let err = admit_artifact(&bad_envelope, &policy, false).unwrap_err();
    assert!(matches!(err, AdmissionError::SignatureVerificationFailed));
}

#[test]
fn test_trust_policy_defaults_require_signatures_to_true() {
    let constructed = ArtifactTrustPolicy::default();
    assert!(
        constructed.require_signatures,
        "constructed Default must match the serde default (secure-by-default)"
    );

    let empty_json = r#"{"producers": []}"#;
    let policy: ArtifactTrustPolicy =
        serde_json::from_str(empty_json).expect("deserialize empty policy");
    assert!(
        policy.require_signatures,
        "require_signatures must default to true when omitted from JSON"
    );
    assert_eq!(
        policy, constructed,
        "deserialized defaults and constructed defaults must not diverge"
    );

    let explicit_camel = r#"{"producers": [], "requireSignatures": false}"#;
    let policy_camel: ArtifactTrustPolicy =
        serde_json::from_str(explicit_camel).expect("deserialize camelCase false");
    assert!(
        !policy_camel.require_signatures,
        "Explicit camelCase opt-out must be respected"
    );

    let explicit_snake = r#"{"producers": [], "require_signatures": false}"#;
    let policy_snake: ArtifactTrustPolicy =
        serde_json::from_str(explicit_snake).expect("deserialize snake_case false");
    assert!(
        !policy_snake.require_signatures,
        "Explicit snake_case opt-out must be respected"
    );
}
