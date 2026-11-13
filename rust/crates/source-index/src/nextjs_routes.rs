//! nextjs_routes.rs — Next.js App Router (TypeScript / JavaScript) provider contract extraction.
//!
//! Next.js App Router uses file-system based routing inside `app/` (or `src/app/`).
//! Route handlers are declared in `route.ts` or `route.js` files, and HTTP verbs are
//! exported as named functions (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`).
//!
//! Route paths are derived from the directory structure:
//! - Static segments: `app/api/users/route.ts` -> `/api/users`
//! - Dynamic segments: `app/api/users/[id]/route.ts` -> `/api/users/:id`
//! - Catch-all segments: `app/api/posts/[...slug]/route.ts` -> `/api/posts/:slug*`
//! - Optional catch-all segments: `app/api/items/[[...slug]]/route.ts` -> `/api/items/:slug*`
//! - Route groups: `app/(marketing)/about/route.ts` -> `/about` (group folders are omitted)
//! - Parallel routes: `app/@slot/...` (ignored from URL path)
//!
//! Shape evidence:
//! - Route params from URL path segments and `context: { params: ... }`
//! - Response bodies from return type annotations (`NextResponse<T>`, `Response`)
//! - Request bodies for POST/PUT/PATCH from typed request parameters or body DTOs
//! - Interfaces, types, and classes declared in route files are resolved into `type_pool`.

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
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

const NEXT_DIRS_TO_SKIP: &[&str] = &[
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".git",
    ".turbo",
];

const SUPPORTED_VERBS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

/// Derives the normalized HTTP route URL from a relative Next.js route file path.
pub fn route_from_file_path(rel_path: &str) -> Option<String> {
    let path = rel_path.replace('\\', "/");
    let without_ext = if let Some(p) = path.strip_suffix("/route.ts") {
        p
    } else if let Some(p) = path.strip_suffix("/route.js") {
        p
    } else if let Some(p) = path.strip_suffix("/route.tsx") {
        p
    } else if let Some(p) = path.strip_suffix("/route.jsx") {
        p
    } else {
        return None;
    };

    let app_sub = if without_ext == "app" || without_ext == "src/app" {
        ""
    } else if let Some(idx) = without_ext.find("/app/") {
        &without_ext[idx + 5..]
    } else if let Some(stripped) = without_ext.strip_prefix("app/") {
        stripped
    } else if let Some(stripped) = without_ext.strip_prefix("src/app/") {
        stripped
    } else {
        without_ext
    };

    let segments: Vec<&str> = app_sub
        .split('/')
        .filter(|s| !s.is_empty())
        .filter(|s| !(s.starts_with('(') && s.ends_with(')')))
        .filter(|s| !s.starts_with('@'))
        .collect();

    let mut route_segments = Vec::new();
    for seg in segments {
        if seg.starts_with("[[...") && seg.ends_with("]]") {
            let name = &seg[5..seg.len() - 2];
            route_segments.push(format!(":{}*", name));
        } else if seg.starts_with("[...") && seg.ends_with(']') {
            let name = &seg[4..seg.len() - 1];
            route_segments.push(format!(":{}*", name));
        } else if seg.starts_with('[') && seg.ends_with(']') {
            let name = &seg[1..seg.len() - 1];
            route_segments.push(format!(":{}", name));
        } else {
            route_segments.push(seg.to_string());
        }
    }

    if route_segments.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", route_segments.join("/")))
    }
}

pub fn is_nextjs_route_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized
        .split('/')
        .any(|p| NEXT_DIRS_TO_SKIP.contains(&p))
    {
        return false;
    }
    (normalized.ends_with("/route.ts")
        || normalized.ends_with("/route.js")
        || normalized.ends_with("/route.tsx")
        || normalized.ends_with("/route.jsx"))
        && (normalized.contains("/app/")
            || normalized.starts_with("app/")
            || normalized.starts_with("src/app/"))
}

/// The URL a `pages/api/**` handler serves. `index` names its directory; bracket
/// segments become route parameters.
pub fn route_from_pages_api_path(rel_path: &str) -> Option<String> {
    let path = rel_path.replace('\\', "/");
    let without_ext = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .find_map(|ext| path.strip_suffix(ext))?;
    let after_pages = if let Some(index) = without_ext.find("/pages/api/") {
        &without_ext[index + "/pages/".len()..]
    } else if let Some(rest) = without_ext.strip_prefix("pages/api/") {
        rest
    } else if let Some(rest) = without_ext.strip_prefix("src/pages/api/") {
        rest
    } else {
        return None;
    };
    // The API mount point is part of the URL: `pages/api/users.ts` serves `/api/users`.
    let after_pages = if after_pages.starts_with("api/") {
        after_pages.to_string()
    } else if after_pages == "api" {
        "api".to_string()
    } else {
        format!("api/{after_pages}")
    };
    let after_pages = after_pages.as_str();
    let mut segments: Vec<String> = after_pages
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            if segment.starts_with("[[...") && segment.ends_with("]]") {
                format!(":{}*", &segment[5..segment.len() - 2])
            } else if segment.starts_with("[...") && segment.ends_with(']') {
                format!(":{}*", &segment[4..segment.len() - 1])
            } else if segment.starts_with('[') && segment.ends_with(']') {
                format!(":{}", &segment[1..segment.len() - 1])
            } else {
                segment.to_string()
            }
        })
        .collect();
    if segments.last().is_some_and(|segment| segment == "index") {
        segments.pop();
    }
    if segments.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", segments.join("/")))
    }
}

/// A Pages Router backend has `pages/api/**` handlers and no App Router route file.
pub fn looks_like_nextjs_pages_root(root: &Path) -> bool {
    let package = match fs::read_to_string(root.join("package.json")) {
        Ok(content) => content,
        Err(_) => return false,
    };
    if !package.contains("\"next\"") {
        return false;
    }
    let mut files = Vec::new();
    let _ = walk_nextjs_files(root, &mut files);
    files.iter().any(|path| {
        let rel = path.to_string_lossy().replace('\\', "/");
        is_nextjs_pages_api_file(&rel)
    })
}

/// A Next.js config document. Only the `basePath` literal is read from it.
pub fn is_nextjs_config_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    matches!(
        normalized.rsplit('/').next().unwrap_or(""),
        "next.config.js" | "next.config.mjs" | "next.config.cjs" | "next.config.ts"
    )
}

/// A Pages Router API handler. The App Router extractor does not read these, but their
/// presence must be recorded when both routers coexist.
pub fn is_nextjs_pages_api_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized
        .split('/')
        .any(|p| NEXT_DIRS_TO_SKIP.contains(&p))
    {
        return false;
    }
    if normalized.ends_with(".d.ts") {
        return false;
    }
    let in_pages_api = normalized.starts_with("pages/api/") || normalized.contains("/pages/api/");
    in_pages_api
        && (normalized.ends_with(".ts")
            || normalized.ends_with(".tsx")
            || normalized.ends_with(".js")
            || normalized.ends_with(".jsx")
            || normalized.ends_with(".mjs")
            || normalized.ends_with(".cjs"))
}

/// The literal `basePath` a next.config document declares. A non-literal expression
/// cannot be resolved here, and the caller must publish routes as unprefixed *and* say so.
fn parse_next_base_path(content: &str) -> (String, bool) {
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        let Some(index) = line.find("basePath") else {
            continue;
        };
        let rest = line[index + "basePath".len()..].trim_start();
        let Some(rest) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('=')) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            return (String::new(), true);
        };
        let Some(end) = rest[1..].find(quote) else {
            return (String::new(), true);
        };
        let value = &rest[1..1 + end];
        if value.is_empty() {
            return (String::new(), false);
        }
        return if value.starts_with('/') {
            (value.to_string(), false)
        } else {
            (String::new(), true)
        };
    }
    (String::new(), false)
}

fn apply_base_path(base_path: &str, route: &str) -> String {
    let base = base_path.trim_end_matches('/');
    if base.is_empty() {
        return route.to_string();
    }
    if route == "/" {
        base.to_string()
    } else {
        format!("{base}{route}")
    }
}

pub fn looks_like_nextjs_root(root: &Path) -> bool {
    let mut files = Vec::new();
    let _ = walk_nextjs_files(root, &mut files);
    files.iter().any(|p| {
        let s = p.to_string_lossy().replace('\\', "/");
        is_nextjs_route_file(&s)
    })
}

fn walk_nextjs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if NEXT_DIRS_TO_SKIP.contains(&name.as_str()) {
                continue;
            }
            walk_nextjs_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

fn all_http_methods() -> Vec<String> {
    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
        .iter()
        .map(|verb| verb.to_string())
        .collect()
}

fn find_pages_handler<'a>(root: Node<'a>, content: &str) -> Option<Node<'a>> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "export_statement" {
            continue;
        }
        if !text(child, content)
            .trim_start()
            .starts_with("export default")
        {
            continue;
        }
        if let Some(declaration) = child.child_by_field_name("declaration") {
            match declaration.kind() {
                "function_declaration" | "arrow_function" | "function_expression" => {
                    return Some(declaration)
                }
                "identifier" => {
                    let name = text(declaration, content).trim();
                    if let Some(found) = find_named_function(root, content, name) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        let mut inner_cursor = child.walk();
        for part in child.named_children(&mut inner_cursor) {
            if matches!(part.kind(), "arrow_function" | "function_expression") {
                return Some(part);
            }
        }
    }
    None
}

fn find_named_function<'a>(root: Node<'a>, content: &str, name: &str) -> Option<Node<'a>> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        match child.kind() {
            "function_declaration" => {
                if child
                    .child_by_field_name("name")
                    .is_some_and(|node| text(node, content).trim() == name)
                {
                    return Some(child);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut decl_cursor = child.walk();
                for declarator in child.named_children(&mut decl_cursor) {
                    if declarator.kind() != "variable_declarator" {
                        continue;
                    }
                    let matches_name = declarator
                        .child_by_field_name("name")
                        .is_some_and(|node| text(node, content).trim() == name);
                    if matches_name {
                        if let Some(value) = declarator.child_by_field_name("value") {
                            if matches!(value.kind(), "arrow_function" | "function_expression") {
                                return Some(value);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Literal `req.method` comparisons and switch cases. No comparison means the handler
/// serves every method; a non-literal comparison is recorded as dynamic.
fn pages_methods(handler: Node, content: &str) -> (Vec<String>, bool) {
    if !text(handler, content).contains(".method") {
        return (all_http_methods(), false);
    }
    let mut verbs: Vec<String> = Vec::new();
    let mut dynamic = false;
    walk_nodes(handler, &mut |node| {
        if node.kind() == "binary_expression" {
            let operator = node
                .child_by_field_name("operator")
                .map(|operator| text(operator, content))
                .unwrap_or_default();
            if !matches!(operator, "===" | "==" | "!=" | "!==") {
                return;
            }
            let (Some(left), Some(right)) = (
                node.child_by_field_name("left"),
                node.child_by_field_name("right"),
            ) else {
                return;
            };
            let (method_side, other) = if text(left, content).trim().ends_with(".method") {
                (left, right)
            } else if text(right, content).trim().ends_with(".method") {
                (right, left)
            } else {
                return;
            };
            let _ = method_side;
            if other.kind() == "string" {
                let verb = unquote_string(text(other, content)).to_ascii_uppercase();
                if matches!(
                    verb.as_str(),
                    "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
                ) && !verbs.contains(&verb)
                {
                    verbs.push(verb);
                }
            } else {
                dynamic = true;
            }
        }
        if node.kind() == "switch_statement" {
            let matches_method = node
                .child_by_field_name("value")
                .is_some_and(|value| text(value, content).trim().ends_with(".method"));
            if !matches_method {
                return;
            }
            let mut case_cursor = node.walk();
            for case in node.named_children(&mut case_cursor) {
                if case.kind() != "switch_case" {
                    continue;
                }
                let mut value_cursor = case.walk();
                for value in case.named_children(&mut value_cursor) {
                    if value.kind() == "string" {
                        let verb = unquote_string(text(value, content)).to_ascii_uppercase();
                        if matches!(
                            verb.as_str(),
                            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
                        ) && !verbs.contains(&verb)
                        {
                            verbs.push(verb);
                        }
                        break;
                    }
                }
            }
        }
    });
    if verbs.is_empty() {
        return (all_http_methods(), dynamic);
    }
    verbs.sort();
    verbs.dedup();
    (verbs, dynamic)
}

fn pages_handler_types(handler: Node, content: &str) -> (Option<String>, Option<String>) {
    let mut res_type = None;
    let Some(params) = handler.child_by_field_name("parameters") else {
        return (None, None);
    };
    let mut cursor = params.walk();
    let parameters: Vec<Node> = params
        .named_children(&mut cursor)
        .filter(|node| matches!(node.kind(), "required_parameter" | "optional_parameter"))
        .collect();
    if let Some(second) = parameters.get(1) {
        if let Some(type_annotation) = second.child_by_field_name("type") {
            let raw = text(type_annotation, content)
                .trim_start_matches(':')
                .trim();
            let unwrapped = unwrap_generic(raw, "NextApiResponse");
            if !unwrapped.is_empty() && unwrapped != "any" && !is_next_envelope_type(&unwrapped) {
                res_type = Some(unwrapped);
            }
        }
    }
    (None, res_type)
}

/// `req.body as Foo` or `const body: Foo = req.body`.
fn pages_body_type(handler: Node, content: &str) -> Option<String> {
    let mut found = None;
    walk_nodes(handler, &mut |node| {
        if found.is_some() {
            return;
        }
        let raw = text(node, content).trim();
        if node.kind() == "as_expression" {
            if let Some(index) = raw.find(" as ") {
                let left = raw[..index].trim();
                if left.ends_with(".body") {
                    let ty = raw[index + 4..].trim().trim_end_matches(';').trim();
                    if !ty.is_empty() {
                        found = Some(ty.to_string());
                    }
                }
            }
            return;
        }
        if node.kind() == "variable_declarator" {
            let value_is_body = node
                .child_by_field_name("value")
                .is_some_and(|value| text(value, content).trim().ends_with(".body"));
            if !value_is_body {
                return;
            }
            let Some(name) = node.child_by_field_name("name") else {
                return;
            };
            if let Some(type_annotation) = name.child_by_field_name("type") {
                let ty = text(type_annotation, content)
                    .trim_start_matches(':')
                    .trim();
                if !ty.is_empty() {
                    found = Some(ty.to_string());
                }
            }
        }
    });
    found
}

fn is_pages_response_object(object_text: &str) -> bool {
    let root = object_text
        .trim()
        .split(".status(")
        .next()
        .unwrap_or(object_text)
        .trim();
    let last = root.rsplit('.').next().unwrap_or(root).trim();
    matches!(last, "res" | "response")
}

fn pages_status(object: Node, content: &str) -> Option<u16> {
    if object.kind() != "call_expression" {
        return None;
    }
    let function = object.child_by_field_name("function")?;
    if function.kind() != "member_expression" {
        return None;
    }
    let property = function.child_by_field_name("property")?;
    if text(property, content).trim() != "status" {
        return None;
    }
    let arguments = call_arguments(object);
    let first = arguments.first()?;
    if first.kind() != "number" {
        return None;
    }
    text(*first, content).trim().parse::<u16>().ok()
}

fn unquote_string(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = trimmed.as_bytes()[trimmed.len() - 1];
        if (first == b'"' && last == b'"')
            || (first == b'\'' && last == b'\'')
            || (first == b'`' && last == b'`')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn text<'a>(node: Node<'a>, src: &'a str) -> &'a str {
    &src[node.start_byte()..node.end_byte()]
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

#[derive(Debug, Clone)]
struct NextMethodFacts {
    verb: String,
    line: u32,
    params: Vec<String>,
    req_type: Option<String>,
    res_type: Option<String>,
    response_shape: Option<WireType>,
    status: Option<u16>,
}

#[derive(Debug, Clone)]
struct NextRouteFileFacts {
    file: String,
    route: String,
    methods: Vec<NextMethodFacts>,
    declared_types: Vec<(String, WireType)>,
    blockers: Vec<ArtifactBlocker>,
}

pub struct NextJsRouteExtractor {
    sources: Vec<(String, String)>,
    source_hashes: BTreeMap<String, String>,
    route_files: Vec<NextRouteFileFacts>,
    /// A `basePath` expression this reader cannot resolve. Routes would be published
    /// without their real prefix, so the artifact must say so.
    base_path_unresolved: bool,
}

impl NextJsRouteExtractor {
    pub fn new(repo_root: PathBuf, src_dir: &Path) -> Result<Self> {
        let mut files = Vec::new();
        walk_nextjs_files(src_dir, &mut files)?;
        files.sort();
        let mut sources = Vec::new();
        for path in files {
            let rel = path
                .strip_prefix(&repo_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
            if is_nextjs_route_file(&rel)
                || is_nextjs_config_file(&rel)
                || is_nextjs_pages_api_file(&rel)
            {
                if let Ok(content) = fs::read_to_string(&path) {
                    sources.push((rel, content));
                }
            }
        }
        Self::from_sources(sources)
    }

    pub fn from_blobs(_repo_root: PathBuf, sources: Vec<(String, String)>) -> Result<Self> {
        Self::from_sources(sources)
    }

    pub fn from_sources(mut sources: Vec<(String, String)>) -> Result<Self> {
        sources.sort_by(|a, b| a.0.cmp(&b.0));
        sources.dedup_by(|a, b| a.0 == b.0);
        let (base_path, base_path_unresolved) = sources
            .iter()
            .find(|(path, _)| is_nextjs_config_file(path))
            .map(|(_, content)| parse_next_base_path(content))
            .unwrap_or_default();
        sources.retain(|(path, _)| is_nextjs_route_file(path) || is_nextjs_pages_api_file(path));

        let mut extractor = Self {
            sources: Vec::new(),
            source_hashes: BTreeMap::new(),
            route_files: Vec::new(),
            base_path_unresolved,
        };

        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
            .map_err(|e| anyhow!("Failed to set tree-sitter TypeScript language: {}", e))?;

        for (path, content) in &sources {
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            extractor
                .source_hashes
                .insert(path.clone(), hex::encode(hasher.finalize()));

            let route_source = route_from_file_path(path)
                .map(|route| (route, false))
                .or_else(|| route_from_pages_api_path(path).map(|route| (route, true)));
            if let Some((route, is_pages)) = route_source {
                let route = apply_base_path(&base_path, &route);
                let facts = if is_pages {
                    extractor.ingest_pages_route_file(&mut parser, path, content, &route)
                } else {
                    extractor.ingest_route_file(&mut parser, path, content, &route)
                };
                if let Some(facts) = facts {
                    extractor.route_files.push(facts);
                }
            }
        }

        extractor.sources = sources;
        Ok(extractor)
    }

    pub fn endpoints_count(&self) -> usize {
        self.route_files.iter().map(|r| r.methods.len()).sum()
    }

    fn ingest_route_file(
        &self,
        parser: &mut Parser,
        rel_path: &str,
        content: &str,
        route: &str,
    ) -> Option<NextRouteFileFacts> {
        let tree = parser.parse(content, None)?;
        let root = tree.root_node();
        let mut cursor = root.walk();

        let mut methods = Vec::new();
        let mut declared_types = Vec::new();
        let mut blockers = Vec::new();
        if root.has_error() {
            blockers.push(ArtifactBlocker {
                code: "NEXTJS_PARSE_ERROR".to_string(),
                message: "The route file does not parse as TypeScript/JavaScript; handlers after the syntax error are absent from this artifact and its emptiness is not evidence of absence".to_string(),
                file: Some(rel_path.to_string()),
            });
        }

        // Extract path parameters from the route path (e.g. :id -> id)
        let route_params: Vec<String> = route
            .split('/')
            .filter(|s| s.starts_with(':'))
            .map(|s| s.trim_start_matches(':').trim_end_matches('*').to_string())
            .collect();

        for child in root.children(&mut cursor) {
            match child.kind() {
                "interface_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = text(name_node, content).to_string();
                        let wire = self.parse_interface_to_wire(child, content, rel_path, &name);
                        declared_types.push((name, wire));
                    }
                }
                "type_alias_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = text(name_node, content).to_string();
                        if let Some(val_node) = child.child_by_field_name("value") {
                            let wire =
                                self.parse_type_value_to_wire(val_node, content, rel_path, &name);
                            declared_types.push((name, wire));
                        }
                    }
                }
                "export_statement" => {
                    // Look for exported function or const declaration
                    let mut export_cursor = child.walk();
                    for exp_child in child.children(&mut export_cursor) {
                        match exp_child.kind() {
                            "interface_declaration" => {
                                if let Some(name_node) = exp_child.child_by_field_name("name") {
                                    let name = text(name_node, content).to_string();
                                    let wire = self.parse_interface_to_wire(
                                        exp_child, content, rel_path, &name,
                                    );
                                    declared_types.push((name, wire));
                                }
                            }
                            "type_alias_declaration" => {
                                if let Some(name_node) = exp_child.child_by_field_name("name") {
                                    let name = text(name_node, content).to_string();
                                    if let Some(val_node) = exp_child.child_by_field_name("value") {
                                        let wire = self.parse_type_value_to_wire(
                                            val_node, content, rel_path, &name,
                                        );
                                        declared_types.push((name, wire));
                                    }
                                }
                            }
                            "function_declaration" => {
                                if let Some(name_node) = exp_child.child_by_field_name("name") {
                                    let name = text(name_node, content);
                                    if SUPPORTED_VERBS.contains(&name) {
                                        let line = line_of(exp_child);
                                        let (req_type, res_type) =
                                            self.extract_handler_types(exp_child, content);
                                        let req_type = req_type.or_else(|| {
                                            self.extract_request_body_type(exp_child, content)
                                        });
                                        let (response_shape, status) = self
                                            .extract_response_shape(exp_child, content, rel_path);
                                        methods.push(NextMethodFacts {
                                            verb: name.to_string(),
                                            line,
                                            params: route_params.clone(),
                                            req_type,
                                            res_type,
                                            response_shape,
                                            status,
                                        });
                                    }
                                }
                            }
                            "lexical_declaration" => {
                                let mut decl_cursor = exp_child.walk();
                                for decl in exp_child.children(&mut decl_cursor) {
                                    if decl.kind() == "variable_declarator" {
                                        if let Some(name_node) = decl.child_by_field_name("name") {
                                            let name = text(name_node, content);
                                            if SUPPORTED_VERBS.contains(&name) {
                                                let line = line_of(decl);
                                                let (req_type, res_type) = if let Some(val) =
                                                    decl.child_by_field_name("value")
                                                {
                                                    self.extract_handler_types(val, content)
                                                } else {
                                                    (None, None)
                                                };
                                                let handler = decl
                                                    .child_by_field_name("value")
                                                    .unwrap_or(decl);
                                                let req_type = req_type.or_else(|| {
                                                    self.extract_request_body_type(handler, content)
                                                });
                                                let (response_shape, status) = self
                                                    .extract_response_shape(
                                                        handler, content, rel_path,
                                                    );
                                                methods.push(NextMethodFacts {
                                                    verb: name.to_string(),
                                                    line,
                                                    params: route_params.clone(),
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
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }

        if methods.is_empty() && blockers.is_empty() {
            None
        } else {
            Some(NextRouteFileFacts {
                file: rel_path.to_string(),
                route: route.to_string(),
                methods,
                declared_types,
                blockers,
            })
        }
    }

    /// Pages Router API handlers export one default function and dispatch on `req.method`.
    /// The route comes from the file path; methods come from literal comparisons/switch
    /// cases, and an unconditional handler legitimately serves every standard method.
    fn ingest_pages_route_file(
        &self,
        parser: &mut Parser,
        rel_path: &str,
        content: &str,
        route: &str,
    ) -> Option<NextRouteFileFacts> {
        let tree = parser.parse(content, None)?;
        let root = tree.root_node();
        let mut blockers = Vec::new();
        if root.has_error() {
            blockers.push(ArtifactBlocker {
                code: "NEXTJS_PARSE_ERROR".to_string(),
                message: "The Pages Router handler does not parse as TypeScript/JavaScript; handlers after the syntax error are absent from this artifact".to_string(),
                file: Some(rel_path.to_string()),
            });
        }
        let declared_types = self.collect_pages_declared_types(root, content, rel_path);
        let route_params: Vec<String> = route
            .split('/')
            .filter(|segment| segment.starts_with(':'))
            .map(|segment| {
                segment
                    .trim_start_matches(':')
                    .trim_end_matches('*')
                    .to_string()
            })
            .collect();

        let mut methods = Vec::new();
        match find_pages_handler(root, content) {
            Some(handler) => {
                let (verbs, dynamic) = pages_methods(handler, content);
                if dynamic {
                    blockers.push(ArtifactBlocker {
                        code: "NEXTJS_PAGES_METHOD_DYNAMIC".to_string(),
                        message: "The Pages Router handler compares `req.method` against a non-literal value; methods are published as the full standard set and may be narrower at runtime".to_string(),
                        file: Some(rel_path.to_string()),
                    });
                }
                let (req_type, res_type) = pages_handler_types(handler, content);
                let req_type = req_type.or_else(|| pages_body_type(handler, content));
                let (response_shape, status) = self.pages_response(handler, content, rel_path);
                for verb in verbs {
                    methods.push(NextMethodFacts {
                        verb,
                        line: line_of(handler),
                        params: route_params.clone(),
                        req_type: req_type.clone(),
                        res_type: res_type.clone(),
                        response_shape: response_shape.clone(),
                        status,
                    });
                }
            }
            None => blockers.push(ArtifactBlocker {
                code: "NEXTJS_PAGES_HANDLER_UNRESOLVED".to_string(),
                message: "No default-exported handler was found in this Pages Router API file; its endpoints are absent from this artifact".to_string(),
                file: Some(rel_path.to_string()),
            }),
        }

        if methods.is_empty() && blockers.is_empty() {
            return None;
        }
        Some(NextRouteFileFacts {
            file: rel_path.to_string(),
            route: route.to_string(),
            methods,
            declared_types,
            blockers,
        })
    }

    fn collect_pages_declared_types(
        &self,
        root: Node,
        content: &str,
        rel_path: &str,
    ) -> Vec<(String, WireType)> {
        let mut declared_types = Vec::new();
        let mut cursor = root.walk();
        for child in root.children(&mut cursor) {
            match child.kind() {
                "interface_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        let name = text(name, content).to_string();
                        let wire = self.parse_interface_to_wire(child, content, rel_path, &name);
                        declared_types.push((name, wire));
                    }
                }
                "type_alias_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        let name = text(name, content).to_string();
                        if let Some(value) = child.child_by_field_name("value") {
                            let wire =
                                self.parse_type_value_to_wire(value, content, rel_path, &name);
                            declared_types.push((name, wire));
                        }
                    }
                }
                "export_statement" => {
                    let mut export_cursor = child.walk();
                    for part in child.named_children(&mut export_cursor) {
                        match part.kind() {
                            "interface_declaration" => {
                                if let Some(name) = part.child_by_field_name("name") {
                                    let name = text(name, content).to_string();
                                    let wire = self
                                        .parse_interface_to_wire(part, content, rel_path, &name);
                                    declared_types.push((name, wire));
                                }
                            }
                            "type_alias_declaration" => {
                                if let Some(name) = part.child_by_field_name("name") {
                                    let name = text(name, content).to_string();
                                    if let Some(value) = part.child_by_field_name("value") {
                                        let wire = self.parse_type_value_to_wire(
                                            value, content, rel_path, &name,
                                        );
                                        declared_types.push((name, wire));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        declared_types
    }

    fn pages_response(
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
            if node.kind() != "call_expression" {
                return;
            }
            let Some(func) = node.child_by_field_name("function") else {
                return;
            };
            if func.kind() != "member_expression" {
                return;
            }
            let (Some(object), Some(property)) = (
                func.child_by_field_name("object"),
                func.child_by_field_name("property"),
            ) else {
                return;
            };
            let property = text(property, content).trim();
            if !matches!(property, "json" | "send" | "end") {
                return;
            }
            let object_text = text(object, content).trim();
            if !is_pages_response_object(object_text) {
                return;
            }
            if let Some(value) = pages_status(object, content) {
                status = Some(value);
            }
            let args = call_arguments(node);
            if let Some(first) = args.first() {
                if first.kind() == "null" {
                    shape = Some(void_wire(&self.prov(
                        rel_path,
                        line_of(*first),
                        "response-null",
                    )));
                } else if let Some(object_shape) = response_shape_wire(*first, &ctx) {
                    shape = Some(object_shape);
                }
            }
        });
        if status == Some(204) && shape.is_none() {
            shape = Some(void_wire(&self.prov(
                rel_path,
                handler.start_position().row as u32 + 1,
                "response-204",
            )));
        }
        (shape, status)
    }

    fn extract_handler_types(
        &self,
        func_node: Node,
        content: &str,
    ) -> (Option<String>, Option<String>) {
        let mut req_type = None;
        let mut res_type = None;

        if let Some(params) = func_node.child_by_field_name("parameters") {
            let mut cursor = params.walk();
            let mut first_param = None;
            for c in params.children(&mut cursor) {
                if c.kind() == "required_parameter" || c.kind() == "optional_parameter" {
                    first_param = Some(c);
                    break;
                }
            }
            if let Some(param) = first_param {
                if let Some(type_ann) = param.child_by_field_name("type") {
                    let raw = text(type_ann, content).trim_start_matches(':').trim();
                    // In the App Router the first parameter is the web Request
                    // envelope. The body lives behind `await request.json()`, so
                    // naming the envelope as a DTO fabricates a contract.
                    if !is_next_envelope_type(raw) {
                        req_type = Some(raw.to_string());
                    }
                }
            }
        }

        if let Some(ret) = func_node.child_by_field_name("return_type") {
            let raw = text(ret, content).trim_start_matches(':').trim();
            // Unwrap Promise<NextResponse<T>> or NextResponse<T>
            let unwrapped = unwrap_generic(raw, "Promise");
            let unwrapped = unwrap_generic(&unwrapped, "NextResponse");
            let unwrapped = unwrap_generic(&unwrapped, "Response");
            if unwrapped == "void" || unwrapped == "Void" {
                res_type = Some("Void".to_string());
            } else if !unwrapped.is_empty()
                && unwrapped != "any"
                && !is_next_envelope_type(&unwrapped)
            {
                res_type = Some(unwrapped);
            }
        }

        (req_type, res_type)
    }

    /// Read `const body: Type = await request.json()` (and the `as Type`
    /// variant). The App Router request envelope is not a body; this is the
    /// only place the body type is declared.
    fn extract_request_body_type(&self, handler: Node, content: &str) -> Option<String> {
        let mut found = None;
        walk_nodes(handler, &mut |node| {
            if found.is_some() || node.kind() != "variable_declarator" {
                return;
            }
            let raw = text(node, content);
            if !raw.contains(".json()") {
                return;
            }
            if let Some(eq) = raw.find('=') {
                let left = &raw[..eq];
                if let Some(colon) = left.find(':') {
                    let ty = left[colon + 1..].trim();
                    if !ty.is_empty() && !is_next_envelope_type(ty) {
                        found = Some(ty.to_string());
                        return;
                    }
                }
            }
            if let Some(as_index) = raw.rfind(" as ") {
                let ty = raw[as_index + 4..].trim().trim_end_matches(';').trim();
                if !ty.is_empty() && !is_next_envelope_type(ty) {
                    found = Some(ty.to_string());
                }
            }
        });
        found
    }

    /// Read `NextResponse.json({...})` / `Response.json({...})` /
    /// `new Response(JSON.stringify({...}), { status })`. Computed bodies stay
    /// `None` and the endpoint is reported as unresolved.
    fn extract_response_shape(
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
                let object_text = text(object, content).trim();
                let property = text(property, content).trim();
                if property == "json"
                    && (object_text.ends_with("NextResponse") || object_text.ends_with("Response"))
                {
                    let args = call_arguments(node);
                    if let Some(first) = args.first() {
                        if let Some(object_shape) = response_shape_wire(*first, &ctx) {
                            shape = Some(object_shape);
                        } else if first.kind() == "null" {
                            shape = Some(void_wire(&self.prov(
                                rel_path,
                                line_of(*first),
                                "response-null",
                            )));
                        }
                    }
                    if let Some(second) = args.get(1) {
                        if let Some(value) = object_number_property(*second, content, "status") {
                            status = value.parse::<u16>().ok();
                        }
                    }
                }
            } else if node.kind() == "new_expression" {
                let Some(constructor) = node.child_by_field_name("constructor") else {
                    return;
                };
                if !text(constructor, content).trim().ends_with("Response") {
                    return;
                }
                let args = call_arguments(node);
                if let Some(first) = args.first() {
                    if first.kind() == "null" {
                        shape = Some(void_wire(&self.prov(
                            rel_path,
                            line_of(*first),
                            "response-null",
                        )));
                    } else if first.kind() == "call_expression" {
                        if let Some(func) = first.child_by_field_name("function") {
                            if text(func, content).trim().ends_with("JSON.stringify") {
                                let nested = call_arguments(*first);
                                if let Some(inner) = nested.first() {
                                    if let Some(object_shape) = response_shape_wire(*inner, &ctx) {
                                        shape = Some(object_shape);
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(second) = args.get(1) {
                    if let Some(value) = object_number_property(*second, content, "status") {
                        status = value.parse::<u16>().ok();
                    }
                }
            }
        });
        if status == Some(204) && shape.is_none() {
            shape = Some(void_wire(&self.prov(
                rel_path,
                handler.start_position().row as u32 + 1,
                "response-204",
            )));
        }
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

        if self.base_path_unresolved {
            blockers.push(ArtifactBlocker {
                code: "NEXTJS_BASE_PATH_UNRESOLVED".to_string(),
                message: "next.config declares a basePath this reader cannot resolve to a literal; routes are published without that prefix".to_string(),
                file: Some("next.config".to_string()),
            });
        }

        for rf in &self.route_files {
            blockers.extend(rf.blockers.iter().cloned());
            for (name, wire) in &rf.declared_types {
                type_pool.insert(name.clone(), wire.clone());
            }

            let normalized = normalize_route_segments(&rf.route);

            for method in &rf.methods {
                let verb = method.verb.to_ascii_uppercase();
                let identity = format!("{} {}", verb, rf.route);

                let path_parameters: Vec<ParamContract> = method
                    .params
                    .iter()
                    .map(|p| ParamContract {
                        name: p.clone(),
                        r#type: WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::String,
                            format: None,
                            provenance: Some(self.prov(&rf.file, method.line, p)),
                        }),
                        required: true,
                        validation_constraints: None,
                        provenance: Some(self.prov(&rf.file, method.line, p)),
                    })
                    .collect();

                let mut response_body = method.res_type.as_ref().and_then(|rt| {
                    if rt == "Void" || rt == "void" {
                        return Some(WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::Void,
                            format: None,
                            provenance: Some(self.prov(&rf.file, method.line, rt)),
                        }));
                    }
                    if is_next_envelope_type(rt) {
                        return None;
                    }
                    Some(if let Some(existing) = type_pool.get(rt) {
                        existing.clone()
                    } else {
                        WireType::Ref(RefWireType {
                            r#ref: rt.clone(),
                            provenance: Some(self.prov(&rf.file, method.line, rt)),
                        })
                    })
                });
                if wire_body_unresolved(response_body.as_ref(), &type_pool) {
                    if let Some(literal_shape) = &method.response_shape {
                        response_body = Some(literal_shape.clone());
                    }
                }

                let response_unresolved = wire_body_unresolved(response_body.as_ref(), &type_pool);
                if response_unresolved {
                    unresolved_endpoints.push(format!("{verb} {}", rf.route));
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
                    provenance: self.prov(&rf.file, method.line, &format!("{}@RESPONSE", identity)),
                    evidence_classification: Some(EvidenceClassification::ImplementationDerived),
                    declared_responses: None,
                    status_code_family: Some(status_family(method.status)),
                    mapping_conditions: Some(serde_json::json!({
                        "params": [],
                        "complete": true
                    })),
                });

                // Request endpoint if path parameters or request body exist
                let request_body = method.req_type.as_ref().and_then(|qt| {
                    if is_next_envelope_type(qt) {
                        return None;
                    }
                    Some(if let Some(existing) = type_pool.get(qt) {
                        existing.clone()
                    } else {
                        WireType::Ref(RefWireType {
                            r#ref: qt.clone(),
                            provenance: Some(self.prov(&rf.file, method.line, qt)),
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
                    unresolved_endpoints.push(format!("{verb} {} request body", rf.route));
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
                            &rf.file,
                            method.line,
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
                framework_profile: Some("NEXTJS".to_string()),
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

fn walk_nodes(node: Node, visit: &mut dyn FnMut(Node)) {
    visit(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_nodes(child, &mut *visit);
    }
}

fn call_arguments(node: Node) -> Vec<Node> {
    let Some(args) = node.child_by_field_name("arguments") else {
        return Vec::new();
    };
    let mut cursor = args.walk();
    args.named_children(&mut cursor).collect()
}

fn object_number_property(node: Node, content: &str, key: &str) -> Option<String> {
    if node.kind() != "object" {
        return None;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "pair" {
            continue;
        }
        let Some(key_node) = child.child_by_field_name("key") else {
            continue;
        };
        let key_text = text(key_node, content)
            .trim()
            .trim_matches(|c| c == '\'' || c == '"');
        if key_text != key {
            continue;
        }
        let Some(value) = child.child_by_field_name("value") else {
            continue;
        };
        if value.kind() == "number" {
            return Some(text(value, content).trim().to_string());
        }
    }
    None
}

fn void_wire(provenance: &SourceProvenance) -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::Void,
        format: None,
        provenance: Some(provenance.clone()),
    })
}

fn is_next_envelope_type(type_text: &str) -> bool {
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
        "Request" | "Response" | "NextRequest" | "NextResponse" | "Headers"
    )
}

fn unwrap_generic(type_str: &str, wrapper: &str) -> String {
    let t = type_str.trim();
    if t.starts_with(wrapper) {
        let rest = t[wrapper.len()..].trim();
        if rest.starts_with('<') && rest.ends_with('>') {
            return rest[1..rest.len() - 1].trim().to_string();
        }
    }
    t.to_string()
}
