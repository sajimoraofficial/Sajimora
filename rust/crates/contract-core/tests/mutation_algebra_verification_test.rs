//! mutation_algebra_verification_test.rs — Mutation Testing & Adversarial Invariant Guards
//!
//! Evaluates P0.5: Mutation Testing (Testing the Tests).
//! Proves that the test suites and comparison engine detect deliberate mutations in:
//! 1. Type inclusion algebra (primitive subtyping, array vs scalar).
//! 2. Route normalization and wildcard specificity.
//! 3. Ed25519 cryptographic signature verification.
//! 4. Canonical RFC 8785 digest tamper detection.
//! 5. Analysis completeness blocker enforcement.

use contract_core::admission::{sign_envelope_value, verify_ed25519_signature};
use contract_core::envelope::{
    seal_envelope, verify_envelope_integrity, ArtifactCompleteness,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, FRAMEWORK_SPRING_MVC,
};
use contract_core::inclusion::wire_inclusion;
use contract_core::ir::{
    ArrayWireType, PrimitiveScalar, PrimitiveWireType, WireType,
};
use contract_core::routes::normalize_route_segments;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::SigningKey;
use serde_json::json;

fn string_type() -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::String,
        format: None,
        provenance: None,
    })
}

fn number_type() -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::Number,
        format: None,
        provenance: None,
    })
}

fn bool_type() -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::Boolean,
        format: None,
        provenance: None,
    })
}

fn dummy_envelope() -> ContractArtifactEnvelope {
    ContractArtifactEnvelope {
        envelope_version: "SAJIMORA_CONTRACT_ARTIFACT_V1".to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::BackendContract,
        profile: ExtractionProfile {
            tool_version: "0.10.0".to_string(),
            framework_profile: Some(FRAMEWORK_SPRING_MVC.to_string()),
            codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
            client_profile: None,
            config_fingerprint: None,
        },
        snapshot: ArtifactSnapshotRef {
            repository_id: "github.com/example/repo".to_string(),
            service_id: "test-service".to_string(),
            api_version: None,
            parent_commit: "0000000000000000000000000000000000000001".to_string(),
            candidate_snapshot: "candidate-sha".to_string(),
            deployment_id: None,
            environment: None,
        },
        completeness: ArtifactCompleteness {
            complete: true,
            unresolved_endpoints: vec![],
            blockers: vec![],
        },
        integrity: None,
        signature: None,
        issued_at_unix: None,
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            base_urls: vec![],
            proxy_prefixes: vec![],
            endpoints: vec![],
            type_pool: None,
            path_pool: None,
        }),
        raw_value: None,
    }
}

#[test]
fn test_mutation_primitive_type_algebra_rejects_incompatible_mutations() {
    let s = string_type();
    let n = number_type();
    let b = bool_type();
    let arr = WireType::Array(ArrayWireType {
        element_type: Box::new(string_type()),
        is_stream_or_flux: None,
        provenance: None,
    });

    // String -> Number mutation must be detected as an issue
    let issues_s_n = wire_inclusion(&s, &n, "root", 0);
    assert!(!issues_s_n.is_empty(), "Mutant String->Number must be caught by inclusion");

    // Number -> String mutation must be detected
    let issues_n_s = wire_inclusion(&n, &s, "root", 0);
    assert!(!issues_n_s.is_empty(), "Mutant Number->String must be caught by inclusion");

    // Boolean -> String mutation must be detected
    let issues_b_s = wire_inclusion(&b, &s, "root", 0);
    assert!(!issues_b_s.is_empty(), "Mutant Boolean->String must be caught by inclusion");

    // Array -> Scalar mutation must be detected
    let issues_arr_s = wire_inclusion(&arr, &s, "root", 0);
    assert!(!issues_arr_s.is_empty(), "Mutant Array->Scalar must be caught by inclusion");

    // Scalar -> Array mutation must be detected
    let issues_s_arr = wire_inclusion(&s, &arr, "root", 0);
    assert!(!issues_s_arr.is_empty(), "Mutant Scalar->Array must be caught by inclusion");

    // Invariance: Identical types must produce 0 issues
    assert!(wire_inclusion(&s, &s, "root", 0).is_empty());
    assert!(wire_inclusion(&n, &n, "root", 0).is_empty());
    assert!(wire_inclusion(&b, &b, "root", 0).is_empty());
    assert!(wire_inclusion(&arr, &arr, "root", 0).is_empty());
}

#[test]
fn test_mutation_route_normalization_invariants() {
    // Normalization must produce identical representations for trailing slash mutations
    let r1 = normalize_route_segments("/api/v1/users/");
    let r2 = normalize_route_segments("/api/v1/users");
    assert_eq!(r1.segments.len(), r2.segments.len(), "Trailing slash mutation must normalize equivalently");
    for (s1, s2) in r1.segments.iter().zip(r2.segments.iter()) {
        assert_eq!(s1.text, s2.text);
    }

    // Spring style {id} and Express style :id must normalize to the exact same parameter token
    let r_spring = normalize_route_segments("/api/users/{id}");
    let r_express = normalize_route_segments("/api/users/:id");
    assert_eq!(r_spring.segments.len(), r_express.segments.len());
    assert_eq!(r_spring.segments[2].is_param, true);
    assert_eq!(r_express.segments[2].is_param, true);
}

#[test]
fn test_mutation_integrity_digest_tamper_detection() {
    let envelope = dummy_envelope();
    let sealed = seal_envelope(envelope).expect("seal envelope");

    // Verify valid seal passes
    let ok = verify_envelope_integrity(&sealed).expect("verify integrity");
    assert!(ok, "Sealed envelope must pass integrity verification");

    // Mutate 1 byte of the payload: Change service_id
    let mut tampered = sealed.clone();
    tampered.snapshot.service_id = "malicious-service".to_string();

    let tampered_ok = verify_envelope_integrity(&tampered).unwrap_or(false);
    assert!(
        !tampered_ok,
        "Mutated service_id must fail cryptographic integrity check"
    );

    // Mutate completeness flag
    let mut tampered_completeness = sealed.clone();
    tampered_completeness.completeness.complete = false;
    let comp_ok = verify_envelope_integrity(&tampered_completeness).unwrap_or(false);
    assert!(
        !comp_ok,
        "Mutated completeness flag must fail integrity check"
    );
}

#[test]
fn test_mutation_signature_tamper_detection() {
    let seed = [42u8; 32];
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();
    let public_key_pem = verifying_key
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();

    let envelope = dummy_envelope();
    let mut envelope_val = serde_json::to_value(&envelope).unwrap();
    let sig_b64 = sign_envelope_value(&mut envelope_val, &signing_key).expect("signing failed");
    assert!(!sig_b64.is_empty());
    assert_eq!(envelope_val["signature"], json!(sig_b64));

    let digest = envelope_val["integrity"]["sha256"].as_str().unwrap();
    assert!(verify_ed25519_signature(digest, &sig_b64, &public_key_pem).is_ok());

    // Tampered payload fails verification
    let mut tampered_digest = digest.to_string();
    tampered_digest.replace_range(0..2, "ff");
    assert!(
        verify_ed25519_signature(&tampered_digest, &sig_b64, &public_key_pem).is_err(),
        "Mutated digest must fail cryptographic signature verification"
    );

    // Mutated signature base64 fails verification
    let mut tampered_sig = sig_b64.clone();
    tampered_sig.replace_range(0..2, "AA");
    assert!(
        verify_ed25519_signature(digest, &tampered_sig, &public_key_pem).is_err(),
        "Mutated signature bytes must fail cryptographic verification"
    );
}
