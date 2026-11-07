//! run_pipeline_test.rs — Integration tests for unified `sajimora run` pipeline.
//!
//! Validates:
//! 1. `sajimora run --help`
//! 2. Uninitialized repository behavior (auto-detects missing manifest in Stage 1)
//! 3. Initialized repository with `--skip-live` executes stages and writes pipeline report
//! 4. Test synthesis collision handling: user file with non-Sajimora comment is never overwritten

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
            "sajimora-run-test-{tag}-{}-{nanos}",
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
            "user.name=Pipeline Tester",
            "-c",
            "user.email=pipeline@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git execution failed");
    assert!(status.success(), "git {:?} failed in {:?}", args, repo);
}

#[test]
fn test_run_help_shows_unified_pipeline() {
    let output = Command::new(cli_bin())
        .args(["run", "--help"])
        .output()
        .expect("failed to execute sajimora run --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("unified end-to-end Sajimora verification pipeline")
            || stdout.contains("sajimora run"),
        "Unexpected help output: {}",
        stdout
    );
    assert!(stdout.contains("--skip-live"));
}

#[test]
fn test_run_uninitialized_repo_notices_missing_manifest() {
    let guard = TempDirGuard::new("uninit");
    let repo = guard.path();
    git(repo, &["init"]);

    let output = Command::new(cli_bin())
        .args(["run", "--repo", repo.to_str().unwrap(), "--skip-live"])
        .output()
        .expect("failed to execute sajimora run");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);
    assert!(
        combined.contains("Health Check") || combined.contains("init-manifest.json"),
        "Pipeline should report health check or manifest notice on uninitialized repo: {}",
        combined
    );
}

#[test]
fn test_run_initialized_repo_skip_live_completes() {
    let guard = TempDirGuard::new("init-skip-live");
    let repo = guard.path();
    git(repo, &["init"]);

    // Write minimal Spring Boot backend
    let java_dir = repo.join("src/main/java/com/example");
    fs::create_dir_all(&java_dir).unwrap();
    fs::write(
        repo.join("pom.xml"),
        r#"<project><modelVersion>4.0.0</modelVersion>
<groupId>com.example</groupId><artifactId>test-app</artifactId><version>0.0.1</version>
<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>
</project>"#,
    ).unwrap();

    fs::write(
        java_dir.join("HelloController.java"),
        r#"package com.example;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {
    @GetMapping("/api/hello")
    public String hello() { return "world"; }
}
"#,
    )
    .unwrap();

    // Write minimal frontend client
    let fe_dir = repo.join("frontend/src");
    fs::create_dir_all(&fe_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{"name": "test-fe", "version": "1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        fe_dir.join("api.ts"),
        r#"export async function getHello(): Promise<string> {
    const res = await fetch('/api/hello');
    return res.text();
}
"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Initial commit"]);

    // Initialize sajimora
    let init_out = Command::new(cli_bin())
        .args(["init", "--apply"])
        .current_dir(repo)
        .output()
        .expect("failed to execute sajimora init");
    assert!(
        init_out.status.success(),
        "init failed: {}",
        String::from_utf8_lossy(&init_out.stderr)
    );

    // Run unified pipeline with --skip-live
    let run_out = Command::new(cli_bin())
        .args(["run", "--skip-live", "--repo", repo.to_str().unwrap()])
        .output()
        .expect("failed to execute sajimora run");

    assert!(
        run_out.status.success(),
        "run failed: stdout={}, stderr={}",
        String::from_utf8_lossy(&run_out.stdout),
        String::from_utf8_lossy(&run_out.stderr)
    );

    let stdout = String::from_utf8_lossy(&run_out.stdout);
    assert!(
        stdout.contains("Health Check"),
        "Missing Health Check stage"
    );
    assert!(
        stdout.contains("Contract Lattice"),
        "Missing Contract Lattice stage"
    );
    assert!(
        stdout.contains("CONSOLIDATED PIPELINE REPORT"),
        "Missing consolidated pipeline report"
    );

    // Verify pipeline report was written to disk
    let report_file = repo.join(".sajimora/pipeline-report.json");
    assert!(
        report_file.exists(),
        "Expected .sajimora/pipeline-report.json to exist"
    );
    let report_content = fs::read_to_string(report_file).unwrap();
    assert!(report_content.contains("sajimora_run"));
}

#[test]
fn test_collision_refusal_on_user_authored_test() {
    let guard = TempDirGuard::new("collision");
    let test_file = guard.path().join("UserAuthoredTest.java");

    let original = b"// Manual test written by dev\nclass UserAuthoredTest {}";
    fs::write(&test_file, original).unwrap();
    let contract = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures/envelopes/backend_complete.json");
    let output = Command::new(cli_bin())
        .arg("generate-tests")
        .arg("--contract")
        .arg(contract)
        .arg("--out")
        .arg(&test_file)
        .current_dir(guard.path())
        .output()
        .expect("failed to run generate-tests");
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("COLLISION_REFUSAL"));
    assert_eq!(fs::read(&test_file).unwrap(), original);
}

fn configured_repo(repo: &Path, backend: &str, frontend: Option<&str>) {
    fs::create_dir_all(repo.join(".sajimora")).unwrap();
    let manifest = serde_json::json!({
        "manifest_version": 1, "status": "complete", "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-28T00:00:00Z",
        "roots": {"repo_root": repo, "backend_root": backend, "frontend_root": frontend, "service_id": "test-service"},
        "owned": {"package_json": null, "hook": null, "gitignore": null}, "artifacts": []
    });
    fs::write(
        repo.join(".sajimora/init-manifest.json"),
        manifest.to_string(),
    )
    .unwrap();
}

fn spring_repo(repo: &Path) {
    configured_repo(repo, ".", None);
    let src = repo.join("src/main/java/com/example");
    fs::create_dir_all(&src).unwrap();
    fs::write(repo.join("pom.xml"), "<project><parent><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent><dependencies><artifactId>spring-boot-starter-web</artifactId><artifactId>spring-boot-starter-test</artifactId></dependencies></project>").unwrap();
    fs::write(src.join("HelloController.java"), "package com.example; import org.springframework.web.bind.annotation.*; @RestController public class HelloController { @GetMapping(\"/hello\") public String hello() { return \"hello\"; } }").unwrap();
}

fn pipeline_json(repo: &Path, skip_live: bool) -> (i32, serde_json::Value) {
    let report_path = repo.join("audit-pipeline-report.json");
    let mut command = Command::new(cli_bin());
    command
        .args(["run", "--repo"])
        .arg(repo)
        .args(["--json", "--fail-on-violation", "--out"])
        .arg(&report_path)
        .current_dir(repo);
    if skip_live {
        command.arg("--skip-live");
    }
    let output = command.output().unwrap();
    let report = serde_json::from_slice(&fs::read(report_path).unwrap()).unwrap();
    (output.status.code().unwrap(), report)
}

fn stage<'a>(report: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    report["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap()
}

#[test]
fn pipeline_missing_backend_is_an_error() {
    let guard = TempDirGuard::new("missing-backend");
    configured_repo(guard.path(), "missing", None);
    let (exit, report) = pipeline_json(guard.path(), true);
    assert_eq!(exit, 1);
    assert_eq!(stage(&report, "contract_extraction")["status"], "ERROR");
    assert_ne!(report["overall_verdict"], "LIKELY_PRESERVED");
    assert!(!report["recommendations"]
        .to_string()
        .contains("Safe to commit"));
}

#[test]
fn pipeline_corrupt_baseline_is_an_error() {
    let guard = TempDirGuard::new("corrupt-baseline");
    let repo = guard.path();
    spring_repo(repo);
    configured_repo(repo, ".", Some("frontend"));
    fs::create_dir_all(repo.join("frontend")).unwrap();
    fs::write(
        repo.join("frontend/api.ts"),
        "export async function hello(): Promise<string> { return (await fetch('/hello')).text(); }",
    )
    .unwrap();
    fs::write(
        repo.join(".sajimora/backend-contract.json"),
        "invalid baseline",
    )
    .unwrap();
    let (exit, report) = pipeline_json(repo, true);
    assert_eq!(exit, 1);
    assert_eq!(
        stage(&report, "cross_language_verification")["status"],
        "ERROR"
    );
    assert_eq!(
        fs::read_to_string(repo.join(".sajimora/backend-contract.json")).unwrap(),
        "invalid baseline"
    );
}

fn mock_maven(repo: &Path, xml: &str, exit: i32) {
    let count = |key: &str| {
        xml.split(&format!("{key}=\""))
            .nth(1)
            .and_then(|part| part.split('"').next())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0)
    };
    let mut expanded = xml.to_string();
    if xml.ends_with("/>") && count("tests") > 0 {
        expanded = format!("{}>", xml.trim_end_matches("/>"));
        for index in 0..count("tests") {
            let outcome = if index < count("failures") {
                "<failure/>"
            } else if index < count("failures") + count("errors") {
                "<error/>"
            } else if index < count("failures") + count("errors") + count("skipped") {
                "<skipped/>"
            } else {
                ""
            };
            expanded.push_str(&format!(
                "<testcase name=\"case{index}\">{outcome}</testcase>"
            ));
        }
        expanded.push_str("</testsuite>");
    }
    let xml = expanded.as_str();
    let reports = repo.join("target/surefire-reports");
    fs::create_dir_all(&reports).unwrap();
    let script = if cfg!(windows) {
        format!("@echo off\r\n>target\\surefire-reports\\TEST-GeneratedContractTest.xml echo {}\r\nexit /b {exit}\r\n", xml.replace('<', "^<").replace('>', "^>"))
    } else {
        format!("#!/bin/sh\nprintf '%s' '{xml}' > target/surefire-reports/TEST-GeneratedContractTest.xml\nexit {exit}\n")
    };
    let wrapper = repo.join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
    fs::write(&wrapper, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn pipeline_rejects_failed_process_even_with_passing_xml() {
    let guard = TempDirGuard::new("failed-runner");
    spring_repo(guard.path());
    mock_maven(guard.path(), "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/>", 1);
    let (exit, report) = pipeline_json(guard.path(), false);
    assert_eq!(exit, 1);
    assert_ne!(stage(&report, "live_contract_tests")["status"], "PASS");
}

#[test]
fn pipeline_rejects_failed_and_skipped_and_zero_and_malformed_xml() {
    for (tag, xml) in [
        ("failure", "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"1\" errors=\"0\" skipped=\"0\"/>"),
        ("skipped", "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"1\"/>"),
        ("zero", "<testsuite name=\"GeneratedContractTest\" tests=\"0\" failures=\"0\" errors=\"0\" skipped=\"0\"/>"),
        ("malformed", "<testsuite tests=\"oops\""),
    ] {
        let guard = TempDirGuard::new(tag);
        spring_repo(guard.path());
        mock_maven(guard.path(), xml, 0);
        let (exit, report) = pipeline_json(guard.path(), false);
        assert_eq!(exit, 1, "{tag}");
        assert_ne!(stage(&report, "live_contract_tests")["status"], "PASS", "{tag}");
    }
}

#[test]
fn pipeline_does_not_trust_stale_test_reports() {
    let guard = TempDirGuard::new("stale-results");
    spring_repo(guard.path());
    mock_maven(guard.path(), "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/>", 0);
    let wrapper = guard
        .path()
        .join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
    fs::write(
        &wrapper,
        if cfg!(windows) {
            "@echo off\r\nexit /b 0\r\n"
        } else {
            "#!/bin/sh\nexit 0\n"
        },
    )
    .unwrap();
    fs::write(guard.path().join("target/surefire-reports/TEST-GeneratedContractTest.xml"), "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/>").unwrap();
    let (exit, report) = pipeline_json(guard.path(), false);
    assert_eq!(exit, 1);
    assert_ne!(stage(&report, "live_contract_tests")["status"], "PASS");
}

#[test]
fn pipeline_requires_results_for_the_generated_suite() {
    let guard = TempDirGuard::new("wrong-suite");
    spring_repo(guard.path());
    mock_maven(guard.path(), "<testsuite name=\"OtherContractTest\" tests=\"1\" failures=\"0\" errors=\"0\" skipped=\"0\"/>", 0);
    let (exit, report) = pipeline_json(guard.path(), false);
    assert_eq!(exit, 1);
    assert_ne!(stage(&report, "live_contract_tests")["status"], "PASS");
}

#[test]
fn pipeline_requires_the_emitted_generated_suite_count() {
    let guard = TempDirGuard::new("wrong-suite-count");
    spring_repo(guard.path());
    mock_maven(guard.path(), "<testsuite name=\"GeneratedContractTest\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/>", 0);
    let (exit, report) = pipeline_json(guard.path(), false);
    let live = stage(&report, "live_contract_tests");
    assert_eq!(exit, 1);
    assert_eq!(live["status"], "INCONCLUSIVE");
    assert_eq!(live["details"]["expected_generated_suite"]["tests"], 1);
    assert_eq!(live["details"]["generated_suite_tests"], 2);
}

#[test]
fn pipeline_reports_fresh_execution_counts_and_all_six_stages() {
    let guard = TempDirGuard::new("fresh-results");
    spring_repo(guard.path());
    mock_maven(guard.path(), "<testsuite name=\"GeneratedContractTest\" tests=\"1\" failures=\"0\" errors=\"0\" skipped=\"0\"/>", 0);
    let (_, report) = pipeline_json(guard.path(), false);
    let live = stage(&report, "live_contract_tests");
    assert_eq!(live["status"], "PASS");
    assert_eq!(live["details"]["tests_run"], 1);
    assert_eq!(live["details"]["tests_passed"], 1);
    assert_eq!(live["details"]["generated_suite_tests"], 1);
    assert_eq!(live["details"]["attempts"][0]["exit_code"], 0);
    assert!(live["details"]["assertions_completed"].is_null());
    let names: Vec<_> = report["stages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|stage| stage["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "health_check",
            "contract_extraction",
            "cross_language_verification",
            "git_endpoint_impact",
            "test_synthesis",
            "live_contract_tests"
        ]
    );
    let generated = stage(&report, "test_synthesis")["details"]["generated_file"]
        .as_str()
        .unwrap();
    assert!(Path::new(generated)
        .canonicalize()
        .unwrap()
        .starts_with(guard.path().canonicalize().unwrap()));
}

#[test]
fn pipeline_advisory_exit_does_not_hide_a_real_comparison_finding() {
    let guard = TempDirGuard::new("advisory-finding");
    let repo = guard.path();
    spring_repo(repo);
    configured_repo(repo, ".", Some("frontend"));
    fs::create_dir_all(repo.join("frontend")).unwrap();
    fs::write(
        repo.join("frontend/api.ts"),
        "export async function hello(): Promise<number> { return (await fetch('/hello')).json(); }",
    )
    .unwrap();
    let output = Command::new(cli_bin())
        .args(["run", "--repo"])
        .arg(repo)
        .args(["--json", "--skip-live"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let comparison = stage(&report, "cross_language_verification");
    assert_eq!(comparison["status"], "VIOLATION");
    assert!(comparison["details"]["breaking_changes"].as_u64().unwrap() > 0);
    assert!(!report["recommendations"]
        .to_string()
        .contains("Safe to commit"));
}
