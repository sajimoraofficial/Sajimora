//! svn_integration_test.rs — Comprehensive integration tests for Sajimora on Subversion (SVN) repositories.
//!
//! Validates:
//! 1. `sajimora doctor` identifies an SVN working copy (.svn).
//! 2. `sajimora init` on an SVN working copy initializes contracts without forcing Git hooks or .gitignore.
//! 3. `sajimora verify` operates on an SVN working copy with baseline contracts.
//! 4. `sajimora clean` cleanly removes Sajimora state in an SVN repo without failing on git commands.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
        let path = std::env::temp_dir().join(format!("sajimora-svn-test-{tag}-{nanos}"));
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

fn create_mock_spring_svn_project(root: &Path) {
    // Create .svn folder to mark as SVN working copy
    fs::create_dir_all(root.join(".svn")).unwrap();

    // Create minimal Spring Boot Java source
    let java_dir = root.join("src/main/java/com/example");
    fs::create_dir_all(&java_dir).unwrap();
    fs::write(
        java_dir.join("HelloController.java"),
        r#"package com.example;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {
    @GetMapping("/api/hello")
    public String hello() {
        return "Hello SVN";
    }
}
"#,
    )
    .unwrap();

    // Create pom.xml
    fs::write(
        root.join("pom.xml"),
        r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
</project>
"#,
    )
    .unwrap();
}

#[test]
fn test_svn_doctor_detects_working_copy() {
    let temp = TempDir::new("doc-svn");
    let repo = temp.path();
    create_mock_spring_svn_project(repo);

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("valid Subversion (SVN) working copy detected"),
        "stdout should confirm SVN: {stdout}"
    );
}

#[test]
fn test_svn_init_and_clean_lifecycle() {
    let temp = TempDir::new("init-svn");
    let repo = temp.path();
    create_mock_spring_svn_project(repo);

    // 1. Run init --apply
    let init_out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["init", "--apply", "--repo"])
        .arg(repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run sajimora init");

    let stdout = String::from_utf8_lossy(&init_out.stdout);
    let stderr = String::from_utf8_lossy(&init_out.stderr);
    assert!(
        init_out.status.success(),
        "sajimora init must succeed on SVN repo. stdout:\n{stdout}\nstderr:\n{stderr}"
    );

    // Verify .gitignore was NOT forcibly created since this is SVN
    assert!(
        !repo.join(".gitignore").exists(),
        ".gitignore should not be created for an SVN-only project"
    );

    // Verify contracts and manifest exist
    assert!(repo.join(".sajimora/init-manifest.json").exists());
    assert!(repo.join(".sajimora/backend-contract.json").exists());

    // 2. Run doctor on initialized SVN repo
    let doc_out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("doctor")
        .arg("--repo")
        .arg(repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run doctor");
    let doc_stdout = String::from_utf8_lossy(&doc_out.stdout);
    assert!(
        doc_stdout.contains("INITIALIZED"),
        "Doctor should detect initialized state: {doc_stdout}"
    );

    // 3. Run verify on SVN repo
    let verify_out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["verify", "--repo"])
        .arg(repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run verify");
    let ver_stdout = String::from_utf8_lossy(&verify_out.stdout);
    let ver_stderr = String::from_utf8_lossy(&verify_out.stderr);
    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed on SVN repo. stdout:\n{ver_stdout}\nstderr:\n{ver_stderr}"
    );

    // 4. Run clean --force on SVN repo
    let clean_out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["clean", "--force", "--repo"])
        .arg(repo)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run clean");
    let clean_stdout = String::from_utf8_lossy(&clean_out.stdout);
    let clean_stderr = String::from_utf8_lossy(&clean_out.stderr);
    assert!(
        clean_out.status.success(),
        "sajimora clean must succeed on SVN repo. stdout:\n{clean_stdout}\nstderr:\n{clean_stderr}"
    );
    assert!(!repo.join(".sajimora").exists());
}
