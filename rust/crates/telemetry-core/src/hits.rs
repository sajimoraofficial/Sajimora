//! hits.rs — Production Hit-Count Ingestion Engine (Phase 1).
//!
//! Ingests `prod-counts.json` (SAJIMORA_HIT_TELEMETRY_V1) and `prod-counts.csv`
//! into a validated, normalized `HitCountEnvelope`.
//!
//! ## Trust Tiers
//! - **Tier A (AdvisoryLocal)**: SHA-256 integrity check only. Cannot authorize
//!   any admission waiver. Used for local developer triage and terminal badges.
//! - **Tier B (CertifiedProduction)**: Ed25519 signature verified against a
//!   caller-supplied `ArtifactTrustPolicy`. Required for any waiver evaluation.
//!
//! ## Fail-Closed Invariants
//! - Missing, unparseable, or expired telemetry → `TrafficTier::Untracked`.
//! - SHA-256 mismatch → `HitIngestError::IntegrityFailed`.
//! - Ed25519 verification failure → `HitIngestError::SignatureVerificationFailed`.
//! - Revoked key → `HitIngestError::RevokedKey`.
//! - Window < minimum days → routes cannot qualify for waiver evaluation.

use crate::types::{
    HitCountEnvelope, ObservationWindow, RouteHitSummary, TelemetrySignature, TelemetryTrustLevel,
    TrafficTier, TrafficTierUntracked, HIT_TELEMETRY_SCHEMA_V1,
};
use anyhow::Result;
use contract_core::admission::{ArtifactTrustPolicy, TrustedProducer};
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Ingest Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum HitIngestError {
    #[error("Telemetry file is not parseable: {0}")]
    ParseError(String),
    #[error("Schema version mismatch: expected {expected}, got {got}")]
    SchemaMismatch { expected: String, got: String },
    #[error("Missing required field: {0}")]
    MissingField(String),
    #[error("Invalid ISO-8601 timestamp in field '{field}': {value}")]
    InvalidTimestamp { field: String, value: String },
    #[error(
        "Observation window duration inconsistency: declared {declared}d, computed {computed}d"
    )]
    WindowDurationMismatch { declared: u32, computed: i64 },
    #[error("SHA-256 integrity verification failed")]
    IntegrityFailed,
    #[error("Ed25519 signature verification failed: {0}")]
    SignatureVerificationFailed(String),
    #[error("Telemetry signing key is revoked: key_id={key_id}")]
    RevokedKey { key_id: String },
    #[error("Telemetry producer '{producer_id}' is not in trust policy")]
    UnauthorizedProducer { producer_id: String },
    #[error("Observation window too short for waiver evaluation: {days}d < {minimum}d")]
    WindowTooShort { days: u32, minimum: u32 },
    #[error("Telemetry is stale: window ended {end}, now {now}")]
    WindowStale { end: String, now: String },
    #[error("IO error reading telemetry file: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Raw JSON schema for SAJIMORA_HIT_TELEMETRY_V1
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHitTelemetry {
    schema_version: String,
    source_identity: String,
    collected_at: String,
    observation_window: RawObservationWindow,
    routes: Vec<RawRouteHit>,
    /// Optional SHA-256 integrity digest (computed over this JSON sans `integrity`).
    #[serde(skip_serializing_if = "Option::is_none")]
    integrity: Option<RawIntegrity>,
    /// Optional Ed25519 cryptographic signature block.
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<RawSignature>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawObservationWindow {
    start: String,
    end: String,
    duration_days: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRouteHit {
    method: String,
    path: String,
    total_requests: u64,
    #[serde(default)]
    error_count_5xx: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawIntegrity {
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSignature {
    key_id: String,
    producer_id: String,
    signed_at: String,
    signature_base64: String,
}

// ---------------------------------------------------------------------------
// Public ingestion API
// ---------------------------------------------------------------------------

/// Ingest a hit-count file from the given path.
///
/// `policy` is `None` for Tier A (advisory-local) mode. When `None`,
/// only SHA-256 integrity is checked; waivers are structurally unavailable.
///
/// `policy` is `Some(...)` for Tier B (certified-production) mode. The
/// Ed25519 signature in the file is verified against the policy's trusted
/// producers.
///
/// The minimum window duration for waiver eligibility is controlled by
/// `min_window_days_for_waiver` (plan specifies 90 days).
pub fn ingest_hit_counts(
    path: &std::path::Path,
    policy: Option<&ArtifactTrustPolicy>,
    min_window_days_for_waiver: u32,
    max_staleness_days: u32,
) -> Result<HitCountEnvelope, HitIngestError> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext == "csv" {
        ingest_csv(path, policy, min_window_days_for_waiver, max_staleness_days)
    } else {
        ingest_json(path, policy, min_window_days_for_waiver, max_staleness_days)
    }
}

// ---------------------------------------------------------------------------
// JSON Ingestion
// ---------------------------------------------------------------------------

fn ingest_json(
    path: &std::path::Path,
    policy: Option<&ArtifactTrustPolicy>,
    min_window_days_for_waiver: u32,
    max_staleness_days: u32,
) -> Result<HitCountEnvelope, HitIngestError> {
    let raw_bytes = std::fs::read(path)?;
    let raw_str = String::from_utf8_lossy(&raw_bytes).into_owned();

    // Parse
    let raw: RawHitTelemetry =
        serde_json::from_str(&raw_str).map_err(|e| HitIngestError::ParseError(e.to_string()))?;

    // Schema version check
    if raw.schema_version != HIT_TELEMETRY_SCHEMA_V1 {
        return Err(HitIngestError::SchemaMismatch {
            expected: HIT_TELEMETRY_SCHEMA_V1.to_string(),
            got: raw.schema_version,
        });
    }

    // Validate timestamps
    validate_iso8601(&raw.observation_window.start, "observationWindow.start")?;
    validate_iso8601(&raw.observation_window.end, "observationWindow.end")?;
    validate_iso8601(&raw.collected_at, "collectedAt")?;

    // Validate window duration consistency
    let computed_days =
        compute_window_days(&raw.observation_window.start, &raw.observation_window.end)?;
    let declared_days = raw.observation_window.duration_days as i64;
    // Allow ±1 day tolerance for timezone rounding
    if (computed_days - declared_days).abs() > 1 {
        return Err(HitIngestError::WindowDurationMismatch {
            declared: raw.observation_window.duration_days,
            computed: computed_days,
        });
    }

    // Validate staleness
    let staleness = days_since_timestamp(&raw.observation_window.end)?;
    if staleness > max_staleness_days as i64 {
        return Err(HitIngestError::WindowStale {
            end: raw.observation_window.end.clone(),
            now: current_utc_iso8601(),
        });
    }

    // SHA-256 integrity check (both tiers)
    let trust_level =
        verify_integrity_and_signature(&raw_str, &raw.integrity, raw.signature.as_ref(), policy)?;

    // Build normalized route summaries
    let window_days = raw.observation_window.duration_days;
    let routes = raw
        .routes
        .iter()
        .map(|r| build_route_hit_summary(r, window_days, min_window_days_for_waiver, &trust_level))
        .collect::<Vec<_>>();

    Ok(HitCountEnvelope {
        schema_version: raw.schema_version,
        source_identity: raw.source_identity,
        collected_at: raw.collected_at,
        observation_window: ObservationWindow {
            start: raw.observation_window.start,
            end: raw.observation_window.end,
            duration_days: raw.observation_window.duration_days,
        },
        trust_level,
        routes,
        signature: raw.signature.map(|s| TelemetrySignature {
            key_id: s.key_id,
            producer_id: s.producer_id,
            signed_at: s.signed_at,
            signature_base64: s.signature_base64,
        }),
    })
}

// ---------------------------------------------------------------------------
// CSV Ingestion
// ---------------------------------------------------------------------------
// CSV format (with provenance metadata comments):
//
// # schemaVersion=SAJIMORA_HIT_TELEMETRY_V1
// # sourceIdentity=cloudflare:zone-prod:analytics
// # windowStart=2026-07-22T00:00:00Z
// # windowEnd=2026-10-20T00:00:00Z
// # durationDays=90
// # collectedAt=2026-10-20T12:00:00Z
// method,path,totalRequests
// GET,/api/admin/orders,54200
// DELETE,/api/v1/legacy-export,0

fn ingest_csv(
    path: &std::path::Path,
    policy: Option<&ArtifactTrustPolicy>,
    min_window_days_for_waiver: u32,
    max_staleness_days: u32,
) -> Result<HitCountEnvelope, HitIngestError> {
    let content = std::fs::read_to_string(path)?;

    let mut meta: BTreeMap<String, String> = BTreeMap::new();
    let mut data_lines: Vec<&str> = Vec::new();
    let mut header_skipped = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            // Metadata comment line: # key=value
            let kv = trimmed.trim_start_matches('#').trim();
            if let Some((k, v)) = kv.split_once('=') {
                meta.insert(k.trim().to_string(), v.trim().to_string());
            }
        } else if !trimmed.is_empty() {
            if !header_skipped {
                header_skipped = true; // skip "method,path,totalRequests"
            } else {
                data_lines.push(trimmed);
            }
        }
    }

    let schema_version = meta
        .get("schemaVersion")
        .ok_or_else(|| HitIngestError::MissingField("schemaVersion".into()))?
        .clone();
    if schema_version != HIT_TELEMETRY_SCHEMA_V1 {
        return Err(HitIngestError::SchemaMismatch {
            expected: HIT_TELEMETRY_SCHEMA_V1.to_string(),
            got: schema_version,
        });
    }

    let source_identity = meta
        .get("sourceIdentity")
        .ok_or_else(|| HitIngestError::MissingField("sourceIdentity".into()))?
        .clone();
    let window_start = meta
        .get("windowStart")
        .ok_or_else(|| HitIngestError::MissingField("windowStart".into()))?
        .clone();
    let window_end = meta
        .get("windowEnd")
        .ok_or_else(|| HitIngestError::MissingField("windowEnd".into()))?
        .clone();
    let duration_days: u32 = meta
        .get("durationDays")
        .ok_or_else(|| HitIngestError::MissingField("durationDays".into()))?
        .parse()
        .map_err(|_| HitIngestError::MissingField("durationDays (not a number)".into()))?;
    let collected_at = meta
        .get("collectedAt")
        .ok_or_else(|| HitIngestError::MissingField("collectedAt".into()))?
        .clone();

    validate_iso8601(&window_start, "windowStart")?;
    validate_iso8601(&window_end, "windowEnd")?;
    validate_iso8601(&collected_at, "collectedAt")?;

    // Staleness check
    let staleness = days_since_timestamp(&window_end)?;
    if staleness > max_staleness_days as i64 {
        return Err(HitIngestError::WindowStale {
            end: window_end.clone(),
            now: current_utc_iso8601(),
        });
    }

    // CSV has no inline SHA-256 or signature. Force Tier A (advisory only).
    if policy.is_some() {
        // If caller supplied a trust policy for CSV, reject: CSV cannot carry Ed25519.
        return Err(HitIngestError::SignatureVerificationFailed(
            "CSV format does not support Ed25519 signatures. Use JSON format for Tier B certified ingestion.".into()
        ));
    }
    let trust_level = TelemetryTrustLevel::AdvisoryLocal {
        sha256_verified: false,
    };

    // Parse data rows
    let routes = data_lines
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, ',').collect();
            if parts.len() < 3 {
                return None;
            }
            let method = parts[0].trim().to_uppercase();
            let path = parts[1].trim().to_string();
            let total_requests: u64 = parts[2].trim().parse().unwrap_or(0);
            let raw = RawRouteHit {
                method,
                path,
                total_requests,
                error_count_5xx: 0,
            };
            Some(build_route_hit_summary(
                &raw,
                duration_days,
                min_window_days_for_waiver,
                &trust_level,
            ))
        })
        .collect::<Vec<_>>();

    Ok(HitCountEnvelope {
        schema_version,
        source_identity,
        collected_at,
        observation_window: ObservationWindow {
            start: window_start,
            end: window_end,
            duration_days,
        },
        trust_level,
        routes,
        signature: None,
    })
}

// ---------------------------------------------------------------------------
// Integrity & Signature Verification
// ---------------------------------------------------------------------------

fn verify_integrity_and_signature(
    raw_str: &str,
    integrity: &Option<RawIntegrity>,
    signature: Option<&RawSignature>,
    policy: Option<&ArtifactTrustPolicy>,
) -> Result<TelemetryTrustLevel, HitIngestError> {
    // Step 1: Compute canonical SHA-256 over the JSON without the `integrity` field.
    let canonical = strip_integrity_field(raw_str);
    let computed_hex = {
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        hex::encode(hasher.finalize())
    };

    // Step 2: If an integrity block is present, verify it.
    let sha256_verified = if let Some(integ) = integrity {
        if integ.sha256 != computed_hex {
            return Err(HitIngestError::IntegrityFailed);
        }
        true
    } else {
        false
    };

    // Step 3: If no trust policy → Tier A advisory only.
    let Some(policy) = policy else {
        return Ok(TelemetryTrustLevel::AdvisoryLocal { sha256_verified });
    };

    // Step 4: Tier B — require Ed25519 signature.
    let Some(sig) = signature else {
        return Err(HitIngestError::SignatureVerificationFailed(
            "Tier B (certified) mode requires an Ed25519 signature block in the telemetry file."
                .into(),
        ));
    };

    // Step 5: Check revocation list.
    if policy.revoked_key_ids.contains(&sig.key_id) {
        return Err(HitIngestError::RevokedKey {
            key_id: sig.key_id.clone(),
        });
    }

    // Step 6: Find authorized producer.
    let producer = policy
        .producers
        .iter()
        .find(|p| p.repository_id == sig.producer_id || p.service_id == sig.producer_id)
        .ok_or_else(|| HitIngestError::UnauthorizedProducer {
            producer_id: sig.producer_id.clone(),
        })?;

    // Step 7: Verify Ed25519 signature.
    verify_ed25519_signature(producer, &computed_hex, &sig.signature_base64, &sig.key_id)?;

    Ok(TelemetryTrustLevel::CertifiedProduction {
        key_id: sig.key_id.clone(),
        producer_id: sig.producer_id.clone(),
        signed_at: sig.signed_at.clone(),
    })
}

fn verify_ed25519_signature(
    producer: &TrustedProducer,
    canonical_hex_digest: &str,
    signature_b64: &str,
    key_id: &str,
) -> Result<(), HitIngestError> {
    let pem = producer.public_key_pem.as_deref().ok_or_else(|| {
        HitIngestError::SignatureVerificationFailed(format!(
            "Producer '{}' has no public key configured in trust policy",
            producer.service_id
        ))
    })?;

    // Verify claimed key_id matches key in trust policy (DER SPKI SHA-256)
    let verifying_key = VerifyingKey::from_public_key_pem(pem).map_err(|e| {
        HitIngestError::SignatureVerificationFailed(format!("Invalid PEM public key: {e}"))
    })?;
    let spki_bytes = verifying_key.to_bytes();
    let claimed_key_id = format!("sha256:{}", hex::encode(Sha256::digest(&spki_bytes)));
    if let Some(policy_key_id) = &producer.public_key_id {
        if policy_key_id != key_id && claimed_key_id != key_id {
            return Err(HitIngestError::SignatureVerificationFailed(format!(
                "key_id mismatch: file claims '{key_id}', policy has '{policy_key_id}'"
            )));
        }
    }

    // The signed payload is the UTF-8 lowercase hex SHA-256 digest (mirrors build_sign_payload convention)
    let signature_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        signature_b64,
    )
    .map_err(|e| {
        HitIngestError::SignatureVerificationFailed(format!("Invalid base64 signature: {e}"))
    })?;

    let signature = Signature::from_slice(&signature_bytes).map_err(|e| {
        HitIngestError::SignatureVerificationFailed(format!("Invalid Ed25519 signature bytes: {e}"))
    })?;

    use ed25519_dalek::Verifier;
    verifying_key
        .verify(canonical_hex_digest.as_bytes(), &signature)
        .map_err(|e| {
            HitIngestError::SignatureVerificationFailed(format!("Ed25519 signature invalid: {e}"))
        })
}

// ---------------------------------------------------------------------------
// Route Hit Summary Building
// ---------------------------------------------------------------------------

fn build_route_hit_summary(
    raw: &RawRouteHit,
    window_days: u32,
    min_window_days_for_waiver: u32,
    trust_level: &TelemetryTrustLevel,
) -> RouteHitSummary {
    let rpd = if window_days > 0 {
        raw.total_requests as f64 / window_days as f64
    } else {
        0.0
    };

    let tier = classify_traffic_tier(
        raw.total_requests,
        rpd,
        window_days,
        min_window_days_for_waiver,
        trust_level,
    );

    RouteHitSummary {
        http_method: raw.method.to_uppercase(),
        raw_path: raw.path.clone(),
        total_requests: raw.total_requests,
        requests_per_day: rpd,
        error_count_5xx: raw.error_count_5xx,
        traffic_tier: tier,
    }
}

fn classify_traffic_tier(
    total_requests: u64,
    rpd: f64,
    window_days: u32,
    min_window_days_for_waiver: u32,
    trust_level: &TelemetryTrustLevel,
) -> TrafficTier {
    if total_requests == 0 {
        // Zero observed: only CertifiedProduction with sufficient window qualifies as ZeroObserved.
        // Advisory-local zero traffic is NEVER promoted to ZeroObserved.
        match trust_level {
            TelemetryTrustLevel::CertifiedProduction { .. }
                if window_days >= min_window_days_for_waiver =>
            {
                TrafficTier::ZeroObserved
            }
            _ => TrafficTier::Untracked(TrafficTierUntracked::UnauthenticatedOrInsufficientWindow),
        }
    } else if rpd > 100.0 {
        TrafficTier::HighVolume
    } else if rpd >= 1.0 {
        TrafficTier::ModerateVolume
    } else {
        // > 0 but < 1 req/day
        TrafficTier::LowVolume
    }
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/// Strip the `"integrity"` JSON object field from a JSON string for digest computation.
/// Simple approach: reparse, remove, re-serialize (canonical).
fn strip_integrity_field(raw: &str) -> String {
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = v.as_object_mut() {
            obj.remove("integrity");
            obj.remove("signature"); // also strip signature for digest computation
            return serde_json::to_string(obj).unwrap_or_else(|_| raw.to_string());
        }
    }
    raw.to_string()
}

/// Validate that a string is a well-formed ISO-8601/RFC-3339 timestamp.
/// Accepts format: `YYYY-MM-DDTHH:MM:SSZ` or with timezone offset.
fn validate_iso8601(value: &str, field: &str) -> Result<(), HitIngestError> {
    // Minimal structural check: at least 16 chars, contains 'T'
    if value.len() < 16 || !value.contains('T') {
        return Err(HitIngestError::InvalidTimestamp {
            field: field.to_string(),
            value: value.to_string(),
        });
    }
    Ok(())
}

/// Compute days between two ISO-8601 timestamps.
/// Uses simple string parsing for YYYY-MM-DD prefix.
fn compute_window_days(start: &str, end: &str) -> Result<i64, HitIngestError> {
    let start_days =
        iso8601_to_days_since_epoch(start).ok_or_else(|| HitIngestError::InvalidTimestamp {
            field: "observationWindow.start".to_string(),
            value: start.to_string(),
        })?;
    let end_days =
        iso8601_to_days_since_epoch(end).ok_or_else(|| HitIngestError::InvalidTimestamp {
            field: "observationWindow.end".to_string(),
            value: end.to_string(),
        })?;
    Ok(end_days - start_days)
}

fn days_since_timestamp(ts: &str) -> Result<i64, HitIngestError> {
    let ts_days =
        iso8601_to_days_since_epoch(ts).ok_or_else(|| HitIngestError::InvalidTimestamp {
            field: "observationWindow.end".to_string(),
            value: ts.to_string(),
        })?;
    let now_days = unix_epoch_days_now();
    Ok(now_days - ts_days)
}

fn iso8601_to_days_since_epoch(ts: &str) -> Option<i64> {
    // Parse YYYY-MM-DD from the timestamp prefix
    let date_part = &ts[..10]; // "YYYY-MM-DD"
    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    // Simplified Julian Day Number for Gregorian calendar
    let a = (14 - m) / 12;
    let yr = y + 4800 - a;
    let mo = m + 12 * a - 3;
    let jdn = d + (153 * mo + 2) / 5 + 365 * yr + yr / 4 - yr / 100 + yr / 400 - 32045;
    Some(jdn)
}

fn unix_epoch_days_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 86400) as i64 + 2440588 // JDN for 1970-01-01
}

fn current_utc_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal ISO-8601 rendering
    let days = secs / 86400;
    let rem = secs % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;
    // Day → YYYY-MM-DD via reverse Julian Day (epoch = 1970-01-01 = JDN 2440588)
    let jdn = days as i64 + 2440588;
    let (yr, mo, da) = jdn_to_ymd(jdn);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", yr, mo, da, h, m, s)
}

fn jdn_to_ymd(jdn: i64) -> (i64, i64, i64) {
    let a = jdn + 32044;
    let b = (4 * a + 3) / 146097;
    let c = a - (146097 * b) / 4;
    let d = (4 * c + 3) / 1461;
    let e = c - (1461 * d) / 4;
    let m = (5 * e + 2) / 153;
    let day = e - (153 * m + 2) / 5 + 1;
    let month = m + 3 - 12 * (m / 10);
    let year = 100 * b + d - 4800 + m / 10;
    (year, month, day)
}

// (Window duration validation is performed inline in ingest_json using computed_days.)
