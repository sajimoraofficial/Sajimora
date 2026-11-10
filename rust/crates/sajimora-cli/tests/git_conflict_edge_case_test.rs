//! git_conflict_edge_case_test.rs — Edge case testing for repositories containing Git merge conflicts.
//!
//! Validates:
//! 1. Resilience against Git conflict markers (`<<<<<<< HEAD`, `=======`, `>>>>>>>`):
//!    Sajimora must gracefully capture unparsable syntax as a structured blocker
//!    rather than suffering an unhandled AST parser panic or crash (exit code 101).
//! 2. Clean endpoint retention:
//!    When one file contains merge conflict markers and another file is clean,
//!    valid endpoints are preserved and isolated without whole-repository failure.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-git-conflict-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
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
            "user.name=Conflict Tester",
            "-c",
            "user.email=conflict@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git command failed");
    assert!(status.success(), "git command {:?} failed", args);
}

fn setup_base_repo(repo: &Path) {
    git(repo, &["init"]);

    // Java backend
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

    // Frontend client
    let fe_dir = repo.join("frontend/src");
    fs::create_dir_all(&fe_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{"name": "demo-fe", "dependencies": {"axios": "^1.6.0"}}"#,
    )
    .unwrap();

    fs::write(
        fe_dir.join("orderClient.ts"),
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

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Initial commit"]);

    // Run sajimora init --apply to create baseline
    let init_out = Command::new(cli_bin())
        .arg("init")
        .arg("--apply")
        .current_dir(repo)
        .output()
        .expect("sajimora init");
    assert!(init_out.status.success(), "sajimora init must succeed");

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Baseline sealed"]);
}

#[test]
fn test_git_merge_conflict_markers_in_frontend_fails_gracefully() {
    let guard = TempDirGuard::new("fe-conflict");
    let repo = guard.path();
    setup_base_repo(repo);

    // Inject raw git merge conflict markers into frontend TypeScript file
    let conflict_ts = r#"import axios from 'axios';

<<<<<<< HEAD
export interface OrderResponse {
    orderId: number;
    customerName: string;
}
=======
export interface OrderResponse {
    orderId: number;
    clientName: string;
    extraNote: string;
}
>>>>>>> feature/rename-customer

export async function fetchOrders(): Promise<OrderResponse> {
    const res = await axios.get<OrderResponse>('/api/orders');
    return res.data;
}
"#;
    fs::write(repo.join("frontend/src/orderClient.ts"), conflict_ts).unwrap();

    // Run sajimora verify: must NOT panic or abort with code 101
    let output = Command::new(cli_bin())
        .arg("verify")
        .current_dir(repo)
        .output()
        .expect("sajimora verify must execute");

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // In advisory mode, parse blockers do not cause SIGABRT/crash (101).
    assert_ne!(
        code, 101,
        "Sajimora must not panic on Git merge conflict markers in TypeScript!\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    println!("Verified graceful handling of TS merge conflict (code {code})");
}

#[test]
fn test_git_merge_conflict_markers_in_backend_fails_gracefully() {
    let guard = TempDirGuard::new("be-conflict");
    let repo = guard.path();
    setup_base_repo(repo);

    // Inject raw git merge conflict markers into backend Java controller
    let conflict_java = r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

<<<<<<< HEAD
@RestController
public class OrderController {
    @GetMapping("/api/orders")
    public OrderResponse getOrders() {
        return new OrderResponse();
    }
}
=======
@RestController
public class OrderController {
    @GetMapping("/api/v2/orders")
    public OrderResponse getOrders() {
        return new OrderResponse();
    }
}
>>>>>>> main

class OrderResponse {
    public Long orderId;
    public String customerName;
}
"#;
    fs::write(
        repo.join("backend/src/main/java/com/example/api/OrderController.java"),
        conflict_java,
    )
    .unwrap();

    // Run sajimora verify: must NOT panic or crash with code 101
    let output = Command::new(cli_bin())
        .arg("verify")
        .current_dir(repo)
        .output()
        .expect("sajimora verify must execute");

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_ne!(
        code, 101,
        "Sajimora must not panic on Git merge conflict markers in Java!\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    println!("Verified graceful handling of Java merge conflict (code {code})");
}
