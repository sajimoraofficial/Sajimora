use tree_sitter::Parser;
use verifier::symbolic::{
    parse_java_condition, synthesize_unit_tests_for_java, SynthesizedUnitTestSuite,
};

// Compile real source + generated suite using only already cached Maven artifacts.
fn compile_generated_java(source: &str, suite: &SynthesizedUnitTestSuite) {
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let Some(home) = home else {
        eprintln!("SKIP javac: no Maven cache home");
        return;
    };
    let cache = PathBuf::from(home).join(".m2/repository");
    let mut jars = vec![
        cache.join("org/junit/jupiter/junit-jupiter-api/5.10.2/junit-jupiter-api-5.10.2.jar"),
        cache.join(
            "org/junit/platform/junit-platform-commons/1.10.2/junit-platform-commons-1.10.2.jar",
        ),
        cache.join("org/opentest4j/opentest4j/1.3.0/opentest4j-1.3.0.jar"),
        cache.join("org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar"),
    ];
    if source.contains("lombok") {
        jars.push(cache.join("org/projectlombok/lombok/1.18.44/lombok-1.18.44.jar"));
    }
    if jars.iter().any(|jar| !jar.is_file())
        || Command::new("javac")
            .arg("-version")
            .output()
            .map_or(true, |o| !o.status.success())
    {
        eprintln!("SKIP javac: compiler or cached JUnit/Lombok prerequisites unavailable");
        return;
    }
    let dir = std::env::temp_dir().join(format!(
        "sajimora-symbolic-javac-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let target = dir.join(format!("{}.java", suite.class_name));
    let test = dir.join(format!("{}.java", suite.test_class_name));
    fs::write(&target, source).unwrap();
    fs::write(&test, &suite.test_source_code).unwrap();
    let output = Command::new("javac")
        .arg("-cp")
        .arg(std::env::join_paths(jars).unwrap())
        .arg("-d")
        .arg(&dir)
        .arg(&target)
        .arg(&test)
        .output()
        .unwrap();
    let _ = fs::remove_dir_all(&dir);
    assert!(
        output.status.success(),
        "javac rejected {}:\n{}\n{}",
        suite.test_class_name,
        String::from_utf8_lossy(&output.stderr),
        suite.test_source_code
    );
    eprintln!(
        "javac PASS: {} (target + generated suite)",
        suite.test_class_name
    );
}

fn assert_abstained(source: &str, code: &str) -> SynthesizedUnitTestSuite {
    let suite = synthesize_unit_tests_for_java(source, None, 50).unwrap();
    assert!(
        suite.branches_synthesized.is_empty(),
        "diagnostic-only suite must count zero executable branches: {suite:?}"
    );
    assert!(
        suite.abstentions.iter().any(|a| a.code == code),
        "missing {code}: {suite:?}"
    );
    compile_generated_java(source, &suite);
    suite
}

#[test]
fn construction_abstention_has_structured_zero_branch_count() {
    assert_abstained("public class Injected { public Injected(Object dependency) {} public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn inaccessible_or_abstract_target_abstains() {
    for source in [
        "public class PrivateCtor { private PrivateCtor() {} public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "public abstract class AbstractTarget { public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "public class ThrowingCtor { public ThrowingCtor() throws java.io.IOException {} public int calc(int x) { if (x > 0) return 1; return 0; } }",
    ] { assert_abstained(source, "TARGET_CONSTRUCTION_UNSUPPORTED"); }
}

#[test]
fn structural_lombok_required_args_and_field_modifiers_abstain() {
    assert_abstained("@lombok.RequiredArgsConstructor public class Required { private final Object dependency; public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn structural_lombok_all_args_modifier_abstains() {
    assert_abstained("@lombok.AllArgsConstructor public class AllArgs { private Object dependency; public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn structural_lombok_value_modifier_abstains() {
    assert_abstained("@lombok.Value public class ValueTarget { Object dependency; public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn structural_lombok_non_null_field_modifier_abstains() {
    assert_abstained("@lombok.RequiredArgsConstructor public class NonNullTarget { @lombok.NonNull private Object dependency; public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn lombok_private_no_argument_constructor_abstains() {
    assert_abstained("@lombok.NoArgsConstructor(access = lombok.AccessLevel.PRIVATE) public class PrivateLombokZero { public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn partial_abstention_retains_executable_branches_and_solver_results() {
    let source = "import java.net.URI; public class Mixed { public int good(int x) { if (x > 0) return 1; return 0; } public int bad(int x, URI uri) { if (x > 0) return 1; return 0; } }";
    let suite = synthesize_unit_tests_for_java(source, None, 50).unwrap();
    assert_eq!(suite.branches_synthesized.len(), 2);
    assert!(suite
        .branches_synthesized
        .iter()
        .all(|b| b.method_name == "good"));
    assert_eq!(suite.abstentions.len(), 2);
    assert!(suite
        .abstentions
        .iter()
        .all(|a| a.method_name == "bad" && a.code == "UNSUPPORTED_PARAMETER_TYPE"));
    compile_generated_java(source, &suite);
}

#[test]
fn valid_zero_argument_constructors_generate_compilable_branches() {
    for source in [
        "public class ExplicitZero { public ExplicitZero() {} public ExplicitZero(Object dependency) {} public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "public class PackageZero { PackageZero() {} public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "@lombok.RequiredArgsConstructor public class InitializedFinal { private final Object dependency = new Object(); public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "@lombok.AllArgsConstructor public class ExplicitLombokZero { private Object dependency; public ExplicitLombokZero() {} public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "@lombok.Value public class InitializedValue { Object dependency = new Object(); public int calc(int x) { if (x > 0) return 1; return 0; } }",
        "@lombok.NoArgsConstructor public class LombokZero { private Object dependency; public int calc(int x) { if (x > 0) return 1; return 0; } }",
    ] {
        let suite = synthesize_unit_tests_for_java(source, None, 50).unwrap();
        assert_eq!(suite.branches_synthesized.len(), 2, "{suite:?}");
        assert!(suite.abstentions.is_empty(), "{suite:?}");
        compile_generated_java(source, &suite);
    }
}

#[test]
fn imported_return_only_reference_generates_compilable_java() {
    let source = "import java.net.URI; public class UriFactory { public URI make(int x) { if (x > 0) return URI.create(\"https://example.com\"); return URI.create(\"https://example.org\"); } }";
    let suite = synthesize_unit_tests_for_java(source, None, 50).unwrap();
    assert_eq!(suite.branches_synthesized.len(), 2);
    assert!(suite.abstentions.is_empty());
    compile_generated_java(source, &suite);
}

#[test]
fn unsupported_imported_parameter_abstains_explicitly() {
    assert_abstained("import java.net.URI; public class UriInput { public int calc(int x, URI uri) { if (x > 0) return 1; return 0; } }", "UNSUPPORTED_PARAMETER_TYPE");
}

#[test]
fn supported_imported_parameter_generates_compilable_java() {
    let source = "import java.math.BigDecimal; public class DecimalInput { public BigDecimal calc(int x, BigDecimal decimal) { if (x > 0) return BigDecimal.ONE; return BigDecimal.ZERO; } }";
    let suite = synthesize_unit_tests_for_java(source, None, 50).unwrap();
    assert_eq!(suite.branches_synthesized.len(), 2);
    compile_generated_java(source, &suite);
}

#[test]
fn private_method_abstains_instead_of_generating_inaccessible_invocation() {
    assert_abstained(
        "public class PrivateMethod { private int calc(int x) { if (x > 0) return 1; return 0; } }",
        "METHOD_ACCESS_UNSUPPORTED",
    );
}

#[test]
fn zero_branches_has_explicit_abstention() {
    assert_abstained(
        "public class NoBranches { public int calc(int x) { return x; } }",
        "NO_EXECUTABLE_BRANCHES",
    );
}

#[test]
fn unrelated_no_args_annotation_cannot_establish_construction() {
    assert_abstained("@interface NoArgsConstructor {} @NoArgsConstructor public class CustomNoArgs { public CustomNoArgs(String dependency) {} public int calc(int x) { if (x > 0) return 1; return 0; } }", "TARGET_CONSTRUCTION_UNSUPPORTED");
}

#[test]
fn test_parse_java_conditions() {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .unwrap();

    let source = r#"
public class TestCases {
    void test() {
        if (total > 100.0) {}
        if (age >= 18 && isVip) {}
        if ("SUMMER10".equals(promoCode)) {}
    }
}
"#;

    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let root = tree.root_node();

    // Query if_statement condition nodes
    let mut conditions = Vec::new();
    collect_if_conditions(root, source, &mut conditions);

    assert_eq!(conditions.len(), 3);

    // 1. total > 100.0
    let c1 = parse_java_condition(source, conditions[0]).expect("Condition 1 parse failed");
    assert!(format!("{:?}", c1).contains("Gt"));

    // 2. age >= 18 && isVip
    let c2 = parse_java_condition(source, conditions[1]).expect("Condition 2 parse failed");
    assert!(format!("{:?}", c2).contains("And"));

    // 3. "SUMMER10".equals(promoCode)
    let c3 = parse_java_condition(source, conditions[2]).expect("Condition 3 parse failed");
    assert!(format!("{:?}", c3).contains("StringEquals"));
}

fn collect_if_conditions<'a>(
    node: tree_sitter::Node<'a>,
    source: &str,
    out: &mut Vec<tree_sitter::Node<'a>>,
) {
    if node.kind() == "if_statement" {
        if let Some(cond) = node.child_by_field_name("condition") {
            out.push(cond);
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_if_conditions(child, source, out);
    }
}

#[test]
fn test_synthesize_unit_tests_branch_coverage() {
    let java_service = r#"package com.example.service;

public class DiscountService {
    public double calculateDiscount(double orderTotal, boolean isVip) {
        if (orderTotal > 100.0) {
            return orderTotal * 0.10;
        }
        return 0.0;
    }
}
"#;

    let suite =
        synthesize_unit_tests_for_java(java_service, None, 50).expect("Synthesis should succeed");

    assert_eq!(suite.class_name, "DiscountService");
    assert_eq!(suite.test_class_name, "DiscountServiceTest");
    assert_eq!(
        suite.branches_synthesized.len(),
        2,
        "Expected THEN and ELSE branches"
    );

    // THEN branch: orderTotal > 100.0
    let then_branch = suite
        .branches_synthesized
        .iter()
        .find(|b| b.branch_type == "THEN_BRANCH")
        .unwrap();
    assert!(then_branch.condition_expr.contains("orderTotal > 100.0"));
    if let Some(verifier::solver::ConcreteValue::Float(val)) = then_branch.inputs.get("orderTotal")
    {
        assert!(
            *val > 100.0 || (*val - 100.0).abs() < f64::EPSILON,
            "Expected input to satisfy branch condition: val={}",
            val
        );
    }

    // ELSE branch: !(orderTotal > 100.0)
    let else_branch = suite
        .branches_synthesized
        .iter()
        .find(|b| b.branch_type == "ELSE_BRANCH")
        .unwrap();
    assert!(else_branch.condition_expr.contains("!(orderTotal > 100.0)"));

    // Verifies generated test source actually invokes the method with parameters (no phantom test!)
    assert!(suite
        .test_source_code
        .contains("public class DiscountServiceTest"));
    assert!(suite.test_source_code.contains("@Test"));
    assert!(suite
        .test_source_code
        .contains("DiscountService service = new DiscountService();"));
    assert!(
        suite
            .test_source_code
            .contains("double result = service.calculateDiscount(orderTotal, isVip);"),
        "explicit result type keeps the generated Java compilable: {}",
        suite.test_source_code
    );
    assert!(suite
        .test_source_code
        .contains("assertEquals(result, result);"));
}

#[test]
fn test_synthesize_unit_tests_mock_depth_abstention() {
    let java_service = r#"package com.example.service;

public class OrderProcessor {
    public void process(int orderId) {
        if (orderId > 0) {
            // Violates Law of Demeter: 3 hops deep
            gateway.getAccount().getLedger().syncBalance();
        }
    }
}
"#;

    let suite =
        synthesize_unit_tests_for_java(java_service, None, 50).expect("Synthesis should execute");

    // Must strictly abstain with MOCK_BUDGET_EXCEEDED
    assert!(
        suite
            .abstentions
            .iter()
            .any(|a| a.code == "MOCK_BUDGET_EXCEEDED"),
        "Must abstain when mock depth exceeds 2 hops"
    );
}
