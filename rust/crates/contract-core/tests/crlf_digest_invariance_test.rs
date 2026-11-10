//! crlf_digest_invariance_test.rs
//!
//! Enterprise QA test for cross-platform line ending invariance:
//! Verifies that Windows CRLF (`\r\n`) vs Unix LF (`\n`) formatting differences
//! in contract envelopes DO NOT alter the RFC 8785 canonical digest or break
//! envelope admission and integrity verification.

use contract_core::canonical::{canonical_json, compute_canonical_digest};
use contract_core::envelope::{compute_envelope_digest_from_value, parse_envelope};
use contract_core::service::{run_check_contract_envelope_service, CheckContractEnvelopeRequest};
use serde_json::Value;
use std::path::PathBuf;

fn fixture_bytes(name: &str) -> Vec<u8> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = manifest
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
        .join("envelopes")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("Failed to read {}: {:?}", path.display(), e))
}

#[test]
fn test_crlf_vs_lf_canonical_json_byte_for_byte_identity() {
    let unix_json = "{\n  \"service\": \"users\",\n  \"active\": true,\n  \"version\": 1\n}";
    let windows_json = "{\r\n  \"service\": \"users\",\r\n  \"active\": true,\r\n  \"version\": 1\r\n}";

    let val_unix: Value = serde_json::from_str(unix_json).unwrap();
    let val_windows: Value = serde_json::from_str(windows_json).unwrap();

    let canon_unix = canonical_json(&val_unix);
    let canon_windows = canonical_json(&val_windows);

    // Canonical bytes must be 100% byte-for-byte identical
    assert_eq!(
        canon_unix, canon_windows,
        "Canonical bytes must be identical regardless of CRLF vs LF"
    );

    let digest_unix = compute_canonical_digest(&val_unix);
    let digest_windows = compute_canonical_digest(&val_windows);

    assert_eq!(
        digest_unix, digest_windows,
        "Canonical SHA-256 digests must match across Windows and Unix JSON"
    );
}

#[test]
fn test_sealed_envelope_verifies_under_windows_crlf_conversion() {
    let raw_bytes = fixture_bytes("backend_complete.json");
    let original_str = String::from_utf8(raw_bytes).unwrap();

    // Convert to Windows CRLF
    let windows_crlf_str = original_str.replace("\r\n", "\n").replace('\n', "\r\n");
    assert!(windows_crlf_str.contains("\r\n"));

    // Parse from Windows CRLF bytes
    let parsed_from_windows = parse_envelope(windows_crlf_str.as_bytes())
        .expect("Envelope must parse cleanly from Windows CRLF bytes");

    let val_windows: Value = serde_json::from_str(&windows_crlf_str).unwrap();
    let recomputed_digest = compute_envelope_digest_from_value(val_windows).unwrap();

    let expected_digest = parsed_from_windows.integrity.as_ref().unwrap().sha256.clone();
    assert_eq!(
        recomputed_digest, expected_digest,
        "Envelope digest must remain intact when formatted with Windows CRLF"
    );

    // Run verification service with CRLF-formatted envelopes
    let target_bytes = fixture_bytes("frontend_complete.json");
    let target_windows_crlf = String::from_utf8(target_bytes)
        .unwrap()
        .replace("\r\n", "\n")
        .replace('\n', "\r\n");

    let base = parse_envelope(windows_crlf_str.as_bytes()).expect("parse base CRLF");
    let candidate = parse_envelope(windows_crlf_str.as_bytes()).expect("parse candidate CRLF");
    let target = parse_envelope(target_windows_crlf.as_bytes()).expect("parse target CRLF");

    let req = CheckContractEnvelopeRequest {
        base,
        candidate,
        targets: vec![target],
        base_targets: None,
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    };

    let report = run_check_contract_envelope_service(req)
        .expect("Verification must succeed on Windows CRLF-formatted envelopes");
    assert_eq!(
        report.verdict,
        contract_core::report::CrossLanguageVerdict::LikelyPreserved,
        "Verification must succeed on Windows CRLF-formatted envelopes: {:?}",
        report.blockers
    );
}

#[test]
fn test_tampered_payload_under_crlf_is_still_rejected() {
    let raw_bytes = fixture_bytes("backend_complete.json");
    let mut val: Value = serde_json::from_slice(&raw_bytes).unwrap();

    // Tamper with a field WITHOUT resealing digest
    val["snapshot"]["service_id"] = Value::String("hacked-service".to_string());

    let tampered_str = serde_json::to_string_pretty(&val).unwrap().replace('\n', "\r\n");
    let base_bytes = fixture_bytes("backend_complete.json");
    let target_bytes = fixture_bytes("frontend_complete.json");

    let base = parse_envelope(&base_bytes).unwrap();
    let candidate = parse_envelope(tampered_str.as_bytes()).unwrap();
    let target = parse_envelope(&target_bytes).unwrap();

    let req = CheckContractEnvelopeRequest {
        base,
        candidate,
        targets: vec![target],
        base_targets: None,
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    };

    let res = run_check_contract_envelope_service(req);
    // Tampered payload must either fail admission or produce AnalysisError
    assert!(
        res.is_err() || res.unwrap().verdict == contract_core::report::CrossLanguageVerdict::AnalysisError,
        "Tampered payload under CRLF must be rejected by admission gate"
    );
}
