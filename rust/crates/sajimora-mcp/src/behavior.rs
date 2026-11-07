//! behavior.rs — MCP tool implementation for behavioral bisimulation equivalence checking.
//!
//! Catches calculation logic regressions across dual Git/file revisions.
//! Solves path conditions to produce formal equivalence proofs or cryptographic SHA-256 counterexample witnesses.

use anyhow::{bail, Context, Result};
use contract_core::service::validate_path_under_roots;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use verifier::bisim::{verify_method_behavior, BehaviorVerdict};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpVerifyBehaviorRequest {
    pub candidate: String,
    pub base: Option<String>,
    pub method: Option<String>,
    pub budget_ms: Option<u64>,
    pub strict: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorMcpResponse {
    pub target_file: String,
    pub target_method: String,
    pub base_revision: String,
    pub candidate_revision: String,
    pub verdict: BehaviorVerdict,
    pub is_strict_pass: bool,
    pub is_advisory_pass: bool,
}

pub fn run_verify_behavior(
    req: McpVerifyBehaviorRequest,
    allowed_roots: &[PathBuf],
) -> Result<BehaviorMcpResponse> {
    let cand_path = PathBuf::from(&req.candidate);

    if !allowed_roots.is_empty() {
        validate_path_under_roots(&cand_path, allowed_roots)?;
    }

    if !cand_path.exists() {
        bail!("Candidate file not found: {:?}", cand_path);
    }

    let cand_src = fs::read_to_string(&cand_path)
        .with_context(|| format!("Failed to read candidate file {:?}", cand_path))?;

    let base_label: String;
    let base_src = if let Some(ref base_file) = req.base {
        let base_path = PathBuf::from(base_file);
        if !allowed_roots.is_empty() {
            validate_path_under_roots(&base_path, allowed_roots)?;
        }
        if !base_path.exists() {
            bail!("Base file not found: {:?}", base_path);
        }
        base_label = base_file.clone();
        fs::read_to_string(&base_path)
            .with_context(|| format!("Failed to read base file {:?}", base_path))?
    } else {
        base_label = format!("HEAD:{}", req.candidate);
        match get_git_head_content(&req.candidate) {
            Some(s) => s,
            None => {
                bail!("Base file not specified and could not be retrieved from git HEAD. Use 'base' argument.");
            }
        }
    };

    let target_methods: Vec<String> = match req.method.as_deref() {
        Some(m) => vec![m.to_string()],
        None => {
            if let Ok(sigs) =
                source_index::signature_diff::extract_java_method_signatures(&cand_src)
            {
                let mut list = Vec::new();
                for s in sigs {
                    if !list.contains(&s.method_name) {
                        list.push(s.method_name);
                    }
                }
                if list.is_empty() {
                    bail!("No methods found in candidate file. Specify 'method' argument.");
                }
                list
            } else {
                bail!("Method name required. Specify 'method' argument.");
            }
        }
    };

    let budget = req.budget_ms.unwrap_or(50);
    let strict = req.strict.unwrap_or(false);

    // Verify all methods; if any fails, return that failing verdict
    let mut last_response = None;

    for target_method in &target_methods {
        let verdict = verify_method_behavior(
            &req.candidate,
            target_method,
            &base_src,
            &cand_src,
            &base_label,
            &req.candidate,
            budget,
        );

        let is_strict_pass = matches!(verdict, BehaviorVerdict::SoundProofOfEquivalence { .. });
        let is_advisory_pass = matches!(
            verdict,
            BehaviorVerdict::SoundProofOfEquivalence { .. }
                | BehaviorVerdict::LikelyEquivalentBounded { .. }
        );

        let resp = BehaviorMcpResponse {
            target_file: req.candidate.clone(),
            target_method: target_method.clone(),
            base_revision: base_label.clone(),
            candidate_revision: "candidate".to_string(),
            verdict,
            is_strict_pass,
            is_advisory_pass: if strict {
                is_strict_pass
            } else {
                is_advisory_pass
            },
        };

        if !resp.is_advisory_pass {
            return Ok(resp);
        }
        last_response = Some(resp);
    }

    Ok(last_response.unwrap())
}

fn get_git_head_content(rel_path: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["show", &format!("HEAD:{}", rel_path.replace('\\', "/"))])
        .output()
        .ok()?;
    if output.status.success() {
        String::from_utf8(output.stdout).ok()
    } else {
        None
    }
}
