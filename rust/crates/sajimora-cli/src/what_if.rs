//! what_if.rs — Instant in-memory DTO mutation and contract simulation CLI command.

use anyhow::{Context, Result};
use clap::Args;
use serde_json::json;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct WhatIfArgs {
    /// Repository root containing .sajimora/contracts.db (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Target DTO type symbol to simulate (e.g. "User") for DTO mutations.
    #[arg(long)]
    pub r#type: Option<String>,

    /// Mutation kind (RENAME_FIELD, REMOVE_FIELD, CHANGE_TYPE, DELETE_ENDPOINT).
    #[arg(long, default_value = "RENAME_FIELD")]
    pub mutation: String,

    /// Target field name inside the DTO (DTO mutations).
    #[arg(long)]
    pub field: Option<String>,

    /// New field name (required for RENAME_FIELD).
    #[arg(long)]
    pub new_name: Option<String>,

    /// New field type (required for CHANGE_TYPE).
    #[arg(long)]
    pub new_type: Option<String>,

    /// Endpoint route (required for DELETE_ENDPOINT, e.g. "/api/users/{id}").
    #[arg(long)]
    pub route: Option<String>,

    /// Optional HTTP method filter for DELETE_ENDPOINT.
    #[arg(long)]
    pub method: Option<String>,

    /// Optional path to evaluate an unsaved candidate code buffer from disk.
    #[arg(long)]
    pub file: Option<PathBuf>,

    /// Output raw JSON instead of human-readable terminal output.
    #[arg(long)]
    pub json: bool,
}

pub fn run(args: WhatIfArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("sajimora what-if error: {err:#}");
            1
        }
    }
}

fn run_inner(args: WhatIfArgs) -> Result<()> {
    let repo_root = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("Cannot resolve repository path {:?}", args.repo))?;
    let allowed_roots = vec![repo_root.clone()];

    let mut query_params = serde_json::Map::new();
    query_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));

    let mut mutation_obj = serde_json::Map::new();
    mutation_obj.insert("action".to_string(), json!(args.mutation.to_uppercase()));
    if let Some(ref t) = args.r#type {
        mutation_obj.insert("targetDto".to_string(), json!(t));
    }
    if let Some(ref f) = args.field {
        mutation_obj.insert("field".to_string(), json!(f));
    }
    if let Some(ref n) = args.new_name {
        mutation_obj.insert("renameTo".to_string(), json!(n));
    }
    if let Some(ref t) = args.new_type {
        mutation_obj.insert("newType".to_string(), json!(t));
    }
    if let Some(ref r) = args.route {
        mutation_obj.insert("route".to_string(), json!(r));
    }
    if let Some(ref m) = args.method {
        mutation_obj.insert("method".to_string(), json!(m));
    }
    query_params.insert("mutation".to_string(), json!(mutation_obj));

    if let Some(ref file_path) = args.file {
        if file_path.exists() {
            let code = std::fs::read_to_string(file_path)?;
            query_params.insert("candidateCode".to_string(), json!(code));
        }
    }

    let output_str = sajimora_mcp::what_if::run_what_if(&allowed_roots, &query_params)?;
    let parsed: serde_json::Value = serde_json::from_str(&output_str)?;
    if let Some(message) = parsed.get("error").and_then(|e| e.as_str()) {
        anyhow::bail!(
            "{}: {}",
            message,
            parsed
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("no detail")
        );
    }

    if args.json {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
        return Ok(());
    }

    // Pretty terminal printing
    let verdict = parsed
        .get("verdict")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    let latency_ms = parsed
        .get("latencyMicros")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as f64
        / 1000.0;
    let matched = parsed
        .get("breakingConsumersCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let file_count = parsed
        .get("affectedFiles")
        .and_then(|f| f.as_array())
        .map(|files| files.len())
        .unwrap_or(0);

    println!(
        "⚡ Sajimora Sub-Second 'What-If' Contract Simulation (in {:.2}ms)",
        latency_ms
    );
    println!("--------------------------------------------------");
    match verdict {
        "BREAKING_CHANGE" => {
            println!("❌ VERDICT: BREAKING CHANGE DETECTED!");
            println!("  Affected Consumer Call Sites : {}", matched);
            println!("  Affected Client Files        : {}", file_count);
            if let Some(files) = parsed.get("affectedFiles").and_then(|f| f.as_array()) {
                for file in files {
                    if let Some(path) = file.as_str() {
                        println!("    • {}", path);
                    }
                }
            }
            if let Some(fix) = parsed.get("suggestedFix").and_then(|m| m.as_str()) {
                println!("\n💡 Zero-Breaking Suggested Fix:");
                println!("  {}", fix);
            }
            if let Some(rec) = parsed.get("recommendation").and_then(|m| m.as_str()) {
                println!("  {}", rec);
            }
        }
        "NON_BREAKING_PRESERVED" => {
            println!("✅ VERDICT: PRESERVED (NON-BREAKING)");
            println!("  Affected Consumers : 0");
            if let Some(message) = parsed.get("message").and_then(|m| m.as_str()) {
                println!("  {}", message);
            }
        }
        "SAFE_NO_OBSERVED_CONSUMERS" => {
            println!("✅ VERDICT: NO OBSERVED CONSUMERS");
            if let Some(message) = parsed.get("message").and_then(|m| m.as_str()) {
                println!("  {}", message);
            }
        }
        "COMPATIBLE" => {
            println!("✅ VERDICT: COMPATIBLE");
            println!(
                "  Detected Routes     : {}",
                parsed
                    .get("detectedRoutes")
                    .and_then(|r| r.as_array())
                    .map(|r| r.len())
                    .unwrap_or(0)
            );
            println!("  Affected Consumers  : 0");
        }
        "CONSUMERS_OBSERVED" => {
            println!("⚠️  VERDICT: CONSUMERS OBSERVED");
            println!("  Affected Consumer Call Sites : {}", matched);
        }
        other => {
            println!("⚠️  VERDICT: {}", other);
            if let Some(message) = parsed.get("message").and_then(|m| m.as_str()) {
                println!("  {}", message);
            }
        }
    }
    println!("--------------------------------------------------");

    Ok(())
}
