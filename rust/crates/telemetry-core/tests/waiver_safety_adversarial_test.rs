use contract_core::admission::{ArtifactTrustPolicy, TrustedProducer};
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

use telemetry_core::hits::ingest_hit_counts;
use telemetry_core::types::{
    HitCountEnvelope, ObservationWindow, RouteHitSummary, TelemetrySignature,
    TelemetryTrustLevel, TrafficTier, TrafficTierUntracked, HIT_TELEMETRY_SCHEMA_V1,
};

fn temp_file(name: &str, content: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("sajimora-waiver-test-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(name);
    fs::write(&path, content).unwrap();
    path
}

fn sample_trusted_producer() -> (SigningKey, TrustedProducer, String) {
    let signing_key = SigningKey::from_bytes(&[0x77; 32]);
    let verifying_key = signing_key.verifying_key();
    let spki_pem = verifying_key
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();
    let key_id = format!("sha256:{}", hex::encode(Sha256::digest(&verifying_key.to_bytes())));
    let producer = TrustedProducer {
        repository_id: "prod-pipeline-us-east".to_string(),
        service_id: "prod-pipeline-us-east".to_string(),
        public_key_pem: Some(spki_pem),
        public_key_id: Some(key_id.clone()),
        ..Default::default()
    };
    (signing_key, producer, key_id)
}

fn compute_canonical_sha256(v: &serde_json::Value) -> Vec<u8> {
    let mut cloned = v.clone();
    if let Some(obj) = cloned.as_object_mut() {
        obj.remove("signature");
    }
    let serialized = serde_json::to_string(&cloned).expect("serialize");
    Sha256::digest(serialized.as_bytes()).to_vec()
}

#[test]
fn test_waiver_safety_window_duration_under_90_days_fails_waiver_eligibility() {
    let (signing_key, producer, key_id) = sample_trusted_producer();

    // 60-day window (fails 90-day minimum for waiver qualification)
    let payload = HitCountEnvelope {
        schema_version: HIT_TELEMETRY_SCHEMA_V1.to_string(),
        source_identity: "telemetry-collector".to_string(),
        collected_at: "2026-11-10T12:00:00Z".to_string(),
        observation_window: ObservationWindow {
            start: "2026-09-11T12:00:00Z".to_string(),
            end: "2026-11-10T12:00:00Z".to_string(),
            duration_days: 60,
        },
        trust_level: TelemetryTrustLevel::CertifiedProduction {
            key_id: key_id.clone(),
            producer_id: "prod-pipeline-us-east".to_string(),
            signed_at: "2026-11-10T12:00:00Z".to_string(),
        },
        routes: vec![RouteHitSummary {
            http_method: "DELETE".to_string(),
            raw_path: "/api/legacy/orders".to_string(),
            total_requests: 0,
            requests_per_day: 0.0,
            error_count_5xx: 0,
            traffic_tier: TrafficTier::Untracked(TrafficTierUntracked::UnauthenticatedOrInsufficientWindow),
        }],
        signature: None,
    };

    let mut json_val = serde_json::to_value(&payload).unwrap();
    let digest = compute_canonical_sha256(&json_val);
    let sig = signing_key.sign(&digest);
    json_val["signature"] = serde_json::to_value(TelemetrySignature {
        key_id,
        producer_id: "prod-pipeline-us-east".to_string(),
        signed_at: "2026-11-10T12:00:00Z".to_string(),
        signature_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sig.to_bytes(),
        ),
    })
    .unwrap();

    let hits_file = temp_file("hits_60days.json", &serde_json::to_string_pretty(&json_val).unwrap());

    let policy = ArtifactTrustPolicy {
        producers: vec![producer],
        require_signatures: true,
        revoked_key_ids: vec![],
        max_contract_age_days: None,
        waiver_approvers: vec![],
    };

    // When min_window_days is 90, a 60-day window fails ingestion
    let result = ingest_hit_counts(&hits_file, Some(&policy), 90, 3650);
    assert!(result.is_err(), "A 60-day window must fail when 90-day minimum is enforced");
}

#[test]
fn test_waiver_safety_tampered_signature_bits_fail_verification() {
    let (signing_key, producer, key_id) = sample_trusted_producer();

    let raw = r#"{
  "schemaVersion": "SAJIMORA_HIT_TELEMETRY_V1",
  "sourceIdentity": "prod-pipeline-us-east",
  "collectedAt": "2026-11-10T12:00:00Z",
  "observationWindow": {
    "start": "2026-08-10T00:00:00Z",
    "end": "2026-11-10T00:00:00Z",
    "durationDays": 92
  },
  "routes": [
    {
      "method": "GET",
      "path": "/api/status",
      "totalRequests": 1000,
      "errorCount5xx": 0
    }
  ]
}"#;

    let mut json_val: serde_json::Value = serde_json::from_str(raw).unwrap();
    let digest = compute_canonical_sha256(&json_val);
    let hex_digest = hex::encode(&digest);
    let mut sig_bytes = signing_key.sign(hex_digest.as_bytes()).to_bytes();
    // Tamper with the signature bytes (bit flip)
    sig_bytes[0] ^= 0xFF;

    json_val["signature"] = serde_json::to_value(TelemetrySignature {
        key_id,
        producer_id: "prod-pipeline-us-east".to_string(),
        signed_at: "2026-11-10T12:00:00Z".to_string(),
        signature_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sig_bytes,
        ),
    })
    .unwrap();

    let hits_file = temp_file("tampered_hits.json", &serde_json::to_string(&json_val).unwrap());

    let policy = ArtifactTrustPolicy {
        producers: vec![producer],
        require_signatures: true,
        revoked_key_ids: vec![],
        max_contract_age_days: None,
        waiver_approvers: vec![],
    };

    let err = ingest_hit_counts(&hits_file, Some(&policy), 90, 3650)
        .expect_err("tampered signature must fail closed");
    assert!(
        err.to_string().to_lowercase().contains("signature")
            || err.to_string().to_lowercase().contains("verification")
            || err.to_string().to_lowercase().contains("invalid"),
        "Error message must indicate signature verification failure: {}",
        err
    );
}

#[test]
fn test_waiver_safety_wrong_producer_key_id_fails_closed() {
    let (signing_key, producer, _) = sample_trusted_producer();

    let payload = HitCountEnvelope {
        schema_version: HIT_TELEMETRY_SCHEMA_V1.to_string(),
        source_identity: "telemetry-collector".to_string(),
        collected_at: "2026-11-10T12:00:00Z".to_string(),
        observation_window: ObservationWindow {
            start: "2026-08-10T12:00:00Z".to_string(),
            end: "2026-11-10T12:00:00Z".to_string(),
            duration_days: 92,
        },
        trust_level: TelemetryTrustLevel::CertifiedProduction {
            key_id: "unknown-key-99".to_string(),
            producer_id: "unknown-producer".to_string(),
            signed_at: "2026-11-10T12:00:00Z".to_string(),
        },
        routes: vec![],
        signature: None,
    };

    let mut json_val = serde_json::to_value(&payload).unwrap();
    let digest = compute_canonical_sha256(&json_val);
    let sig = signing_key.sign(&digest);
    json_val["signature"] = serde_json::to_value(TelemetrySignature {
        key_id: "unknown-key-99".to_string(),
        producer_id: "unknown-producer".to_string(),
        signed_at: "2026-11-10T12:00:00Z".to_string(),
        signature_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sig.to_bytes(),
        ),
    })
    .unwrap();

    let hits_file = temp_file("unknown_prod.json", &serde_json::to_string(&json_val).unwrap());

    let policy = ArtifactTrustPolicy {
        producers: vec![producer],
        require_signatures: true,
        revoked_key_ids: vec![],
        max_contract_age_days: None,
        waiver_approvers: vec![],
    };

    let err = ingest_hit_counts(&hits_file, Some(&policy), 90, 3650)
        .expect_err("unknown producer key must fail closed");
    assert!(
        err.to_string().contains("unknown-key-99")
            || err.to_string().to_lowercase().contains("untrusted")
            || err.to_string().to_lowercase().contains("producer")
            || err.to_string().to_lowercase().contains("unknown")
            || err.to_string().to_lowercase().contains("unrecognized"),
        "Error must mention untrusted producer or key: {}",
        err
    );
}

#[test]
fn test_csv_ingestion_malformed_rows_fail_cleanly() {
    let corrupt_csv = r#"# schemaVersion=SAJIMORA_HIT_TELEMETRY_V1
# sourceIdentity=prod
# windowStart=2026-08-01T00:00:00Z
# windowEnd=2026-11-01T00:00:00Z
# durationDays=92
# collectedAt=2026-11-01T12:00:00Z
method,path,totalRequests,errorCount5xx
GET,/api/valid,100,0
POST,/api/corrupted,NOT_A_NUMBER,0
"#;

    let csv_file = temp_file("corrupt.csv", corrupt_csv);
    let result = ingest_hit_counts(&csv_file, None, 90, 3650);
    assert!(result.is_err(), "Non-numeric request count must fail parsing");
}

#[test]
fn test_csv_ingestion_negative_counts_fail() {
    let corrupt_csv = r#"# schemaVersion=SAJIMORA_HIT_TELEMETRY_V1
# sourceIdentity=prod
# windowStart=2026-08-01T00:00:00Z
# windowEnd=2026-11-01T00:00:00Z
# durationDays=92
# collectedAt=2026-11-01T12:00:00Z
method,path,totalRequests,errorCount5xx
GET,/api/negative,-50,0
"#;

    let csv_file = temp_file("negative.csv", corrupt_csv);
    let result = ingest_hit_counts(&csv_file, None, 90, 3650);
    assert!(result.is_err(), "Negative request count must fail parsing");
}

#[test]
fn test_csv_ingestion_high_volume_traffic_tier_calculation() {
    let csv = r#"# schemaVersion=SAJIMORA_HIT_TELEMETRY_V1
# sourceIdentity=prod-cluster
# windowStart=2026-08-01T00:00:00Z
# windowEnd=2026-11-01T00:00:00Z
# durationDays=92
# collectedAt=2026-11-01T12:00:00Z
method,path,totalRequests,errorCount5xx
GET,/api/v1/checkout,100000,12
GET,/api/v1/rare,5,0
"#;

    let csv_file = temp_file("high_volume.csv", csv);
    let envelope = ingest_hit_counts(&csv_file, None, 90, 3650).expect("must parse high volume csv");

    assert_eq!(envelope.routes.len(), 2);

    let checkout = envelope.routes.iter().find(|r| r.raw_path == "/api/v1/checkout").unwrap();
    assert_eq!(checkout.traffic_tier, TrafficTier::HighVolume);
    assert_eq!(checkout.error_count_5xx, 12);
    assert!(checkout.requests_per_day > 100.0);

    let rare = envelope.routes.iter().find(|r| r.raw_path == "/api/v1/rare").unwrap();
    assert_eq!(rare.traffic_tier, TrafficTier::LowVolume);
    assert!(rare.requests_per_day < 1.0);
}
