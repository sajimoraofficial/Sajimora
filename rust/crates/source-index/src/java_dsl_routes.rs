//! java_dsl_routes.rs — Spring WebFlux functional `RouterFunctions` and Helidon SE
//! `Routing.builder()` route chains.
//!
//! These frameworks register routes through fluent calls, not annotations. Only literal
//! paths and literal verbs are published; nested/prefix registration is reported as a
//! named blocker rather than guessed.

use contract_core::envelope::ArtifactBlocker;
use std::collections::HashSet;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaDslRoute {
    pub file: String,
    pub line: u32,
    pub http_method: String,
    pub path: String,
}

#[derive(Debug, Default)]
pub struct DslRouteExtraction {
    pub routes: Vec<JavaDslRoute>,
    pub blockers: Vec<ArtifactBlocker>,
    pub webflux_functional: bool,
    pub helidon: bool,
}

const UPPER_VERBS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const LOWER_VERBS: &[&str] = &["get", "post", "put", "delete", "patch", "head", "options"];

pub fn extract_dsl_routes(file: &str, content: &str) -> DslRouteExtraction {
    let mut out = DslRouteExtraction::default();
    let static_router = content.contains(
        "import static org.springframework.web.reactive.function.server.RouterFunctions.",
    );
    let webflux = content.contains("RouterFunctions") || static_router;
    let helidon = content.contains("Routing.builder");
    out.webflux_functional = webflux;
    out.helidon = helidon;
    if !webflux && !helidon {
        return out;
    }
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .is_err()
    {
        return out;
    }
    let Some(tree) = parser.parse(content, None) else {
        return out;
    };
    let helidon_static = content.contains("import static io.helidon.webserver.Routing.builder")
        || content.contains("import static io.helidon.webserver.http.HttpRouting.builder");
    let (mut webflux_vars, mut helidon_vars) = (HashSet::new(), HashSet::new());
    walk(tree.root_node(), &mut |node| {
        let (name, value) = match node.kind() {
            "variable_declarator" => (
                node.child_by_field_name("name"),
                node.child_by_field_name("value"),
            ),
            "assignment_expression" => (
                node.child_by_field_name("left"),
                node.child_by_field_name("right"),
            ),
            _ => (None, None),
        };
        let (Some(name), Some(value)) = (name, value) else {
            return;
        };
        if name.kind() != "identifier" {
            return;
        }
        let name = text(name, content).trim().to_string();
        let value_text = text(value, content);
        let compact: String = value_text
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();
        if compact.contains("RouterFunctions.route") || (static_router && compact == "route()") {
            webflux_vars.insert(name);
        } else if compact.contains("Routing.builder") || (helidon_static && compact == "builder()")
        {
            helidon_vars.insert(name);
        }
    });
    walk(tree.root_node(), &mut |node| {
        if node.kind() != "method_invocation" {
            return;
        }
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = text(name_node, content).trim();
        let object_text = node
            .child_by_field_name("object")
            .map(|object| text(object, content))
            .unwrap_or("");

        // WebFlux static form: RouterFunctions.route(RequestPredicates.GET("/x"), handler)
        // or, with a static import, route(RequestPredicates.GET("/x"), handler).
        let static_route_call = object_text.trim().ends_with("RouterFunctions")
            || (static_router && object_text.trim().is_empty());
        if name == "route" && static_route_call {
            if let Some(arguments) = node.child_by_field_name("arguments") {
                let mut cursor = arguments.walk();
                let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
                if let Some(predicate) = children.first().copied() {
                    if predicate.kind() == "method_invocation" {
                        if let Some(verb_node) = predicate.child_by_field_name("name") {
                            let verb = text(verb_node, content).trim();
                            if UPPER_VERBS.contains(&verb) {
                                if let Some(arguments) = predicate.child_by_field_name("arguments")
                                {
                                    let mut arg_cursor = arguments.walk();
                                    let path_nodes: Vec<Node> =
                                        arguments.named_children(&mut arg_cursor).collect();
                                    if let Some(path_node) = path_nodes.first().copied() {
                                        if let Some(path) = string_literal(path_node, content) {
                                            push_functional_route(
                                                &mut out, file, node, content, verb, &path,
                                            );
                                        } else {
                                            out.blockers.push(blocker(
                                                file,
                                                "JAVA_FUNCTIONAL_ROUTE_PATH_UNRESOLVED",
                                                "RouterFunctions route predicate has a non-literal path",
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fluent builder form: RouterFunctions.route().GET("/x", h) / Routing.builder().get("/x", h).
        // A builder held in a local variable (`Routing.Builder b = Routing.builder()`) is
        // recognized after its declaring file has been scanned for builder roots.
        let compact_object: String = object_text
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();
        let on_var = |vars: &HashSet<String>| {
            vars.iter()
                .any(|var| compact_object == *var || compact_object.starts_with(&format!("{var}.")))
        };
        let is_webflux_builder = object_text.contains("RouterFunctions.route")
            || (static_router && object_text.trim().ends_with("route()"))
            || on_var(&webflux_vars);
        let is_helidon_builder = object_text.contains("Routing.builder")
            || (helidon_static && compact_object.ends_with("builder()"))
            || on_var(&helidon_vars);
        if !is_webflux_builder && !is_helidon_builder {
            return;
        }
        let (verb, is_verb) = if is_webflux_builder {
            (name, UPPER_VERBS.contains(&name))
        } else {
            (name, LOWER_VERBS.contains(&name))
        };
        if !is_verb {
            return;
        }
        let Some(arguments) = node.child_by_field_name("arguments") else {
            return;
        };
        let mut cursor = arguments.walk();
        let Some(path_node) = arguments.named_children(&mut cursor).next() else {
            return;
        };
        match string_literal(path_node, content) {
            Some(path) => push_functional_route(
                &mut out,
                file,
                node,
                content,
                &verb.to_ascii_uppercase(),
                &path,
            ),
            None => out.blockers.push(blocker(
                file,
                "JAVA_FUNCTIONAL_ROUTE_PATH_UNRESOLVED",
                &format!("{verb}(...) route has a non-literal path"),
            )),
        }
    });

    if webflux && (content.contains(".nest(") || (static_router && content.contains("nest("))) {
        out.blockers.push(blocker(
            file,
            "JAVA_FUNCTIONAL_ROUTE_NEST_UNPARSED",
            "RouterFunctions .nest(...) prefixes are not composed; nested routes are absent from this artifact",
        ));
    }
    if helidon && (content.contains(".register(") || content.contains(".routing(")) {
        out.blockers.push(blocker(
            file,
            "JAVA_HELIDON_ROUTE_REGISTER_UNPARSED",
            "Helidon .register(...) route groups are not composed; grouped routes may be absent",
        ));
    }
    if out.routes.is_empty() {
        if webflux {
            out.blockers.push(blocker(
                file,
                "JAVA_WEBFLUX_FUNCTIONAL_UNPARSED",
                "RouterFunctions is present but no literal functional route was recognized",
            ));
        }
        if helidon {
            out.blockers.push(blocker(
                file,
                "JAVA_HELIDON_ROUTES_UNPARSED",
                "Routing.builder() is present but no literal route was recognized",
            ));
        }
    }
    out.routes.sort_by(|a, b| {
        (a.path.as_str(), a.http_method.as_str(), a.line).cmp(&(
            b.path.as_str(),
            b.http_method.as_str(),
            b.line,
        ))
    });
    out.routes.dedup();
    out.blockers
        .sort_by(|a, b| (&a.code, &a.message).cmp(&(&b.code, &b.message)));
    out.blockers
        .dedup_by(|a, b| a.code == b.code && a.message == b.message);
    out
}

fn node_within<'a>(ancestor: Node<'a>, mut node: Node<'a>) -> bool {
    loop {
        if node.id() == ancestor.id() {
            return true;
        }
        match node.parent() {
            Some(parent) => node = parent,
            None => return false,
        }
    }
}

struct FunctionalScope {
    prefixes: Vec<String>,
    blocked: bool,
}

/// `.path("/prefix", () -> route()...)` prefixes a nested router, and `nest(...)`
/// constrains one. Both are composed for literal prefixes; anything else blocks the
/// route instead of publishing it without its prefix.
fn functional_scope(node: Node, content: &str) -> FunctionalScope {
    let mut prefixes = Vec::new();
    let mut blocked = false;
    let mut current = node;
    for _ in 0..32 {
        let Some(parent) = current.parent() else {
            break;
        };
        if parent.kind() != "method_invocation" {
            current = parent;
            continue;
        }
        let name = parent
            .child_by_field_name("name")
            .map(|name| text(name, content).trim())
            .unwrap_or("");
        // A `path`/`nest` prefix applies only to routes inside its nested-router
        // argument, not to calls that merely precede it in the same chain.
        let nested_argument = parent
            .child_by_field_name("arguments")
            .and_then(|arguments| arguments.named_child(1));
        let node_is_nested = nested_argument
            .map(|argument| node_within(argument, node))
            .unwrap_or(false);
        // `.path` on a builder lambda (`builder -> builder.path(...)`) still
        // contributes its literal prefix; the nested argument proves the call.
        if name == "path" && node_is_nested {
            let first = parent
                .child_by_field_name("arguments")
                .and_then(|arguments| arguments.named_child(0));
            match first.and_then(|node| string_literal(node, content)) {
                Some(path) => prefixes.push(path),
                None => blocked = true,
            }
        }
        // `nest`/`andNest` carry a path and/or method predicate that is not
        // composed; publishing their inner routes without it would fabricate a
        // route, so they stay blocked.
        if matches!(name, "nest" | "andNest") {
            blocked = true;
        }
        current = parent;
    }
    prefixes.reverse();
    FunctionalScope { prefixes, blocked }
}

fn prefix_functional_route(scope: &FunctionalScope, path: &str) -> String {
    let mut full = path.trim().to_string();
    for prefix in scope.prefixes.iter().rev() {
        full = format!(
            "{}/{}",
            prefix.trim_end_matches('/'),
            full.trim_start_matches('/')
        );
    }
    full
}

fn push_functional_route(
    out: &mut DslRouteExtraction,
    file: &str,
    node: Node,
    content: &str,
    http_method: &str,
    path: &str,
) {
    let scope = functional_scope(node, content);
    if scope.blocked {
        out.blockers.push(blocker(
            file,
            "JAVA_FUNCTIONAL_ROUTE_PATH_UNRESOLVED",
            "route under a .path(...)/nest(...) prefix that is not composed; the route is absent from this artifact",
        ));
        return;
    }
    let path = prefix_functional_route(&scope, path);
    out.routes.push(JavaDslRoute {
        file: file.to_string(),
        line: line_of(node),
        http_method: http_method.to_string(),
        path,
    });
}

/// A `register("/prefix", service)` target in a Helidon SE routing builder.
pub struct HelidonRegistration {
    pub prefix: String,
    pub service: String,
}

/// A Helidon `Service` implementation and the routes its `update`/`routing`
/// method registers on the builder it receives.
pub struct HelidonServiceRoutes {
    pub class_name: String,
    pub routes: Vec<(String, String, u32)>,
}

/// Registrations in one file: literal `register("/prefix", serviceVar)` pairs, and
/// whether a grouped registration (health/metrics or a non-literal target) exists.
pub fn extract_helidon_registrations(content: &str) -> (Vec<HelidonRegistration>, bool) {
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .is_err()
    {
        return (Vec::new(), false);
    }
    let Some(tree) = parser.parse(content, None) else {
        return (Vec::new(), false);
    };
    let root = tree.root_node();
    let mut variable_types: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    walk(root, &mut |node| {
        if node.kind() != "variable_declarator" {
            return;
        }
        let (Some(name), Some(value)) = (
            node.child_by_field_name("name"),
            node.child_by_field_name("value"),
        ) else {
            return;
        };
        if value.kind() != "object_creation_expression" {
            return;
        }
        let Some(type_node) = value.child_by_field_name("type") else {
            return;
        };
        let simple = text(type_node, content)
            .trim()
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_string();
        if !simple.is_empty() {
            variable_types.insert(text(name, content).trim().to_string(), simple);
        }
    });
    let mut registrations = Vec::new();
    let mut unresolved = false;
    walk(root, &mut |node| {
        if node.kind() != "method_invocation" {
            return;
        }
        let name = node
            .child_by_field_name("name")
            .map(|name| text(name, content).trim())
            .unwrap_or("");
        if name != "register" {
            return;
        }
        let Some(arguments) = node.child_by_field_name("arguments") else {
            unresolved = true;
            return;
        };
        let mut cursor = arguments.walk();
        let args: Vec<Node> = arguments.named_children(&mut cursor).collect();
        if args.len() != 2 || args[0].kind() != "string_literal" {
            // `register(health)` / `register(service)` groups carry no literal prefix.
            unresolved = true;
            return;
        }
        let prefix = string_literal(args[0], content).unwrap_or_default();
        let service = if args[1].kind() == "identifier" {
            variable_types.get(text(args[1], content).trim()).cloned()
        } else if args[1].kind() == "object_creation_expression" {
            args[1].child_by_field_name("type").map(|node| {
                text(node, content)
                    .trim()
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
        } else {
            None
        };
        match service {
            Some(service) if !service.is_empty() => {
                registrations.push(HelidonRegistration { prefix, service })
            }
            _ => unresolved = true,
        }
    });
    (registrations, unresolved)
}

/// A class implementing Helidon's `Service` interface: routes registered on the
/// `Routing.Rules` / `Routing.Builder` (or Helidon 4 `HttpRouting.Builder`) it gets.
pub fn extract_helidon_service(content: &str) -> Option<HelidonServiceRoutes> {
    if !(content.contains("io.helidon.webserver.Service")
        || content.contains("implements Service")
        || content.contains("Routing.Rules"))
    {
        return None;
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(content, None)?;
    let root = tree.root_node();
    let mut class_name = None;
    let mut routes = Vec::new();
    walk(root, &mut |node| {
        if node.kind() != "class_declaration" {
            return;
        }
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let implements_service = node
            .child_by_field_name("interfaces")
            .map(|interfaces| text(interfaces, content).contains("Service"))
            .unwrap_or(false)
            || content.contains("implements Service");
        if !implements_service {
            return;
        }
        class_name = Some(text(name, content).trim().to_string());
        let Some(class_body) = node.child_by_field_name("body") else {
            return;
        };
        let mut cursor = class_body.walk();
        for child in class_body.children(&mut cursor) {
            if child.kind() != "method_declaration" {
                continue;
            }
            let method_name = child
                .child_by_field_name("name")
                .map(|name| text(name, content).trim())
                .unwrap_or("");
            if !matches!(method_name, "update" | "routing" | "setup") {
                continue;
            }
            let Some(parameters) = child.child_by_field_name("parameters") else {
                continue;
            };
            let mut param_cursor = parameters.walk();
            let Some(parameter) = parameters.named_children(&mut param_cursor).next() else {
                continue;
            };
            let parameter_type = parameter
                .child_by_field_name("type")
                .map(|node| text(node, content).trim())
                .unwrap_or("");
            if !parameter_type.contains("Routing.Rules")
                && !parameter_type.contains("Routing.Builder")
                && !parameter_type.contains("HttpRouting.Builder")
            {
                continue;
            }
            let Some(builder_name) = parameter
                .child_by_field_name("name")
                .map(|name| text(name, content).trim().to_string())
            else {
                continue;
            };
            let Some(body) = child.child_by_field_name("body") else {
                continue;
            };
            walk(body, &mut |call| {
                if call.kind() != "method_invocation" {
                    return;
                }
                let verb = call
                    .child_by_field_name("name")
                    .map(|name| text(name, content).trim())
                    .unwrap_or("");
                if !LOWER_VERBS.contains(&verb) {
                    return;
                }
                let object = call
                    .child_by_field_name("object")
                    .map(|object| {
                        text(object, content)
                            .chars()
                            .filter(|ch| !ch.is_whitespace())
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                // The chain may put the dot on the next line; compare without
                // whitespace so a newline before `.get` still chains from the
                // builder variable.
                if object != builder_name && !object.starts_with(&format!("{builder_name}.")) {
                    return;
                }
                let Some(path_node) = call
                    .child_by_field_name("arguments")
                    .and_then(|arguments| arguments.named_child(0))
                else {
                    return;
                };
                if let Some(path) = string_literal(path_node, content) {
                    routes.push((verb.to_ascii_uppercase(), path, line_of(call)));
                }
            });
        }
    });
    class_name.map(|class_name| HelidonServiceRoutes { class_name, routes })
}

/// Helidon 4's server API (`WebServer.builder().routing(...)`,
/// `HttpRouting.builder()`); the reader does not compose it and must say so.
pub fn uses_helidon4_routing(content: &str) -> bool {
    content.contains("HttpRouting")
}

fn string_literal(node: Node, content: &str) -> Option<String> {
    if node.kind() != "string_literal" {
        return None;
    }
    serde_json::from_str(&text(node, content)).ok()
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

fn text<'a>(node: Node<'a>, content: &'a str) -> &'a str {
    &content[node.start_byte()..node.end_byte()]
}

fn blocker(file: &str, code: &str, message: &str) -> ArtifactBlocker {
    ArtifactBlocker {
        code: code.to_string(),
        message: message.to_string(),
        file: Some(file.to_string()),
    }
}

fn walk<F: FnMut(Node)>(node: Node, visit: &mut F) {
    visit(node);
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index as u32) {
            walk(child, visit);
        }
    }
}
