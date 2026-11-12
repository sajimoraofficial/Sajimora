//! heal_e2e_test.rs — Comprehensive end-to-end integration tests for `sajimora heal`.
//!
//! Validates:
//! 1. AST call-site healing with injected default values
//! 2. Idempotence: heal(heal(x)) == heal(x) byte-for-byte
//! 3. Preservation of inline comments, formatting, and annotations verbatim
//! 4. Fail-closed abstention on side-effecting argument expressions (P1-C)
//! 5. Fail-closed abstention on unresolvable default expressions (P1-A)
//! 6. Zero-argument call-site healing
//! 7. Automatic signature diff healing (--old-file and --new-file)
//! 8. Advisory detect-only mode (zero disk mutations)
//! 9. Regression test: Parameter reordering, no corruption of unrelated assertions, TypeScript file isolation

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
        "sajimora-heal-{tag}-{}-{}",
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_heal(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("heal")
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
fn test_heal_primitive_param_addition_and_idempotence() {
    let dir = unique_dir("primitive-heal");
    let file_path = dir.join("PriceCalculatorTest.java");

    let original_source = r#"package com.example.service;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class PriceCalculatorTest {
    @Test
    void testStandardCalculation() {
        PriceCalculator calc = new PriceCalculator();
        double result = calc.calculateFinalPrice(100.0, 0.15);
        assertEquals(85.0, result);
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, stdout, stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "calculateFinalPrice",
        "--default-value",
        "false",
    ]);

    assert_eq!(code, 0, "Heal failed. Stderr: {stderr}");
    assert!(stdout.contains("Successfully healed 1 call sites"));

    let patched_source = fs::read_to_string(&file_path).unwrap();
    assert!(
        patched_source.contains("calc.calculateFinalPrice(100.0, 0.15, false);"),
        "Call site was not healed as expected. Actual content:\n{patched_source}"
    );

    // IDEMPOTENCE TEST: Run heal second time on already-healed file
    let (code2, stdout2, stderr2) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "calculateFinalPrice",
        "--default-value",
        "false",
    ]);

    assert_eq!(code2, 0, "Second run failed. Stderr: {stderr2}");
    assert!(stdout2.contains("Successfully healed 0 call sites"));

    let second_run_source = fs::read_to_string(&file_path).unwrap();
    assert_eq!(
        patched_source, second_run_source,
        "Files must be byte-identical on repeat runs"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_abstention_on_side_effecting_argument() {
    let dir = unique_dir("side-effect");
    let file_path = dir.join("SideEffectTest.java");

    let original_source = r#"package com.example.service;

public class SideEffectTest {
    @Test
    void testSideEffect() {
        calc.processOrder(computeDiscount(user), 42);
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, stdout, _stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "processOrder",
        "--default-value",
        "false",
        "--json",
    ]);

    assert_eq!(code, 1, "Expected exit code 1 for abstention");

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON report output");

    let abstentions = json_val["abstentions"].as_array().unwrap();
    assert_eq!(abstentions.len(), 1);
    assert_eq!(abstentions[0]["code"], "HEAL_SIDE_EFFECT_ARGUMENT");
    assert_eq!(abstentions[0]["method"], "processOrder");
    assert_eq!(abstentions[0]["argument_index"], 0);

    let current_source = fs::read_to_string(&file_path).unwrap();
    assert_eq!(
        original_source, current_source,
        "File must remain unchanged on abstention"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_abstention_on_unresolvable_default() {
    let dir = unique_dir("unresolvable-default");
    let file_path = dir.join("UnresolvableDefaultTest.java");

    let original_source = r#"package com.example.service;

public class UnresolvableDefaultTest {
    @Test
    void testUnresolvable() {
        repo.query(123);
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, stdout, _stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "query",
        "--default-value",
        "UnknownContext.builder().build()",
        "--json",
    ]);

    assert_eq!(
        code, 1,
        "Expected exit code 1 for unresolvable default abstention"
    );

    let json_val: serde_json::Value =
        serde_json::from_str(&stdout).expect("Failed to parse JSON report output");

    let abstentions = json_val["abstentions"].as_array().unwrap();
    assert_eq!(abstentions.len(), 1);
    assert_eq!(abstentions[0]["code"], "HEAL_DEFAULT_UNRESOLVABLE");
    assert_eq!(abstentions[0]["method"], "query");

    let current_source = fs::read_to_string(&file_path).unwrap();
    assert_eq!(
        original_source, current_source,
        "File must remain unchanged on unresolvable default"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_preserves_inline_comments_verbatim() {
    let dir = unique_dir("comments-preservation");
    let file_path = dir.join("CommentsPreservationTest.java");

    let original_source = r#"package com.example.service;

public class CommentsPreservationTest {
    @Test
    void testCommentPreservation() {
        service.apply(/* reason= */ code, 42);
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, _stdout, stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "apply",
        "--default-value",
        "true",
    ]);

    assert_eq!(code, 0, "Heal failed. Stderr: {stderr}");

    let patched_source = fs::read_to_string(&file_path).unwrap();
    assert!(
        patched_source.contains("service.apply(/* reason= */ code, 42, true);"),
        "Comment preservation failed: {patched_source}"
    );
    assert!(patched_source.contains("/* reason= */"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_advisory_detect_only_mode() {
    let dir = unique_dir("detect-only");
    let file_path = dir.join("DetectOnlyTest.java");

    let original_source = r#"package com.example.service;

public class DetectOnlyTest {
    @Test
    void testAdvisory() {
        service.calculateFinalPrice(100.0);
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, stdout, _stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "calculateFinalPrice",
        "--default-value",
        "false",
        "--detect-only",
    ]);

    // Detect-only mode reports non-zero exit code (1) when eligible call sites are broken/unhealed
    assert_eq!(code, 1);
    assert!(stdout.contains("Advisory Mode: 1 call sites eligible for healing"));

    let current_source = fs::read_to_string(&file_path).unwrap();
    assert_eq!(
        original_source, current_source,
        "Detect-only mode must make zero writes to disk"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_zero_argument_call_site() {
    let dir = unique_dir("zero-arg");
    let file_path = dir.join("ZeroArgTest.java");

    let original_source = r#"package com.example.service;

public class ZeroArgTest {
    @Test
    void testZeroArg() {
        service.doWork();
    }
}
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, _stdout, stderr) = run_heal(&[
        "--test-dir",
        file_path.to_str().unwrap(),
        "--method",
        "doWork",
        "--default-value",
        "true",
    ]);

    assert_eq!(code, 0, "Heal failed: {stderr}");

    let patched_source = fs::read_to_string(&file_path).unwrap();
    assert!(
        patched_source.contains("service.doWork(true);"),
        "Zero arg patch mismatch: {patched_source}"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_automatic_signature_diff() {
    let dir = unique_dir("auto-diff");
    let old_service_path = dir.join("OrderServiceOld.java");
    let new_service_path = dir.join("OrderServiceNew.java");
    let test_path = dir.join("OrderServiceTest.java");

    let old_src = r#"package com.example.service;

public class OrderService {
    public OrderResponse placeOrder(String userId, double amount) {
        return null;
    }
}
"#;

    let new_src = r#"package com.example.service;

public class OrderService {
    public OrderResponse placeOrder(String userId, double amount, boolean expressShipping) {
        return null;
    }
}
"#;

    let test_src = r#"package com.example.service;

import org.junit.jupiter.api.Test;

public class OrderServiceTest {
    @Test
    void testOrder() {
        service.placeOrder("user123", 99.99);
    }
}
"#;

    fs::write(&old_service_path, old_src).unwrap();
    fs::write(&new_service_path, new_src).unwrap();
    fs::write(&test_path, test_src).unwrap();

    let (code, stdout, stderr) = run_heal(&[
        "--test-dir",
        test_path.to_str().unwrap(),
        "--old-file",
        old_service_path.to_str().unwrap(),
        "--new-file",
        new_service_path.to_str().unwrap(),
    ]);

    assert_eq!(code, 0, "Automatic signature diff heal failed: {stderr}");
    assert!(stdout.contains("Successfully healed 1 call sites"));

    let healed_content = fs::read_to_string(&test_path).unwrap();
    assert!(
        healed_content.contains("service.placeOrder(\"user123\", 99.99, false);"),
        "Failed to auto-heal signature diff: {healed_content}"
    );

    // Repeat run to ensure idempotence
    let (code2, stdout2, _) = run_heal(&[
        "--test-dir",
        test_path.to_str().unwrap(),
        "--old-file",
        old_service_path.to_str().unwrap(),
        "--new-file",
        new_service_path.to_str().unwrap(),
    ]);
    assert_eq!(code2, 0);
    assert!(stdout2.contains("Successfully healed 0 call sites"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_does_not_corrupt_unrelated_methods_or_reordered_params() {
    let dir = unique_dir("no-corrupt");
    let old_service = dir.join("PriceServiceOld.java");
    let new_service = dir.join("PriceServiceNew.java");
    let test_java = dir.join("PriceServiceTest.java");
    let ts_file = dir.join("price.service.spec.ts");

    // Old: price(int total, boolean vip)
    let old_src = r#"package com.example;
public class PriceService {
    public int price(int total, boolean vip) { return 0; }
}
"#;
    // New reordered: price(boolean vip, int total)
    let new_src = r#"package com.example;
public class PriceService {
    public int price(boolean vip, int total) { return 0; }
}
"#;
    let test_src = r#"package com.example;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
public class PriceServiceTest {
    @Test
    void testPrice() {
        int r = svc.price(100, true);
        assertEquals(100, r);
    }
}
"#;
    let ts_src = r#"
describe("pricing", () => {
    it("computes", () => {
        const res = compute(a, 2);
        expect(res).toBe(2);
    });
});
"#;

    fs::write(&old_service, old_src).unwrap();
    fs::write(&new_service, new_src).unwrap();
    fs::write(&test_java, test_src).unwrap();
    fs::write(&ts_file, ts_src).unwrap();

    let (code, stdout, stderr) = run_heal(&[
        "--test-dir",
        dir.to_str().unwrap(),
        "--old-file",
        old_service.to_str().unwrap(),
        "--new-file",
        new_service.to_str().unwrap(),
    ]);

    assert_eq!(code, 0, "Heal reorder must succeed: {stderr}");
    assert!(stdout.contains("Successfully healed 1 call sites"));

    let java_after = fs::read_to_string(&test_java).unwrap();
    // 1. Target method was properly reordered
    assert!(
        java_after.contains("svc.price(true, 100);"),
        "Expected reordered args: {java_after}"
    );
    // 2. Unrelated assertEquals was NOT corrupted with ', false'
    assert!(
        java_after.contains("assertEquals(100, r);"),
        "assertEquals must remain untouched: {java_after}"
    );
    assert!(
        !java_after.contains("assertEquals(100, r, false);"),
        "assertEquals corrupted with false: {java_after}"
    );

    // 3. TypeScript file was completely untouched
    let ts_after = fs::read_to_string(&ts_file).unwrap();
    assert_eq!(
        ts_src, ts_after,
        "TypeScript file must never be touched by Java AST healer"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_heal_typescript_call_site_addition_and_idempotence() {
    let dir = unique_dir("ts-heal");
    let file_path = dir.join("priceCalculator.test.ts");

    let original_source = r#"import { calculateFinalPrice } from './calculator';

describe("PriceCalculator", () => {
    it("calculates standard discount", () => {
        const result = calculateFinalPrice(100.0, 0.15);
        expect(result).toBe(85.0);
    });
});
"#;

    fs::write(&file_path, original_source).unwrap();

    let (code, stdout, stderr) = run_heal(&[
        "--test-dir",
        dir.to_str().unwrap(),
        "--method",
        "calculateFinalPrice",
        "--default-value",
        "true",
    ]);

    assert_eq!(code, 0, "Heal command failed: {stderr}");
    assert!(
        stdout.contains("Successfully healed 1 call sites"),
        "stdout: {stdout}"
    );

    let content_after_first = fs::read_to_string(&file_path).unwrap();
    assert!(
        content_after_first.contains("calculateFinalPrice(100.0, 0.15, true)"),
        "Content after first heal: {content_after_first}"
    );

    // Idempotence test: second run must find 0 eligible unhealed call sites
    let (code2, stdout2, _) = run_heal(&[
        "--test-dir",
        dir.to_str().unwrap(),
        "--method",
        "calculateFinalPrice",
        "--default-value",
        "true",
    ]);

    assert_eq!(code2, 0);
    assert!(
        stdout2.contains("Successfully healed 0 call sites"),
        "Second heal must be a no-op: {stdout2}"
    );

    let content_after_second = fs::read_to_string(&file_path).unwrap();
    assert_eq!(
        content_after_first, content_after_second,
        "Idempotence failed"
    );

    let _ = fs::remove_dir_all(dir);
}
