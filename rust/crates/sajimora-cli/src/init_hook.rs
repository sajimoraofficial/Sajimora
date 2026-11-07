//! init_hook.rs — Install or reconfigure the Sajimora pre-commit hook.
//!
//! Advisory by default: the hook reports contract breaks without blocking the
//! commit. `--blocking` opts into exit 1 on violations and exit 3 on
//! inconclusive analysis.
//!
//! The command only ever writes inside the repository. A pre-existing user
//! hook is preserved (wrapped for bare hooks, chained for Husky), and a hook
//! that Sajimora already manages is rewritten in place so switching modes does
//! not stack hooks. If an init-manifest exists, the hook is recorded there so
//! `sajimora clean` can revert it.

use anyhow::{anyhow, bail, Result};
use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::init::{
    git_config_get, git_rev_parse_hooks, greenfield_hook_script, husky_hook_snippet,
    set_executable, wrapper_hook_script, write_manifest_durable, HookIntegration, InitManifest,
    HOOK_MARKER,
};

#[derive(Args, Debug)]
pub struct InitHookArgs {
    /// Path to the repository root (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Install an enforcing hook: exit 1 on contract violations and exit 3 on
    /// inconclusive analysis. Off by default (advisory, exit 0).
    #[arg(long)]
    pub blocking: bool,
}

#[derive(Clone, Copy)]
enum Strategy {
    Greenfield,
    HuskyChain,
    BareWrapper,
}

impl Strategy {
    fn as_str(self) -> &'static str {
        match self {
            Strategy::Greenfield => "greenfield",
            Strategy::HuskyChain => "husky_chain",
            Strategy::BareWrapper => "bare_wrapper",
        }
    }
}

pub fn run(args: InitHookArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("❌ init-hook failed: {}", e);
            1
        }
    }
}

fn run_inner(args: InitHookArgs) -> Result<()> {
    let repo_input = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo.clone()
    };
    let repo_root = repo_input.canonicalize().map_err(|e| {
        anyhow!(
            "Repository directory does not exist or cannot be resolved: {:?} ({})",
            repo_input,
            e
        )
    })?;
    ensure_git_repository(&repo_root)?;

    let hooks_path_cfg = git_config_get(&repo_root, "core.hooksPath");
    let husky_dir = repo_root.join(".husky");

    enum InstallMode {
        Husky,
        Bare { backup: PathBuf },
    }

    let (mode, target) = if let Some(ref hp) = hooks_path_cfg {
        let raw = Path::new(hp);
        let absolute = if raw.is_relative() {
            repo_root.join(raw)
        } else {
            raw.to_path_buf()
        };
        ensure_inside_repo(&repo_root, &absolute, "core.hooksPath")?;

        if hp.replace('\\', "/").contains(".husky") {
            // Husky v9 executes the user-editable .husky/pre-commit, not the
            // generated shims under .husky/_.
            (InstallMode::Husky, repo_root.join(".husky/pre-commit"))
        } else {
            (
                InstallMode::Bare {
                    backup: absolute.join("pre-commit.sajimora-orig"),
                },
                absolute.join("pre-commit"),
            )
        }
    } else if husky_dir.is_dir() {
        bail!(
            ".husky exists but core.hooksPath is unset, so Git would not execute the hook. Run `npm install` (or `npx husky init`) first, then re-run `sajimora init-hook`."
        );
    } else {
        // Trust git's own resolution here: linked worktrees place the git dir
        // (and therefore hooks) outside the working tree by design.
        let hooks_dir = git_rev_parse_hooks(&repo_root)?;
        let hooks_dir = if hooks_dir.is_relative() {
            repo_root.join(hooks_dir)
        } else {
            hooks_dir
        };
        (
            InstallMode::Bare {
                backup: hooks_dir.join("pre-commit.sajimora-orig"),
            },
            hooks_dir.join("pre-commit"),
        )
    };

    let (installed, backup) = match mode {
        InstallMode::Husky => install_husky_hook(&target, args.blocking)?,
        InstallMode::Bare { backup } => install_bare_hook(&target, &backup, args.blocking)?,
    };

    record_hook(&repo_root, installed, &target, backup.as_deref());

    let target_rel = display_rel(&repo_root, &target);
    println!(
        "Installed Sajimora pre-commit hook at {} ({})",
        target_rel,
        if args.blocking {
            "blocking"
        } else {
            "advisory"
        }
    );
    if args.blocking {
        println!(
            "  Mode: blocking — exit 1 on contract violations, exit 3 on inconclusive analysis."
        );
    } else {
        println!(
            "  Mode: advisory — reports contract breaks without blocking the commit (exit 0)."
        );
        println!("  Enable enforcement with: sajimora init-hook --blocking");
    }
    if let Some(ref backup) = backup {
        println!(
            "  Original hook preserved at {}",
            display_rel(&repo_root, backup)
        );
    }
    if !repo_root.join(".sajimora/frontend-contract.json").exists()
        || !repo_root.join(".sajimora/backend-contract.json").exists()
    {
        println!(
            "  Note: no .sajimora contracts were found; the hook stays quiet until `sajimora init --apply` creates them."
        );
    }

    Ok(())
}

fn ensure_git_repository(repo_root: &Path) -> Result<()> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| anyhow!("Failed to run git while checking the repository: {}", e))?;
    if !output.status.success() {
        bail!("Not a git repository: {:?}", repo_root);
    }
    Ok(())
}

/// Resolve a candidate path through its deepest existing ancestor (following
/// symlinks/junctions) and require the result to stay inside the repository.
fn ensure_inside_repo(repo_root: &Path, candidate: &Path, label: &str) -> Result<()> {
    let root_canon = repo_root
        .canonicalize()
        .map_err(|e| anyhow!("Cannot resolve repository root {:?}: {}", repo_root, e))?;
    let resolved = resolve_with_existing_ancestor(candidate)
        .ok_or_else(|| anyhow!("Cannot resolve {} path {:?}", label, candidate))?;
    if !resolved.starts_with(&root_canon) {
        bail!(
            "Refusing to write {} outside the repository: {:?}",
            label,
            candidate
        );
    }
    Ok(())
}

fn resolve_with_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut probe = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if probe.exists() {
            let mut resolved = probe.canonicalize().ok()?;
            for part in tail.iter().rev() {
                if part == std::ffi::OsStr::new("..") {
                    resolved.pop();
                } else {
                    resolved.push(part);
                }
            }
            return Some(resolved);
        }
        let name = probe.file_name()?.to_os_string();
        tail.push(name);
        if !probe.pop() {
            return None;
        }
    }
}

fn install_bare_hook(
    target: &Path,
    backup: &Path,
    blocking: bool,
) -> Result<(Strategy, Option<PathBuf>)> {
    if target.exists() {
        let content = fs::read_to_string(target)
            .map_err(|e| anyhow!("Cannot read existing hook {:?}: {}", target, e))?;

        let is_wrapper =
            content.contains("pre-commit.sajimora-orig") && content.contains("sajimora verify");
        if is_wrapper {
            if !backup.exists() {
                bail!(
                    "{:?} wraps a preserved hook, but the original at {:?} is missing. Restore it or run `sajimora clean` before reinstalling.",
                    target,
                    backup
                );
            }
            write_hook(target, &wrapper_hook_script(blocking))?;
            return Ok((Strategy::BareWrapper, Some(backup.to_path_buf())));
        }

        if content.contains(HOOK_MARKER) {
            write_hook(target, &greenfield_hook_script(blocking))?;
            return Ok((Strategy::Greenfield, None));
        }

        if backup.exists() {
            bail!(
                "Backup hook {:?} already exists. Run `sajimora clean` first before re-initializing.",
                backup
            );
        }
        // Preserve the user's hook before the wrapper takes the canonical path.
        fs::rename(target, backup).map_err(|e| {
            anyhow!(
                "Cannot preserve the existing hook {:?} as {:?}: {}",
                target,
                backup,
                e
            )
        })?;
        write_hook(target, &wrapper_hook_script(blocking))?;
        return Ok((Strategy::BareWrapper, Some(backup.to_path_buf())));
    }

    write_hook(target, &greenfield_hook_script(blocking))?;
    Ok((Strategy::Greenfield, None))
}

fn install_husky_hook(target: &Path, blocking: bool) -> Result<(Strategy, Option<PathBuf>)> {
    let snippet = husky_hook_snippet(blocking);

    if target.exists() {
        let content = fs::read_to_string(target)
            .map_err(|e| anyhow!("Cannot read existing husky hook {:?}: {}", target, e))?;

        if content.contains(HOOK_MARKER) {
            let updated = replace_managed_block(&content, &snippet);
            write_hook(target, &updated)?;
            return Ok((Strategy::HuskyChain, None));
        }

        let backup = target.with_file_name("pre-commit.sajimora-backup");
        if !backup.exists() {
            fs::copy(target, &backup).map_err(|e| {
                anyhow!(
                    "Cannot back up the existing husky hook {:?} to {:?}: {}",
                    target,
                    backup,
                    e
                )
            })?;
        }
        let mut updated = content;
        if !updated.ends_with('\n') && !updated.ends_with('\r') {
            updated.push('\n');
        }
        updated.push_str(&snippet);
        write_hook(target, &updated)?;
        return Ok((Strategy::HuskyChain, Some(backup)));
    }

    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("Invalid hook path {:?}", target))?;
    fs::create_dir_all(parent)?;
    write_hook(target, &format!("#!/bin/sh\n{}", snippet))?;
    Ok((Strategy::HuskyChain, None))
}

/// Replace the Sajimora block (marker through its closing `fi`) and drop any
/// duplicate managed blocks, leaving user content untouched.
fn replace_managed_block(content: &str, snippet: &str) -> String {
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let block: Vec<&str> = snippet.trim_matches('\n').lines().collect();
    let mut out: Vec<String> = Vec::new();
    let mut lines = content.lines();
    let mut replaced = false;

    while let Some(line) = lines.next() {
        if line.contains(HOOK_MARKER) {
            while let Some(next) = lines.next() {
                if next.trim() == "fi" {
                    break;
                }
            }
            if !replaced {
                if out.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                    out.push(String::new());
                }
                out.extend(block.iter().map(|l| l.to_string()));
                replaced = true;
            }
            continue;
        }
        out.push(line.to_string());
    }

    let mut joined = out.join(eol);
    if content.ends_with('\n') || content.ends_with('\r') {
        joined.push_str(eol);
    }
    joined
}

fn write_hook(target: &Path, content: &str) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = target.with_file_name(format!(
        "{}.sajimora-new",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("hook")
    ));
    fs::write(&temp, content).map_err(|e| anyhow!("Cannot write hook {:?}: {}", temp, e))?;
    set_executable(&temp)?;

    // Unix rename replaces atomically; Windows refuses to overwrite, so the
    // old file is removed first.
    #[cfg(windows)]
    if target.exists() {
        fs::remove_file(target).map_err(|e| anyhow!("Cannot replace hook {:?}: {}", target, e))?;
    }
    fs::rename(&temp, target).map_err(|e| anyhow!("Cannot install hook {:?}: {}", target, e))?;
    Ok(())
}

fn record_hook(repo_root: &Path, strategy: Strategy, target: &Path, backup: Option<&Path>) {
    let manifest_path = repo_root.join(".sajimora/init-manifest.json");
    if !manifest_path.exists() {
        return;
    }

    let target_rel = match target.strip_prefix(repo_root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            eprintln!(
                "warning: hook path {:?} is outside the repository; manifest not updated.",
                target
            );
            return;
        }
    };
    let backup_rel = backup.map(|b| {
        b.strip_prefix(repo_root)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| b.to_string_lossy().replace('\\', "/"))
    });

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!(
                "warning: cannot read {:?} ({}); hook installed but not recorded for `sajimora clean`.",
                manifest_path, e
            );
            return;
        }
    };
    let mut manifest: InitManifest = match serde_json::from_str(&raw) {
        Ok(manifest) => manifest,
        Err(e) => {
            eprintln!(
                "warning: cannot parse {:?} ({}); hook installed but not recorded for `sajimora clean`.",
                manifest_path, e
            );
            return;
        }
    };

    manifest.owned.hook = Some(HookIntegration {
        strategy: strategy.as_str().to_string(),
        target_hook: target_rel,
        backup_hook: backup_rel,
    });

    if let Err(e) = write_manifest_durable(&manifest_path, &manifest) {
        eprintln!(
            "warning: failed to record the hook in {:?}: {}",
            manifest_path, e
        );
    }
}

fn display_rel(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
