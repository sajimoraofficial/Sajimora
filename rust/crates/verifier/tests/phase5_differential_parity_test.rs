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
fn test_phase5_modules_parse_and_typecheck() {
    let phase5_modules = [
        "sjm-core/ai/slot_tagger.sjm",
        "sjm-core/ai/intent_gate.sjm",
        "sjm-core/ai/knowledge_governor.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase5_modules {
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
fn test_phase5_intent_gate_e042_differential_contract() {
    // 1. Source with unexpanded intent must be detected
    let ungrounded_code = "to process:\n    ?> calculate total discount with rate 0.1\n";
    let unexpanded = sajimora_ai::ExpandEngine::find_unexpanded_intents(ungrounded_code);
    assert_eq!(unexpanded.len(), 1, "Must find exactly 1 unexpanded intent block");
    assert_eq!(unexpanded[0].0, 2, "Intent block is on line 2");

    // 2. Clean source has 0 unexpanded intents
    let clean_code = "to process -> returns Int:\n    return 42\n";
    let clean_intents = sajimora_ai::ExpandEngine::find_unexpanded_intents(clean_code);
    assert!(clean_intents.is_empty(), "Clean source must have 0 unexpanded intents");

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "IntentGateE042Contract",
        "E042=FailClosedOnUngrounded",
        "E042=FailClosedOnUngrounded",
    )
    .expect("Intent gate differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase5_knowledge_governor_redaction_differential_contract() {
    use sajimora_ai::knowledge_governor::{KnowledgeGovernor, KnowledgeLevel};

    // 1. Public content is allowed
    let pub_content = "define schema User version 1:\n    id as UUID\n";
    let pub_verdict = KnowledgeGovernor::sanitize_output(pub_content);
    assert_eq!(pub_verdict.level, KnowledgeLevel::Level1Public);
    assert!(pub_verdict.is_allowed);
    assert!(!pub_verdict.leak_prevented);

    // 2. Proprietary Level 3 content is blocked and redacted
    let proprietary_content = "Internal details: presburger_solver_heuristic_v2 coefficients";
    let prop_verdict = KnowledgeGovernor::sanitize_output(proprietary_content);
    assert_eq!(prop_verdict.level, KnowledgeLevel::Level3Proprietary);
    assert!(!prop_verdict.is_allowed);
    assert!(prop_verdict.leak_prevented);
    assert!(prop_verdict.sanitized_content.contains("[REDACTED"));

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "KnowledgeGovernorRedactionContract",
        "Level3=RedactedAndBlocked",
        "Level3=RedactedAndBlocked",
    )
    .expect("Knowledge governor differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase5_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/ai/slot_tagger.parity.json",
        "sjm-core/ai/intent_gate.parity.json",
        "sjm-core/ai/knowledge_governor.parity.json",
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
        assert_eq!(json["l4_status"], "N/A");
        assert_eq!(json["verdict"], "UNKNOWN", "Verdict must remain UNKNOWN until full L5 proof");
    }
}

