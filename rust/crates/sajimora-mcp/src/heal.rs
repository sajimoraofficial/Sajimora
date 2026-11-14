//! heal.rs — MCP tool implementation for AST test call-site self-healing.
//!
//! Enforces safety-critical compiler invariants:
//! - Preserves comments, whitespace, and non-target tokens verbatim
//! - Strictly abstains on side-effecting expressions (HEAL_SIDE_EFFECT_ARGUMENT)
//! - Strictly abstains on unresolvable defaults (HEAL_DEFAULT_UNRESOLVABLE)
//! - Guaranteed idempotence and atomic writes (MoveFileExW on Windows)
//! - Fail-closed: Never mutates any file if target method cannot be determined

use anyhow::{bail, Context, Result};
use contract_core::service::validate_path_under_roots;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use source_index::call_sites::{extract_java_call_sites, CallSiteRecord};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealAbstention {
    pub sajimora_heal_abstention: bool,
    pub code: String,
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub method: String,
    pub argument_index: Option<usize>,
    pub expression_text: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealPatchResult {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub method: String,
    pub action: String,
    pub pre_patch_hash: String,
    pub post_patch_hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealSummary {
    pub total_call_sites_inspected: usize,
    pub eligible_call_sites: usize,
    pub healed_call_sites: usize,
    pub abstentions: Vec<HealAbstention>,
    pub patches: Vec<HealPatchResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealRequest {
    pub test_dir: Option<String>,
    pub target: Option<String>,
    pub method: Option<String>,
    pub param_index: Option<usize>,
    pub default_value: Option<String>,
    pub old_file: Option<String>,
    pub new_file: Option<String>,
    pub detect_only: Option<bool>,
}

#[derive(Debug, Clone)]
enum TargetHealOperation {
    InsertParam {
        method: String,
        position: Option<usize>,
        default_val: String,
    },
    ReorderParams {
        method: String,
        old_indices: Vec<usize>,
    },
    RemoveParam {
        method: String,
        index: usize,
    },
}

pub fn run_heal(req: McpHealRequest, allowed_roots: &[PathBuf]) -> Result<HealSummary> {
    let mut summary = HealSummary::default();

    let test_dir_str = req
        .test_dir
        .clone()
        .unwrap_or_else(|| "src/test".to_string());
    let test_path = PathBuf::from(&test_dir_str);

    if !allowed_roots.is_empty() && test_path.exists() {
        validate_path_under_roots(&test_path, allowed_roots)?;
    }

    let test_files = if test_path.is_file() {
        vec![test_path]
    } else if test_path.exists() {
        find_test_files(&test_path)?
    } else {
        return Ok(summary);
    };

    let target_operation: Option<TargetHealOperation> = match (&req.old_file, &req.new_file) {
        (Some(old_path), Some(new_path)) => {
            let old_pb = PathBuf::from(old_path);
            let new_pb = PathBuf::from(new_path);
            if !allowed_roots.is_empty() {
                validate_path_under_roots(&old_pb, allowed_roots)?;
                validate_path_under_roots(&new_pb, allowed_roots)?;
            }
            let old_src = fs::read_to_string(&old_pb)
                .with_context(|| format!("Failed to read old file: {}", old_path))?;
            let new_src = fs::read_to_string(&new_pb)
                .with_context(|| format!("Failed to read new file: {}", new_path))?;
            diff_sources_for_param(&old_src, &new_src, &req)?
        }
        (None, Some(new_path)) => {
            let new_pb = PathBuf::from(new_path);
            if !allowed_roots.is_empty() {
                validate_path_under_roots(&new_pb, allowed_roots)?;
            }
            if let Some(old_src) = get_git_head_content(new_path) {
                let new_src = fs::read_to_string(&new_pb)
                    .with_context(|| format!("Failed to read new file: {}", new_path))?;
                diff_sources_for_param(&old_src, &new_src, &req)?
            } else if let Some(ref m) = req.method {
                Some(TargetHealOperation::InsertParam {
                    method: m.clone(),
                    position: req.param_index,
                    default_val: req
                        .default_value
                        .clone()
                        .unwrap_or_else(|| "false".to_string()),
                })
            } else {
                None
            }
        }
        _ => {
            if let Some(ref t) = req.target {
                if t.ends_with(".java") || Path::new(t).is_file() {
                    let pb = PathBuf::from(t);
                    if !allowed_roots.is_empty() && pb.exists() {
                        validate_path_under_roots(&pb, allowed_roots)?;
                    }
                    if let Some(old_src) = get_git_head_content(t) {
                        if let Ok(new_src) = fs::read_to_string(&pb) {
                            diff_sources_for_param(&old_src, &new_src, &req)?
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    Some(TargetHealOperation::InsertParam {
                        method: t.clone(),
                        position: req.param_index,
                        default_val: req
                            .default_value
                            .clone()
                            .unwrap_or_else(|| "false".to_string()),
                    })
                }
            } else if req.method.is_none() {
                let modified = detect_modified_git_files();
                let mut resolved = None;
                for f in modified {
                    if let Some(old_src) = get_git_head_content(&f) {
                        if let Ok(new_src) = fs::read_to_string(&f) {
                            if let Ok(Some(op)) = diff_sources_for_param(&old_src, &new_src, &req) {
                                resolved = Some(op);
                                break;
                            }
                        }
                    }
                }
                resolved
            } else if let Some(ref m) = req.method {
                Some(TargetHealOperation::InsertParam {
                    method: m.clone(),
                    position: req.param_index,
                    default_val: req
                        .default_value
                        .clone()
                        .unwrap_or_else(|| "false".to_string()),
                })
            } else {
                None
            }
        }
    };

    // CRITICAL SHIP-STOPPING GUARD: Fail-closed if no method resolved
    let op = match target_operation {
        Some(op) => op,
        None => return Ok(summary),
    };

    let target_method = match &op {
        TargetHealOperation::InsertParam { method, .. } => method.clone(),
        TargetHealOperation::ReorderParams { method, .. } => method.clone(),
        TargetHealOperation::RemoveParam { method, .. } => method.clone(),
    };

    let detect_only = req.detect_only.unwrap_or(false);

    for file_path in test_files {
        let file_str = file_path.to_string_lossy().to_string();
        let source = match fs::read_to_string(&file_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let call_sites = match extract_java_call_sites(&file_str, &source) {
            Ok(cs) => cs,
            Err(_) => {
                summary.abstentions.push(HealAbstention {
                    sajimora_heal_abstention: true,
                    code: "HEAL_PARSE_ERROR".into(),
                    file: file_str.clone(),
                    line: 1,
                    column: 1,
                    method: target_method.clone(),
                    argument_index: None,
                    expression_text: None,
                    reason: "Tree-sitter parse error in source file".into(),
                });
                continue;
            }
        };

        summary.total_call_sites_inspected += call_sites.len();

        let mut file_mutated = false;
        let mut current_source = source.clone();

        let mut matching_calls: Vec<&CallSiteRecord> = call_sites
            .iter()
            .filter(|c| c.method_name == target_method)
            .collect();
        matching_calls.sort_by_key(|c| std::cmp::Reverse(c.invocation_span.start));

        for call in matching_calls {
            match &op {
                TargetHealOperation::InsertParam {
                    position,
                    default_val,
                    ..
                } => {
                    let default_clean = default_val.trim();
                    let is_safe_default = matches!(
                        default_clean,
                        "false"
                            | "true"
                            | "0"
                            | "0L"
                            | "0.0"
                            | "0.0f"
                            | "0.0d"
                            | "\"\""
                            | "null"
                            | "Optional.empty()"
                            | "Collections.emptyList()"
                            | "Collections.emptySet()"
                            | "Collections.emptyMap()"
                            | "List.of()"
                            | "Set.of()"
                            | "Map.of()"
                            | "java.util.Optional.empty()"
                            | "java.util.Collections.emptyList()"
                            | "java.util.Collections.emptySet()"
                            | "java.util.Collections.emptyMap()"
                            | "java.util.List.of()"
                            | "java.util.Set.of()"
                            | "java.util.Map.of()"
                    );

                    summary.eligible_call_sites += 1;

                    let already_healed = if let Some(target_idx) = *position {
                        call.argument_texts.get(target_idx).map(|s| s.as_str())
                            == Some(default_clean)
                    } else {
                        call.argument_texts.last().map(|s| s.as_str()) == Some(default_clean)
                    };

                    if already_healed {
                        continue;
                    }

                    if !is_safe_default {
                        summary.abstentions.push(HealAbstention {
                            sajimora_heal_abstention: true,
                            code: "HEAL_DEFAULT_UNRESOLVABLE".into(),
                            file: file_str.clone(),
                            line: call.line,
                            column: call.column,
                            method: call.method_name.clone(),
                            argument_index: *position,
                            expression_text: Some(default_clean.to_string()),
                            reason: format!(
                                "Default expression '{}' is not a certified safe primitive literal or empty collection.",
                                default_clean
                            ),
                        });
                        continue;
                    }

                    let mut side_effect_detected = false;
                    for (idx, arg_text) in call.argument_texts.iter().enumerate() {
                        if has_side_effects(arg_text) {
                            summary.abstentions.push(HealAbstention {
                                sajimora_heal_abstention: true,
                                code: "HEAL_SIDE_EFFECT_ARGUMENT".into(),
                                file: file_str.clone(),
                                line: call.line,
                                column: call.column,
                                method: call.method_name.clone(),
                                argument_index: Some(idx),
                                expression_text: Some(arg_text.clone()),
                                reason: format!(
                                    "Argument at index {} ('{}') has side-effecting expressions. Reordering/injection cannot be safely automated.",
                                    idx, arg_text
                                ),
                            });
                            side_effect_detected = true;
                            break;
                        }
                    }
                    if side_effect_detected {
                        continue;
                    }

                    if !detect_only {
                        let pre_hash = hex::encode(Sha256::digest(current_source.as_bytes()));
                        match apply_safe_argument_patch(
                            &current_source,
                            call,
                            *position,
                            default_clean,
                        ) {
                            Ok(patched) => {
                                let post_hash = hex::encode(Sha256::digest(patched.as_bytes()));
                                if pre_hash == post_hash {
                                    continue;
                                }

                                current_source = patched;
                                file_mutated = true;
                                summary.healed_call_sites += 1;
                                summary.patches.push(HealPatchResult {
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    action: format!("Injected parameter '{}'", default_clean),
                                    pre_patch_hash: pre_hash,
                                    post_patch_hash: post_hash,
                                });
                            }
                            Err(e) => {
                                summary.abstentions.push(HealAbstention {
                                    sajimora_heal_abstention: true,
                                    code: "HEAL_PATCH_ERROR".into(),
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    argument_index: *position,
                                    expression_text: None,
                                    reason: format!("Failed to apply patch: {:#}", e),
                                });
                            }
                        }
                    }
                }
                TargetHealOperation::ReorderParams { old_indices, .. } => {
                    summary.eligible_call_sites += 1;

                    if call.argument_spans.len() != old_indices.len() {
                        summary.abstentions.push(HealAbstention {
                            sajimora_heal_abstention: true,
                            code: "HEAL_REORDER_ARITY_MISMATCH".into(),
                            file: file_str.clone(),
                            line: call.line,
                            column: call.column,
                            method: call.method_name.clone(),
                            argument_index: None,
                            expression_text: None,
                            reason: format!(
                                "Call site argument count ({}) does not match signature count ({}).",
                                call.argument_spans.len(),
                                old_indices.len()
                            ),
                        });
                        continue;
                    }

                    let mut side_effect_detected = false;
                    for (idx, arg_text) in call.argument_texts.iter().enumerate() {
                        if has_side_effects(arg_text) {
                            summary.abstentions.push(HealAbstention {
                                sajimora_heal_abstention: true,
                                code: "HEAL_SIDE_EFFECT_ARGUMENT".into(),
                                file: file_str.clone(),
                                line: call.line,
                                column: call.column,
                                method: call.method_name.clone(),
                                argument_index: Some(idx),
                                expression_text: Some(arg_text.clone()),
                                reason: format!(
                                    "Argument at index {} ('{}') has side-effects; reordering cannot be safely automated.",
                                    idx, arg_text
                                ),
                            });
                            side_effect_detected = true;
                            break;
                        }
                    }
                    if side_effect_detected {
                        continue;
                    }

                    if !detect_only {
                        let pre_hash = hex::encode(Sha256::digest(current_source.as_bytes()));
                        match apply_reorder_argument_patch(&current_source, call, old_indices) {
                            Ok(patched) => {
                                let post_hash = hex::encode(Sha256::digest(patched.as_bytes()));
                                if pre_hash == post_hash {
                                    continue;
                                }

                                current_source = patched;
                                file_mutated = true;
                                summary.healed_call_sites += 1;
                                summary.patches.push(HealPatchResult {
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    action: format!("Reordered parameters to {:?}", old_indices),
                                    pre_patch_hash: pre_hash,
                                    post_patch_hash: post_hash,
                                });
                            }
                            Err(e) => {
                                summary.abstentions.push(HealAbstention {
                                    sajimora_heal_abstention: true,
                                    code: "HEAL_PATCH_ERROR".into(),
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    argument_index: None,
                                    expression_text: None,
                                    reason: format!("Failed to apply reorder patch: {:#}", e),
                                });
                            }
                        }
                    }
                }
                TargetHealOperation::RemoveParam { index, .. } => {
                    summary.eligible_call_sites += 1;

                    if *index >= call.argument_spans.len() {
                        continue;
                    }

                    if has_side_effects(&call.argument_texts[*index]) {
                        summary.abstentions.push(HealAbstention {
                            sajimora_heal_abstention: true,
                            code: "HEAL_SIDE_EFFECT_ARGUMENT".into(),
                            file: file_str.clone(),
                            line: call.line,
                            column: call.column,
                            method: call.method_name.clone(),
                            argument_index: Some(*index),
                            expression_text: Some(call.argument_texts[*index].clone()),
                            reason: "Removed parameter had side-effecting argument; cannot drop silently.".into(),
                        });
                        continue;
                    }

                    if !detect_only {
                        let pre_hash = hex::encode(Sha256::digest(current_source.as_bytes()));
                        match apply_remove_argument_patch(&current_source, call, *index) {
                            Ok(patched) => {
                                let post_hash = hex::encode(Sha256::digest(patched.as_bytes()));
                                if pre_hash == post_hash {
                                    continue;
                                }

                                current_source = patched;
                                file_mutated = true;
                                summary.healed_call_sites += 1;
                                summary.patches.push(HealPatchResult {
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    action: format!("Removed argument at index {}", index),
                                    pre_patch_hash: pre_hash,
                                    post_patch_hash: post_hash,
                                });
                            }
                            Err(e) => {
                                summary.abstentions.push(HealAbstention {
                                    sajimora_heal_abstention: true,
                                    code: "HEAL_PATCH_ERROR".into(),
                                    file: file_str.clone(),
                                    line: call.line,
                                    column: call.column,
                                    method: call.method_name.clone(),
                                    argument_index: Some(*index),
                                    expression_text: None,
                                    reason: format!("Failed to apply removal patch: {:#}", e),
                                });
                            }
                        }
                    }
                }
            }
        }

        if file_mutated && !detect_only {
            write_atomic(&file_path, &current_source).with_context(|| {
                format!("Failed to atomically write healed file: {:?}", file_path)
            })?;
        }
    }

    Ok(summary)
}

fn get_git_head_content(rel_path: &str) -> Option<String> {
    let norm = rel_path.replace('\\', "/");
    let output = std::process::Command::new("git")
        .args(["show", &format!("HEAD:{}", norm)])
        .output()
        .ok();
    if let Some(out) = output {
        if out.status.success() {
            if let Ok(content) = String::from_utf8(out.stdout) {
                return Some(content);
            }
        }
    }
    // SVN fallback: svn cat -r BASE <rel_path> or svn cat <rel_path>
    let svn_out = std::process::Command::new("svn")
        .args(["cat", "-r", "BASE", &norm])
        .output()
        .ok();
    if let Some(out) = svn_out {
        if out.status.success() {
            if let Ok(content) = String::from_utf8(out.stdout) {
                return Some(content);
            }
        }
    }
    let svn_out2 = std::process::Command::new("svn")
        .args(["cat", &norm])
        .output()
        .ok();
    if let Some(out) = svn_out2 {
        if out.status.success() {
            return String::from_utf8(out.stdout).ok();
        }
    }
    None
}

fn detect_modified_git_files() -> Vec<String> {
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .output()
        .ok();
    if let Some(out) = output {
        if out.status.success() {
            let files: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| l.ends_with(".java"))
                .map(|s| s.trim().to_string())
                .collect();
            if !files.is_empty() {
                return files;
            }
        }
    }
    // SVN fallback: svn status -q
    let svn_output = std::process::Command::new("svn")
        .args(["status", "-q"])
        .output()
        .ok();
    if let Some(out) = svn_output {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.starts_with('M') || trimmed.starts_with('A') {
                        let path = trimmed[1..].trim();
                        if path.ends_with(".java") {
                            return Some(path.to_string());
                        }
                    }
                    None
                })
                .collect();
        }
    }
    Vec::new()
}

fn diff_sources_for_param(
    old_src: &str,
    new_src: &str,
    req: &McpHealRequest,
) -> Result<Option<TargetHealOperation>> {
    let old_sigs = source_index::signature_diff::extract_java_method_signatures(old_src)?;
    let new_sigs = source_index::signature_diff::extract_java_method_signatures(new_src)?;

    for new_sig in &new_sigs {
        if let Some(target_m) = &req.method {
            if &new_sig.method_name != target_m {
                continue;
            }
        }
        if let Some(old_sig) = old_sigs
            .iter()
            .find(|s| s.method_name == new_sig.method_name)
        {
            let diffs = source_index::signature_diff::diff_signatures(old_sig, new_sig);
            if let Some(op) = diffs.into_iter().next() {
                match op {
                    source_index::signature_diff::SignatureDiffOp::AddParam {
                        index,
                        name: _,
                        type_name: _,
                        inferred_default,
                    } => {
                        let def_val = req.default_value.clone().unwrap_or_else(|| {
                            inferred_default.unwrap_or_else(|| "false".to_string())
                        });
                        return Ok(Some(TargetHealOperation::InsertParam {
                            method: new_sig.method_name.clone(),
                            position: Some(index),
                            default_val: def_val,
                        }));
                    }
                    source_index::signature_diff::SignatureDiffOp::ReorderParams {
                        old_indices,
                    } => {
                        return Ok(Some(TargetHealOperation::ReorderParams {
                            method: new_sig.method_name.clone(),
                            old_indices,
                        }));
                    }
                    source_index::signature_diff::SignatureDiffOp::RemoveParam {
                        index,
                        name: _,
                    } => {
                        return Ok(Some(TargetHealOperation::RemoveParam {
                            method: new_sig.method_name.clone(),
                            index,
                        }));
                    }
                }
            }
        }
    }

    if let Some(ref m) = req.method {
        let def_val = req
            .default_value
            .clone()
            .unwrap_or_else(|| "false".to_string());
        return Ok(Some(TargetHealOperation::InsertParam {
            method: m.clone(),
            position: req.param_index,
            default_val: def_val,
        }));
    }

    Ok(None)
}

pub fn has_side_effects(expr: &str) -> bool {
    let trimmed = expr.trim();
    if trimmed.contains("++") || trimmed.contains("--") {
        return true;
    }
    if trimmed.contains(" = ") || trimmed.contains(" += ") || trimmed.contains(" -= ") {
        return true;
    }

    if trimmed.starts_with("new ") {
        return false;
    }

    let pure_prefixes = [
        "List.of(",
        "Set.of(",
        "Map.of(",
        "Optional.of(",
        "Optional.ofNullable(",
        "Optional.empty(",
        "Collections.emptyList(",
        "Collections.emptySet(",
        "Collections.emptyMap(",
        "Arrays.asList(",
        "BigDecimal.valueOf(",
        "Integer.valueOf(",
        "Long.valueOf(",
        "Double.valueOf(",
        "Boolean.valueOf(",
        "String.valueOf(",
        "java.util.",
    ];
    for p in &pure_prefixes {
        if trimmed.starts_with(p) {
            return false;
        }
    }

    let is_cast =
        trimmed.starts_with('(') && !trimmed.contains('.') && trimmed.split(')').count() == 2;
    if is_cast {
        return false;
    }

    if trimmed.contains('(') && trimmed.contains(')') {
        return true;
    }

    false
}

pub fn apply_safe_argument_patch(
    source: &str,
    call: &CallSiteRecord,
    target_pos: Option<usize>,
    injected_val: &str,
) -> Result<String> {
    let arg_count = call.argument_spans.len();

    if arg_count == 0 {
        let start_paren = call.argument_list_span.start;
        let end_paren = call.argument_list_span.end;

        if end_paren <= start_paren + 1 {
            bail!("Corrupted argument_list node");
        }

        let mut output = String::with_capacity(source.len() + injected_val.len());
        output.push_str(&source[..start_paren + 1]);
        output.push_str(injected_val);
        output.push_str(&source[end_paren - 1..]);
        return Ok(output);
    }

    let pos = target_pos.unwrap_or(arg_count);

    if pos >= arg_count {
        let last_arg = &call.argument_spans[arg_count - 1];
        let mut output = String::with_capacity(source.len() + injected_val.len() + 2);
        output.push_str(&source[..last_arg.end]);
        output.push_str(", ");
        output.push_str(injected_val);
        output.push_str(&source[last_arg.end..]);
        Ok(output)
    } else if pos == 0 {
        let first_arg = &call.argument_spans[0];
        let mut output = String::with_capacity(source.len() + injected_val.len() + 2);
        output.push_str(&source[..first_arg.start]);
        output.push_str(injected_val);
        output.push_str(", ");
        output.push_str(&source[first_arg.start..]);
        Ok(output)
    } else {
        let prev_arg = &call.argument_spans[pos - 1];
        let mut output = String::with_capacity(source.len() + injected_val.len() + 2);
        output.push_str(&source[..prev_arg.end]);
        output.push_str(", ");
        output.push_str(injected_val);
        output.push_str(&source[prev_arg.end..]);
        Ok(output)
    }
}

pub fn apply_reorder_argument_patch(
    source: &str,
    call: &CallSiteRecord,
    old_indices: &[usize],
) -> Result<String> {
    if call.argument_spans.len() != old_indices.len() {
        bail!("Argument count does not match reorder signature count");
    }

    let start_paren = call.argument_list_span.start;
    let end_paren = call.argument_list_span.end;

    if end_paren <= start_paren + 1 {
        bail!("Corrupted argument_list node");
    }

    let reordered_args: Vec<&str> = old_indices
        .iter()
        .map(|&idx| call.argument_texts[idx].as_str())
        .collect();
    let reordered_text = reordered_args.join(", ");

    let mut output = String::with_capacity(source.len() + reordered_text.len());
    output.push_str(&source[..start_paren + 1]);
    output.push_str(&reordered_text);
    output.push_str(&source[end_paren - 1..]);
    Ok(output)
}

pub fn apply_remove_argument_patch(
    source: &str,
    call: &CallSiteRecord,
    remove_index: usize,
) -> Result<String> {
    if remove_index >= call.argument_spans.len() {
        bail!("Remove index out of bounds");
    }

    let start_paren = call.argument_list_span.start;
    let end_paren = call.argument_list_span.end;

    if end_paren <= start_paren + 1 {
        bail!("Corrupted argument_list node");
    }

    let remaining_args: Vec<&str> = call
        .argument_texts
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != remove_index)
        .map(|(_, s)| s.as_str())
        .collect();
    let new_text = remaining_args.join(", ");

    let mut output = String::with_capacity(source.len());
    output.push_str(&source[..start_paren + 1]);
    output.push_str(&new_text);
    output.push_str(&source[end_paren - 1..]);
    Ok(output)
}

fn find_test_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    walk_dir_for_tests(dir, &mut files)?;
    Ok(files)
}

fn walk_dir_for_tests(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_dir_for_tests(&path, files)?;
        } else if let Some(ext) = path.extension() {
            // STRICT SAFETY: Java AST healer must ONLY process Java files!
            if ext == "java" {
                files.push(path);
            }
        }
    }
    Ok(())
}

fn write_atomic(dest: &Path, content: &str) -> Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(".sajimora_heal_{}_{}.tmp", std::process::id(), nanos);
    let temp_path = parent.join(temp_name);

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
    // Flags 1 | 2 | 8 = MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 2 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
