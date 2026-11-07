use rusqlite::Connection;
use source_index::capture;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}
fn fixture(name: &str, sha256: bool) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/source-index-fixtures")
        .join(format!(
            "{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    if sha256 {
        git(&repo, &["init", "--object-format=sha256"]);
    } else {
        git(&repo, &["init"]);
    }
    git(&repo, &["config", "user.email", "fixture@example.invalid"]);
    git(&repo, &["config", "user.name", "Fixture"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    repo
}
fn commit(repo: &Path) {
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "fixture"]);
}

#[test]
fn captures_binary_chunks_duplicates_and_immutable_commit() {
    let repo = fixture("chunks", false);
    let bytes: Vec<u8> = (0..2_100_000).map(|index| (index % 251) as u8).collect();
    fs::write(repo.join("A.java"), &bytes).unwrap();
    fs::write(repo.join("B.java"), &bytes).unwrap();
    fs::write(repo.join("Empty.java"), []).unwrap();
    fs::write(repo.join("package.json"), b"{}\n").unwrap();
    fs::write(repo.join("client.ts"), b"export {}\n").unwrap();
    commit(&repo);
    let revision = git(&repo, &["rev-parse", "HEAD"]);
    fs::write(repo.join("A.java"), b"uncommitted replacement").unwrap();
    let database = repo.parent().unwrap().join("index.sqlite");
    let metrics = capture(&repo, &revision, &database, 64 * 1024 * 1024).unwrap();
    assert_eq!(metrics.discovered_files, 5);
    assert_eq!(metrics.java_files, 3);
    assert_eq!(metrics.captured_files, 4);
    assert_eq!(metrics.state, "INCOMPLETE");
    let db = Connection::open(&database).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM source_blobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3);
    let mut statement = db.prepare("SELECT bytes FROM source_chunks WHERE source_sha256=(SELECT source_sha256 FROM files WHERE path='A.java') ORDER BY chunk_ordinal").unwrap();
    let recovered: Vec<u8> = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
        .flat_map(|row| row.unwrap())
        .collect();
    assert_eq!(recovered, bytes);
    let pending: i64 = db
        .query_row(
            "SELECT count(*) FROM obligations WHERE status='PENDING'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
    let unknown: i64 = db
        .query_row(
            "SELECT count(*) FROM obligations WHERE status='UNKNOWN'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unknown, 5);
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let fk: i64 = db
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(fk, 0);
    assert!(capture(&repo, &revision, &database, 64 * 1024 * 1024).is_err());
    assert_eq!(
        fs::read(repo.join("A.java")).unwrap(),
        b"uncommitted replacement"
    );
}

#[test]
fn oversized_files_remain_unknown_and_accounted() {
    let repo = fixture("limit", false);
    fs::write(repo.join("Large.java"), vec![b'x'; 100]).unwrap();
    commit(&repo);
    let database = repo.parent().unwrap().join("index.sqlite");
    let metrics = capture(&repo, "HEAD", &database, 8).unwrap();
    assert_eq!(metrics.discovered_files, 1);
    assert_eq!(metrics.blocked_files, 1);
    assert_eq!(metrics.captured_files, 0);
    let db = Connection::open(database).unwrap();
    let reason: String = db
        .query_row("SELECT reason FROM obligations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(reason, "RESOURCE_LIMIT_BLOB_BYTES");
}

#[test]
fn sha256_git_objects_are_verified() {
    let repo = fixture("sha256", true);
    fs::write(repo.join("A.java"), b"class A {}\n").unwrap();
    commit(&repo);
    let metrics = capture(
        &repo,
        "HEAD",
        &repo.parent().unwrap().join("index.sqlite"),
        1024,
    )
    .unwrap();
    assert_eq!(metrics.revision.len(), 64);
    assert_eq!(metrics.captured_files, 1);
}

#[test]
fn missing_object_fails_the_build_instead_of_claiming_completion() {
    let repo = fixture("missing", false);
    fs::write(repo.join("A.java"), b"class A {}\n").unwrap();
    commit(&repo);
    let oid = git(&repo, &["rev-parse", "HEAD:A.java"]);
    let object = repo.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
    let saved = fs::read(&object).unwrap();
    fs::remove_file(&object).unwrap();
    let database = repo.parent().unwrap().join("index.sqlite");
    assert!(capture(&repo, "HEAD", &database, 1024).is_err());
    let db = Connection::open(&database).unwrap();
    let state: String = db
        .query_row("SELECT state FROM builds", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "FAILED");
    drop(db);
    fs::write(object, saved).unwrap();
    let resumed = source_index::capture_with_resume(&repo, "HEAD", &database, 1024, true).unwrap();
    assert_eq!(resumed.captured_files, 1);
}

#[test]
fn resume_recovers_unsealed_capture_and_reconciles_all_counters() {
    let repo = fixture("resume", false);
    fs::write(repo.join("A.java"), b"class A {}\n").unwrap();
    fs::write(repo.join("B.java"), b"class B {}\n").unwrap();
    fs::write(repo.join("config.json"), b"{}\n").unwrap();
    commit(&repo);
    let database = repo.parent().unwrap().join("index.sqlite");
    let first = capture(&repo, "HEAD", &database, 1024).unwrap();
    let db = Connection::open(&database).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; UPDATE builds SET state='BUILDING'; UPDATE source_blobs SET state='WRITING' WHERE source_sha256=(SELECT source_sha256 FROM files WHERE path='B.java'); UPDATE files SET status='INDEXING' WHERE path='B.java'; DELETE FROM source_chunks WHERE source_sha256=(SELECT source_sha256 FROM files WHERE path='B.java'); INSERT INTO capture_staging VALUES(0,x'1234');").unwrap();
    drop(db);
    let resumed = source_index::capture_with_resume(&repo, "HEAD", &database, 1024, true).unwrap();
    assert_eq!(resumed.build_id, first.build_id);
    assert_eq!(resumed.captured_files, 3);
    assert_eq!(resumed.captured_bytes, first.captured_bytes);
    let db = Connection::open(&database).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM files WHERE status IN ('DISCOVERED','INDEXING')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM source_blobs WHERE state!='SEALED'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM capture_staging", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn resume_rejects_changed_identity_and_corrupt_sealed_content() {
    let repo = fixture("resume-reject", false);
    fs::write(repo.join("A.java"), b"class A {}\n").unwrap();
    commit(&repo);
    let database = repo.parent().unwrap().join("index.sqlite");
    capture(&repo, "HEAD", &database, 1024).unwrap();
    assert!(
        source_index::capture_with_resume(&repo, "HEAD", &database, 2048, true)
            .unwrap_err()
            .to_string()
            .contains("IDENTITY_MISMATCH")
    );
    let db = Connection::open(&database).unwrap();
    db.execute("UPDATE source_chunks SET bytes=x'0000'", [])
        .unwrap();
    drop(db);
    assert!(
        source_index::capture_with_resume(&repo, "HEAD", &database, 1024, true)
            .unwrap_err()
            .to_string()
            .contains("HASH_MISMATCH")
    );
}

#[test]
fn resume_retries_empty_database_left_before_atomic_initialization() {
    let repo = fixture("resume-init", false);
    fs::write(repo.join("A.java"), b"class A {}\n").unwrap();
    commit(&repo);
    let database = repo.parent().unwrap().join("index.sqlite");
    fs::write(&database, []).unwrap();
    let resumed = source_index::capture_with_resume(&repo, "HEAD", &database, 1024, true).unwrap();
    assert_eq!(resumed.captured_files, 1);
    assert_eq!(resumed.discovered_files, 1);
}
