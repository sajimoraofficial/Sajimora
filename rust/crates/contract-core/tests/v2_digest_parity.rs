use contract_core::envelope::{compute_envelope_digest, parse_envelope};
use std::path::Path;

#[test]
fn test_v2_struct_path_digest_parity() {
    let contract_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../backend-contract.json");
    let json_bytes = std::fs::read(&contract_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", contract_path.display()));

    let mut env = parse_envelope(&json_bytes).expect("parse_envelope must succeed on V2 contract");
    let expected_sha256 = env
        .integrity
        .as_ref()
        .expect("envelope must have integrity")
        .sha256
        .clone();

    // Critical: Strip raw_value to force compute_envelope_digest to serialize the Rust structs!
    env.raw_value = None;

    let computed_sha256 = compute_envelope_digest(&env)
        .expect("compute_envelope_digest must succeed on Rust struct representation");

    assert_eq!(
        computed_sha256, expected_sha256,
        "Rust struct serialization must reproduce canonical TS digest"
    );
}

#[test]
fn test_spring_sample_v2_digest_parity() {
    let contract_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/spring-sample.contract.json");
    let json_bytes = std::fs::read(&contract_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", contract_path.display()));

    let mut env = parse_envelope(&json_bytes).expect("parse_envelope must succeed on V2 contract");
    let expected_sha256 = env
        .integrity
        .as_ref()
        .expect("envelope must have integrity")
        .sha256
        .clone();

    // Critical: Strip raw_value to force compute_envelope_digest to serialize the Rust structs!
    env.raw_value = None;

    let computed_sha256 = compute_envelope_digest(&env)
        .expect("compute_envelope_digest must succeed on Rust struct representation");

    assert_eq!(
        computed_sha256, expected_sha256,
        "Rust struct serialization must reproduce canonical TS digest for spring-sample"
    );
}
