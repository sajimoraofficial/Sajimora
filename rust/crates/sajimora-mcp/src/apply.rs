//! apply.rs — Deterministic consumer-side patch application for MCP.
//!
//! `sajimora_what_if` proposes consumer-side patches but only returns them as
//! capped, advisory descriptions. This tool closes the loop: it re-derives the
//! SAME patch plan (uncapped) for a symbolic DTO mutation and *applies* the
//! deterministic subset to disk, so a small orchestrating model does not have to
//! synthesize the edits itself.
//!
//! Scope (prototype):
//! - Applies TypeScript client-model property RENAME/REMOVE (AST-targeted) and
//!   Angular template token REPLACE.
//! - Does NOT edit Java provider code, and does NOT rewrite arbitrary call-site
//!   reads. Those remain the model's job; re-check with `sajimora_verify`.
//!
//! Safety mirrors `heal`:
//! - Every path is validated against the server allowed roots before read/write.
//! - Atomic writes; fail-closed abstentions; idempotent; dry-run writes nothing.
//! - Non-target bytes are preserved verbatim (byte-range splice / single-line edit).

use anyhow::{bail, Context, Result};
use contract_core::service::validate_path_under_roots;
use rmcp::model::Tool;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use source_index::contracts_db::{
    client_type_declares_field, dto_has_field, open_reader, resolve_dto_type_refs, sync_if_needed,
};
use source_index::endpoint_impact::resolve_repo_root;
use source_index::html_templates::{scan_html_templates, TemplateConsumerMatch};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tree_sitter::{Node, Parser};

pub const TOOL_NAME: &str = "sajimora_apply_patches";

pub fn tool_definition() -> Tool {
    let mut schema_map = serde_json::Map::new();
    schema_map.insert("type".to_string(), json!("object"));
    schema_map.insert(
        "properties".to_string(),
        json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root containing .sajimora/init-manifest.json; must resolve under an allowed root"
            },
            "mutation": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["RENAME_FIELD", "REMOVE_FIELD"] },
                    "targetDto": { "type": "string", "description": "DTO name (e.g. 'UserDto')" },
                    "field": { "type": "string", "description": "Wire field being modified (e.g. 'firstName')" },
                    "renameTo": { "type": "string", "description": "New field name (RENAME_FIELD only)" },
                    "jsonPropertyRetained": { "type": "boolean", "description": "If true the rename preserves the wire contract; nothing is applied" }
                },
                "description": "Symbolic DTO mutation, identical to sajimora_what_if. Only RENAME_FIELD and REMOVE_FIELD produce deterministic consumer patches."
            },
            "dryRun": {
                "type": "boolean",
                "description": "Default false. When true, computes and previews the edits without writing any file."
            }
        }),
    );
    schema_map.insert("required".to_string(), json!(["repoRoot", "mutation"]));

    Tool::new(
        TOOL_NAME,
        "Deterministically applies the consumer-side patches (TypeScript client-model property rename/remove, Angular template token replacement) computed for a symbolic DTO mutation. Atomic writes, fail-closed abstentions, idempotent, dry-run supported. Does not edit Java provider code or arbitrary call-site reads; re-check with sajimora_verify afterwards.",
        Arc::new(schema_map),
    )
}

/// A deterministic, safely-applicable consumer-side edit.
#[derive(Debug, Clone)]
enum Patch {
    RenameModelProperty {
        file: String,
        type_name: String,
        field: String,
        replacement: String,
    },
    RemoveModelProperty {
        file: String,
        type_name: String,
        field: String,
    },
    ReplaceTemplateToken {
        file: String,
        line: usize,
        target: String,
        replacement: String,
    },
}

impl Patch {
    fn file(&self) -> &str {
        match self {
            Patch::RenameModelProperty { file, .. }
            | Patch::RemoveModelProperty { file, .. }
            | Patch::ReplaceTemplateToken { file, .. } => file,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            Patch::RenameModelProperty { .. } => "RENAME_MODEL_PROPERTY",
            Patch::RemoveModelProperty { .. } => "REMOVE_MODEL_PROPERTY",
            Patch::ReplaceTemplateToken { .. } => "REPLACE_TEMPLATE_EXPRESSION",
        }
    }
}

struct Plan {
    patches: Vec<Patch>,
    /// Advisory items that cannot be applied deterministically (manual review).
    abstentions: Vec<Value>,
}

pub fn run_apply_patches(
    allowed_roots: &[PathBuf],
    args: &serde_json::Map<String, Value>,
) -> Result<String> {
    if allowed_roots.is_empty() {
        bail!("{TOOL_NAME} requires at least one server-configured allowed root");
    }

    let repo_arg = args
        .get("repoRoot")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .context("Missing required argument: 'repoRoot'")?;
    let repo_path = PathBuf::from(repo_arg);
    if !repo_path.is_absolute() {
        bail!("repoRoot must be an absolute path");
    }
    let repo_root = resolve_repo_root(&repo_path, allowed_roots)?;
    let dry_run = args.get("dryRun").and_then(Value::as_bool).unwrap_or(false);

    let mutation = args
        .get("mutation")
        .and_then(Value::as_object)
        .context("Missing required argument: 'mutation'")?;
    let action = mutation
        .get("action")
        .and_then(Value::as_str)
        .context("mutation.action is required")?
        .to_ascii_uppercase();
    let target_dto = mutation
        .get("targetDto")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .context("mutation.targetDto is required")?;
    let field = mutation
        .get("field")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .context("mutation.field is required")?;
    let rename_to = mutation
        .get("renameTo")
        .and_then(Value::as_str)
        .unwrap_or("");
    let json_property_retained = mutation
        .get("jsonPropertyRetained")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let db_path = match sync_if_needed(&repo_root) {
        Ok(p) => p,
        Err(e) => {
            return Ok(json!({
                "schemaVersion": "SAJIMORA_APPLY_PATCHES_V1",
                "error": "SEALED_BASELINE_MISSING",
                "message": format!("Contract baseline error: {e}. Run 'sajimora init' to seal contracts."),
                "repoRoot": repo_root.display().to_string(),
            })
            .to_string());
        }
    };
    let conn = open_reader(&db_path)?;

    // Honest early exits: nothing deterministic to apply.
    if !matches!(action.as_str(), "RENAME_FIELD" | "REMOVE_FIELD") {
        return Ok(note_response(&action, target_dto, field, dry_run, &format!(
            "Action '{action}' produces no deterministic consumer patches; handle it manually and re-verify."
        )));
    }
    if action == "RENAME_FIELD" {
        if rename_to.is_empty() {
            bail!("RENAME_FIELD requires mutation.renameTo");
        }
        if json_property_retained {
            return Ok(note_response(&action, target_dto, field, dry_run,
                "Rename retains @JsonProperty wire compatibility; no consumer patch is required."));
        }
    }

    let matched_type_refs = resolve_dto_type_refs(&conn, target_dto)?;
    if matched_type_refs.is_empty() {
        return Ok(note_response(&action, target_dto, field, dry_run, &format!(
            "'{target_dto}' is not present in the indexed type pool; nothing to apply."
        )));
    }
    if !dto_has_field(&conn, &matched_type_refs, field)? {
        return Ok(note_response(&action, target_dto, field, dry_run, &format!(
            "The indexed shape of '{target_dto}' does not declare '{field}'; nothing to apply."
        )));
    }
    if action == "REMOVE_FIELD" {
        if let Some(is_consumed) = client_type_declares_field(&conn, target_dto, field)? {
            if !is_consumed {
                return Ok(note_response(&action, target_dto, field, dry_run, &format!(
                    "Field '{field}' is unconsumed by any active client contract; nothing to apply."
                )));
            }
        }
    }

    let template_matches = scan_html_templates(&repo_root, target_dto, field).unwrap_or_default();
    let plan = build_plan(&matched_type_refs, &template_matches, &action, field, rename_to);

    let mut applied: Vec<Value> = Vec::new();
    let mut abstentions: Vec<Value> = plan.abstentions.clone();
    let mut no_ops: Vec<Value> = Vec::new();
    // In-memory overlay so multiple patches to one file compose and dry-run never writes.
    let mut overlay: BTreeMap<PathBuf, String> = BTreeMap::new();
    let mut modified_files: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();

    for patch in &plan.patches {
        let rel = patch.file();
        let clean_rel = rel.trim_start_matches(|c| c == '/' || c == '\\').replace('\\', "/");
        let full = repo_root.join(&clean_rel);
        let full = match validate_path_under_roots(&full, allowed_roots) {
            Ok(p) => p,
            Err(e) => {
                abstentions.push(json!({
                    "code": "APPLY_PATH_OUTSIDE_ROOT", "file": rel, "reason": format!("{e:#}")
                }));
                continue;
            }
        };

        let current = match overlay.get(&full) {
            Some(s) => s.clone(),
            None => match fs::read_to_string(&full) {
                Ok(s) => s,
                Err(e) => {
                    abstentions.push(json!({
                        "code": "APPLY_FILE_UNREADABLE", "file": rel, "reason": format!("{e}")
                    }));
                    continue;
                }
            },
        };

        match apply_one(patch, &current) {
            Ok(Edit::Changed(new_content)) => {
                let pre = hex::encode(Sha256::digest(current.as_bytes()));
                let post = hex::encode(Sha256::digest(new_content.as_bytes()));
                overlay.insert(full.clone(), new_content);
                modified_files.insert(full.clone());
                applied.push(json!({
                    "file": rel,
                    "type": patch.kind(),
                    "written": !dry_run,
                    "prePatchHash": pre,
                    "postPatchHash": post,
                }));
            }
            Ok(Edit::NoOp(reason)) => {
                no_ops.push(json!({ "file": rel, "type": patch.kind(), "reason": reason }));
            }
            Err(reason) => {
                abstentions.push(json!({
                    "code": "APPLY_ABSTAINED", "file": rel, "type": patch.kind(), "reason": reason
                }));
            }
        }
    }

    // Atomic batch commit: write each modified file at most once.
    if !dry_run {
        for full in &modified_files {
            if let Some(new_content) = overlay.get(full) {
                if let Err(e) = write_atomic(full, new_content) {
                    let rel = full.strip_prefix(&repo_root).unwrap_or(full).to_string_lossy();
                    abstentions.push(json!({
                        "code": "APPLY_WRITE_FAILED",
                        "file": rel,
                        "reason": format!("{e:#}")
                    }));
                }
            }
        }
    }

    let summary = json!({
        "schemaVersion": "SAJIMORA_APPLY_PATCHES_V1",
        "dryRun": dry_run,
        "action": action,
        "targetDto": target_dto,
        "field": field,
        "planned": plan.patches.len(),
        "applied": applied,
        "noOps": no_ops,
        "abstentions": abstentions,
        "counts": {
            "applied": applied.len(),
            "noOp": no_ops.len(),
            "abstained": abstentions.len(),
        },
        "notice": "Deterministic consumer-side patches only. Java provider edits and call-site reads are not applied; re-check with sajimora_verify.",
    });
    Ok(summary.to_string())
}

fn note_response(action: &str, dto: &str, field: &str, dry_run: bool, note: &str) -> String {
    json!({
        "schemaVersion": "SAJIMORA_APPLY_PATCHES_V1",
        "dryRun": dry_run,
        "action": action,
        "targetDto": dto,
        "field": field,
        "note": note,
        "planned": 0,
        "applied": [],
        "noOps": [],
        "abstentions": [],
        "counts": { "applied": 0, "noOp": 0, "abstained": 0 },
        "notice": "Nothing applied.",
    })
    .to_string()
}

/// Build the same consumer patch plan `what_if` emits, uncapped and typed. Pure:
/// the DB-derived inputs are resolved by the caller.
fn build_plan(
    matched_type_refs: &[String],
    template_matches: &[TemplateConsumerMatch],
    action: &str,
    field: &str,
    rename_to: &str,
) -> Plan {
    let mut plan = Plan {
        patches: Vec::new(),
        abstentions: Vec::new(),
    };

    // 1. Client TypeScript model patches (keep the '#TypeName' so edits are targeted).
    for tr in matched_type_refs {
        if let Some(stripped) = tr.strip_prefix("ts:") {
            let (file_part, type_name) = match stripped.split_once('#') {
                Some((f, t)) => (f.to_string(), t.to_string()),
                None => (stripped.to_string(), String::new()),
            };
            if type_name.is_empty() {
                plan.abstentions.push(json!({
                    "code": "APPLY_TYPE_REF_NO_NAME", "file": file_part,
                    "reason": "Client type ref has no '#TypeName'; cannot target the declaration safely."
                }));
                continue;
            }
            if action == "RENAME_FIELD" {
                plan.patches.push(Patch::RenameModelProperty {
                    file: file_part,
                    type_name,
                    field: field.to_string(),
                    replacement: rename_to.to_string(),
                });
            } else {
                plan.patches.push(Patch::RemoveModelProperty {
                    file: file_part,
                    type_name,
                    field: field.to_string(),
                });
            }
        }
    }

    // 2. Angular template patches.
    for tm in template_matches {
        if action == "RENAME_FIELD" {
            let replacement = replace_property_token(&tm.matched_token, field, rename_to);
            plan.patches.push(Patch::ReplaceTemplateToken {
                file: tm.file.clone(),
                line: tm.line,
                target: tm.matched_token.clone(),
                replacement,
            });
        } else {
            // Removing a bound field needs a fallback decision; never auto-apply.
            plan.abstentions.push(json!({
                "code": "APPLY_MANUAL_REVIEW",
                "file": tm.file,
                "line": tm.line,
                "reason": format!("Removed field '{}' binding '{}' needs a fallback or removal decision.", field, tm.matched_token),
            }));
        }
    }

    plan
}

/// Safely replace a property access in a template token (e.g. `user.firstName` -> `user.givenName`,
/// `user?.firstName` -> `user?.givenName`), without corrupting subtoken prefixes like `username.name`.
pub fn replace_property_token(matched: &str, field: &str, rename_to: &str) -> String {
    let safe_dot = format!(".{field}");
    if let Some(pos) = matched.rfind(&safe_dot) {
        let end = pos + safe_dot.len();
        if end == matched.len()
            || !matched[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
        {
            let mut out = String::with_capacity(matched.len() + rename_to.len());
            out.push_str(&matched[..pos]);
            out.push('.');
            out.push_str(rename_to);
            out.push_str(&matched[end..]);
            return out;
        }
    }
    if matched == field {
        return rename_to.to_string();
    }
    matched.replace(field, rename_to)
}

#[derive(Debug)]
enum Edit {
    Changed(String),
    NoOp(String),
}

fn apply_one(patch: &Patch, source: &str) -> std::result::Result<Edit, String> {
    match patch {
        Patch::RenameModelProperty {
            file,
            type_name,
            field,
            replacement,
        } => edit_ts_property(file, source, type_name, field, Some(replacement)),
        Patch::RemoveModelProperty {
            file,
            type_name,
            field,
        } => edit_ts_property(file, source, type_name, field, None),
        Patch::ReplaceTemplateToken {
            line,
            target,
            replacement,
            ..
        } => edit_template_line(source, *line, target, replacement),
    }
}

/// AST-targeted rename (Some) or remove (None) of a single property in a named
/// TS interface / type alias / class. Preserves all non-target bytes.
/// Supports both .ts and .tsx grammars.
fn edit_ts_property(
    file: &str,
    source: &str,
    type_name: &str,
    field: &str,
    replacement: Option<&str>,
) -> std::result::Result<Edit, String> {
    let mut parser = Parser::new();
    let is_tsx = file.ends_with(".tsx") || file.ends_with(".jsx");
    let grammar: tree_sitter::Language = if is_tsx {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    parser
        .set_language(&grammar)
        .map_err(|e| format!("TS parser init failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "TS parse failed".to_string())?;
    let root = tree.root_node();

    let mut declarations = Vec::new();
    collect_declarations(root, source, type_name, &mut declarations);
    if declarations.is_empty() {
        return Err(format!("APPLY_TYPE_NOT_FOUND: no declaration named '{type_name}'"));
    }

    let mut properties = Vec::new();
    for decl in &declarations {
        collect_properties(*decl, source, field, &mut properties);
    }

    if properties.is_empty() {
        // Idempotence: a rename whose target is already the replacement is a no-op.
        if let Some(new_name) = replacement {
            let mut renamed = Vec::new();
            for decl in &declarations {
                collect_properties(*decl, source, new_name, &mut renamed);
            }
            if !renamed.is_empty() {
                return Ok(Edit::NoOp("ALREADY_APPLIED".to_string()));
            }
            return Err(format!("APPLY_PROPERTY_NOT_FOUND: '{field}' not declared in '{type_name}'"));
        }
        // Remove of an already-absent property is an idempotent no-op.
        return Ok(Edit::NoOp("ALREADY_ABSENT".to_string()));
    }
    if properties.len() > 1 {
        return Err(format!(
            "APPLY_AMBIGUOUS_MATCH: '{}' occurs {} times in '{type_name}'",
            field,
            properties.len()
        ));
    }

    let prop = properties[0];
    match replacement {
        Some(new_name) => {
            let name_node = property_name_node(prop)
                .ok_or_else(|| "APPLY_PROPERTY_NAME_UNRESOLVED".to_string())?;
            let range = name_node.byte_range();
            let mut out = String::with_capacity(source.len() + new_name.len());
            out.push_str(&source[..range.start]);
            out.push_str(new_name);
            out.push_str(&source[range.end..]);
            Ok(Edit::Changed(out))
        }
        None => {
            let start_row = prop.start_position().row;
            let end_row = prop.end_position().row;
            if start_row != end_row {
                return Err("APPLY_MULTILINE_PROPERTY: refusing to remove a multi-line declaration".to_string());
            }
            remove_line(source, start_row)
                .map(Edit::Changed)
                .ok_or_else(|| "APPLY_LINE_OUT_OF_BOUNDS".to_string())
        }
    }
}

fn collect_declarations<'a>(node: Node<'a>, source: &str, type_name: &str, out: &mut Vec<Node<'a>>) {
    if matches!(
        node.kind(),
        "interface_declaration" | "type_alias_declaration" | "class_declaration"
    ) && declaration_name(node, source).as_deref() == Some(type_name) {
        out.push(node);
    }
    for i in 0..node.named_child_count() as u32 {
        if let Some(child) = node.named_child(i) {
            collect_declarations(child, source, type_name, out);
        }
    }
}

fn declaration_name(node: Node, source: &str) -> Option<String> {
    for i in 0..node.named_child_count() as u32 {
        if let Some(child) = node.named_child(i) {
            if matches!(child.kind(), "type_identifier" | "identifier") {
                return Some(source[child.byte_range()].to_string());
            }
        }
    }
    None
}

fn collect_properties<'a>(node: Node<'a>, source: &str, field: &str, out: &mut Vec<Node<'a>>) {
    if matches!(node.kind(), "property_signature" | "public_field_definition") {
        if let Some(name_node) = property_name_node(node) {
            if &source[name_node.byte_range()] == field {
                out.push(node);
            }
        }
    }
    for i in 0..node.named_child_count() as u32 {
        if let Some(child) = node.named_child(i) {
            collect_properties(child, source, field, out);
        }
    }
}

fn property_name_node(node: Node) -> Option<Node> {
    for i in 0..node.named_child_count() as u32 {
        if let Some(child) = node.named_child(i) {
            if child.kind() == "property_identifier" {
                return Some(child);
            }
        }
    }
    None
}

/// Replace the exact target token on a 1-indexed line. Idempotent and fail-closed.
fn edit_template_line(
    source: &str,
    line: usize,
    target: &str,
    replacement: &str,
) -> std::result::Result<Edit, String> {
    if line == 0 {
        return Err("APPLY_LINE_OUT_OF_BOUNDS: line is 1-indexed".to_string());
    }
    let idx = line - 1;
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    if idx >= lines.len() {
        return Err("APPLY_LINE_OUT_OF_BOUNDS".to_string());
    }
    let original = lines[idx];
    if original.contains(target) {
        let updated = original.replace(target, replacement);
        let mut out = String::with_capacity(source.len() + updated.len());
        for (i, l) in lines.iter().enumerate() {
            if i == idx {
                out.push_str(&updated);
            } else {
                out.push_str(l);
            }
        }
        return Ok(Edit::Changed(out));
    }
    if original.contains(replacement) {
        return Ok(Edit::NoOp("ALREADY_APPLIED".to_string()));
    }
    Err(format!("APPLY_TARGET_NOT_FOUND: '{target}' not present on line {line}"))
}

/// Remove a single 0-indexed line (including its newline), preserving all others.
fn remove_line(source: &str, row: usize) -> Option<String> {
    let mut start = 0usize;
    for (i, line) in source.split_inclusive('\n').enumerate() {
        if i == row {
            let end = start + line.len();
            return Some(format!("{}{}", &source[..start], &source[end..]));
        }
        start += line.len();
    }
    None
}

fn write_atomic(dest: &Path, content: &str) -> Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_path = parent.join(format!(".sajimora_apply_{}_{}.tmp", std::process::id(), nanos));
    fs::write(&temp_path, content)?;
    if let Err(e) = replace_output(&temp_path, dest) {
        let _ = fs::remove_file(&temp_path);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(source, dest)
}

#[cfg(windows)]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 2 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS: &str = "export interface UserDto {\n  firstName: string;\n  lastName: string;\n}\n";

    #[test]
    fn rename_property_preserves_other_bytes() {
        let out = edit_ts_property("types.ts", TS, "UserDto", "firstName", Some("givenName")).unwrap();
        match out {
            Edit::Changed(s) => {
                assert!(s.contains("givenName: string;"));
                assert!(s.contains("lastName: string;"));
                assert!(!s.contains("firstName"));
                assert_eq!(s.lines().count(), TS.lines().count());
            }
            _ => panic!("expected change"),
        }
    }

    #[test]
    fn rename_is_idempotent() {
        let first = match edit_ts_property("types.ts", TS, "UserDto", "firstName", Some("givenName")).unwrap() {
            Edit::Changed(s) => s,
            _ => panic!(),
        };
        let second = edit_ts_property("types.ts", &first, "UserDto", "firstName", Some("givenName")).unwrap();
        assert!(matches!(second, Edit::NoOp(_)));
    }

    #[test]
    fn remove_property_drops_only_that_line() {
        let out = edit_ts_property("types.ts", TS, "UserDto", "firstName", None).unwrap();
        match out {
            Edit::Changed(s) => {
                assert!(!s.contains("firstName"));
                assert!(s.contains("lastName: string;"));
                assert_eq!(s.lines().count(), TS.lines().count() - 1);
            }
            _ => panic!("expected change"),
        }
    }

    #[test]
    fn remove_absent_property_is_noop() {
        let out = edit_ts_property("types.ts", TS, "UserDto", "nickname", None).unwrap();
        assert!(matches!(out, Edit::NoOp(_)));
    }

    #[test]
    fn missing_type_abstains() {
        let err = edit_ts_property("types.ts", TS, "Missing", "firstName", Some("x")).unwrap_err();
        assert!(err.contains("APPLY_TYPE_NOT_FOUND"));
    }

    #[test]
    fn ambiguous_property_abstains() {
        let dup = "interface D {\n  a: string;\n}\ninterface D {\n  a: number;\n}\n";
        let err = edit_ts_property("types.ts", dup, "D", "a", Some("b")).unwrap_err();
        assert!(err.contains("APPLY_AMBIGUOUS_MATCH"));
    }

    #[test]
    fn tsx_grammar_parses_jsx_elements() {
        let tsx = "export interface UserProps {\n  firstName: string;\n}\nexport const View = (p: UserProps) => <div className=\"user\">{p.firstName}</div>;\n";
        let out = edit_ts_property("UserView.tsx", tsx, "UserProps", "firstName", Some("givenName")).unwrap();
        match out {
            Edit::Changed(s) => {
                assert!(s.contains("givenName: string;"));
                assert!(s.contains("<div className=\"user\">{p.firstName}</div>"));
            }
            _ => panic!("expected change"),
        }
    }

    #[test]
    fn template_token_replacement_avoids_prefix_collisions() {
        // A naive replace would turn username.name into usergivenName.givenName
        assert_eq!(
            replace_property_token("username.name", "name", "givenName"),
            "username.givenName"
        );
        assert_eq!(
            replace_property_token("user?.name", "name", "givenName"),
            "user?.givenName"
        );
        assert_eq!(
            replace_property_token("user.firstName", "firstName", "givenName"),
            "user.givenName"
        );
        assert_eq!(
            replace_property_token("this.account.name", "name", "givenName"),
            "this.account.givenName"
        );
        assert_eq!(
            replace_property_token("name", "name", "givenName"),
            "givenName"
        );
    }

    #[test]
    fn template_replace_targets_only_the_line() {
        let src = "<p>{{ user.firstName }}</p>\n<p>{{ user.lastName }}</p>\n";
        let out = edit_template_line(src, 1, "user.firstName", "user.givenName").unwrap();
        match out {
            Edit::Changed(s) => {
                assert!(s.contains("user.givenName"));
                assert!(s.contains("user.lastName"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn template_replace_idempotent_and_fail_closed() {
        let src = "<p>{{ user.givenName }}</p>\n";
        assert!(matches!(
            edit_template_line(src, 1, "user.firstName", "user.givenName").unwrap(),
            Edit::NoOp(_)
        ));
        let err = edit_template_line("<p>hello</p>\n", 1, "user.firstName", "x").unwrap_err();
        assert!(err.contains("APPLY_TARGET_NOT_FOUND"));
    }

    #[test]
    fn remove_line_preserves_remaining_lines() {
        let src = "a\nb\nc\n";
        assert_eq!(remove_line(src, 1).unwrap(), "a\nc\n");
    }
}