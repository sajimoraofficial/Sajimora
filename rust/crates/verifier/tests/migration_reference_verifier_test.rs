// Unit tests for the payload comparison utility. Identical literals exercise
// the equality path of the comparator; they are not bootstrap evidence and
// must never be cited as Stage 1/2/3 proof.

use verifier::{EquivalenceStatus, ReferenceVerifier};

#[test]
fn test_m1_reference_verifier_ast_parity() {
    let rust_ast = r#"{"kind":"SourceFile","nodes":[{"kind":"SchemaDef","name":"User"}]}"#;
    let sjm_ast = r#"{"kind":"SourceFile","nodes":[{"kind":"SchemaDef","name":"User"}]}"#;

    let proof = ReferenceVerifier::verify_ast_equivalence("UserSchema", rust_ast, sjm_ast)
        .expect("M1 AST equivalence proof must succeed on identical ASTs");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
    assert_eq!(proof.rust_digest, proof.sjm_digest);
    assert!(!proof.certificate_sha256.is_empty());
}

#[test]
fn test_m1_reference_verifier_divergence_detection() {
    let rust_ast = r#"{"kind":"SourceFile","nodes":[{"kind":"SchemaDef","name":"User"}]}"#;
    let tampered_ast = r#"{"kind":"SourceFile","nodes":[{"kind":"SchemaDef","name":"HackedUser"}]}"#;

    let result = ReferenceVerifier::verify_ast_equivalence("UserSchema", rust_ast, tampered_ast);
    assert!(result.is_err(), "Must fail-closed upon divergence");
}

#[test]
fn test_m1_reference_verifier_contract_integrity_parity() {
    let rust_envelope = r#"{"service_id":"user_service","integrity":{"sha256":"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"}}"#;
    let sjm_envelope = r#"{"service_id":"user_service","integrity":{"sha256":"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"}}"#;

    let proof = ReferenceVerifier::verify_contract_equivalence("UserServiceContract", rust_envelope, sjm_envelope)
        .expect("Contract equivalence must succeed when digests match");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
    assert_eq!(proof.target, "UserServiceContract");
}

