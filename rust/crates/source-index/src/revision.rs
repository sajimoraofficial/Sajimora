//! revision.rs — provider contract extraction from Git revisions, in memory.
//!
//! Three evaluation boundaries (MCP spec §2.1.2):
//! * `workingTreeVsBaseline` — the checked-out files, as `sajimora verify` uses today.
//! * `stagedVsBaseline` — index blobs only; unstaged edits must not be observable.
//! * `commitRange` — two committed trees, neither of which is on disk.
//!
//! No mode writes a file: the extracted envelope is handed to the envelope-level
//! service entry point, so the reviewed revision never touches disk.

use crate::express_routes::{is_express_source_file, ExpressRouteExtractor};
use crate::git_stream::{self, entry, record, Entry, GitChild, RECORD_LIMIT};
use crate::java_routes::{is_profile_config_path, ConfigInputs, JavaRouteExtractor, CONFIG_TAILS};
use crate::nestjs_routes::{is_controller_ts_path, is_provider_ts_file, NestJsRouteExtractor};
use crate::nextjs_routes::{is_nextjs_route_file, NextJsRouteExtractor};
use crate::provider::ProviderKind;
use anyhow::{bail, Context, Result};
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::report::SCHEMA_VERSION;
use sha2::{Digest, Sha256};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Repository identity used by `sajimora init`/`verify` artifacts. Revision-mode
/// extraction keeps the same value so a candidate and a sealed baseline remain
/// comparable by the admission layer's producer match.
pub const NATIVE_REPOSITORY_ID: &str = "git-root:native";

pub const MAX_JAVA_BLOB_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_BLOBS: usize = 20_000;

/// `detect_config` in the working-tree extractor reads these, in this order,
/// relative to the backend directory. The same precedence is applied to Git
/// blobs: `configFingerprint` is part of the sealed digest, so a mode that
/// consulted a different file would produce an incomparable artifact. The tail
/// list is taken from the extractor itself so the two cannot drift apart.
pub(crate) fn config_tails() -> Vec<&'static str> {
    let mut tails = vec!["rust/fixtures/spring-sample/src/main/resources/application.properties"];
    tails.extend(CONFIG_TAILS.iter().copied());
    tails
}

/// The provider module inside the repository. `prefix` is expressed in the same
/// POSIX terms Git reports (relative to the directory the git command runs in,
/// i.e. the repository root handed to `sajimora verify`), so blob paths can be
/// rebased onto the paths the sealed baseline uses for `provenance.file`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendScope {
    pub repo_root: PathBuf,
    pub prefix: String,
    pub disk_root: PathBuf,
}

impl BackendScope {
    pub fn new(repo_root: &Path, backend_rel: &str) -> Self {
        let prefix = backend_rel.trim_matches('/').replace('\\', "/");
        let disk_root = if prefix.is_empty() {
            repo_root.to_path_buf()
        } else {
            repo_root.join(&prefix)
        };
        Self {
            repo_root: repo_root.to_path_buf(),
            prefix,
            disk_root,
        }
    }

    /// Repository-relative POSIX path of a file inside the module, or `None`
    /// when the Git path lies outside the scope.
    pub fn within(&self, repo_path: &str) -> Option<String> {
        if self.prefix.is_empty() {
            return Some(repo_path.to_string());
        }
        repo_path
            .strip_prefix(&self.prefix)
            .and_then(|rest| rest.strip_prefix('/'))
            .map(|rest| rest.to_string())
    }

    pub fn join(&self, tail: &str) -> String {
        if self.prefix.is_empty() {
            tail.to_string()
        } else {
            format!("{}/{}", self.prefix, tail)
        }
    }
}

fn reject_option_like(argument: &str, what: &str) -> Result<()> {
    // A revision beginning with `-` would be consumed as a git option.
    if argument.is_empty() || argument.starts_with('-') {
        bail!("Invalid {what}: {argument:?}");
    }
    Ok(())
}

pub fn toplevel(repo: &Path) -> Result<PathBuf> {
    let raw = git_stream::scalar(repo, &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(raw))
}

pub fn resolve_commit(repo: &Path, revision: &str) -> Result<String> {
    reject_option_like(revision, "revision")?;
    let sha = git_stream::scalar(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
    )?;
    if sha.len() != 40 || !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("Revision {revision:?} did not resolve to a commit object id");
    }
    Ok(sha.to_ascii_lowercase())
}

pub fn head_commit(repo: &Path) -> Result<String> {
    resolve_commit(repo, "HEAD")
}

/// `(repository-relative POSIX path, blob oid)` for the staged index.
///
/// Uses `ls-files --stage -z` so unusual path bytes cannot break framing.
/// Unmerged entries abort the call: a conflicted path has three candidate
/// blobs, and silently picking one would verify a revision that no longer exists.
pub fn index_entries(repo: &Path) -> Result<Vec<(String, String)>> {
    let mut cmd = git_stream::command(repo);
    cmd.args(["ls-files", "--stage", "-z"]);
    // This server's stdin is the MCP protocol stream; a child must never read it.
    cmd.stdin(Stdio::null());
    let mut child = GitChild::spawn(cmd)?;
    let stdout = child.child.stdout.take().context("Git stdout missing")?;
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut entries = Vec::new();
    while let Some(line) = record(&mut reader, b'\0', RECORD_LIMIT)? {
        let (header, path) = split_record(&line)?;
        let columns: Vec<_> = header.split_whitespace().collect();
        if columns.len() != 3 {
            bail!("Invalid index record: {header}");
        }
        let (mode, oid, stage) = (columns[0], columns[1], columns[2]);
        if stage != "0" {
            bail!(
                "Unmerged index entry for {path:?} (stage {stage}); resolve the conflict before verifying"
            );
        }
        // 100644/100755 are file blobs. 120000 is a symlink and 160000 a
        // gitlink; neither is provider source, and following either would let
        // the index reference bytes outside the repository.
        if mode != "100644" && mode != "100755" {
            continue;
        }
        if oid.len() != 40 || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("Invalid blob id for {path:?}");
        }
        entries.push((path, oid.to_ascii_lowercase()));
    }
    child.finish()?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// Every file blob of a committed tree, with repository-relative paths.
///
/// `commit` must already be a resolved object id: a symbolic revision would
/// move between the two listings that make up one comparison.
pub fn tree_entries(repo: &Path, commit: &str) -> Result<Vec<Entry>> {
    reject_option_like(commit, "commit")?;
    if (commit.len() != 40 && commit.len() != 64) || !commit.bytes().all(|c| c.is_ascii_hexdigit())
    {
        bail!("Tree listing requires a resolved commit object id, got {commit:?}");
    }
    let commit = commit.to_ascii_lowercase();
    let mut cmd = git_stream::command(repo);
    cmd.args(["ls-tree", "-r", "-z", "--long", &commit]);
    cmd.stdin(Stdio::null());
    let mut child = GitChild::spawn(cmd)?;
    let stdout = child.child.stdout.take().context("Git stdout missing")?;
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut entries = Vec::new();
    while let Some(line) = record(&mut reader, b'\0', RECORD_LIMIT)? {
        let parsed = entry(&line, 40)?;
        if parsed.kind == "blob" {
            entries.push(parsed);
        }
    }
    child.finish()?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn split_record(record: &[u8]) -> Result<(String, String)> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .context("Index record has no separator")?;
    let header = std::str::from_utf8(&record[..tab])?.to_string();
    let path = String::from_utf8(record[tab + 1..].to_vec())?;
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("Invalid repository path: {path:?}");
    }
    Ok((header, path))
}

/// One `git cat-file --batch` process serves every blob of one revision, so a
/// large module costs one spawn rather than one spawn per file.
pub(crate) struct BlobReader {
    process: GitChild,
    input: Option<std::process::ChildStdin>,
    output: BufReader<std::process::ChildStdout>,
}

impl BlobReader {
    pub(crate) fn start(repo: &Path) -> Result<Self> {
        let mut cmd = git_stream::command(repo);
        cmd.arg("cat-file").arg("--batch").stdin(Stdio::piped());
        let mut process = GitChild::spawn(cmd)?;
        let input = process.child.stdin.take();
        let output = BufReader::with_capacity(
            64 * 1024,
            process.child.stdout.take().context("Git stdout missing")?,
        );
        Ok(Self {
            process,
            input,
            output,
        })
    }

    pub(crate) fn read(&mut self, oid: &str, expected_bytes: Option<u64>) -> Result<Vec<u8>> {
        let input = self.input.as_mut().context("Git batch closed")?;
        writeln!(input, "{oid}")?;
        input.flush()?;
        let header =
            record(&mut self.output, b'\n', RECORD_LIMIT)?.context("Missing batch header")?;
        let header = std::str::from_utf8(&header)?;
        let columns: Vec<_> = header.split_whitespace().collect();
        if columns.len() != 3 || columns[0] != oid {
            bail!("Invalid batch header: {header}");
        }
        if columns[1] != "blob" {
            bail!("Git object {oid} is not a blob ({})", columns[1]);
        }
        let size: u64 = columns[2].parse()?;
        if let Some(expected) = expected_bytes {
            if expected != size {
                bail!("Blob {oid} length {size} disagrees with the tree length {expected}");
            }
        }
        if size > MAX_JAVA_BLOB_BYTES {
            bail!("Blob {oid} is {size} bytes, over the {MAX_JAVA_BLOB_BYTES} byte source limit");
        }
        let mut buffer = vec![0u8; size as usize];
        self.output.read_exact(&mut buffer)?;
        let mut trailer = [0u8; 1];
        self.output.read_exact(&mut trailer)?;
        if trailer[0] != b'\n' {
            bail!("Invalid batch blob trailer for {oid}");
        }
        Ok(buffer)
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        self.input.take();
        if record(&mut self.output, b'\n', RECORD_LIMIT)?.is_some() {
            bail!("Unexpected batch output");
        }
        self.process.finish()
    }
}

/// Where one revision's bytes come from: Git's object store, or files on disk whose blob ids
/// were computed before extraction.
trait SourceBytes {
    fn read(&mut self, path: &str, oid: &str, size: Option<u64>) -> Result<Vec<u8>>;
}

impl SourceBytes for BlobReader {
    fn read(&mut self, _path: &str, oid: &str, size: Option<u64>) -> Result<Vec<u8>> {
        BlobReader::read(self, oid, size)
    }
}

/// Reads working-tree files and refuses any whose bytes no longer hash to the blob id the
/// change set recorded, so a file edited mid-analysis cannot be extracted under a stale id.
struct DiskBytes<'a> {
    repo: &'a Path,
}

impl SourceBytes for DiskBytes<'_> {
    fn read(&mut self, path: &str, oid: &str, _size: Option<u64>) -> Result<Vec<u8>> {
        read_worktree_blob(self.repo, path, oid)
    }
}

/// Git's object id for `bytes` stored as a blob (SHA-1 object format).
pub fn blob_oid(bytes: &[u8]) -> String {
    use sha1::Digest as _;
    let mut hasher = sha1::Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// `bytes` with every CRLF pair reduced to LF — the checkin conversion `text=auto`/`autocrlf`
/// applies — or `None` when there is no CRLF to reduce.
pub fn crlf_to_lf(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.windows(2).any(|pair| pair == b"\r\n") {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*byte);
    }
    Some(out)
}

/// The working-tree content of a repository-relative path, as the blob `expected_oid`.
pub fn read_worktree_blob(repo: &Path, path: &str, expected_oid: &str) -> Result<Vec<u8>> {
    let full = path
        .split('/')
        .fold(repo.to_path_buf(), |acc, part| acc.join(part));
    let metadata = std::fs::symlink_metadata(&full)
        .with_context(|| format!("Cannot stat working-tree file {path:?}"))?;
    if !metadata.is_file() {
        bail!("Working-tree path {path:?} is not a regular file");
    }
    if metadata.len() > MAX_JAVA_BLOB_BYTES {
        bail!("Working-tree file {path:?} exceeds the {MAX_JAVA_BLOB_BYTES} byte source limit");
    }
    let bytes = std::fs::read(&full).with_context(|| format!("Cannot read {path:?}"))?;
    if blob_oid(&bytes) == expected_oid {
        return Ok(bytes);
    }
    if let Some(normalized) = crlf_to_lf(&bytes) {
        if blob_oid(&normalized) == expected_oid {
            return Ok(normalized);
        }
    }
    bail!("Working-tree file {path:?} changed while it was being analyzed")
}

/// One revision's provider source, keyed by backend-relative POSIX path.
struct SourceSet {
    sources: Vec<(String, String)>,
    /// The configuration of this revision, gathered the same way `detect_config` gathers it from
    /// the working tree. `configFingerprint` and the configuration blockers are both sealed into
    /// the artifact, so a mode that saw a different set of documents would certify a different
    /// contract from the same commit. Empty for providers without a Java-style config document.
    config: ConfigInputs,
    ledger: Vec<String>,
    /// The lane these sources belong to, detected from the same listing the
    /// sources were read from so base and candidate cannot disagree about it.
    provider: ProviderKind,
    /// A TypeScript server framework detected but not extracted. The artifact
    /// must carry a named blocker rather than fall through to an empty Spring tree.
    unsupported_ts: Option<(String, String)>,
    /// The first Kotlin source in a Java-lane revision. Kotlin is not parsed, and an
    /// artifact that omits its endpoints must say so rather than look complete.
    unparsed_kotlin: Option<String>,
    unparsed_scala: Option<String>,
    unparsed_groovy: Option<String>,
}

/// Detect the provider from the revision's bytes, not only from its file
/// names. Express, Fastify, and JAX-RS have no mandatory path convention, so a
/// listing without content cannot distinguish them from a default Spring tree.
/// Reading a bounded sample here keeps base and candidate on the same lane
/// without consulting the checkout.
fn detect_provider_with_content(
    backend: &BackendScope,
    entries: &[(String, String, Option<u64>)],
    reader: &mut dyn SourceBytes,
) -> Result<(ProviderKind, Option<(String, String)>)> {
    let scoped: Vec<&(String, String, Option<u64>)> = entries
        .iter()
        .filter(|(path, _, _)| backend.within(path).is_some())
        .collect();

    let java: Vec<_> = scoped
        .iter()
        .filter(|(path, _, _)| path.ends_with(".java"))
        .collect();
    if !java.is_empty() {
        let mut jax_rs = false;
        let mut spring = false;
        for (path, oid, size) in java.into_iter().take(128) {
            let bytes = reader.read(path, oid, *size)?;
            let text = String::from_utf8_lossy(&bytes);
            if text.contains("jakarta.ws.rs.")
                || text.contains("javax.ws.rs.")
                || (text.contains("@Path") && text.contains("@GET"))
            {
                jax_rs = true;
            }
            if text.contains("@RestController")
                || text.contains("@Controller")
                || text.contains("org.springframework.")
            {
                spring = true;
            }
        }
        return Ok((
            if jax_rs && !spring {
                ProviderKind::JaxRs
            } else {
                ProviderKind::Spring
            },
            None,
        ));
    }

    if scoped.iter().any(|(path, _, _)| is_nextjs_route_file(path)) {
        return Ok((ProviderKind::NextJs, None));
    }
    if scoped
        .iter()
        .any(|(path, _, _)| crate::file_system_routes::is_file_router_source_file(path))
    {
        return Ok((ProviderKind::FileRouter, None));
    }
    if scoped
        .iter()
        .any(|(path, _, _)| is_controller_ts_path(path))
    {
        return Ok((ProviderKind::NestJs, None));
    }

    for candidate in [
        "package.json",
        "backend/package.json",
        "server/package.json",
        "api/package.json",
    ] {
        let target = backend.join(candidate);
        let Some((path, oid, size)) = entries.iter().find(|(path, _, _)| path == &target) else {
            continue;
        };
        let bytes = reader.read(path, oid, *size)?;
        let text = String::from_utf8_lossy(&bytes);
        if text.contains("\"express\"") || text.contains("\"fastify\"") {
            return Ok((ProviderKind::Express, None));
        }
        if text.contains("\"@nestjs/core\"") {
            return Ok((ProviderKind::NestJs, None));
        }
        if text.contains("\"next\"")
            && scoped.iter().any(|(path, _, _)| {
                let path = path.replace('\\', "/");
                path.starts_with("pages/api/") || path.contains("/pages/api/")
            })
        {
            return Ok((ProviderKind::NextJs, None));
        }
        for needle in [
            "\"express\"",
            "\"fastify\"",
            "\"hono\"",
            "\"koa\"",
            "\"@koa/router\"",
            "\"koa-router\"",
            "\"@hapi/hapi\"",
            "\"hapi\"",
            "\"restify\"",
            "\"polka\"",
            "\"elysia\"",
        ] {
            if text.contains(needle) {
                return Ok((ProviderKind::Express, None));
            }
        }
        for (needle, name) in [
            ("\"h3\"", "H3"),
            ("\"@apollo/server\"", "Apollo Server (GraphQL)"),
            ("\"apollo-server\"", "Apollo Server (GraphQL)"),
            ("\"graphql-yoga\"", "GraphQL Yoga"),
            ("\"@graphql-yoga/node\"", "GraphQL Yoga"),
            ("\"@sveltejs/kit\"", "SvelteKit"),
            ("\"nuxt\"", "Nuxt"),
            ("\"@remix-run/node\"", "Remix"),
            ("\"astro\"", "Astro"),
        ] {
            if text.contains(needle) {
                return Ok((
                    ProviderKind::Spring,
                    Some((name.to_string(), candidate.to_string())),
                ));
            }
        }
    }

    let mut budget = 128usize;
    let mut first_ts = None;
    for (path, oid, size) in scoped {
        if budget == 0 {
            break;
        }
        let Some(scoped_path) = backend.within(path) else {
            continue;
        };
        if !(scoped_path.ends_with(".ts")
            || scoped_path.ends_with(".tsx")
            || scoped_path.ends_with(".js")
            || scoped_path.ends_with(".jsx")
            || scoped_path.ends_with(".mts")
            || scoped_path.ends_with(".cts")
            || scoped_path.ends_with(".mjs")
            || scoped_path.ends_with(".cjs"))
        {
            continue;
        }
        if first_ts.is_none() {
            first_ts = Some(scoped_path.to_string());
        }
        budget -= 1;
        let bytes = reader.read(path, oid, *size)?;
        let text = String::from_utf8_lossy(&bytes);
        if text.contains("@nestjs/common") {
            return Ok((ProviderKind::NestJs, None));
        }
        if text.contains("'express'")
            || text.contains("\"express\"")
            || text.contains("'fastify'")
            || text.contains("\"fastify\"")
        {
            return Ok((ProviderKind::Express, None));
        }
    }

    if let Some(path) = first_ts {
        return Ok((
            ProviderKind::Spring,
            Some((
                "an unrecognized TypeScript/JavaScript server".to_string(),
                path,
            )),
        ));
    }
    Ok((ProviderKind::Spring, None))
}

/// Collect the provider sources and, for Spring/JAX-RS, the configuration of one revision.
///
/// `entries` are `(repository-relative path, oid, optional expected size)`.
/// Sizes are checked against the tree when the caller has them, so a object
/// that changed between listing and reading cannot be silently substituted.
fn collect_sources(
    backend: &BackendScope,
    entries: Vec<(String, String, Option<u64>)>,
    what: &str,
    reader: &mut dyn SourceBytes,
) -> Result<SourceSet> {
    let (provider, unsupported_ts) = detect_provider_with_content(backend, &entries, reader)?;
    let by_path: std::collections::HashMap<&str, (String, Option<u64>)> = entries
        .iter()
        .map(|(path, oid, size)| (path.as_str(), (oid.clone(), *size)))
        .collect();

    // Every candidate that exists, in precedence order; the first governs the fingerprint and the
    // naming strategy, the rest are carried so a shadowed document cannot raise a blocker the
    // runtime never had.
    let mut files = Vec::new();
    let mut profile_files: Vec<String> = Vec::new();
    let mut lombok = None;
    // Configuration documents only feed the Java lanes' fingerprint and naming strategy; a
    // TypeScript revision's fingerprint is derived by its extractor from the sources themselves.
    if matches!(provider, ProviderKind::Spring | ProviderKind::JaxRs) {
        for tail in config_tails() {
            let candidate = backend.join(tail);
            let Some((oid, size)) = by_path.get(candidate.as_str()) else {
                continue;
            };
            let bytes = reader.read(&candidate, oid, *size)?;
            let label = backend.within(&candidate).unwrap_or(candidate);
            files.push((label, String::from_utf8_lossy(&bytes).to_string()));
        }

        // Only the paths are needed — Spring selects one of these at runtime from the active
        // profile, so no static reading of its content could be the right one.
        profile_files = entries
            .iter()
            .map(|(path, _, _)| path.as_str())
            .filter(|path| backend.within(path).is_some())
            .filter(|path| is_profile_config_path(path))
            .map(|path| path.to_string())
            .collect();
        profile_files.sort();

        // Lombok bubbles configuration up from the source directory, so the nearest file governs:
        // the module's own, else the repository root's.
        for candidate in [backend.join("lombok.config"), "lombok.config".to_string()] {
            let Some((oid, size)) = by_path.get(candidate.as_str()) else {
                continue;
            };
            let bytes = reader.read(&candidate, oid, *size)?;
            let label = backend
                .within(&candidate)
                .unwrap_or_else(|| candidate.clone());
            lombok = Some((label, String::from_utf8_lossy(&bytes).to_string()));
            break;
        }
    }

    let mut sources = Vec::new();
    let mut ledger = Vec::new();
    let mut unparsed_kotlin = None;
    let mut unparsed_scala = None;
    let mut unparsed_groovy = None;
    for (path, oid, size) in entries {
        let (scoped, is_sibling) = match backend.within(&path) {
            Some(scoped) => (scoped, false),
            None if matches!(provider, ProviderKind::Spring | ProviderKind::JaxRs)
                && path.ends_with(".java") =>
            {
                (path.clone(), true)
            }
            None => continue,
        };
        if !is_sibling && matches!(provider, ProviderKind::Spring | ProviderKind::JaxRs) {
            if scoped.ends_with(".kt") && unparsed_kotlin.is_none() {
                unparsed_kotlin = Some(scoped.clone());
            }
            if scoped.ends_with(".scala") && unparsed_scala.is_none() {
                unparsed_scala = Some(scoped.clone());
            }
            if scoped.ends_with(".groovy") && unparsed_groovy.is_none() {
                unparsed_groovy = Some(scoped.clone());
            }
        }
        let is_source = match provider {
            ProviderKind::Spring | ProviderKind::JaxRs => scoped.ends_with(".java"),
            ProviderKind::NestJs => is_provider_ts_file(&scoped),
            ProviderKind::NextJs => {
                is_nextjs_route_file(&scoped)
                    || crate::nextjs_routes::is_nextjs_config_file(&scoped)
                    || crate::nextjs_routes::is_nextjs_pages_api_file(&scoped)
            }
            ProviderKind::Express => is_express_source_file(&scoped),
            ProviderKind::FileRouter => {
                crate::file_system_routes::is_file_router_source_file(&scoped)
            }
        };
        if !is_source {
            continue;
        }
        if sources.len() >= MAX_BLOBS {
            bail!("The {what} source set exceeds {MAX_BLOBS} files");
        }
        // The ledger records the exact revision that was analyzed, including
        // files whose bytes are not valid UTF-8 and were therefore skipped.
        ledger.push(format!("{scoped}\0{oid}"));
        let bytes = reader.read(&path, &oid, size)?;
        match String::from_utf8(bytes) {
            Ok(content) => sources.push((scoped, content)),
            // Parity with the working-tree scanner, which skips unreadable
            // files rather than failing the extraction.
            Err(_) => continue,
        }
    }
    Ok(SourceSet {
        sources,
        config: ConfigInputs {
            files,
            profile_files,
            lombok,
        },
        ledger,
        provider,
        unsupported_ts,
        unparsed_kotlin,
        unparsed_scala,
        unparsed_groovy,
    })
}

/// Extract the provider contract from staged index blobs.
///
/// Returns the envelope plus the staged identity token: the index is not a
/// commit, so the snapshot label is the digest of the exact `(path, oid)` set
/// that was analyzed.
pub fn extract_staged(
    repo: &Path,
    backend: &BackendScope,
    service_id: &str,
    head: &str,
) -> Result<(ContractArtifactEnvelope, String)> {
    let index = index_entries(repo)?
        .into_iter()
        .map(|(path, oid)| (path, oid, None))
        .collect();
    let mut set = collect_from_git(repo, backend, index, "staged")?;
    let token = staged_identity_token(&mut set.ledger);
    let envelope = build(
        backend,
        set.provider,
        set.unsupported_ts,
        set.unparsed_kotlin,
        set.unparsed_scala,
        set.unparsed_groovy,
        set.sources,
        set.config,
        service_id,
        head,
        &format!("staged:{token}"),
    )?;
    Ok((envelope, token))
}

/// Extract the provider contract from a committed tree.
pub fn extract_tree(
    repo: &Path,
    backend: &BackendScope,
    service_id: &str,
    commit: &str,
    parent_commit: &str,
) -> Result<ContractArtifactEnvelope> {
    let tree = tree_entries(repo, commit)?
        .into_iter()
        .map(|item| (item.path, item.oid, Some(item.bytes)))
        .collect();
    let set = collect_from_git(repo, backend, tree, "tree")?;
    build(
        backend,
        set.provider,
        set.unsupported_ts,
        set.unparsed_kotlin,
        set.unparsed_scala,
        set.unparsed_groovy,
        set.sources,
        set.config,
        service_id,
        parent_commit,
        commit,
    )
}

fn collect_from_git(
    repo: &Path,
    backend: &BackendScope,
    entries: Vec<(String, String, Option<u64>)>,
    what: &str,
) -> Result<SourceSet> {
    let mut reader = BlobReader::start(repo)?;
    let set = collect_sources(backend, entries, what, &mut reader)?;
    reader.finish()?;
    Ok(set)
}

/// Where the bytes of an explicit revision listing live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingSource {
    /// Blob ids name objects in the repository's object database.
    GitObjects,
    /// Blob ids were computed from the working tree, which is re-read and re-verified.
    WorkingTree,
}

/// Extract the provider contract from an explicit `(path, oid, size)` listing, so a caller that
/// already classified a change set extracts exactly the files it classified.
pub fn extract_listing(
    repo: &Path,
    backend: &BackendScope,
    service_id: &str,
    entries: Vec<(String, String, Option<u64>)>,
    source: ListingSource,
    parent_commit: &str,
    candidate_snapshot: &str,
) -> Result<ContractArtifactEnvelope> {
    let set = match source {
        ListingSource::GitObjects => collect_from_git(repo, backend, entries, "revision")?,
        ListingSource::WorkingTree => {
            collect_sources(backend, entries, "working-tree", &mut DiskBytes { repo })?
        }
    };
    build(
        backend,
        set.provider,
        set.unsupported_ts,
        set.unparsed_kotlin,
        set.unparsed_scala,
        set.unparsed_groovy,
        set.sources,
        set.config,
        service_id,
        parent_commit,
        candidate_snapshot,
    )
}

fn unsupported_ts_envelope(
    service_id: &str,
    parent_commit: &str,
    candidate_snapshot: &str,
    framework: &str,
    file_path: &str,
) -> Result<ContractArtifactEnvelope> {
    let blocker = ArtifactBlocker {
        code: "TS_MAPPING_FRAMEWORK_UNPARSED".to_string(),
        message: format!(
            "Repository declares {framework} backend routes (detected in {file_path}). This framework is not extracted into route contracts; emptiness is not evidence of absence."
        ),
        file: Some(file_path.to_string()),
    };
    let mut envelope = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: NATIVE_REPOSITORY_ID.to_string(),
            service_id: service_id.to_string(),
            api_version: None,
            parent_commit: parent_commit.to_string(),
            candidate_snapshot: candidate_snapshot.to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
            framework_profile: Some(framework.to_ascii_uppercase().replace('.', "")),
            codec_profile: Some("JSON_STRINGIFY_V1".to_string()),
            client_profile: None,
            config_fingerprint: None,
        },
        completeness: ArtifactCompleteness {
            complete: false,
            unresolved_endpoints: Vec::new(),
            blockers: vec![blocker],
        },
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            base_urls: Vec::new(),
            proxy_prefixes: Vec::new(),
            endpoints: Vec::new(),
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    };
    let digest = compute_envelope_digest(&envelope)?;
    envelope.integrity = Some(ArtifactIntegrity { sha256: digest });
    Ok(envelope)
}

fn build(
    backend: &BackendScope,
    provider: ProviderKind,
    unsupported_ts: Option<(String, String)>,
    unparsed_kotlin: Option<String>,
    unparsed_scala: Option<String>,
    unparsed_groovy: Option<String>,
    sources: Vec<(String, String)>,
    config: ConfigInputs,
    service_id: &str,
    parent_commit: &str,
    candidate_snapshot: &str,
) -> Result<ContractArtifactEnvelope> {
    if let Some((framework, file)) = unsupported_ts {
        return unsupported_ts_envelope(
            service_id,
            parent_commit,
            candidate_snapshot,
            &framework,
            &file,
        );
    }
    // `sajimora init` seals provenance and config labels relative to the
    // repository root, so a revision extraction must use the same path space or
    // the two artifacts describe one commit with two sets of paths.
    let sources: Vec<(String, String)> = sources
        .into_iter()
        .map(|(path, content)| {
            let final_path = if backend.prefix.is_empty() {
                path
            } else if path.starts_with(&format!("{}/", backend.prefix)) {
                path
            } else if path.starts_with("src/") || !path.contains('/') {
                backend.join(&path)
            } else {
                path
            };
            (final_path, content)
        })
        .collect();
    match provider {
        ProviderKind::NestJs => {
            let extractor = NestJsRouteExtractor::from_blobs(backend.repo_root.clone(), sources)?;
            extractor.build_envelope_bound(
                service_id,
                None,
                NATIVE_REPOSITORY_ID,
                parent_commit,
                candidate_snapshot,
            )
        }
        ProviderKind::NextJs => {
            let extractor = NextJsRouteExtractor::from_blobs(backend.repo_root.clone(), sources)?;
            extractor.build_envelope_bound(
                service_id,
                None,
                NATIVE_REPOSITORY_ID,
                parent_commit,
                candidate_snapshot,
            )
        }
        ProviderKind::Express => {
            let extractor = ExpressRouteExtractor::from_blobs(backend.repo_root.clone(), sources)?;
            extractor.build_envelope_bound(
                service_id,
                None,
                NATIVE_REPOSITORY_ID,
                parent_commit,
                candidate_snapshot,
            )
        }
        ProviderKind::FileRouter => {
            let extractor = crate::file_system_routes::FileSystemRouteExtractor::from_blobs(
                backend.repo_root.clone(),
                sources,
            )?;
            extractor.build_envelope_bound(
                service_id,
                None,
                NATIVE_REPOSITORY_ID,
                parent_commit,
                candidate_snapshot,
            )
        }
        ProviderKind::Spring | ProviderKind::JaxRs => {
            let config = ConfigInputs {
                files: config
                    .files
                    .into_iter()
                    .map(|(label, content)| (backend.join(&label), content))
                    .collect(),
                profile_files: config.profile_files,
                lombok: config
                    .lombok
                    .map(|(label, content)| (backend.join(&label), content)),
            };
            let mut extractor =
                JavaRouteExtractor::from_blobs(backend.repo_root.clone(), sources, config)?
                    .with_jax_rs(provider == ProviderKind::JaxRs);
            if let Some(kotlin) = unparsed_kotlin {
                extractor.note_unparsed_kotlin(&backend.join(&kotlin));
            }
            if let Some(scala) = unparsed_scala {
                extractor.note_unparsed_source("Scala", &backend.join(&scala));
            }
            if let Some(groovy) = unparsed_groovy {
                extractor.note_unparsed_source("Groovy", &backend.join(&groovy));
            }
            extractor.build_envelope_bound(
                service_id,
                None,
                NATIVE_REPOSITORY_ID,
                parent_commit,
                candidate_snapshot,
            )
        }
    }
}

/// Extract from the checked-out module. The extractor is rooted at the
/// repository, not the module, so provenance matches the paths `sajimora init`
/// seals. The snapshot identity keeps the literal `HEAD` placeholders that
/// `sajimora verify` writes, so a working-tree candidate stays byte-comparable
/// with the sealed baseline.
pub fn extract_working_tree(
    repo_root: &Path,
    backend: &BackendScope,
    service_id: &str,
) -> Result<ContractArtifactEnvelope> {
    let provider = ProviderKind::detect_on_disk(&backend.disk_root);
    if matches!(provider, ProviderKind::Spring | ProviderKind::JaxRs)
        && !crate::provider::has_java_source(&backend.disk_root)
    {
        if let Some((framework, file)) =
            crate::provider::detect_unsupported_ts_framework(&backend.disk_root)
        {
            return unsupported_ts_envelope(service_id, "HEAD", "HEAD", &framework, &file);
        }
    }
    match provider {
        ProviderKind::NestJs => {
            let extractor = NestJsRouteExtractor::new(repo_root.to_path_buf(), &backend.disk_root)
                .map_err(|e| anyhow::anyhow!("Failed to parse NestJS routes: {}", e))?;
            extractor.build_envelope_bound(service_id, None, NATIVE_REPOSITORY_ID, "HEAD", "HEAD")
        }
        ProviderKind::NextJs => {
            let extractor = NextJsRouteExtractor::new(repo_root.to_path_buf(), &backend.disk_root)
                .map_err(|e| anyhow::anyhow!("Failed to parse Next.js routes: {}", e))?;
            extractor.build_envelope_bound(service_id, None, NATIVE_REPOSITORY_ID, "HEAD", "HEAD")
        }
        ProviderKind::Express => {
            let extractor = ExpressRouteExtractor::new(repo_root.to_path_buf(), &backend.disk_root)
                .map_err(|e| anyhow::anyhow!("Failed to parse Express routes: {}", e))?;
            extractor.build_envelope_bound(service_id, None, NATIVE_REPOSITORY_ID, "HEAD", "HEAD")
        }
        ProviderKind::FileRouter => {
            let extractor = crate::file_system_routes::FileSystemRouteExtractor::new(
                repo_root.to_path_buf(),
                &backend.disk_root,
            )
            .map_err(|e| anyhow::anyhow!("Failed to parse file-system routes: {}", e))?;
            extractor.build_envelope_bound(service_id, None, NATIVE_REPOSITORY_ID, "HEAD", "HEAD")
        }
        ProviderKind::Spring | ProviderKind::JaxRs => {
            let java_dir = {
                let default_src = backend.disk_root.join("src/main/java");
                if default_src.exists() {
                    default_src
                } else {
                    backend.disk_root.clone()
                }
            };
            let extractor = JavaRouteExtractor::new(repo_root.to_path_buf(), &java_dir)
                .map_err(|e| anyhow::anyhow!("Failed to parse Java routes: {}", e))?
                .with_jax_rs(provider == ProviderKind::JaxRs);
            extractor.build_envelope_bound(service_id, None, NATIVE_REPOSITORY_ID, "HEAD", "HEAD")
        }
    }
}

fn staged_identity_token(ledger: &mut [String]) -> String {
    ledger.sort();
    let mut hasher = Sha256::new();
    for row in ledger.iter() {
        hasher.update(row.as_bytes());
        hasher.update(*b"\n");
    }
    hex::encode(hasher.finalize())[..16].to_string()
}
