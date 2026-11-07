use source_index::signature_diff::{
    diff_signatures, extract_java_method_signatures, infer_default_value, MethodSignatureFact,
    ParamDef, SignatureDiffOp,
};

#[test]
fn test_infer_default_value() {
    assert_eq!(infer_default_value("boolean").as_deref(), Some("false"));
    assert_eq!(infer_default_value("int").as_deref(), Some("0"));
    assert_eq!(infer_default_value("long").as_deref(), Some("0L"));
    assert_eq!(infer_default_value("double").as_deref(), Some("0.0d"));
    assert_eq!(infer_default_value("String").as_deref(), Some("\"\""));
    assert_eq!(
        infer_default_value("Optional<User>").as_deref(),
        Some("java.util.Optional.empty()")
    );
    assert_eq!(
        infer_default_value("List<String>").as_deref(),
        Some("java.util.Collections.emptyList()")
    );

    // Complex domain object must return None per P1-A
    assert_eq!(infer_default_value("com.example.UserAccount"), None);
    assert_eq!(infer_default_value("CustomBuilder"), None);
}

#[test]
fn test_diff_signatures_add_param() {
    let old_sig = MethodSignatureFact {
        method_name: "getUser".to_string(),
        class_name: Some("UserService".to_string()),
        return_type: "User".to_string(),
        params: vec![ParamDef {
            name: "id".to_string(),
            type_name: "String".to_string(),
            annotations: vec![],
            default_value: None,
        }],
        annotations: vec![],
        is_static: false,
    };

    let new_sig = MethodSignatureFact {
        method_name: "getUser".to_string(),
        class_name: Some("UserService".to_string()),
        return_type: "User".to_string(),
        params: vec![
            ParamDef {
                name: "id".to_string(),
                type_name: "String".to_string(),
                annotations: vec![],
                default_value: None,
            },
            ParamDef {
                name: "includeDetails".to_string(),
                type_name: "boolean".to_string(),
                annotations: vec![],
                default_value: None,
            },
        ],
        annotations: vec![],
        is_static: false,
    };

    let diff = diff_signatures(&old_sig, &new_sig);
    assert_eq!(diff.len(), 1);
    match &diff[0] {
        SignatureDiffOp::AddParam {
            index,
            name,
            type_name,
            inferred_default,
        } => {
            assert_eq!(*index, 1);
            assert_eq!(name, "includeDetails");
            assert_eq!(type_name, "boolean");
            assert_eq!(inferred_default.as_deref(), Some("false"));
        }
        _ => panic!("Expected AddParam"),
    }
}

#[test]
fn test_diff_signatures_reorder() {
    let old_sig = MethodSignatureFact {
        method_name: "transfer".to_string(),
        class_name: None,
        return_type: "void".to_string(),
        params: vec![
            ParamDef {
                name: "from".to_string(),
                type_name: "String".to_string(),
                annotations: vec![],
                default_value: None,
            },
            ParamDef {
                name: "to".to_string(),
                type_name: "String".to_string(),
                annotations: vec![],
                default_value: None,
            },
        ],
        annotations: vec![],
        is_static: false,
    };

    let new_sig = MethodSignatureFact {
        method_name: "transfer".to_string(),
        class_name: None,
        return_type: "void".to_string(),
        params: vec![
            ParamDef {
                name: "to".to_string(),
                type_name: "String".to_string(),
                annotations: vec![],
                default_value: None,
            },
            ParamDef {
                name: "from".to_string(),
                type_name: "String".to_string(),
                annotations: vec![],
                default_value: None,
            },
        ],
        annotations: vec![],
        is_static: false,
    };

    let diff = diff_signatures(&old_sig, &new_sig);
    assert_eq!(diff.len(), 1);
    match &diff[0] {
        SignatureDiffOp::ReorderParams { old_indices } => {
            assert_eq!(old_indices, &[1, 0]);
        }
        _ => panic!("Expected ReorderParams"),
    }
}

#[test]
fn test_extract_java_method_signatures() {
    let source = r#"
package com.example;

public class OrderController {
    public OrderResponse createOrder(@Valid OrderRequest req, boolean notify) {
        return null;
    }

    public OrderController(OrderService svc) {
    }
}
"#;

    let sigs = extract_java_method_signatures(source).expect("Extraction failed");
    assert_eq!(sigs.len(), 2);

    let create_order = sigs
        .iter()
        .find(|s| s.method_name == "createOrder")
        .unwrap();
    assert_eq!(create_order.return_type, "OrderResponse");
    assert_eq!(create_order.params.len(), 2);
    assert_eq!(create_order.params[0].name, "req");
    assert_eq!(create_order.params[0].type_name, "OrderRequest");
    assert!(create_order.params[0]
        .annotations
        .contains(&"@Valid".to_string()));
    assert_eq!(create_order.params[1].name, "notify");
    assert_eq!(create_order.params[1].type_name, "boolean");

    let ctor = sigs
        .iter()
        .find(|s| s.method_name == "OrderController")
        .unwrap();
    assert_eq!(ctor.params.len(), 1);
    assert_eq!(ctor.params[0].name, "svc");
}
