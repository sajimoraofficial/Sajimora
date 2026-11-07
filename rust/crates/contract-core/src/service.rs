//! service.rs — Shared service function for artifact check operations.
//!
//! Shared between sajimora-cli and sajimora-mcp to ensure identical
//! admission rules, defaults, size bounds, and error reporting.

use std::fs;
use std::path::{Path, PathBuf};

use crate::admission::ArtifactTrustPolicy;
use crate::comparison::check_contract_refs;
use crate::envelope::{parse_envelope, ContractArtifactEnvelope};
use crate::report::{CrossLanguageImpactReport, CrossLanguageVerdict};
use anyhow::{anyhow, bail, Context, Result};

pub const DEFAULT_MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024; // 64 MiB; aggregate budget remains enforced
pub const MAX_AGGREGATE_ARTIFACT_BYTES: usize = 100 * 1024 * 1024; // 100 MB aggregate budget

/// Same evaluation as [`CheckContractServiceRequest`], but the envelopes are
/// supplied by the caller instead of read from paths. Used when a revision is
/// extracted from Git objects, where no file on disk holds the candidate.
#[derive(Debug, Clone)]
pub struct CheckContractEnvelopeRequest {
    pub base: ContractArtifactEnvelope,
    pub candidate: ContractArtifactEnvelope,
    pub targets: Vec<ContractArtifactEnvelope>,
    pub trust_policy_path: Option<PathBuf>,
    pub trusted_local: bool,
    pub require_service_mapping: bool,
    /// Parsed telemetry artifact value, when the caller supplied one.
    pub telemetry: Option<serde_json::Value>,
    pub evaluation_time_unix: Option<u64>,
    pub deployment_liveness_verified: bool,
    pub max_artifact_bytes: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct CheckContractServiceRequest {
    pub base_path: PathBuf,
    pub candidate_path: PathBuf,
    pub target_paths: Vec<PathBuf>,
    pub trust_policy_path: Option<PathBuf>,
    pub trusted_local: bool,
    pub require_service_mapping: bool,
    pub allowed_roots: Option<Vec<PathBuf>>,
    pub max_artifact_bytes: Option<usize>,
    pub telemetry_path: Option<PathBuf>,
    /// Explicit evaluation instant (Unix seconds) for calendar-freshness
    /// checks (spec §2). When `None` no freshness gate runs and output is
    /// byte-identical across runs; the gate never reads the wall clock.
    pub evaluation_time_unix: Option<u64>,
    /// True when a caller-verified deployment liveness record refreshed the
    /// candidate (e.g. the replay gate passed against a deployment state
    /// ledger). Suppresses the LIKELY_PRESERVED withholding for
    /// `maxContractAgeDays` breaches (spec §2).
    pub deployment_liveness_verified: bool,
}

pub fn run_check_contract_service(
    req: CheckContractServiceRequest,
) -> Result<CrossLanguageImpactReport> {
    let max_bytes = req.max_artifact_bytes.unwrap_or(DEFAULT_MAX_ARTIFACT_BYTES);

    // 1. Validate paths against allowed_roots if specified, capturing canonical paths
    let (base_path, candidate_path, target_paths, trust_policy_path, telemetry_path) =
        if let Some(ref allowed_roots) = req.allowed_roots {
            if !allowed_roots.is_empty() {
                let base = validate_path_under_roots(&req.base_path, allowed_roots)?;
                let cand = validate_path_under_roots(&req.candidate_path, allowed_roots)?;
                let mut targets = Vec::with_capacity(req.target_paths.len());
                for target in &req.target_paths {
                    targets.push(validate_path_under_roots(target, allowed_roots)?);
                }
                let tp = if let Some(ref tp_path) = req.trust_policy_path {
                    Some(validate_path_under_roots(tp_path, allowed_roots)?)
                } else {
                    None
                };
                // Telemetry is an input like any other artifact: it is read from
                // disk, so it is confined to the same roots.
                let telemetry = match req.telemetry_path {
                    Some(ref tel_path) if tel_path.as_os_str().is_empty() => None,
                    Some(ref tel_path) => Some(validate_path_under_roots(tel_path, allowed_roots)?),
                    None => None,
                };
                (base, cand, targets, tp, telemetry)
            } else {
                (
                    req.base_path,
                    req.candidate_path,
                    req.target_paths,
                    req.trust_policy_path,
                    req.telemetry_path,
                )
            }
        } else {
            (
                req.base_path,
                req.candidate_path,
                req.target_paths,
                req.trust_policy_path,
                req.telemetry_path,
            )
        };

    // 2. Validate input bounds
    if target_paths.is_empty() {
        bail!("At least one target contract artifact must be specified");
    }
    if target_paths.len() > 64 {
        bail!("Too many target artifacts (maximum 64 allowed)");
    }

    let mut total_bytes: usize = 0;

    // 3. Read and parse envelopes
    let base_bytes = read_bounded(&base_path, max_bytes)
        .with_context(|| format!("Reading base artifact {:?}", base_path))?;
    total_bytes += base_bytes.len();
    let mut base =
        parse_envelope(&base_bytes).map_err(|e| anyhow!("Base artifact {:?}: {}", base_path, e))?;

    let candidate_bytes = read_bounded(&candidate_path, max_bytes)
        .with_context(|| format!("Reading candidate artifact {:?}", candidate_path))?;
    total_bytes += candidate_bytes.len();
    let mut candidate = parse_envelope(&candidate_bytes)
        .map_err(|e| anyhow!("Candidate artifact {:?}: {}", candidate_path, e))?;

    let mut targets = Vec::with_capacity(target_paths.len());
    for target_path in &target_paths {
        let target_bytes = read_bounded(target_path, max_bytes)
            .with_context(|| format!("Reading target artifact {:?}", target_path))?;
        total_bytes += target_bytes.len();
        if total_bytes > MAX_AGGREGATE_ARTIFACT_BYTES {
            bail!(
                "Aggregate artifact size exceeded budget of {} bytes (read {} bytes)",
                MAX_AGGREGATE_ARTIFACT_BYTES,
                total_bytes
            );
        }
        let target = parse_envelope(&target_bytes)
            .map_err(|e| anyhow!("Target artifact {:?}: {}", target_path, e))?;
        targets.push(target);
    }

    if total_bytes > MAX_AGGREGATE_ARTIFACT_BYTES {
        bail!(
            "Aggregate artifact size exceeded budget of {} bytes (read {} bytes)",
            MAX_AGGREGATE_ARTIFACT_BYTES,
            total_bytes
        );
    }

    // 5. Resolve trust policy
    let policy = resolve_policy(
        &base,
        &candidate,
        &targets,
        trust_policy_path.as_deref(),
        req.trusted_local,
        max_bytes,
    )?;

    // 6. Compare against the baseline, then against the candidate
    drop(base_bytes);
    drop(candidate_bytes);
    let mut report = compare_with_baseline(
        &mut base,
        &mut candidate,
        &mut targets,
        &policy,
        req.trusted_local,
        req.require_service_mapping,
    )?;

    if let Some(ref tel_path) = telemetry_path {
        if let Ok(bytes) = read_bounded(tel_path, max_bytes) {
            apply_telemetry_ref(&mut report, &bytes);
        }
    }

    apply_freshness_gate(
        &mut report,
        &policy,
        &candidate,
        req.evaluation_time_unix,
        req.deployment_liveness_verified,
    );

    Ok(report)
}

/// In-memory sibling of [`run_check_contract_service`] for callers that already
/// hold parsed envelopes — a candidate extracted from staged index blobs or
/// from a Git tree must not be written to disk first. Trust resolution, type
/// pool expansion, comparison, the finding ratchet, telemetry reference and the
/// freshness gate are the same code path as the file-based entry point.
pub fn run_check_contract_envelope_service(
    req: CheckContractEnvelopeRequest,
) -> Result<CrossLanguageImpactReport> {
    let max_bytes = req.max_artifact_bytes.unwrap_or(DEFAULT_MAX_ARTIFACT_BYTES);

    if req.targets.is_empty() {
        bail!("At least one target contract artifact must be specified");
    }
    if req.targets.len() > 64 {
        bail!("Too many target artifacts (maximum 64 allowed)");
    }

    let CheckContractEnvelopeRequest {
        mut base,
        mut candidate,
        mut targets,
        trust_policy_path,
        trusted_local,
        require_service_mapping,
        telemetry,
        evaluation_time_unix,
        deployment_liveness_verified,
        max_artifact_bytes: _,
    } = req;

    // The file-based entry point parses artifacts, so every envelope it hands to
    // admission carries the JSON it was sealed over. Type-pool expansion then
    // mutates the struct without disturbing that copy; an in-memory envelope
    // needs the same anchor or its post-expansion digest would not match its
    // seal. Serialization skips `rawValue`, so this records the pre-expansion
    // bytes exactly as a round trip through disk would.
    for envelope in [&mut base, &mut candidate]
        .into_iter()
        .chain(targets.iter_mut())
    {
        if envelope.raw_value.is_none() {
            envelope.raw_value = Some(serde_json::to_value(&*envelope)?);
        }
    }

    let policy = resolve_policy(
        &base,
        &candidate,
        &targets,
        trust_policy_path.as_deref(),
        trusted_local,
        max_bytes,
    )?;

    let mut report = compare_with_baseline(
        &mut base,
        &mut candidate,
        &mut targets,
        &policy,
        trusted_local,
        require_service_mapping,
    )?;

    if let Some(value) = telemetry {
        if let Ok(bytes) = serde_json::to_vec(&value) {
            apply_telemetry_ref(&mut report, &bytes);
        }
    }

    apply_freshness_gate(
        &mut report,
        &policy,
        &candidate,
        evaluation_time_unix,
        deployment_liveness_verified,
    );

    Ok(report)
}

fn resolve_policy(
    base: &ContractArtifactEnvelope,
    candidate: &ContractArtifactEnvelope,
    targets: &[ContractArtifactEnvelope],
    trust_policy_path: Option<&Path>,
    trusted_local: bool,
    max_bytes: usize,
) -> Result<ArtifactTrustPolicy> {
    if let Some(path) = trust_policy_path {
        let bytes = read_bounded(path, max_bytes)?;
        return serde_json::from_slice::<ArtifactTrustPolicy>(&bytes)
            .map_err(|e| anyhow!("trust policy parse error in {:?}: {}", path, e));
    }
    if !trusted_local {
        bail!("Either trust policy or trusted_local must be specified");
    }
    let mut producers = vec![
        crate::admission::TrustedProducer {
            repository_id: base.snapshot.repository_id.clone(),
            service_id: base.snapshot.service_id.clone(),
            public_key_pem: None,
            trusted_digests: None,
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        },
        crate::admission::TrustedProducer {
            repository_id: candidate.snapshot.repository_id.clone(),
            service_id: candidate.snapshot.service_id.clone(),
            public_key_pem: None,
            trusted_digests: None,
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        },
    ];
    for target in targets {
        producers.push(crate::admission::TrustedProducer {
            repository_id: target.snapshot.repository_id.clone(),
            service_id: target.snapshot.service_id.clone(),
            public_key_pem: None,
            trusted_digests: None,
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        });
    }
    Ok(ArtifactTrustPolicy {
        producers,
        require_signatures: false,
        revoked_key_ids: Vec::new(),
        max_contract_age_days: None,
        waiver_approvers: Vec::new(),
    })
}

fn compare_with_baseline(
    base: &mut ContractArtifactEnvelope,
    candidate: &mut ContractArtifactEnvelope,
    targets: &mut [ContractArtifactEnvelope],
    policy: &ArtifactTrustPolicy,
    trusted_local: bool,
    require_service_mapping: bool,
) -> Result<CrossLanguageImpactReport> {
    // Expand type pools if present (V2 artifacts)
    crate::expansion::expand_type_pool(base)?;
    crate::expansion::expand_type_pool(candidate)?;
    for target in targets.iter_mut() {
        crate::expansion::expand_type_pool(target)?;
    }

    // C1 FIX: Unconditionally admit and integrity-verify the candidate artifact BEFORE any shortcut.
    if let Err(e) = crate::admission::admit_artifact(candidate, policy, trusted_local) {
        let repo = crate::report::SnapshotIdentity {
            repository_id: candidate.snapshot.repository_id.clone(),
            parent_commit: candidate.snapshot.parent_commit.clone(),
            candidate_snapshot: candidate.snapshot.candidate_snapshot.clone(),
        };
        return Ok(crate::report::make_error_report(
            repo,
            crate::report::BlockerCode::ToolFailure,
            format!("candidate: admission failed: {}", e),
        ));
    }

    let baseline = check_contract_refs(
        base,
        base,
        targets,
        policy,
        trusted_local,
        require_service_mapping,
    )?;

    if baseline.verdict == CrossLanguageVerdict::AnalysisError {
        return Ok(baseline);
    }

    // Re-derive identical contract from freshly recomputed canonical digests, never from unverified fields.
    let is_identical_contract = match (
        crate::envelope::compute_envelope_digest(candidate),
        crate::envelope::compute_envelope_digest(base),
    ) {
        (Ok(cand_digest), Ok(base_digest)) => cand_digest == base_digest,
        _ => false,
    };

    let mut report = if is_identical_contract {
        baseline.clone()
    } else {
        check_contract_refs(
            base,
            candidate,
            targets,
            policy,
            trusted_local,
            require_service_mapping,
        )?
    };
    for finding in report.findings.iter_mut() {
        crate::report::populate_finding_id_v2(finding);
    }
    let split =
        crate::report::apply_finding_ratchet(report.findings.clone(), baseline.findings.clone());
    report.delta = Some(crate::report::FindingDelta {
        new_findings: split.new_violations,
        existing_findings: split.frozen_legacy_debt,
        resolved_findings: split.resolved,
    });
    Ok(report)
}

/// Binds a telemetry artifact to the report by its sealed digest. This records
/// which evidence was available; it does not authenticate the telemetry
/// producer and does not alter the verdict.
fn apply_telemetry_ref(report: &mut CrossLanguageImpactReport, bytes: &[u8]) {
    let Ok(tel) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return;
    };
    let Some(integrity) = tel
        .get("integrity")
        .and_then(|i| i.get("sha256"))
        .and_then(|s| s.as_str())
    else {
        return;
    };
    let svc = tel
        .get("serviceId")
        .and_then(|s| s.as_str())
        .unwrap_or("backend-service")
        .to_string();
    let total_obs = tel
        .get("totalObservations")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    report.telemetry = Some(crate::report::TelemetryRef {
        artifact_sha256: integrity.to_string(),
        service_id: svc,
        total_observations: total_obs,
    });
}

/// Freshness gate (spec §2) — Evidence Admission Gate duty, never the pure
/// evaluator's. Runs exclusively when an explicit evaluation time is supplied,
/// so identical inputs keep producing byte-identical output.
fn apply_freshness_gate(
    report: &mut CrossLanguageImpactReport,
    policy: &ArtifactTrustPolicy,
    candidate: &ContractArtifactEnvelope,
    evaluation_time_unix: Option<u64>,
    deployment_liveness_verified: bool,
) {
    if let (Some(eval_secs), Some(max_age_days), Some(issued)) = (
        evaluation_time_unix,
        policy.max_contract_age_days,
        candidate.issued_at_unix,
    ) {
        let age_days = eval_secs.saturating_sub(issued) / 86_400;
        if age_days > max_age_days as u64 {
            let refreshed = deployment_liveness_verified;
            report.advisories.push(
                crate::advisory::EvidenceAdvisory::ContractAgeThresholdExceeded {
                    age_days,
                    threshold_days: max_age_days,
                    issued_at_unix: issued,
                    evaluation_time_unix: eval_secs,
                    refreshed_by_deployment_record: refreshed,
                },
            );
            if !refreshed && report.verdict == CrossLanguageVerdict::LikelyPreserved {
                // Abstain: a stale artifact cannot earn the strongest verdict
                // without a deployment liveness refresh or an authorized waiver.
                report.verdict = CrossLanguageVerdict::Inconclusive;
            }
        }
    }
}

pub fn normalize_path(path: &Path) -> Result<PathBuf> {
    let canonical =
        fs::canonicalize(path).map_err(|e| anyhow!("Cannot resolve path {:?}: {}", path, e))?;
    let path_str = canonical.to_string_lossy();
    if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        Ok(PathBuf::from(stripped))
    } else {
        Ok(canonical)
    }
}

pub fn is_under_root(path: &Path, root: &Path) -> bool {
    let p_comps: Vec<_> = path.components().collect();
    let r_comps: Vec<_> = root.components().collect();
    if p_comps.len() < r_comps.len() {
        return false;
    }
    for (p, r) in p_comps.iter().zip(r_comps.iter()) {
        #[cfg(windows)]
        {
            let p_s = p.as_os_str().to_string_lossy().to_lowercase();
            let r_s = r.as_os_str().to_string_lossy().to_lowercase();
            if p_s != r_s {
                return false;
            }
        }
        #[cfg(not(windows))]
        {
            if p != r {
                return false;
            }
        }
    }
    true
}

pub fn validate_path_under_roots(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf> {
    let normalized = normalize_path(path)?;
    for root in allowed_roots {
        let normalized_root = normalize_path(root)?;
        if is_under_root(&normalized, &normalized_root) {
            return Ok(normalized);
        }
    }
    bail!(
        "Path {:?} is outside all allowed roots: {:?}",
        path,
        allowed_roots
    );
}

/// Open a file without following a symlink or reparse point at its final
/// component (spec §2.1.4). `normalize_path` already resolves ancestors, so the
/// remaining exposure is a link swapped in after resolution and before open;
/// the flag is applied at open time to close that window on the platforms where
/// the flag value is stable.
fn open_confined(path: &Path) -> Result<fs::File> {
    use std::fs::OpenOptions;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT opens the link itself, so the metadata
        // check below observes the reparse point instead of its target.
        options.custom_flags(0x0020_0000);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW: Linux flag 0o400000 (0x20000) prevents following symlinks on open.
        // Note: 0o40000 is O_DIRECT which causes EINVAL on unaligned reads.
        options.custom_flags(0o400000);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0100);
    }
    let file = options
        .open(path)
        .map_err(|e| anyhow!("Cannot open {:?}: {}", path, e))?;
    if file
        .metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        bail!(
            "Unsafe file path {:?}: symbolic links are not followed",
            path
        );
    }
    Ok(file)
}

pub fn read_bounded(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let before =
        fs::symlink_metadata(path).map_err(|e| anyhow!("Cannot resolve {:?}: {}", path, e))?;
    if before.file_type().is_symlink() {
        bail!(
            "Unsafe file path {:?}: symbolic links are not followed",
            path
        );
    }
    let file = open_confined(path)?;
    let mut reader = file.take((max_bytes + 1) as u64);
    let mut buffer = Vec::new();
    reader
        .read_to_end(&mut buffer)
        .map_err(|e| anyhow!("Cannot read {:?}: {}", path, e))?;
    if buffer.len() > max_bytes {
        bail!(
            "Artifact {:?} exceeds maximum allowed size of {} bytes",
            path,
            max_bytes
        );
    }
    // Re-identify the object after reading. A file replaced or relinked while
    // the bytes were being copied cannot seal under the identity the caller
    // validated.
    let after =
        fs::symlink_metadata(path).map_err(|e| anyhow!("Cannot re-resolve {:?}: {}", path, e))?;
    if after.file_type().is_symlink()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        bail!(
            "FILE_CHANGED_DURING_CAPTURE: {:?} changed while it was being read",
            path
        );
    }
    Ok(buffer)
}
