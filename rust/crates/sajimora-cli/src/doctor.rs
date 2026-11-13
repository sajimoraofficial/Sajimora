//! doctor.rs — Comprehensive setup verification and health check for Sajimora.
//!
//! Validates:
//! 1. Pre-flight diagnostics when uninitialized: Git repository, write permissions, toolchains (Java, Node, build tools).
//! 2. Post-initialization health:
//!    - Init manifest presence, version compatibility, and "complete" status.
//!    - Root directory presence (Java/Spring backend and frontend client).
//!    - Owned integrations (package.json scripts, git pre-commit hooks, .gitignore).
//!    - Artifact parseability and envelope integrity (backend and frontend contracts).

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::envelope::ContractArtifactEnvelope;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::init::{InitManifest, ManifestStatus};

#[derive(Args, Debug, Clone)]
pub struct DoctorArgs {
    /// Path to the repository root (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Optional target workflow to validate required toolchains for ("spring", "nestjs", "fullstack").
    #[arg(long)]
    pub workflow: Option<String>,
}

pub fn run(args: DoctorArgs) -> i32 {
    match run_inner(args) {
        Ok(healthy) => {
            if healthy {
                0
            } else {
                1
            }
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn resolve_tool(cmd: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path).filter(|p| !p.as_os_str().is_empty()) {
        #[cfg(windows)]
        let names = [
            format!("{cmd}.exe"),
            format!("{cmd}.cmd"),
            format!("{cmd}.bat"),
        ];
        #[cfg(not(windows))]
        let names = [cmd.to_string()];
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn check_tool_version(cmd: &str, args: &[&str]) -> Option<String> {
    probe_tool_version(&resolve_tool(cmd)?, args, None)
}

fn probe_tool_version(cmd: &Path, args: &[&str], directory: Option<&Path>) -> Option<String> {
    let mut command = Command::new(cmd);
    command.args(args);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    command.output().ok().and_then(|output| {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let first = stdout.lines().next().unwrap_or("").trim().to_string();
            if !first.is_empty() {
                return Some(first);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let first_err = stderr.lines().next().unwrap_or("").trim().to_string();
            if !first_err.is_empty() {
                return Some(first_err);
            }
        }
        None
    })
}

fn diagnose_environment(
    repo_root: &Path,
    workflow: Option<&str>,
    backend: Option<&Path>,
) -> Result<bool> {
    let mut healthy = true;

    // 1. Version Control Check (Git or SVN)
    let git_dir = repo_root.join(".git");
    let is_git = if git_dir.exists() {
        true
    } else {
        Command::new("git")
            .arg("rev-parse")
            .arg("--is-inside-work-tree")
            .current_dir(repo_root)
            .output()
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
            .unwrap_or(false)
    };

    let svn_dir = repo_root.join(".svn");
    let is_svn = if svn_dir.is_dir() {
        true
    } else {
        Command::new("svn")
            .arg("info")
            .current_dir(repo_root)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };

    if is_git {
        let branch = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(repo_root)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "detached".to_string());
        println!(
            "  ✅ [PASS] Git repository: valid worktree detected (branch: {})",
            if branch.is_empty() { "HEAD" } else { &branch }
        );
    } else if is_svn {
        println!("  ✅ [PASS] Version Control: valid Subversion (SVN) working copy detected");
    } else {
        println!("  ❌ [FAIL] Git repository: Directory is not a Git repository (or SVN working copy).");
        println!(
            "     Sajimora requires a Git or Subversion (SVN) working copy for revision tracking."
        );
        healthy = false;
    }

    // 2. Working Directory Write Permissions
    let test_file = repo_root.join(format!(".sajimora_probe_{}", std::process::id()));
    let write_ok = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&test_file)
        .map(drop)
    {
        Ok(()) => {
            let _ = fs::remove_file(&test_file);
            true
        }
        Err(e) => {
            println!(
                "  ❌ [FAIL] Write permissions: cannot write to repository root: {}",
                e
            );
            false
        }
    };
    if write_ok {
        println!("  ✅ [PASS] Write permissions: repository working directory is writable.");
    } else {
        healthy = false;
    }

    // 3. Toolchain & Runtimes. A runtime alone is not a Java compiler.
    let req_wf = workflow.unwrap_or("auto").to_lowercase();
    if !matches!(req_wf.as_str(), "auto" | "spring" | "nestjs" | "fullstack") {
        println!(
            "  [FAIL] Unknown workflow '{}'; expected spring, nestjs, fullstack, or auto.",
            req_wf
        );
        healthy = false;
    }
    let java_required = matches!(req_wf.as_str(), "spring" | "fullstack");
    let node_required = matches!(req_wf.as_str(), "nestjs" | "fullstack");
    let javac = check_tool_version("javac", &["-version"]);
    let node = check_tool_version("node", &["-v"]);
    let maven = check_tool_version("mvn", &["-version"]);
    let gradle = check_tool_version("gradle", &["-v"]);
    let npm = check_tool_version("npm", &["-v"]);

    for (label, version, required) in [
        ("Java toolchain (javac)", &javac, java_required),
        ("Node.js runtime", &node, node_required),
        ("Package manager (npm)", &npm, node_required),
    ] {
        if let Some(version) = version {
            println!("  [PASS] {}: {}", label, version);
        } else if required {
            println!(
                "  [FAIL] {}: not found in PATH (required for '{}' workflow).",
                label, req_wf
            );
            healthy = false;
        } else {
            println!(
                "  [WARN] {}: not detected in PATH (optional for '{}' workflow).",
                label, req_wf
            );
        }
    }
    for (label, version) in [("Maven", &maven), ("Gradle", &gradle)] {
        if let Some(version) = version {
            println!("  [PASS] Build tool ({}): {}", label, version);
        }
    }

    let mut build_roots = vec![repo_root.to_path_buf()];
    if let Some(backend) = backend {
        build_roots.push(backend.to_path_buf());
    }
    build_roots.push(repo_root.join("backend"));
    let has_maven = build_roots.iter().any(|p| p.join("pom.xml").is_file());
    let has_gradle = build_roots
        .iter()
        .any(|p| p.join("build.gradle").is_file() || p.join("build.gradle.kts").is_file());
    let wrapper_available = |wrapper: &str, args: &[&str]| {
        build_roots.iter().any(|directory| {
            #[cfg(windows)]
            let names = [
                format!("{wrapper}.exe"),
                format!("{wrapper}.cmd"),
                format!("{wrapper}.bat"),
            ];
            #[cfg(not(windows))]
            let names = [wrapper.to_string()];
            names.iter().any(|name| {
                let path = directory.join(name);
                path.is_file() && probe_tool_version(&path, args, Some(directory)).is_some()
            })
        })
    };
    let maven_available = maven.is_some() || wrapper_available("mvnw", &["-version"]);
    let gradle_available = gradle.is_some() || wrapper_available("gradlew", &["-v"]);
    // Match the project's descriptor, rather than accepting npm as a Java build tool.
    let build_available = if has_maven {
        maven_available
    } else if has_gradle {
        gradle_available
    } else {
        maven_available || gradle_available
    };
    if build_available {
        println!("  [PASS] Java build runner: matching Maven/Gradle runner or wrapper available.");
    } else {
        println!(
            "  [{}] Java build runner: matching Maven/Gradle runner or wrapper not available{}.",
            if java_required { "FAIL" } else { "WARN" },
            if java_required {
                format!(" (required for '{}' workflow)", req_wf)
            } else {
                String::new()
            }
        );
        if java_required {
            healthy = false;
        }
    }
    Ok(healthy)
}

fn diagnose_preflight(repo_root: &Path, workflow: Option<&str>) -> Result<bool> {
    println!("  [INFO] Missing .sajimora/init-manifest.json (repository not initialized).");
    println!("     Running pre-flight environment and toolchain diagnostics...\n");
    let healthy = diagnose_environment(repo_root, workflow, None)?;

    println!("\n  ┌────────────────────────────────────────────────────────┐");
    println!("  │                 HEALTH & READINESS SUMMARY             │");
    println!("  ├───────────────────────────────┬────────────────────────┤");
    if healthy {
        println!("  │ Environment Readiness         │ ✅ PASS                │");
    } else {
        println!("  │ Environment Readiness         │ ❌ FAIL                │");
    }
    println!("  │ Initialization Status         │ ℹ️  UNINITIALIZED       │");
    println!("  │ Contract Verification Status  │ ⏩ PENDING             │");
    println!("  └───────────────────────────────┴────────────────────────┘\n");

    if healthy {
        println!("  👉 Next step: Run `sajimora init --apply` to automatically discover controllers and establish contract baseline.\n");
    } else {
        println!("  👉 Please resolve the failed environment checks above before initializing.\n");
    }

    Ok(healthy)
}

fn run_inner(args: DoctorArgs) -> Result<bool> {
    let repo_root = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo.clone()
    };

    if !repo_root.exists() {
        return Err(anyhow!(
            "Repository directory does not exist: {:?}",
            repo_root
        ));
    }

    println!(
        "\nSajimora Doctor — Diagnosing setup health in {:?}...\n",
        repo_root
    );

    let sajimora_dir = repo_root.join(".sajimora");
    let manifest_path = sajimora_dir.join("init-manifest.json");

    // 1. If Manifest is missing, run pre-flight diagnostics mode
    if !manifest_path.exists() {
        return diagnose_preflight(&repo_root, args.workflow.as_deref());
    }

    let mut healthy = true;

    let manifest: InitManifest = match fs::read_to_string(&manifest_path).and_then(|raw| {
        serde_json::from_str::<InitManifest>(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }) {
        Ok(m) => {
            if m.status == ManifestStatus::Complete {
                println!(
                    "  ✅ [PASS] Init manifest: valid (v{}, complete, sajimora {})",
                    m.manifest_version, m.sajimora_version
                );
            } else {
                println!("  ⚠️  [WARN] Init manifest has status 'incomplete'. A previous init may have been interrupted.");
                println!("     -> Run `sajimora clean` or re-run `sajimora init --apply`.");
                healthy = false;
            }
            m
        }
        Err(e) => {
            println!("  ❌ [FAIL] Init manifest is corrupted: {}", e);
            return Ok(false);
        }
    };

    // Initialized repositories still need a valid environment for the requested workflow.
    let backend_path = repo_root.join(&manifest.roots.backend_root);
    healthy &= diagnose_environment(&repo_root, args.workflow.as_deref(), Some(&backend_path))?;

    // 2. Check Roots
    if backend_path.exists() {
        println!(
            "  ✅ [PASS] Backend service directory: {:?} (service: {})",
            manifest.roots.backend_root, manifest.roots.service_id
        );
    } else {
        println!(
            "  ❌ [FAIL] Configured backend directory does not exist: {:?}",
            backend_path
        );
        healthy = false;
    }

    if let Some(ref fe_rel) = manifest.roots.frontend_root {
        let fe_path = repo_root.join(fe_rel);
        if fe_path.exists() {
            println!("  ✅ [PASS] Frontend client directory: {:?}", fe_rel);
        } else {
            println!(
                "  ❌ [FAIL] Configured frontend directory does not exist: {:?}",
                fe_path
            );
            healthy = false;
        }
    }

    // 3. Check Owned package.json scripts
    if let Some(ref pkg_mod) = manifest.owned.package_json {
        let pkg_path = repo_root.join(&pkg_mod.path);
        if pkg_path.exists() {
            if let Ok(raw) = fs::read_to_string(&pkg_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let mut all_scripts_present = true;
                    for s in &pkg_mod.injected_scripts {
                        let present = val
                            .get("scripts")
                            .and_then(|m| m.get(&s.key))
                            .and_then(|v| v.as_str());
                        if present.is_none() {
                            println!("  ⚠️  [WARN] Missing script '{}' in package.json", s.key);
                            all_scripts_present = false;
                            healthy = false;
                        }
                    }
                    if all_scripts_present {
                        println!(
                            "  ✅ [PASS] package.json scripts: all {} verification scripts present",
                            pkg_mod.injected_scripts.len()
                        );
                    }
                } else {
                    println!("  ❌ [FAIL] package.json is not valid JSON.");
                    healthy = false;
                }
            }
        } else {
            println!("  ❌ [FAIL] package.json was configured but no longer exists.");
            healthy = false;
        }
    }

    // 4. Check Owned Hook
    if let Some(ref hook_mod) = manifest.owned.hook {
        let hook_path = repo_root.join(&hook_mod.target_hook);
        if hook_path.exists() {
            if let Ok(content) = fs::read_to_string(&hook_path) {
                if content.contains("sajimora verify") {
                    println!(
                        "  ✅ [PASS] Git pre-commit hook: active at {} (strategy: {})",
                        hook_mod.target_hook, hook_mod.strategy
                    );
                } else {
                    println!("  ⚠️  [WARN] Git pre-commit hook exists at {} but does not invoke `sajimora verify`.", hook_mod.target_hook);
                    healthy = false;
                }
            }
        } else {
            println!(
                "  ⚠️  [WARN] Configured Git hook does not exist: {}",
                hook_mod.target_hook
            );
            healthy = false;
        }
    } else {
        println!("  ℹ️  [INFO] Git pre-commit hook: skipped (not configured)");
    }

    // 5. Check Contract Artifacts
    for art in &manifest.artifacts {
        let art_path = repo_root.join(&art.path);
        if art_path.exists() {
            match fs::read_to_string(&art_path).and_then(|raw| {
                serde_json::from_str::<ContractArtifactEnvelope>(&raw)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            }) {
                Ok(env) => {
                    println!(
                        "  ✅ [PASS] Artifact {:?}: valid envelope (kind: {:?}, tool: {})",
                        art.path, env.kind, env.profile.tool_version
                    );
                }
                Err(e) => {
                    println!(
                        "  ❌ [FAIL] Artifact {:?} is corrupted or invalid: {}",
                        art.path, e
                    );
                    healthy = false;
                }
            }
        } else {
            println!("  ❌ [FAIL] Missing contract artifact: {:?}", art.path);
            healthy = false;
        }
    }

    println!("\n  ┌────────────────────────────────────────────────────────┐");
    println!("  │                 HEALTH & READINESS SUMMARY             │");
    println!("  ├───────────────────────────────┬────────────────────────┤");
    println!(
        "  │ Environment Readiness         │ {}                │",
        if healthy { "PASS" } else { "FAIL" }
    );
    println!(
        "  │ Initialization Status         │ ✅ INITIALIZED (v{})    │",
        manifest.manifest_version
    );
    if healthy {
        println!("  │ Contract Verification Status  │ ✅ VERIFIED            │");
    } else {
        println!("  │ Contract Verification Status  │ ❌ WARNINGS / FAILURES │");
    }
    println!("  └───────────────────────────────┴────────────────────────┘\n");

    if healthy {
        println!("✅ All Sajimora health checks passed! Repository is ready for verification.\n");
    } else {
        println!("⚠️  Some health checks failed or showed warnings. Review the items marked with ❌ or ⚠️ above.\n");
    }

    Ok(healthy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_probe_preserves_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "sajimora-doctor-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        let file = root.join(format!(".sajimora_probe_{}", std::process::id()));
        fs::write(&file, b"user-authored content").unwrap();
        let healthy = diagnose_environment(&root, Some("auto"), None).unwrap();
        assert!(
            !healthy,
            "A colliding permission probe must fail without replacement"
        );
        assert_eq!(fs::read(&file).unwrap(), b"user-authored content");
        fs::remove_dir_all(root).unwrap();
    }
}
