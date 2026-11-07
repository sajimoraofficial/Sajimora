//! file_system_routes.rs — SvelteKit, Nuxt/Nitro, Remix and Astro endpoint extraction.
//!
//! These frameworks derive the URL from the file path and export one function per HTTP
//! method. Shapes are read from literal `json({...})` / `Response.json({...})` /
//! `new Response(JSON.stringify({...}))` calls (and, for Nuxt, a returned object literal).
//! Unmodelled bodies stay unresolved; nothing is fabricated.

use crate::ts_shape::{object_literal, ShapeContext};
use anyhow::{anyhow, Result};
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ContractDirection, EndpointContract, EndpointIdentityContract, ParamContract, PrimitiveScalar,
    PrimitiveWireType, SourceLanguage, SourceProvenance, StatusCodeFamily, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use contract_core::routes::normalize_route_segments;
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "dist",
    "build",
    "out",
    "coverage",
    ".output",
];

const METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFramework {
    SvelteKit,
    Nuxt,
    Remix,
    Astro,
    /// Deno Fresh (`routes/**`, `handler` object exports).
    Fresh,
}

impl FileFramework {
    pub fn profile(self) -> &'static str {
        match self {
            FileFramework::SvelteKit => "SVELTEKIT",
            FileFramework::Nuxt => "NUXT",
            FileFramework::Remix => "REMIX",
            FileFramework::Astro => "ASTRO",
            FileFramework::Fresh => "FRESH",
        }
    }
}

pub fn framework_from_path(path: &str) -> Option<FileFramework> {
    let path = path.replace('\\', "/");
    if path.ends_with(".d.ts") {
        return None;
    }
    if !(path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs"))
    {
        return None;
    }
    if path.ends_with("+server.ts") || path.ends_with("+server.js") {
        return Some(FileFramework::SvelteKit);
    }
    if path.contains("/server/api/") || path.starts_with("server/api/") {
        return Some(FileFramework::Nuxt);
    }
    if path.contains("/server/routes/") || path.starts_with("server/routes/") {
        return Some(FileFramework::Nuxt);
    }
    if path.contains("/app/routes/") || path.starts_with("app/routes/") {
        return Some(FileFramework::Remix);
    }
    if (path.contains("/src/pages/") || path.starts_with("src/pages/")) && !path.ends_with(".astro")
    {
        return Some(FileFramework::Astro);
    }
    // Fresh routes live in `routes/`; files starting with `_` (`_middleware`,
    // `_app`, `_layout`, `_404`, `_error`) are infrastructure, and SvelteKit's
    // `src/routes` stays with the SvelteKit lane.
    let in_fresh_routes = path.starts_with("routes/") || path.contains("/routes/");
    if in_fresh_routes && !path.starts_with("src/routes/") && !path.contains("/src/routes/") {
        let basename = path.rsplit('/').next().unwrap_or("");
        if !basename.starts_with('_') && !basename.starts_with('+') {
            return Some(FileFramework::Fresh);
        }
    }
    None
}

pub fn is_file_router_source_file(path: &str) -> bool {
    framework_from_path(path).is_some()
}

#[derive(Debug, Clone, Copy, Default)]
struct FileRouterEvidence {
    fresh: bool,
    remix: bool,
    astro: bool,
}

impl FileRouterEvidence {
    fn observe_source(&mut self, content: &str) {
        if content.contains("@remix-run/")
            || content.contains("from \"remix\"")
            || content.contains("from 'remix'")
        {
            self.remix = true;
        }
        if content.contains("astro:")
            || content.contains("@astrojs/")
            || content.contains("from \"astro\"")
            || content.contains("from 'astro'")
        {
            self.astro = true;
        }
        if content.contains("$fresh/")
            || content.contains("@fresh/")
            || content.contains("fresh/server")
        {
            self.fresh = true;
        }
    }
}

/// Remix and Astro reserve ordinary directory names (`app/routes`, `src/pages`)
/// that any Node/React app may use, and Fresh reserves `routes/`. A path shape
/// alone is not evidence that the repository uses the framework: an Express app
/// with `src/app/routes` must not be read as Remix, and a Nuxt proxy with a
/// `routes/` directory must not be read as Fresh. Configuration, dependencies or
/// framework imports decide. SvelteKit's `+server` and Nuxt's `server/api` are
/// unambiguous on their own.
fn root_file_router_evidence(root: &Path) -> FileRouterEvidence {
    let mut evidence = FileRouterEvidence {
        fresh: fresh_root_evidence(root),
        remix: false,
        astro: false,
    };
    let pkg = fs::read_to_string(root.join("package.json")).unwrap_or_default();
    if pkg.contains("\"@remix-run/") || pkg.contains("\"remix\"") {
        evidence.remix = true;
    }
    if pkg.contains("\"astro\"") || pkg.contains("\"@astrojs/") {
        evidence.astro = true;
    }
    for name in ["remix.config.js", "remix.config.ts", "remix.config.mjs"] {
        if root.join(name).is_file() {
            evidence.remix = true;
        }
    }
    for name in ["astro.config.mjs", "astro.config.ts", "astro.config.js"] {
        if root.join(name).is_file() {
            evidence.astro = true;
        }
    }
    for name in [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mts",
        "vite.config.mjs",
    ] {
        if let Ok(content) = fs::read_to_string(root.join(name)) {
            if content.contains("remix(")
                || content.contains("@remix-run/dev")
                || content.contains("remix vite")
            {
                evidence.remix = true;
            }
            if content.contains("astro(") || content.contains("@astrojs/") {
                evidence.astro = true;
            }
        }
    }
    evidence
}

fn framework_evidenced(framework: FileFramework, evidence: &FileRouterEvidence) -> bool {
    match framework {
        FileFramework::Fresh => evidence.fresh,
        FileFramework::Remix => evidence.remix,
        FileFramework::Astro => evidence.astro,
        FileFramework::SvelteKit | FileFramework::Nuxt => true,
    }
}

pub fn looks_like_file_router_root(root: &Path) -> bool {
    let mut files = Vec::new();
    if walk_files(root, &mut files).is_err() {
        return false;
    }
    let mut evidence = root_file_router_evidence(root);
    files.iter().any(|path| {
        let rel = path.to_string_lossy().replace('\\', "/");
        let Some(framework) = framework_from_path(&rel) else {
            return false;
        };
        if !framework_evidenced(framework, &evidence) {
            if let Ok(content) = fs::read_to_string(path) {
                evidence.observe_source(&content);
            }
        }
        framework_evidenced(framework, &evidence)
    })
}

fn fresh_root_evidence(root: &Path) -> bool {
    if root.join("fresh.gen.ts").is_file() || root.join("fresh.gen.js").is_file() {
        return true;
    }
    // Fresh 2 projects generate `_fresh/` and use the Vite plugin; the plugin
    // dependency lives in vite.config rather than a `fresh` import in deno.json.
    if root.join("_fresh").is_dir() {
        return true;
    }
    for name in ["deno.json", "deno.jsonc"] {
        if let Ok(content) = fs::read_to_string(root.join(name)) {
            if content.contains("fresh")
                || content.contains("jsr:@fresh/")
                || content.contains("_fresh/server.js")
            {
                return true;
            }
        }
    }
    for name in ["package.json"] {
        if let Ok(content) = fs::read_to_string(root.join(name)) {
            if content.contains("\"fresh\"") || content.contains("@fresh/plugin") {
                return true;
            }
        }
    }
    for name in [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mts",
        "vite.config.mjs",
    ] {
        if let Ok(content) = fs::read_to_string(root.join(name)) {
            if content.contains("@fresh/") || content.contains("fresh(") {
                return true;
            }
        }
    }
    false
}

pub fn detect_file_framework(sources: &[(String, String)]) -> Option<FileFramework> {
    let mut found = None;
    for (path, _) in sources {
        if let Some(framework) = framework_from_path(path) {
            found = Some(match (found, framework) {
                (None, first) => first,
                (Some(existing), candidate) if existing == candidate => existing,
                // A repo with several frameworks is ambiguous; keep the first deterministic one.
                (Some(existing), _) => existing,
            });
        }
    }
    found
}

pub struct FileSystemRouteExtractor {
    sources: Vec<(String, String)>,
    framework: FileFramework,
}

impl FileSystemRouteExtractor {
    pub fn new(repo_root: PathBuf, src_dir: &Path) -> Result<Self> {
        let mut files = Vec::new();
        walk_files(src_dir, &mut files)?;
        files.sort();
        let mut sources = Vec::new();
        for path in files {
            let rel = path
                .strip_prefix(&repo_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
            if is_file_router_source_file(&rel) {
                if let Ok(content) = fs::read_to_string(&path) {
                    sources.push((rel, content));
                }
            }
        }
        Self::from_sources_scoped(&repo_root, sources)
    }

    pub fn from_blobs(repo_root: PathBuf, sources: Vec<(String, String)>) -> Result<Self> {
        Self::from_sources_scoped(&repo_root, sources)
    }

    /// Selects the framework only from sources the repository has framework evidence for.
    /// Source imports count as evidence alongside configuration files, so a stub project
    /// without a package manifest is still read correctly.
    pub fn from_sources_scoped(repo_root: &Path, sources: Vec<(String, String)>) -> Result<Self> {
        let mut evidence = root_file_router_evidence(repo_root);
        for (_, content) in &sources {
            evidence.observe_source(content);
        }
        let scoped = sources
            .into_iter()
            .filter(|(path, _)| {
                framework_from_path(path)
                    .is_some_and(|framework| framework_evidenced(framework, &evidence))
            })
            .collect();
        Self::from_sources(scoped)
    }

    pub fn from_sources(mut sources: Vec<(String, String)>) -> Result<Self> {
        sources.sort_by(|a, b| a.0.cmp(&b.0));
        sources.dedup_by(|a, b| a.0 == b.0);
        let framework = detect_file_framework(&sources)
            .ok_or_else(|| anyhow!("No SvelteKit/Nuxt/Remix/Astro endpoint file was found"))?;
        Ok(Self { sources, framework })
    }

    pub fn framework(&self) -> FileFramework {
        self.framework
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
        let mut blockers = Vec::new();
        let mut unresolved_endpoints = Vec::new();

        for (file, content) in &self.sources {
            if framework_from_path(file) != Some(self.framework) {
                continue;
            }
            let Some(route) = route_for(self.framework, file) else {
                continue;
            };
            let Some(mut facts) = parse_endpoint(file, content, &route, self.framework)? else {
                continue;
            };
            blockers.append(&mut facts.blockers);
            for method in facts.methods {
                let normalized = normalize_route_segments(&route);
                let path_parameters: Vec<ParamContract> = route
                    .split('/')
                    .filter(|segment| segment.starts_with(':'))
                    .map(|segment| {
                        let name = segment
                            .trim_start_matches(':')
                            .trim_end_matches('*')
                            .to_string();
                        ParamContract {
                            name: name.clone(),
                            r#type: WireType::Primitive(PrimitiveWireType {
                                scalar: PrimitiveScalar::String,
                                format: None,
                                provenance: Some(provenance(file, method.line)),
                            }),
                            required: true,
                            validation_constraints: None,
                            provenance: Some(provenance(file, method.line)),
                        }
                    })
                    .collect();

                let response_body = method.response.clone();
                let response_unresolved = response_body.is_none();
                if response_unresolved {
                    unresolved_endpoints.push(format!("{} {}", method.verb, route));
                }
                endpoints.push(EndpointContract {
                    identity: EndpointIdentityContract {
                        service: Some(service_id.to_string()),
                        http_method: method.verb.clone(),
                        normalized_route: normalized.clone(),
                        direction: ContractDirection::Response,
                    },
                    path_parameters: path_parameters.clone(),
                    query_parameters: Vec::new(),
                    headers: Vec::new(),
                    body: response_body,
                    provenance: provenance(file, method.line),
                    evidence_classification: None,
                    declared_responses: None,
                    status_code_family: Some(StatusCodeFamily::Success2xx),
                    mapping_conditions: Some(serde_json::json!({
                        "params": [],
                        "complete": true
                    })),
                });

                let body_may_exist = matches!(method.verb.as_str(), "POST" | "PUT" | "PATCH");
                let request_body = method.request_body.clone();
                if body_may_exist && request_body.is_none() {
                    unresolved_endpoints.push(format!("{} {} request body", method.verb, route));
                }
                if !path_parameters.is_empty() || request_body.is_some() {
                    endpoints.push(EndpointContract {
                        identity: EndpointIdentityContract {
                            service: Some(service_id.to_string()),
                            http_method: method.verb,
                            normalized_route: normalized,
                            direction: ContractDirection::Request,
                        },
                        path_parameters,
                        query_parameters: Vec::new(),
                        headers: Vec::new(),
                        body: request_body,
                        provenance: provenance(file, method.line),
                        evidence_classification: None,
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
            (
                &a.identity.normalized_route.raw_path,
                &a.identity.http_method,
            )
                .cmp(&(
                    &b.identity.normalized_route.raw_path,
                    &b.identity.http_method,
                ))
                .then_with(|| match (&a.identity.direction, &b.identity.direction) {
                    (ContractDirection::Request, ContractDirection::Response) => {
                        std::cmp::Ordering::Less
                    }
                    (ContractDirection::Response, ContractDirection::Request) => {
                        std::cmp::Ordering::Greater
                    }
                    _ => std::cmp::Ordering::Equal,
                })
        });
        unresolved_endpoints.sort();
        unresolved_endpoints.dedup();
        blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
        blockers.dedup_by(|a, b| a.code == b.code && a.message == b.message && a.file == b.file);

        let payload = BackendContractPayload {
            serialization_assumptions: None,
            base_urls: vec![],
            proxy_prefixes: vec![],
            endpoints,
            type_pool: None,
            path_pool: None,
        };
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
                api_version: api_version.map(|value| value.to_string()),
                parent_commit: parent_commit.to_string(),
                candidate_snapshot: candidate_snapshot.to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: Some(self.framework.profile().to_string()),
                codec_profile: Some("JSON_STRINGIFY_V1".to_string()),
                client_profile: None,
                config_fingerprint: Some(format!("file-router:{}", self.framework.profile())),
            },
            completeness,
            signature: None,
            issued_at_unix: None,
            payload: ArtifactPayload::Backend(payload),
            integrity: None,
            raw_value: None,
        };
        let digest = compute_envelope_digest(&env)
            .map_err(|error| anyhow!("Failed to compute envelope digest: {error}"))?;
        env.integrity = Some(ArtifactIntegrity { sha256: digest });
        Ok(env)
    }

    pub fn sources(&self) -> &[(String, String)] {
        &self.sources
    }
}

struct MethodFacts {
    verb: String,
    line: u32,
    response: Option<WireType>,
    request_body: Option<WireType>,
}

struct EndpointFacts {
    methods: Vec<MethodFacts>,
    blockers: Vec<ArtifactBlocker>,
}

fn provenance(file: &str, line: u32) -> SourceProvenance {
    SourceProvenance {
        sha256: None,
        language: SourceLanguage::TypeScript,
        file: file.to_string(),
        line,
        column: None,
        ast_identity: None,
        annotation_or_schema: None,
        evidence_classification: None,
    }
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

fn strip_code_extension(path: &str) -> &str {
    for extension in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        if let Some(stripped) = path.strip_suffix(extension) {
            return stripped;
        }
    }
    path
}

fn rename_segments(path: &str) -> Vec<String> {
    path.split('/')
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
        .collect()
}

pub fn route_for(framework: FileFramework, rel_path: &str) -> Option<String> {
    let path = rel_path.replace('\\', "/");
    match framework {
        FileFramework::SvelteKit => {
            let index = path
                .find("/src/routes/")
                .or_else(|| path.strip_prefix("src/routes/").map(|_| 0))?;
            let tail = if index == 0 && path.starts_with("src/routes/") {
                &path["src/routes/".len()..]
            } else {
                &path[index + "/src/routes/".len()..]
            };
            let tail = tail
                .strip_suffix("/+server.ts")
                .or_else(|| tail.strip_suffix("/+server.js"))
                .or_else(|| tail.strip_suffix("+server.ts"))
                .or_else(|| tail.strip_suffix("+server.js"))?;
            let segments: Vec<String> = rename_segments(tail)
                .into_iter()
                .filter(|segment| !(segment.starts_with('(') && segment.ends_with(')')))
                .collect();
            Some(if segments.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", segments.join("/"))
            })
        }
        FileFramework::Nuxt => {
            let (mount, tail) = if let Some(index) = path.find("/server/api/") {
                ("/api", &path[index + "/server/api/".len()..])
            } else if let Some(tail) = path.strip_prefix("server/api/") {
                ("/api", tail)
            } else if let Some(index) = path.find("/server/routes/") {
                ("", &path[index + "/server/routes/".len()..])
            } else if let Some(tail) = path.strip_prefix("server/routes/") {
                ("", tail)
            } else {
                return None;
            };
            let mut stem = strip_code_extension(tail).to_string();
            for suffix in [
                ".get", ".post", ".put", ".delete", ".patch", ".head", ".options",
            ] {
                if let Some(stripped) = stem.strip_suffix(suffix) {
                    stem = stripped.to_string();
                    break;
                }
            }
            let mut segments = rename_segments(&stem);
            if segments.last().is_some_and(|segment| segment == "index") {
                segments.pop();
            }
            let base = mount.to_string();
            Some(if segments.is_empty() {
                if base.is_empty() {
                    "/".to_string()
                } else {
                    base
                }
            } else {
                format!("{base}/{}", segments.join("/"))
            })
        }
        FileFramework::Remix => {
            let tail = path
                .find("/app/routes/")
                .map(|index| &path[index + "/app/routes/".len()..])
                .or_else(|| path.strip_prefix("app/routes/"))?;
            let stem = strip_code_extension(tail);
            // Remix v1 escapes a literal dot as `[.]` in a file name
            // (`jokes[.]rss.tsx` serves `/jokes.rss`); the other dots delimit
            // nested route segments.
            let stem = stem.replace("[.]", "\u{0}");
            let mut segments = Vec::new();
            for segment in stem.split('.') {
                if segment == "_index" || segment == "index" {
                    continue;
                }
                if segment.starts_with('_') {
                    continue;
                }
                let segment = segment.trim_start_matches('(').trim_end_matches(')');
                if segment.is_empty() || segment.starts_with('_') {
                    continue;
                }
                let segment = segment.replace('\u{0}', ".");
                if let Some(param) = segment.strip_prefix('$') {
                    segments.push(format!(":{}", param));
                } else {
                    segments.push(segment);
                }
            }
            Some(if segments.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", segments.join("/"))
            })
        }
        FileFramework::Astro => {
            let tail = path
                .find("/src/pages/")
                .map(|index| &path[index + "/src/pages/".len()..])
                .or_else(|| path.strip_prefix("src/pages/"))?;
            let stem = strip_code_extension(tail);
            let mut segments = rename_segments(stem);
            if segments.last().is_some_and(|segment| segment == "index") {
                segments.pop();
            }
            Some(if segments.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", segments.join("/"))
            })
        }
        FileFramework::Fresh => {
            let tail = path
                .find("/routes/")
                .map(|index| &path[index + "/routes/".len()..])
                .or_else(|| path.strip_prefix("routes/"))?;
            let stem = strip_code_extension(tail);
            let mut segments: Vec<String> = rename_segments(stem)
                .into_iter()
                .filter(|segment| !(segment.starts_with('(') && segment.ends_with(')')))
                .collect();
            if segments.last().is_some_and(|segment| segment == "index") {
                segments.pop();
            }
            Some(if segments.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", segments.join("/"))
            })
        }
    }
}

fn method_from_nuxt_path(rel_path: &str) -> Option<String> {
    let normalized = rel_path.replace('\\', "/");
    let stem = strip_code_extension(&normalized);
    for (suffix, verb) in [
        (".get", "GET"),
        (".post", "POST"),
        (".put", "PUT"),
        (".delete", "DELETE"),
        (".patch", "PATCH"),
        (".head", "HEAD"),
        (".options", "OPTIONS"),
    ] {
        if stem.ends_with(suffix) {
            return Some(verb.to_string());
        }
    }
    None
}

fn parse_endpoint(
    file: &str,
    content: &str,
    route: &str,
    framework: FileFramework,
) -> Result<Option<EndpointFacts>> {
    let mut parser = Parser::new();
    let language = if file.ends_with(".tsx") || file.ends_with(".jsx") || file.ends_with(".js") {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    parser
        .set_language(&language)
        .map_err(|error| anyhow!("Failed to set tree-sitter language: {error}"))?;
    let Some(tree) = parser.parse(content, None) else {
        return Ok(Some(EndpointFacts {
            methods: Vec::new(),
            blockers: vec![ArtifactBlocker {
                code: "FILE_ROUTER_PARSE_ERROR".to_string(),
                message: "The endpoint file could not be parsed; its handlers are absent"
                    .to_string(),
                file: Some(file.to_string()),
            }],
        }));
    };
    let root = tree.root_node();
    let mut blockers = Vec::new();
    if root.has_error() {
        blockers.push(ArtifactBlocker {
            code: "FILE_ROUTER_PARSE_ERROR".to_string(),
            message: "The endpoint file contains syntax the TypeScript grammar could not read; handlers may be absent".to_string(),
            file: Some(file.to_string()),
        });
    }

    if framework == FileFramework::Fresh && has_default_export(root, content) {
        // A Fresh UI page exports a default component; its `handler` object
        // serves page loads and form actions, not a JSON API endpoint.
        return Ok(None);
    }
    let exported = exported_method_names(root, content, framework, file);
    if exported.is_empty() {
        if framework == FileFramework::Remix {
            // A Remix UI route with neither loader nor action is not an API endpoint.
            return Ok(None);
        }
        blockers.push(ArtifactBlocker {
            code: "FILE_ROUTER_HANDLER_UNRESOLVED".to_string(),
            message:
                "No exported HTTP method handler was found; the route is absent from this artifact"
                    .to_string(),
            file: Some(file.to_string()),
        });
        return Ok(Some(EndpointFacts {
            methods: Vec::new(),
            blockers,
        }));
    }

    let ctx = ShapeContext {
        content,
        file,
        sha256: None,
    };
    let response = literal_response(root, content, &ctx);
    let request_body = request_body_type(root, content);
    let line = 1;
    let methods = exported
        .into_iter()
        .map(|verb| MethodFacts {
            verb,
            line,
            response: response.clone(),
            request_body: request_body.clone().map(|name| {
                WireType::Unknown(contract_core::ir::UnknownWireType {
                    reason: format!("Request body type `{name}` is declared in source but not expanded by the file-system lane"),
                    provenance: Some(provenance(file, line)),
                })
            }),
        })
        .collect();
    let _ = route;
    Ok(Some(EndpointFacts { methods, blockers }))
}

fn exported_method_names(
    root: Node,
    content: &str,
    framework: FileFramework,
    file: &str,
) -> Vec<String> {
    if framework == FileFramework::Nuxt {
        if let Some(verb) = method_from_nuxt_path(file) {
            return vec![verb];
        }
        return METHODS.iter().map(|verb| verb.to_string()).collect();
    }
    if framework == FileFramework::Fresh {
        return fresh_handler_verbs(root, content);
    }
    let mut verbs = Vec::new();
    let mut has_loader = false;
    let mut has_action = false;
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let mut declaration = child;
        if child.kind() == "export_statement" {
            if let Some(inner) = child.child_by_field_name("declaration") {
                declaration = inner;
            }
        }
        match declaration.kind() {
            "function_declaration" => {
                if let Some(name) = declaration.child_by_field_name("name") {
                    let name = text(name, content).trim();
                    if METHODS.contains(&name) {
                        verbs.push(name.to_string());
                    } else if name == "loader" {
                        has_loader = true;
                    } else if name == "action" {
                        has_action = true;
                    }
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut decl_cursor = declaration.walk();
                for declarator in declaration.named_children(&mut decl_cursor) {
                    if declarator.kind() != "variable_declarator" {
                        continue;
                    }
                    let Some(name) = declarator.child_by_field_name("name") else {
                        continue;
                    };
                    let name = text(name, content).trim();
                    if METHODS.contains(&name) {
                        verbs.push(name.to_string());
                    } else if name == "loader" {
                        // Remix v1/v2 commonly declare `export let loader` or
                        // `export const loader`; only `export function loader`
                        // used to be recognized, which silently dropped real
                        // resource routes.
                        has_loader = true;
                    } else if name == "action" {
                        has_action = true;
                    }
                }
            }
            _ => {}
        }
    }
    if framework == FileFramework::Remix {
        if has_loader && !verbs.iter().any(|verb| verb == "GET") {
            verbs.push("GET".to_string());
        }
        if has_action {
            for verb in ["POST", "PUT", "PATCH", "DELETE"] {
                if !verbs.iter().any(|existing| existing == verb) {
                    verbs.push(verb.to_string());
                }
            }
        }
    }
    verbs.sort();
    verbs.dedup();
    verbs
}

/// Fresh exports one `handler` object whose keys are the HTTP methods:
/// `export const handler: Handlers = { GET() {...}, POST() {...} }`.
fn fresh_handler_verbs(root: Node, content: &str) -> Vec<String> {
    let mut verbs = Vec::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "export_statement" {
            continue;
        }
        let Some(declaration) = child.child_by_field_name("declaration") else {
            continue;
        };
        if !matches!(
            declaration.kind(),
            "lexical_declaration" | "variable_declaration"
        ) {
            continue;
        }
        let mut decl_cursor = declaration.walk();
        for declarator in declaration.named_children(&mut decl_cursor) {
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            let Some(name) = declarator.child_by_field_name("name") else {
                continue;
            };
            if text(name, content).trim() != "handler" {
                continue;
            }
            let Some(value) = declarator.child_by_field_name("value") else {
                continue;
            };
            let Some(object) = first_object_node(value) else {
                continue;
            };
            let mut object_cursor = object.walk();
            for member in object.named_children(&mut object_cursor) {
                // `{ GET() {} }` parses as a method_definition; `{ GET: fn }`
                // parses as a pair.
                let key = match member.kind() {
                    "method_definition" => member.child_by_field_name("name"),
                    "pair" => member.child_by_field_name("key"),
                    _ => continue,
                };
                let Some(key) = key else {
                    continue;
                };
                let key = text(key, content).trim().trim_matches('"');
                if METHODS.contains(&key) {
                    verbs.push(key.to_string());
                }
            }
        }
    }
    verbs.sort();
    verbs.dedup();
    verbs
}

fn first_object_node(node: Node) -> Option<Node> {
    if node.kind() == "object" {
        return Some(node);
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            if let Some(found) = first_object_node(child) {
                return Some(found);
            }
        }
    }
    None
}

fn has_default_export(root: Node, content: &str) -> bool {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "export_statement"
            && text(child, content)
                .trim_start()
                .starts_with("export default")
        {
            return true;
        }
    }
    false
}

fn literal_response(root: Node, content: &str, ctx: &ShapeContext) -> Option<WireType> {
    let mut shape = None;
    walk(root, &mut |node| {
        if shape.is_some() {
            return;
        }
        if matches!(
            node.kind(),
            "arrow_function" | "function_expression" | "function_declaration"
        ) {
            if let Some(body) = node.child_by_field_name("body") {
                let body = unwrap_parenthesized(body);
                if body.kind() == "object" {
                    shape = object_literal(body, ctx);
                }
            }
            return;
        }
        match node.kind() {
            "call_expression" => {
                let Some(function) = node.child_by_field_name("function") else {
                    return;
                };
                let name = text(function, content).trim();
                let is_json =
                    name == "json" || name.ends_with(".json") || name.ends_with("JSON.stringify");
                if !is_json {
                    return;
                }
                let Some(arguments) = node.child_by_field_name("arguments") else {
                    return;
                };
                let mut cursor = arguments.walk();
                let first = arguments.named_children(&mut cursor).next();
                if let Some(first) = first {
                    shape = object_literal(first, ctx);
                }
            }
            "return_statement" => {
                if let Some(value) = node.named_child(0) {
                    if value.kind() == "object" {
                        shape = object_literal(value, ctx);
                    }
                }
            }
            _ => {}
        }
    });
    shape
}

fn request_body_type(root: Node, content: &str) -> Option<String> {
    let mut found = None;
    walk(root, &mut |node| {
        if found.is_some() {
            return;
        }
        let raw = text(node, content);
        if node.kind() == "as_expression" {
            if let Some(index) = raw.find(" as ") {
                let left = raw[..index].trim();
                if left.contains(".json()") || left.contains("readBody(") {
                    let ty = raw[index + 4..].trim().trim_end_matches(';').trim();
                    if !ty.is_empty() {
                        found = Some(ty.to_string());
                    }
                }
            }
        }
        if node.kind() == "variable_declarator" {
            if raw.contains(".json()") || raw.contains("readBody(") {
                if let Some(eq) = raw.find('=') {
                    let left = raw[..eq].trim();
                    if let Some(colon) = left.find(':') {
                        let ty = left[colon + 1..].trim();
                        if !ty.is_empty() {
                            found = Some(ty.to_string());
                        }
                    }
                }
            }
        }
    });
    found
}

fn unwrap_parenthesized(mut node: Node) -> Node {
    while node.kind() == "parenthesized_expression" {
        match node.named_child(0) {
            Some(inner) => node = inner,
            None => break,
        }
    }
    node
}

fn text<'a>(node: Node<'a>, content: &'a str) -> &'a str {
    &content[node.start_byte()..node.end_byte()]
}

fn walk<F: FnMut(Node)>(node: Node, visit: &mut F) {
    visit(node);
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index as u32) {
            walk(child, visit);
        }
    }
}
