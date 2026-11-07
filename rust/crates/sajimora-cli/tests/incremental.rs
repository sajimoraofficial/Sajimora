use rusqlite::{params, Connection};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn fixture(name: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/incremental-fixtures")
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
    git(&root, &["config", "core.autocrlf", "false"]);
    root
}
fn commit(repo: &Path) -> String {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", "fixture"]);
    git(repo, &["rev-parse", "HEAD"])
}
fn invoke(repo: &Path, database: &Path, revision: &str, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_sajimora-source-pilot"))
        .args(["index-source", "--repo"])
        .arg(repo)
        .arg("--database")
        .arg(database)
        .args(["--revision", revision, "--parse-java"])
        .args(extra)
        .output()
        .unwrap()
}
fn run(repo: &Path, database: &Path, revision: &str, extra: &[&str]) -> Value {
    let out = invoke(repo, database, revision, extra);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn same_as_fresh(database: &Path, fresh: &Path, build: &str) {
    let db = Connection::open(database).unwrap();
    db.execute("ATTACH DATABASE ?1 AS fresh", [fresh.to_str().unwrap()])
        .unwrap();
    for table in ["files", "obligations"] {
        let sql=format!("SELECT (SELECT count(*) FROM (SELECT * FROM main.{table} WHERE build_id=?1 EXCEPT SELECT * FROM fresh.{table} WHERE build_id=?1))+(SELECT count(*) FROM (SELECT * FROM fresh.{table} WHERE build_id=?1 EXCEPT SELECT * FROM main.{table} WHERE build_id=?1))");
        assert_eq!(
            db.query_row(&sql, [build], |r| r.get::<_, i64>(0)).unwrap(),
            0,
            "{table}"
        );
    }
    for (table, key) in [
        ("declarations", "unit_id"),
        ("parse_units", "unit_id"),
        ("source_blobs", "source_sha256"),
        ("source_chunks", "source_sha256"),
    ] {
        let query = |schema: &str| {
            format!("SELECT DISTINCT d.* FROM {schema}.{table} d JOIN {schema}.files f ON f.{key}=d.{key} WHERE f.build_id=?1")
        };
        let a = query("main");
        let b = query("fresh");
        let sql=format!("SELECT (SELECT count(*) FROM ({a} EXCEPT {b}))+(SELECT count(*) FROM ({b} EXCEPT {a}))");
        assert_eq!(
            db.query_row(&sql, [build], |r| r.get::<_, i64>(0)).unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}

#[test]
fn changed_added_deleted_and_renamed_files_match_fresh_and_reuse_unmodified_units() {
    let repo = fixture("changes");
    for (name, text) in [
        ("A.java", "class A { int a; }"),
        ("B.java", "class B {}"),
        ("Keep.java", "class Keep {}"),
        ("Old.java", "class Old {}"),
        ("config.json", "{}"),
        ("client.ts", "export {}"),
    ] {
        fs::write(repo.join(name), text).unwrap();
    }
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &[]);
    fs::write(repo.join("A.java"), "class A { String a; int b; }").unwrap();
    fs::remove_file(repo.join("B.java")).unwrap();
    fs::rename(repo.join("Old.java"), repo.join("Renamed.java")).unwrap();
    fs::write(repo.join("New.java"), "class New {}").unwrap();
    let after = commit(&repo);
    let report = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(report["java"]["worker_requests"], 2);
    assert_eq!(report["java"]["cache_hits"], 2);
    assert_eq!(report["capture"]["fetched_blob_files"], 2);
    assert_eq!(report["capture"]["reused_source_files"], 3);
    for (kind, count) in [
        ("added", 1),
        ("modified", 1),
        ("deleted", 1),
        ("renamed", 1),
        ("unchanged", 3),
    ] {
        assert_eq!(report["incremental"][kind], count, "{kind}");
    }
    assert_eq!(report["incremental"]["configuration_changed"], false);
    let fresh = repo.with_extension("fresh.sqlite");
    run(&repo, &fresh, &after, &[]);
    let build = report["capture"]["build_id"].as_str().unwrap();
    same_as_fresh(&database, &fresh, build);
    let db = Connection::open(&database).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM files WHERE build_id=?1 AND path IN ('B.java','Old.java')",
            [build],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        build
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM files WHERE build_id=?1",
            [initial["capture"]["build_id"].as_str().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        6
    );
}

#[test]
fn configuration_change_invalidates_entire_scope_and_never_copies_semantic_results() {
    let repo = fixture("config");
    fs::write(repo.join("A.java"), "class A {}").unwrap();
    fs::write(repo.join("B.java"), "class B {}").unwrap();
    fs::write(repo.join("pom.xml"), "<project/>").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &[]);
    let old = initial["capture"]["build_id"].as_str().unwrap();
    let db = Connection::open(&database).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let (id, unit): (i64, String) = db
        .query_row(
            "SELECT file_id,unit_id FROM files WHERE build_id=?1 AND path='A.java'",
            [old],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    db.execute(
        "INSERT INTO references_ir VALUES (?1,0,0,'TEST','A',0,1,'{}')",
        [&unit],
    )
    .unwrap();
    db.execute(
        "INSERT INTO resolutions VALUES (?1,?2,?3,0,'RESOLVED','{}')",
        params![old, id, unit],
    )
    .unwrap();
    db.execute(
        "INSERT INTO resolution_targets VALUES (?1,?2,0,?2,?3,0)",
        params![old, id, unit],
    )
    .unwrap();
    drop(db);
    fs::write(
        repo.join("pom.xml"),
        "<project><version>2</version></project>",
    )
    .unwrap();
    let after = commit(&repo);
    let report = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(report["java"]["worker_requests"], 0);
    assert_eq!(report["java"]["cache_hits"], 2);
    assert_eq!(report["incremental"]["configuration_changed"], true);
    assert_eq!(report["incremental"]["semantic_invalidated_files"], 3);
    let new = report["capture"]["build_id"].as_str().unwrap();
    let db = Connection::open(database).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM resolutions WHERE build_id=?1",
            [new],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM resolutions WHERE build_id=?1",
            [old],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(db.query_row("SELECT count(*) FROM semantic_invalidations WHERE build_id=?1 AND reason='CONFIGURATION_CHANGED' AND status='PENDING'",[new],|r|r.get::<_,i64>(0)).unwrap(),3);
}

#[test]
fn incomplete_new_build_does_not_replace_published_snapshot() {
    let repo = fixture("publication");
    fs::write(repo.join("A.java"), "class A {}").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &[]);
    let old = initial["capture"]["build_id"].as_str().unwrap();
    fs::write(repo.join("A.java"), "class A { int changed; }").unwrap();
    let after = commit(&repo);
    let capture =
        source_index::capture_incremental(&repo, &after, &database, 64 * 1024 * 1024).unwrap();
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        old
    );
    assert!(source_index::incremental::publish(&database, &capture.build_id, true).is_err());
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        old
    );
    let wrong = invoke(&repo, &database, &before, &["--incremental"]);
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("INCREMENTAL_PENDING_BUILD"));
    let report = run(&repo, &database, &after, &["--resume"]);
    assert_eq!(report["java"]["worker_requests"], 1);
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        capture.build_id
    );
}

#[test]
fn ambiguous_renames_are_additions_deletions_and_identical_commit_reuses_everything() {
    let repo = fixture("ambiguous");
    for file in ["A.java", "B.java"] {
        fs::write(repo.join(file), "class Shared {}").unwrap();
    }
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    run(&repo, &database, &before, &[]);
    fs::rename(repo.join("A.java"), repo.join("C.java")).unwrap();
    fs::rename(repo.join("B.java"), repo.join("D.java")).unwrap();
    let after = commit(&repo);
    let report = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(report["incremental"]["renamed"], 0);
    assert_eq!(report["incremental"]["added"], 2);
    assert_eq!(report["incremental"]["deleted"], 2);
    assert_eq!(report["java"]["worker_requests"], 0);
    let repeat = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(repeat["java"]["worker_requests"], 0);
    assert_eq!(repeat["capture"]["fetched_blob_files"], 0);
    let wrong = invoke(
        &repo,
        &database,
        &after,
        &["--incremental", "--max-blob-bytes", "1024"],
    );
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("INCREMENTAL_PROFILE_MISMATCH"));
}

#[test]
fn interrupted_incremental_writer_resumes_without_losing_old_snapshot() {
    let repo = fixture("kill");
    fs::write(repo.join("Keep.java"), "class Keep {}").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &[]);
    let old = initial["capture"]["build_id"].as_str().unwrap();
    let mut text = String::from("class Huge {\n");
    for n in 0..15000 {
        text.push_str(&format!("int f{n};\n"));
    }
    text.push('}');
    fs::write(repo.join("Huge.java"), text).unwrap();
    let after = commit(&repo);
    let mut child = Command::new(env!("CARGO_BIN_EXE_sajimora-source-pilot"))
        .args(["index-source", "--repo"])
        .arg(&repo)
        .arg("--database")
        .arg(&database)
        .args(["--revision", &after, "--parse-java", "--incremental"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let mut killed = false;
    while start.elapsed() < Duration::from_secs(30) {
        if let Ok(db) = Connection::open(&database) {
            let prefix=db.query_row("SELECT count(*) FROM files f JOIN parse_units u USING(unit_id) JOIN declarations d USING(unit_id) WHERE f.build_id!=?1 AND u.status='WRITING'",[old],|r|r.get::<_,i64>(0)).unwrap_or(0);
            if prefix > 0 {
                child.kill().unwrap();
                killed = true;
                break;
            }
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    if !killed {
        let _ = child.kill();
    }
    child.wait().unwrap();
    assert!(killed);
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        old
    );
    let report = run(&repo, &database, &after, &["--resume"]);
    assert_eq!(report["java"]["complete_files"], 2);
    let fresh = repo.with_extension("fresh.sqlite");
    run(&repo, &fresh, &after, &[]);
    same_as_fresh(
        &database,
        &fresh,
        report["capture"]["build_id"].as_str().unwrap(),
    );
}

#[test]
fn partial_units_are_retried_and_language_changes_do_not_leak_old_java_facts() {
    let repo = fixture("partial-language");
    fs::write(repo.join("Broken.java"), "class Broken { void f( { }").unwrap();
    fs::write(repo.join("Keep.java"), "class Keep {}").unwrap();
    fs::write(repo.join("Move.java"), "class Move {}").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    run(&repo, &database, &before, &[]);
    fs::rename(repo.join("Move.java"), repo.join("Move.ts")).unwrap();
    fs::write(repo.join("New.java"), "class New {}").unwrap();
    let after = commit(&repo);
    let report = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(report["java"]["worker_requests"], 2);
    assert_eq!(report["java"]["partial_files"], 1);
    assert_eq!(report["java"]["cache_hits"], 1);
    let fresh = repo.with_extension("fresh.sqlite");
    run(&repo, &fresh, &after, &[]);
    same_as_fresh(
        &database,
        &fresh,
        report["capture"]["build_id"].as_str().unwrap(),
    );
    let db = Connection::open(database).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM files WHERE build_id=?1 AND path='Move.ts' AND unit_id IS NULL AND source_sha256 IS NULL AND status='BLOCKED'",[report["capture"]["build_id"].as_str().unwrap()],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn legacy_single_build_database_upgrades_and_reuses_its_verified_units() {
    let repo = fixture("legacy");
    fs::write(repo.join("Keep.java"), "class Keep {}").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    run(&repo, &database, &before, &[]);
    let db = Connection::open(&database).unwrap();
    db.execute_batch("DROP TABLE semantic_invalidations; DROP INDEX changed_previous_path; DROP TABLE file_changes; DROP TABLE incremental_builds; DROP TABLE index_state; DROP TABLE blob_git_objects; DROP INDEX files_git_lookup;").unwrap();
    drop(db);
    fs::write(repo.join("New.java"), "class New {}").unwrap();
    let after = commit(&repo);
    let report = run(&repo, &database, &after, &["--incremental"]);
    assert_eq!(report["java"]["worker_requests"], 1);
    assert_eq!(report["java"]["cache_hits"], 1);
    assert_eq!(report["capture"]["fetched_blob_files"], 1);
    let fresh = repo.with_extension("fresh.sqlite");
    run(&repo, &fresh, &after, &[]);
    same_as_fresh(
        &database,
        &fresh,
        report["capture"]["build_id"].as_str().unwrap(),
    );
}

#[test]
fn admission_changes_and_wrong_repository_preserve_snapshot_and_unknowns() {
    let repo = fixture("admission");
    fs::write(
        repo.join("Huge.java"),
        format!("class Huge {{ {} }}", " ".repeat(200)),
    )
    .unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &["--max-blob-bytes", "100"]);
    assert_eq!(initial["capture"]["blocked_files"], 1);
    fs::write(repo.join("Huge.java"), "class Huge {}").unwrap();
    let after = commit(&repo);
    let report = run(
        &repo,
        &database,
        &after,
        &["--incremental", "--max-blob-bytes", "100"],
    );
    assert_eq!(report["java"]["worker_requests"], 1);
    assert_eq!(report["java"]["complete_files"], 1);
    let other = fixture("wrong-repo");
    fs::write(other.join("A.java"), "class A {}").unwrap();
    let revision = commit(&other);
    let wrong = invoke(
        &other,
        &database,
        &revision,
        &["--incremental", "--max-blob-bytes", "100"],
    );
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("INCREMENTAL_PROFILE_MISMATCH"));
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        report["capture"]["build_id"].as_str().unwrap()
    );
}

#[test]
fn explicit_cache_scrub_rejects_corruption_before_publishing_new_build() {
    let repo = fixture("scrub");
    fs::write(repo.join("A.java"), "class A {}").unwrap();
    let before = commit(&repo);
    let database = repo.with_extension("sqlite");
    let initial = run(&repo, &database, &before, &[]);
    let db = Connection::open(&database).unwrap();
    db.execute("UPDATE source_chunks SET bytes=x'001122'", [])
        .unwrap();
    drop(db);
    fs::write(repo.join("B.java"), "class B {}").unwrap();
    let after = commit(&repo);
    let out = invoke(
        &repo,
        &database,
        &after,
        &["--incremental", "--verify-cache"],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("RESUME_SOURCE_HASH_MISMATCH"));
    assert_eq!(
        source_index::incremental::published_build(&database).unwrap(),
        initial["capture"]["build_id"].as_str().unwrap()
    );
}
