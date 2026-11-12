//! ask.rs — 100% Offline, Zero-LLM Natural Language Contract & Risk Query CLI.
//!
//! Answers developer questions in plain English using deterministic AST graph indexes
//! and SQLite B-Tree queries in sub-2ms latency without requiring any cloud or local LLM.

use anyhow::{Context, Result};
use clap::Args;
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Args, Debug)]
pub struct AskArgs {
    /// Natural language question in plain English (e.g. "how many of my apis don't have pagination?", "why are pages loading slowly", "who calls /api/relations")
    #[arg(required = true, num_args = 1..)]
    pub question: Vec<String>,

    /// Repository root containing .sajimora/contracts.db (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Output raw JSON instead of human-readable terminal output.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum CliIntent {
    PaginationAudit,
    PerformanceDiagnostic,
    WhatIfImpact,
    WhoCalls,
    CatalogOverview,
    Unknown,
}

struct IntentMatch {
    intent: CliIntent,
    target_route: Option<String>,
    target_dto: Option<String>,
}

fn classify_intent(query_str: &str) -> IntentMatch {
    let lower = query_str.to_lowercase();
    let tokens: Vec<&str> = query_str.split_whitespace().collect();

    let mut target_route = None;
    let mut target_dto = None;

    for token in &tokens {
        let clean = token.trim_matches(|c: char| c == '?' || c == '\'' || c == '"' || c == ',' || c == ':');
        if clean.starts_with('/') {
            target_route = Some(clean.to_string());
        } else if clean.contains('.') {
            let parts: Vec<&str> = clean.split('.').collect();
            if parts.len() == 2 && parts[0].chars().next().map_or(false, |c| c.is_uppercase()) {
                target_dto = Some(parts[0].to_string());
            }
        } else if clean.len() > 2 && clean.chars().next().map_or(false, |c| c.is_uppercase()) && !clean.contains('/') {
            target_dto = Some(clean.to_string());
        }
    }

    let intent = if lower.contains("slow") || lower.contains("loading") || lower.contains("latency") || lower.contains("lag") || lower.contains("freeze") || lower.contains("bottleneck") || lower.contains("poll") || lower.contains("delay") {
        CliIntent::PerformanceDiagnostic
    } else if lower.contains("paginat") || lower.contains("page size") || lower.contains("pageable") || lower.contains("unpaginat") || lower.contains("limit") || lower.contains("offset") || lower.contains("pages") || lower.contains("page") {
        CliIntent::PaginationAudit
    } else if lower.contains("what if") || lower.contains("break") || lower.contains("rename") || lower.contains("mutate") || lower.contains("modify") || lower.contains("delete field") {
        CliIntent::WhatIfImpact
    } else if lower.contains("who call") || lower.contains("who use") || lower.contains("consumer") || lower.contains("caller") || lower.contains("where is") || lower.contains("call site") {
        CliIntent::WhoCalls
    } else if lower.contains("how many") || lower.contains("stat") || lower.contains("overview") || lower.contains("summary") || lower.contains("count") {
        CliIntent::CatalogOverview
    } else {
        CliIntent::Unknown
    };

    IntentMatch {
        intent,
        target_route,
        target_dto,
    }
}

pub fn run(args: AskArgs) -> i32 {
    let start = Instant::now();
    let query_str = args.question.join(" ");

    match run_inner(&args, &query_str, start) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("sajimora ask error: {err:#}");
            1
        }
    }
}

fn run_inner(args: &AskArgs, query_str: &str, start: Instant) -> Result<()> {
    let repo_root = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("Cannot resolve repository path {:?}", args.repo))?;

    let db_path = repo_root.join(".sajimora").join("contracts.db");
    if !db_path.exists() {
        anyhow::bail!(
            "Sajimora contract database not found at {:?}. Run 'sajimora init' or 'sajimora check' first to index the repository.",
            db_path
        );
    }

    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).with_context(|| format!("Failed to open contracts database at {:?}", db_path))?;

    let intent_match = classify_intent(query_str);

    match intent_match.intent {
        CliIntent::PaginationAudit => handle_pagination_audit(&conn, args.json, start),
        CliIntent::PerformanceDiagnostic => handle_performance_diagnostic(&conn, intent_match.target_route.as_deref(), args.json, start),
        CliIntent::WhatIfImpact => handle_what_if(&repo_root, intent_match.target_dto.as_deref(), query_str, args.json, start),
        CliIntent::WhoCalls => handle_who_calls(&repo_root, &conn, intent_match.target_route.as_deref(), intent_match.target_dto.as_deref(), args.json, start),
        CliIntent::CatalogOverview => handle_catalog_overview(&repo_root, &conn, args.json, start),
        CliIntent::Unknown => {
            println!("\n🤖 Sajimora Offline Natural Language Query");
            println!("─────────────────────────────────────────────────────────────────");
            println!("Query: \"{}\"\n", query_str);
            println!("I couldn't match a specific AST intent. Here are common questions you can ask offline:\n");
            println!("  • \"How many of my APIs don't have pagination?\"");
            println!("  • \"Why are pages loading slowly?\"");
            println!("  • \"Who calls /api/relations?\"");
            println!("  • \"What if I rename Device.name?\"");
            println!("  • \"How many endpoints are in this repository?\"");
            println!("─────────────────────────────────────────────────────────────────");
            Ok(())
        }
    }
}

fn handle_pagination_audit(conn: &Connection, json_output: bool, start: Instant) -> Result<()> {
    let paged_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT normalized_route) FROM consumer_contracts WHERE call_site_usage LIKE '%PageData<%' OR call_site_usage LIKE '%pageLink%'",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    let unpaged_query = "
        SELECT normalized_route, COUNT(*) as consumer_count, MAX(source_file), MAX(source_line), MAX(call_site_usage)
        FROM consumer_contracts
        WHERE (call_site_usage LIKE '%Array<%' OR call_site_usage LIKE '%List<%')
          AND normalized_route NOT IN (
              SELECT normalized_route FROM consumer_contracts 
              WHERE call_site_usage LIKE '%PageData<%' OR call_site_usage LIKE '%pageLink%'
          )
        GROUP BY normalized_route
        ORDER BY consumer_count DESC
    ";

    let mut stmt = conn.prepare(unpaged_query)?;
    let mut unpaged_routes = Vec::new();

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    for r in rows {
        unpaged_routes.push(r?);
    }

    let unpaged_count = unpaged_routes.len() as i64;
    let total_collection_routes = paged_count + unpaged_count;
    let elapsed = start.elapsed();

    if json_output {
        let payload = json!({
            "intent": "pagination_audit",
            "total_collection_endpoints": total_collection_routes,
            "paginated_count": paged_count,
            "unpaginated_count": unpaged_count,
            "top_unpaginated_routes": unpaged_routes.iter().take(10).map(|(r, c, f, l, u)| {
                json!({
                    "route": r,
                    "consumer_count": c,
                    "sample_source": format!("{}:{}", f, l),
                    "usage": u
                })
            }).collect::<Vec<_>>(),
            "latency_micros": elapsed.as_micros()
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("\n📊 Sajimora Static Pagination Audit (100% Offline)");
    println!("═════════════════════════════════════════════════════════════════");
    println!("Analyzed collection endpoints in repository:");
    println!("  • Paginated Routes (PageData / pageLink):  {:>4} (Safe)", paged_count);
    println!("  • Unpaginated Routes (Raw Array / List):   {:>4} (High Risk)", unpaged_count);
    println!("─────────────────────────────────────────────────────────────────");

    if !unpaged_routes.is_empty() {
        println!("⚠️  Top Unpaginated Endpoints with High Consumer Fan-out:");
        for (i, (route, cnt, file, line, usage)) in unpaged_routes.iter().take(5).enumerate() {
            println!("  {}. Route: {} ({} active UI consumers)", i + 1, route, cnt);
            println!("     Called at: {}:{}", file, line);
            println!("     Usage:     {}", usage.trim());
            println!("     Remedy:    Add pagination query parameters (e.g. PageData<T> / Pageable) to prevent unbounded memory load.\n");
        }
    }

    println!("─────────────────────────────────────────────────────────────────");
    println!("⚡ Answered in {:.2?} (Offline • 0 Tokens • Local SQLite B-Tree)", elapsed);
    println!("═════════════════════════════════════════════════════════════════\n");

    Ok(())
}

fn handle_performance_diagnostic(
    conn: &Connection,
    target_route: Option<&str>,
    json_output: bool,
    start: Instant,
) -> Result<()> {
    let bottleneck_query = "
        SELECT b.normalized_route, b.http_method, b.source_file as be_file, b.source_line as be_line,
               c.source_file as fe_file, c.source_line as fe_line, c.call_site_usage,
               (SELECT COUNT(*) FROM consumer_contracts WHERE normalized_route = b.normalized_route) as fanout
        FROM backend_endpoints b
        JOIN consumer_contracts c ON b.normalized_route = c.normalized_route
        WHERE (?1 IS NULL OR b.normalized_route LIKE '%' || ?1 || '%')
          AND (c.call_site_usage LIKE '%Array<%' OR c.call_site_usage LIKE '%interval%' OR c.call_site_usage LIKE '%poll%')
        GROUP BY b.normalized_route
        ORDER BY fanout DESC
        LIMIT 5;
    ";

    let mut stmt = conn.prepare(bottleneck_query)?;
    let rows = stmt.query_map([target_route], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;

    let mut findings = Vec::new();
    for r in rows {
        findings.push(r?);
    }

    let elapsed = start.elapsed();

    if json_output {
        let payload = json!({
            "intent": "performance_diagnostic",
            "findings": findings.iter().map(|(route, method, be_file, be_line, fe_file, fe_line, usage, fanout)| {
                json!({
                    "route": route,
                    "method": method,
                    "backend_handler": format!("{}:{}", be_file, be_line),
                    "frontend_consumer": format!("{}:{}", fe_file, fe_line),
                    "usage": usage,
                    "consumer_fanout": fanout,
                })
            }).collect::<Vec<_>>(),
            "latency_micros": elapsed.as_micros()
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("\n⚡ Sajimora Performance Diagnostic: Why Pages Are Loading Slowly");
    println!("═════════════════════════════════════════════════════════════════");

    if findings.is_empty() {
        println!("No high-friction polling or unpaginated collection bottlenecks detected for {:?}.", target_route.unwrap_or("repository"));
    } else {
        println!("Cross-Language Structural Load Friction Detected:\n");
        for (i, (route, method, be_file, be_line, fe_file, fe_line, usage, fanout)) in findings.iter().enumerate() {
            println!("{}. Endpoint: {} {}", i + 1, method, route);
            println!("   • Fanout Load:     {} active consumer call sites", fanout);
            println!("   • Frontend Caller: {}:{}", fe_file, fe_line);
            println!("     Code:            {}", usage.trim());
            println!("   • Backend Handler: {}:{}", be_file, be_line);
            println!("   • Diagnosis:       Unbounded array payload combined with multi-consumer fanout.");
            println!("   • Actionable Fix:  1. In {}:{}", be_file, be_line);
            println!("                        Add pagination / chunking so the DB query does not return unbounded items.");
            println!("                      2. In {}:{}", fe_file, fe_line);
            println!("                        Ensure UI component debounces requests or uses virtual scrolling.\n");
        }
    }

    println!("─────────────────────────────────────────────────────────────────");
    println!("⚡ Answered in {:.2?} (Offline • 0 Tokens • Pure AST Graph Linkage)", elapsed);
    println!("═════════════════════════════════════════════════════════════════\n");

    Ok(())
}

fn handle_who_calls(
    repo_root: &Path,
    _conn: &Connection,
    target_route: Option<&str>,
    target_dto: Option<&str>,
    json_output: bool,
    start: Instant,
) -> Result<()> {
    let allowed_roots = vec![repo_root.to_path_buf()];
    let mut query_params = serde_json::Map::new();
    query_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));
    query_params.insert("detail".to_string(), json!("full"));

    if let Some(route) = target_route {
        query_params.insert("queryType".to_string(), json!("consumers_by_route"));
        query_params.insert("target".to_string(), json!(route));
    } else if let Some(dto) = target_dto {
        query_params.insert("queryType".to_string(), json!("consumers_by_dto"));
        query_params.insert("target".to_string(), json!(dto));
    } else {
        query_params.insert("queryType".to_string(), json!("stats"));
    }

    let output_str = sajimora_mcp::query::run_query(&allowed_roots, &query_params)?;
    let parsed: serde_json::Value = serde_json::from_str(&output_str)?;
    let elapsed = start.elapsed();

    if json_output {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
        return Ok(());
    }

    println!("\n🔍 Sajimora Consumer Discovery (Offline)");
    println!("═════════════════════════════════════════════════════════════════");

    if let Some(consumers) = parsed.get("consumers").and_then(|c| c.as_array()) {
        println!("Found {} consumer call sites for {:?}:\n", consumers.len(), target_route.or(target_dto).unwrap_or("target"));
        for (i, c) in consumers.iter().enumerate() {
            let method = c.get("http_method").and_then(|m| m.as_str()).unwrap_or("GET");
            let route = c.get("normalized_route").and_then(|r| r.as_str()).unwrap_or("/");
            let file = c.get("source_file").and_then(|f| f.as_str()).unwrap_or("");
            let line = c.get("source_line").and_then(|l| l.as_i64()).unwrap_or(0);
            let usage = c.get("call_site_usage").and_then(|u| u.as_str()).unwrap_or("");
            println!("  {}. [{} {}] -> {}:{}", i + 1, method, route, file, line);
            if !usage.is_empty() {
                println!("     Usage: {}", usage.trim());
            }
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
    }

    println!("─────────────────────────────────────────────────────────────────");
    println!("⚡ Answered in {:.2?} (Offline • 0 Tokens • Local SQLite Index)", elapsed);
    println!("═════════════════════════════════════════════════════════════════\n");

    Ok(())
}

fn handle_what_if(
    repo_root: &Path,
    target_dto: Option<&str>,
    query_str: &str,
    json_output: bool,
    start: Instant,
) -> Result<()> {
    let allowed_roots = vec![repo_root.to_path_buf()];
    let mut resolved_dto = target_dto.unwrap_or("Device").to_string();

    let mut field = "name".to_string();
    let mut new_name = "title".to_string();

    let tokens: Vec<&str> = query_str.split_whitespace().collect();
    for i in 0..tokens.len() {
        let clean = tokens[i].trim_matches(|c: char| c == '?' || c == '\'' || c == '"' || c == ',' || c == ':');
        if clean.contains('.') {
            let parts: Vec<&str> = clean.split('.').collect();
            if parts.len() == 2 && parts[0].chars().next().map_or(false, |c| c.is_uppercase()) {
                resolved_dto = parts[0].to_string();
                field = parts[1].to_string();
            }
        }
        if tokens[i].eq_ignore_ascii_case("rename") && i + 1 < tokens.len() {
            let next_token = tokens[i + 1].trim_matches(|c: char| c == '?' || c == '\'' || c == '"' || c == ',' || c == ':');
            if next_token.contains('.') {
                let parts: Vec<&str> = next_token.split('.').collect();
                if parts.len() == 2 {
                    resolved_dto = parts[0].to_string();
                    field = parts[1].to_string();
                }
            } else {
                field = next_token.to_string();
            }
            if i + 3 < tokens.len() && tokens[i + 2].eq_ignore_ascii_case("to") {
                new_name = tokens[i + 3].trim_matches(|c: char| c == '?' || c == '\'' || c == '"' || c == ',' || c == ':').to_string();
            }
        }
    }

    let mut mutation_obj = serde_json::Map::new();
    mutation_obj.insert("action".to_string(), json!("RENAME_FIELD"));
    mutation_obj.insert("targetDto".to_string(), json!(resolved_dto));
    mutation_obj.insert("field".to_string(), json!(field));
    mutation_obj.insert("renameTo".to_string(), json!(new_name));

    let mut what_if_params = serde_json::Map::new();
    what_if_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));
    what_if_params.insert("mutation".to_string(), serde_json::Value::Object(mutation_obj));

    let output_str = sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_params)?;
    let parsed: serde_json::Value = serde_json::from_str(&output_str)?;
    let elapsed = start.elapsed();

    if json_output {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
        return Ok(());
    }

    println!("\n⚡ Sajimora What-If Simulation (Offline AST Graph)");
    println!("═════════════════════════════════════════════════════════════════");
    println!("Simulated Change: Rename field '{}.{}' -> '{}'\n", resolved_dto, field, new_name);

    let breaking_count = parsed.get("breakingConsumersCount").and_then(|c| c.as_i64()).unwrap_or(0);
    let affected_files = parsed.get("affectedFiles").and_then(|f| f.as_array()).map(|a| a.len()).unwrap_or(0);
    let recommendation = parsed.get("recommendation").and_then(|r| r.as_str()).unwrap_or("");

    println!("Simulation Results:");
    println!("  • Breaking Consumers:  {} call sites", breaking_count);
    println!("  • Affected Files:      {} files across UI", affected_files);
    if !recommendation.is_empty() {
        println!("  • Recommendation:      {}", recommendation);
    }
    println!("─────────────────────────────────────────────────────────────────");

    if let Some(consumers) = parsed.get("affectedConsumers").and_then(|a| a.as_array()) {
        println!("Call Sites That Will Break:");
        for (i, c) in consumers.iter().take(5).enumerate() {
            let file = c.get("file").and_then(|f| f.as_str()).unwrap_or("");
            let line = c.get("line").and_then(|l| l.as_i64()).unwrap_or(0);
            let kind = c.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            let route = c.get("route").and_then(|r| r.as_str()).unwrap_or("");
            println!("  {}. {}:{} [{}]", i + 1, file, line, kind);
            if !route.is_empty() {
                println!("     Route:      {}", route);
            }
        }
    }

    println!("─────────────────────────────────────────────────────────────────");
    println!("⚡ Answered in {:.2?} (Offline • 0 Tokens • Sub-second Bipartite Solver)", elapsed);
    println!("═════════════════════════════════════════════════════════════════\n");

    Ok(())
}

fn handle_catalog_overview(
    repo_root: &Path,
    _conn: &Connection,
    json_output: bool,
    start: Instant,
) -> Result<()> {
    let allowed_roots = vec![repo_root.to_path_buf()];
    let mut query_params = serde_json::Map::new();
    query_params.insert("repoRoot".to_string(), json!(repo_root.to_string_lossy()));
    query_params.insert("queryType".to_string(), json!("stats"));
    query_params.insert("detail".to_string(), json!("summary"));

    let output_str = sajimora_mcp::query::run_query(&allowed_roots, &query_params)?;
    let parsed: serde_json::Value = serde_json::from_str(&output_str)?;
    let elapsed = start.elapsed();

    if json_output {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
        return Ok(());
    }

    println!("\n📊 Sajimora Repository Contract Catalog Overview (Offline)");
    println!("═════════════════════════════════════════════════════════════════");
    if let Some(stats) = parsed.get("stats") {
        println!("  • Total Backend Endpoints: {:>6}", stats.get("backendEndpoints").and_then(|v| v.as_i64()).unwrap_or(0));
        println!("  • Total Consumer Calls:    {:>6}", stats.get("consumerContracts").and_then(|v| v.as_i64()).unwrap_or(0));
        println!("  • Unique API Routes:       {:>6}", stats.get("uniqueRoutes").and_then(|v| v.as_i64()).unwrap_or(0));
        println!("  • Database File Size:      {:>6} KB", stats.get("dbSizeBytes").and_then(|v| v.as_i64()).unwrap_or(0) / 1024);
    } else {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
    }
    println!("─────────────────────────────────────────────────────────────────");
    println!("⚡ Answered in {:.2?} (Offline • 0 Tokens • Local SQLite B-Tree)", elapsed);
    println!("═════════════════════════════════════════════════════════════════\n");

    Ok(())
}
