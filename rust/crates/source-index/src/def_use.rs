//! Bounded intraprocedural string folding for Java call sites.
//!
//! The folder answers one question: what finite set of literal strings can this
//! expression produce? It never invents a value. Anything it cannot enumerate —
//! a call, a loop-carried reassignment, a non-literal branch — is `Opaque`, and the
//! caller keeps its existing unresolved blocker.
//!
//! The fold is deliberately narrow: a variable is foldable only when it has exactly
//! one assignment site (its initializer or one assignment) in the method body.
//! Multiple assignment sites are not joined across control flow, because the value
//! at a specific call site would otherwise be wrong for code that runs before the
//! later assignment. Ternary initializers are joined, since their alternatives are
//! mutually exclusive at that single site.

use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use tree_sitter::Node;

const MAX_SET: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalValue {
    Literal(String),
    FiniteSet(BTreeSet<String>),
    Opaque,
}

#[derive(Default, Clone, Debug)]
pub struct LocalStrings {
    values: HashMap<String, LocalValue>,
}

impl LocalStrings {
    pub fn get(&self, name: &str) -> Option<&LocalValue> {
        self.values.get(name)
    }

    /// True when the name is bound in this method, even if its value is opaque.
    /// Callers must not fall back to a class constant for a shadowed local.
    pub fn contains(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }
}

/// Fold every single-assignment local string in one method body.
pub fn fold_locals(
    body: Node,
    content: &str,
    resolve_external: &dyn Fn(&str) -> Option<String>,
) -> LocalStrings {
    let mut sites: HashMap<String, Vec<Option<Node>>> = HashMap::new();
    collect_sites(body, content, &mut sites);
    let mut values = HashMap::new();
    for (name, assignments) in &sites {
        if assignments.len() != 1 {
            values.insert(name.clone(), LocalValue::Opaque);
            continue;
        }
        let Some(expression) = assignments[0] else {
            values.insert(name.clone(), LocalValue::Opaque);
            continue;
        };
        let mut stack = HashSet::new();
        let value = fold_site(expression, content, &sites, &mut stack, resolve_external);
        values.insert(name.clone(), value);
    }
    LocalStrings { values }
}

/// Evaluate an arbitrary expression against already-folded locals.
pub fn eval_expression(
    node: Node,
    content: &str,
    locals: &LocalStrings,
    resolve_external: &dyn Fn(&str) -> Option<String>,
) -> LocalValue {
    let mut resolver = |name: &str| locals.get(name).cloned();
    eval(node, content, &mut resolver, resolve_external)
}

fn collect_sites<'a>(
    node: Node<'a>,
    content: &str,
    sites: &mut HashMap<String, Vec<Option<Node<'a>>>>,
) {
    match node.kind() {
        "lambda_expression" | "class_declaration" | "interface_declaration" => return,
        "variable_declarator" => {
            let Some(name) = node.child_by_field_name("name") else {
                return;
            };
            if name.kind() != "identifier" {
                return;
            }
            let name = text(name, content).trim().to_string();
            let value = node.child_by_field_name("value");
            sites.entry(name).or_default().push(value);
        }
        "assignment_expression" => {
            let Some(left) = node.child_by_field_name("left") else {
                return;
            };
            if left.kind() != "identifier" {
                return;
            }
            let Some(right) = node.child_by_field_name("right") else {
                return;
            };
            let name = text(left, content).trim().to_string();
            sites.entry(name).or_default().push(Some(right));
        }
        _ => {}
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            collect_sites(child, content, sites);
        }
    }
}

fn fold_site(
    expression: Node,
    content: &str,
    sites: &HashMap<String, Vec<Option<Node>>>,
    stack: &mut HashSet<String>,
    resolve_external: &dyn Fn(&str) -> Option<String>,
) -> LocalValue {
    let mut resolver = |name: &str| {
        let Some(assignments) = sites.get(name) else {
            return None;
        };
        if assignments.len() != 1 {
            return Some(LocalValue::Opaque);
        }
        let Some(value) = assignments[0] else {
            return Some(LocalValue::Opaque);
        };
        if !stack.insert(name.to_string()) {
            return Some(LocalValue::Opaque);
        }
        let folded = fold_site(value, content, sites, stack, resolve_external);
        stack.remove(name);
        Some(folded)
    };
    eval(expression, content, &mut resolver, resolve_external)
}

fn eval(
    node: Node,
    content: &str,
    local: &mut dyn FnMut(&str) -> Option<LocalValue>,
    resolve_external: &dyn Fn(&str) -> Option<String>,
) -> LocalValue {
    match node.kind() {
        "string_literal" => match java_string_value(text(node, content)) {
            Some(value) => LocalValue::Literal(value),
            None => LocalValue::Opaque,
        },
        "parenthesized_expression" => match node.named_child(0) {
            Some(inner) => eval(inner, content, local, resolve_external),
            None => LocalValue::Opaque,
        },
        "identifier" => {
            let name = text(node, content).trim();
            match local(name) {
                Some(value) => value,
                None => resolve_external(name)
                    .map(LocalValue::Literal)
                    .unwrap_or(LocalValue::Opaque),
            }
        }
        "field_access" => {
            let name = text(node, content).trim();
            resolve_external(name)
                .map(LocalValue::Literal)
                .unwrap_or(LocalValue::Opaque)
        }
        "binary_expression" => {
            let operator = node
                .child_by_field_name("operator")
                .map(|operator| text(operator, content).trim())
                .unwrap_or_default();
            if operator != "+" {
                return LocalValue::Opaque;
            }
            let (Some(left), Some(right)) = (
                node.child_by_field_name("left"),
                node.child_by_field_name("right"),
            ) else {
                return LocalValue::Opaque;
            };
            concat(
                eval(left, content, local, resolve_external),
                eval(right, content, local, resolve_external),
            )
        }
        "ternary_expression" => {
            let (Some(consequence), Some(alternative)) = (
                node.child_by_field_name("consequence"),
                node.child_by_field_name("alternative"),
            ) else {
                return LocalValue::Opaque;
            };
            join(
                eval(consequence, content, local, resolve_external),
                eval(alternative, content, local, resolve_external),
            )
        }
        "method_invocation" => {
            // URI.create(<literal>) is the one string-producing call the extractor
            // already trusts for URL arguments.
            let name = node
                .child_by_field_name("name")
                .map(|name| text(name, content).trim())
                .unwrap_or("");
            if name != "create" {
                return LocalValue::Opaque;
            }
            let Some(first) = node
                .child_by_field_name("arguments")
                .and_then(|arguments| arguments.named_child(0))
            else {
                return LocalValue::Opaque;
            };
            eval(first, content, local, resolve_external)
        }
        _ => LocalValue::Opaque,
    }
}

fn concat(left: LocalValue, right: LocalValue) -> LocalValue {
    match (left, right) {
        (LocalValue::Literal(left), LocalValue::Literal(right)) => {
            LocalValue::Literal(format!("{left}{right}"))
        }
        (LocalValue::Opaque, _) | (_, LocalValue::Opaque) => LocalValue::Opaque,
        (left, right) => {
            let left = into_set(left);
            let right = into_set(right);
            let mut out = BTreeSet::new();
            for a in &left {
                for b in &right {
                    if out.len() >= MAX_SET {
                        return LocalValue::Opaque;
                    }
                    out.insert(format!("{a}{b}"));
                }
            }
            set_value(out)
        }
    }
}

fn join(left: LocalValue, right: LocalValue) -> LocalValue {
    match (left, right) {
        (LocalValue::Opaque, _) | (_, LocalValue::Opaque) => LocalValue::Opaque,
        (left, right) => {
            let mut out = into_set(left);
            out.extend(into_set(right));
            set_value(out)
        }
    }
}

fn into_set(value: LocalValue) -> BTreeSet<String> {
    match value {
        LocalValue::Literal(value) => BTreeSet::from([value]),
        LocalValue::FiniteSet(values) => values,
        LocalValue::Opaque => BTreeSet::new(),
    }
}

fn set_value(values: BTreeSet<String>) -> LocalValue {
    if values.is_empty() || values.len() > MAX_SET {
        LocalValue::Opaque
    } else if values.len() == 1 {
        LocalValue::Literal(values.into_iter().next().unwrap())
    } else {
        LocalValue::FiniteSet(values)
    }
}

fn java_string_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('"') || !trimmed.ends_with('"') || trimmed.len() < 2 {
        return None;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::String(value)) => Some(value),
        _ => Some(trimmed[1..trimmed.len() - 1].to_string()),
    }
}

fn text<'a>(node: Node<'a>, content: &'a str) -> &'a str {
    &content[node.start_byte()..node.end_byte()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::{Node, Parser};

    fn body_of(source: &str) -> (tree_sitter::Tree, usize) {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_java::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(source, None).unwrap();
        (tree, source.find('{').unwrap())
    }

    fn find_body<'a>(node: Node<'a>) -> Option<Node<'a>> {
        if node.kind() == "method_declaration" {
            return node.child_by_field_name("body");
        }
        for index in 0..node.named_child_count() {
            if let Some(found) = find_body(node.named_child(index as u32)?) {
                return Some(found);
            }
        }
        None
    }

    fn fold(source: &str) -> LocalStrings {
        let (tree, _) = body_of(source);
        let body = find_body(tree.root_node()).expect("method body");
        fold_locals(body, source, &|name| {
            (name == "BASE").then(|| "/api".to_string())
        })
    }

    const WRAPPER: &str = "class C { void run() { ";
    const WRAPPER_END: &str = " } }";

    #[test]
    fn literal_and_constant_concatenation_fold() {
        let source = format!(
            "{WRAPPER}String a = \"/x\"; String b = BASE + a; String c = \"/y\" + a;{WRAPPER_END}"
        );
        let locals = fold(&source);
        assert_eq!(
            locals.get("b"),
            Some(&LocalValue::Literal("/api/x".to_string()))
        );
        assert_eq!(
            locals.get("c"),
            Some(&LocalValue::Literal("/y/x".to_string()))
        );
    }

    #[test]
    fn ternary_and_uri_create_fold() {
        let source = format!(
            "{WRAPPER}boolean v2 = true; String base = v2 ? \"/v1\" : \"/v2\"; String u = URI.create(base + \"/users\");{WRAPPER_END}"
        );
        let locals = fold(&source);
        match locals.get("base") {
            Some(LocalValue::FiniteSet(values)) => {
                assert_eq!(
                    values,
                    &BTreeSet::from(["/v1".to_string(), "/v2".to_string()])
                );
            }
            other => panic!("base {other:?}"),
        }
        match locals.get("u") {
            Some(LocalValue::FiniteSet(values)) => {
                assert_eq!(
                    values,
                    &BTreeSet::from(["/v1/users".to_string(), "/v2/users".to_string()])
                );
            }
            other => panic!("u {other:?}"),
        }
    }

    #[test]
    fn reassignment_shadows_and_stays_opaque() {
        let source = format!(
            "{WRAPPER}String url = \"/a\"; url = \"/b\"; String BASE = \"/local\";{WRAPPER_END}"
        );
        let locals = fold(&source);
        assert_eq!(locals.get("url"), Some(&LocalValue::Opaque));
        assert_eq!(
            locals.get("BASE"),
            Some(&LocalValue::Literal("/local".to_string()))
        );
    }

    #[test]
    fn calls_and_loops_do_not_invent_values() {
        let source = format!(
            "{WRAPPER}String url = build(); String loop; for (int i = 0; i < 1; i++) {{ loop = \"/x\"; }}{WRAPPER_END}"
        );
        let locals = fold(&source);
        assert_eq!(locals.get("url"), Some(&LocalValue::Opaque));
        assert_eq!(locals.get("loop"), Some(&LocalValue::Opaque));
    }
}
