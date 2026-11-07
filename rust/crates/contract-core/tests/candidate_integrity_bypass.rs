use contract_core::{
    envelope::parse_envelope,
    report::{BlockerCode, CrossLanguageVerdict},
    service::{run_check_contract_envelope_service, CheckContractEnvelopeRequest},
};
use serde_json::{json, Value};

fn sample_envelope() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes/backend_same.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn sample_frontend_envelope() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes/frontend_complete.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn test_candidate_tampered_payload_with_copied_integrity_fails_admission() {
    let base_val = sample_envelope();
    let mut candidate_val = base_val.clone();
    let target_val = sample_frontend_envelope();

    // Tamper with candidate payload (e.g., delete all endpoints) while copying base integrity
    candidate_val["payload"]["endpoints"] = json!([]);
    // Intentionally keep candidate_val["integrity"] == base_val["integrity"]

    let base = parse_envelope(&serde_json::to_vec(&base_val).unwrap()).unwrap();
    let candidate = parse_envelope(&serde_json::to_vec(&candidate_val).unwrap()).unwrap();
    let target = parse_envelope(&serde_json::to_vec(&target_val).unwrap()).unwrap();

    let req = CheckContractEnvelopeRequest {
        base,
        candidate,
        targets: vec![target],
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    };

    let report = run_check_contract_envelope_service(req)
        .expect("service execution should return error report, not panic");

    assert_eq!(
        report.verdict,
        CrossLanguageVerdict::AnalysisError,
        "Tampered candidate with copied digest must result in ANALYSIS_ERROR"
    );
    assert!(
        report.blockers.iter().any(|b| {
            matches!(b.code, BlockerCode::ToolFailure)
                && b.message.contains("candidate: admission failed")
        }),
        "Must contain admission failure blocker for candidate, got: {:?}",
        report.blockers
    );
}

#[test]
fn test_identical_unmodified_contract_still_succeeds() {
    let base_val = sample_envelope();
    let target_val = sample_frontend_envelope();

    let base = parse_envelope(&serde_json::to_vec(&base_val).unwrap()).unwrap();
    let candidate = parse_envelope(&serde_json::to_vec(&base_val).unwrap()).unwrap();
    let target = parse_envelope(&serde_json::to_vec(&target_val).unwrap()).unwrap();

    let req = CheckContractEnvelopeRequest {
        base,
        candidate,
        targets: vec![target],
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    };

    let report =
        run_check_contract_envelope_service(req).expect("service execution should return report");

    // Identical admitted contract should succeed without admission error
    assert_ne!(
        report.verdict,
        CrossLanguageVerdict::AnalysisError,
        "Legitimate identical candidate must pass admission: {:?}",
        report.blockers
    );
}
