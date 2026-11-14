use tree_sitter::Parser;
use verifier::cfg::{build_java_cfg, Terminator};

fn find_first_method<'a>(root: tree_sitter::Node<'a>) -> tree_sitter::Node<'a> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "class_declaration" {
            if let Some(body) = child.child_by_field_name("body") {
                let mut b_cursor = body.walk();
                for m in body.children(&mut b_cursor) {
                    if m.kind() == "method_declaration" {
                        return m;
                    }
                }
            }
        }
    }
    panic!("No method declaration found in fixture");
}

#[test]
fn test_cfg_straight_line_code() {
    let source = r#"
class Demo {
    void process() {
        int x = 1;
        int y = 2;
        return x + y;
    }
}
"#;
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let m = find_first_method(tree.root_node());
    let cfg = build_java_cfg(source, m).expect("must build CFG");

    assert_eq!(cfg.method_name, "process");
    assert_eq!(cfg.blocks.len(), 1);
    let entry_block = &cfg.blocks[0];
    assert!(matches!(entry_block.terminator, Terminator::Return(Some(_))));
    assert_eq!(cfg.extract_branch_conditions().len(), 0);
}

#[test]
fn test_cfg_single_branch_if_else() {
    let source = r#"
class Demo {
    int check(int age) {
        if (age >= 18) {
            return 1;
        }
        return 0;
    }
}
"#;
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let m = find_first_method(tree.root_node());
    let cfg = build_java_cfg(source, m).expect("must build CFG");

    assert_eq!(cfg.method_name, "check");
    let branch_conds = cfg.extract_branch_conditions();
    assert_eq!(branch_conds.len(), 1);
    assert!(branch_conds[0].contains("age >= 18"));
}

#[test]
fn test_cfg_nested_and_chained_conditions() {
    let source = r#"
class Demo {
    String rank(int score) {
        if (score >= 90) {
            return "A";
        }
        if (score >= 80) {
            return "B";
        }
        return "C";
    }
}
"#;
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let m = find_first_method(tree.root_node());
    let cfg = build_java_cfg(source, m).expect("must build CFG");

    assert_eq!(cfg.method_name, "rank");
    let conds = cfg.extract_branch_conditions();
    assert_eq!(conds.len(), 2);
    assert!(conds[0].contains("score >= 90"));
    assert!(conds[1].contains("score >= 80"));
}

#[test]
fn test_cfg_empty_method_returns_valid_cfg() {
    let source = r#"
class Demo {
    void noop() {
    }
}
"#;
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let m = find_first_method(tree.root_node());
    let cfg = build_java_cfg(source, m).expect("must build CFG");

    assert_eq!(cfg.method_name, "noop");
    assert_eq!(cfg.blocks.len(), 1);
    assert!(matches!(cfg.blocks[0].terminator, Terminator::Return(None)));
}
