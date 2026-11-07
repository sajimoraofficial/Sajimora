//! Cross-commit membership with immutable content reuse and conservative invalidation.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

const SCHEMA:&str="
CREATE TABLE IF NOT EXISTS index_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),published_build_id TEXT REFERENCES builds(build_id),pending_build_id TEXT REFERENCES builds(build_id));
INSERT INTO index_state VALUES(1,NULL,NULL) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS blob_git_objects(git_object_id TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL REFERENCES source_blobs(source_sha256),byte_length INTEGER NOT NULL CHECK(byte_length>=0));
CREATE INDEX IF NOT EXISTS files_git_lookup ON files(build_id,git_object_id,path);
CREATE TABLE IF NOT EXISTS incremental_builds(build_id TEXT PRIMARY KEY REFERENCES builds(build_id),base_build_id TEXT REFERENCES builds(build_id));
CREATE TABLE IF NOT EXISTS file_changes(build_id TEXT NOT NULL REFERENCES builds(build_id),path TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('ADDED','MODIFIED','DELETED','RENAMED')),previous_path TEXT,PRIMARY KEY(build_id,path,kind)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS changed_previous_path ON file_changes(build_id,previous_path) WHERE kind='RENAMED';
CREATE TABLE IF NOT EXISTS semantic_invalidations(build_id TEXT NOT NULL,file_id INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETE')),PRIMARY KEY(build_id,file_id),FOREIGN KEY(build_id,file_id) REFERENCES files(build_id,file_id)) WITHOUT ROWID;
";

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='blob_git_objects')",
        [],
        |r| r.get(0),
    )?;
    db.execute_batch(SCHEMA)?;
    if !exists {
        let mut batch = Writes::new(db)?;
        let mut after = (String::new(), 0i64);
        loop {
            let row=db.query_row("SELECT f.build_id,f.file_id,f.git_object_id,f.source_sha256,f.git_byte_length FROM files f JOIN source_blobs b ON b.source_sha256=f.source_sha256 WHERE b.state='SEALED' AND (f.build_id,f.file_id)>(?1,?2) ORDER BY f.build_id,f.file_id LIMIT 1",params![after.0,after.1],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?))).optional()?;
            let Some((build, id, oid, hash, bytes)) = row else {
                break;
            };
            after = (build, id);
            batch.reserve(256)?;
            db.execute(
                "INSERT INTO blob_git_objects VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                params![oid, hash, bytes],
            )?;
        }
        batch.finish()?;
    }
    Ok(())
}

pub(crate) fn begin(
    db: &mut Connection,
    repo: &Path,
    revision: &str,
    build: &str,
    max_bytes: u64,
) -> Result<()> {
    let has_state: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='index_state')",
        [],
        |r| r.get(0),
    )?;
    let base: String = if has_state {
        let (published, pending): (Option<String>, Option<String>) = db.query_row(
            "SELECT published_build_id,pending_build_id FROM index_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if pending.as_deref().is_some_and(|id| id != build) {
            bail!("INCREMENTAL_PENDING_BUILD: resume the interrupted revision first");
        }
        published.context("INCREMENTAL_BASE_REQUIRED: finish/publish the initial build first")?
    } else {
        let count: i64 = db.query_row("SELECT count(*) FROM builds", [], |r| r.get(0))?;
        if count != 1 {
            bail!("INCREMENTAL_LEGACY_BASE_AMBIGUOUS");
        }
        db.query_row("SELECT build_id FROM builds", [], |r| r.get(0))?
    };
    let (repository,old_revision,scope,engine,state):(String,String,String,String,String)=db.query_row("SELECT repository_id,revision,scope_fingerprint,indexer_fingerprint,state FROM builds WHERE build_id=?1",[&base],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let format = crate::git_stream::scalar(repo, &["rev-parse", "--show-object-format"])?;
    let expected = hex::encode(Sha256::digest(
        format!("capture-v1\0{old_revision}\0{format}\0{max_bytes}").as_bytes(),
    ));
    if repository != repo.to_string_lossy()
        || scope != "java-and-config-capture-v1"
        || engine != "capture-v1"
        || expected != base
    {
        bail!("INCREMENTAL_PROFILE_MISMATCH");
    }
    if state != "INCOMPLETE" && base != build {
        bail!("INCREMENTAL_BASE_NOT_COMPLETE");
    }
    let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if integrity != "ok"
        || db
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        bail!("INCREMENTAL_DATABASE_INTEGRITY_FAILED");
    }
    if !has_state {
        crate::validate_sealed_sources(db)?;
    }
    ensure_schema(db)?;
    let tx = db.transaction()?;
    tx.execute("INSERT INTO builds(build_id,repository_id,revision,scope_fingerprint,configuration_fingerprint,indexer_fingerprint,state,discovered_files,terminal_files,created_at_ms) VALUES (?1,?2,?3,?4,'pending',?5,'BUILDING',0,0,?6) ON CONFLICT(build_id) DO NOTHING",params![build,repository,revision,scope,engine,std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as i64])?;
    tx.execute("UPDATE index_state SET published_build_id=coalesce(published_build_id,?1),pending_build_id=?2 WHERE singleton=1",params![base,build])?;
    tx.execute(
        "INSERT INTO incremental_builds VALUES (?1,?2) ON CONFLICT(build_id) DO NOTHING",
        params![build, base],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct Changes {
    pub base_build_id: Option<String>,
    pub added: u64,
    pub modified: u64,
    pub deleted: u64,
    pub renamed: u64,
    pub unchanged: u64,
    pub configuration_changed: bool,
    pub semantic_invalidated_files: u64,
}

pub fn changes(database: &Path, build: &str) -> Result<Changes> {
    let db = open(database)?;
    let base: Option<String> = db
        .query_row(
            "SELECT base_build_id FROM incremental_builds WHERE build_id=?1",
            [build],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let count = |kind: &str| -> Result<u64> {
        Ok(db.query_row(
            "SELECT count(*) FROM file_changes WHERE build_id=?1 AND kind=?2",
            params![build, kind],
            |r| r.get::<_, i64>(0),
        )? as u64)
    };
    let (added, modified, deleted, renamed) = (
        count("ADDED")?,
        count("MODIFIED")?,
        count("DELETED")?,
        count("RENAMED")?,
    );
    let files: i64 = db.query_row(
        "SELECT count(*) FROM files WHERE build_id=?1",
        [build],
        |r| r.get(0),
    )?;
    let configuration_changed = if let Some(old) = &base {
        db.query_row("SELECT a.configuration_fingerprint!=b.configuration_fingerprint FROM builds a JOIN builds b ON b.build_id=?2 WHERE a.build_id=?1",params![build,old],|r|r.get(0))?
    } else {
        false
    };
    let invalidated: i64 = db.query_row(
        "SELECT count(*) FROM semantic_invalidations WHERE build_id=?1",
        [build],
        |r| r.get(0),
    )?;
    Ok(Changes {
        base_build_id: base,
        added,
        modified,
        deleted,
        renamed,
        unchanged: files as u64 - added - modified - renamed,
        configuration_changed,
        semantic_invalidated_files: invalidated as u64,
    })
}

pub(crate) fn reconcile(db: &Connection, build: &str) -> Result<()> {
    let base: Option<String> = db
        .query_row(
            "SELECT base_build_id FROM incremental_builds WHERE build_id=?1",
            [build],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(base) = base else {
        return Ok(());
    };
    if base == build {
        return Ok(());
    }
    let config:bool=db.query_row("SELECT a.configuration_fingerprint!=b.configuration_fingerprint FROM builds a JOIN builds b ON b.build_id=?2 WHERE a.build_id=?1",params![build,base],|r|r.get(0))?;
    let mut writes = Writes::new(db)?;
    let mut after = 0i64;
    loop {
        let next=db.query_row("SELECT n.file_id,n.path,n.git_object_id,n.language,o.path,(o.git_object_id=n.git_object_id AND o.language=n.language AND o.source_sha256 IS n.source_sha256) FROM files n LEFT JOIN files o ON o.build_id=?2 AND o.path=n.path WHERE n.build_id=?1 AND n.file_id>?3 ORDER BY n.file_id LIMIT 1",params![build,base,after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<bool>>(5)?))).optional()?;
        let Some((id, path, oid, language, old, unchanged)) = next else {
            break;
        };
        after = id;
        let mut previous = None;
        let kind = if old.is_some() {
            if unchanged == Some(true) {
                None
            } else {
                Some("MODIFIED")
            }
        } else {
            let candidates:i64=db.query_row("SELECT count(*) FROM files o WHERE o.build_id=?1 AND o.git_object_id=?2 AND NOT EXISTS(SELECT 1 FROM files n WHERE n.build_id=?3 AND n.path=o.path)",params![base,oid,build],|r|r.get(0))?;
            let additions:i64=db.query_row("SELECT count(*) FROM files n WHERE n.build_id=?1 AND n.git_object_id=?2 AND NOT EXISTS(SELECT 1 FROM files o WHERE o.build_id=?3 AND o.path=n.path)",params![build,oid,base],|r|r.get(0))?;
            if candidates == 1 && additions == 1 {
                previous=Some(db.query_row("SELECT o.path FROM files o WHERE o.build_id=?1 AND o.git_object_id=?2 AND NOT EXISTS(SELECT 1 FROM files n WHERE n.build_id=?3 AND n.path=o.path)",params![base,oid,build],|r|r.get::<_,String>(0))?);
                Some("RENAMED")
            } else {
                Some("ADDED")
            }
        };
        if let Some(kind) = kind {
            writes.reserve(path.len() + previous.as_ref().map_or(0, String::len) + 256)?;
            db.execute(
                "INSERT INTO file_changes VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![build, path, kind, previous],
            )?;
        }
        // Dependency extraction/resolution is not qualified. Never inherit old
        // semantic results: persist a whole-scope invalidation for the new build.
        if ["JAVA", "CONFIG", "TYPESCRIPT", "JAVASCRIPT"].contains(&language.as_str()) {
            writes.reserve(256)?;
            db.execute("INSERT INTO semantic_invalidations VALUES (?1,?2,?3,'PENDING') ON CONFLICT DO NOTHING",params![build,id,if config{"CONFIGURATION_CHANGED"}else{"DEPENDENCY_GRAPH_INCOMPLETE"}])?;
        }
    }
    let mut after = 0i64;
    loop {
        let next=db.query_row("SELECT o.file_id,o.path FROM files o WHERE o.build_id=?1 AND o.file_id>?3 AND NOT EXISTS(SELECT 1 FROM files n WHERE n.build_id=?2 AND n.path=o.path) ORDER BY o.file_id LIMIT 1",params![base,build,after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional()?;
        let Some((id, path)) = next else {
            break;
        };
        after = id;
        let renamed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM file_changes WHERE build_id=?1 AND kind='RENAMED' AND previous_path=?2)",params![build,path],|r|r.get(0))?;
        if !renamed {
            writes.reserve(path.len() + 256)?;
            db.execute(
                "INSERT INTO file_changes VALUES (?1,?2,'DELETED',NULL) ON CONFLICT DO NOTHING",
                params![build, path],
            )?;
        }
    }
    writes.finish()?;
    Ok(())
}

fn open(database: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;")?;
    crate::verify_writer_settings(&db)?;
    Ok(db)
}

pub fn publish(database: &Path, build: &str, java: bool) -> Result<()> {
    let mut db = open(database)?;
    let tx = db.transaction()?;
    let valid:bool=tx.query_row("SELECT state='INCOMPLETE' AND NOT EXISTS(SELECT 1 FROM files WHERE build_id=?1 AND status IN ('DISCOVERED','INDEXING')) FROM builds WHERE build_id=?1",[build],|r|r.get(0))?;
    if !valid {
        bail!("INCREMENTAL_BUILD_NOT_TERMINAL");
    }
    if java {
        let missing:i64=tx.query_row("SELECT count(*) FROM files f WHERE f.build_id=?1 AND f.language='JAVA' AND f.source_sha256 IS NOT NULL AND (f.unit_id IS NULL OR NOT EXISTS(SELECT 1 FROM obligations o WHERE o.build_id=f.build_id AND o.file_id=f.file_id AND o.kind='JAVA_STRUCTURAL_FACTS') OR EXISTS(SELECT 1 FROM parse_units u WHERE u.unit_id=f.unit_id AND u.status='WRITING'))",[build],|r|r.get(0))?;
        if missing != 0 {
            bail!("INCREMENTAL_JAVA_NOT_TERMINAL");
        }
    }
    let changed=tx.execute("UPDATE index_state SET published_build_id=?1,pending_build_id=NULL WHERE singleton=1 AND pending_build_id=?1",[build])?;
    if changed != 1 {
        bail!("INCREMENTAL_PUBLICATION_MISMATCH");
    }
    tx.commit()?;
    Ok(())
}

pub fn published_build(database: &Path) -> Result<String> {
    let db = open(database)?;
    Ok(db.query_row("SELECT b.build_id FROM index_state s JOIN builds b ON b.build_id=s.published_build_id WHERE s.singleton=1 AND b.state='INCOMPLETE' AND (s.pending_build_id IS NULL OR s.pending_build_id!=s.published_build_id)",[],|r|r.get(0))?)
}

struct Writes<'a> {
    db: &'a Connection,
    rows: usize,
    bytes: usize,
}
impl<'a> Writes<'a> {
    fn new(db: &'a Connection) -> Result<Self> {
        db.execute_batch("BEGIN")?;
        Ok(Self {
            db,
            rows: 0,
            bytes: 0,
        })
    }
    fn reserve(&mut self, bytes: usize) -> Result<()> {
        if bytes > 4 * 1024 * 1024 {
            bail!("INCREMENTAL_RECORD_TOO_LARGE");
        }
        if self.rows >= 128 || self.bytes + bytes > 4 * 1024 * 1024 {
            self.db.execute_batch("COMMIT; BEGIN")?;
            self.rows = 0;
            self.bytes = 0;
        }
        self.rows += 1;
        self.bytes += bytes;
        Ok(())
    }
    fn finish(self) -> Result<()> {
        self.db.execute_batch("COMMIT")?;
        Ok(())
    }
}
impl Drop for Writes<'_> {
    fn drop(&mut self) {
        if !self.db.is_autocommit() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
    }
}
