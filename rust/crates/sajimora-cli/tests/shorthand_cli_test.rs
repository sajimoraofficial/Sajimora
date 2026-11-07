//! shorthand_cli_test.rs — Test short, intuitive developer CLI command aliases and positional defaults.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "sajimora-shorthand-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

#[test]
fn test_shorthand_unit_alias_and_positional_file() {
    let dir = unique_dir("shorthand-unit");
    let calc_file = dir.join("Calculator.java");
    let java_code = r#"package com.example;

public class Calculator {
    public int calculateDiscount(int total, boolean isVip) {
        if (total > 100 && isVip) {
            return 20;
        } else {
            return 0;
        }
    }
}
"#;
    fs::write(&calc_file, java_code).unwrap();

    // Use shorthand `sajimora unit Calculator.java` (alias for gen-unit with auto-derived output!)
    let output = Command::new(cli_bin())
        .arg("unit")
        .arg(&calc_file)
        .output()
        .expect("Failed to execute sajimora unit shorthand");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "sajimora unit shorthand failed. stdout: {}, stderr: {}",
        stdout,
        stderr
    );

    // Auto-derived output should be CalculatorTest.java
    let derived_out = dir.join("CalculatorTest.java");
    assert!(
        derived_out.exists(),
        "Auto-derived test file CalculatorTest.java should exist on disk"
    );
    let content = fs::read_to_string(derived_out).unwrap();
    assert!(content.contains("class CalculatorTest"));
    assert!(content.contains("calculateDiscount"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_shorthand_props_alias_and_positional_file() {
    let dir = unique_dir("shorthand-props");
    let sanitizer_file = dir.join("Sanitizer.java");
    let java_code = r#"package com.example;

public class Sanitizer {
    public String normalize(String input) {
        return input.trim().toLowerCase();
    }
}
"#;
    fs::write(&sanitizer_file, java_code).unwrap();

    // Use shorthand `sajimora props Sanitizer.java` (alias for gen-invariants)
    let output = Command::new(cli_bin())
        .arg("props")
        .arg(&sanitizer_file)
        .output()
        .expect("Failed to execute sajimora props shorthand");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "sajimora props shorthand failed. stdout: {}",
        stdout
    );
    assert!(stdout.contains("@Property") || stdout.contains("normalize"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_shorthand_fix_alias() {
    let dir = unique_dir("shorthand-fix");
    let test_file = dir.join("OrderServiceTest.java");
    let test_code = r#"package com.example;

public class OrderServiceTest {
    public void testCompute() {
        var service = new OrderService();
        service.calculateTotal(50);
    }
}
"#;
    fs::write(&test_file, test_code).unwrap();

    // Use shorthand `sajimora fix calculateTotal --default-value true -t <dir>`
    let output = Command::new(cli_bin())
        .arg("fix")
        .arg("calculateTotal")
        .arg("--default-value")
        .arg("true")
        .arg("-t")
        .arg(&dir)
        .output()
        .expect("Failed to execute sajimora fix shorthand");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "sajimora fix shorthand failed. stdout: {}",
        stdout
    );
    let healed = fs::read_to_string(&test_file).unwrap();
    assert!(healed.contains("calculateTotal(50, true)"));

    let _ = fs::remove_dir_all(dir);
}
