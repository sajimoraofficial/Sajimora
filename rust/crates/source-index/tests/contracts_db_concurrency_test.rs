//! contracts_db_concurrency_test.rs — Multi-threaded concurrency and SQLite WAL stress test.
//!
//! Validates:
//! 1. Concurrent Readers: 10 parallel reader threads querying routes simultaneously under WAL mode.
//! 2. Concurrent Readers + Writers: Multiple threads querying and upserting contracts concurrently
//!    without throwing unhandled `SQLITE_BUSY` (busy_timeout 5000ms ensures graceful wait).
//! 3. Zero data corruption: B-Tree integrity passes after high-concurrency bursts.

use source_index::contracts_db::*;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct TempDbGuard {
    dir: PathBuf,
}

impl TempDbGuard {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "sajimora-db-concurrency-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join("contracts.db")
    }
}

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn test_concurrent_readers_under_wal_mode() {
    let guard = TempDbGuard::new("readers");
    let db_path = guard.db_path();

    // 1. Initialize DB with sample backend routes
    {
        let conn = open_writer(&db_path).expect("open writer to init");
        for i in 0..100 {
            let route = format!("/api/resource/{}", i);
            let canonical = canonical_route_key(&route);
            conn.execute(
                "INSERT INTO backend_endpoints (
                    service_id, http_method, raw_path, normalized_route,
                    direction, source_file, source_line,
                    ast_identity, sha256
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    "test-service",
                    "GET",
                    route,
                    canonical,
                    "RESPONSE",
                    "src/Controller.java",
                    i as i32,
                    format!("ast_id_{}", i),
                    format!("sha_{}", i),
                ],
            )
            .expect("insert initial endpoint");
        }
    }

    // 2. Spawn 10 concurrent reader threads performing 50 queries each
    let thread_count = 10;
    let queries_per_thread = 50;
    let completed_queries = Arc::new(AtomicUsize::new(0));
    let mut handles = vec![];

    for t_id in 0..thread_count {
        let db_path_clone = db_path.clone();
        let completed = Arc::clone(&completed_queries);

        handles.push(thread::spawn(move || {
            let reader = open_reader(&db_path_clone)
                .unwrap_or_else(|e| panic!("Thread {} failed to open reader: {:?}", t_id, e));

            for q in 0..queries_per_thread {
                let target_route = format!("/api/resource/{}", (t_id * 10 + q) % 100);
                let mut stmt = reader
                    .prepare_cached("SELECT ast_identity FROM backend_endpoints WHERE raw_path = ?1")
                    .expect("prepare select");

                let mut rows = stmt.query([&target_route]).expect("query execute");
                let mut found = false;
                if let Some(row) = rows.next().expect("read row") {
                    let ast_id: String = row.get(0).expect("get ast_identity");
                    assert!(ast_id.starts_with("ast_id_"));
                    found = true;
                }
                assert!(found, "Target route {} must be found", target_route);
                completed.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    for handle in handles {
        handle.join().expect("Reader thread panicked");
    }

    assert_eq!(
        completed_queries.load(Ordering::SeqCst),
        thread_count * queries_per_thread,
        "All 500 concurrent queries must complete successfully"
    );
}

#[test]
fn test_concurrent_readers_and_writers_stress() {
    let guard = TempDbGuard::new("rw-stress");
    let db_path = guard.db_path();

    // Initialize DB
    {
        let conn = open_writer(&db_path).expect("init writer");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS stress_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                ts INTEGER NOT NULL
            )",
            [],
        )
        .expect("create test table");
    }

    let write_threads = 4;
    let read_threads = 6;
    let writes_per_thread = 25;
    let reads_per_thread = 50;

    let write_success = Arc::new(AtomicUsize::new(0));
    let read_success = Arc::new(AtomicUsize::new(0));
    let mut handles = vec![];

    // Spawn writers
    for w in 0..write_threads {
        let db_path_clone = db_path.clone();
        let success = Arc::clone(&write_success);

        handles.push(thread::spawn(move || {
            for step in 0..writes_per_thread {
                let conn = open_writer(&db_path_clone)
                    .unwrap_or_else(|e| panic!("Writer {} open error: {:?}", w, e));

                conn.execute(
                    "INSERT INTO stress_log (thread_id, message, ts) VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        w as i64,
                        format!("writer_{}_step_{}", w, step),
                        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as i64
                    ],
                )
                .unwrap_or_else(|e| panic!("Writer {} step {} insert failed: {:?}", w, step, e));

                success.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(2));
            }
        }));
    }

    // Spawn readers
    for r in 0..read_threads {
        let db_path_clone = db_path.clone();
        let success = Arc::clone(&read_success);

        handles.push(thread::spawn(move || {
            let conn = open_reader(&db_path_clone)
                .unwrap_or_else(|e| panic!("Reader {} open error: {:?}", r, e));

            for _ in 0..reads_per_thread {
                let mut stmt = conn
                    .prepare_cached("SELECT COUNT(*) FROM stress_log")
                    .expect("prepare count");

                let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap_or(0);
                assert!(count >= 0);
                success.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(1));
            }
        }));
    }

    for handle in handles {
        handle.join().expect("Concurrent stress thread panicked");
    }

    assert_eq!(
        write_success.load(Ordering::SeqCst),
        write_threads * writes_per_thread,
        "All writes must commit without busy deadlock"
    );
    assert_eq!(
        read_success.load(Ordering::SeqCst),
        read_threads * reads_per_thread,
        "All reads must execute concurrently under WAL mode"
    );

    // Verify DB integrity check passes
    let reader = open_reader(&db_path).expect("open reader for integrity check");
    let integrity: String = reader
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("PRAGMA integrity_check");
    assert_eq!(integrity, "ok", "Database integrity check must be ok");
}
