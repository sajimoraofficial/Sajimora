//! types.rs — Canonical Telemetry Artifact Types.
//!
//! Provides deterministic data structures for:
//! - JaCoCo branch and line coverage
//! - OpenTelemetry endpoint observation counts and status code frequencies
//! - Sealed artifact envelope with SHA-256 integrity digest
//! - Production hit-count envelopes (SAJIMORA_HIT_TELEMETRY_V1)
//!   with Two-Tier trust model (Advisory Local vs Certified Production).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Hit-Count Telemetry schema identifier
// ---------------------------------------------------------------------------

pub const HIT_TELEMETRY_SCHEMA_V1: &str = "SAJIMORA_HIT_TELEMETRY_V1";

// ---------------------------------------------------------------------------
// Two-Tier Trust Model
// ---------------------------------------------------------------------------

/// Tracks how the telemetry file was authenticated.
///
/// Only [`TelemetryTrustLevel::CertifiedProduction`] telemetry with a
/// sufficient observation window may be used for waiver evaluation.
/// [`TelemetryTrustLevel::AdvisoryLocal`] telemetry is valid for terminal
/// visualization and dashboard badges ONLY — never for CI waivers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "tier", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TelemetryTrustLevel {
    /// Tier A: SHA-256 integrity check only. Cannot authorize admission waivers.
    AdvisoryLocal { sha256_verified: bool },
    /// Tier B: Ed25519 digital signature verified against a `TrustedProducer`.
    /// Eligible for waiver evaluation subject to the 6-point Waiver Safety Invariant.
    CertifiedProduction {
        key_id: String,
        producer_id: String,
        signed_at: String,
    },
}

impl TelemetryTrustLevel {
    /// Returns true only for Certified Production telemetry.
    pub fn is_certified(&self) -> bool {
        matches!(self, TelemetryTrustLevel::CertifiedProduction { .. })
    }
}

// ---------------------------------------------------------------------------
// Observation Window
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationWindow {
    pub start: String,
    pub end: String,
    pub duration_days: u32,
}

// ---------------------------------------------------------------------------
// Traffic Tier Classification
// ---------------------------------------------------------------------------

/// Reason an endpoint is marked untracked when traffic would be zero or absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrafficTierUntracked {
    /// Route was not present in the telemetry payload at all.
    AbsentFromPayload,
    /// Route matched more than one backend template with equal specificity.
    AmbiguousRouteCollision,
    /// Telemetry is unsigned (Tier A) or window too short for waiver eligibility.
    UnauthenticatedOrInsufficientWindow,
    /// Telemetry window end is older than the maximum staleness threshold.
    WindowStale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrafficTier {
    /// > 100 requests/day (critical production path).
    HighVolume,
    /// 1–100 requests/day.
    ModerateVolume,
    /// > 0 but < 1 request/day.
    LowVolume,
    /// Exactly 0 requests in a **Certified** observation window ≥ 90 days.
    ZeroObserved,
    /// Route not tracked or authentication insufficient.
    Untracked(TrafficTierUntracked),
}

// ---------------------------------------------------------------------------
// Route Hit Summary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHitSummary {
    pub http_method: String,
    /// Raw path as supplied in the telemetry payload.
    pub raw_path: String,
    pub total_requests: u64,
    pub requests_per_day: f64,
    pub error_count_5xx: u64,
    pub traffic_tier: TrafficTier,
}

// ---------------------------------------------------------------------------
// Ed25519 Signature block
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySignature {
    pub key_id: String,
    pub producer_id: String,
    pub signed_at: String,
    pub signature_base64: String,
}

// ---------------------------------------------------------------------------
// HitCountEnvelope — output of the ingestion pipeline
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitCountEnvelope {
    pub schema_version: String,
    pub source_identity: String,
    pub collected_at: String,
    pub observation_window: ObservationWindow,
    pub trust_level: TelemetryTrustLevel,
    pub routes: Vec<RouteHitSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<TelemetrySignature>,
}

pub const TELEMETRY_ARTIFACT_VERSION_V1: &str = "SAJIMORA_TELEMETRY_ARTIFACT_V1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryArtifactEnvelope {
    pub envelope_version: String,
    pub service_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    pub created_at: String,
    pub coverage: BTreeMap<String, FileCoverage>,
    pub span_summaries: Vec<EndpointTelemetrySummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<TelemetryIntegrity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryIntegrity {
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCoverage {
    pub covered_lines: Vec<u32>,
    pub missed_lines: Vec<u32>,
    pub total_lines: u32,
    pub line_coverage_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTelemetrySummary {
    pub http_method: String,
    pub normalized_route: String,
    pub observation_count: u64,
    pub status_codes: BTreeMap<u16, u64>,
}

/// Compute canonical SHA-256 digest of a TelemetryArtifactEnvelope without its integrity field.
pub fn compute_telemetry_digest(env: &TelemetryArtifactEnvelope) -> Result<String> {
    let mut unsigned = env.clone();
    unsigned.integrity = None;
    let canonical_json = serde_json::to_string(&unsigned)
        .map_err(|e| anyhow!("Failed to serialize telemetry envelope: {}", e))?;
    let hash = Sha256::digest(canonical_json.as_bytes());
    Ok(hex::encode(hash))
}

/// Verify integrity of a sealed TelemetryArtifactEnvelope.
pub fn verify_telemetry_integrity(env: &TelemetryArtifactEnvelope) -> Result<bool> {
    let claimed = match &env.integrity {
        Some(i) => &i.sha256,
        None => return Ok(false),
    };
    let computed = compute_telemetry_digest(env)?;
    Ok(claimed == &computed)
}
