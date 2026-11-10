//! Isolated structural Java extraction. No cross-file/type or call resolution.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use tree_sitter::{Node, Parser};

const FRAME_LIMIT: usize = 64 * 1024;
const GRAMMAR: &str = "tree-sitter-java-0.23.5/runtime-0.26.7";
const EXTRACTOR: &str = "java-structural-v3";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Fact {
    pub ordinal: i64,
    pub parent_ordinal: Option<i64>,
    pub kind: String,
    pub name: String,
    pub qualified_name: Option<String>,
    pub start_byte: usize,
    pub end_byte: usize,
    pub metadata: Value,
}

#[derive(Serialize, Deserialize)]
struct Request {
    source_hash: String,
    max_file_bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "message")]
enum Message {
    Fact {
        fact: Fact,
    },
    End {
        facts: u64,
        parse_error: bool,
        timing: WorkerTiming,
    },
    Error {
        reason: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct WorkerTiming {
    pub source_load_ns: u64,
    pub native_parse_ns: u64,
    pub extraction_ns: u64,
    /// Includes JSON encoding, buffered writes and pipe backpressure; overlaps parent work.
    pub emit_ns: u64,
}

#[derive(Debug, Serialize, Default)]
pub struct JavaMetrics {
    pub worker_requests: u64,
    pub writer_commits: u64,
    pub batch_peak_bytes: usize,
    pub batch_peak_rows: usize,
    pub batch_peak_files: usize,
    pub writer_synchronous: i64,
    pub writer_journal_mode: String,
    pub cache_hits: u64,
    pub worker_timing: WorkerTiming,
    pub parent_receive_wait_ns: u128,
    pub parent_decode_ns: u128,
    pub sqlite_insert_ns: u128,
    pub sqlite_commit_ns: u128,
    pub ledger_ns: u128,
    pub attempted_files: u64,
    pub complete_files: u64,
    pub partial_files: u64,
    pub blocked_files: u64,
    pub declarations: u64,
    pub elapsed_ms: u128,
    pub worker_peak_rss_bytes: usize,
    pub worker_memory_limit_mib: usize,
    pub memory_enforcement: String,
    pub worker_restarts: u64,
    pub max_active_files: usize,
}

const BATCH_BYTES: usize = 4 * 1024 * 1024;
const BATCH_ROWS: usize = 2000;
const BATCH_FILES: usize = 32;

#[derive(Default)]
struct Completed {
    complete: u64,
    partial: u64,
    blocked: u64,
    facts: u64,
    cache_hits: u64,
}
impl Completed {
    fn files(&self) -> u64 {
        self.complete + self.partial + self.blocked
    }
    fn add(&mut self, other: Self) {
        self.complete += other.complete;
        self.partial += other.partial;
        self.blocked += other.blocked;
        self.facts += other.facts;
        self.cache_hits += other.cache_hits;
    }
}

/// SQLite retains the records; only fixed-size counters await a successful commit.
struct FactWriter<'a> {
    db: &'a Connection,
    active_file: bool,
    bytes: usize,
    rows: usize,
    files: usize,
    pending: Completed,
}
impl<'a> FactWriter<'a> {
    fn new(db: &'a Connection) -> Result<Self> {
        db.execute_batch("BEGIN")?;
        Ok(Self {
            db,
            active_file: false,
            bytes: 0,
            rows: 0,
            files: 0,
            pending: Completed::default(),
        })
    }
    fn flush(&mut self, metrics: &mut JavaMetrics, reopen: bool) -> Result<()> {
        if self.active_file {
            self.db.execute_batch("RELEASE active_file")?;
        }
        let start = Instant::now();
        self.db.execute_batch("COMMIT")?;
        metrics.sqlite_commit_ns += start.elapsed().as_nanos();
        metrics.writer_commits += 1;
        metrics.complete_files += self.pending.complete;
        metrics.partial_files += self.pending.partial;
        metrics.blocked_files += self.pending.blocked;
        metrics.declarations += self.pending.facts;
        metrics.cache_hits += self.pending.cache_hits;
        self.pending = Completed::default();
        self.bytes = 0;
        self.rows = 0;
        self.files = usize::from(self.active_file);
        if reopen {
            self.db.execute_batch("BEGIN")?;
            if self.active_file {
                self.db.execute_batch("SAVEPOINT active_file")?;
            }
        }
        Ok(())
    }
    fn reserve(&mut self, bytes: usize, metrics: &mut JavaMetrics) -> Result<()> {
        if bytes > BATCH_BYTES {
            bail!("RESOURCE_LIMIT_WRITER_RECORD");
        }
        if self.bytes + bytes > BATCH_BYTES || self.rows >= BATCH_ROWS {
            self.flush(metrics, true)?;
        }
        self.bytes += bytes;
        metrics.batch_peak_bytes = metrics.batch_peak_bytes.max(self.bytes);
        Ok(())
    }
    fn start_file(&mut self, metrics: &mut JavaMetrics) -> Result<()> {
        if self.files >= BATCH_FILES || self.pending.files() >= BATCH_FILES as u64 {
            self.flush(metrics, true)?;
        }
        self.reserve(2048, metrics)?;
        self.files += 1;
        metrics.batch_peak_files = metrics.batch_peak_files.max(self.files);
        Ok(())
    }
    fn guard_file(&mut self) -> Result<()> {
        self.db.execute_batch("SAVEPOINT active_file")?;
        self.active_file = true;
        Ok(())
    }
    fn end_file(&mut self, failed: bool) -> Result<()> {
        if failed {
            self.db.execute_batch("ROLLBACK TO active_file")?;
        }
        self.db.execute_batch("RELEASE active_file")?;
        self.active_file = false;
        // Conservatively retain rolled-back row/byte charges until the next flush.
        Ok(())
    }
}
impl Drop for FactWriter<'_> {
    fn drop(&mut self) {
        if !self.db.is_autocommit() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
    }
}

fn text(node: Node<'_>, source: &[u8]) -> Result<String> {
    if node.byte_range().len() > 16 * 1024 {
        bail!("RESOURCE_LIMIT_FACT_TEXT");
    }
    Ok(std::str::from_utf8(&source[node.byte_range()])?.to_owned())
}
fn field(node: Node<'_>, name: &str, source: &[u8]) -> Result<Option<String>> {
    node.child_by_field_name(name)
        .map(|node| text(node, source))
        .transpose()
}
fn class_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration"
            | "annotation_type_declaration"
    )
}
fn package_name(node: Node<'_>, source: &[u8]) -> Result<String> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if matches!(child.kind(), "identifier" | "scoped_identifier") {
            return text(child, source);
        }
    }
    Ok(String::new())
}

/// One native parse; facts are delivered one at a time and never retained as a whole-file vector.
pub fn extract(source: &[u8], mut emit: impl FnMut(Fact) -> Result<()>) -> Result<(u64, bool)> {
    extract_profiled(source, &mut emit, &mut WorkerTiming::default())
}

fn extract_profiled(
    source: &[u8],
    mut emit: impl FnMut(Fact) -> Result<()>,
    timing: &mut WorkerTiming,
) -> Result<(u64, bool)> {
    let extraction_start = Instant::now();
    std::str::from_utf8(source).context("INVALID_UTF8")?;
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into())?;
    let parse_start = Instant::now();
    let tree = parser.parse(source, None).context("JAVA_PARSE_FAILED")?;
    timing.native_parse_ns = parse_start.elapsed().as_nanos() as u64;
    let error = tree.root_node().has_error();
    let mut cursor = tree.walk();
    let mut owners: Vec<Option<i64>> = Vec::new();
    let mut next = 0i64;
    loop {
        let node = cursor.node();
        if owners.len() > 4096 {
            bail!("RESOURCE_LIMIT_TRAVERSAL_DEPTH");
        }
        let parent = owners.last().copied().flatten();
        let kind = node.kind();
        let fact_kind = if class_kind(kind) {
            Some("CLASS")
        } else {
            match kind {
                "package_declaration" => Some("PACKAGE"),
                "import_declaration" => Some("IMPORT"),
                "method_declaration" | "annotation_type_element_declaration" => Some("METHOD"),
                "constructor_declaration" | "compact_constructor_declaration" => {
                    Some("CONSTRUCTOR")
                }
                "variable_declarator"
                    if node
                        .parent()
                        .is_some_and(|p| p.kind() == "field_declaration") =>
                {
                    Some("FIELD")
                }
                "enum_constant" => Some("ENUM_CONSTANT"),
                "formal_parameter" | "spread_parameter" => Some("PARAMETER"),
                "type_parameter" => Some("TYPE_PARAMETER"),
                "lambda_expression" => Some("LAMBDA"),
                "class_body"
                    if node.parent().is_some_and(|p| {
                        matches!(p.kind(), "object_creation_expression" | "enum_constant")
                    }) =>
                {
                    Some("ANONYMOUS_CLASS")
                }
                "annotation" | "marker_annotation" => Some("ANNOTATION"),
                _ => None,
            }
        };
        let mut owner = parent;
        if let Some(fact_kind) = fact_kind {
            let mut metadata = json!({"syntax_kind":kind,"line_start":node.start_position().row+1,"line_end":node.end_position().row+1,"byte_column":node.start_position().column});
            let point = node.start_position();
            let line_start = node.start_byte().saturating_sub(point.column);
            metadata["utf16_column"] =
                json!(std::str::from_utf8(&source[line_start..node.start_byte()])?
                    .encode_utf16()
                    .count());
            let name = if matches!(fact_kind, "PACKAGE" | "IMPORT") {
                let raw = text(node, source)?;
                if fact_kind == "PACKAGE" {
                    package_name(node, source)?
                } else {
                    raw.trim_end_matches(';')
                        .trim()
                        .strip_prefix("import")
                        .unwrap_or(&raw)
                        .trim()
                        .to_owned()
                }
            } else {
                let mut name = field(node, "name", source)?.unwrap_or_default();
                if name.is_empty() && kind == "spread_parameter" {
                    let mut cursor = node.walk();
                    for child in node.named_children(&mut cursor) {
                        if child.kind() == "variable_declarator" {
                            name = field(child, "name", source)?.unwrap_or_default();
                        }
                    }
                }
                name
            };
            let mut qualified = None;
            if class_kind(kind) {
                let mut names = vec![name.clone()];
                let mut ancestor = node.parent();
                while let Some(p) = ancestor {
                    if class_kind(p.kind()) {
                        names.push(field(p, "name", source)?.unwrap_or_default());
                    }
                    ancestor = p.parent();
                }
                names.reverse();
                let root = tree.root_node();
                let mut package = String::new();
                let mut children = root.walk();
                for child in root.named_children(&mut children) {
                    if child.kind() == "package_declaration" {
                        package = package_name(child, source)?;
                        break;
                    }
                }
                qualified = Some(if package.is_empty() {
                    names.join(".")
                } else {
                    format!("{package}.{}", names.join("."))
                });
                metadata["type_parameters"] = json!(field(node, "type_parameters", source)?);
                metadata["superclass"] = json!(field(node, "superclass", source)?);
                metadata["interfaces"] = json!(field(node, "interfaces", source)?);
                metadata["permits"] = json!(field(node, "permits", source)?);
            }
            let holder = if fact_kind == "FIELD" {
                node.parent().unwrap_or(node)
            } else {
                node
            };
            metadata["parent_syntax_kind"] = json!(node.parent().map(|p| p.kind()));
            metadata["type"] = json!(field(holder, "type", source)?);
            metadata["type_parameters"] = json!(field(node, "type_parameters", source)?);
            metadata["name_line"] = json!(
                node.child_by_field_name("name")
                    .unwrap_or(node)
                    .start_position()
                    .row
                    + 1
            );
            if kind == "spread_parameter" {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if !matches!(child.kind(), "modifiers" | "variable_declarator") {
                        metadata["type"] = json!(text(child, source)?);
                        break;
                    }
                }
            }
            metadata["dimensions"] = json!(field(node, "dimensions", source)?);
            let mut children = holder.walk();
            for child in holder.named_children(&mut children) {
                if child.kind() == "modifiers" {
                    metadata["modifiers"] = json!(text(child, source)?);
                    let mut annotation_names = Vec::new();
                    let mut flags = Vec::new();
                    let mut modifiers = child.walk();
                    for modifier in child.children(&mut modifiers) {
                        if matches!(modifier.kind(), "annotation" | "marker_annotation") {
                            annotation_names
                                .push(field(modifier, "name", source)?.unwrap_or_default());
                        } else if !matches!(modifier.kind(), "line_comment" | "block_comment") {
                            flags.push(text(modifier, source)?);
                        }
                    }
                    metadata["annotations"] = json!(annotation_names);
                    metadata["flags"] = json!(flags);
                }
                if child.kind() == "throws" {
                    metadata["throws"] = json!(text(child, source)?);
                }
            }
            if let Some(value) = node.child_by_field_name("value") {
                metadata["value_span"] = json!([value.start_byte(), value.end_byte()]);
            }
            let fact = Fact {
                ordinal: next,
                parent_ordinal: parent,
                kind: fact_kind.into(),
                name,
                qualified_name: qualified,
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
                metadata,
            };
            // Includes names and all metadata; IPC and pending facts remain bounded.
            if serde_json::to_vec(&fact)?.len() > FRAME_LIMIT - 128 {
                bail!("RESOURCE_LIMIT_FACT_BYTES");
            }
            let emit_start = Instant::now();
            emit(fact)?;
            timing.emit_ns += emit_start.elapsed().as_nanos() as u64;
            if matches!(
                fact_kind,
                "CLASS"
                    | "LAMBDA"
                    | "ANONYMOUS_CLASS"
                    | "METHOD"
                    | "CONSTRUCTOR"
                    | "FIELD"
                    | "ENUM_CONSTANT"
                    | "PARAMETER"
                    | "TYPE_PARAMETER"
            ) {
                owner = Some(next);
            }
            next += 1;
        }
        owners.push(owner);
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            owners.pop();
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                timing.extraction_ns = (extraction_start.elapsed().as_nanos() as u64)
                    .saturating_sub(timing.native_parse_ns + timing.emit_ns);
                return Ok((next as u64, error));
            }
        }
    }
}

/// Worker owns a single source and tree per request; dropping parser/tree frees native state.
pub fn worker(database: &Path) -> Result<()> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("PRAGMA cache_size=-8192; PRAGMA mmap_size=0;")?;
    let mut input = BufReader::new(std::io::stdin());
    let mut output = BufWriter::new(std::io::stdout());
    while let Some(frame) = crate::git_stream::record(&mut input, b'\n', FRAME_LIMIT)? {
        let request: Request = serde_json::from_slice(&frame)?;
        let operation = (|| -> Result<()> {
            let load_start = Instant::now();
            let mut timing = WorkerTiming::default();
            let (length, state): (i64, String) = db.query_row(
                "SELECT byte_length,state FROM source_blobs WHERE source_sha256=?1",
                [&request.source_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if length as u64 > request.max_file_bytes {
                bail!("RESOURCE_LIMIT_SOURCE_BYTES");
            }
            if state != "SEALED" {
                bail!("UNSEALED_SOURCE");
            }
            let mut source = Vec::with_capacity(length as usize);
            let mut statement=db.prepare("SELECT chunk_ordinal,bytes FROM source_chunks WHERE source_sha256=?1 ORDER BY chunk_ordinal")?;
            let mut rows = statement.query([&request.source_hash])?;
            let mut ordinal = 0i64;
            while let Some(row) = rows.next()? {
                let number: i64 = row.get(0)?;
                if number != ordinal {
                    bail!("SOURCE_CHUNK_GAP");
                }
                let bytes: Vec<u8> = row.get(1)?;
                if source.len() + bytes.len() > length as usize {
                    bail!("SOURCE_LENGTH_MISMATCH");
                }
                source.extend_from_slice(&bytes);
                ordinal += 1;
            }
            drop(rows);
            drop(statement);
            if source.len() != length as usize
                || hex::encode(Sha256::digest(&source)) != request.source_hash
            {
                bail!("SOURCE_HASH_MISMATCH");
            }
            timing.source_load_ns = load_start.elapsed().as_nanos() as u64;
            let (facts, parse_error) = extract_profiled(
                &source,
                |fact| {
                    let message = Message::Fact { fact };
                    serde_json::to_writer(&mut output, &message)?;
                    output.write_all(b"\n")?;
                    // Bounded pipe backpressure; writer can consume facts before end-of-file.
                    Ok(())
                },
                &mut timing,
            )?;
            drop(source);
            serde_json::to_writer(
                &mut output,
                &Message::End {
                    facts,
                    parse_error,
                    timing,
                },
            )?;
            output.write_all(b"\n")?;
            Ok(())
        })();
        if let Err(error) = operation {
            serde_json::to_writer(
                &mut output,
                &Message::Error {
                    reason: format!("{error:#}"),
                },
            )?;
            output.write_all(b"\n")?;
        }
        output.flush()?;
    }
    Ok(())
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child, bytes: usize) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The child waits for input; apply the cap before permitting source allocation.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                bail!("JOB_CREATE_FAILED: {}", std::io::Error::last_os_error());
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            info.ProcessMemoryLimit = bytes;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                bail!("JOB_ASSIGN_FAILED: {error}");
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn rss(child: &Child) -> Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::ProcessStatus::*;
        let mut info = PROCESS_MEMORY_COUNTERS::default();
        if unsafe {
            GetProcessMemoryInfo(
                child.as_raw_handle(),
                &mut info,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            bail!("WORKER_MEMORY_SAMPLE_FAILED");
        }
        Ok(info.WorkingSetSize)
    }
    #[cfg(target_os = "linux")]
    {
        let pid = child.id();
        if let Ok(content) = std::fs::read_to_string(format!("/proc/{pid}/statm")) {
            let page_size = crate::budget::linux_page_size();
            if let Ok(rss_bytes) = crate::budget::parse_statm_rss(&content, page_size) {
                return Ok(rss_bytes);
            }
        }
        Ok(0)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = child;
        Ok(0)
    }
}

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    messages: Receiver<Result<Vec<u8>>>,
    reader: Option<thread::JoinHandle<()>>,
    #[cfg(windows)]
    _job: Job,
}
impl Worker {
    fn start(executable: &Path, database: &Path, _memory_mib: usize) -> Result<Self> {
        let mut command = Command::new(executable);
        command
            .arg("java-worker")
            .arg("--database")
            .arg(database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match Job::attach(&child, memory_mib * 1024 * 1024) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take();
        let stdout = child.stdout.take().context("Worker stdout missing")?;
        let (send, messages) = sync_channel(2);
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match crate::git_stream::record(&mut reader, b'\n', FRAME_LIMIT) {
                    Ok(Some(frame)) => {
                        if send.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = send.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            messages,
            reader: Some(reader),
            #[cfg(windows)]
            _job: job,
        })
    }
    fn send(&mut self, request: &Request) -> Result<()> {
        let input = self.input.as_mut().context("Worker closed")?;
        serde_json::to_writer(&mut *input, request)?;
        input.write_all(b"\n")?;
        input.flush()?;
        Ok(())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Drop the bounded receiver before joining a reader blocked on send.
        let (_send, replacement) = sync_channel(1);
        let receiver = std::mem::replace(&mut self.messages, replacement);
        drop(receiver);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS file_analysis_status (
    file_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    updated_at INTEGER NOT NULL
);
";

pub fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn index(
    database: &Path,
    executable: &Path,
    timeout_ms: u64,
    memory_mib: usize,
    max_file_bytes: u64,
) -> Result<JavaMetrics> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let count: i64 = db.query_row("SELECT count(*) FROM builds", [], |r| r.get(0))?;
    if count != 1 {
        bail!("MULTIPLE_BUILDS_REQUIRE_EXPLICIT_BUILD_ID");
    }
    let build: String = db.query_row("SELECT build_id FROM builds", [], |r| r.get(0))?;
    drop(db);
    index_build(
        database,
        &build,
        executable,
        timeout_ms,
        memory_mib,
        max_file_bytes,
    )
}

pub fn index_build(
    database: &Path,
    build: &str,
    executable: &Path,
    timeout_ms: u64,
    memory_mib: usize,
    max_file_bytes: u64,
) -> Result<JavaMetrics> {
    if timeout_ms == 0 || !(16..=512).contains(&memory_mib) || max_file_bytes == 0 {
        bail!("Invalid Java worker limits");
    }
    let start = Instant::now();
    let mut metrics = JavaMetrics {
        worker_memory_limit_mib: memory_mib,
        memory_enforcement: if cfg!(windows) {
            "Windows Job Object private-commit cap + sampled RSS"
        } else if cfg!(target_os = "linux") {
            "Linux /proc/<pid>/statm sampled RSS; no OS hard cap; timeout only"
        } else {
            "no OS hard cap; timeout only"
        }
        .into(),
        max_active_files: 1,
        ..Default::default()
    };
    let db = Connection::open(database)?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;")?;
    crate::verify_writer_settings(&db)?;
    ensure_schema(&db)?;
    metrics.writer_synchronous = db.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
    metrics.writer_journal_mode = db.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    let (build, state): (String, String) = db.query_row(
        "SELECT build_id,state FROM builds WHERE build_id=?1",
        [build],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if state != "INCOMPLETE" {
        bail!("Expected a completed capture build");
    }
    db.execute(
        "UPDATE builds SET state='BUILDING' WHERE build_id=?1",
        [&build],
    )?;
    let mut writer = FactWriter::new(&db)?;
    let mut worker: Option<Worker> = None;
    let mut after = 0i64;
    loop {
        let file = {
            let mut statement=db.prepare("SELECT file_id,source_sha256,git_byte_length FROM files WHERE build_id=?1 AND language='JAVA' AND source_sha256 IS NOT NULL AND file_id>?2 ORDER BY file_id LIMIT 1")?;
            let mut rows = statement.query(params![build, after])?;
            rows.next()?
                .map(|row| {
                    Ok::<_, rusqlite::Error>((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                    ))
                })
                .transpose()?
        };
        let Some((file_id, hash, length)) = file else {
            break;
        };
        after = file_id;
        metrics.attempted_files += 1;
        writer.start_file(&mut metrics)?;
        let ledger_start = Instant::now();
        let unit = hex::encode(Sha256::digest(
            format!("{hash}\0{GRAMMAR}\0{EXTRACTOR}").as_bytes(),
        ));
        // One file's bounded setup ledger; source blobs were already sealed by capture.
        let setup = writer.db;
        setup.prepare_cached("INSERT INTO parse_units VALUES (?1,?2,'JAVA',?3,?4,'WRITING') ON CONFLICT(unit_id) DO NOTHING")?.execute(params![unit,hash,GRAMMAR,EXTRACTOR])?;
        setup
            .prepare_cached(
                "UPDATE files SET unit_id=?3,status='INDEXING' WHERE build_id=?1 AND file_id=?2",
            )?
            .execute(params![build, file_id, unit])?;
        let reusable: String = setup.query_row(
            "SELECT status FROM parse_units WHERE unit_id=?1 AND source_sha256=?2 AND grammar_fingerprint=?3 AND extractor_fingerprint=?4 AND language='JAVA'",
            params![unit,hash,GRAMMAR,EXTRACTOR],
            |row| row.get(0),
        )?;
        if reusable != "COMPLETE" {
            // Descending ordinals keep parent FKs valid at each bounded commit.
            // A crashed/blocked large file must not create an unbounded DELETE.
            loop {
                let tail=setup.query_row("SELECT ordinal,length(CAST(facts_json AS BLOB))+length(CAST(name AS BLOB))+coalesce(length(CAST(qualified_name AS BLOB)),0)+128 FROM declarations WHERE unit_id=?1 ORDER BY ordinal DESC LIMIT 1",[&unit],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).optional()?;
                let Some((ordinal, bytes)) = tail else {
                    break;
                };
                writer.reserve(bytes as usize, &mut metrics)?;
                setup
                    .prepare_cached("DELETE FROM declarations WHERE unit_id=?1 AND ordinal=?2")?
                    .execute(params![unit, ordinal])?;
                writer.rows += 1;
                metrics.batch_peak_rows = metrics.batch_peak_rows.max(writer.rows);
            }
        }
        metrics.ledger_ns += ledger_start.elapsed().as_nanos();
        writer.guard_file()?;
        let mut used_cache = false;
        let operation = (|| -> Result<(u64, bool)> {
            if length > max_file_bytes {
                bail!("RESOURCE_LIMIT_SOURCE_BYTES");
            }
            if reusable == "COMPLETE" {
                used_cache = true;
                let count: u64 = db.query_row(
                    "SELECT count(*) FROM declarations WHERE unit_id=?1",
                    [&unit],
                    |row| row.get::<_, i64>(0).map(|n| n as u64),
                )?;
                return Ok((count, false));
            }
            if worker.is_none() {
                worker = Some(Worker::start(executable, database, memory_mib)?);
            }
            let current = worker.as_mut().unwrap();
            current.send(&Request {
                source_hash: hash.clone(),
                max_file_bytes,
            })?;
            metrics.worker_requests += 1;
            let deadline = Instant::now();
            let mut last_sample = Instant::now() - Duration::from_millis(20);
            let mut ordinal = 0u64;
            loop {
                if deadline.elapsed().as_millis() >= timeout_ms as u128 {
                    bail!("RESOURCE_LIMIT_TIMEOUT");
                }
                if last_sample.elapsed() >= Duration::from_millis(20) {
                    let current_rss = rss(&current.child)?;
                    metrics.worker_peak_rss_bytes = metrics.worker_peak_rss_bytes.max(current_rss);
                    if current_rss > memory_mib * 1024 * 1024 {
                        bail!("RESOURCE_LIMIT_WORKER_RSS");
                    }
                    last_sample = Instant::now();
                }
                let receive_start = Instant::now();
                let received = current.messages.recv_timeout(Duration::from_millis(20));
                metrics.parent_receive_wait_ns += receive_start.elapsed().as_nanos();
                match received {
                    Ok(frame) => {
                        let frame = frame?;
                        let decode_start = Instant::now();
                        let message: Message = serde_json::from_slice(&frame)?;
                        metrics.parent_decode_ns += decode_start.elapsed().as_nanos();
                        match message {
                            Message::Fact { fact } => {
                                if fact.ordinal != ordinal as i64
                                    || fact.end_byte > length as usize
                                    || fact.start_byte > fact.end_byte
                                    || fact
                                        .parent_ordinal
                                        .is_some_and(|p| p < 0 || p >= fact.ordinal)
                                {
                                    bail!("INVALID_WORKER_FACT");
                                }
                                let metadata = serde_json::to_string(&fact.metadata)?;
                                writer.reserve(frame.len(), &mut metrics)?;
                                let insert_start = Instant::now();
                                writer.db.prepare_cached("INSERT INTO declarations VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)")?.execute(params![unit,fact.ordinal,fact.parent_ordinal,fact.kind,fact.name,fact.qualified_name,fact.start_byte as i64,fact.end_byte as i64,metadata])?;
                                metrics.sqlite_insert_ns += insert_start.elapsed().as_nanos();
                                ordinal += 1;
                                writer.rows += 1;
                                metrics.batch_peak_rows = metrics.batch_peak_rows.max(writer.rows);
                            }
                            Message::End {
                                facts,
                                parse_error,
                                timing,
                            } => {
                                if facts != ordinal {
                                    bail!("WORKER_COUNT_MISMATCH");
                                }
                                metrics.worker_timing.source_load_ns += timing.source_load_ns;
                                metrics.worker_timing.native_parse_ns += timing.native_parse_ns;
                                metrics.worker_timing.extraction_ns += timing.extraction_ns;
                                metrics.worker_timing.emit_ns += timing.emit_ns;
                                return Ok((facts, parse_error));
                            }
                            Message::Error { reason } => bail!("{reason}"),
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if current.child.try_wait()?.is_some() {
                            bail!("RESOURCE_LIMIT_OR_WORKER_EXIT");
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => bail!("RESOURCE_LIMIT_OR_WORKER_EXIT"),
                }
            }
        })();
        let failed = operation.is_err();
        // SQLITE_FULL/NOMEM can abort the entire transaction and remove its
        // savepoint. Preserve the originating error; never publish a file ACK.
        if writer.db.is_autocommit() {
            let error = operation
                .err()
                .unwrap_or_else(|| anyhow::anyhow!("writer transaction unexpectedly ended"));
            return Err(error).context("WRITER_TRANSACTION_ABORTED");
        }
        writer.end_file(failed)?;
        let (unit_status, file_status, reason, completion) = match operation {
            Ok((facts, false)) => (
                "COMPLETE",
                "INDEXED",
                None,
                Completed {
                    complete: 1,
                    facts,
                    ..Default::default()
                },
            ),
            Ok((facts, true)) => (
                "PARTIAL",
                "PARTIAL",
                Some("JAVA_PARSE_ERRORS".to_owned()),
                Completed {
                    partial: 1,
                    facts,
                    ..Default::default()
                },
            ),
            Err(error) => {
                worker.take();
                metrics.worker_restarts += 1;
                (
                    "BLOCKED",
                    "BLOCKED",
                    Some(format!("{error:#}")),
                    Completed {
                        blocked: 1,
                        ..Default::default()
                    },
                )
            }
        };
        // Flush/charge before adding this completion: current facts may commit as WRITING.
        writer.reserve(2048 + reason.as_ref().map_or(0, String::len), &mut metrics)?;
        let ledger_start = Instant::now();
        let tx = writer.db;
        tx.execute(
            "UPDATE parse_units SET status=?2 WHERE unit_id=?1",
            params![unit, unit_status],
        )?;
        tx.execute(
            "UPDATE files SET status=?3 WHERE build_id=?1 AND file_id=?2",
            params![build, file_id, file_status],
        )?;
        tx.execute("INSERT INTO obligations VALUES (?1,?2,?3,'JAVA_STRUCTURAL_FACTS',?4,?5,'{}') ON CONFLICT(build_id,obligation_id) DO UPDATE SET status=excluded.status,reason=excluded.reason",params![build,file_id,format!("structural:{file_id}"),if reason.is_none(){"SUPPORTED"}else{"UNKNOWN"},reason])?;
        let changed = tx.prepare_cached("UPDATE obligations SET reason='CALL_REFERENCE_RESOLUTION_NOT_IMPLEMENTED' WHERE build_id=?1 AND obligation_id=?2 AND file_id=?3 AND kind='JAVA_SYNTAX'")?.execute(params![build,format!("syntax:{file_id}"),file_id])?;
        if changed != 1 {
            bail!("JAVA_SYNTAX_OBLIGATION_MISSING");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        tx.execute(
            "INSERT INTO file_analysis_status(file_id, status, reason, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(file_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated_at=excluded.updated_at",
            params![file_id.to_string(), file_status, reason, now],
        )?;
        metrics.ledger_ns += ledger_start.elapsed().as_nanos();
        writer.pending.add(Completed {
            cache_hits: u64::from(used_cache),
            ..completion
        });
        metrics.batch_peak_files = metrics
            .batch_peak_files
            .max(writer.pending.files() as usize);
        if failed || writer.files >= BATCH_FILES || writer.pending.files() >= BATCH_FILES as u64 {
            writer.flush(&mut metrics, true)?;
        }
    }
    writer.flush(&mut metrics, false)?;
    drop(writer);
    drop(worker);
    db.execute("UPDATE builds SET state='INCOMPLETE',terminal_files=(SELECT count(*) FROM files WHERE build_id=?1 AND status NOT IN ('DISCOVERED','INDEXING')) WHERE build_id=?1", [&build])?;
    metrics.elapsed_ms = start.elapsed().as_millis();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(metrics)
}

#[cfg(test)]
mod writer_tests {
    use super::*;

    #[test]
    fn sqlite_full_aborts_uncommitted_batch_without_publishing_success() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(value BLOB); INSERT INTO events VALUES(x'01'); PRAGMA max_page_count=2;").unwrap();
        let mut metrics = JavaMetrics::default();
        {
            let mut writer = FactWriter::new(&db).unwrap();
            writer.start_file(&mut metrics).unwrap();
            writer.guard_file().unwrap();
            let error = db
                .execute("INSERT INTO events VALUES(?1)", [vec![42u8; 65536]])
                .unwrap_err();
            assert!(
                matches!(error,rusqlite::Error::SqliteFailure(e,_) if e.code==rusqlite::ErrorCode::DiskFull)
            );
        }
        assert_eq!(metrics.complete_files, 0);
        assert_eq!(metrics.writer_commits, 0);
        assert_eq!(
            db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn byte_limit_flushes_before_overflow_and_tail_rollback_preserves_prefix() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(value INTEGER)")
            .unwrap();
        let mut metrics = JavaMetrics::default();
        let mut writer = FactWriter::new(&db).unwrap();
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        db.execute("INSERT INTO events VALUES(1)", []).unwrap();
        writer.reserve(BATCH_BYTES - 2048, &mut metrics).unwrap();
        writer.reserve(1, &mut metrics).unwrap();
        assert_eq!(metrics.batch_peak_bytes, BATCH_BYTES);
        assert_eq!(metrics.writer_commits, 1);
        db.execute("INSERT INTO events VALUES(2)", []).unwrap();
        writer.end_file(true).unwrap();
        writer.pending.blocked = 1;
        writer.flush(&mut metrics, false).unwrap();
        assert_eq!(
            db.query_row("SELECT sum(value) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn dropping_uncommitted_batch_rolls_back_unacknowledged_completions() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(value INTEGER)")
            .unwrap();
        let mut metrics = JavaMetrics::default();
        {
            let mut writer = FactWriter::new(&db).unwrap();
            writer.start_file(&mut metrics).unwrap();
            writer.guard_file().unwrap();
            db.execute("INSERT INTO events VALUES(1)", []).unwrap();
            writer.end_file(false).unwrap();
            writer.pending.complete = 1;
        }
        assert_eq!(metrics.complete_files, 0);
        assert_eq!(
            db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn failed_commit_does_not_acknowledge_and_drop_rolls_back() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)").unwrap();
        let mut metrics = JavaMetrics::default();
        let mut writer = FactWriter::new(&db).unwrap();
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        db.execute("INSERT INTO children VALUES(99)", []).unwrap();
        writer.end_file(false).unwrap();
        writer.pending.complete = 1;
        assert!(writer.flush(&mut metrics, false).is_err());
        assert_eq!(metrics.complete_files, 0);
        assert_eq!(metrics.writer_commits, 0);
        drop(writer);
        assert_eq!(
            db.query_row("SELECT count(*) FROM children", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn sql_failure_preserves_previous_file_and_acknowledges_only_on_commit() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(value INTEGER UNIQUE)")
            .unwrap();
        let mut metrics = JavaMetrics::default();
        let mut writer = FactWriter::new(&db).unwrap();
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        db.execute("INSERT INTO events VALUES(1)", []).unwrap();
        writer.end_file(false).unwrap();
        writer.pending.complete = 1;
        assert_eq!(metrics.complete_files, 0);
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        db.execute("INSERT INTO events VALUES(2)", []).unwrap();
        assert!(db.execute("INSERT INTO events VALUES(1)", []).is_err());
        writer.end_file(true).unwrap();
        writer.pending.blocked = 1;
        writer.flush(&mut metrics, false).unwrap();
        assert_eq!(metrics.complete_files, 1);
        assert_eq!(metrics.blocked_files, 1);
        assert_eq!(
            db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn split_file_recreates_savepoint_and_rollback_keeps_committed_prefix() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(value INTEGER UNIQUE)")
            .unwrap();
        let mut metrics = JavaMetrics::default();
        let mut writer = FactWriter::new(&db).unwrap();
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        db.execute("INSERT INTO events VALUES(-1)", []).unwrap();
        writer.end_file(false).unwrap();
        writer.pending.complete = 1;
        writer.start_file(&mut metrics).unwrap();
        writer.guard_file().unwrap();
        for number in 0..2001 {
            writer.reserve(64, &mut metrics).unwrap();
            db.execute("INSERT INTO events VALUES(?)", [number])
                .unwrap();
            writer.rows += 1;
        }
        assert_eq!(metrics.complete_files, 1);
        assert!(db.execute("INSERT INTO events VALUES(-1)", []).is_err());
        writer.end_file(true).unwrap();
        writer.pending.blocked = 1;
        writer.flush(&mut metrics, false).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2001
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM events WHERE value=2000", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(metrics.blocked_files, 1);
    }
}
