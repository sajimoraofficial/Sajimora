//! query.rs -- Sub-millisecond SQLite B-Tree contract queries for MCP.
//!
//! Provides zero-token-waste, zero-heap-growth contract intelligence for AI coding agents.

use anyhow::{bail, Context, Result};
use rmcp::model::Tool;
use source_index::contracts_db::{
    get_catalog_stats, open_reader, query_consumers_by_dto, query_consumers_by_route,
    query_endpoints_by_dto, sync_if_needed,
};
use crate::snippet::extract_source_snippet;
use source_index::endpoint_impact::resolve_repo_root;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

pub const TOOL_NAME: &str = "sajimora_query";

pub fn tool_definition() -> Tool {
    let mut schema_map = serde_json::Map::new();
    schema_map.insert("type".to_string(), serde_json::json!("object"));
    schema_map.insert(
        "properties".to_string(),
        serde_json::json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root containing .sajimora/init-manifest.json; must resolve under an allowed root"
            },
            "queryType": {
                "type": "string",
                "enum": ["consumers_by_route", "consumers_by_dto", "endpoints_by_dto", "stats"],
                "description": "Query selector: consumers_by_route, consumers_by_dto, endpoints_by_dto, or stats"
            },
            "target": {
                "type": "string",
                "description": "Route path ('/api/user/{id}'), DTO name ('User'), or empty for stats"
            },
            "method": {
                "type": "string",
                "description": "Optional HTTP method filter (GET, POST, PUT, DELETE, etc.)"
            },
            "detail": {
                "type": "string",
                "enum": ["summary", "full"],
                "default": "summary",
                "description": "Default 'summary' returns service names and match counts (~40 tokens); 'full' includes exact call-site source lines"
            }
        }),
    );
    schema_map.insert(
        "required".to_string(),
        serde_json::json!(["repoRoot", "queryType"]),
    );

    Tool::new(
        TOOL_NAME,
        "Sub-millisecond SQLite B-Tree query over pre-indexed API and consumer contracts. Returns exact callers, routes, and DTO bindings without reading files or wasting LLM tokens.",
        Arc::new(schema_map),
    )
}

pub fn run_query(
    allowed_roots: &[PathBuf],
    args: &serde_json::Map<String, serde_json::Value>,
) -> Result<String> {
    if allowed_roots.is_empty() {
        bail!("{TOOL_NAME} requires at least one server-configured allowed root");
    }

    let repo_arg = args
        .get("repoRoot")
        .and_then(serde_json::Value::as_str)
        .filter(|t| !t.is_empty())
        .context("Missing required argument: 'repoRoot'")?;
    let repo_path = PathBuf::from(repo_arg);
    if !repo_path.is_absolute() {
        bail!("repoRoot must be an absolute path");
    }
    let repo_root = resolve_repo_root(&repo_path, allowed_roots)?;

    let query_type = args
        .get("queryType")
        .and_then(serde_json::Value::as_str)
        .context("Missing required argument: 'queryType'")?;

    let target = args
        .get("target")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    let method = args
        .get("method")
        .and_then(serde_json::Value::as_str)
        .filter(|m| !m.is_empty());

    let detail = args
        .get("detail")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("summary");

    // Ensure database exists and is synchronized with sealed baseline
    let db_path = match sync_if_needed(&repo_root) {
        Ok(p) => p,
        Err(e) => {
            return Ok(serde_json::json!({
                "error": "SEALED_BASELINE_MISSING",
                "message": format!("Contract baseline error: {e}. Run 'sajimora init' to seal contracts."),
                "repoRoot": repo_root.display().to_string(),
            }).to_string());
        }
    };

    let conn = open_reader(&db_path)?;
    let start = Instant::now();

    match query_type {
        "stats" => {
            let stats = get_catalog_stats(&conn, &db_path)?;
            let elapsed_micros = start.elapsed().as_micros();
            Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_QUERY_V1",
                "queryType": "stats",
                "latencyMicros": elapsed_micros,
                "stats": {
                    "backendEndpoints": stats.backend_endpoints_count,
                    "consumerContracts": stats.consumer_contracts_count,
                    "uniqueRoutes": stats.unique_routes_count,
                    "dbSizeBytes": stats.db_size_bytes
                }
            }).to_string())
        }
        "consumers_by_route" => {
            let matches = query_consumers_by_route(&conn, target, method)?;
            let elapsed_micros = start.elapsed().as_micros();
            if detail == "summary" {
                let mut file_counts = std::collections::BTreeMap::new();
                for m in &matches {
                    *file_counts.entry(m.source_file.clone()).or_insert(0usize) += 1;
                }
                let files: Vec<_> = file_counts
                    .into_iter()
                    .map(|(file, count)| serde_json::json!({ "file": file, "callSites": count }))
                    .collect();
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V1",
                    "queryType": "consumers_by_route",
                    "target": target,
                    "method": method,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "files": files
                }).to_string())
            } else {
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V1",
                    "queryType": "consumers_by_route",
                    "target": target,
                    "method": method,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "consumers": matches
                }).to_string())
            }
        }
        "consumers_by_dto" => {
            let matches = query_consumers_by_dto(&conn, target)?;
            let elapsed_micros = start.elapsed().as_micros();
            if detail == "summary" {
                let mut files = std::collections::BTreeSet::new();
                for m in &matches {
                    files.insert(m.source_file.clone());
                }
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V1",
                    "queryType": "consumers_by_dto",
                    "targetDto": target,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "affectedFiles": files.into_iter().collect::<Vec<_>>()
                }).to_string())
            } else {
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V1",
                    "queryType": "consumers_by_dto",
                    "targetDto": target,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "consumers": matches
                }).to_string())
            }
        }
        "endpoints_by_dto" => {
            let matches = query_endpoints_by_dto(&conn, target)?;
            let elapsed_micros = start.elapsed().as_micros();
            if detail == "summary" {
                let endpoints: Vec<_> = matches
                    .iter()
                    .map(|e| {
                        let mut item = serde_json::json!({
                            "endpoint": format!("{} {} ({}:{})", e.http_method, e.raw_path, e.source_file, e.source_line),
                            "method": e.http_method,
                            "route": e.raw_path,
                            "file": e.source_file,
                            "line": e.source_line,
                        });
                        if let Some(snip) = extract_source_snippet(&repo_root, &e.source_file, e.source_line, 2) {
                            item["snippet"] = serde_json::json!(snip);
                        }
                        item
                    })
                    .collect();
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V2",
                    "queryType": "endpoints_by_dto",
                    "targetDto": target,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "endpoints": endpoints
                }).to_string())
            } else {
                Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_QUERY_V1",
                    "queryType": "endpoints_by_dto",
                    "targetDto": target,
                    "matchCount": matches.len(),
                    "latencyMicros": elapsed_micros,
                    "endpoints": matches
                }).to_string())
            }
        }
        other => bail!("Unknown queryType: {other}; expected 'consumers_by_route', 'consumers_by_dto', 'endpoints_by_dto', or 'stats'"),
    }
}
