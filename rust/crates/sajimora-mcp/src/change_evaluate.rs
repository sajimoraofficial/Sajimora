//! change_evaluate.rs — MCP surface for Expected Change Model evaluation.
//!
//! The tool refuses to run without a configured allowed root and validates
//! every path it reads or writes against those roots.

use anyhow::{bail, Context, Result};
use rmcp::model::Tool;
use source_index::change_eval::{evaluate, render_report, resolve_output_path, EvaluationRequest};
use source_index::endpoint_impact::resolve_repo_root;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TOOL_NAME: &str = "sajimora_change_evaluate";

pub fn tool_definition() -> Tool {
    let mut schema_map = serde_json::Map::new();
    schema_map.insert("type".to_string(), serde_json::json!("object"));
    schema_map.insert(
        "properties".to_string(),
        serde_json::json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root whose Git history is evaluated; must resolve under a server-configured allowed root"
            },
            "ecmPath": {
                "type": "string",
                "description": "Expected Change Model JSON path. Relative paths resolve against repoRoot and must stay under an allowed root"
            },
            "base": {
                "type": "string",
                "description": "Optional base revision override; defaults to the ECM's base/baseCommitSha field"
            },
            "candidate": {
                "type": "string",
                "description": "Optional candidate revision override; defaults to the ECM's candidate/candidateCommitSha field"
            },
            "outputPath": {
                "type": "string",
                "description": "Optional report destination; relative paths resolve against repoRoot and the parent must already exist. Defaults to no write. Other Sajimora artifact names are refused"
            }
        }),
    );
    schema_map.insert(
        "required".to_string(),
        serde_json::json!(["repoRoot", "ecmPath"]),
    );

    Tool::new(
        TOOL_NAME,
        "Evaluate a declared Expected Change Model (expectedFiles, expectedSymbols, changeBoundary) against the structural Git change set between two revisions. Classifies every observed file mutation as INTENDED_MUTATION or UNINTENDED_REGRESSION, and every declaration as intended, unobserved, or unverifiable. Java symbol evidence is structural; files outside Java are evaluated at file level only. Advisory evidence only: never selects tests or enforces policy",
        Arc::new(schema_map),
    )
}

/// Run the evaluation and return the same report text the CLI writes.
pub fn run_change_evaluate(
    allowed_roots: &[PathBuf],
    args: &serde_json::Map<String, serde_json::Value>,
) -> Result<String> {
    if allowed_roots.is_empty() {
        bail!(
            "{TOOL_NAME} requires at least one server-configured allowed root; refusing to analyze without one"
        );
    }

    let repo_arg = args
        .get("repoRoot")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .context("Missing or invalid required argument: 'repoRoot'")?;
    let repo_path = PathBuf::from(repo_arg);
    if !repo_path.is_absolute() {
        bail!("repoRoot must be an absolute path");
    }
    let repo_root = resolve_repo_root(&repo_path, allowed_roots)?;

    let ecm_arg = args
        .get("ecmPath")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .context("Missing or invalid required argument: 'ecmPath'")?;
    let ecm_path = PathBuf::from(ecm_arg);
    let ecm_path = if ecm_path.is_absolute() {
        ecm_path
    } else {
        repo_root.join(ecm_path)
    };

    let base_override = optional_revision(args, "base")?;
    let candidate_override = optional_revision(args, "candidate")?;

    let output = match args
        .get("outputPath")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
    {
        Some(text) => Some(resolve_output_path(
            &repo_root,
            Some(Path::new(text)),
            allowed_roots,
        )?),
        None => None,
    };

    let request = EvaluationRequest {
        repo_root: repo_root.clone(),
        ecm_path: ecm_path.clone(),
        base_override,
        candidate_override,
    };
    let report = evaluate(allowed_roots, &request).context("Change evaluation failed")?;
    let text = render_report(&report)?;
    if let Some(path) = output {
        source_index::change_eval::write_report(&path, &text)?;
    }
    Ok(text)
}

fn optional_revision(
    args: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> Result<Option<String>> {
    match args.get(name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => {
            let text = value
                .as_str()
                .filter(|text| !text.is_empty())
                .with_context(|| format!("'{name}' must be a non-empty string"))?;
            Ok(Some(text.to_string()))
        }
    }
}
