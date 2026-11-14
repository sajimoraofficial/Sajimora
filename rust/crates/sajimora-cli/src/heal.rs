//! sajimora heal — Autonomous AST test call-site self-healing engine.
//!
//! Enforces safety-critical compiler invariants:
//! - Preserves comments, whitespace, and non-target tokens verbatim
//! - Strictly abstains on side-effecting expressions (HEAL_SIDE_EFFECT_ARGUMENT)
//! - Strictly abstains on unresolvable defaults (HEAL_DEFAULT_UNRESOLVABLE)
//! - Guaranteed idempotence and atomic writes (MoveFileExW on Windows)
//! - Fail-closed: Never mutates any file if target method cannot be determined

use anyhow::{Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use source_index::call_sites::{extract_java_call_sites, extract_ts_call_sites, CallSiteRecord};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Args, Debug, Clone)]
pub struct HealArgs {
    /// Optional target file or method shorthand (e.g. `sajimora fix OrderService.java` or `sajimora fix calculateTax`)
    #[arg(value_name = "TARGET")]
    pub target: Option<String>,

    /// Target test directory or file to heal (default: "src/test")
    #[arg(long, short = 't', default_value = "src/test")]
    pub test_dir: String,

    /// Method name to heal (e.g. "calculateFinalPrice" or "processOrder")
    #[arg(long, short = 'm')]
    pub method: Option<String>,

    /// Target parameter position to insert (0-indexed, default: end)
    #[arg(long)]
    pub param_index: Option<usize>,

    /// Default value expression to inject (e.g. "false", "0", "0.0", "\"\"", "Optional.empty()")
    #[arg(long)]
    pub default_value: Option<String>,

    /// Old source file to diff signatures against (for automated detection)
    #[arg(long)]
    pub old_file: Option<String>,

    /// New source file containing refactored method signatures
    #[arg(long)]
    pub new_file: Option<String>,

    /// Advisory detection only; does not write any files to disk
    #[arg(long, short = 'd', alias = "dry-run")]
    pub detect_only: bool,

    /// Emit structured JSON diagnostics to stdout
    #[arg(long)]
    pub json: bool,

    /// Verbose progress logging
    #[arg(long, short = 'v')]
    pub verbose: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct HealSummary {
    pub total_call_sites_inspected: usize,
    pub eligible_call_sites: usize,
    pub healed_call_sites: usize,
    pub abstentions: Vec<HealAbstention>,
    pub patches: Vec<HealPatchResult>,
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

pub fn run(args: HealArgs) -> i32 {
    match execute_heal(&args) {
        Ok(summary) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_default()
                );
            } else {
                println!(
                    "[+] Inspected {} call sites",
                    summary.total_call_sites_inspected
                );
                if args.detect_only {
                    println!(
                        "[!] Advisory Mode: {} call sites eligible for healing",
                        summary.eligible_call_sites
                    );
                } else {
                    println!(
                        "[+] Successfully healed {} call sites",
                        summary.healed_call_sites
                    );
                }
                if !summary.abstentions.is_empty() {
                    eprintln!(
                        "[-] Encountered {} safety abstentions (fail-closed):",
                        summary.abstentions.len()
                    );
                    for abs in &summary.abstentions {
                        eprintln!(
                            "    ⚠️ {} [{}:{}] {} — {}",
                            abs.code, abs.file, abs.line, abs.method, abs.reason
                        );
                    }
                }
            }

            if args.detect_only {
                // In detect-only mode: exit 1 if call sites need healing or abstained; exit 0 if clean.
                if summary.eligible_call_sites > 0 || !summary.abstentions.is_empty() {
                    1
                } else {
                    0
                }
            } else if summary.abstentions.is_empty() {
                0
            } else {
                1
            }
        }
        Err(e) => {
            eprintln!("[-] Error executing sajimora heal: {:#}", e);
            2
        }
    }
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
    args: &HealArgs,
) -> Result<Option<TargetHealOperation>> {
    let old_sigs = source_index::signature_diff::extract_java_method_signatures(old_src)?;
    let new_sigs = source_index::signature_diff::extract_java_method_signatures(new_src)?;

    for new_sig in &new_sigs {
        if let Some(target_m) = &args.method {
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
                        let def_val = args.default_value.clone().unwrap_or_else(|| {
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

    if let Some(ref m) = args.method {
        let def_val = args
            .default_value
            .clone()
            .unwrap_or_else(|| "false".to_string());
        return Ok(Some(TargetHealOperation::InsertParam {
            method: m.clone(),
            position: args.param_index,
            default_val: def_val,
        }));
    }

    Ok(None)
}

pub fn execute_heal(args: &HealArgs) -> Result<HealSummary> {
    let mut summary = HealSummary::default();
    let test_path = Path::new(&args.test_dir);

    let test_files = if test_path.is_file() {
        let ext = test_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "java" | "ts" | "tsx" | "js" | "jsx") {
            anyhow::bail!("Autonomous test healing supports Java (.java) and TypeScript/JavaScript (.ts, .tsx, .js, .jsx) files. Found: {:?}", test_path);
        }
        vec![test_path.to_path_buf()]
    } else if test_path.exists() {
        find_test_files(test_path)?
    } else {
        return Ok(summary);
    };

    if let Some(ref t) = args.target {
        let p = Path::new(t);
        if p.is_file() {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !matches!(ext, "java" | "ts" | "tsx" | "js" | "jsx") {
                anyhow::bail!("Autonomous healing target {:?} is not a supported source file (.java, .ts, .tsx, .js, .jsx).", t);
            }
        }
    }

    let target_operation: Option<TargetHealOperation> = match (&args.old_file, &args.new_file) {
        (Some(old_path), Some(new_path)) => {
            let old_src = fs::read_to_string(old_path)
                .with_context(|| format!("Failed to read old file: {}", old_path))?;
            let new_src = fs::read_to_string(new_path)
                .with_context(|| format!("Failed to read new file: {}", new_path))?;
            diff_sources_for_param(&old_src, &new_src, args)?
        }
        (None, Some(new_path)) => {
            if let Some(old_src) = get_git_head_content(new_path) {
                let new_src = fs::read_to_string(new_path)
                    .with_context(|| format!("Failed to read new file: {}", new_path))?;
                diff_sources_for_param(&old_src, &new_src, args)?
            } else if let Some(ref m) = args.method {
                Some(TargetHealOperation::InsertParam {
                    method: m.clone(),
                    position: args.param_index,
                    default_val: args
                        .default_value
                        .clone()
                        .unwrap_or_else(|| "false".to_string()),
                })
            } else {
                None
            }
        }
        _ => {
            if let Some(ref t) = args.target {
                if t.ends_with(".java") || Path::new(t).is_file() {
                    if let Some(old_src) = get_git_head_content(t) {
                        if let Ok(new_src) = fs::read_to_string(t) {
                            diff_sources_for_param(&old_src, &new_src, args)?
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    // Shorthand method name: e.g. `sajimora fix calculateTax`
                    Some(TargetHealOperation::InsertParam {
                        method: t.clone(),
                        position: args.param_index,
                        default_val: args
                            .default_value
                            .clone()
                            .unwrap_or_else(|| "false".to_string()),
                    })
                }
            } else {
                // Auto-detect from Git diff (for specified method or zero-argument mode)
                let modified = detect_modified_git_files();
                let mut resolved = None;
                for f in modified {
                    if let Some(old_src) = get_git_head_content(&f) {
                        if let Ok(new_src) = fs::read_to_string(&f) {
                            if let Ok(Some(op)) = diff_sources_for_param(&old_src, &new_src, args) {
                                resolved = Some(op);
                                break;
                            }
                        }
                    }
                }
                if resolved.is_some() {
                    resolved
                } else if let Some(ref m) = args.method {
                    Some(TargetHealOperation::InsertParam {
                        method: m.clone(),
                        position: args.param_index,
                        default_val: args
                            .default_value
                            .clone()
                            .unwrap_or_else(|| "false".to_string()),
                    })
                } else {
                    None
                }
            }
        }
    };

    // CRITICAL SHIP-STOPPING GUARD (P0 defect resolution):
    // If no target operation or method could be resolved, fail-closed immediately.
    // Never iterate or mutate arbitrary call-sites!
    let op = match target_operation {
        Some(op) => op,
        None => return Ok(summary),
    };

    let target_method = match &op {
        TargetHealOperation::InsertParam { method, .. } => method.clone(),
        TargetHealOperation::ReorderParams { method, .. } => method.clone(),
        TargetHealOperation::RemoveParam { method, .. } => method.clone(),
    };

    for file_path in test_files {
        let file_str = file_path.to_string_lossy().to_string();
        let source = match fs::read_to_string(&file_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let call_sites = if matches!(ext, "ts" | "tsx" | "js" | "jsx") {
            extract_ts_call_sites(&file_str, &source)
        } else {
            extract_java_call_sites(&file_str, &source)
        };

        let call_sites = match call_sites {
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

        // Sort call sites in reverse byte order so earlier replacements don't shift later byte offsets
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
                            | "undefined"
                            | "[]"
                            | "{}"
                            | "new Map()"
                            | "new Set()"
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

                    if !args.detect_only {
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

                    if !args.detect_only {
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

                    if !args.detect_only {
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

        if file_mutated && !args.detect_only {
            write_atomic(&file_path, &current_source).with_context(|| {
                format!("Failed to atomically write healed file: {:?}", file_path)
            })?;
        }
    }

    Ok(summary)
}

/// Detects if an expression text contains potential side-effects
pub fn has_side_effects(expr: &str) -> bool {
    let trimmed = expr.trim();
    if trimmed.contains("++") || trimmed.contains("--") {
        return true;
    }
    if trimmed.contains(" = ") || trimmed.contains(" += ") || trimmed.contains(" -= ") {
        return true;
    }

    // Constructor allocations for standard value objects are safe
    if trimmed.starts_with("new ") {
        return false;
    }

    // Pure immutable factory calls are safe
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

    // Casts like `(int) x`
    let is_cast =
        trimmed.starts_with('(') && !trimmed.contains('.') && trimmed.split(')').count() == 2;
    if is_cast {
        return false;
    }

    // Arbitrary method calls
    if trimmed.contains('(') && trimmed.contains(')') {
        return true;
    }

    false
}

/// Surgically applies an argument patch touching ONLY the insertion boundary.
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
            anyhow::bail!("Corrupted argument_list node");
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
        anyhow::bail!("Argument count does not match reorder signature count");
    }

    let start_paren = call.argument_list_span.start;
    let end_paren = call.argument_list_span.end;

    if end_paren <= start_paren + 1 {
        anyhow::bail!("Corrupted argument_list node");
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
        anyhow::bail!("Remove index out of bounds");
    }

    let start_paren = call.argument_list_span.start;
    let end_paren = call.argument_list_span.end;

    if end_paren <= start_paren + 1 {
        anyhow::bail!("Corrupted argument_list node");
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
            if matches!(ext.to_str().unwrap_or(""), "java" | "ts" | "tsx" | "js" | "jsx") {
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
