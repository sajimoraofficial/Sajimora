//! endpoint_impact.rs — MCP surface for the advisory endpoint-impact report.
//!
//! The tool refuses to run without a configured allowed root and validates
//! every path it reads or writes against those roots.

use anyhow::{bail, Context, Result};
use rmcp::model::Tool;
use source_index::endpoint_impact::{
    analyze, render_report, resolve_output_path, resolve_repo_root, write_report, ImpactMode,
    ImpactRequest,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TOOL_NAME: &str = "sajimora_endpoint_impact";

pub fn tool_definition() -> Tool {
    let mut schema_map = serde_json::Map::new();
    schema_map.insert("type".to_string(), serde_json::json!("object"));
    schema_map.insert(
        "properties".to_string(),
        serde_json::json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root containing .sajimora/init-manifest.json; must resolve under a server-configured allowed root"
            },
            "mode": {
                "type": "string",
                "enum": ["workingTreeVsHead", "stagedVsHead", "commitRange"],
                "description": "Default workingTreeVsHead. stagedVsHead reads only Git index blobs, so unstaged edits are not observable. commitRange compares two committed trees and requires commitRange"
            },
            "commitRange": {
                "type": "string",
                "description": "base..candidate for mode=commitRange. Both sides are resolved with rev-parse --verify and read from Git trees; three-dot ranges are rejected"
            },
            "generatedTests": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional generated test files to scan for Sajimora synthesis markers; relative paths resolve against repoRoot"
            },
            "outputPath": {
                "type": "string",
                "description": "Optional report destination; relative paths resolve against repoRoot and the parent must already exist. Defaults to no write. The legacy impact-report.json name is refused"
            }
        }),
    );
    schema_map.insert("required".to_string(), serde_json::json!(["repoRoot"]));

    Tool::new(
        TOOL_NAME,
        "Advisory endpoint impact: map changed files at a Git revision boundary to provider endpoints, sealed frontend call sites, and synthesis markers in named generated tests. Never selects tests or blocks a merge",
        Arc::new(schema_map),
    )
}

/// Run the analysis and return the same report text the CLI writes.
pub fn run_endpoint_impact(
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

    let mode = match args.get("mode").and_then(serde_json::Value::as_str) {
        Some(text) => ImpactMode::parse(text)?,
        None => ImpactMode::WorkingTree,
    };
    let commit_range = args
        .get("commitRange")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string);

    let generated_tests = match args.get("generatedTests") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => {
            let mut paths = Vec::with_capacity(items.len());
            for item in items {
                let text = item
                    .as_str()
                    .filter(|text| !text.is_empty())
                    .context("Elements of 'generatedTests' must be non-empty strings")?;
                let path = PathBuf::from(text);
                paths.push(if path.is_absolute() {
                    path
                } else {
                    repo_root.join(path)
                });
            }
            paths
        }
        Some(_) => bail!("'generatedTests' must be an array of strings"),
    };

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

    let request = ImpactRequest {
        repo_root: repo_root.clone(),
        mode,
        commit_range,
        generated_tests,
    };
    let report = analyze(allowed_roots, &request).context("Endpoint impact analysis failed")?;
    let text = render_report(&report);
    if let Some(path) = output {
        write_report(&path, &text)?;
    }
    Ok(text)
}
