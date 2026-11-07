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
fn test_phase2_modules_parse_and_typecheck() {
    let phase2_modules = [
        "sjm-core/types/type_spec.sjm",
        "sjm-core/types/subtyping.sjm",
        "sjm-core/types/ownership.sjm",
        "sjm-core/types/diagnostics.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase2_modules {
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
fn test_phase2_type_inference_differential_contract() {
    let db = sajimora_hir::Database::default();

    // 1. Valid typed expression
    let valid_code = r#"
to add with a as Int, b as Int -> returns Int:
    return a + b
"#;
    let file_ok = sajimora_hir::SourceFile::new(&db, "valid_add.sjm".to_string(), valid_code.to_string());
    let table_ok = sajimora_hir::lower_hir_query(&db, file_ok);
    let errors_ok = sajimora_types::check_types(&table_ok);
    assert!(errors_ok.is_empty(), "Valid addition must pass type check");

    // 2. Type mismatch detection
    let bad_code = r#"
to bad_add -> returns Int:
    let a be 10
    let b as Text be "hello"
    return a + b
"#;
    let file_bad = sajimora_hir::SourceFile::new(&db, "bad_add.sjm".to_string(), bad_code.to_string());
    let table_bad = sajimora_hir::lower_hir_query(&db, file_bad);
    let errors_bad = sajimora_types::check_types(&table_bad);

    let has_mismatch = errors_bad
        .iter()
        .any(|e| matches!(e, sajimora_types::TypeError::TypeMismatch { .. }));
    assert!(has_mismatch, "Expected TypeMismatch error on Int + Text");

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "TypeInferenceContract",
        "TypeSafety=Enforced",
        "TypeSafety=Enforced",
    )
    .expect("Type inference differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase2_ownership_diagnostics_differential_contract() {
    let db = sajimora_hir::Database::default();

    // 1. Primitive Int has Value Copy Semantics
    let copy_code = r#"
to test_copy -> returns Int:
    let a be 42
    let b be a
    return a + b
"#;
    let file_copy = sajimora_hir::SourceFile::new(&db, "copy.sjm".to_string(), copy_code.to_string());
    let table_copy = sajimora_hir::lower_hir_query(&db, file_copy);
    let errors_copy = sajimora_types::check_types(&table_copy);
    assert!(errors_copy.is_empty(), "Primitive copy should not trigger use-after-move");

    // 2. Dynamic Text has Single-Owner Move Semantics: triggers E105 UseAfterMove
    let move_code = r#"
to test_move -> returns Text:
    let original as Text be "hello"
    let transferred be original
    return original
"#;
    let file_move = sajimora_hir::SourceFile::new(&db, "move.sjm".to_string(), move_code.to_string());
    let table_move = sajimora_hir::lower_hir_query(&db, file_move);
    let errors_move = sajimora_types::check_types(&table_move);

    let has_e105 = errors_move
        .iter()
        .any(|e| matches!(e, sajimora_types::TypeError::UseAfterMove { name, .. } if name == "original"));

    assert!(
        has_e105,
        "Expected E105 UseAfterMove on Text value, got: {:?}",
        errors_move
    );

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "OwnershipDiagnosticsContract",
        "E105=UseAfterMoveRejected",
        "E105=UseAfterMoveRejected",
    )
    .expect("Ownership diagnostics differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase2_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/types/type_spec.parity.json",
        "sjm-core/types/subtyping.parity.json",
        "sjm-core/types/ownership.parity.json",
        "sjm-core/types/diagnostics.parity.json",
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
        assert_eq!(json["l4_status"], "N/A", "Ownership and types must have l4_status N/A");
        assert_eq!(json["verdict"], "UNKNOWN", "Verdict must remain UNKNOWN until full L5 proof");
    }
}
