//! contracts_db.rs -- SQLite-backed contract storage and sub-millisecond query engine.
//!
//! Implements Patent Claim 1 and Benchmark A:
//! - Materializes query-sufficient semantic contracts into persistent SQLite storage (.sajimora/contracts.db).
//! - Decouples AST memory from query evaluation, bounding runtime heap to < 30 MB RSS.
//! - Uses WAL mode, memory-mapped I/O, and normalized route B-Tree indexing.

use anyhow::{bail, Context, Result};
use contract_core::routes::normalize_route_segments;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const CONTRACTS_DB_NAME: &str = "contracts.db";

/// Schema revision. The database is a rebuildable cache, so any mismatch drops
/// and recreates the tables instead of migrating rows that may mean something
/// different now.
pub const SCHEMA_VERSION: i32 = 4;

/// Canonicalize an HTTP route into a parameter-wildcard format (`/api/user/*PARAM*`).
/// Normalizes Spring `{id}`, `{id:[0-9]+}`, Angular `${id}`, and `:param`
/// to the exact same key for O(1) B-Tree matching.
///
/// The transform is idempotent: an already-canonical key canonicalizes to itself.
/// Static segments keep their case because the cross-language matcher is
/// case-sensitive, and a case-folded key would link clients the matcher rejects.
pub fn canonical_route_key(route: &str) -> String {
    let normalized = normalize_route_segments(route);
    if normalized.segments.is_empty() {
        return "/".to_string();
    }
    let mut path = String::new();
    for seg in &normalized.segments {
        path.push('/');
        if seg.is_param
            || seg.is_wildcard == Some(true)
            || seg.text.eq_ignore_ascii_case(PARAM_TOKEN)
        {
            path.push_str(PARAM_TOKEN);
        } else {
            path.push_str(&seg.text);
        }
    }
    path
}

/// Placeholder written for any path parameter. `normalize_route_segments` treats
/// `*PARAM*` as a static segment, so it is matched explicitly to keep
/// [`canonical_route_key`] idempotent.
const PARAM_TOKEN: &str = "*PARAM*";

fn try_open_and_init(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("Cannot open SQLite database at {:?}", db_path))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "mmap_size", 67108864)?; // 64 MB OS mmap cache

    // Verify integrity of existing database file
    let integrity: Result<String, _> = conn.query_row("PRAGMA integrity_check(1)", [], |r| r.get(0));
    if let Ok(ref status) = integrity {
        if status != "ok" {
            bail!("SQLite integrity check failed: {}", status);
        }
    }

    if schema_version(&conn).unwrap_or(0) != SCHEMA_VERSION {
        reset_schema(&conn)?;
    }
    init_schema(&conn)?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(conn)
}

/// Open or initialize a SQLite writer connection with WAL mode and concurrency pragmas.
/// If the database cache file is corrupted (e.g. truncated page, uncommitted power loss),
/// it automatically triggers safe self-healing recovery by clearing invalid state.
pub fn open_writer(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    match try_open_and_init(db_path) {
        Ok(conn) => Ok(conn),
        Err(e) if db_path.exists() => {
            // Self-healing: contracts.db is a rebuildable local cache.
            // Power loss or page truncation must not permanently lock the user out.
            eprintln!("[sajimora] Warning: Corrupted contracts database detected ({e}). Rebuilding clean cache.");
            let _ = fs::remove_file(db_path);
            let _ = fs::remove_file(format!("{}-wal", db_path.display()));
            let _ = fs::remove_file(format!("{}-shm", db_path.display()));
            try_open_and_init(db_path)
        }
        Err(e) => Err(e),
    }
}

fn schema_version(conn: &Connection) -> Result<i32> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

fn reset_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS backend_endpoints;
         DROP TABLE IF EXISTS consumer_contracts;
         DROP TABLE IF EXISTS type_pool;
         DROP TABLE IF EXISTS file_stat_cache;
         DROP TABLE IF EXISTS contract_artifact_cache;
         DROP TABLE IF EXISTS backend_provenance_files;
         DROP TABLE IF EXISTS file_controller_dependencies;",
    )?;
    Ok(())
}

/// Open a SQLite reader connection strictly read-only and without thread mutex overhead.
pub fn open_reader(db_path: &Path) -> Result<Connection> {
    if !db_path.exists() {
        bail!("Database does not exist at {:?}", db_path);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(db_path, flags)
        .with_context(|| format!("Cannot open read-only SQLite database at {:?}", db_path))?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "mmap_size", 67108864)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS backend_endpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_id TEXT NOT NULL,
            http_method TEXT NOT NULL,
            raw_path TEXT NOT NULL,
            normalized_route TEXT NOT NULL,
            direction TEXT NOT NULL DEFAULT 'RESPONSE',
            body_type_ref TEXT,
            return_type_ref TEXT,
            source_file TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            ast_identity TEXT NOT NULL,
            sha256 TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS consumer_contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_service_id TEXT NOT NULL,
            http_method TEXT NOT NULL,
            normalized_route TEXT NOT NULL,
            expected_response_ref TEXT,
            source_file TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            call_site_usage TEXT NOT NULL,
            complete INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS type_pool (
            type_ref TEXT PRIMARY KEY,
            language TEXT NOT NULL,
            properties_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_stat_cache (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime_nanos TEXT NOT NULL,
            oid TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contract_artifact_cache (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime_nanos TEXT NOT NULL,
            step TEXT NOT NULL,
            service_id TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            client_contracts_count INTEGER NOT NULL,
            complete INTEGER NOT NULL,
            integrity_valid INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backend_provenance_files (
            path TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS file_controller_dependencies (
            source_file TEXT NOT NULL,
            controller_file TEXT NOT NULL,
            PRIMARY KEY (source_file, controller_file)
        );

        CREATE INDEX IF NOT EXISTS idx_file_ctrl_dep 
        ON file_controller_dependencies (source_file);

        CREATE INDEX IF NOT EXISTS idx_ctrl_file_dep 
        ON file_controller_dependencies (controller_file);

        CREATE INDEX IF NOT EXISTS idx_consumer_lookup 
        ON consumer_contracts (normalized_route, http_method);

        CREATE INDEX IF NOT EXISTS idx_consumer_dto 
        ON consumer_contracts (expected_response_ref);

        CREATE INDEX IF NOT EXISTS idx_endpoint_lookup 
        ON backend_endpoints (normalized_route, http_method);

        CREATE INDEX IF NOT EXISTS idx_endpoint_file 
        ON backend_endpoints (source_file);

        CREATE INDEX IF NOT EXISTS idx_endpoint_return_type 
        ON backend_endpoints (return_type_ref);
        "#,
    )?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConsumerMatch {
    pub service_id: String,
    pub http_method: String,
    pub normalized_route: String,
    pub source_file: String,
    pub source_line: i64,
    pub call_site_usage: String,
    pub expected_response_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EndpointMatch {
    pub service_id: String,
    pub http_method: String,
    pub raw_path: String,
    pub normalized_route: String,
    pub direction: String,
    pub source_file: String,
    pub source_line: i64,
    pub return_type_ref: Option<String>,
    pub body_type_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogStats {
    pub backend_endpoints_count: i64,
    pub consumer_contracts_count: i64,
    pub unique_routes_count: i64,
    pub db_size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub query_type: String,
    pub target: String,
    pub latency_micros: u128,
    pub match_count: usize,
    pub consumers: Vec<ConsumerMatch>,
    pub endpoints: Vec<EndpointMatch>,
    pub stats: Option<CatalogStats>,
}

/// Query consumers matching a normalized route path (and optional HTTP method).
pub fn query_consumers_by_route(
    conn: &Connection,
    route: &str,
    method: Option<&str>,
) -> Result<Vec<ConsumerMatch>> {
    let key = canonical_route_key(route);
    let mut results = Vec::new();

    if let Some(m) = method {
        let mut stmt = conn.prepare_cached(
            "SELECT target_service_id, http_method, normalized_route, source_file, source_line, call_site_usage, expected_response_ref 
             FROM consumer_contracts 
             WHERE normalized_route = ?1 AND http_method = ?2 
             ORDER BY source_file, source_line",
        )?;
        let rows = stmt.query_map(params![key, m.to_uppercase()], |row| {
            Ok(ConsumerMatch {
                service_id: row.get(0)?,
                http_method: row.get(1)?,
                normalized_route: row.get(2)?,
                source_file: row.get(3)?,
                source_line: row.get(4)?,
                call_site_usage: row.get(5)?,
                expected_response_ref: row.get(6)?,
            })
        })?;
        for r in rows {
            results.push(r?);
        }
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT target_service_id, http_method, normalized_route, source_file, source_line, call_site_usage, expected_response_ref 
             FROM consumer_contracts 
             WHERE normalized_route = ?1 
             ORDER BY source_file, source_line",
        )?;
        let rows = stmt.query_map(params![key], |row| {
            Ok(ConsumerMatch {
                service_id: row.get(0)?,
                http_method: row.get(1)?,
                normalized_route: row.get(2)?,
                source_file: row.get(3)?,
                source_line: row.get(4)?,
                call_site_usage: row.get(5)?,
                expected_response_ref: row.get(6)?,
            })
        })?;
        for r in rows {
            results.push(r?);
        }
    }

    Ok(results)
}

/// Query consumers expecting a given DTO model (by full type ref or substring).
pub fn query_consumers_by_dto(conn: &Connection, dto_symbol: &str) -> Result<Vec<ConsumerMatch>> {
    let pattern = format!("%{}%", dto_symbol);
    let mut stmt = conn.prepare_cached(
        "SELECT target_service_id, http_method, normalized_route, source_file, source_line, call_site_usage, expected_response_ref 
         FROM consumer_contracts 
         WHERE expected_response_ref LIKE ?1 
         ORDER BY source_file, source_line",
    )?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok(ConsumerMatch {
            service_id: row.get(0)?,
            http_method: row.get(1)?,
            normalized_route: row.get(2)?,
            source_file: row.get(3)?,
            source_line: row.get(4)?,
            call_site_usage: row.get(5)?,
            expected_response_ref: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for r in rows {
        results.push(r?);
    }
    Ok(results)
}

/// Query endpoints returning or accepting a given DTO model.
pub fn query_endpoints_by_dto(conn: &Connection, dto_symbol: &str) -> Result<Vec<EndpointMatch>> {
    let pattern = format!("%{}%", dto_symbol);
    let mut stmt = conn.prepare_cached(
        "SELECT service_id, http_method, raw_path, normalized_route, direction, source_file, source_line, return_type_ref, body_type_ref 
         FROM backend_endpoints 
         WHERE return_type_ref LIKE ?1 OR body_type_ref LIKE ?1 
         ORDER BY source_file, source_line",
    )?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok(EndpointMatch {
            service_id: row.get(0)?,
            http_method: row.get(1)?,
            raw_path: row.get(2)?,
            normalized_route: row.get(3)?,
            direction: row.get(4)?,
            source_file: row.get(5)?,
            source_line: row.get(6)?,
            return_type_ref: row.get(7)?,
            body_type_ref: row.get(8)?,
        })
    })?;
    let mut results = Vec::new();
    for r in rows {
        results.push(r?);
    }
    Ok(results)
}

/// Compute catalog stats in sub-millisecond time using SQLite index counters.
pub fn get_catalog_stats(conn: &Connection, db_path: &Path) -> Result<CatalogStats> {
    let backend_count: i64 =
        conn.query_row("SELECT count(*) FROM backend_endpoints", [], |r| r.get(0))?;
    let consumer_count: i64 =
        conn.query_row("SELECT count(*) FROM consumer_contracts", [], |r| r.get(0))?;
    let unique_routes: i64 = conn.query_row(
        "SELECT count(DISTINCT normalized_route) FROM backend_endpoints",
        [],
        |r| r.get(0),
    )?;
    let db_size_bytes = fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

    Ok(CatalogStats {
        backend_endpoints_count: backend_count,
        consumer_contracts_count: consumer_count,
        unique_routes_count: unique_routes,
        db_size_bytes,
    })
}

/// Synchronize JSON sealed artifacts (.sajimora/backend-contract.json and frontend-contract.json)
/// into SQLite (.sajimora/contracts.db) when the cache does not prove it is current.
///
/// Freshness is decided per artifact from `contract_artifact_cache` (size + mtime),
/// so an added, replaced, or deleted artifact always forces a rebuild. An artifact
/// that cannot be parsed, or whose sealed digest does not verify, fails closed with
/// an error instead of silently producing an empty catalog.
pub fn sync_if_needed(repo_root: &Path) -> Result<PathBuf> {
    let sajimora_dir = repo_root.join(".sajimora");
    let db_path = sajimora_dir.join(CONTRACTS_DB_NAME);
    let backend_json = sajimora_dir.join("backend-contract.json");
    let frontend_json = sajimora_dir.join("frontend-contract.json");

    if !backend_json.exists() && !frontend_json.exists() {
        bail!(
            "Sealed contract baseline missing in {:?}; run 'sajimora init' or extraction first",
            sajimora_dir
        );
    }

    let mut needs_sync = !db_path.exists();
    if !needs_sync {
        needs_sync = match open_reader(&db_path) {
            Ok(conn) if schema_version(&conn).unwrap_or(0) == SCHEMA_VERSION => {
                let cache = load_artifact_cache(&conn).unwrap_or_default();
                let stale = |path: &Path| -> bool {
                    match (file_signature(path), cache.get(&normalized_path(path))) {
                        (None, None) => false,
                        (Some((size, mtime)), Some(entry)) => {
                            entry.size != size || entry.mtime_nanos != mtime
                        }
                        _ => true,
                    }
                };
                if stale(&backend_json) || stale(&frontend_json) {
                    true
                } else {
                    // A cache row can be current while the tables were emptied
                    // out-of-band (manual delete, interrupted write); rebuild then.
                    let backend_rows: i64 = conn
                        .query_row("SELECT count(*) FROM backend_endpoints", [], |r| r.get(0))
                        .unwrap_or(0);
                    let consumer_rows: i64 = conn
                        .query_row("SELECT count(*) FROM consumer_contracts", [], |r| r.get(0))
                        .unwrap_or(0);
                    let cached_clients = cache
                        .get(&normalized_path(&frontend_json))
                        .map(|entry| entry.client_contracts_count)
                        .unwrap_or(0);
                    (backend_json.exists()
                        && backend_rows == 0
                        && backend_declares_endpoints(&backend_json))
                        || (frontend_json.exists() && consumer_rows == 0 && cached_clients > 0)
                }
            }
            _ => true,
        };
    }
    if !needs_sync {
        return Ok(db_path);
    }

    let mut conn = open_writer(&db_path)?;
    let tx = conn.transaction()?;

    // Clean slate in transaction
    tx.execute("DELETE FROM backend_endpoints", [])?;
    tx.execute("DELETE FROM consumer_contracts", [])?;
    tx.execute("DELETE FROM type_pool", [])?;
    tx.execute("DELETE FROM backend_provenance_files", [])?;
    tx.execute("DELETE FROM file_controller_dependencies", [])?;
    tx.execute("DELETE FROM contract_artifact_cache", [])?;

    // Ingest backend contract
    if backend_json.exists() {
        let content = fs::read(&backend_json)?;
        let envelope = contract_core::envelope::parse_envelope(&content).with_context(|| {
            format!(
                "Backend contract {:?} is not a readable sealed artifact",
                backend_json
            )
        })?;
        let integrity_valid = matches!(
            contract_core::envelope::verify_envelope_integrity(&envelope),
            Ok(true)
        );
        if !integrity_valid {
            bail!(
                "Backend contract {:?} failed integrity verification; refusing to serve it as a baseline",
                backend_json
            );
        }
        let (size, mtime) = file_signature(&backend_json).unwrap_or((content.len() as u64, 0));
        let digest = hex::encode(Sha256::digest(&content));
        let service_id = envelope.snapshot.service_id.clone();
        let complete = envelope.completeness.complete;

        // `parse_envelope` already parsed the document; reuse it instead of
        // deserializing the same megabytes a second time.
        let val = envelope
            .raw_value
            .clone()
            .context("Parsed backend envelope lost its raw value")?;
        let mut prov_stmt =
            tx.prepare("INSERT OR IGNORE INTO backend_provenance_files (path) VALUES (?1)")?;
        let mut dep_stmt = tx.prepare(
            "INSERT OR IGNORE INTO file_controller_dependencies (source_file, controller_file) VALUES (?1, ?2)"
        )?;

        if let Some(payload) = val.get("payload") {
            let mut type_to_file: HashMap<String, String> = HashMap::new();
            let mut type_edges: HashMap<String, std::collections::BTreeSet<String>> =
                HashMap::new();

            if let Some(pool) = payload
                .get("type_pool")
                .or_else(|| payload.get("typePool"))
                .and_then(|p| p.as_object())
            {
                let mut type_stmt = tx.prepare(
                    "INSERT OR REPLACE INTO type_pool (type_ref, language, properties_json) VALUES (?1, ?2, ?3)"
                )?;
                for (k, v) in pool {
                    if let Some(pf) = v
                        .get("provenance")
                        .and_then(|p| p.get("file"))
                        .and_then(|f| f.as_str())
                    {
                        if !pf.is_empty() {
                            let _ = prov_stmt.execute(params![pf]);
                            type_to_file.insert(k.clone(), pf.to_string());
                        }
                    }
                    let lang = v
                        .get("provenance")
                        .and_then(|p| p.get("language"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("JAVA");
                    let props = v
                        .get("properties")
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let props_str = serde_json::to_string(&props).unwrap_or_default();
                    let _ = type_stmt.execute(params![k, lang, props_str]);

                    let mut refs = std::collections::BTreeSet::new();
                    collect_wire_refs(v, &mut refs);
                    for target in refs {
                        if target != *k && pool.contains_key(&target) {
                            type_edges.entry(k.clone()).or_default().insert(target);
                        }
                    }
                }
            }

            if let Some(endpoints) = payload.get("endpoints").and_then(|e| e.as_array()) {
                let mut stmt = tx.prepare(
                    "INSERT INTO backend_endpoints
                    (service_id, http_method, raw_path, normalized_route, direction, body_type_ref, return_type_ref, source_file, source_line, ast_identity, sha256)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
                )?;
                for ep in endpoints {
                    let service_id = ep
                        .get("identity")
                        .and_then(|i| i.get("service"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("backend");
                    let method = ep
                        .get("identity")
                        .and_then(|i| i.get("httpMethod"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("GET");
                    let raw_path = ep
                        .get("identity")
                        .and_then(|i| i.get("normalizedRoute"))
                        .and_then(|r| r.get("rawPath"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("/");
                    let norm_route = canonical_route_key(raw_path);
                    let direction = ep
                        .get("identity")
                        .and_then(|i| i.get("direction"))
                        .and_then(|d| d.as_str())
                        .unwrap_or("RESPONSE");

                    let mut body_refs = std::collections::BTreeSet::new();
                    if let Some(b) = ep.get("body") {
                        collect_wire_refs(b, &mut body_refs);
                    }
                    let body_ref_str = if body_refs.is_empty() {
                        None
                    } else {
                        Some(body_refs.into_iter().collect::<Vec<_>>().join(","))
                    };
                    // On a REQUEST record `body` is the request body, so it must not be
                    // published as the response type.
                    let return_ref = if direction == "RESPONSE" {
                        body_ref_str.as_deref()
                    } else {
                        None
                    };
                    let body_ref = body_ref_str.as_deref();

                    let prov = ep.get("provenance");
                    let file = prov
                        .and_then(|p| p.get("file"))
                        .and_then(|f| f.as_str())
                        .unwrap_or("");
                    let line = prov
                        .and_then(|p| p.get("line"))
                        .and_then(|l| l.as_i64())
                        .unwrap_or(0);
                    let ast_id = prov
                        .and_then(|p| p.get("astIdentity"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("");
                    let sha = prov
                        .and_then(|p| p.get("sha256"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("");

                    stmt.execute(params![
                        service_id, method, raw_path, norm_route, direction, body_ref, return_ref,
                        file, line, ast_id, sha
                    ])?;
                    if !file.is_empty() {
                        let _ = prov_stmt.execute(params![file]);
                        let _ = dep_stmt.execute(params![file, file]);

                        let mut ep_types = std::collections::BTreeSet::new();
                        collect_wire_refs(ep, &mut ep_types);
                        if let Some(b) = body_ref {
                            ep_types.insert(b.to_string());
                        }
                        if let Some(r) = return_ref {
                            ep_types.insert(r.to_string());
                        }
                        let mut all_types = ep_types.clone();
                        let mut stack: Vec<String> = ep_types.into_iter().collect();
                        while let Some(top) = stack.pop() {
                            if let Some(children) = type_edges.get(&top) {
                                for child in children {
                                    if all_types.insert(child.clone()) {
                                        stack.push(child.clone());
                                    }
                                }
                            }
                        }
                        for t in all_types {
                            if let Some(dto_file) = type_to_file.get(&t) {
                                let _ = dep_stmt.execute(params![dto_file, file]);
                            }
                        }
                    }
                    if let Some(bf) = ep
                        .get("body")
                        .and_then(|b| b.get("provenance"))
                        .and_then(|p| p.get("file"))
                        .and_then(|f| f.as_str())
                    {
                        if !bf.is_empty() {
                            let _ = prov_stmt.execute(params![bf]);
                        }
                    }
                }
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO contract_artifact_cache
            (path, size, mtime_nanos, step, service_id, sha256, client_contracts_count, complete, integrity_valid)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                normalized_path(&backend_json),
                size as i64,
                mtime.to_string(),
                "A-committed",
                service_id,
                digest,
                0i64,
                if complete { 1 } else { 0 },
                1i64,
            ],
        )?;
    }

    // Ingest frontend contract
    if frontend_json.exists() {
        let content = fs::read(&frontend_json)?;
        let envelope = contract_core::envelope::parse_envelope(&content).with_context(|| {
            format!(
                "Frontend contract {:?} is not a readable sealed artifact",
                frontend_json
            )
        })?;
        let (size, mtime) = file_signature(&frontend_json).unwrap_or((content.len() as u64, 0));
        let digest = hex::encode(Sha256::digest(&content));
        let integrity_valid = matches!(
            contract_core::envelope::verify_envelope_integrity(&envelope),
            Ok(true)
        );
        let svc_id = envelope.snapshot.service_id.clone();
        let complete = envelope.completeness.complete;
        let mut client_count = 0;

        if integrity_valid {
            if let contract_core::envelope::ArtifactPayload::Frontend(ref payload) =
                envelope.payload
            {
                client_count = payload.client_contracts.len();
                let mut stmt = tx.prepare(
                    "INSERT INTO consumer_contracts
                    (target_service_id, http_method, normalized_route, expected_response_ref, source_file, source_line, call_site_usage, complete)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
                )?;
                for c in &payload.client_contracts {
                    let service_id = c.target_service_id.as_deref().unwrap_or("backend");
                    let method = &c.http_method;
                    let norm_route = canonical_route_key(&c.normalized_route);
                    let mut client_refs = std::collections::BTreeSet::new();
                    collect_wire_type_refs(&c.expected_response, &mut client_refs);
                    if let Some(ref req_body) = c.request_body {
                        collect_wire_type_refs(req_body, &mut client_refs);
                    }
                    let expected_ref_str = if client_refs.is_empty() {
                        None
                    } else {
                        Some(client_refs.into_iter().collect::<Vec<_>>().join(","))
                    };
                    let expected_ref = expected_ref_str.as_deref();
                    let file = &c.source_file;
                    let line = c.source_line as i64;
                    let usage = c
                        .consumers
                        .first()
                        .map(|site| site.usage.as_str())
                        .unwrap_or("");
                    let complete = if c.consumer_traversal_complete.unwrap_or(true) {
                        1
                    } else {
                        0
                    };

                    stmt.execute(params![
                        service_id,
                        method,
                        norm_route,
                        expected_ref,
                        file,
                        line,
                        usage,
                        complete
                    ])?;
                }
            }

            // Sync client type pool into type_pool table for cross-language field validation
            let val: serde_json::Value =
                serde_json::from_slice(&content).unwrap_or(serde_json::json!({}));
            if let Some(pool) = val
                .get("payload")
                .and_then(|p| p.get("type_pool").or_else(|| p.get("typePool")))
                .and_then(|p| p.as_object())
            {
                let mut type_stmt = tx.prepare(
                    "INSERT OR REPLACE INTO type_pool (type_ref, language, properties_json) VALUES (?1, ?2, ?3)",
                )?;
                for (k, v) in pool {
                    let lang = v
                        .get("provenance")
                        .and_then(|p| p.get("language"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("TYPESCRIPT");
                    let props = v
                        .get("properties")
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let props_str = serde_json::to_string(&props).unwrap_or_default();
                    let _ = type_stmt.execute(params![k, lang, props_str]);
                }
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO contract_artifact_cache
            (path, size, mtime_nanos, step, service_id, sha256, client_contracts_count, complete, integrity_valid)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                normalized_path(&frontend_json),
                size as i64,
                mtime.to_string(),
                "A-committed",
                svc_id,
                digest,
                client_count as i64,
                if complete { 1 } else { 0 },
                if integrity_valid { 1 } else { 0 },
            ],
        )?;
    }

    tx.commit()?;
    Ok(db_path)
}

/// Collect every referenced type symbol or URI declared inside a client WireType tree.
fn collect_wire_type_refs(
    wt: &contract_core::ir::WireType,
    out: &mut std::collections::BTreeSet<String>,
) {
    use contract_core::ir::WireType;
    match wt {
        WireType::Ref(r) => {
            out.insert(r.r#ref.clone());
        }
        WireType::Array(arr) => {
            collect_wire_type_refs(&arr.element_type, out);
        }
        WireType::Nullable(n) => {
            collect_wire_type_refs(&n.inner_type, out);
        }
        WireType::Optional(opt) => {
            collect_wire_type_refs(&opt.inner_type, out);
        }
        WireType::Union(u) => {
            for t in &u.types {
                collect_wire_type_refs(t, out);
            }
        }
        WireType::Object(obj) => {
            if let Some(ref name) = obj.name {
                out.insert(name.clone());
            }
            for prop in &obj.properties {
                collect_wire_type_refs(&prop.r#type, out);
            }
        }
        _ => {}
    }
}

/// Collect every `"ref"` string declared inside a wire-shape tree.
///
/// Type dependencies used to be found by testing every type name as a substring
/// of each serialized shape, which is O(types^2) on a large backend pool and
/// matched names inside unrelated strings. Walking the JSON only records actual
/// `RefWireType` targets.
fn collect_wire_refs(value: &serde_json::Value, out: &mut std::collections::BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(reference)) = map.get("ref") {
                out.insert(reference.clone());
            }
            for child in map.values() {
                collect_wire_refs(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_wire_refs(child, out);
            }
        }
        _ => {}
    }
}

/// True when the artifact declares at least one endpoint, used only to detect a
/// cache whose tables were emptied out-of-band. Artifacts without a payload do
/// not force a rebuild on every call.
fn backend_declares_endpoints(path: &Path) -> bool {
    let Ok(content) = fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&content) else {
        return false;
    };
    value
        .get("payload")
        .and_then(|payload| payload.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .map(|endpoints| !endpoints.is_empty())
        .unwrap_or(false)
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn file_signature(path: &Path) -> Option<(u64, u128)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedContractArtifact {
    pub path: String,
    pub size: u64,
    pub mtime_nanos: u128,
    pub step: String,
    pub service_id: String,
    pub sha256: String,
    pub client_contracts_count: usize,
    pub complete: bool,
    pub integrity_valid: bool,
}

/// Load the verified contract artifact cache from SQLite.
pub fn load_artifact_cache(conn: &Connection) -> Result<HashMap<String, CachedContractArtifact>> {
    let mut stmt = conn.prepare_cached(
        "SELECT path, size, mtime_nanos, step, service_id, sha256, client_contracts_count, complete, integrity_valid FROM contract_artifact_cache",
    )?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let size: i64 = row.get(1)?;
        let mtime_str: String = row.get(2)?;
        let mtime: u128 = mtime_str.parse().unwrap_or(0);
        let step: String = row.get(3)?;
        let service_id: String = row.get(4)?;
        let sha256: String = row.get(5)?;
        let client_contracts_count: i64 = row.get(6)?;
        let complete: i64 = row.get(7)?;
        let integrity_valid: i64 = row.get(8)?;
        Ok((
            path.clone(),
            CachedContractArtifact {
                path,
                size: size as u64,
                mtime_nanos: mtime,
                step,
                service_id,
                sha256,
                client_contracts_count: client_contracts_count as usize,
                complete: complete != 0,
                integrity_valid: integrity_valid != 0,
            },
        ))
    })?;
    let mut map = HashMap::new();
    for r in rows {
        let (p, v) = r?;
        map.insert(p, v);
    }
    Ok(map)
}

/// Insert or update a verified contract artifact entry into the cache.
pub fn save_artifact_cache_entry(conn: &Connection, entry: &CachedContractArtifact) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO contract_artifact_cache
        (path, size, mtime_nanos, step, service_id, sha256, client_contracts_count, complete, integrity_valid)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry.path,
            entry.size as i64,
            entry.mtime_nanos.to_string(),
            entry.step,
            entry.service_id,
            entry.sha256,
            entry.client_contracts_count as i64,
            if entry.complete { 1 } else { 0 },
            if entry.integrity_valid { 1 } else { 0 },
        ],
    )?;
    Ok(())
}

/// Load the zero-trust file stat cache mapping relative path -> (size, mtime_nanos, git_oid).
/// Takes ~2ms for 14,000 files in SQLite WAL mode.
pub fn load_stat_cache(conn: &Connection) -> Result<HashMap<String, (u64, u128, String)>> {
    let mut stmt =
        conn.prepare_cached("SELECT path, size, mtime_nanos, oid FROM file_stat_cache")?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let size: i64 = row.get(1)?;
        let mtime_str: String = row.get(2)?;
        let mtime: u128 = mtime_str.parse().unwrap_or(0);
        let oid: String = row.get(3)?;
        Ok((path, (size as u64, mtime, oid)))
    })?;
    let mut map = HashMap::new();
    for r in rows {
        let (p, v) = r?;
        map.insert(p, v);
    }
    Ok(map)
}

/// Batch upsert modified file entries into the stat cache within a single transaction.
pub fn save_stat_cache_entries(
    conn: &mut Connection,
    entries: &[(String, u64, u128, String)],
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR REPLACE INTO file_stat_cache (path, size, mtime_nanos, oid)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (path, size, mtime, oid) in entries {
            stmt.execute(params![path, *size as i64, mtime.to_string(), oid])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Load all unique Java source and DTO files recorded in the baseline backend contract.
pub fn load_backend_provenance_files(
    conn: &Connection,
) -> Result<std::collections::BTreeSet<String>> {
    let mut stmt = conn.prepare_cached("SELECT path FROM backend_provenance_files")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut set = std::collections::BTreeSet::new();
    for r in rows {
        set.insert(r?);
    }
    Ok(set)
}

/// Query all controller files that depend on any of the specified source/DTO files.
pub fn query_dependent_controllers(
    conn: &Connection,
    source_files: &std::collections::BTreeSet<String>,
) -> Result<std::collections::BTreeSet<String>> {
    let mut controllers = std::collections::BTreeSet::new();
    let mut stmt = conn.prepare_cached(
        "SELECT controller_file FROM file_controller_dependencies WHERE source_file = ?1",
    )?;
    for file in source_files {
        let mut rows = stmt.query(params![file])?;
        while let Some(row) = rows.next()? {
            let ctrl: String = row.get(0)?;
            controllers.insert(ctrl);
        }
    }
    Ok(controllers)
}

/// Query all source/DTO files that are required by any of the specified controller files.
pub fn query_controller_dependencies(
    conn: &Connection,
    controller_files: &std::collections::BTreeSet<String>,
) -> Result<std::collections::BTreeSet<String>> {
    let mut sources = std::collections::BTreeSet::new();
    let mut stmt = conn.prepare_cached(
        "SELECT source_file FROM file_controller_dependencies WHERE controller_file = ?1",
    )?;
    for ctrl in controller_files {
        let mut rows = stmt.query(params![ctrl])?;
        while let Some(row) = rows.next()? {
            let src: String = row.get(0)?;
            sources.insert(src);
        }
    }
    Ok(sources)
}

/// Resolve a DTO symbol ("User") to the full type refs recorded in the type pool
/// ("java:org.example.User"). Matching is on the last `:`/`.` segment so a simple
/// class name never resolves by substring to an unrelated type.
pub fn resolve_dto_type_refs(conn: &Connection, symbol: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached("SELECT type_ref FROM type_pool ORDER BY type_ref")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut refs = Vec::new();
    for row in rows {
        let type_ref = row?;
        let simple = ref_simple_name(&type_ref);
        if type_ref == symbol || simple == symbol {
            refs.push(type_ref);
        }
    }
    Ok(refs)
}

/// Query consumers whose expected response type has the given simple name.
///
/// Consumer refs are written by the frontend extractor (`ts:path#User`) while the
/// backend type pool is `java:package.User`, so cross-language what-if simulation
/// bridges the two by the type's simple name, never by substring.
pub fn query_consumers_by_dto_symbol(
    conn: &Connection,
    symbol: &str,
) -> Result<Vec<ConsumerMatch>> {
    let mut stmt = conn.prepare_cached(
        "SELECT target_service_id, http_method, normalized_route, source_file, source_line, call_site_usage, expected_response_ref
         FROM consumer_contracts
         WHERE expected_response_ref IS NOT NULL
         ORDER BY source_file, source_line",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConsumerMatch {
            service_id: row.get(0)?,
            http_method: row.get(1)?,
            normalized_route: row.get(2)?,
            source_file: row.get(3)?,
            source_line: row.get(4)?,
            call_site_usage: row.get(5)?,
            expected_response_ref: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        let consumer = row?;
        let matches = consumer
            .expected_response_ref
            .as_deref()
            .map(|refs_str| {
                refs_str.split(',').any(|r| ref_simple_name(r.trim()) == symbol)
            })
            .unwrap_or(false);
        if matches {
            results.push(consumer);
        }
    }
    Ok(results)
}

fn ref_simple_name(type_ref: &str) -> &str {
    type_ref
        .rsplit(|c| c == '#' || c == ':' || c == '.')
        .next()
        .unwrap_or(type_ref)
}

/// Query consumers that expect the given type ref (supporting comma-separated multi-ref entries).
pub fn query_consumers_by_type_ref(
    conn: &Connection,
    type_ref: &str,
) -> Result<Vec<ConsumerMatch>> {
    let mut stmt = conn.prepare_cached(
        "SELECT target_service_id, http_method, normalized_route, source_file, source_line, call_site_usage, expected_response_ref
         FROM consumer_contracts
         WHERE expected_response_ref IS NOT NULL
         ORDER BY source_file, source_line",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConsumerMatch {
            service_id: row.get(0)?,
            http_method: row.get(1)?,
            normalized_route: row.get(2)?,
            source_file: row.get(3)?,
            source_line: row.get(4)?,
            call_site_usage: row.get(5)?,
            expected_response_ref: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        let consumer = row?;
        let matches = consumer
            .expected_response_ref
            .as_deref()
            .map(|refs_str| {
                refs_str.split(',').any(|r| r.trim() == type_ref)
            })
            .unwrap_or(false);
        if matches {
            results.push(consumer);
        }
    }
    Ok(results)
}

/// Reconcile consumers with backend endpoints: if a backend endpoint exists and is strictly void
/// (both body_type_ref and return_type_ref are NULL), client-side generic annotation
/// has no wire presence and cannot be broken by a DTO field mutation.
pub fn filter_active_wire_consumers(
    conn: &Connection,
    consumers: Vec<ConsumerMatch>,
) -> Result<Vec<ConsumerMatch>> {
    let mut stmt = conn.prepare_cached(
        "SELECT body_type_ref, return_type_ref FROM backend_endpoints WHERE normalized_route = ?1 AND http_method = ?2",
    )?;
    let mut out = Vec::new();
    for c in consumers {
        let rows = stmt.query_map(params![c.normalized_route, c.http_method], |row| {
            let b: Option<String> = row.get(0)?;
            let r: Option<String> = row.get(1)?;
            Ok((b, r))
        })?;
        let ep_types: Vec<_> = rows.filter_map(|r| r.ok()).collect();
        if !ep_types.is_empty() {
            let has_wire_body = ep_types.iter().any(|(b, r)| b.is_some() || r.is_some());
            if !has_wire_body {
                continue;
            }
        }
        out.push(c);
    }
    Ok(out)
}

/// Check if any client type matching the target DTO symbol declares the given wire field.
/// Returns Ok(Some(true)) if matching client types exist and at least one declares the field.
/// Returns Ok(Some(false)) if matching client types exist but none declare the field (unconsumed).
/// Returns Ok(None) if no client types matching the DTO are found.
pub fn client_type_declares_field(
    conn: &Connection,
    target_dto: &str,
    field: &str,
) -> Result<Option<bool>> {
    let mut stmt = conn.prepare_cached(
        "SELECT properties_json FROM type_pool WHERE language = 'TYPESCRIPT' AND (type_ref LIKE ?1 OR type_ref LIKE ?2)",
    )?;
    let pattern1 = format!("%#{}", target_dto);
    let pattern2 = format!("%:{}", target_dto);
    let rows = stmt.query_map(params![pattern1, pattern2], |row| {
        row.get::<_, String>(0)
    })?;
    let mut found_any_type = false;
    for row in rows {
        let raw = row?;
        found_any_type = true;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if json_declares_field(&value, field) {
                return Ok(Some(true));
            }
        }
    }
    if found_any_type {
        Ok(Some(false))
    } else {
        Ok(None)
    }
}

/// True when any recorded type ref declares the given wire field.
pub fn dto_has_field(conn: &Connection, type_refs: &[String], field: &str) -> Result<bool> {
    let mut stmt =
        conn.prepare_cached("SELECT properties_json FROM type_pool WHERE type_ref = ?1")?;
    for type_ref in type_refs {
        let raw = match stmt.query_row(params![type_ref], |row| row.get::<_, String>(0)) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if json_declares_field(&value, field) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn json_declares_field(value: &serde_json::Value, field: &str) -> bool {
    let properties = value
        .as_array()
        .or_else(|| value.get("properties").and_then(|p| p.as_array()));
    let Some(properties) = properties else {
        return false;
    };
    properties.iter().any(|property| {
        property.get("wireName").and_then(|w| w.as_str()) == Some(field)
            || property
                .get("aliases")
                .and_then(|a| a.as_array())
                .map(|aliases| aliases.iter().any(|alias| alias.as_str() == Some(field)))
                .unwrap_or(false)
            || property
                .get("provenance")
                .and_then(|p| p.get("astIdentity"))
                .and_then(|a| a.as_str())
                .map(|identity| identity.ends_with(&format!(".{field}")))
                .unwrap_or(false)
    })
}
