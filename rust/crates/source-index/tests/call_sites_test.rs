use source_index::call_sites::extract_java_call_sites;

#[test]
fn test_extract_java_primitive_call_site() {
    let source = r#"
package com.example.service;

public class OrderServiceTest {
    @Test
    void testPricing() {
        double result = service.calculateFinalPrice(200.0, true, "SUMMER10");
        assertEquals(160.0, result);
    }
}
"#;

    let calls = extract_java_call_sites("OrderServiceTest.java", source).unwrap();

    // Find calculateFinalPrice call
    let calc_call = calls
        .iter()
        .find(|c| c.method_name == "calculateFinalPrice")
        .expect("calculateFinalPrice call not found");

    assert_eq!(calc_call.receiver.as_deref(), Some("service"));
    assert_eq!(calc_call.line, 7);
    assert!(!calc_call.is_constructor);
    assert_eq!(calc_call.argument_spans.len(), 3);
    assert_eq!(
        calc_call.argument_texts,
        vec!["200.0", "true", "\"SUMMER10\""]
    );

    // Verify exact byte slice equivalence
    for (i, span) in calc_call.argument_spans.iter().enumerate() {
        assert_eq!(&source[span.start..span.end], calc_call.argument_texts[i]);
    }
}

#[test]
fn test_extract_java_nested_and_side_effect_call_site() {
    let source = r#"
public class TestNested {
    void run() {
        service.process(cart, computeDiscount(user));
    }
}
"#;

    let calls = extract_java_call_sites("TestNested.java", source).unwrap();

    let process_call = calls
        .iter()
        .find(|c| c.method_name == "process")
        .expect("process call not found");

    assert_eq!(process_call.argument_spans.len(), 2);
    assert_eq!(process_call.argument_texts[0], "cart");
    assert_eq!(process_call.argument_texts[1], "computeDiscount(user)");

    // Also verify that the nested call computeDiscount was extracted
    let nested_call = calls
        .iter()
        .find(|c| c.method_name == "computeDiscount")
        .expect("nested computeDiscount call not found");
    assert_eq!(nested_call.argument_texts, vec!["user"]);
}

#[test]
fn test_extract_java_constructor_call_site() {
    let source = r#"
public class TestConstructor {
    void run() {
        Order order = new Order(cart, 100);
    }
}
"#;

    let calls = extract_java_call_sites("TestConstructor.java", source).unwrap();

    let ctor_call = calls
        .iter()
        .find(|c| c.method_name == "Order" && c.is_constructor)
        .expect("Order constructor not found");

    assert!(ctor_call.is_constructor);
    assert_eq!(ctor_call.argument_spans.len(), 2);
    assert_eq!(ctor_call.argument_texts, vec!["cart", "100"]);
}

#[test]
fn test_extract_java_with_inline_comments() {
    let source = r#"
public class TestComment {
    void run() {
        service.apply(/* reason */ code, 42);
    }
}
"#;

    let calls = extract_java_call_sites("TestComment.java", source).unwrap();

    let apply_call = calls
        .iter()
        .find(|c| c.method_name == "apply")
        .expect("apply call not found");

    assert_eq!(apply_call.argument_spans.len(), 2);
    assert_eq!(apply_call.argument_texts[0], "code");
    assert_eq!(apply_call.argument_texts[1], "42");

    // The argument list span includes the comment
    let arg_list_text =
        &source[apply_call.argument_list_span.start..apply_call.argument_list_span.end];
    assert!(arg_list_text.contains("/* reason */"));
}

#[test]
fn test_extract_real_spring_sample_fixture() {
    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/spring-sample/src/main/java/com/example/sample/SampleController.java"
    );
    let source = std::fs::read_to_string(fixture_path)
        .expect("Failed to read SampleController.java fixture");

    let calls = extract_java_call_sites("SampleController.java", &source).unwrap();
    assert!(!calls.is_empty(), "Expected calls in SampleController.java");

    for call in &calls {
        assert!(call.invocation_span.start < call.invocation_span.end);
        assert!(call.argument_list_span.start <= call.argument_list_span.end);
        for span in &call.argument_spans {
            assert!(span.start < span.end);
            assert!(span.start >= call.argument_list_span.start);
            assert!(span.end <= call.argument_list_span.end);
        }
    }
}
