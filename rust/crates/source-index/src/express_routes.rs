//! express_routes.rs — Express & Fastify (TypeScript / JavaScript) provider contract extraction.
//!
//! Express and Fastify register routes via imperative calls:
//! - `app.get('/api/users/:id', handler)`
//! - `router.post('/api/users', handler)`
//! - `fastify.get('/api/items', handler)`
//! - `app.use('/api', subRouter)` (mount prefix chaining)
//!
//! Route paths use `:param` dynamic segments which are mapped to path parameters.
//! Handlers with typed request/response shapes (e.g. `req: Request<Params, ResBody, ReqBody>`)
//! or local DTO interfaces are resolved and added to `type_pool`.

use crate::ts_shape::{contains_unknown, response_shape_wire, ShapeContext};
use anyhow::{anyhow, Result};
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ContractDirection, EndpointContract, EndpointIdentityContract, EvidenceClassification,
    ObjectWireType, ParamContract, PrimitiveScalar, PrimitiveWireType, RefWireType, SourceLanguage,
    SourceProvenance, StatusCodeFamily, WirePropertyContract, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use contract_core::routes::normalize_route_segments;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

const DIRS_TO_SKIP: &[&str] = &["node_modules", "dist", "build", "coverage", ".git", ".next"];

const EXPRESS_VERBS: &[(&str, &str)] = &[
    ("get", "GET"),
    ("post", "POST"),
    ("put", "PUT"),
    ("delete", "DELETE"),
    ("patch", "PATCH"),
    ("head", "HEAD"),
    ("options", "OPTIONS"),
    ("all", "ALL"),
];

#[derive(Debug, Clone)]
struct ExpressRouteCall {
    verb: String,
    path: String,
    line: u32,
    req_type: Option<String>,
    res_type: Option<String>,
    response_shape: Option<WireType>,
    status: Option<u16>,
}

#[derive(Debug, Clone)]
struct ExpressFileFacts {
    file: String,
    routes: Vec<ExpressRouteCall>,
    declared_types: Vec<(String, WireType)>,
    blockers: Vec<ArtifactBlocker>,
}

pub struct ExpressRouteExtractor {
    sources: Vec<(String, String)>,
    source_hashes: BTreeMap<String, String>,
    file_facts: Vec<ExpressFileFacts>,
    /// Hono/Koa/Hapi/Restify/Polka/Elysia share this router-DSL reader; the profile
    /// records which framework the module actually imports.
    framework_profile: &'static str,
}

fn detect_node_framework(sources: &[(String, String)]) -> &'static str {
    let combined = sources
        .iter()
        .map(|(_, content)| content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let has = |needle: &str| {
        combined.contains(&format!("\"{needle}\"")) || combined.contains(&format!("'{needle}'"))
    };
    if has("hono") {
        "HONO"
    } else if has("@koa/router") || has("koa-router") || has("koa") {
        "KOA"
    } else if has("@hapi/hapi") || has("hapi") {
        "HAPI"
    } else if has("restify") {
        "RESTIFY"
    } else if has("polka") {
        "POLKA"
    } else if has("elysia") {
        "ELYSIA"
    } else if combined.contains("Bun.serve(") && !has("express") && !has("fastify") {
        "BUN"
    } else if has("express") || has("fastify") {
        // A Node service may contain one Workers-compatible file (a deploy adapter);
        // an explicit Express/Fastify import still describes the router this lane reads.
        "EXPRESS"
    } else if is_workers_source(&combined) {
        "CLOUDFLARE_WORKERS"
    } else {
        "EXPRESS"
    }
}

pub fn is_express_source_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.split('/').any(|p| DIRS_TO_SKIP.contains(&p)) {
        return false;
    }
    (normalized.ends_with(".ts")
        || normalized.ends_with(".tsx")
        || normalized.ends_with(".js")
        || normalized.ends_with(".jsx")
        || normalized.ends_with(".mts")
        || normalized.ends_with(".cts")
        || normalized.ends_with(".mjs")
        || normalized.ends_with(".cjs"))
        && !normalized.ends_with(".d.ts")
        && !normalized.ends_with(".d.mts")
        && !normalized.ends_with(".d.cts")
        && ![
            ".test.ts",
            ".spec.ts",
            ".test.tsx",
            ".spec.tsx",
            ".test.js",
            ".spec.js",
            ".test.jsx",
            ".spec.jsx",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

pub fn looks_like_express_root(root: &Path) -> bool {
    // Check package.json for express or fastify dependency
    const PACKAGES: &[&str] = &[
        "\"express\"",
        "\"fastify\"",
        "\"hono\"",
        "\"koa\"",
        "\"@koa/router\"",
        "\"koa-router\"",
        "\"@hapi/hapi\"",
        "\"hapi\"",
        "\"restify\"",
        "\"polka\"",
        "\"elysia\"",
    ];
    let pkg_path = root.join("package.json");
    if let Ok(content) = fs::read_to_string(&pkg_path) {
        if PACKAGES.iter().any(|package| content.contains(package)) {
            return true;
        }
    }
    // Scan source files for router-framework imports
    let mut files = Vec::new();
    let _ = walk_express_files(root, &mut files);
    files.iter().any(|p| {
        if let Ok(content) = fs::read_to_string(p) {
            if content.contains("Bun.serve(") || is_workers_source(&content) {
                return true;
            }
            PACKAGES.iter().any(|package| {
                let unquoted = package.trim_matches('"');
                content.contains(&format!("'{unquoted}'"))
                    || content.contains(&format!("\"{unquoted}\""))
            })
        } else {
            false
        }
    })
}

fn walk_express_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if DIRS_TO_SKIP.contains(&name.as_str()) {
                continue;
            }
            walk_express_files(&path, out)?;
        } else if path.is_file() {
            let s = path.to_string_lossy().replace('\\', "/");
            if is_express_source_file(&s) {
                out.push(path);
            }
        }
    }
    Ok(())
}

/// Types that name the HTTP envelope rather than a wire body. A handler that
/// annotates `res: Response` or `req: Request` has told us nothing about the
/// JSON shape, so treating the name as a DTO would fabricate a contract.
/// Cloudflare Workers (and service-worker style) `fetch` handlers: routes are
/// discovered from literal `url.pathname` comparisons, and a verb comes only from
/// a literal `request.method` comparison in the same branch.
fn is_workers_source(content: &str) -> bool {
    let event_listener = content.contains("addEventListener(\"fetch\"")
        || content.contains("addEventListener('fetch'");
    let default_handler = content.contains("export default")
        && (content.contains("async fetch(")
            || content.contains("fetch(request")
            || content.contains("fetch(req")
            || content.contains("fetch:"));
    (event_listener || default_handler)
        && (content.contains(".pathname") || content.contains("new URL("))
}

fn is_pathname_expression(node: Node, content: &str) -> bool {
    // A `switch (url.pathname)` value is wrapped in a parenthesized_expression.
    let mut current = node;
    while current.kind() == "parenthesized_expression" {
        let Some(inner) = current.named_child(0) else {
            return false;
        };
        current = inner;
    }
    let text = text(current, content).trim().trim_end_matches(['?', '!']);
    text.ends_with(".pathname")
}

fn workers_path_comparisons(
    condition: Node,
    content: &str,
    paths: &mut Vec<String>,
    dynamic: &mut bool,
) {
    match condition.kind() {
        "parenthesized_expression" => {
            if let Some(inner) = condition.named_child(0) {
                workers_path_comparisons(inner, content, paths, dynamic);
            }
        }
        "binary_expression" => {
            let operator = condition
                .child_by_field_name("operator")
                .map(|operator| text(operator, content).trim())
                .unwrap_or_default();
            if operator == "&&" || operator == "||" {
                if let Some(left) = condition.child_by_field_name("left") {
                    workers_path_comparisons(left, content, paths, dynamic);
                }
                if let Some(right) = condition.child_by_field_name("right") {
                    workers_path_comparisons(right, content, paths, dynamic);
                }
                return;
            }
            if !matches!(operator, "===" | "==") {
                return;
            }
            let (Some(left), Some(right)) = (
                condition.child_by_field_name("left"),
                condition.child_by_field_name("right"),
            ) else {
                return;
            };
            let pathname_is_left = is_pathname_expression(left, content);
            let pathname_is_right = is_pathname_expression(right, content);
            if !pathname_is_left && !pathname_is_right {
                return;
            }
            let literal = if pathname_is_left { right } else { left };
            if literal.kind() == "string" {
                paths.push(unquote(text(literal, content)));
            } else {
                *dynamic = true;
            }
        }
        "call_expression" => {
            let Some(function) = condition.child_by_field_name("function") else {
                return;
            };
            if function.kind() != "member_expression" {
                return;
            }
            let property = function
                .child_by_field_name("property")
                .map(|property| text(property, content).trim())
                .unwrap_or_default();
            if property != "startsWith" {
                return;
            }
            let Some(object) = function.child_by_field_name("object") else {
                return;
            };
            if !is_pathname_expression(object, content) {
                return;
            }
            let argument = condition
                .child_by_field_name("arguments")
                .and_then(|arguments| arguments.named_child(0));
            match argument {
                Some(argument) if argument.kind() == "string" => {
                    paths.push(unquote(text(argument, content)));
                }
                _ => *dynamic = true,
            }
        }
        _ => {}
    }
}

/// The `if` statement inside a Workers branch that checks for one literal method.
fn workers_method_branch<'a>(branch: Node<'a>, verb: &str, content: &str) -> Option<Node<'a>> {
    if branch.kind() == "if_statement" {
        if let Some(condition) = branch.child_by_field_name("condition") {
            let mut condition_verbs = Vec::new();
            workers_method_verbs(condition, content, &mut condition_verbs);
            if condition_verbs.iter().any(|candidate| candidate == verb) {
                if let Some(consequence) = branch.child_by_field_name("consequence") {
                    return Some(consequence);
                }
            }
        }
    }
    for index in 0..branch.named_child_count() {
        if let Some(child) = branch.named_child(index as u32) {
            if let Some(found) = workers_method_branch(child, verb, content) {
                return Some(found);
            }
        }
    }
    None
}

fn workers_method_verbs(node: Node, content: &str, verbs: &mut Vec<String>) {
    if node.kind() == "binary_expression" {
        let operator = node
            .child_by_field_name("operator")
            .map(|operator| text(operator, content).trim())
            .unwrap_or_default();
        if matches!(operator, "===" | "==") {
            let (Some(left), Some(right)) = (
                node.child_by_field_name("left"),
                node.child_by_field_name("right"),
            ) else {
                return;
            };
            let left_is_method = text(left, content)
                .trim()
                .trim_end_matches(['?', '!'])
                .ends_with(".method");
            let right_is_method = text(right, content)
                .trim()
                .trim_end_matches(['?', '!'])
                .ends_with(".method");
            let value = if left_is_method {
                Some(right)
            } else if right_is_method {
                Some(left)
            } else {
                None
            };
            if let Some(value) = value {
                if value.kind() == "string" {
                    if let Some(verb) = normalize_http_verb(&unquote(text(value, content))) {
                        verbs.push(verb);
                    }
                }
            }
        }
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            workers_method_verbs(child, content, verbs);
        }
    }
}

fn collect_server_bindings(root: Node, content: &str) -> HashSet<String> {
    let mut bindings = HashSet::new();
    walk_nodes(root, &mut |node| {
        if node.kind() != "variable_declarator" {
            return;
        }
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        if name.kind() != "identifier" {
            return;
        }
        let Some(value) = node.child_by_field_name("value") else {
            return;
        };
        let raw = text(value, content).trim();
        let is_server = raw.starts_with("express(")
            || raw.starts_with("express.Router(")
            || raw.starts_with("Router(")
            || raw.starts_with("new Router(")
            || raw.starts_with("new KoaRouter(")
            || raw.starts_with("fastify(")
            || raw.starts_with("Fastify(")
            || raw.starts_with("new Hono(")
            || raw.starts_with("new Koa(")
            || raw.starts_with("Hapi.server(")
            || raw.starts_with("new Hapi.Server(")
            || raw.starts_with("restify.createServer(")
            || raw.starts_with("polka(")
            || raw.starts_with("new Elysia(")
            || raw.starts_with("require('express')")
            || raw.starts_with("require(\"express\")")
            || raw.starts_with("require('fastify')")
            || raw.starts_with("require(\"fastify\")");
        if is_server {
            bindings.insert(text(name, content).trim().to_string());
        }
    });
    bindings
}

fn collect_router_prefixes(
    root: Node,
    content: &str,
    server_bindings: &HashSet<String>,
    prefixes: &mut HashMap<String, String>,
) {
    walk_nodes(root, &mut |node| {
        if node.kind() != "call_expression" {
            return;
        }
        let Some(func) = node.child_by_field_name("function") else {
            return;
        };
        if func.kind() != "member_expression" {
            return;
        }
        let Some(object) = func.child_by_field_name("object") else {
            return;
        };
        let Some(property) = func.child_by_field_name("property") else {
            return;
        };
        if text(property, content).trim().to_ascii_lowercase() != "use" {
            return;
        }
        let receiver = text(object, content).trim();
        if !server_bindings.contains(receiver)
            && !matches!(receiver, "app" | "router" | "server" | "fastify")
        {
            return;
        }
        let Some(args) = node.child_by_field_name("arguments") else {
            return;
        };
        let mut cursor = args.walk();
        let arguments: Vec<Node> = args.named_children(&mut cursor).collect();
        if arguments.len() != 2 || arguments[0].kind() != "string" {
            return;
        }
        if let Some(target) = mounted_router_identifier(arguments[1], content) {
            if server_bindings.contains(&target)
                || matches!(target.as_str(), "app" | "router" | "server" | "fastify")
            {
                prefixes.insert(target, unquote(text(arguments[0], content)));
            }
        }
    });
}

fn express_blocker(file: &str, code: &str, message: String) -> ArtifactBlocker {
    ArtifactBlocker {
        code: code.to_string(),
        message,
        file: Some(file.to_string()),
    }
}

fn wire_body_unresolved(body: Option<&WireType>, type_pool: &BTreeMap<String, WireType>) -> bool {
    match body {
        None => true,
        Some(WireType::Ref(reference)) => !type_pool.contains_key(&reference.r#ref),
        Some(WireType::Primitive(primitive)) => {
            matches!(primitive.scalar, PrimitiveScalar::Any)
        }
        Some(wire) => contains_unknown(wire),
    }
}

fn status_family(status: Option<u16>) -> StatusCodeFamily {
    match status {
        Some(status) if status >= 400 => StatusCodeFamily::Error4xx5xx,
        _ => StatusCodeFamily::Success2xx,
    }
}

fn handler_second_param_name(handler: Node, content: &str) -> Option<String> {
    let parameters = handler.child_by_field_name("parameters")?;
    let mut cursor = parameters.walk();
    let params: Vec<Node> = parameters
        .named_children(&mut cursor)
        .filter(|child| {
            matches!(
                child.kind(),
                "required_parameter" | "optional_parameter" | "identifier"
            )
        })
        .collect();
    let second = params.get(1)?;
    let raw = text(*second, content);
    let name = raw.split(':').next().unwrap_or(raw).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn walk_nodes(node: Node, visit: &mut dyn FnMut(Node)) {
    visit(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_nodes(child, &mut *visit);
    }
}

fn is_http_envelope_type(type_text: &str) -> bool {
    let simple = type_text
        .trim()
        .trim_start_matches(':')
        .trim()
        .rsplit('.')
        .next()
        .unwrap_or(type_text)
        .trim();
    matches!(
        simple,
        "Request"
            | "Response"
            | "NextRequest"
            | "NextResponse"
            | "NextFunction"
            | "Application"
            | "Router"
            | "Headers"
    )
}

fn text<'a>(node: Node<'a>, src: &'a str) -> &'a str {
    &src[node.start_byte()..node.end_byte()]
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

fn is_router_instance_expression(text: &str) -> bool {
    let text = text.trim();
    [
        "new Hono(",
        "Hono(",
        "new Elysia(",
        "Elysia(",
        "new Router(",
        "new KoaRouter(",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

/// `router.routes()` / `router.middleware()` identifies the router a Koa app mounts.
fn mounted_router_identifier(node: Node, content: &str) -> Option<String> {
    if node.kind() == "identifier" {
        return Some(text(node, content).trim().to_string());
    }
    if node.kind() != "call_expression" {
        return None;
    }
    let function = node.child_by_field_name("function")?;
    if function.kind() != "member_expression" {
        return None;
    }
    let property = function.child_by_field_name("property")?;
    if !matches!(
        text(property, content).trim(),
        "routes" | "middleware" | "allowedMethods"
    ) {
        return None;
    }
    let object = function.child_by_field_name("object")?;
    if object.kind() != "identifier" {
        return None;
    }
    Some(text(object, content).trim().to_string())
}

/// Fastify's declarative form: `fastify.route({ method, url, handler })`. `method` may be
/// one literal or an array, and `url`/`path` must be a literal; anything else is reported.
fn parse_fastify_route_object(node: Node, content: &str) -> Option<(Vec<String>, String)> {
    let mut methods = Vec::new();
    let mut path = None;
    let mut cursor = node.walk();
    for pair in node.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (
            pair.child_by_field_name("key"),
            pair.child_by_field_name("value"),
        ) else {
            continue;
        };
        let key = text(key, content)
            .trim()
            .trim_matches(|c| c == '"' || c == '\'');
        match key {
            "method" | "methods" => match value.kind() {
                "string" => {
                    if let Some(verb) = normalize_http_verb(&unquote(text(value, content))) {
                        methods.push(verb);
                    }
                }
                "array" => {
                    let mut list = value.walk();
                    for item in value.named_children(&mut list) {
                        if item.kind() != "string" {
                            return None;
                        }
                        if let Some(verb) = normalize_http_verb(&unquote(text(item, content))) {
                            methods.push(verb);
                        } else {
                            return None;
                        }
                    }
                }
                _ => return None,
            },
            "url" | "path" => {
                if value.kind() != "string" {
                    return None;
                }
                path = Some(unquote(text(value, content)));
            }
            _ => {}
        }
    }
    methods.sort();
    methods.dedup();
    if methods.is_empty() {
        return None;
    }
    path.map(|path| (methods, path))
}

fn normalize_http_verb(raw: &str) -> Option<String> {
    let verb = raw.trim().to_ascii_uppercase();
    EXPRESS_VERBS
        .iter()
        .any(|(_, known)| *known == verb)
        .then_some(verb)
}

/// The `handler` member of a Fastify route object, when it is a function expression.
fn fastify_route_handler<'a>(node: Node<'a>, content: &str) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    for pair in node.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let Some(key) = pair.child_by_field_name("key") else {
            continue;
        };
        if text(key, content)
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            != "handler"
        {
            continue;
        }
        return pair.child_by_field_name("value").filter(|value| {
            matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "function"
            )
        });
    }
    None
}

fn first_argument(call: Node) -> Option<Node> {
    call.child_by_field_name("arguments")?.named_child(0)
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('`') && trimmed.ends_with('`'))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

impl ExpressRouteExtractor {
    pub fn new(repo_root: PathBuf, src_dir: &Path) -> Result<Self> {
        let mut files = Vec::new();
        walk_express_files(src_dir, &mut files)?;
        files.sort();
        let mut sources = Vec::new();
        for path in files {
            let rel = path
                .strip_prefix(&repo_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
            if let Ok(content) = fs::read_to_string(&path) {
                sources.push((rel, content));
            }
        }
        Self::from_sources(sources)
    }

    pub fn from_blobs(_repo_root: PathBuf, sources: Vec<(String, String)>) -> Result<Self> {
        Self::from_sources(sources)
    }

    pub fn from_sources(mut sources: Vec<(String, String)>) -> Result<Self> {
        sources.retain(|(path, _)| is_express_source_file(path));
        sources.sort_by(|a, b| a.0.cmp(&b.0));
        sources.dedup_by(|a, b| a.0 == b.0);

        let mut extractor = Self {
            sources: Vec::new(),
            source_hashes: BTreeMap::new(),
            file_facts: Vec::new(),
            framework_profile: detect_node_framework(&sources),
        };

        let mut parser = Parser::new();

        for (path, content) in &sources {
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            extractor
                .source_hashes
                .insert(path.clone(), hex::encode(hasher.finalize()));

            if let Some(facts) = extractor.ingest_express_file(&mut parser, path, content) {
                extractor.file_facts.push(facts);
            }
        }

        extractor.sources = sources;
        Ok(extractor)
    }

    pub fn endpoints_count(&self) -> usize {
        self.file_facts.iter().map(|f| f.routes.len()).sum()
    }

    fn ingest_express_file(
        &self,
        parser: &mut Parser,
        rel_path: &str,
        content: &str,
    ) -> Option<ExpressFileFacts> {
        // React/JSX files need the TSX grammar; the plain TS grammar reports
        // their components as syntax errors.
        let language = if rel_path.ends_with(".tsx")
            || rel_path.ends_with(".jsx")
            || rel_path.ends_with(".js")
            || rel_path.ends_with(".mjs")
            || rel_path.ends_with(".cjs")
        {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        } else {
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
        };
        if parser.set_language(&language).is_err() {
            return None;
        }
        let tree = parser.parse(content, None)?;
        let root = tree.root_node();

        let mut routes = Vec::new();
        let mut declared_types = Vec::new();
        let mut router_prefixes: HashMap<String, String> = HashMap::new();
        let server_bindings = collect_server_bindings(root, content);
        let mut blockers = Vec::new();
        if root.has_error() {
            blockers.push(ArtifactBlocker {
                code: "EXPRESS_PARSE_ERROR".to_string(),
                message: "The file does not parse as TypeScript/JavaScript; routes after the syntax error are absent from this artifact and its emptiness is not evidence of absence".to_string(),
                file: Some(rel_path.to_string()),
            });
        }
        // Mounts can appear after the routes they govern. Read them first so
        // traversal order cannot silently drop a prefix.
        collect_router_prefixes(root, content, &server_bindings, &mut router_prefixes);

        self.traverse_ast(
            root,
            content,
            rel_path,
            &mut routes,
            &mut declared_types,
            &mut router_prefixes,
            &server_bindings,
            &mut blockers,
        );
        self.collect_bun_routes(root, content, rel_path, &mut routes, &mut blockers);
        self.collect_workers_routes(root, content, rel_path, &mut routes, &mut blockers);

        if routes.is_empty() && declared_types.is_empty() && blockers.is_empty() {
            None
        } else {
            Some(ExpressFileFacts {
                file: rel_path.to_string(),
                routes,
                declared_types,
                blockers,
            })
        }
    }

    fn traverse_ast(
        &self,
        node: Node,
        content: &str,
        rel_path: &str,
        routes: &mut Vec<ExpressRouteCall>,
        declared_types: &mut Vec<(String, WireType)>,
        router_prefixes: &mut HashMap<String, String>,
        server_bindings: &HashSet<String>,
        blockers: &mut Vec<ArtifactBlocker>,
    ) {
        match node.kind() {
            "interface_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = text(name_node, content).to_string();
                    let wire = self.parse_interface_to_wire(node, content, rel_path, &name);
                    declared_types.push((name, wire));
                }
            }
            "type_alias_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = text(name_node, content).to_string();
                    if let Some(val_node) = node.child_by_field_name("value") {
                        let wire =
                            self.parse_type_value_to_wire(val_node, content, rel_path, &name);
                        declared_types.push((name, wire));
                    }
                }
            }
            "call_expression" => {
                if let Some(func) = node.child_by_field_name("function") {
                    if func.kind() == "member_expression" {
                        if let (Some(obj), Some(prop)) = (
                            func.child_by_field_name("object"),
                            func.child_by_field_name("property"),
                        ) {
                            let obj_name = text(obj, content).to_string();
                            let method_name = text(prop, content).to_ascii_lowercase();
                            let receiver_is_server = server_bindings.contains(&obj_name)
                                || matches!(
                                    obj_name.as_str(),
                                    "app" | "router" | "server" | "fastify"
                                )
                                || is_router_instance_expression(&obj_name);

                            if receiver_is_server {
                                if let Some(args) = node.child_by_field_name("arguments") {
                                    let mut arg_cursor = args.walk();
                                    let arg_children: Vec<Node> = args
                                        .children(&mut arg_cursor)
                                        .filter(|c| {
                                            c.kind() != "(" && c.kind() != ")" && c.kind() != ","
                                        })
                                        .collect();

                                    if method_name == "use" {
                                        // Router mounting: app.use('/api', router)
                                        if let Some(first) = arg_children.first() {
                                            if first.kind() == "string" {
                                                if arg_children.len() == 2
                                                    && arg_children[1].kind() == "identifier"
                                                {
                                                    let prefix = unquote(text(*first, content));
                                                    let router_var =
                                                        text(arg_children[1], content).to_string();
                                                    if server_bindings.contains(&router_var)
                                                        || matches!(
                                                            router_var.as_str(),
                                                            "app" | "router" | "server" | "fastify"
                                                        )
                                                    {
                                                        router_prefixes.insert(router_var, prefix);
                                                    } else {
                                                        blockers.push(express_blocker(
                                                            rel_path,
                                                            "EXPRESS_MOUNT_PREFIX_UNRESOLVED",
                                                            format!(
                                                                "{obj_name}.use(\"{prefix}\", {router_var}) mounts a router declared outside this file; routes in that router are extracted without the \"{prefix}\" prefix"
                                                            ),
                                                        ));
                                                    }
                                                } else if arg_children.len() >= 2 {
                                                    let prefix = unquote(text(*first, content));
                                                    let mounted = mounted_router_identifier(
                                                        arg_children[1],
                                                        content,
                                                    );
                                                    match mounted {
                                                        Some(router_var)
                                                            if server_bindings
                                                                .contains(&router_var)
                                                                || matches!(
                                                                    router_var.as_str(),
                                                                    "app" | "router" | "server" | "fastify"
                                                                ) =>
                                                        {
                                                            router_prefixes
                                                                .insert(router_var, prefix);
                                                        }
                                                        Some(router_var) => {
                                                            blockers.push(express_blocker(
                                                                rel_path,
                                                                "EXPRESS_MOUNT_PREFIX_UNRESOLVED",
                                                                format!(
                                                                    "{obj_name}.use(\"{prefix}\", {router_var}...) mounts a router declared outside this file; routes in that router are extracted without the \"{prefix}\" prefix"
                                                                ),
                                                            ));
                                                        }
                                                        None => blockers.push(express_blocker(
                                                            rel_path,
                                                            "EXPRESS_MOUNT_PREFIX_UNRESOLVED",
                                                            format!(
                                                                "{obj_name}.use(\"{prefix}\", ...) has middleware or a router target this reader cannot follow; the mounted routes may lose their prefix"
                                                            ),
                                                        )),
                                                    }
                                                }
                                            }
                                        }
                                    } else if method_name == "route"
                                        && arg_children.len() == 2
                                        && arg_children[0].kind() == "string"
                                        && arg_children[1].kind() == "identifier"
                                    {
                                        // Hono sub-app mount: app.route('/api', sub)
                                        let prefix = unquote(text(arg_children[0], content));
                                        let router_var = text(arg_children[1], content).to_string();
                                        if server_bindings.contains(&router_var)
                                            || matches!(
                                                router_var.as_str(),
                                                "app" | "router" | "server" | "fastify"
                                            )
                                        {
                                            router_prefixes.insert(router_var, prefix);
                                        } else {
                                            blockers.push(express_blocker(
                                                rel_path,
                                                "EXPRESS_MOUNT_PREFIX_UNRESOLVED",
                                                format!(
                                                    "{obj_name}.route(\"{prefix}\", {router_var}) mounts a sub-app declared outside this file; routes in it are extracted without the \"{prefix}\" prefix"
                                                ),
                                            ));
                                        }
                                    } else if method_name == "route" {
                                        let first = arg_children.first().copied();
                                        if let Some(first) =
                                            first.filter(|arg| arg.kind() == "object")
                                        {
                                            match parse_fastify_route_object(first, content) {
                                                Some((verbs, mut path)) => {
                                                    if !path.starts_with('/') {
                                                        path = format!("/{}", path);
                                                    }
                                                    if let Some(prefix) = router_prefixes.get(&obj_name) {
                                                        let clean_prefix = prefix.trim_end_matches('/');
                                                        path = format!("{clean_prefix}{path}");
                                                    }
                                                    let handler = fastify_route_handler(first, content);
                                                    let (req_type, res_type) = handler
                                                        .map(|handler| {
                                                            self.extract_handler_types(handler, content)
                                                        })
                                                        .unwrap_or((None, None));
                                                    let (response_shape, status) = handler
                                                        .map(|handler| {
                                                            self.extract_response_shape(
                                                                handler,
                                                                content,
                                                                rel_path,
                                                            )
                                                        })
                                                        .unwrap_or((None, None));
                                                    for verb in verbs {
                                                        routes.push(ExpressRouteCall {
                                                            verb,
                                                            path: path.clone(),
                                                            line: line_of(node),
                                                            req_type: req_type.clone(),
                                                            res_type: res_type.clone(),
                                                            response_shape: response_shape.clone(),
                                                            status,
                                                        });
                                                    }
                                                }
                                                None => blockers.push(express_blocker(
                                                    rel_path,
                                                    "FASTIFY_ROUTE_OBJECT_UNRESOLVED",
                                                    format!(
                                                        "{obj_name}.route(...) at line {} does not declare literal `method` and `url` values; its routes are absent from this artifact and their emptiness is not evidence of absence",
                                                        line_of(node)
                                                    ),
                                                )),
                                            }
                                        } else {
                                            blockers.push(express_blocker(
                                                rel_path,
                                                "EXPRESS_ROUTE_CHAIN_UNPARSED",
                                                format!(
                                                    "{obj_name}.route(...) chains are not read; the routes they declare are absent from this artifact"
                                                ),
                                            ));
                                        }
                                    } else if method_name == "register"
                                        && arg_children
                                            .iter()
                                            .any(|arg| text(*arg, content).contains("prefix"))
                                    {
                                        blockers.push(express_blocker(
                                            rel_path,
                                            "FASTIFY_PLUGIN_PREFIX_UNPARSED",
                                            format!(
                                                "{obj_name}.register(..., {{ prefix }}) is not read; routes registered by that plugin lose the prefix"
                                            ),
                                        ));
                                    } else if let Some((_, verb)) = EXPRESS_VERBS
                                        .iter()
                                        .find(|(method, _)| *method == method_name.as_str())
                                    {
                                        if let Some(first_arg) = arg_children.first() {
                                            if first_arg.kind() != "string" {
                                                blockers.push(express_blocker(
                                                    rel_path,
                                                    "EXPRESS_ROUTE_PATH_UNRESOLVED",
                                                    format!(
                                                        "{obj_name}.{method_name} at line {} is called with a path that is not a string literal; the route is absent from this artifact and its emptiness is not evidence of absence",
                                                        line_of(node)
                                                    ),
                                                ));
                                            } else {
                                                let mut path = unquote(text(*first_arg, content));
                                                if !path.starts_with('/') {
                                                    path = format!("/{}", path);
                                                }
                                                if let Some(prefix) = router_prefixes.get(&obj_name)
                                                {
                                                    let clean_prefix = prefix.trim_end_matches('/');
                                                    path = format!("{clean_prefix}{path}");
                                                }

                                                let line = line_of(node);
                                                let handler = arg_children.last().filter(|node| {
                                                    arg_children.len() > 1 && **node != *first_arg
                                                });
                                                let (req_type, res_type) = handler
                                                    .map(|handler| {
                                                        self.extract_handler_types(
                                                            *handler, content,
                                                        )
                                                    })
                                                    .unwrap_or((None, None));
                                                let (response_shape, status) = handler
                                                    .map(|handler| {
                                                        self.extract_response_shape(
                                                            *handler, content, rel_path,
                                                        )
                                                    })
                                                    .unwrap_or((None, None));

                                                routes.push(ExpressRouteCall {
                                                    verb: verb.to_string(),
                                                    path,
                                                    line,
                                                    req_type,
                                                    res_type,
                                                    response_shape,
                                                    status,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_ast(
                child,
                content,
                rel_path,
                routes,
                declared_types,
                router_prefixes,
                server_bindings,
                blockers,
            );
        }
    }

    /// Cloudflare Workers `fetch` handlers: routes come from literal `url.pathname`
    /// comparisons, verbs from literal `request.method` comparisons in the branch.
    fn collect_workers_routes(
        &self,
        root: Node,
        content: &str,
        rel_path: &str,
        routes: &mut Vec<ExpressRouteCall>,
        blockers: &mut Vec<ArtifactBlocker>,
    ) {
        if !is_workers_source(content) {
            return;
        }
        walk_nodes(root, &mut |node| {
            match node.kind() {
                "if_statement" => {
                    let Some(condition) = node.child_by_field_name("condition") else {
                        return;
                    };
                    let mut paths = Vec::new();
                    let mut dynamic = false;
                    workers_path_comparisons(condition, content, &mut paths, &mut dynamic);
                    if dynamic {
                        blockers.push(express_blocker(
                            rel_path,
                            "WORKERS_PATH_UNRESOLVED",
                            format!(
                                "A Cloudflare Workers pathname comparison at line {} is not a string literal; that branch is absent from this artifact",
                                line_of(node)
                            ),
                        ));
                    }
                    if paths.is_empty() {
                        return;
                    }
                    let Some(consequence) = node.child_by_field_name("consequence") else {
                        return;
                    };
                    let mut verbs = Vec::new();
                    workers_method_verbs(condition, content, &mut verbs);
                    workers_method_verbs(consequence, content, &mut verbs);
                    verbs.sort();
                    verbs.dedup();
                    for path in paths {
                        let mut path = path;
                        if !path.starts_with('/') {
                            path = format!("/{path}");
                        }
                        if verbs.is_empty() {
                            blockers.push(express_blocker(
                                rel_path,
                                "WORKERS_METHOD_UNRESOLVED",
                                format!(
                                    "Cloudflare Workers route {path:?} at line {} has no literal request.method comparison; the methods it serves are not guessed",
                                    line_of(node)
                                ),
                            ));
                            continue;
                        }
                        for verb in &verbs {
                            // Each method may answer with its own shape; read the
                            // response inside that method's branch when one exists.
                            let shape_node = workers_method_branch(consequence, verb, content)
                                .unwrap_or(consequence);
                            let (shape, status) = self
                                .extract_response_constructor_shape(shape_node, content, rel_path);
                            routes.push(ExpressRouteCall {
                                verb: verb.clone(),
                                path: path.clone(),
                                line: line_of(node),
                                req_type: None,
                                res_type: None,
                                response_shape: shape,
                                status,
                            });
                        }
                    }
                }
                "switch_statement" => {
                    let Some(value) = node.child_by_field_name("value") else {
                        return;
                    };
                    if !is_pathname_expression(value, content) {
                        return;
                    }
                    let Some(body) = node.child_by_field_name("body") else {
                        return;
                    };
                    let mut cursor = body.walk();
                    for case in body.named_children(&mut cursor) {
                        if case.kind() != "switch_case" {
                            continue;
                        }
                        let Some(case_value) = case.child_by_field_name("value") else {
                            continue;
                        };
                        if case_value.kind() != "string" {
                            blockers.push(express_blocker(
                                rel_path,
                                "WORKERS_PATH_UNRESOLVED",
                                format!(
                                    "A Cloudflare Workers switch case at line {} is not a string pathname literal; that branch is absent from this artifact",
                                    line_of(case)
                                ),
                            ));
                            continue;
                        }
                        let mut path = unquote(text(case_value, content));
                        if !path.starts_with('/') {
                            path = format!("/{path}");
                        }
                        let mut verbs = Vec::new();
                        workers_method_verbs(case, content, &mut verbs);
                        verbs.sort();
                        verbs.dedup();
                        if verbs.is_empty() {
                            blockers.push(express_blocker(
                                rel_path,
                                "WORKERS_METHOD_UNRESOLVED",
                                format!(
                                    "Cloudflare Workers route {path:?} at line {} has no literal request.method comparison; the methods it serves are not guessed",
                                    line_of(case)
                                ),
                            ));
                            continue;
                        }
                        for verb in &verbs {
                            let shape_node =
                                workers_method_branch(case, verb, content).unwrap_or(case);
                            let (shape, status) = self
                                .extract_response_constructor_shape(shape_node, content, rel_path);
                            routes.push(ExpressRouteCall {
                                verb: verb.clone(),
                                path: path.clone(),
                                line: line_of(case),
                                req_type: None,
                                res_type: None,
                                response_shape: shape,
                                status,
                            });
                        }
                    }
                }
                _ => {}
            }
        });
    }

    /// `Bun.serve({ routes: { "/x": { GET: handler } } })`. Only a literal route
    /// table with literal method keys is published; a bare handler function, a
    /// non-object table, or a `fetch`-style config is a named blocker.
    fn collect_bun_routes(
        &self,
        root: Node,
        content: &str,
        rel_path: &str,
        routes: &mut Vec<ExpressRouteCall>,
        blockers: &mut Vec<ArtifactBlocker>,
    ) {
        walk_nodes(root, &mut |node| {
            if node.kind() != "call_expression" {
                return;
            }
            let Some(function) = node.child_by_field_name("function") else {
                return;
            };
            if text(function, content).trim() != "Bun.serve" {
                return;
            }
            let Some(arguments) = node.child_by_field_name("arguments") else {
                return;
            };
            let mut cursor = arguments.walk();
            let Some(config) = arguments.named_children(&mut cursor).next() else {
                return;
            };
            if config.kind() != "object" {
                blockers.push(express_blocker(
                    rel_path,
                    "BUN_SERVE_ROUTES_UNRESOLVED",
                    format!(
                        "Bun.serve(...) at line {} takes a non-literal config; its routes are absent from this artifact",
                        line_of(node)
                    ),
                ));
                return;
            }
            let mut config_cursor = config.walk();
            let mut saw_routes = false;
            for pair in config.named_children(&mut config_cursor) {
                if pair.kind() != "pair" {
                    continue;
                }
                let key = pair
                    .child_by_field_name("key")
                    .map(|key| unquote(text(key, content)))
                    .unwrap_or_default();
                if key.trim() != "routes" {
                    continue;
                }
                saw_routes = true;
                let Some(table) = pair.child_by_field_name("value") else {
                    continue;
                };
                if table.kind() != "object" {
                    blockers.push(express_blocker(
                        rel_path,
                        "BUN_ROUTES_UNRESOLVED",
                        format!(
                            "Bun.serve routes at line {} are not an object literal; its routes are absent from this artifact",
                            line_of(node)
                        ),
                    ));
                    continue;
                }
                let mut table_cursor = table.walk();
                for route_pair in table.named_children(&mut table_cursor) {
                    if route_pair.kind() != "pair" {
                        continue;
                    }
                    let Some(path_node) = route_pair.child_by_field_name("key") else {
                        continue;
                    };
                    if path_node.kind() != "string" {
                        blockers.push(express_blocker(
                            rel_path,
                            "BUN_ROUTE_PATH_UNRESOLVED",
                            format!(
                                "A Bun.serve route key at line {} is not a string literal; that route is absent",
                                line_of(route_pair)
                            ),
                        ));
                        continue;
                    }
                    let mut path = unquote(text(path_node, content));
                    if !path.starts_with('/') {
                        path = format!("/{path}");
                    }
                    let Some(value) = route_pair.child_by_field_name("value") else {
                        continue;
                    };
                    if value.kind() != "object" {
                        blockers.push(express_blocker(
                            rel_path,
                            "BUN_ROUTE_METHOD_UNRESOLVED",
                            format!(
                                "Bun.serve route {path:?} at line {} uses a handler function without a literal HTTP method; the method this route accepts is not guessed",
                                line_of(route_pair)
                            ),
                        ));
                        continue;
                    }
                    let mut method_cursor = value.walk();
                    let mut verbs = 0usize;
                    for method_pair in value.named_children(&mut method_cursor) {
                        // `{ GET: fn }` is a pair; `{ GET() {} }` is a
                        // method_definition.
                        let method_key = match method_pair.kind() {
                            "pair" => method_pair.child_by_field_name("key"),
                            "method_definition" => method_pair.child_by_field_name("name"),
                            _ => continue,
                        };
                        let Some(method_key) = method_key else {
                            continue;
                        };
                        let raw_method = unquote(text(method_key, content));
                        let Some(verb) = normalize_http_verb(&raw_method) else {
                            blockers.push(express_blocker(
                                rel_path,
                                "BUN_ROUTE_METHOD_UNRESOLVED",
                                format!(
                                    "Bun.serve route {path:?} declares {raw_method:?}, which is not a standard HTTP method; that handler is absent",
                                ),
                            ));
                            continue;
                        };
                        verbs += 1;
                        let handler = method_pair.child_by_field_name("value");
                        let (response_shape, status) = handler
                            .map(|handler| {
                                self.extract_response_constructor_shape(handler, content, rel_path)
                            })
                            .unwrap_or((None, None));
                        routes.push(ExpressRouteCall {
                            verb,
                            path: path.clone(),
                            line: line_of(node),
                            req_type: None,
                            res_type: None,
                            response_shape,
                            status,
                        });
                    }
                    if verbs == 0 {
                        blockers.push(express_blocker(
                            rel_path,
                            "BUN_ROUTE_HANDLER_UNRESOLVED",
                            format!(
                                "Bun.serve route {path:?} at line {} has no standard HTTP method handler; it is absent from this artifact",
                                line_of(route_pair)
                            ),
                        ));
                    }
                }
            }
            if !saw_routes {
                blockers.push(express_blocker(
                    rel_path,
                    "BUN_SERVE_ROUTES_UNRESOLVED",
                    format!(
                        "Bun.serve(...) at line {} has no literal `routes` table (fetch-style dispatch); its routes are absent from this artifact",
                        line_of(node)
                    ),
                ));
            }
        });
    }

    /// `Response.json({...})`, `new Response(JSON.stringify({...}), { status })`.
    fn extract_response_constructor_shape(
        &self,
        handler: Node,
        content: &str,
        rel_path: &str,
    ) -> (Option<WireType>, Option<u16>) {
        let ctx = ShapeContext {
            content,
            file: rel_path,
            sha256: self.source_hashes.get(rel_path).map(|s| s.as_str()),
        };
        let mut shape = None;
        let mut status = None;
        walk_nodes(handler, &mut |node| {
            if node.kind() == "call_expression" {
                let Some(function) = node.child_by_field_name("function") else {
                    return;
                };
                if function.kind() != "member_expression" {
                    return;
                }
                let object = function
                    .child_by_field_name("object")
                    .map(|object| text(object, content).trim())
                    .unwrap_or_default();
                let property = function
                    .child_by_field_name("property")
                    .map(|property| text(property, content).trim())
                    .unwrap_or_default();
                if object != "Response" || property != "json" {
                    return;
                }
                if let Some(first) = first_argument(node) {
                    if let Some(response) = response_shape_wire(first, &ctx) {
                        shape = Some(response);
                    }
                }
                return;
            }
            if node.kind() != "new_expression" {
                return;
            }
            let constructor = node
                .child_by_field_name("constructor")
                .map(|constructor| text(constructor, content).trim())
                .unwrap_or_default();
            if constructor != "Response" {
                return;
            }
            let Some(arguments) = node.child_by_field_name("arguments") else {
                return;
            };
            let mut cursor = arguments.walk();
            let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
            if let Some(first) = children.first() {
                if first.kind() == "call_expression" {
                    let callee = first
                        .child_by_field_name("function")
                        .map(|function| text(function, content).trim())
                        .unwrap_or_default();
                    if callee == "JSON.stringify" {
                        if let Some(argument) = first_argument(*first) {
                            if let Some(response) = response_shape_wire(argument, &ctx) {
                                shape = Some(response);
                            }
                        }
                    }
                }
            }
            if let Some(init) = children.get(1) {
                if init.kind() == "object" {
                    let mut init_cursor = init.walk();
                    for pair in init.named_children(&mut init_cursor) {
                        if pair.kind() != "pair" {
                            continue;
                        }
                        let key = pair
                            .child_by_field_name("key")
                            .map(|key| unquote(text(key, content)))
                            .unwrap_or_default();
                        if key.trim() != "status" {
                            continue;
                        }
                        if let Some(value) = pair.child_by_field_name("value") {
                            if value.kind() == "number" {
                                status = text(value, content).trim().parse::<u16>().ok();
                            }
                        }
                    }
                }
            }
        });
        (shape, status)
    }

    fn extract_handler_types(
        &self,
        handler_node: Node,
        content: &str,
    ) -> (Option<String>, Option<String>) {
        let mut req_type = None;
        let mut res_type = None;

        if handler_node.kind() == "arrow_function" || handler_node.kind() == "function_expression" {
            if let Some(params) = handler_node.child_by_field_name("parameters") {
                let mut cursor = params.walk();
                let param_list: Vec<Node> = params
                    .children(&mut cursor)
                    .filter(|c| {
                        c.kind() == "required_parameter" || c.kind() == "optional_parameter"
                    })
                    .collect();

                // req: Request<Params, ResBody, ReqBody, ReqQuery>
                if let Some(first_param) = param_list.first() {
                    if let Some(type_ann) = first_param.child_by_field_name("type") {
                        let raw = text(type_ann, content).trim_start_matches(':').trim();
                        if raw.starts_with("Request<") && raw.ends_with('>') {
                            let inner = &raw[8..raw.len() - 1];
                            let type_args: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
                            if type_args.len() >= 2
                                && !type_args[1].is_empty()
                                && type_args[1] != "any"
                                && type_args[1] != "{}"
                            {
                                res_type = Some(type_args[1].to_string());
                            }
                            if type_args.len() >= 3
                                && !type_args[2].is_empty()
                                && type_args[2] != "any"
                                && type_args[2] != "{}"
                            {
                                req_type = Some(type_args[2].to_string());
                            }
                        }
                    }
                }

                // res: Response<ResBody>
                if let Some(second_param) = param_list.get(1) {
                    if let Some(type_ann) = second_param.child_by_field_name("type") {
                        let raw = text(type_ann, content).trim_start_matches(':').trim();
                        if raw.starts_with("Response<") && raw.ends_with('>') {
                            let inner = &raw[9..raw.len() - 1].trim();
                            if !inner.is_empty() && *inner != "any" && *inner != "{}" {
                                res_type = Some(inner.to_string());
                            }
                        }
                    }
                }
            }
        }

        (req_type, res_type)
    }

    /// Read the common `res.json({ ... })` / `res.status(201).send(...)` form.
    /// This is deliberately limited to object/string literals and `send()`
    /// with no argument; anything computed stays `None` and the route is
    /// reported as an unresolved endpoint.
    fn extract_response_shape(
        &self,
        handler_node: Node,
        content: &str,
        rel_path: &str,
    ) -> (Option<WireType>, Option<u16>) {
        let ctx = ShapeContext {
            content,
            file: rel_path,
            sha256: self.source_hashes.get(rel_path).map(|s| s.as_str()),
        };
        let res_name =
            handler_second_param_name(handler_node, content).unwrap_or_else(|| "res".to_string());
        let res_prefix = format!("{res_name}.");
        let mut shape = None;
        let mut status = None;
        walk_nodes(handler_node, &mut |node| {
            if node.kind() != "call_expression" {
                return;
            }
            let Some(func) = node.child_by_field_name("function") else {
                return;
            };
            if func.kind() != "member_expression" {
                return;
            }
            let Some(property) = func.child_by_field_name("property") else {
                return;
            };
            let Some(object) = func.child_by_field_name("object") else {
                return;
            };
            let object_text = text(object, content).trim();
            if object_text != res_name && !object_text.starts_with(&res_prefix) {
                return;
            }
            let property = text(property, content).trim();
            let first_arg = if let Some(args) = node.child_by_field_name("arguments") {
                let mut cursor = args.walk();
                let first = args.named_children(&mut cursor).next();
                first
            } else {
                None
            };
            match property {
                "status" => {
                    if let Some(first) = first_arg {
                        if first.kind() == "number" {
                            status = text(first, content).trim().parse::<u16>().ok();
                        }
                    }
                }
                "json" | "send" => {
                    if let Some(first) = first_arg {
                        if let Some(object_shape) = response_shape_wire(first, &ctx) {
                            shape = Some(object_shape);
                        } else if first.kind() == "string" || first.kind() == "template_string" {
                            shape = Some(WireType::Primitive(PrimitiveWireType {
                                scalar: PrimitiveScalar::String,
                                format: None,
                                provenance: Some(self.prov(
                                    rel_path,
                                    line_of(first),
                                    "response-string",
                                )),
                            }));
                        }
                    } else if property == "send" {
                        shape = Some(WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::Void,
                            format: None,
                            provenance: Some(self.prov(rel_path, line_of(node), "response-empty")),
                        }));
                    }
                }
                "end" => {
                    shape = Some(WireType::Primitive(PrimitiveWireType {
                        scalar: PrimitiveScalar::Void,
                        format: None,
                        provenance: Some(self.prov(rel_path, line_of(node), "response-end")),
                    }));
                }
                _ => {}
            }
        });
        (shape, status)
    }

    fn parse_interface_to_wire(
        &self,
        node: Node,
        content: &str,
        file: &str,
        name: &str,
    ) -> WireType {
        let line = line_of(node);
        let mut properties = Vec::new();

        if let Some(body) = node.child_by_field_name("body") {
            let mut cursor = body.walk();
            for member in body.children(&mut cursor) {
                if member.kind() == "property_signature" {
                    if let Some(name_node) = member.child_by_field_name("name") {
                        let prop_name = text(name_node, content).trim().to_string();
                        let optional = member
                            .children(&mut member.walk())
                            .any(|c| text(c, content) == "?");
                        let prop_wire = if let Some(type_node) = member.child_by_field_name("type")
                        {
                            self.parse_type_value_to_wire(type_node, content, file, &prop_name)
                        } else {
                            WireType::Primitive(PrimitiveWireType {
                                scalar: PrimitiveScalar::String,
                                format: None,
                                provenance: Some(self.prov(file, line, &prop_name)),
                            })
                        };
                        properties.push(WirePropertyContract {
                            wire_name: prop_name,
                            aliases: Vec::new(),
                            r#type: prop_wire,
                            optional,
                            nullable: false,
                            server_assigned: false,
                            validation_constraints: Vec::new(),
                            provenance: Some(self.prov(file, line, name)),
                        });
                    }
                }
            }
        }

        WireType::Object(ObjectWireType {
            name: Some(name.to_string()),
            properties,
            strict: Some(false),
            provenance: Some(self.prov(file, line, name)),
        })
    }

    fn parse_type_value_to_wire(
        &self,
        node: Node,
        content: &str,
        file: &str,
        name: &str,
    ) -> WireType {
        let line = line_of(node);
        let t = text(node, content).trim().trim_start_matches(':').trim();
        match t {
            "string" => WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: None,
                provenance: Some(self.prov(file, line, name)),
            }),
            "number" => WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Number,
                format: None,
                provenance: Some(self.prov(file, line, name)),
            }),
            "boolean" => WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Boolean,
                format: None,
                provenance: Some(self.prov(file, line, name)),
            }),
            "any" | "unknown" => WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Any,
                format: None,
                provenance: Some(self.prov(file, line, name)),
            }),
            other => {
                if other.ends_with("[]") {
                    let elem = &other[..other.len() - 2];
                    WireType::Array(contract_core::ir::ArrayWireType {
                        element_type: Box::new(WireType::Ref(RefWireType {
                            r#ref: elem.to_string(),
                            provenance: Some(self.prov(file, line, name)),
                        })),
                        is_stream_or_flux: Some(false),
                        provenance: Some(self.prov(file, line, name)),
                    })
                } else {
                    WireType::Ref(RefWireType {
                        r#ref: other.to_string(),
                        provenance: Some(self.prov(file, line, name)),
                    })
                }
            }
        }
    }

    fn prov(&self, file: &str, line: u32, identity: &str) -> SourceProvenance {
        SourceProvenance {
            language: SourceLanguage::TypeScript,
            file: file.to_string(),
            line,
            column: None,
            ast_identity: Some(identity.to_string()),
            annotation_or_schema: None,
            sha256: self.source_hashes.get(file).cloned(),
            evidence_classification: Some(EvidenceClassification::ImplementationDerived),
        }
    }

    pub fn build_envelope(
        &self,
        service_id: &str,
        api_version: Option<&str>,
        candidate_snapshot: &str,
    ) -> Result<ContractArtifactEnvelope> {
        self.build_envelope_bound(
            service_id,
            api_version,
            "git-root:native",
            "HEAD",
            candidate_snapshot,
        )
    }

    pub fn build_envelope_bound(
        &self,
        service_id: &str,
        api_version: Option<&str>,
        repository_id: &str,
        parent_commit: &str,
        candidate_snapshot: &str,
    ) -> Result<ContractArtifactEnvelope> {
        let mut endpoints = Vec::new();
        let mut type_pool = BTreeMap::new();
        let mut blockers = Vec::new();
        let mut unresolved_endpoints = Vec::new();

        let total_routes: usize = self.file_facts.iter().map(|facts| facts.routes.len()).sum();
        if total_routes == 0 && !self.sources.is_empty() {
            blockers.push(ArtifactBlocker {
                code: "NODE_ROUTER_NO_ROUTE_RECOGNIZED".to_string(),
                message: format!(
                    "{} source file(s) were read but no literal router call was recognized; this artifact carries no provider expectations and must not be read as a service with no routes",
                    self.sources.len()
                ),
                file: None,
            });
        }

        // Medusa registers file-based routes (`src/api/**/route.ts`). A single
        // Express route elsewhere in the package must not make that whole API look
        // covered.
        let medusa_file_routes: Vec<&str> = self
            .sources
            .iter()
            .filter(|(path, content)| {
                let path = path.replace('\\', "/");
                (path.contains("/api/") || path.starts_with("api/"))
                    && path.ends_with("/route.ts")
                    && (content.contains("@medusajs/")
                        || content.contains("MedusaRequest")
                        || content.contains("MedusaResponse"))
            })
            .map(|(path, _)| path.as_str())
            .collect();
        if !medusa_file_routes.is_empty() {
            blockers.push(ArtifactBlocker {
                code: "MEDUSA_FILE_ROUTES_UNPARSED".to_string(),
                message: format!(
                    "{} Medusa file-router route file(s) under src/api/**/route.ts are not extracted; their endpoints are absent from this artifact",
                    medusa_file_routes.len()
                ),
                file: Some(medusa_file_routes[0].to_string()),
            });
        }

        // A tRPC server mounted on Express exposes procedures over one RPC endpoint, not
        // REST routes. Its procedures are absent, so the artifact must say so.
        let trpc_files: Vec<&str> = self
            .sources
            .iter()
            .filter(|(_, content)| content.contains("@trpc/server"))
            .map(|(path, _)| path.as_str())
            .collect();
        if !trpc_files.is_empty() {
            blockers.push(ArtifactBlocker {
                code: "TRPC_ROUTES_UNMODELED".to_string(),
                message: format!(
                    "{} file(s) build a tRPC server; its procedures are served over an RPC endpoint that this reader does not model, so they are absent from this artifact",
                    trpc_files.len()
                ),
                file: Some(trpc_files[0].to_string()),
            });
        }

        for ff in &self.file_facts {
            blockers.extend(ff.blockers.iter().cloned());
            for (name, wire) in &ff.declared_types {
                type_pool.insert(name.clone(), wire.clone());
            }

            for route in &ff.routes {
                let normalized = normalize_route_segments(&route.path);
                let verb = route.verb.clone();
                let identity = format!("{} {}", verb, route.path);

                // Extract path parameters from route path (:id -> id)
                let path_parameters: Vec<ParamContract> = route
                    .path
                    .split('/')
                    .filter(|s| s.starts_with(':'))
                    .map(|s| {
                        let param_name = s.trim_start_matches(':').to_string();
                        ParamContract {
                            name: param_name.clone(),
                            r#type: WireType::Primitive(PrimitiveWireType {
                                scalar: PrimitiveScalar::String,
                                format: None,
                                provenance: Some(self.prov(&ff.file, route.line, &param_name)),
                            }),
                            required: true,
                            validation_constraints: None,
                            provenance: Some(self.prov(&ff.file, route.line, &param_name)),
                        }
                    })
                    .collect();

                let mut response_body = route.res_type.as_ref().and_then(|rt| {
                    if rt == "Void" || rt == "void" {
                        return Some(WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::Void,
                            format: None,
                            provenance: Some(self.prov(&ff.file, route.line, rt)),
                        }));
                    }
                    if is_http_envelope_type(rt) {
                        return None;
                    }
                    Some(if let Some(existing) = type_pool.get(rt) {
                        existing.clone()
                    } else {
                        WireType::Ref(RefWireType {
                            r#ref: rt.clone(),
                            provenance: Some(self.prov(&ff.file, route.line, rt)),
                        })
                    })
                });
                if wire_body_unresolved(response_body.as_ref(), &type_pool) {
                    if let Some(literal_shape) = &route.response_shape {
                        response_body = Some(literal_shape.clone());
                    }
                }

                let response_unresolved = wire_body_unresolved(response_body.as_ref(), &type_pool);
                if response_unresolved {
                    unresolved_endpoints.push(format!("{verb} {}", route.path));
                }

                // Add response endpoint
                endpoints.push(EndpointContract {
                    identity: EndpointIdentityContract {
                        service: Some(service_id.to_string()),
                        http_method: verb.clone(),
                        normalized_route: normalized.clone(),
                        direction: ContractDirection::Response,
                    },
                    path_parameters: path_parameters.clone(),
                    query_parameters: Vec::new(),
                    headers: Vec::new(),
                    body: response_body,
                    provenance: self.prov(&ff.file, route.line, &format!("{}@RESPONSE", identity)),
                    evidence_classification: Some(EvidenceClassification::ImplementationDerived),
                    declared_responses: None,
                    status_code_family: Some(status_family(route.status)),
                    mapping_conditions: Some(serde_json::json!({
                        "params": [],
                        "complete": true
                    })),
                });

                // Request endpoint if path parameters or request body exist
                let request_body = route.req_type.as_ref().and_then(|qt| {
                    if is_http_envelope_type(qt) {
                        return None;
                    }
                    Some(if let Some(existing) = type_pool.get(qt) {
                        existing.clone()
                    } else {
                        WireType::Ref(RefWireType {
                            r#ref: qt.clone(),
                            provenance: Some(self.prov(&ff.file, route.line, qt)),
                        })
                    })
                });

                let body_may_exist = matches!(verb.as_str(), "POST" | "PUT" | "PATCH");
                let request_unresolved = body_may_exist
                    && match &request_body {
                        None => true,
                        Some(WireType::Ref(r)) => !type_pool.contains_key(&r.r#ref),
                        Some(WireType::Primitive(p)) => {
                            matches!(p.scalar, PrimitiveScalar::Any)
                        }
                        _ => false,
                    };
                if request_unresolved {
                    unresolved_endpoints.push(format!("{verb} {} request body", route.path));
                }

                if !path_parameters.is_empty() || request_body.is_some() {
                    endpoints.push(EndpointContract {
                        identity: EndpointIdentityContract {
                            service: Some(service_id.to_string()),
                            http_method: verb,
                            normalized_route: normalized.clone(),
                            direction: ContractDirection::Request,
                        },
                        path_parameters,
                        query_parameters: Vec::new(),
                        headers: Vec::new(),
                        body: request_body,
                        provenance: self.prov(
                            &ff.file,
                            route.line,
                            &format!("{}@REQUEST", identity),
                        ),
                        evidence_classification: Some(
                            EvidenceClassification::ImplementationDerived,
                        ),
                        declared_responses: None,
                        status_code_family: Some(StatusCodeFamily::Success2xx),
                        mapping_conditions: Some(serde_json::json!({
                            "params": [],
                            "complete": true
                        })),
                    });
                }
            }
        }

        endpoints.sort_by(|a, b| {
            a.identity
                .normalized_route
                .raw_path
                .cmp(&b.identity.normalized_route.raw_path)
                .then_with(|| a.identity.http_method.cmp(&b.identity.http_method))
                .then_with(|| match (&a.identity.direction, &b.identity.direction) {
                    (ContractDirection::Response, ContractDirection::Request) => {
                        std::cmp::Ordering::Less
                    }
                    (ContractDirection::Request, ContractDirection::Response) => {
                        std::cmp::Ordering::Greater
                    }
                    _ => std::cmp::Ordering::Equal,
                })
        });

        let payload = BackendContractPayload {
            serialization_assumptions: None,
            base_urls: vec![],
            proxy_prefixes: vec![],
            endpoints,
            type_pool: if type_pool.is_empty() {
                None
            } else {
                Some(type_pool)
            },
            path_pool: None,
        };

        unresolved_endpoints.sort();
        unresolved_endpoints.dedup();
        blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
        blockers.dedup();
        let completeness = ArtifactCompleteness {
            complete: blockers.is_empty() && unresolved_endpoints.is_empty(),
            unresolved_endpoints,
            blockers,
        };

        let mut env = ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::BackendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: repository_id.to_string(),
                service_id: service_id.to_string(),
                api_version: api_version.map(|v| v.to_string()),
                parent_commit: parent_commit.to_string(),
                candidate_snapshot: candidate_snapshot.to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: Some(self.framework_profile.to_string()),
                codec_profile: Some("JSON_STRINGIFY_V1".to_string()),
                client_profile: None,
                config_fingerprint: None,
            },
            completeness,
            payload: ArtifactPayload::Backend(payload),
            integrity: None,
            signature: None,
            issued_at_unix: None,
            raw_value: None,
        };

        let digest = compute_envelope_digest(&env)
            .map_err(|e| anyhow!("Failed to compute envelope digest: {}", e))?;
        env.integrity = Some(ArtifactIntegrity { sha256: digest });
        Ok(env)
    }
}
