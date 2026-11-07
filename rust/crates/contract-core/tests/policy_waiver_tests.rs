use base64::Engine as _;
use contract_core::admission::WaiverApprover;
use contract_core::policy::{
    build_admission_audit, build_waiver_sign_payload, evaluate_admission_policy, AdmissionDecision,
    EndpointTrafficContext, PolicyMode, WaiverEndpointScope, WaiverEntry, WaiverLedger,
    WAIVER_LEDGER_SCHEMA,
};
use contract_core::report::{
    AnalysisCounts, AnalysisScope, ChangeRecord, ConsumerSite, CrossLanguageFinding,
    CrossLanguageImpactReport, CrossLanguageVerdict, EndpointLocation, SnapshotIdentity,
    TsExpectationKind, TypeScriptClientRef,
};
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use std::collections::HashMap;

fn make_finding(method: &str, path: &str, has_caller: bool) -> CrossLanguageFinding {
    CrossLanguageFinding {
        id: format!("{method}:{path}"),
        endpoint: EndpointLocation {
            method: method.to_string(),
            path: path.to_string(),
            java_file: "com/example/TestController.java".to_string(),
            line: 42,
        },
        wire_path: "id".to_string(),
        change: ChangeRecord {
            before: "string".to_string(),
            after: "number".to_string(),
        },
        typescript_client: TypeScriptClientRef {
            file: if has_caller {
                "src/client.ts".to_string()
            } else {
                String::new()
            },
            line: if has_caller { 10 } else { 0 },
            expectation: format!("{method} {path}"),
            expectation_kind: TsExpectationKind::TypeAssertion,
        },
        consumers: if has_caller {
            vec![ConsumerSite {
                file: "src/client.ts".to_string(),
                line: 10,
                column: Some(5),
                usage: "api.call()".to_string(),
            }]
        } else {
            Vec::new()
        },
        evidence: Vec::new(),
        repair_hint: "Migrate type".to_string(),
        id_v2: None,
        classification: None,
    }
}

fn make_report(
    findings: Vec<CrossLanguageFinding>,
    verdict: CrossLanguageVerdict,
) -> CrossLanguageImpactReport {
    CrossLanguageImpactReport {
        delta: None,
        schema_version: "SAJIMORA_IMPACT_REPORT_V1".to_string(),
        assurance: "CERTIFIED".to_string(),
        verdict,
        property: "COMPLIANCE".to_string(),
        verdict_scope: None,
        repository: SnapshotIdentity {
            repository_id: "org/service-repo".to_string(),
            parent_commit: "1111222233334444555566667777888899990000".to_string(),
            candidate_snapshot: "HEAD".to_string(),
        },
        scope: AnalysisScope {
            framework: "SPRING".to_string(),
            codec: "JACKSON".to_string(),
            client: "TYPESCRIPT".to_string(),
            complete: true,
        },
        completeness: None,
        reason_codes: Vec::new(),
        counts: AnalysisCounts {
            changed_endpoints: 10,
            linked_endpoints: findings.len(),
            affected_consumers: findings.len(),
            unresolved_links: 0,
            abstentions_by_code: None,
        },
        findings,
        blockers: Vec::new(),
        advisories: Vec::new(),
        artifacts: None,
        telemetry: None,
    }
}

#[test]
fn test_clean_report_admission_decision_is_clean() {
    let report = make_report(Vec::new(), CrossLanguageVerdict::LikelyPreserved);
    let traffic = HashMap::new();
    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "repo-1",
        "commit-a",
        "commit-b",
        PolicyMode::Strict,
    );
    assert_eq!(decision, AdmissionDecision::Clean);
}

#[test]
fn test_strict_mode_blocks_breaking_findings_regardless_of_waivers() {
    let finding = make_finding("DELETE", "/api/v1/stale", false);
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);
    let traffic = HashMap::new();
    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "repo-1",
        "commit-a",
        "commit-b",
        PolicyMode::Strict,
    );
    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert_eq!(reasons.len(), 1);
            assert!(reasons[0].reason.contains("STRICT"));
        }
        _ => panic!("Expected Blocked in Strict mode"),
    }
    // Verify non-weakening invariant: report verdict is untouched
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}

#[test]
fn test_active_callers_rejects_waiver() {
    let finding = make_finding("DELETE", "/api/v1/stale", true); // has static caller!
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);

    let mut traffic = HashMap::new();
    traffic.insert(
        "DELETE /api/v1/stale".to_string(),
        EndpointTrafficContext {
            http_method: "DELETE".to_string(),
            canonical_route: "/api/v1/stale".to_string(),
            is_certified: true,
            window_days: 90,
            is_zero_observed_certified: true,
            traffic_tier_label: "ZERO_OBSERVED".to_string(),
        },
    );

    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "repo-1",
        "commit-a",
        "commit-b",
        PolicyMode::WaiverLedger,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert!(reasons[0]
                .reason
                .contains("Active static frontend callers found"));
        }
        _ => panic!("Expected Blocked due to active static callers"),
    }
}

#[test]
fn test_tier_a_advisory_local_traffic_cannot_grant_waiver() {
    let finding = make_finding("DELETE", "/api/v1/stale", false);
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);

    let mut traffic = HashMap::new();
    traffic.insert(
        "DELETE /api/v1/stale".to_string(),
        EndpointTrafficContext {
            http_method: "DELETE".to_string(),
            canonical_route: "/api/v1/stale".to_string(),
            is_certified: false, // Tier A Local!
            window_days: 90,
            is_zero_observed_certified: false,
            traffic_tier_label: "ZERO_OBSERVED".to_string(),
        },
    );

    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "repo-1",
        "commit-a",
        "commit-b",
        PolicyMode::WaiverLedger,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert!(reasons[0].reason.contains("Tier A (advisory-local)"));
        }
        _ => panic!("Expected Blocked due to Tier A traffic"),
    }
}

#[test]
fn test_short_window_rejects_waiver() {
    let finding = make_finding("DELETE", "/api/v1/stale", false);
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);

    let mut traffic = HashMap::new();
    traffic.insert(
        "DELETE /api/v1/stale".to_string(),
        EndpointTrafficContext {
            http_method: "DELETE".to_string(),
            canonical_route: "/api/v1/stale".to_string(),
            is_certified: true,
            window_days: 30, // < 90 days!
            is_zero_observed_certified: true,
            traffic_tier_label: "ZERO_OBSERVED".to_string(),
        },
    );

    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "repo-1",
        "commit-a",
        "commit-b",
        PolicyMode::WaiverLedger,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert!(reasons[0]
                .reason
                .contains("minimum for 'DELETE /api/v1/stale'"));
        }
        _ => panic!("Expected Blocked due to short window"),
    }
}

#[test]
fn test_valid_certified_zero_traffic_and_signed_waiver_admitted() {
    let repo_id = "org/service-repo";
    let base_commit = "1111222233334444555566667777888899990000";
    let target_commit = "aaaabbbbccccddddeeeeffff0000111122223333";
    let method = "DELETE";
    let route = "/api/v1/stale";
    let approver_id = "lead.architect@enterprise.corp";
    let expires_at = "2029-12-31T23:59:59Z";
    let reason = "Endpoint sunsetted in PR #402 with certified 0 traffic.";

    // 1. Deterministic Ed25519 keypair for approver
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let verifying_key = signing_key.verifying_key();
    let public_key_pem = verifying_key.to_public_key_pem(LineEnding::LF).unwrap();

    let approvers = vec![WaiverApprover {
        approver_id: approver_id.to_string(),
        public_key_pem,
        allowed_scopes: vec!["methods/DELETE".to_string()],
        max_validity_days: 90,
    }];

    // 2. Sign canonical waiver payload
    let sign_payload = build_waiver_sign_payload(
        repo_id,
        base_commit,
        target_commit,
        "*",
        method,
        route,
        reason,
        expires_at,
        approver_id,
    );
    let signature = signing_key.sign(&sign_payload);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

    // 3. Build waiver ledger
    let ledger = WaiverLedger {
        schema_version: WAIVER_LEDGER_SCHEMA.to_string(),
        repository_id: repo_id.to_string(),
        waivers: vec![WaiverEntry {
            waiver_id: "WV-2026-001".to_string(),
            endpoint: WaiverEndpointScope {
                http_method: method.to_string(),
                route_template: route.to_string(),
                service_id: None,
            },
            base_commit: base_commit.to_string(),
            target_commit_prefix: target_commit[..8].to_string(),
            approved_by: approver_id.to_string(),
            approved_at: "2026-10-20T10:00:00Z".to_string(),
            approval_signature: sig_b64,
            reason: reason.to_string(),
            expires_at: expires_at.to_string(),
        }],
    };

    // 4. Certified Tier B telemetry with 0 observed traffic
    let mut traffic = HashMap::new();
    traffic.insert(
        format!("{method} {route}"),
        EndpointTrafficContext {
            http_method: method.to_string(),
            canonical_route: route.to_string(),
            is_certified: true,
            window_days: 90,
            is_zero_observed_certified: true,
            traffic_tier_label: "ZERO_OBSERVED".to_string(),
        },
    );

    let finding = make_finding(method, route, false);
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);

    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        Some(&ledger),
        &approvers,
        repo_id,
        base_commit,
        target_commit,
        PolicyMode::WaiverLedger,
    );

    match decision {
        AdmissionDecision::WaiverAdmitted {
            ref waivers_applied,
        } => {
            assert_eq!(waivers_applied.len(), 1);
            assert_eq!(waivers_applied[0].waiver_id, "WV-2026-001");
            assert_eq!(waivers_applied[0].approver_id, approver_id);
        }
        _ => panic!("Expected WaiverAdmitted, got {:?}", decision),
    }

    // 5. Verify non-weakening invariant & audit artifact
    let audit = build_admission_audit(
        repo_id,
        base_commit,
        target_commit,
        "LIKELY_VIOLATED",
        1,
        PolicyMode::WaiverLedger,
        &decision,
        None,
    );
    assert_eq!(audit.static_verdict, "LIKELY_VIOLATED");
    assert_eq!(audit.findings_count, 1);
    assert!(matches!(
        audit.admission_decision,
        AdmissionDecision::WaiverAdmitted { .. }
    ));
}

#[test]
fn test_expired_waiver_rejected() {
    let repo_id = "org/service-repo";
    let base_commit = "1111222233334444555566667777888899990000";
    let target_commit = "aaaabbbbccccddddeeeeffff0000111122223333";
    let method = "DELETE";
    let route = "/api/v1/stale";
    let approver_id = "lead.architect@enterprise.corp";
    let expires_at = "2020-01-01T00:00:00Z"; // EXPIRED!
    let reason = "Old waiver";

    let signing_key = SigningKey::from_bytes(&[8u8; 32]);
    let verifying_key = signing_key.verifying_key();
    let public_key_pem = verifying_key.to_public_key_pem(LineEnding::LF).unwrap();

    let approvers = vec![WaiverApprover {
        approver_id: approver_id.to_string(),
        public_key_pem,
        allowed_scopes: vec![],
        max_validity_days: 90,
    }];

    let sign_payload = build_waiver_sign_payload(
        repo_id,
        base_commit,
        target_commit,
        "*",
        method,
        route,
        reason,
        expires_at,
        approver_id,
    );
    let signature = signing_key.sign(&sign_payload);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

    let ledger = WaiverLedger {
        schema_version: WAIVER_LEDGER_SCHEMA.to_string(),
        repository_id: repo_id.to_string(),
        waivers: vec![WaiverEntry {
            waiver_id: "WV-EXPIRED".to_string(),
            endpoint: WaiverEndpointScope {
                http_method: method.to_string(),
                route_template: route.to_string(),
                service_id: None,
            },
            base_commit: base_commit.to_string(),
            target_commit_prefix: target_commit[..8].to_string(),
            approved_by: approver_id.to_string(),
            approved_at: "2019-12-01T00:00:00Z".to_string(),
            approval_signature: sig_b64,
            reason: reason.to_string(),
            expires_at: expires_at.to_string(),
        }],
    };

    let mut traffic = HashMap::new();
    traffic.insert(
        format!("{method} {route}"),
        EndpointTrafficContext {
            http_method: method.to_string(),
            canonical_route: route.to_string(),
            is_certified: true,
            window_days: 90,
            is_zero_observed_certified: true,
            traffic_tier_label: "ZERO_OBSERVED".to_string(),
        },
    );

    let finding = make_finding(method, route, false);
    let report = make_report(vec![finding], CrossLanguageVerdict::LikelyViolated);

    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        Some(&ledger),
        &approvers,
        repo_id,
        base_commit,
        target_commit,
        PolicyMode::WaiverLedger,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert!(reasons[0].reason.contains("expired"));
        }
        _ => panic!("Expected Blocked due to expired waiver"),
    }
}

#[test]
fn test_differential_ratchet_admits_clean_when_zero_new_findings_despite_legacy_debt() {
    let legacy_finding = make_finding("GET", "/api/v1/legacy", true);
    let mut report = make_report(
        vec![legacy_finding.clone()],
        CrossLanguageVerdict::LikelyViolated,
    );

    // Simulate brownfield repo: 1 legacy finding in baseline, 0 new findings in PR
    report.delta = Some(contract_core::report::FindingDelta {
        new_findings: vec![],
        existing_findings: vec![legacy_finding],
        resolved_findings: vec![],
    });

    let traffic = HashMap::new();
    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "thingsboard/thingsboard",
        "base_sha",
        "cand_sha",
        PolicyMode::Strict,
    );

    // Differential ratchet: 0 new breaking changes -> Admitted cleanly!
    assert!(
        matches!(decision, AdmissionDecision::Clean),
        "Expected Clean admission when delta.new_findings is empty"
    );
}

#[test]
fn test_differential_ratchet_blocks_when_new_findings_introduced() {
    let legacy_finding = make_finding("GET", "/api/v1/legacy", true);
    let new_finding = make_finding("POST", "/api/v1/broken", true);
    let mut report = make_report(
        vec![legacy_finding.clone(), new_finding.clone()],
        CrossLanguageVerdict::LikelyViolated,
    );

    report.delta = Some(contract_core::report::FindingDelta {
        new_findings: vec![new_finding],
        existing_findings: vec![legacy_finding],
        resolved_findings: vec![],
    });

    let traffic = HashMap::new();
    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "thingsboard/thingsboard",
        "base_sha",
        "cand_sha",
        PolicyMode::Strict,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert_eq!(reasons.len(), 1);
            assert!(reasons[0]
                .finding_summary
                .contains("1 breaking finding(s) detected"));
        }
        _ => panic!("Expected Blocked when new breaking findings exist"),
    }
}

#[test]
fn test_strict_baseline_blocks_on_legacy_debt() {
    let legacy_finding = make_finding("GET", "/api/v1/legacy", true);
    let mut report = make_report(
        vec![legacy_finding.clone()],
        CrossLanguageVerdict::LikelyViolated,
    );

    report.delta = Some(contract_core::report::FindingDelta {
        new_findings: vec![],
        existing_findings: vec![legacy_finding],
        resolved_findings: vec![],
    });

    let traffic = HashMap::new();
    let decision = evaluate_admission_policy(
        &report,
        &traffic,
        None,
        &[],
        "thingsboard/thingsboard",
        "base_sha",
        "cand_sha",
        PolicyMode::StrictBaseline,
    );

    match decision {
        AdmissionDecision::Blocked { reasons } => {
            assert!(reasons[0].reason.contains("Policy mode is STRICT"));
        }
        _ => panic!("Expected Blocked under StrictBaseline mode"),
    }
}
