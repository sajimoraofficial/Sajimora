//! sign.rs — Native CLI command for Ed25519 envelope and artifact signing.
//!
//! Signature formats:
//! - `v1-digest-utf8` (default, frozen R0.6.3): signs the UTF-8 bytes of the
//!   lowercase hex SHA-256 digest string.
//! - `v2-envelope` (spec §1.2): signs the domain-separated, length-prefixed
//!   buffer `SAJIMORA-ED25519-V2-ENVELOPE\n | u32be len(digest) | digest |
//!   u32be len(repoId) | repoId | u32be len(serviceId) | serviceId | u64be issuedAt`.
//!   Requires `--issued-at` (Unix epoch seconds), which is embedded in the
//!   envelope as `issuedAtUnix` and bound into the signature.

use anyhow::{anyhow, bail, Result};
use clap::Args;
use contract_core::admission::{
    load_signing_key, sign_envelope_value, sign_envelope_value_v2, SIGNATURE_FORMAT_V1,
    SIGNATURE_FORMAT_V2_ENVELOPE,
};
use std::fs;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct SignArgs {
    /// Path to the contract artifact envelope JSON file to sign.
    #[arg(long)]
    pub artifact: PathBuf,

    /// Path to the Ed25519 private key file (PKCS#8 PEM or raw 32-byte hex/base64), or the key string itself.
    #[arg(long)]
    pub key: String,

    /// Optional output path for the signed artifact JSON (defaults to in-place overwrite).
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Signature payload format: "v1-digest-utf8" (default) or "v2-envelope" (spec §1.2).
    #[arg(long, default_value = "v1-digest-utf8")]
    pub format: String,

    /// Unix epoch seconds recorded as `issuedAtUnix` and bound into the V2
    /// signature. Required for --format v2-envelope.
    #[arg(long)]
    pub issued_at: Option<u64>,
}

pub fn run(args: SignArgs) -> i32 {
    match run_inner(args) {
        Ok(out_path) => {
            eprintln!(
                "✅ Signed contract artifact successfully written to {:?}",
                out_path
            );
            0
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn run_inner(args: SignArgs) -> Result<PathBuf> {
    if !args.artifact.exists() {
        return Err(anyhow!("Artifact file not found: {:?}", args.artifact));
    }

    let format = match args.format.as_str() {
        "v1-digest-utf8" | "v1" => SIGNATURE_FORMAT_V1,
        "v2-envelope" | "v2" => SIGNATURE_FORMAT_V2_ENVELOPE,
        other => bail!(
            "unknown signature format {:?}; expected {:?} or {:?}",
            other,
            SIGNATURE_FORMAT_V1,
            SIGNATURE_FORMAT_V2_ENVELOPE
        ),
    };

    let key_content = if let Ok(content) = fs::read_to_string(&args.key) {
        content
    } else {
        args.key.clone()
    };

    let signing_key = load_signing_key(&key_content)?;

    let raw_bytes = fs::read(&args.artifact)?;
    let mut envelope_val: serde_json::Value = serde_json::from_slice(&raw_bytes)
        .map_err(|e| anyhow!("Failed to parse artifact JSON: {e}"))?;

    let sig_b64 = match format {
        SIGNATURE_FORMAT_V2_ENVELOPE => {
            let issued_at = args
                .issued_at
                .ok_or_else(|| anyhow!("--issued-at is required for --format v2-envelope"))?;
            sign_envelope_value_v2(&mut envelope_val, &signing_key, issued_at)?
        }
        _ => sign_envelope_value(&mut envelope_val, &signing_key)?,
    };

    let out_path = args.out.unwrap_or(args.artifact);
    let output_json = serde_json::to_string_pretty(&envelope_val)?;
    fs::write(&out_path, output_json)?;

    eprintln!("Signature: {}", sig_b64);
    Ok(out_path)
}
