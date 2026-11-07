use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
fn git(repo: &Path, args: &[&str]) {
    let result = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn fixture(name: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/java-worker-fixtures")
        .join(format!(
            "{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&root).unwrap();
    git(&root, &["init"]);
    git(&root, &["config", "user.name", "Fixture"]);
    git(&root, &["config", "user.email", "fixture@example.invalid"]);
    root
}
fn run(repo: &Path, extra: &[&str]) -> (serde_json::Value, PathBuf) {
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "fixture"]);
    let database = repo.with_extension("sqlite");
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora-source-pilot"))
        .args(["index-source", "--repo"])
        .arg(repo)
        .args(["--database"])
        .arg(&database)
        .arg("--parse-java")
        .args(extra)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    (serde_json::from_slice(&output.stdout).unwrap(), database)
}

#[test]
fn worker_persists_structural_facts_and_keeps_parse_errors_partial() {
    let repo = fixture("facts");
    fs::write(
        repo.join("A.java"),
        "package demo; class A<T> { int a,b; A(){} void f(String p){} class Inner{} }",
    )
    .unwrap();
    fs::write(
        repo.join("Broken.java"),
        "class Broken { int field; void f( {",
    )
    .unwrap();
    let (report, database) = run(&repo, &[]);
    assert_eq!(report["java"]["complete_files"], 1);
    assert_eq!(report["java"]["partial_files"], 1);
    assert_eq!(report["java"]["blocked_files"], 0);
    assert_eq!(report["java"]["writer_synchronous"], 1);
    assert_eq!(report["java"]["writer_journal_mode"], "wal");
    assert!(
        report["java"]["worker_timing"]["native_parse_ns"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(report["java"]["sqlite_insert_ns"].as_u64().unwrap() > 0);
    let db = Connection::open(database).unwrap();
    let classes: i64 = db
        .query_row(
            "SELECT count(*) FROM declarations WHERE kind='CLASS'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(classes >= 2);
    let ready: i64 = db
        .query_row("SELECT count(*) FROM builds WHERE state='READY'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(ready, 0);
    let foreign: i64 = db
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(foreign, 0);
}

#[test]
fn shared_unit_retains_each_files_structural_and_unknown_syntax_obligations() {
    let repo = fixture("shared-unit");
    let source = "package demo; class Shared { int field; void run(){} }";
    fs::write(repo.join("A.java"), source).unwrap();
    fs::write(repo.join("B.java"), source).unwrap();
    let (report, database) = run(&repo, &[]);
    assert_eq!(report["java"]["complete_files"], 2);
    assert_eq!(report["java"]["cache_hits"], 1);
    let db = Connection::open(database).unwrap();
    let units: i64 = db
        .query_row(
            "SELECT count(DISTINCT unit_id) FROM files WHERE language='JAVA'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(units, 1);
    let syntax: i64 = db.query_row("SELECT count(*) FROM obligations WHERE kind='JAVA_SYNTAX' AND status='UNKNOWN' AND reason='CALL_REFERENCE_RESOLUTION_NOT_IMPLEMENTED'", [], |row| row.get(0)).unwrap();
    let supported: i64 = db.query_row("SELECT count(*) FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS' AND status='SUPPORTED'", [], |row| row.get(0)).unwrap();
    assert_eq!(syntax, 2);
    assert_eq!(supported, 2);
    let writing: i64 = db
        .query_row(
            "SELECT count(*) FROM parse_units WHERE status='WRITING'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(writing, 0);
}

#[test]
fn deadline_kills_worker_and_leaves_unknown_obligation() {
    let repo = fixture("timeout");
    let mut source = String::from("class Huge {");
    for n in 0..30000 {
        source.push_str(&format!("int field{n};"));
    }
    source.push('}');
    fs::write(repo.join("Huge.java"), source).unwrap();
    let (report, database) = run(&repo, &["--java-timeout-ms", "1"]);
    assert_eq!(report["java"]["blocked_files"], 1);
    assert_eq!(report["java"]["worker_restarts"], 1);
    let db = Connection::open(database).unwrap();
    let reason: String = db
        .query_row(
            "SELECT reason FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(reason.contains("TIMEOUT"));
    let complete: i64 = db
        .query_row(
            "SELECT count(*) FROM parse_units WHERE status='COMPLETE'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(complete, 0);
}

#[test]
fn failed_file_rolls_back_its_tail_without_erasing_prior_or_later_files() {
    let repo = fixture("batch-rollback");
    fs::write(repo.join("A.java"), "class A { int value; }").unwrap();
    fs::write(
        repo.join("B.java"),
        format!(
            "class B {{ int partial; class {} {{}} }}",
            "Long".repeat(5000)
        ),
    )
    .unwrap();
    fs::write(repo.join("C.java"), "class C { int value; }").unwrap();
    let (report, database) = run(&repo, &[]);
    assert_eq!(report["java"]["complete_files"], 2);
    assert_eq!(report["java"]["blocked_files"], 1);
    assert_eq!(report["java"]["declarations"], 4);
    assert_eq!(report["java"]["worker_restarts"], 1);
    let db = Connection::open(database).unwrap();
    let lost: i64 = db.query_row("SELECT count(*) FROM declarations d JOIN files f ON d.unit_id=f.unit_id WHERE f.path='B.java'", [], |r|r.get(0)).unwrap();
    assert_eq!(lost, 0);
    let states: Vec<(String, String)> = db
        .prepare("SELECT path,status FROM files WHERE language='JAVA' ORDER BY path")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        states,
        vec![
            ("A.java".into(), "INDEXED".into()),
            ("B.java".into(), "BLOCKED".into()),
            ("C.java".into(), "INDEXED".into())
        ]
    );
    let reason:String=db.query_row("SELECT reason FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS' AND status='UNKNOWN'",[],|r|r.get(0)).unwrap();
    assert!(reason.contains("FACT_TEXT"));
    assert!(report["java"]["batch_peak_bytes"].as_u64().unwrap() <= 4 * 1024 * 1024);
    assert!(report["java"]["batch_peak_rows"].as_u64().unwrap() <= 2000);
    assert!(report["java"]["batch_peak_files"].as_u64().unwrap() <= 32);
}

#[test]
fn seventy_files_use_bounded_batches_and_all_completions_are_committed() {
    let repo = fixture("file-bound");
    for n in 0..70 {
        fs::write(
            repo.join(format!("A{n:03}.java")),
            format!("class A{n} {{ int value; }}"),
        )
        .unwrap();
    }
    let (report, database) = run(&repo, &[]);
    assert_eq!(report["java"]["complete_files"], 70);
    assert_eq!(report["java"]["writer_commits"], 3);
    assert_eq!(report["java"]["batch_peak_files"], 32);
    assert_eq!(report["java"]["declarations"], 140);
    let db = Connection::open(database).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM files WHERE status='INDEXED'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        70
    );
    assert_eq!(db.query_row("SELECT count(*) FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS' AND status='SUPPORTED'",[],|r|r.get::<_,i64>(0)).unwrap(),70);
}

#[test]
fn failed_large_file_preserves_committed_prefix_as_blocked_without_counting_success() {
    let repo = fixture("large-batch-rollback");
    fs::write(repo.join("A.java"), "class A { int value; }").unwrap();
    let mut source = String::from("class B {");
    for n in 0..6000 {
        source.push_str(&format!("int field{n};"));
    }
    source.push_str(&format!("class {} {{}} }}", "Long".repeat(5000)));
    fs::write(repo.join("B.java"), source).unwrap();
    fs::write(repo.join("C.java"), "class C { int value; }").unwrap();
    let (report, database) = run(&repo, &[]);
    assert_eq!(report["java"]["complete_files"], 2);
    assert_eq!(report["java"]["blocked_files"], 1);
    assert_eq!(report["java"]["declarations"], 4);
    let db = Connection::open(database).unwrap();
    let (state, unit): (String, String) = db
        .query_row(
            "SELECT status,unit_id FROM files WHERE path='B.java'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "BLOCKED");
    let prefix: i64 = db
        .query_row(
            "SELECT count(*) FROM declarations WHERE unit_id=?",
            [&unit],
            |r| r.get(0),
        )
        .unwrap();
    assert!(prefix > 0 && prefix < 6001);
    let unit_state: String = db
        .query_row(
            "SELECT status FROM parse_units WHERE unit_id=?",
            [&unit],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unit_state, "BLOCKED");
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert!(report["java"]["batch_peak_rows"].as_u64().unwrap() <= 2000);
}

#[cfg(windows)]
#[test]
fn native_memory_cap_failure_does_not_kill_parent() {
    let repo = fixture("memory");
    let mut source = String::from("class Huge {");
    for n in 0..80000 {
        source.push_str(&format!("int field{n};"));
    }
    source.push('}');
    fs::write(repo.join("Huge.java"), source).unwrap();
    let (report, database) = run(&repo, &["--java-memory-mib", "16"]);
    assert_eq!(report["java"]["blocked_files"], 1);
    assert!(report["java"]["memory_enforcement"]
        .as_str()
        .unwrap()
        .contains("Job Object"));
    let db = Connection::open(database).unwrap();
    let unknown:i64=db.query_row("SELECT count(*) FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS' AND status='UNKNOWN'",[],|r|r.get(0)).unwrap();
    assert_eq!(unknown, 1);
}

#[cfg(windows)]
#[test]
fn aggregate_tree_cap_blocks_worker_even_with_larger_individual_allowance() {
    let repo = fixture("tree-cap");
    let mut source = String::from("class Huge {\n");
    for n in 0..80000 {
        source.push_str(&format!("int field{n};\n"));
    }
    source.push('}');
    fs::write(repo.join("Huge.java"), source).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "fixture"]);
    let database = repo.with_extension("sqlite");
    let executable = env!("CARGO_BIN_EXE_sajimora-source-pilot");
    let output = Command::new(executable)
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&database)
        .args([
            "--parse-java",
            "--java-memory-mib",
            "512",
            "--tree-memory-mib",
            "64",
        ])
        .output()
        .unwrap();
    if output.status.success() {
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["java"]["blocked_files"], 1);
        assert_eq!(
            report["process_tree_memory"]["limit_readback_bytes"],
            64 * 1024 * 1024
        );
    } else {
        assert!(output.stdout.is_empty(), "failed run published success");
    }
    let output = Command::new(executable)
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&database)
        .args([
            "--parse-java",
            "--resume",
            "--java-memory-mib",
            "512",
            "--java-timeout-ms",
            "120000",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["java"]["complete_files"], 1);
    assert_eq!(report["java"]["declarations"], 80001);
}

#[test]
fn resume_after_real_process_kill_discards_incomplete_prefix_and_matches_fresh_facts() {
    use std::time::{Duration, Instant};
    let repo = fixture("crash-resume");
    fs::write(repo.join("A.java"), "package demo; class A { int a; }").unwrap();
    let mut source = String::from("package demo; class B {\n");
    for n in 0..10000 {
        source.push_str(&format!("int f{n};\n"));
    }
    source.push('}');
    fs::write(repo.join("B.java"), source).unwrap();
    fs::write(repo.join("C.java"), "package demo; class C { int c; }").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "fixture"]);
    let database = repo.with_extension("sqlite");
    let executable = env!("CARGO_BIN_EXE_sajimora-source-pilot");
    let mut child = Command::new(executable)
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&database)
        .arg("--parse-java")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let mut interrupted = false;
    while start.elapsed() < Duration::from_secs(30) {
        if let Ok(db) =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            let visible=db.query_row("SELECT count(*) FROM declarations d JOIN parse_units u USING(unit_id) WHERE u.status='WRITING'",[],|r|r.get::<_,i64>(0)).unwrap_or(0);
            if visible > 0 {
                let competing = Command::new(executable)
                    .args(["index-source", "--repo"])
                    .arg(&repo)
                    .arg("--database")
                    .arg(&database)
                    .args(["--parse-java", "--resume"])
                    .output()
                    .unwrap();
                assert!(!competing.status.success());
                assert!(
                    String::from_utf8_lossy(&competing.stderr).contains("BUILD_LEASE_UNAVAILABLE")
                );
                child.kill().unwrap();
                interrupted = true;
                break;
            }
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    if !interrupted {
        let _ = child.kill();
    }
    child.wait().unwrap();
    assert!(interrupted, "did not observe a committed incomplete prefix");
    let output = Command::new(executable)
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&database)
        .args(["--parse-java", "--resume"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["java"]["complete_files"], 3);
    let fresh = repo.with_extension("fresh.sqlite");
    let output = Command::new(executable)
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&fresh)
        .arg("--parse-java")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let db = Connection::open(&database).unwrap();
    db.execute("ATTACH DATABASE ?1 AS fresh", [fresh.to_str().unwrap()])
        .unwrap();
    for table in [
        "files",
        "obligations",
        "declarations",
        "source_blobs",
        "source_chunks",
        "parse_units",
    ] {
        let differences:i64=db.query_row(&format!("SELECT (SELECT count(*) FROM (SELECT * FROM {table} EXCEPT SELECT * FROM fresh.{table}))+(SELECT count(*) FROM (SELECT * FROM fresh.{table} EXCEPT SELECT * FROM {table}))"),[],|r|r.get(0)).unwrap();
        assert_eq!(differences, 0, "{table}");
    }
    let sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='declaration_lookup'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(sql.contains("WHERE qualified_name IS NOT NULL"));
    let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT unit_id,ordinal FROM declarations WHERE qualified_name='demo.A'",[],|r|r.get(3)).unwrap();
    assert!(plan.contains("declaration_lookup"), "{plan}");
}
