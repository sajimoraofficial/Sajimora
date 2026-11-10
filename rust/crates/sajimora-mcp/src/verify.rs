//! verify.rs — the `sajimora_verify` repository-level gate.
//!
//! Resolves a provider revision inside a repository, discovers the downstream
//! consumer contracts available for cross-verification, and runs the same
//! comparison service as `sajimora check-contract`. Extraction never writes to
//! disk, so `stagedVsBaseline` and `commitRange` observe exactly the revision
//! they name.

use anyhow::{anyhow, Context, Result};
use contract_core::envelope::{parse_envelope, ArtifactKind, ContractArtifactEnvelope};
use contract_core::report::{
    make_error_report, make_inconclusive_report, AnalysisBlocker, BlockerCode,
    CrossLanguageImpactReport, CrossLanguageVerdict, SnapshotIdentity,
};
use contract_core::service::{
    read_bounded, run_check_contract_envelope_service, validate_path_under_roots,
    CheckContractEnvelopeRequest, DEFAULT_MAX_ARTIFACT_BYTES,
};
use serde_json::Value;
use source_index::discovery::{self, DiscoveredContract};
use source_index::revision::{self, BackendScope};
use std::path::{Path, PathBuf};

pub const VERDICT_SCOPE_NOTICE: &str =
    "Advisory findings, not scoped proofs. Verdicts describe contract compatibility of analyzed call sites, not runtime application behavior.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionMode {
    WorkingTree,
    Staged,
    CommitRange,
}

impl RevisionMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "workingTreeVsBaseline" => Ok(Self::WorkingTree),
            "stagedVsBaseline" => Ok(Self::Staged),
            "commitRange" => Ok(Self::CommitRange),
            other => Err(anyhow!(
                "Invalid revisionMode {other:?}: expected workingTreeVsBaseline, stagedVsBaseline or commitRange"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::WorkingTree => "workingTreeVsBaseline",
            Self::Staged => "stagedVsBaseline",
            Self::CommitRange => "commitRange",
        }
    }
}

#[derive(Debug)]
pub struct VerifyRequest {
    pub repo_root: PathBuf,
    pub target_services: Option<Vec<String>>,
    pub revision_mode: RevisionMode,
    pub commit_range: Option<String>,
    pub strict: bool,
}

pub struct Resolution {
    pub report: CrossLanguageImpactReport,
    pub revision: Value,
    pub consumers: Vec<DiscoveredContract>,
    pub rejected: Vec<Value>,
}

/// `sajimora init` writes `roots` in snake_case; accept the older camelCase
/// spelling too so a manifest from either writer is honoured instead of
/// silently falling back to the repository root.
fn manifest_root<'a>(roots: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    roots
        .get(snake)
        .or_else(|| roots.get(camel))
        .and_then(Value::as_str)
}

/// Split `parent..candidate`, rejecting the symmetric-diff form rather than
/// guessing which side the caller meant.
fn parse_commit_range(range: &str) -> Result<(String, String)> {
    let trimmed = range.trim();
    if trimmed.contains("...") {
        return Err(anyhow!(
            "Unsupported commitRange {range:?}: symmetric three-dot ranges are not accepted; give an explicit parent..candidate"
        ));
    }
    let (parent, candidate) = trimmed
        .split_once("..")
        .with_context(|| format!("commitRange {range:?} is not in parent..candidate form"))?;
    if parent.trim().is_empty() || candidate.trim().is_empty() {
        return Err(anyhow!("commitRange {range:?} has an empty endpoint"));
    }
    Ok((parent.trim().to_string(), candidate.trim().to_string()))
}

pub fn run(
    allowed_roots: &[PathBuf],
    trust_policy_path: Option<&Path>,
    trusted_local: bool,
    require_service_mapping: bool,
    request: VerifyRequest,
) -> Result<Resolution> {
    let repo_root = if allowed_roots.is_empty() {
        contract_core::service::normalize_path(&request.repo_root)
            .with_context(|| format!("Cannot resolve repoRoot {:?}", request.repo_root))?
    } else {
        validate_path_under_roots(&request.repo_root, allowed_roots).with_context(|| {
            format!(
                "repoRoot {:?} is outside the allowed roots",
                request.repo_root
            )
        })?
    };
    if !repo_root.is_dir() {
        return Err(anyhow!("repoRoot {:?} is not a directory", repo_root));
    }
    let sajimora = repo_root.join(".sajimora");

    // Provider identity and module root come from the init manifest. Its
    // baseline reference is the sealed provider contract: init never records a
    // commit, so the artifact digest is the only reproducible baseline handle.
    let manifest_path = sajimora.join("init-manifest.json");
    let manifest = read_bounded(&manifest_path, DEFAULT_MAX_ARTIFACT_BYTES)
        .map_err(|error| anyhow!("{manifest_path:?}: {error}"))
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|error| anyhow!("{manifest_path:?}: {error}"))
        });

    let unresolved = SnapshotIdentity {
        repository_id: format!("fs-root:{}", repo_root.to_string_lossy()),
        parent_commit: "UNRESOLVED".to_string(),
        candidate_snapshot: "UNRESOLVED".to_string(),
    };

    let manifest = match manifest {
        Ok(manifest) => manifest,
        Err(error) => {
            let report = make_error_report(
                unresolved,
                BlockerCode::ToolFailure,
                format!("{error}; run `sajimora init --apply` to establish a baseline snapshot"),
            );
            return Ok(Resolution {
                report,
                revision: serde_json::json!({ "revisionMode": request.revision_mode.label() }),
                consumers: vec![],
                rejected: vec![],
            });
        }
    };
    let mut service_id = manifest
        .get("roots")
        .and_then(|roots| manifest_root(roots, "service_id", "serviceId"))
        .unwrap_or("backend-service")
        .to_string();
    let backend_root = manifest
        .get("roots")
        .and_then(|roots| manifest_root(roots, "backend_root", "backendRoot"))
        .map(|value| value.replace('\\', "/"))
        .unwrap_or_default();

    // `sajimora init` records the backend root relative to the repository root,
    // which is also the base every git path listing is reported against here.
    let backend = BackendScope::new(&repo_root, &backend_root);
    let backend_prefix = &backend.prefix;
    if !backend.disk_root.is_dir() {
        return Err(anyhow!(
            "init manifest backend root {:?} does not exist under {:?}",
            backend_prefix,
            repo_root
        ));
    }

    let mut revision = serde_json::json!({
        "revisionMode": request.revision_mode.label(),
        "providerServiceId": service_id.clone(),
        "strict": request.strict,
        "backendRoot": if backend_prefix.is_empty() { "." } else { backend_prefix },
    });

    let base: ContractArtifactEnvelope;
    let candidate: ContractArtifactEnvelope;

    match request.revision_mode {
        RevisionMode::WorkingTree => {
            base = read_sealed(&sajimora.join("backend-contract.json"), &repo_root)?;
            // The sealed baseline names the producer; the manifest only locates
            // it. A drifted manifest must not rename the candidate's identity.
            service_id = base.snapshot.service_id.clone();
            candidate = revision::extract_working_tree(&repo_root, &backend, &service_id)?;
            revision["providerServiceId"] = service_id.clone().into();
            revision["baselineArtifact"] = base.snapshot.candidate_snapshot.clone().into();
        }
        RevisionMode::Staged => {
            base = read_sealed(&sajimora.join("backend-contract.json"), &repo_root)?;
            service_id = base.snapshot.service_id.clone();
            let head = git_or_fail(&repo_root, "stagedVsBaseline")?;
            let (envelope, token) =
                revision::extract_staged(&repo_root, &backend, &service_id, &head)?;
            candidate = envelope;
            revision["providerServiceId"] = service_id.clone().into();
            revision["headCommit"] = head.into();
            revision["stagedIdentity"] = format!("staged:{token}").into();
            revision["baselineArtifact"] = base.snapshot.candidate_snapshot.clone().into();
        }
        RevisionMode::CommitRange => {
            let range = request
                .commit_range
                .as_deref()
                .context("commitRange is required when revisionMode is commitRange")?;
            let (parent, child) = parse_commit_range(range)?;
            let git_repo = git_or_fail(&repo_root, "commitRange")?;
            let parent_sha = revision::resolve_commit(&repo_root, &parent)?;
            let child_sha = revision::resolve_commit(&repo_root, &child)?;
            base = revision::extract_tree(
                &repo_root,
                &backend,
                &service_id,
                &parent_sha,
                &parent_sha,
            )?;
            candidate =
                revision::extract_tree(&repo_root, &backend, &service_id, &child_sha, &parent_sha)?;
            revision["toplevel"] = git_repo.into();
            revision["parentCommit"] = parent_sha.into();
            revision["candidateCommit"] = child_sha.into();
        }
    }

    let mut found = discovery::discover(&repo_root, allowed_roots)?;
    if let Some(wanted) = request.target_services.as_ref() {
        found
            .contracts
            .retain(|(entry, _)| wanted.iter().any(|name| name == &entry.service_id));
    }

    // Invariant (§2.1.3): with no consumer evidence the gate abstains. A
    // preserved verdict requires at least one downstream call site.
    if found.contracts.is_empty() {
        let report = make_inconclusive_report(
            SnapshotIdentity {
                repository_id: candidate.snapshot.repository_id.clone(),
                parent_commit: candidate.snapshot.parent_commit.clone(),
                candidate_snapshot: candidate.snapshot.candidate_snapshot.clone(),
            },
            vec![AnalysisBlocker {
                code: BlockerCode::NoConsumerContracts,
                message: "No downstream consumer contract was discovered in the committed targets, configured siblings, ambient siblings or transport cache; cross-verification of consumer call sites is impossible.".to_string(),
                file: Some(".sajimora/frontend-contract.json".to_string()),
            }],
        );
        return Ok(Resolution {
            report,
            revision,
            consumers: vec![],
            rejected: found
                .rejected
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "path": entry.path.to_string_lossy(),
                        "discoveryStep": entry.step,
                        "reason": entry.reason,
                    })
                })
                .collect(),
        });
    }

    let consumers: Vec<DiscoveredContract> = found
        .contracts
        .iter()
        .map(|(entry, _)| entry.clone())
        .collect();
    let mut targets: Vec<ContractArtifactEnvelope> = found
        .contracts
        .iter()
        .map(|(_, envelope)| envelope.clone())
        .collect();
    let rejected: Vec<Value> = found
        .rejected
        .iter()
        .map(|entry| {
            serde_json::json!({
                "path": entry.path.to_string_lossy(),
                "discoveryStep": entry.step,
                "reason": entry.reason,
            })
        })
        .collect();

    let mut base_targets: Option<Vec<ContractArtifactEnvelope>> = None;

    if request.revision_mode != RevisionMode::CommitRange && discovery::detect_frontend_changes(&repo_root) {
        let fe_dir_opt = manifest
            .get("roots")
            .and_then(|roots| manifest_root(roots, "frontend_root", "frontendRoot"))
            .map(|value| repo_root.join(value.replace('\\', "/")))
            .filter(|p| p.is_dir())
            .or_else(|| discovery::detect_frontend(&repo_root));

        if let Some(fe_dir) = fe_dir_opt {
            let fe_service_id = targets
                .iter()
                .find(|t| t.kind == ArtifactKind::FrontendContract)
                .map(|t| t.snapshot.service_id.clone())
                .unwrap_or_else(|| {
                    std::fs::read_to_string(fe_dir.join("package.json"))
                        .ok()
                        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(ToString::to_string))
                        .unwrap_or_else(|| "frontend-service".to_string())
                });

            if let Ok(cand_envelope) = source_index::ts_routes::extract_frontend_envelope(
                &repo_root,
                &fe_dir,
                &fe_service_id,
                &service_id,
                "HEAD",
            ) {
                base_targets = Some(targets.clone());
                let single_target = targets.len() == 1;
                let mut replaced = false;
                for t in targets.iter_mut() {
                    if t.kind == ArtifactKind::FrontendContract
                        && (t.snapshot.service_id == fe_service_id || single_target)
                    {
                        *t = cand_envelope.clone();
                        replaced = true;
                        break;
                    }
                }
                if !replaced {
                    targets.push(cand_envelope);
                }
            }
        }
    }

    let report = run_check_contract_envelope_service(CheckContractEnvelopeRequest {
        base,
        candidate,
        targets,
        base_targets,
        trust_policy_path: trust_policy_path.map(Path::to_path_buf),
        trusted_local,
        require_service_mapping,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    })?;

    Ok(Resolution {
        report,
        revision,
        consumers,
        rejected,
    })
}

/// A repository without git cannot answer questions about the index or about
/// commits; say so instead of silently falling back to the working tree.
fn git_or_fail(repo_root: &Path, mode: &str) -> Result<String> {
    revision::toplevel(repo_root)
        .map(|toplevel| toplevel.to_string_lossy().replace('\\', "/"))
        .map_err(|error| {
            anyhow!("{mode} requires a Git repository and revision resolution failed: {error}")
        })
}

fn read_sealed(path: &Path, repo_root: &Path) -> Result<ContractArtifactEnvelope> {
    let bytes = read_bounded(path, DEFAULT_MAX_ARTIFACT_BYTES).map_err(|error| {
        anyhow!(
            "{path:?}: {error}; run `sajimora init --apply` in {:?} to establish a baseline provider contract",
            repo_root
        )
    })?;
    parse_envelope(&bytes).map_err(|error| anyhow!("{path:?}: {error}"))
}

pub fn is_blocking(report: &CrossLanguageImpactReport, strict: bool) -> bool {
    match report.verdict {
        CrossLanguageVerdict::LikelyViolated => true,
        CrossLanguageVerdict::Inconclusive | CrossLanguageVerdict::AnalysisError => strict,
        CrossLanguageVerdict::LikelyPreserved => false,
    }
}
