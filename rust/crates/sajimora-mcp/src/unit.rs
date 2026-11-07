//! unit.rs — MCP tool implementation for bounded symbolic unit test synthesis.
//!
//! Autonomous branch test generation for internal business calculation logic.
//! Solves path conditions via Tier 1 SMT solver and enforces strict 2-hop mock budget.

use anyhow::{bail, Context, Result};
use contract_core::service::validate_path_under_roots;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use verifier::symbolic::{synthesize_unit_tests_for_java, SynthesizedUnitTestSuite};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGenUnitRequest {
    pub file: String,
    pub method: Option<String>,
    pub out_file: Option<String>,
    pub budget_ms: Option<u64>,
}

pub fn run_gen_unit(
    req: McpGenUnitRequest,
    allowed_roots: &[PathBuf],
) -> Result<SynthesizedUnitTestSuite> {
    let source_path = PathBuf::from(&req.file);

    if !allowed_roots.is_empty() {
        validate_path_under_roots(&source_path, allowed_roots)?;
    }

    if !source_path.exists() {
        bail!("Target file not found: {:?}", source_path);
    }

    let source = fs::read_to_string(&source_path)
        .with_context(|| format!("Failed to read file {:?}", source_path))?;

    let budget = req.budget_ms.unwrap_or(50);
    let suite = synthesize_unit_tests_for_java(&source, req.method.as_deref(), budget)?;

    if let Some(out_path_str) = &req.out_file {
        let out_path = PathBuf::from(out_path_str);
        if !allowed_roots.is_empty() {
            validate_path_under_roots(&out_path, allowed_roots)?;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&out_path, &suite.test_source_code)?;
    }

    Ok(suite)
}
