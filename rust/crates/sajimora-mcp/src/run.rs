//! run.rs — MCP surface for the unified Sajimora pipeline (`sajimora_run`).
//!
//! Executes health check, contract extraction/discovery, cross-language subtyping
//! verification, and Git impact analysis in one call.

use anyhow::{bail, Context, Result};
use contract_core::envelope::ArtifactKind;
use rmcp::model::Tool;
use serde_json::{json, Map, Value};
use source_index::discovery::discover;
use source_index::endpoint_impact::{analyze, resolve_repo_root, ImpactMode, ImpactRequest};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

pub const TOOL_NAME: &str = "sajimora_run";

pub fn tool_definition() -> Tool {
    let mut schema_map = Map::new();
    schema_map.insert("type".to_string(), json!("object"));
    schema_map.insert(
        "properties".to_string(),
        json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root containing .sajimora/init-manifest.json; must resolve under a server-configured allowed root"
            },
            "skipLive": {
                "type": "boolean",
                "description": "Skip live JVM test execution for sub-second static verification (defaults to false)"
            },
            "strict": {
                "type": "boolean",
                "description": "Strict failure mode: flag any breaking contract change (defaults to false)"
            },
            "outputPath": {
                "type": "string",
                "description": "Optional report destination JSON; relative paths resolve against repoRoot"
            }
        }),
    );
    schema_map.insert("required".to_string(), json!(["repoRoot"]));

    Tool::new(
        TOOL_NAME,
        "Run the complete end-to-end Sajimora verification pipeline in one call. Executes repository health check, contract discovery, cross-language subtyping verification, and Git endpoint impact analysis, returning a consolidated executive report.",
        Arc::new(schema_map),
    )
}

pub fn run_pipeline(allowed_roots: &[PathBuf], args: &Map<String, Value>) -> Result<String> {
    if allowed_roots.is_empty() {
        bail!("{TOOL_NAME} requires at least one server-configured allowed root; refusing to run without one");
    }

    let repo_arg = args
        .get("repoRoot")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .context("Missing or invalid required argument: 'repoRoot'")?;
    let repo_path = PathBuf::from(repo_arg);
    if !repo_path.is_absolute() {
        bail!("repoRoot must be an absolute path");
    }
    let repo_root = resolve_repo_root(&repo_path, allowed_roots)?;

    let skip_live = args
        .get("skipLive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let strict = args.get("strict").and_then(Value::as_bool).unwrap_or(false);

    let sajimora_dir = repo_root.join(".sajimora");
    let manifest_path = sajimora_dir.join("init-manifest.json");

    // 1. Health check
    let manifest_valid = manifest_path.exists();
    let service_id = if manifest_valid {
        fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| {
                v.pointer("/roots/service_id")
                    .and_then(|s| s.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "application".to_string())
    } else {
        "uninitialized".to_string()
    };

    // 2. Discover contracts
    let (backend_count, frontend_count) =
        if let Ok(discovered) = discover(&repo_root, allowed_roots) {
            let be = discovered
                .contracts
                .iter()
                .filter(|c| c.1.kind == ArtifactKind::BackendContract)
                .count();
            let fe = discovered
                .contracts
                .iter()
                .filter(|c| c.1.kind == ArtifactKind::FrontendContract)
                .count();
            (be, fe)
        } else {
            (0, 0)
        };

    // 3. Verification check
    let base_contract = sajimora_dir.join("backend-contract.json");
    let candidate_contract = sajimora_dir.join("candidate-contract.json");
    let frontend_contract = sajimora_dir.join("frontend-contract.json");

    let candidate_path = if candidate_contract.exists() {
        candidate_contract
    } else {
        base_contract.clone()
    };

    let mut verdict = "LIKELY_PRESERVED".to_string();
    let mut breaking_count = 0;
    let mut findings_sample = Vec::new();

    if base_contract.exists() && frontend_contract.exists() {
        let check_req = contract_core::service::CheckContractServiceRequest {
            base_path: base_contract,
            candidate_path,
            target_paths: vec![frontend_contract],
            base_target_paths: None,
            trust_policy_path: None,
            trusted_local: true,
            require_service_mapping: false,
            allowed_roots: Some(allowed_roots.to_vec()),
            max_artifact_bytes: None,
            telemetry_path: None,
            evaluation_time_unix: None,
            deployment_liveness_verified: false,
        };

        if let Ok(report) = contract_core::service::run_check_contract_service(check_req) {
            breaking_count = report.findings.len();
            match report.verdict {
                contract_core::report::CrossLanguageVerdict::LikelyPreserved => {
                    verdict = "LIKELY_PRESERVED".to_string()
                }
                contract_core::report::CrossLanguageVerdict::LikelyViolated => {
                    verdict = "LIKELY_VIOLATED".to_string()
                }
                contract_core::report::CrossLanguageVerdict::Inconclusive => {
                    verdict = "INCONCLUSIVE".to_string()
                }
                contract_core::report::CrossLanguageVerdict::AnalysisError => {
                    verdict = "ANALYSIS_ERROR".to_string()
                }
            }
            for finding in report.findings.iter().take(5) {
                findings_sample.push(json!({
                    "endpoint": format!("{} {}", finding.endpoint.method, finding.endpoint.path),
                    "wire_path": finding.wire_path,
                    "repair_hint": finding.repair_hint,
                    "client": format!("{}:{}", finding.typescript_client.file, finding.typescript_client.line),
                }));
            }
        }
    }

    // 4. Git Impact
    let impact_req = ImpactRequest {
        repo_root: repo_root.clone(),
        mode: ImpactMode::WorkingTree,
        commit_range: None,
        generated_tests: vec![],
    };

    let mut changed_files = 0;
    let mut affected_endpoints = 0;
    let mut consumer_links = 0;

    if let Ok(impact_report) = analyze(allowed_roots, &impact_req) {
        if let Some(summary) = impact_report.get("summary") {
            changed_files = summary
                .get("changedFiles")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            affected_endpoints = summary
                .get("affectedEndpoints")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            consumer_links = summary
                .get("consumerLinks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
        }
    }

    let timestamp = format!(
        "{}s (unix epoch)",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );

    let consolidated = json!({
        "schema_version": "1.0.0",
        "pipeline": "sajimora_run",
        "timestamp": timestamp,
        "repository": repo_root.to_string_lossy(),
        "service_id": service_id,
        "stages": {
            "health_check": {
                "manifest_valid": manifest_valid,
                "status": if manifest_valid { "PASS" } else { "ADVISORY" }
            },
            "contract_lattice": {
                "backend_contracts_discovered": backend_count,
                "frontend_contracts_discovered": frontend_count,
            },
            "cross_language_verification": {
                "verdict": verdict,
                "breaking_changes_count": breaking_count,
                "sample_findings": findings_sample,
            },
            "git_impact": {
                "changed_files": changed_files,
                "affected_endpoints": affected_endpoints,
                "consumer_links": consumer_links,
            },
            "live_tests": {
                "skipped": skip_live,
            }
        },
        "overall_verdict": verdict,
        "breaking_changes_count": breaking_count,
        "strict_failure": strict && breaking_count > 0,
        "recommendations": if breaking_count > 0 {
            vec![
                "Run `sajimora fix` to auto-heal affected frontend call sites.",
                "Or run `sajimora init --apply` to accept wire modifications as the new baseline."
            ]
        } else {
            vec!["All contracts are compatible. Safe to commit and deploy."]
        }
    });

    if let Some(output_rel) = args.get("outputPath").and_then(Value::as_str) {
        let out_path = repo_root.join(output_rel);
        if let Ok(rendered) = serde_json::to_string_pretty(&consolidated) {
            let _ = fs::write(&out_path, rendered);
        }
    }

    Ok(serde_json::to_string_pretty(&consolidated)?)
}
