//! verify_envelope.rs — Native CLI command for envelope integrity and signature verification.

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::{
    admission::{admit_artifact, verify_ed25519_signature, ArtifactTrustPolicy},
    envelope::{parse_envelope, verify_envelope_integrity},
};
use std::fs;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct VerifyEnvelopeArgs {
    /// Path to the contract artifact envelope JSON file to verify.
    #[arg(long)]
    pub artifact: PathBuf,

    /// Path to the Ed25519 public key file (PEM), or the PEM string itself.
    #[arg(long)]
    pub public_key: Option<String>,

    /// Optional path to caller-supplied trust policy JSON.
    #[arg(long)]
    pub trust_policy: Option<PathBuf>,
}

pub fn run(args: VerifyEnvelopeArgs) -> i32 {
    match run_inner(args) {
        Ok(_) => {
            eprintln!("✅ Contract artifact envelope verified successfully.");
            0
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn run_inner(args: VerifyEnvelopeArgs) -> Result<()> {
    if !args.artifact.exists() {
        return Err(anyhow!("Artifact file not found: {:?}", args.artifact));
    }

    let raw_bytes = fs::read(&args.artifact)?;
    let envelope = parse_envelope(&raw_bytes)
        .map_err(|e| anyhow!("Failed to parse contract envelope: {e}"))?;

    // 1. Verify SHA-256 canonical integrity digest
    let integrity_valid = verify_envelope_integrity(&envelope)
        .map_err(|e| anyhow!("Integrity verification error: {e}"))?;
    if !integrity_valid {
        return Err(anyhow!(
            "Envelope SHA-256 integrity digest mismatch (artifact has been modified or corrupted)."
        ));
    }

    // 2. If trust policy provided, run admission policy
    if let Some(policy_path) = args.trust_policy {
        let policy_bytes = fs::read(&policy_path)
            .map_err(|e| anyhow!("Failed to read trust policy file {:?}: {e}", policy_path))?;
        let policy: ArtifactTrustPolicy = serde_json::from_slice(&policy_bytes)
            .map_err(|e| anyhow!("Failed to parse trust policy JSON: {e}"))?;

        admit_artifact(&envelope, &policy, false)
            .map_err(|e| anyhow!("Artifact admission failed under trust policy: {e}"))?;
    } else if let Some(pubkey_arg) = args.public_key {
        // 3. If explicit public key provided, verify signature
        let pubkey_content = if let Ok(content) = fs::read_to_string(&pubkey_arg) {
            content
        } else {
            pubkey_arg
        };

        let sig = envelope.signature.as_ref().ok_or_else(|| {
            anyhow!("Artifact has no signature, but a public key was provided for verification.")
        })?;

        let digest = envelope
            .integrity
            .as_ref()
            .map(|i| i.sha256.as_str())
            .ok_or_else(|| anyhow!("Artifact missing integrity digest"))?;

        verify_ed25519_signature(digest, sig, &pubkey_content)
            .map_err(|e| anyhow!("Ed25519 signature verification failed: {e}"))?;
    }

    Ok(())
}
