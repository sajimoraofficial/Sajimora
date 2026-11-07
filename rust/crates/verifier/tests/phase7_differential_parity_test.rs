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
fn test_phase7_modules_parse_and_typecheck() {
    let phase7_modules = [
        "sjm-core/verifier/bisim.sjm",
        "sjm-core/verifier/solver.sjm",
        "sjm-core/verifier/invariants.sjm",
        "sjm-core/verifier/witness.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase7_modules {
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
fn test_phase7_bisimulation_verdict_differential_contract() {
    let proof = ReferenceVerifier::verify_ast_equivalence(
        "BisimulationEquivalenceContract",
        "Bisimulation=SoundProofGenerated",
        "Bisimulation=SoundProofGenerated",
    )
    .expect("Bisimulation equivalence differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase7_smt_solver_proof_differential_contract() {
    let proof = ReferenceVerifier::verify_ast_equivalence(
        "SmtSolverProofContract",
        "PresburgerLinearInequality=SolvedDeterministic",
        "PresburgerLinearInequality=SolvedDeterministic",
    )
    .expect("SMT solver proof differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase7_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/verifier/bisim.parity.json",
        "sjm-core/verifier/solver.parity.json",
        "sjm-core/verifier/invariants.parity.json",
        "sjm-core/verifier/witness.parity.json",
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
        assert_eq!(json["verdict"], "UNKNOWN", "Verdict must remain UNKNOWN until full L5 proof");
    }
}

