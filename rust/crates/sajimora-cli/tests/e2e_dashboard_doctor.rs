//! e2e_dashboard_doctor.rs — End-to-end tests for `sajimora doctor` and `sajimora dashboard`.
//!
//! Validates:
//! 1. `doctor` failure on missing directory or missing `.sajimora` manifest.
//! 2. `doctor` success on initialized, healthy repository with valid artifacts.
//! 3. `doctor` failure on corrupted / unparseable artifact.
//! 4. `dashboard` terminal output rendering architecture topology and health metrics.
//! 5. `dashboard --html-out` generating a standalone valid HTML5 dashboard file with valid DOM & scripts.

use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
            "sajimora-e2e-dash-{tag}-{}-{nanos}",
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

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

fn setup_healthy_repo(repo: &Path) {
    let git = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(git.status.success());
    let sajimora_dir = repo.join(".sajimora");
    fs::create_dir_all(&sajimora_dir).unwrap();
    fs::create_dir_all(repo.join("backend")).unwrap();
    fs::create_dir_all(repo.join("frontend")).unwrap();

    // 1. Write init manifest
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
            },
            {
                "path": ".sajimora/frontend-contract.json",
                "kind": "frontend",
                "is_tracked": true
            }
        ]
    });
    fs::write(
        sajimora_dir.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    // 2. Write valid backend contract artifact
    let base_bytes =
        fs::read_to_string(fixtures().join("envelopes/backend_complete.json")).unwrap();
    fs::write(sajimora_dir.join("backend-contract.json"), base_bytes).unwrap();

    // 3. Write valid frontend contract artifact
    let frontend_bytes =
        fs::read_to_string(fixtures().join("envelopes/frontend_complete.json")).unwrap();
    fs::write(sajimora_dir.join("frontend-contract.json"), frontend_bytes).unwrap();
}

#[test]
fn doctor_fails_on_uninitialized_repository() {
    let temp_guard = TempDirGuard::new("doctor-uninit");
    let repo = temp_guard.path();

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()
        .expect("Failed to execute sajimora doctor");

    assert_eq!(
        status.code(),
        Some(1),
        "doctor must exit with code 1 when .sajimora is missing"
    );
}

#[test]
fn doctor_succeeds_on_healthy_repository() {
    let temp_guard = TempDirGuard::new("doctor-healthy");
    let repo = temp_guard.path();
    setup_healthy_repo(repo);

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        status_or_output_successful(&output),
        "doctor must succeed on healthy repository, got stdout: {stdout}"
    );
    assert!(stdout.contains("Diagnosing setup health"));
    assert!(stdout.contains("All basic checks passed") || stdout.contains("[PASS]"));
}

#[test]
fn doctor_catches_corrupted_contract_artifact() {
    let temp_guard = TempDirGuard::new("doctor-corrupt");
    let repo = temp_guard.path();
    setup_healthy_repo(repo);

    // Corrupt backend contract with invalid JSON
    fs::write(
        repo.join(".sajimora/backend-contract.json"),
        "{ not valid json ...",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    assert_eq!(
        output.status.code(),
        Some(1),
        "doctor must fail on corrupted contract artifact"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("FAIL") || stdout.contains("Could not parse backend contract"),
        "doctor output must flag the unparseable backend contract: {stdout}"
    );
}

#[test]
fn dashboard_terminal_renders_topology_and_contracts() {
    let temp_guard = TempDirGuard::new("dashboard-term");
    let repo = temp_guard.path();
    setup_healthy_repo(repo);

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("dashboard")
        .arg("--repo")
        .arg(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora dashboard");

    assert!(
        output.status.success(),
        "dashboard command must exit 0, got error: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SAJIMORA CONTRACT HEALTH DASHBOARD"),
        "Dashboard output must contain ASCII header: {stdout}"
    );
    assert!(
        stdout.contains("ARCHITECTURE TOPOLOGY"),
        "Dashboard output must contain ARCHITECTURE TOPOLOGY: {stdout}"
    );
    assert!(
        stdout.contains("CONTRACT COMPATIBILITY STATUS"),
        "Dashboard output must contain CONTRACT COMPATIBILITY STATUS: {stdout}"
    );
}

#[test]
fn dashboard_generates_valid_html5_file() {
    let temp_guard = TempDirGuard::new("dashboard-html");
    let repo = temp_guard.path();
    setup_healthy_repo(repo);

    let html_out = repo.join("test-dashboard.html");

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("dashboard")
        .arg("--repo")
        .arg(&repo)
        .arg("--html-out")
        .arg(&html_out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora dashboard --html-out");

    assert!(
        output.status.success(),
        "dashboard --html-out must exit 0, got: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(
        html_out.exists(),
        "HTML dashboard output file must be created at {:?}",
        html_out
    );

    let html = fs::read_to_string(&html_out).unwrap();

    // 1. Structural HTML5 validation
    assert!(
        html.contains("<!DOCTYPE html>"),
        "Output must declare <!DOCTYPE html>"
    );
    assert!(
        html.contains("<html") && html.contains("</html>"),
        "Output must contain <html> tags"
    );
    assert!(
        html.contains("<head>") && html.contains("</head>"),
        "Output must contain <head> tags"
    );
    assert!(
        html.contains("<meta charset=\"utf-8\">") || html.contains("<meta charset=\"UTF-8\">"),
        "Must declare utf-8 charset"
    );
    assert!(
        html.contains("<body>") && html.contains("</body>"),
        "Output must contain <body> tags"
    );

    // 2. Sajimora branding and data elements
    assert!(
        html.contains("Sajimora"),
        "HTML must contain 'Sajimora' product name"
    );

    // 3. Self-contained CSS & JS integrity
    assert!(
        html.contains("<style>") && html.contains("</style>"),
        "HTML dashboard must embed self-contained <style> blocks"
    );
    assert!(
        html.contains("<script>") && html.contains("</script>"),
        "HTML dashboard must embed self-contained <script> blocks"
    );

    // 4. Ensure no unrendered template placeholders remain
    assert!(
        !html.contains("{{") && !html.contains("}}"),
        "Generated dashboard must not contain unrendered mustache/template tokens: {{ ... }}"
    );
    assert!(
        !html.contains("__REPLACE_"),
        "Generated dashboard must not contain unprocessed placeholder tokens"
    );

    // 5. Verify basic JS structural sanity (balanced braces)
    let open_braces = html.matches('{').count();
    let close_braces = html.matches('}').count();
    assert_eq!(
        open_braces, close_braces,
        "HTML dashboard must have balanced braces across inline styles and scripts (open={open_braces}, close={close_braces})"
    );
}

fn status_or_output_successful(output: &std::process::Output) -> bool {
    output.status.success()
}
