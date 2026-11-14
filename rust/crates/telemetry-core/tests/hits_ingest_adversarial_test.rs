use std::fs;
use std::path::PathBuf;
use contract_core::admission::{ArtifactTrustPolicy, TrustedProducer};
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use telemetry_core::hits::{ingest_hit_counts, HitIngestError};
use telemetry_core::jacoco::parse_jacoco_xml;
use telemetry_core::otel::reduce_otel_spans;
use telemetry_core::types::{TelemetryTrustLevel, TrafficTier, HIT_TELEMETRY_SCHEMA_V1};

fn temp_file(name: &str, content: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("sajimora-telemetry-test-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(name);
    fs::write(&path, content).unwrap();
    path
}

fn compute_canonical_sha256(json_without_integrity: &str) -> String {
    let mut v: serde_json::Value = serde_json::from_str(json_without_integrity).unwrap();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("integrity");
        obj.remove("signature");
    }
    let canonical = serde_json::to_string(&v).unwrap();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

#[test]
fn test_ingest_json_valid_tier_a_advisory_local() {
    let raw = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "nginx:prod-cluster-01",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 90
  },
  "routes": [
    {
      "method": "GET",
      "path": "/api/users/{id}",
      "totalRequests": 150000,
      "errorCount5xx": 12
    },
    {
      "method": "POST",
      "path": "/api/checkout",
      "totalRequests": 45000,
      "errorCount5xx": 2
    },
    {
      "method": "DELETE",
      "path": "/api/v1/legacy-export",
      "totalRequests": 0,
      "errorCount5xx": 0
    }
  ]
}"#;
    let digest = compute_canonical_sha256(raw);
    let with_integrity = format!(
        r#"{raw_trimmed},
  "integrity": {{
    "sha256": "{digest}"
  }}
}}"#,
        raw_trimmed = raw.trim_end_matches('}').trim_end()
    );

    let path = temp_file("valid_tier_a.json", &with_integrity);
    let envelope = ingest_hit_counts(&path, None, 90, 3650).expect("Tier A ingestion must succeed");

    assert_eq!(envelope.schema_version, HIT_TELEMETRY_SCHEMA_V1);
    assert_eq!(envelope.source_identity, "nginx:prod-cluster-01");
    assert_eq!(envelope.routes.len(), 3);
    assert!(matches!(
        envelope.trust_level,
        TelemetryTrustLevel::AdvisoryLocal { sha256_verified: true }
    ));

    // Verify Active and Dormant tiers
    let active_route = envelope.routes.iter().find(|r| r.raw_path == "/api/users/{id}").unwrap();
    assert_eq!(active_route.traffic_tier, TrafficTier::HighVolume);

    let dormant_route = envelope.routes.iter().find(|r| r.raw_path == "/api/v1/legacy-export").unwrap();
    assert!(matches!(dormant_route.traffic_tier, TrafficTier::Untracked(_) | TrafficTier::ZeroObserved));
}

#[test]
fn test_ingest_json_tampered_digest_fails_closed() {
    let raw = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "nginx:prod-cluster-01",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 90
  },
  "routes": [
    {
      "method": "GET",
      "path": "/api/test",
      "totalRequests": 100,
      "errorCount5xx": 0
    }
  ],
  "integrity": {
    "sha256": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  }
}"#;
    let path = temp_file("tampered.json", raw);
    let err = ingest_hit_counts(&path, None, 90, 3650).expect_err("Tampered sha256 must fail closed");
    assert!(matches!(err, HitIngestError::IntegrityFailed));
}

#[test]
fn test_ingest_json_schema_mismatch() {
    let raw = r#"{
  "schemaVersion": "UNKNOWN_SCHEMA_V99",
  "sourceIdentity": "test",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 90
  },
  "routes": []
}"#;
    let path = temp_file("schema_mismatch.json", raw);
    let err = ingest_hit_counts(&path, None, 90, 3650).expect_err("Unknown schema must fail");
    assert!(matches!(err, HitIngestError::SchemaMismatch { .. }));
}

#[test]
fn test_ingest_json_window_duration_mismatch() {
    let raw = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "test",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 30
  },
  "routes": []
}"#;
    let path = temp_file("duration_mismatch.json", raw);
    let err = ingest_hit_counts(&path, None, 90, 3650).expect_err("Mismatch declared 30 vs actual 90 must fail");
    assert!(matches!(err, HitIngestError::WindowDurationMismatch { declared: 30, .. }));
}

#[test]
fn test_ingest_json_tier_b_certified_production_ed25519() {
    let signing_key = SigningKey::from_bytes(&[0x42; 32]);
    let verifying_key = signing_key.verifying_key();
    let spki_pem = verifying_key.to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF).unwrap();
    let key_id = format!("sha256:{}", hex::encode(Sha256::digest(&verifying_key.to_bytes())));

    let policy = ArtifactTrustPolicy {
        producers: vec![TrustedProducer {
            repository_id: "prod-cluster".into(),
            service_id: "prod-cluster".into(),
            public_key_pem: Some(spki_pem),
            public_key_id: Some(key_id.clone()),
            ..Default::default()
        }],
        require_signatures: true,
        revoked_key_ids: vec![],
        max_contract_age_days: None,
        waiver_approvers: vec![],
    };

    let raw_payload = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "cloudflare:zone:prod",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 90
  },
  "routes": [
    {
      "method": "GET",
      "path": "/api/metrics",
      "totalRequests": 1000000,
      "errorCount5xx": 5
    }
  ]
}"#;

    let hex_digest = compute_canonical_sha256(raw_payload);
    let signature = signing_key.sign(hex_digest.as_bytes());
    let sig_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signature.to_bytes());

    let full_json = format!(
        r#"{trimmed},
  "integrity": {{
    "sha256": "{hex_digest}"
  }},
  "signature": {{
    "keyId": "{key_id}",
    "producerId": "prod-cluster",
    "signedAt": "2026-10-20T12:01:00Z",
    "signatureBase64": "{sig_b64}"
  }}
}}"#,
        trimmed = raw_payload.trim_end_matches('}').trim_end()
    );

    let path = temp_file("certified_tier_b.json", &full_json);
    let envelope = ingest_hit_counts(&path, Some(&policy), 90, 3650).expect("Tier B certified signature must verify");

    assert!(matches!(envelope.trust_level, TelemetryTrustLevel::CertifiedProduction { .. }));
}

#[test]
fn test_ingest_json_tier_b_revoked_key_fails_closed() {
    let signing_key = SigningKey::from_bytes(&[0x99; 32]);
    let verifying_key = signing_key.verifying_key();
    let spki_pem = verifying_key.to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF).unwrap();
    let key_id = format!("sha256:{}", hex::encode(Sha256::digest(&verifying_key.to_bytes())));

    let policy = ArtifactTrustPolicy {
        producers: vec![TrustedProducer {
            repository_id: "revoked-producer".into(),
            service_id: "revoked-producer".into(),
            public_key_pem: Some(spki_pem),
            public_key_id: Some(key_id.clone()),
            ..Default::default()
        }],
        require_signatures: true,
        revoked_key_ids: vec![key_id.clone()], // Revoked!
        max_contract_age_days: None,
        waiver_approvers: vec![],
    };

    let raw_payload = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "test",
  "collectedAt": "2026-10-20T12:00:00Z",
  "observationWindow": {
    "start": "2026-07-22T00:00:00Z",
    "end": "2026-10-20T00:00:00Z",
    "durationDays": 90
  },
  "routes": []
}"#;
    let hex_digest = compute_canonical_sha256(raw_payload);
    let signature = signing_key.sign(hex_digest.as_bytes());
    let sig_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signature.to_bytes());

    let full_json = format!(
        r#"{trimmed},
  "signature": {{
    "keyId": "{key_id}",
    "producerId": "revoked-producer",
    "signedAt": "2026-10-20T12:01:00Z",
    "signatureBase64": "{sig_b64}"
  }}
}}"#,
        trimmed = raw_payload.trim_end_matches('}').trim_end()
    );

    let path = temp_file("revoked_tier_b.json", &full_json);
    let err = ingest_hit_counts(&path, Some(&policy), 90, 3650).expect_err("Revoked key must fail closed");
    assert!(matches!(err, HitIngestError::RevokedKey { .. }));
}

#[test]
fn test_ingest_csv_valid_format_and_traffic_tiers() {
    let csv = r#"# schemaVersion=SAJIMORA_HIT_TELEMETRY_V1
# sourceIdentity=cloudflare:zone-prod:analytics
# windowStart=2026-07-22T00:00:00Z
# windowEnd=2026-10-20T00:00:00Z
# durationDays=90
# collectedAt=2026-10-20T12:00:00Z
method,path,totalRequests
GET,/api/admin/orders,54200
DELETE,/api/v1/legacy-export,0
POST,/api/v2/items,100
"#;
    let path = temp_file("hit_counts.csv", csv);
    let envelope = ingest_hit_counts(&path, None, 90, 3650).expect("CSV hit count parsing must succeed");

    assert_eq!(envelope.routes.len(), 3);
    assert_eq!(envelope.observation_window.duration_days, 90);

    let dormant = envelope.routes.iter().find(|r| r.http_method == "DELETE").unwrap();
    assert!(matches!(dormant.traffic_tier, TrafficTier::Untracked(_) | TrafficTier::ZeroObserved));

    let active = envelope.routes.iter().find(|r| r.http_method == "GET").unwrap();
    assert_eq!(active.traffic_tier, TrafficTier::HighVolume);
}

#[test]
fn test_ingest_csv_missing_metadata_header_fails() {
    let csv_missing_schema = r#"# sourceIdentity=cloudflare
# windowStart=2026-07-22T00:00:00Z
# windowEnd=2026-10-20T00:00:00Z
# durationDays=90
method,path,totalRequests
GET,/api/admin/orders,54200
"#;
    let path = temp_file("missing_schema.csv", csv_missing_schema);
    let err = ingest_hit_counts(&path, None, 90, 3650).expect_err("Missing schema header must fail");
    assert!(matches!(err, HitIngestError::MissingField(field) if field == "schemaVersion"));
}

#[test]
fn test_jacoco_streaming_multiple_packages_and_empty_elements() {
    let sample = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="multi-module">
    <package name="com/corp/auth">
        <sourcefile name="AuthService.java">
            <line nr="10" mi="0" ci="1" mb="0" cb="0"/>
            <line nr="11" mi="0" ci="1" mb="0" cb="0"/>
        </sourcefile>
        <sourcefile name="EmptyService.java"/>
    </package>
    <package name="com\corp\billing">
        <sourcefile name="BillingController.java">
            <line nr="42" mi="2" ci="0" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>"#;

    let cursor = std::io::Cursor::new(sample);
    let coverage = parse_jacoco_xml(cursor).expect("Multi-package JaCoCo must parse");

    assert!(coverage.contains_key("com/corp/auth/AuthService.java"));
    assert_eq!(coverage["com/corp/auth/AuthService.java"].covered_lines, vec![10, 11]);
    assert_eq!(coverage["com/corp/auth/AuthService.java"].total_lines, 2);

    // Verify backslash in package name was normalized to forward slash
    assert!(coverage.contains_key("com/corp/billing/BillingController.java"));
    assert_eq!(coverage["com/corp/billing/BillingController.java"].missed_lines, vec![42]);
}

#[test]
fn test_otel_ndjson_and_mixed_formats() {
    let ndjson = r#"
{"attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/products"}},{"key":"http.status_code","value":{"intValue":200}}]}

{"attributes":[{"key":"http.method","value":{"stringValue":"get"}},{"key":"http.route","value":{"stringValue":"/api/products"}},{"key":"http.status_code","value":{"intValue":200}}]}
{"attributes":[{"key":"http.request.method","value":{"stringValue":"DELETE"}},{"key":"url.path","value":{"stringValue":"/api/products/42"}},{"key":"http.response.status_code","value":{"intValue":204}}]}
"#;

    let cursor = std::io::Cursor::new(ndjson);
    let summaries = reduce_otel_spans(cursor).expect("OTel NDJSON must reduce cleanly");

    assert_eq!(summaries.len(), 2);
    let prod_summary = summaries.iter().find(|s| s.normalized_route == "/api/products").unwrap();
    // Verify lowercase 'get' was uppercase-normalized to 'GET' and aggregated
    assert_eq!(prod_summary.http_method, "GET");
    assert_eq!(prod_summary.observation_count, 2);
    assert_eq!(prod_summary.status_codes.get(&200), Some(&2));

    let del_summary = summaries.iter().find(|s| s.http_method == "DELETE").unwrap();
    assert_eq!(del_summary.observation_count, 1);
    assert_eq!(del_summary.status_codes.get(&204), Some(&1));
}
