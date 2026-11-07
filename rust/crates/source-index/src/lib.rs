//! Bounded immutable source capture, recovery and isolated structural indexing.
pub mod budget;
pub mod call_sites;
pub mod change_eval;
pub mod contracts_db;
pub mod def_use;
pub mod discovery;
pub mod endpoint_impact;
pub mod express_routes;
pub mod file_system_routes;
pub mod html_templates;
/// Bounded Git plumbing (`git --no-replace-objects`, env-scrubbed, record-framed).
/// Public so the MCP adapter can read staged and tree revisions without a second,
/// weaker implementation of the same stream handling.
pub mod git_stream;
pub mod incremental;
pub mod java;
pub mod java_dsl_routes;
pub mod java_routes;
pub mod js_observed;
pub mod nestjs_routes;
pub mod nextjs_routes;
pub mod provider;
pub mod revision;
pub mod signature_diff;
pub mod ts_routes;
mod ts_shape;
pub mod wire_wrapper;
use anyhow::{bail, Context, Result};
use git_stream::{Batch, CHUNK_SIZE};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha1::Digest as _;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Debug)]
pub struct Metrics {
    pub build_id: String,
    pub revision: String,
    pub state: String,
    pub discovered_files: u64,
    pub java_files: u64,
    pub captured_files: u64,
    pub captured_bytes: u64,
    pub blocked_files: u64,
    pub elapsed_ms: u128,
    pub discovery_ms: u128,
    pub capture_ms: u128,
    pub chunk_buffer_bytes: usize,
    pub outstanding_blob_requests: usize,
    pub syntax_parsing_implemented: bool,
    pub reused_source_files: u64,
    pub fetched_blob_files: u64,
}

fn language(path: &str) -> &'static str {
    if path.ends_with(".java") {
        "JAVA"
    } else if path.ends_with(".ts") || path.ends_with(".tsx") {
        "TYPESCRIPT"
    } else if path.ends_with(".js") || path.ends_with(".jsx") {
        "JAVASCRIPT"
    } else if [
        ".json",
        ".properties",
        ".yaml",
        ".yml",
        ".xml",
        ".toml",
        ".gradle",
        ".lock",
    ]
    .iter()
    .any(|extension| path.ends_with(extension))
    {
        "CONFIG"
    } else {
        "OTHER"
    }
}

pub(crate) fn verify_writer_settings(db: &Connection) -> Result<()> {
    for (pragma, expected) in [
        ("foreign_keys", 1),
        ("synchronous", 1),
        ("temp_store", 1),
        ("cache_size", -32768),
        ("mmap_size", 0),
    ] {
        let value: i64 = db.query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))?;
        if value != expected {
            bail!("SQLite setting {pragma} did not take effect");
        }
    }
    let journal: String = db.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if journal != "wal" {
        bail!("SQLite WAL mode unavailable");
    }
    Ok(())
}

pub fn capture(repo: &Path, revision: &str, database: &Path, max_bytes: u64) -> Result<Metrics> {
    let metrics = capture_with_resume(repo, revision, database, max_bytes, false)?;
    incremental::publish(database, &metrics.build_id, false)?;
    Ok(metrics)
}

pub fn capture_with_resume(
    repo: &Path,
    revision: &str,
    database: &Path,
    max_bytes: u64,
    resume: bool,
) -> Result<Metrics> {
    capture_mode(repo, revision, database, max_bytes, resume, false)
}

pub fn capture_incremental(
    repo: &Path,
    revision: &str,
    database: &Path,
    max_bytes: u64,
) -> Result<Metrics> {
    capture_mode(repo, revision, database, max_bytes, true, true)
}

/// Optional deep cache scrub. Normal incremental updates trust previously
/// sealed content; workers always hash any source they actually parse.
pub fn verify_cache(database: &Path) -> Result<()> {
    let db = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768; PRAGMA mmap_size=0;")?;
    verify_writer_settings(&db)?;
    validate_sealed_sources(&db)
}

fn capture_mode(
    repo: &Path,
    revision: &str,
    database: &Path,
    max_bytes: u64,
    resume: bool,
    incremental: bool,
) -> Result<Metrics> {
    let start = Instant::now();
    if max_bytes == 0 || max_bytes > i64::MAX as u64 {
        bail!("Invalid blob limit");
    }
    let repo = repo.canonicalize()?;
    let pinned = git_stream::scalar(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
    )?;
    let format = git_stream::scalar(&repo, &["rev-parse", "--show-object-format"])?;
    let oid_len = match format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        _ => bail!("Unsupported Git object format"),
    };
    let build_id = hex::encode(Sha256::digest(
        format!("capture-v1\0{pinned}\0{format}\0{max_bytes}").as_bytes(),
    ));
    if !resume {
        // Refuse overwrite; failed builds remain available for diagnosis.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(database)
            .context("Database must be a new path")?;
    }
    let mut db =
        Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let initialize = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table'",
        [],
        |r| r.get::<_, i64>(0),
    )? == 0;
    if initialize {
        if incremental {
            bail!("INCREMENTAL_BASE_REQUIRED");
        }
        let schema = include_str!("../schema-v1.sql");
        let (settings, _) = schema
            .split_once("CREATE TABLE")
            .context("schema is missing tables")?;
        db.execute_batch(settings)?;
    } else {
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;")?;
        if incremental {
            incremental::begin(&mut db, &repo, &pinned, &build_id, max_bytes)?;
        }
        let stored: (String, String, String) = db.query_row(
            "SELECT build_id,scope_fingerprint,indexer_fingerprint FROM builds WHERE build_id=?1",
            [&build_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?.context("RESUME_IDENTITY_MISMATCH: repository, revision or capture profile changed")?;
        if stored
            != (
                build_id.clone(),
                "java-and-config-capture-v1".into(),
                "capture-v1".into(),
            )
        {
            bail!("RESUME_IDENTITY_MISMATCH: repository, revision or capture profile changed");
        }
        if !incremental {
            validate_sealed_sources(&db)?;
        }
    }
    verify_writer_settings(&db)?;
    if initialize {
        // DDL, extensions and identity become visible atomically. An interrupted
        // initialization leaves an empty database that explicit resume can retry.
        let schema = include_str!("../schema-v1.sql");
        let (_, tables) = schema
            .split_once("CREATE TABLE")
            .context("schema is missing tables")?;
        let tx = db.transaction()?;
        tx.execute_batch(&format!("CREATE TABLE{tables}"))?;
        tx.execute_batch("ALTER TABLE files ADD COLUMN source_sha256 TEXT REFERENCES source_blobs(source_sha256); ALTER TABLE builds ADD COLUMN error_detail TEXT; CREATE TABLE capture_staging (ordinal INTEGER PRIMARY KEY, bytes BLOB NOT NULL CHECK(length(bytes)<=1048576));")?;
        tx.execute("INSERT INTO builds(build_id,repository_id,revision,scope_fingerprint,configuration_fingerprint,indexer_fingerprint,state,discovered_files,terminal_files,created_at_ms) VALUES (?1,?2,?3,'java-and-config-capture-v1','pending','capture-v1','BUILDING',0,0,?4)", params![build_id, repo.to_string_lossy(), pinned, SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64])?;
        tx.commit()?;
    } else {
        incremental::ensure_schema(&db)?;
        db.execute(
            "UPDATE builds SET state='BUILDING',error_detail=NULL WHERE build_id=?1",
            [&build_id],
        )?;
        db.execute("DELETE FROM capture_staging", [])?;
        loop {
            let changed = db.execute("DELETE FROM source_chunks WHERE (source_sha256,chunk_ordinal) IN (SELECT c.source_sha256,c.chunk_ordinal FROM source_chunks c JOIN source_blobs b USING(source_sha256) WHERE b.state='WRITING' LIMIT 4)", [])?;
            if changed == 0 {
                break;
            }
        }
        db.execute("UPDATE files SET source_sha256=NULL,status='DISCOVERED' WHERE source_sha256 IN (SELECT source_sha256 FROM source_blobs WHERE state='WRITING')", [])?;
        db.execute("DELETE FROM blob_git_objects WHERE source_sha256 IN (SELECT source_sha256 FROM source_blobs WHERE state='WRITING')", [])?;
        db.execute("DELETE FROM source_blobs WHERE state='WRITING' AND source_sha256 NOT IN (SELECT source_sha256 FROM parse_units)", [])?;
    }
    incremental::ensure_schema(&db)?;
    db.execute(
        "UPDATE index_state SET pending_build_id=?1 WHERE singleton=1",
        [&build_id],
    )?;
    let mut metrics = Metrics {
        build_id,
        revision: pinned,
        state: "BUILDING".into(),
        discovered_files: 0,
        java_files: 0,
        captured_files: 0,
        captured_bytes: 0,
        blocked_files: 0,
        elapsed_ms: 0,
        discovery_ms: 0,
        capture_ms: 0,
        chunk_buffer_bytes: CHUNK_SIZE,
        outstanding_blob_requests: 1,
        syntax_parsing_implemented: false,
        reused_source_files: 0,
        fetched_blob_files: 0,
    };
    let result = execute(&mut db, &repo, oid_len, max_bytes, &mut metrics);
    if let Err(error) = result {
        db.execute("UPDATE files SET status='BLOCKED' WHERE build_id=?1 AND status IN ('DISCOVERED','INDEXING')", [&metrics.build_id])?;
        db.execute("UPDATE obligations SET status='UNKNOWN',reason='CAPTURE_FAILED' WHERE build_id=?1 AND status='PENDING'", [&metrics.build_id])?;
        db.execute("UPDATE builds SET state='FAILED',discovered_files=(SELECT count(*) FROM files WHERE build_id=?1),terminal_files=(SELECT count(*) FROM files WHERE build_id=?1),error_detail=?2 WHERE build_id=?1", params![metrics.build_id,format!("{error:#}")])?;
        return Err(error);
    }
    // Captured bytes are not syntax-qualified facts. Never advertise READY.
    metrics.state = "INCOMPLETE".into();
    metrics.elapsed_ms = start.elapsed().as_millis();
    db.execute("UPDATE builds SET state='INCOMPLETE',terminal_files=(SELECT count(*) FROM files WHERE build_id=?1) WHERE build_id=?1", [&metrics.build_id])?;
    incremental::reconcile(&db, &metrics.build_id)?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(metrics)
}

fn execute(
    db: &mut Connection,
    repo: &Path,
    oid_len: usize,
    max_bytes: u64,
    metrics: &mut Metrics,
) -> Result<()> {
    let start = Instant::now();
    let mut command = git_stream::command(repo);
    command.args([
        "ls-tree",
        "-r",
        "-z",
        "-l",
        "--full-tree",
        &metrics.revision,
    ]);
    let mut child = git_stream::GitChild::spawn(command)?;
    let mut reader = BufReader::new(child.child.stdout.take().context("Tree stdout missing")?);
    let mut transaction = db.transaction()?;
    let mut transaction_bytes = 0usize;
    while let Some(record) = git_stream::record(&mut reader, 0, git_stream::RECORD_LIMIT)? {
        transaction_bytes += record.len();
        let entry = git_stream::entry(&record, oid_len)?;
        let lang = language(&entry.path);
        metrics.discovered_files += 1;
        if lang == "JAVA" {
            metrics.java_files += 1;
        }
        let reason = if entry.kind != "blob" || !["100644", "100755"].contains(&entry.mode.as_str())
        {
            Some("UNSUPPORTED_FILE_MODE")
        } else if !["JAVA", "CONFIG"].contains(&lang) {
            Some("OUTSIDE_JAVA_CAPTURE_SCOPE")
        } else if entry.bytes > max_bytes {
            Some("RESOURCE_LIMIT_BLOB_BYTES")
        } else {
            None
        };
        let status = if reason.is_some() {
            "BLOCKED"
        } else {
            "DISCOVERED"
        };
        transaction.execute("INSERT INTO files(build_id,file_id,path,git_object_id,git_byte_length,language,status) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(build_id,file_id) DO NOTHING", params![metrics.build_id,metrics.discovered_files as i64,entry.path,entry.oid,entry.bytes as i64,lang,status])?;
        let matches: bool = transaction.query_row("SELECT path=?3 AND git_object_id=?4 AND git_byte_length=?5 AND language=?6 FROM files WHERE build_id=?1 AND file_id=?2",params![metrics.build_id,metrics.discovered_files as i64,entry.path,entry.oid,entry.bytes as i64,lang], |row| row.get(0))?;
        if !matches {
            bail!("RESUME_INVENTORY_MISMATCH");
        }
        if reason.is_none() {
            transaction.execute("UPDATE files SET status='DISCOVERED',source_sha256=NULL WHERE build_id=?1 AND file_id=?2 AND (source_sha256 IS NULL OR source_sha256 IN (SELECT source_sha256 FROM source_blobs WHERE state!='SEALED'))", params![metrics.build_id,metrics.discovered_files as i64])?;
        }
        transaction.execute(
            "INSERT INTO obligations VALUES (?1,?2,?3,'FILE_DISCOVERY',?4,?5,'{}') ON CONFLICT(build_id,obligation_id) DO NOTHING",
            params![
                metrics.build_id,
                metrics.discovered_files as i64,
                format!("file:{}", metrics.discovered_files),
                if reason.is_some() {
                    "UNKNOWN"
                } else {
                    "PENDING"
                },
                reason
            ],
        )?;
        if reason.is_none() {
            use rusqlite::OptionalExtension;
            let cached:Option<String>=transaction.query_row("SELECT o.source_sha256 FROM blob_git_objects o JOIN source_blobs b USING(source_sha256) WHERE o.git_object_id=?1 AND o.byte_length=?2 AND b.byte_length=o.byte_length AND b.state='SEALED'",params![entry.oid,entry.bytes as i64],|row|row.get(0)).optional()?;
            if let Some(hash) = cached {
                transaction.execute("UPDATE files SET source_sha256=?3,status=CASE WHEN status='DISCOVERED' THEN 'PARTIAL' ELSE status END WHERE build_id=?1 AND file_id=?2",params![metrics.build_id,metrics.discovered_files as i64,hash])?;
                transaction.execute("UPDATE obligations SET status='SUPPORTED',reason=NULL WHERE build_id=?1 AND obligation_id=?2",params![metrics.build_id,format!("file:{}",metrics.discovered_files)])?;
                transaction.execute("INSERT INTO obligations VALUES (?1,?2,?3,?4,'UNKNOWN','SYNTAX_INDEX_NOT_IMPLEMENTED','{}') ON CONFLICT(build_id,obligation_id) DO NOTHING",params![metrics.build_id,metrics.discovered_files as i64,format!("syntax:{}",metrics.discovered_files),if lang=="JAVA"{"JAVA_SYNTAX"}else{"CONFIG_SEMANTICS"}])?;
                metrics.reused_source_files += 1;
            }
        }
        if reason.is_some() {
            metrics.blocked_files += 1;
        }
        // Bound transaction size by rows; each bounded tree record is written immediately.
        if metrics.discovered_files.is_multiple_of(128) || transaction_bytes >= 4 * 1024 * 1024 {
            transaction.commit()?;
            transaction = db.transaction()?;
            transaction_bytes = 0;
        }
    }
    transaction.commit()?;
    child.finish()?;
    let stored_files: i64 = db.query_row(
        "SELECT count(*) FROM files WHERE build_id=?1",
        [&metrics.build_id],
        |row| row.get(0),
    )?;
    if stored_files as u64 != metrics.discovered_files {
        bail!("RESUME_INVENTORY_COUNT_MISMATCH");
    }
    db.execute(
        "UPDATE builds SET discovered_files=?2 WHERE build_id=?1",
        params![metrics.build_id, metrics.discovered_files as i64],
    )?;
    metrics.discovery_ms = start.elapsed().as_millis();
    let start = Instant::now();
    let mut batch = Batch::start(repo)?;
    let mut after = 0i64;
    loop {
        // One metadata row at a time; no complete file list in memory.
        let next = {
            let mut statement = db.prepare("SELECT file_id,git_object_id,git_byte_length,path,language FROM files WHERE build_id=?1 AND file_id>?2 AND status='DISCOVERED' ORDER BY file_id LIMIT 1")?;
            let mut rows = statement.query(params![metrics.build_id, after])?;
            rows.next()?
                .map(|row| {
                    Ok::<_, rusqlite::Error>((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .transpose()?
        };
        let Some((file_id, oid, bytes, path, lang)) = next else {
            break;
        };
        after = file_id;
        db.execute(
            "UPDATE files SET status='INDEXING' WHERE build_id=?1 AND file_id=?2",
            params![metrics.build_id, file_id],
        )?;
        use rusqlite::OptionalExtension;
        let cached:Option<String>=db.query_row("SELECT o.source_sha256 FROM blob_git_objects o JOIN source_blobs b USING(source_sha256) WHERE o.git_object_id=?1 AND o.byte_length=?2 AND b.state='SEALED'",params![oid,bytes as i64],|row|row.get(0)).optional()?;
        let source_hash = if let Some(hash) = cached {
            metrics.reused_source_files += 1;
            hash
        } else {
            batch.request(&oid, bytes)?;
            let hash = capture_blob(db, &mut batch, &oid, bytes, oid_len)?;
            metrics.fetched_blob_files += 1;
            hash
        };
        let tx = db.transaction()?;
        tx.execute(
            "UPDATE files SET source_sha256=?3,status='PARTIAL' WHERE build_id=?1 AND file_id=?2",
            params![metrics.build_id, file_id, source_hash],
        )?;
        tx.execute("UPDATE obligations SET status='SUPPORTED',reason=NULL WHERE build_id=?1 AND file_id=?2 AND kind='FILE_DISCOVERY'",params![metrics.build_id,file_id])?;
        tx.execute("INSERT INTO obligations VALUES (?1,?2,?3,?4,'UNKNOWN','SYNTAX_INDEX_NOT_IMPLEMENTED','{}') ON CONFLICT(build_id,obligation_id) DO NOTHING",params![metrics.build_id,file_id,format!("syntax:{file_id}"),if lang=="JAVA"{"JAVA_SYNTAX"}else{"CONFIG_SEMANTICS"}])?;
        tx.execute(
            "INSERT INTO blob_git_objects VALUES (?1,?2,?3) ON CONFLICT(git_object_id) DO NOTHING",
            params![oid, source_hash, bytes as i64],
        )?;
        tx.commit()?;
        let _ = path;
        metrics.captured_files += 1;
        metrics.captured_bytes += bytes;
    }
    batch.finish()?;
    let mut config_hash = Sha256::new();
    let mut statement = db.prepare("SELECT path,source_sha256 FROM files WHERE build_id=?1 AND language='CONFIG' AND source_sha256 IS NOT NULL ORDER BY file_id")?;
    let mut rows = statement.query([&metrics.build_id])?;
    while let Some(row) = rows.next()? {
        config_hash.update(row.get::<_, String>(0)?.as_bytes());
        config_hash.update([0]);
        config_hash.update(row.get::<_, String>(1)?.as_bytes());
        config_hash.update([0]);
    }
    (metrics.captured_files,metrics.captured_bytes) = db.query_row("SELECT count(*),coalesce(sum(git_byte_length),0) FROM files WHERE build_id=?1 AND source_sha256 IS NOT NULL",[&metrics.build_id],|row|Ok((row.get::<_,i64>(0)? as u64,row.get::<_,i64>(1)? as u64)))?;
    db.execute(
        "UPDATE builds SET configuration_fingerprint=?2 WHERE build_id=?1",
        params![metrics.build_id, hex::encode(config_hash.finalize())],
    )?;
    metrics.capture_ms = start.elapsed().as_millis();
    Ok(())
}

/// Stream persisted chunks; resume never trusts an old SEALED label alone.
pub(crate) fn validate_sealed_sources(db: &Connection) -> Result<()> {
    let has_cache: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='blob_git_objects')",
        [],
        |r| r.get(0),
    )?;
    let integrity: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        bail!("RESUME_DATABASE_INTEGRITY_FAILED: {integrity}");
    }
    if db
        .prepare("PRAGMA foreign_key_check")?
        .query([])?
        .next()?
        .is_some()
    {
        bail!("RESUME_FOREIGN_KEY_FAILED");
    }
    let mut blobs = db.prepare(
        "SELECT source_sha256,byte_length,physical_lines FROM source_blobs WHERE state='SEALED'",
    )?;
    let mut chunks = db.prepare("SELECT chunk_ordinal,bytes FROM source_chunks WHERE source_sha256=?1 ORDER BY chunk_ordinal")?;
    let mut rows = blobs.query([])?;
    while let Some(row) = rows.next()? {
        let expected: String = row.get(0)?;
        let mut hash = Sha256::new();
        let mut git_sha1 = sha1::Sha1::new();
        let mut git_sha256 = Sha256::new();
        let header = format!("blob {}\0", row.get::<_, i64>(1)?);
        git_sha1.update(header.as_bytes());
        git_sha256.update(header.as_bytes());
        let (mut ordinal, mut bytes, mut lines, mut last) = (0i64, 0i64, 0i64, None);
        let mut data_rows = chunks.query([&expected])?;
        while let Some(chunk) = data_rows.next()? {
            let index: i64 = chunk.get(0)?;
            let data: Vec<u8> = chunk.get(1)?;
            if index != ordinal || data.is_empty() || data.len() > CHUNK_SIZE {
                bail!("RESUME_CHUNK_INVALID");
            }
            hash.update(&data);
            git_sha1.update(&data);
            git_sha256.update(&data);
            bytes += data.len() as i64;
            lines += data.iter().filter(|b| **b == b'\n').count() as i64;
            last = data.last().copied();
            ordinal += 1;
        }
        lines += i64::from(last.is_some_and(|b| b != b'\n'));
        if hex::encode(hash.finalize()) != expected
            || bytes != row.get::<_, i64>(1)?
            || lines != row.get::<_, i64>(2)?
        {
            bail!("RESUME_SOURCE_HASH_MISMATCH");
        }
        let git1 = hex::encode(git_sha1.finalize());
        let git256 = hex::encode(git_sha256.finalize());
        let mismatch:i64=db.query_row("SELECT count(*) FROM files WHERE source_sha256=?1 AND (git_byte_length!=?2 OR (length(git_object_id)=40 AND git_object_id!=?3) OR (length(git_object_id)=64 AND git_object_id!=?4))",params![expected,bytes,git1,git256],|r|r.get(0))?;
        if mismatch != 0 {
            bail!("RESUME_GIT_SOURCE_MISMATCH");
        }
        if has_cache {
            let mismatch:i64=db.query_row("SELECT count(*) FROM blob_git_objects WHERE source_sha256=?1 AND (byte_length!=?2 OR (length(git_object_id)=40 AND git_object_id!=?3) OR (length(git_object_id)=64 AND git_object_id!=?4) OR length(git_object_id) NOT IN (40,64))",params![expected,bytes,git1,git256],|r|r.get(0))?;
            if mismatch != 0 {
                bail!("RESUME_GIT_CACHE_MISMATCH");
            }
        }
    }
    let invalid:i64=db.query_row("SELECT count(*) FROM declarations d JOIN parse_units u USING(unit_id) JOIN source_blobs b USING(source_sha256) WHERE d.end_byte>b.byte_length",[],|r|r.get(0))?;
    if invalid != 0 {
        bail!("RESUME_FACT_SPAN_INVALID");
    }
    let invalid:i64=db.query_row("SELECT count(*) FROM (SELECT d.unit_id FROM declarations d JOIN parse_units u USING(unit_id) WHERE u.status='COMPLETE' GROUP BY d.unit_id HAVING min(d.ordinal)!=0 OR max(d.ordinal)+1!=count(*))",[],|r|r.get(0))?;
    if invalid != 0 {
        bail!("RESUME_COMPLETE_UNIT_INVALID");
    }
    Ok(())
}

fn capture_blob(
    db: &mut Connection,
    batch: &mut Batch,
    oid: &str,
    bytes: u64,
    oid_len: usize,
) -> Result<String> {
    db.execute("DELETE FROM capture_staging", [])?;
    let mut hash = Sha256::new();
    let mut sha1 = sha1::Sha1::new();
    let mut git_sha256 = Sha256::new();
    let header = format!("blob {bytes}\0");
    sha1.update(header.as_bytes());
    git_sha256.update(header.as_bytes());
    let mut remaining = bytes;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut ordinal = 0i64;
    let mut lines = 0u64;
    let mut last = None;
    let mut transaction = db.transaction()?;
    while remaining > 0 {
        let length = remaining.min(CHUNK_SIZE as u64) as usize;
        batch.output.read_exact(&mut buffer[..length])?;
        let data = &buffer[..length];
        hash.update(data);
        sha1.update(data);
        git_sha256.update(data);
        lines += data.iter().filter(|byte| **byte == b'\n').count() as u64;
        last = data.last().copied();
        transaction.execute(
            "INSERT INTO capture_staging VALUES (?1,?2)",
            params![ordinal, data],
        )?;
        remaining -= length as u64;
        ordinal += 1;
        if ordinal % 4 == 0 {
            transaction.commit()?;
            transaction = db.transaction()?;
        }
    }
    batch.trailer()?;
    let computed = if oid_len == 40 {
        hex::encode(sha1.finalize())
    } else {
        hex::encode(git_sha256.finalize())
    };
    if computed != oid {
        bail!("Blob object hash mismatch");
    }
    if last.is_some_and(|byte| byte != b'\n') {
        lines += 1;
    }
    let source_hash = hex::encode(hash.finalize());
    transaction.execute("INSERT INTO source_blobs VALUES (?1,?2,?3,'WRITING') ON CONFLICT(source_sha256) DO NOTHING",params![source_hash,bytes as i64,lines as i64])?;
    let metadata: (i64, i64) = transaction.query_row(
        "SELECT byte_length,physical_lines FROM source_blobs WHERE source_sha256=?1",
        [&source_hash],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if metadata != (bytes as i64, lines as i64) {
        bail!("Existing source metadata mismatch");
    }
    // Finish the tail's staging and metadata in the same transaction. Small
    // blobs need one staging/sealing commit rather than several tiny commits.
    if ordinal <= 1 {
        transaction.execute("INSERT INTO source_chunks SELECT ?1,ordinal,bytes FROM capture_staging WHERE 1 ON CONFLICT(source_sha256,chunk_ordinal) DO NOTHING", [&source_hash])?;
        let stored: (i64,i64) = transaction.query_row("SELECT count(*),coalesce(sum(length(bytes)),0) FROM source_chunks WHERE source_sha256=?1",[&source_hash],|row|Ok((row.get(0)?,row.get(1)?)))?;
        if stored != (ordinal, bytes as i64) {
            bail!("Source chunk reconciliation failed");
        }
        transaction.execute("DELETE FROM capture_staging", [])?;
        transaction.execute(
            "UPDATE source_blobs SET state='SEALED' WHERE source_sha256=?1",
            [&source_hash],
        )?;
        transaction.commit()?;
        return Ok(source_hash);
    }
    transaction.commit()?;
    let mut after = -1i64;
    while after + 1 < ordinal {
        let tx = db.transaction()?;
        tx.execute("INSERT INTO source_chunks SELECT ?1,ordinal,bytes FROM capture_staging WHERE ordinal>?2 ORDER BY ordinal LIMIT 4 ON CONFLICT(source_sha256,chunk_ordinal) DO NOTHING",params![source_hash,after])?;
        tx.execute("DELETE FROM capture_staging WHERE ordinal IN (SELECT ordinal FROM capture_staging WHERE ordinal>?1 ORDER BY ordinal LIMIT 4)",[after])?;
        tx.commit()?;
        after += 4;
    }
    let stored: (i64, i64) = db.query_row(
        "SELECT count(*),coalesce(sum(length(bytes)),0) FROM source_chunks WHERE source_sha256=?1",
        [&source_hash],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if stored != (ordinal, bytes as i64) {
        bail!("Source chunk reconciliation failed");
    }
    let tx = db.transaction()?;
    tx.execute(
        "UPDATE source_blobs SET state='SEALED' WHERE source_sha256=?1",
        [&source_hash],
    )?;
    tx.commit()?;
    Ok(source_hash)
}
