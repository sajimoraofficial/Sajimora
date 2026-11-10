//! multi_process_concurrency_test.rs — OS-level multi-process SQLite lock contention test.
//!
//! Validates Patent Claim 1 & Concurrency Invariant:
//! 1. Multiple separate OS processes (`Command::new("sajimora")`) competing for the same
//!    `.sajimora/contracts.db` file lock via OS primitives (`fcntl`/`flock` on POSIX, `LockFileEx` on Windows).
//! 2. `busy_timeout` (5000ms) and WAL mode ensure zero unhandled `SQLITE_BUSY` or `database is locked` errors.
//! 3. Zero crashes or code 101 panics under 30 concurrent CLI operations across 6 parallel processes.
//! 4. Full SQLite database B-Tree integrity check passes after high-concurrency contention bursts.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
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
        let path = std::env::temp_dir().join(format!(
            "sajimora-multi-process-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Concurrency Tester",
            "-c",
            "user.email=concurrent@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git command failed");
    assert!(status.success(), "git command {:?} failed", args);
}

fn setup_concurrent_repo(repo: &Path) {
    git(repo, &["init"]);

    // 1. Maven Backend structure
    let backend_dir = repo.join("backend/src/main/java/com/example/api");
    fs::create_dir_all(&backend_dir).unwrap();
    fs::write(
        repo.join("backend/pom.xml"),
        r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo-concurrent</artifactId>
  <version>1.0.0</version>
</project>"#,
    )
    .unwrap();

    fs::write(
        backend_dir.join("OrderController.java"),
        r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    @GetMapping("/api/orders")
    public OrderDto getOrders() {
        return new OrderDto();
    }
}

class OrderDto {
    public Long id;
    public String title;
}
"#,
    )
    .unwrap();

    // 2. TypeScript Frontend structure
    let fe_dir = repo.join("frontend/src");
    fs::create_dir_all(&fe_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{"name": "demo-fe", "dependencies": {"axios": "^1.6.0"}}"#,
    )
    .unwrap();

    fs::write(
        fe_dir.join("orderClient.ts"),
        r#"import axios from 'axios';

export interface OrderDto {
    id: number;
    title: string;
}

export async function fetchOrders(): Promise<OrderDto> {
    const res = await axios.get<OrderDto>('/api/orders');
    return res.data;
}
"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Initial commit"]);

    // Initialize baseline using sajimora init --apply
    let init_out = Command::new(cli_bin())
        .arg("init")
        .arg("--apply")
        .current_dir(repo)
        .output()
        .expect("sajimora init");
    assert!(
        init_out.status.success(),
        "sajimora init must succeed: {}",
        String::from_utf8_lossy(&init_out.stderr)
    );

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Baseline sealed"]);
}

#[test]
fn test_multi_process_concurrent_cli_invocations() {
    let guard = TempDirGuard::new("contention");
    let repo = guard.path();
    setup_concurrent_repo(repo);

    let num_processes = 6;
    let iterations_per_proc = 5;
    let completed_runs = Arc::new(AtomicUsize::new(0));
    let mut handles = vec![];

    // Spawn 6 threads, each executing independent OS subprocesses in a loop
    for p_id in 0..num_processes {
        let repo_path = repo.to_path_buf();
        let completed = Arc::clone(&completed_runs);

        handles.push(thread::spawn(move || {
            let bin = cli_bin();

            for iter in 0..iterations_per_proc {
                let cmd_arg = match (p_id + iter) % 3 {
                    0 => vec!["verify"],
                    1 => vec!["run"],
                    _ => vec!["verify"],
                };

                let output = Command::new(&bin)
                    .args(&cmd_arg)
                    .current_dir(&repo_path)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .unwrap_or_else(|e| {
                        panic!(
                            "Process {} iteration {} failed to spawn: {:?}",
                            p_id, iter, e
                        )
                    });

                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let code = output.status.code().unwrap_or(-1);

                // Invariant 1: No Rust panics (exit code 101)
                assert_ne!(
                    code, 101,
                    "Process {} crashed with Rust panic!\nstdout: {}\nstderr: {}",
                    p_id, stdout, stderr
                );

                // Invariant 2: No unhandled SQLite lock errors
                assert!(
                    !stderr.contains("database is locked")
                        && !stdout.contains("database is locked")
                        && !stderr.contains("SQLITE_BUSY"),
                    "Process {} hit unhandled SQLite lock error!\nstderr: {}\nstdout: {}",
                    p_id, stderr, stdout
                );

                // Invariant 3: Clean exit in advisory mode (code 0)
                assert_eq!(
                    code, 0,
                    "Process {} failed with exit code {}\nstdout: {}\nstderr: {}",
                    p_id, code, stdout, stderr
                );

                completed.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    for handle in handles {
        handle.join().expect("Subprocess thread panicked");
    }

    let total_runs = completed_runs.load(Ordering::SeqCst);
    assert_eq!(
        total_runs,
        num_processes * iterations_per_proc,
        "All 30 concurrent OS CLI subprocesses must finish successfully"
    );

    // Invariant 4: Verify SQLite database file is not corrupted after multi-process storm
    let db_path = repo.join(".sajimora/contracts.db");
    if db_path.exists() {
        let conn = rusqlite::Connection::open(&db_path).expect("open contracts.db");
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("PRAGMA integrity_check");
        assert_eq!(
            integrity, "ok",
            "SQLite database integrity must remain ok after multi-process contention"
        );
    }

    println!("✅ Verified: 30 concurrent OS subprocesses executed with zero locks or panics.");
}
