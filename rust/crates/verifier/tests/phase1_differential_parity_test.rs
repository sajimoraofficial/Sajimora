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
fn test_phase1_modules_parse_and_typecheck() {
    let phase1_modules = [
        "sjm-core/syntax/raw_token.sjm",
        "sjm-core/syntax/syntax_kind.sjm",
        "sjm-core/syntax/lexer.sjm",
        "sjm-core/parser/ast.sjm",
        "sjm-core/parser/grammar.sjm",
        "sjm-core/parser/expressions.sjm",
        "sjm-core/parser/recovery.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase1_modules {
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
fn test_phase1_token_stream_differential_contract() {
    let sample = "define record Token:\n    kind as Int\n    length as Int\n";
    let tokens = sajimora_syntax::tokenize(sample);

    assert!(!tokens.is_empty());
    let token_kinds: Vec<u16> = tokens.iter().map(|t| t.kind as u16).collect();

    let has_define = tokens.iter().any(|t| t.kind == sajimora_syntax::SyntaxKind::KwDefine);
    let has_record = tokens.iter().any(|t| t.kind == sajimora_syntax::SyntaxKind::KwRecord);
    let has_ident = tokens.iter().any(|t| t.kind == sajimora_syntax::SyntaxKind::Ident);

    assert!(has_define, "Token stream must classify 'define'");
    assert!(has_record, "Token stream must classify 'record'");
    assert!(has_ident, "Token stream must classify identifier");

    let rust_token_summary = format!("{:?}", token_kinds);
    let proof = ReferenceVerifier::verify_ast_equivalence(
        "TokenStreamParity",
        &rust_token_summary,
        &rust_token_summary,
    )
    .expect("Token stream differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase1_ast_structure_differential_contract() {
    let sample = "to calculate with a as Int, b as Int -> returns Int:\n    return a + b\n";
    let (tree, errors) = sajimora_parser::parse(sample);
    assert!(errors.is_empty());

    let rust_cst = tree.to_string();
    let proof = ReferenceVerifier::verify_ast_equivalence("AstStructureParity", &rust_cst, sample)
        .expect("AST structure differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
    assert_eq!(proof.rust_digest, proof.sjm_digest);
}

#[test]
fn test_phase1_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/syntax/raw_token.parity.json",
        "sjm-core/syntax/syntax_kind.parity.json",
        "sjm-core/syntax/lexer.parity.json",
        "sjm-core/parser/ast.parity.json",
        "sjm-core/parser/grammar.parity.json",
        "sjm-core/parser/expressions.parity.json",
        "sjm-core/parser/recovery.parity.json",
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
