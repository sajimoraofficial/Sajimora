//! gen_unit_e2e_test.rs — Comprehensive end-to-end test suite for `sajimora gen-unit`.
//!
//! Validates:
//! 1. Autonomous branch test synthesis for business calculation logic
//! 2. Tier 1 linear SMT constraint solving (producing concrete inputs for true and false paths)
//! 3. Strict 2-Hop Mock Budget enforcement (abstains when collaborator depth > 2)
//! 4. JUnit 5 test class generation and atomic file write

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "sajimora-genunit-{tag}-{}-{}",
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_gen_unit(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("gen-unit")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to execute sajimora binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn test_gen_unit_branch_synthesis_and_file_write() {
    let dir = unique_dir("branch-synthesis");
    let file_path = dir.join("PricingEngine.java");
    let out_test_path = dir.join("PricingEngineTest.java");

    let source = r#"package com.example.service;

public class PricingEngine {
    public double calculateTotal(double basePrice, int quantity) {
        if (basePrice > 50.0 && quantity >= 5) {
            return basePrice * quantity * 0.90;
        }
        return basePrice * quantity;
    }
}
"#;

    fs::write(&file_path, source).unwrap();

    let (code, stdout, stderr) = run_gen_unit(&[
        "--file",
        file_path.to_str().unwrap(),
        "--out",
        out_test_path.to_str().unwrap(),
        "--json",
    ]);

    assert_eq!(code, 0, "gen-unit failed: {stderr}");

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON output");

    assert_eq!(json_val["class_name"], "PricingEngine");
    assert_eq!(json_val["test_class_name"], "PricingEngineTest");

    let branches = json_val["branches_synthesized"].as_array().unwrap();
    assert!(
        branches.len() >= 2,
        "Expected at least 2 branches synthesized (THEN and ELSE)"
    );

    // Verify output test file on disk
    assert!(out_test_path.exists(), "Output test file must exist");
    let test_content = fs::read_to_string(&out_test_path).unwrap();
    assert!(test_content.contains("public class PricingEngineTest"));
    assert!(test_content.contains("@Test"));
    assert!(test_content.contains("PricingEngine service = new PricingEngine();"));
    compile_java(&dir, &[&file_path, &out_test_path]);

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_gen_unit_mock_budget_abstention() {
    let dir = unique_dir("mock-abstain");
    let file_path = dir.join("CheckoutService.java");

    let source = r#"package com.example.service;

public class CheckoutService {
    public void checkout(int cartId) {
        if (cartId > 0) {
            // Violates Law of Demeter: 3 hops
            paymentGateway.getWallet().getBankClient().transfer();
        }
    }
}
"#;

    fs::write(&file_path, source).unwrap();

    let (_code, stdout, _stderr) = run_gen_unit(&["--file", file_path.to_str().unwrap(), "--json"]);

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON output");

    let abstentions = json_val["abstentions"].as_array().unwrap();
    assert!(
        abstentions
            .iter()
            .any(|a| a["code"] == "MOCK_BUDGET_EXCEEDED"),
        "Must abstain with MOCK_BUDGET_EXCEEDED when call chain exceeds 2 hops"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_gen_unit_output_is_compilable_and_matches_the_output_filename() {
    let dir = unique_dir("compilable");
    let file_path = dir.join("OrderService.java");
    let out_test_path = dir.join("OrderServiceUnitTest.java");

    let source = r#"package com.example.service;

import java.math.BigDecimal;

public class OrderService {
    private final Repo repo;

    public OrderService(Repo repo) {
        this.repo = repo;
    }

    public BigDecimal apply(String code, BigDecimal subtotal) {
        int updated = repo.update(code);
        if (updated != 1) {
            return BigDecimal.ZERO;
        }
        return subtotal;
    }
}
"#;
    fs::write(&file_path, source).unwrap();

    let (code, stdout, stderr) = run_gen_unit(&[
        "--file",
        file_path.to_str().unwrap(),
        "--out",
        out_test_path.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(
        code, 1,
        "construction abstention must not report success: {stderr}"
    );

    let content = fs::read_to_string(&out_test_path).unwrap();
    assert!(
        content.contains("public class OrderServiceUnitTest"),
        "the public class must match the file name or javac rejects the suite:\n{content}"
    );
    assert!(
        !content.contains("var "),
        "generated Java must stay Java 8 compatible"
    );
    assert!(
        content.contains("import java.math.BigDecimal;"),
        "{content}"
    );
    assert!(
        content.contains("no zero-argument constructor"),
        "a class with only a parameterized constructor must abstain visibly, not emit `new`:\n{content}"
    );
    assert!(!content.contains("new OrderService()"), "{content}");
    assert!(
        content.contains("throw new AssertionError("),
        "the abstention must be an executable failure, not a silent skip"
    );

    let json_val: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(json_val["test_class_name"], "OrderServiceUnitTest");
    assert_eq!(
        json_val["branches_synthesized"].as_array().unwrap().len(),
        0
    );
    assert!(json_val["abstentions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["code"] == "TARGET_CONSTRUCTION_UNSUPPORTED"));
    let repo = dir.join("Repo.java");
    fs::write(
        &repo,
        "package com.example.service; interface Repo { int update(String code); }",
    )
    .unwrap();
    compile_java(&dir, &[&file_path, &out_test_path, &repo]);

    let _ = fs::remove_dir_all(dir);
}

fn compile_java(dir: &std::path::Path, files: &[&std::path::Path]) {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        eprintln!("SKIP javac: no cache home");
        return;
    };
    let cache = PathBuf::from(home).join(".m2/repository");
    let jars = [
        cache.join("org/junit/jupiter/junit-jupiter-api/5.10.2/junit-jupiter-api-5.10.2.jar"),
        cache.join(
            "org/junit/platform/junit-platform-commons/1.10.2/junit-platform-commons-1.10.2.jar",
        ),
        cache.join("org/opentest4j/opentest4j/1.3.0/opentest4j-1.3.0.jar"),
        cache.join("org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar"),
    ];
    if jars.iter().any(|p| !p.is_file())
        || Command::new("javac")
            .arg("-version")
            .output()
            .map_or(true, |o| !o.status.success())
    {
        eprintln!("SKIP javac: compiler or cached JUnit unavailable");
        return;
    }
    let output = Command::new("javac")
        .arg("-cp")
        .arg(std::env::join_paths(jars).unwrap())
        .arg("-d")
        .arg(dir)
        .args(files)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "javac: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("javac PASS: {} source files", files.len());
}

#[test]
fn test_gen_unit_zero_executable_branches_never_exits_successfully() {
    for (name, source, expected_abstention) in [
        ("NoBranches", "public class NoBranches { public int calc(int x) { return x; } }", "NO_EXECUTABLE_BRANCHES"),
        ("UriInput", "import java.net.URI; public class UriInput { public int calc(int x, URI uri) { if (x > 0) return 1; return 0; } }", "UNSUPPORTED_PARAMETER_TYPE"),
        ("PrivateCtor", "public class PrivateCtor { private PrivateCtor() {} public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED"),
    ] {
        let dir = unique_dir(name);
        let file = dir.join(format!("{name}.java"));
        let out = dir.join(format!("{name}UnitTest.java"));
        fs::write(&file, source).unwrap();
        let (code, stdout, stderr) = run_gen_unit(&["--file", file.to_str().unwrap(), "--out", out.to_str().unwrap(), "--json"]);
        assert_eq!(code, 1, "{name}: {stdout}\n{stderr}");
        let suite: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        assert!(suite["branches_synthesized"].as_array().unwrap().is_empty());
        assert!(suite["abstentions"].as_array().unwrap().iter().any(|a| a["code"] == expected_abstention));
        compile_java(&dir, &[&file, &out]);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn test_gen_unit_imported_return_type_compiles() {
    let dir = unique_dir("uri-return");
    let file = dir.join("UriFactory.java");
    let out = dir.join("UriFactoryUnitTest.java");
    fs::write(&file, "import java.net.URI; public class UriFactory { public URI make(int x) { if (x > 0) return URI.create(\"https://example.com\"); return URI.create(\"https://example.org\"); } }").unwrap();
    let (code, stdout, stderr) = run_gen_unit(&[
        "--file",
        file.to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(code, 0, "{stderr}");
    let suite: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(suite["branches_synthesized"].as_array().unwrap().len(), 2);
    compile_java(&dir, &[&file, &out]);
    fs::remove_dir_all(dir).unwrap();
}
