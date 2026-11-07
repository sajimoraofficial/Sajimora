//! doctor_preflight_test.rs — Comprehensive regression tests for `sajimora doctor`.
//!
//! Validates:
//! 1. Pre-flight diagnostics on an uninitialized Git repository with a healthy environment -> exit code 0.
//! 2. Diagnostics on a non-Git directory -> exit code 1 with guidance.
//! 3. Optional tools missing -> warnings only, exit code 0.
//! 4. Required tools missing for a selected workflow -> exit code 1.
//! 5. Initialized repository with valid configuration -> exit code 0.
//! 6. Initialized repository with invalid / corrupted configuration -> exit code 1.

use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora-doc-test-{tag}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// The child sees only these mocks, never the host's installed toolchains.
fn mock_tool(dir: &Path, tool: &str) {
    #[cfg(windows)]
    fs::write(
        dir.join(format!("{tool}.cmd")),
        format!("@echo off\r\necho {tool} mock-version\r\nexit /b 0\r\n"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(tool);
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf '{tool} mock-version\\n'\n"),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[cfg(windows)]
fn mock_executable(dir: &Path, tool: &str) {
    let source = dir.join(format!("{tool}.rs"));
    fs::write(
        &source,
        format!("fn main() {{ println!(\"{tool} mock-exe-version\"); }}"),
    )
    .unwrap();
    let compiled = Command::new("rustc")
        .arg(&source)
        .arg("-o")
        .arg(dir.join(format!("{tool}.exe")))
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
}

fn mocked_doctor(repo: &Path, path: &Path, workflow: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sajimora"));
    command
        .args(["doctor", "--repo"])
        .arg(repo)
        .env("PATH", path)
        .current_dir(repo);
    if let Some(workflow) = workflow {
        command.args(["--workflow", workflow]);
    }
    command.output().unwrap()
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

#[test]
fn test_doctor_uninitialized_with_healthy_git_env() {
    let temp = TempDir::new("uninit-healthy");
    let repo = temp.path();

    // Initialize Git repository so it is a valid worktree
    fs::create_dir(repo.join(".git")).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(0),
        "doctor on an uninitialized Git repository with healthy environment must exit 0, got: {stdout}"
    );

    assert!(stdout.contains("Missing .sajimora/init-manifest.json"));
    assert!(stdout.contains("Git repository: valid worktree detected"));
    assert!(stdout.contains("Environment Readiness"));
    assert!(stdout.contains("UNINITIALIZED"));
    assert!(stdout.contains("sajimora init --apply"));
}

#[test]
fn test_doctor_non_git_directory_fails() {
    let temp = TempDir::new("non-git");
    let repo = temp.path();
    // Do NOT run git init

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    assert_eq!(
        output.status.code(),
        Some(1),
        "doctor on a non-Git directory must fail with exit code 1"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Directory is not a Git repository"));
}

#[test]
fn test_doctor_missing_required_tool_for_workflow() {
    let temp = TempDir::new("workflow-req");
    let repo = temp.path();

    fs::create_dir(repo.join(".git")).unwrap();

    // Run doctor with --workflow spring but with empty PATH so javac cannot be found
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .arg("--workflow")
        .arg("spring")
        .env("PATH", "")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(1),
        "doctor with unsatisfied workflow requirement must exit 1, got stdout: {stdout}"
    );
    assert!(
        stdout.contains("required for 'spring' workflow") || stdout.contains("not found in PATH")
    );
}

#[test]
fn test_doctor_missing_optional_tools_warns_only() {
    let temp = TempDir::new("optional-tools");
    let repo = temp.path();

    fs::create_dir(repo.join(".git")).unwrap();

    // The .git directory proves repository presence; PATH contains no installed tools.
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .arg("--workflow")
        .arg("auto")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(0),
        "doctor with auto workflow and healthy git must exit 0, got stdout: {stdout}"
    );
    assert!(stdout.contains("Environment Readiness"));
    assert!(stdout.contains("[WARN] Java toolchain"), "{stdout}");
    assert!(stdout.contains("[WARN] Node.js runtime"), "{stdout}");
}

#[test]
fn test_doctor_workflow_toolchain_matrix() {
    let cases: &[(&str, &[&str], Option<&str>, i32)] = &[
        ("spring", &["java", "mvn"], Some("pom.xml"), 1),
        ("spring", &["javac"], Some("pom.xml"), 1),
        ("spring", &["javac", "npm"], Some("pom.xml"), 1),
        ("spring", &["javac", "gradle"], Some("pom.xml"), 1),
        ("spring", &["javac", "mvn"], Some("pom.xml"), 0),
        ("spring", &["javac", "gradle"], Some("build.gradle.kts"), 0),
        ("spring", &["javac", "mvn"], Some("build.gradle"), 1),
        ("spring", &["javac", "mvn"], None, 0),
        ("nestjs", &["node"], None, 1),
        ("nestjs", &["npm"], None, 1),
        ("nestjs", &["node", "npm"], None, 0),
        ("fullstack", &[], None, 1),
        ("fullstack", &["javac", "mvn"], Some("pom.xml"), 1),
        ("fullstack", &["node", "npm"], None, 1),
        ("fullstack", &["javac", "node", "mvn"], Some("pom.xml"), 1),
        (
            "fullstack",
            &["javac", "node", "npm", "mvn"],
            Some("pom.xml"),
            0,
        ),
        ("unknown", &[], None, 1),
        ("auto", &[], None, 0),
    ];
    let mut failures = Vec::new();
    for (index, (workflow, tools, build_file, expected)) in cases.iter().enumerate() {
        let temp = TempDir::new(&format!("matrix-{index}"));
        let repo = temp.path();
        fs::create_dir(repo.join(".git")).unwrap();
        let mocks = repo.join("mock tools");
        fs::create_dir(&mocks).unwrap();
        for tool in *tools {
            // Exe runtimes isolate requirement bugs from the separate Windows batch lookup bug.
            #[cfg(windows)]
            if matches!((index, *tool), (0, "java") | (1..=3, "javac") | (8, "node")) {
                mock_executable(&mocks, tool);
                continue;
            }
            mock_tool(&mocks, tool);
        }
        if let Some(file) = build_file {
            fs::write(repo.join(file), "").unwrap();
        }
        let output = mocked_doctor(repo, &mocks, Some(workflow));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let undiscovered = tools
            .iter()
            .filter(|tool| {
                **tool != "java"
                    && !stdout.contains(&format!("{tool} mock-version"))
                    && !stdout.contains(&format!("{tool} mock-exe-version"))
            })
            .collect::<Vec<_>>();
        if output.status.code() != Some(*expected) || !undiscovered.is_empty() {
            failures.push(format!("case {index}: {workflow} {tools:?}: expected {expected}, got {:?}, undiscovered {undiscovered:?}\n{stdout}", output.status.code()));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn test_doctor_matching_project_wrapper_without_installed_runner() {
    for (build_file, wrapper) in [("pom.xml", "mvnw"), ("build.gradle", "gradlew")] {
        let temp = TempDir::new(wrapper);
        let repo = temp.path();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::write(repo.join(build_file), "").unwrap();
        mock_tool(repo, "javac");
        mock_tool(repo, wrapper);
        #[cfg(windows)]
        if wrapper == "gradlew" {
            fs::rename(repo.join("gradlew.cmd"), repo.join("gradlew.bat")).unwrap();
        }
        let output = mocked_doctor(repo, repo, Some("spring"));
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[cfg(windows)]
#[test]
fn test_doctor_windows_exe_and_batch_resolution() {
    let temp = TempDir::new("windows-resolution");
    let repo = temp.path();
    fs::create_dir(repo.join(".git")).unwrap();
    let mocks = repo.join("mock tools");
    fs::create_dir(&mocks).unwrap();
    let source = mocks.join("mock.rs");
    fs::write(&source, "fn main() { println!(\"mock-exe-version\"); }").unwrap();
    let compiled = Command::new("rustc")
        .arg(&source)
        .arg("-o")
        .arg(mocks.join("javac.exe"))
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    fs::copy(mocks.join("javac.exe"), mocks.join("node.exe")).unwrap();
    mock_tool(&mocks, "gradle");
    mock_tool(&mocks, "npm");
    fs::rename(mocks.join("gradle.cmd"), mocks.join("gradle.bat")).unwrap();
    fs::rename(mocks.join("npm.cmd"), mocks.join("npm.bat")).unwrap();
    fs::write(repo.join("build.gradle"), "").unwrap();
    let output = mocked_doctor(repo, &mocks, Some("fullstack"));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(0), "{stdout}");
    assert_eq!(stdout.matches("mock-exe-version").count(), 2, "{stdout}");
    assert!(stdout.contains("gradle mock-version"), "{stdout}");
    assert!(stdout.contains("npm mock-version"), "{stdout}");
}

#[test]
fn test_doctor_initialized_valid_config() {
    let temp = TempDir::new("init-valid");
    let repo = temp.path();

    fs::create_dir(repo.join(".git")).unwrap();
    let sajimora_dir = repo.join(".sajimora");
    fs::create_dir_all(&sajimora_dir).unwrap();
    fs::create_dir_all(repo.join("backend")).unwrap();
    fs::create_dir_all(repo.join("frontend")).unwrap();

    let manifest = json!({
        "manifest_version": 1,
        "status": "complete",
        "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-25T12:00:00Z",
        "roots": {
            "repo_root": repo.to_string_lossy(),
            "backend_root": "backend",
            "frontend_root": "frontend",
            "service_id": "test-service"
        },
        "owned": {
            "package_json": null,
            "hook": null,
            "gitignore": null
        },
        "artifacts": [
            {
                "path": ".sajimora/backend-contract.json",
                "kind": "backend",
                "is_tracked": true
            }
        ]
    });
    fs::write(
        sajimora_dir.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let base_bytes =
        fs::read_to_string(fixtures().join("envelopes/backend_complete.json")).unwrap();
    fs::write(sajimora_dir.join("backend-contract.json"), base_bytes).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(0),
        "doctor on healthy initialized repo must exit 0, got stdout: {stdout}"
    );
    assert!(stdout.contains("INITIALIZED"));
    assert!(stdout.contains("All Sajimora health checks passed!"));
    let required = mocked_doctor(repo, repo, Some("fullstack"));
    let stdout = String::from_utf8_lossy(&required.stdout);
    assert_eq!(required.status.code(), Some(1), "{stdout}");
    assert!(
        !stdout
            .lines()
            .any(|line| line.contains("Environment Readiness") && line.contains("PASS")),
        "{stdout}"
    );
}

#[test]
fn test_doctor_initialized_invalid_config() {
    let temp = TempDir::new("init-invalid");
    let repo = temp.path();

    fs::create_dir(repo.join(".git")).unwrap();
    let sajimora_dir = repo.join(".sajimora");
    fs::create_dir_all(&sajimora_dir).unwrap();

    // Manifest pointing to nonexistent backend directory
    let manifest = json!({
        "manifest_version": 1,
        "status": "complete",
        "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-25T12:00:00Z",
        "roots": {
            "repo_root": repo.to_string_lossy(),
            "backend_root": "nonexistent_backend_dir",
            "frontend_root": null,
            "service_id": "test-service"
        },
        "owned": {
            "package_json": null,
            "hook": null,
            "gitignore": null
        },
        "artifacts": []
    });
    fs::write(
        sajimora_dir.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .env("PATH", repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    assert_eq!(
        output.status.code(),
        Some(1),
        "doctor on invalid configured repo must exit 1"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Configured backend directory does not exist"));
    assert!(
        !stdout
            .lines()
            .any(|line| line.contains("Environment Readiness") && line.contains("PASS")),
        "{stdout}"
    );
}
