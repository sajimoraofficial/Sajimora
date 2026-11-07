//! remote.rs — Secure remote contract envelope ingestion for polyrepo environments.
//!
//! Enables polyrepo pipelines to verify contracts across repositories by fetching
//! remote contract envelopes over HTTP or HTTPS without requiring both repositories
//! to be checked out on the same local filesystem.

use anyhow::{anyhow, Context, Result};
use contract_core::envelope::parse_envelope;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_REMOTE_ARTIFACT_BYTES: usize = 64 * 1024 * 1024; // 64 MiB

/// Returns true if the string is an HTTP or HTTPS URL.
pub fn is_remote_url(target: &str) -> bool {
    target.starts_with("http://") || target.starts_with("https://")
}

/// Resolves an artifact reference (local path or remote HTTP/HTTPS URL) to a local file path.
/// If `input` is a remote URL, fetches the envelope, verifies its structure, and caches it
/// in `<cache_dir>/remote/`.
pub fn resolve_contract_path(input: &str, repo_root: &Path, cache_dir: &Path) -> Result<PathBuf> {
    if is_remote_url(input) {
        let remote_dir = cache_dir.join("remote");
        fs::create_dir_all(&remote_dir).with_context(|| {
            format!(
                "Failed to create remote contract cache directory at {:?}",
                remote_dir
            )
        })?;

        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        let hash_hex = hex::encode(hasher.finalize());
        let cache_file = remote_dir.join(format!("remote-{}.contract.json", &hash_hex[..16]));

        eprintln!("   [Remote Contract] Fetching {} ...", input);
        let bytes = fetch_remote_envelope_bytes(input)?;

        // Validate envelope schema and canonical integrity before persisting
        let _ = parse_envelope(&bytes).map_err(|e| {
            anyhow!(
                "Fetched payload from {} is not a valid contract envelope: {}",
                input,
                e
            )
        })?;

        fs::write(&cache_file, &bytes).with_context(|| {
            format!(
                "Failed to cache remote contract envelope to {:?}",
                cache_file
            )
        })?;

        Ok(cache_file)
    } else {
        let path = PathBuf::from(input);
        let resolved = if path.is_relative() {
            repo_root.join(path)
        } else {
            path
        };
        Ok(resolved)
    }
}

/// Fetches bytes from an HTTP or HTTPS URL with timeout and byte limit.
pub fn fetch_remote_envelope_bytes(url: &str) -> Result<Vec<u8>> {
    if !is_remote_url(url) {
        return Err(anyhow!("URL must start with http:// or https://: {}", url));
    }

    // Attempt system curl first (universal on Windows 10/11, macOS, and Linux)
    let curl_res = std::process::Command::new("curl")
        .args([
            "-sSL",
            "--fail",
            "--max-time",
            "30",
            "--max-filesize",
            &MAX_REMOTE_ARTIFACT_BYTES.to_string(),
            url,
        ])
        .output();

    if let Ok(output) = curl_res {
        if output.status.success() {
            if output.stdout.len() > MAX_REMOTE_ARTIFACT_BYTES {
                return Err(anyhow!(
                    "Remote contract from {} exceeds maximum size of {} bytes",
                    url,
                    MAX_REMOTE_ARTIFACT_BYTES
                ));
            }
            return Ok(output.stdout);
        }
    }

    // Pure Rust fallback for http:// (useful in minimal containers or tests without curl)
    if url.starts_with("http://") {
        return fetch_http_pure(url);
    }

    Err(anyhow!(
        "Failed to fetch remote contract from {}: curl command failed or was not found, and HTTPS requires curl",
        url
    ))
}

fn fetch_http_pure(url: &str) -> Result<Vec<u8>> {
    let rest = url.strip_prefix("http://").unwrap();
    let (host_port, path_and_query) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };

    let (host, port) = match host_port.find(':') {
        Some(idx) => (
            &host_port[..idx],
            host_port[idx + 1..]
                .parse::<u16>()
                .context("Invalid port")?,
        ),
        None => (host_port, 80),
    };

    let addr = format!("{}:{}", host, port);
    let mut stream =
        TcpStream::connect(&addr).with_context(|| format!("Failed to connect to {}", addr))?;

    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;

    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: sajimora-cli/0.1.0\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        path_and_query, host
    );
    stream.write_all(req.as_bytes())?;

    let mut response = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&buf[..n]);
        if response.len() > MAX_REMOTE_ARTIFACT_BYTES {
            return Err(anyhow!(
                "Response exceeded maximum allowed size of {} bytes",
                MAX_REMOTE_ARTIFACT_BYTES
            ));
        }
    }

    // Parse simple HTTP response
    let header_end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("Malformed HTTP response (no header terminator)"))?;

    let headers_str =
        std::str::from_utf8(&response[..header_end]).context("HTTP headers are not valid UTF-8")?;

    let first_line = headers_str.lines().next().unwrap_or("");
    if !first_line.contains("200") {
        return Err(anyhow!(
            "Remote server returned non-200 status: {}",
            first_line
        ));
    }

    let body = response[header_end + 4..].to_vec();
    Ok(body)
}
