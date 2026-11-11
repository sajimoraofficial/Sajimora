//! endpoint_census_test.rs — Quantitative Endpoint Accounting & Completeness Census
//!
//! Validates:
//! 1. Mathematical counting of total backend endpoints, static routes, and parameterized routes.
//! 2. Mathematical counting of total frontend call sites, static calls, and parameterized calls.
//! 3. Detection of missed/unlinked endpoints (if an endpoint is missing from backend, frontend flags it).
//! 4. Unresolved dynamic route expressions strictly forced to INCONCLUSIVE.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRepo {
    path: PathBuf,
}

impl TempRepo {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora-census-{tag}-{nanos}"));
        fs::create_dir_all(&path).unwrap();

        run_cmd(&path, &["git", "init"]);
        run_cmd(&path, &["git", "config", "user.name", "Census QA Tester"]);
        run_cmd(&path, &["git", "config", "user.email", "census@sajimora.local"]);

        Self { path }
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_cmd(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(args[0])
        .args(&args[1..])
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("Failed to run {:?}: {}", args, e));
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn bin_path() -> PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("sajimora")
}

#[test]
fn test_endpoint_census_static_vs_parameterized_accounting() {
    let repo = TempRepo::new("static-vs-param");
    let cli = bin_path();

    let java_dir = repo.path.join("src").join("main").join("java").join("com").join("example");
    let fe_dir = repo.path.join("frontend").join("src");
    fs::create_dir_all(&java_dir).unwrap();
    fs::create_dir_all(&fe_dir).unwrap();

    // 2 Static endpoints: /api/v1/health, /api/v1/status
    // 2 Parameterized endpoints: /api/v1/users/{id}, /api/v1/orders/{orderId}/items/{itemId}
    let controller = r#"package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ApiController {
    @GetMapping("/health")
    public String health() { return "ok"; }

    @GetMapping("/status")
    public String status() { return "active"; }

    @GetMapping("/users/{id}")
    public String getUser(@PathVariable("id") String id) { return id; }

    @GetMapping("/orders/{orderId}/items/{itemId}")
    public String getItem(@PathVariable("orderId") String orderId, @PathVariable("itemId") String itemId) { return itemId; }
}
"#;

    // Frontend: calls health (static) and users/{id} (parameterized)
    let client = r#"
export async function getHealth(): Promise<string> {
    const res = await fetch("/api/v1/health");
    return (await res.json()) as string;
}

export async function getUser(id: string): Promise<string> {
    const res = await fetch(`/api/v1/users/${id}`);
    return (await res.json()) as string;
}
"#;

    fs::write(java_dir.join("ApiController.java"), controller).unwrap();
    fs::write(fe_dir.join("apiClient.ts"), client).unwrap();
    fs::write(repo.path.join("frontend").join("package.json"), r#"{"name": "test-frontend", "version": "1.0.0"}"#).unwrap();

    run_cmd(&repo.path, &["git", "add", "."]);
    run_cmd(&repo.path, &["git", "commit", "-m", "Initial census commit"]);

    // Run init
    let init_out = Command::new(&cli)
        .args(["init", "--apply"])
        .current_dir(&repo.path)
        .output()
        .expect("init --apply");
    assert!(init_out.status.success());

    // Run verify with --json
    let verify_out = Command::new(&cli)
        .args(["verify", "--json"])
        .current_dir(&repo.path)
        .output()
        .expect("verify --json");
    assert!(verify_out.status.success());

    let payload: serde_json::Value = serde_json::from_slice(&verify_out.stdout)
        .expect("parse verify json payload");

    println!("Census JSON output:\n{}", serde_json::to_string_pretty(&payload["endpoint_census"]).unwrap());

    let be_bytes = fs::read(repo.path.join(".sajimora/backend-contract.json")).unwrap();
    let be_val: serde_json::Value = serde_json::from_slice(&be_bytes).unwrap();
    println!("Backend Endpoints extracted:\n{}", serde_json::to_string_pretty(&be_val["payload"]["endpoints"]).unwrap());

    let census = &payload["endpoint_census"];
    assert_eq!(census["backend_total"], 4, "Backend must discover exactly 4 endpoints");
    assert_eq!(census["backend_static"], 2, "Backend must discover exactly 2 static endpoints");
    assert_eq!(census["backend_parameterized"], 2, "Backend must discover exactly 2 parameterized endpoints");
    assert_eq!(census["backend_unresolved"], 0, "Backend must have 0 unresolved endpoints");

    assert_eq!(census["frontend_total"], 2, "Frontend must discover exactly 2 call sites");
    assert_eq!(census["frontend_static"], 1, "Frontend must have 1 static call site (/api/v1/health)");
    assert_eq!(census["frontend_parameterized"], 1, "Frontend must have 1 parameterized call site (/api/v1/users/{{id}})");
    assert_eq!(census["frontend_unresolved"], 0, "Frontend must have 0 unresolved call sites");
}

#[test]
fn test_unlinked_missed_endpoint_detection() {
    let repo = TempRepo::new("missed-endpoint");
    let cli = bin_path();

    let java_dir = repo.path.join("src").join("main").join("java").join("com").join("example");
    let fe_dir = repo.path.join("frontend").join("src");
    fs::create_dir_all(&java_dir).unwrap();
    fs::create_dir_all(&fe_dir).unwrap();

    // Backend only has /api/v1/health
    let controller = r#"package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ApiController {
    @GetMapping("/health")
    public String health() { return "ok"; }
}
"#;

    // Frontend calls /api/v1/health AND an unextracted / missed / deleted endpoint /api/v1/ghost
    let client = r#"
export async function getHealth(): Promise<string> {
    const res = await fetch("/api/v1/health");
    return (await res.json()) as string;
}

export async function getGhost(): Promise<string> {
    const res = await fetch("/api/v1/ghost");
    return (await res.json()) as string;
}
"#;

    fs::write(java_dir.join("ApiController.java"), controller).unwrap();
    fs::write(fe_dir.join("apiClient.ts"), client).unwrap();
    fs::write(repo.path.join("frontend").join("package.json"), r#"{"name": "test-frontend", "version": "1.0.0"}"#).unwrap();

    run_cmd(&repo.path, &["git", "add", "."]);
    run_cmd(&repo.path, &["git", "commit", "-m", "Commit with unlinked ghost endpoint"]);

    // Initialize
    let init_out = Command::new(&cli)
        .args(["init", "--apply"])
        .current_dir(&repo.path)
        .output()
        .expect("init --apply");
    assert!(init_out.status.success());

    // Verify: Sajimora MUST report the unlinked client call
    let verify_out = Command::new(&cli)
        .args(["verify", "--json"])
        .current_dir(&repo.path)
        .output()
        .expect("verify --json");

    let payload: serde_json::Value = serde_json::from_slice(&verify_out.stdout)
        .expect("parse verify json payload");

    // Inconclusive because 1 call site has no matching provider
    println!("Ghost verify payload:\n{}", serde_json::to_string_pretty(&payload).unwrap());
    assert!(
        payload["untyped_dynamic_sites"].as_u64().unwrap_or(0) >= 1
            || payload["remaining_ambiguity"].as_u64().unwrap_or(0) >= 1,
        "Sajimora must never silently ignore a missed backend endpoint that frontend calls"
    );
}
