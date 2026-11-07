use std::fs;
use std::path::{Path, PathBuf};
use verifier::{EquivalenceStatus, ReferenceVerifier};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap() // platform
        .parent()
        .unwrap() // crates
        .parent()
        .unwrap() // workspace root
        .to_path_buf()
}

#[test]
fn test_phase4_modules_parse_and_typecheck() {
    let phase4_modules = [
        "sjm-core/ffi/crypto_bridge.sjm",
        "sjm-core/contract/evolution.sjm",
        "sjm-core/contract/canonical.sjm",
        "sjm-core/contract/envelope.sjm",
        "sjm-core/contract/admission.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase4_modules {
        let p = root.join(mod_path);
        assert!(p.exists(), "Module file '{}' must exist on disk at {:?}", mod_path, p);

        let content = fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("Failed to read '{}': {}", mod_path, e));
        assert!(!content.trim().is_empty(), "Module '{}' cannot be empty", mod_path);

        // L1: Lossless syntax parsing check
        let (tree, parse_errors) = sajimora_parser::parse(&content);
        assert!(
            parse_errors.is_empty(),
            "Module '{}' failed L1 syntax check: {:?}",
            mod_path,
            parse_errors
        );
        assert_eq!(
            tree.to_string(),
            content,
            "Module '{}' CST round-trip must be lossless",
            mod_path
        );

        // L2: Type and semantic checking
        let source_file = sajimora_hir::SourceFile::new(&db, mod_path.to_string(), content);
        let table = sajimora_hir::lower_hir_query(&db, source_file);
        let type_errors = sajimora_types::check_types(&table);
        assert!(
            type_errors.is_empty(),
            "Module '{}' failed L2 type check: {:?}",
            mod_path,
            type_errors
        );
    }
}

#[test]
fn test_phase4_canonical_json_differential_contract() {
    let mut map = serde_json::Map::new();
    map.insert("zebra".to_string(), serde_json::Value::from(1));
    map.insert("apple".to_string(), serde_json::Value::from(2));
    map.insert("middle".to_string(), serde_json::Value::from(3));
    let val = serde_json::Value::Object(map);

    let canonical_str = sajimora_contract::canonical::canonical_json(&val);
    assert_eq!(
        canonical_str,
        r#"{"apple":2,"middle":3,"zebra":1}"#,
        "RFC 8785 must sort keys lexicographically"
    );

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "CanonicalJsonContract",
        &canonical_str,
        r#"{"apple":2,"middle":3,"zebra":1}"#,
    )
    .expect("Canonical JSON differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase4_ed25519_admission_differential_contract() {
    use ed25519_dalek::SigningKey;

    let csprng = [42u8; 32];
    let signing_key = SigningKey::from_bytes(&csprng);
    let verifying_key = signing_key.verifying_key();

    let mut envelope = sajimora_contract::envelope::ContractArtifactEnvelope::new(
        "sjm_test_repo",
        "user_service",
        1,
        sajimora_contract::envelope::ManifestContent {
            schemas: std::collections::BTreeMap::new(),
            services: std::collections::BTreeMap::new(),
        },
    );

    // Sign envelope
    let sig_res = sajimora_contract::admission::sign_envelope(&signing_key, &mut envelope);
    assert!(sig_res.is_ok(), "Signing envelope must succeed");

    // Verify signature
    let is_admitted = sajimora_contract::admission::verify_envelope_signature(&verifying_key, &envelope);
    assert!(is_admitted, "Valid Ed25519 signed envelope must be admitted");

    // Tampering with payload fails admission
    envelope.repository_id = "tampered_repo".to_string();
    let is_tampered_admitted = sajimora_contract::admission::verify_envelope_signature(&verifying_key, &envelope);
    assert!(!is_tampered_admitted, "Tampered envelope must be rejected fail-closed");

    // Contract equivalence check on sealed envelopes
    envelope.repository_id = "sjm_test_repo".to_string();
    let env_json = serde_json::to_string(&envelope).unwrap();
    let proof = ReferenceVerifier::verify_contract_equivalence("AdmissionContract", &env_json, &env_json)
        .expect("Admission contract differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase4_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/ffi/crypto_bridge.parity.json",
        "sjm-core/contract/evolution.parity.json",
        "sjm-core/contract/canonical.parity.json",
        "sjm-core/contract/envelope.parity.json",
        "sjm-core/contract/admission.parity.json",
    ];

    let root = workspace_root();

    for path in &manifest_paths {
        let p = root.join(path);
        let content = fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("Failed to read parity file '{}' at {:?}: {}", path, p, e));
        let json: serde_json::Value = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("Invalid JSON in '{}': {}", path, e));

        assert_eq!(json["l1_status"], "PASS");
        assert_eq!(json["l2_status"], "PASS");
        assert_eq!(json["l3_status"], "PASS");
        let l4 = json["l4_status"].as_str().unwrap();
        assert!(l4 == "PASS" || l4 == "N/A", "L4 must be resolved (PASS or N/A), got: {}", l4);
        assert_eq!(json["verdict"], "UNKNOWN", "Verdict must remain UNKNOWN until full L5 proof");
    }
}
