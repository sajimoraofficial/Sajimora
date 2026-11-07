//! query.rs — Sub-second contract database query CLI command.

use anyhow::{Context, Result};
use clap::Args;
use serde_json::json;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct QueryArgs {
    /// Repository root containing .sajimora/contracts.db (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Query consumer contracts matching an HTTP route pattern (e.g. "/api/user/*PARAM*" or "/api/user/{id}").
    #[arg(long)]
    pub route: Option<String>,

    /// Query consumers and endpoints associated with a DTO type symbol (e.g. "UserDto").
    #[arg(long)]
    pub dto: Option<String>,

    /// Query backend endpoints that return or accept a DTO type symbol (e.g. "UserDto").
    #[arg(long)]
    pub endpoint_dto: Option<String>,

    /// Display global catalog statistics (endpoints, consumers, unique routes, db size).
    #[arg(long)]
    pub stats: bool,

    /// Filter by HTTP method (GET, POST, PUT, DELETE, etc.).
    #[arg(long)]
    pub method: Option<String>,

    /// Output raw JSON instead of human-readable terminal output.
    #[arg(long)]
    pub json: bool,
}

pub fn run(args: QueryArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("sajimora query error: {err:#}");
            1
        }
    }
}

fn run_inner(args: QueryArgs) -> Result<()> {
    let repo_root = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("Cannot resolve repository path {:?}", args.repo))?;
    let allowed_roots = vec![repo_root.clone()];

    let mut query_params = serde_json::Map::new();
    query_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));
    query_params.insert("detail".to_string(), json!("full"));

    if args.stats {
        query_params.insert("queryType".to_string(), json!("stats"));
    } else if let Some(ref route) = args.route {
        query_params.insert("queryType".to_string(), json!("consumers_by_route"));
        query_params.insert("target".to_string(), json!(route));
        if let Some(ref m) = args.method {
            query_params.insert("method".to_string(), json!(m));
        }
    } else if let Some(ref dto) = args.dto {
        query_params.insert("queryType".to_string(), json!("consumers_by_dto"));
        query_params.insert("target".to_string(), json!(dto));
    } else if let Some(ref dto) = args.endpoint_dto {
        query_params.insert("queryType".to_string(), json!("endpoints_by_dto"));
        query_params.insert("target".to_string(), json!(dto));
    } else {
        query_params.insert("queryType".to_string(), json!("stats"));
    }

    let output_str = sajimora_mcp::query::run_query(&allowed_roots, &query_params)?;
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
    if args.stats || (args.route.is_none() && args.dto.is_none() && args.endpoint_dto.is_none()) {
        let stats = parsed.get("stats").unwrap_or(&parsed);
        let latency_us = parsed
            .get("latencyMicros")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!(
            "📊 Sajimora Contract Database Catalog Stats (took {} µs)",
            latency_us
        );
        println!("--------------------------------------------------");
        println!(
            "  Backend Endpoints   : {}",
            stats
                .get("backendEndpoints")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        );
        println!(
            "  Consumer Contracts  : {}",
            stats
                .get("consumerContracts")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        );
        println!(
            "  Unique Routes       : {}",
            stats
                .get("uniqueRoutes")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        );
        let size_kb = stats
            .get("dbSizeBytes")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            / 1024.0;
        println!("  Database Size       : {:.2} KB", size_kb);
        println!("--------------------------------------------------");
    } else if let Some(endpoints) = parsed.get("endpoints").and_then(|e| e.as_array()) {
        let latency_us = parsed
            .get("latencyMicros")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!(
            "🔍 Matched {} Endpoint(s) in {} µs:",
            endpoints.len(),
            latency_us
        );
        println!("--------------------------------------------------");
        for (i, endpoint) in endpoints.iter().enumerate() {
            let method = endpoint
                .get("http_method")
                .and_then(|m| m.as_str())
                .unwrap_or("GET");
            let route = endpoint
                .get("raw_path")
                .and_then(|r| r.as_str())
                .unwrap_or("/");
            let direction = endpoint
                .get("direction")
                .and_then(|d| d.as_str())
                .unwrap_or("");
            let file = endpoint
                .get("source_file")
                .and_then(|f| f.as_str())
                .unwrap_or("");
            let line = endpoint
                .get("source_line")
                .and_then(|l| l.as_i64())
                .unwrap_or(0);
            println!(
                "  {}. [{} {} {}] -> {}:{}",
                i + 1,
                method,
                route,
                direction,
                file,
                line
            );
        }
        println!("--------------------------------------------------");
    } else if let Some(consumers) = parsed.get("consumers").and_then(|c| c.as_array()) {
        let latency_us = parsed
            .get("latencyMicros")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!(
            "🔍 Matched {} Consumer Contract(s) in {} µs:",
            consumers.len(),
            latency_us
        );
        println!("--------------------------------------------------");
        for (i, c) in consumers.iter().enumerate() {
            let method = c
                .get("http_method")
                .and_then(|m| m.as_str())
                .unwrap_or("GET");
            let route = c
                .get("normalized_route")
                .and_then(|r| r.as_str())
                .unwrap_or("/");
            let file = c.get("source_file").and_then(|f| f.as_str()).unwrap_or("");
            let line = c.get("source_line").and_then(|l| l.as_i64()).unwrap_or(0);
            let usage = c
                .get("call_site_usage")
                .and_then(|u| u.as_str())
                .unwrap_or("");
            println!("  {}. [{} {}] -> {}:{}", i + 1, method, route, file, line);
            if !usage.is_empty() {
                println!("     Usage: {}", usage);
            }
        }
        println!("--------------------------------------------------");
    } else {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
    }

    Ok(())
}
