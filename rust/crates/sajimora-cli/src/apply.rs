//! apply.rs — Deterministically apply consumer-side patches computed for DTO mutations.

use anyhow::{Context, Result};
use clap::Args;
use serde_json::json;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct ApplyArgs {
    /// Repository root containing .sajimora/init-manifest.json (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Mutation kind (RENAME_FIELD, REMOVE_FIELD).
    #[arg(long, default_value = "RENAME_FIELD")]
    pub mutation: String,

    /// Target DTO symbol (e.g. "UserDto").
    #[arg(long)]
    pub r#type: String,

    /// Field name being modified (e.g. "firstName").
    #[arg(long)]
    pub field: String,

    /// New field name (required for RENAME_FIELD).
    #[arg(long)]
    pub rename_to: Option<String>,

    /// Dry run: compute and preview the edits without modifying files on disk.
    #[arg(long)]
    pub dry_run: bool,

    /// If true, the rename preserves the wire contract; nothing is applied.
    #[arg(long)]
    pub json_property_retained: bool,

    /// Output raw JSON instead of human-readable terminal output.
    #[arg(long)]
    pub json: bool,
}

pub fn run(args: ApplyArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("sajimora apply error: {err:#}");
            1
        }
    }
}

fn run_inner(args: ApplyArgs) -> Result<()> {
    let repo_root = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("Cannot resolve repository path {:?}", args.repo))?;
    let allowed_roots = vec![repo_root.clone()];

    let mut query_params = serde_json::Map::new();
    query_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));
    query_params.insert("dryRun".to_string(), json!(args.dry_run));

    let mut mutation_obj = serde_json::Map::new();
    mutation_obj.insert("action".to_string(), json!(args.mutation.to_uppercase()));
    mutation_obj.insert("targetDto".to_string(), json!(args.r#type));
    mutation_obj.insert("field".to_string(), json!(args.field));
    if let Some(ref r) = args.rename_to {
        mutation_obj.insert("renameTo".to_string(), json!(r));
    }
    if args.json_property_retained {
        mutation_obj.insert("jsonPropertyRetained".to_string(), json!(true));
    }
    query_params.insert("mutation".to_string(), json!(mutation_obj));

    let output_str = sajimora_mcp::apply::run_apply_patches(&allowed_roots, &query_params)?;
    let parsed: serde_json::Value = serde_json::from_str(&output_str)?;

    if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
        anyhow::bail!(
            "{}: {}",
            error,
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
    let dry_run = parsed.get("dryRun").and_then(|v| v.as_bool()).unwrap_or(false);
    let action = parsed.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let target_dto = parsed.get("targetDto").and_then(|v| v.as_str()).unwrap_or("");
    let field = parsed.get("field").and_then(|v| v.as_str()).unwrap_or("");
    let applied_count = parsed["counts"]["applied"].as_u64().unwrap_or(0);
    let no_op_count = parsed["counts"]["noOp"].as_u64().unwrap_or(0);
    let abstained_count = parsed["counts"]["abstained"].as_u64().unwrap_or(0);

    println!("⚡ Sajimora Deterministic Consumer Patch Application");
    println!("--------------------------------------------------");
    println!("  Target DTO : {}", target_dto);
    println!("  Action     : {}", action);
    println!("  Field      : {}", field);
    if dry_run {
        println!("  Mode       : DRY RUN (no files modified)");
    } else {
        println!("  Mode       : LIVE (atomic writes committed)");
    }
    println!("--------------------------------------------------");

    if let Some(applied) = parsed.get("applied").and_then(|v| v.as_array()) {
        if !applied.is_empty() {
            println!("  Applied patches ({}):", applied.len());
            for p in applied {
                let file = p["file"].as_str().unwrap_or("?");
                let ptype = p["type"].as_str().unwrap_or("?");
                let written = p["written"].as_bool().unwrap_or(false);
                println!("    • [{ptype}] {file} (written: {written})");
            }
        }
    }

    if let Some(no_ops) = parsed.get("noOps").and_then(|v| v.as_array()) {
        if !no_ops.is_empty() {
            println!("  Idempotent no-ops ({}):", no_ops.len());
            for n in no_ops {
                let file = n["file"].as_str().unwrap_or("?");
                let reason = n["reason"].as_str().unwrap_or("ALREADY_APPLIED");
                println!("    • {file} ({reason})");
            }
        }
    }

    if let Some(abstentions) = parsed.get("abstentions").and_then(|v| v.as_array()) {
        if !abstentions.is_empty() {
            println!("  Manual review abstentions ({}):", abstentions.len());
            for a in abstentions {
                let file = a["file"].as_str().unwrap_or("?");
                let code = a["code"].as_str().unwrap_or("ABSTAINED");
                let reason = a["reason"].as_str().unwrap_or("");
                println!("    • [{code}] {file}: {reason}");
            }
        }
    }

    println!("--------------------------------------------------");
    println!(
        "Summary: {} applied, {} no-op, {} abstained",
        applied_count, no_op_count, abstained_count
    );
    if let Some(notice) = parsed.get("notice").and_then(|v| v.as_str()) {
        println!("Note: {}", notice);
    }

    Ok(())
}
