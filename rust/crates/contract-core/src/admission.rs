//! admission.rs — Artifact admission and trust policy enforcement.
//!
//! Mirrors ArtifactAdmission.ts exactly.
//!
//! Frozen behavior (R0.6.3):
//! - Trust policy is CALLER-SUPPLIED. Never inferred from artifact contents or path.
//! - Signed bytes: UTF-8 of lowercase hex SHA-256 digest string (NOT raw hash bytes)
//! - Signature: Base64-encoded Ed25519 signature
//! - requireSignatures=true disallows digest-pin bypass
//! - --trusted-local is a server startup decision, not an artifact attribute
//! - Admission checks: schema/profile/integrity, then caller-controlled trust

use crate::envelope::{
    verify_envelope_integrity, ContractArtifactEnvelope, ARTIFACT_ENVELOPE_VERSION,
    ARTIFACT_ENVELOPE_VERSION_V2,
};
use crate::report::SCHEMA_VERSION;
use crate::validation::validate_artifact_fields;
use anyhow::Result;
use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Trust policy
// ---------------------------------------------------------------------------

/// Identifies a trusted artifact producer.
/// Either a public key (for signature verification) or a set of trusted digest
/// pins (for channel-authenticated artifacts) or both.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedProducer {
    pub repository_id: String,
    pub service_id: String,
    /// PEM-encoded Ed25519 public key for signature verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key_pem: Option<String>,
    /// Exact SHA-256 hex digests accepted via channel authentication (e.g. IAM).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_digests: Option<Vec<String>>,
    /// Public key identifier. Either the "sha256:<hex>" form over DER SPKI bytes
    /// or a distinct operator-assigned key id (spec §3.1).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub public_key_id: Option<String>,
    /// DER-encoded SPKI public key hex string.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub public_key_der_hex: Option<String>,
    /// Exclusive Unix-epoch-seconds expiry for this key (spec §3.1 `validUntil`).
    /// Admission at or after this instant fails with `KeyExpired`.
    /// Absent means the key never expires.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub valid_until: Option<i64>,
    /// Environments this key may sign for, e.g. ["prod"] (spec §3.2).
    /// When the artifact declares `snapshot.environment` and this list is
    /// present and non-empty, the declared environment must be a member,
    /// else `UnauthorizedSignerScope`. Absent/empty means unrestricted (legacy).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub environments: Option<Vec<String>>,
    /// Signature payload format this producer's key signs with.
    /// "V1_DIGEST_UTF8" (default, frozen R0.6.3) signs the UTF-8 hex digest
    /// string; "V2_ENVELOPE" signs the domain-separated length-prefixed
    /// buffer from spec §1.2.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub signature_format: Option<String>,
}

/// Signature format: legacy — Ed25519 over the UTF-8 bytes of the lowercase
/// hex SHA-256 digest string (frozen R0.6.3 behavior).
pub const SIGNATURE_FORMAT_V1: &str = "V1_DIGEST_UTF8";
/// Signature format: domain-separated length-prefixed buffer (spec §1.2).
pub const SIGNATURE_FORMAT_V2_ENVELOPE: &str = "V2_ENVELOPE";

fn default_require_signatures() -> bool {
    true
}

/// Artifact trust policy. MUST come from the caller, never from artifact contents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTrustPolicy {
    pub producers: Vec<TrustedProducer>,
    /// If true, digest-pin bypass is disallowed; every artifact must have a
    /// valid Ed25519 signature. Must be explicitly specified or defaults to true in policy JSON.
    #[serde(default = "default_require_signatures", alias = "require_signatures")]
    pub require_signatures: bool,
    /// Set of revoked key IDs (format: "sha256:<hex>").
    /// Checked before any signature verification; a match immediately rejects the artifact.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revoked_key_ids: Vec<String>,
    /// Calendar TTL as an auditable policy limit (spec §2), in days. When the
    /// Evidence Admission Gate runs with an explicit evaluation time, a
    /// candidate artifact whose `issuedAtUnix` age exceeds this threshold draws
    /// an `EvidenceAdvisory::ContractAgeThresholdExceeded` and withholds
    /// `LIKELY_PRESERVED` unless refreshed by a valid deployment liveness
    /// record. A calendar window is not physical proof of obsolescence, so the
    /// pure evaluator itself never consults this limit. `None` disables it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_contract_age_days: Option<u32>,
    /// Authorized human waiver approvers for release admission governance.
    /// Each approver has a scoped Ed25519 key valid for specific service/method patterns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waiver_approvers: Vec<WaiverApprover>,
}

impl Default for ArtifactTrustPolicy {
    fn default() -> Self {
        Self {
            producers: Vec::new(),
            require_signatures: default_require_signatures(),
            revoked_key_ids: Vec::new(),
            max_contract_age_days: None,
            waiver_approvers: Vec::new(),
        }
    }
}

/// An authorized human or automation principal who may sign admission waivers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverApprover {
    /// Human-readable identity (e.g. "lead.architect@enterprise.corp").
    pub approver_id: String,
    /// PEM-encoded Ed25519 public key for waiver signature verification.
    pub public_key_pem: String,
    /// Glob-style scope patterns the approver is authorized for.
    /// Examples: ["services/*"], ["methods/DELETE"], ["services/payments-svc/methods/POST"]
    /// An empty list means no scope restrictions (super-approver).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_scopes: Vec<String>,
    /// Maximum validity period in days from waiver `approvedAt`.
    /// Defaults to 90 days.
    #[serde(default = "default_max_validity_days")]
    pub max_validity_days: u32,
}

fn default_max_validity_days() -> u32 {
    90
}

// ---------------------------------------------------------------------------
// Admission errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("Artifact integrity verification failed.")]
    IntegrityFailed,
    #[error("Invalid artifact trust policy.")]
    InvalidPolicy,
    #[error("Artifact producer is not authorized by trust policy.")]
    UnauthorizedProducer,
    #[error("Artifact requires an authorized signature or a trusted pinned digest.")]
    MissingSignatureOrPin,
    #[error("Artifact signature verification failed.")]
    SignatureVerificationFailed,
    #[error("Artifact schema validation failed: {0}")]
    SchemaValidationFailed(String),
    #[error("Envelope version mismatch: expected {expected:?}, got {got:?}")]
    EnvelopeVersionMismatch { expected: String, got: String },
    #[error("Report schema version mismatch: expected {expected:?}, got {got:?}")]
    SchemaVersionMismatch { expected: String, got: String },
    #[error("Artifact integrity seal is missing (not sealed).")]
    NotSealed,
    #[error("Manifest validation failed: {0}")]
    ManifestValidationFailed(String),
    #[error("Signing key has been revoked by the trust policy.")]
    KeyRevoked,
    #[error("Signing key validity window has closed (validUntil passed).")]
    KeyExpired,
    #[error("Signing key is not authorized for the artifact's declared environment.")]
    UnauthorizedSignerScope,
    #[error("Artifact is missing issuedAtUnix, required for V2_ENVELOPE signature verification.")]
    MissingIssuedAt,
    #[error("Replay proof missing: artifact carries no monotonic deploymentId (spec §3.3).")]
    ReplayProofMissing,
    #[error("Stale deployment rejected: got sequence {got}, latest recorded is {latest}.")]
    StaleDeployment { got: u64, latest: u64 },
    #[error("Baseline descent unproven: candidate parent {got_parent:?} does not descend from recorded head {expected_parent:?}.")]
    BaselineDescentUnproven {
        expected_parent: String,
        got_parent: String,
    },
    #[error("Deployment state ledger is invalid: {0}")]
    DeploymentStateInvalid(String),
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/// Admit an artifact for analysis.
///
/// Checks in order:
/// 1. Schema and profile validation (validateArtifactFields equivalent)
/// 2. Envelope version match
/// 3. Integrity digest verification
/// 4. Producer authorization via trust policy
/// 5. Signature or pin verification
///
/// On success, returns Ok(()). On failure, returns an AdmissionError.
///
/// The `trusted_local` flag is a server startup decision (R4). When true, the
/// trust policy MUST still have an entry for the artifact's producer. The
/// `trusted_local` flag grants that entry's digest-pin bypass even without
/// explicit pinned digests. It does NOT skip integrity or schema checks.
pub fn admit_artifact(
    envelope: &ContractArtifactEnvelope,
    policy: &ArtifactTrustPolicy,
    trusted_local: bool,
) -> Result<(), AdmissionError> {
    admit_artifact_at(envelope, policy, trusted_local, None)
}

/// Admit an artifact with an explicit `evaluation_time_unix` instant (spec §2).
///
/// Freshness-adjacent lifecycle checks (key `validUntil`) belong to the
/// Evidence Admission Gate, which — unlike the pure comparison engine — may
/// consult a clock. When the caller supplies `evaluation_time_unix` the run is
/// fully deterministic; when it is `None` the gate falls back to the wall
/// clock for `validUntil` enforcement only.
pub fn admit_artifact_at(
    envelope: &ContractArtifactEnvelope,
    policy: &ArtifactTrustPolicy,
    trusted_local: bool,
    evaluation_time_unix: Option<u64>,
) -> Result<(), AdmissionError> {
    // 1. Envelope version check
    if envelope.envelope_version != ARTIFACT_ENVELOPE_VERSION
        && envelope.envelope_version != ARTIFACT_ENVELOPE_VERSION_V2
    {
        return Err(AdmissionError::EnvelopeVersionMismatch {
            expected: format!("{ARTIFACT_ENVELOPE_VERSION} or {ARTIFACT_ENVELOPE_VERSION_V2}"),
            got: envelope.envelope_version.clone(),
        });
    }
    if envelope.report_schema_version != SCHEMA_VERSION {
        return Err(AdmissionError::SchemaVersionMismatch {
            expected: SCHEMA_VERSION.to_string(),
            got: envelope.report_schema_version.clone(),
        });
    }

    // 2. Deep schema/field validation
    validate_artifact_fields(envelope)
        .map_err(|e| AdmissionError::SchemaValidationFailed(e.to_string()))?;

    // 3. Integrity digest verification
    let integrity = envelope
        .integrity
        .as_ref()
        .ok_or(AdmissionError::NotSealed)?;

    let digest_ok =
        verify_envelope_integrity(envelope).map_err(|_| AdmissionError::IntegrityFailed)?;
    if !digest_ok {
        return Err(AdmissionError::IntegrityFailed);
    }

    // 4. Producer authorization -- always enforced.
    //    The trust policy MUST have an entry for the artifact's producer.
    let producer = policy
        .producers
        .iter()
        .find(|p| {
            p.repository_id == envelope.snapshot.repository_id
                && p.service_id == envelope.snapshot.service_id
        })
        .ok_or(AdmissionError::UnauthorizedProducer)?;

    // 4a. Revocation (spec §3.1): a revoked key is rejected immediately,
    //     before any signature verification and before the trusted_local bypass.
    if let Some(key_id) = producer_key_id(producer) {
        if policy
            .revoked_key_ids
            .iter()
            .any(|revoked| revoked.eq_ignore_ascii_case(&key_id))
        {
            return Err(AdmissionError::KeyRevoked);
        }
    }

    // 4b. Key validity window (spec §3.1 `validUntil`). Exclusive upper bound:
    //     admission at or after `validUntil` fails, mirroring the waiver rule
    //     ("invalid on or after the timestamp").
    if let Some(valid_until) = producer.valid_until {
        let now_secs = match evaluation_time_unix {
            Some(explicit) => explicit as i64,
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX),
        };
        if now_secs >= valid_until {
            return Err(AdmissionError::KeyExpired);
        }
    }

    // 4c. Environment segregation (spec §3.2): a key authorized for one
    //     environment cannot validate a contract asserting another. Enforcement
    //     triggers when the artifact declares `snapshot.environment` and the
    //     producer declares a non-empty authorized set.
    if let Some(ref declared) = envelope.snapshot.environment {
        if let Some(ref authorized) = producer.environments {
            if !authorized.is_empty() && !authorized.iter().any(|e| e == declared) {
                return Err(AdmissionError::UnauthorizedSignerScope);
            }
        }
    }

    // 5. trusted_local startup decision:
    //    Grants that authorized entry's signature/pin bypass even without explicit pinned digests.
    if trusted_local {
        return Ok(());
    }

    // 5. Signature or pin bypass
    // Mirrors ArtifactAdmission.ts line 15:
    //   if (!policy.requireSignatures && producer.trustedDigests?.includes(e.integrity!.sha256)) return;
    if !policy.require_signatures {
        if let Some(ref pins) = producer.trusted_digests {
            if pins.iter().any(|pin| pin == &integrity.sha256) {
                return Ok(());
            }
        }
    }

    // 6. Signature verification required.
    //    The payload format is declared by the producer entry (out-of-band trust
    //    root, spec §1.3): "V2_ENVELOPE" verifies the domain-separated §1.2
    //    buffer; anything else verifies the frozen V1 hex-digest-UTF-8 format.
    let signature_b64 = envelope
        .signature
        .as_deref()
        .ok_or(AdmissionError::MissingSignatureOrPin)?;

    if producer.signature_format.as_deref() == Some(SIGNATURE_FORMAT_V2_ENVELOPE) {
        let issued_at = envelope
            .issued_at_unix
            .ok_or(AdmissionError::MissingIssuedAt)?;
        let payload = crate::envelope::build_envelope_sign_payload(
            &envelope.snapshot.repository_id,
            &envelope.snapshot.service_id,
            &integrity.sha256,
            issued_at,
        );
        let signature = decode_signature_bytes(signature_b64)?;
        let verifying_key = producer.to_verifying_key()?;
        verifying_key
            .verify_strict(&payload, &signature)
            .map_err(|_| AdmissionError::SignatureVerificationFailed)?;
        return Ok(());
    }

    let public_key_pem = producer
        .public_key_pem
        .as_deref()
        .ok_or(AdmissionError::MissingSignatureOrPin)?;

    verify_ed25519_signature(&integrity.sha256, signature_b64, public_key_pem)
        .map_err(|_| AdmissionError::SignatureVerificationFailed)?;

    Ok(())
}

/// Load an Ed25519 signing key from PKCS#8 PEM, raw 32-byte hex, or base64.
pub fn load_signing_key(key_str: &str) -> Result<SigningKey> {
    let trimmed = key_str.trim();
    if trimmed.contains("-----BEGIN PRIVATE KEY-----") {
        SigningKey::from_pkcs8_pem(trimmed)
            .map_err(|e| anyhow::anyhow!("failed to parse PKCS#8 Ed25519 private key PEM: {e}"))
    } else if let Ok(bytes) = hex::decode(trimmed) {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            Ok(SigningKey::from_bytes(&arr))
        } else if bytes.len() == 64 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes[..32]);
            Ok(SigningKey::from_bytes(&arr))
        } else {
            anyhow::bail!(
                "hex private key must be 32 bytes (seed) or 64 bytes (keypair), got {}",
                bytes.len()
            );
        }
    } else {
        use base64::Engine;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(trimmed) {
            if bytes.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                return Ok(SigningKey::from_bytes(&arr));
            }
        }
        anyhow::bail!(
            "unsupported private key format: must be PKCS#8 PEM, 32-byte hex, or 32-byte base64"
        );
    }
}

/// Sign message bytes using an Ed25519 signing key, returning a Base64-encoded signature.
pub fn sign_ed25519(message: &[u8], signing_key: &SigningKey) -> String {
    use base64::Engine;
    let signature = signing_key.sign(message);
    base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
}

/// Sign an envelope JSON Value in place by calculating its canonical SHA-256 digest,
/// updating `integrity.sha256`, and setting `signature` to the Base64 Ed25519 signature.
pub fn sign_envelope_value(
    envelope_val: &mut serde_json::Value,
    signing_key: &SigningKey,
) -> Result<String> {
    let digest = crate::envelope::compute_envelope_digest_from_value(envelope_val.clone())?;
    envelope_val["integrity"] = serde_json::json!({ "sha256": digest });
    let sig_b64 = sign_ed25519(digest.as_bytes(), signing_key);
    envelope_val["signature"] = serde_json::json!(sig_b64);
    Ok(sig_b64)
}

/// Seal and sign an envelope JSON Value using the domain-separated V2 envelope
/// format from spec §1.2.
///
/// Stamps `issuedAtUnix` BEFORE the digest is computed (the digest covers it),
/// then signs the length-prefixed buffer binding domain header, digest,
/// repository identity, service identity, and the issuance instant.
pub fn sign_envelope_value_v2(
    envelope_val: &mut serde_json::Value,
    signing_key: &SigningKey,
    issued_at_unix: u64,
) -> Result<String> {
    envelope_val["issuedAtUnix"] = serde_json::json!(issued_at_unix);
    let digest = crate::envelope::compute_envelope_digest_from_value(envelope_val.clone())?;
    envelope_val["integrity"] = serde_json::json!({ "sha256": digest });

    let snapshot = envelope_val
        .get("snapshot")
        .ok_or_else(|| anyhow::anyhow!("envelope is missing the snapshot object"))?;
    let repo_id = snapshot
        .get("repositoryId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("envelope snapshot is missing repositoryId"))?;
    let service_id = snapshot
        .get("serviceId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("envelope snapshot is missing serviceId"))?;

    let payload =
        crate::envelope::build_envelope_sign_payload(repo_id, service_id, &digest, issued_at_unix);
    let sig_b64 = sign_ed25519(&payload, signing_key);
    envelope_val["signature"] = serde_json::json!(sig_b64);
    Ok(sig_b64)
}

/// Verify an Ed25519 signature.
///
/// Mirrors TypeScript:
///   verify(null, Buffer.from(e.integrity!.sha256, 'utf8'), producer.publicKeyPem,
///          Buffer.from(e.signature, 'base64'))
///
/// - Signed bytes: UTF-8 of the lowercase hex SHA-256 digest string
/// - Signature: Base64-encoded Ed25519 signature
/// - Public key: PEM-encoded Ed25519 public key
pub fn verify_ed25519_signature(
    sha256_hex: &str,
    signature_b64: &str,
    public_key_pem: &str,
) -> Result<()> {
    use base64::Engine;

    // Decode signature from Base64 (standard alphabet, with padding)
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| anyhow::anyhow!("signature base64 decode failed: {e}"))?;

    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|e| anyhow::anyhow!("invalid signature bytes: {e}"))?;

    // Parse PEM public key
    // ed25519-dalek 3.x uses `VerifyingKey::from_public_key_pem`
    let verifying_key = VerifyingKey::from_public_key_pem(public_key_pem)
        .map_err(|e| anyhow::anyhow!("invalid public key PEM: {e}"))?;

    // Signed message: UTF-8 bytes of the lowercase hex digest string
    let message = sha256_hex.as_bytes();

    verifying_key
        .verify_strict(message, &signature)
        .map_err(|e| anyhow::anyhow!("signature verification failed: {e}"))
}

/// Convenience alias for callers (matches TypeScript function naming)
#[allow(non_snake_case)]
pub fn admitArtifact(
    envelope: &ContractArtifactEnvelope,
    policy: &ArtifactTrustPolicy,
) -> Result<(), AdmissionError> {
    admit_artifact(envelope, policy, false)
}

// ---------------------------------------------------------------------------
// Envelope V2 Manifest Admission & Shard Verification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmittedManifest {
    pub manifest: crate::envelope::SignedManifest,
}

impl std::ops::Deref for AdmittedManifest {
    type Target = crate::envelope::SignedManifest;
    fn deref(&self) -> &Self::Target {
        &self.manifest
    }
}

impl AdmittedManifest {
    pub fn new(manifest: crate::envelope::SignedManifest) -> Self {
        Self { manifest }
    }

    /// Verify a shard's raw content bytes against this admitted manifest.
    pub fn verify_shard_content(&self, path: &str, content: &[u8]) -> Result<(), AdmissionError> {
        let shard = self
            .manifest
            .shards
            .iter()
            .find(|s| s.path == path)
            .ok_or_else(|| {
                AdmissionError::ManifestValidationFailed(format!("unknown shard: {path}"))
            })?;
        verify_shard_content(shard, content)
    }
}

/// Verify a shard's raw content bytes against its declared descriptor in an admitted manifest.
/// Checks:
/// 1. Declared byteLength matches actual content byte length
/// 2. Declared sha256 matches actual lowercase hex SHA-256 digest
pub fn verify_shard_content(
    shard: &crate::envelope::ShardDescriptor,
    content: &[u8],
) -> Result<(), AdmissionError> {
    if content.len() as u64 != shard.byte_length {
        return Err(AdmissionError::IntegrityFailed);
    }
    use sha2::{Digest, Sha256};
    let actual_hash = hex::encode(Sha256::digest(content));
    if actual_hash != shard.sha256 {
        return Err(AdmissionError::IntegrityFailed);
    }
    Ok(())
}

/// Compute public key identifier formatted as "sha256:<hex>" over DER-encoded SPKI public key bytes.
pub fn compute_public_key_id_from_der(der_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(der_bytes);
    format!("sha256:{}", hex::encode(hash))
}

/// Extract raw DER bytes from a PEM string.
pub fn extract_der_from_pem(pem: &str) -> Result<Vec<u8>, AdmissionError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let b64: String = pem
        .lines()
        .filter(|line| !line.trim().starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    STANDARD
        .decode(b64.trim())
        .map_err(|_| AdmissionError::UnauthorizedProducer)
}

/// Parse a VerifyingKey from DER bytes (SPKI or raw).
pub fn parse_verifying_key_from_der(der_bytes: &[u8]) -> Result<VerifyingKey, AdmissionError> {
    // 1. Try pkcs8/spki DecodePublicKey
    if let Ok(key) = VerifyingKey::from_public_key_der(der_bytes) {
        return Ok(key);
    }
    // 2. Fallback: 44-byte Ed25519 SPKI DER prefix
    if der_bytes.len() == 44
        && der_bytes.starts_with(&[
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ])
    {
        let raw_bytes: [u8; 32] = der_bytes[12..44]
            .try_into()
            .map_err(|_| AdmissionError::UnauthorizedProducer)?;
        return VerifyingKey::from_bytes(&raw_bytes)
            .map_err(|_| AdmissionError::UnauthorizedProducer);
    }
    // 3. Fallback: 32 raw bytes
    if der_bytes.len() == 32 {
        let raw_bytes: [u8; 32] = der_bytes
            .try_into()
            .map_err(|_| AdmissionError::UnauthorizedProducer)?;
        return VerifyingKey::from_bytes(&raw_bytes)
            .map_err(|_| AdmissionError::UnauthorizedProducer);
    }
    Err(AdmissionError::UnauthorizedProducer)
}

impl TrustedProducer {
    pub fn matches_public_key_id(&self, key_id: &str) -> bool {
        if let Some(ref id) = self.public_key_id {
            if id.eq_ignore_ascii_case(key_id) {
                return true;
            }
        }
        if let Some(ref der_hex) = self.public_key_der_hex {
            if let Ok(der_bytes) = hex::decode(der_hex) {
                if compute_public_key_id_from_der(&der_bytes).eq_ignore_ascii_case(key_id) {
                    return true;
                }
            }
        }
        if let Some(ref pem) = self.public_key_pem {
            if let Ok(der_bytes) = extract_der_from_pem(pem) {
                if compute_public_key_id_from_der(&der_bytes).eq_ignore_ascii_case(key_id) {
                    return true;
                }
            }
        }
        false
    }

    pub fn to_verifying_key(&self) -> Result<VerifyingKey, AdmissionError> {
        if let Some(ref der_hex) = self.public_key_der_hex {
            let der_bytes =
                hex::decode(der_hex).map_err(|_| AdmissionError::UnauthorizedProducer)?;
            return parse_verifying_key_from_der(&der_bytes);
        }
        if let Some(ref pem) = self.public_key_pem {
            return VerifyingKey::from_public_key_pem(pem)
                .map_err(|_| AdmissionError::UnauthorizedProducer);
        }
        Err(AdmissionError::UnauthorizedProducer)
    }
}

/// Ed25519 SubjectPublicKeyInfo DER prefix (12 bytes) preceding the 32-byte key.
const ED25519_SPKI_DER_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Resolve the revocation-lookup key id for a producer (spec §3.1).
///
/// Uses the operator-assigned `public_key_id` when present; otherwise derives
/// the canonical "sha256:<hex>" id over the DER SPKI encoding of the
/// producer's key material.
fn producer_key_id(producer: &TrustedProducer) -> Option<String> {
    if let Some(ref id) = producer.public_key_id {
        return Some(id.clone());
    }
    let verifying_key = producer.to_verifying_key().ok()?;
    let mut der = Vec::with_capacity(44);
    der.extend_from_slice(&ED25519_SPKI_DER_PREFIX);
    der.extend_from_slice(verifying_key.as_bytes());
    Some(compute_public_key_id_from_der(&der))
}

fn is_valid_shard_filename(path: &str) -> bool {
    let bytes = path.as_bytes();
    // "shard-xxx.json": 6 + 3 + 5 = 14 bytes
    if bytes.len() != 14 {
        return false;
    }
    if !bytes.starts_with(b"shard-") || !bytes.ends_with(b".json") {
        return false;
    }
    bytes[6..9].iter().all(|b| b.is_ascii_digit())
}

fn decode_signature_bytes(sig_str: &str) -> Result<Signature, AdmissionError> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine;

    let bytes = URL_SAFE_NO_PAD
        .decode(sig_str)
        .or_else(|_| URL_SAFE.decode(sig_str))
        .or_else(|_| STANDARD.decode(sig_str))
        .map_err(|_| AdmissionError::SignatureVerificationFailed)?;

    Signature::from_slice(&bytes).map_err(|_| AdmissionError::SignatureVerificationFailed)
}

/// Verify admission for an Envelope V2 SignedManifest.
///
/// Implements exact validation order:
/// 1. Key lookup from `trust_policy.producers` by `publicKeyId`
///    -> else `AdmissionError::UnauthorizedProducer` (`CRYPTO_UNKNOWN_KEY`).
/// 2. Reconstruct `UnsignedManifest` -> compute RFC 8785 canonical bytes
///    -> assemble `sign_payload` with length prefixes -> verify Ed25519 signature.
///    Reject on failure (`SignatureVerificationFailed`).
/// 3. Verify shard count <= 5 (and between 1 and 5 inclusive).
/// 4. Validate shard paths: no directory traversal (`..`, `/`, `\`), regex `^shard-[0-9]{3}\.json$`.
/// 5. Validate shard declared byteLength <= 20 MiB and sha256 is 64 hex chars.
pub fn verify_manifest_admission(
    signed_manifest_json: &str,
    trust_policy: &ArtifactTrustPolicy,
    expected_repo_id: Option<&str>,
    expected_revision: Option<&str>,
) -> Result<AdmittedManifest, AdmissionError> {
    // Reject duplicate JSON keys
    crate::canonical::check_no_duplicate_keys(signed_manifest_json)
        .map_err(|e| AdmissionError::ManifestValidationFailed(e.to_string()))?;

    let signed_manifest: crate::envelope::SignedManifest =
        serde_json::from_str(signed_manifest_json)
            .map_err(|e| AdmissionError::ManifestValidationFailed(e.to_string()))?;

    // 1. Key lookup from trust_policy.producers by publicKeyId -> else UnauthorizedProducer (CRYPTO_UNKNOWN_KEY)
    let producer = trust_policy
        .producers
        .iter()
        .find(|p| p.matches_public_key_id(&signed_manifest.signature.public_key_id))
        .ok_or(AdmissionError::UnauthorizedProducer)?;

    let verifying_key = producer.to_verifying_key()?;

    // 2. Reconstruct UnsignedManifest -> compute RFC 8785 canonical bytes -> assemble sign_payload with length prefixes -> verify Ed25519 signature. Reject on failure (SignatureVerificationFailed).
    let unsigned = signed_manifest.to_unsigned();
    let canonical_bytes = crate::envelope::canonical_manifest_bytes(&unsigned)
        .map_err(|_| AdmissionError::SignatureVerificationFailed)?;
    use sha2::{Digest, Sha256};
    let manifest_digest_hex = hex::encode(Sha256::digest(&canonical_bytes));

    let sign_payload = crate::envelope::build_sign_payload(
        &signed_manifest.repository_id,
        &signed_manifest.revision,
        &signed_manifest.envelope_version,
        &manifest_digest_hex,
    );

    let signature = decode_signature_bytes(&signed_manifest.signature.signature_value)?;
    verifying_key
        .verify_strict(&sign_payload, &signature)
        .map_err(|_| AdmissionError::SignatureVerificationFailed)?;

    // 2b. Producer authorization: the matching key's authorized repository must match the manifest repositoryId
    if producer.repository_id != signed_manifest.repository_id {
        return Err(AdmissionError::UnauthorizedProducer);
    }

    // Expected repository and revision checks if specified
    if let Some(expected_repo) = expected_repo_id {
        if signed_manifest.repository_id != expected_repo {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "repositoryId mismatch: expected {expected_repo:?}, got {:?}",
                signed_manifest.repository_id
            )));
        }
    }
    if let Some(expected_rev) = expected_revision {
        if signed_manifest.revision != expected_rev {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "revision mismatch: expected {expected_rev:?}, got {:?}",
                signed_manifest.revision
            )));
        }
    }

    if signed_manifest.envelope_version != crate::envelope::ARTIFACT_ENVELOPE_VERSION_V2 {
        return Err(AdmissionError::EnvelopeVersionMismatch {
            expected: crate::envelope::ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
            got: signed_manifest.envelope_version.clone(),
        });
    }

    // 3. Verify shard count <= 5 (and between 1 and 5 inclusive)
    if signed_manifest.shards.is_empty() || signed_manifest.shards.len() > 5 {
        return Err(AdmissionError::ManifestValidationFailed(format!(
            "shard count must be between 1 and 5 inclusive, got {}",
            signed_manifest.shards.len()
        )));
    }

    // 4. Validate shard paths: no directory traversal (.., /, \), regex ^shard-[0-9]{3}\.json$
    let mut seen_paths = std::collections::HashSet::new();
    for shard in &signed_manifest.shards {
        if !seen_paths.insert(&shard.path) {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "duplicate shard path: {:?}",
                shard.path
            )));
        }
        if shard.path.contains("..") || shard.path.contains('/') || shard.path.contains('\\') {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "shard path contains invalid traversal or separators: {:?}",
                shard.path
            )));
        }
        if !is_valid_shard_filename(&shard.path) {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "shard path does not match '^shard-[0-9]{{3}}\\.json$': {:?}",
                shard.path
            )));
        }
    }

    // 5. Validate shard declared byteLength <= 20 MiB and sha256 is 64 hex chars
    const MAX_SHARD_BYTE_LENGTH: u64 = 20 * 1024 * 1024; // 20971520 bytes = 20 MiB
    for shard in &signed_manifest.shards {
        if shard.byte_length < 1 || shard.byte_length > MAX_SHARD_BYTE_LENGTH {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "shard declared byteLength {} out of bounds [1, {MAX_SHARD_BYTE_LENGTH}]",
                shard.byte_length
            )));
        }
        if shard.sha256.len() != 64
            || !shard
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(AdmissionError::ManifestValidationFailed(format!(
                "shard sha256 is not 64 lowercase hex characters: {:?}",
                shard.sha256
            )));
        }
    }

    Ok(AdmittedManifest::new(signed_manifest))
}

/// Convenience overload of `verify_manifest_admission` with explicit expected repo and revision.
pub fn verify_manifest_admission_expected(
    signed_manifest_json: &str,
    trust_policy: &ArtifactTrustPolicy,
    expected_repo_id: &str,
    expected_revision: &str,
) -> Result<AdmittedManifest, AdmissionError> {
    verify_manifest_admission(
        signed_manifest_json,
        trust_policy,
        Some(expected_repo_id),
        Some(expected_revision),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{
        seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
        BackendContractPayload, ContractArtifactEnvelope, ExtractionProfile,
    };
    use ed25519_dalek::pkcs8::EncodePublicKey;

    fn make_test_envelope() -> ContractArtifactEnvelope {
        ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::BackendContract,
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: Some("SPRING_MVC".to_string()),
                codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
                client_profile: None,
                config_fingerprint: Some("test-fingerprint".to_string()),
            },
            snapshot: ArtifactSnapshotRef {
                repository_id: "github.com/example/repo".to_string(),
                service_id: "my-service".to_string(),
                api_version: Some("v1".to_string()),
                parent_commit: "0123456789abcdef0123456789abcdef01234567".to_string(),
                candidate_snapshot: "candidate-1".to_string(),
                deployment_id: None,
                environment: None,
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
    fn test_trusted_local_unauthorized_producer_rejected() {
        let envelope = seal_envelope(make_test_envelope()).unwrap();
        let policy = ArtifactTrustPolicy {
            producers: vec![TrustedProducer {
                repository_id: "github.com/different/repo".to_string(),
                service_id: "other-service".to_string(),
                public_key_pem: None,
                trusted_digests: None,
                public_key_id: None,
                public_key_der_hex: None,
                valid_until: None,
                environments: None,
                signature_format: None,
            }],
            require_signatures: false,
            ..Default::default()
        };

        let result = admit_artifact(&envelope, &policy, true);
        assert_eq!(result, Err(AdmissionError::UnauthorizedProducer));
    }

    fn policy_for_producer(producer: TrustedProducer, revoked: Vec<String>) -> ArtifactTrustPolicy {
        ArtifactTrustPolicy {
            producers: vec![producer],
            require_signatures: false,
            revoked_key_ids: revoked,
            max_contract_age_days: None,
            waiver_approvers: Vec::new(),
        }
    }

    fn signed_v1_test_policy(
        envelope: &ContractArtifactEnvelope,
    ) -> (ArtifactTrustPolicy, SigningKey) {
        let seed = [99u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let public_key_pem = verifying_key
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        let producer = TrustedProducer {
            repository_id: envelope.snapshot.repository_id.clone(),
            service_id: envelope.snapshot.service_id.clone(),
            public_key_pem: Some(public_key_pem),
            trusted_digests: None,
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        };
        (policy_for_producer(producer, Vec::new()), signing_key)
    }

    fn v1_sign_and_seal(
        mut envelope: ContractArtifactEnvelope,
        signing_key: &SigningKey,
    ) -> ContractArtifactEnvelope {
        envelope = seal_envelope(envelope).unwrap();
        let digest = envelope.integrity.as_ref().unwrap().sha256.clone();
        let sig = sign_ed25519(digest.as_bytes(), signing_key);
        envelope.signature = Some(sig);
        envelope
    }

    #[test]
    fn test_revoked_key_rejected_before_signature_checks() {
        let envelope = seal_envelope(make_test_envelope()).unwrap();
        let mut producer = {
            let (policy, _) = signed_v1_test_policy(&envelope);
            policy.producers.into_iter().next().unwrap()
        };
        // Operator-assigned key id, matching a revoked_key_ids entry.
        producer.public_key_id = Some("key_ed25519_2026_prod_01".to_string());
        let policy = policy_for_producer(producer, vec!["key_ed25519_2026_prod_01".to_string()]);

        // Revocation fires even though the envelope has no signature at all
        // and trusted_local bypasses signature checks: fail closed.
        let err = admit_artifact(&envelope, &policy, false).unwrap_err();
        assert_eq!(err, AdmissionError::KeyRevoked);
        let err = admit_artifact(&envelope, &policy, true).unwrap_err();
        assert_eq!(err, AdmissionError::KeyRevoked);
    }

    #[test]
    fn test_revoked_derived_key_id_rejected() {
        let envelope = seal_envelope(make_test_envelope()).unwrap();
        let (policy, _) = signed_v1_test_policy(&envelope);
        let key_id = producer_key_id(&policy.producers[0]).unwrap();
        assert!(key_id.starts_with("sha256:"));

        let revoked_policy = policy_for_producer(policy.producers[0].clone(), vec![key_id]);
        let err = admit_artifact(&envelope, &revoked_policy, false).unwrap_err();
        assert_eq!(err, AdmissionError::KeyRevoked);
    }

    #[test]
    fn test_valid_until_expiry_enforced_with_explicit_evaluation_time() {
        let envelope = seal_envelope(make_test_envelope()).unwrap();
        let (mut policy, _) = signed_v1_test_policy(&envelope);
        policy.producers[0].valid_until = Some(1_800_000_000); // far future relative to evaluation time

        // Unsigned envelope with no pins: falls through to MissingSignatureOrPin,
        // proving the expiry check did not fire.
        let err = admit_artifact_at(&envelope, &policy, false, Some(1_700_000_000)).unwrap_err();
        assert_eq!(err, AdmissionError::MissingSignatureOrPin);

        // At the exclusive upper bound the key is already expired.
        policy.producers[0].valid_until = Some(1_700_000_000);
        let err = admit_artifact_at(&envelope, &policy, false, Some(1_700_000_000)).unwrap_err();
        assert_eq!(err, AdmissionError::KeyExpired);

        // One second later, also expired.
        let err = admit_artifact_at(&envelope, &policy, false, Some(1_700_000_001)).unwrap_err();
        assert_eq!(err, AdmissionError::KeyExpired);
    }

    #[test]
    fn test_environment_scope_binding() {
        let mut envelope = make_test_envelope();
        envelope.snapshot.environment = Some("staging".to_string());
        let envelope = seal_envelope(envelope).unwrap();
        let (mut policy, _) = signed_v1_test_policy(&envelope);

        // Key authorized for prod only cannot validate a staging artifact.
        policy.producers[0].environments = Some(vec!["prod".to_string()]);
        let err = admit_artifact(&envelope, &policy, false).unwrap_err();
        assert_eq!(err, AdmissionError::UnauthorizedSignerScope);

        // Authorized for both staging and prod: scope check passes; the
        // unsigned envelope then fails at the signature step instead.
        policy.producers[0].environments = Some(vec!["prod".to_string(), "staging".to_string()]);
        let err = admit_artifact(&envelope, &policy, false).unwrap_err();
        assert_eq!(err, AdmissionError::MissingSignatureOrPin);
    }

    #[test]
    fn test_v2_envelope_signature_roundtrip() {
        use crate::envelope::build_envelope_sign_payload;

        let seed = [7u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let public_key_pem = verifying_key
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();

        let issued_at = 1_760_000_000u64;
        let mut envelope = make_test_envelope();
        envelope.issued_at_unix = Some(issued_at);
        envelope = seal_envelope(envelope).unwrap();
        let digest = envelope.integrity.as_ref().unwrap().sha256.clone();
        let payload = build_envelope_sign_payload(
            &envelope.snapshot.repository_id,
            &envelope.snapshot.service_id,
            &digest,
            issued_at,
        );
        envelope.signature = Some(sign_ed25519(&payload, &signing_key));

        let producer = TrustedProducer {
            repository_id: envelope.snapshot.repository_id.clone(),
            service_id: envelope.snapshot.service_id.clone(),
            public_key_pem: Some(public_key_pem.clone()),
            trusted_digests: None,
            public_key_id: None,
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: Some(SIGNATURE_FORMAT_V2_ENVELOPE.to_string()),
        };
        let policy = ArtifactTrustPolicy {
            producers: vec![producer.clone()],
            require_signatures: true,
            revoked_key_ids: Vec::new(),
            max_contract_age_days: None,
            waiver_approvers: Vec::new(),
        };

        // V2 signature admitted with the V1 verifier absent.
        assert!(admit_artifact(&envelope, &policy, false).is_ok());

        // The same signature does NOT verify under the V1 hex-digest format:
        // domain separation prevents cross-protocol reuse.
        let mut v1_producer = producer.clone();
        v1_producer.signature_format = None;
        let v1_policy = ArtifactTrustPolicy {
            producers: vec![v1_producer],
            ..policy.clone()
        };
        assert_eq!(
            admit_artifact(&envelope, &v1_policy, false).unwrap_err(),
            AdmissionError::SignatureVerificationFailed
        );

        // Plain issuedAtUnix mutation breaks the integrity digest first
        // (the field is inside the canonical digest input).
        let mut tampered = envelope.clone();
        tampered.issued_at_unix = Some(issued_at + 1);
        assert_eq!(
            admit_artifact(&tampered, &policy, false).unwrap_err(),
            AdmissionError::IntegrityFailed
        );

        // Even when the attacker re-seals the digest for the new timestamp,
        // the V2 signature (which binds issuedAtUnix) no longer verifies.
        let resealed = seal_envelope(tampered).unwrap();
        assert_eq!(
            admit_artifact(&resealed, &policy, false).unwrap_err(),
            AdmissionError::SignatureVerificationFailed
        );

        // A V2 producer cannot admit an artifact without issuedAtUnix. The
        // field is removed and the digest re-sealed so the failure isolates
        // the missing-timestamp rule rather than integrity.
        let mut missing_ts = envelope;
        missing_ts.issued_at_unix = None;
        missing_ts = seal_envelope(missing_ts).unwrap();
        assert_eq!(
            admit_artifact(&missing_ts, &policy, false).unwrap_err(),
            AdmissionError::MissingIssuedAt
        );
    }

    #[test]
    fn test_v1_signing_still_admits_under_default_format() {
        let envelope = make_test_envelope();
        let (policy, signing_key) = signed_v1_test_policy(&envelope);
        let envelope = v1_sign_and_seal(envelope, &signing_key);
        assert!(admit_artifact(&envelope, &policy, false).is_ok());
    }

    #[test]
    fn test_envelope_sign_payload_layout() {
        use crate::envelope::{build_envelope_sign_payload, ENVELOPE_SIGN_DOMAIN_HEADER};
        assert_eq!(
            ENVELOPE_SIGN_DOMAIN_HEADER,
            b"SAJIMORA-ED25519-V2-ENVELOPE\n"
        );
        assert_eq!(ENVELOPE_SIGN_DOMAIN_HEADER.len(), 29);

        let payload = build_envelope_sign_payload("r", "s", &"a".repeat(64), 1);
        // 29 header + 4 len + 64 digest + 4 + 1 repo + 4 + 1 service + 8 ts
        assert_eq!(payload.len(), 29 + 4 + 64 + 4 + 1 + 4 + 1 + 8);
        assert_eq!(&payload[..29], ENVELOPE_SIGN_DOMAIN_HEADER);
        assert_eq!(&payload[29..33], &64u32.to_be_bytes());
        assert_eq!(&payload[33..97], &[b'a'; 64]);
        assert_eq!(&payload[97..101], &1u32.to_be_bytes());
        assert_eq!(&payload[101..102], b"r");
        assert_eq!(&payload[102..106], &1u32.to_be_bytes());
        assert_eq!(&payload[106..107], b"s");
        assert_eq!(&payload[107..115], &1u64.to_be_bytes());
    }
}
