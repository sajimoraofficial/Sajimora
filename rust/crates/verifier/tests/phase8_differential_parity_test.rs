use std::fs;
use std::path::{Path, PathBuf};

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

/// L1/L2 are real checks: every Phase 8 module must parse losslessly and
/// typecheck. This says nothing about behavioral parity (L3) or bootstrap.
#[test]
fn test_phase8_modules_parse_and_typecheck() {
    let phase8_modules = [
        "sjm-core/codegen/ir.sjm",
        "sjm-core/codegen/backend.sjm",
        "sjm-core/codegen/emitter.sjm",
        "sjm-core/codegen/linker.sjm",
        "sjm-core/codegen/bootstrap.sjm",
        "sjm-core/cli/sjm_driver.sjm",
        "sjm-core/cli/repl.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase8_modules {
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

/// Parity manifests are claims, not evidence. A codegen manifest may only
/// claim L3 PASS if it names a committed differential evidence file. The
/// previous test asserted the literal string "PASS" and a literal verdict,
/// which certified nothing.
#[test]
fn test_phase8_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/codegen/ir.parity.json",
        "sjm-core/codegen/backend.parity.json",
        "sjm-core/codegen/emitter.parity.json",
        "sjm-core/codegen/linker.parity.json",
        "sjm-core/codegen/bootstrap.parity.json",
    ];

    let root = workspace_root();

    for path in &manifest_paths {
        let p = root.join(path);
        let content = fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("Failed to read parity file '{}' at {:?}: {}", path, p, e));
        let json: serde_json::Value = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("Invalid JSON in '{}': {}", path, e));

        assert_eq!(
            json["verdict"], "UNKNOWN",
            "'{}' must not claim a final verdict without an L5 proof",
            path
        );
        if let Some(reference) = json.get("rust_reference").and_then(|v| v.as_str()) {
            assert!(
                root.join(reference).exists(),
                "'{}' references missing rust file '{}'",
                path,
                reference
            );
        }
        if json["l3_status"] == "PASS" {
            let evidence = json
                .get("differential_evidence")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| {
                    panic!(
                        "'{}' claims L3 PASS without a differential evidence file",
                        path
                    )
                });
            assert!(
                root.join(evidence).exists(),
                "'{}' differential evidence file '{}' is missing",
                path,
                evidence
            );
        }
    }
}
