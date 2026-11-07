//! nestjs_routes.rs — NestJS (TypeScript) provider contract extraction.
//!
//! The Java lane indexes Spring MVC annotations. This module does the same for the
//! decorator-driven NestJS provider surface, so a TypeScript backend can enter the
//! same contract IR instead of being classified as consumer source.
//!
//! Discovery is declaration-driven, never a directory scan: a class is a controller
//! only when it carries `@Controller` and the file imports that decorator from
//! `@nestjs/common`. Route paths come from the class decorator plus the method
//! decorator (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`,
//! `@All`), and a `setGlobalPrefix('api')` call in the scanned sources is applied to
//! every route, because the client sees the prefixed path.
//!
//! Shape evidence:
//! * Request bodies come from `@Body()` parameter types; a string argument
//!   (`@Body('article')`) wraps the type under that key, which is what Nest passes
//!   to the handler.
//! * Response bodies come from the handler return type with `Promise`/`PromiseLike`
//!   unwrapped. An absent annotation is `any` (unconstrained), matching the Java
//!   lane's treatment of a method with no declared response: the endpoint exists,
//!   but no shape is asserted.
//! * Interfaces, classes, type aliases and string/number enums declared in the same
//!   source set are resolved by import first, then by a unique repository-wide name.
//!   Named types become `Ref` entries in `type_pool`, so recursive entities terminate
//!   through the same expansion guard the Java lane uses.
//! * Parameter decorators outside the standard Nest set (`@User('id')` and other
//!   auth helpers) are request-scoped values, like Spring's `Principal`; they are not
//!   wire shape and do not make the artifact incomplete. An untyped `@Query()` or
//!   `@Body()` is a genuine unknown and is recorded as a blocker.
//!
//! Output is deterministic: sources are sorted by path, endpoints by route and method,
//! and every map is a `BTreeMap`.

use anyhow::{anyhow, Result};
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ArrayWireType, ContractDirection, EndpointContract, EndpointIdentityContract, EnumWireType,
    EvidenceClassification, LiteralWireType, MapWireType, NullableWireType, ObjectWireType,
    ParamContract, PrimitiveScalar, PrimitiveWireType, RefWireType, SourceLanguage,
    SourceProvenance, StatusCodeFamily, UnionWireType, UnknownWireType, ValidationConstraint,
    ValidationConstraintKind, WirePropertyContract, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use contract_core::routes::normalize_route_segments;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

const SUPPORTED_VERBS: &[&str] = &[
    "Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All",
];

const PROVIDER_DIRS: &[&str] = &["node_modules", "dist", "build", "coverage", ".git", ".next"];

// ---------------------------------------------------------------------------
// Facts collected from one source file
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeclKind {
    Interface,
    Class,
    Alias,
    Enum,
}

#[derive(Debug, Clone)]
struct RawProperty {
    name: String,
    type_text: Option<String>,
    optional: bool,
    validations: Vec<ValidationConstraint>,
    line: u32,
}

#[derive(Debug, Clone)]
struct TypeDecl {
    name: String,
    file: String,
    line: u32,
    kind: DeclKind,
    alias_text: Option<String>,
    properties: Vec<RawProperty>,
    enum_values: Vec<serde_json::Value>,
    bases: Vec<String>,
    opaque: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParamKind {
    Path,
    Query,
    Body,
    Header,
    Ignored,
    Multipart,
}

#[derive(Debug, Clone)]
struct ParamFacts {
    kind: ParamKind,
    /// Literal argument of the decorator (`@Param('slug')`), when one was given.
    name: Option<String>,
    type_text: Option<String>,
}

#[derive(Debug, Clone)]
struct MethodFacts {
    name: String,
    line: u32,
    http: Option<(String, Vec<String>)>,
    path_unresolved: bool,
    params: Vec<ParamFacts>,
    return_text: Option<String>,
    declared_responses: Vec<(Option<u16>, String)>,
}

#[derive(Debug, Clone)]
struct ControllerFacts {
    file: String,
    name: String,
    prefixes: Vec<String>,
    prefix_unresolved: bool,
    methods: Vec<MethodFacts>,
    /// Request/response surfaces this reader does not model: runtime response objects,
    /// server-sent events, and URI versioning declared on the controller.
    blockers: Vec<(&'static str, String)>,
}

// ---------------------------------------------------------------------------
// Decorator argument model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Arg {
    Str(String),
    Strings(Vec<String>),
    Number(f64),
    Bool(bool),
    Ident(String),
    Object(Vec<(String, Arg)>),
    Raw,
}

impl Arg {
    fn first_string(&self) -> Option<String> {
        match self {
            Arg::Str(s) => Some(s.clone()),
            Arg::Strings(values) => values.first().cloned(),
            _ => None,
        }
    }

    fn string_list(&self) -> Option<Vec<String>> {
        match self {
            Arg::Str(s) => Some(vec![s.clone()]),
            Arg::Strings(values) => Some(values.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct Decorator {
    name: String,
    args: Vec<Arg>,
}

impl Decorator {
    fn object_field(&self, key: &str) -> Option<&Arg> {
        self.args.iter().find_map(|arg| match arg {
            Arg::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, value)| value),
            _ => None,
        })
    }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

pub struct NestJsRouteExtractor {
    sources: Vec<(String, String)>,
    source_hashes: BTreeMap<String, String>,
    types: BTreeMap<String, Vec<TypeDecl>>,
    imports: BTreeMap<String, BTreeMap<String, String>>,
    controllers: Vec<ControllerFacts>,
    parse_blockers: Vec<ArtifactBlocker>,
    global_prefix: Option<String>,
    config_fingerprint: String,
}

impl NestJsRouteExtractor {
    /// Read every `.ts` file below `ts_dir` from the working tree. Provenance paths
    /// are repository-relative, matching the Java lane and the sealed consumer
    /// artifacts, so a working-tree extraction and a revision extraction of the
    /// same source text agree byte for byte.
    pub fn new(repo_root: PathBuf, ts_dir: &Path) -> Result<Self> {
        let mut files = Vec::new();
        walk_ts(ts_dir, &mut files)?;
        files.sort();
        let mut sources = Vec::with_capacity(files.len());
        for path in files {
            let content = fs::read_to_string(&path)
                .map_err(|e| anyhow!("Cannot read TypeScript source {:?}: {}", path, e))?;
            let rel = path
                .strip_prefix(&repo_root)
                .map(path_to_posix)
                .unwrap_or_else(|_| path_to_posix(&path));
            sources.push((rel, content));
        }
        Self::from_sources(sources)
    }

    /// Build from caller-supplied text without touching the working tree. Paths are
    /// repository-relative POSIX strings, as Git reports them. `_repo_root` keeps the
    /// call shape of `new`; provenance already carries repository-relative paths.
    pub fn from_blobs(_repo_root: PathBuf, sources: Vec<(String, String)>) -> Result<Self> {
        Self::from_sources(sources)
    }

    fn from_sources(mut sources: Vec<(String, String)>) -> Result<Self> {
        sources.retain(|(path, _)| is_provider_ts_file(path));
        sources.sort_by(|a, b| a.0.cmp(&b.0));
        sources.dedup_by(|a, b| a.0 == b.0);

        let mut extractor = Self {
            sources: Vec::new(),
            source_hashes: BTreeMap::new(),
            types: BTreeMap::new(),
            imports: BTreeMap::new(),
            controllers: Vec::new(),
            parse_blockers: Vec::new(),
            global_prefix: None,
            config_fingerprint: String::new(),
        };

        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
            .map_err(|e| anyhow!("Failed to set tree-sitter TypeScript language: {}", e))?;

        let mut prefix_candidates: BTreeSet<String> = BTreeSet::new();
        for (path, content) in &sources {
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            extractor
                .source_hashes
                .insert(path.clone(), hex::encode(hasher.finalize()));
            extractor.ingest(&mut parser, path, content, &mut prefix_candidates);
        }

        extractor.sources = sources;
        extractor.global_prefix = match prefix_candidates.len() {
            0 => None,
            1 => prefix_candidates.into_iter().next(),
            _ => {
                let values = prefix_candidates.into_iter().collect::<Vec<_>>().join(", ");
                extractor.parse_blockers.push(ArtifactBlocker {
                    code: "NESTJS_GLOBAL_PREFIX_AMBIGUOUS".to_string(),
                    message: format!(
                        "Multiple `setGlobalPrefix` values were found ({}); no prefix was applied to the extracted routes, so client paths that include one will not link",
                        values
                    ),
                    file: None,
                });
                None
            }
        };

        let mut hasher = Sha256::new();
        hasher.update(b"nestjs:global-prefix=");
        hasher.update(extractor.global_prefix.as_deref().unwrap_or("").as_bytes());
        extractor.config_fingerprint = hex::encode(hasher.finalize());
        Ok(extractor)
    }

    pub fn sources(&self) -> &[(String, String)] {
        &self.sources
    }

    pub fn controller_count(&self) -> usize {
        self.controllers.len()
    }

    pub fn global_prefix(&self) -> Option<&str> {
        self.global_prefix.as_deref()
    }

    fn ingest(
        &mut self,
        parser: &mut Parser,
        rel_path: &str,
        content: &str,
        prefix_candidates: &mut BTreeSet<String>,
    ) {
        let Some(tree) = parser.parse(content, None) else {
            self.parse_blockers.push(ArtifactBlocker {
                code: "NESTJS_PARSE_ERROR".to_string(),
                message: "The TypeScript parser returned no tree; controllers and types in this file are absent"
                    .to_string(),
                file: Some(rel_path.to_string()),
            });
            return;
        };
        if tree.root_node().has_error() {
            self.parse_blockers.push(ArtifactBlocker {
                code: "NESTJS_PARSE_ERROR".to_string(),
                message: "The file contains syntax the TypeScript grammar could not read; controller and type discovery in it may be incomplete"
                    .to_string(),
                file: Some(rel_path.to_string()),
            });
        }
        // URI versioning inserts a path segment this reader does not derive. Header and
        // media-type versioning do not change the route and need no blocker.
        if content.contains("enableVersioning") && content.contains("VersioningType.URI") {
            self.parse_blockers.push(ArtifactBlocker {
                code: "NESTJS_URI_VERSIONING_UNMODELED".to_string(),
                message: "The application enables URI versioning; version segments are not derived, so a client route that includes one will not link".to_string(),
                file: Some(rel_path.to_string()),
            });
        }

        let root = tree.root_node();
        // `setGlobalPrefix` can sit anywhere a call expression can, including a
        // bootstrap function body, so the prefix is collected by a targeted walk
        // over the whole file rather than by the declaration visitor.
        collect_global_prefix(root, content, prefix_candidates);
        let mut cursor = root.walk();
        for child in root.children(&mut cursor) {
            self.ingest_top_level(child, content, rel_path, prefix_candidates, &[]);
        }
    }

    fn ingest_top_level(
        &mut self,
        node: Node,
        src: &str,
        rel_path: &str,
        prefix_candidates: &mut BTreeSet<String>,
        inherited: &[Decorator],
    ) {
        match node.kind() {
            "import_statement" => self.parse_import(node, src, rel_path),
            "interface_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => {
                // A decorated `export class` carries its decorators on the
                // `export_statement`, one level above the declaration itself.
                let mut decorators = inherited.to_vec();
                decorators.extend(decorators_of(node, src));
                self.ingest_declaration(node, src, rel_path, &decorators)
            }
            "export_statement" | "ambient_declaration" | "declaration" => {
                let mut decorators = inherited.to_vec();
                decorators.extend(decorators_of(node, src));
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    self.ingest_top_level(child, src, rel_path, prefix_candidates, &decorators);
                }
            }
            _ => {}
        }
    }

    fn parse_import(&mut self, node: Node, src: &str, rel_path: &str) {
        let Some(source_node) = node.child_by_field_name("source") else {
            return;
        };
        let module = unquote(text(source_node, src));
        let entry = self.imports.entry(rel_path.to_string()).or_default();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "import_clause" => {
                    let mut clause_cursor = child.walk();
                    for part in child.children(&mut clause_cursor) {
                        match part.kind() {
                            "identifier" => {
                                entry.insert(text(part, src).to_string(), module.clone());
                            }
                            "named_imports" => {
                                let mut named_cursor = part.walk();
                                for spec in part.children(&mut named_cursor) {
                                    if spec.kind() != "import_specifier" {
                                        continue;
                                    }
                                    let Some(name_node) = spec.child_by_field_name("name") else {
                                        continue;
                                    };
                                    let imported = text(name_node, src).to_string();
                                    let local = spec
                                        .child_by_field_name("alias")
                                        .map(|n| text(n, src).to_string())
                                        .unwrap_or_else(|| imported.clone());
                                    entry.insert(local, module.clone());
                                }
                            }
                            "namespace_import" => {
                                let mut ns_cursor = part.walk();
                                for ident in part.children(&mut ns_cursor) {
                                    if ident.kind() == "identifier" {
                                        entry.insert(text(ident, src).to_string(), module.clone());
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
    }

    fn ingest_declaration(
        &mut self,
        node: Node,
        src: &str,
        rel_path: &str,
        decorators: &[Decorator],
    ) {
        match node.kind() {
            "interface_declaration" => {
                if let Some(decl) = self.interface_decl(node, src, rel_path) {
                    self.types.entry(decl.name.clone()).or_default().push(decl);
                }
            }
            "class_declaration" | "abstract_class_declaration" => {
                let Some(name_node) = node.child_by_field_name("name") else {
                    return;
                };
                let class_name = text(name_node, src).to_string();

                if let Some(controller) =
                    self.controller_facts(node, src, rel_path, &class_name, decorators)
                {
                    self.controllers.push(controller);
                }

                if let Some(decl) = self.class_decl(node, src, rel_path, &class_name) {
                    self.types.entry(decl.name.clone()).or_default().push(decl);
                }
            }
            "type_alias_declaration" => {
                let Some(name_node) = node.child_by_field_name("name") else {
                    return;
                };
                let Some(value) = node.child_by_field_name("value") else {
                    return;
                };
                let name = text(name_node, src).to_string();
                self.types.entry(name.clone()).or_default().push(TypeDecl {
                    name,
                    file: rel_path.to_string(),
                    line: line_of(node),
                    kind: DeclKind::Alias,
                    alias_text: Some(text(value, src).to_string()),
                    properties: Vec::new(),
                    enum_values: Vec::new(),
                    bases: Vec::new(),
                    opaque: None,
                });
            }
            "enum_declaration" => {
                if let Some(decl) = enum_decl(node, src, rel_path) {
                    self.types.entry(decl.name.clone()).or_default().push(decl);
                }
            }
            _ => {}
        }
    }

    fn interface_decl(&self, node: Node, src: &str, rel_path: &str) -> Option<TypeDecl> {
        let name_node = node.child_by_field_name("name")?;
        let name = text(name_node, src).to_string();
        let mut properties = Vec::new();
        let mut opaque = None;
        if let Some(body) = node.child_by_field_name("body") {
            let mut pending = Vec::new();
            let mut cursor = body.walk();
            for member in body.children(&mut cursor) {
                if member.kind() == "decorator" {
                    if let Some(dec) = parse_decorator(member, src) {
                        pending.push(dec);
                    }
                    continue;
                }
                let decorators = take_with_member_decorators(&mut pending, member, src);
                match member.kind() {
                    "property_signature" => {
                        if let Some(prop) = raw_property(member, src, &decorators) {
                            properties.push(prop);
                        }
                    }
                    "index_signature" => {
                        opaque = Some(format!(
                            "`{}` declares an index signature; its arbitrary keys cannot be enumerated",
                            name
                        ));
                    }
                    _ => {}
                }
            }
        }
        Some(TypeDecl {
            name,
            file: rel_path.to_string(),
            line: line_of(node),
            kind: DeclKind::Interface,
            alias_text: None,
            properties,
            enum_values: Vec::new(),
            bases: heritage_names(node, src),
            opaque,
        })
    }

    fn class_decl(
        &self,
        node: Node,
        src: &str,
        rel_path: &str,
        class_name: &str,
    ) -> Option<TypeDecl> {
        let body = node.child_by_field_name("body")?;
        let mut properties = Vec::new();
        let mut opaque = None;
        let mut pending = Vec::new();
        let mut cursor = body.walk();
        for member in body.children(&mut cursor) {
            if member.kind() == "decorator" {
                if let Some(dec) = parse_decorator(member, src) {
                    pending.push(dec);
                }
                continue;
            }
            let decorators = take_with_member_decorators(&mut pending, member, src);
            match member.kind() {
                "public_field_definition" => {
                    if let Some(prop) = raw_property(member, src, &decorators) {
                        properties.push(prop);
                    }
                }
                "index_signature" => {
                    opaque = Some(format!(
                        "`{}` declares an index signature; its arbitrary keys cannot be enumerated",
                        class_name
                    ));
                }
                "method_definition" => {
                    let is_constructor = member
                        .child_by_field_name("name")
                        .map(|n| text(n, src).trim() == "constructor")
                        .unwrap_or(false);
                    if !is_constructor {
                        continue;
                    }
                    let Some(params) = member.child_by_field_name("parameters") else {
                        continue;
                    };
                    let mut param_cursor = params.walk();
                    for param in params.children(&mut param_cursor) {
                        if param.kind() != "required_parameter"
                            && param.kind() != "optional_parameter"
                        {
                            continue;
                        }
                        if !has_parameter_property_modifier(param, src) {
                            continue;
                        }
                        if let Some(prop) = raw_property(param, src, &[]) {
                            properties.push(prop);
                        }
                    }
                }
                _ => {}
            }
        }
        Some(TypeDecl {
            name: class_name.to_string(),
            file: rel_path.to_string(),
            line: line_of(node),
            kind: DeclKind::Class,
            alias_text: None,
            properties,
            enum_values: Vec::new(),
            bases: heritage_names(node, src),
            opaque,
        })
    }

    fn controller_facts(
        &self,
        node: Node,
        src: &str,
        rel_path: &str,
        class_name: &str,
        decorators: &[Decorator],
    ) -> Option<ControllerFacts> {
        let controller = decorators.iter().find(|d| d.name == "Controller")?;
        // A local class that happens to use the name `Controller` is not a Nest controller
        // unless the decorator came from the Nest package.
        let imported = self
            .imports
            .get(rel_path)
            .and_then(|map| map.get("Controller"))
            .map(|module| module == "@nestjs/common")
            .unwrap_or(false);
        if !imported {
            return None;
        }

        let (prefixes, prefix_unresolved) = match controller.args.first() {
            None => (vec![String::new()], false),
            Some(arg) => match route_values(arg) {
                Some(values) => (values, false),
                None => (vec![String::new()], true),
            },
        };

        let body = node.child_by_field_name("body")?;
        let mut methods = Vec::new();
        let mut pending = Vec::new();
        let mut cursor = body.walk();
        for member in body.children(&mut cursor) {
            if member.kind() == "decorator" {
                if let Some(dec) = parse_decorator(member, src) {
                    pending.push(dec);
                }
                continue;
            }
            let member_decorators = take_with_member_decorators(&mut pending, member, src);
            if member.kind() != "method_definition" {
                continue;
            }
            let Some(method_name) = member.child_by_field_name("name") else {
                continue;
            };
            let method_name = text(method_name, src).to_string();
            if method_name == "constructor" {
                continue;
            }
            let route_decorator = member_decorators
                .iter()
                .find(|d| SUPPORTED_VERBS.contains(&d.name.as_str()));
            let Some(route_decorator) = route_decorator else {
                continue;
            };
            let verb = match route_decorator.name.as_str() {
                "All" => "ALL".to_string(),
                other => other.to_uppercase(),
            };
            let (paths, path_unresolved) = match route_decorator.args.first() {
                None => (vec![String::new()], false),
                Some(arg) => match route_values(arg) {
                    Some(values) => (values, false),
                    None => (vec![String::new()], true),
                },
            };
            methods.push(MethodFacts {
                name: method_name,
                line: line_of(member),
                http: Some((verb, paths)),
                path_unresolved,
                params: parameter_facts(member, src),
                return_text: return_type_text(member, src),
                declared_responses: declared_responses(member, src),
            });
        }

        let class_text = text(node, src);
        let mut blockers = Vec::new();
        if class_text.contains("@Res(") || class_text.contains("@Res (") {
            blockers.push((
                "NESTJS_RUNTIME_RESPONSE_UNMODELED",
                format!(
                    "`{}` uses `@Res()`; the handler writes the response at runtime, so the status and body this artifact records are not its wire shape",
                    class_name
                ),
            ));
        }
        if class_text.contains("@Sse(") || class_text.contains("@Sse (") {
            blockers.push((
                "NESTJS_SSE_UNMODELED",
                format!(
                    "`{}` declares a server-sent-event handler; the event stream is not modelled as a JSON response body",
                    class_name
                ),
            ));
        }
        if class_text.contains("@Version(") || class_text.contains("@Version (") {
            blockers.push((
                "NESTJS_VERSION_DECORATOR_UNMODELED",
                format!(
                    "`{}` declares `@Version`; this reader does not apply URI version segments, so the published route may lack its `/vN` prefix",
                    class_name
                ),
            ));
        }

        Some(ControllerFacts {
            file: rel_path.to_string(),
            name: class_name.to_string(),
            prefixes,
            prefix_unresolved,
            methods,
            blockers,
        })
    }

    // -----------------------------------------------------------------------
    // Payload
    // -----------------------------------------------------------------------

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
        let (payload, completeness) = self.extract_payload(service_id);

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
                framework_profile: Some("NESTJS".to_string()),
                codec_profile: Some("JSON_STRINGIFY_V1".to_string()),
                client_profile: None,
                config_fingerprint: Some(self.config_fingerprint.clone()),
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

    fn extract_payload(&self, service_id: &str) -> (BackendContractPayload, ArtifactCompleteness) {
        let mut resolver = ShapeResolver::new(
            &self.types,
            &self.imports,
            &self.source_hashes,
            self.parse_blockers.clone(),
        );

        let mut endpoints: Vec<EndpointContract> = Vec::new();
        for controller in &self.controllers {
            for (code, message) in &controller.blockers {
                resolver.blocker(&controller.file, code, message.clone());
            }
            if controller.prefix_unresolved {
                resolver.blocker(
                    &controller.file,
                    "NESTJS_CONTROLLER_PREFIX_UNRESOLVED",
                    format!(
                        "`@Controller` on `{}` has an argument that is not a string literal or an object with a literal `path`; the controller's routes are anchored at the empty prefix",
                        controller.name
                    ),
                );
            }
            let prefixes: Vec<String> = if controller.prefixes.is_empty() {
                vec![String::new()]
            } else {
                controller.prefixes.clone()
            };
            for prefix in &prefixes {
                for method in &controller.methods {
                    let Some((verb, paths)) = &method.http else {
                        continue;
                    };
                    if method.path_unresolved {
                        resolver.blocker(
                            &controller.file,
                            "NESTJS_ROUTE_PATH_UNRESOLVED",
                            format!(
                                "`{}#{}` has a route decorator argument that is not a string literal or an array of literals; the method's route is anchored at its controller prefix only",
                                controller.name, method.name
                            ),
                        );
                    }
                    let suffixes: Vec<String> = if paths.is_empty() {
                        vec![String::new()]
                    } else {
                        paths.clone()
                    };
                    for suffix in &suffixes {
                        let route = join_route(self.global_prefix.as_deref(), prefix, suffix);
                        let identity = format!("{}#{}", controller.name, method.name);
                        self.build_endpoint(
                            &mut resolver,
                            &mut endpoints,
                            service_id,
                            controller,
                            method,
                            verb,
                            &route,
                            &identity,
                        );
                    }
                }
            }
        }

        endpoints.sort_by(|a, b| {
            (
                &a.identity.normalized_route.raw_path,
                &a.identity.http_method,
                direction_rank(&a.identity.direction),
                &a.provenance.file,
                a.provenance.line,
            )
                .cmp(&(
                    &b.identity.normalized_route.raw_path,
                    &b.identity.http_method,
                    direction_rank(&b.identity.direction),
                    &b.provenance.file,
                    b.provenance.line,
                ))
        });

        // A Nest service that also publishes GraphQL answers through resolvers exposes a
        // surface this REST reader never sees. Name it rather than letting the artifact
        // read as the service's whole contract.
        for (file, content) in &self.sources {
            if content.contains("@nestjs/graphql")
                && (content.contains("@Resolver(") || content.contains("@Resolver ("))
            {
                resolver.blocker(
                    file,
                    "NESTJS_GRAPHQL_UNMODELED",
                    "`@Resolver` from `@nestjs/graphql` serves this schema through the GraphQL endpoint, not a REST route; those operations are absent from this artifact".to_string(),
                );
            }
        }

        let ShapeResolver {
            pool,
            blockers: resolver_blockers,
            ..
        } = resolver;
        let type_pool = if pool.is_empty() { None } else { Some(pool) };
        let mut completeness_blockers = self.parse_blockers.clone();
        completeness_blockers.extend(resolver_blockers);
        completeness_blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
        completeness_blockers.dedup();

        let completeness = ArtifactCompleteness {
            complete: completeness_blockers.is_empty(),
            unresolved_endpoints: Vec::new(),
            blockers: completeness_blockers,
        };

        let payload = BackendContractPayload {
            serialization_assumptions: Some(vec![
                "NestJS serialises handler return values with JSON.stringify: Date values become ISO-8601 strings, undefined properties are omitted, and a handler that returns undefined sends an empty body".to_string(),
            ]),
            base_urls: Vec::new(),
            proxy_prefixes: Vec::new(),
            endpoints,
            type_pool,
            path_pool: None,
        };
        (payload, completeness)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_endpoint(
        &self,
        resolver: &mut ShapeResolver,
        endpoints: &mut Vec<EndpointContract>,
        service_id: &str,
        controller: &ControllerFacts,
        method: &MethodFacts,
        verb: &str,
        route: &str,
        identity: &str,
    ) {
        let normalized = normalize_route_segments(route);
        let file = &controller.file;
        let line = method.line;

        // Path parameters are declared by the route itself. A `@Param('name')`
        // annotation only refines the type; it never adds a parameter the route
        // does not have.
        let dto_path = method
            .params
            .iter()
            .find(|p| p.kind == ParamKind::Path && p.name.is_none())
            .and_then(|p| p.type_text.as_deref());
        let dto_path_props = dto_path
            .map(|text| resolver.object_properties(text, file, line, identity))
            .unwrap_or_default();

        let mut path_parameters = Vec::new();
        for segment in &normalized.segments {
            if !segment.is_param {
                continue;
            }
            let name = segment
                .param_name
                .clone()
                .unwrap_or_else(|| format!("param{}", segment.param_index.unwrap_or(0)));
            let annotated = method
                .params
                .iter()
                .find(|p| p.kind == ParamKind::Path && p.name.as_deref() == Some(name.as_str()));
            let mut wire = WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: None,
                provenance: Some(provenance(file, line, identity)),
            });
            if let Some(typed) = annotated.and_then(|p| p.type_text.as_deref()) {
                wire = resolver.resolve_text(typed, file, line, identity);
            } else if let Some(prop) = dto_path_props.iter().find(|p| p.wire_name == name) {
                wire = prop.r#type.clone();
            }
            path_parameters.push(ParamContract {
                name,
                r#type: wire,
                required: !segment
                    .param_name
                    .as_deref()
                    .is_some_and(|n| n.ends_with('?')),
                validation_constraints: None,
                provenance: Some(provenance(file, line, identity)),
            });
        }

        let mut query_parameters = Vec::new();
        for param in &method.params {
            match param.kind {
                ParamKind::Query => match (&param.name, param.type_text.as_deref()) {
                    (Some(name), typed) => {
                        let wire = typed
                            .map(|t| resolver.resolve_text(t, file, line, identity))
                            .unwrap_or_else(|| resolver.any(file, line));
                        query_parameters
                            .push(param_contract(name, wire, false, file, line, identity));
                    }
                    (None, Some(typed)) => {
                        for prop in resolver.object_properties(typed, file, line, identity) {
                            query_parameters.push(ParamContract {
                                name: prop.wire_name,
                                r#type: prop.r#type,
                                required: false,
                                validation_constraints: Some(prop.validation_constraints),
                                provenance: prop.provenance,
                            });
                        }
                    }
                    (None, None) => {
                        resolver.blocker(
                            file,
                            "NESTJS_QUERY_SHAPE_UNRESOLVED",
                            format!(
                                "`{}#{}` binds `@Query()` without a type annotation, so the query keys the handler reads are absent from this artifact",
                                controller.name, method.name
                            ),
                        );
                    }
                },
                ParamKind::Header => {
                    if let Some(name) = &param.name {
                        let wire = param
                            .type_text
                            .as_deref()
                            .map(|t| resolver.resolve_text(t, file, line, identity))
                            .unwrap_or_else(|| resolver.any(file, line));
                        query_parameters
                            .push(param_contract(name, wire, false, file, line, identity));
                    }
                }
                _ => {}
            }
        }
        // Header params are recorded in the dedicated list, not among query params.
        let headers: Vec<ParamContract> = query_parameters
            .iter()
            .filter(|p| {
                method.params.iter().any(|param| {
                    param.kind == ParamKind::Header && param.name.as_deref() == Some(&p.name)
                })
            })
            .cloned()
            .collect();
        query_parameters.retain(|p| {
            !method.params.iter().any(|param| {
                param.kind == ParamKind::Header && param.name.as_deref() == Some(&p.name)
            })
        });

        let mut request_body: Option<WireType> = None;
        for param in &method.params {
            match param.kind {
                ParamKind::Body => {
                    match &param.type_text {
                        Some(typed) => {
                            let resolved = resolver.resolve_text(typed, file, line, identity);
                            request_body = Some(match &param.name {
                                Some(key) => wrap_object(key, resolved, file, line, identity),
                                None => resolved,
                            });
                        }
                        None => {
                            resolver.blocker(
                                file,
                                "NESTJS_REQUEST_BODY_UNRESOLVED",
                                format!(
                                    "`{}#{}` binds `@Body()` without a type annotation, so the request body shape is unknown",
                                    controller.name, method.name
                                ),
                            );
                            request_body = Some(resolver.unknown(
                                "the handler binds @Body() without a type annotation",
                                file,
                                line,
                            ));
                        }
                    }
                    break;
                }
                ParamKind::Multipart => {
                    resolver.blocker(
                        file,
                        "NESTJS_MULTIPART_BODY_UNMODELED",
                        format!(
                            "`{}#{}` accepts a file upload; multipart request bodies are not modelled, so the request shape is absent",
                            controller.name, method.name
                        ),
                    );
                }
                _ => {}
            }
        }

        let (response_body, evidence_classification) = match &method.return_text {
            Some(text) => {
                let unwrapped = unwrap_promise(text);
                (
                    Some(resolver.resolve_text(unwrapped, file, line, identity)),
                    EvidenceClassification::ImplementationDerived,
                )
            }
            None => (
                Some(WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Any,
                    format: None,
                    provenance: Some(provenance(file, line, identity)),
                })),
                EvidenceClassification::DeclaredSpecification,
            ),
        };

        let declared = if method.declared_responses.is_empty() {
            None
        } else {
            Some(
                method
                    .declared_responses
                    .iter()
                    .map(
                        |(status, type_name)| contract_core::ir::DeclaredResponseEvidence {
                            status_code: *status,
                            schema_name: Some(type_name.clone()),
                            media_type: Some("application/json".to_string()),
                            description: None,
                            wire_type: Some(resolver.resolve_text(type_name, file, line, identity)),
                        },
                    )
                    .collect(),
            )
        };

        let sha256 = self.source_hashes.get(file).cloned();
        endpoints.push(EndpointContract {
            identity: EndpointIdentityContract {
                service: Some(service_id.to_string()),
                http_method: verb.to_string(),
                normalized_route: normalized.clone(),
                direction: ContractDirection::Response,
            },
            path_parameters: path_parameters.clone(),
            query_parameters: query_parameters.clone(),
            headers: headers.clone(),
            body: response_body,
            provenance: SourceProvenance {
                language: SourceLanguage::TypeScript,
                file: file.clone(),
                line,
                column: None,
                ast_identity: Some(format!("{}@{}", identity, "RESPONSE")),
                annotation_or_schema: None,
                sha256: sha256.clone(),
                evidence_classification: Some(evidence_classification),
            },
            evidence_classification: Some(evidence_classification),
            declared_responses: declared,
            status_code_family: Some(StatusCodeFamily::Success2xx),
            mapping_conditions: Some(serde_json::json!({
                "params": [],
                "complete": true
            })),
        });

        if request_body.is_some()
            || !path_parameters.is_empty()
            || !query_parameters.is_empty()
            || !headers.is_empty()
        {
            endpoints.push(EndpointContract {
                identity: EndpointIdentityContract {
                    service: Some(service_id.to_string()),
                    http_method: verb.to_string(),
                    normalized_route: normalized,
                    direction: ContractDirection::Request,
                },
                path_parameters,
                query_parameters,
                headers,
                body: request_body,
                provenance: SourceProvenance {
                    language: SourceLanguage::TypeScript,
                    file: file.clone(),
                    line,
                    column: None,
                    ast_identity: Some(format!("{}@{}", identity, "REQUEST")),
                    annotation_or_schema: None,
                    sha256,
                    evidence_classification: Some(EvidenceClassification::ImplementationDerived),
                },
                evidence_classification: Some(EvidenceClassification::ImplementationDerived),
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

fn direction_rank(direction: &ContractDirection) -> u8 {
    match direction {
        ContractDirection::Response => 0,
        ContractDirection::Request => 1,
    }
}

fn param_contract(
    name: &str,
    wire: WireType,
    required: bool,
    file: &str,
    line: u32,
    identity: &str,
) -> ParamContract {
    ParamContract {
        name: name.to_string(),
        r#type: wire,
        required,
        validation_constraints: None,
        provenance: Some(provenance(file, line, identity)),
    }
}

fn wrap_object(key: &str, inner: WireType, file: &str, line: u32, identity: &str) -> WireType {
    WireType::Object(ObjectWireType {
        name: Some(format!("Body{{{}}}", key)),
        properties: vec![WirePropertyContract {
            wire_name: key.to_string(),
            aliases: Vec::new(),
            r#type: inner,
            optional: false,
            nullable: false,
            server_assigned: false,
            validation_constraints: Vec::new(),
            provenance: Some(provenance(file, line, identity)),
        }],
        strict: Some(false),
        provenance: Some(provenance(file, line, identity)),
    })
}

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

struct ShapeResolver<'a> {
    types: &'a BTreeMap<String, Vec<TypeDecl>>,
    imports: &'a BTreeMap<String, BTreeMap<String, String>>,
    source_hashes: &'a BTreeMap<String, String>,
    pool: BTreeMap<String, WireType>,
    blockers: Vec<ArtifactBlocker>,
    seen: BTreeSet<String>,
    parser: Parser,
    max_depth: usize,
}

impl<'a> ShapeResolver<'a> {
    fn new(
        types: &'a BTreeMap<String, Vec<TypeDecl>>,
        imports: &'a BTreeMap<String, BTreeMap<String, String>>,
        source_hashes: &'a BTreeMap<String, String>,
        blockers: Vec<ArtifactBlocker>,
    ) -> Self {
        let mut parser = Parser::new();
        let _ = parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        Self {
            types,
            imports,
            source_hashes,
            pool: BTreeMap::new(),
            blockers,
            seen: BTreeSet::new(),
            parser,
            max_depth: 32,
        }
    }

    #[allow(dead_code)]
    fn into_pool(self) -> BTreeMap<String, WireType> {
        self.pool
    }

    fn blocker(&mut self, file: &str, code: &str, message: String) {
        let dedupe_key = format!("{}\u{0}{}\u{0}{}", file, code, message);
        if self.seen.insert(dedupe_key) {
            self.blockers.push(ArtifactBlocker {
                code: code.to_string(),
                message,
                file: Some(file.to_string()),
            });
        }
    }

    fn unknown(&self, reason: &str, file: &str, line: u32) -> WireType {
        WireType::Unknown(UnknownWireType {
            reason: reason.to_string(),
            provenance: Some(SourceProvenance {
                language: SourceLanguage::TypeScript,
                file: file.to_string(),
                line,
                column: None,
                ast_identity: None,
                annotation_or_schema: None,
                sha256: self.source_hashes.get(file).cloned(),
                evidence_classification: Some(EvidenceClassification::InconclusiveOrConflicting),
            }),
        })
    }

    fn any(&self, file: &str, line: u32) -> WireType {
        WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Any,
            format: None,
            provenance: Some(provenance(file, line, "any")),
        })
    }

    fn resolve_text(&mut self, type_text: &str, file: &str, line: u32, identity: &str) -> WireType {
        self.resolve_text_at(type_text, file, line, identity, 0)
    }

    fn resolve_text_at(
        &mut self,
        type_text: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        let trimmed = type_text.trim().trim_end_matches(';').trim();
        if trimmed.is_empty() {
            return self.any(file, line);
        }
        if depth > self.max_depth {
            return self.unknown("type nesting exceeded the resolution budget", file, line);
        }
        let snippet = format!("type __Sajimora = {trimmed};");
        let Some(tree) = self.parser.parse(&snippet, None) else {
            self.blocker(
                file,
                "NESTJS_TYPE_PARSE_FAILED",
                format!("Type expression `{}` could not be parsed", trimmed),
            );
            return self.unknown("type expression could not be parsed", file, line);
        };
        let root = tree.root_node();
        let mut cursor = root.walk();
        let alias = root
            .children(&mut cursor)
            .find(|child| child.kind() == "type_alias_declaration");
        let Some(value) = alias.and_then(|a| a.child_by_field_name("value")) else {
            self.blocker(
                file,
                "NESTJS_TYPE_PARSE_FAILED",
                format!("Type expression `{}` did not parse as a type", trimmed),
            );
            return self.unknown("type expression could not be parsed", file, line);
        };
        self.resolve_node(value, &snippet, file, line, identity, depth)
    }

    fn resolve_node(
        &mut self,
        node: Node,
        src: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        if depth > self.max_depth {
            return self.unknown("type nesting exceeded the resolution budget", file, line);
        }
        match node.kind() {
            "predefined_type" => {
                let text_value = text(node, src).trim();
                match text_value {
                    "string" => primitive(PrimitiveScalar::String, file, line, identity),
                    "number" => primitive(PrimitiveScalar::Number, file, line, identity),
                    "boolean" => primitive(PrimitiveScalar::Boolean, file, line, identity),
                    "bigint" => primitive(PrimitiveScalar::BigInt, file, line, identity),
                    "void" => primitive(PrimitiveScalar::Void, file, line, identity),
                    "any" => primitive(PrimitiveScalar::Any, file, line, identity),
                    "never" => self.unknown("`never` has no wire value", file, line),
                    "unknown" | "object" | "symbol" => {
                        self.unknown("the declared type has no static JSON shape", file, line)
                    }
                    "null" | "undefined" => self.nullable(
                        primitive(PrimitiveScalar::Any, file, line, identity),
                        file,
                        line,
                        identity,
                    ),
                    _ => self.unknown(
                        &format!("unrecognised predefined type `{}`", text_value),
                        file,
                        line,
                    ),
                }
            }
            "type_identifier" | "nested_type_identifier" => {
                let raw = text(node, src).trim();
                let name = raw.rsplit('.').next().unwrap_or(raw).to_string();
                self.resolve_name(&name, file, line, identity, depth)
            }
            "generic_type" => {
                let name = node
                    .child_by_field_name("name")
                    .map(|n| text(n, src).trim().to_string())
                    .unwrap_or_default();
                let args = node
                    .child_by_field_name("type_arguments")
                    .map(|arguments| {
                        let mut cursor = arguments.walk();
                        arguments
                            .children(&mut cursor)
                            .filter(|c| c.is_named())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                self.resolve_generic(&name, &args, src, file, line, identity, depth)
            }
            "union_type" => {
                let mut cursor = node.walk();
                let members: Vec<Node> = node
                    .children(&mut cursor)
                    .filter(|c| c.is_named())
                    .collect();
                self.resolve_union(&members, src, file, line, identity, depth)
            }
            "intersection_type" => {
                let mut cursor = node.walk();
                let members: Vec<Node> = node
                    .children(&mut cursor)
                    .filter(|c| c.is_named())
                    .collect();
                self.resolve_intersection(&members, src, file, line, identity, depth)
            }
            "array_type" => match node.named_child(0) {
                Some(element) => {
                    let element_type =
                        self.resolve_node(element, src, file, line, identity, depth + 1);
                    WireType::Array(ArrayWireType {
                        element_type: Box::new(element_type),
                        is_stream_or_flux: Some(false),
                        provenance: Some(provenance(file, line, identity)),
                    })
                }
                None => self.unknown("array element type is absent", file, line),
            },
            "parenthesized_type" => match node.named_child(0) {
                Some(inner) => self.resolve_node(inner, src, file, line, identity, depth + 1),
                None => self.unknown("parenthesised type is empty", file, line),
            },
            "object_type" => {
                let props =
                    self.object_properties_from_node(node, src, file, line, identity, depth);
                match props {
                    Some(properties) => WireType::Object(ObjectWireType {
                        name: None,
                        properties,
                        strict: Some(false),
                        provenance: Some(provenance(file, line, identity)),
                    }),
                    None => self.unknown(
                        "an object type declares an index signature; its keys cannot be enumerated",
                        file,
                        line,
                    ),
                }
            }
            "literal_type" => {
                let inner = node.named_child(0);
                match inner {
                    Some(inner) if inner.kind() == "string" => WireType::Literal(LiteralWireType {
                        value: serde_json::Value::String(unquote(text(inner, src))),
                        provenance: Some(provenance(file, line, identity)),
                    }),
                    Some(inner) if inner.kind() == "number" => WireType::Literal(LiteralWireType {
                        value: serde_json::json!(text(inner, src)
                            .parse::<f64>()
                            .unwrap_or_default()),
                        provenance: Some(provenance(file, line, identity)),
                    }),
                    Some(inner) if inner.kind() == "true" || inner.kind() == "false" => {
                        WireType::Literal(LiteralWireType {
                            value: serde_json::Value::Bool(inner.kind() == "true"),
                            provenance: Some(provenance(file, line, identity)),
                        })
                    }
                    _ => self.unknown("null or computed literal type", file, line),
                }
            }
            "tuple_type" => {
                let mut cursor = node.walk();
                let members: Vec<Node> = node
                    .children(&mut cursor)
                    .filter(|c| c.is_named())
                    .collect();
                let element = self.resolve_union(&members, src, file, line, identity, depth + 1);
                WireType::Array(ArrayWireType {
                    element_type: Box::new(element),
                    is_stream_or_flux: Some(false),
                    provenance: Some(provenance(file, line, identity)),
                })
            }
            "optional_type" => {
                if let Some(inner) = node.named_child(0) {
                    WireType::Optional(contract_core::ir::OptionalWireType {
                        inner_type: Box::new(self.resolve_node(
                            inner,
                            src,
                            file,
                            line,
                            identity,
                            depth + 1,
                        )),
                        provenance: Some(provenance(file, line, identity)),
                    })
                } else {
                    self.unknown("optional type has no inner type", file, line)
                }
            }
            other => self.unknown(
                &format!("TypeScript syntax `{}` has no wire-shape rule", other),
                file,
                line,
            ),
        }
    }

    fn resolve_generic(
        &mut self,
        name: &str,
        args: &[Node],
        src: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        let arg = |resolver: &mut Self, index: usize| -> Option<WireType> {
            args.get(index)
                .map(|node| resolver.resolve_node(*node, src, file, line, identity, depth + 1))
        };
        match name {
            "Promise" | "PromiseLike" => match arg(self, 0) {
                Some(inner) => inner,
                None => self.unknown("Promise without a result type", file, line),
            },
            "Array" | "ReadonlyArray" => match arg(self, 0) {
                Some(inner) => WireType::Array(ArrayWireType {
                    element_type: Box::new(inner),
                    is_stream_or_flux: Some(false),
                    provenance: Some(provenance(file, line, identity)),
                }),
                None => self.unknown("Array without an element type", file, line),
            },
            "Record" => {
                let key = arg(self, 0).unwrap_or_else(|| {
                    primitive(PrimitiveScalar::String, file, line, identity)
                });
                let value = arg(self, 1).unwrap_or_else(|| self.any(file, line));
                WireType::Map(MapWireType {
                    key_type: Box::new(key),
                    value_type: Box::new(value),
                    provenance: Some(provenance(file, line, identity)),
                })
            }
            "Partial" => match arg(self, 0) {
                Some(inner) => make_properties_optional(inner),
                None => self.unknown("Partial without a target type", file, line),
            },
            "Required" => match arg(self, 0) {
                Some(inner) => make_properties_required(inner),
                None => self.unknown("Required without a target type", file, line),
            },
            "NonNullable" => arg(self, 0)
                .unwrap_or_else(|| self.unknown("NonNullable without a target", file, line)),
            "Omit" | "Pick" | "Exclude" | "Extract" | "Readonly" | "Map" | "Set"
            | "WeakMap" | "WeakSet" => self.unknown(
                &format!(
                    "`{}` changes the wire shape in a way this extractor does not model; the shape abstains",
                    name
                ),
                file,
                line,
            ),
            _ => {
                // A declared generic type is not the same shape as its bare name; binding
                // its arguments is not attempted, so the shape abstains instead of
                // publishing the unsubstituted declaration.
                if self.lookup(name, file).is_some() {
                    self.blocker(
                        file,
                        "NESTJS_GENERIC_ARGUMENTS_UNBOUND",
                        format!(
                            "`{}` is applied with type arguments; the declaration's parameters are not substituted, so the shape abstains",
                            name
                        ),
                    );
                    self.unknown(
                        &format!("`{}` type arguments are not bound", name),
                        file,
                        line,
                    )
                } else {
                    self.resolve_name(name, file, line, identity, depth)
                }
            }
        }
    }

    fn resolve_union(
        &mut self,
        members: &[Node],
        src: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        let mut resolved = Vec::new();
        let mut saw_null = false;
        let mut all_literals = true;
        for member in members {
            let text_value = text(*member, src).trim();
            if matches!(text_value, "null" | "undefined") {
                saw_null = true;
                continue;
            }
            let wire = self.resolve_node(*member, src, file, line, identity, depth + 1);
            if !matches!(wire, WireType::Literal(_)) {
                all_literals = false;
            }
            resolved.push(wire);
        }
        if resolved.is_empty() {
            return self.unknown("the union has no non-null member", file, line);
        }
        if all_literals && resolved.len() > 1 {
            let values = resolved
                .iter()
                .filter_map(|wire| match wire {
                    WireType::Literal(lit) => Some(lit.value.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if !values.is_empty() {
                return WireType::Enum(EnumWireType {
                    name: None,
                    values,
                    provenance: Some(provenance(file, line, identity)),
                });
            }
        }
        let inner = if resolved.len() == 1 {
            resolved.into_iter().next().expect("checked above")
        } else {
            WireType::Union(UnionWireType {
                types: resolved,
                provenance: Some(provenance(file, line, identity)),
            })
        };
        if saw_null {
            self.nullable(inner, file, line, identity)
        } else {
            inner
        }
    }

    fn resolve_intersection(
        &mut self,
        members: &[Node],
        src: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        let mut merged: Vec<WirePropertyContract> = Vec::new();
        let mut names = BTreeSet::new();
        let mut all_objects = true;
        for member in members {
            let wire = self.resolve_node(*member, src, file, line, identity, depth + 1);
            let object = self.deref_object(&wire);
            match object {
                Some(object) => {
                    for prop in object.properties {
                        if names.insert(prop.wire_name.clone()) {
                            merged.push(prop);
                        }
                    }
                }
                None => all_objects = false,
            }
        }
        if all_objects {
            WireType::Object(ObjectWireType {
                name: None,
                properties: merged,
                strict: Some(false),
                provenance: Some(provenance(file, line, identity)),
            })
        } else {
            self.unknown(
                "an intersection mixes object shapes with non-object types",
                file,
                line,
            )
        }
    }

    fn object_properties(
        &mut self,
        type_text: &str,
        file: &str,
        line: u32,
        identity: &str,
    ) -> Vec<WirePropertyContract> {
        let wire = self.resolve_text(type_text, file, line, identity);
        self.deref_object(&wire)
            .map(|object| object.properties)
            .unwrap_or_default()
    }

    fn object_properties_from_node(
        &mut self,
        node: Node,
        src: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> Option<Vec<WirePropertyContract>> {
        let mut properties = Vec::new();
        let mut cursor = node.walk();
        for member in node.children(&mut cursor) {
            match member.kind() {
                "property_signature" => {
                    if let Some(raw) = raw_property(member, src, &[]) {
                        properties.push(self.wire_property(&raw, file, line, identity, depth));
                    }
                }
                "index_signature" => return None,
                _ => {}
            }
        }
        Some(properties)
    }

    fn deref_object(&self, wire: &WireType) -> Option<ObjectWireType> {
        match wire {
            WireType::Object(object) => Some(object.clone()),
            WireType::Ref(reference) => match self.pool.get(&reference.r#ref) {
                Some(WireType::Object(object)) => Some(object.clone()),
                _ => None,
            },
            WireType::Optional(optional) => self.deref_object(&optional.inner_type),
            WireType::Nullable(nullable) => self.deref_object(&nullable.inner_type),
            _ => None,
        }
    }

    fn resolve_name(
        &mut self,
        name: &str,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WireType {
        match name {
            "Date" => return primitive(PrimitiveScalar::String, file, line, identity),
            "Buffer" | "Uint8Array" | "ArrayBuffer" | "Blob" | "File" => {
                return self.unknown("binary values are serialised outside JSON", file, line)
            }
            _ => {}
        }
        let Some(decl) = self.lookup(name, file) else {
            self.blocker(
                file,
                "NESTJS_TYPE_UNRESOLVED",
                format!(
                    "Type `{}` is not declared in the scanned sources or imported from a module this extractor can resolve",
                    name
                ),
            );
            return self.unknown(
                &format!("type `{}` could not be resolved", name),
                file,
                line,
            );
        };
        let key = format!("ts:{}#{}", decl.file, decl.name);
        if !self.pool.contains_key(&key) {
            self.pool.insert(
                key.clone(),
                self.unknown("type is being resolved", &decl.file, decl.line),
            );
            let shape = self.build_decl_shape(&decl, depth + 1);
            self.pool.insert(key.clone(), shape);
        }
        WireType::Ref(RefWireType {
            r#ref: key,
            provenance: Some(provenance(file, line, identity)),
        })
    }

    fn build_decl_shape(&mut self, decl: &TypeDecl, depth: usize) -> WireType {
        if let Some(reason) = &decl.opaque {
            return self.unknown(reason, &decl.file, decl.line);
        }
        match decl.kind {
            DeclKind::Alias => match &decl.alias_text {
                Some(text_value) => {
                    self.resolve_text_at(text_value, &decl.file, decl.line, &decl.name, depth)
                }
                None => self.unknown("type alias has no body", &decl.file, decl.line),
            },
            DeclKind::Enum => {
                if decl.enum_values.is_empty() {
                    self.unknown(
                        "the enum declares no explicit wire values",
                        &decl.file,
                        decl.line,
                    )
                } else {
                    WireType::Enum(EnumWireType {
                        name: Some(decl.name.clone()),
                        values: decl.enum_values.clone(),
                        provenance: Some(provenance(&decl.file, decl.line, &decl.name)),
                    })
                }
            }
            DeclKind::Interface | DeclKind::Class => {
                let mut properties: Vec<WirePropertyContract> = Vec::new();
                let mut names: BTreeSet<String> = BTreeSet::new();
                for base in &decl.bases {
                    let base_name = base
                        .split('<')
                        .next()
                        .unwrap_or(base)
                        .trim()
                        .rsplit('.')
                        .next()
                        .unwrap_or(base)
                        .to_string();
                    if base_name == decl.name {
                        continue;
                    }
                    let base_wire =
                        self.resolve_text_at(base, &decl.file, decl.line, &decl.name, depth + 1);
                    if let Some(object) = self.deref_object(&base_wire) {
                        for prop in object.properties {
                            if names.insert(prop.wire_name.clone()) {
                                properties.push(prop);
                            }
                        }
                    }
                }
                for raw in &decl.properties {
                    if !names.insert(raw.name.clone()) {
                        continue;
                    }
                    let property =
                        self.wire_property(raw, &decl.file, decl.line, &decl.name, depth);
                    properties.push(property);
                }
                WireType::Object(ObjectWireType {
                    name: Some(decl.name.clone()),
                    properties,
                    strict: Some(false),
                    provenance: Some(provenance(&decl.file, decl.line, &decl.name)),
                })
            }
        }
    }

    fn wire_property(
        &mut self,
        raw: &RawProperty,
        file: &str,
        line: u32,
        identity: &str,
        depth: usize,
    ) -> WirePropertyContract {
        let mut wire = match &raw.type_text {
            Some(type_text) => self.resolve_text_at(type_text, file, line, identity, depth + 1),
            None => self.any(file, line),
        };
        if raw.optional {
            wire = WireType::Optional(contract_core::ir::OptionalWireType {
                inner_type: Box::new(wire),
                provenance: Some(provenance(file, line, identity)),
            });
        }
        let nullable = raw.optional || matches!(wire, WireType::Nullable(_));
        WirePropertyContract {
            wire_name: raw.name.clone(),
            aliases: Vec::new(),
            r#type: wire,
            optional: raw.optional,
            nullable,
            server_assigned: false,
            validation_constraints: raw.validations.clone(),
            provenance: Some(SourceProvenance {
                language: SourceLanguage::TypeScript,
                file: file.to_string(),
                line: raw.line,
                column: None,
                ast_identity: Some(format!("{}#{}", identity, raw.name)),
                annotation_or_schema: None,
                sha256: None,
                evidence_classification: Some(EvidenceClassification::ImplementationDerived),
            }),
        }
    }

    fn lookup(&self, name: &str, file: &str) -> Option<TypeDecl> {
        // 1. An import in this file names the declaring module.
        if let Some(module) = self.imports.get(file).and_then(|imports| imports.get(name)) {
            if module.starts_with('.') {
                for candidate in module_candidates(file, module) {
                    if let Some(decl) = self.find_in_file(&candidate, name) {
                        return Some(decl);
                    }
                }
            }
        }
        // 2. A declaration in the same file.
        if let Some(decl) = self.find_in_file(file, name) {
            return Some(decl);
        }
        // 3. A unique declaration in the scanned sources.
        let candidates = self.types.get(name)?;
        if candidates.len() == 1 {
            return candidates.first().cloned();
        }
        None
    }

    fn find_in_file(&self, file: &str, name: &str) -> Option<TypeDecl> {
        self.types
            .get(name)?
            .iter()
            .find(|decl| decl.file == file)
            .cloned()
    }

    fn nullable(&self, inner: WireType, file: &str, line: u32, identity: &str) -> WireType {
        WireType::Nullable(NullableWireType {
            inner_type: Box::new(inner),
            provenance: Some(provenance(file, line, identity)),
        })
    }
}

fn make_properties_optional(wire: WireType) -> WireType {
    match wire {
        WireType::Object(mut object) => {
            for prop in &mut object.properties {
                prop.optional = true;
                prop.nullable = true;
                let inner = prop.r#type.clone();
                prop.r#type = WireType::Optional(contract_core::ir::OptionalWireType {
                    inner_type: Box::new(inner),
                    provenance: prop.provenance.clone(),
                });
            }
            WireType::Object(object)
        }
        other => other,
    }
}

fn make_properties_required(wire: WireType) -> WireType {
    match wire {
        WireType::Object(mut object) => {
            for prop in &mut object.properties {
                prop.optional = false;
                if let WireType::Optional(optional) = &prop.r#type {
                    prop.r#type = (*optional.inner_type).clone();
                }
            }
            WireType::Object(object)
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

fn primitive(scalar: PrimitiveScalar, file: &str, line: u32, identity: &str) -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar,
        format: None,
        provenance: Some(provenance(file, line, identity)),
    })
}

fn provenance(file: &str, line: u32, identity: &str) -> SourceProvenance {
    SourceProvenance {
        language: SourceLanguage::TypeScript,
        file: file.to_string(),
        line,
        column: None,
        ast_identity: Some(identity.to_string()),
        annotation_or_schema: None,
        sha256: None,
        evidence_classification: Some(EvidenceClassification::ImplementationDerived),
    }
}

fn text<'a>(node: Node, src: &'a str) -> &'a str {
    &src[node.byte_range()]
}

fn line_of(node: Node) -> u32 {
    (node.start_position().row + 1) as u32
}

fn parse_decorator(node: Node, src: &str) -> Option<Decorator> {
    let raw = text(node, src).trim();
    let raw = raw.strip_prefix('@').unwrap_or(raw).trim();
    let mut cursor = node.walk();
    let child = node.children(&mut cursor).find(|c| c.is_named())?;
    match child.kind() {
        "call_expression" => {
            let function = child.child_by_field_name("function")?;
            let name = text(function, src)
                .trim()
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_string();
            let args = child
                .child_by_field_name("arguments")
                .map(|arguments| {
                    let mut arg_cursor = arguments.walk();
                    arguments
                        .children(&mut arg_cursor)
                        .filter(|c| c.is_named())
                        .map(|c| parse_arg(c, src))
                        .collect()
                })
                .unwrap_or_default();
            Some(Decorator { name, args })
        }
        "identifier" | "member_expression" => {
            let name = raw.rsplit('.').next().unwrap_or(raw).to_string();
            Some(Decorator {
                name,
                args: Vec::new(),
            })
        }
        _ => None,
    }
}

fn parse_arg(node: Node, src: &str) -> Arg {
    match node.kind() {
        "string" => Arg::Str(unquote(text(node, src))),
        "template_string" => {
            // A template with substitutions is not a literal route or key.
            let mut cursor = node.walk();
            let has_substitution = node
                .children(&mut cursor)
                .any(|child| child.kind() == "template_substitution");
            if has_substitution {
                Arg::Raw
            } else {
                Arg::Str(unquote(text(node, src)))
            }
        }
        "array" => {
            let mut cursor = node.walk();
            let values: Vec<Arg> = node
                .children(&mut cursor)
                .filter(|c| c.is_named())
                .map(|c| parse_arg(c, src))
                .collect();
            if values.iter().all(|v| matches!(v, Arg::Str(_))) {
                Arg::Strings(
                    values
                        .into_iter()
                        .filter_map(|v| match v {
                            Arg::Str(s) => Some(s),
                            _ => None,
                        })
                        .collect(),
                )
            } else {
                Arg::Raw
            }
        }
        "object" => {
            let mut pairs = Vec::new();
            let mut cursor = node.walk();
            for pair in node.children(&mut cursor) {
                if pair.kind() != "pair" {
                    continue;
                }
                let key = pair
                    .child_by_field_name("key")
                    .map(|k| unquote(text(k, src)))
                    .unwrap_or_default();
                if key.is_empty() {
                    continue;
                }
                let value = pair
                    .child_by_field_name("value")
                    .map(|v| parse_arg(v, src))
                    .unwrap_or(Arg::Raw);
                pairs.push((key, value));
            }
            Arg::Object(pairs)
        }
        "number" => Arg::Number(text(node, src).parse::<f64>().unwrap_or_default()),
        "true" => Arg::Bool(true),
        "false" => Arg::Bool(false),
        "identifier" => Arg::Ident(text(node, src).to_string()),
        _ => Arg::Raw,
    }
}

fn decorators_of(node: Node, src: &str) -> Vec<Decorator> {
    let mut out = Vec::new();
    let mut cursor = node.walk();
    for decorator in node.children_by_field_name("decorator", &mut cursor) {
        if let Some(parsed) = parse_decorator(decorator, src) {
            out.push(parsed);
        }
    }
    out
}

fn take_with_member_decorators(
    pending: &mut Vec<Decorator>,
    member: Node,
    src: &str,
) -> Vec<Decorator> {
    let mut decorators = std::mem::take(pending);
    decorators.extend(decorators_of(member, src));
    decorators
}

fn raw_property(node: Node, src: &str, decorators: &[Decorator]) -> Option<RawProperty> {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("pattern"))?;
    let raw_name = text(name_node, src).trim();
    let name = unquote(raw_name);
    if name.is_empty() || name.starts_with('#') {
        return None;
    }
    // Static fields are not instance wire shape.
    let mut cursor = node.walk();
    if node
        .children(&mut cursor)
        .any(|child| child.kind() == "static")
    {
        return None;
    }
    let type_text = node
        .child_by_field_name("type")
        .and_then(|annotation| annotation.named_child(0))
        .map(|t| text(t, src).trim().to_string());
    let optional = has_token(node, "?")
        || decorators.iter().any(|d| d.name == "IsOptional")
        || decorators.iter().any(|d| {
            d.name == "ApiProperty" && matches!(d.object_field("required"), Some(Arg::Bool(false)))
        });
    let validations = decorators
        .iter()
        .filter_map(validation_constraint)
        .collect::<Vec<_>>();
    Some(RawProperty {
        name,
        type_text,
        optional,
        validations,
        line: line_of(node),
    })
}

fn has_token(node: Node, token: &str) -> bool {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .any(|child| child.kind() == token);
    found
}

fn has_parameter_property_modifier(node: Node, src: &str) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| {
        matches!(child.kind(), "accessibility_modifier" | "readonly")
            || text(child, src).trim() == "readonly"
    });
    found
}

fn validation_constraint(decorator: &Decorator) -> Option<ValidationConstraint> {
    let kind = match decorator.name.as_str() {
        "IsNotEmpty" | "IsDefined" | "IsNotNull" => ValidationConstraintKind::NotNull,
        "IsEmail" => ValidationConstraintKind::Email,
        "IsPositive" | "Min" => ValidationConstraintKind::Min,
        "Max" => ValidationConstraintKind::Max,
        "MinLength" | "MaxLength" | "Length" | "ArrayMinSize" | "ArrayMaxSize" => {
            ValidationConstraintKind::Size
        }
        "Matches" => ValidationConstraintKind::Pattern,
        _ => return None,
    };
    let value = decorator.args.first().map(|arg| match arg {
        Arg::Number(n) => serde_json::json!(n),
        Arg::Str(s) => serde_json::Value::String(s.clone()),
        _ => serde_json::Value::Null,
    });
    Some(ValidationConstraint {
        kind,
        value,
        message: None,
        provenance: None,
    })
}

fn route_values(arg: &Arg) -> Option<Vec<String>> {
    match arg {
        Arg::Str(value) => Some(vec![value.clone()]),
        Arg::Strings(values) => Some(values.clone()),
        Arg::Object(pairs) => {
            let path = pairs.iter().find(|(key, _)| key == "path")?;
            path.1.string_list()
        }
        _ => None,
    }
}

fn heritage_names(node: Node, src: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "class_heritage" => {
                let mut inner = child.walk();
                for clause in child.children(&mut inner) {
                    if clause.kind() != "extends_clause" {
                        continue;
                    }
                    if let Some(value) = clause.child_by_field_name("value") {
                        let value_text = text(value, src).trim().to_string();
                        if !value_text.is_empty() {
                            names.push(value_text);
                        }
                    }
                }
            }
            // Interfaces list the extended types directly under the clause, without a
            // nested `extends_clause`.
            "extends_type_clause" => {
                let mut inner = child.walk();
                for ty in child.children(&mut inner) {
                    if !ty.is_named() {
                        continue;
                    }
                    let value_text = text(ty, src).trim().to_string();
                    if !value_text.is_empty() {
                        names.push(value_text);
                    }
                }
            }
            _ => {}
        }
    }
    names
}

fn enum_decl(node: Node, src: &str, rel_path: &str) -> Option<TypeDecl> {
    let name_node = node.child_by_field_name("name")?;
    let name = text(name_node, src).to_string();
    let mut values = Vec::new();
    if let Some(body) = node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for member in body.children(&mut cursor) {
            if member.kind() != "enum_assignment" {
                continue;
            }
            let Some(value) = member.child_by_field_name("value") else {
                continue;
            };
            match value.kind() {
                "string" => values.push(serde_json::Value::String(unquote(text(value, src)))),
                "number" => {
                    if let Ok(parsed) = text(value, src).trim().parse::<f64>() {
                        values.push(serde_json::json!(parsed));
                    }
                }
                _ => {}
            }
        }
    }
    Some(TypeDecl {
        name,
        file: rel_path.to_string(),
        line: line_of(node),
        kind: DeclKind::Enum,
        alias_text: None,
        properties: Vec::new(),
        enum_values: values,
        bases: Vec::new(),
        opaque: None,
    })
}

fn return_type_text(method: Node, src: &str) -> Option<String> {
    method
        .child_by_field_name("return_type")
        .and_then(|annotation| annotation.named_child(0))
        .map(|t| text(t, src).trim().to_string())
        .filter(|t| !t.is_empty())
}

fn unwrap_promise(type_text: &str) -> &str {
    let trimmed = type_text.trim();
    for wrapper in ["Promise<", "PromiseLike<"] {
        if let Some(rest) = trimmed.strip_prefix(wrapper) {
            if let Some(inner) = rest.strip_suffix('>') {
                return inner.trim();
            }
        }
    }
    trimmed
}

fn parameter_facts(method: Node, src: &str) -> Vec<ParamFacts> {
    let Some(parameters) = method.child_by_field_name("parameters") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut cursor = parameters.walk();
    for param in parameters.children(&mut cursor) {
        if param.kind() != "required_parameter" && param.kind() != "optional_parameter" {
            continue;
        }
        let decorators = decorators_of(param, src);
        let Some(decorator) = decorators.first() else {
            continue;
        };
        let kind = match decorator.name.as_str() {
            "Param" => ParamKind::Path,
            "Query" => ParamKind::Query,
            "Body" => ParamKind::Body,
            "Headers" | "Header" => ParamKind::Header,
            "UploadedFile" | "UploadedFiles" => ParamKind::Multipart,
            // Request/Response/Next/Session/Ip/HostParam and application-defined auth
            // decorators derive from the request but are not the JSON wire shape.
            _ => ParamKind::Ignored,
        };
        let name = decorator.args.first().and_then(|arg| arg.first_string());
        let type_text = param
            .child_by_field_name("type")
            .and_then(|annotation| annotation.named_child(0))
            .map(|t| text(t, src).trim().to_string());
        out.push(ParamFacts {
            kind,
            name,
            type_text,
        });
    }
    out
}

fn declared_responses(method: Node, src: &str) -> Vec<(Option<u16>, String)> {
    let mut out = Vec::new();
    for decorator in decorators_of(method, src) {
        if decorator.name != "ApiResponse" {
            continue;
        }
        let status = decorator.object_field("status").and_then(|arg| match arg {
            Arg::Number(n) => Some(*n as u16),
            _ => None,
        });
        if let Some(Arg::Ident(name)) = decorator.object_field("type") {
            let name = name.rsplit('.').next().unwrap_or(name).to_string();
            out.push((status, name));
        }
    }
    out
}

/// Walk every node of a parsed file looking for `setGlobalPrefix` calls. The walk is
/// iterative so a deeply nested function body cannot overflow the stack.
fn collect_global_prefix(root: Node, src: &str, candidates: &mut BTreeSet<String>) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(prefix) = global_prefix_argument(node, src) {
                candidates.insert(prefix);
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }
}

fn global_prefix_argument(call: Node, src: &str) -> Option<String> {
    let function = call.child_by_field_name("function")?;
    let callee = text(function, src).trim();
    if !callee.ends_with(".setGlobalPrefix") {
        return None;
    }
    let arguments = call.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let first = arguments
        .children(&mut cursor)
        .find(|child| child.is_named())?;
    if first.kind() != "string" {
        return None;
    }
    let value = unquote(text(first, src)).trim_matches('/').to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn join_route(global_prefix: Option<&str>, prefix: &str, suffix: &str) -> String {
    let mut route = String::new();
    for part in [global_prefix.unwrap_or(""), prefix, suffix] {
        for segment in part.trim().trim_matches('/').split('/') {
            if segment.is_empty() {
                continue;
            }
            route.push('/');
            route.push_str(segment);
        }
    }
    if route.is_empty() {
        "/".to_string()
    } else {
        route
    }
}

fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    let without = if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('`') && trimmed.ends_with('`'))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        return trimmed.to_string();
    };
    let mut out = String::with_capacity(without.len());
    let mut chars = without.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

pub fn is_provider_ts_file(path: &str) -> bool {
    if !(path.ends_with(".ts") || path.ends_with(".tsx")) {
        return false;
    }
    if path.ends_with(".d.ts") {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".spec.ts")
        || name.ends_with(".test.ts")
        || name.ends_with(".spec.tsx")
        || name.ends_with(".test.tsx")
        || name.ends_with(".e2e-spec.ts")
    {
        return false;
    }
    !path.split('/').any(|part| PROVIDER_DIRS.contains(&part))
}

/// True when this path names a file the NestJS provider lane is expected to read.
/// Used by role classification so `.ts` inside a NestJS backend is provider source,
/// not consumer source.
pub fn is_controller_ts_path(path: &str) -> bool {
    is_provider_ts_file(path) && path.ends_with(".controller.ts")
}

fn walk_ts(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if PROVIDER_DIRS.contains(&name.as_str()) {
                continue;
            }
            if path.join(".git").exists() {
                continue;
            }
            walk_ts(&path, out)?;
        } else if path.is_file() {
            let rel = path_to_posix(&path);
            if is_provider_ts_file(&rel) {
                out.push(path);
            }
        }
    }
    Ok(())
}

fn path_to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn module_candidates(from_file: &str, module: &str) -> Vec<String> {
    let module = module.trim_end_matches(".js");
    let base_dir = from_file.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for part in module.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let base = parts.join("/");
    vec![
        format!("{}.ts", base),
        format!("{}.tsx", base),
        format!("{}/index.ts", base),
    ]
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Provider detection from source text rather than a file-name convention: a
/// directory is a NestJS provider root when at least one `.ts` file imports from
/// `@nestjs/common` and declares a `@Controller` class.
pub fn looks_like_nestjs_root(root: &Path) -> bool {
    let mut files = Vec::new();
    if walk_ts(root, &mut files).is_err() {
        return false;
    }
    files.truncate(2_000);
    for path in files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if !content.contains("@nestjs/common") || !content.contains("@Controller") {
            continue;
        }
        if content.contains("from '@nestjs/common'") || content.contains("from \"@nestjs/common\"")
        {
            return true;
        }
    }
    false
}
