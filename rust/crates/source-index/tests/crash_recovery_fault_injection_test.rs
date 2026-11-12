//! crash_recovery_fault_injection_test.rs — SQLite Crash Consistency & Fault Recovery
//!
//! Evaluates Sajimora's database reliability under hostile failure conditions:
//! 1. Process termination (SIGKILL) mid-transaction (verifying atomic rollback).
//! 2. Truncated database files (incomplete OS page writes / disk failure).
//! 3. Malformed SQLite header bytes and page corruption.
//! 4. Corrupted WAL/SHM journal files.
//! 5. Multi-repository state isolation and cross-repo contamination prevention.

use source_index::contracts_db::*;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora-fault-qa-{tag}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn test_fault_recovery_truncated_database() {
    let tmp = TempDirGuard::new("truncated-db");
    let db_path = tmp.path.join(".sajimora").join("contracts.db");

    // 1. Initialize a valid DB and populate a record
    {
        let conn = open_writer(&db_path).expect("open writer");
        conn.execute(
            "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256)
             VALUES ('health-service', 'GET', '/api/health', '/api/health', 'HealthController.java', 10, 'HealthController#get', 'sha1')",
            [],
        )
        .expect("insert endpoint");
    }
    assert!(db_path.exists());

    // 2. Corrupt the database by truncating it midway through a page (256 bytes)
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&db_path)
            .expect("open for truncation");
        file.write_all(&[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20]) // "SQLite "
            .expect("write partial header");
        file.set_len(256).expect("truncate to 256 bytes");
    }

    // 3. Re-open via open_writer: it must self-heal without panicking
    let healed_conn = open_writer(&db_path).expect("open_writer must safely recover from truncated DB");

    // 4. Verify integrity check returns "ok"
    let integrity: String = healed_conn
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .expect("pragma integrity check");
    assert_eq!(integrity, "ok", "Database must be pristine after self-healing");

    // 5. Verify database accepts new operations
    healed_conn
        .execute(
            "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256)
             VALUES ('health-service', 'POST', '/api/v2/recovered', '/api/v2/recovered', 'HealthController.java', 20, 'HealthController#post', 'sha2')",
            [],
        )
        .expect("write after recovery");

    let count: i64 = healed_conn
        .query_row("SELECT count(*) FROM backend_endpoints", [], |r| r.get(0))
        .expect("query count");
    assert_eq!(count, 1, "Only fresh post-recovery record must exist");
}

#[test]
fn test_fault_recovery_malformed_header_bytes() {
    let tmp = TempDirGuard::new("malformed-header");
    let db_path = tmp.path.join(".sajimora").join("contracts.db");

    // 1. Create a valid DB
    {
        let _ = open_writer(&db_path).expect("open writer");
    }
    assert!(db_path.exists());

    // 2. Overwrite the first 500 bytes with completely random garbage
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&db_path)
            .expect("open for corruption");
        let garbage = [0xFFu8; 500];
        file.write_all(&garbage).expect("write garbage");
    }

    // 3. Reopen: must detect corruption, heal, and recreate
    let conn = open_writer(&db_path).expect("open_writer must safely recover from corrupt header");

    let integrity: String = conn
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .expect("pragma integrity check");
    assert_eq!(integrity, "ok");

    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("pragma user_version");
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn test_fault_recovery_corrupted_wal_file() {
    let tmp = TempDirGuard::new("corrupted-wal");
    let db_path = tmp.path.join(".sajimora").join("contracts.db");
    let wal_path = tmp.path.join(".sajimora").join("contracts.db-wal");

    // 1. Create valid DB
    {
        let _ = open_writer(&db_path).expect("open writer");
    }

    // 2. Plant garbage WAL file
    fs::write(&wal_path, b"MALFORMED_WAL_FRAME_GARBAGE_PAYLOAD").expect("write bad wal");

    // 3. Reopen: must recover cleanly
    let conn = open_writer(&db_path).expect("open_writer must safely handle corrupt WAL");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .expect("integrity check");
    assert_eq!(integrity, "ok");
}

#[test]
fn test_crash_recovery_uncommitted_sigkill() {
    let tmp = TempDirGuard::new("uncommitted-sigkill");
    let db_path = tmp.path.join(".sajimora").join("contracts.db");

    // 1. Create database and write a baseline committed record
    {
        let conn = open_writer(&db_path).expect("open initial db");
        conn.execute(
            "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256)
             VALUES ('base-service', 'GET', '/api/baseline', '/api/baseline', 'BaseController.java', 1, 'Base#get', 'basesha')",
            [],
        )
        .expect("insert baseline");
    }

    // 2. Spawn a python subprocess that enters an IMMEDIATE transaction, inserts 100 dirty rows, flushes, and sleeps
    let db_str = db_path.to_string_lossy().replace('\\', "/");
    let py_script = format!(
        r#"
import sqlite3, sys, time

conn = sqlite3.connect("{db_str}")
conn.execute("PRAGMA journal_mode = WAL")
conn.execute("BEGIN IMMEDIATE")
for i in range(100):
    conn.execute(
        "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256) VALUES ('dirty-service', 'GET', ?, ?, 'Dirty.java', ?, 'Dirty#get', 'dirtysha')",
        (f"/api/dirty/{{i}}", f"/api/dirty/{{i}}", i)
    )
print("DIRTY_ROWS_INSERTED", flush=True)
sys.stdout.flush()
time.sleep(30)
"#
    );

    let py_bin = if cfg!(windows) { "python" } else { "python3" };
    let mut child = Command::new(py_bin)
        .arg("-c")
        .arg(&py_script)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn python crash worker");

    // Read until DIRTY_ROWS_INSERTED appears
    use std::io::BufRead;
    let stdout = child.stdout.take().expect("child stdout");
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("read line from child");
    assert!(line.contains("DIRTY_ROWS_INSERTED"), "Child must confirm dirty rows inserted");

    // 3. Force kill mid-transaction with SIGKILL (signal 9)
    let _ = child.kill();
    let _ = child.wait();

    // 4. Parent reopens DB with open_writer
    let conn = open_writer(&db_path).expect("open after crash worker SIGKILL");

    // 5. Verify PRAGMA integrity_check returns ok
    let integrity: String = conn
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .expect("integrity check");
    assert_eq!(integrity, "ok", "Database integrity must be intact after mid-write SIGKILL");

    // 6. Verify atomic rollback: dirty records must NOT exist
    let dirty_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM backend_endpoints WHERE service_id = 'dirty-service'",
            [],
            |r| r.get(0),
        )
        .expect("query dirty count");
    assert_eq!(dirty_count, 0, "All uncommitted transactions must roll back cleanly");

    // 7. Verify baseline committed record is safely preserved
    let base_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM backend_endpoints WHERE service_id = 'base-service'",
            [],
            |r| r.get(0),
        )
        .expect("query base count");
    assert_eq!(base_count, 1, "Committed baseline data must survive process termination");
}

#[test]
fn test_multi_repo_state_isolation() {
    let tmp = TempDirGuard::new("multi-repo-isolation");
    let repo_a_db = tmp.path.join("repo_a").join(".sajimora").join("contracts.db");
    let repo_b_db = tmp.path.join("repo_b").join(".sajimora").join("contracts.db");

    // Initialize Repo A
    let conn_a = open_writer(&repo_a_db).expect("open repo a");
    conn_a.execute(
        "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256)
         VALUES ('service-a', 'GET', '/api/repo_a/users', '/api/repo_a/users', 'A.java', 1, 'A#get', 'shaA')",
        [],
    ).unwrap();

    // Initialize Repo B
    let conn_b = open_writer(&repo_b_db).expect("open repo b");
    conn_b.execute(
        "INSERT INTO backend_endpoints (service_id, http_method, raw_path, normalized_route, source_file, source_line, ast_identity, sha256)
         VALUES ('service-b', 'POST', '/api/repo_b/orders', '/api/repo_b/orders', 'B.java', 1, 'B#post', 'shaB')",
        [],
    ).unwrap();

    // Query Repo A for Repo B route
    let count_in_a: i64 = conn_a.query_row(
        "SELECT count(*) FROM backend_endpoints WHERE normalized_route = '/api/repo_b/orders'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(count_in_a, 0, "Repo A must never contain endpoints from Repo B");

    // Query Repo B for Repo A route
    let count_in_b: i64 = conn_b.query_row(
        "SELECT count(*) FROM backend_endpoints WHERE normalized_route = '/api/repo_a/users'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(count_in_b, 0, "Repo B must never contain endpoints from Repo A");

    // Corrupt Repo A completely
    fs::write(&repo_a_db, b"TOTAL_CORRUPTION").unwrap();

    // Repo B must continue operating with zero degradation
    let reader_b = open_reader(&repo_b_db).expect("reader b remains unaffected");
    let b_alive: i64 = reader_b.query_row(
        "SELECT count(*) FROM backend_endpoints WHERE service_id = 'service-b'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(b_alive, 1, "Repo B state must be completely isolated from Repo A failure");
}
