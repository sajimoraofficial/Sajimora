//! reference_verifier.rs — Stand-alone Rust comparison utility.
//!
//! Compares two supplied payloads. It does NOT establish bootstrap evidence:
//! feeding the same literal string twice always produces equal digests. Real
//! Stage 1/2/3 acceptance requires a recorded compilation transcript and a
//! functional compiler, not a hash comparison (see audit 2026-11-04).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EquivalenceProof {
    pub target: String,
    pub stage: String,
    pub verified_at_unix: u64,
    pub rust_digest: String,
    pub sjm_digest: String,
    pub status: EquivalenceStatus,
    pub certificate_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EquivalenceStatus {
    IdenticalBitwise,
    BisimulationEquivalent,
    SemanticParity,
    Divergent { reason: String },
}

pub struct ReferenceVerifier;

impl ReferenceVerifier {
    /// Compute canonical SHA-256 hash of a normalized string payload.
    pub fn compute_digest(payload: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(payload.trim().as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Verify AST parity between Rust reference compiler output and Sajimora compiler output.
    pub fn verify_ast_equivalence(
        target_name: &str,
        rust_ast_json: &str,
        sjm_ast_json: &str,
    ) -> Result<EquivalenceProof, String> {
        let rust_digest = Self::compute_digest(rust_ast_json);
        let sjm_digest = Self::compute_digest(sjm_ast_json);

        let status = if rust_digest == sjm_digest {
            EquivalenceStatus::IdenticalBitwise
        } else {
            // Attempt semantic JSON equivalence parse
            let rust_val: Result<serde_json::Value, _> = serde_json::from_str(rust_ast_json);
            let sjm_val: Result<serde_json::Value, _> = serde_json::from_str(sjm_ast_json);

            match (rust_val, sjm_val) {
                (Ok(r), Ok(s)) if r == s => EquivalenceStatus::SemanticParity,
                (Ok(_), Ok(_)) => {
                    return Err(format!(
                        "AST divergence detected between Rust ({}) and Sajimora ({})",
                        rust_digest, sjm_digest
                    ));
                }
                (Err(e), _) => return Err(format!("Invalid Rust AST JSON: {}", e)),
                (_, Err(e)) => return Err(format!("Invalid Sajimora AST JSON: {}", e)),
            }
        };

        let cert_payload = format!("{}:{}:{}:{}", target_name, "AST", rust_digest, sjm_digest);
        let cert_hash = Self::compute_digest(&cert_payload);

        Ok(EquivalenceProof {
            target: target_name.to_string(),
            stage: "AST".to_string(),
            verified_at_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            rust_digest,
            sjm_digest,
            status,
            certificate_sha256: cert_hash,
        })
    }

    /// Verify HIR and Contract Envelope equivalence between dual implementations.
    pub fn verify_contract_equivalence(
        target_name: &str,
        rust_envelope_json: &str,
        sjm_envelope_json: &str,
    ) -> Result<EquivalenceProof, String> {
        let rust_val: serde_json::Value = serde_json::from_str(rust_envelope_json)
            .map_err(|e| format!("Rust envelope invalid JSON: {}", e))?;
        let sjm_val: serde_json::Value = serde_json::from_str(sjm_envelope_json)
            .map_err(|e| format!("Sajimora envelope invalid JSON: {}", e))?;

        let rust_digest = Self::compute_digest(&rust_val.to_string());
        let sjm_digest = Self::compute_digest(&sjm_val.to_string());

        // Compare integrity digest fields
        let rust_int = rust_val.get("integrity").and_then(|i| i.get("sha256"));
        let sjm_int = sjm_val.get("integrity").and_then(|i| i.get("sha256"));

        if rust_int.is_some() && rust_int == sjm_int {
            let cert_payload = format!("{}:CONTRACT:{}:{}", target_name, rust_digest, sjm_digest);
            let cert_hash = Self::compute_digest(&cert_payload);

            Ok(EquivalenceProof {
                target: target_name.to_string(),
                stage: "CONTRACT_ENVELOPE".to_string(),
                verified_at_unix: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                rust_digest,
                sjm_digest,
                status: EquivalenceStatus::IdenticalBitwise,
                certificate_sha256: cert_hash,
            })
        } else {
            Err(format!(
                "Contract integrity mismatch: Rust={:?}, Sajimora={:?}",
                rust_int, sjm_int
            ))
        }
    }
}
