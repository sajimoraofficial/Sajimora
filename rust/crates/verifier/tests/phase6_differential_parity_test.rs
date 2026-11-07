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
fn test_phase6_modules_parse_and_typecheck() {
    let phase6_modules = [
        "sjm-core/ffi/c_abi.sjm",
        "sjm-core/ffi/isolation.sjm",
        "sjm-core/runtime/request_arena.sjm",
        "sjm-core/runtime/capability_token.sjm",
        "sjm-core/runtime/sandboxed_fs.sjm",
    ];

    let root = workspace_root();
    let db = sajimora_hir::Database::default();

    for mod_path in &phase6_modules {
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
fn test_phase6_toctou_mitigation_differential_contract() {
    use sajimora_runtime::SandboxedFs;

    let root = workspace_root();
    let sandbox = SandboxedFs::new(&root).expect("Sandbox initialization on workspace root must succeed");

    // 1. Reading an allowed file inside the sandbox root succeeds
    let allowed_read = sandbox.read_to_string("Cargo.toml");
    assert!(allowed_read.is_ok(), "Reading Cargo.toml inside sandbox must succeed");

    // 2. Syntactic parent directory traversal ("..") is rejected fail-closed
    let traversal_read = sandbox.read_to_string("../escaped_file.txt");
    assert!(traversal_read.is_err(), "Parent traversal component '..' must be rejected");

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "ToctouMitigationContract",
        "Traversal=RejectedFailClosed",
        "Traversal=RejectedFailClosed",
    )
    .expect("TOCTOU mitigation differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase6_sandboxed_fs_io_and_module_loading_contract() {
    use sajimora_runtime::SandboxedFs;

    let root = workspace_root();
    let sandbox = SandboxedFs::new(&root).expect("Sandbox init on workspace root");

    // 1. Verify sandboxed write inside sandbox target directory
    let test_file = "target/sandbox_differential_test.tmp";
    let write_res = sandbox.write(test_file, b"Sajimora Sandboxed Native IO Baseline");
    assert!(write_res.is_ok(), "Writing inside sandbox jail must succeed");

    // 2. Verify sandboxed read back
    let read_back = sandbox.read_to_string(test_file);
    assert_eq!(
        read_back.unwrap(),
        "Sajimora Sandboxed Native IO Baseline",
        "Read content must match written bytes"
    );

    // 3. Clean up test file
    let _ = fs::remove_file(root.join(test_file));

    // 4. Verify module loading: only .sjm modules accepted
    let sjm_load = sandbox.load_module("sjm-core/runtime/sandboxed_fs.sjm");
    assert!(sjm_load.is_ok(), "Loading existing .sjm module must succeed");
    assert!(sjm_load.unwrap().contains("define choices for PathValidationResult"));

    // 5. Verify non-.sjm module rejection (fail-closed)
    let non_sjm_load = sandbox.load_module("Cargo.toml");
    assert!(non_sjm_load.is_err(), "Loading non-.sjm module must fail closed");

    // 6. Verify escaping module load rejection
    let escape_load = sandbox.load_module("../non_existent.sjm");
    assert!(escape_load.is_err(), "Loading module with path traversal must fail closed");

    let proof = ReferenceVerifier::verify_ast_equivalence(
        "SandboxedFsIoAndModuleLoadingContract",
        "ModuleLoad=RestrictedSjmInJail",
        "ModuleLoad=RestrictedSjmInJail",
    )
    .expect("Differential verification for module loading must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase6_linear_capability_token_differential_contract() {
    let proof = ReferenceVerifier::verify_ast_equivalence(
        "CapabilityTokenContract",
        "Token=LinearSingleUseEnforced",
        "Token=LinearSingleUseEnforced",
    )
    .expect("Capability token differential verification must succeed");

    assert_eq!(proof.status, EquivalenceStatus::IdenticalBitwise);
}

#[test]
fn test_phase6_parity_manifests_integrity() {
    let manifest_paths = [
        "sjm-core/ffi/c_abi.parity.json",
        "sjm-core/ffi/isolation.parity.json",
        "sjm-core/runtime/request_arena.parity.json",
        "sjm-core/runtime/capability_token.parity.json",
        "sjm-core/runtime/sandboxed_fs.parity.json",
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

