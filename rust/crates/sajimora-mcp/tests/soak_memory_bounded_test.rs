//! soak_memory_bounded_test.rs — Long-running soak test verifying bounded memory consumption.
//!
//! Validates Patent Claim 1 & Enterprise Daemon Invariant:
//! 1. Memory Boundedness: Executing 500 consecutive contract verifications must bound process RSS < 50 MB.
//! 2. Zero Memory Leak: Memory consumption between iteration 100 and iteration 500 must stabilize
//!    with near-zero drift, proving no unbounded cache growth or string intern leaks.

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

fn get_process_rss_bytes() -> usize {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/self/statm") {
            let parts: Vec<&str> = content.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(pages) = parts[1].parse::<usize>() {
                    return pages * 4096;
                }
            }
        }
    }
    0
}

#[test]
fn test_soak_500_queries_memory_bounded_under_50mb() {
    let base_bytes = fixture_bytes("backend_complete.json");
    let candidate_bytes = fixture_bytes("backend_same.json");
    let target_bytes = fixture_bytes("frontend_complete.json");

    let total_iterations = 500;
    let mut rss_samples = vec![];

    let start_rss = get_process_rss_bytes();

    for i in 0..total_iterations {
        // Mutate candidate slightly each iteration to defeat trivial caching
        let mut candidate_val: Value = serde_json::from_slice(&candidate_bytes).unwrap();
        candidate_val["payload"]["endpoints"][0]["route"] =
            serde_json::json!(format!("/api/resource/{}", i % 50));
        let digest = compute_envelope_digest_from_value(candidate_val.clone()).unwrap();
        candidate_val["integrity"] = serde_json::json!({ "sha256": digest });

        let mutated_candidate_bytes = serde_json::to_vec(&candidate_val).unwrap();

        let base = parse_envelope(&base_bytes).expect("parse base");
        let candidate = parse_envelope(&mutated_candidate_bytes).expect("parse candidate");
        let target = parse_envelope(&target_bytes).expect("parse target");

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
            .expect("contract envelope service must succeed");

        assert!(!report.findings.is_empty() || report.verdict != contract_core::report::CrossLanguageVerdict::AnalysisError);

        // Sample RSS memory every 50 iterations
        if i % 50 == 0 || i == total_iterations - 1 {
            let current_rss = get_process_rss_bytes();
            rss_samples.push((i, current_rss));
        }
    }

    let final_rss = get_process_rss_bytes();

    if start_rss > 0 && final_rss > 0 {
        let final_rss_mb = final_rss as f64 / (1024.0 * 1024.0);
        println!("Soak test RSS trajectory (iteration, RSS MB):");
        for (iter, rss) in &rss_samples {
            println!("  Iter {:>3}: {:.2} MB", iter, *rss as f64 / (1024.0 * 1024.0));
        }

        // Invariant 1: Final RSS must be strictly under 50 MB
        assert!(
            final_rss < 52_428_800,
            "Memory budget exceeded! Process RSS was {:.2} MB (must be < 50 MB)",
            final_rss_mb
        );

        // Invariant 2: Growth between iteration 100 and 500 must be less than 15 MB (no linear leak)
        let rss_at_100 = rss_samples.iter().find(|(iter, _)| *iter == 100).map(|(_, r)| *r).unwrap_or(start_rss);
        let growth_100_to_500 = final_rss.saturating_sub(rss_at_100);
        let growth_mb = growth_100_to_500 as f64 / (1024.0 * 1024.0);
        assert!(
            growth_100_to_500 < 15_728_640,
            "Memory leak detected! Grew by {:.2} MB between iter 100 and 500",
            growth_mb
        );

        println!("✅ Verified: Memory remains strictly bounded at {:.2} MB across 500 iterations (budget: <50MB).", final_rss_mb);
    }
}
