//! check_contract.rs -- CLI admission, comparison, and output.
//!
//! Exit semantics (advisory):
//! - 0: valid report produced (including LIKELY_VIOLATED or INCONCLUSIVE)
//! - 1: invocation error, admission failure, or tool error

use clap::Args;
use contract_core::report::CrossLanguageVerdict;
use contract_core::serialization::serialize_report;
use contract_core::service::{run_check_contract_service, CheckContractServiceRequest};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Args)]
pub struct CheckContractArgs {
    /// Base artifact JSON file path.
    #[arg(long)]
    pub base: PathBuf,
    /// Candidate artifact JSON file path.
    #[arg(long)]
    pub candidate: PathBuf,
    /// Target artifact JSON file path(s) or remote HTTP/HTTPS URL(s). May be specified multiple times.
    #[arg(long = "target", required = true)]
    pub targets: Vec<String>,
    /// Trust policy JSON file path.
    #[arg(long, conflicts_with = "trusted_local")]
    pub trust_policy: Option<PathBuf>,
    /// Use trusted-local mode.
    #[arg(long, conflicts_with = "trust_policy")]
    pub trusted_local: bool,
    /// Write report JSON to this file instead of stdout.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Require service mapping for relative routes (default: true).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub require_service_mapping: bool,
    /// Fail with exit code 1 if the report verdict is VIOLATED or LIKELY_VIOLATED.
    #[arg(long)]
    pub fail_on_violation: bool,
    /// Strict mode (spec §8): fail closed — VIOLATED exits 1, INCONCLUSIVE and
    /// ANALYSIS_ERROR exit 3. Default advisory mode allows the commit on
    /// INCONCLUSIVE/ANALYSIS_ERROR (exit 0) with a recovery banner.
    #[arg(long)]
    pub strict: bool,
    /// Path to a sealed telemetry artifact (SAJIMORA_TELEMETRY_ARTIFACT_V1).
    #[arg(long)]
    pub telemetry: Option<PathBuf>,
    /// Release admission policy mode: "strict" (default) or "waiver-ledger".
    #[arg(long, default_value = "strict")]
    pub policy_mode: String,
    /// Path to a signed waiver ledger JSON (e.g. .sajimora/waivers.json).
    #[arg(long)]
    pub waiver_ledger: Option<PathBuf>,
    /// Path to production hit counts JSON or CSV.
    #[arg(long)]
    pub telemetry_hits: Option<PathBuf>,
    /// Write admission audit JSON to this file.
    #[arg(long)]
    pub admission_audit: Option<PathBuf>,
    /// Enforce absolute zero findings even for pre-existing legacy baseline debt.
    #[arg(long)]
    pub strict_baseline: bool,
    /// Path to the caller-supplied deployment state ledger
    /// (SAJIMORA_DEPLOYMENT_STATE_V1) for replay/rollback prevention (spec §3.3).
    /// A replay check failure exits with code 4 (ADMISSION_ERROR). When the
    /// gate passes, the candidate counts as refreshed by a deployment
    /// liveness record for `maxContractAgeDays` purposes (spec §2).
    #[arg(long)]
    pub deployment_state: Option<PathBuf>,
    /// Explicit evaluation instant (Unix epoch seconds) for calendar-freshness
    /// checks (spec §2). When omitted, no freshness gate runs and output
    /// remains byte-identical across runs.
    #[arg(long)]
    pub evaluation_time: Option<u64>,
    /// Include the per-route shape distance rows in the report's `shapeCoverage`
    /// block. Without it, `shapeCoverage` carries the per-artifact totals only.
    #[arg(long)]
    pub shape_detail: bool,
    /// Omit the `shapeCoverage` block entirely, restoring the pre-shape-report
    /// output byte-for-byte.
    #[arg(long)]
    pub no_shape_coverage: bool,
}

/// Exit-code matrix (spec §8):
///   0 — LIKELY_PRESERVED / admitted (also INCONCLUSIVE/ANALYSIS_ERROR in the
///       default local advisory mode, with a recovery banner on stderr)
///   1 — LIKELY_VIOLATED and blocked by the admission policy (or a generic
///       invocation failure)
///   2 — USAGE_ERROR: invalid CLI arguments or malformed configuration
///   3 — INCONCLUSIVE / ANALYSIS_ERROR under --strict (fail-closed CI gate)
///   4 — ADMISSION_ERROR: untrusted signer, forged envelope, expired TTL,
///       tampered payload, replay/rollback failure
pub fn run(args: CheckContractArgs) -> i32 {
    let fail_on_violation = args.fail_on_violation || args.strict;
    let strict = args.strict;
    let strict_baseline = args.strict_baseline;
    let policy_mode_str = args.policy_mode.clone();
    let waiver_ledger_path = args.waiver_ledger.clone();
    let telemetry_hits_path = args.telemetry_hits.clone();
    let admission_audit_path = args.admission_audit.clone();
    let trust_policy_path = args.trust_policy.clone();
    let candidate_path = args.candidate.clone();

    match run_inner(args) {
        Ok((report, report_json, out_path)) => {
            let has_admission_error = report
                .blockers
                .iter()
                .any(|b| b.message.contains("admission failed"));
            let verdict = &report.verdict;

            if let Some(path) = out_path {
                if let Err(e) = write_atomic(&path, &report_json) {
                    eprintln!("{{\"error\": \"failed to write output: {}\"}}", e);
                    return 1;
                }
                eprintln!("Report written to {:?}", path);
            } else {
                println!("{}", report_json);
            }

            if has_admission_error {
                4
            } else if *verdict == CrossLanguageVerdict::AnalysisError {
                if strict {
                    3
                } else {
                    print_advisory_banner("analysis failed");
                    0
                }
            } else if fail_on_violation && *verdict == CrossLanguageVerdict::LikelyViolated {
                let policy_mode = if strict_baseline {
                    contract_core::policy::PolicyMode::StrictBaseline
                } else {
                    match policy_mode_str.to_lowercase().as_str() {
                        "waiver-ledger" | "waiver_ledger" | "advisory-traffic" => {
                            contract_core::policy::PolicyMode::WaiverLedger
                        }
                        _ => contract_core::policy::PolicyMode::Strict,
                    }
                };

                let trust_policy: contract_core::admission::ArtifactTrustPolicy = if let Some(
                    ref p,
                ) =
                    trust_policy_path
                {
                    match fs::read_to_string(p) {
                        Ok(s) => match serde_json::from_str(&s) {
                            Ok(pol) => pol,
                            Err(e) => {
                                eprintln!("{{\"error\": \"invalid trust policy: malformed JSON in {}: {e}\"}}", p.display());
                                return 4;
                            }
                        },
                        Err(e) => {
                            eprintln!(
                                "{{\"error\": \"cannot read trust policy at {}: {e}\"}}",
                                p.display()
                            );
                            return 4;
                        }
                    }
                } else {
                    contract_core::admission::ArtifactTrustPolicy::default()
                };

                let mut traffic_map = std::collections::HashMap::new();
                let mut telemetry_proof = None;
                if let Some(ref hp) = telemetry_hits_path {
                    if let Ok(env) =
                        telemetry_core::ingest_hit_counts(hp, Some(&trust_policy), 90, 30)
                    {
                        telemetry_proof = Some(contract_core::policy::TelemetryProof {
                            source_identity: env.source_identity.clone(),
                            duration_days: env.observation_window.duration_days,
                            trust_level: format!("{:?}", env.trust_level),
                        });
                        for r in &env.routes {
                            let key = format!("{} {}", r.http_method.to_uppercase(), r.raw_path);
                            let is_zero = matches!(
                                r.traffic_tier,
                                telemetry_core::types::TrafficTier::ZeroObserved
                            ) && env.trust_level.is_certified();
                            traffic_map.insert(
                                key,
                                contract_core::policy::EndpointTrafficContext {
                                    http_method: r.http_method.clone(),
                                    canonical_route: r.raw_path.clone(),
                                    is_certified: env.trust_level.is_certified(),
                                    window_days: env.observation_window.duration_days,
                                    is_zero_observed_certified: is_zero,
                                    traffic_tier_label: format!("{:?}", r.traffic_tier),
                                },
                            );
                        }
                    }
                }

                let waiver_ledger: Option<contract_core::policy::WaiverLedger> = waiver_ledger_path
                    .as_ref()
                    .and_then(|p| fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str(&s).ok());

                let (repo_id, base_commit, target_commit) =
                    if let Ok(bytes) = fs::read(&candidate_path) {
                        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            let snap = val.get("snapshot");
                            let r = snap
                                .and_then(|s| s.get("repositoryId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let b = snap
                                .and_then(|s| s.get("parentCommit"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("HEAD~1");
                            let t = snap
                                .and_then(|s| s.get("candidateSnapshot"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("HEAD");
                            (r.to_string(), b.to_string(), t.to_string())
                        } else {
                            ("unknown".into(), "HEAD~1".into(), "HEAD".into())
                        }
                    } else {
                        ("unknown".into(), "HEAD~1".into(), "HEAD".into())
                    };

                let decision = contract_core::policy::evaluate_admission_policy(
                    &report,
                    &traffic_map,
                    waiver_ledger.as_ref(),
                    &trust_policy.waiver_approvers,
                    &repo_id,
                    &base_commit,
                    &target_commit,
                    policy_mode,
                );

                if let Some(ref audit_path) = admission_audit_path {
                    let audit = contract_core::policy::build_admission_audit(
                        &repo_id,
                        &base_commit,
                        &target_commit,
                        "LIKELY_VIOLATED",
                        report.findings.len(),
                        policy_mode,
                        &decision,
                        telemetry_proof,
                    );
                    if let Ok(audit_json) = serde_json::to_string_pretty(&audit) {
                        let _ = write_atomic(audit_path, &audit_json);
                    }
                }

                match decision {
                    contract_core::policy::AdmissionDecision::WaiverAdmitted { .. } => 0,
                    contract_core::policy::AdmissionDecision::Blocked { ref reasons } => {
                        let has_sig_error = reasons.iter().any(|r| {
                            r.reason.contains("signature verification failed")
                                || r.reason.contains("signature error")
                        });
                        if has_sig_error {
                            4
                        } else {
                            1
                        }
                    }
                    contract_core::policy::AdmissionDecision::Clean => 0,
                }
            } else if strict && *verdict == CrossLanguageVerdict::Inconclusive {
                3
            } else {
                if *verdict == CrossLanguageVerdict::Inconclusive {
                    print_advisory_banner("analysis incomplete");
                }
                0
            }
        }
        Err(e) => {
            if let Some(ReplayGateError(msg)) = e.downcast_ref::<ReplayGateError>() {
                eprintln!("{{\"error\": {:?}}}", msg);
                4
            } else if let Some(TrustPolicyError(msg)) = e.downcast_ref::<TrustPolicyError>() {
                eprintln!("{{\"error\": {:?}}}", msg);
                4
            } else if let Some(UsageError(msg)) = e.downcast_ref::<UsageError>() {
                eprintln!("{{\"error\": {:?}}}", msg);
                2
            } else {
                eprintln!("{{\"error\": {:?}}}", e.to_string());
                1
            }
        }
    }
}

/// Typed marker for trust policy loading and admission errors (spec §8.2: ADMISSION_ERROR, exit 4).
#[derive(Debug)]
struct TrustPolicyError(String);

impl std::fmt::Display for TrustPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TrustPolicyError {}

/// Typed marker for invalid CLI arguments or malformed configuration
/// (spec §8.2: USAGE_ERROR, exit 2).
#[derive(Debug)]
struct UsageError(String);

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UsageError {}

/// Advisory banner (spec §8.1): in the default local mode, INCONCLUSIVE and
/// ANALYSIS_ERROR allow the commit while telling the developer exactly how to
/// recover. `--strict` turns these verdicts fail-closed (exit 3).
fn print_advisory_banner(reason: &str) {
    eprintln!();
    eprintln!("⚠️  Sajimora Advisory: {reason} or local cache index may need a rebuild.");
    eprintln!("    -> Commit allowed locally under advisory mode.");
    eprintln!("    -> Run `sajimora doctor` to diagnose.");
    eprintln!("    -> Run `sajimora clean` to reset local state safely.");
    eprintln!("    -> Re-run with `--strict` to make this verdict fail-closed (exit 3).");
    eprintln!();
}

/// Typed marker so replay-gate failures exit with ADMISSION_ERROR (4) instead
/// of the generic invocation error code (spec §8.2).
#[derive(Debug)]
struct ReplayGateError(String);

impl std::fmt::Display for ReplayGateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReplayGateError {}

/// Enforce the replay/rollback gate (spec §3.3) against the caller-supplied
/// deployment state ledger for the candidate artifact.
fn enforce_replay_gate(ds_path: &Path, candidate_path: &Path) -> anyhow::Result<()> {
    let run = || -> Result<(), String> {
        let ds_bytes = fs::read(ds_path)
            .map_err(|e| format!("failed to read deployment state {:?}: {}", ds_path, e))?;
        let ledger: contract_core::replay::DeploymentStateLedger =
            serde_json::from_slice(&ds_bytes)
                .map_err(|e| format!("deployment state parse error in {:?}: {}", ds_path, e))?;
        let raw = fs::read(candidate_path).map_err(|e| {
            format!(
                "failed to read candidate artifact {:?}: {}",
                candidate_path, e
            )
        })?;
        let candidate = contract_core::envelope::parse_envelope(&raw)
            .map_err(|e| format!("candidate artifact parse error: {}", e))?;
        let expected_env = candidate.snapshot.environment.as_deref();
        contract_core::replay::check_replay(&candidate, &ledger, expected_env)
            .map_err(|e| format!("replay gate failed: {}", e))
    };
    run().map_err(|msg| anyhow::Error::new(ReplayGateError(msg)))
}

fn run_inner(
    args: CheckContractArgs,
) -> anyhow::Result<(
    contract_core::report::CrossLanguageImpactReport,
    String,
    Option<PathBuf>,
)> {
    if !args.trusted_local && args.trust_policy.is_none() {
        return Err(anyhow::Error::new(UsageError(
            "either --trust-policy or --trusted-local is required".to_string(),
        )));
    }

    if let Some(ref tp) = args.trust_policy {
        match fs::read_to_string(tp) {
            Ok(content) => {
                if let Err(e) =
                    serde_json::from_str::<contract_core::admission::ArtifactTrustPolicy>(&content)
                {
                    return Err(anyhow::Error::new(TrustPolicyError(format!(
                        "failed to read trust policy at {}: {e}",
                        tp.display()
                    ))));
                }
            }
            Err(e) => {
                return Err(anyhow::Error::new(TrustPolicyError(format!(
                    "failed to read trust policy at {}: {e}",
                    tp.display()
                ))));
            }
        }
    }

    // Malformed configuration is a USAGE_ERROR (exit 2, spec §8.2), not a
    // silent fallback to the default policy mode.
    match args.policy_mode.to_lowercase().as_str() {
        "strict" | "waiver-ledger" | "waiver_ledger" | "advisory-traffic" => {}
        other => {
            return Err(anyhow::Error::new(UsageError(format!(
                "invalid --policy-mode {other:?}; expected \"strict\" or \"waiver-ledger\""
            ))))
        }
    }

    // Replay/rollback gate (spec §3.3) runs ahead of comparison; a failure is
    // a typed error so run() can exit with ADMISSION_ERROR (4). A pass marks
    // the candidate as deployment-liveness-refreshed for the freshness gate.
    let deployment_liveness_verified = if let Some(ref ds_path) = args.deployment_state {
        enforce_replay_gate(ds_path, &args.candidate)?;
        true
    } else {
        false
    };

    let shape_detail = args.shape_detail;
    let no_shape_coverage = args.no_shape_coverage;
    let base_path = args.base.clone();
    let candidate_path = args.candidate.clone();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cache_dir = cwd.join(".sajimora");
    let mut target_paths = Vec::with_capacity(args.targets.len());
    for t in &args.targets {
        let resolved = crate::remote::resolve_contract_path(t, &cwd, &cache_dir)?;
        target_paths.push(resolved);
    }

    let report = run_check_contract_service(CheckContractServiceRequest {
        base_path: args.base,
        candidate_path: args.candidate,
        target_paths: target_paths.clone(),
        trust_policy_path: args.trust_policy,
        trusted_local: args.trusted_local,
        require_service_mapping: args.require_service_mapping,
        allowed_roots: None,
        max_artifact_bytes: None,
        telemetry_path: args.telemetry,
        evaluation_time_unix: args.evaluation_time,
        deployment_liveness_verified,
    })?;

    // The request above owns the artifact paths; the shape read-out needs to open the
    // same files again, so keep a copy of the handles rather than re-deriving them.
    let json = serialize_report(report.clone());
    let json = attach_shape_coverage(
        json,
        &base_path,
        &candidate_path,
        &target_paths,
        shape_detail,
        no_shape_coverage,
    );
    Ok((report, json, args.out))
}

/// Add the shape-distance block to the report JSON as a sibling key.
///
/// Deliberately an injection rather than a field on `CrossLanguageImpactReport`: the
/// report struct is constructed in fifteen places and the verdict digest of an artifact
/// must not move because a coverage read-out was added next to it. The block never
/// changes exit codes, and a failure to compute it leaves the report untouched — shape
/// coverage is a read-out, not a gate.
fn attach_shape_coverage(
    json: String,
    base: &Path,
    candidate: &Path,
    targets: &[PathBuf],
    with_routes: bool,
    disabled: bool,
) -> String {
    if disabled {
        return json;
    }
    let mut coverages = serde_json::Map::new();
    let mut summary: Vec<(String, contract_core::shape_report::ShapeCoverage)> = Vec::new();
    for (role, path) in std::iter::once(("base", base))
        .chain(std::iter::once(("candidate", candidate)))
        .chain(targets.iter().map(|t| ("target", t.as_path())))
    {
        let coverage = match contract_core::shape_report::coverage_for_artifact(path, with_routes) {
            Ok(coverage) => coverage,
            Err(e) => {
                eprintln!(
                    "shapeCoverage: {} artifact {} unreadable: {e}",
                    role,
                    path.display()
                );
                return json;
            }
        };
        let value = match serde_json::to_value(&coverage) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "shapeCoverage: {} for {} failed to serialize: {e}",
                    role,
                    path.display()
                );
                return json;
            }
        };
        summary.push((role.to_string(), coverage));
        if role == "target" {
            let entry = coverages
                .entry("targets")
                .or_insert_with(|| serde_json::Value::Array(Vec::new()));
            if let Some(list) = entry.as_array_mut() {
                list.push(value);
            }
        } else {
            coverages.insert(role.to_string(), value);
        }
    }

    // The same numbers, in the place an engineer looks first. Stderr keeps stdout a
    // single parseable JSON document.
    eprintln!("shape coverage (census definitions; positions are per occurrence):");
    for (role, coverage) in &summary {
        eprintln!("  {:<9} {}", role, coverage.summary_line());
    }
    for (role, coverage) in &summary {
        if coverage.nearest_routes.is_empty() {
            continue;
        }
        let rows = coverage
            .nearest_routes
            .iter()
            .take(5)
            .map(|r| format!("{} (+{})", r.route, r.distance_to_complete))
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!("  {:<9} nearest to fully-shaped: {}", role, rows);
    }

    let mut root: serde_json::Value = match serde_json::from_str(&json) {
        Ok(v) => v,
        Err(_) => return json,
    };
    if let Some(obj) = root.as_object_mut() {
        obj.insert(
            "shapeCoverage".to_string(),
            serde_json::Value::Object(coverages),
        );
    } else {
        return json;
    }
    serde_json::to_string_pretty(&root).unwrap_or(json)
}

fn write_atomic(dest: &Path, content: &str) -> anyhow::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(".sajimora_tmp_{}_{}.tmp", std::process::id(), nanos);
    let temp_path = parent.join(temp_name);

    fs::write(&temp_path, content)?;

    if let Err(e) = replace_output(&temp_path, dest) {
        let _ = fs::remove_file(&temp_path);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(source, dest)
}

#[cfg(windows)]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-directory replacement; no cross-volume copy/delete fallback.
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[test]
    fn replaces_existing_report_and_cleans_temporary_files() {
        let dir = std::env::temp_dir().join(format!(
            "sajimora-output-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let dest = dir.join("report.json");
        write_atomic(&dest, "old").unwrap();
        write_atomic(&dest, "new").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(dest).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_destination_preserves_old_report_on_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!(
            "sajimora-locked-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let dest = dir.join("report.json");
        fs::write(&dest, "old").unwrap();
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&dest)
            .unwrap();
        assert!(write_atomic(&dest, "new").is_err());
        drop(guard);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(dest).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
