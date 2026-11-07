//! freshness_gate.rs — Spec §2: calendar TTL is an auditable admission-gate
//! policy limit, never a pure-evaluator behavior.
//!
//! Matrix under test:
//! 1. No evaluation_time supplied -> no freshness gate runs, verdict unchanged
//!    (byte-identical-output invariant).
//! 2. Age exceeds maxContractAgeDays -> ContractAgeThresholdExceeded advisory
//!    + LIKELY_PRESERVED withheld (downgraded to INCONCLUSIVE).
//! 3. Same breach with a deployment-liveness refresh -> advisory present but
//!    LIKELY_PRESERVED kept.
//! 4. Age within threshold -> clean LIKELY_PRESERVED, no advisories.
//! 5. Exactly at the threshold -> not exceeded (strictly-greater rule).

use contract_core::advisory::EvidenceAdvisory;
use contract_core::envelope::compute_envelope_digest_from_value;
use contract_core::report::CrossLanguageVerdict;
use contract_core::service::{run_check_contract_service, CheckContractServiceRequest};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const DAY: u64 = 86_400;
const EVAL_NOW: u64 = 1_800_000_000;
const ISSUED_AT: u64 = EVAL_NOW - 40 * DAY; // 40 days old at evaluation time

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes")
        .join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// Stamp optional `issuedAtUnix` first, then seal the canonical digest over
/// the stamped envelope and pin the resulting digest.
fn sealed_with_issued(mut value: Value, issued_at_unix: Option<u64>) -> (Value, String) {
    if let Some(issued) = issued_at_unix {
        value["issuedAtUnix"] = json!(issued);
    }
    let digest = compute_envelope_digest_from_value(value.clone()).unwrap();
    value["integrity"] = json!({ "sha256": digest });
    (value, digest)
}

fn write_json(dir: &Path, filename: &str, value: &Value) -> PathBuf {
    let path = dir.join(filename);
    std::fs::write(&path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    path
}

struct Bench {
    _dir: PathBuf,
    base_path: PathBuf,
    candidate_path: PathBuf,
    target_path: PathBuf,
    policy_path: PathBuf,
}

fn setup(dir_name: &str) -> Bench {
    let dir = std::env::temp_dir().join(format!(
        "sajimora-fresh-{}-{}",
        dir_name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (base, base_digest) = sealed_with_issued(fixture("backend_same"), None);
    let (candidate, cand_digest) = sealed_with_issued(fixture("backend_same"), Some(ISSUED_AT));
    let (target, target_digest) = sealed_with_issued(fixture("frontend_complete"), None);

    // Pin each artifact's digest so admission passes without signatures.
    // Base and candidate share one identity, so group digests by producer.
    let mut pin_map: Vec<(Value, Value, Vec<String>)> = Vec::new();
    for (artifact, digest) in [
        (&base, base_digest),
        (&candidate, cand_digest),
        (&target, target_digest),
    ] {
        let repo = artifact["snapshot"]["repositoryId"].clone();
        let service = artifact["snapshot"]["serviceId"].clone();
        match pin_map
            .iter_mut()
            .find(|(r, s, _)| *r == repo && *s == service)
        {
            Some(entry) => entry.2.push(digest),
            None => pin_map.push((repo, service, vec![digest])),
        }
    }
    let producers: Vec<Value> = pin_map
        .into_iter()
        .map(|(repo, service, digests)| {
            json!({ "repositoryId": repo, "serviceId": service, "trustedDigests": digests })
        })
        .collect();
    let policy = json!({
        "producers": producers,
        "requireSignatures": false,
        "maxContractAgeDays": 30
    });

    Bench {
        base_path: write_json(&dir, "base.json", &base),
        candidate_path: write_json(&dir, "candidate.json", &candidate),
        target_path: write_json(&dir, "target.json", &target),
        policy_path: write_json(&dir, "trust-policy.json", &policy),
        _dir: dir,
    }
}

fn run(
    bench: &Bench,
    evaluation_time_unix: Option<u64>,
    liveness: bool,
) -> contract_core::report::CrossLanguageImpactReport {
    run_check_contract_service(CheckContractServiceRequest {
        base_path: bench.base_path.clone(),
        candidate_path: bench.candidate_path.clone(),
        target_paths: vec![bench.target_path.clone()],
        trust_policy_path: Some(bench.policy_path.clone()),
        trusted_local: false,
        require_service_mapping: true,
        allowed_roots: None,
        max_artifact_bytes: None,
        telemetry_path: None,
        evaluation_time_unix,
        deployment_liveness_verified: liveness,
    })
    .unwrap()
}

#[test]
fn freshness_gate_matrix() {
    let bench = setup("matrix");

    // Baseline: no evaluation time -> no freshness gate, advisory-free.
    let baseline = run(&bench, None, false);
    assert_eq!(
        baseline.verdict,
        CrossLanguageVerdict::LikelyPreserved,
        "unexpected baseline verdict; blockers: {:?}",
        baseline.blockers
    );
    assert!(baseline.advisories.is_empty());

    // 40-day-old artifact against a 30-day limit: advisory + abstention.
    let stale = run(&bench, Some(EVAL_NOW), false);
    assert_eq!(stale.verdict, CrossLanguageVerdict::Inconclusive);
    assert_eq!(stale.advisories.len(), 1);
    assert!(matches!(
        &stale.advisories[0],
        EvidenceAdvisory::ContractAgeThresholdExceeded {
            age_days: 40,
            threshold_days: 30,
            refreshed_by_deployment_record: false,
            ..
        }
    ));

    // Same breach with a verified deployment liveness record: advisory is
    // recorded but LIKELY_PRESERVED is not withheld.
    let refreshed = run(&bench, Some(EVAL_NOW), true);
    assert_eq!(refreshed.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert_eq!(refreshed.advisories.len(), 1);
    assert!(matches!(
        &refreshed.advisories[0],
        EvidenceAdvisory::ContractAgeThresholdExceeded {
            refreshed_by_deployment_record: true,
            ..
        }
    ));

    // Within the threshold (29 days old at evaluation): clean pass, no advisory.
    let fresh = run(&bench, Some(EVAL_NOW - 11 * DAY), false);
    assert_eq!(fresh.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert!(fresh.advisories.is_empty());

    // Exactly at the threshold (30 days) is not "exceeded".
    let boundary = run(&bench, Some(EVAL_NOW - 10 * DAY), false);
    assert_eq!(boundary.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert!(boundary.advisories.is_empty());
}
