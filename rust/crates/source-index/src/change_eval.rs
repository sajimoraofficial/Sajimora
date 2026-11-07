//! change_eval.rs — native Expected Change Model (ECM) evaluation.
//!
//! An ECM declares which files and symbols a change intends to mutate, and
//! optionally which repository paths are out of bounds. This module validates
//! that declaration, lists both Git trees, reconstructs the actual mutation set
//! (pairing only exact-blob renames), reads structural Java symbol evidence from
//! the blobs themselves, and classifies every observed mutation and every
//! declaration as intended, unintended, unobserved, or unverifiable.
//!
//! Nothing here enforces policy, selects tests, or infers intent beyond the
//! declaration. Java symbol identity is structural: `Type` or `Type#member`,
//! with nested types dot-qualified inside member keys. Files outside Java have
//! file-level evidence only; symbol expectations on them are reported as
//! unverifiable rather than guessed.

use crate::endpoint_impact::resolve_repo_root;
use crate::java::{self, Fact};
use crate::revision::{self, BlobReader, MAX_JAVA_BLOB_BYTES};
use anyhow::{bail, Context, Result};
use contract_core::service::{normalize_path, read_bounded, validate_path_under_roots};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const SCHEMA_VERSION: &str = "SAJIMORA_CHANGE_EVALUATION_V1";
pub const DEFAULT_OUTPUT: &str = ".sajimora/change-evaluation.json";
const RESERVED_OUTPUT_FILES: [&str; 3] = [
    "impact-report.json",
    "endpoint-impact.json",
    "init-manifest.json",
];
pub const MAX_ECM_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FILE_EXPECTATIONS: usize = 10_000;
pub const MAX_SYMBOL_EXPECTATIONS: usize = 20_000;
pub const MAX_SYMBOL_FILES: usize = 512;
pub const MAX_TOTAL_SYMBOL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FACTS_PER_FILE: usize = 100_000;
const MAX_REASON_CHARS: usize = 400;

const NOTICE: &str = "Advisory evidence only: this report compares an Expected Change Model with the structural Git change set between two revisions. It does not inspect runtime behaviour, does not select tests, and does not enforce policy. Java symbol evidence is structural (declaration names and signatures); other languages are evaluated at file level only.";

// ---------------------------------------------------------------------------
// ECM document (input)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExpectedFileChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExpectedSymbolChangeType {
    Added,
    Removed,
    Renamed,
    SignatureChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedFileChange {
    pub file_path: String,
    pub change_type: ExpectedFileChangeType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedSymbolChange {
    pub file_path: String,
    pub symbol_name: String,
    pub change_type: ExpectedSymbolChangeType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_symbol_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeBoundary {
    #[serde(default)]
    pub forbidden_paths: Vec<String>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
}

/// The portable ECM document. Revisions may be supplied by the file or by the
/// caller (`base`/`candidate` overrides); the TS names `baseCommitSha` and
/// `candidateCommitSha` are accepted as aliases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EcmDocument {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecm_version: Option<u32>,
    #[serde(
        default,
        alias = "baseCommitSha",
        skip_serializing_if = "Option::is_none"
    )]
    pub base: Option<String>,
    #[serde(
        default,
        alias = "candidateCommitSha",
        skip_serializing_if = "Option::is_none"
    )]
    pub candidate: Option<String>,
    #[serde(default)]
    pub expected_files: Vec<ExpectedFileChange>,
    #[serde(default)]
    pub expected_symbols: Vec<ExpectedSymbolChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_boundary: Option<ChangeBoundary>,
}

struct ResolvedEcm {
    base: String,
    candidate: String,
    expected_files: Vec<ExpectedFileChange>,
    expected_symbols: Vec<ExpectedSymbolChange>,
    boundary: Option<ChangeBoundary>,
}

fn validate_repo_path(path: &str, what: &str) -> Result<()> {
    if path.is_empty() {
        bail!("{what} must not be empty");
    }
    if path.starts_with('/') {
        bail!("{what} {path:?} must be repository-relative, not absolute");
    }
    if path.contains('\\') {
        bail!("{what} {path:?} must use POSIX '/' separators");
    }
    if path.contains(':') || path.contains('\0') {
        bail!("{what} {path:?} must not contain ':' or NUL");
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("{what} {path:?} contains an empty, '.' or '..' segment");
    }
    Ok(())
}

fn validate_symbol_name(name: &str, what: &str) -> Result<()> {
    if name.is_empty() {
        bail!("{what} must not be empty");
    }
    if name.chars().any(char::is_whitespace) {
        bail!("{what} {name:?} must not contain whitespace");
    }
    if name.contains('.') || name.contains('/') || name.contains('\\') || name.contains(':') {
        bail!("{what} {name:?} must use 'Type' or 'Type#member' form");
    }
    let parts: Vec<&str> = name.split('#').collect();
    if parts.len() > 2 || parts.iter().any(|part| part.is_empty()) {
        bail!("{what} {name:?} must use 'Type' or 'Type#member' form with at most one '#'");
    }
    Ok(())
}

fn validate_optional_metadata(
    provenance: Option<&String>,
    confidence: Option<f64>,
    what: &str,
) -> Result<()> {
    if provenance.is_some_and(|text| text.trim().is_empty()) {
        bail!("{what} provenance must not be empty when present");
    }
    if let Some(value) = confidence {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            bail!("{what} confidence must be a finite number between 0.0 and 1.0");
        }
    }
    Ok(())
}

/// Exact path-segment prefix: `src/gen` matches `src/gen` and `src/gen/A.java`,
/// but never `src/generated`.
fn under_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn validate_ecm(
    doc: &EcmDocument,
    base_override: Option<&str>,
    candidate_override: Option<&str>,
) -> Result<ResolvedEcm> {
    if let Some(version) = doc.ecm_version {
        if version != 1 {
            bail!("Unsupported ecmVersion {version}; expected 1");
        }
    }

    let pick_revision = |name: &str, override_value: Option<&str>, declared: Option<&String>| {
        let text = override_value
            .map(str::to_string)
            .or_else(|| declared.cloned())
            .with_context(|| {
                format!("ECM does not declare {name} and no --{name} override was supplied")
            })?;
        if text.is_empty() || text.trim() != text {
            bail!("ECM {name} revision must be non-empty without surrounding whitespace");
        }
        Ok(text)
    };
    let base = pick_revision("base", base_override, doc.base.as_ref())?;
    let candidate = pick_revision("candidate", candidate_override, doc.candidate.as_ref())?;

    if doc.expected_files.len() > MAX_FILE_EXPECTATIONS {
        bail!(
            "ECM declares {} file expectations; the limit is {MAX_FILE_EXPECTATIONS}",
            doc.expected_files.len()
        );
    }
    if doc.expected_symbols.len() > MAX_SYMBOL_EXPECTATIONS {
        bail!(
            "ECM declares {} symbol expectations; the limit is {MAX_SYMBOL_EXPECTATIONS}",
            doc.expected_symbols.len()
        );
    }

    let boundary = doc.change_boundary.clone();
    if let Some(boundary) = &boundary {
        if boundary.reason.trim().is_empty() {
            bail!("changeBoundary.reason must not be empty");
        }
        let mut seen = BTreeSet::new();
        for prefix in &boundary.forbidden_paths {
            validate_repo_path(prefix, "forbidden path prefix")?;
            if prefix
                .chars()
                .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '!'))
            {
                bail!(
                    "forbidden path prefix {prefix:?} must not contain glob metacharacters; \
                     matching is an exact path-segment prefix"
                );
            }
            if !seen.insert(prefix.as_str()) {
                bail!("changeBoundary lists forbidden prefix {prefix:?} more than once");
            }
        }
    }

    let mut claimed_paths: BTreeSet<&str> = BTreeSet::new();
    for expected in &doc.expected_files {
        validate_repo_path(&expected.file_path, "expectedFiles[].filePath")?;
        validate_optional_metadata(
            expected.provenance.as_ref(),
            expected.confidence,
            "expectedFiles[]",
        )?;
        let mut paths = vec![expected.file_path.as_str()];
        match expected.change_type {
            ExpectedFileChangeType::Renamed => {
                let old_path = expected.old_file_path.as_deref().with_context(|| {
                    format!(
                        "expectedFiles[] RENAMED entry for {:?} requires oldFilePath",
                        expected.file_path
                    )
                })?;
                validate_repo_path(old_path, "expectedFiles[].oldFilePath")?;
                if old_path == expected.file_path {
                    bail!(
                        "expectedFiles[] RENAMED entry for {:?} has identical filePath and oldFilePath",
                        expected.file_path
                    );
                }
                paths.push(old_path);
            }
            _ => {
                if expected.old_file_path.is_some() {
                    bail!(
                        "expectedFiles[] {:?} sets oldFilePath but changeType is not RENAMED",
                        expected.file_path
                    );
                }
            }
        }
        for path in paths {
            if !claimed_paths.insert(path) {
                bail!("ECM claims path {path:?} in more than one file expectation");
            }
        }
    }

    let mut claimed_symbols: BTreeSet<(&str, &str)> = BTreeSet::new();
    for expected in &doc.expected_symbols {
        validate_repo_path(&expected.file_path, "expectedSymbols[].filePath")?;
        validate_symbol_name(&expected.symbol_name, "expectedSymbols[].symbolName")?;
        validate_optional_metadata(
            expected.provenance.as_ref(),
            expected.confidence,
            "expectedSymbols[]",
        )?;
        match expected.change_type {
            ExpectedSymbolChangeType::Renamed => {
                let old_name = expected.old_symbol_name.as_deref().with_context(|| {
                    format!(
                        "expectedSymbols[] RENAMED entry for {:?} requires oldSymbolName",
                        expected.symbol_name
                    )
                })?;
                validate_symbol_name(old_name, "expectedSymbols[].oldSymbolName")?;
                if old_name == expected.symbol_name {
                    bail!(
                        "expectedSymbols[] RENAMED entry for {:?} has identical symbolName and oldSymbolName",
                        expected.symbol_name
                    );
                }
            }
            _ => {
                if expected.old_symbol_name.is_some() {
                    bail!(
                        "expectedSymbols[] {:?} sets oldSymbolName but changeType is not RENAMED",
                        expected.symbol_name
                    );
                }
            }
        }
        if !claimed_symbols.insert((&expected.file_path, &expected.symbol_name)) {
            bail!(
                "ECM declares the symbol {:?} in {:?} more than once",
                expected.symbol_name,
                expected.file_path
            );
        }
    }

    if let Some(boundary) = &boundary {
        let mut declared_paths: Vec<(&str, &str)> = Vec::new();
        for expected in &doc.expected_files {
            declared_paths.push((&expected.file_path, "expectedFiles[].filePath"));
            if let Some(old_path) = &expected.old_file_path {
                declared_paths.push((old_path, "expectedFiles[].oldFilePath"));
            }
        }
        for expected in &doc.expected_symbols {
            declared_paths.push((&expected.file_path, "expectedSymbols[].filePath"));
        }
        for (path, what) in declared_paths {
            if let Some(prefix) = boundary
                .forbidden_paths
                .iter()
                .find(|prefix| under_prefix(path, prefix))
            {
                bail!(
                    "ECM declares {what} {path:?} inside its own forbidden boundary {prefix:?}; \
                     the declaration contradicts itself"
                );
            }
        }
    }

    Ok(ResolvedEcm {
        base,
        candidate,
        expected_files: doc.expected_files.clone(),
        expected_symbols: doc.expected_symbols.clone(),
        boundary,
    })
}

// ---------------------------------------------------------------------------
// Report (output)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ItemVerdict {
    IntendedMutation,
    UnintendedRegression,
    UnobservedExpectation,
    Unverifiable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChangeVerdict {
    NoChanges,
    IntendedChange,
    UnintendedRegression,
    IncompleteEvidence,
    DeclaredChangeNotObserved,
}

impl ChangeVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeVerdict::NoChanges => "NO_CHANGES",
            ChangeVerdict::IntendedChange => "INTENDED_CHANGE",
            ChangeVerdict::UnintendedRegression => "UNINTENDED_REGRESSION",
            ChangeVerdict::IncompleteEvidence => "INCOMPLETE_EVIDENCE",
            ChangeVerdict::DeclaredChangeNotObserved => "DECLARED_CHANGE_NOT_OBSERVED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExpectationKind {
    File,
    Symbol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RevisionSource {
    Ecm,
    Override,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActualChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ActualChangeType {
    fn as_str(self) -> &'static str {
        match self {
            ActualChangeType::Added => "ADDED",
            ActualChangeType::Modified => "MODIFIED",
            ActualChangeType::Deleted => "DELETED",
            ActualChangeType::Renamed => "RENAMED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SymbolEvidenceStatus {
    Complete,
    UnchangedContent,
    ParseError,
    Unavailable,
    SkippedLimit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationReport {
    pub schema_version: &'static str,
    pub ecm: EcmSummary,
    pub summary: EvaluationSummary,
    pub verdict: ChangeVerdict,
    pub verdict_reason: String,
    pub expectations: Vec<ExpectationEvaluation>,
    pub actual_mutations: Vec<ActualMutation>,
    pub completeness: Completeness,
    pub notice: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcmSummary {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecm_version: Option<u32>,
    pub base: RevisionSummary,
    pub candidate: RevisionSummary,
    pub declared_files: u64,
    pub declared_symbols: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundarySummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub requested: String,
    pub resolved: String,
    pub source: RevisionSource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundarySummary {
    pub forbidden_paths: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationSummary {
    pub declared_file_expectations: u64,
    pub declared_symbol_expectations: u64,
    pub observed_file_mutations: u64,
    pub intended_file_mutations: u64,
    pub unintended_file_mutations: u64,
    pub boundary_violations: u64,
    pub expectations_intended: u64,
    pub expectations_unobserved: u64,
    pub expectations_unverifiable: u64,
    pub observed_symbol_mutations: u64,
    pub symbol_evidence_incomplete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectationEvaluation {
    pub kind: ExpectationKind,
    pub declared: DeclaredExpectation,
    pub verdict: ItemVerdict,
    pub reason_code: &'static str,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<MatchedMutation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_change_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_preserved: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredExpectation {
    pub kind: ExpectationKind,
    pub file_path: String,
    pub change_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_symbol_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedMutation {
    pub file_path: String,
    pub change_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_symbol_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_preserved: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActualMutation {
    pub file_path: String,
    pub change_type: ActualChangeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file_path: Option<String>,
    pub verdict: ItemVerdict,
    pub reason_code: &'static str,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_expectation_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundaryHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_change: Option<ModeChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbols: Option<SymbolEvidenceOut>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryHit {
    pub prefix: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChange {
    pub base: String,
    pub candidate: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolEvidenceOut {
    pub status: SymbolEvidenceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub signature_changed: Vec<SignatureChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureChange {
    pub symbol: String,
    pub old_signature: String,
    pub new_signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub symbol_evidence: SymbolCompleteness,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCompleteness {
    pub complete: bool,
    pub changed_java_files: u64,
    pub evaluated_java_files: u64,
    pub reasons: Vec<ReasonCode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCode {
    pub code: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// Actual change set
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct BlobMeta {
    oid: String,
    mode: String,
    bytes: u64,
}

#[derive(Debug)]
struct ActualChange {
    file_path: String,
    change_type: ActualChangeType,
    old_file_path: Option<String>,
    base: Option<BlobMeta>,
    candidate: Option<BlobMeta>,
    mode_changed: bool,
}

fn tree_map(repo: &Path, commit: &str) -> Result<BTreeMap<String, BlobMeta>> {
    let mut map = BTreeMap::new();
    for entry in revision::tree_entries(repo, commit)? {
        if entry.kind != "blob" {
            continue;
        }
        map.insert(
            entry.path,
            BlobMeta {
                oid: entry.oid,
                mode: entry.mode,
                bytes: entry.bytes,
            },
        );
    }
    Ok(map)
}

fn is_regular_mode(mode: &str) -> bool {
    matches!(mode, "100644" | "100755")
}

fn actual_changes(
    base: &BTreeMap<String, BlobMeta>,
    candidate: &BTreeMap<String, BlobMeta>,
) -> Vec<ActualChange> {
    let mut changes = Vec::new();
    let mut deleted_by_oid: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut added_by_oid: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (path, meta) in base {
        match candidate.get(path) {
            Some(cand) if cand.oid == meta.oid && cand.mode == meta.mode => {}
            Some(cand) => changes.push(ActualChange {
                file_path: path.clone(),
                change_type: ActualChangeType::Modified,
                old_file_path: None,
                base: Some(meta.clone()),
                candidate: Some(cand.clone()),
                mode_changed: cand.mode != meta.mode,
            }),
            None => deleted_by_oid
                .entry(meta.oid.clone())
                .or_default()
                .push(path.clone()),
        }
    }
    for (path, meta) in candidate {
        if !base.contains_key(path) {
            added_by_oid
                .entry(meta.oid.clone())
                .or_default()
                .push(path.clone());
        }
    }

    // Pair a deletion and an addition only when the blob id is unique on both
    // sides. Several paths sharing one blob id are ambiguous and stay separate.
    let mut paired_deleted: BTreeSet<String> = BTreeSet::new();
    let mut paired_added: BTreeSet<String> = BTreeSet::new();
    for (oid, deletions) in &deleted_by_oid {
        let Some(additions) = added_by_oid.get(oid) else {
            continue;
        };
        if deletions.len() != 1 || additions.len() != 1 {
            continue;
        }
        let old_path = &deletions[0];
        let new_path = &additions[0];
        changes.push(ActualChange {
            file_path: new_path.clone(),
            change_type: ActualChangeType::Renamed,
            old_file_path: Some(old_path.clone()),
            base: base.get(old_path).cloned(),
            candidate: candidate.get(new_path).cloned(),
            mode_changed: base.get(old_path).map(|meta| &meta.mode)
                != candidate.get(new_path).map(|meta| &meta.mode),
        });
        paired_deleted.insert(old_path.clone());
        paired_added.insert(new_path.clone());
    }
    for paths in deleted_by_oid.values() {
        for path in paths {
            if paired_deleted.contains(path) {
                continue;
            }
            changes.push(ActualChange {
                file_path: path.clone(),
                change_type: ActualChangeType::Deleted,
                old_file_path: None,
                base: base.get(path).cloned(),
                candidate: None,
                mode_changed: false,
            });
        }
    }
    for paths in added_by_oid.values() {
        for path in paths {
            if paired_added.contains(path) {
                continue;
            }
            changes.push(ActualChange {
                file_path: path.clone(),
                change_type: ActualChangeType::Added,
                old_file_path: None,
                base: None,
                candidate: candidate.get(path).cloned(),
                mode_changed: false,
            });
        }
    }

    changes.sort_by(|left, right| {
        left.file_path
            .cmp(&right.file_path)
            .then_with(|| left.old_file_path.cmp(&right.old_file_path))
    });
    changes
}

// ---------------------------------------------------------------------------
// Java symbol evidence
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
struct SymbolSnapshot {
    symbols: BTreeMap<String, Vec<String>>,
}

impl SymbolSnapshot {
    fn signature(&self, key: &str) -> Option<&Vec<String>> {
        self.symbols.get(key)
    }

    fn insert(&mut self, key: String, signature: String) {
        self.symbols.entry(key).or_default().push(signature);
    }

    fn finish(mut self) -> Self {
        for signatures in self.symbols.values_mut() {
            signatures.sort();
        }
        self
    }
}

#[derive(Debug, Default)]
struct SymbolDelta {
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<SignatureChange>,
}

#[derive(Debug)]
struct SymbolEvidenceInternal {
    status: SymbolEvidenceStatus,
    reason: Option<String>,
    delta: SymbolDelta,
    base: SymbolSnapshot,
    candidate: SymbolSnapshot,
    snapshots_available: bool,
}

impl SymbolEvidenceInternal {
    fn with_status(status: SymbolEvidenceStatus, reason: String) -> Self {
        Self {
            status,
            reason: Some(reason),
            delta: SymbolDelta::default(),
            base: SymbolSnapshot::default(),
            candidate: SymbolSnapshot::default(),
            snapshots_available: false,
        }
    }

    fn unavailable(reason: String) -> Self {
        Self::with_status(SymbolEvidenceStatus::Unavailable, reason)
    }

    fn skipped(reason: String) -> Self {
        Self::with_status(SymbolEvidenceStatus::SkippedLimit, reason)
    }
}

#[derive(Debug)]
enum SnapshotFailure {
    ParseError,
    Unavailable(String),
}

fn sanitize(text: &str) -> String {
    let single_line: String = text
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    let trimmed = single_line.trim();
    let clipped: String = trimmed.chars().take(MAX_REASON_CHARS).collect();
    if clipped.len() < trimmed.len() {
        format!("{clipped}...")
    } else {
        clipped
    }
}

fn snapshot_from_source(bytes: &[u8]) -> std::result::Result<SymbolSnapshot, SnapshotFailure> {
    let mut facts: Vec<Fact> = Vec::new();
    let outcome = java::extract(bytes, |fact| {
        if facts.len() >= MAX_FACTS_PER_FILE {
            bail!("FACT_LIMIT: more than {MAX_FACTS_PER_FILE} structural facts");
        }
        facts.push(fact);
        Ok(())
    });
    match outcome {
        Ok((_, true)) => Err(SnapshotFailure::ParseError),
        Ok((_, false)) => Ok(snapshot_from_facts(&facts)),
        Err(error) => Err(SnapshotFailure::Unavailable(sanitize(&format!(
            "{error:#}"
        )))),
    }
}

fn diff_snapshots(base: &SymbolSnapshot, candidate: &SymbolSnapshot) -> SymbolDelta {
    let keys: BTreeSet<String> = base
        .symbols
        .keys()
        .chain(candidate.symbols.keys())
        .cloned()
        .collect();
    let mut delta = SymbolDelta::default();
    for key in keys {
        match (base.symbols.get(&key), candidate.symbols.get(&key)) {
            (None, Some(_)) => delta.added.push(key),
            (Some(_), None) => delta.removed.push(key),
            (Some(old), Some(new)) if old != new => delta.changed.push(SignatureChange {
                symbol: key,
                old_signature: old.join(" | "),
                new_signature: new.join(" | "),
            }),
            _ => {}
        }
    }
    delta
}

fn nearest_class_chain(
    mut ordinal: Option<i64>,
    parent_of: &HashMap<i64, Option<i64>>,
    chains: &HashMap<i64, String>,
) -> Option<String> {
    while let Some(current) = ordinal {
        if let Some(chain) = chains.get(&current) {
            return Some(chain.clone());
        }
        ordinal = parent_of.get(&current).copied().flatten();
    }
    None
}

fn metadata_text(fact: &Fact, key: &str) -> Option<String> {
    fact.metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn raw_field(fact: &Fact, key: &str) -> String {
    metadata_text(fact, key)
        .map(|text| format!(" {text}"))
        .unwrap_or_default()
}

fn labelled_field(fact: &Fact, key: &str, keyword: &str) -> String {
    match metadata_text(fact, key) {
        Some(text) if text.starts_with(keyword) => format!(" {text}"),
        Some(text) => format!(" {keyword} {text}"),
        None => String::new(),
    }
}

fn type_signature(fact: &Fact) -> String {
    let kind = fact
        .metadata
        .get("syntax_kind")
        .and_then(Value::as_str)
        .unwrap_or("class_declaration");
    let keyword = match kind {
        "interface_declaration" => "interface",
        "enum_declaration" => "enum",
        "record_declaration" => "record",
        "annotation_type_declaration" => "@interface",
        _ => "class",
    };
    format!(
        "type {keyword}{}{}{}{}",
        raw_field(fact, "type_parameters"),
        labelled_field(fact, "superclass", "extends"),
        labelled_field(fact, "interfaces", "implements"),
        labelled_field(fact, "permits", "permits"),
    )
}

fn parameter_signature(fact: &Fact) -> String {
    let spread =
        fact.metadata.get("syntax_kind").and_then(Value::as_str) == Some("spread_parameter");
    let type_name = metadata_text(fact, "type").unwrap_or_else(|| "?".to_string());
    let dimensions = metadata_text(fact, "dimensions").unwrap_or_default();
    if spread {
        format!("...{type_name}{dimensions}")
    } else {
        format!("{type_name}{dimensions}")
    }
}

fn field_signature(fact: &Fact) -> String {
    let type_name = metadata_text(fact, "type").unwrap_or_else(|| "?".to_string());
    let dimensions = metadata_text(fact, "dimensions").unwrap_or_default();
    format!("field {type_name}{dimensions}")
}

fn method_signature(fact: &Fact, parameters: Option<&Vec<String>>) -> String {
    let return_type = metadata_text(fact, "type").unwrap_or_else(|| "void".to_string());
    let parameters = parameters.map(|items| items.join(",")).unwrap_or_default();
    format!("method {return_type}({parameters})")
}

fn constructor_signature(parameters: Option<&Vec<String>>) -> String {
    let parameters = parameters.map(|items| items.join(",")).unwrap_or_default();
    format!("ctor({parameters})")
}

fn snapshot_from_facts(facts: &[Fact]) -> SymbolSnapshot {
    let mut parent_of: HashMap<i64, Option<i64>> = HashMap::new();
    let mut parameters: HashMap<i64, Vec<String>> = HashMap::new();
    for fact in facts {
        parent_of.insert(fact.ordinal, fact.parent_ordinal);
        if fact.kind == "PARAMETER" {
            if let Some(owner) = fact.parent_ordinal {
                parameters
                    .entry(owner)
                    .or_default()
                    .push(parameter_signature(fact));
            }
        }
    }

    // Nested classes are dot-qualified inside member keys. Facts arrive
    // pre-order, so a class chain is always built after its enclosing class.
    let mut chains: HashMap<i64, String> = HashMap::new();
    let mut snapshot = SymbolSnapshot::default();
    for fact in facts {
        if fact.kind != "CLASS" {
            continue;
        }
        let chain = match nearest_class_chain(fact.parent_ordinal, &parent_of, &chains) {
            Some(prefix) => format!("{prefix}.{}", fact.name),
            None => fact.name.clone(),
        };
        chains.insert(fact.ordinal, chain);
        snapshot.insert(fact.name.clone(), type_signature(fact));
    }

    for fact in facts {
        match fact.kind.as_str() {
            "METHOD" | "CONSTRUCTOR" => {
                let Some(owner) = nearest_class_chain(fact.parent_ordinal, &parent_of, &chains)
                else {
                    continue;
                };
                let parameters = parameters.get(&fact.ordinal);
                if fact.kind == "CONSTRUCTOR" {
                    snapshot.insert(format!("{owner}#<init>"), constructor_signature(parameters));
                } else {
                    snapshot.insert(
                        format!("{owner}#{}", fact.name),
                        method_signature(fact, parameters),
                    );
                }
            }
            "FIELD" => {
                let Some(owner) = nearest_class_chain(fact.parent_ordinal, &parent_of, &chains)
                else {
                    continue;
                };
                snapshot.insert(format!("{owner}#{}", fact.name), field_signature(fact));
            }
            "ENUM_CONSTANT" => {
                let Some(owner) = nearest_class_chain(fact.parent_ordinal, &parent_of, &chains)
                else {
                    continue;
                };
                snapshot.insert(
                    format!("{owner}#{}", fact.name),
                    "enum-constant".to_string(),
                );
            }
            _ => {}
        }
    }
    snapshot.finish()
}

fn read_blob(
    reader: &mut Option<BlobReader>,
    repo: &Path,
    oid: &str,
    size: u64,
) -> Result<Vec<u8>> {
    if reader.is_none() {
        *reader = Some(BlobReader::start(repo)?);
    }
    reader
        .as_mut()
        .expect("reader was started above")
        .read(oid, Some(size))
}

fn collect_symbol_evidence(
    repo: &Path,
    changes: &[ActualChange],
) -> Result<HashMap<usize, SymbolEvidenceInternal>> {
    let mut evidence = HashMap::new();
    let mut reader: Option<BlobReader> = None;
    let mut evaluated = 0usize;
    let mut total_bytes = 0u64;

    for (index, change) in changes.iter().enumerate() {
        let base_path = change
            .old_file_path
            .as_deref()
            .unwrap_or(change.file_path.as_str());
        let candidate_path = change.file_path.as_str();
        let base_is_java = base_path.ends_with(".java");
        let candidate_is_java = candidate_path.ends_with(".java");
        if !base_is_java && !candidate_is_java {
            continue;
        }

        let base = change.base.as_ref();
        let candidate = change.candidate.as_ref();
        if base.is_some_and(|meta| !is_regular_mode(&meta.mode))
            || candidate.is_some_and(|meta| !is_regular_mode(&meta.mode))
        {
            evidence.insert(
                index,
                SymbolEvidenceInternal::unavailable(
                    "NON_REGULAR_FILE_MODE: the change touches a symlink or gitlink, not a regular file"
                        .to_string(),
                ),
            );
            continue;
        }
        if let (Some(base), Some(candidate)) = (base, candidate) {
            if base.oid == candidate.oid {
                // Identical content produces no delta, but a declared symbol rename across the
                // path move still needs the snapshot to say whether the names exist. Parse once
                // when the change is a rename and the blob is within the usual limits.
                let mut record = SymbolEvidenceInternal::with_status(
                    SymbolEvidenceStatus::UnchangedContent,
                    "base and candidate blobs are identical".to_string(),
                );
                if change.change_type == ActualChangeType::Renamed
                    && base_is_java
                    && base.bytes <= MAX_JAVA_BLOB_BYTES
                    && evaluated < MAX_SYMBOL_FILES
                    && total_bytes.saturating_add(base.bytes) <= MAX_TOTAL_SYMBOL_BYTES
                {
                    let source = read_blob(&mut reader, repo, &base.oid, base.bytes)?;
                    match snapshot_from_source(&source) {
                        Ok(snapshot) => {
                            evaluated += 1;
                            total_bytes += base.bytes;
                            record.base = snapshot.clone();
                            record.candidate = snapshot;
                            record.snapshots_available = true;
                        }
                        Err(failure) => record = failure_evidence(failure),
                    }
                }
                evidence.insert(index, record);
                continue;
            }
        }
        if base.is_some_and(|meta| meta.bytes > MAX_JAVA_BLOB_BYTES)
            || candidate.is_some_and(|meta| meta.bytes > MAX_JAVA_BLOB_BYTES)
        {
            evidence.insert(
                index,
                SymbolEvidenceInternal::unavailable(format!(
                    "BLOB_TOO_LARGE: a changed blob exceeds the {MAX_JAVA_BLOB_BYTES} byte source limit"
                )),
            );
            continue;
        }
        let bytes = base.map_or(0, |meta| meta.bytes) + candidate.map_or(0, |meta| meta.bytes);
        if evaluated >= MAX_SYMBOL_FILES
            || total_bytes.saturating_add(bytes) > MAX_TOTAL_SYMBOL_BYTES
        {
            evidence.insert(
                index,
                SymbolEvidenceInternal::skipped(
                    "SYMBOL_EVIDENCE_LIMIT: symbol parsing stopped at the per-evaluation file or byte limit"
                        .to_string(),
                ),
            );
            continue;
        }

        let base_snapshot = match (base, base_is_java) {
            (Some(meta), true) => {
                let source = read_blob(&mut reader, repo, &meta.oid, meta.bytes)?;
                match snapshot_from_source(&source) {
                    Ok(snapshot) => snapshot,
                    Err(failure) => {
                        evidence.insert(index, failure_evidence(failure));
                        continue;
                    }
                }
            }
            _ => SymbolSnapshot::default(),
        };
        let candidate_snapshot = match (candidate, candidate_is_java) {
            (Some(meta), true) => {
                let source = read_blob(&mut reader, repo, &meta.oid, meta.bytes)?;
                match snapshot_from_source(&source) {
                    Ok(snapshot) => snapshot,
                    Err(failure) => {
                        evidence.insert(index, failure_evidence(failure));
                        continue;
                    }
                }
            }
            _ => SymbolSnapshot::default(),
        };

        evaluated += 1;
        total_bytes += bytes;
        let delta = diff_snapshots(&base_snapshot, &candidate_snapshot);
        evidence.insert(
            index,
            SymbolEvidenceInternal {
                status: SymbolEvidenceStatus::Complete,
                reason: None,
                delta,
                base: base_snapshot,
                candidate: candidate_snapshot,
                snapshots_available: true,
            },
        );
    }

    if let Some(reader) = reader {
        reader.finish()?;
    }
    Ok(evidence)
}

fn failure_evidence(failure: SnapshotFailure) -> SymbolEvidenceInternal {
    match failure {
        SnapshotFailure::ParseError => SymbolEvidenceInternal::with_status(
            SymbolEvidenceStatus::ParseError,
            "Java source did not parse cleanly; symbol deltas are not reported".to_string(),
        ),
        SnapshotFailure::Unavailable(detail) => SymbolEvidenceInternal::unavailable(detail),
    }
}

// ---------------------------------------------------------------------------
// Evaluation algebra
// ---------------------------------------------------------------------------

fn file_change_str(change: ExpectedFileChangeType) -> &'static str {
    match change {
        ExpectedFileChangeType::Added => "ADDED",
        ExpectedFileChangeType::Modified => "MODIFIED",
        ExpectedFileChangeType::Deleted => "DELETED",
        ExpectedFileChangeType::Renamed => "RENAMED",
    }
}

fn symbol_change_str(change: ExpectedSymbolChangeType) -> &'static str {
    match change {
        ExpectedSymbolChangeType::Added => "ADDED",
        ExpectedSymbolChangeType::Removed => "REMOVED",
        ExpectedSymbolChangeType::Renamed => "RENAMED",
        ExpectedSymbolChangeType::SignatureChanged => "SIGNATURE_CHANGED",
    }
}

fn declared_file(change: &ExpectedFileChange) -> DeclaredExpectation {
    DeclaredExpectation {
        kind: ExpectationKind::File,
        file_path: change.file_path.clone(),
        change_type: file_change_str(change.change_type).to_string(),
        old_file_path: change.old_file_path.clone(),
        symbol_name: None,
        old_symbol_name: None,
        symbol_kind: None,
        provenance: change.provenance.clone(),
        confidence: change.confidence,
    }
}

fn declared_symbol(change: &ExpectedSymbolChange) -> DeclaredExpectation {
    DeclaredExpectation {
        kind: ExpectationKind::Symbol,
        file_path: change.file_path.clone(),
        change_type: symbol_change_str(change.change_type).to_string(),
        old_file_path: None,
        symbol_name: Some(change.symbol_name.clone()),
        old_symbol_name: change.old_symbol_name.clone(),
        symbol_kind: change.symbol_kind.clone(),
        provenance: change.provenance.clone(),
        confidence: change.confidence,
    }
}

fn expectation_record(
    kind: ExpectationKind,
    declared: DeclaredExpectation,
    verdict: ItemVerdict,
    reason_code: &'static str,
    reason: String,
) -> ExpectationEvaluation {
    ExpectationEvaluation {
        kind,
        declared,
        verdict,
        reason_code,
        reason,
        matched: None,
        observed_change_type: None,
        signature_preserved: None,
    }
}

fn expected_actual_type(change: ExpectedFileChangeType) -> ActualChangeType {
    match change {
        ExpectedFileChangeType::Added => ActualChangeType::Added,
        ExpectedFileChangeType::Modified => ActualChangeType::Modified,
        ExpectedFileChangeType::Deleted => ActualChangeType::Deleted,
        ExpectedFileChangeType::Renamed => ActualChangeType::Renamed,
    }
}

fn find_change(
    actuals: &[ActualChange],
    consumed: &[bool],
    path: &str,
    change_type: ActualChangeType,
) -> Option<usize> {
    actuals
        .iter()
        .enumerate()
        .find(|(index, change)| {
            !consumed[*index] && change.file_path == path && change.change_type == change_type
        })
        .map(|(index, _)| index)
}

fn match_file_expectation(
    expected: &ExpectedFileChange,
    index: usize,
    actuals: &[ActualChange],
    consumed: &mut [bool],
    consumed_by: &mut [Option<usize>],
    base_paths: &BTreeMap<String, BlobMeta>,
    candidate_paths: &BTreeMap<String, BlobMeta>,
) -> ExpectationEvaluation {
    let declared = declared_file(expected);
    let claim = |actual_index: usize, consumed: &mut [bool], consumed_by: &mut [Option<usize>]| {
        consumed[actual_index] = true;
        consumed_by[actual_index] = Some(index);
    };

    if expected.change_type == ExpectedFileChangeType::Renamed {
        let old_path = expected
            .old_file_path
            .as_deref()
            .expect("RENAMED expectations are validated to carry oldFilePath");

        if let Some(actual_index) = actuals
            .iter()
            .enumerate()
            .find(|(actual_index, change)| {
                !consumed[*actual_index]
                    && change.change_type == ActualChangeType::Renamed
                    && change.file_path == expected.file_path
                    && change.old_file_path.as_deref() == Some(old_path)
            })
            .map(|(actual_index, _)| actual_index)
        {
            claim(actual_index, consumed, consumed_by);
            let mut record = expectation_record(
                ExpectationKind::File,
                declared,
                ItemVerdict::IntendedMutation,
                "DECLARED_RENAME_OBSERVED",
                "The declared rename was observed with identical base and candidate blob content."
                    .to_string(),
            );
            record.matched = Some(MatchedMutation {
                file_path: expected.file_path.clone(),
                change_type: "RENAMED".to_string(),
                old_file_path: Some(old_path.to_string()),
                symbol_name: None,
                old_symbol_name: None,
                content_preserved: Some(true),
            });
            return record;
        }

        let deletion = find_change(actuals, consumed, old_path, ActualChangeType::Deleted);
        let addition = find_change(
            actuals,
            consumed,
            &expected.file_path,
            ActualChangeType::Added,
        );
        if let (Some(deletion), Some(addition)) = (deletion, addition) {
            let content_preserved = actuals[deletion]
                .base
                .as_ref()
                .map(|meta| meta.oid.as_str())
                == actuals[addition]
                    .candidate
                    .as_ref()
                    .map(|meta| meta.oid.as_str());
            claim(deletion, consumed, consumed_by);
            claim(addition, consumed, consumed_by);
            let mut record = expectation_record(
                ExpectationKind::File,
                declared,
                ItemVerdict::IntendedMutation,
                if content_preserved {
                    "DECLARED_RENAME_EXACT_CONTENT"
                } else {
                    "DECLARED_RENAME_CONTENT_CHANGED"
                },
                if content_preserved {
                    "The declared rename was observed; content is identical on both paths."
                        .to_string()
                } else {
                    "The declared rename was observed; the file content also changed.".to_string()
                },
            );
            record.matched = Some(MatchedMutation {
                file_path: expected.file_path.clone(),
                change_type: "RENAMED".to_string(),
                old_file_path: Some(old_path.to_string()),
                symbol_name: None,
                old_symbol_name: None,
                content_preserved: Some(content_preserved),
            });
            return record;
        }

        let old_deleted = actuals.iter().any(|change| {
            change.change_type == ActualChangeType::Deleted && change.file_path == old_path
        });
        let new_added = actuals.iter().any(|change| {
            change.change_type == ActualChangeType::Added && change.file_path == expected.file_path
        });
        let code = if !old_deleted && !new_added {
            "RENAME_NOT_OBSERVED"
        } else if !old_deleted {
            "OLD_PATH_NOT_DELETED"
        } else {
            "NEW_PATH_NOT_ADDED"
        };
        let reason = match code {
            "OLD_PATH_NOT_DELETED" => format!(
                "The declared rename was not observed: {old_path:?} is still present in the candidate tree."
            ),
            "NEW_PATH_NOT_ADDED" => format!(
                "The declared rename was not observed: {:?} is not present as an addition.",
                expected.file_path
            ),
            _ => format!(
                "The declared rename was not observed: neither {old_path:?} disappeared nor {:?} appeared.",
                expected.file_path
            ),
        };
        return expectation_record(
            ExpectationKind::File,
            declared,
            ItemVerdict::UnobservedExpectation,
            code,
            reason,
        );
    }

    let actual_type = expected_actual_type(expected.change_type);
    if let Some(actual_index) = find_change(actuals, consumed, &expected.file_path, actual_type) {
        claim(actual_index, consumed, consumed_by);
        return expectation_record(
            ExpectationKind::File,
            declared,
            ItemVerdict::IntendedMutation,
            "DECLARED_CHANGE_OBSERVED",
            format!(
                "The declared {} change was observed in the candidate tree.",
                file_change_str(expected.change_type)
            ),
        );
    }

    let observed = actuals.iter().find(|change| {
        change.file_path == expected.file_path
            || change.old_file_path.as_deref() == Some(expected.file_path.as_str())
    });
    if let Some(observed) = observed {
        let mut record = expectation_record(
            ExpectationKind::File,
            declared,
            ItemVerdict::UnobservedExpectation,
            "CHANGE_TYPE_MISMATCH",
            format!(
                "The declared {} change was not observed; the path changed as {}.",
                file_change_str(expected.change_type),
                observed.change_type.as_str()
            ),
        );
        record.observed_change_type = Some(observed.change_type.as_str().to_string());
        return record;
    }

    if base_paths.contains_key(&expected.file_path)
        && candidate_paths.contains_key(&expected.file_path)
    {
        return expectation_record(
            ExpectationKind::File,
            declared,
            ItemVerdict::UnobservedExpectation,
            "FILE_UNCHANGED",
            "The declared change was not observed; the path is unchanged between the two revisions."
                .to_string(),
        );
    }
    expectation_record(
        ExpectationKind::File,
        declared,
        ItemVerdict::UnobservedExpectation,
        "FILE_NOT_OBSERVED",
        "The declared change was not observed; the path is absent from both revisions.".to_string(),
    )
}

fn symbol_evidence_unverifiable(
    expected: &ExpectedSymbolChange,
    code: &'static str,
    reason: String,
) -> ExpectationEvaluation {
    expectation_record(
        ExpectationKind::Symbol,
        declared_symbol(expected),
        ItemVerdict::Unverifiable,
        code,
        reason,
    )
}

fn compare_symbol_expectation(
    expected: &ExpectedSymbolChange,
    evidence: &SymbolEvidenceInternal,
) -> (ExpectationEvaluation, Option<usize>) {
    let declared = declared_symbol(expected);
    let key = expected.symbol_name.as_str();
    let key_in_base = evidence.base.signature(key);
    let key_in_candidate = evidence.candidate.signature(key);
    let matched_symbol = |change_type: &str| MatchedMutation {
        file_path: expected.file_path.clone(),
        change_type: change_type.to_string(),
        old_file_path: None,
        symbol_name: Some(key.to_string()),
        old_symbol_name: expected.old_symbol_name.clone(),
        content_preserved: None,
    };

    let (verdict, code, reason, matched, observed, signature_preserved) =
        match expected.change_type {
            ExpectedSymbolChangeType::Added => match (key_in_base, key_in_candidate) {
                (None, Some(_)) => (
                    ItemVerdict::IntendedMutation,
                    "SYMBOL_ADDITION_OBSERVED",
                    "The declared symbol addition was observed.".to_string(),
                    Some(matched_symbol("ADDED")),
                    None,
                    None,
                ),
                (Some(_), Some(_)) if key_in_base != key_in_candidate => (
                    ItemVerdict::UnobservedExpectation,
                    "SIGNATURE_CHANGED_INSTEAD",
                    "The declared symbol addition was not observed; the existing symbol's signature changed."
                        .to_string(),
                    None,
                    Some("SIGNATURE_CHANGED".to_string()),
                    None,
                ),
                (Some(_), Some(_)) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_ALREADY_EXISTED",
                    "The declared symbol addition was not observed; the symbol already exists."
                        .to_string(),
                    None,
                    None,
                    None,
                ),
                (Some(_), None) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_REMOVED_INSTEAD",
                    "The declared symbol addition was not observed; the symbol was removed."
                        .to_string(),
                    None,
                    Some("REMOVED".to_string()),
                    None,
                ),
                (None, None) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_NOT_FOUND",
                    "The declared symbol was not found in either revision.".to_string(),
                    None,
                    None,
                    None,
                ),
            },
            ExpectedSymbolChangeType::Removed => match (key_in_base, key_in_candidate) {
                (Some(_), None) => (
                    ItemVerdict::IntendedMutation,
                    "SYMBOL_REMOVAL_OBSERVED",
                    "The declared symbol removal was observed.".to_string(),
                    Some(matched_symbol("REMOVED")),
                    None,
                    None,
                ),
                (None, Some(_)) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_ADDED_INSTEAD",
                    "The declared symbol removal was not observed; the symbol was added."
                        .to_string(),
                    None,
                    Some("ADDED".to_string()),
                    None,
                ),
                (Some(_), Some(_)) if key_in_base != key_in_candidate => (
                    ItemVerdict::UnobservedExpectation,
                    "SIGNATURE_CHANGED_INSTEAD",
                    "The declared symbol removal was not observed; the symbol's signature changed."
                        .to_string(),
                    None,
                    Some("SIGNATURE_CHANGED".to_string()),
                    None,
                ),
                (Some(_), Some(_)) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_STILL_PRESENT",
                    "The declared symbol removal was not observed; the symbol is unchanged."
                        .to_string(),
                    None,
                    None,
                    None,
                ),
                (None, None) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_NOT_FOUND",
                    "The declared symbol was not found in either revision.".to_string(),
                    None,
                    None,
                    None,
                ),
            },
            ExpectedSymbolChangeType::SignatureChanged => match (key_in_base, key_in_candidate) {
                (Some(_), Some(_)) if key_in_base != key_in_candidate => (
                    ItemVerdict::IntendedMutation,
                    "SYMBOL_SIGNATURE_CHANGE_OBSERVED",
                    "The declared signature change was observed.".to_string(),
                    Some(matched_symbol("SIGNATURE_CHANGED")),
                    None,
                    None,
                ),
                (Some(_), Some(_)) => (
                    ItemVerdict::UnobservedExpectation,
                    "SIGNATURE_UNCHANGED",
                    "The declared signature change was not observed; the signature is unchanged."
                        .to_string(),
                    None,
                    None,
                    None,
                ),
                (Some(_), None) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_REMOVED_INSTEAD",
                    "The declared signature change was not observed; the symbol was removed."
                        .to_string(),
                    None,
                    Some("REMOVED".to_string()),
                    None,
                ),
                (None, Some(_)) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_ADDED_INSTEAD",
                    "The declared signature change was not observed; the symbol was added."
                        .to_string(),
                    None,
                    Some("ADDED".to_string()),
                    None,
                ),
                (None, None) => (
                    ItemVerdict::UnobservedExpectation,
                    "SYMBOL_NOT_FOUND",
                    "The declared symbol was not found in either revision.".to_string(),
                    None,
                    None,
                    None,
                ),
            },
            ExpectedSymbolChangeType::Renamed => {
                let old_key = expected
                    .old_symbol_name
                    .as_deref()
                    .expect("RENAMED symbol expectations are validated to carry oldSymbolName");
                let old_in_base = evidence.base.signature(old_key);
                let old_in_candidate = evidence.candidate.signature(old_key);
                let new_in_base = evidence.base.signature(key);
                let new_in_candidate = evidence.candidate.signature(key);
                if old_in_base.is_none() {
                    (
                        ItemVerdict::UnobservedExpectation,
                        "OLD_SYMBOL_NOT_FOUND",
                        format!("The declared old symbol {old_key:?} was not found in the base revision."),
                        None,
                        None,
                        None,
                    )
                } else if new_in_candidate.is_none() {
                    (
                        ItemVerdict::UnobservedExpectation,
                        "NEW_SYMBOL_NOT_OBSERVED",
                        format!("The declared new symbol {key:?} was not found in the candidate revision."),
                        None,
                        None,
                        None,
                    )
                } else if new_in_base.is_some() {
                    (
                        ItemVerdict::UnobservedExpectation,
                        "NEW_SYMBOL_PREEXISTED",
                        format!("The declared new symbol {key:?} already existed in the base revision; a rename cannot be distinguished from an addition."),
                        None,
                        None,
                        None,
                    )
                } else if old_in_candidate.is_some() {
                    (
                        ItemVerdict::UnobservedExpectation,
                        "OLD_SYMBOL_STILL_PRESENT",
                        format!("The declared old symbol {old_key:?} is still present in the candidate revision."),
                        None,
                        None,
                        None,
                    )
                } else {
                    let preserved = old_in_base == new_in_candidate;
                    let mut matched = matched_symbol("RENAMED");
                    matched.old_symbol_name = Some(old_key.to_string());
                    (
                        ItemVerdict::IntendedMutation,
                        "SYMBOL_RENAMED_OBSERVED",
                        if preserved {
                            "The declared symbol rename was observed with an unchanged signature."
                                .to_string()
                        } else {
                            "The declared symbol rename was observed; the signature also changed."
                                .to_string()
                        },
                        Some(matched),
                        None,
                        Some(preserved),
                    )
                }
            }
        };

    let mut record = expectation_record(ExpectationKind::Symbol, declared, verdict, code, reason);
    record.matched = matched;
    record.observed_change_type = observed;
    record.signature_preserved = signature_preserved;
    (record, None)
}

fn symbol_evidence_failure(
    expected: &ExpectedSymbolChange,
    evidence: &SymbolEvidenceInternal,
) -> Option<ExpectationEvaluation> {
    let (code, fallback) = match evidence.status {
        SymbolEvidenceStatus::ParseError => (
            "SYMBOL_EVIDENCE_PARSE_ERROR",
            "Java source did not parse cleanly.",
        ),
        SymbolEvidenceStatus::Unavailable => (
            "SYMBOL_EVIDENCE_UNAVAILABLE",
            "Symbol evidence could not be read.",
        ),
        SymbolEvidenceStatus::SkippedLimit => (
            "SYMBOL_EVIDENCE_SKIPPED_LIMIT",
            "Symbol evidence was skipped at a resource limit.",
        ),
        SymbolEvidenceStatus::Complete | SymbolEvidenceStatus::UnchangedContent => return None,
    };
    Some(symbol_evidence_unverifiable(
        expected,
        code,
        evidence
            .reason
            .clone()
            .unwrap_or_else(|| fallback.to_string()),
    ))
}

fn evaluate_symbol_expectation(
    expected: &ExpectedSymbolChange,
    actuals: &[ActualChange],
    evidence: &HashMap<usize, SymbolEvidenceInternal>,
    candidate_paths: &BTreeMap<String, BlobMeta>,
    declared_renames: &HashMap<String, String>,
) -> (ExpectationEvaluation, Option<usize>) {
    if !expected.file_path.ends_with(".java") {
        return (
            symbol_evidence_unverifiable(
                expected,
                "NON_JAVA_SYMBOL_EVIDENCE",
                "Symbol expectations are evaluated for Java sources only; this file is outside that scope."
                    .to_string(),
            ),
            None,
        );
    }

    let actual_index = actuals.iter().enumerate().find_map(|(index, change)| {
        (change.file_path == expected.file_path
            || change.old_file_path.as_deref() == Some(expected.file_path.as_str()))
        .then_some(index)
    });
    let Some(actual_index) = actual_index else {
        let (code, reason) = if candidate_paths.contains_key(&expected.file_path) {
            (
                "FILE_UNCHANGED",
                "The file is unchanged between the two revisions, so no symbol mutation is observable.",
            )
        } else {
            (
                "FILE_NOT_OBSERVED",
                "The declared file is not part of the observed change set.",
            )
        };
        return (
            expectation_record(
                ExpectationKind::Symbol,
                declared_symbol(expected),
                ItemVerdict::UnobservedExpectation,
                code,
                reason.to_string(),
            ),
            None,
        );
    };
    let Some(candidate_evidence) = evidence.get(&actual_index) else {
        return (
            symbol_evidence_unverifiable(
                expected,
                "SYMBOL_EVIDENCE_UNAVAILABLE",
                "The changed file has no Java symbol evidence.".to_string(),
            ),
            None,
        );
    };

    // A RENAMED symbol expectation names the file that should hold the new symbol. When a
    // declared file rename moved the content, the old symbol lives in the old path's base
    // snapshot, which is a different mutation. An undeclared deletion is never guessed at.
    let is_rename = expected.change_type == ExpectedSymbolChangeType::Renamed;
    let base_path = if is_rename {
        declared_renames
            .get(&expected.file_path)
            .map(String::as_str)
            .or_else(|| actuals[actual_index].old_file_path.as_deref())
            .unwrap_or(expected.file_path.as_str())
    } else {
        expected.file_path.as_str()
    };
    let moved = base_path != expected.file_path;

    if candidate_evidence.status == SymbolEvidenceStatus::UnchangedContent
        && !(is_rename && moved && candidate_evidence.snapshots_available)
    {
        if moved {
            return (
                symbol_evidence_unverifiable(
                    expected,
                    "SYMBOL_EVIDENCE_UNAVAILABLE",
                    "The renamed file content is identical between the revisions, but it could not be parsed for symbol evaluation."
                        .to_string(),
                ),
                None,
            );
        }
        return (
            expectation_record(
                ExpectationKind::Symbol,
                declared_symbol(expected),
                ItemVerdict::UnobservedExpectation,
                "FILE_UNCHANGED",
                "The file content is identical between the two revisions, so no symbol mutation is observable."
                    .to_string(),
            ),
            None,
        );
    }
    if let Some(failure) = symbol_evidence_failure(expected, candidate_evidence) {
        return (failure, None);
    }

    let merged;
    let effective = if !moved {
        if is_rename && actuals[actual_index].base.is_none() {
            return (
                symbol_evidence_unverifiable(
                    expected,
                    "RENAME_BASE_FILE_NOT_OBSERVED",
                    "The declared file was added in the candidate revision, so the old symbol has no base revision content to resolve against."
                        .to_string(),
                ),
                None,
            );
        }
        candidate_evidence
    } else {
        let base_index = actuals
            .iter()
            .position(|change| change.file_path == base_path)
            .or_else(|| {
                actuals
                    .iter()
                    .position(|change| change.old_file_path.as_deref() == Some(base_path))
            });
        let Some(base_index) = base_index else {
            return (
                symbol_evidence_unverifiable(
                    expected,
                    "RENAME_BASE_FILE_NOT_OBSERVED",
                    format!(
                        "The declared old file {base_path:?} is not part of the observed change set, so the old symbol cannot be evaluated."
                    ),
                ),
                None,
            );
        };
        let Some(base_evidence) = evidence.get(&base_index) else {
            if !base_path.ends_with(".java") {
                return (
                    symbol_evidence_unverifiable(
                        expected,
                        "NON_JAVA_SYMBOL_EVIDENCE",
                        format!(
                            "The declared old file {base_path:?} is not a Java source; symbol expectations are evaluated for Java sources only."
                        ),
                    ),
                    None,
                );
            }
            return (
                symbol_evidence_unverifiable(
                    expected,
                    "SYMBOL_EVIDENCE_UNAVAILABLE",
                    format!("The old file {base_path:?} has no Java symbol evidence."),
                ),
                None,
            );
        };
        if let Some(failure) = symbol_evidence_failure(expected, base_evidence) {
            return (failure, None);
        }
        if base_evidence.status == SymbolEvidenceStatus::UnchangedContent
            && !base_evidence.snapshots_available
        {
            return (
                symbol_evidence_unverifiable(
                    expected,
                    "SYMBOL_EVIDENCE_UNAVAILABLE",
                    format!(
                        "The old file {base_path:?} is unchanged in content but could not be parsed for symbol evaluation."
                    ),
                ),
                None,
            );
        }
        merged = SymbolEvidenceInternal {
            status: SymbolEvidenceStatus::Complete,
            reason: None,
            delta: SymbolDelta::default(),
            base: base_evidence.base.clone(),
            candidate: candidate_evidence.candidate.clone(),
            snapshots_available: true,
        };
        &merged
    };

    let (record, _) = compare_symbol_expectation(expected, effective);
    let satisfied = (record.verdict == ItemVerdict::IntendedMutation).then_some(actual_index);
    (record, satisfied)
}

// ---------------------------------------------------------------------------
// Public evaluation entry point
// ---------------------------------------------------------------------------

pub struct EvaluationRequest {
    pub repo_root: PathBuf,
    pub ecm_path: PathBuf,
    pub base_override: Option<String>,
    pub candidate_override: Option<String>,
}

fn confine(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf> {
    if allowed_roots.is_empty() {
        normalize_path(path)
    } else {
        validate_path_under_roots(path, allowed_roots)
    }
}

fn display_path(repo_root: &Path, path: &Path) -> String {
    let display = path
        .strip_prefix(repo_root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
    if display.is_empty() {
        ".".to_string()
    } else {
        display
    }
}

pub fn evaluate(
    allowed_roots: &[PathBuf],
    request: &EvaluationRequest,
) -> Result<EvaluationReport> {
    let repo_root = resolve_repo_root(&request.repo_root, allowed_roots)?;
    let ecm_path = confine(&request.ecm_path, allowed_roots)
        .with_context(|| format!("Cannot resolve ECM path {:?}", request.ecm_path))?;
    let metadata = fs::symlink_metadata(&ecm_path)
        .with_context(|| format!("Cannot read ECM file {:?}", ecm_path))?;
    if !metadata.is_file() {
        bail!("ECM path {:?} is not a regular file", ecm_path);
    }
    let bytes = read_bounded(&ecm_path, MAX_ECM_BYTES)
        .with_context(|| format!("Cannot read ECM file {:?}", ecm_path))?;
    let document: EcmDocument = serde_json::from_slice(&bytes)
        .with_context(|| format!("Invalid ECM JSON in {:?}", ecm_path))?;

    let base_source = if request.base_override.is_some() {
        RevisionSource::Override
    } else {
        RevisionSource::Ecm
    };
    let candidate_source = if request.candidate_override.is_some() {
        RevisionSource::Override
    } else {
        RevisionSource::Ecm
    };
    let resolved = validate_ecm(
        &document,
        request.base_override.as_deref(),
        request.candidate_override.as_deref(),
    )?;

    let base_commit = revision::resolve_commit(&repo_root, &resolved.base)
        .with_context(|| format!("Cannot resolve ECM base revision {:?}", resolved.base))?;
    let candidate_commit =
        revision::resolve_commit(&repo_root, &resolved.candidate).with_context(|| {
            format!(
                "Cannot resolve ECM candidate revision {:?}",
                resolved.candidate
            )
        })?;

    let base_paths = tree_map(&repo_root, &base_commit)?;
    let candidate_paths = tree_map(&repo_root, &candidate_commit)?;
    let actuals = actual_changes(&base_paths, &candidate_paths);
    let symbol_evidence = collect_symbol_evidence(&repo_root, &actuals)?;

    let mut expectations: Vec<ExpectationEvaluation> = Vec::new();
    let mut consumed = vec![false; actuals.len()];
    let mut consumed_by: Vec<Option<usize>> = vec![None; actuals.len()];

    for (index, expected) in resolved.expected_files.iter().enumerate() {
        expectations.push(match_file_expectation(
            expected,
            index,
            &actuals,
            &mut consumed,
            &mut consumed_by,
            &base_paths,
            &candidate_paths,
        ));
    }

    let file_expectation_count = expectations.len();
    let declared_renames: HashMap<String, String> = resolved
        .expected_files
        .iter()
        .filter(|expected| expected.change_type == ExpectedFileChangeType::Renamed)
        .filter_map(|expected| {
            expected
                .old_file_path
                .as_ref()
                .map(|old| (expected.file_path.clone(), old.clone()))
        })
        .collect();
    let mut symbol_intent: BTreeMap<usize, usize> = BTreeMap::new();
    for (offset, expected) in resolved.expected_symbols.iter().enumerate() {
        let expectation_index = file_expectation_count + offset;
        let (record, satisfied_actual) = evaluate_symbol_expectation(
            expected,
            &actuals,
            &symbol_evidence,
            &candidate_paths,
            &declared_renames,
        );
        if let Some(actual_index) = satisfied_actual {
            symbol_intent
                .entry(actual_index)
                .or_insert(expectation_index);
        }
        expectations.push(record);
    }

    let mut actual_mutations = Vec::with_capacity(actuals.len());
    for (index, change) in actuals.iter().enumerate() {
        let boundary = resolved.boundary.as_ref().and_then(|boundary| {
            let mut paths = vec![change.file_path.as_str()];
            if let Some(old_path) = change.old_file_path.as_deref() {
                paths.push(old_path);
            }
            boundary.forbidden_paths.iter().find_map(|prefix| {
                paths
                    .iter()
                    .find(|path| under_prefix(path, prefix))
                    .map(|_| BoundaryHit {
                        prefix: prefix.clone(),
                        reason: boundary.reason.clone(),
                    })
            })
        });
        let (verdict, reason_code, reason, matched_expectation_index) =
            if let Some(hit) = boundary.as_ref() {
                (
                    ItemVerdict::UnintendedRegression,
                    "BOUNDARY_VIOLATION",
                    format!(
                        "The mutation touches forbidden path prefix {:?}: {}",
                        hit.prefix, hit.reason
                    ),
                    None,
                )
            } else if let Some(expectation_index) = consumed_by[index] {
                (
                    ItemVerdict::IntendedMutation,
                    "DECLARED_CHANGE_OBSERVED",
                    "The mutation is covered by a declared file expectation.".to_string(),
                    Some(expectation_index),
                )
            } else if let Some(expectation_index) = symbol_intent.get(&index) {
                (
                    ItemVerdict::IntendedMutation,
                    "SYMBOL_EXPECTATION_OBSERVED",
                    "The mutation is covered by a declared symbol expectation.".to_string(),
                    Some(*expectation_index),
                )
            } else {
                (
                    ItemVerdict::UnintendedRegression,
                    "UNDECLARED_FILE_MUTATION",
                    "The mutation is not covered by any declared expectation.".to_string(),
                    None,
                )
            };

        actual_mutations.push(ActualMutation {
            file_path: change.file_path.clone(),
            change_type: change.change_type,
            old_file_path: change.old_file_path.clone(),
            verdict,
            reason_code,
            reason,
            matched_expectation_index,
            boundary,
            mode_change: change.mode_changed.then(|| ModeChange {
                base: change
                    .base
                    .as_ref()
                    .map(|meta| meta.mode.clone())
                    .unwrap_or_default(),
                candidate: change
                    .candidate
                    .as_ref()
                    .map(|meta| meta.mode.clone())
                    .unwrap_or_default(),
            }),
            symbols: symbol_evidence
                .get(&index)
                .map(|evidence| SymbolEvidenceOut {
                    status: evidence.status,
                    reason: evidence.reason.clone(),
                    added: evidence.delta.added.clone(),
                    removed: evidence.delta.removed.clone(),
                    signature_changed: evidence.delta.changed.clone(),
                }),
        });
    }

    let mut completeness_reasons: Vec<ReasonCode> = Vec::new();
    for (index, evidence) in &symbol_evidence {
        if matches!(
            evidence.status,
            SymbolEvidenceStatus::ParseError
                | SymbolEvidenceStatus::Unavailable
                | SymbolEvidenceStatus::SkippedLimit
        ) {
            completeness_reasons.push(ReasonCode {
                code: evidence_status_code(evidence.status).to_string(),
                detail: format!(
                    "{}: {}",
                    actuals[*index].file_path,
                    evidence.reason.clone().unwrap_or_default()
                ),
            });
        }
    }
    completeness_reasons.sort_by(|left, right| {
        left.code
            .cmp(&right.code)
            .then_with(|| left.detail.cmp(&right.detail))
    });
    let changed_java_files = symbol_evidence.len() as u64;
    let evaluated_java_files = symbol_evidence
        .values()
        .filter(|evidence| evidence.status == SymbolEvidenceStatus::Complete)
        .count() as u64;
    let symbol_evidence_incomplete = !completeness_reasons.is_empty();

    let declared_file_expectations = resolved.expected_files.len() as u64;
    let declared_symbol_expectations = resolved.expected_symbols.len() as u64;
    let observed_file_mutations = actual_mutations.len() as u64;
    let intended_file_mutations = actual_mutations
        .iter()
        .filter(|mutation| mutation.verdict == ItemVerdict::IntendedMutation)
        .count() as u64;
    let unintended_file_mutations = actual_mutations
        .iter()
        .filter(|mutation| mutation.verdict == ItemVerdict::UnintendedRegression)
        .count() as u64;
    let boundary_violations = actual_mutations
        .iter()
        .filter(|mutation| mutation.boundary.is_some())
        .count() as u64;
    let expectations_intended = expectations
        .iter()
        .filter(|expectation| expectation.verdict == ItemVerdict::IntendedMutation)
        .count() as u64;
    let expectations_unobserved = expectations
        .iter()
        .filter(|expectation| expectation.verdict == ItemVerdict::UnobservedExpectation)
        .count() as u64;
    let expectations_unverifiable = expectations
        .iter()
        .filter(|expectation| expectation.verdict == ItemVerdict::Unverifiable)
        .count() as u64;
    let observed_symbol_mutations = symbol_evidence
        .values()
        .map(|evidence| {
            evidence.delta.added.len() + evidence.delta.removed.len() + evidence.delta.changed.len()
        })
        .sum::<usize>() as u64;

    let (verdict, verdict_reason) = if boundary_violations > 0 {
        (
            ChangeVerdict::UnintendedRegression,
            format!(
                "{boundary_violations} observed mutation(s) touch declared forbidden paths; \
                 {unintended_file_mutations} observed mutation(s) are not covered by declared intent."
            ),
        )
    } else if unintended_file_mutations > 0 {
        (
            ChangeVerdict::UnintendedRegression,
            format!(
                "{unintended_file_mutations} observed mutation(s) are not covered by declared intent. \
                 Declared intent covers {intended_file_mutations} of {observed_file_mutations} observed mutation(s)."
            ),
        )
    } else if expectations_unverifiable > 0 {
        (
            ChangeVerdict::IncompleteEvidence,
            format!(
                "No undeclared mutation was observed, but {expectations_unverifiable} expectation(s) could not be evaluated with the available structural evidence."
            ),
        )
    } else if expectations_unobserved > 0 {
        (
            ChangeVerdict::DeclaredChangeNotObserved,
            format!(
                "No undeclared mutation was observed, but {expectations_unobserved} declared expectation(s) were not observed in the change set."
            ),
        )
    } else if actual_mutations.is_empty() && expectations.is_empty() {
        (
            ChangeVerdict::NoChanges,
            "No files changed between the two revisions and the ECM declared no expectations."
                .to_string(),
        )
    } else {
        (
            ChangeVerdict::IntendedChange,
            format!(
                "All {observed_file_mutations} observed mutation(s) are covered by declared intent, and all {expectations_intended} expectation(s) were observed."
            ),
        )
    };

    Ok(EvaluationReport {
        schema_version: SCHEMA_VERSION,
        ecm: EcmSummary {
            path: display_path(&repo_root, &ecm_path),
            ecm_version: document.ecm_version,
            base: RevisionSummary {
                requested: resolved.base.clone(),
                resolved: base_commit,
                source: base_source,
            },
            candidate: RevisionSummary {
                requested: resolved.candidate.clone(),
                resolved: candidate_commit,
                source: candidate_source,
            },
            declared_files: declared_file_expectations,
            declared_symbols: declared_symbol_expectations,
            boundary: resolved.boundary.as_ref().map(|boundary| BoundarySummary {
                forbidden_paths: boundary.forbidden_paths.clone(),
                reason: boundary.reason.clone(),
            }),
        },
        summary: EvaluationSummary {
            declared_file_expectations,
            declared_symbol_expectations,
            observed_file_mutations,
            intended_file_mutations,
            unintended_file_mutations,
            boundary_violations,
            expectations_intended,
            expectations_unobserved,
            expectations_unverifiable,
            observed_symbol_mutations,
            symbol_evidence_incomplete,
        },
        verdict,
        verdict_reason,
        expectations,
        actual_mutations,
        completeness: Completeness {
            symbol_evidence: SymbolCompleteness {
                complete: !symbol_evidence_incomplete,
                changed_java_files,
                evaluated_java_files,
                reasons: completeness_reasons,
            },
        },
        notice: NOTICE,
    })
}

fn evidence_status_code(status: SymbolEvidenceStatus) -> &'static str {
    match status {
        SymbolEvidenceStatus::Complete => "COMPLETE",
        SymbolEvidenceStatus::UnchangedContent => "UNCHANGED_CONTENT",
        SymbolEvidenceStatus::ParseError => "SYMBOL_EVIDENCE_PARSE_ERROR",
        SymbolEvidenceStatus::Unavailable => "SYMBOL_EVIDENCE_UNAVAILABLE",
        SymbolEvidenceStatus::SkippedLimit => "SYMBOL_EVIDENCE_SKIPPED_LIMIT",
    }
}

// ---------------------------------------------------------------------------
// Report rendering and output
// ---------------------------------------------------------------------------

pub fn render_report(report: &EvaluationReport) -> Result<String> {
    let mut text = serde_json::to_string_pretty(report)?;
    text.push('\n');
    Ok(text)
}

pub fn summary_line(report: &EvaluationReport) -> String {
    let summary = &report.summary;
    format!(
        "change-evaluate: {} - {} file mutation(s): {} intended, {} unintended ({} boundary violation(s)); \
         expectations: {} intended, {} unobserved, {} unverifiable; symbol evidence: {} (advisory, no test selection)",
        report.verdict.as_str(),
        summary.observed_file_mutations,
        summary.intended_file_mutations,
        summary.unintended_file_mutations,
        summary.boundary_violations,
        summary.expectations_intended,
        summary.expectations_unobserved,
        summary.expectations_unverifiable,
        if summary.symbol_evidence_incomplete {
            "incomplete"
        } else {
            "complete"
        }
    )
}

/// Validate a report destination. The default lives beside the other Sajimora
/// artifacts; files owned by the other analysis lanes are refused outright, and
/// an existing file is only overwritten when it is already a change evaluation.
pub fn resolve_output_path(
    repo_root: &Path,
    requested: Option<&Path>,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf> {
    let candidate = match requested {
        Some(path) => {
            if path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            {
                bail!("Output path {:?} must not contain '..'", path);
            }
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                repo_root.join(path)
            }
        }
        None => repo_root.join(DEFAULT_OUTPUT),
    };
    let name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .context("Output path has no file name")?;
    for reserved in RESERVED_OUTPUT_FILES {
        if name.eq_ignore_ascii_case(reserved) {
            bail!("{name} is reserved for another Sajimora artifact; choose another output name");
        }
    }
    if !name.to_ascii_lowercase().ends_with(".json") {
        bail!("Output path {name:?} must end in .json");
    }
    let parent = candidate
        .parent()
        .context("Output path has no parent directory")?;
    if !parent.is_dir() {
        bail!("Output directory {:?} does not exist", parent);
    }
    let parent = confine(parent, allowed_roots)?;
    let name = candidate
        .file_name()
        .context("Output path has no file name")?;
    let resolved = parent.join(name);
    if resolved.exists() {
        let metadata = fs::symlink_metadata(&resolved)?;
        if !metadata.is_file() {
            bail!(
                "Output path {:?} is not a regular file; refusing to overwrite",
                resolved
            );
        }
        let bytes = read_bounded(&resolved, MAX_ECM_BYTES)
            .with_context(|| format!("Cannot read existing output {:?}", resolved))?;
        let existing: Value = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "Existing file {:?} is not a Sajimora change evaluation; refusing to overwrite",
                resolved
            )
        })?;
        if existing.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA_VERSION) {
            bail!(
                "Existing file {:?} is not a {} report; refusing to overwrite",
                resolved,
                SCHEMA_VERSION
            );
        }
    }
    Ok(resolved)
}

pub fn write_report(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            bail!("Output directory {:?} does not exist", parent);
        }
    }
    fs::write(path, text).with_context(|| format!("Cannot write report to {:?}", path))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_prefix_matches_whole_segments_only() {
        assert!(under_prefix("src/gen", "src/gen"));
        assert!(under_prefix("src/gen/Out.java", "src/gen"));
        assert!(!under_prefix("src/generated/Out.java", "src/gen"));
        assert!(!under_prefix("src", "src/gen"));
    }

    #[test]
    fn symbol_keys_are_structural_and_nested_types_are_dot_qualified() {
        let source = br#"package demo;

public class Demo {
    private int count;
    public Demo(int count) { this.count = count; }
    public void save(String value) { }
    static class Outer {
        void run(int a, long[] b) { }
    }
}
"#;
        let snapshot = snapshot_from_source(source).expect("parse fixture");
        let keys: Vec<&String> = snapshot.symbols.keys().collect();
        assert!(keys.contains(&&"Demo".to_string()), "{keys:?}");
        assert!(keys.contains(&&"Demo#count".to_string()), "{keys:?}");
        assert!(keys.contains(&&"Demo#<init>".to_string()), "{keys:?}");
        assert!(keys.contains(&&"Demo#save".to_string()), "{keys:?}");
        assert!(keys.contains(&&"Outer".to_string()), "{keys:?}");
        assert!(keys.contains(&&"Demo.Outer#run".to_string()), "{keys:?}");
    }

    #[test]
    fn signature_diff_reports_a_parameter_change() {
        let base = snapshot_from_source(
            b"package demo; public class Demo { public void save(String value) { } }",
        )
        .expect("base");
        let candidate = snapshot_from_source(
            b"package demo; public class Demo { public void save(String value, int retries) { } }",
        )
        .expect("candidate");
        let delta = diff_snapshots(&base, &candidate);
        assert_eq!(delta.changed.len(), 1);
        assert_eq!(delta.changed[0].symbol, "Demo#save");
        assert!(delta.added.is_empty(), "{:?}", delta.added);
        assert!(delta.removed.is_empty(), "{:?}", delta.removed);
    }

    #[test]
    fn ambiguous_rename_pairing_is_not_invented() {
        let mut base = BTreeMap::new();
        base.insert(
            "a.txt".to_string(),
            BlobMeta {
                oid: "same".into(),
                mode: "100644".into(),
                bytes: 1,
            },
        );
        base.insert(
            "b.txt".to_string(),
            BlobMeta {
                oid: "same".into(),
                mode: "100644".into(),
                bytes: 1,
            },
        );
        let mut candidate = BTreeMap::new();
        candidate.insert(
            "c.txt".to_string(),
            BlobMeta {
                oid: "same".into(),
                mode: "100644".into(),
                bytes: 1,
            },
        );
        candidate.insert(
            "d.txt".to_string(),
            BlobMeta {
                oid: "same".into(),
                mode: "100644".into(),
                bytes: 1,
            },
        );
        let changes = actual_changes(&base, &candidate);
        assert_eq!(changes.len(), 4);
        assert!(
            changes
                .iter()
                .all(|change| change.change_type != ActualChangeType::Renamed),
            "ambiguous blob ids must not be paired"
        );
    }
}
