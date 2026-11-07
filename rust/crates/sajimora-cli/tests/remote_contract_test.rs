//! remote_contract_test.rs — Integration tests for remote contract envelope ingestion over HTTP.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn binary() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().unwrap().parent().unwrap();
    workspace.join("target").join("debug").join("sajimora.exe")
}

fn fixtures() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

fn env_path(name: &str) -> PathBuf {
    fixtures().join("envelopes").join(name)
}

#[test]
fn test_remote_contract_fetch_and_verify_over_http() {
    let target_content = fs::read(env_path("frontend_complete.json"))
        .expect("frontend_complete envelope must exist");

    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral TCP port");
    let addr = listener.local_addr().expect("Must have local addr");
    let running = Arc::new(AtomicBool::new(true));
    let r_clone = running.clone();
    let server_content = target_content.clone();

    let server_handle = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        while r_clone.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        server_content.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&server_content);
                    let _ = stream.flush();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let remote_url = format!("http://127.0.0.1:{}/frontend_complete.json", addr.port());
    let base = env_path("backend_complete.json");
    let candidate = env_path("backend_same.json");

    let output = Command::new(binary())
        .args([
            "check-contract",
            "--base",
            base.to_str().unwrap(),
            "--candidate",
            candidate.to_str().unwrap(),
            "--target",
            &remote_url,
            "--trusted-local",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("sajimora binary must execute");

    running.store(false, Ordering::Relaxed);
    let _ = server_handle.join();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "Command should succeed. stdout: {}\nstderr: {}",
        stdout,
        stderr
    );

    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("stdout not valid JSON: {}\n---\n{}", e, stdout));

    let verdict = parsed["verdict"]
        .as_str()
        .expect("Verdict must be a string");
    assert_eq!(verdict, "LIKELY_PRESERVED");
}

#[test]
fn test_remote_contract_fetch_404_fails_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral TCP port");
    let addr = listener.local_addr().expect("Must have local addr");
    let running = Arc::new(AtomicBool::new(true));
    let r_clone = running.clone();

    let server_handle = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        while r_clone.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let response =
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let remote_url = format!("http://127.0.0.1:{}/nonexistent.json", addr.port());
    let base = env_path("backend_complete.json");
    let candidate = env_path("backend_same.json");

    let output = Command::new(binary())
        .args([
            "check-contract",
            "--base",
            base.to_str().unwrap(),
            "--candidate",
            candidate.to_str().unwrap(),
            "--target",
            &remote_url,
            "--trusted-local",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("sajimora binary must execute");

    running.store(false, Ordering::Relaxed);
    let _ = server_handle.join();

    assert!(
        !output.status.success(),
        "Fetching 404 remote contract must fail closed"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Remote server returned non-200 status")
            || stderr.contains("Failed to fetch remote contract")
            || stderr.contains("Failed to connect"),
        "stderr should describe the fetch failure: {}",
        stderr
    );
}

#[test]
fn test_remote_frontend_verify_command() {
    let target_content = fs::read(env_path("frontend_complete.json"))
        .expect("frontend_complete envelope must exist");

    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral TCP port");
    let addr = listener.local_addr().expect("Must have local addr");
    let running = Arc::new(AtomicBool::new(true));
    let r_clone = running.clone();
    let server_content = target_content.clone();

    let server_handle = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        while r_clone.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        server_content.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&server_content);
                    let _ = stream.flush();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let remote_url = format!("http://127.0.0.1:{}/frontend-contract.json", addr.port());

    // Create a temporary repo with a baseline backend contract
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let repo = std::env::temp_dir().join(format!("sajimora-remote-verify-{nanos}"));
    fs::create_dir_all(repo.join(".sajimora")).unwrap();
    fs::create_dir_all(repo.join("src/main/java/com/example")).unwrap();

    let base_content = fs::read(env_path("backend_complete.json")).unwrap();
    fs::write(repo.join(".sajimora/backend-contract.json"), base_content).unwrap();

    fs::write(
        repo.join("src/main/java/com/example/UserController.java"),
        r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping("/api/users")
    public User getUser() {
        return new User();
    }
}

class User {
    private String name;
    public String getName() { return name; }
}
"#,
    )
    .unwrap();

    let output = Command::new(binary())
        .args([
            "verify",
            "--repo",
            repo.to_str().unwrap(),
            "--frontend",
            &remote_url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("sajimora binary must execute");

    running.store(false, Ordering::Relaxed);
    let _ = server_handle.join();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Advisory verify exits 0
    assert!(
        output.status.success(),
        "Advisory verify should succeed with exit code 0. stdout: {}\nstderr: {}",
        stdout,
        stderr
    );
    assert!(
        stderr.contains("[Remote Contract] Fetching"),
        "stderr should log remote contract fetching: {}",
        stderr
    );
}
