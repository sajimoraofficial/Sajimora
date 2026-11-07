//! init_clean_test.rs — Comprehensive test matrix for `sajimora init` and `sajimora clean`.
//!
//! Scenarios covered:
//! 1. Greenfield: No hooks -> hook installed, executable, clean removes it, git status clean.
//! 2. Husky v9: .husky/_ + hooksPath=.husky/_ -> brownfield preview by default; --apply --hook-mode chain
//!    writes to .husky/pre-commit and leaves .husky/_ untouched; clean strips chain.
//! 3. Bare custom hook: .git/hooks/pre-commit exists -> preview by default; 3-way atomic swap preserves
//!    original hook at .orig; clean restores byte-identical original hook.
//! 4. External hooksPath: hooksPath points outside repo -> hard refusal, external directory untouched.
//! 5. CRLF + 4-space package.json -> exact formatting preservation on init and byte-identical on clean.
//! 6. Tracked artifact -> clean preserves committed contract JSONs, preventing git status deletions.
//! 7. Idempotency -> second init run is an immediate no-op with byte-identical manifest.
//! 8. Crash recovery -> clean unwinds interrupted state (status: incomplete + .tmp-extract).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn binary() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().unwrap().parent().unwrap();
    #[cfg(windows)]
    let bin_name = "sajimora.exe";
    #[cfg(not(windows))]
    let bin_name = "sajimora";
    workspace.join("target").join("debug").join(bin_name)
}

fn run_sajimora(repo: &Path, args: &[&str]) -> (i32, String, String) {
    let mut cmd = Command::new(binary());
    cmd.args(args).current_dir(repo);
    let output = cmd.output().expect("failed to execute sajimora binary");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);
    (code, stdout, stderr)
}

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=CI Test",
            "-c",
            "user.email=ci@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git execution failed");
    assert!(status.success(), "git command failed: {:?}", args);
}

fn setup_sample_spring_app(repo: &Path) {
    let java_dir = repo.join("src/main/java/com/example");
    fs::create_dir_all(&java_dir).unwrap();
    let controller_code = r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {
    @GetMapping("/api/v1/status")
    public String getStatus() {
        return "OK";
    }
}
"#;
    fs::write(java_dir.join("DemoController.java"), controller_code).unwrap();
    fs::write(repo.join("pom.xml"), "<project></project>").unwrap();
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora_test_{}_{}", prefix, nanos));
        fs::create_dir_all(&path).unwrap();
        TempDir { path }
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

#[test]
fn test_scenario_1_greenfield_lifecycle() {
    let temp = TempDir::new("scen1");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    let pkg_json =
        "{\n  \"name\": \"demo-app\",\n  \"scripts\": {\n    \"test\": \"echo test\"\n  }\n}\n";
    fs::write(repo.join("package.json"), pkg_json).unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "initial commit"]);

    // 1. Init in greenfield
    let (code, stdout, stderr) = run_sajimora(repo, &["init", "--backend", "."]);
    assert_eq!(code, 0, "Init failed: stdout={}\nstderr={}", stdout, stderr);
    assert!(repo.join(".sajimora/init-manifest.json").exists());
    assert!(repo.join(".sajimora/backend-contract.json").exists());
    assert!(repo.join(".sajimora/frontend-contract.json").exists());
    assert!(repo.join(".git/hooks/pre-commit").exists());

    let hook_content = fs::read_to_string(repo.join(".git/hooks/pre-commit")).unwrap();
    assert!(hook_content.contains("sajimora verify"));

    // 2. Clean
    let (clean_code, _, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(clean_code, 0);
    assert!(!repo.join(".sajimora").exists());
    assert!(!repo.join(".git/hooks/pre-commit").exists());

    let restored_pkg = fs::read_to_string(repo.join("package.json")).unwrap();
    assert_eq!(restored_pkg, pkg_json);

    // Git status must be 100% clean
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty());
}

#[test]
fn test_scenario_2_husky_v9_compatibility() {
    let temp = TempDir::new("scen2");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(
        repo.join("package.json"),
        "{\n  \"name\": \"husky-app\"\n}\n",
    )
    .unwrap();

    // Setup Husky v9 layout: .husky/_/ (generated) and .husky/pre-commit (user-facing)
    let husky_dir = repo.join(".husky");
    let husky_internal = husky_dir.join("_");
    fs::create_dir_all(&husky_internal).unwrap();

    let internal_shim = "#!/bin/sh\n# Generated by husky. Do not edit.\nexit 0\n";
    fs::write(husky_internal.join("pre-commit"), internal_shim).unwrap();

    let user_hook = "#!/bin/sh\nexit 0\n";
    fs::write(husky_dir.join("pre-commit"), user_hook).unwrap();

    git(repo, &["config", "core.hooksPath", ".husky/_"]);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "commit with husky"]);

    // 1. Brownfield preview by default (exit 0, no changes)
    let (code, stdout, _) = run_sajimora(repo, &["init", "--backend", "."]);
    assert_eq!(code, 0);
    assert!(stdout.contains("SAJIMORA INIT PREVIEW"));
    assert!(!repo.join(".sajimora").exists());
    assert_eq!(
        fs::read_to_string(husky_internal.join("pre-commit")).unwrap(),
        internal_shim
    );

    // 2. Apply with --hook-mode chain
    let (code, _, stderr) = run_sajimora(
        repo,
        &["init", "--backend", ".", "--apply", "--hook-mode", "chain"],
    );
    assert_eq!(code, 0, "Failed to apply with chain: {}", stderr);

    // Assert: User hook chained, but internal generated shim is byte-identical untouched!
    let updated_user_hook = fs::read_to_string(husky_dir.join("pre-commit")).unwrap();
    assert!(updated_user_hook.contains("sajimora verify"));
    assert_eq!(
        fs::read_to_string(husky_internal.join("pre-commit")).unwrap(),
        internal_shim
    );

    // 3. Clean restores user hook and leaves git status clean
    let (clean_code, _, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(clean_code, 0);
    assert_eq!(
        fs::read_to_string(husky_dir.join("pre-commit")).unwrap(),
        user_hook
    );

    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    let status_str = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        status_str.trim().is_empty(),
        "Scen2 git status dirty: {:?}",
        status_str
    );
}

#[test]
fn test_scenario_3_bare_custom_hook_atomic_swap() {
    let temp = TempDir::new("scen3");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(
        repo.join("package.json"),
        "{\n  \"name\": \"custom-hook-app\"\n}\n",
    )
    .unwrap();

    let git_hooks = repo.join(".git/hooks");
    fs::create_dir_all(&git_hooks).unwrap();
    let custom_hook = "#!/bin/sh\necho \"running custom precommit\"\nexit 0\n";
    fs::write(git_hooks.join("pre-commit"), custom_hook).unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "commit with custom hook"]);

    // 1. Preview
    let (code, stdout, _) = run_sajimora(repo, &["init", "--backend", "."]);
    assert_eq!(code, 0);
    assert!(stdout.contains("SAJIMORA INIT PREVIEW"));
    assert!(!repo.join(".sajimora").exists());

    // 2. Apply with chain (atomic 3-way swap)
    let (code, _, _) = run_sajimora(
        repo,
        &["init", "--backend", ".", "--apply", "--hook-mode", "chain"],
    );
    assert_eq!(code, 0);

    let orig_hook = git_hooks.join("pre-commit.sajimora-orig");
    assert!(orig_hook.exists());
    assert_eq!(fs::read_to_string(&orig_hook).unwrap(), custom_hook);

    let active_wrapper = fs::read_to_string(git_hooks.join("pre-commit")).unwrap();
    assert!(active_wrapper.contains("pre-commit.sajimora-orig"));
    assert!(active_wrapper.contains("sajimora verify"));

    // 3. Clean restores original hook
    let (clean_code, _, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(clean_code, 0);
    assert!(!orig_hook.exists());
    assert_eq!(
        fs::read_to_string(git_hooks.join("pre-commit")).unwrap(),
        custom_hook
    );

    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    let status_str = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        status_str.trim().is_empty(),
        "Scen3 git status dirty: {:?}",
        status_str
    );
}

#[test]
fn test_scenario_4_external_hooks_path_hard_refusal() {
    let temp = TempDir::new("scen4");
    let repo = temp.path().join("my-repo");
    fs::create_dir_all(&repo).unwrap();

    let external_hooks = temp.path().join("shared-corporate-hooks");
    fs::create_dir_all(&external_hooks).unwrap();

    git(&repo, &["init"]);
    setup_sample_spring_app(&repo);
    fs::write(
        repo.join("package.json"),
        "{\n  \"name\": \"corp-app\"\n}\n",
    )
    .unwrap();

    let ext_str = external_hooks.to_string_lossy().to_string();
    git(&repo, &["config", "core.hooksPath", &ext_str]);

    // Hard refusal even with --apply --hook-mode chain
    let (code, _, stderr) = run_sajimora(
        &repo,
        &["init", "--backend", ".", "--apply", "--hook-mode", "chain"],
    );
    assert_eq!(code, 1);
    assert!(stderr.contains("points outside this repository"));
    assert!(!repo.join(".sajimora").exists());
    assert_eq!(fs::read_dir(&external_hooks).unwrap().count(), 0);
}

#[test]
fn test_scenario_5_crlf_and_4space_indent_exact_preservation() {
    let temp = TempDir::new("scen5");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);

    let original_pkg = "{\r\n    \"name\": \"crlf-app\",\r\n    \"version\": \"1.0.0\",\r\n    \"scripts\": {\r\n        \"build\": \"tsc\"\r\n    }\r\n}\r\n";
    fs::write(repo.join("package.json"), original_pkg).unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "commit with 4-space crlf"]);

    // Init with --hook-mode skip
    let (code, stdout, stderr) =
        run_sajimora(repo, &["init", "--backend", ".", "--hook-mode", "skip"]);
    assert_eq!(
        code, 0,
        "Init failed in scen5: stdout={}\nstderr={}",
        stdout, stderr
    );

    let modified_pkg = fs::read_to_string(repo.join("package.json")).unwrap();
    assert!(
        modified_pkg.contains("\r\n        \"contract:check\":"),
        "scen5 modified_pkg does not contain 8-space (level 2) CRLF contract:check:\n{:?}\nstdout: {}",
        modified_pkg,
        stdout
    );
    assert!(modified_pkg.ends_with("\r\n"));

    // Clean restores byte-identical original
    let (clean_code, _, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(clean_code, 0);

    let restored_pkg = fs::read_to_string(repo.join("package.json")).unwrap();
    assert_eq!(restored_pkg, original_pkg);

    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    let status_str = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        status_str.trim().is_empty(),
        "Scen5 git status dirty: {:?}",
        status_str
    );
}

#[test]
fn test_scenario_6_tracked_artifact_preservation() {
    let temp = TempDir::new("scen6");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(
        repo.join("package.json"),
        "{\n  \"name\": \"tracked-app\"\n}\n",
    )
    .unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "initial commit"]);

    let (code, _, stderr) = run_sajimora(repo, &["init", "--backend", ".", "--hook-mode", "skip"]);
    assert_eq!(code, 0, "Init failed in scen6: {}", stderr);

    // Track backend-contract.json in git
    git(repo, &["add", ".sajimora/backend-contract.json"]);
    git(repo, &["commit", "-m", "commit baseline contract"]);

    // Clean
    let (clean_code, stdout, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(clean_code, 0);
    assert!(stdout.contains("is tracked in git; preserved"));
    assert!(repo.join(".sajimora/backend-contract.json").exists());

    // git status should NOT show any deletion of backend-contract.json!
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    let porcelain = String::from_utf8_lossy(&out.stdout);
    assert!(!porcelain.contains(".sajimora/backend-contract.json"));
}

#[test]
fn test_scenario_7_idempotency() {
    let temp = TempDir::new("scen7");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(
        repo.join("package.json"),
        "{\n  \"name\": \"idempotent-app\"\n}\n",
    )
    .unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "initial commit"]);

    let (code1, _, stderr) = run_sajimora(repo, &["init", "--backend", ".", "--hook-mode", "skip"]);
    assert_eq!(code1, 0, "Init failed in scen7: {}", stderr);

    let manifest_1 = fs::read_to_string(repo.join(".sajimora/init-manifest.json")).unwrap();
    let pkg_1 = fs::read_to_string(repo.join("package.json")).unwrap();

    // Second run
    let (code2, stdout, _) = run_sajimora(repo, &["init", "--backend", ".", "--hook-mode", "skip"]);
    assert_eq!(code2, 0);
    assert!(stdout.contains("Zero changes needed"));

    let manifest_2 = fs::read_to_string(repo.join(".sajimora/init-manifest.json")).unwrap();
    let pkg_2 = fs::read_to_string(repo.join("package.json")).unwrap();

    assert_eq!(manifest_1, manifest_2);
    assert_eq!(pkg_1, pkg_2);
}

#[test]
fn test_scenario_8_interrupted_crash_recovery() {
    let temp = TempDir::new("scen8");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    let original_pkg = "{\n  \"name\": \"crash-app\"\n}\n";
    fs::write(repo.join("package.json"), original_pkg).unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init commit"]);

    // Simulate mid-crash state: status incomplete + leftover .tmp-extract
    let sajimora_dir = repo.join(".sajimora");
    let tmp_extract = sajimora_dir.join(".tmp-extract");
    fs::create_dir_all(&tmp_extract).unwrap();
    fs::write(tmp_extract.join("junk.txt"), "leftover").unwrap();

    let incomplete_manifest = r#"{
  "manifest_version": 1,
  "status": "incomplete",
  "sajimora_version": "0.1.0",
  "initialized_at": "2026-10-20T00:00:00Z",
  "roots": {
    "repo_root": ".",
    "backend_root": ".",
    "frontend_root": null,
    "service_id": "test"
  },
  "owned": {
    "package_json": null,
    "hook": null,
    "gitignore": null
  },
  "artifacts": []
}"#;
    fs::write(sajimora_dir.join("init-manifest.json"), incomplete_manifest).unwrap();

    // Clean unwinds crash state
    let (code, stdout, _) = run_sajimora(repo, &["clean"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("incomplete/interrupted"));
    assert!(!tmp_extract.exists());
    assert!(!sajimora_dir.exists());

    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty());
}

#[test]
fn test_scenario_9_doctor_health_check() {
    let temp = TempDir::new("scen9");
    let repo = temp.path();

    // 1. Doctor on uninitialized repo -> fails with guidance
    let (code, stdout, _) = run_sajimora(repo, &["doctor"]);
    assert_eq!(code, 1);
    assert!(stdout.contains("Missing .sajimora/init-manifest.json"));

    // 2. Initialize
    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(repo.join("package.json"), "{\n  \"name\": \"doc-app\"\n}\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init commit"]);

    let (init_code, _, _) = run_sajimora(repo, &["init", "--backend", "."]);
    assert_eq!(init_code, 0);

    // 3. Doctor on healthy repo -> passes with 0
    let (code, stdout, _) = run_sajimora(repo, &["doctor"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("All Sajimora health checks passed"));
}

#[test]
fn test_scenario_10_dry_run_flag() {
    let temp = TempDir::new("scen10");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(repo.join("package.json"), "{\n  \"name\": \"dry-app\"\n}\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init commit"]);

    // Explicit --dry-run on greenfield -> preview only, zero disk changes
    let (code, stdout, _) = run_sajimora(repo, &["init", "--backend", ".", "--dry-run"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("SAJIMORA INIT PREVIEW"));
    assert!(!repo.join(".sajimora").exists());
}

#[test]
fn test_scenario_11_recursion_guard_and_lefthook() {
    let temp = TempDir::new("scen11");
    let repo = temp.path();

    git(repo, &["init"]);
    setup_sample_spring_app(repo);
    fs::write(repo.join("package.json"), "{\n  \"name\": \"lefthook-app\",\n  \"lint-staged\": {\n    \"*.js\": \"eslint\"\n  }\n}\n").unwrap();
    fs::write(
        repo.join("lefthook.yml"),
        "pre-commit:\n  commands:\n    lint:\n      run: echo lint\n",
    )
    .unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init commit"]);

    // 1. Preview detects Lefthook and lint-staged
    let (code, stdout, _) = run_sajimora(repo, &["init", "--backend", "."]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Lefthook Detected:"));
    assert!(stdout.contains("sajimora verify"));
    assert!(stdout.contains("lint-staged Detected:"));

    // 2. Greenfield hook has recursion guard
    let temp_gf = TempDir::new("scen11_gf");
    let repo_gf = temp_gf.path();
    git(repo_gf, &["init"]);
    setup_sample_spring_app(repo_gf);
    fs::write(
        repo_gf.join("package.json"),
        "{\n  \"name\": \"gf-app\"\n}\n",
    )
    .unwrap();
    git(repo_gf, &["add", "."]);
    git(repo_gf, &["commit", "-m", "init commit"]);

    let (gf_code, _, _) = run_sajimora(repo_gf, &["init", "--backend", "."]);
    assert_eq!(gf_code, 0);
    let hook_content = fs::read_to_string(repo_gf.join(".git/hooks/pre-commit")).unwrap();
    assert!(hook_content.contains("SAJIMORA_VERIFY_ACTIVE"));
    assert!(hook_content.contains("exit 0"));
}
