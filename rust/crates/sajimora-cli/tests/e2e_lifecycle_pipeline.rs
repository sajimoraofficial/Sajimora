//! e2e_lifecycle_pipeline.rs — Pure end-to-end multi-stage lifecycle test.
//!
//! Exercises the full developer lifecycle through real subprocess CLI invocations:
//! 1. `sajimora init --apply` on a real Spring Boot + TypeScript repository.
//! 2. Initial state verification (`sajimora verify` -> LIKELY_PRESERVED).
//! 3. Introducing a breaking change in backend Java DTO.
//! 4. Advisory verification (`sajimora verify` -> LIKELY_VIOLATED, exit code 0).
//! 5. CI / Blocking verification (`sajimora verify --fail-on-violation` -> exit code 1).
//! 6. HTML report generation (`sajimora dashboard --html-out ...`).
//! 7. Complete cleanup (`sajimora clean --force` -> removes owned hooks, scripts, and manifest while preserving user exports).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// RAII guard for temporary test directories, ensuring automatic cleanup on normal exit or panic.
pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-e2e-pipe-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=E2E Tester",
            "-c",
            "user.email=e2e@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git command failed");
    assert!(status.success(), "git command {:?} failed", args);
}

fn run_cli(repo: &Path, args: &[&str]) -> (i32, String, String) {
    let output = Command::new(cli_bin())
        .args(args)
        .current_dir(repo)
        .output()
        .expect("Failed to execute sajimora binary");

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);
    (code, stdout, stderr)
}

fn setup_full_polyglot_repo(repo: &Path) {
    git(repo, &["init"]);

    // 1. Maven backend structure
    let backend_dir = repo.join("backend/src/main/java/com/example/api");
    fs::create_dir_all(&backend_dir).unwrap();
    fs::write(
        repo.join("backend/pom.xml"),
        r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo-backend</artifactId>
  <version>1.0.0</version>
</project>"#,
    )
    .unwrap();

    // Java Spring Controller
    fs::write(
        backend_dir.join("OrderController.java"),
        r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    @GetMapping("/api/orders")
    public OrderResponse getOrders() {
        return new OrderResponse();
    }
}

class OrderResponse {
    public Long orderId;
    public String customerName;
}
"#,
    )
    .unwrap();

    // 2. Frontend TypeScript structure
    let frontend_dir = repo.join("frontend/src");
    fs::create_dir_all(&frontend_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{
  "name": "demo-frontend",
  "version": "1.0.0"
}"#,
    )
    .unwrap();

    // TypeScript Client API
    fs::write(
        frontend_dir.join("orderClient.ts"),
        r#"import axios from 'axios';

export interface OrderResponse {
    orderId: number;
    customerName: string;
}

export async function fetchOrders(): Promise<OrderResponse> {
    const res = await axios.get<OrderResponse>('/api/orders');
    return res.data;
}
"#,
    )
    .unwrap();

    // Root package.json for monorepo tooling
    fs::write(
        repo.join("package.json"),
        r#"{
  "name": "root-repo",
  "private": true
}"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(
        repo,
        &["commit", "-m", "Initial full-stack application commit"],
    );
}

#[test]
fn test_e2e_full_lifecycle_pipeline() {
    let temp_guard = TempDirGuard::new("lifecycle");
    let repo = temp_guard.path();
    setup_full_polyglot_repo(repo);

    // =========================================================================
    // STAGE 1: Repository Initialization (`sajimora init --apply`)
    // =========================================================================
    let (code, stdout, stderr) = run_cli(repo, &["init", "--apply"]);
    assert_eq!(
        code, 0,
        "init --apply must succeed: stderr={stderr}, stdout={stdout}"
    );
    assert!(
        stdout.contains("Sajimora setup complete!"),
        "Init stdout must report success: {stdout}"
    );

    let sajimora_dir = repo.join(".sajimora");
    assert!(sajimora_dir.exists(), ".sajimora directory must exist");
    assert!(
        sajimora_dir.join("init-manifest.json").exists(),
        "init-manifest.json must be written"
    );

    // =========================================================================
    // STAGE 2: Health Check (`sajimora doctor`)
    // =========================================================================
    let (code, stdout, _) = run_cli(repo, &["doctor"]);
    assert_eq!(code, 0, "doctor must pass on fresh init: {stdout}");
    assert!(
        stdout.contains("[PASS]"),
        "doctor must report passing checks"
    );

    // =========================================================================
    // STAGE 3: Baseline Contract Verification (`sajimora verify`)
    // Initial state: Java OrderResponse matches TypeScript OrderResponse.
    // =========================================================================
    let (code, stdout, _) = run_cli(repo, &["verify"]);
    assert_eq!(
        code, 0,
        "verify must succeed on unmodified baseline: {stdout}"
    );
    assert!(
        stdout.contains("ADMISSIBLE")
            || stdout.contains("CLEAN")
            || stdout.contains("LIKELY_PRESERVED"),
        "Initial verification must report clean/admissible contracts: {stdout}"
    );

    // =========================================================================
    // STAGE 4: Introduce Intentional Breaking Change in Java DTO
    // Change `customerName` -> `clientName` (violates TypeScript contract).
    // =========================================================================
    fs::write(
        repo.join("backend/src/main/java/com/example/api/OrderController.java"),
        r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    @GetMapping("/api/orders")
    public OrderResponse getOrders() {
        return new OrderResponse();
    }
}

class OrderResponse {
    public Long orderId;
    public String clientName; // BREAK: renamed from customerName
}
"#,
    )
    .unwrap();

    // =========================================================================
    // STAGE 5: Advisory Verification (`sajimora verify`)
    // By default, Sajimora is advisory: reports LIKELY_VIOLATED with code 0.
    // =========================================================================
    let (code, stdout, _) = run_cli(repo, &["verify"]);
    assert_eq!(
        code, 0,
        "Advisory mode must exit code 0 even on breaks: {stdout}"
    );
    assert!(
        stdout.contains("LIKELY VIOLATED")
            || stdout.contains("LIKELY_VIOLATED")
            || stdout.contains("BREAKING CONTRACT REGRESSIONS"),
        "Advisory verify must catch breaking field change: {stdout}"
    );

    // =========================================================================
    // STAGE 6: Blocking CI Mode (`sajimora verify --fail-on-violation`)
    // In CI mode, breaking changes must strictly fail the build with exit code 1.
    // =========================================================================
    let (code, stdout, _) = run_cli(repo, &["verify", "--fail-on-violation"]);
    assert_eq!(
        code, 1,
        "CI verification with --fail-on-violation must return exit code 1: {stdout}"
    );

    // =========================================================================
    // STAGE 7: Interactive Terminal & HTML Dashboard Export (`sajimora dashboard`)
    // =========================================================================
    let html_report = repo.join("e2e-report.html");
    let (code, stdout, _) = run_cli(
        repo,
        &["dashboard", "--html-out", html_report.to_str().unwrap()],
    );
    assert_eq!(code, 0, "dashboard export must exit 0: {stdout}");
    assert!(
        html_report.exists(),
        "HTML report file must be written to disk"
    );

    let html_content = fs::read_to_string(&html_report).unwrap();
    assert!(
        html_content.contains("<!DOCTYPE html>"),
        "Report must be valid HTML5"
    );
    assert!(
        html_content.contains("OrderController") || html_content.contains("/api/orders"),
        "HTML report must display the analyzed endpoints: {html_content}"
    );

    // =========================================================================
    // STAGE 8: Complete Cleanup (`sajimora clean --force`)
    // Surgical cleanup: removes owned hooks, scripts, and manifest,
    // while deliberately preserving user-requested exports (e2e-report.html).
    // =========================================================================
    let (code, stdout, _) = run_cli(repo, &["clean", "--force"]);
    assert_eq!(code, 0, "clean --force must succeed: {stdout}");

    // 1. Manifest must be removed
    assert!(
        !sajimora_dir.join("init-manifest.json").exists(),
        "init-manifest.json must be removed on clean"
    );

    // 2. Git hook must be unwound (either removed or contains no sajimora invocation)
    let pre_commit_hook = repo.join(".git/hooks/pre-commit");
    if pre_commit_hook.exists() {
        let hook_content = fs::read_to_string(&pre_commit_hook).unwrap_or_default();
        assert!(
            !hook_content.contains("sajimora verify"),
            "Pre-commit hook must not retain sajimora verify after clean"
        );
    }

    // 3. Injected package.json scripts must be stripped
    let pkg_json_path = repo.join("package.json");
    if pkg_json_path.exists() {
        let pkg_content = fs::read_to_string(&pkg_json_path).unwrap_or_default();
        assert!(
            !pkg_content.contains("sajimora:verify"),
            "package.json must not retain injected sajimora scripts"
        );
    }

    // 4. Injected .gitignore entries must be cleaned
    let gitignore_path = repo.join(".gitignore");
    if gitignore_path.exists() {
        let gi_content = fs::read_to_string(&gitignore_path).unwrap_or_default();
        assert!(
            !gi_content.contains("# Sajimora transient artifacts"),
            ".gitignore must not retain Sajimora header comment"
        );
    }

    // 5. Intentionally retained files: user-requested report export must NOT be deleted by clean
    assert!(
        html_report.exists(),
        "User-requested export report e2e-report.html must be intentionally preserved by clean"
    );
}
