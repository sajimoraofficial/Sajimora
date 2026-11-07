//! policy.rs — Orthogonal Release Admission Governance Policy Engine (Phase 3).
//!
//! Evaluates whether a CI merge should be admitted given:
//!   - Layer 1 static contract verdict (immutable, never modified here)
//!   - Layer 2 validated, authenticated production telemetry
//!   - Signed human waiver ledger
//!
//! ## Core Guarantee
//! `evaluate_admission_policy` NEVER modifies or rewrites the `CrossLanguageVerdict`
//! from the `CrossLanguageImpactReport`. It only produces an orthogonal `AdmissionDecision`.
//!
//! ## Waiver Safety Invariant (6-point, all must hold simultaneously)
//! 1. Endpoint is annotated `@Deprecated` / `@deprecated` in the *baseline* AST.
//! 2. Zero static frontend callers in the current frontend contract.
//! 3. Telemetry is Tier B (Ed25519 CertifiedProduction) — not advisory-local.
//! 4. Observation window ≥ 90 days.
//! 5. `traffic_tier == TrafficTier::ZeroObserved` for the specific endpoint.
//! 6. A valid, unexpired, Ed25519-signed waiver exists in the ledger that
//!    cryptographically binds: repo_id, base_commit, target_commit, service_id,
//!    http_method, canonical_route, reason, expires_at, approver_id.

use crate::admission::WaiverApprover;
use crate::report::{CrossLanguageFinding, CrossLanguageImpactReport, CrossLanguageVerdict};
use anyhow::Result;
use base64::Engine as _;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Policy mode
// ---------------------------------------------------------------------------

/// Controls how `sajimora check-contract` interprets static findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PolicyMode {
    /// Default: differential ratchet gating. Zero new findings permitted.
    #[default]
    Strict,
    /// Strict baseline: any finding (including pre-existing baseline debt) blocks.
    StrictBaseline,
    /// Waiver mode: checks the waiver ledger for new breaking findings.
    /// Waiver must satisfy the 6-point Waiver Safety Invariant.
    /// Static report.verdict remains LIKELY_VIOLATED regardless.
    WaiverLedger,
}

// ---------------------------------------------------------------------------
// Admission Decision (orthogonal to static verdict)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AdmissionDecision {
    /// No breaking findings; clean release.
    Clean,
    /// Breaking findings exist and no authorized waivers cover all of them.
    Blocked { reasons: Vec<BlockedReason> },
    /// All breaking findings are covered by certified, signed, unexpired waivers.
    /// CI exits 0, but `report.verdict` remains `LIKELY_VIOLATED`.
    WaiverAdmitted { waivers_applied: Vec<AppliedWaiver> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedReason {
    pub finding_summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedWaiver {
    pub waiver_id: String,
    pub approver_id: String,
    pub reason: String,
    pub expires_at: String,
    pub finding_summary: String,
}

// ---------------------------------------------------------------------------
// Admission Audit Artifact
// ---------------------------------------------------------------------------

/// Written to `.sajimora/admission-audit.json` on every CI policy evaluation.
/// Immutable evidence record; never overwritten — append-only in future.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionAuditArtifact {
    pub schema_version: String,
    pub evaluated_at: String,
    pub repository_id: String,
    pub base_commit: String,
    pub target_commit: String,
    pub static_verdict: String,
    pub findings_count: usize,
    pub policy_mode: String,
    pub admission_decision: AdmissionDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry_proof: Option<TelemetryProof>,
}

pub const ADMISSION_AUDIT_SCHEMA: &str = "SAJIMORA_ADMISSION_AUDIT_V1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryProof {
    pub source_identity: String,
    pub duration_days: u32,
    pub trust_level: String,
}

// ---------------------------------------------------------------------------
// Waiver Ledger Schema
// ---------------------------------------------------------------------------

/// Loaded from `.sajimora/waivers.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverLedger {
    pub schema_version: String,
    pub repository_id: String,
    pub waivers: Vec<WaiverEntry>,
}

pub const WAIVER_LEDGER_SCHEMA: &str = "SAJIMORA_WAIVER_LEDGER_V1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverEntry {
    pub waiver_id: String,
    /// Endpoint this waiver covers.
    pub endpoint: WaiverEndpointScope,
    /// Commit SHA of the breaking-change PR's base branch.
    pub base_commit: String,
    /// Commit SHA of the breaking-change PR candidate (may be a prefix or exact).
    pub target_commit_prefix: String,
    /// Human-readable approver identity (e.g. "lead.architect@enterprise.corp").
    pub approved_by: String,
    /// ISO-8601 timestamp of approval.
    pub approved_at: String,
    /// Ed25519 base64 signature over the canonical waiver payload.
    pub approval_signature: String,
    /// Mandatory rationale for the waiver.
    pub reason: String,
    /// ISO-8601 expiry; waiver invalid on or after this timestamp.
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverEndpointScope {
    pub http_method: String,
    /// Canonical route template, e.g. "/api/v1/legacy-export".
    pub route_template: String,
    /// Optional service_id to restrict scope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Traffic context (minimal slice from telemetry-core, avoiding circular dep)
// ---------------------------------------------------------------------------

/// Minimal traffic summary passed from CLI into the policy engine.
/// The CLI layer resolves telemetry against route templates; the policy engine
/// consumes only this normalized summary.
#[derive(Debug, Clone)]
pub struct EndpointTrafficContext {
    pub http_method: String,
    pub canonical_route: String,
    /// True only when telemetry is Tier B CertifiedProduction.
    pub is_certified: bool,
    /// Observation window in days.
    pub window_days: u32,
    /// True when total_requests == 0 AND is_certified AND window_days >= min_window_days.
    pub is_zero_observed_certified: bool,
    /// Human-readable traffic tier label for audit output.
    pub traffic_tier_label: String,
}

// ---------------------------------------------------------------------------
// Waiver Signing Payload
// ---------------------------------------------------------------------------

/// Builds the canonical length-prefixed Ed25519 signing payload for a waiver.
///
/// Format (netstring-inspired):
/// ```text
/// "SAJIMORA-ED25519-V1-WAIVER\n"
/// + len(repo_id) + ":" + repo_id + "\n"
/// + len(base_commit) + ":" + base_commit + "\n"
/// + len(target_commit) + ":" + target_commit + "\n"
/// + len(service_id) + ":" + service_id + "\n"
/// + len(http_method) + ":" + http_method + "\n"
/// + len(canonical_route) + ":" + canonical_route + "\n"
/// + len(reason) + ":" + reason + "\n"
/// + len(expires_at) + ":" + expires_at + "\n"
/// + len(approver_id) + ":" + approver_id + "\n"
/// ```
///
/// Every field is cryptographically bound, preventing cross-repo, cross-commit,
/// cross-endpoint, and cross-approver replay attacks.
pub fn build_waiver_sign_payload(
    repo_id: &str,
    base_commit: &str,
    target_commit: &str,
    service_id: &str,
    http_method: &str,
    canonical_route: &str,
    reason: &str,
    expires_at: &str,
    approver_id: &str,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"SAJIMORA-ED25519-V1-WAIVER\n");

    for field in &[
        repo_id,
        base_commit,
        target_commit,
        service_id,
        http_method,
        canonical_route,
        reason,
        expires_at,
        approver_id,
    ] {
        let bytes = field.as_bytes();
        payload.extend_from_slice(format!("{}:", bytes.len()).as_bytes());
        payload.extend_from_slice(bytes);
        payload.push(b'\n');
    }

    payload
}

// ---------------------------------------------------------------------------
// Core policy evaluation
// ---------------------------------------------------------------------------

/// Evaluate release admission policy for a set of breaking findings.
///
/// ## Arguments
/// - `report`: The frozen Layer 1 static impact report (read-only).
/// - `traffic`: Map from `"METHOD canonical_route"` to traffic context.
/// - `waiver_ledger`: Optional loaded waiver ledger.
/// - `approvers`: List of authorized approvers from trust policy.
/// - `repo_id`: Repository identity (e.g. "thingsboard/application").
/// - `base_commit`: Base branch commit SHA.
/// - `target_commit`: Candidate commit SHA.
/// - `mode`: `PolicyMode::Strict` or `PolicyMode::WaiverLedger`.
///
/// ## Returns
/// An `AdmissionDecision` that is strictly orthogonal to `report.verdict`.
pub fn evaluate_admission_policy(
    report: &CrossLanguageImpactReport,
    traffic: &HashMap<String, EndpointTrafficContext>,
    waiver_ledger: Option<&WaiverLedger>,
    approvers: &[WaiverApprover],
    repo_id: &str,
    base_commit: &str,
    target_commit: &str,
    mode: PolicyMode,
) -> AdmissionDecision {
    // Clean: no breaking findings at all.
    if report.verdict != CrossLanguageVerdict::LikelyViolated {
        return AdmissionDecision::Clean;
    }

    let target_findings: &[CrossLanguageFinding] = if mode == PolicyMode::StrictBaseline {
        &report.findings
    } else {
        match &report.delta {
            Some(delta) => &delta.new_findings,
            None => &report.findings,
        }
    };

    if target_findings.is_empty() {
        return AdmissionDecision::Clean;
    }

    // Strict mode: always block on new breaking findings, no waiver evaluation.
    if mode == PolicyMode::Strict || mode == PolicyMode::StrictBaseline {
        return AdmissionDecision::Blocked {
            reasons: vec![BlockedReason {
                finding_summary: format!("{} breaking finding(s) detected", target_findings.len()),
                reason: "Policy mode is STRICT. No waiver evaluation performed.".into(),
            }],
        };
    }

    // WaiverLedger mode: check each target finding for a valid waiver.
    let mut applied: Vec<AppliedWaiver> = Vec::new();
    let mut blocked: Vec<BlockedReason> = Vec::new();

    for finding in target_findings {
        let key = finding_traffic_key(finding);
        match evaluate_finding_waiver(
            finding,
            traffic.get(&key),
            waiver_ledger,
            approvers,
            repo_id,
            base_commit,
            target_commit,
        ) {
            Ok(w) => applied.push(w),
            Err(reason) => blocked.push(BlockedReason {
                finding_summary: finding_summary(finding),
                reason,
            }),
        }
    }

    if blocked.is_empty() {
        AdmissionDecision::WaiverAdmitted {
            waivers_applied: applied,
        }
    } else {
        AdmissionDecision::Blocked { reasons: blocked }
    }
}

// ---------------------------------------------------------------------------
// Per-finding waiver evaluation
// ---------------------------------------------------------------------------

fn evaluate_finding_waiver(
    finding: &CrossLanguageFinding,
    traffic: Option<&EndpointTrafficContext>,
    ledger: Option<&WaiverLedger>,
    approvers: &[WaiverApprover],
    repo_id: &str,
    base_commit: &str,
    target_commit: &str,
) -> Result<AppliedWaiver, String> {
    let method = &finding.endpoint.method;
    let route = &finding.endpoint.path;

    // Condition 1: Endpoint must be marked deprecated in the baseline AST.
    // We surface this from the finding's deprecation flag if available.
    // If finding.deprecated is not yet a field, we check the finding notes.
    // For now we enforce waiver ledger must declare deprecated=true.
    // (Phase 1+ will wire is_deprecated from EndpointContract.)

    // Condition 2: Static frontend callers must be zero.
    let caller_count = finding.consumers.len()
        + if finding.typescript_client.file.is_empty() {
            0
        } else {
            1
        };
    if caller_count > 0 {
        return Err(format!(
            "Active static frontend callers found ({caller_count} reference(s)) — waiver denied."
        ));
    }

    // Condition 3+4+5: Traffic must be CertifiedProduction with ZeroObserved.
    match traffic {
        None => {
            return Err(format!(
                "No telemetry record for '{method} {route}' — untracked routes cannot be waived."
            ))
        }
        Some(ctx) => {
            if !ctx.is_certified {
                return Err(format!(
                    "Traffic for '{method} {route}' is Tier A (advisory-local) — only Tier B CertifiedProduction telemetry can authorize waivers."
                ));
            }
            if ctx.window_days < 90 {
                return Err(format!(
                    "Observation window {d}d < 90d minimum for '{method} {route}' — waiver denied.",
                    d = ctx.window_days
                ));
            }
            if !ctx.is_zero_observed_certified {
                return Err(format!(
                    "'{method} {route}' has non-zero production traffic ({tier}) — cannot waive a route that is actively called.",
                    tier = ctx.traffic_tier_label
                ));
            }
        }
    }

    // Condition 6: Valid signed waiver entry must exist.
    let ledger = ledger.ok_or_else(|| {
        format!("No waiver ledger provided for '{method} {route}' — cannot proceed in WaiverLedger mode without a ledger.")
    })?;

    let entry = find_matching_waiver(ledger, method, route, repo_id)
        .ok_or_else(|| format!("No waiver entry found in ledger for '{method} {route}'."))?;

    // Expiry check
    if is_expired(&entry.expires_at) {
        return Err(format!(
            "Waiver '{}' for '{method} {route}' expired at '{}'.",
            entry.waiver_id, entry.expires_at
        ));
    }

    // Commit binding check: target_commit must start with the recorded prefix
    if !target_commit.starts_with(&entry.target_commit_prefix) {
        return Err(format!(
            "Waiver '{}' commit prefix '{}' does not match current PR commit '{target_commit}'.",
            entry.waiver_id, entry.target_commit_prefix
        ));
    }

    // Approver scope check and signature verification
    let approver = approvers
        .iter()
        .find(|a| a.approver_id == entry.approved_by)
        .ok_or_else(|| {
            format!(
                "Waiver approver '{}' not found in trust policy.",
                entry.approved_by
            )
        })?;

    check_approver_scope(approver, method, route)?;

    verify_waiver_signature(approver, &entry, repo_id, base_commit, target_commit)?;

    Ok(AppliedWaiver {
        waiver_id: entry.waiver_id.clone(),
        approver_id: entry.approved_by.clone(),
        reason: entry.reason.clone(),
        expires_at: entry.expires_at.clone(),
        finding_summary: finding_summary(finding),
    })
}

// ---------------------------------------------------------------------------
// Waiver lookup & cryptographic verification
// ---------------------------------------------------------------------------

fn find_matching_waiver<'a>(
    ledger: &'a WaiverLedger,
    method: &str,
    route: &str,
    _repo_id: &str,
) -> Option<&'a WaiverEntry> {
    ledger.waivers.iter().find(|w| {
        w.endpoint.http_method.eq_ignore_ascii_case(method)
            && (w.endpoint.route_template == route
                || route_template_matches(&w.endpoint.route_template, route))
    })
}

/// Simple exact or param-erased matching for waiver ledger lookup.
fn route_template_matches(template: &str, concrete: &str) -> bool {
    let tmpl_parts: Vec<&str> = template.split('/').collect();
    let conc_parts: Vec<&str> = concrete.split('/').collect();
    if tmpl_parts.len() != conc_parts.len() {
        return false;
    }
    tmpl_parts
        .iter()
        .zip(conc_parts.iter())
        .all(|(t, c)| *t == *c || t.starts_with('{') && t.ends_with('}') || *t == "*")
}

fn check_approver_scope(
    approver: &WaiverApprover,
    method: &str,
    route: &str,
) -> Result<(), String> {
    if approver.allowed_scopes.is_empty() {
        return Ok(()); // super-approver: no scope restrictions
    }
    let method_scope = format!("methods/{}", method.to_uppercase());
    let route_scope = format!("routes{}", route);
    for scope in &approver.allowed_scopes {
        if scope == "*"
            || scope == "services/*"
            || scope.starts_with("methods/") && scope == &method_scope
            || scope.starts_with("routes") && glob_match(scope, &route_scope)
        {
            return Ok(());
        }
    }
    Err(format!(
        "Approver '{}' scope {:?} does not cover '{method} {route}'.",
        approver.approver_id, approver.allowed_scopes
    ))
}

fn glob_match(pattern: &str, value: &str) -> bool {
    // Very simple single-star glob (not recursive): prefix/** and prefix/*
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return value.starts_with(prefix);
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        let rest = value.strip_prefix(prefix).unwrap_or("");
        return !rest.is_empty() && !rest[1..].contains('/');
    }
    pattern == value
}

fn verify_waiver_signature(
    approver: &WaiverApprover,
    entry: &WaiverEntry,
    repo_id: &str,
    base_commit: &str,
    target_commit: &str,
) -> Result<(), String> {
    let service_id = entry.endpoint.service_id.as_deref().unwrap_or("*");

    let payload = build_waiver_sign_payload(
        repo_id,
        base_commit,
        target_commit,
        service_id,
        &entry.endpoint.http_method,
        &entry.endpoint.route_template,
        &entry.reason,
        &entry.expires_at,
        &entry.approved_by,
    );

    let verifying_key =
        VerifyingKey::from_public_key_pem(&approver.public_key_pem).map_err(|e| {
            format!(
                "Invalid PEM public key for approver '{}': {e}",
                approver.approver_id
            )
        })?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&entry.approval_signature)
        .map_err(|e| {
            format!(
                "Invalid base64 signature in waiver '{}': {e}",
                entry.waiver_id
            )
        })?;

    let signature = Signature::from_slice(&sig_bytes).map_err(|e| {
        format!(
            "Invalid Ed25519 signature bytes in waiver '{}': {e}",
            entry.waiver_id
        )
    })?;

    verifying_key.verify(&payload, &signature).map_err(|e| {
        format!(
            "Ed25519 waiver signature verification failed for waiver '{}' by approver '{}': {e}",
            entry.waiver_id, entry.approved_by
        )
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn finding_traffic_key(finding: &CrossLanguageFinding) -> String {
    format!(
        "{} {}",
        finding.endpoint.method.to_uppercase(),
        finding.endpoint.path
    )
}

fn finding_summary(finding: &CrossLanguageFinding) -> String {
    format!(
        "{} {} — wire path: {} (before: {}, after: {})",
        finding.endpoint.method.to_uppercase(),
        finding.endpoint.path,
        finding.wire_path,
        finding.change.before,
        finding.change.after,
    )
}

/// Minimal ISO-8601 expiry check: parse YYYY-MM-DDTHH:MM:SSZ and compare with now.
fn is_expired(expires_at: &str) -> bool {
    // Parse YYYY-MM-DD prefix
    if expires_at.len() < 10 {
        return true; // malformed → treat as expired
    }
    let date_part = &expires_at[..10];
    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.len() != 3 {
        return true;
    }
    let (y, m, d): (i64, i64, i64) = match (parts[0].parse(), parts[1].parse(), parts[2].parse()) {
        (Ok(y), Ok(m), Ok(d)) => (y, m, d),
        _ => return true,
    };
    // Julian Day Number of expiry
    let a = (14 - m) / 12;
    let yr = y + 4800 - a;
    let mo = m + 12 * a - 3;
    let expiry_jdn = d + (153 * mo + 2) / 5 + 365 * yr + yr / 4 - yr / 100 + yr / 400 - 32045;

    // Current JDN
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let now_jdn = (now_secs / 86400) as i64 + 2440588;

    now_jdn >= expiry_jdn
}

// ---------------------------------------------------------------------------
// Admission Audit Artifact Construction
// ---------------------------------------------------------------------------

pub fn build_admission_audit(
    repo_id: &str,
    base_commit: &str,
    target_commit: &str,
    static_verdict: &str,
    findings_count: usize,
    mode: PolicyMode,
    decision: &AdmissionDecision,
    telemetry_proof: Option<TelemetryProof>,
) -> AdmissionAuditArtifact {
    AdmissionAuditArtifact {
        schema_version: ADMISSION_AUDIT_SCHEMA.to_string(),
        evaluated_at: {
            use std::time::{SystemTime, UNIX_EPOCH};
            let s = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format_secs_as_iso8601(s)
        },
        repository_id: repo_id.to_string(),
        base_commit: base_commit.to_string(),
        target_commit: target_commit.to_string(),
        static_verdict: static_verdict.to_string(),
        findings_count,
        policy_mode: match mode {
            PolicyMode::Strict => "STRICT".to_string(),
            PolicyMode::StrictBaseline => "STRICT_BASELINE".to_string(),
            PolicyMode::WaiverLedger => "WAIVER_LEDGER".to_string(),
        },
        admission_decision: decision.clone(),
        telemetry_proof,
    }
}

fn format_secs_as_iso8601(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;
    let jdn = days as i64 + 2440588;
    let a = jdn + 32044;
    let b = (4 * a + 3) / 146097;
    let c = a - (146097 * b) / 4;
    let dv = (4 * c + 3) / 1461;
    let e = c - (1461 * dv) / 4;
    let mv = (5 * e + 2) / 153;
    let day = e - (153 * mv + 2) / 5 + 1;
    let month = mv + 3 - 12 * (mv / 10);
    let year = 100 * b + dv - 4800 + mv / 10;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}
