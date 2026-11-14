//! mcp_integration.rs — Gate R4 subprocess integration tests for `sajimora-mcp`.
//!
//! Verifies:
//!  ✓ MCP protocol initialization and capability negotiation
//!  ✓ Tool discovery via `tools/list` advertising `sajimora_check_contract`
//!  ✓ Valid contract comparison returning structured report
//!  ✓ CLI and MCP result equivalence (identical verdict and findings)
//!  ✓ Breaking change advisory verdict (LIKELY_VIOLATED with isError=false)
//!  ✓ Unauthorized path rejection (paths outside allowed-roots return isError=true)
//!  ✓ Admission error on tampered artifact (returns isError=true)
//!  ✓ Invalid arguments rejected (missing base/targets returns isError=true)
//!  ✓ Clean stdout JSON-RPC framing (all diagnostics on stderr, never stdout)
//!  ✓ Parallel-call isolation across concurrent requests
//!  ✓ Clean shutdown on stdin EOF

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

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

fn fixtures_root() -> PathBuf {
    let mut path = rust_root();
    path.push("fixtures");
    path
}

fn fixture_envelope(name: &str) -> PathBuf {
    let mut path = fixtures_root();
    path.push("envelopes");
    path.push(name);
    path
}

struct McpTestClient {
    child: Child,
    stdin: ChildStdin,
    stdout_reader: BufReader<ChildStdout>,
}

impl McpTestClient {
    async fn start(args: &[&str]) -> Self {
        let bin = mcp_binary();
        assert!(bin.exists(), "mcp binary not found at {:?}", bin);

        let mut child = Command::new(bin)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn sajimora-mcp");

        let stdin = child.stdin.take().expect("failed to take stdin");
        let stdout = child.stdout.take().expect("failed to take stdout");
        let stdout_reader = BufReader::new(stdout);

        Self {
            child,
            stdin,
            stdout_reader,
        }
    }

    async fn send_raw(&mut self, json_val: &Value) {
        let line = serde_json::to_string(json_val).expect("serialize json");
        self.stdin
            .write_all(line.as_bytes())
            .await
            .expect("write to stdin");
        self.stdin.write_all(b"\n").await.expect("write newline");
        self.stdin.flush().await.expect("flush stdin");
    }

    async fn read_raw(&mut self) -> Value {
        let mut line = String::new();
        let timeout = Duration::from_secs(10);
        let res = tokio::time::timeout(timeout, self.stdout_reader.read_line(&mut line)).await;
        match res {
            Ok(Ok(bytes_read)) => {
                assert!(bytes_read > 0, "EOF reached while reading MCP response");
                serde_json::from_str(&line).unwrap_or_else(|e| {
                    panic!(
                        "failed to parse MCP stdout line as JSON ({:?}): {}",
                        line, e
                    )
                })
            }
            Ok(Err(e)) => panic!("IO error reading stdout: {}", e),
            Err(_) => panic!("Timeout reading MCP stdout"),
        }
    }

    async fn initialize(&mut self) -> Value {
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "gate-r4-test", "version": "1.0.0" }
            }
        }))
        .await;

        let init_resp = self.read_raw().await;
        assert_eq!(init_resp["id"], 1);

        // Send notifications/initialized
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }))
        .await;

        init_resp
    }

    async fn shutdown_and_wait(mut self) -> std::process::ExitStatus {
        drop(self.stdin);
        let wait_res = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        match wait_res {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => panic!("Child wait failed: {}", e),
            Err(_) => {
                let _ = self.child.kill().await;
                panic!("Child process did not exit within timeout on stdin EOF");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Test 1: Initialize and tools/list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_init_and_list_tools() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    let init_resp = client.initialize().await;

    // Check capabilities
    assert!(
        init_resp["result"]["capabilities"]["tools"].is_object(),
        "server must advertise tools capability: {:?}",
        init_resp
    );
    assert_eq!(
        init_resp["result"]["serverInfo"]["name"], "sajimora-mcp",
        "serverInfo name must match"
    );

    // List tools
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        }))
        .await;

    let list_resp = client.read_raw().await;
    assert_eq!(list_resp["id"], 2);

    let tools = list_resp["result"]["tools"]
        .as_array()
        .expect("tools array");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "sajimora_check_contract",
            "sajimora_verify",
            "sajimora_heal",
            "sajimora_gen_invariants",
            "sajimora_gen_unit",
            "sajimora_verify_behavior",
            "sajimora_endpoint_impact",
            "sajimora_change_evaluate",
            "sajimora_run",
            "sajimora_query",
            "sajimora_what_if",
            "sajimora_apply_patches",
        ],
        "all Level 1 and Level 2 tools are advertised"
    );

    let tool = &tools[0];
    assert_eq!(tool["name"], "sajimora_check_contract");
    assert!(
        tool["description"].as_str().is_some(),
        "tool must have description"
    );

    let props = &tool["inputSchema"]["properties"];
    assert!(props["base"].is_object(), "base prop required in schema");
    assert!(
        props["candidate"].is_object(),
        "candidate prop required in schema"
    );
    assert!(
        props["targets"].is_object(),
        "targets prop required in schema"
    );
    assert!(
        props["telemetry"].is_object(),
        "telemetry must be bindable, as it is on the CLI"
    );

    let required = tool["inputSchema"]["required"]
        .as_array()
        .expect("required array");
    let req_names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
    assert!(req_names.contains(&"base"));
    assert!(req_names.contains(&"candidate"));
    assert!(req_names.contains(&"targets"));

    let verify = &tools[1];
    let verify_props = &verify["inputSchema"]["properties"];
    for name in [
        "repoRoot",
        "revisionMode",
        "commitRange",
        "targetServices",
        "strict",
    ] {
        assert!(
            verify_props[name].is_object(),
            "{name} must be part of the sajimora_verify schema"
        );
    }
    assert_eq!(
        verify["inputSchema"]["properties"]["revisionMode"]["enum"]
            .as_array()
            .map(|modes| modes.len()),
        Some(3),
        "all three revision boundaries are selectable"
    );
    assert_eq!(
        verify["inputSchema"]["required"]
            .as_array()
            .map(|required| required
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()),
        Some(vec!["repoRoot"])
    );

    let status = client.shutdown_and_wait().await;
    assert!(
        status.success(),
        "server must exit 0 on clean EOF: {:?}",
        status
    );
}

// ---------------------------------------------------------------------------
// Test 2: Valid contract call and CLI/MCP equivalence
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_call_tool_valid_and_cli_equivalence() {
    let base_file = fixture_envelope("backend_complete.json");
    let same_file = fixture_envelope("backend_same.json");
    let fe_file = fixture_envelope("frontend_complete.json");

    assert!(base_file.exists());
    assert!(same_file.exists());
    assert!(fe_file.exists());

    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": base_file.to_str().unwrap(),
                    "candidate": same_file.to_str().unwrap(),
                    "detail": "full",
                    "targets": [fe_file.to_str().unwrap()]
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 10);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "valid check must not be tool error"
    );

    let content_text = resp["result"]["content"][0]["text"]
        .as_str()
        .expect("report text in content[0]");
    let mcp_report: Value =
        serde_json::from_str(content_text).expect("parse MCP report text as JSON");

    assert!(
        mcp_report["verdict"].as_str().is_some(),
        "verdict must be present"
    );
    assert_eq!(
        mcp_report["schemaVersion"],
        "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1"
    );

    // Run CLI on the exact same inputs
    let cli = cli_binary();
    assert!(cli.exists(), "cli binary must exist at {:?}", cli);

    let output = std::process::Command::new(cli)
        .args([
            "check-contract",
            "--base",
            base_file.to_str().unwrap(),
            "--candidate",
            same_file.to_str().unwrap(),
            "--target",
            fe_file.to_str().unwrap(),
            "--trusted-local",
        ])
        .output()
        .expect("run cli");

    assert_eq!(output.status.code(), Some(0));
    let cli_stdout = String::from_utf8(output.stdout).unwrap();
    let cli_report: Value =
        serde_json::from_str(&cli_stdout).expect("parse CLI report stdout as JSON");

    // CLI and MCP equivalence check!
    assert_eq!(
        mcp_report["verdict"], cli_report["verdict"],
        "MCP and CLI verdicts must match"
    );
    assert_eq!(
        mcp_report["property"], cli_report["property"],
        "MCP and CLI property must match"
    );
    assert_eq!(
        mcp_report["schemaVersion"], cli_report["schemaVersion"],
        "MCP and CLI schemaVersion must match"
    );
    assert_eq!(
        mcp_report["findings"].as_array().map(|a| a.len()),
        cli_report["findings"].as_array().map(|a| a.len()),
        "MCP and CLI findings count must match"
    );
    assert_eq!(
        mcp_report["blockers"].as_array().map(|a| a.len()),
        cli_report["blockers"].as_array().map(|a| a.len()),
        "MCP and CLI blockers count must match"
    );

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 3: Breaking change returns LIKELY_VIOLATED with isError=false
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_breaking_change_likely_violated() {
    let base_file = fixture_envelope("backend_complete.json");
    let cand_file = fixture_envelope("backend_candidate.json");
    let fe_file = fixture_envelope("frontend_complete.json");

    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": base_file.to_str().unwrap(),
                    "candidate": cand_file.to_str().unwrap(),
                    "targets": [fe_file.to_str().unwrap()]
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 20);
    // Advisory verdict is a successful tool execution, not an MCP tool error
    assert_ne!(resp["result"]["isError"], json!(true));

    let content_text = resp["result"]["content"][0]["text"]
        .as_str()
        .expect("report text");
    let report: Value = serde_json::from_str(content_text).unwrap();

    assert_eq!(
        report["verdict"], "LIKELY_VIOLATED",
        "breaking change must produce LIKELY_VIOLATED"
    );
    let findings = report["findings"].as_array().unwrap();
    assert!(
        !findings.is_empty(),
        "must have findings for breaking change"
    );

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 4: Path outside allowed-roots is rejected with isError=true
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_unauthorized_path_rejected() {
    let allowed_dir = fixtures_root().join("envelopes");
    let base_file = fixture_envelope("backend_complete.json");
    let same_file = fixture_envelope("backend_same.json");
    let fe_file = fixture_envelope("frontend_complete.json");

    // Server configured with allowed-root = rust/fixtures/envelopes
    let mut client = McpTestClient::start(&[
        "--trusted-local",
        "--allowed-root",
        allowed_dir.to_str().unwrap(),
    ])
    .await;
    client.initialize().await;

    // 1. Valid call inside allowed root succeeds
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 30,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": base_file.to_str().unwrap(),
                    "candidate": same_file.to_str().unwrap(),
                    "targets": [fe_file.to_str().unwrap()]
                }
            }
        }))
        .await;

    let valid_resp = client.read_raw().await;
    assert_ne!(valid_resp["result"]["isError"], json!(true));

    // 2. Call with base pointing to rust/Cargo.toml (outside allowed root) is rejected
    let outside_path = fixtures_root().parent().unwrap().join("Cargo.toml");
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": outside_path.to_str().unwrap(),
                    "candidate": same_file.to_str().unwrap(),
                    "targets": [fe_file.to_str().unwrap()]
                }
            }
        }))
        .await;

    let rejected_resp = client.read_raw().await;
    assert_eq!(rejected_resp["id"], 31);
    assert_eq!(
        rejected_resp["result"]["isError"],
        json!(true),
        "unauthorized path must return tool error with isError=true: {:?}",
        rejected_resp
    );
    let err_msg = rejected_resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(
        err_msg.contains("outside all allowed roots"),
        "error message should explain path rejection: {}",
        err_msg
    );

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 5: Tampered artifact returns tool error
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_tampered_artifact_admission_error() {
    let tampered_file = fixture_envelope("tampered.json");
    let same_file = fixture_envelope("backend_same.json");
    let fe_file = fixture_envelope("frontend_complete.json");

    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 40,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": tampered_file.to_str().unwrap(),
                    "candidate": same_file.to_str().unwrap(),
                    "targets": [fe_file.to_str().unwrap()]
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 40);
    // Tampered artifact should result in tool error (isError=true)
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "tampered artifact must produce tool error: {:?}",
        resp
    );

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 6: Invalid arguments rejected
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_invalid_arguments_rejected() {
    let base_file = fixture_envelope("backend_complete.json");

    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    // Missing candidate and targets
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": base_file.to_str().unwrap()
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 50);
    assert_eq!(resp["result"]["isError"], json!(true));

    // Empty targets list
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 51,
            "method": "tools/call",
            "params": {
                "name": "sajimora_check_contract",
                "arguments": {
                    "base": base_file.to_str().unwrap(),
                    "candidate": base_file.to_str().unwrap(),
                    "targets": []
                }
            }
        }))
        .await;

    let resp2 = client.read_raw().await;
    assert_eq!(resp2["id"], 51);
    assert_eq!(resp2["result"]["isError"], json!(true));

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 7: Parallel call isolation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_parallel_call_isolation() {
    let base_file = fixture_envelope("backend_complete.json");
    let same_file = fixture_envelope("backend_same.json");
    let fe_file = fixture_envelope("frontend_complete.json");

    let mut client = McpTestClient::start(&["--trusted-local", "--max-concurrent-jobs", "4"]).await;
    client.initialize().await;

    let request_count = 8;
    let expected_ids: BTreeSet<u64> = (100..100 + request_count).collect();

    // Send all requests before reading any responses
    for &id in &expected_ids {
        client
            .send_raw(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": "sajimora_check_contract",
                    "arguments": {
                        "base": base_file.to_str().unwrap(),
                        "candidate": same_file.to_str().unwrap(),
                        "targets": [fe_file.to_str().unwrap()]
                    }
                }
            }))
            .await;
    }

    // Read all responses and verify each matches an expected ID
    let mut received_ids = BTreeSet::new();
    for _ in 0..request_count {
        let resp = client.read_raw().await;
        let id = resp["id"].as_u64().expect("numeric id in response");
        assert!(expected_ids.contains(&id), "unexpected response id: {}", id);
        assert_ne!(
            resp["result"]["isError"],
            json!(true),
            "response must succeed"
        );
        received_ids.insert(id);
    }

    assert_eq!(
        received_ids, expected_ids,
        "all concurrent requests must receive responses"
    );

    client.shutdown_and_wait().await;
}

// ---------------------------------------------------------------------------
// Test 8: Clean shutdown on stdin EOF
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mcp_cancellation_and_eof_shutdown() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;
    // Closing stdin
    let status = client.shutdown_and_wait().await;
    assert!(
        status.success(),
        "server must exit with status 0 upon EOF on stdin: {:?}",
        status
    );
}

// ---------------------------------------------------------------------------
// Test 9: sajimora_verify over the wire
// ---------------------------------------------------------------------------

fn temp_repo(tag: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora-mcp-verify-{tag}-{nanos}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[tokio::test]
async fn test_mcp_verify_abstains_without_consumer_evidence() {
    use source_index::revision;

    let root = temp_repo("wire");
    let repo = root.join("repo");
    let src = repo.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("UserController.java"),
        r#"package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping
    public String list() { return "ok"; }
}
"#,
    )
    .unwrap();
    let sajimora = repo.join(".sajimora");
    std::fs::create_dir_all(&sajimora).unwrap();
    std::fs::write(
        sajimora.join("init-manifest.json"),
        serde_json::to_vec_pretty(&json!({
            "manifestVersion": 1,
            "status": "COMPLETE",
            "roots": {
                "repoRoot": repo.to_string_lossy().replace('\\', "/"),
                "backendRoot": "",
                "frontendRoot": "",
                "serviceId": "user-service",
            },
        }))
        .unwrap(),
    )
    .unwrap();
    let baseline = revision::extract_working_tree(
        &repo,
        &revision::BackendScope::new(&repo, ""),
        "user-service",
    )
    .unwrap();
    std::fs::write(
        sajimora.join("backend-contract.json"),
        serde_json::to_string_pretty(&baseline).unwrap(),
    )
    .unwrap();

    // A sibling project's contract sits outside the repository boundary. With
    // no allowed root configured, discovery must report it as skipped rather
    // than adopting it as consumer evidence for this repository.
    let sibling = root.join("ambient-frontend");
    std::fs::create_dir_all(sibling.join(".sajimora")).unwrap();
    std::fs::copy(
        fixture_envelope("frontend_complete.json"),
        sibling.join(".sajimora/frontend-contract.json"),
    )
    .unwrap();

    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 60,
            "method": "tools/call",
            "params": {
                "name": "sajimora_verify",
                "arguments": { "repoRoot": repo.to_str().unwrap(), "detail": "full" }
            }
        }))
        .await;
    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 60);
    // Abstention is advisory: the tool ran, it did not fail.
    assert_ne!(resp["result"]["isError"], json!(true), "{resp}");

    let text = resp["result"]["content"][0]["text"]
        .as_str()
        .expect("verify response text");
    let body: Value = serde_json::from_str(text).expect("verify response json");
    assert_eq!(body["report"]["verdict"], "INCONCLUSIVE");
    assert_eq!(
        body["verification"]["revision"]["revisionMode"],
        "workingTreeVsBaseline"
    );
    assert_eq!(
        body["verification"]["consumers"].as_array().unwrap().len(),
        0
    );
    let rejected = body["verification"]["rejectedConsumers"]
        .as_array()
        .unwrap_or_else(|| panic!("rejectedConsumers must be reported: {body:#}"));
    let ambient = rejected
        .iter()
        .find(|entry| entry["discoveryStep"] == "C-ambient")
        .unwrap_or_else(|| panic!("ambient sibling must be listed as skipped: {body:#}"));
    assert!(
        ambient["path"].as_str().is_some_and(|path| path
            .replace('\\', "/")
            .ends_with("ambient-frontend/.sajimora/frontend-contract.json")),
        "unexpected ambient path: {ambient}"
    );
    assert!(
        ambient["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("outside the repository boundary")),
        "unexpected ambient reason: {ambient}"
    );
    assert_eq!(
        body["report"]["blockers"][0]["code"], "NO_CONSUMER_CONTRACTS",
        "missing consumer evidence must be named, not hidden"
    );

    // strict=true turns the same abstention into a tool error.
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 61,
            "method": "tools/call",
            "params": {
                "name": "sajimora_verify",
                "arguments": { "repoRoot": repo.to_str().unwrap(), "strict": true }
            }
        }))
        .await;
    let strict = client.read_raw().await;
    assert_eq!(strict["result"]["isError"], json!(true), "{strict}");

    // An unknown tool is a protocol error, not a tool result.
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 62,
            "method": "tools/call",
            "params": { "name": "sajimora_publish", "arguments": {} }
        }))
        .await;
    let unknown = client.read_raw().await;
    assert!(
        unknown["error"].is_object(),
        "unimplemented transport tools must not be callable: {unknown}"
    );

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// Test: sajimora_heal tool via MCP stdio JSON-RPC
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_mcp_heal_tool() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("sajimora_mcp_heal_test_{nanos}"));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let test_file = temp_dir.join("OrderTest.java");
    let test_content = r#"package com.example;
import org.junit.jupiter.api.Test;
public class OrderTest {
    @Test
    void testCompute() {
        OrderService service = new OrderService();
        service.calculateTotal(100);
    }
}
"#;
    std::fs::write(&test_file, test_content).unwrap();

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 101,
            "method": "tools/call",
            "params": {
                "name": "sajimora_heal",
                "arguments": {
                    "testDir": test_file.to_str().unwrap(),
                    "method": "calculateTotal",
                    "defaultValue": "false",
                    "detectOnly": false
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 101);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "heal must succeed: {resp}"
    );

    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    let summary: Value = serde_json::from_str(text).unwrap();
    assert_eq!(summary["healedCallSites"], 1);

    let healed_content = std::fs::read_to_string(&test_file).unwrap();
    assert!(healed_content.contains("service.calculateTotal(100, false);"));

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// ---------------------------------------------------------------------------
// Test: sajimora_gen_invariants tool via MCP stdio JSON-RPC
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_mcp_gen_invariants_tool() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("sajimora_mcp_inv_test_{nanos}"));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let java_file = temp_dir.join("Sanitizer.java");
    let java_content = r#"package com.example;
public class Sanitizer {
    public String normalizeEmail(String email) {
        if (email == null) return "";
        return email.trim().toLowerCase();
    }
}
"#;
    std::fs::write(&java_file, java_content).unwrap();

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 102,
            "method": "tools/call",
            "params": {
                "name": "sajimora_gen_invariants",
                "arguments": {
                    "file": java_file.to_str().unwrap(),
                    "framework": "jqwik"
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 102);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "invariants must succeed: {resp}"
    );

    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    let report: Value = serde_json::from_str(text).unwrap();
    assert_eq!(report["className"], "Sanitizer");
    assert!(report["invariantsDiscovered"].as_array().unwrap().len() >= 1);
    assert!(report["synthesizedSource"]
        .as_str()
        .unwrap()
        .contains("@Property"));
    assert!(report["synthesizedSource"]
        .as_str()
        .unwrap()
        .contains("idempotence_normalizeEmail"));

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// ---------------------------------------------------------------------------
// Test: sajimora_gen_unit tool via MCP stdio JSON-RPC
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_mcp_gen_unit_tool() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("sajimora_mcp_unit_test_{nanos}"));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let java_file = temp_dir.join("DiscountCalculator.java");
    let java_content = r#"package com.example;
public class DiscountCalculator {
    public double calculate(int amount) {
        if (amount > 100) {
            return amount * 0.9;
        } else {
            return amount;
        }
    }
}
"#;
    std::fs::write(&java_file, java_content).unwrap();

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 103,
            "method": "tools/call",
            "params": {
                "name": "sajimora_gen_unit",
                "arguments": {
                    "file": java_file.to_str().unwrap(),
                    "budgetMs": 100
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 103);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "gen_unit must succeed: {resp}"
    );

    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    let suite: Value = serde_json::from_str(text).unwrap();
    let test_class_name = suite
        .get("testClassName")
        .or_else(|| suite.get("test_class_name"))
        .and_then(|v| v.as_str())
        .expect("test_class_name");
    assert_eq!(test_class_name, "DiscountCalculatorTest");
    let branches = suite
        .get("branchesSynthesized")
        .or_else(|| suite.get("branches_synthesized"))
        .and_then(|v| v.as_array())
        .expect("branches");
    assert!(branches.len() >= 1);
    let test_code = suite
        .get("testSourceCode")
        .or_else(|| suite.get("test_source_code"))
        .and_then(|v| v.as_str())
        .expect("test_source_code");
    assert!(test_code.contains("calculate"));

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// ---------------------------------------------------------------------------
// Test: sajimora_verify_behavior tool via MCP stdio JSON-RPC
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_mcp_verify_behavior_tool() {
    let mut client = McpTestClient::start(&["--trusted-local"]).await;
    client.initialize().await;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("sajimora_mcp_bisim_test_{nanos}"));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let base_file = temp_dir.join("CalcBase.java");
    let cand_file = temp_dir.join("CalcCand.java");

    let base_code = r#"public class Calc {
    public int compute(int x) {
        return x + 10;
    }
}
"#;
    let cand_code = r#"public class Calc {
    public int compute(int x) {
        return 10 + x;
    }
}
"#;
    std::fs::write(&base_file, base_code).unwrap();
    std::fs::write(&cand_file, cand_code).unwrap();

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 104,
            "method": "tools/call",
            "params": {
                "name": "sajimora_verify_behavior",
                "arguments": {
                    "base": base_file.to_str().unwrap(),
                    "candidate": cand_file.to_str().unwrap(),
                    "method": "compute"
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 104);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "verify_behavior must succeed: {resp}"
    );

    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    let report: Value = serde_json::from_str(text).unwrap();
    assert!(report["isAdvisoryPass"].as_bool().unwrap());

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// ---------------------------------------------------------------------------
// Test: sajimora_change_evaluate over the wire
// ---------------------------------------------------------------------------

fn run_git(dir: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn commit_all(dir: &std::path::Path, message: &str) {
    run_git(dir, &["add", "-A"]);
    run_git(
        dir,
        &[
            "-c",
            "user.name=Sajimora Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            message,
        ],
    );
}

#[tokio::test]
async fn test_mcp_change_evaluate_tool() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora_mcp_change_eval_{nanos}"));
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::create_dir_all(repo.join(".sajimora")).unwrap();

    run_git(&repo, &["init", "--quiet"]);
    std::fs::write(
        repo.join("src/Main.java"),
        "package demo;\npublic class Main { public void run() { } }\n",
    )
    .unwrap();
    commit_all(&repo, "base");

    std::fs::write(
        repo.join("src/Main.java"),
        "package demo;\npublic class Main { public void run() { } public void stop() { } }\n",
    )
    .unwrap();
    std::fs::write(
        repo.join("src/Extra.java"),
        "package demo;\npublic class Extra { }\n",
    )
    .unwrap();
    commit_all(&repo, "candidate");

    let ecm = json!({
        "base": "HEAD~1",
        "candidate": "HEAD",
        "expectedFiles": [
            {"filePath": "src/Main.java", "changeType": "MODIFIED"}
        ],
        "expectedSymbols": [
            {"filePath": "src/Main.java", "symbolName": "Main#stop", "changeType": "ADDED"}
        ]
    });
    std::fs::write(
        repo.join("ecm.json"),
        serde_json::to_vec_pretty(&ecm).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("ecm.json"),
        serde_json::to_vec_pretty(&ecm).unwrap(),
    )
    .unwrap();

    let mut client =
        McpTestClient::start(&["--trusted-local", "--allowed-root", root.to_str().unwrap()]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 110,
            "method": "tools/call",
            "params": {
                "name": "sajimora_change_evaluate",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "ecmPath": "ecm.json",
                    "outputPath": ".sajimora/change-evaluation.json"
                }
            }
        }))
        .await;

    let resp = client.read_raw().await;
    assert_eq!(resp["id"], 110);
    assert_ne!(
        resp["result"]["isError"],
        json!(true),
        "change evaluation must run: {resp}"
    );
    let text = resp["result"]["content"][0]["text"]
        .as_str()
        .expect("report text");
    let report: Value = serde_json::from_str(text).expect("report json");
    assert_eq!(report["schemaVersion"], "SAJIMORA_CHANGE_EVALUATION_V1");
    assert_eq!(
        report["verdict"], "UNINTENDED_REGRESSION",
        "the undeclared file mutation must make the verdict advisory-regressive"
    );
    assert_eq!(report["summary"]["observedFileMutations"], 2);
    assert_eq!(report["summary"]["unintendedFileMutations"], 1);
    let extra = report["actualMutations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|mutation| mutation["filePath"] == "src/Extra.java")
        .expect("Extra.java mutation");
    assert_eq!(extra["verdict"], "UNINTENDED_REGRESSION");
    assert_eq!(extra["reasonCode"], "UNDECLARED_FILE_MUTATION");

    // The CLI writes the same report text for the same inputs.
    let cli = cli_binary();
    let out = root.join("cli-report.json");
    let output = std::process::Command::new(cli)
        .args([
            "change-evaluate",
            "--repo",
            repo.to_str().unwrap(),
            "--ecm",
            repo.join("ecm.json").to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .expect("run change-evaluate cli");
    assert_eq!(
        output.status.code(),
        Some(0),
        "advisory regressions must not fail the CLI: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cli_text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(
        text, cli_text,
        "MCP and CLI must emit byte-identical reports"
    );

    // Without a configured allowed root the tool refuses to run at all.
    let mut refusal = McpTestClient::start(&["--trusted-local"]).await;
    refusal.initialize().await;
    refusal
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 111,
            "method": "tools/call",
            "params": {
                "name": "sajimora_change_evaluate",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "ecmPath": "ecm.json"
                }
            }
        }))
        .await;
    let denied = refusal.read_raw().await;
    assert_eq!(
        denied["result"]["isError"],
        json!(true),
        "no allowed root must refuse the tool: {denied}"
    );
    let message = denied["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        message.contains("requires at least one server-configured allowed root"),
        "{message}"
    );
    refusal.shutdown_and_wait().await;

    // An ECM outside the allowed roots is rejected even when the repo is inside.
    let mut confined =
        McpTestClient::start(&["--trusted-local", "--allowed-root", repo.to_str().unwrap()]).await;
    confined.initialize().await;
    let outside_ecm = root.join("ecm.json");
    confined
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 112,
            "method": "tools/call",
            "params": {
                "name": "sajimora_change_evaluate",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "ecmPath": outside_ecm.to_str().unwrap()
                }
            }
        }))
        .await;
    let rejected = confined.read_raw().await;
    assert_eq!(
        rejected["result"]["isError"],
        json!(true),
        "out-of-root ECM must be rejected: {rejected}"
    );
    let message = rejected["result"]["content"][0]["text"].as_str().unwrap();
    assert!(message.contains("outside all allowed roots"), "{message}");
    confined.shutdown_and_wait().await;

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&root);
}

// Test: sajimora_run pipeline tool via MCP stdio JSON-RPC
#[tokio::test]
async fn test_mcp_run_pipeline_tool() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora_mcp_run_{nanos}"));
    std::fs::create_dir_all(&root).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".sajimora")).unwrap();

    let manifest = json!({
        "manifest_version": 1,
        "status": "complete",
        "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-20T00:00:00Z",
        "roots": {
            "repo_root": repo.to_str().unwrap(),
            "backend_root": "backend",
            "frontend_root": null,
            "service_id": "test-service"
        },
        "owned": { "package_json": null, "hook": null, "gitignore": null },
        "artifacts": []
    });
    std::fs::write(
        repo.join(".sajimora/init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let mut client =
        McpTestClient::start(&["--trusted-local", "--allowed-root", repo.to_str().unwrap()]).await;
    client.initialize().await;

    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 113,
            "method": "tools/call",
            "params": {
                "name": "sajimora_run",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "skipLive": true
                }
            }
        }))
        .await;

    let response = client.read_raw().await;
    assert_ne!(
        response["result"]["isError"],
        json!(true),
        "sajimora_run call must succeed: {response}"
    );
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("text content");
    assert!(
        text.contains("sajimora_run"),
        "output must be pipeline report JSON: {text}"
    );
    assert!(
        text.contains("health_check"),
        "report must contain stages: {text}"
    );

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn test_mcp_apply_alias_and_run_pipeline() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora_mcp_alias_{nanos}"));
    std::fs::create_dir_all(&root).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".sajimora")).unwrap();

    let manifest = json!({
        "manifest_version": 1,
        "status": "complete",
        "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-20T00:00:00Z",
        "roots": {
            "repo_root": repo.to_str().unwrap(),
            "backend_root": "backend",
            "frontend_root": null,
            "service_id": "test-service"
        },
        "owned": { "package_json": null, "hook": null, "gitignore": null },
        "artifacts": []
    });
    std::fs::write(
        repo.join(".sajimora/init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let mut client =
        McpTestClient::start(&["--trusted-local", "--allowed-root", root.to_str().unwrap()]).await;
    client.initialize().await;

    // 1. Verify sajimora_run runs successfully without allowed_roots
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 201,
            "method": "tools/call",
            "params": {
                "name": "sajimora_run",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "skipLive": true
                }
            }
        }))
        .await;

    let response = client.read_raw().await;
    assert_ne!(
        response["result"]["isError"],
        json!(true),
        "sajimora_run without allowed_roots must succeed: {response}"
    );

    // 2. Verify sajimora_apply alias is recognized and dispatches to apply_patches
    client
        .send_raw(&json!({
            "jsonrpc": "2.0",
            "id": 202,
            "method": "tools/call",
            "params": {
                "name": "sajimora_apply",
                "arguments": {
                    "repoRoot": repo.to_str().unwrap(),
                    "dryRun": true,
                    "mutation": {
                        "action": "RENAME_FIELD",
                        "targetDto": "UserDto",
                        "field": "oldName",
                        "renameTo": "newName"
                    }
                }
            }
        }))
        .await;

    let apply_response = client.read_raw().await;
    // Should NOT be "Unknown tool: sajimora_apply"
    let err_str = format!("{apply_response}");
    assert!(
        !err_str.contains("Unknown tool: sajimora_apply"),
        "sajimora_apply alias must be recognized: {apply_response}"
    );

    client.shutdown_and_wait().await;
    let _ = std::fs::remove_dir_all(&root);
}
