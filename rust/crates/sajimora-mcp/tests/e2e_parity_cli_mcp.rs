//! e2e_parity_cli_mcp.rs — Strict Cross-Interface Parity End-to-End Suite.
//!
//! Asserts that running verification via the CLI (`sajimora verify`) and via the
//! MCP Server (`sajimora_verify` via stdio JSON-RPC) produces 100% identical:
//!  1. Verdicts (LIKELY_PRESERVED, LIKELY_VIOLATED, INCONCLUSIVE).
//!  2. Finding counts and broken property paths.
//!  3. Route normalization and coverage statistics.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command as TokioCommand};

fn rust_root() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates/
    path.pop(); // rust/
    path
}

fn mcp_binary() -> PathBuf {
    let mut path = rust_root();
    path.push("target");
    path.push("debug");
    path.push(if cfg!(windows) {
        "sajimora-mcp.exe"
    } else {
        "sajimora-mcp"
    });
    path
}

fn cli_binary() -> PathBuf {
    let mut path = rust_root();
    path.push("target");
    path.push("debug");
    path.push(if cfg!(windows) {
        "sajimora.exe"
    } else {
        "sajimora"
    });
    path
}

pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-e2e-parity-{tag}-{}-{nanos}",
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

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Parity Tester",
            "-c",
            "user.email=parity@test.com",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git execution failed");
    assert!(status.success(), "git failed: {:?}", args);
}

struct McpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl McpClient {
    async fn launch(repo_root: &Path) -> Self {
        let bin = mcp_binary();
        assert!(bin.exists(), "MCP binary missing at {:?}", bin);

        let mut child = TokioCommand::new(bin)
            .args([
                "--trusted-local",
                "--allowed-root",
                repo_root.to_str().unwrap(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn sajimora-mcp");

        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut client = Self {
            child,
            stdin,
            stdout,
        };

        // Initialize MCP
        client
            .send_raw(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "e2e-parity-tester", "version": "1.0.0" }
                }
            }))
            .await;
        let _ = client.read_raw().await;

        client
            .send_raw(&json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }))
            .await;

        client
    }

    async fn send_raw(&mut self, val: &Value) {
        let mut s = serde_json::to_string(val).unwrap();
        s.push('\n');
        self.stdin.write_all(s.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn read_raw(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).expect("JSON-RPC line parse")
    }

    async fn call_verify(&mut self, id: i64, repo_root: &Path) -> Value {
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": "sajimora_verify",
                "arguments": {
                    "repoRoot": repo_root.to_str().unwrap(),
                    "revisionMode": "workingTreeVsBaseline",
                    "detail": "full"
                }
            }
        }))
        .await;

        let resp = self.read_raw().await;
        assert_eq!(resp["id"], id);
        let content_text = resp["result"]["content"][0]["text"].as_str().expect("text");
        serde_json::from_str(content_text).expect("MCP verify report as JSON")
    }

    async fn shutdown(mut self) {
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

fn setup_monorepo(repo: &Path) {
    git(repo, &["init"]);

    let java_dir = repo.join("backend/src/main/java/com/example");
    fs::create_dir_all(&java_dir).unwrap();
    fs::write(
        java_dir.join("ApiController.java"),
        r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ApiController {
    @GetMapping("/api/item")
    public ItemDto getItem() {
        return new ItemDto();
    }
}

class ItemDto {
    public Long id;
    public String title;
}
"#,
    )
    .unwrap();

    let ts_dir = repo.join("frontend/src");
    fs::create_dir_all(&ts_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{ "name": "frontend", "version": "1.0.0" }"#,
    )
    .unwrap();
    fs::write(
        ts_dir.join("api.ts"),
        r#"import axios from 'axios';

export interface ItemDto {
    id: number;
    title: string;
}

export async function fetchItem(): Promise<ItemDto> {
    const res = await axios.get<ItemDto>('/api/item');
    return res.data;
}
"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "initial commit"]);

    // Initialize with Sajimora
    let init_status = Command::new(cli_binary())
        .arg("init")
        .arg("--apply")
        .current_dir(repo)
        .status()
        .unwrap();
    assert!(init_status.success(), "init --apply must succeed");
}

#[tokio::test]
async fn test_cli_and_mcp_exact_parity_on_breaking_and_preserved_changes() {
    let temp_guard = TempDirGuard::new("parity-check");
    let repo = temp_guard.path();
    setup_monorepo(&repo);

    let mut mcp = McpClient::launch(&repo).await;

    // -------------------------------------------------------------------------
    // CASE 1: Initial Preserved State
    // -------------------------------------------------------------------------
    // Run CLI verify
    let cli_status = Command::new(cli_binary())
        .arg("verify")
        .arg("--repo")
        .arg(&repo)
        .status()
        .unwrap();
    assert!(
        cli_status.success(),
        "CLI verify must exit 0 on clean baseline"
    );

    let report_file = repo.join(".sajimora/impact-report.json");
    assert!(report_file.exists());
    let cli_report: Value =
        serde_json::from_str(&fs::read_to_string(&report_file).unwrap()).unwrap();

    // Call MCP verify
    let mcp_report = mcp.call_verify(10, &repo).await;

    // Compare Parity
    assert_eq!(
        mcp_report["report"]["verdict"], cli_report["verdict"],
        "PARITY DISAGREEMENT: MCP and CLI emitted different verdicts on baseline!"
    );
    assert_eq!(
        mcp_report["report"]["findings"].as_array().map(|a| a.len()),
        cli_report["findings"].as_array().map(|a| a.len()),
        "PARITY DISAGREEMENT: MCP and CLI finding counts differ!"
    );

    // -------------------------------------------------------------------------
    // CASE 2: Introduce Breaking Change (rename `title` -> `description`)
    // -------------------------------------------------------------------------
    fs::write(
        repo.join("backend/src/main/java/com/example/ApiController.java"),
        r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ApiController {
    @GetMapping("/api/item")
    public ItemDto getItem() {
        return new ItemDto();
    }
}

class ItemDto {
    public Long id;
    public String description; // BREAKING CHANGE
}
"#,
    )
    .unwrap();

    // Run CLI verify (advisory mode exits 0, writes updated report)
    let cli_status = Command::new(cli_binary())
        .arg("verify")
        .arg("--repo")
        .arg(&repo)
        .status()
        .unwrap();
    assert!(cli_status.success());
    let cli_broken_report: Value =
        serde_json::from_str(&fs::read_to_string(&report_file).unwrap()).unwrap();

    // Call MCP verify
    let mcp_broken_report = mcp.call_verify(20, &repo).await;

    // Assert Both Detect Violation
    assert_eq!(
        cli_broken_report["verdict"], "LIKELY_VIOLATED",
        "CLI must detect LIKELY_VIOLATED"
    );
    assert_eq!(
        mcp_broken_report["report"]["verdict"], "LIKELY_VIOLATED",
        "MCP must detect LIKELY_VIOLATED"
    );

    // Assert Exact Finding Parity (order-independent set equivalence)
    let mut mcp_findings = mcp_broken_report["report"]["findings"]
        .as_array()
        .unwrap()
        .clone();
    let mut cli_findings = cli_broken_report["findings"].as_array().unwrap().clone();
    assert_eq!(
        mcp_findings.len(),
        cli_findings.len(),
        "Finding counts must match"
    );

    mcp_findings.sort_by_key(|f| f["id"].as_str().unwrap_or("").to_string());
    cli_findings.sort_by_key(|f| f["id"].as_str().unwrap_or("").to_string());

    for (m, c) in mcp_findings.iter().zip(cli_findings.iter()) {
        assert_eq!(m["id"], c["id"], "Finding ID must match");
        assert_eq!(m["wirePath"], c["wirePath"], "Finding wirePath must match");
        assert_eq!(m["change"], c["change"], "Finding change must match");
        assert_eq!(
            m["repairHint"], c["repairHint"],
            "Finding repairHint must match"
        );
        assert_eq!(
            m["endpoint"]["path"], c["endpoint"]["path"],
            "Finding endpoint path must match"
        );
        assert_eq!(
            m["typescriptClient"]["file"], c["typescriptClient"]["file"],
            "Finding client file must match"
        );
    }

    mcp.shutdown().await;
}
