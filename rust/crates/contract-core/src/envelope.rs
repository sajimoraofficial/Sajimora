//! envelope.rs — Contract Artifact Envelope DTOs, integrity sealing, and verification.
//!
//! Mirrors ContractArtifactEnvelope.ts exactly.
//!
//! Key behavior (frozen in R0.6.2):
//! - sealEnvelope: sets integrity.sha256 using canonical_json with integrity=null, signature deleted
//! - verifyEnvelopeIntegrity: recomputes digest, compares to stored integrity.sha256
//! - ArtifactComparisonVerdict: ANALYSIS_ERROR > LIKELY_VIOLATED > INCONCLUSIVE > LIKELY_PRESERVED

use crate::canonical::compute_canonical_digest;
use crate::ir::EndpointContract;
use crate::report::SCHEMA_VERSION;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Envelope schema version
// ---------------------------------------------------------------------------

pub const ARTIFACT_ENVELOPE_VERSION: &str = "SAJIMORA_CONTRACT_ARTIFACT_V1";
pub const ARTIFACT_ENVELOPE_VERSION_V2: &str = "SAJIMORA_CONTRACT_ARTIFACT_V2";
pub const ARTIFACT_MANIFEST_VERSION_V2: &str = "SAJIMORA_MANIFEST_V2";

/// Provider lanes an artifact may declare as its `frameworkProfile`. Admission
/// rejects anything else, so a lane cannot be silently mislabelled.
pub const FRAMEWORK_SPRING_MVC: &str = "SPRING_MVC";
pub const FRAMEWORK_NESTJS: &str = "NESTJS";

// ---------------------------------------------------------------------------
// Producer kind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactKind {
    #[serde(rename = "BACKEND_CONTRACT")]
    BackendContract,
    #[serde(rename = "FRONTEND_CONTRACT")]
    FrontendContract,
}

// ---------------------------------------------------------------------------
// Extraction profile
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionProfile {
    pub tool_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_profile: Option<String>,
    /// null if not captured. A missing fingerprint is an incomplete-export blocker.
    pub config_fingerprint: Option<String>,
}

// ---------------------------------------------------------------------------
// Snapshot reference
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSnapshotRef {
    pub repository_id: String,
    pub service_id: String,
    pub api_version: Option<String>,
    pub parent_commit: String,
    pub candidate_snapshot: String,
    /// Deployment identity for replay/rollback protection (spec §3.3).
    /// Absent in V1 artifacts; admission ignores replay checks when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    /// Declared deployment environment (e.g. "prod", "staging") bound against
    /// signer authorization scope (spec §3.2). Absent in V1 artifacts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCompleteness {
    pub complete: bool,
    pub unresolved_endpoints: Vec<String>,
    pub blockers: Vec<ArtifactBlocker>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlocker {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendContractPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serialization_assumptions: Option<Vec<String>>,
    #[serde(default)]
    pub base_urls: Vec<String>,
    #[serde(default)]
    pub proxy_prefixes: Vec<String>,
    pub endpoints: Vec<EndpointContract>,
    #[serde(rename = "type_pool", default, skip_serializing_if = "Option::is_none")]
    pub type_pool: Option<std::collections::BTreeMap<String, crate::ir::WireType>>,
    #[serde(rename = "path_pool", default, skip_serializing_if = "Option::is_none")]
    pub path_pool: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendContractPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_context: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interceptor_evidence: Option<serde_json::Value>,
    pub client_contracts: Vec<FrontendClientContract>,
    #[serde(rename = "type_pool", default, skip_serializing_if = "Option::is_none")]
    pub type_pool: Option<std::collections::BTreeMap<String, crate::ir::WireType>>,
    #[serde(rename = "path_pool", default, skip_serializing_if = "Option::is_none")]
    pub path_pool: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecoderKind {
    #[serde(rename = "ZOD_STRICT")]
    ZodStrict,
    #[serde(rename = "ZOD_PASSTHROUGH")]
    ZodPassthrough,
    #[serde(rename = "ZOD_DEFAULT")]
    ZodDefault,
    #[serde(rename = "TYPE_ASSERTION")]
    TypeAssertion,
    #[serde(rename = "INFERRED_TYPE")]
    InferredType,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerLocation {
    pub file: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub usage: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendClientContract {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_service_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumer_traversal_complete: Option<bool>,
    pub http_method: String,
    pub normalized_route: String,
    pub request_body: Option<crate::ir::WireType>,
    pub expected_response: crate::ir::WireType,
    pub decoder_kind: DecoderKind,
    pub consumers: Vec<ConsumerLocation>,
    pub unresolved_evidence: Vec<String>,
    /// What an untyped client statically reads from the response. Never a shape claim;
    /// absent when the response type was declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_response: Option<crate::ir::ObservedResponseEvidence>,
    /// What an untyped client statically sends in the request body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_request_body: Option<crate::ir::ObservedRequestBody>,
    pub source_file: String,
    pub source_line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArtifactPayload {
    Backend(BackendContractPayload),
    Frontend(FrontendContractPayload),
}

// ---------------------------------------------------------------------------
// Integrity seal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactIntegrity {
    pub sha256: String,
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ContractArtifactEnvelope {
    pub envelope_version: String,
    pub report_schema_version: String,
    pub kind: ArtifactKind,
    pub snapshot: ArtifactSnapshotRef,
    pub profile: ExtractionProfile,
    pub completeness: ArtifactCompleteness,
    /// None only during construction before sealing.
    pub integrity: Option<ArtifactIntegrity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Unix-epoch seconds at issuance. Required for `V2_ENVELOPE` domain-separated
    /// signatures (spec §1.2); absent in V1 artifacts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued_at_unix: Option<u64>,
    pub payload: ArtifactPayload,
    #[serde(skip)]
    pub raw_value: Option<Value>,
}

// ---------------------------------------------------------------------------
// Envelope V2 Manifest Data Structures (signing_spec.md)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardDescriptor {
    pub path: String,
    pub sha256: String,
    pub byte_length: u64,
}

pub type ManifestShard = ShardDescriptor;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSignature {
    pub algorithm: String,
    pub public_key_id: String,
    pub signature_value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsignedManifest {
    pub envelope_version: String,
    pub repository_id: String,
    pub revision: String,
    pub created_at: String,
    pub shards: Vec<ShardDescriptor>,
    pub root_type_pool: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedManifest {
    pub envelope_version: String,
    pub repository_id: String,
    pub revision: String,
    pub created_at: String,
    pub shards: Vec<ShardDescriptor>,
    pub root_type_pool: Value,
    pub signature: ManifestSignature,
}

impl SignedManifest {
    pub fn to_unsigned(&self) -> UnsignedManifest {
        UnsignedManifest {
            envelope_version: self.envelope_version.clone(),
            repository_id: self.repository_id.clone(),
            revision: self.revision.clone(),
            created_at: self.created_at.clone(),
            shards: self.shards.clone(),
            root_type_pool: self.root_type_pool.clone(),
        }
    }
}

/// Produce RFC 8785 canonical JSON bytes for an `UnsignedManifest`.
pub fn canonical_manifest_bytes(unsigned: &UnsignedManifest) -> Result<Vec<u8>> {
    let val = serde_json::to_value(unsigned)
        .map_err(|e| anyhow::anyhow!("failed to serialize unsigned manifest: {e}"))?;
    Ok(crate::canonical::canonical_json(&val).into_bytes())
}

/// Compute SHA-256 digest of the canonical JSON representation of an `UnsignedManifest`.
/// Returns 64 lowercase hexadecimal characters.
pub fn compute_manifest_digest(unsigned: &UnsignedManifest) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = canonical_manifest_bytes(unsigned)?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

/// Construct the length-prefixed Ed25519 V2 sign payload buffer per `signing_spec.md`.
///
/// Format:
///   "SAJIMORA-ED25519-V2-MANIFEST\n"
///   + decimal_len(repo_id_utf8) + ":" + repo_id_utf8 + "\n"
///   + decimal_len(revision_utf8) + ":" + revision_utf8 + "\n"
///   + decimal_len(envelope_version_utf8) + ":" + envelope_version_utf8 + "\n"
///   + "sha256:" + manifest_digest_hex_utf8 + "\n"
pub fn build_sign_payload(
    repo_id: &str,
    revision: &str,
    envelope_version: &str,
    manifest_digest_hex: &str,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"SAJIMORA-ED25519-V2-MANIFEST\n");

    let repo_bytes = repo_id.as_bytes();
    payload.extend_from_slice(format!("{}:", repo_bytes.len()).as_bytes());
    payload.extend_from_slice(repo_bytes);
    payload.push(b'\n');

    let rev_bytes = revision.as_bytes();
    payload.extend_from_slice(format!("{}:", rev_bytes.len()).as_bytes());
    payload.extend_from_slice(rev_bytes);
    payload.push(b'\n');

    let ver_bytes = envelope_version.as_bytes();
    payload.extend_from_slice(format!("{}:", ver_bytes.len()).as_bytes());
    payload.extend_from_slice(ver_bytes);
    payload.push(b'\n');

    payload.extend_from_slice(format!("sha256:{manifest_digest_hex}\n").as_bytes());
    payload
}

// ---------------------------------------------------------------------------
// Envelope signing payload (spec §1.2 — domain-separated, length-prefixed)
// ---------------------------------------------------------------------------

/// Domain header for the V2 envelope signing payload: 28 ASCII chars + `'\n'`
/// = 29 bytes (spec §1.2).
pub const ENVELOPE_SIGN_DOMAIN_HEADER: &[u8] = b"SAJIMORA-ED25519-V2-ENVELOPE\n";

/// Construct the domain-separated, length-prefixed Ed25519 sign payload for a
/// contract artifact envelope (spec §1.2).
///
/// The signature never covers the raw digest string; it covers this buffer:
/// ```text
/// [ Domain Header ]     "SAJIMORA-ED25519-V2-ENVELOPE\n"  (29 bytes)
/// [ Digest Length ]     uint32_be(len(sha256_hex))        (4 bytes; 64 for hex)
/// [ Digest Payload ]    UTF-8 bytes of sha256_hex
/// [ Repository ID Len ] uint32_be(len(repository_id))     (4 bytes)
/// [ Repository ID ]     UTF-8 bytes of repository_id
/// [ Service ID Len ]    uint32_be(len(service_id))        (4 bytes)
/// [ Service ID ]        UTF-8 bytes of service_id
/// [ Issued At ]         uint64_be(unix_epoch_seconds)     (8 bytes)
/// ```
pub fn build_envelope_sign_payload(
    repository_id: &str,
    service_id: &str,
    sha256_hex: &str,
    issued_at_unix: u64,
) -> Vec<u8> {
    debug_assert_eq!(ENVELOPE_SIGN_DOMAIN_HEADER.len(), 29);
    let mut payload = Vec::with_capacity(
        ENVELOPE_SIGN_DOMAIN_HEADER.len()
            + 4
            + sha256_hex.len()
            + 4
            + repository_id.len()
            + 4
            + service_id.len()
            + 8,
    );
    payload.extend_from_slice(ENVELOPE_SIGN_DOMAIN_HEADER);

    let digest = sha256_hex.as_bytes();
    payload.extend_from_slice(&(digest.len() as u32).to_be_bytes());
    payload.extend_from_slice(digest);

    let repo = repository_id.as_bytes();
    payload.extend_from_slice(&(repo.len() as u32).to_be_bytes());
    payload.extend_from_slice(repo);

    let service = service_id.as_bytes();
    payload.extend_from_slice(&(service.len() as u32).to_be_bytes());
    payload.extend_from_slice(service);

    payload.extend_from_slice(&issued_at_unix.to_be_bytes());
    payload
}

// ---------------------------------------------------------------------------
// Canonicalization and digest
// ---------------------------------------------------------------------------

/// Compute the SHA-256 integrity digest for an envelope.
///
/// The envelope is serialized with `integrity` set to `null` and `signature`
/// omitted, then hashed using canonical_json.
///
/// Exactly mirrors TypeScript computeEnvelopeDigest():
///   const forDigest = { ...envelope, integrity: null };
///   delete forDigest['signature'];
///   return sha256(canonicalJson(forDigest))
pub fn compute_envelope_digest(envelope: &ContractArtifactEnvelope) -> Result<String> {
    if let Some(ref raw) = envelope.raw_value {
        return compute_envelope_digest_from_value(raw.clone());
    }

    // Serialize to a serde_json Value first.
    let v: Value = serde_json::to_value(envelope)
        .map_err(|e| anyhow::anyhow!("envelope serialization failed: {e}"))?;

    compute_envelope_digest_from_value(v)
}

/// Compute envelope digest directly from a parsed JSON Value, preserving any
/// unknown fields that were present in the source JSON.
pub fn compute_envelope_digest_from_value(mut v: Value) -> Result<String> {
    let obj = v
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("envelope did not serialize to object"))?;

    // Set integrity to null (not removed — this is the frozen R0 spec).
    obj.insert("integrity".to_string(), Value::Null);

    // Remove signature entirely.
    obj.remove("signature");

    Ok(compute_canonical_digest(&v))
}

/// Seal an envelope by computing and embedding the SHA-256 integrity digest.
/// Returns a new envelope with `integrity` set.
pub fn seal_envelope(mut envelope: ContractArtifactEnvelope) -> Result<ContractArtifactEnvelope> {
    let digest = compute_envelope_digest(&envelope)?;
    envelope.integrity = Some(ArtifactIntegrity { sha256: digest });
    Ok(envelope)
}

/// Verify the integrity digest of a sealed envelope.
/// Returns true if the digest matches, false otherwise.
/// Returns Err if `integrity` is None (envelope was not sealed).
pub fn verify_envelope_integrity(envelope: &ContractArtifactEnvelope) -> Result<bool> {
    let stored = envelope.integrity.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "ContractArtifactEnvelope: integrity field is null; envelope was not sealed."
        )
    })?;

    let expected = if let Some(ref raw) = envelope.raw_value {
        compute_envelope_digest_from_value(raw.clone())?
    } else {
        compute_envelope_digest(envelope)?
    };

    Ok(stored.sha256 == expected)
}

/// Parse an envelope from a JSON byte slice.
/// Validates discriminant fields. Does NOT verify integrity — call
/// `verify_envelope_integrity` separately after parsing.
pub fn parse_envelope(json: &[u8]) -> Result<ContractArtifactEnvelope> {
    let json_str = std::str::from_utf8(json)
        .map_err(|e| anyhow::anyhow!("envelope JSON is not valid UTF-8: {e}"))?;

    // Reject duplicate keys at admission (R1 requirement)
    crate::canonical::check_no_duplicate_keys(json_str)?;

    let val: Value = serde_json::from_str(json_str)
        .map_err(|e| anyhow::anyhow!("envelope JSON parse error: {e}"))?;

    let mut envelope: ContractArtifactEnvelope = serde_json::from_value(val.clone())
        .map_err(|e| anyhow::anyhow!("envelope schema error: {e}"))?;

    envelope.raw_value = Some(val);

    if envelope.envelope_version != ARTIFACT_ENVELOPE_VERSION
        && envelope.envelope_version != ARTIFACT_ENVELOPE_VERSION_V2
    {
        bail!(
            "envelope version mismatch: expected {:?} or {:?}, got {:?}",
            ARTIFACT_ENVELOPE_VERSION,
            ARTIFACT_ENVELOPE_VERSION_V2,
            envelope.envelope_version
        );
    }
    if envelope.report_schema_version != SCHEMA_VERSION {
        bail!(
            "report schema version mismatch: expected {:?}, got {:?}",
            SCHEMA_VERSION,
            envelope.report_schema_version
        );
    }

    Ok(envelope)
}

// ---------------------------------------------------------------------------
// Verdict precedence (mirrors ContractArtifactEnvelope.ts lines 389-431)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactComparisonVerdict {
    #[serde(rename = "LIKELY_VIOLATED")]
    LikelyViolated,
    #[serde(rename = "LIKELY_PRESERVED")]
    LikelyPreserved,
    #[serde(rename = "INCONCLUSIVE")]
    Inconclusive,
    #[serde(rename = "ANALYSIS_ERROR")]
    AnalysisError,
}

impl ArtifactComparisonVerdict {
    fn rank(self) -> u8 {
        match self {
            ArtifactComparisonVerdict::AnalysisError => 3,
            ArtifactComparisonVerdict::LikelyViolated => 2,
            ArtifactComparisonVerdict::Inconclusive => 1,
            ArtifactComparisonVerdict::LikelyPreserved => 0,
        }
    }

    pub fn merge(self, other: ArtifactComparisonVerdict) -> ArtifactComparisonVerdict {
        if self.rank() >= other.rank() {
            self
        } else {
            other
        }
    }
}

/// Determine overall verdict from per-obligation verdicts plus completeness.
/// LIKELY_PRESERVED is prohibited when completeness.complete == false.
pub fn resolve_overall_verdict(
    per_obligation: impl IntoIterator<Item = ArtifactComparisonVerdict>,
    completeness: &ArtifactCompleteness,
) -> ArtifactComparisonVerdict {
    let merged = per_obligation
        .into_iter()
        .fold(ArtifactComparisonVerdict::LikelyPreserved, |acc, v| {
            acc.merge(v)
        });
    // Prohibit LIKELY_PRESERVED when extraction was incomplete.
    if merged == ArtifactComparisonVerdict::LikelyPreserved && !completeness.complete {
        return ArtifactComparisonVerdict::Inconclusive;
    }
    merged
}

#[allow(non_snake_case)]
pub fn sealEnvelope(envelope: ContractArtifactEnvelope) -> Result<ContractArtifactEnvelope> {
    seal_envelope(envelope)
}

#[allow(non_snake_case)]
pub fn verifyEnvelopeIntegrity(envelope: &ContractArtifactEnvelope) -> Result<bool> {
    verify_envelope_integrity(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::SCHEMA_VERSION;

    fn make_test_envelope() -> ContractArtifactEnvelope {
        ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::BackendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: "github.com/org/repo".to_string(),
                service_id: "orders-service".to_string(),
                api_version: None,
                parent_commit: "abc123".to_string(),
                candidate_snapshot: "def456".to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.10.0".to_string(),
                framework_profile: Some("SPRING_MVC".to_string()),
                codec_profile: None,
                client_profile: None,
                config_fingerprint: None,
            },
            completeness: ArtifactCompleteness {
                complete: true,
                unresolved_endpoints: vec![],
                blockers: vec![],
            },
            integrity: None,
            signature: None,
            issued_at_unix: None,
            payload: ArtifactPayload::Backend(BackendContractPayload {
                serialization_assumptions: None,
                base_urls: vec!["https://api.example.com".to_string()],
                proxy_prefixes: vec![],
                endpoints: vec![],
                type_pool: None,
                path_pool: None,
            }),
            raw_value: None,
        }
    }

    #[test]
    fn seal_and_verify() {
        let envelope = make_test_envelope();
        let sealed = seal_envelope(envelope).expect("seal_envelope failed");
        assert!(sealed.integrity.is_some());
        let verified = verify_envelope_integrity(&sealed).expect("verify failed");
        assert!(verified, "integrity should match after sealing");
    }

    #[test]
    fn tampered_payload_fails_verify() {
        let envelope = make_test_envelope();
        let mut sealed = seal_envelope(envelope).expect("seal_envelope failed");
        // Tamper with the payload
        sealed.snapshot.repository_id = "tampered".to_string();
        let verified = verify_envelope_integrity(&sealed).expect("verify failed");
        assert!(!verified, "tampered envelope should fail integrity check");
    }

    #[test]
    fn verdict_precedence_analysis_error_wins() {
        use ArtifactComparisonVerdict::*;
        assert_eq!(AnalysisError.merge(LikelyViolated), AnalysisError);
        assert_eq!(LikelyViolated.merge(Inconclusive), LikelyViolated);
        assert_eq!(Inconclusive.merge(LikelyPreserved), Inconclusive);
    }

    #[test]
    fn incomplete_artifact_upgrades_preserved_to_inconclusive() {
        let completeness = ArtifactCompleteness {
            complete: false,
            unresolved_endpoints: vec!["GET /orders".to_string()],
            blockers: vec![],
        };
        use ArtifactComparisonVerdict::*;
        let result = resolve_overall_verdict([LikelyPreserved], &completeness);
        assert_eq!(result, Inconclusive);
    }

    #[test]
    fn complete_artifact_allows_likely_preserved() {
        let completeness = ArtifactCompleteness {
            complete: true,
            unresolved_endpoints: vec![],
            blockers: vec![],
        };
        use ArtifactComparisonVerdict::*;
        let result = resolve_overall_verdict([LikelyPreserved], &completeness);
        assert_eq!(result, LikelyPreserved);
    }
}
