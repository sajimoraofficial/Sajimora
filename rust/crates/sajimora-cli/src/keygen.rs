//! keygen.rs — Generate an Ed25519 keypair and a matching artifact trust policy.
//!
//! The generated private key is PKCS#8 PEM (accepted by `sajimora sign`) and
//! the public key is SPKI PEM (accepted by `sajimora verify-envelope` and by
//! artifact admission). The policy binds the public key to the producer
//! identity and requires signatures.
//!
//! `--out-dir` writes the three files; without it the same material is printed
//! as JSON to stdout, matching the legacy Node CLI.

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::admission::{ArtifactTrustPolicy, TrustedProducer};
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use ed25519_dalek::SigningKey;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Args, Debug)]
pub struct KeygenArgs {
    /// Directory to write sajimora-private.pem, sajimora-public.pem and
    /// trust-policy.json into. When omitted, the key material is printed as
    /// JSON on stdout.
    #[arg(long, short = 'o')]
    pub out_dir: Option<PathBuf>,

    /// Repository id recorded as the trusted producer in the generated policy.
    #[arg(long, default_value = "example-org/repo")]
    pub repo_id: String,

    /// Service id recorded as the trusted producer in the generated policy.
    #[arg(long, default_value = "frontend-service")]
    pub service_id: String,

    /// Optional operator-assigned key id recorded as `publicKeyId`. Revocation
    /// entries must use this id instead of the derived "sha256:<hex>" form.
    #[arg(long)]
    pub key_id: Option<String>,
}

pub fn run(args: KeygenArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("❌ Key generation failed: {}", e);
            1
        }
    }
}

fn run_inner(args: KeygenArgs) -> Result<()> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed)
        .map_err(|e| anyhow!("Operating system random source unavailable: {}", e))?;
    let signing_key = SigningKey::from_bytes(&seed);
    seed.fill(0);

    let private_pem = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| anyhow!("Failed to encode private key as PKCS#8 PEM: {}", e))?;
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| anyhow!("Failed to encode public key as SPKI PEM: {}", e))?;

    let policy = ArtifactTrustPolicy {
        producers: vec![TrustedProducer {
            repository_id: args.repo_id.clone(),
            service_id: args.service_id.clone(),
            public_key_pem: Some(public_pem.clone()),
            trusted_digests: None,
            public_key_id: args.key_id.clone(),
            public_key_der_hex: None,
            valid_until: None,
            environments: None,
            signature_format: None,
        }],
        require_signatures: true,
        revoked_key_ids: Vec::new(),
        max_contract_age_days: None,
        waiver_approvers: Vec::new(),
    };
    let policy_json = serde_json::to_string_pretty(&policy)?;

    match args.out_dir {
        Some(dir) => {
            fs::create_dir_all(&dir)
                .map_err(|e| anyhow!("Cannot create output directory {:?}: {}", dir, e))?;
            let private_path = dir.join("sajimora-private.pem");
            let public_path = dir.join("sajimora-public.pem");
            let policy_path = dir.join("trust-policy.json");

            write_private_key(&private_path, private_pem.as_bytes())?;
            fs::write(&public_path, &public_pem)
                .map_err(|e| anyhow!("Cannot write public key {:?}: {}", public_path, e))?;
            fs::write(&policy_path, format!("{}\n", policy_json))
                .map_err(|e| anyhow!("Cannot write trust policy {:?}: {}", policy_path, e))?;

            println!("Ed25519 keypair and trust policy generated successfully:");
            println!("  - Private key:  {} (mode 0600)", private_path.display());
            println!("  - Public key:   {}", public_path.display());
            println!("  - Trust policy: {}", policy_path.display());
            println!();
            println!("Keep the private key outside the analyzed repository and pass it to");
            println!("`sajimora sign --key <path>`; ship only the public key and policy.");
        }
        None => {
            let printed = serde_json::json!({
                "publicKeyPem": public_pem,
                "privateKeyPem": private_pem.as_str(),
                "trustPolicy": policy,
            });
            println!("{}", serde_json::to_string_pretty(&printed)?);
        }
    }

    Ok(())
}

/// Create the private key file exclusively, so an existing key is never
/// silently replaced by a fresh keypair.
fn write_private_key(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            anyhow!(
                "Private key already exists at {:?}. Remove it or choose another --out-dir; refusing to overwrite a signing key.",
                path
            )
        } else {
            anyhow!("Cannot create private key {:?}: {}", path, e)
        }
    })?;
    file.write_all(bytes)
        .map_err(|e| anyhow!("Cannot write private key {:?}: {}", path, e))?;
    Ok(())
}
