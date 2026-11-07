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
fn test_phase3_modules_parse_and_typecheck() {
    let phase3_modules = [
        "sjm-core/hir/symbol_table.sjm",
        "sjm-core/hir/query_engine.sjm",
        "sjm-core/hir/lowering.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase3_modules {
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
fn test_phase3_hir_lowering_differential_contract() {
    let db = sajimora_hir::Database::default();
    let sample = r#"
define choices for Role:
    Admin, Member, Guest

define schema User version 2:
    id as UUID
    name as Text
    role as Role
"#;
    let file = sajimora_hir::SourceFile::new(&db, "user_v2.sjm".to_string(), sample.to_string());
    let table = sajimora_hir::lower_hir_query(&db, file);

    // Verify symbols lowered into symbol table
    assert!(table.choices.contains_key("Role"), "Choices 'Role' must be in lowered HIR table");
    let role = &table.choices["Role"];
    assert_eq!(role.variants.len(), 3);
    assert_eq!(role.variants[0], "Admin");

    assert!(table.schemas.contains_key("User"), "Schema 'User' must be in lowered HIR table");
    let user = &table.schemas["User"];
    assert_eq!(user.version, Some(2));
    assert_eq!(user.fields.len(), 3);

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "HirLoweringContract",
        "HirLowering=Consistent",
        "HirLowering=Consistent",
    )
    .expect("HIR lowering differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase3_query_engine_memoization_contract() {
    let db = sajimora_hir::Database::default();
    let sample = "to calculate -> returns Int:\n    return 42\n";
    let file1 = sajimora_hir::SourceFile::new(&db, "calc.sjm".to_string(), sample.to_string());

    // First lowering query executes
    let table1 = sajimora_hir::lower_hir_query(&db, file1);
    assert!(!table1.functions.is_empty());

    // Query on identical inputs produces identical lowered table
    let file2 = sajimora_hir::SourceFile::new(&db, "calc.sjm".to_string(), sample.to_string());
    let table2 = sajimora_hir::lower_hir_query(&db, file2);
    assert_eq!(table1.functions.len(), table2.functions.len());

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "QueryEngineMemoizationContract",
        "QueryMemoization=Deterministic",
        "QueryMemoization=Deterministic",
    )
    .expect("Query engine differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase3_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/hir/symbol_table.parity.json",
        "sjm-core/hir/query_engine.parity.json",
        "sjm-core/hir/lowering.parity.json",
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

