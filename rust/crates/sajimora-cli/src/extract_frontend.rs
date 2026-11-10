//! extract_frontend.rs — Native CLI bridge for frontend contract extraction.
//!
//! Uses high-performance native Tree-sitter + Rayon parallel TypeScript parsing
//! across all CPU cores with zero external runtime dependencies.

use anyhow::{anyhow, Result};
use clap::Args;
use std::fs;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct ExtractFrontendArgs {
    /// Path to the git repository root.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Stable service identifier for this frontend client (e.g. "ui-ngx", "web-portal").
    #[arg(long)]
    pub service_id: Option<String>,

    /// Target backend service identifier (matches the backend contract serviceId).
    #[arg(long)]
    pub target_service_id: Option<String>,

    /// Subdirectory to filter TypeScript/JavaScript files (e.g. "src" or "frontend/src").
    #[arg(long)]
    pub ts_root: Option<PathBuf>,

    /// Parent commit SHA (defaults to "HEAD").
    #[arg(long, default_value = "HEAD")]
    pub parent: String,

    /// Output path for the generated contract artifact JSON.
    #[arg(long)]
    pub out: PathBuf,
}

pub fn run(args: ExtractFrontendArgs) -> i32 {
    match run_inner(args) {
        Ok(dest) => {
            eprintln!("Frontend contract written to {:?}", dest);
            0
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

pub fn run_inner(args: ExtractFrontendArgs) -> Result<PathBuf> {
    let repo_path = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo
    };

    let scan_dir = if let Some(ref root) = args.ts_root {
        if root.is_relative() {
            repo_path.join(root)
        } else {
            root.clone()
        }
    } else {
        // 1. Single source of truth: Read from .sajimora/init-manifest.json if initialized
        let manifest_path = repo_path.join(".sajimora/init-manifest.json");
        let from_manifest = fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|c| serde_json::from_str::<crate::init::InitManifest>(&c).ok())
            .and_then(|m| m.roots.frontend_root)
            .map(|fe| repo_path.join(fe))
            .filter(|p| p.is_dir());

        // 2. Generic AST-driven crawler: scans all subdirectories, monorepo packages, and root
        from_manifest
            .or_else(|| crate::init::detect_frontend(&repo_path))
            .unwrap_or_else(|| repo_path.clone())
    };

    let manifest_path = repo_path.join(".sajimora/init-manifest.json");
    let manifest_roots = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|c| serde_json::from_str::<crate::init::InitManifest>(&c).ok())
        .map(|m| m.roots);

    let service_id = args.service_id.unwrap_or_else(|| {
        let pkg_name = fs::read_to_string(scan_dir.join("package.json"))
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()));
        pkg_name.unwrap_or_else(|| "frontend-service".to_string())
    });

    let target_service_id = args.target_service_id.unwrap_or_else(|| {
        manifest_roots
            .as_ref()
            .map(|r| r.service_id.clone())
            .unwrap_or_else(|| "backend-service".to_string())
    });

    // An unreachable scan root yields zero calls rather than zero contracts, and the artifact
    // would then read as "this frontend makes no requests" with nothing to say why.
    for (label, dir) in [("Repository", &repo_path), ("Source root", &scan_dir)] {
        if !dir.is_dir() {
            return Err(anyhow!("{} directory does not exist: {:?}", label, dir));
        }
    }

    let envelope = source_index::ts_routes::extract_frontend_envelope(
        &repo_path,
        &scan_dir,
        &service_id,
        &target_service_id,
        &args.parent,
    )?;
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&envelope)?;
    fs::write(&args.out, json)?;
    Ok(args.out)
}
