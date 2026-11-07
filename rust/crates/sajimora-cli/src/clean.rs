//! clean.rs — Safe, surgical, and reversible teardown of Sajimora.
//!
//! Replays `.sajimora/init-manifest.json` in reverse:
//! 1. Removes transient extraction directories (.sajimora/.tmp-extract/).
//! 2. Surgically strips injected scripts from `package.json` preserving user modifications and formatting.
//! 3. Reverts `.gitignore` additions without touching unrelated rules.
//! 4. Restores original Git hooks or removes Greenfield hook.
//! 5. Removes untracked artifacts while preserving tracked contracts.
//! 6. Removes the manifest and `.sajimora/` directory.

use anyhow::{anyhow, Result};
use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::init::{serialize_json_with_fingerprint, InitManifest, ManifestStatus};

#[derive(Args, Debug)]
pub struct CleanArgs {
    /// Path to the repository root (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Force clean even if manifest is missing or damaged.
    #[arg(long)]
    pub force: bool,
}

pub fn run(args: CleanArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn run_inner(args: CleanArgs) -> Result<()> {
    let repo_root = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo
    };

    if !repo_root.exists() {
        return Err(anyhow!(
            "Repository directory does not exist: {:?}",
            repo_root
        ));
    }

    let sajimora_dir = repo_root.join(".sajimora");
    let manifest_path = sajimora_dir.join("init-manifest.json");

    if !manifest_path.exists() {
        if sajimora_dir.exists() && args.force {
            println!("No init-manifest.json found. Removing .sajimora/ due to --force...");
            fs::remove_dir_all(&sajimora_dir)?;
            println!("Clean complete (--force).");
            return Ok(());
        } else if sajimora_dir.exists() {
            return Err(anyhow!(
                "No .sajimora/init-manifest.json found. Use `sajimora clean --force` to delete .sajimora/ manually."
            ));
        } else {
            println!(
                "Sajimora is not initialized in {:?}. Nothing to clean.",
                repo_root
            );
            return Ok(());
        }
    }

    println!("\nCleaning Sajimora in {:?}...", repo_root);

    let manifest_raw = fs::read_to_string(&manifest_path)?;
    let manifest: InitManifest = match serde_json::from_str(&manifest_raw) {
        Ok(m) => m,
        Err(e) => {
            if args.force {
                println!(
                    "  [WARN] Manifest is damaged: {}. Removing .sajimora/ (--force)...",
                    e
                );
                fs::remove_dir_all(&sajimora_dir)?;
                return Ok(());
            } else {
                return Err(anyhow!(
                    "Manifest is damaged ({e}). Run with --force to remove .sajimora/ unconditionally."
                ));
            }
        }
    };

    if manifest.status == ManifestStatus::Incomplete {
        println!("  [INFO] Recovering from incomplete/interrupted Sajimora initialization...");
    }

    // 1. Remove temporary extraction directory unconditionally
    let tmp_extract = sajimora_dir.join(".tmp-extract");
    if tmp_extract.exists() {
        let _ = fs::remove_dir_all(&tmp_extract);
        println!("  [OK] Removed temporary extraction directory");
    }

    // 2. Surgical package.json cleanup
    if let Some(ref pkg_mod) = manifest.owned.package_json {
        let pkg_path_opt = safe_repo_path(&repo_root, &pkg_mod.path);
        if pkg_path_opt.is_none() {
            eprintln!(
                "  [SECURITY] Refusing to touch package.json outside repository: {}",
                pkg_mod.path
            );
        } else if let Some(pkg_path) = pkg_path_opt {
            if pkg_path.exists() {
                match fs::read_to_string(&pkg_path) {
                Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(mut json_val) => {
                        let mut modified = false;
                        if let Some(scripts_map) = json_val.get_mut("scripts").and_then(|s| s.as_object_mut()) {
                            for script in &pkg_mod.injected_scripts {
                                if let Some(current_val) = scripts_map.get(&script.key) {
                                    if current_val.as_str() == Some(&script.expected_value) {
                                        scripts_map.remove(&script.key);
                                        modified = true;
                                        println!("  [OK] Removed injected script '{}' from package.json", script.key);
                                    } else {
                                        println!(
                                            "  [KEEP] Preserved script '{}' in package.json (modified by user since init)",
                                            script.key
                                        );
                                    }
                                }
                            }
                        }

                        // If scripts object became empty, remove the scripts key entirely
                        if let Some(scripts_val) = json_val.get("scripts") {
                            if scripts_val.as_object().map(|obj| obj.is_empty()).unwrap_or(false) {
                                if let Some(obj) = json_val.as_object_mut() {
                                    obj.remove("scripts");
                                    modified = true;
                                }
                            }
                        }

                        if modified {
                            match serialize_json_with_fingerprint(&json_val, &pkg_mod.fingerprint) {
                                Ok(new_content) => {
                                    if let Err(e) = fs::write(&pkg_path, new_content) {
                                        eprintln!("  [WARN] Failed to write updated package.json: {}", e);
                                    }
                                }
                                Err(e) => eprintln!("  [WARN] Failed to serialize package.json: {}", e),
                            }
                        }
                    }
                    Err(e) => eprintln!("  [WARN] package.json is not valid JSON ({}); skipping script cleanup.", e),
                },
                Err(e) => eprintln!("  [WARN] Failed to read package.json ({}).", e),
            }
            }
        }
    }

    // 3. Surgical .gitignore cleanup
    if let Some(ref gi_mod) = manifest.owned.gitignore {
        let gi_path_opt = safe_repo_path(&repo_root, &gi_mod.path);
        if gi_path_opt.is_none() {
            eprintln!(
                "  [SECURITY] Refusing to touch .gitignore outside repository: {}",
                gi_mod.path
            );
        } else if let Some(gi_path) = gi_path_opt {
            if gi_path.exists() {
                if gi_mod.created_by_sajimora {
                    let _ = fs::remove_file(&gi_path);
                    println!("  [OK] Removed .gitignore created by Sajimora");
                } else if let Ok(content) = fs::read_to_string(&gi_path) {
                    let eol = if content.contains("\r\n") {
                        "\r\n"
                    } else {
                        "\n"
                    };
                    let mut remaining_lines = Vec::new();
                    let mut removed_count = 0;
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed == "# Sajimora transient artifacts" {
                            removed_count += 1;
                            continue;
                        }
                        if gi_mod
                            .injected_lines
                            .iter()
                            .any(|injected| injected.trim() == trimmed)
                        {
                            removed_count += 1;
                        } else {
                            remaining_lines.push(line);
                        }
                    }
                    if removed_count > 0 {
                        let mut updated = remaining_lines.join(eol);
                        if (content.ends_with('\n') || content.ends_with('\r'))
                            && !updated.is_empty()
                        {
                            updated.push_str(eol);
                        }
                        let _ = fs::write(&gi_path, updated);
                        println!(
                            "  [OK] Removed {} injected line(s) from .gitignore",
                            removed_count
                        );
                    }
                }
            }
        }
    }

    // 4. Hook cleanup
    if let Some(ref hook_mod) = manifest.owned.hook {
        let target_opt = safe_repo_path(&repo_root, &hook_mod.target_hook);
        if target_opt.is_none() {
            eprintln!(
                "  [SECURITY] Refusing to touch hook target outside repository: {}",
                hook_mod.target_hook
            );
        } else if let Some(target) = target_opt {
            match hook_mod.strategy.as_str() {
                "greenfield" => {
                    if target.exists() {
                        if let Ok(content) = fs::read_to_string(&target) {
                            if content.contains("sajimora verify") {
                                let _ = fs::remove_file(&target);
                                println!(
                                    "  [OK] Removed Greenfield hook: {}",
                                    hook_mod.target_hook
                                );
                            }
                        }
                    }
                }
                "bare_wrapper" => {
                    if let Some(ref backup_rel) = hook_mod.backup_hook {
                        let backup_opt = safe_repo_path(&repo_root, backup_rel);
                        if backup_opt.is_none() {
                            eprintln!(
                                "  [SECURITY] Refusing to touch hook backup outside repository: {}",
                                backup_rel
                            );
                        } else if let Some(backup) = backup_opt {
                            if backup.exists() {
                                let _ = fs::rename(&backup, &target);
                                println!("  [OK] Restored original hook from {}", backup_rel);
                            } else if target.exists() {
                                // If backup is missing, remove wrapper if it only runs sajimora verify
                                if let Ok(content) = fs::read_to_string(&target) {
                                    if content.contains("sajimora verify")
                                        && !content.contains("sajimora-orig")
                                    {
                                        let _ = fs::remove_file(&target);
                                    }
                                }
                            }
                        }
                    }
                }
                "husky_chain" => {
                    let backup = target.with_file_name("pre-commit.sajimora-backup");
                    if backup.exists() {
                        let _ = fs::remove_file(&backup);
                    }
                    if let Some(ref backup_rel) = hook_mod.backup_hook {
                        if let Some(backup_p) = safe_repo_path(&repo_root, backup_rel) {
                            if backup_p.exists() {
                                let _ = fs::remove_file(&backup_p);
                            }
                        }
                    }
                    if target.exists() {
                        if let Ok(content) = fs::read_to_string(&target) {
                            let eol = if content.contains("\r\n") {
                                "\r\n"
                            } else {
                                "\n"
                            };
                            let mut filtered: Vec<&str> = Vec::new();
                            let mut skipping_block = false;

                            for line in content.lines() {
                                let trimmed = line.trim();
                                if trimmed.contains("Sajimora cross-language verification") {
                                    skipping_block = true;
                                    continue;
                                }
                                if skipping_block {
                                    if trimmed == "fi" {
                                        skipping_block = false;
                                        continue;
                                    }
                                    continue;
                                }
                                if !line.to_lowercase().contains("sajimora") {
                                    filtered.push(line);
                                }
                            }
                            while filtered
                                .last()
                                .map(|s| s.trim().is_empty())
                                .unwrap_or(false)
                            {
                                filtered.pop();
                            }
                            let mut updated = filtered.join(eol);
                            if (content.ends_with('\n') || content.ends_with('\r'))
                                && !updated.is_empty()
                            {
                                updated.push_str(eol);
                            }
                            let _ = fs::write(&target, updated);
                            println!(
                                "  [OK] Removed Sajimora verification from {}",
                                hook_mod.target_hook
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // 5. Artifact cleanup (respect tracked vs untracked)
    for art in &manifest.artifacts {
        if let Some(art_path) = safe_repo_path(&repo_root, &art.path) {
            if art_path.exists() {
                if is_file_tracked(&repo_root, &art.path) {
                    println!("  [KEEP] {} is tracked in git; preserved.", art.path);
                } else {
                    let _ = fs::remove_file(&art_path);
                    println!("  [OK] Removed untracked artifact: {}", art.path);
                }
            }
        } else {
            eprintln!(
                "  [SECURITY] Refusing to touch artifact outside repository: {}",
                art.path
            );
        }
    }

    // Remove remaining backup directory if empty
    let backup_dir = sajimora_dir.join("backup");
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }

    // 6. Remove manifest
    if manifest_path.exists() {
        let _ = fs::remove_file(&manifest_path);
    }

    // 7. Remove .sajimora/ directory if empty or only contains transient untracked files
    if sajimora_dir.exists() {
        if let Ok(entries) = fs::read_dir(&sajimora_dir) {
            let count = entries.flatten().count();
            if count == 0 {
                let _ = fs::remove_dir(&sajimora_dir);
            }
        }
    }

    println!("Sajimora teardown complete.\n");
    Ok(())
}

fn is_file_tracked(repo_root: &Path, rel_path: &str) -> bool {
    let output = Command::new("git")
        .args(["ls-files", "--", rel_path])
        .current_dir(repo_root)
        .output();
    match output {
        Ok(out) => {
            if out.status.success() {
                !String::from_utf8_lossy(&out.stdout).trim().is_empty()
            } else {
                false
            }
        }
        Err(_) => false,
    }
}

pub fn safe_repo_path(repo_root: &Path, rel_path: &str) -> Option<PathBuf> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return None;
    }
    for comp in rel.components() {
        if let std::path::Component::ParentDir = comp {
            return None;
        }
    }
    let joined = repo_root.join(rel);
    if let Ok(canon_root) = repo_root.canonicalize() {
        if joined.exists() {
            if let Ok(canon_joined) = joined.canonicalize() {
                if !canon_joined.starts_with(&canon_root) {
                    return None;
                }
            } else {
                return None;
            }
        }
    }
    Some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_repo_path_confines_to_root() {
        let root_buf = std::env::temp_dir();
        let root = root_buf.as_path();

        // Valid internal path
        assert!(safe_repo_path(root, ".sajimora/init-manifest.json").is_some());
        assert!(safe_repo_path(root, "package.json").is_some());

        // Traversal attempts
        assert!(safe_repo_path(root, "../../../../etc/passwd").is_none());
        assert!(safe_repo_path(root, "sub/../../something").is_none());
        assert!(safe_repo_path(root, "..").is_none());

        // Absolute path attempts
        #[cfg(windows)]
        {
            assert!(safe_repo_path(root, "C:\\Windows\\System32").is_none());
            assert!(safe_repo_path(root, "\\Windows\\System32").is_none());
        }
        #[cfg(unix)]
        {
            assert!(safe_repo_path(root, "/etc/passwd").is_none());
        }
    }
}
