//! discovery.rs — deterministic downstream consumer contract discovery.
//!
//! Precedence (MCP spec §2.1.3): committed/pinned targets, configured siblings,
//! ambient sibling scan, transport cache. Every step is absence-tolerant — a
//! location that does not exist contributes nothing rather than failing the
//! call — but a file that exists and cannot be admitted is reported, never
//! quietly dropped.
//!
//! The ambient sibling step needs a boundary: with no allowed root there is
//! nothing that can confine it, and a sibling project's contract would be
//! indistinguishable from evidence about this repository. Candidates are still
//! named in the rejections so the missing evidence is visible (see `Step C`).

use anyhow::Result;
use crate::provider::ProviderKind;
use contract_core::envelope::{parse_envelope, ContractArtifactEnvelope};
use contract_core::service::{
    read_bounded, validate_path_under_roots, DEFAULT_MAX_ARTIFACT_BYTES,
    MAX_AGGREGATE_ARTIFACT_BYTES,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const SELF_FRONTEND: &str = "A-committed";
pub const TARGETS_DIR: &str = "A-pinned";
pub const CONFIGURED_SIBLINGS: &str = "B-configured";
pub const AMBIENT_SIBLINGS: &str = "C-ambient";
pub const TRANSPORT_CACHE: &str = "D-cache";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredContract {
    pub step: &'static str,
    pub path: PathBuf,
    pub service_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedContract {
    pub path: PathBuf,
    pub step: &'static str,
    pub reason: String,
}

#[derive(Default)]
pub struct Discovery {
    pub contracts: Vec<(DiscoveredContract, ContractArtifactEnvelope)>,
    pub rejected: Vec<RejectedContract>,
}

impl Discovery {
    pub fn service_ids(&self) -> Vec<String> {
        self.contracts
            .iter()
            .map(|(entry, _)| entry.service_id.clone())
            .collect()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolyrepoSection {
    #[serde(default)]
    local_siblings: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SajimoraConfig {
    #[serde(default)]
    polyrepo: PolyrepoSection,
}

impl SajimoraConfig {
    pub fn local_siblings(&self) -> &[String] {
        &self.polyrepo.local_siblings
    }
}

/// Read `.sajimora/config.json`. Absent yields defaults; unparseable is an
/// error the caller reports as a blocker rather than a silent empty config.
pub fn load_config(sajimora_dir: &Path) -> Result<SajimoraConfig> {
    let path = sajimora_dir.join("config.json");
    if !path.exists() {
        return Ok(SajimoraConfig::default());
    }
    let bytes = read_bounded(&path, DEFAULT_MAX_ARTIFACT_BYTES)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| anyhow::anyhow!("invalid .sajimora/config.json: {e}"))
}

/// Discover consumer contracts for `repo_root`, confined to `allowed_roots`
/// when that list is non-empty.
pub fn discover(repo_root: &Path, allowed_roots: &[PathBuf]) -> Result<Discovery> {
    let sajimora = repo_root.join(".sajimora");
    let mut discovery = Discovery::default();
    let mut seen_paths: Vec<PathBuf> = Vec::new();
    let mut seen_digests: Vec<String> = Vec::new();
    let mut aggregate: usize = 0;

    // Step A: the repository's own committed consumer contract, then any
    // committed/pinned targets directory.
    let mut step_a: Vec<(PathBuf, &'static str)> = Vec::new();
    let own = sajimora.join("frontend-contract.json");
    if own.is_file() {
        step_a.push((own, SELF_FRONTEND));
    }
    step_a.extend(
        json_files_in(&sajimora.join("targets"))?
            .into_iter()
            .map(|path| (path, TARGETS_DIR)),
    );

    for (path, step) in step_a {
        admit(
            &path,
            step,
            allowed_roots,
            &mut discovery,
            &mut seen_paths,
            &mut seen_digests,
            &mut aggregate,
        )?;
    }

    // Step B: siblings named in .sajimora/config.json.
    let configured = match load_config(&sajimora) {
        Ok(config) => config.local_siblings().to_vec(),
        Err(error) => {
            discovery.rejected.push(RejectedContract {
                path: sajimora.join("config.json"),
                step: CONFIGURED_SIBLINGS,
                reason: error.to_string(),
            });
            Vec::new()
        }
    };
    for entry in configured {
        let sibling = if Path::new(&entry).is_absolute() {
            PathBuf::from(&entry)
        } else {
            repo_root.join(&entry)
        };
        admit(
            &sibling.join(".sajimora").join("frontend-contract.json"),
            CONFIGURED_SIBLINGS,
            allowed_roots,
            &mut discovery,
            &mut seen_paths,
            &mut seen_digests,
            &mut aggregate,
        )?;
    }

    // Step C: immediate sibling directories of the repository. Only a caller
    // that supplied an allowed root has a boundary this scan can be confined
    // to; without one, a sibling project is a different repository and its
    // contract is not evidence about this one. The candidates are still listed
    // as rejections so a skipped consumer is visible rather than silent.
    if let Some(parent) = repo_root.parent() {
        for path in sibling_contracts(parent, repo_root)? {
            if allowed_roots.is_empty() {
                // Do not name a contract that a preceding step already admitted
                // (an explicitly configured sibling, or the repository itself).
                let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
                if seen_paths.iter().any(|seen| seen == &resolved) {
                    continue;
                }
                discovery.rejected.push(RejectedContract {
                    path,
                    step: AMBIENT_SIBLINGS,
                    reason: "ambient sibling contract is outside the repository boundary; \
                             add it to .sajimora/config.json localSiblings or supply an allowed root"
                        .to_string(),
                });
                continue;
            }
            admit(
                &path,
                AMBIENT_SIBLINGS,
                allowed_roots,
                &mut discovery,
                &mut seen_paths,
                &mut seen_digests,
                &mut aggregate,
            )?;
        }
    }

    // Step D: envelopes populated by a previous transport fetch.
    for path in json_files_in(&sajimora.join("cache").join("contracts"))? {
        admit(
            &path,
            TRANSPORT_CACHE,
            allowed_roots,
            &mut discovery,
            &mut seen_paths,
            &mut seen_digests,
            &mut aggregate,
        )?;
    }

    Ok(discovery)
}

fn sibling_contracts(parent: &Path, repo_root: &Path) -> Result<Vec<PathBuf>> {
    // A drive root (e.g. "E:\" or "/") is not a workspace directory containing peer repos.
    if parent.parent().is_none() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    let mut names: Vec<String> = Vec::new();
    match fs::read_dir(parent) {
        Ok(entries) => {
            for item in entries.flatten() {
                if let Ok(name) = item.file_name().into_string() {
                    names.push(name);
                }
            }
        }
        Err(_) => return Ok(found),
    }
    names.sort();
    for name in names {
        // A symlinked sibling is not followed: it could point outside the
        // workspace regardless of what the roots check later observes.
        let dir = parent.join(&name);
        // The repository is not its own sibling; Step A owns its contract.
        if dir == repo_root {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let candidate = dir.join(".sajimora").join("frontend-contract.json");
        let Ok(file_metadata) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if file_metadata.is_file() {
            found.push(candidate);
        }
    }
    Ok(found)
}

fn json_files_in(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    if !dir.is_dir() {
        return Ok(found);
    }
    let mut names: Vec<String> = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            if let Ok(name) = item.file_name().into_string() {
                names.push(name);
            }
        }
    }
    names.sort();
    found.extend(names.into_iter().map(|name| dir.join(name)));
    Ok(found)
}

#[allow(clippy::too_many_arguments)]
fn admit(
    path: &Path,
    step: &'static str,
    allowed_roots: &[PathBuf],
    discovery: &mut Discovery,
    seen_paths: &mut Vec<PathBuf>,
    seen_digests: &mut Vec<String>,
    aggregate: &mut usize,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let confined = if allowed_roots.is_empty() {
        // No roots means no confinement policy, but the resolved path is still
        // the identity used to deduplicate a contract reached two ways.
        Ok(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
    } else {
        validate_path_under_roots(path, allowed_roots)
    };
    let canonical = match confined {
        Ok(canonical) => canonical,
        Err(error) => {
            discovery.rejected.push(RejectedContract {
                path: path.to_path_buf(),
                step,
                reason: error.to_string(),
            });
            return Ok(());
        }
    };
    if seen_paths.iter().any(|seen| seen == &canonical) {
        return Ok(());
    }

    let bytes = match read_bounded(path, DEFAULT_MAX_ARTIFACT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            discovery.rejected.push(RejectedContract {
                path: path.to_path_buf(),
                step,
                reason: error.to_string(),
            });
            return Ok(());
        }
    };
    *aggregate += bytes.len();
    if *aggregate > MAX_AGGREGATE_ARTIFACT_BYTES {
        discovery.rejected.push(RejectedContract {
            path: path.to_path_buf(),
            step,
            reason: format!(
                "aggregate consumer contract budget of {MAX_AGGREGATE_ARTIFACT_BYTES} bytes exceeded"
            ),
        });
        return Ok(());
    }

    let digest = hex::encode(Sha256::digest(&bytes));
    if seen_digests.iter().any(|seen| seen == &digest) {
        return Ok(());
    }

    let envelope = match parse_envelope(&bytes) {
        Ok(envelope) => envelope,
        Err(error) => {
            discovery.rejected.push(RejectedContract {
                path: path.to_path_buf(),
                step,
                reason: error.to_string(),
            });
            return Ok(());
        }
    };
    let service_id = envelope.snapshot.service_id.clone();
    seen_paths.push(canonical);
    seen_digests.push(digest.clone());
    discovery.contracts.push((
        DiscoveredContract {
            step,
            path: path.to_path_buf(),
            service_id,
            sha256: digest,
        },
        envelope,
    ));
    Ok(())
}

/// Present discovered contracts as JSON for the tool response.
pub fn provenance_json(discovery: &Discovery) -> Vec<Value> {
    discovery
        .contracts
        .iter()
        .map(|(entry, _)| {
            serde_json::json!({
                "path": entry.path.to_string_lossy(),
                "discoveryStep": entry.step,
                "serviceId": entry.service_id,
                "sha256": entry.sha256,
            })
        })
        .collect()
}

pub fn score_frontend_candidate(dir: &Path) -> u32 {
    if dir.join("package.json").exists() {
        let pkind = ProviderKind::detect_on_disk(dir);
        if pkind == ProviderKind::NestJs || pkind == ProviderKind::NextJs || pkind == ProviderKind::Express {
            return 0;
        }
    }
    let pkg_path = dir.join("package.json");
    let mut score = 1;

    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.contains("ui")
        || name.contains("frontend")
        || name.contains("client")
        || name.contains("web")
        || name.contains("spa")
    {
        score += 30;
    }

    if dir.join("tsconfig.json").exists() {
        score += 15;
    }

    if let Ok(content) = fs::read_to_string(&pkg_path) {
        let lower = content.to_lowercase();
        if lower.contains("@angular")
            || lower.contains("react")
            || lower.contains("vue")
            || lower.contains("svelte")
            || lower.contains("next")
            || lower.contains("vite")
            || lower.contains("nuxt")
        {
            score += 50;
        }
        if lower.contains("axios") || lower.contains("fetch") {
            score += 10;
        }
    }

    score
}

pub fn detect_frontend(repo_root: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    // Check top-level directories and nested project directories
    if let Ok(entries) = fs::read_dir(repo_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "build"
                    || name == "dist"
                {
                    continue;
                }

                if path.join("package.json").exists() {
                    let score = score_frontend_candidate(&path);
                    candidates.push((score, path.clone()));
                }

                // Check nested directories (e.g. apps/web, packages/client, ui/frontend)
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub in sub_entries.flatten() {
                        let sub_path = sub.path();
                        if sub_path.is_dir() {
                            let sub_name =
                                sub_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            if sub_name.starts_with('.')
                                || sub_name == "node_modules"
                                || sub_name == "target"
                                || sub_name == "dist"
                            {
                                continue;
                            }
                            if sub_path.join("package.json").exists() {
                                let score = score_frontend_candidate(&sub_path);
                                candidates.push((score, sub_path));
                            }
                        }
                    }
                }
            }
        }
    }

    // Also consider root itself if it has package.json and frontend markers
    if repo_root.join("package.json").exists() {
        let score = score_frontend_candidate(repo_root);
        if score > 30 {
            candidates.push((score, repo_root.to_path_buf()));
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, p)| p)
}

pub fn detect_frontend_changes(repo_root: &Path) -> bool {
    let is_frontend_input = |path: &str| -> bool {
        path.ends_with(".ts")
            || path.ends_with(".tsx")
            || path.ends_with(".js")
            || path.ends_with(".jsx")
            || path.ends_with(".html")
    };

    // 0. If a baseline frontend contract exists, check if HEAD has moved past its commit
    let fe_contract = repo_root.join(".sajimora/frontend-contract.json");
    if fe_contract.exists() {
        if let Ok(out) = std::process::Command::new("git")
            .args(["log", "-n", "1", "--format=%H", "--", ".sajimora/frontend-contract.json"])
            .current_dir(repo_root)
            .output()
        {
            if out.status.success() {
                let base_commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !base_commit.is_empty() {
                    if let Ok(diff_out) = std::process::Command::new("git")
                        .args(["diff", "--name-only", &base_commit, "HEAD"])
                        .current_dir(repo_root)
                        .output()
                    {
                        if diff_out.status.success() {
                            let stdout = String::from_utf8_lossy(&diff_out.stdout);
                            if stdout.lines().any(|l| is_frontend_input(l.trim())) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }

    // 1. Check working tree & staged modifications against HEAD
    if let Ok(out) = std::process::Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(repo_root)
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.lines().any(|l| is_frontend_input(l.trim())) {
                return true;
            }
        }
    }

    // 2. Check untracked files
    if let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_root)
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            return stdout.lines().any(|l| {
                let path = l.get(3..).unwrap_or("").trim();
                is_frontend_input(path)
            });
        }
    }
    false
}
