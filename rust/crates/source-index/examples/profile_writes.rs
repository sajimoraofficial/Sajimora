//! Diagnostic replay into new database copies. Never mutates the supplied evidence databases.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Serialize)]
struct Report {
    case: String,
    sqlite_version: String,
    files: usize,
    facts: u64,
    total_ms: u128,
    insert_ns: u128,
    commit_ns: u128,
    checkpoint_ns: u128,
    index_build_ns: u128,
    foreign_keys: i64,
    synchronous: i64,
    wal_autocheckpoint: i64,
    commits: u64,
    checkpoints: u64,
    peak_wal_bytes: u64,
    foreign_key_violations: i64,
    integrity: String,
}
fn wal_bytes(path: &Path) -> u64 {
    fs::metadata(PathBuf::from(format!("{}-wal", path.display())))
        .map(|m| m.len())
        .unwrap_or(0)
}
fn checkpoint(db: &Connection, report: &mut Report) -> Result<()> {
    let start = Instant::now();
    let (busy, pages, written): (i64, i64, i64) =
        db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    report.checkpoint_ns += start.elapsed().as_nanos();
    report.checkpoints += 1;
    if busy != 0 || pages != written {
        bail!("Checkpoint did not complete");
    }
    Ok(())
}
fn run(capture: &Path, facts: &Path, output: &Path, case: &str, limit: usize) -> Result<Report> {
    let target = output.join(format!("{case}.sqlite"));
    if target.exists() {
        bail!("Refusing overwrite: {}", target.display());
    }
    fs::copy(capture, &target)?;
    let source = Connection::open_with_flags(facts, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.execute_batch("PRAGMA cache_size=-16384; PRAGMA mmap_size=0;")?;
    let mut db = Connection::open(&target)?;
    let fk = if case == "foreign_keys_off_diagnostic" {
        0
    } else {
        1
    };
    let manual = case == "manual_checkpoint";
    let deferred_indexes = matches!(case, "deferred_lookup_indexes" | "batched_deferred_indexes");
    db.execute_batch(&format!("PRAGMA foreign_keys={fk}; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint={};",if manual{0}else{1000}))?;
    let journal: String = db.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    if journal != "wal" {
        bail!("Expected WAL input");
    }
    if db.query_row("SELECT count(*) FROM declarations", [], |r| {
        r.get::<_, i64>(0)
    })? != 0
    {
        bail!("Capture input must have no facts");
    }
    let build: String = db.query_row("SELECT build_id FROM builds", [], |r| r.get(0))?;
    let source_build: String = source.query_row("SELECT build_id FROM builds", [], |r| r.get(0))?;
    if build != source_build {
        bail!("Frozen builds differ");
    }
    if deferred_indexes {
        db.execute_batch("DROP INDEX declaration_lookup; DROP INDEX declaration_short_name;")?;
    }
    let mut report = Report {
        case: case.into(),
        sqlite_version: db.query_row("SELECT sqlite_version()", [], |r| r.get(0))?,
        files: 0,
        facts: 0,
        total_ms: 0,
        insert_ns: 0,
        commit_ns: 0,
        checkpoint_ns: 0,
        index_build_ns: 0,
        foreign_keys: db.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?,
        synchronous: db.query_row("PRAGMA synchronous", [], |r| r.get(0))?,
        wal_autocheckpoint: db.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))?,
        commits: 0,
        checkpoints: 0,
        peak_wal_bytes: 0,
        foreign_key_violations: 0,
        integrity: String::new(),
    };
    let start = Instant::now();
    let mut files=source.prepare("SELECT file_id,unit_id,source_sha256 FROM files WHERE language='JAVA' ORDER BY file_id LIMIT ?")?;
    let mut rows = files.query([limit as i64])?;
    let batched = matches!(
        case,
        "bounded_cross_file_batch" | "batched_deferred_indexes"
    );
    let mut tx = db.transaction()?;
    let mut batch_rows = 0usize;
    let mut batch_bytes = 0usize;
    let mut batch_files = 0usize;
    while let Some(file) = rows.next()? {
        let id: i64 = file.get(0)?;
        let unit: String = file.get(1)?;
        let hash: String = file.get(2)?;
        let (grammar, extractor): (String, String) = source.query_row(
            "SELECT grammar_fingerprint,extractor_fingerprint FROM parse_units WHERE unit_id=?",
            [&unit],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "INSERT INTO parse_units VALUES (?1,?2,'JAVA',?3,?4,'WRITING')",
            params![unit, hash, grammar, extractor],
        )?;
        tx.execute(
            "UPDATE files SET unit_id=?3,status='INDEXING' WHERE build_id=?1 AND file_id=?2",
            params![build, id, unit],
        )?;
        if !batched {
            let t = Instant::now();
            tx.commit()?;
            report.commit_ns += t.elapsed().as_nanos();
            report.commits += 1;
            tx = db.transaction()?;
        }
        {
            let mut facts=source.prepare("SELECT ordinal,parent_ordinal,kind,name,qualified_name,start_byte,end_byte,facts_json FROM declarations WHERE unit_id=? ORDER BY ordinal")?;
            let mut facts = facts.query([&unit])?;
            while let Some(f) = facts.next()? {
                let ordinal: i64 = f.get(0)?;
                let parent: Option<i64> = f.get(1)?;
                let kind: String = f.get(2)?;
                let name: String = f.get(3)?;
                let qualified: Option<String> = f.get(4)?;
                let begin: i64 = f.get(5)?;
                let end: i64 = f.get(6)?;
                let metadata: String = f.get(7)?;
                let t = Instant::now();
                tx.prepare_cached("INSERT INTO declarations VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)")?
                    .execute(params![
                        unit, ordinal, parent, kind, name, qualified, begin, end, metadata
                    ])?;
                report.insert_ns += t.elapsed().as_nanos();
                report.facts += 1;
                batch_rows += 1;
                batch_bytes +=
                    metadata.len() + name.len() + qualified.as_ref().map_or(0, String::len) + 256;
                if batch_rows >= 2000 || batch_bytes >= 4 * 1024 * 1024 {
                    let t = Instant::now();
                    tx.commit()?;
                    report.commit_ns += t.elapsed().as_nanos();
                    report.commits += 1;
                    report.peak_wal_bytes = report.peak_wal_bytes.max(wal_bytes(&target));
                    if manual && wal_bytes(&target) >= 4 * 1024 * 1024 {
                        checkpoint(&db, &mut report)?;
                    }
                    tx = db.transaction()?;
                    batch_rows = 0;
                    batch_bytes = 0;
                    batch_files = 0;
                }
            }
        }
        if !batched {
            let t = Instant::now();
            tx.commit()?;
            report.commit_ns += t.elapsed().as_nanos();
            report.commits += 1;
            tx = db.transaction()?;
            batch_rows = 0;
            batch_bytes = 0;
        }
        tx.execute(
            "UPDATE parse_units SET status='COMPLETE' WHERE unit_id=?",
            [&unit],
        )?;
        tx.execute(
            "UPDATE files SET status='INDEXED' WHERE build_id=?1 AND file_id=?2",
            params![build, id],
        )?;
        tx.execute("INSERT INTO obligations VALUES (?1,?2,?3,'JAVA_STRUCTURAL_FACTS','SUPPORTED',NULL,'{}')",params![build,id,format!("structural:{id}")])?;
        tx.execute("UPDATE obligations SET reason='CALL_REFERENCE_RESOLUTION_NOT_IMPLEMENTED' WHERE build_id=?1 AND obligation_id=?2",params![build,format!("syntax:{id}")])?;
        if !batched {
            let t = Instant::now();
            tx.commit()?;
            report.commit_ns += t.elapsed().as_nanos();
            report.commits += 1;
            report.peak_wal_bytes = report.peak_wal_bytes.max(wal_bytes(&target));
            if manual && wal_bytes(&target) >= 4 * 1024 * 1024 {
                checkpoint(&db, &mut report)?;
            }
            tx = db.transaction()?;
        }
        report.files += 1;
        if batched {
            batch_files += 1;
            batch_bytes += 2048; // Reservation for the fixed per-file ledger writes.
            if batch_files >= 32 || batch_bytes >= 4 * 1024 * 1024 {
                let t = Instant::now();
                tx.commit()?;
                report.commit_ns += t.elapsed().as_nanos();
                report.commits += 1;
                report.peak_wal_bytes = report.peak_wal_bytes.max(wal_bytes(&target));
                tx = db.transaction()?;
                batch_files = 0;
                batch_rows = 0;
                batch_bytes = 0;
            }
        }
    }
    let t = Instant::now();
    tx.commit()?;
    report.commit_ns += t.elapsed().as_nanos();
    report.commits += 1;
    report.peak_wal_bytes = report.peak_wal_bytes.max(wal_bytes(&target));
    if deferred_indexes {
        let t = Instant::now();
        db.execute_batch("CREATE INDEX declaration_lookup ON declarations(qualified_name, unit_id, ordinal); CREATE INDEX declaration_short_name ON declarations(name, unit_id, ordinal);")?;
        report.index_build_ns = t.elapsed().as_nanos();
        report.peak_wal_bytes = report.peak_wal_bytes.max(wal_bytes(&target));
    }
    checkpoint(&db, &mut report)?;
    report.total_ms = start.elapsed().as_millis();
    report.foreign_key_violations =
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    report.integrity = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if report.foreign_key_violations != 0 || report.integrity != "ok" {
        bail!("Replay database invalid");
    }
    Ok(report)
}
fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        bail!("profile_writes CAPTURE.sqlite FACTS.sqlite NEW_OUTPUT [file-limit=2000] [case=all]");
    }
    let output = Path::new(&args[3]);
    fs::create_dir_all(output)?;
    let limit = args.get(4).map(|v| v.parse()).transpose()?.unwrap_or(2000);
    let selected = args.get(5).map(String::as_str).unwrap_or("all");
    let cases = [
        "default",
        "manual_checkpoint",
        "bounded_cross_file_batch",
        "foreign_keys_off_diagnostic",
        "deferred_lookup_indexes",
        "batched_deferred_indexes",
    ];
    if selected != "all" && !cases.contains(&selected) {
        bail!("Unknown case");
    }
    let mut reports = Vec::new();
    for case in cases {
        if selected != "all" && selected != case {
            continue;
        }
        eprintln!("Replay {case}");
        let report = run(
            Path::new(&args[1]),
            Path::new(&args[2]),
            output,
            case,
            limit,
        )
        .context(case)?;
        println!("{}", serde_json::to_string(&report)?);
        reports.push(report);
        fs::write(
            output.join("reports.json"),
            serde_json::to_vec_pretty(&reports)?,
        )?;
    }
    Ok(())
}
