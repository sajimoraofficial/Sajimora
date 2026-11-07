//! serialization.rs -- Report output rules, redaction, sorting, and atomic write.
//!
//! Mirrors AgentImpactJson.ts exactly.
//!
//! Rules (from TS source):
//! - stdout contains exactly one JSON object; logs to stderr
//! - Arrays sorted deterministically (findings by endpoint.path/wirePath/id, blockers by code/message)
//! - No credentials, auth headers, real traffic payloads, absolute temp paths, or full source files
//! - Snippet lengths capped at defined maxima
//! - Schema version and assurance always present

use crate::report::{AnalysisBlocker, CrossLanguageFinding, CrossLanguageImpactReport};
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_USAGE_SNIPPET_LEN: usize = 200;
const MAX_REPAIR_HINT_LEN: usize = 500;
const MAX_BLOCKER_MSG_LEN: usize = 300;

// ---------------------------------------------------------------------------
// Secret redaction (mirrors AgentImpactJson.ts SECRET_PATTERNS)
// ---------------------------------------------------------------------------

fn redact_secrets(s: &str) -> String {
    // Best-effort redaction of known secret patterns
    let mut out = s.to_string();
    // Bearer token
    out = redact_pattern(&out, "bearer ", "[REDACTED]");
    // password:value or password=value
    out = redact_key_value_pattern(&out, "password");
    // api_key or apikey
    out = redact_key_value_pattern(&out, "api_key");
    out = redact_key_value_pattern(&out, "apikey");
    out
}

fn redact_pattern(s: &str, marker: &str, replacement: &str) -> String {
    let lower = s.to_lowercase();
    let mut result = s.to_string();
    let mut offset = 0usize;
    let mut search = &lower[..];
    while let Some(pos) = search.find(marker) {
        let abs = offset + pos + marker.len();
        // Find end of token (whitespace or end)
        let end = s[abs..]
            .find(|c: char| c.is_whitespace())
            .map(|e| abs + e)
            .unwrap_or(s.len());
        if end > abs {
            result.replace_range(abs..end, replacement);
            offset = abs + replacement.len();
        } else {
            offset += pos + marker.len();
        }
        if offset >= s.len() {
            break;
        }
        search = &lower[offset..];
    }
    result
}

fn redact_key_value_pattern(s: &str, key: &str) -> String {
    let lower = s.to_lowercase();
    if let Some(pos) = lower.find(key) {
        let rest = &s[pos + key.len()..];
        if rest.starts_with(':') || rest.starts_with('=') {
            let val_start = pos + key.len() + 1;
            let val_end = s[val_start..]
                .find(|c: char| c.is_whitespace())
                .map(|e| val_start + e)
                .unwrap_or(s.len());
            if val_end > val_start {
                let mut result = s.to_string();
                result.replace_range(val_start..val_end, "[REDACTED]");
                return result;
            }
        }
    }
    s.to_string()
}

fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{}\u{2026}", truncated) // UTF-8 ellipsis
    }
}

// ---------------------------------------------------------------------------
// Sanitize findings and blockers
// ---------------------------------------------------------------------------

fn sanitize_finding(f: CrossLanguageFinding) -> CrossLanguageFinding {
    CrossLanguageFinding {
        repair_hint: cap(&redact_secrets(&f.repair_hint), MAX_REPAIR_HINT_LEN),
        consumers: f
            .consumers
            .into_iter()
            .map(|c| crate::report::ConsumerSite {
                usage: cap(&redact_secrets(&c.usage), MAX_USAGE_SNIPPET_LEN),
                ..c
            })
            .collect(),
        typescript_client: crate::report::TypeScriptClientRef {
            expectation: cap(
                &redact_secrets(&f.typescript_client.expectation),
                MAX_USAGE_SNIPPET_LEN,
            ),
            ..f.typescript_client
        },
        ..f
    }
}

fn sanitize_blocker(b: AnalysisBlocker) -> AnalysisBlocker {
    AnalysisBlocker {
        message: cap(&redact_secrets(&b.message), MAX_BLOCKER_MSG_LEN),
        ..b
    }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

fn sort_findings(mut findings: Vec<CrossLanguageFinding>) -> Vec<CrossLanguageFinding> {
    findings.sort_by(|a, b| {
        let ep = a.endpoint.path.cmp(&b.endpoint.path);
        if ep != std::cmp::Ordering::Equal {
            return ep;
        }
        let wp = a.wire_path.cmp(&b.wire_path);
        if wp != std::cmp::Ordering::Equal {
            return wp;
        }
        a.id.cmp(&b.id)
    });
    findings
        .into_iter()
        .map(|mut f| {
            f.consumers
                .sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
            f.evidence
                .sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
            f
        })
        .collect()
}

fn sort_blockers(mut blockers: Vec<AnalysisBlocker>) -> Vec<AnalysisBlocker> {
    blockers.sort_by(|a, b| {
        let c = format!("{:?}", a.code).cmp(&format!("{:?}", b.code));
        if c != std::cmp::Ordering::Equal {
            return c;
        }
        a.message.cmp(&b.message)
    });
    blockers
}

// ---------------------------------------------------------------------------
// serialize_report -- mirrors AgentImpactJson.ts:serializeReport
// ---------------------------------------------------------------------------

pub fn serialize_report(report: CrossLanguageImpactReport) -> String {
    let sanitized = CrossLanguageImpactReport {
        delta: report.delta.map(|delta| crate::report::FindingDelta {
            new_findings: sort_findings(
                delta
                    .new_findings
                    .into_iter()
                    .map(sanitize_finding)
                    .collect(),
            ),
            existing_findings: sort_findings(
                delta
                    .existing_findings
                    .into_iter()
                    .map(sanitize_finding)
                    .collect(),
            ),
            resolved_findings: sort_findings(
                delta
                    .resolved_findings
                    .into_iter()
                    .map(sanitize_finding)
                    .collect(),
            ),
        }),
        findings: sort_findings(report.findings.into_iter().map(sanitize_finding).collect()),
        blockers: sort_blockers(report.blockers.into_iter().map(sanitize_blocker).collect()),
        ..report
    };
    serde_json::to_string_pretty(&sanitized)
        .unwrap_or_else(|e| format!("{{\"error\":\"serialization failed: {}\"}}", e))
}

// ---------------------------------------------------------------------------
// report_fingerprint -- sha256(serialized)[..16]
// ---------------------------------------------------------------------------

pub fn report_fingerprint(report: &CrossLanguageImpactReport) -> String {
    let json = serialize_report(report.clone());
    let hash = Sha256::digest(json.as_bytes());
    hex::encode(hash)[..16].to_string()
}

// ---------------------------------------------------------------------------
// write_report_atomic -- atomic write via temp file + rename
// ---------------------------------------------------------------------------

pub fn write_report_atomic(
    report: CrossLanguageImpactReport,
    output_path: &Path,
) -> anyhow::Result<()> {
    let json = serialize_report(report);
    let dir = output_path.parent().unwrap_or(Path::new("."));
    // Create temp path in same directory for atomic rename
    let hash = hex::encode(Sha256::digest(json.as_bytes()));
    let tmp_name = format!(".sajimora-tmp-{}.json", &hash[..8]);
    let tmp_path = dir.join(tmp_name);

    std::fs::create_dir_all(dir)?;
    std::fs::write(&tmp_path, json.as_bytes())?;
    std::fs::rename(&tmp_path, output_path)?;
    Ok(())
}
