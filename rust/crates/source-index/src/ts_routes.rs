//! ts_routes.rs — High-performance native TypeScript & JavaScript AST route extractor.
//!
//! Uses Tree-sitter TypeScript and Rayon for multi-threaded parallel parsing across
//! all CPU cores. Extracts Angular HttpClient, Axios, and Fetch calls in seconds.

use crate::js_observed::unwrap_expression;
use anyhow::{anyhow, Result};
use contract_core::envelope::{
    seal_envelope, ArtifactBlocker, ArtifactCompleteness, ArtifactKind, ArtifactPayload,
    ArtifactSnapshotRef, ConsumerLocation, ContractArtifactEnvelope, DecoderKind,
    ExtractionProfile, FrontendClientContract, FrontendContractPayload,
    ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ArrayWireType, EnumWireType, NullableWireType, ObjectWireType, OptionalWireType,
    PrimitiveScalar, PrimitiveWireType, RefWireType, SourceLanguage, SourceProvenance,
    UnionWireType, UnknownWireType, WirePropertyContract, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tree_sitter::{Node, Parser};

/// Raw client call site extracted from an AST file.
#[derive(Debug, Clone)]
pub struct RawClientCall {
    pub file: String,
    pub line: u32,
    /// Byte offset of the call node. Re-parse passes use this as the call identity; a line
    /// number is not unique when a minified or generated file puts several calls on one line.
    pub anchor: usize,
    pub http_method: String,
    pub raw_url: String,
    pub normalized_route: String,
    pub response_type: Option<String>,
    /// The call's options set a non-JSON `responseType` (e.g. Angular's `'text'`/`'blob'`).
    /// The generic argument then describes a value the client derives after reading the body,
    /// not the wire body itself, so the response shape must abstain.
    pub non_json_response_type: Option<String>,
    pub request_body_expr: Option<String>,
    /// The declared type of the identifier passed as the request body, when this pass saw
    /// exactly one annotated binding for it. The expression alone says what was written at
    /// the call site; this says what the compiler believes is sent.
    pub request_body_type: Option<String>,
    /// The call site passed a literal `null`/`undefined` body. That is a deliberate
    /// "no body", not an expression this pass failed to follow.
    pub request_body_explicit_none: bool,
    pub usage_snippet: String,
    /// Leading interpolations dropped as authority/base-URL prefixes. Their values are not
    /// part of the route path, but the assumption is recorded on the contract.
    pub base_url_assumptions: Vec<String>,
    /// For a call published through a wrapper hop, the byte offset of the wrapper's own
    /// client call. The site names the wrapper rather than a transport, so the observed
    /// pass cannot re-derive which envelope (`res.data`, `res.body`) the response arrives in.
    pub transport_anchor: Option<usize>,
    pub observed_response: Option<contract_core::ir::ObservedResponseEvidence>,
    pub observed_request_body: Option<contract_core::ir::ObservedRequestBody>,
}

/// A local type name bound by an import statement.
#[derive(Debug, Clone)]
struct ImportBinding {
    module: String,
    imported: String,
}

/// A symbol exported or re-exported by a module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportBinding {
    pub module: String,
    pub source_symbol: String,
}

/// A `type` alias declaration, kept as a type expression so it can be expanded at its
/// use sites. `interface` declarations are already structural and need no expansion.
#[derive(Debug, Clone, PartialEq)]
struct AliasDef {
    file: String,
    line: u32,
    params: Vec<String>,
    body: TypeExpr,
}

/// A generic `interface` declaration kept as a type expression, so the type parameters an
/// `interface Foo<T>` writes as `T` can be bound to the concrete type the *use site* named.
/// A pooled wire shape cannot carry that information: it is built once, before anyone says
/// what `T` is.
#[derive(Debug, Clone, PartialEq)]
struct GenericDecl {
    file: String,
    line: u32,
    params: Vec<String>,
    body: TypeExpr,
}

/// TypeScript type expression, limited to the subset that changes a wire shape.
#[derive(Debug, Clone, PartialEq)]
enum TypeExpr {
    Name(String),
    Object(Vec<PropExpr>),
    Generic(String, Vec<TypeExpr>),
    Array(Box<TypeExpr>),
    Union(Vec<TypeExpr>),
    Intersection(Vec<TypeExpr>),
    StrLit(String),
    /// A property the source never annotated: the shape is silent, not empty.
    NoAnnotation,
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
struct PropExpr {
    name: String,
    optional: bool,
    r#type: TypeExpr,
}

pub struct TypeScriptRouteExtractor {
    pub repo_root: PathBuf,
    pub ts_root: PathBuf,
    pub calls: Vec<RawClientCall>,
    pub declared_types: BTreeMap<String, WireType>,
    /// Import specifiers per source file, so a type name can resolve to the file that
    /// actually declares it instead of an arbitrary same-named declaration.
    import_maps: BTreeMap<String, HashMap<String, ImportBinding>>,
    /// Re-export declarations per source file for resolving barrel re-exports.
    pub export_maps: BTreeMap<String, HashMap<String, ExportBinding>>,
    /// `type` aliases by pool key, expanded into the pool before it is sealed.
    alias_defs: BTreeMap<String, AliasDef>,
    /// Generic `interface` declarations by pool key, instantiated at each use site.
    generic_decls: BTreeMap<String, GenericDecl>,
    /// `extends` clauses by pool key, merged into the declared object before sealing.
    heritage: BTreeMap<String, Vec<String>>,
    pub source_blockers: Vec<ArtifactBlocker>,
    pub scanned_source_files: usize,
    /// Angular/axios interceptor URL prefixes, when declared with literal evidence.
    interceptor_evidence: Option<serde_json::Value>,
}

struct FileFacts {
    file: String,
    calls: Vec<RawClientCall>,
    types: Vec<(String, WireType)>,
    aliases: Vec<(String, AliasDef)>,
    generics: Vec<(String, GenericDecl)>,
    imports: HashMap<String, ImportBinding>,
    exports: HashMap<String, ExportBinding>,
    /// `ts:<file>#<Name>` to the base type names its `extends` clause names.
    heritage: Vec<(String, Vec<String>)>,
    blockers: Vec<ArtifactBlocker>,
}

impl FileFacts {
    fn clean(
        file: &str,
        calls: Vec<RawClientCall>,
        types: Vec<(String, WireType)>,
        aliases: Vec<(String, AliasDef)>,
        generics: Vec<(String, GenericDecl)>,
        imports: HashMap<String, ImportBinding>,
        exports: HashMap<String, ExportBinding>,
        heritage: Vec<(String, Vec<String>)>,
    ) -> Self {
        FileFacts {
            file: file.to_string(),
            calls,
            types,
            aliases,
            generics,
            imports,
            exports,
            heritage,
            blockers: Vec::new(),
        }
    }

    fn blocked(blocker: ArtifactBlocker) -> Self {
        FileFacts {
            file: blocker.file.clone().unwrap_or_default(),
            calls: Vec::new(),
            types: Vec::new(),
            aliases: Vec::new(),
            generics: Vec::new(),
            imports: HashMap::new(),
            exports: HashMap::new(),
            heritage: Vec::new(),
            blockers: vec![blocker],
        }
    }
}

impl TypeScriptRouteExtractor {
    pub fn new(repo_root: PathBuf, ts_root: &Path) -> Result<Self> {
        let abs_ts_root = if ts_root.is_relative() {
            repo_root.join(ts_root)
        } else {
            ts_root.to_path_buf()
        };

        let mut source_files = Vec::new();
        let mut vue_files = Vec::new();
        collect_ts_files(&abs_ts_root, &mut source_files, &mut vue_files)?;
        // read_dir order is unspecified; call-site grouping depends on it.
        source_files.sort();
        vue_files.sort();

        // Which modules are HTTP clients? Answering it before call extraction lets an
        // arbitrarily named client (transport, conduit, ...) be recognized from the
        // module that defines it instead of from its name.
        let http_modules = collect_http_bearing_modules(&repo_root, &source_files);
        let resolver = ModuleResolver::from_project(&repo_root, &abs_ts_root);
        let module_constants = collect_module_constants(&repo_root, &source_files, &resolver);

        let ts_outcomes: Vec<FileFacts> = source_files
            .par_iter()
            .map(|file_path| {
                analyze_ts_source(
                    &repo_root,
                    file_path,
                    &http_modules,
                    &module_constants,
                    &resolver,
                )
            })
            .collect();
        // Scripts inside SFCs are parsed from a position-preserving mask of the file, so
        // their rows already are SFC rows. Their outcomes follow the plain sources in
        // sorted file order, which keeps the sealed call order deterministic.
        let vue_outcomes: Vec<FileFacts> = vue_files
            .par_iter()
            .map(|file_path| {
                analyze_sfc_source(
                    &repo_root,
                    file_path,
                    &http_modules,
                    &module_constants,
                    &resolver,
                )
            })
            .collect();

        let mut all_calls = Vec::new();
        let mut declared_types: BTreeMap<String, WireType> = BTreeMap::new();
        let mut import_maps = BTreeMap::new();
        let mut export_maps = BTreeMap::new();
        let mut alias_defs = BTreeMap::new();
        let mut generic_decls: BTreeMap<String, GenericDecl> = BTreeMap::new();
        let mut heritage_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut source_blockers = Vec::new();

        for outcome in ts_outcomes.into_iter().chain(vue_outcomes) {
            if !outcome.imports.is_empty() {
                import_maps.insert(outcome.file.clone(), outcome.imports);
            }
            if !outcome.exports.is_empty() {
                export_maps.insert(outcome.file.clone(), outcome.exports);
            }
            all_calls.extend(outcome.calls);
            for (name, wt) in outcome.types {
                // TypeScript merges interface declarations that share a name in the
                // same module. Keeping only the last declaration silently drops the
                // properties contributed by the others.
                match declared_types.entry(name.clone()) {
                    std::collections::btree_map::Entry::Vacant(slot) => {
                        slot.insert(wt);
                    }
                    std::collections::btree_map::Entry::Occupied(mut slot) => {
                        let merged = merge_duplicate_declaration(slot.get().clone(), wt, &name);
                        slot.insert(merged);
                    }
                }
            }
            for (key, bases) in outcome.heritage {
                heritage_map.entry(key).or_default().extend(bases);
            }
            for (key, def) in outcome.aliases {
                alias_defs.insert(key, def);
            }
            for (key, decl) in outcome.generics {
                // Interface declarations that share a name in one module are merged by
                // TypeScript. Two bodies under one key mean neither shape can be
                // instantiated without inventing which declaration owned which property.
                match generic_decls.entry(key) {
                    std::collections::btree_map::Entry::Vacant(slot) => {
                        slot.insert(decl);
                    }
                    std::collections::btree_map::Entry::Occupied(slot) => {
                        if *slot.get() != decl {
                            slot.remove();
                        }
                    }
                }
            }
            source_blockers.extend(outcome.blockers);
        }
        let (interceptor_evidence, interceptor_blockers) =
            collect_interceptor_evidence(&repo_root, &source_files, &module_constants, &resolver);
        source_blockers.extend(interceptor_blockers);
        source_blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));

        let mut all_source_files = source_files.clone();
        all_source_files.extend(vue_files.clone());
        crate::js_observed::attach_js_observed_evidence(
            &repo_root,
            &all_source_files,
            &mut all_calls,
        );

        Ok(TypeScriptRouteExtractor {
            repo_root,
            ts_root: abs_ts_root,
            calls: all_calls,
            declared_types,
            import_maps,
            export_maps,
            alias_defs,
            generic_decls,
            heritage: heritage_map,
            source_blockers,
            scanned_source_files: source_files.len() + vue_files.len(),
            interceptor_evidence,
        })
    }

    pub fn extract_payload(
        &self,
        _service_id: &str,
        target_service_id: &str,
    ) -> (FrontendContractPayload, ArtifactCompleteness) {
        let mut grouped: HashMap<(String, String), Vec<&RawClientCall>> = HashMap::new();

        for call in &self.calls {
            grouped
                .entry((call.http_method.clone(), call.normalized_route.clone()))
                .or_default()
                .push(call);
        }

        let mut client_contracts = Vec::new();
        let mut path_pool_set = HashSet::new();

        let mut keys: Vec<_> = grouped.keys().cloned().collect();
        keys.sort();

        for (method, route) in keys {
            let calls = grouped.get(&(method.clone(), route.clone())).unwrap();
            // Several consumers can share a route. A typed call is stronger evidence than
            // an untyped one (an XHR/fetch call and a typed HttpClient call often coexist),
            // so the grouped contract takes its response from the first typed call.
            let primary = calls
                .iter()
                .copied()
                .find(|call| call.response_type.is_some())
                .unwrap_or(calls[0]);

            path_pool_set.insert(primary.file.clone());

            let mut consumers = Vec::new();
            for c in calls {
                path_pool_set.insert(c.file.clone());
                consumers.push(ConsumerLocation {
                    file: c.file.clone(),
                    line: c.line,
                    column: None,
                    usage: c.usage_snippet.clone(),
                });
            }

            let expected_response = if let Some(ref response_type) = primary.non_json_response_type
            {
                let declared = primary.response_type.as_deref().unwrap_or("(none)");
                WireType::Unknown(UnknownWireType {
                    reason: format!(
                        "responseType `{response_type}` returns a non-JSON body; declared type `{declared}` describes a client-derived value, not the wire response"
                    ),
                    provenance: Some(SourceProvenance {
                        sha256: None,
                        language: SourceLanguage::TypeScript,
                        file: primary.file.clone(),
                        line: primary.line,
                        column: None,
                        ast_identity: primary.response_type.clone(),
                        annotation_or_schema: None,
                        evidence_classification: None,
                    }),
                })
            } else if let Some(ref type_name) = primary.response_type {
                TypeResolver {
                    pool: &self.declared_types,
                    aliases: &self.alias_defs,
                    generics: &self.generic_decls,
                    import_maps: &self.import_maps,
                    export_maps: Some(&self.export_maps),
                }
                .map(type_name, &primary.file, primary.line)
            } else if primary.http_method == "DELETE" {
                // HTTP DELETE requests in standard REST semantics return 204 No Content or void
                // when no explicit response DTO is declared on the client call.
                WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Void,
                    format: None,
                    provenance: Some(SourceProvenance {
                        sha256: None,
                        language: SourceLanguage::TypeScript,
                        file: primary.file.clone(),
                        line: primary.line,
                        column: None,
                        ast_identity: Some("void".to_string()),
                        annotation_or_schema: None,
                        evidence_classification: None,
                    }),
                })
            } else {
                WireType::Unknown(UnknownWireType {
                    reason: "Response type could not be resolved from call context".to_string(),
                    provenance: Some(SourceProvenance {
                        sha256: None,
                        language: SourceLanguage::TypeScript,
                        file: primary.file.clone(),
                        line: primary.line,
                        column: None,
                        ast_identity: None,
                        annotation_or_schema: None,
                        evidence_classification: None,
                    }),
                })
            };

            let request_body = primary.request_body_expr.as_ref().map(|expr| {
                if let Some(type_name) = primary.request_body_type.as_ref() {
                    return TypeResolver {
                        pool: &self.declared_types,
                        aliases: &self.alias_defs,
                        generics: &self.generic_decls,
                        import_maps: &self.import_maps,
                        export_maps: Some(&self.export_maps),
                    }
                    .map(type_name, &primary.file, primary.line);
                }
                WireType::Unknown(UnknownWireType {
                    reason: format!("Request body expression: {}", expr),
                    provenance: Some(SourceProvenance {
                        sha256: None,
                        language: SourceLanguage::TypeScript,
                        file: primary.file.clone(),
                        line: primary.line,
                        column: None,
                        ast_identity: Some(expr.clone()),
                        annotation_or_schema: None,
                        evidence_classification: None,
                    }),
                })
            });

            let decoder_kind = if primary.non_json_response_type.is_some() {
                DecoderKind::Unknown
            } else if primary.response_type.is_some() {
                DecoderKind::InferredType
            } else {
                DecoderKind::Unknown
            };

            let is_resolved = !matches!(expected_response, WireType::Unknown(_));
            let mut unresolved_evidence = Vec::new();
            if !is_resolved {
                if let Some(ref response_type) = primary.non_json_response_type {
                    unresolved_evidence.push(format!(
                        "responseType `{response_type}` returns a non-JSON body; the declared generic does not describe the wire response"
                    ));
                } else {
                    unresolved_evidence.push(
                        "Response return from untyped client call requires type annotation or reconciliation"
                            .to_string(),
                    );
                }
            }
            let mut prefix_assumptions: Vec<String> = calls
                .iter()
                .flat_map(|c| c.base_url_assumptions.iter().cloned())
                .collect();
            prefix_assumptions.sort();
            prefix_assumptions.dedup();
            for assumption in prefix_assumptions {
                unresolved_evidence.push(format!(
                    "Route begins with `{assumption}`, which is not resolvable from source and is treated as an authority/base-URL prefix; matching uses the remaining path"
                ));
            }

            // Observed reads never compete with a declared shape: only untyped clients
            // need them, and only the comparison lane may consume them, delta-gated.
            let observed_response = if primary.response_type.is_some() {
                None
            } else {
                crate::js_observed::merge_observed_response(calls)
            };
            let observed_request_body = if is_resolved {
                None
            } else {
                crate::js_observed::merge_observed_request(calls)
            };

            client_contracts.push(FrontendClientContract {
                target_service_id: Some(target_service_id.to_string()),
                target_api_version: None,
                source_sha256: None,
                consumer_traversal_complete: Some(is_resolved),
                http_method: method,
                normalized_route: route,
                request_body,
                expected_response,
                decoder_kind,
                consumers,
                unresolved_evidence,
                observed_response,
                observed_request_body,
                source_file: primary.file.clone(),
                source_line: primary.line,
            });
        }

        let mut path_pool: Vec<String> = path_pool_set.into_iter().collect();
        path_pool.sort();

        let type_pool = if self.declared_types.is_empty() {
            None
        } else {
            let mut pool = self.declared_types.clone();
            rewrite_import_refs(&mut pool, &self.import_maps, Some(&self.export_maps));
            // Bases must be folded in before aliases are materialized, otherwise an
            // alias whose body references a derived interface copies a partial shape.
            merge_heritage(
                &mut pool,
                &self.heritage,
                &self.alias_defs,
                &self.generic_decls,
                &self.import_maps,
            );
            materialize_type_aliases(
                &mut pool,
                &self.alias_defs,
                &self.generic_decls,
                &self.import_maps,
            );
            sanitize_type_pool(&mut pool);
            Some(pool)
        };

        if let Some(pool) = &type_pool {
            sanitize_client_contracts(&mut client_contracts, pool);
        }

        let mut unresolved_endpoints = Vec::new();
        for contract in &client_contracts {
            if matches!(contract.expected_response, WireType::Unknown(_)) {
                unresolved_endpoints.push(format!(
                    "{} {}",
                    contract.http_method, contract.normalized_route
                ));
            }
        }
        unresolved_endpoints.sort();
        unresolved_endpoints.dedup();

        let mut blockers = self.source_blockers.clone();
        if client_contracts.is_empty() && self.scanned_source_files > 0 {
            let label = {
                let l = path_to_posix(
                    self.ts_root
                        .strip_prefix(&self.repo_root)
                        .unwrap_or(&self.ts_root),
                );
                if l.is_empty() {
                    ".".to_string()
                } else {
                    l
                }
            };
            blockers.push(ArtifactBlocker {
                code: "TS_NO_CLIENT_CALL_RECOGNIZED".to_string(),
                message: format!(
                    "{} source file(s) were read under {} and none produced a client contract this extractor can publish, so this artifact carries no consumer expectations and must not be read as a client that makes none",
                    self.scanned_source_files, label
                ),
                file: Some(label),
            });
        }
        blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));

        let complete = unresolved_endpoints.is_empty() && blockers.is_empty();

        let completeness = ArtifactCompleteness {
            complete,
            unresolved_endpoints,
            blockers,
        };

        let payload = FrontendContractPayload {
            dependency_context: None,
            interceptor_evidence: self.interceptor_evidence.clone(),
            client_contracts,
            type_pool,
            path_pool: Some(path_pool),
        };

        (payload, completeness)
    }

    pub fn build_envelope(
        &self,
        service_id: &str,
        target_service_id: &str,
        revision: &str,
    ) -> Result<ContractArtifactEnvelope> {
        let (payload, completeness) = self.extract_payload(service_id, target_service_id);

        let env = ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::FrontendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: format!("git-root:{}", service_id),
                service_id: service_id.to_string(),
                api_version: None,
                parent_commit: revision.to_string(),
                candidate_snapshot: revision.to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: None,
                codec_profile: None,
                client_profile: Some("STATIC_FETCH_V1".to_string()),
                config_fingerprint: Some("native-ts-fast".to_string()),
            },
            completeness,
            signature: None,
            issued_at_unix: None,
            payload: ArtifactPayload::Frontend(payload),
            integrity: None,
            raw_value: None,
        };

        seal_envelope(env)
    }
}

// =========================================================================
// Parser & AST Walkers
// =========================================================================

#[derive(Default, Clone)]
struct ScopeContext {
    pub file_constants: HashMap<String, String>,
    pub class_constants: HashMap<String, String>,
    /// URL fragments exported by another module and imported under a local name.
    pub imported_constants: HashMap<String, String>,
    pub local_variables: HashMap<String, String>,
    pub enclosing_return_type: Option<String>,
    /// Prefix assumptions attached to a resolved constant, e.g. a class field initialized
    /// from `${serverApiUrl}api/users`. They travel with the value to the call site.
    pub value_assumptions: HashMap<String, Vec<String>>,
    /// Classes declared in this file, so a subclass can see a base class's URL fields.
    pub class_defs: Rc<HashMap<String, ClassChain>>,
    /// Position-ordered bindings of the enclosing function, so a call resolves the
    /// value that is visible at the call site rather than the final assignment.
    pub local_events: Option<Rc<Vec<LocalEvent>>>,
    /// Names whose closest binding is not a statically known URL. Lookup must not fall
    /// back to a file or class constant of the same name.
    pub shadowed_locals: HashSet<String>,
    /// Parameter name to declared type annotation, for the enclosing function. A request
    /// body passed as an identifier is only as shaped as the declaration it names.
    pub typed_bindings: HashMap<String, String>,
}

#[derive(Clone, Debug)]
enum LocalEventKind {
    Set {
        name: String,
        route: String,
        assumptions: Vec<String>,
    },
    /// The binding is reassigned under a condition, with a non-literal value, or
    /// shadowed by an unknown declaration.
    Poison { name: String },
}

#[derive(Clone, Debug)]
struct LocalEvent {
    pos: usize,
    kind: LocalEventKind,
}

#[derive(Default, Clone)]
struct ClassChain {
    fields: HashMap<String, String>,
    assumptions: HashMap<String, Vec<String>>,
    parent: Option<String>,
}

impl ScopeContext {
    pub fn lookup(&self, name: &str) -> Option<&String> {
        if self.shadowed_locals.contains(name) {
            return None;
        }
        self.local_variables
            .get(name)
            .or_else(|| self.class_constants.get(name))
            .or_else(|| self.imported_constants.get(name))
            .or_else(|| self.file_constants.get(name))
    }

    pub fn assumptions_for(&self, name: &str) -> &[String] {
        if self.shadowed_locals.contains(name) {
            return &[];
        }
        self.value_assumptions
            .get(name)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    fn apply_local_events(&mut self, position: usize) {
        let Some(events) = self.local_events.clone() else {
            return;
        };
        for event in events.iter().filter(|e| e.pos <= position) {
            match &event.kind {
                LocalEventKind::Set {
                    name,
                    route,
                    assumptions,
                } => {
                    self.shadowed_locals.remove(name);
                    self.local_variables.insert(name.clone(), route.clone());
                    if assumptions.is_empty() {
                        self.value_assumptions.remove(name);
                    } else {
                        self.value_assumptions
                            .insert(name.clone(), assumptions.clone());
                    }
                }
                LocalEventKind::Poison { name } => {
                    self.local_variables.remove(name);
                    self.value_assumptions.remove(name);
                    self.shadowed_locals.insert(name.clone());
                }
            }
        }
    }
}

/// Whether a string constant can be part of a URL path. Both rooted (`/api/users`) and
/// relative (`api/users`) fragments are common; whitespace and bare words are not paths.
fn is_route_literal(value: &str) -> bool {
    let v = value.trim();
    !v.is_empty()
        && !v.chars().any(|c| c.is_whitespace())
        && (v.starts_with('/') || v.contains('/'))
}

fn collect_file_constants(root: Node, content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let decl = match child.kind() {
            "export_statement" => child.child_by_field_name("declaration").unwrap_or(child),
            "lexical_declaration" | "variable_declaration" => child,
            _ => continue,
        };
        if (decl.kind() == "lexical_declaration" || decl.kind() == "variable_declaration")
            && slice_node(decl, content).trim_start().starts_with("const")
        {
            let mut d_cursor = decl.walk();
            for var in decl.children(&mut d_cursor) {
                if var.kind() == "variable_declarator" {
                    if let (Some(name_node), Some(val_node)) = (
                        var.child_by_field_name("name"),
                        var.child_by_field_name("value"),
                    ) {
                        let name = slice_node(name_node, content).trim();
                        if val_node.kind() == "string" {
                            let unquoted = unquote_str(slice_node(val_node, content));
                            if is_route_literal(&unquoted) {
                                map.insert(name.to_string(), unquoted);
                            }
                        }
                    }
                }
            }
        }
    }
    map
}

/// Class fields holding a URL fragment. Both the field initializer form
/// (`protected readonly resourceUrl = '${serverApiUrl}api/users'`) and the constructor
/// assignment form (`this.resourceUrl = 'api/users'`) are read, and either may be a
/// template or a concatenation, so the existing URL flattener decides the value.
fn collect_class_fields(
    class_node: Node,
    content: &str,
    scope: &ScopeContext,
) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let mut values = HashMap::new();
    let mut assumptions = HashMap::new();
    let body = match class_node.child_by_field_name("body") {
        Some(b) => b,
        None => return (values, assumptions),
    };
    collect_field_values(body, content, scope, &mut values, &mut assumptions);
    (values, assumptions)
}

fn collect_field_values(
    node: Node,
    content: &str,
    scope: &ScopeContext,
    values: &mut HashMap<String, String>,
    assumptions: &mut HashMap<String, Vec<String>>,
) {
    let candidate = match node.kind() {
        "field_definition" | "public_field_definition" => {
            let name_node = node
                .child_by_field_name("name")
                .or_else(|| node.child_by_field_name("property"));
            name_node
                .map(|n| slice_node(n, content).trim().to_string())
                .zip(node.child_by_field_name("value"))
        }
        "assignment_expression" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let this_field = left
                .filter(|l| l.kind() == "member_expression")
                .and_then(|l| {
                    let object_is_this = l
                        .child_by_field_name("object")
                        .map(|o| slice_node(o, content).trim() == "this")
                        .unwrap_or(false);
                    if object_is_this {
                        l.child_by_field_name("property")
                            .map(|p| slice_node(p, content).trim().to_string())
                    } else {
                        None
                    }
                });
            this_field.zip(right)
        }
        _ => None,
    };

    if let Some((name, value_node)) = candidate {
        if !name.is_empty() {
            if let Some((_, route, field_assumptions)) =
                extract_route_url(value_node, content, scope)
            {
                if has_literal_url_segment(&route) {
                    values.insert(name.clone(), route.clone());
                    values.insert(format!("this.{}", name), route);
                    if !field_assumptions.is_empty() {
                        assumptions.insert(name.clone(), field_assumptions.clone());
                        assumptions.insert(format!("this.{}", name), field_assumptions);
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_field_values(child, content, scope, values, assumptions);
    }
}

/// All classes declared in the file, so a subclass can inherit a base class's URL fields
/// (the generated "base service + entity service extends it" idiom).
fn collect_class_defs(
    root: Node,
    content: &str,
    scope: &ScopeContext,
) -> HashMap<String, ClassChain> {
    let mut defs = HashMap::new();
    collect_class_defs_into(root, content, scope, &mut defs);
    defs
}

fn collect_class_defs_into(
    node: Node,
    content: &str,
    scope: &ScopeContext,
    defs: &mut HashMap<String, ClassChain>,
) {
    if node.kind() == "class_declaration" || node.kind() == "abstract_class_declaration" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = slice_node(name_node, content).trim().to_string();
            let (fields, assumptions) = collect_class_fields(node, content, scope);
            defs.insert(
                name,
                ClassChain {
                    fields,
                    assumptions,
                    parent: superclass_name(node, content),
                },
            );
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_class_defs_into(child, content, scope, defs);
    }
}

fn superclass_name(node: Node, content: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "class_heritage" {
            continue;
        }
        let rest = slice_node(child, content)
            .trim()
            .strip_prefix("extends")?
            .trim();
        let name = rest
            .split(|c: char| c == '<' || c.is_whitespace() || c == '{')
            .next()
            .unwrap_or("")
            .trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

fn inherited_class_members(
    parent: &str,
    defs: &HashMap<String, ClassChain>,
) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let mut chain: Vec<&ClassChain> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut current = Some(parent);
    while let Some(name) = current {
        if !seen.insert(name) {
            break;
        }
        let Some(def) = defs.get(name) else {
            break;
        };
        chain.push(def);
        current = def.parent.as_deref();
    }

    let mut fields = HashMap::new();
    let mut assumptions = HashMap::new();
    for def in chain.into_iter().rev() {
        fields.extend(def.fields.clone());
        assumptions.extend(def.assumptions.clone());
    }
    (fields, assumptions)
}

/// Typed parameters of a function or method: name plus the annotation as written.
/// Destructured and rest parameters are skipped, because no single identifier names the
/// value the call site passes.
fn collect_typed_parameters(fn_node: Node, content: &str) -> Vec<(String, String)> {
    let mut bindings = Vec::new();
    let Some(params) = fn_node.child_by_field_name("parameters") else {
        return bindings;
    };
    let mut cursor = params.walk();
    for param in params.named_children(&mut cursor) {
        if !matches!(param.kind(), "required_parameter" | "optional_parameter") {
            continue;
        }
        let Some(pattern) = param.child_by_field_name("pattern") else {
            continue;
        };
        if pattern.kind() != "identifier" {
            continue;
        }
        let Some(type_node) = param.child_by_field_name("type") else {
            continue;
        };
        let name = slice_node(pattern, content).trim();
        let type_text = strip_type_annotation(slice_node(type_node, content));
        if !name.is_empty() && !type_text.is_empty() {
            bindings.push((name.to_string(), type_text));
        }
    }
    bindings
}

fn typed_request_body(request_body_expr: &Option<String>, scope: &ScopeContext) -> Option<String> {
    let expr = request_body_expr.as_deref()?.trim();
    if !is_valid_type_identifier(expr) {
        return None;
    }
    scope.typed_bindings.get(expr).cloned()
}

fn collect_function_local_events(
    fn_node: Node,
    content: &str,
    scope: &ScopeContext,
) -> Vec<LocalEvent> {
    let mut events = Vec::new();
    let body = match fn_node.child_by_field_name("body") {
        Some(b) => b,
        None => return events,
    };
    if body.kind() != "statement_block" {
        return events;
    }
    // Evaluate initializers against the bindings that are visible before the statement;
    // the walker later applies the recorded values by source position.
    let mut state = scope.clone();
    state.local_events = None;
    state.shadowed_locals = HashSet::new();

    let mut cursor = body.walk();
    for stmt in body.children(&mut cursor) {
        let pos = stmt.start_byte();
        match stmt.kind() {
            "lexical_declaration" | "variable_declaration" => {
                let mut d_cursor = stmt.walk();
                for decl in stmt.children(&mut d_cursor) {
                    if decl.kind() != "variable_declarator" {
                        continue;
                    }
                    let Some(name_node) = decl.child_by_field_name("name") else {
                        continue;
                    };
                    let mut names = Vec::new();
                    binding_identifiers(name_node, content, &mut names);
                    if names.is_empty() {
                        continue;
                    }
                    if names.len() == 1 {
                        let route = decl
                            .child_by_field_name("value")
                            .and_then(|value| extract_route_url(value, content, &state))
                            .filter(|(_, route, _)| route.starts_with('/'));
                        if let Some((_, route, assumptions)) = route {
                            let name = names[0].clone();
                            events.push(LocalEvent {
                                pos,
                                kind: LocalEventKind::Set {
                                    name: name.clone(),
                                    route: route.clone(),
                                    assumptions: assumptions.clone(),
                                },
                            });
                            state.local_variables.insert(name.clone(), route);
                            if assumptions.is_empty() {
                                state.value_assumptions.remove(&name);
                            } else {
                                state.value_assumptions.insert(name.clone(), assumptions);
                            }
                            state.shadowed_locals.remove(&name);
                            continue;
                        }
                    }
                    for name in names {
                        events.push(LocalEvent {
                            pos,
                            kind: LocalEventKind::Poison { name: name.clone() },
                        });
                        state.local_variables.remove(&name);
                        state.value_assumptions.remove(&name);
                        state.shadowed_locals.insert(name);
                    }
                }
            }
            "expression_statement" => {
                let Some(expr) = stmt.named_child(0) else {
                    continue;
                };
                let mut names = Vec::new();
                match expr.kind() {
                    "assignment_expression" => {
                        if let Some(left) = expr.child_by_field_name("left") {
                            if left.kind() == "identifier" {
                                let name = slice_node(left, content).trim().to_string();
                                let route = if is_plain_assignment(expr, content, left) {
                                    expr.child_by_field_name("right")
                                        .and_then(|right| extract_route_url(right, content, &state))
                                        .filter(|(_, route, _)| route.starts_with('/'))
                                } else {
                                    None
                                };
                                match route {
                                    Some((_, route, assumptions)) => {
                                        events.push(LocalEvent {
                                            pos,
                                            kind: LocalEventKind::Set {
                                                name: name.clone(),
                                                route: route.clone(),
                                                assumptions: assumptions.clone(),
                                            },
                                        });
                                        state.local_variables.insert(name.clone(), route);
                                        if assumptions.is_empty() {
                                            state.value_assumptions.remove(&name);
                                        } else {
                                            state
                                                .value_assumptions
                                                .insert(name.clone(), assumptions);
                                        }
                                        state.shadowed_locals.remove(&name);
                                    }
                                    None => {
                                        events.push(LocalEvent {
                                            pos,
                                            kind: LocalEventKind::Poison { name: name.clone() },
                                        });
                                        state.local_variables.remove(&name);
                                        state.value_assumptions.remove(&name);
                                        state.shadowed_locals.insert(name);
                                    }
                                }
                            } else {
                                // A property write does not rebind its root, and a
                                // destructuring assignment rebinds every bound name.
                                binding_identifiers(left, content, &mut names);
                                for name in names {
                                    events.push(LocalEvent {
                                        pos,
                                        kind: LocalEventKind::Poison { name: name.clone() },
                                    });
                                    state.local_variables.remove(&name);
                                    state.value_assumptions.remove(&name);
                                    state.shadowed_locals.insert(name);
                                }
                            }
                        }
                    }
                    "augmented_assignment_expression" | "update_expression" => {
                        if is_query_only_append(expr, content) {
                            continue;
                        }
                        let target = if expr.kind() == "update_expression" {
                            expr.child_by_field_name("argument")
                        } else {
                            expr.child_by_field_name("left")
                        };
                        if let Some(target) = target {
                            collect_write_targets(target, content, &mut names);
                            for name in names {
                                events.push(LocalEvent {
                                    pos,
                                    kind: LocalEventKind::Poison { name: name.clone() },
                                });
                                state.local_variables.remove(&name);
                                state.value_assumptions.remove(&name);
                                state.shadowed_locals.insert(name);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {
                // Assignments under a branch, loop, or try block may or may not have
                // executed, so the name is no longer a single statically known URL.
                let mut names = HashSet::new();
                collect_conditional_mutations(stmt, content, &mut names);
                for name in names {
                    events.push(LocalEvent {
                        pos,
                        kind: LocalEventKind::Poison { name: name.clone() },
                    });
                    state.local_variables.remove(&name);
                    state.value_assumptions.remove(&name);
                    state.shadowed_locals.insert(name);
                }
            }
        }
    }

    events
}

/// `url += '?...'` or `url += '&...'` only extends the query string. A contract is
/// keyed on the route path, so the binding remains statically known; appending a
/// path segment (or an unknown expression) still invalidates it.
fn is_query_only_append(expr: Node, content: &str) -> bool {
    if expr.kind() != "augmented_assignment_expression" {
        return false;
    }
    let Some(left) = expr.child_by_field_name("left") else {
        return false;
    };
    let Some(right) = expr.child_by_field_name("right") else {
        return false;
    };
    let operator = content
        .get(left.end_byte()..right.start_byte())
        .map(str::trim)
        .unwrap_or("");
    if operator != "+=" {
        return false;
    }
    let literal = slice_node(right, content).trim();
    let literal = literal.trim_start_matches(['`', '\'', '"']);
    literal.starts_with('?') || literal.starts_with('&')
}

fn is_plain_assignment(expr: Node, content: &str, left: Node) -> bool {
    let Some(right) = expr.child_by_field_name("right") else {
        return false;
    };
    if right.start_byte() <= left.end_byte() {
        return false;
    }
    content
        .get(left.end_byte()..right.start_byte())
        .map(|between| between.trim() == "=")
        .unwrap_or(false)
}

fn binding_identifiers(node: Node, content: &str, names: &mut Vec<String>) {
    if matches!(
        node.kind(),
        "identifier" | "shorthand_property_identifier_pattern"
    ) {
        let name = slice_node(node, content).trim();
        if !name.is_empty() {
            names.push(name.to_string());
        }
        return;
    }
    if matches!(node.kind(), "member_expression" | "subscript_expression") {
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        binding_identifiers(child, content, names);
    }
}

/// Names written by an assignment or loop binding anywhere below `node`, including
/// nested blocks. Property writes and nested declarations are not writes to the binding.
fn collect_conditional_mutations(node: Node, content: &str, names: &mut HashSet<String>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "assignment_expression" | "augmented_assignment_expression" => {
                if child.kind() == "augmented_assignment_expression"
                    && is_query_only_append(child, content)
                {
                    continue;
                }
                if let Some(left) = child.child_by_field_name("left") {
                    let mut written = Vec::new();
                    collect_write_targets(left, content, &mut written);
                    names.extend(written);
                }
            }
            "update_expression" => {
                if let Some(argument) = child.child_by_field_name("argument") {
                    let mut written = Vec::new();
                    collect_write_targets(argument, content, &mut written);
                    names.extend(written);
                }
            }
            "for_in_statement" => {
                if let Some(left) = child.child_by_field_name("left") {
                    let mut written = Vec::new();
                    collect_write_targets(left, content, &mut written);
                    names.extend(written);
                }
                collect_conditional_mutations(child, content, names);
            }
            _ => collect_conditional_mutations(child, content, names),
        }
    }
}

fn collect_write_targets(node: Node, content: &str, names: &mut Vec<String>) {
    match node.kind() {
        "identifier" => {
            let name = slice_node(node, content).trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
        "member_expression" | "subscript_expression" => {}
        "parenthesized_expression" => {
            if let Some(inner) = node.named_child(0) {
                collect_write_targets(inner, content, names);
            }
        }
        _ => binding_identifiers(node, content, names),
    }
}

fn extract_function_return_type(node: Node, content: &str) -> Option<String> {
    // 1. Explicit return type annotation on function: async foo(): Promise<T>
    if let Some(ret_node) = node.child_by_field_name("return_type") {
        let raw = slice_node(ret_node, content).trim();
        let clean = raw.strip_prefix(':').unwrap_or(raw).trim();
        if let Some(inner) = unwrap_async_wrapper(clean) {
            return Some(inner);
        }
        if clean == "void" {
            return Some("void".to_string());
        }
        if !clean.contains('<')
            && ![
                "any", "unknown", "never", "boolean", "number", "string",
            ]
            .contains(&clean)
        {
            return Some(clean.to_string());
        }
    }

    // 2. Return statement with type assertion: return res.data as T
    if let Some(body) = node.child_by_field_name("body") {
        if let Some(asserted_type) = find_return_as_expression(body, content) {
            return Some(asserted_type);
        }
    }

    None
}

fn unwrap_async_wrapper(type_str: &str) -> Option<String> {
    // Each wrapper only describes how the value is delivered. `Promise<AxiosResponse<T>>`
    // is the common Axios service signature, so unwrap repeatedly instead of one layer.
    const WRAPPERS: &[&str] = &[
        "Promise<",
        "Observable<",
        "AxiosResponse<",
        "HttpResponse<",
        "HttpEvent<",
        "Response<",
    ];
    let mut current = type_str.trim();
    let mut unwrapped = None;
    for _ in 0..4 {
        let Some(inner) = WRAPPERS.iter().find_map(|prefix| {
            if current.starts_with(prefix) && current.ends_with('>') {
                Some(current[prefix.len()..current.len() - 1].trim())
            } else {
                None
            }
        }) else {
            break;
        };
        if inner.is_empty() || matches!(inner, "any" | "unknown") {
            return None;
        }
        current = inner;
        unwrapped = Some(current.to_string());
    }
    unwrapped
}

fn find_return_as_expression(node: Node, content: &str) -> Option<String> {
    let count = node.child_count();
    for i in 0..count {
        if let Some(child) = node.child(i as u32) {
            if child.kind() == "return_statement" {
                if let Some(type_name) = extract_as_type(child, content) {
                    return Some(type_name);
                }
            } else if child.kind() == "try_statement"
                || child.kind() == "statement_block"
                || child.kind() == "catch_clause"
            {
                if let Some(type_name) = find_return_as_expression(child, content) {
                    return Some(type_name);
                }
            }
        }
    }
    None
}

fn extract_as_type(return_stmt: Node, content: &str) -> Option<String> {
    let count = return_stmt.child_count();
    for i in 0..count {
        if let Some(child) = return_stmt.child(i as u32) {
            if child.kind() == "as_expression" {
                if let Some(type_node) = child.child_by_field_name("type") {
                    let t = slice_node(type_node, content).trim();
                    if !t.is_empty() && t != "any" && t != "unknown" {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TsGrammar {
    Typescript,
    Tsx,
}

/// Grammar chosen by extension. JSX is legal in a `.js` file — Create React App and plain
/// Babel setups ship components without a `.jsx` extension — and the TSX grammar reads
/// ordinary JavaScript, so the whole JS family uses it. `.ts` keeps the TypeScript grammar
/// because a `<T>value` cast is legal TypeScript and the opening of a JSX element.
pub(crate) fn grammar_for(rel_path: &str) -> TsGrammar {
    if rel_path.ends_with(".tsx")
        || rel_path.ends_with(".jsx")
        || rel_path.ends_with(".js")
        || rel_path.ends_with(".mjs")
        || rel_path.ends_with(".cjs")
    {
        TsGrammar::Tsx
    } else {
        TsGrammar::Typescript
    }
}

fn blocker_for(file: &str, code: &str, message: String) -> ArtifactBlocker {
    ArtifactBlocker {
        code: code.to_string(),
        message,
        file: Some(file.to_string()),
    }
}

/// Packages that construct HTTP clients. A module importing one of these is a client
/// module, whatever it calls its exports.
const HTTP_PACKAGES: &[&str] = &[
    "axios",
    "ky",
    "got",
    "superagent",
    "node-fetch",
    "cross-fetch",
    "undici",
    "ofetch",
    "wretch",
    "redaxios",
    "tinyhttp",
    "request",
    "request-promise",
    "request-promise-native",
    "needle",
    "bent",
    "make-fetch-happen",
];

/// Modules whose source contains an HTTP primitive. A module imported from one of these
/// is treated as an HTTP client, so calls on arbitrarily named receivers (`transport.get`,
/// `conduit.post`) are recognized without a per-repo name list.
///
/// A barrel that only re-exports a client (`export { api } from './client'`) is the
/// ordinary way an application exposes one, and has no HTTP token of its own. Provenance
/// therefore follows relative re-export edges to a bounded fixpoint.
fn collect_http_bearing_modules(repo_root: &Path, files: &[PathBuf]) -> HashSet<String> {
    let mut modules: HashSet<String> = files
        .par_iter()
        .filter_map(|file_path| {
            let content = fs::read_to_string(file_path).ok()?;
            if !module_has_direct_http_evidence(&content) {
                return None;
            }
            let rel_path = path_to_posix(file_path.strip_prefix(repo_root).unwrap_or(file_path));
            Some(strip_script_extension(&rel_path).to_string())
        })
        .collect();

    let edges: Vec<(String, String, Vec<String>)> = files
        .par_iter()
        .filter_map(|file_path| {
            let content = fs::read_to_string(file_path).ok()?;
            let rel_path = path_to_posix(file_path.strip_prefix(repo_root).unwrap_or(file_path));
            let sources = collect_reexport_sources(&rel_path, &content);
            (!sources.is_empty()).then(|| {
                (
                    strip_script_extension(&rel_path).to_string(),
                    rel_path.clone(),
                    sources,
                )
            })
        })
        .collect();

    // Four hops covers the usual `index -> api -> client` chain and terminates even when
    // barrels re-export each other.
    for _ in 0..4 {
        let mut added = false;
        for (module, rel_path, sources) in &edges {
            if modules.contains(module) {
                continue;
            }
            if sources.iter().any(|source| {
                resolve_import_module(rel_path, source)
                    .map(|resolved| modules.contains(strip_script_extension(&resolved)))
                    .unwrap_or(false)
            }) {
                modules.insert(module.clone());
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    modules
}

/// Relative modules named by `export … from '…'` statements. Only a re-export can carry
/// client provenance across a barrel; a plain `export` names a local declaration.
fn collect_reexport_sources(rel_path: &str, content: &str) -> Vec<String> {
    if !content.contains("export") || !content.contains("from") {
        return Vec::new();
    }
    let mut parser = Parser::new();
    let grammar = match grammar_for(rel_path) {
        TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    };
    if parser.set_language(&grammar).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.kind() == "export_statement" {
            if let Some(source) = node.child_by_field_name("source") {
                let module = unquote_str(slice_node(source, content));
                if module.starts_with('.') {
                    sources.push(module);
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i as u32) {
                stack.push(child);
            }
        }
    }
    sources.sort();
    sources.dedup();
    sources
}

fn module_has_direct_http_evidence(content: &str) -> bool {
    imports_http_package(content)
        || content.contains("fetch(")
        || content.contains("fetch (")
        || content.contains("$http")
        || content.contains("HttpClient")
}

fn imports_http_package(content: &str) -> bool {
    HTTP_PACKAGES.iter().any(|package| {
        let from_double = format!("from \"{package}\"");
        let from_single = format!("from '{package}'");
        let require_double = format!("require(\"{package}\")");
        let require_single = format!("require('{package}')");
        content.contains(&from_double)
            || content.contains(&from_single)
            || content.contains(&require_double)
            || content.contains(&require_single)
    })
}

/// A module-level name that holds an HTTP client without importing one:
/// `const superagent = withPromise(_superagent, global.Promise)` passes the client through a
/// plugin wrapper. Names bound this way join the import map, so every existing receiver check
/// resolves them without a per-repo name list.
#[derive(Clone, Debug)]
pub(crate) struct ClientAliasBinding {
    pub name: String,
    pub module: String,
    pub imported: String,
}

pub(crate) fn collect_client_alias_bindings(
    root: Node,
    content: &str,
    lookup: &dyn Fn(&str) -> Option<(String, String)>,
    is_http_module: &dyn Fn(&str) -> bool,
) -> Vec<ClientAliasBinding> {
    let declarators = collect_module_declarators(root, content);
    let mut resolved: HashMap<String, (String, String)> = HashMap::new();
    // An alias can wrap another alias, so bindings are settled with the small fixpoint the
    // import map already assumes; four rounds covers `wrap(wrap(wrap(client)))` and stops.
    for _ in 0..4 {
        let mut round: Vec<(String, (String, String))> = Vec::new();
        for (name, value) in declarators.iter() {
            if lookup(name).is_some() || resolved.contains_key(name.as_str()) {
                continue;
            }
            let bound = |id: &str| lookup(id).or_else(|| resolved.get(id).cloned());
            if let Some(binding) = alias_source_binding(*value, content, &bound, is_http_module) {
                round.push((name.clone(), binding));
            }
        }
        let mut changed = false;
        for (name, binding) in round {
            if !resolved.contains_key(&name) {
                resolved.insert(name, binding);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out: Vec<ClientAliasBinding> = resolved
        .into_iter()
        .map(|(name, (module, imported))| ClientAliasBinding {
            name,
            module,
            imported,
        })
        .collect();
    // A HashMap's iteration order is process-dependent; this feeds a sealed artifact.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn collect_module_declarators<'a>(root: Node<'a>, content: &'a str) -> Vec<(String, Node<'a>)> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for statement in root.children(&mut cursor) {
        let mut stack = vec![statement];
        while let Some(node) = stack.pop() {
            match node.kind() {
                "variable_declarator" => {
                    let (Some(name), Some(value)) = (
                        node.child_by_field_name("name"),
                        node.child_by_field_name("value"),
                    ) else {
                        continue;
                    };
                    if name.kind() == "identifier" {
                        out.push((slice_node(name, content).trim().to_string(), value));
                    }
                }
                "lexical_declaration"
                | "variable_declaration"
                | "export_statement"
                | "export_clause" => {
                    let mut inner = node.walk();
                    for child in node.named_children(&mut inner) {
                        stack.push(child);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

fn alias_source_binding(
    value: Node,
    content: &str,
    bound: &dyn Fn(&str) -> Option<(String, String)>,
    is_http_module: &dyn Fn(&str) -> bool,
) -> Option<(String, String)> {
    let value = unwrap_expression(value);
    // The names that can already denote a client: the callee's receiver (`axios.create`), the
    // callee itself, and each argument. A wrapper function contributes nothing on its own —
    // the client is whatever was handed to it.
    let mut candidates: Vec<Node> = Vec::new();
    match value.kind() {
        "identifier" => candidates.push(value),
        "member_expression" => {
            if let Some(object) = value.child_by_field_name("object") {
                candidates.push(unwrap_expression(object));
            }
        }
        "call_expression" => {
            if let Some(callee) = value.child_by_field_name("function") {
                let callee = unwrap_expression(callee);
                match callee.kind() {
                    "identifier" => candidates.push(callee),
                    "member_expression" => {
                        if let Some(object) = callee.child_by_field_name("object") {
                            candidates.push(unwrap_expression(object));
                        }
                    }
                    _ => {}
                }
            }
            if let Some(args) = value.child_by_field_name("arguments") {
                let mut cursor = args.walk();
                for arg in args.named_children(&mut cursor) {
                    let arg = unwrap_expression(arg);
                    match arg.kind() {
                        "identifier" => candidates.push(arg),
                        "member_expression" => {
                            if let Some(object) = arg.child_by_field_name("object") {
                                candidates.push(unwrap_expression(object));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    for candidate in candidates {
        if candidate.kind() != "identifier" {
            continue;
        }
        let name = slice_node(candidate, content).trim();
        let Some((module, imported)) = bound(name) else {
            continue;
        };
        if is_http_module(&module) {
            return Some((module, imported));
        }
    }
    None
}

/// A same-module request wrapper: a function that makes exactly one client call whose endpoint
/// is built from the function's own parameters, e.g.
/// `const requests = { get: url => superagent.get(`${API_ROOT}${url}`) }`.
///
/// The anchor can never name an endpoint on its own, so it is reported as unresolved today.
/// Fanning it out binds each recorded parameter to the argument a call site passes and re-runs
/// the existing endpoint inspection, which keeps normalization, the locatability gate and the
/// base-URL assumptions identical to a direct call. Sites whose argument is not statically
/// known contribute nothing, so the only routes published are the ones a caller wrote out.
struct WrapperAnchor {
    /// Byte range of the client call inside the wrapper, re-inspected per call site.
    call_start: usize,
    call_end: usize,
    /// Parameters the endpoint is built from, by name.
    hole_params: Vec<String>,
    /// Parameter name to positional index, so an argument lines up with its hole.
    param_index: HashMap<String, usize>,
}

/// Per wrapper anchor, how many call sites reached it and how many of them named a route.
/// An anchor stops being reported as unresolved only when every site that reached it is
/// accounted for; one unreadable argument keeps the blocker, because a route is absent.
#[derive(Default)]
struct WrapperCoverage {
    resolved_sites: usize,
    unbound_sites: usize,
}

/// Bindings of module-level values that hold a wrapper function, keyed by the text a call site
/// uses to reach them: `requests.get` for an object of lambdas, `load` for a function.
fn collect_wrapper_bindings<'a>(root: Node<'a>, content: &'a str) -> Vec<(String, Node<'a>)> {
    let mut out = Vec::new();
    for (name, value) in collect_module_declarators(root, content) {
        let value = unwrap_expression(value);
        if is_function_value(value.kind()) {
            out.push((name, value));
            continue;
        }
        if value.kind() != "object" {
            continue;
        }
        let mut cursor = value.walk();
        for pair in value.named_children(&mut cursor) {
            if pair.kind() != "pair" {
                continue;
            }
            let (Some(key), Some(value)) = (
                pair.child_by_field_name("key"),
                pair.child_by_field_name("value"),
            ) else {
                continue;
            };
            let key = unquote_str(slice_node(key, content));
            let value = unwrap_expression(value);
            if !key.is_empty() && is_function_value(value.kind()) {
                out.push((format!("{name}.{key}"), value));
            }
        }
    }
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let declaration = match child.kind() {
            "function_declaration" | "generator_function_declaration" => Some(child),
            "export_statement" => {
                let mut inner = child.walk();
                let found = child.named_children(&mut inner).find(|node| {
                    matches!(
                        node.kind(),
                        "function_declaration" | "generator_function_declaration"
                    )
                });
                found
            }
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        let Some(name) = declaration.child_by_field_name("name") else {
            continue;
        };
        let name = slice_node(name, content).trim().to_string();
        if !name.is_empty() {
            out.push((name, declaration));
        }
    }
    out
}

fn is_function_value(kind: &str) -> bool {
    matches!(
        kind,
        "arrow_function"
            | "function_expression"
            | "function_declaration"
            | "generator_function_declaration"
            | "method_definition"
    )
}

/// The bare name a parameter binds, or None when the slot is destructured, rest or computed.
/// Identifier kinds vary with the grammar (`identifier`, `ascii_identifier`, the pattern form),
/// so a name is whatever the node spells out with no structure of its own.
fn pattern_name(node: Node, content: &str) -> Option<String> {
    let bound = match node.kind() {
        "required_parameter" | "optional_parameter" => node.child_by_field_name("pattern")?,
        _ => node,
    };
    if bound.named_child_count() != 0 {
        return None;
    }
    let name = slice_node(bound, content).trim();
    if name.is_empty() || !name.starts_with(|c: char| c.is_alphabetic() || c == '_' || c == '$') {
        return None;
    }
    Some(name.to_string())
}

/// Positional parameter names of a function value. Destructured and rest parameters keep their
/// slot with no name, so an argument index still lines up with the parameter list.
fn parameter_names(node: Node, content: &str) -> Vec<Option<String>> {
    let parameters = match node.child_by_field_name("parameters") {
        Some(parameters) => parameters,
        // `url => ...` spells its single parameter as a bare identifier that this grammar
        // leaves unfielded: anything before the `=>` token, and nothing after it.
        None => {
            let Some(arrow) = (0..node.child_count())
                .filter_map(|index| node.child(index as u32))
                .find(|child| child.kind() == "=>")
            else {
                return Vec::new();
            };
            let Some(first) = node.named_child(0) else {
                return Vec::new();
            };
            if first.start_byte() >= arrow.start_byte() {
                return Vec::new();
            }
            return vec![pattern_name(first, content)];
        }
    };
    if parameters.kind() != "formal_parameters" {
        return vec![pattern_name(parameters, content)];
    }
    let mut out = Vec::new();
    let mut cursor = parameters.walk();
    for child in parameters.named_children(&mut cursor) {
        out.push(pattern_name(child, content));
    }
    out
}

/// Call nodes inside a function body, without descending into a nested function: a callback's
/// client call belongs to that callback, not to the function that received it.
fn body_call_nodes<'a>(node: Node<'a>, out: &mut Vec<Node<'a>>) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "call_expression" {
            out.push(child);
        }
        if is_function_value(child.kind()) {
            continue;
        }
        body_call_nodes(child, out);
    }
}

fn root_of(mut node: Node) -> Node {
    while let Some(parent) = node.parent() {
        node = parent;
    }
    node
}

/// Which of `names` appear inside the endpoint expression. A name reached through a nested
/// function is not this wrapper's parameter, so the descent stops at function boundaries.
fn endpoint_holes(node: Node, content: &str, names: &[String], out: &mut BTreeSet<String>) {
    if node.kind() == "identifier" {
        let name = slice_node(node, content).trim().to_string();
        if names.iter().any(|candidate| candidate == &name) {
            out.insert(name);
        }
        return;
    }
    if is_function_value(node.kind()) {
        return;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        endpoint_holes(child, content, names, out);
    }
}

fn collect_wrapper_anchors(
    root: Node,
    content: &str,
    rel_path: &str,
    base_scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> HashMap<String, WrapperAnchor> {
    let mut out = HashMap::new();
    for (path, function) in collect_wrapper_bindings(root, content) {
        let params = parameter_names(function, content);
        let named: Vec<String> = params.iter().flatten().cloned().collect();
        if named.is_empty() {
            continue;
        }
        let mut probe_scope = base_scope.clone();
        probe_scope.local_variables.clear();
        probe_scope.class_constants.clear();
        probe_scope.value_assumptions.clear();
        probe_scope.local_events = None;
        // The parameters are what a call site supplies, so the anchor must not resolve them
        // from a same-named constant further out.
        probe_scope.shadowed_locals = named.iter().cloned().collect();

        let mut bodies = Vec::new();
        body_call_nodes(function, &mut bodies);
        let mut resolved = 0usize;
        let mut unresolved: Vec<(Node, Option<(usize, usize)>)> = Vec::new();
        for call in bodies {
            match inspect_call_expression(
                call,
                content,
                rel_path,
                &probe_scope,
                imports,
                http_modules,
            ) {
                CallInspection::Resolved(_) => resolved += 1,
                CallInspection::UnresolvedHttp { endpoint_arg, .. } => {
                    unresolved.push((call, endpoint_arg))
                }
                CallInspection::NotHttp => {}
            }
        }
        // Exactly one client call and nothing already published: fanning out must not compete
        // with an endpoint the anchor can name by itself, or one contract would be published
        // twice under two different routes.
        if resolved != 0 || unresolved.len() != 1 {
            continue;
        }
        let (call, endpoint_arg) = match unresolved.pop() {
            Some(entry) => entry,
            None => continue,
        };
        let Some((start, end)) = endpoint_arg else {
            continue;
        };
        let Some(endpoint_node) = call.descendant_for_byte_range(start, end) else {
            continue;
        };
        let mut holes = BTreeSet::new();
        endpoint_holes(endpoint_node, content, &named, &mut holes);
        if holes.is_empty() {
            continue;
        }
        let hole_params: Vec<String> = holes.into_iter().collect();
        let mut param_index = HashMap::new();
        for (index, name) in params.iter().enumerate() {
            if let Some(name) = name {
                param_index.insert(name.clone(), index);
            }
        }
        out.insert(
            path,
            WrapperAnchor {
                call_start: call.start_byte(),
                call_end: call.end_byte(),
                hole_params,
                param_index,
            },
        );
    }
    out
}

fn argument_nodes(call: Node) -> Vec<Node> {
    let Some(arguments) = call.child_by_field_name("arguments") else {
        return Vec::new();
    };
    let mut cursor = arguments.walk();
    arguments
        .named_children(&mut cursor)
        .filter(|child| child.kind() != "comment")
        .collect()
}

/// The endpoint text a call site hands to a wrapper. Resolution abstains rather than guessing:
/// an argument that is not a literal, a template of literals and readable names, or a name this
/// scope can read contributes no contract.
fn endpoint_fragment(node: Node, content: &str, scope: &ScopeContext) -> Option<String> {
    let node = unwrap_expression(node);
    match node.kind() {
        "string" => Some(unquote_str(slice_node(node, content))),
        "template_string" => {
            let mut out = String::new();
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "string_fragment" => out.push_str(slice_node(child, content)),
                    "template_substitution" => {
                        let inner = slice_node(child, content)
                            .trim_start_matches("${")
                            .trim_end_matches('}')
                            .trim();
                        match scope.lookup(inner) {
                            Some(value) => out.push_str(value),
                            None => out.push_str(":param"),
                        }
                    }
                    _ => {}
                }
            }
            Some(out)
        }
        "binary_expression" => {
            let operator = node
                .child_by_field_name("operator")
                .map(|n| slice_node(n, content).trim().to_string())
                .unwrap_or_default();
            if operator != "+" {
                return None;
            }
            let left = node.child_by_field_name("left")?;
            let right = node.child_by_field_name("right")?;
            let left = endpoint_fragment(left, content, scope)?;
            let right = endpoint_fragment(right, content, scope)?;
            Some(format!("{left}{right}"))
        }
        "identifier" | "member_expression" => {
            let name = slice_node(node, content).trim();
            scope.lookup(name).cloned()
        }
        _ => None,
    }
}

/// Binds each endpoint parameter to the argument this call site passes and re-inspects the
/// wrapper's client call, so the route comes out of the same code path as a direct call.
fn fan_out_wrapper_site(
    site: Node,
    content: &str,
    rel_path: &str,
    anchor: &WrapperAnchor,
    scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
    calls: &mut Vec<RawClientCall>,
) -> Option<usize> {
    let arguments = argument_nodes(site);
    if arguments.is_empty() {
        return None;
    }
    let mut bound = scope.clone();
    bound.local_events = None;
    for hole in &anchor.hole_params {
        let Some(index) = anchor.param_index.get(hole) else {
            return None;
        };
        let Some(argument) = arguments.get(*index) else {
            return None;
        };
        let fragment = endpoint_fragment(*argument, content, scope)?;
        bound.shadowed_locals.remove(hole);
        bound.local_variables.insert(hole.clone(), fragment);
    }
    let anchor_call =
        root_of(site).descendant_for_byte_range(anchor.call_start, anchor.call_end)?;
    if anchor_call.kind() != "call_expression" {
        return None;
    }
    let CallInspection::Resolved(mut call) = inspect_call_expression(
        anchor_call,
        content,
        rel_path,
        &bound,
        imports,
        http_modules,
    ) else {
        return None;
    };
    // The endpoint was decided here, so the contract is reported at the call site. `rawUrl`
    // stays the wrapper's own expression: that is the code that actually sends the request.
    call.line = site.start_position().row as u32 + 1;
    call.anchor = site.start_byte();
    // The wrapper's client is the site's envelope only when the wrapper returns that call
    // untouched. A wrapper that chains `.then(res => res.body)` over it hands its callers the
    // payload, so a `res.data` at the site names a wire field rather than the envelope.
    call.transport_anchor = is_bare_transport_value(anchor_call).then_some(anchor.call_start);
    let snippet = slice_node(site, content);
    let cap = snippet.len().min(160);
    call.usage_snippet = snippet[..cap].replace('\n', " ").trim().to_string();
    // The wrapper's own body argument names its parameter, not anything the caller wrote.
    // Reporting it as a request-body expression would attribute a shape to the site that only
    // the wrapper's signature invented.
    call.request_body_expr = None;
    call.request_body_type = None;
    call.request_body_explicit_none = false;
    calls.push(call);
    Some(anchor.call_start)
}

/// Whether a call is handed on as itself rather than chained over. A chain continuation
/// starts at the same byte as its receiver, so `api.get(u).then(unwrap)` can be told from
/// `api.get(u)` by walking up while the offset is shared.
fn is_bare_transport_value(call: Node) -> bool {
    let mut current = call;
    while let Some(parent) = current.parent() {
        if parent.start_byte() != current.start_byte() {
            return current == call;
        }
        if !matches!(
            parent.kind(),
            "member_expression" | "call_expression" | "parenthesized_expression"
        ) {
            return false;
        }
        current = parent;
    }
    current == call
}

/// The text a call site uses to reach a binding: `requests.get` or a bare `load`.
fn callee_binding(call: Node, content: &str) -> Option<String> {
    let function = call.child_by_field_name("function")?;
    let function = unwrap_expression(function);
    match function.kind() {
        "identifier" => Some(slice_node(function, content).trim().to_string()),
        "member_expression" => {
            let object = function.child_by_field_name("object")?;
            let property = function.child_by_field_name("property")?;
            if !matches!(object.kind(), "identifier" | "member_expression") {
                return None;
            }
            Some(format!(
                "{}.{}",
                slice_node(object, content).trim(),
                slice_node(property, content).trim()
            ))
        }
        _ => None,
    }
}

/// Publishes a contract when this call reaches a known wrapper with an argument this pass can
/// name. Only the endpoint crosses the hop; the call site's own line and snippet are kept.
fn try_wrapper_fanout(
    site: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    wrappers: &HashMap<String, WrapperAnchor>,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
    calls: &mut Vec<RawClientCall>,
    coverage: &mut HashMap<usize, WrapperCoverage>,
) -> bool {
    let Some(binding) = callee_binding(site, content) else {
        return false;
    };
    let Some(anchor) = wrappers.get(&binding) else {
        return false;
    };
    match fan_out_wrapper_site(
        site,
        content,
        rel_path,
        anchor,
        scope,
        imports,
        http_modules,
        calls,
    ) {
        Some(anchor_start) => {
            coverage
                .entry(anchor_start)
                .or_insert_with(WrapperCoverage::default)
                .resolved_sites += 1;
            true
        }
        None => {
            coverage
                .entry(anchor.call_start)
                .or_insert_with(WrapperCoverage::default)
                .unbound_sites += 1;
            false
        }
    }
}

/// TypeScript's `paths`/`baseUrl` mapping, read from the nearest tsconfig so an
/// `@shared/models` import names the file it actually resolves to.
#[derive(Default, Clone, Debug)]
struct ModuleResolver {
    exact: Vec<(String, String)>,
    prefixes: Vec<(String, String)>,
    base_url: Option<String>,
}

impl ModuleResolver {
    fn from_project(repo_root: &Path, ts_root: &Path) -> Self {
        let Some(config) = find_tsconfig(ts_root, repo_root) else {
            return Self::default();
        };
        let mut seen = HashSet::new();
        let mut resolver = Self::default();
        merge_tsconfig(&config, repo_root, &mut seen, 0, &mut resolver);
        // A child config overrides its `extends` parent, so the last declaration wins.
        let mut exact: Vec<(String, String)> = Vec::new();
        for (key, value) in resolver.exact.drain(..) {
            exact.retain(|(existing, _)| existing != &key);
            exact.push((key, value));
        }
        let mut prefixes: Vec<(String, String)> = Vec::new();
        for (key, value) in resolver.prefixes.drain(..) {
            prefixes.retain(|(existing, _)| existing != &key);
            prefixes.push((key, value));
        }
        resolver.exact = exact;
        resolver.prefixes = prefixes;
        resolver
            .prefixes
            .sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.0.cmp(&b.0)));
        resolver.exact.sort();
        resolver
    }

    fn resolve(&self, rel_path: &str, module: &str) -> Option<String> {
        if module.starts_with('.') {
            return resolve_import_module(rel_path, module);
        }
        if let Some((_, target)) = self.exact.iter().find(|(key, _)| key == module) {
            return Some(target.clone());
        }
        for (prefix, target) in &self.prefixes {
            if let Some(rest) = module.strip_prefix(prefix) {
                return Some(format!("{target}{rest}"));
            }
        }
        if let Some(base) = &self.base_url {
            return Some(format!("{base}{module}"));
        }
        Some(module.trim_start_matches('/').to_string())
    }
}

fn find_tsconfig(ts_root: &Path, repo_root: &Path) -> Option<PathBuf> {
    let mut current = Some(ts_root);
    for _ in 0..12 {
        let dir = current?;
        for name in ["tsconfig.json", "tsconfig.base.json"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if dir == repo_root {
            break;
        }
        current = dir.parent();
    }
    None
}

fn merge_tsconfig(
    file: &Path,
    repo_root: &Path,
    seen: &mut HashSet<PathBuf>,
    depth: usize,
    resolver: &mut ModuleResolver,
) {
    if depth > 4 || !seen.insert(file.to_path_buf()) {
        return;
    }
    let Ok(raw) = fs::read_to_string(file) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&strip_json_comments(&raw)) else {
        return;
    };
    let Some(dir) = file.parent() else {
        return;
    };
    if let Some(extends) = json.get("extends").and_then(|value| value.as_str()) {
        if extends.starts_with('.') {
            let mut parent = dir.join(extends);
            if parent.extension().is_none() {
                parent.set_extension("json");
            }
            merge_tsconfig(&parent, repo_root, seen, depth + 1, resolver);
        }
    }
    let Some(dir_rel) = dir.strip_prefix(repo_root).ok().map(path_to_posix) else {
        return;
    };
    let Some(options) = json.get("compilerOptions") else {
        return;
    };
    let base_dir = options
        .get("baseUrl")
        .and_then(|value| value.as_str())
        .map(|value| normalize_rel_path(&format!("{dir_rel}/{value}")))
        .unwrap_or(dir_rel);
    if options
        .get("baseUrl")
        .and_then(|value| value.as_str())
        .is_some()
    {
        let base = format!("{}/", base_dir.trim_end_matches('/'));
        resolver.base_url = Some(base);
    }
    let Some(paths) = options.get("paths").and_then(|value| value.as_object()) else {
        return;
    };
    for (key, targets) in paths {
        let Some(target) = targets
            .as_array()
            .and_then(|values| values.first())
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let target = normalize_rel_path(&format!("{base_dir}/{target}"));
        if let Some(prefix) = key.strip_suffix('*') {
            let target_prefix = target.strip_suffix('*').unwrap_or(&target).to_string();
            resolver.prefixes.push((prefix.to_string(), target_prefix));
        } else {
            resolver.exact.push((key.clone(), target));
        }
    }
}

/// tsconfig is JSONC: comments are legal and common.
fn strip_json_comments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            out.push(byte);
            if byte == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            out.push(byte);
            i += 1;
            continue;
        }
        if byte == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if byte == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        // JSONC permits a trailing comma before a closing brace or bracket.
        if byte == b',' {
            let mut next = i + 1;
            while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                next += 1;
            }
            if next < bytes.len() && matches!(bytes[next], b'}' | b']') {
                i += 1;
                continue;
            }
        }
        out.push(byte);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn normalize_rel_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn module_candidates(resolver: &ModuleResolver, rel_path: &str, module: &str) -> Vec<String> {
    let Some(resolved) = resolver.resolve(rel_path, module) else {
        return Vec::new();
    };
    let key = strip_script_extension(&resolved).to_string();
    vec![key.clone(), format!("{key}/index")]
}

fn resolve_imported_constants(
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> HashMap<String, String> {
    let mut resolved = HashMap::new();
    for (local, binding) in imports {
        if binding.imported == "*" {
            continue;
        }
        for candidate in module_candidates(resolver, rel_path, &binding.module) {
            let Some(value) = module_constants
                .get(&candidate)
                .and_then(|constants| constants.get(&binding.imported))
            else {
                continue;
            };
            resolved.insert(local.clone(), value.clone());
            break;
        }
    }
    resolved
}

struct ModuleSurface {
    locals: BTreeMap<String, String>,
    direct: BTreeMap<String, String>,
    local_exports: Vec<(String, String)>,
    symbol_reexports: Vec<(String, String, String)>,
    star_reexports: Vec<String>,
}

fn scan_module_surface(root: Node, content: &str) -> ModuleSurface {
    let locals: BTreeMap<String, String> =
        collect_file_constants(root, content).into_iter().collect();
    let local = &locals;
    let mut direct = BTreeMap::new();
    let mut local_exports = Vec::new();
    let mut symbol_reexports = Vec::new();
    let mut star_reexports = Vec::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "export_statement" {
            continue;
        }
        if let Some(declaration) = child.child_by_field_name("declaration") {
            if matches!(
                declaration.kind(),
                "lexical_declaration" | "variable_declaration"
            ) {
                let mut decl_cursor = declaration.walk();
                for declarator in declaration.children(&mut decl_cursor) {
                    if declarator.kind() != "variable_declarator" {
                        continue;
                    }
                    let Some(name) = declarator.child_by_field_name("name") else {
                        continue;
                    };
                    let name = slice_node(name, content).trim();
                    if let Some(value) = local.get(name) {
                        direct.insert(name.to_string(), value.clone());
                    }
                }
            }
        }
        let source = child
            .child_by_field_name("source")
            .map(|source| unquote_str(slice_node(source, content)));
        let mut saw_clause = false;
        let mut saw_namespace = false;
        let mut clause_cursor = child.walk();
        for part in child.named_children(&mut clause_cursor) {
            match part.kind() {
                "namespace_export" => saw_namespace = true,
                "export_clause" => {
                    saw_clause = true;
                    let mut spec_cursor = part.walk();
                    for spec in part.named_children(&mut spec_cursor) {
                        if spec.kind() != "export_specifier" {
                            continue;
                        }
                        let Some(name) = spec.child_by_field_name("name") else {
                            continue;
                        };
                        let name = slice_node(name, content).trim().to_string();
                        let exported = spec
                            .child_by_field_name("alias")
                            .map(|alias| slice_node(alias, content).trim().to_string())
                            .unwrap_or_else(|| name.clone());
                        match &source {
                            Some(module) => symbol_reexports.push((name, exported, module.clone())),
                            None => local_exports.push((exported, name)),
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(module) = source {
            if !saw_clause && !saw_namespace {
                star_reexports.push(module);
            }
        }
    }
    ModuleSurface {
        locals,
        direct,
        local_exports,
        symbol_reexports,
        star_reexports,
    }
}

/// Exported URL-fragment constants, keyed by module path without its extension.
/// Re-exports propagate values through barrels to a bounded fixpoint.
fn collect_module_constants(
    repo_root: &Path,
    files: &[PathBuf],
    resolver: &ModuleResolver,
) -> HashMap<String, BTreeMap<String, String>> {
    struct FileFacts {
        module: String,
        direct: BTreeMap<String, String>,
        symbols: Vec<(String, String, Vec<String>)>,
        stars: Vec<String>,
    }
    let facts: Vec<FileFacts> = files
        .par_iter()
        .filter_map(|file_path| {
            let content = fs::read_to_string(file_path).ok()?;
            if !content.contains("export") {
                return None;
            }
            let rel_path = path_to_posix(file_path.strip_prefix(repo_root).unwrap_or(file_path));
            let mut parser = Parser::new();
            let grammar = match grammar_for(&rel_path) {
                TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
                TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            };
            if parser.set_language(&grammar).is_err() {
                return None;
            }
            let tree = parser.parse(&content, None)?;
            let surface = scan_module_surface(tree.root_node(), &content);
            let module = strip_script_extension(&rel_path).to_string();
            let direct = surface
                .direct
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .chain(
                    surface
                        .local_exports
                        .iter()
                        .filter_map(|(exported, local)| {
                            surface
                                .locals
                                .get(local)
                                .map(|value| (exported.clone(), value.clone()))
                        }),
                )
                .collect::<BTreeMap<_, _>>();
            let symbols = surface
                .symbol_reexports
                .iter()
                .map(|(source_name, exported, module_spec)| {
                    (
                        source_name.clone(),
                        exported.clone(),
                        module_candidates(resolver, &rel_path, module_spec),
                    )
                })
                .collect::<Vec<_>>();
            let stars = surface
                .star_reexports
                .iter()
                .flat_map(|module_spec| module_candidates(resolver, &rel_path, module_spec))
                .collect::<Vec<_>>();
            Some(FileFacts {
                module,
                direct,
                symbols,
                stars,
            })
        })
        .collect();

    let mut constants: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    for facts in &facts {
        if !facts.direct.is_empty() {
            constants.insert(facts.module.clone(), facts.direct.clone());
        }
    }
    for _ in 0..4 {
        let mut updates: Vec<(String, String, String)> = Vec::new();
        for facts in &facts {
            for (source_name, exported, targets) in &facts.symbols {
                for target in targets {
                    if let Some(value) = constants
                        .get(target)
                        .and_then(|values| values.get(source_name))
                    {
                        updates.push((facts.module.clone(), exported.clone(), value.clone()));
                        break;
                    }
                }
            }
            for target in &facts.stars {
                if let Some(values) = constants.get(target) {
                    for (name, value) in values {
                        updates.push((facts.module.clone(), name.clone(), value.clone()));
                    }
                }
            }
        }
        let mut changed = false;
        for (module, name, value) in updates {
            let entry = constants.entry(module).or_default();
            match entry.get(&name) {
                Some(existing) if existing == &value => {}
                Some(_) => {}
                None => {
                    entry.insert(name, value);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    constants
}

/// Angular `HttpInterceptor` and axios request interceptors can prefix every request
/// URL. Only a literal/constant prefix is recorded; the routes themselves are not
/// rewritten, so a prefix that cannot be proven stays visible as a blocker.
fn collect_interceptor_evidence(
    repo_root: &Path,
    files: &[PathBuf],
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> (Option<serde_json::Value>, Vec<ArtifactBlocker>) {
    struct Entry {
        file: String,
        line: u32,
        prefix: Option<String>,
        framework: &'static str,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut has_interceptor = false;
    let mut detected_frameworks: BTreeSet<&'static str> = BTreeSet::new();
    for path in files {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        // Angular 15+ functional interceptors (`HttpInterceptorFn`) have no `intercept(`
        // method, so the type name alone must arm the scan.
        let angular = content.contains("HttpInterceptor")
            && (content.contains("intercept(") || content.contains("HttpInterceptorFn"));
        let axios = content.contains(".interceptors.request.use");
        if !angular && !axios {
            continue;
        }
        has_interceptor = true;
        if angular {
            detected_frameworks.insert("angular");
        }
        if axios {
            detected_frameworks.insert("axios");
        }
        let rel_path = path_to_posix(path.strip_prefix(repo_root).unwrap_or(path));
        let mut parser = Parser::new();
        let grammar = match grammar_for(&rel_path) {
            TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        };
        if parser.set_language(&grammar).is_err() {
            continue;
        }
        let Some(tree) = parser.parse(&content, None) else {
            continue;
        };
        let root = tree.root_node();
        let constants = collect_file_constants(root, &content);
        let imports = collect_imports(root, &content);
        let resolve = |node: Node| {
            interceptor_prefix_expr(
                node,
                &content,
                &rel_path,
                &constants,
                &imports,
                resolver,
                module_constants,
            )
        };
        walk_interceptor_nodes(root, &mut |node| {
            if angular && node.kind() == "call_expression" {
                let Some(function) = node.child_by_field_name("function") else {
                    return;
                };
                if function.kind() != "member_expression" {
                    return;
                }
                let property = function
                    .child_by_field_name("property")
                    .map(|property| slice_node(property, &content).trim())
                    .unwrap_or("");
                if property != "clone" {
                    return;
                }
                let Some(arguments) = node.child_by_field_name("arguments") else {
                    return;
                };
                let mut cursor = arguments.walk();
                let Some(first) = arguments.named_children(&mut cursor).next() else {
                    return;
                };
                if first.kind() != "object" {
                    return;
                }
                let mut object_cursor = first.walk();
                for pair in first.named_children(&mut object_cursor) {
                    if pair.kind() != "pair" {
                        continue;
                    }
                    let key = pair
                        .child_by_field_name("key")
                        .map(|key| unquote_str(slice_node(key, &content)))
                        .unwrap_or_default();
                    if key != "url" {
                        continue;
                    }
                    if let Some(value) = pair.child_by_field_name("value") {
                        entries.push(Entry {
                            file: rel_path.clone(),
                            line: (node.start_position().row + 1) as u32,
                            prefix: resolve(value),
                            framework: "angular",
                        });
                    }
                }
            }
            if axios && node.kind() == "assignment_expression" {
                let (Some(left), Some(right)) = (
                    node.child_by_field_name("left"),
                    node.child_by_field_name("right"),
                ) else {
                    return;
                };
                let left = slice_node(left, &content).trim();
                if !(left.ends_with(".baseURL") || left.ends_with(".url")) {
                    return;
                }
                entries.push(Entry {
                    file: rel_path.clone(),
                    line: (node.start_position().row + 1) as u32,
                    prefix: resolve(right),
                    framework: "axios",
                });
            }
        });
    }
    if !has_interceptor {
        return (None, Vec::new());
    }
    entries.sort_by(|a, b| (&a.file, a.line, &a.prefix).cmp(&(&b.file, b.line, &b.prefix)));
    entries.dedup_by(|a, b| a.file == b.file && a.line == b.line && a.prefix == b.prefix);
    let mut blockers = Vec::new();
    let mut prefixes = Vec::new();
    for entry in &entries {
        match &entry.prefix {
            Some(prefix) => prefixes.push(serde_json::json!({
                "file": entry.file,
                "line": entry.line,
                "prefix": prefix,
                "framework": entry.framework,
            })),
            None => blockers.push(blocker_for(
                &entry.file,
                "TS_INTERCEPTOR_PREFIX_UNRESOLVED",
                "An interceptor mutates the request URL with an expression that is not a literal/constant prefix; the prefix is not applied or recorded as evidence".to_string(),
            )),
        }
    }
    let evidence = serde_json::json!({
        "frameworks": detected_frameworks.into_iter().collect::<Vec<_>>(),
        "prefixes": prefixes,
        "complete": blockers.is_empty(),
    });
    (Some(evidence), blockers)
}

fn interceptor_prefix_expr(
    node: Node,
    content: &str,
    rel_path: &str,
    constants: &HashMap<String, String>,
    imports: &HashMap<String, ImportBinding>,
    resolver: &ModuleResolver,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
) -> Option<String> {
    let node = unwrap_expression(node);
    match node.kind() {
        "string" => Some(unquote_str(slice_node(node, content))),
        "template_string" => {
            let mut value = String::new();
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "string_fragment" => value.push_str(slice_node(child, content)),
                    "template_substitution" => {
                        let inner = slice_node(child, content)
                            .trim_start_matches("${")
                            .trim_end_matches('}')
                            .trim();
                        value.push_str(&resolve_interceptor_identifier(
                            inner,
                            rel_path,
                            constants,
                            imports,
                            resolver,
                            module_constants,
                        )?);
                    }
                    _ => {}
                }
            }
            (!value.is_empty()).then_some(value)
        }
        "binary_expression" => {
            let operator = node
                .child_by_field_name("operator")
                .map(|operator| slice_node(operator, content).trim())
                .unwrap_or_default();
            if operator != "+" {
                return None;
            }
            interceptor_prefix_expr(
                node.child_by_field_name("left")?,
                content,
                rel_path,
                constants,
                imports,
                resolver,
                module_constants,
            )
        }
        "parenthesized_expression" => interceptor_prefix_expr(
            node.named_child(0)?,
            content,
            rel_path,
            constants,
            imports,
            resolver,
            module_constants,
        ),
        "identifier" => {
            let name = slice_node(node, content).trim();
            resolve_interceptor_identifier(
                name,
                rel_path,
                constants,
                imports,
                resolver,
                module_constants,
            )
        }
        _ => None,
    }
}

fn resolve_interceptor_identifier(
    name: &str,
    rel_path: &str,
    constants: &HashMap<String, String>,
    imports: &HashMap<String, ImportBinding>,
    resolver: &ModuleResolver,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
) -> Option<String> {
    if let Some(value) = constants.get(name) {
        return Some(value.clone());
    }
    let binding = imports.get(name)?;
    for candidate in module_candidates(resolver, rel_path, &binding.module) {
        if let Some(value) = module_constants
            .get(&candidate)
            .and_then(|values| values.get(&binding.imported))
        {
            return Some(value.clone());
        }
    }
    None
}

fn walk_interceptor_nodes<F: FnMut(Node)>(node: Node, visit: &mut F) {
    fn inner<F: FnMut(Node)>(node: Node, visit: &mut F, depth: usize) {
        if depth > MAX_AST_DEPTH {
            return;
        }
        visit(node);
        for index in 0..node.child_count() {
            if let Some(child) = node.child(index as u32) {
                inner(child, visit, depth + 1);
            }
        }
    }
    inner(node, visit, 0);
}

fn analyze_ts_source(
    repo_root: &Path,
    file_path: &Path,
    http_modules: &HashSet<String>,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> FileFacts {
    let rel_path = path_to_posix(file_path.strip_prefix(repo_root).unwrap_or(file_path));
    let content = match fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(e) => {
            return FileFacts::blocked(blocker_for(
                &rel_path,
                "TS_SOURCE_UNREADABLE",
                format!(
                    "Source file could not be read ({e}); its calls and declarations are absent from this artifact"
                ),
            ));
        }
    };
    // Every source file is parsed. A client call can be spelled without any token an
    // earlier heuristic recognized (`transport({ url })`, `conduit.get('/orders')`), so
    // skipping files by content would silently exclude exactly the calls this pass exists
    // to find.
    let grammar = grammar_for(&rel_path);
    file_facts_from_parse(
        &rel_path,
        &content,
        grammar,
        http_modules,
        module_constants,
        resolver,
    )
}

fn analyze_sfc_source(
    repo_root: &Path,
    file_path: &Path,
    http_modules: &HashSet<String>,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> FileFacts {
    let rel_path = path_to_posix(file_path.strip_prefix(repo_root).unwrap_or(file_path));
    let content = match fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(e) => {
            return FileFacts::blocked(blocker_for(
                &rel_path,
                "TS_SOURCE_UNREADABLE",
                format!(
                    "Source file could not be read ({e}); its calls and declarations are absent from this artifact"
                ),
            ));
        }
    };
    let is_svelte = rel_path.ends_with(".svelte");
    let scan = if is_svelte {
        scan_svelte_scripts(&content)
    } else {
        scan_vue_scripts(&content)
    };
    let mut facts = file_facts_from_parse(
        &rel_path,
        &scan.masked,
        scan.grammar,
        http_modules,
        module_constants,
        resolver,
    );
    if !is_svelte && vue_declares_mixins(&scan.masked, scan.grammar) {
        facts.blockers.push(blocker_for(
            &rel_path,
            "TS_SFC_MIXINS_UNRESOLVED",
            "This single-file component declares `mixins`; members supplied by a mixin are not resolved into this component, so calls they make are absent from this artifact"
                .to_string(),
        ));
    }
    for (code, message) in scan.issues {
        facts.blockers.push(blocker_for(&rel_path, &code, message));
    }
    facts
}

/// Mixin members are injected at runtime. Detecting the declaration is enough to mark the
/// component's call population as incomplete; resolving mixin call graphs is not attempted.
fn vue_declares_mixins(masked: &str, grammar: TsGrammar) -> bool {
    if !masked.contains("mixins") {
        return false;
    }
    let mut parser = Parser::new();
    let language = match grammar {
        TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    };
    if parser.set_language(&language).is_err() {
        return true;
    }
    let Some(tree) = parser.parse(masked, None) else {
        return true;
    };
    tree_declares_mixins(tree.root_node(), masked)
}

fn tree_declares_mixins(node: Node, content: &str) -> bool {
    if node.kind() == "pair" {
        if let Some(key) = node.child_by_field_name("key") {
            let text = slice_node(key, content).trim();
            if text == "mixins" || unquote_str(text) == "mixins" {
                return true;
            }
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i as u32) {
            if tree_declares_mixins(child, content) {
                return true;
            }
        }
    }
    false
}

fn file_facts_from_parse(
    rel_path: &str,
    content: &str,
    grammar: TsGrammar,
    http_modules: &HashSet<String>,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> FileFacts {
    let parsed = parse_ts_file(
        rel_path,
        content,
        grammar,
        http_modules,
        module_constants,
        resolver,
    );

    // Markup is legal in places the extension does not advertise: a Vue `<script>` block,
    // a `.ts` file holding JSX. The TypeScript grammar rejects those, and reporting the file
    // broken would drop every call in it, so a file that fails one grammar is retried with
    // TSX and only reported when neither can read it.
    if grammar == TsGrammar::Typescript {
        let ts_reported_error = matches!(&parsed, Ok(result) if result.7.is_some());
        if ts_reported_error {
            if let Ok(tsx) = parse_ts_file(
                rel_path,
                content,
                TsGrammar::Tsx,
                http_modules,
                module_constants,
                resolver,
            ) {
                if tsx.7.is_none() {
                    return file_facts_from_parsed(rel_path, tsx);
                }
            }
        }
    }

    match parsed {
        Ok(parsed) => file_facts_from_parsed(rel_path, parsed),
        Err(e) => FileFacts::blocked(blocker_for(rel_path, "TS_PARSE_ERROR", format!("{e}"))),
    }
}

fn file_facts_from_parsed(
    rel_path: &str,
    parsed: (
        Vec<RawClientCall>,
        Vec<(String, WireType)>,
        Vec<(String, AliasDef)>,
        HashMap<String, ImportBinding>,
        HashMap<String, ExportBinding>,
        Vec<(String, Vec<String>)>,
        Vec<(u32, String, usize)>,
        Option<usize>,
        Vec<(String, GenericDecl)>,
    ),
) -> FileFacts {
    let (calls, types, aliases, imports, exports, heritage, unresolved_urls, error_line, generics) =
        parsed;
    let mut facts = FileFacts::clean(
        rel_path, calls, types, aliases, generics, imports, exports, heritage,
    );
    if !unresolved_urls.is_empty() {
        let mut calls = unresolved_urls;
        calls.sort_unstable();
        calls.dedup();
        let shown = calls
            .iter()
            .take(10)
            .map(|(line, method, _)| format!("{method} at line {line}"))
            .collect::<Vec<_>>()
            .join(", ");
        let extra = calls.len().saturating_sub(10);
        let suffix = if extra > 0 {
            format!(" and {extra} more")
        } else {
            String::new()
        };
        facts.blockers.push(blocker_for(
            rel_path,
            "TS_UNRESOLVED_CLIENT_URL",
            format!(
                "{} HTTP client call(s) ({}{}) do not expose a statically resolvable endpoint; their routes are absent from this artifact",
                calls.len(),
                shown,
                suffix
            ),
        ));
    }
    if let Some(line) = error_line {
        facts.blockers.push(blocker_for(
            rel_path,
            "TS_PARSE_ERROR",
            format!(
                "Tree-sitter reported a syntax error near line {line}; facts from this file may be incomplete"
            ),
        ));
    }
    facts
}

struct VueScriptBlock {
    body_start: usize,
    body_end: usize,
}

pub(crate) struct VueScan {
    /// Identical to the SFC byte-for-byte except that every region outside a supported
    /// `<script>` body is spaces. Newlines survive, so tree-sitter rows are SFC rows.
    pub(crate) masked: String,
    pub(crate) grammar: TsGrammar,
    pub(crate) issues: Vec<(String, String)>,
}

pub(crate) fn scan_vue_scripts(content: &str) -> VueScan {
    let bytes = content.as_bytes();
    let mut blocks = Vec::new();
    let mut issues = Vec::new();
    let mut grammar = TsGrammar::Typescript;
    let mut template_depth = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let Some(lt) = find_byte_from(bytes, b'<', i) else {
            break;
        };
        i = lt;
        if bytes[i..].starts_with(b"<!--") {
            i = find_bytes_ci(bytes, b"-->", i + 4)
                .map(|pos| pos + 3)
                .unwrap_or(bytes.len());
            continue;
        }
        let mut j = i + 1;
        let closing = j < bytes.len() && bytes[j] == b'/';
        if closing {
            j += 1;
        }
        let name_start = j;
        while j < bytes.len() && is_tag_name_byte(bytes[j]) {
            j += 1;
        }
        if j == name_start {
            i += 1;
            continue;
        }
        let name = content[name_start..j].to_ascii_lowercase();
        let Some(tag_end) = find_tag_end(bytes, j) else {
            break;
        };
        i = tag_end + 1;
        if closing {
            if name == "template" && template_depth > 0 {
                template_depth -= 1;
            }
            continue;
        }
        let self_closing = is_self_closing(bytes, j, tag_end);
        if template_depth > 0 {
            if name == "template" && !self_closing {
                template_depth += 1;
            }
            continue;
        }
        if name == "template" {
            if !self_closing {
                template_depth = 1;
            }
            continue;
        }
        if name != "script" {
            // Style and custom blocks are raw text. A `<script>` written inside one is
            // content, not an SFC script block.
            if !self_closing {
                i = skip_past_closing_tag(bytes, i, &name);
            }
            continue;
        }

        let attrs = parse_tag_attributes(&content[j..tag_end]);
        let attr = |key: &str| {
            attrs
                .iter()
                .find(|(name, _)| name == key)
                .and_then(|(_, value)| value.clone())
        };
        let lang = attr("lang").map(|value| value.to_ascii_lowercase());
        if let Some(src) = attr("src") {
            issues.push((
                "TS_SFC_EXTERNAL_SCRIPT".to_string(),
                format!(
                    "A <script src=\"{src}\"> block keeps its code outside this single-file component; its calls are absent from this artifact unless that file is scanned independently"
                ),
            ));
            if !self_closing {
                i = skip_past_closing_tag(bytes, i, "script");
            }
            continue;
        }
        let supported = match lang.as_deref() {
            None | Some("ts") | Some("typescript") | Some("javascript") | Some("js") => true,
            Some("tsx") | Some("jsx") => {
                grammar = TsGrammar::Tsx;
                true
            }
            Some(other) => {
                issues.push((
                    "TS_SFC_UNSUPPORTED_LANGUAGE".to_string(),
                    format!(
                        "A <script lang=\"{other}\"> block cannot be parsed by this extractor; its calls are absent from this artifact"
                    ),
                ));
                false
            }
        };
        if self_closing {
            continue;
        }
        let (body_end, closed) = match find_bytes_ci(bytes, b"</script", i) {
            Some(close) => (close, true),
            None => (bytes.len(), false),
        };
        if !closed {
            issues.push((
                "TS_SFC_UNCLOSED_SCRIPT".to_string(),
                "A <script> block is never closed; parsing stopped at the end of the file and facts from this component may be incomplete"
                    .to_string(),
            ));
        }
        if supported {
            blocks.push(VueScriptBlock {
                body_start: i,
                body_end,
            });
        }
        i = if closed {
            skip_past_closing_tag(bytes, body_end, "script")
        } else {
            bytes.len()
        };
    }

    if template_depth > 0 {
        issues.push((
            "TS_SFC_UNCLOSED_TEMPLATE".to_string(),
            "A <template> block is never closed; any script blocks after it were not reached, so this component's calls may be incomplete"
                .to_string(),
        ));
    }

    let mut masked = content.as_bytes().to_vec();
    for byte in masked.iter_mut() {
        if *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
    for block in &blocks {
        masked[block.body_start..block.body_end]
            .copy_from_slice(&content.as_bytes()[block.body_start..block.body_end]);
    }

    VueScan {
        masked: String::from_utf8(masked).expect("masking preserves UTF-8 boundaries"),
        grammar,
        issues,
    }
}

/// Mask a Svelte component down to its `<script>` blocks. Svelte markup is not HTML:
/// void/self-closing elements have no closing tag, so the Vue scanner's "skip to the
/// matching closing tag" rule would swallow the rest of the component. This scanner only
/// enters a tag body for `<script>`.
pub(crate) fn scan_svelte_scripts(content: &str) -> VueScan {
    let bytes = content.as_bytes();
    let mut blocks = Vec::new();
    let mut issues = Vec::new();
    let mut grammar = TsGrammar::Typescript;
    let mut i = 0usize;

    while i < bytes.len() {
        let Some(lt) = find_byte_from(bytes, b'<', i) else {
            break;
        };
        i = lt;
        if bytes[i..].starts_with(b"<!--") {
            i = find_bytes_ci(bytes, b"-->", i + 4)
                .map(|pos| pos + 3)
                .unwrap_or(bytes.len());
            continue;
        }
        let mut j = i + 1;
        if j < bytes.len() && bytes[j] == b'/' {
            i = lt + 1;
            continue;
        }
        let name_start = j;
        while j < bytes.len() && is_tag_name_byte(bytes[j]) {
            j += 1;
        }
        if j == name_start {
            i = lt + 1;
            continue;
        }
        let name = content[name_start..j].to_ascii_lowercase();
        if name != "script" {
            i = lt + 1;
            continue;
        }
        let Some(tag_end) = find_tag_end(bytes, j) else {
            break;
        };
        let attrs = parse_tag_attributes(&content[j..tag_end]);
        let attr = |key: &str| {
            attrs
                .iter()
                .find(|(name, _)| name == key)
                .and_then(|(_, value)| value.clone())
        };
        let self_closing = is_self_closing(bytes, j, tag_end);
        i = tag_end + 1;
        if let Some(src) = attr("src") {
            issues.push((
                "TS_SFC_EXTERNAL_SCRIPT".to_string(),
                format!(
                    "A <script src=\"{src}\"> block keeps its code outside this single-file component; its calls are absent from this artifact unless that file is scanned independently"
                ),
            ));
            if !self_closing {
                i = skip_past_closing_tag(bytes, i, "script");
            }
            continue;
        }
        let lang = attr("lang").map(|value| value.to_ascii_lowercase());
        let supported = match lang.as_deref() {
            None | Some("ts") | Some("typescript") | Some("javascript") | Some("js") => true,
            Some("tsx") | Some("jsx") => {
                grammar = TsGrammar::Tsx;
                true
            }
            Some(other) => {
                issues.push((
                    "TS_SFC_UNSUPPORTED_LANGUAGE".to_string(),
                    format!(
                        "A <script lang=\"{other}\"> block cannot be parsed by this extractor; its calls are absent from this artifact"
                    ),
                ));
                false
            }
        };
        if self_closing {
            continue;
        }
        let (body_end, closed) = match find_bytes_ci(bytes, b"</script", i) {
            Some(close) => (close, true),
            None => (bytes.len(), false),
        };
        if !closed {
            issues.push((
                "TS_SFC_UNCLOSED_SCRIPT".to_string(),
                "A <script> block is never closed; parsing stopped at the end of the file and facts from this component may be incomplete"
                    .to_string(),
            ));
        }
        if supported {
            blocks.push(VueScriptBlock {
                body_start: i,
                body_end,
            });
        }
        i = if closed {
            skip_past_closing_tag(bytes, body_end, "script")
        } else {
            bytes.len()
        };
    }

    let mut masked = content.as_bytes().to_vec();
    for byte in masked.iter_mut() {
        if *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
    for block in &blocks {
        masked[block.body_start..block.body_end]
            .copy_from_slice(&content.as_bytes()[block.body_start..block.body_end]);
    }

    VueScan {
        masked: String::from_utf8(masked).expect("masking preserves UTF-8 boundaries"),
        grammar,
        issues,
    }
}

fn find_byte_from(bytes: &[u8], needle: u8, from: usize) -> Option<usize> {
    if from >= bytes.len() {
        return None;
    }
    bytes[from..]
        .iter()
        .position(|byte| *byte == needle)
        .map(|pos| from + pos)
}

fn find_bytes_ci(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= bytes.len() {
        return None;
    }
    bytes[from..]
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
        .map(|pos| from + pos)
}

fn is_tag_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b':'
}

fn find_tag_end(bytes: &[u8], mut i: usize) -> Option<usize> {
    let mut quote = None;
    while i < bytes.len() {
        let byte = bytes[i];
        match quote {
            Some(q) => {
                if byte == q {
                    quote = None;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    quote = Some(byte);
                } else if byte == b'>' {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

fn is_self_closing(bytes: &[u8], name_end: usize, tag_end: usize) -> bool {
    let mut k = tag_end;
    while k > name_end && bytes[k - 1].is_ascii_whitespace() {
        k -= 1;
    }
    k > name_end && bytes[k - 1] == b'/'
}

fn skip_past_closing_tag(bytes: &[u8], from: usize, name: &str) -> usize {
    let close = format!("</{name}");
    match find_bytes_ci(bytes, close.as_bytes(), from) {
        Some(pos) => {
            let mut k = pos + close.len();
            while k < bytes.len() && bytes[k] != b'>' {
                k += 1;
            }
            (k + 1).min(bytes.len())
        }
        None => bytes.len(),
    }
}

fn parse_tag_attributes(attrs: &str) -> Vec<(String, Option<String>)> {
    let bytes = attrs.as_bytes();
    let mut parsed = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'/'
        {
            i += 1;
        }
        if name_start == i {
            break;
        }
        let name = attrs[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = None;
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = Some(attrs[value_start..i].to_string());
                if i < bytes.len() {
                    i += 1;
                }
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                value = Some(attrs[value_start..i].to_string());
            }
        }
        parsed.push((name, value));
    }
    parsed
}

fn parse_ts_file(
    rel_path: &str,
    content: &str,
    grammar: TsGrammar,
    http_modules: &HashSet<String>,
    module_constants: &HashMap<String, BTreeMap<String, String>>,
    resolver: &ModuleResolver,
) -> Result<(
    Vec<RawClientCall>,
    Vec<(String, WireType)>,
    Vec<(String, AliasDef)>,
    HashMap<String, ImportBinding>,
    HashMap<String, ExportBinding>,
    Vec<(String, Vec<String>)>,
    Vec<(u32, String, usize)>,
    Option<usize>,
    Vec<(String, GenericDecl)>,
)> {
    let mut parser = Parser::new();

    let language = match grammar {
        TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    };

    parser
        .set_language(&language)
        .map_err(|e| anyhow!("Failed to set tree-sitter language for {}: {}", rel_path, e))?;

    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Tree-sitter could not parse {rel_path}"))?;

    let mut calls = Vec::new();
    let mut types = Vec::new();
    let mut aliases = Vec::new();
    let mut generics = Vec::new();
    let mut heritage = Vec::new();
    let mut unresolved_http_calls = Vec::new();

    let root = tree.root_node();
    let error_line = if root.has_error() {
        first_error_line(root)
    } else {
        None
    };
    let file_constants = collect_file_constants(root, content);
    let imports = collect_imports(root, content);
    let client_aliases = collect_client_alias_bindings(
        root,
        content,
        &|name| {
            imports
                .get(name)
                .map(|binding| (binding.module.clone(), binding.imported.clone()))
        },
        &|module: &str| {
            if HTTP_PACKAGES.contains(&module) || module.contains("angular/common/http") {
                return true;
            }
            resolve_import_module(rel_path, module)
                .is_some_and(|base| http_modules.contains(strip_script_extension(&base)))
        },
    );
    let mut imports = imports;
    for alias in client_aliases {
        imports.entry(alias.name).or_insert(ImportBinding {
            module: alias.module,
            imported: alias.imported,
        });
    }
    collect_destructured_client_bindings(root, content, rel_path, http_modules, &mut imports);
    let exports = collect_exports(root, content);
    let imported_constants =
        resolve_imported_constants(rel_path, &imports, module_constants, resolver);
    let mut scope = ScopeContext {
        file_constants,
        class_constants: HashMap::new(),
        imported_constants,
        local_variables: HashMap::new(),
        enclosing_return_type: None,
        value_assumptions: HashMap::new(),
        class_defs: Rc::new(HashMap::new()),
        local_events: None,
        shadowed_locals: HashSet::new(),
        typed_bindings: HashMap::new(),
    };
    scope.class_defs = Rc::new(collect_class_defs(root, content, &scope));

    let wrappers = collect_wrapper_anchors(root, content, rel_path, &scope, &imports, http_modules);
    let mut coverage: HashMap<usize, WrapperCoverage> = HashMap::new();

    walk_node(
        root,
        content,
        rel_path,
        &mut calls,
        &mut types,
        &mut aliases,
        &mut generics,
        &mut heritage,
        &mut unresolved_http_calls,
        &imports,
        http_modules,
        &scope,
        &wrappers,
        &mut coverage,
        0,
    );

    // A wrapper whose every call site named a route no longer hides an endpoint: the routes it
    // stands for are in this artifact. A site this pass could not read keeps the blocker.
    unresolved_http_calls.retain(|(_, _, start)| match coverage.get(start) {
        Some(entry) => !(entry.resolved_sites > 0 && entry.unbound_sites == 0),
        None => true,
    });

    Ok((
        calls,
        types,
        aliases,
        imports,
        exports,
        heritage,
        unresolved_http_calls,
        error_line,
        generics,
    ))
}

/// `const { get, post: create } = axios` binds client verbs without an import
/// statement. The binding is recorded so call sites resolve to the same client.
fn collect_destructured_client_bindings(
    root: Node,
    content: &str,
    rel_path: &str,
    http_modules: &HashSet<String>,
    imports: &mut HashMap<String, ImportBinding>,
) {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let declaration = match child.kind() {
            "lexical_declaration" | "variable_declaration" => child,
            "export_statement" => match child.child_by_field_name("declaration") {
                Some(declaration) => declaration,
                None => continue,
            },
            _ => continue,
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
            let (Some(name), Some(value)) = (
                declarator.child_by_field_name("name"),
                declarator.child_by_field_name("value"),
            ) else {
                continue;
            };
            if name.kind() != "object_pattern" || value.kind() != "identifier" {
                continue;
            }
            let source = slice_node(value, content).trim();
            if !names_http_client(source, rel_path, imports, http_modules) {
                continue;
            }
            let module = if source == "axios" {
                "axios".to_string()
            } else {
                match imports.get(source) {
                    Some(binding) => binding.module.clone(),
                    None => continue,
                }
            };
            let mut pattern_cursor = name.walk();
            for entry in name.named_children(&mut pattern_cursor) {
                let (imported, local) = match entry.kind() {
                    "shorthand_property_identifier_pattern" => {
                        let name = slice_node(entry, content).trim();
                        (name.to_string(), name.to_string())
                    }
                    "pair_pattern" => {
                        let (Some(key), Some(local)) = (
                            entry.child_by_field_name("key"),
                            entry.child_by_field_name("value"),
                        ) else {
                            continue;
                        };
                        (
                            slice_node(key, content).trim().to_string(),
                            slice_node(local, content).trim().to_string(),
                        )
                    }
                    _ => continue,
                };
                if imported.is_empty() || local.is_empty() {
                    continue;
                }
                imports.entry(local).or_insert(ImportBinding {
                    module: module.clone(),
                    imported,
                });
            }
        }
    }
}

fn collect_imports(root: Node, content: &str) -> HashMap<String, ImportBinding> {
    let mut map = HashMap::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "import_statement" {
            continue;
        }
        let module = match child.child_by_field_name("source") {
            Some(source) => unquote_str(slice_node(source, content)),
            None => continue,
        };
        if module.is_empty() {
            continue;
        }
        let mut clause_cursor = child.walk();
        for clause in child.children(&mut clause_cursor) {
            if clause.kind() != "import_clause" {
                continue;
            }
            let mut part_cursor = clause.walk();
            for part in clause.children(&mut part_cursor) {
                match part.kind() {
                    "identifier" => {
                        let name = slice_node(part, content).trim().to_string();
                        if !name.is_empty() {
                            map.insert(
                                name.clone(),
                                ImportBinding {
                                    module: module.clone(),
                                    imported: name,
                                },
                            );
                        }
                    }
                    "namespace_import" => {
                        // `import * as transport from 'axios'`: the binding is the
                        // module namespace, so HTTP-bearing modules keep their
                        // evidence under the alias instead of being guessed by name.
                        let mut ns_cursor = part.walk();
                        let identifier = part
                            .named_children(&mut ns_cursor)
                            .find(|child| child.kind() == "identifier");
                        if let Some(identifier) = identifier {
                            let local = slice_node(identifier, content).trim().to_string();
                            if !local.is_empty() {
                                map.insert(
                                    local,
                                    ImportBinding {
                                        module: module.clone(),
                                        imported: "*".to_string(),
                                    },
                                );
                            }
                        }
                    }
                    "named_imports" => {
                        let mut spec_cursor = part.walk();
                        for spec in part.children(&mut spec_cursor) {
                            if spec.kind() != "import_specifier" {
                                continue;
                            }
                            let imported = match spec.child_by_field_name("name") {
                                Some(n) => slice_node(n, content).trim().to_string(),
                                None => continue,
                            };
                            let local = spec
                                .child_by_field_name("alias")
                                .map(|n| slice_node(n, content).trim().to_string())
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| imported.clone());
                            if !imported.is_empty() && !local.is_empty() {
                                map.insert(
                                    local,
                                    ImportBinding {
                                        module: module.clone(),
                                        imported,
                                    },
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    map
}

fn collect_exports(root: Node, content: &str) -> HashMap<String, ExportBinding> {
    let mut map = HashMap::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "export_statement" {
            continue;
        }
        let module = match child.child_by_field_name("source") {
            Some(source) => unquote_str(slice_node(source, content)),
            None => continue,
        };
        if module.is_empty() {
            continue;
        }
        let mut clause_cursor = child.walk();
        for clause in child.children(&mut clause_cursor) {
            if clause.kind() == "export_clause" {
                let mut spec_cursor = clause.walk();
                for spec in clause.children(&mut spec_cursor) {
                    if spec.kind() == "export_specifier" {
                        let source_symbol = match spec.child_by_field_name("name") {
                            Some(n) => slice_node(n, content).trim().to_string(),
                            None => continue,
                        };
                        let exported_alias = spec
                            .child_by_field_name("alias")
                            .map(|n| slice_node(n, content).trim().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| source_symbol.clone());
                        if !source_symbol.is_empty() && !exported_alias.is_empty() {
                            map.insert(
                                exported_alias,
                                ExportBinding {
                                    module: module.clone(),
                                    source_symbol,
                                },
                            );
                        }
                    }
                }
            }
        }
    }
    map
}

/// One-based line of the first ERROR/MISSING node in the tree.
fn first_error_line(node: Node) -> Option<usize> {
    if node.is_error() || node.is_missing() {
        return Some(node.start_position().row + 1);
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i as u32) {
            if let Some(line) = first_error_line(child) {
                return Some(line);
            }
        }
    }
    None
}

fn walk_node(
    node: Node,
    content: &str,
    rel_path: &str,
    calls: &mut Vec<RawClientCall>,
    types: &mut Vec<(String, WireType)>,
    aliases: &mut Vec<(String, AliasDef)>,
    generics: &mut Vec<(String, GenericDecl)>,
    heritage: &mut Vec<(String, Vec<String>)>,
    unresolved_http_calls: &mut Vec<(u32, String, usize)>,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
    scope: &ScopeContext,
    wrappers: &HashMap<String, WrapperAnchor>,
    coverage: &mut HashMap<usize, WrapperCoverage>,
    depth: usize,
) {
    // Generated string concatenations can nest an expression thousands of levels deep.
    // Recursing without a bound would overflow the stack on an otherwise valid file.
    if depth > MAX_AST_DEPTH {
        return;
    }
    let mut current_scope = scope.clone();
    current_scope.apply_local_events(node.start_byte());

    match node.kind() {
        "class_declaration" | "abstract_class_declaration" => {
            let (own_fields, own_assumptions) = collect_class_fields(node, content, &current_scope);
            let (mut class_fields, mut field_assumptions) = match superclass_name(node, content) {
                Some(parent) => inherited_class_members(&parent, &current_scope.class_defs),
                None => (HashMap::new(), HashMap::new()),
            };
            class_fields.extend(own_fields);
            field_assumptions.extend(own_assumptions);
            current_scope.class_constants.extend(class_fields);
            current_scope.value_assumptions.extend(field_assumptions);
            if let Some((name, wt, bases)) = inspect_class_declaration(node, content, rel_path) {
                if !bases.is_empty() {
                    heritage.push((name.clone(), bases));
                }
                types.push((name, wt));
            }
        }
        "method_definition" | "function_declaration" | "arrow_function" | "function_expression" => {
            let events = collect_function_local_events(node, content, &current_scope);
            current_scope.local_events = Some(Rc::new(events));
            for (name, type_text) in collect_typed_parameters(node, content) {
                current_scope.typed_bindings.insert(name, type_text);
            }
            if let Some(ret_type) = extract_function_return_type(node, content) {
                current_scope.enclosing_return_type = Some(ret_type);
            }
        }
        "call_expression" => {
            let inspection = inspect_call_expression(
                node,
                content,
                rel_path,
                &current_scope,
                imports,
                http_modules,
            );
            // A call this pass cannot classify as HTTP is where a wrapper hop lives: the
            // callee is a module function, not a client. A call that looked like HTTP but
            // named no endpoint is the same case one level deeper.
            let needs_wrapper = !matches!(inspection, CallInspection::Resolved(_));
            let fanned = needs_wrapper
                && try_wrapper_fanout(
                    node,
                    content,
                    rel_path,
                    &current_scope,
                    wrappers,
                    imports,
                    http_modules,
                    calls,
                    coverage,
                );
            match inspection {
                CallInspection::Resolved(call) => calls.push(call),
                CallInspection::UnresolvedHttp {
                    http_method, line, ..
                } => {
                    if !fanned {
                        unresolved_http_calls.push((line, http_method, node.start_byte()))
                    }
                }
                CallInspection::NotHttp => {}
            }
        }
        "enum_declaration" => {
            if let Some((name, wt)) = inspect_enum_declaration(node, content, rel_path) {
                types.push((name, wt));
            }
        }
        "interface_declaration" | "type_alias_declaration" => {
            if let Some((name, wt, bases)) = inspect_type_declaration(node, content, rel_path) {
                if !bases.is_empty() {
                    heritage.push((name.clone(), bases));
                }
                types.push((name, wt));
            }
            if node.kind() == "interface_declaration" {
                if let Some((key, decl)) = collect_generic_interface(node, content, rel_path) {
                    generics.push((key, decl));
                }
            }
            if node.kind() == "type_alias_declaration" {
                if let Some((key, def)) = collect_alias_def(node, content, rel_path) {
                    aliases.push((key, def));
                }
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_node(
            child,
            content,
            rel_path,
            calls,
            types,
            aliases,
            generics,
            heritage,
            unresolved_http_calls,
            imports,
            http_modules,
            &current_scope,
            wrappers,
            coverage,
            depth + 1,
        );
    }
}

/// Deep enough for real source; far below the recursive walker's stack budget.
const MAX_AST_DEPTH: usize = 128;

enum CallInspection {
    NotHttp,
    Resolved(RawClientCall),
    /// The call is HTTP-shaped but the endpoint cannot be resolved from source. Dropping
    /// it silently would let the artifact read as though this call was never made.
    /// `endpoint_arg` is the byte range of the argument that should have carried the endpoint;
    /// a same-module wrapper needs it to tell which parameter the route is built from.
    UnresolvedHttp {
        http_method: String,
        line: u32,
        endpoint_arg: Option<(usize, usize)>,
    },
}

fn inspect_call_expression(
    node: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> CallInspection {
    let (Some(fn_node), Some(args_node)) = (
        node.child_by_field_name("function"),
        node.child_by_field_name("arguments"),
    ) else {
        return CallInspection::NotHttp;
    };

    let line = (node.start_position().row + 1) as u32;

    // A URL argument is string-like. `service.get()` and `service.delete(123)` are
    // ordinary method calls on a receiver whose name happens to look like a client.
    let Some(url_arg) = args_node.named_child(0) else {
        return CallInspection::NotHttp;
    };

    // axios-style config object: request({ url, method, data }). The method lives in the
    // object, so it cannot come from the callee's name.
    if let Some(config) = parse_config_object(url_arg, content) {
        return inspect_config_object_call(
            node,
            content,
            rel_path,
            scope,
            imports,
            http_modules,
            fn_node,
            config,
            line,
        );
    }

    if let Some(inspection) = inspect_http_resource(
        node, fn_node, args_node, content, rel_path, scope, imports, line,
    ) {
        return inspection;
    }
    if let Some(inspection) = inspect_request_object_fetch(
        node, fn_node, args_node, content, rel_path, scope, imports, line,
    ) {
        return inspection;
    }

    let (http_method, is_http_call, url_index) =
        classify_http_function(fn_node, content, args_node, rel_path, imports, http_modules);
    if !is_http_call {
        return CallInspection::NotHttp;
    }
    let Some(url_arg) = args_node.named_child(url_index as u32) else {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: None,
        };
    };

    if !route_like_argument(url_arg) {
        return CallInspection::NotHttp;
    }
    let Some((raw_url, normalized_route, base_url_assumptions)) =
        extract_route_url(url_arg, content, scope)
    else {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_arg.start_byte(), url_arg.end_byte())),
        };
    };

    if !route_is_locatable(&normalized_route)
        || (normalized_route == "/" && !base_url_assumptions.is_empty())
    {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_arg.start_byte(), url_arg.end_byte())),
        };
    }

    // Request body for mutating methods (arg 1 in .post(url, body); arg 2 when the
    // method is passed first, as in Angular's `request('POST', url, body)`).
    let body_index = if url_index == 1 { 2 } else { 1 };
    let request_body_arg = if ["POST", "PUT", "PATCH"].contains(&http_method.as_str()) {
        args_node
            .named_child(body_index)
            .map(|n| slice_node(n, content).trim().to_string())
    } else if http_method == "DELETE" {
        args_node.named_child(body_index).and_then(|options| {
            if options.kind() == "object" {
                let mut cursor = options.walk();
                for child in options.children(&mut cursor) {
                    if child.kind() == "pair" {
                        if let (Some(key_node), Some(val_node)) = (
                            child.child_by_field_name("key"),
                            child.child_by_field_name("value"),
                        ) {
                            let key = slice_node(key_node, content)
                                .trim()
                                .trim_matches(|c| c == '"' || c == '\'');
                            if key == "data" || key == "body" {
                                return Some(slice_node(val_node, content).trim().to_string());
                            }
                        }
                    } else if child.kind() == "shorthand_property_identifier"
                        || child.kind() == "shorthand_property_identifier_pattern"
                    {
                        let key = slice_node(child, content).trim();
                        if key == "data" || key == "body" {
                            return Some(key.to_string());
                        }
                    }
                }
            }
            None
        })
    } else {
        None
    };
    let non_json_response_type = non_json_response_options(args_node, content, &http_method);

    resolved_client_call(
        node,
        content,
        rel_path,
        scope,
        http_method,
        raw_url,
        normalized_route,
        base_url_assumptions,
        request_body_arg,
        non_json_response_type,
        line,
    )
}

/// Build the resolved contract record shared by every recognized client form.
#[allow(clippy::too_many_arguments)]
fn resolved_client_call(
    node: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    http_method: String,
    raw_url: String,
    normalized_route: String,
    base_url_assumptions: Vec<String>,
    request_body_arg: Option<String>,
    non_json_response_type: Option<String>,
    line: u32,
) -> CallInspection {
    // Type arguments (e.g. this.http.get<UserDto>(...) or contextual type / enclosing Promise<T>)
    let mut response_type = extract_type_argument(node, content);
    if response_type.is_none() {
        if let Some(ctx_type) = extract_contextual_type(node, content) {
            response_type = Some(ctx_type);
        } else if is_call_returned(node, content) {
            if let Some(ref enc) = scope.enclosing_return_type {
                response_type = Some(enc.clone());
            }
        }
    }

    let request_body_explicit_none = request_body_arg
        .as_deref()
        .is_some_and(|text| text == "null" || text == "undefined");
    let request_body_expr = request_body_arg.filter(|text| text != "null" && text != "undefined");
    let request_body_type = typed_request_body(&request_body_expr, scope);

    let usage_snippet = slice_node(node, content);
    let cap_len = usage_snippet.len().min(160);
    let safe_snippet = usage_snippet[..cap_len]
        .replace('\n', " ")
        .trim()
        .to_string();

    CallInspection::Resolved(RawClientCall {
        file: rel_path.to_string(),
        line,
        anchor: node.start_byte(),
        http_method,
        raw_url,
        normalized_route,
        response_type,
        non_json_response_type,
        request_body_expr,
        request_body_type,
        request_body_explicit_none,
        usage_snippet: safe_snippet,
        base_url_assumptions,
        transport_anchor: None,
        observed_response: None,
        observed_request_body: None,
    })
}

/// Angular `httpResource(...)` / `httpResource.text(...)`: the request is a function
/// whose body is a literal URL or a `{ url, method, body }` object.
#[allow(clippy::too_many_arguments)]
fn inspect_http_resource(
    node: Node,
    fn_node: Node,
    args_node: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    line: u32,
) -> Option<CallInspection> {
    let (local, resource_variant) = match fn_node.kind() {
        "identifier" => (
            slice_node(fn_node, content).trim().to_string(),
            None::<String>,
        ),
        "member_expression" => {
            let property = fn_node
                .child_by_field_name("property")
                .map(|property| slice_node(property, content).trim().to_ascii_lowercase())
                .unwrap_or_default();
            let variant = match property.as_str() {
                "text" | "blob" | "arraybuffer" | "json" => Some(property),
                _ => return None,
            };
            let object = fn_node.child_by_field_name("object")?;
            if object.kind() != "identifier" {
                return None;
            }
            (slice_node(object, content).trim().to_string(), variant)
        }
        _ => return None,
    };
    if !imports.get(&local).is_some_and(|binding| {
        binding.module == "@angular/common/http" && binding.imported == "httpResource"
    }) {
        return None;
    }

    let first = args_node.named_child(0)?;
    let request = unwrap_resource_request(first, content);

    let (http_method, url_node, request_body_arg, non_json_variant) = match request.kind() {
        "object" => match parse_config_object(request, content) {
            Some(config) => {
                if config.method_is_dynamic {
                    return Some(CallInspection::UnresolvedHttp {
                        http_method: "UNKNOWN".to_string(),
                        line,
                        endpoint_arg: None,
                    });
                }
                let Some(url_node) = config.url else {
                    return Some(CallInspection::UnresolvedHttp {
                        http_method: config.method.unwrap_or_else(|| "GET".to_string()),
                        line,
                        endpoint_arg: None,
                    });
                };
                (
                    config.method.unwrap_or_else(|| "GET".to_string()),
                    url_node,
                    config
                        .data
                        .map(|data| slice_node(data, content).trim().to_string()),
                    resource_variant.clone().or(config.non_json_response_type),
                )
            }
            None => {
                return Some(CallInspection::UnresolvedHttp {
                    http_method: "GET".to_string(),
                    line,
                    endpoint_arg: None,
                })
            }
        },
        "string" | "template_string" | "identifier" | "member_expression" | "binary_expression" => {
            ("GET".to_string(), request, None, resource_variant.clone())
        }
        _ => {
            return Some(CallInspection::UnresolvedHttp {
                http_method: "GET".to_string(),
                line,
                endpoint_arg: None,
            })
        }
    };

    let Some((raw_url, normalized_route, base_url_assumptions)) =
        extract_route_url(url_node, content, scope)
    else {
        return Some(CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        });
    };
    if !route_is_locatable(&normalized_route)
        || (normalized_route == "/" && !base_url_assumptions.is_empty())
    {
        return Some(CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        });
    }
    let request_body_arg = if ["POST", "PUT", "PATCH", "DELETE"].contains(&http_method.as_str()) {
        request_body_arg
    } else {
        None
    };
    Some(resolved_client_call(
        node,
        content,
        rel_path,
        scope,
        http_method,
        raw_url,
        normalized_route,
        base_url_assumptions,
        request_body_arg,
        non_json_variant,
        line,
    ))
}

/// Unwrap `() => ({...})`, function-expression bodies and parenthesized requests.
fn unwrap_resource_request<'a>(node: Node<'a>, content: &str) -> Node<'a> {
    let mut current = node;
    for _ in 0..8 {
        match current.kind() {
            "parenthesized_expression" => {
                let Some(inner) = current.named_child(0) else {
                    break;
                };
                current = inner;
            }
            "arrow_function" | "function_expression" => {
                let Some(body) = current.child_by_field_name("body") else {
                    break;
                };
                if body.kind() == "statement_block" {
                    // A guarded resource can contain `if (!params) return undefined;`
                    // before the real `return { url, params }`; the request-bearing
                    // return is the one that describes the call.
                    match select_resource_return(body, content) {
                        Some(returned) => current = returned,
                        None => return body,
                    }
                } else {
                    current = body;
                }
            }
            _ => break,
        }
    }
    match current.kind() {
        "parenthesized_expression" => current.named_child(0).unwrap_or(current),
        _ => current,
    }
}

fn select_resource_return<'a>(block: Node<'a>, content: &str) -> Option<Node<'a>> {
    let mut arguments = Vec::new();
    collect_return_arguments(block, &mut arguments, 0);
    if let Some(request) = arguments.iter().rev().find(|node| {
        node.kind() == "object"
            && parse_config_object(**node, content).is_some_and(|config| config.url.is_some())
    }) {
        return Some(*request);
    }
    arguments
        .iter()
        .rev()
        .find(|node| {
            let text = slice_node(**node, content).trim();
            text != "undefined"
                && text != "null"
                && matches!(
                    node.kind(),
                    "string"
                        | "template_string"
                        | "identifier"
                        | "member_expression"
                        | "binary_expression"
                )
        })
        .copied()
}

fn collect_return_arguments<'a>(node: Node<'a>, arguments: &mut Vec<Node<'a>>, depth: usize) {
    if depth > MAX_AST_DEPTH {
        return;
    }
    if node.kind() == "return_statement" {
        if let Some(argument) = node.named_child(0) {
            arguments.push(argument);
        }
        return;
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            collect_return_arguments(child, arguments, depth + 1);
        }
    }
}

/// `fetch(new Request('/x'))` and one-hop `const req = new Request('/x'); fetch(req)`.
/// `Request` is only trusted when it is the ambient/undici class, not an imported
/// application type of the same name.
#[allow(clippy::too_many_arguments)]
fn inspect_request_object_fetch(
    node: Node,
    fn_node: Node,
    args_node: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    line: u32,
) -> Option<CallInspection> {
    let is_fetch = match fn_node.kind() {
        "identifier" => slice_node(fn_node, content).trim() == "fetch",
        "member_expression" => {
            let property = fn_node
                .child_by_field_name("property")
                .map(|property| slice_node(property, content).trim())
                .unwrap_or_default();
            let object = fn_node
                .child_by_field_name("object")
                .map(|object| slice_node(object, content).trim())
                .unwrap_or_default();
            property == "fetch" && matches!(object, "window" | "globalThis" | "self")
        }
        _ => false,
    };
    if !is_fetch {
        return None;
    }
    if let Some(binding) = imports.get("Request") {
        if !matches!(
            binding.module.as_str(),
            "undici" | "node-fetch" | "cross-fetch" | "fetch"
        ) {
            return None;
        }
    }
    // A class of the same name declared in this file is the application's own
    // type, not the ambient Request.
    if scope.class_defs.contains_key("Request") {
        return None;
    }

    let first = args_node.named_child(0)?;
    let request_node = match first.kind() {
        "new_expression" | "object_creation_expression" => {
            if request_creation_type(first, content).as_deref() != Some("Request") {
                return None;
            }
            first
        }
        "identifier" => {
            let name = slice_node(first, content).trim().to_string();
            find_local_request_declaration(node, &name, content)?
        }
        _ => return None,
    };

    let arguments = request_node.child_by_field_name("arguments")?;
    let url_node = arguments.named_child(0)?;
    if request_init_method_is_dynamic(arguments, content) {
        return Some(CallInspection::UnresolvedHttp {
            http_method: "UNKNOWN".to_string(),
            line,
            endpoint_arg: None,
        });
    }
    let http_method = method_from_options(arguments, 1, content);
    let request_body_arg = if ["POST", "PUT", "PATCH", "DELETE"].contains(&http_method.as_str()) {
        request_init_body(arguments, content)
    } else {
        None
    };
    let Some((raw_url, normalized_route, base_url_assumptions)) =
        extract_route_url(url_node, content, scope)
    else {
        return Some(CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        });
    };
    if !route_is_locatable(&normalized_route)
        || (normalized_route == "/" && !base_url_assumptions.is_empty())
    {
        return Some(CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        });
    }
    Some(resolved_client_call(
        node,
        content,
        rel_path,
        scope,
        http_method,
        raw_url,
        normalized_route,
        base_url_assumptions,
        request_body_arg,
        None,
        line,
    ))
}

fn request_creation_type(node: Node, content: &str) -> Option<String> {
    let type_text = node
        .child_by_field_name("type")
        .or_else(|| node.child_by_field_name("constructor"))
        .map(|node| slice_node(node, content))
        .unwrap_or_default();
    let simple = type_text.trim().rsplit('.').next().unwrap_or("").trim();
    (!simple.is_empty()).then(|| simple.to_string())
}

/// `new Request(url, nonLiteralInit)` hides the verb; only an object literal with a
/// literal verb is trusted.
fn request_init_method_is_dynamic(arguments: Node, content: &str) -> bool {
    let Some(options) = arguments.named_child(1) else {
        return false;
    };
    if options.kind() != "object" {
        return true;
    }
    let mut cursor = options.walk();
    for pair in options.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (
            pair.child_by_field_name("key"),
            pair.child_by_field_name("value"),
        ) else {
            continue;
        };
        let key = unquote_str(slice_node(key, content));
        if key.trim() != "method" {
            continue;
        }
        if value.kind() == "string" {
            return normalize_request_verb(&unquote_str(slice_node(value, content))).is_none();
        }
        return true;
    }
    false
}

fn request_init_body(arguments: Node, content: &str) -> Option<String> {
    let options = arguments.named_child(1)?;
    if options.kind() != "object" {
        return None;
    }
    let mut cursor = options.walk();
    for pair in options.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (
            pair.child_by_field_name("key"),
            pair.child_by_field_name("value"),
        ) else {
            continue;
        };
        let key = unquote_str(slice_node(key, content));
        if key.trim() == "body" {
            return Some(slice_node(value, content).trim().to_string());
        }
    }
    None
}

fn find_local_request_declaration<'a>(
    use_node: Node<'a>,
    name: &str,
    content: &str,
) -> Option<Node<'a>> {
    let mut scope = use_node;
    while let Some(parent) = scope.parent() {
        if matches!(
            parent.kind(),
            "program"
                | "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "method_definition"
        ) {
            scope = parent;
            break;
        }
        scope = parent;
    }
    let mut candidate = None;
    find_request_declarator(
        scope,
        name,
        use_node.start_byte(),
        content,
        &mut candidate,
        0,
    );
    candidate
}

fn find_request_declarator<'a>(
    node: Node<'a>,
    name: &str,
    before: usize,
    content: &str,
    candidate: &mut Option<Node<'a>>,
    depth: usize,
) {
    if depth > MAX_AST_DEPTH {
        return;
    }
    if node.kind() == "variable_declarator" {
        if let (Some(declared), Some(value)) = (
            node.child_by_field_name("name"),
            node.child_by_field_name("value"),
        ) {
            if matches!(
                value.kind(),
                "new_expression" | "object_creation_expression"
            ) && value.start_byte() < before
                && slice_node(declared, content).trim() == name
                && request_creation_type(value, content).as_deref() == Some("Request")
                && candidate
                    .map(|existing| value.start_byte() > existing.start_byte())
                    .unwrap_or(true)
            {
                *candidate = Some(value);
            }
        }
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            find_request_declarator(child, name, before, content, candidate, depth + 1);
        }
    }
}

struct ConfigObjectCall<'a> {
    url: Option<Node<'a>>,
    method: Option<String>,
    /// A `method` property exists but is not a literal HTTP verb.
    method_is_dynamic: bool,
    data: Option<Node<'a>>,
    /// `responseType` from the same object when it is not `json` (axios semantics).
    non_json_response_type: Option<String>,
}

/// Translate one `responseType` value. `json` (the default) keeps the generic as the wire
/// body; any other literal makes the generic describe a client-derived value. A non-literal
/// value could select either lane, so it abstains rather than guessing.
fn non_json_response_type_value(value_node: Node, content: &str) -> Option<String> {
    if value_node.kind() != "string" {
        return Some("<dynamic>".to_string());
    }
    let raw = unquote_str(slice_node(value_node, content))
        .trim()
        .to_ascii_lowercase();
    if raw.is_empty() || raw == "json" {
        None
    } else {
        Some(raw)
    }
}

/// Scan the options argument of an Angular `HttpClient` call. The options position differs by
/// verb (`post(url, body, options)` vs `get(url, options)`); scanning other arguments would
/// mistake a request-body field named `responseType` for transport configuration.
fn non_json_response_options(args_node: Node, content: &str, http_method: &str) -> Option<String> {
    let options_index = if ["POST", "PUT", "PATCH"].contains(&http_method) {
        2
    } else {
        1
    };
    let options = args_node.named_child(options_index)?;
    if options.kind() != "object" {
        return None;
    }
    let mut cursor = options.walk();
    for child in options.children(&mut cursor) {
        if child.kind() != "pair" {
            continue;
        }
        let (Some(key_node), Some(value_node)) = (
            child.child_by_field_name("key"),
            child.child_by_field_name("value"),
        ) else {
            continue;
        };
        let key = slice_node(key_node, content)
            .trim()
            .trim_matches(|c| c == '"' || c == '\'');
        if key == "responseType" {
            return non_json_response_type_value(value_node, content);
        }
    }
    None
}

/// The axios config-object form: `{ url, method, data }`. Returns None unless at least a
/// url or method property is present, so ordinary options objects are left alone.
fn parse_config_object<'a>(arg: Node<'a>, content: &str) -> Option<ConfigObjectCall<'a>> {
    if arg.kind() != "object" {
        return None;
    }
    let mut config = ConfigObjectCall {
        url: None,
        method: None,
        method_is_dynamic: false,
        data: None,
        non_json_response_type: None,
    };
    let mut saw_http_key = false;
    let mut cursor = arg.walk();
    for child in arg.children(&mut cursor) {
        if child.kind() == "pair" {
            let (Some(key_node), Some(value_node)) = (
                child.child_by_field_name("key"),
                child.child_by_field_name("value"),
            ) else {
                continue;
            };
            let key_text = slice_node(key_node, content);
            let key = key_text.trim().trim_matches(|c| c == '"' || c == '\'');
            match key {
                "url" => {
                    config.url = Some(value_node);
                    saw_http_key = true;
                }
                "method" | "type" => {
                    saw_http_key = true;
                    if value_node.kind() == "string" {
                        let verb = unquote_str(slice_node(value_node, content)).to_ascii_uppercase();
                        if ["GET", "POST", "PUT", "DELETE", "PATCH"].contains(&verb.as_str()) {
                            config.method = Some(verb);
                        } else {
                            config.method_is_dynamic = true;
                        }
                    } else {
                        config.method_is_dynamic = true;
                    }
                }
                "data" | "body" => config.data = Some(value_node),
                "responseType" => {
                    config.non_json_response_type = non_json_response_type_value(value_node, content)
                }
                _ => {}
            }
        } else if child.kind() == "shorthand_property_identifier"
            || child.kind() == "shorthand_property_identifier_pattern"
        {
            let key = slice_node(child, content).trim();
            match key {
                "url" => {
                    config.url = Some(child);
                    saw_http_key = true;
                }
                "data" | "body" => {
                    config.data = Some(child);
                }
                _ => {}
            }
        }
    }
    if saw_http_key {
        Some(config)
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
fn inspect_config_object_call(
    node: Node,
    content: &str,
    rel_path: &str,
    scope: &ScopeContext,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
    fn_node: Node,
    config: ConfigObjectCall,
    line: u32,
) -> CallInspection {
    let callee_is_client =
        callee_names_http_client(fn_node, content, rel_path, imports, http_modules);
    let has_url = config.url.is_some();
    // A config object passed to a member is HTTP only when the receiver is an HTTP
    // client. Test-double APIs (`httpMock.expectOne({ method: 'GET' })`) take the same
    // shape but inspect requests instead of making them.
    let callee_can_send = match fn_node.kind() {
        "identifier" => true,
        _ => callee_is_client,
    };
    let is_http = if has_url {
        callee_can_send && (config.method.is_some() || config.method_is_dynamic || callee_is_client)
    } else {
        callee_is_client
    };
    if !is_http {
        return CallInspection::NotHttp;
    }

    let http_method = match config.method {
        Some(method) => method,
        None if config.method_is_dynamic => {
            return CallInspection::UnresolvedHttp {
                http_method: "UNKNOWN".to_string(),
                line,
                endpoint_arg: None,
            };
        }
        // axios and its wrappers default to GET when the config omits a method.
        None => "GET".to_string(),
    };

    let Some(url_node) = config.url else {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: None,
        };
    };
    let Some((raw_url, normalized_route, base_url_assumptions)) =
        extract_route_url(url_node, content, scope)
    else {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        };
    };
    if !route_is_locatable(&normalized_route)
        || (normalized_route == "/" && !base_url_assumptions.is_empty())
    {
        return CallInspection::UnresolvedHttp {
            http_method,
            line,
            endpoint_arg: Some((url_node.start_byte(), url_node.end_byte())),
        };
    }

    let mut response_type = extract_type_argument(node, content);
    if response_type.is_none() {
        if let Some(ctx_type) = extract_contextual_type(node, content) {
            response_type = Some(ctx_type);
        } else if is_call_returned(node, content) {
            if let Some(ref enc) = scope.enclosing_return_type {
                response_type = Some(enc.clone());
            }
        }
    }

    let request_body_arg = if ["POST", "PUT", "PATCH", "DELETE"].contains(&http_method.as_str()) {
        config
            .data
            .map(|n| slice_node(n, content).trim().to_string())
    } else {
        None
    };
    let request_body_explicit_none = request_body_arg
        .as_deref()
        .is_some_and(|text| text == "null" || text == "undefined");
    let request_body_expr = request_body_arg.filter(|text| text != "null" && text != "undefined");
    let request_body_type = typed_request_body(&request_body_expr, scope);

    let usage_snippet = slice_node(node, content);
    let cap_len = usage_snippet.len().min(160);
    let safe_snippet = usage_snippet[..cap_len]
        .replace('\n', " ")
        .trim()
        .to_string();

    CallInspection::Resolved(RawClientCall {
        file: rel_path.to_string(),
        line,
        anchor: node.start_byte(),
        http_method,
        raw_url,
        normalized_route,
        response_type,
        non_json_response_type: config.non_json_response_type,
        request_body_expr,
        request_body_type,
        request_body_explicit_none,
        usage_snippet: safe_snippet,
        base_url_assumptions,
        transport_anchor: None,
        observed_response: None,
        observed_request_body: None,
    })
}

/// Whether a callee is itself an HTTP client: named axios, imported from an HTTP package,
/// or imported from a module proven to contain HTTP primitives.
fn callee_names_http_client(
    fn_node: Node,
    content: &str,
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> bool {
    match fn_node.kind() {
        "identifier" => {
            let name = slice_node(fn_node, content).trim();
            names_http_client(name, rel_path, imports, http_modules)
        }
        "member_expression" => {
            let object_text = fn_node
                .child_by_field_name("object")
                .map(|object| slice_node(object, content).trim().to_string())
                .unwrap_or_default();
            let property = fn_node
                .child_by_field_name("property")
                .map(|property| slice_node(property, content).trim().to_ascii_lowercase())
                .unwrap_or_default();
            if property == "ajax" && is_jquery_receiver(&object_text) {
                return true;
            }
            // `HttpService.axiosRef` exposes the underlying axios instance; the
            // package import is the evidence that this receiver is HTTP.
            if object_text
                .trim_end_matches(['?', '!'])
                .ends_with(".axiosRef")
                && content.contains("@nestjs/axios")
            {
                return true;
            }
            match fn_node.child_by_field_name("object") {
                Some(object) => {
                    receiver_is_http_client(&object_text)
                        || receiver_binding_is_http(
                            object,
                            content,
                            rel_path,
                            imports,
                            http_modules,
                        )
                }
                None => false,
            }
        }
        _ => false,
    }
}

fn receiver_binding_is_http(
    object: Node,
    content: &str,
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> bool {
    if object.kind() != "identifier" {
        return false;
    }
    let name = slice_node(object, content)
        .trim()
        .trim_end_matches(['?', '!']);
    names_http_client(name, rel_path, imports, http_modules)
}

fn names_http_client(
    local_name: &str,
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> bool {
    if local_name == "axios" {
        return true;
    }
    let Some(binding) = imports.get(local_name) else {
        return false;
    };
    if HTTP_PACKAGES.contains(&binding.module.as_str()) {
        return true;
    }
    let Some(base) = resolve_import_module(rel_path, &binding.module) else {
        return false;
    };
    let base = strip_script_extension(&base);
    // `import … from '../api'` names a directory; TypeScript binds it to
    // `api/index.ts`, which is exactly the barrel this provenance follows.
    http_modules.contains(base) || http_modules.contains(&format!("{base}/index"))
}

fn is_call_returned(call_node: Node, content: &str) -> bool {
    let mut curr = call_node;
    while let Some(parent) = curr.parent() {
        if parent.kind() == "await_expression"
            || parent.kind() == "parenthesized_expression"
            || parent.kind() == "as_expression"
        {
            curr = parent;
            continue;
        }
        // Transparently traverse RxJS .pipe(...) calls
        if parent.kind() == "member_expression" {
            if let Some(prop) = parent.child_by_field_name("property") {
                if slice_node(prop, content).trim() == "pipe" {
                    if let Some(call_parent) = parent.parent() {
                        if call_parent.kind() == "call_expression" {
                            curr = call_parent;
                            continue;
                        }
                    }
                }
            }
        }
        if parent.kind() == "return_statement" {
            return true;
        }
        if parent.kind() == "arrow_function" {
            if let Some(body) = parent.child_by_field_name("body") {
                if body.id() == curr.id() {
                    return true;
                }
            }
        }
        if parent.kind() == "variable_declarator" {
            if let Some(name_node) = parent.child_by_field_name("name") {
                let var_name = slice_node(name_node, content).trim();
                if let Some(fn_node) = find_enclosing_function(parent) {
                    if is_var_returned_in_fn(fn_node, var_name, content) {
                        return true;
                    }
                }
            }
            return false;
        }
        if parent.kind() == "expression_statement" {
            return false;
        }
        curr = parent;
    }
    false
}

fn find_enclosing_function(mut node: Node) -> Option<Node> {
    while let Some(parent) = node.parent() {
        match parent.kind() {
            "function_declaration"
            | "method_definition"
            | "arrow_function"
            | "function_expression" => return Some(parent),
            _ => {
                node = parent;
            }
        }
    }
    None
}

fn is_var_returned_in_fn(fn_node: Node, var_name: &str, content: &str) -> bool {
    let Some(body) = fn_node.child_by_field_name("body") else {
        return false;
    };
    let count = body.child_count();
    for i in 0..count {
        if let Some(child) = body.child(i as u32) {
            if check_return_references_var(child, var_name, content) {
                return true;
            }
        }
    }
    false
}

fn check_return_references_var(node: Node, var_name: &str, content: &str) -> bool {
    if node.kind() == "return_statement" {
        let text = slice_node(node, content);
        let tokens: Vec<&str> = text
            .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
            .collect();
        return tokens.contains(&var_name);
    }
    let count = node.child_count();
    for i in 0..count {
        if let Some(child) = node.child(i as u32) {
            if check_return_references_var(child, var_name, content) {
                return true;
            }
        }
    }
    false
}

fn classify_http_function(
    fn_node: Node,
    content: &str,
    args_node: Node,
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    http_modules: &HashSet<String>,
) -> (String, bool, usize) {
    let mut target_node = fn_node;
    while target_node.kind() == "await_expression"
        || target_node.kind() == "parenthesized_expression"
    {
        if let Some(inner) = target_node
            .child_by_field_name("expression")
            .or_else(|| target_node.named_child(0))
        {
            target_node = inner;
        } else {
            break;
        }
    }
    let fn_text = slice_node(target_node, content);

    // 1. Angular / Axios / Fetch member calls: this.http.get, http.post, axios.delete, api.get
    if target_node.kind() == "member_expression" {
        if let (Some(object), Some(prop_node)) = (
            target_node.child_by_field_name("object"),
            target_node.child_by_field_name("property"),
        ) {
            let prop = slice_node(prop_node, content).trim().to_ascii_lowercase();
            let object_text = slice_node(object, content).trim();

            if is_jquery_receiver(object_text) {
                let jquery_method = match prop.as_str() {
                    "get" | "getjson" => Some("GET"),
                    "post" => Some("POST"),
                    "put" => Some("PUT"),
                    "delete" => Some("DELETE"),
                    "patch" => Some("PATCH"),
                    "head" => Some("HEAD"),
                    "options" => Some("OPTIONS"),
                    _ => None,
                };
                if let Some(method) = jquery_method {
                    return (method.to_string(), true, 0);
                }
            }

            if prop == "fetch" && matches!(object_text, "window" | "globalThis" | "self") {
                return (method_from_options(args_node, 1, content), true, 0);
            }

            if prop == "sendbeacon"
                && object_text
                    .trim_end_matches(['?', '!'])
                    .ends_with("navigator")
            {
                return ("POST".to_string(), true, 0);
            }

            // XMLHttpRequest.open('GET', url): the transport is created by `new
            // XMLHttpRequest()` elsewhere in the file; the receiver name must say so.
            if prop == "open" && content.contains("XMLHttpRequest") {
                let receiver = object_text
                    .trim_end_matches(['?', '!'])
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if receiver.contains("xhr")
                    || receiver.contains("request")
                    || receiver.contains("http")
                    || receiver.contains("client")
                {
                    if let Some(first) = args_node.named_child(0) {
                        if let Some(verb) =
                            normalize_request_verb(&unquote_str(slice_node(first, content)))
                        {
                            if args_node.named_child(1).is_some() {
                                return (verb, true, 1);
                            }
                        }
                    }
                }
            }

            let receiver_is_client = receiver_is_http_client(object_text)
                || receiver_binding_is_http(
                    object,
                    content,
                    rel_path,
                    imports,
                    http_modules,
                )
                // `HttpService.axiosRef` exposes the underlying axios instance;
                // the package import is the evidence that this receiver is HTTP.
                || (object_text
                    .trim_end_matches(['?', '!'])
                    .ends_with(".axiosRef")
                    && content.contains("@nestjs/axios"));

            // `request` is both a verb carrier (`http.request('POST', url, body)`)
            // and a transport call (`axios.request(url, { method })`).
            if prop == "request" && receiver_is_client {
                if let Some(first) = args_node.named_child(0) {
                    let first_text = unquote_str(slice_node(first, content));
                    if let Some(verb) = normalize_request_verb(&first_text) {
                        if args_node.named_child(1).is_some() {
                            return (verb, true, 1);
                        }
                    }
                }
                return (method_from_options(args_node, 1, content), true, 0);
            }

            let method = match prop.as_str() {
                "get" => Some("GET"),
                "post" => Some("POST"),
                "put" => Some("PUT"),
                "delete" => Some("DELETE"),
                // superagent spells DELETE as `del`, and a call that drops the verb's last
                // two letters still deletes.
                "del" => Some("DELETE"),
                "patch" => Some("PATCH"),
                "head" => Some("HEAD"),
                "options" => Some("OPTIONS"),
                _ => None,
            };
            if let Some(m) = method {
                if receiver_is_client {
                    return (m.to_string(), true, 0);
                }
            }
        }
    }

    if target_node.kind() == "identifier" {
        let name = fn_text.trim();

        // 2. Standalone fetch(url, options), including `window.fetch` aliases and
        // `fetch` re-exported by node-fetch/cross-fetch.
        if name == "fetch" || imports.get(name).is_some_and(|b| b.module == "fetch") {
            return (method_from_options(args_node, 1, content), true, 0);
        }

        // Nuxt/SWR wrappers take the route as their first literal argument.
        if name == "$fetch"
            || matches!(
                name,
                "useFetch" | "useLazyFetch" | "useSWR" | "useSWRImmutable" | "useSWRMutation"
            )
        {
            let imported_from_wrapper = imports.get(name).is_some_and(|binding| {
                matches!(
                    binding.module.as_str(),
                    "ofetch"
                        | "#app"
                        | "nuxt"
                        | "nuxt/app"
                        | "swr"
                        | "swr/immutable"
                        | "swr/mutation"
                )
            });
            if name == "$fetch" || imported_from_wrapper {
                let method = if matches!(name, "useSWR" | "useSWRImmutable") {
                    "GET".to_string()
                } else if name == "useSWRMutation" {
                    "POST".to_string()
                } else {
                    method_from_options(args_node, 1, content)
                };
                return (method, true, 0);
            }
        }

        // A destructured client verb (`const { get } = axios`) keeps its verb.
        if let Some(verb) = normalize_request_verb(name) {
            if names_http_client(name, rel_path, imports, http_modules) {
                return (verb, true, 0);
            }
        }

        // 3. Direct-call clients: axios('/x'), got('/x'), ky('/x'), ofetch('/x').
        // Membership in an HTTP-bearing *module* is not enough here: a barrel can export
        // ordinary helpers (`isDefined`) beside a client, and calling one is not HTTP.
        let direct_client = name == "axios"
            || imports.get(name).is_some_and(|binding| {
                HTTP_PACKAGES.contains(&binding.module.as_str()) || binding.module == "fetch"
            });
        if direct_client && names_http_client(name, rel_path, imports, http_modules) {
            return (method_from_options(args_node, 1, content), true, 0);
        }
    }

    ("GET".to_string(), false, 0)
}

fn is_jquery_receiver(object_text: &str) -> bool {
    let receiver = object_text
        .trim()
        .trim_end_matches(['?', '!'])
        .rsplit('.')
        .next()
        .unwrap_or("");
    matches!(receiver, "$" | "jQuery")
}

fn normalize_request_verb(raw: &str) -> Option<String> {
    let verb = raw.trim().to_ascii_uppercase();
    matches!(
        verb.as_str(),
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
    )
    .then_some(verb)
}

/// The literal `method`/`type` in a request options object, defaulting to GET.
fn method_from_options(args_node: Node, index: usize, content: &str) -> String {
    let Some(options) = args_node.named_child(index as u32) else {
        return "GET".to_string();
    };
    if options.kind() != "object" {
        return "GET".to_string();
    }
    let mut cursor = options.walk();
    for pair in options.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (
            pair.child_by_field_name("key"),
            pair.child_by_field_name("value"),
        ) else {
            continue;
        };
        let key = unquote_str(slice_node(key, content));
        if key != "method" && key != "type" {
            continue;
        }
        if value.kind() == "string" {
            if let Some(verb) = normalize_request_verb(&unquote_str(slice_node(value, content))) {
                return verb;
            }
        }
    }
    "GET".to_string()
}

/// Whether a method receiver names an HTTP client. Angular's `FormGroup`, `Map`,
/// `URLSearchParams` and similar classes also expose `.get(...)`, so a substring test over
/// the whole call expression is not enough — the receiver's own words must identify it.
fn receiver_is_http_client(object_text: &str) -> bool {
    let receiver = object_text
        .trim()
        .trim_end_matches(['?', '!'])
        .rsplit('.')
        .next()
        .unwrap_or("")
        .trim();
    if receiver.is_empty() {
        return false;
    }
    let words: Vec<String> = split_identifier_words(receiver)
        .into_iter()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    match words.as_slice() {
        [w] => matches!(
            w.as_str(),
            "http"
                | "httpclient"
                | "httpservice"
                | "apiclient"
                | "apiservice"
                | "axios"
                | "api"
                | "client"
                | "service"
                | "rest"
                | "restclient"
        ),
        [.., a, b] => matches!(
            (a.as_str(), b.as_str()),
            ("http", "client") | ("api", "client") | ("http", "service") | ("api", "service")
        ),
        _ => false,
    }
}

fn split_identifier_words(ident: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in ident.chars() {
        if !ch.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        if ch.is_uppercase() && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn route_like_argument(node: Node) -> bool {
    match node.kind() {
        "string" | "template_string" | "binary_expression" | "identifier" | "member_expression" => {
            true
        }
        "parenthesized_expression" => node
            .named_child(0)
            .map(route_like_argument)
            .unwrap_or(false),
        _ => false,
    }
}

/// A route made only of placeholders (`/:param`) points at no specific endpoint: the
/// whole path came from a variable. Publishing it would fabricate a root endpoint and let
/// a consumer link to every route that happens to start at the root. A literal root (`/`)
/// or any static segment is locatable.
///
/// A placeholder that shares a segment with literal text (`/api:param`, from
/// `` `${base}${path}` `` where the base does not end in a slash) is the same failure in a
/// different shape. A path variable stands for one whole segment on both sides of the pair,
/// so no producer mapping can be matched against a segment whose text is partly unknown.
fn route_is_locatable(route: &str) -> bool {
    if route.starts_with("http") {
        return true;
    }
    if !route.starts_with('/') {
        return false;
    }
    let path = route.split(['?', '#']).next().unwrap_or(route);
    let mut locatable = path == "/";
    for segment in path.split('/').filter(|seg| !seg.is_empty()) {
        if segment.contains(":param") {
            if segment != ":param" {
                return false;
            }
        } else {
            locatable = true;
        }
    }
    locatable
}

fn extract_route_url(
    node: Node,
    content: &str,
    scope: &ScopeContext,
) -> Option<(String, String, Vec<String>)> {
    match node.kind() {
        "string" => {
            let raw = slice_node(node, content);
            let unquoted = unquote_str(raw);
            Some((unquoted.clone(), normalize_url_path(&unquoted), Vec::new()))
        }
        "template_string" => {
            let raw = slice_node(node, content);
            let unquoted = raw.trim_matches('`');
            let mut assumptions = Vec::new();
            let normalized = normalize_template_url(node, content, scope, &mut assumptions);
            Some((unquoted.to_string(), normalized, assumptions))
        }
        "binary_expression" => {
            let raw = slice_node(node, content);
            let mut buf = String::new();
            let mut assumptions = Vec::new();
            if flatten_binary_url(node, content, &mut buf, scope, &mut assumptions)
                && !buf.is_empty()
            {
                settle_leading_prefix(&mut buf, &mut assumptions);
                Some((raw.to_string(), normalize_url_path(&buf), assumptions))
            } else {
                None
            }
        }
        "identifier" => {
            let ident = slice_node(node, content).trim();
            scope.lookup(ident).map(|val| {
                (
                    val.clone(),
                    normalize_url_path(val),
                    scope.assumptions_for(ident).to_vec(),
                )
            })
        }
        "member_expression" => {
            let expr = slice_node(node, content).trim();
            scope.lookup(expr).map(|val| {
                (
                    val.clone(),
                    normalize_url_path(val),
                    scope.assumptions_for(expr).to_vec(),
                )
            })
        }
        // `(this.entityUrl + '/' + id)` is the same expression as without parens.
        "parenthesized_expression" => node
            .named_child(0)
            .and_then(|inner| extract_route_url(inner, content, scope)),
        _ => None,
    }
}

fn flatten_binary_url(
    node: Node,
    content: &str,
    buf: &mut String,
    scope: &ScopeContext,
    assumptions: &mut Vec<String>,
) -> bool {
    match node.kind() {
        "binary_expression" => {
            let left = match node.child_by_field_name("left") {
                Some(l) => l,
                None => return false,
            };
            let right = match node.child_by_field_name("right") {
                Some(r) => r,
                None => return false,
            };
            let left_ok = flatten_binary_url(left, content, buf, scope, assumptions);
            let right_ok = flatten_binary_url(right, content, buf, scope, assumptions);
            left_ok && right_ok
        }
        "string" => {
            let unquoted = unquote_str(slice_node(node, content));
            buf.push_str(&unquoted);
            true
        }
        "template_string" => {
            let norm = normalize_template_url(node, content, scope, assumptions);
            buf.push_str(&norm);
            true
        }
        "identifier" => {
            let ident = slice_node(node, content).trim();
            match scope.lookup(ident) {
                Some(val) => {
                    buf.push_str(val);
                    assumptions.extend(scope.assumptions_for(ident).iter().cloned());
                }
                None => push_unresolved_url_part(ident, buf, assumptions),
            }
            true
        }
        "member_expression" => {
            let expr = slice_node(node, content).trim();
            match scope.lookup(expr) {
                Some(val) => {
                    buf.push_str(val);
                    assumptions.extend(scope.assumptions_for(expr).iter().cloned());
                }
                None => push_unresolved_url_part(expr, buf, assumptions),
            }
            true
        }
        _ => {
            push_unresolved_url_part(slice_node(node, content).trim(), buf, assumptions);
            true
        }
    }
}

fn push_unresolved_url_part(expr: &str, buf: &mut String, assumptions: &mut Vec<String>) {
    if is_query_continuation(expr, buf) {
        return;
    }
    // Before any path text, an unresolved interpolation can only be an authority or
    // base-URL prefix: `\`${serverApiUrl}api/account\`` is `/api/account` whatever the
    // variable holds, so the value is not a route segment. Dropping it is recorded on the
    // contract instead of being left to look like a path parameter.
    if buf.trim().is_empty() {
        assumptions.push(expr.trim().to_string());
        return;
    }
    buf.push_str(":param");
}

/// A leading prefix may only be dropped when a literal path segment survives it. Routes
/// like `${this.resourceUrl}/${id}` learn nothing from the drop — the prefix carried the
/// path — so the parameter form is restored instead of fabricating a one-segment route.
fn settle_leading_prefix(buf: &mut String, assumptions: &mut Vec<String>) {
    if assumptions.is_empty() {
        return;
    }
    let without_query = buf.split(['?', '&']).next().unwrap_or(buf);
    if !has_literal_url_segment(without_query) {
        buf.clear();
        buf.push_str(":param");
        assumptions.clear();
    }
}

fn has_literal_url_segment(route: &str) -> bool {
    route.split('/').any(|segment| {
        let segment = segment.trim();
        !segment.is_empty() && segment != ":param" && segment.chars().any(|c| c.is_alphanumeric())
    })
}

/// Method names that only exist to produce a query string.
const QUERY_BUILDER_MARKERS: [&str; 4] = ["toQuery", "URLSearchParams", "stringify", "join('&')"];

/// Variable names used by the common "accumulate the query string, then interpolate it"
/// idiom. Only consulted for a substitution that is glued inside a path segment, so a
/// path variable that merely happens to be named `query` still becomes a parameter.
const QUERY_VARIABLE_MARKERS: [&str; 4] = ["query", "Query", "params", "Params"];

fn is_query_builder_expression(inner: &str) -> bool {
    QUERY_BUILDER_MARKERS
        .iter()
        .any(|marker| inner.contains(marker))
}

/// Decide whether an unresolved interpolation contributes a path segment.
///
/// A substitution that opens a segment (text before it ends at `/`, or the template
/// starts here) is a path parameter unless it names a query-string builder. A
/// substitution glued inside a segment needs independent evidence — an already open
/// query string, a ternary/`&` in the expression, or a query-accumulator variable —
/// before it is dropped. Dropping on a bare name match used to fabricate shorter
/// routes (`/api/search/${query}` became `/search`); keeping glued text unconditionally
/// fabricated a mangled segment (`/api/schedulerEvents${...}` became `schedulerEvents:param`).
fn is_query_continuation(inner: &str, accumulated: &str) -> bool {
    if is_query_builder_expression(inner) {
        return true;
    }
    let opens_segment = accumulated.is_empty() || accumulated.ends_with('/');
    if opens_segment {
        return false;
    }
    accumulated.contains('?')
        || accumulated.contains('&')
        || accumulated.contains('=')
        || inner.contains('?')
        || inner.contains('&')
        || QUERY_VARIABLE_MARKERS
            .iter()
            .any(|marker| inner.contains(marker))
}

fn normalize_template_url(
    node: Node,
    content: &str,
    scope: &ScopeContext,
    assumptions: &mut Vec<String>,
) -> String {
    let mut result = String::new();
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        match child.kind() {
            "string_fragment" => {
                result.push_str(slice_node(child, content));
            }
            "template_substitution" => {
                let expr_text = slice_node(child, content);
                let inner = expr_text
                    .trim_start_matches("${")
                    .trim_end_matches('}')
                    .trim();

                // 1. Check scope lookup (e.g. this.baseUrl or IMAGES_URL_PREFIX)
                if let Some(val) = scope.lookup(inner) {
                    result.push_str(val);
                    assumptions.extend(scope.assumptions_for(inner).iter().cloned());
                } else if is_query_continuation(inner, &result) {
                    // Query string generation; normalize_url_path keeps the path only.
                } else if result.trim().is_empty() {
                    // Leading interpolation: an authority/base-URL prefix, not a segment.
                    assumptions.push(inner.to_string());
                } else {
                    result.push_str(":param");
                }
            }
            _ => {}
        }
    }

    settle_leading_prefix(&mut result, assumptions);
    normalize_url_path(&result)
}

fn normalize_url_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let path = if let Some(idx) = trimmed.find("://") {
        let after_scheme = &trimmed[idx + 3..];
        if let Some(slash_idx) = after_scheme.find('/') {
            &after_scheme[slash_idx..]
        } else {
            "/"
        }
    } else {
        trimmed
    };

    let without_query = path.split('?').next().unwrap_or(path);
    let without_amp = without_query.split('&').next().unwrap_or(without_query);

    let mut cleaned = without_amp.trim().to_string();
    if !cleaned.starts_with('/') {
        cleaned.insert(0, '/');
    }
    // Collapse multiple consecutive slashes
    while cleaned.contains("//") {
        cleaned = cleaned.replace("//", "/");
    }
    // Collapse consecutive parameter tokens in the same path segment (e.g. :param:param -> :param)
    while cleaned.contains(":param:param") {
        cleaned = cleaned.replace(":param:param", ":param");
    }
    if cleaned.len() > 1 && cleaned.ends_with('/') {
        cleaned.pop();
    }
    cleaned
}

fn extract_type_argument(call_node: Node, content: &str) -> Option<String> {
    let mut cursor = call_node.walk();
    for child in call_node.children(&mut cursor) {
        if child.kind() == "type_arguments" {
            if let Some(first_type) = child.named_child(0) {
                let type_text = slice_node(first_type, content).trim();
                if !type_text.is_empty() && type_text != "any" && type_text != "unknown" {
                    return Some(type_text.to_string());
                }
            }
        }
    }
    None
}

fn extract_contextual_type(call_node: Node, content: &str) -> Option<String> {
    let mut curr = call_node;
    while let Some(parent) = curr.parent() {
        if parent.kind() == "parenthesized_expression" || parent.kind() == "await_expression" {
            curr = parent;
            continue;
        }
        if parent.kind() == "as_expression" {
            let type_node = parent.child_by_field_name("type").or_else(|| {
                let n = parent.named_child_count();
                if n >= 2 {
                    parent.named_child((n - 1) as u32)
                } else {
                    None
                }
            });
            if let Some(type_node) = type_node {
                let raw = slice_node(type_node, content).trim();
                let clean = raw.strip_prefix(':').unwrap_or(raw).trim();
                if !clean.is_empty() && !matches!(clean, "any" | "unknown") {
                    if let Some(unwrapped) = unwrap_async_wrapper(clean) {
                        return Some(unwrapped);
                    }
                    return Some(clean.to_string());
                }
            }
            curr = parent;
            continue;
        }
        if parent.kind() == "variable_declarator" {
            if let Some(type_node) = parent.child_by_field_name("type") {
                let raw = slice_node(type_node, content).trim();
                let clean = raw.strip_prefix(':').unwrap_or(raw).trim();
                if !clean.is_empty() && !matches!(clean, "any" | "unknown") {
                    if let Some(unwrapped) = unwrap_async_wrapper(clean) {
                        return Some(unwrapped);
                    }
                    return Some(clean.to_string());
                }
            }
            break;
        }
        if parent.kind() == "member_expression" {
            if let Some(prop) = parent.child_by_field_name("property") {
                let prop_name = slice_node(prop, content).trim();
                if prop_name == "then" || prop_name == "subscribe" {
                    if let Some(call_parent) = parent.parent() {
                        if call_parent.kind() == "call_expression" {
                            if let Some(args) = call_parent.child_by_field_name("arguments") {
                                if let Some(cb) = args.named_child(0) {
                                    if matches!(cb.kind(), "arrow_function" | "function_expression" | "function") {
                                        if let Some(params) = cb.child_by_field_name("parameters") {
                                            if let Some(first_param) = params.named_child(0) {
                                                if let Some(type_node) = first_param.child_by_field_name("type") {
                                                    let raw = slice_node(type_node, content).trim();
                                                    let clean = raw.strip_prefix(':').unwrap_or(raw).trim();
                                                    if !clean.is_empty() && !matches!(clean, "any" | "unknown") {
                                                        if let Some(unwrapped) = unwrap_async_wrapper(clean) {
                                                            return Some(unwrapped);
                                                        }
                                                        return Some(clean.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if prop_name == "pipe" {
                    if let Some(call_parent) = parent.parent() {
                        if call_parent.kind() == "call_expression" {
                            curr = call_parent;
                            continue;
                        }
                    }
                }
            }
        }
        break;
    }
    None
}

fn is_valid_type_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn parse_type_str_to_wire(type_str: &str, rel_path: &str, line: u32) -> WireType {
    let trimmed = strip_outer_parens(type_str.trim());
    if let Some(parts) = top_level_union_parts(trimmed) {
        return parse_union_type_str(&parts, rel_path, line);
    }
    if trimmed == "string" {
        return WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: None,
            provenance: None,
        });
    }
    if trimmed == "number" {
        return WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Number,
            format: None,
            provenance: None,
        });
    }
    if trimmed == "boolean" {
        return WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Boolean,
            format: None,
            provenance: None,
        });
    }
    if trimmed == "void" || trimmed == "null" || trimmed == "undefined" {
        return WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Void,
            format: None,
            provenance: None,
        });
    }
    if trimmed.ends_with("[]") {
        let inner = &trimmed[..trimmed.len() - 2];
        return WireType::Array(ArrayWireType {
            element_type: Box::new(parse_type_str_to_wire(inner, rel_path, line)),
            is_stream_or_flux: None,
            provenance: None,
        });
    }
    if trimmed.starts_with("Array<") && trimmed.ends_with('>') {
        let inner = &trimmed[6..trimmed.len() - 1];
        return WireType::Array(ArrayWireType {
            element_type: Box::new(parse_type_str_to_wire(inner, rel_path, line)),
            is_stream_or_flux: None,
            provenance: None,
        });
    }

    // Only valid single identifiers (e.g. LowStock, OrderSummary) are candidates for Ref.
    // Non-identifiers (e.g. `string | number`, `() => void`, `"on" | "off"`, `Record<string, unknown>`,
    // inline object literals `{...}`) must degrade to Unknown so expand_type_pool never hard-fails.
    if is_valid_type_identifier(trimmed)
        && !["any", "unknown", "never", "object", "Function", "Record"].contains(&trimmed)
    {
        WireType::Ref(RefWireType {
            r#ref: format!("ts:{}#{}", rel_path, trimmed),
            provenance: Some(SourceProvenance {
                sha256: None,
                language: SourceLanguage::TypeScript,
                file: rel_path.to_string(),
                line,
                column: None,
                ast_identity: Some(trimmed.to_string()),
                annotation_or_schema: None,
                evidence_classification: None,
            }),
        })
    } else {
        WireType::Unknown(UnknownWireType {
            reason: format!(
                "Non-identifier or unresolvable type expression: {}",
                trimmed
            ),
            provenance: Some(SourceProvenance {
                sha256: None,
                language: SourceLanguage::TypeScript,
                file: rel_path.to_string(),
                line,
                column: None,
                ast_identity: Some(trimmed.to_string()),
                annotation_or_schema: None,
                evidence_classification: None,
            }),
        })
    }
}

/// A union is modelled where its JSON meaning is exact: `null`/`undefined`
/// peel off as nullability/optionality, an all-string-literal union is a
/// closed set of values, and any other union whose every arm has a wire shape
/// stays a union. An arm this pass cannot model abstains for the whole union,
/// because dropping one arm would narrow the value set the consumer accepts.
fn parse_union_type_str(parts: &[&str], rel_path: &str, line: u32) -> WireType {
    let mut nullable = false;
    let mut optional = false;
    let mut members: Vec<&str> = Vec::new();
    for part in parts {
        match *part {
            "null" => nullable = true,
            "undefined" => optional = true,
            other => members.push(other),
        }
    }

    let base = if members.is_empty() {
        WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Void,
            format: None,
            provenance: None,
        })
    } else if let Some(values) = members
        .iter()
        .map(|member| string_literal_value(member))
        .collect::<Option<Vec<String>>>()
    {
        enum_from_values(values, rel_path, line)
    } else if members.len() == 1 {
        parse_type_str_to_wire(members[0], rel_path, line)
    } else {
        let mut types = Vec::new();
        for member in &members {
            let member_wire = parse_type_str_to_wire(member.trim(), rel_path, line);
            if matches!(member_wire, WireType::Unknown(_)) {
                return unknown_type(
                    format!(
                        "Union arm `{}` is not resolvable, so the union stays unresolved: {}",
                        member.trim(),
                        members.join(" | ")
                    ),
                    rel_path,
                    line,
                );
            }
            types.push(member_wire);
        }
        WireType::Union(UnionWireType {
            types,
            provenance: Some(ts_provenance(rel_path, line, Some(members.join(" | ")))),
        })
    };

    wrap_nullish(base, nullable, optional, rel_path, line)
}

fn wrap_nullish(
    base: WireType,
    nullable: bool,
    optional: bool,
    rel_path: &str,
    line: u32,
) -> WireType {
    let mut wrapped = base;
    if nullable {
        wrapped = WireType::Nullable(NullableWireType {
            inner_type: Box::new(wrapped),
            provenance: Some(ts_provenance(rel_path, line, None)),
        });
    }
    if optional {
        wrapped = WireType::Optional(OptionalWireType {
            inner_type: Box::new(wrapped),
            provenance: Some(ts_provenance(rel_path, line, None)),
        });
    }
    wrapped
}

fn enum_from_values(values: Vec<String>, rel_path: &str, line: u32) -> WireType {
    let mut unique: Vec<serde_json::Value> = Vec::new();
    for value in values {
        let value = serde_json::Value::String(value);
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    WireType::Enum(EnumWireType {
        name: None,
        values: unique,
        provenance: Some(ts_provenance(rel_path, line, None)),
    })
}

/// An extracted ENUM is a closed set of accepted literals, so every member whose value the
/// compiler computes (`1 << 0`, `Other.Q`, a call) has to abstain for the whole declaration:
/// reporting the source text as a value would reject the numbers the server really sends.
/// A member with no initializer is numeric however its name is quoted (`enum E { 'A' }` is
/// `A = 0`), which is TypeScript's own numbering, not a guess about a repository.
fn inspect_enum_declaration(
    node: Node,
    content: &str,
    rel_path: &str,
) -> Option<(String, WireType)> {
    let name_node = node.child_by_field_name("name")?;
    let enum_name = slice_node(name_node, content).trim().to_string();
    if enum_name.is_empty() {
        return None;
    }
    let body = node.child_by_field_name("body")?;
    let line = (node.start_position().row + 1) as u32;
    let key = format!("ts:{}#{}", rel_path, enum_name);

    let mut values: Vec<serde_json::Value> = Vec::new();
    let mut cursor = body.walk();
    let mut next_auto = 0i64;
    for member in body.children(&mut cursor) {
        if !member.is_named() || member.kind().contains("comment") {
            continue;
        }
        let Some(value_node) = member.child_by_field_name("value") else {
            let name = slice_node(member, content).trim().to_string();
            if !is_plain_enum_member_name(&name) {
                return Some((
                    key,
                    unknown_type(
                        format!(
                            "Enum member `{enum_name}.{name}` is not written as a plain name, so its value cannot be enumerated"
                        ),
                        rel_path,
                        line,
                    ),
                ));
            }
            values.push(serde_json::Value::Number(next_auto.into()));
            next_auto += 1;
            continue;
        };
        let text = slice_node(value_node, content).trim().to_string();
        if let Some(literal) = string_literal_value(&text) {
            values.push(serde_json::Value::String(literal));
        } else if let Some(literal) = template_literal_value(&text) {
            values.push(serde_json::Value::String(literal));
        } else if let Ok(number) = text.parse::<i64>() {
            values.push(serde_json::Value::Number(number.into()));
            next_auto = number + 1;
        } else {
            return Some((
                key,
                unknown_type(
                    format!(
                        "Enum member `{enum_name}` has a value that is not a string or integer literal (`{text}`), so its accepted literals cannot be enumerated statically"
                    ),
                    rel_path,
                    line,
                ),
            ));
        }
    }
    if values.is_empty() {
        return Some((
            key,
            unknown_type(
                format!(
                    "Enum `{enum_name}` declares no members, so no response value can be matched against it"
                ),
                rel_path,
                line,
            ),
        ));
    }
    Some((
        key,
        WireType::Enum(contract_core::ir::EnumWireType {
            name: Some(enum_name.clone()),
            values,
            provenance: Some(ts_provenance(rel_path, line, Some(enum_name))),
        }),
    ))
}

/// A member name is either a bare identifier or a quoted string; both are plain names in TypeScript.
fn is_plain_enum_member_name(text: &str) -> bool {
    if string_literal_value(text).is_some() {
        return true;
    }
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.is_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// A template literal with no substitution is a constant, so TypeScript accepts it as an enum
/// value and its wire form is the text between the backticks.
fn template_literal_value(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('`') || !trimmed.ends_with('`') {
        return None;
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    if inner.contains("${") || inner.contains('`') {
        return None;
    }
    Some(unescape_ts_string(inner))
}

fn string_literal_value(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let quote = trimmed.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    if trimmed.len() < 2 || !trimmed.ends_with(quote) {
        return None;
    }
    Some(unescape_ts_string(&trimmed[1..trimmed.len() - 1]))
}

fn unescape_ts_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Split on `|` only at the top level, so `Array<A | null>` and `'a|b' | 'c'`
/// are not torn apart.
fn top_level_union_parts(text: &str) -> Option<Vec<&str>> {
    let mut parts: Vec<&str> = Vec::new();
    let mut angle = 0i32;
    let mut brace = 0i32;
    let mut bracket = 0i32;
    let mut paren = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, c) in text.char_indices() {
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == active {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '<' => angle += 1,
            '>' => angle = (angle - 1).max(0),
            '{' => brace += 1,
            '}' => brace = (brace - 1).max(0),
            '[' => bracket += 1,
            ']' => bracket = (bracket - 1).max(0),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            '|' if angle == 0 && brace == 0 && bracket == 0 && paren == 0 => {
                parts.push(text[start..i].trim());
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return None;
    }
    parts.push(text[start..].trim());
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

fn strip_outer_parens(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim();
        if !(trimmed.starts_with('(') && trimmed.ends_with(')')) {
            return trimmed;
        }
        let mut depth = 0i32;
        let mut closes_at_end = true;
        for (i, c) in trimmed.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 && i + c.len_utf8() != trimmed.len() {
                        closes_at_end = false;
                        break;
                    }
                }
                _ => {}
            }
        }
        if !closes_at_end || depth != 0 {
            return trimmed;
        }
        text = &trimmed[1..trimmed.len() - 1];
    }
}

/// Property-level unions carry nullability/optionality on the property, matching how
/// the Java side records them; nested wrappers (e.g. array elements) stay nested.
fn peel_nullish_wrappers(mut wire: WireType) -> (WireType, bool, bool) {
    let mut nullable = false;
    let mut optional = false;
    loop {
        match wire {
            WireType::Nullable(n) => {
                nullable = true;
                wire = *n.inner_type;
            }
            WireType::Optional(o) => {
                optional = true;
                wire = *o.inner_type;
            }
            _ => break,
        }
    }
    (wire, nullable, optional)
}

/// Repo-relative path a module specifier points at. Relative specifiers are resolved
/// against the importing file; bare specifiers are treated as repo-root-relative, which
/// covers tsconfig `baseUrl` imports. Package imports simply miss and fall back.
pub(crate) fn resolve_import_module(rel_path: &str, module: &str) -> Option<String> {
    let module = module.trim();
    if module.is_empty() {
        return None;
    }
    let dir = rel_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let joined = if let Some(rest) = module.strip_prefix("./") {
        if dir.is_empty() {
            rest.to_string()
        } else {
            format!("{}/{}", dir, rest)
        }
    } else if module.starts_with("../") {
        let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
        let mut rest = module;
        while let Some(stripped) = rest.strip_prefix("../") {
            parts.pop();
            rest = stripped;
        }
        let mut out = parts.join("/");
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(rest);
        out
    } else {
        module.trim_start_matches('/').to_string()
    };
    Some(joined)
}

pub(crate) fn strip_script_extension(path: &str) -> &str {
    for ext in [
        ".d.ts", ".d.mts", ".d.cts", ".tsx", ".ts", ".jsx", ".js", ".mts", ".cts", ".mjs", ".cjs",
    ] {
        if let Some(stripped) = path.strip_suffix(ext) {
            return stripped;
        }
    }
    path
}

/// Candidate pool keys for a type name bound by an import, best first.
fn import_candidate_refs(
    type_name: &str,
    rel_path: &str,
    imports: &HashMap<String, ImportBinding>,
    export_maps: Option<&BTreeMap<String, HashMap<String, ExportBinding>>>,
) -> Vec<String> {
    let Some(binding) = imports.get(type_name) else {
        return Vec::new();
    };
    let Some(base) = resolve_import_module(rel_path, &binding.module) else {
        return Vec::new();
    };
    let base = strip_script_extension(&base);
    let mut out = Vec::new();
    let mut visited = HashSet::new();

    collect_import_candidates_recursive(
        &base,
        &binding.imported,
        export_maps,
        &mut out,
        &mut visited,
        0,
    );

    if binding.imported != type_name {
        collect_import_candidates_recursive(
            &base,
            type_name,
            export_maps,
            &mut out,
            &mut visited,
            0,
        );
    }

    out
}

fn collect_import_candidates_recursive(
    base: &str,
    symbol_name: &str,
    export_maps: Option<&BTreeMap<String, HashMap<String, ExportBinding>>>,
    out: &mut Vec<String>,
    visited: &mut HashSet<(String, String)>,
    depth: usize,
) {
    if depth > 10 || !visited.insert((base.to_string(), symbol_name.to_string())) {
        return;
    }

    for suffix in [".ts", ".tsx", "/index.ts", "/index.tsx", ""] {
        let key = format!("ts:{}{}#{}", base, suffix, symbol_name);
        if !out.contains(&key) {
            out.push(key);
        }
    }

    if let Some(exports) = export_maps {
        for suffix in ["/index.ts", "/index.tsx", ".ts", ".tsx"] {
            let file_key = format!("{}{}", base, suffix);
            if let Some(file_exports) = exports.get(&file_key) {
                if let Some(exp_binding) = file_exports.get(symbol_name) {
                    if let Some(target_base) = resolve_import_module(&file_key, &exp_binding.module)
                    {
                        let target_base = strip_script_extension(&target_base);
                        collect_import_candidates_recursive(
                            &target_base,
                            &exp_binding.source_symbol,
                            Some(exports),
                            out,
                            visited,
                            depth + 1,
                        );
                    }
                }
            }
        }
    }
}

/// Point property-level refs at the file named by their import statement before the
/// suffix fallback runs, so two same-named declarations no longer resolve by file order.
fn rewrite_import_refs(
    pool: &mut BTreeMap<String, WireType>,
    import_maps: &BTreeMap<String, HashMap<String, ImportBinding>>,
    export_maps: Option<&BTreeMap<String, HashMap<String, ExportBinding>>>,
) {
    let known: HashSet<String> = pool.keys().cloned().collect();
    let keys: Vec<String> = pool.keys().cloned().collect();
    for key in keys {
        let file = key
            .strip_prefix("ts:")
            .and_then(|rest| rest.rsplit_once('#').map(|(f, _)| f.to_string()))
            .unwrap_or_default();
        let Some(imports) = import_maps.get(&file) else {
            continue;
        };
        if let Some(wt) = pool.get_mut(&key) {
            rewrite_wire_refs(wt, &file, imports, &known, export_maps);
        }
    }
}

fn rewrite_wire_refs(
    wt: &mut WireType,
    file: &str,
    imports: &HashMap<String, ImportBinding>,
    known: &HashSet<String>,
    export_maps: Option<&BTreeMap<String, HashMap<String, ExportBinding>>>,
) {
    match wt {
        WireType::Ref(r) => {
            if known.contains(&r.r#ref) {
                return;
            }
            let name = r
                .r#ref
                .rsplit_once('#')
                .map(|(_, n)| n.to_string())
                .unwrap_or_default();
            if let Some(target) = import_candidate_refs(&name, file, imports, export_maps)
                .into_iter()
                .find(|candidate| known.contains(candidate))
            {
                r.r#ref = target;
            }
        }
        WireType::Array(arr) => {
            rewrite_wire_refs(&mut arr.element_type, file, imports, known, export_maps)
        }
        WireType::Object(obj) => {
            for prop in &mut obj.properties {
                rewrite_wire_refs(&mut prop.r#type, file, imports, known, export_maps);
            }
        }
        _ => {}
    }
}

fn pool_resolution_maps(
    pool: &BTreeMap<String, WireType>,
) -> (HashSet<String>, HashMap<String, String>) {
    let known_keys: HashSet<String> = pool.keys().cloned().collect();
    let mut resolved_map: HashMap<String, String> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();

    // Suffix matching is a last resort. When two declarations share a simple name it
    // cannot choose between them, so the name is withheld rather than bound to the
    // lexicographically first declaration (which would invent a shape).
    for key in pool.keys() {
        if let Some(pos) = key.rfind('#') {
            let name = &key[pos + 1..];
            if ambiguous.contains(name) {
                continue;
            }
            if resolved_map.contains_key(name) {
                resolved_map.remove(name);
                ambiguous.insert(name.to_string());
            } else {
                resolved_map.insert(name.to_string(), key.clone());
            }
        }
    }

    (known_keys, resolved_map)
}

fn sanitize_type_pool(pool: &mut BTreeMap<String, WireType>) {
    let (known_keys, resolved_map) = pool_resolution_maps(pool);
    for (_, wt) in pool.iter_mut() {
        sanitize_wire_type(wt, &known_keys, &resolved_map);
    }
}

/// Wire types built from a declaration carry refs qualified by the declaring file,
/// so a type imported into that declaration points at the wrong file. The pool is
/// repaired from its import maps, but the copies embedded in client contracts were
/// not, and `expand_type_pool` hard-fails on the dangling ref. Resolve them against
/// the finished pool so both views agree.
fn sanitize_client_contracts(
    contracts: &mut [FrontendClientContract],
    pool: &BTreeMap<String, WireType>,
) {
    let (known_keys, suffix_map) = pool_resolution_maps(pool);
    for contract in contracts {
        if let Some(body) = &mut contract.request_body {
            sanitize_wire_type(body, &known_keys, &suffix_map);
        }
        sanitize_wire_type(&mut contract.expected_response, &known_keys, &suffix_map);
        if root_declares_a_shape(&contract.expected_response, pool) {
            continue;
        }
        if contract.consumer_traversal_complete != Some(false) {
            contract
                .unresolved_evidence
                .push("Response resolves to an empty or unshaped object declaration".to_string());
        }
        contract.consumer_traversal_complete = Some(false);
    }
}

fn sanitize_wire_type(
    wt: &mut WireType,
    known_keys: &HashSet<String>,
    suffix_map: &HashMap<String, String>,
) {
    match wt {
        WireType::Ref(r) => {
            if known_keys.contains(&r.r#ref) {
                return;
            }
            let type_name = r.r#ref.split('#').last().unwrap_or(&r.r#ref);
            if let Some(target) = suffix_map.get(type_name) {
                r.r#ref = target.clone();
            } else {
                *wt = WireType::Unknown(UnknownWireType {
                    reason: format!(
                        "Type `{}` could not be resolved in local type pool",
                        type_name
                    ),
                    provenance: r.provenance.clone(),
                });
            }
        }
        WireType::Array(arr) => {
            sanitize_wire_type(&mut arr.element_type, known_keys, suffix_map);
        }
        WireType::Object(obj) => {
            for prop in &mut obj.properties {
                sanitize_wire_type(&mut prop.r#type, known_keys, suffix_map);
            }
        }
        WireType::Nullable(n) => {
            sanitize_wire_type(&mut n.inner_type, known_keys, suffix_map);
        }
        WireType::Optional(o) => {
            sanitize_wire_type(&mut o.inner_type, known_keys, suffix_map);
        }
        WireType::Map(map) => {
            sanitize_wire_type(&mut map.key_type, known_keys, suffix_map);
            sanitize_wire_type(&mut map.value_type, known_keys, suffix_map);
        }
        WireType::Union(union) => {
            for member in &mut union.types {
                sanitize_wire_type(member, known_keys, suffix_map);
            }
        }
        _ => {}
    }
}

/// A pooled declaration of a generic type is written with its parameters as names (`T`), which
/// are not types any use site can share. Left as a reference it degrades to "could not be
/// resolved in local type pool", which blames the resolver for what the source left open.
fn mark_unbound_params(wt: &mut WireType, params: &[String], decl: &str) {
    if params.is_empty() {
        return;
    }
    match wt {
        WireType::Ref(reference) => {
            let name = reference
                .r#ref
                .rsplit_once('#')
                .map(|(_, n)| n)
                .unwrap_or("");
            if let Some(param) = params.iter().find(|p| p.as_str() == name) {
                *wt = WireType::Unknown(UnknownWireType {
                    reason: format!(
                        "`{decl}` declares a type parameter `{param}` that is not bound at this use site"
                    ),
                    provenance: reference.provenance.clone(),
                });
            }
        }
        WireType::Array(array) => mark_unbound_params(&mut array.element_type, params, decl),
        WireType::Object(object) => {
            for property in &mut object.properties {
                mark_unbound_params(&mut property.r#type, params, decl);
            }
        }
        WireType::Nullable(wrapper) => mark_unbound_params(&mut wrapper.inner_type, params, decl),
        WireType::Optional(wrapper) => mark_unbound_params(&mut wrapper.inner_type, params, decl),
        WireType::Map(map) => {
            mark_unbound_params(&mut map.key_type, params, decl);
            mark_unbound_params(&mut map.value_type, params, decl);
        }
        WireType::Union(union) => {
            for member in &mut union.types {
                mark_unbound_params(member, params, decl);
            }
        }
        _ => {}
    }
}

fn inspect_type_declaration(
    node: Node,
    content: &str,
    rel_path: &str,
) -> Option<(String, WireType, Vec<String>)> {
    let name_node = node.child_by_field_name("name")?;
    let type_name = slice_node(name_node, content).trim().to_string();

    let fq_ref = format!("ts:{}#{}", rel_path, type_name);
    let bases = collect_heritage(node, content);
    let params = collect_type_params(node, content);

    let mut properties = Vec::new();
    let mut has_index_signature = false;
    let mut body_node = node.child_by_field_name("body");
    if body_node.is_none() {
        let count = node.child_count();
        for i in 0..count {
            if let Some(child) = node.child(i as u32) {
                if child.kind() == "interface_body" || child.kind() == "object_type" {
                    body_node = Some(child);
                    break;
                }
            }
        }
    }

    if let Some(body) = body_node {
        let count = body.child_count();
        for i in 0..count {
            if let Some(child) = body.child(i as u32) {
                if child.kind() == "index_signature" {
                    has_index_signature = true;
                    continue;
                }
                if child.kind() == "property_signature" {
                    if let Some(prop_name_node) = child.child_by_field_name("name") {
                        let prop_name = slice_node(prop_name_node, content).trim().to_string();
                        let prop_line = (child.start_position().row + 1) as u32;

                        let is_optional = (0..child.child_count())
                            .any(|j| child.child(j as u32).map_or(false, |c| c.kind() == "?"));

                        let mut prop_type_wire =
                            if let Some(type_ann) = child.child_by_field_name("type") {
                                let type_text = slice_node(type_ann, content).trim();
                                let clean_type = type_text
                                    .strip_prefix(':')
                                    .unwrap_or(type_text)
                                    .trim()
                                    .trim_end_matches(';')
                                    .trim_end_matches(',')
                                    .trim();
                                parse_type_str_to_wire(clean_type, rel_path, prop_line)
                            } else {
                                WireType::Unknown(UnknownWireType {
                                    reason: "Missing property type annotation".to_string(),
                                    provenance: None,
                                })
                            };
                        mark_unbound_params(&mut prop_type_wire, &params, &type_name);
                        let (prop_type_wire, nullable, nullish_optional) =
                            peel_nullish_wrappers(prop_type_wire);

                        properties.push(WirePropertyContract {
                            wire_name: prop_name.clone(),
                            aliases: Vec::new(),
                            r#type: prop_type_wire,
                            optional: is_optional || nullish_optional,
                            nullable,
                            server_assigned: false,
                            validation_constraints: Vec::new(),
                            provenance: Some(SourceProvenance {
                                sha256: None,
                                language: SourceLanguage::TypeScript,
                                file: rel_path.to_string(),
                                line: prop_line,
                                column: None,
                                ast_identity: Some(format!("{}.{}", type_name, prop_name)),
                                annotation_or_schema: None,
                                evidence_classification: None,
                            }),
                        });
                    }
                }
            }
        }
    }

    if node.kind() == "type_alias_declaration" && body_node.is_none() {
        // A non-literal alias target must not masquerade as an empty object; it is
        // expanded from the alias declaration when the pool is materialized.
        return Some((
            fq_ref,
            unknown_type(
                format!("Type alias `{type_name}` is expanded from its declaration"),
                rel_path,
                (node.start_position().row + 1) as u32,
            ),
            bases,
        ));
    }

    // An index signature admits keys this extractor cannot enumerate, and its value
    // type applies to every one of them. Publishing only the named properties would
    // claim a closed shape and silently ignore that contract.
    if has_index_signature {
        return Some((
            fq_ref,
            unknown_type(
                format!(
                    "`{type_name}` declares an index signature; its arbitrary keys and their value type are not enumerable"
                ),
                rel_path,
                (node.start_position().row + 1) as u32,
            ),
            Vec::new(),
        ));
    }

    let wt = WireType::Object(ObjectWireType {
        name: Some(type_name.clone()),
        properties,
        strict: Some(false),
        provenance: Some(SourceProvenance {
            sha256: None,
            language: SourceLanguage::TypeScript,
            file: rel_path.to_string(),
            line: (node.start_position().row + 1) as u32,
            column: None,
            ast_identity: Some(type_name.clone()),
            annotation_or_schema: None,
            evidence_classification: None,
        }),
    });

    Some((fq_ref, wt, bases))
}

/// A declared class field and a constructor-parameter property both describe the wire
/// shape, so a class can serve as a response type (Angular clients often type responses
/// with classes rather than interfaces).
fn inspect_class_declaration(
    node: Node,
    content: &str,
    rel_path: &str,
) -> Option<(String, WireType, Vec<String>)> {
    let name_node = node.child_by_field_name("name")?;
    let type_name = slice_node(name_node, content).trim().to_string();
    if type_name.is_empty() {
        return None;
    }
    let body = node.child_by_field_name("body")?;
    let mut properties = Vec::new();
    let bases = collect_heritage(node, content);
    let mut has_index_signature = false;

    let mut cursor = body.walk();
    for member in body.children(&mut cursor) {
        match member.kind() {
            "index_signature" => has_index_signature = true,
            "public_field_definition" | "field_definition" | "property_definition" => {
                if is_wire_visible(member, content) {
                    if let Some(prop) = class_property(member, content, rel_path, &type_name, false)
                    {
                        properties.push(prop);
                    }
                }
            }
            "method_definition" => {
                let is_constructor = member
                    .child_by_field_name("name")
                    .map(|n| slice_node(n, content).trim() == "constructor")
                    .unwrap_or(false);
                if !is_constructor {
                    continue;
                }
                let Some(params) = member.child_by_field_name("parameters") else {
                    continue;
                };
                let mut param_cursor = params.walk();
                for param in params.children(&mut param_cursor) {
                    if param.kind() != "required_parameter" && param.kind() != "optional_parameter"
                    {
                        continue;
                    }
                    if !has_parameter_property_modifier(param, content) {
                        continue;
                    }
                    if !is_wire_visible(param, content) {
                        continue;
                    }
                    let optional_by_kind = param.kind() == "optional_parameter";
                    if let Some(prop) =
                        class_property(param, content, rel_path, &type_name, optional_by_kind)
                    {
                        properties.push(prop);
                    }
                }
            }
            _ => {}
        }
    }

    if has_index_signature {
        return Some((
            format!("ts:{}#{}", rel_path, type_name),
            unknown_type(
                format!(
                    "`{type_name}` declares an index signature; its arbitrary keys and their value type are not enumerable"
                ),
                rel_path,
                (node.start_position().row + 1) as u32,
            ),
            Vec::new(),
        ));
    }

    // Base classes and derived classes must be interned so downstream classes
    // can resolve them through inheritance without reporting unresolvable `extends`.
    Some((
        format!("ts:{}#{}", rel_path, type_name),
        WireType::Object(ObjectWireType {
            name: Some(type_name.clone()),
            properties,
            strict: Some(false),
            provenance: Some(ts_provenance(
                rel_path,
                (node.start_position().row + 1) as u32,
                Some(type_name),
            )),
        }),
        bases,
    ))
}

/// Base types named by `extends` on an interface or class. The whole base expression is
/// kept, not just its head: `Omit<Base, 'id'>` and `BaseData<AgentId>` each name a
/// different shape than `Base`, and dropping the arguments would merge the wrong one.
fn collect_heritage(node: Node, content: &str) -> Vec<String> {
    let mut bases = Vec::new();
    let mut push = |raw: &str| {
        let expr = raw.trim();
        if !expr.is_empty() && !bases.iter().any(|b: &String| b == expr) {
            bases.push(expr.to_string());
        }
    };
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "extends_type_clause" => {
                let mut inner = child.walk();
                for ty in child.children_by_field_name("type", &mut inner) {
                    push(slice_node(ty, content));
                }
            }
            "class_heritage" => {
                let mut inner = child.walk();
                for clause in child.children(&mut inner) {
                    if clause.kind() != "extends_clause" {
                        continue;
                    }
                    if let Some(value) = clause.child_by_field_name("value") {
                        push(slice_node(value, content));
                    }
                }
            }
            _ => {}
        }
    }
    bases
}

/// TypeScript merges duplicate interface declarations in the same module. The later
/// declaration wins for a property both declare, while the first-seen order is kept.
fn merge_duplicate_declaration(existing: WireType, incoming: WireType, key: &str) -> WireType {
    match (existing, incoming) {
        (WireType::Object(mut merged), WireType::Object(other)) => {
            for property in other.properties {
                upsert_pool_property(&mut merged.properties, property);
            }
            WireType::Object(merged)
        }
        // Only object-like declarations are mergeable in TypeScript. Anything else is
        // a source error or unmodeled syntax; either half would claim a shape the
        // compiler itself rejects.
        _ => unknown_type(
            format!(
                "`{}` is declared more than once with kinds that cannot be merged",
                short_name(key)
            ),
            key.strip_prefix("ts:")
                .and_then(|rest| rest.rsplit_once('#').map(|(file, _)| file))
                .unwrap_or_default(),
            0,
        ),
    }
}

fn upsert_pool_property(
    properties: &mut Vec<WirePropertyContract>,
    property: WirePropertyContract,
) {
    if let Some(existing) = properties
        .iter_mut()
        .find(|p| p.wire_name == property.wire_name)
    {
        *existing = property;
    } else {
        properties.push(property);
    }
}

/// Fold each `extends` chain into the declared object. A base that cannot be resolved
/// to a declared object makes the derived shape unknowable, so it becomes Unknown
/// rather than silently keeping only its own properties. Cycles fail the same way.
fn merge_heritage(
    pool: &mut BTreeMap<String, WireType>,
    heritage: &BTreeMap<String, Vec<String>>,
    aliases: &BTreeMap<String, AliasDef>,
    generics: &BTreeMap<String, GenericDecl>,
    import_maps: &BTreeMap<String, HashMap<String, ImportBinding>>,
) {
    if heritage.is_empty() {
        return;
    }
    let mut pending: BTreeSet<String> = heritage.keys().cloned().collect();

    loop {
        if pending.is_empty() {
            return;
        }
        let mut progressed = false;
        let keys: Vec<String> = pending.iter().cloned().collect();
        for key in keys {
            let Some(bases) = heritage.get(&key) else {
                pending.remove(&key);
                continue;
            };
            let WireType::Object(mut derived) = pool.get(&key).cloned().unwrap_or_else(|| {
                unknown_type("declaration missing from pool".to_string(), "", 0)
            }) else {
                // Index signatures and duplicate-kind conflicts already resolved it.
                pending.remove(&key);
                progressed = true;
                continue;
            };
            let file = key
                .strip_prefix("ts:")
                .and_then(|rest| rest.rsplit_once('#').map(|(f, _)| f))
                .unwrap_or_default();

            enum Outcome {
                Ready(Vec<ObjectWireType>),
                Defer,
                Unresolved(String),
            }

            let outcome = {
                let resolver = TypeResolver {
                    pool,
                    aliases,
                    generics,
                    import_maps,
                    export_maps: None,
                };
                let mut resolved_bases = Vec::new();
                let mut defer = false;
                let mut unresolved = None;
                for base in bases {
                    let expr = parse_type_expr(base);
                    if heritage_references_pending(&expr, file, &pending, &resolver) {
                        defer = true;
                        break;
                    }
                    let object = match &expr {
                        TypeExpr::Name(name) => pooled_base_object(&resolver, name, file),
                        other => match resolver.eval(
                            other,
                            file,
                            0,
                            &TypeSubst::new(),
                            &mut Vec::new(),
                            0,
                        ) {
                            WireType::Object(object) => Some(object),
                            // A generic heritage whose arguments cannot be evaluated still
                            // contributes the properties it declares, which is what this pass
                            // did before it kept the arguments; that is not a guess about them.
                            _ => heritage_head_name(other)
                                .and_then(|name| pooled_base_object(&resolver, &name, file)),
                        },
                    };
                    match object {
                        Some(object) => resolved_bases.push(object),
                        None => {
                            unresolved = Some(base.clone());
                            break;
                        }
                    }
                }
                if let Some(base) = unresolved {
                    Outcome::Unresolved(base)
                } else if defer {
                    Outcome::Defer
                } else {
                    Outcome::Ready(resolved_bases)
                }
            };

            match outcome {
                Outcome::Defer => continue,
                Outcome::Unresolved(base) => {
                    pool.insert(
                        key.clone(),
                        unknown_type(
                            format!(
                                "`{}` extends `{base}`, which does not resolve to a declared object",
                                short_name(&key)
                            ),
                            file,
                            0,
                        ),
                    );
                    pending.remove(&key);
                    progressed = true;
                }
                Outcome::Ready(resolved_bases) => {
                    let mut merged_properties: Vec<WirePropertyContract> = Vec::new();
                    for base in resolved_bases {
                        for property in base.properties {
                            upsert_pool_property(&mut merged_properties, property);
                        }
                    }
                    for property in std::mem::take(&mut derived.properties) {
                        upsert_pool_property(&mut merged_properties, property);
                    }
                    derived.properties = merged_properties;
                    pool.insert(key.clone(), WireType::Object(derived));
                    pending.remove(&key);
                    progressed = true;
                }
            }
        }
        if !progressed {
            break;
        }
    }

    for key in pending {
        pool.insert(
            key.clone(),
            unknown_type(
                format!(
                    "`{}` participates in a circular `extends` chain, so its shape cannot be resolved",
                    short_name(&key)
                ),
                key.strip_prefix("ts:")
                    .and_then(|rest| rest.rsplit_once('#').map(|(f, _)| f))
                    .unwrap_or_default(),
                0,
            ),
        );
    }
}

/// Resolve a bare heritage name to the object its properties live on. Aliases are
/// expanded; a pooled declaration is cloned. A non-object target is not a base shape.
fn pooled_base_object(
    resolver: &TypeResolver<'_>,
    name: &str,
    file: &str,
) -> Option<ObjectWireType> {
    let key = resolver.resolve_ref(name, file)?;
    if resolver.aliases.contains_key(&key) {
        match resolver.expand_alias(&key, Vec::new(), &mut Vec::new(), 0) {
            WireType::Object(object) => Some(object),
            _ => None,
        }
    } else {
        match resolver.pool.get(&key) {
            Some(WireType::Object(object)) => Some(object.clone()),
            _ => None,
        }
    }
}

/// The declaration name a heritage expression applies to: `BaseData<AgentId>` and
/// `Omit<BaseData<AgentId>, 'name'>` both lead with a name, and the head is the only
/// part that can name a pooled declaration when the expression itself cannot be evaluated.
fn heritage_head_name(expr: &TypeExpr) -> Option<String> {
    match expr {
        TypeExpr::Name(name) => Some(name.clone()),
        TypeExpr::Generic(name, _) => Some(name.clone()),
        TypeExpr::Union(parts) | TypeExpr::Intersection(parts) => {
            parts.iter().find_map(heritage_head_name)
        }
        _ => None,
    }
}

/// A base must be merged after the bases it depends on, so an expression naming a
/// declaration still pending in this same pass defers rather than reading a half-merged
/// shape. Names that resolve to nothing (`Omit`, unbound type parameters) are not
/// dependencies.
fn heritage_references_pending(
    expr: &TypeExpr,
    file: &str,
    pending: &BTreeSet<String>,
    resolver: &TypeResolver<'_>,
) -> bool {
    let mut names = Vec::new();
    collect_type_names(expr, &mut names);
    names.iter().any(|name| {
        let local = format!("ts:{}#{}", file, name);
        pending.contains(&local)
            || resolver
                .resolve_ref(name, file)
                .is_some_and(|key| pending.contains(&key))
    })
}

fn collect_type_names(expr: &TypeExpr, out: &mut Vec<String>) {
    match expr {
        TypeExpr::Name(name) => out.push(name.clone()),
        TypeExpr::Generic(name, args) => {
            out.push(name.clone());
            for arg in args {
                collect_type_names(arg, out);
            }
        }
        TypeExpr::Array(inner) => collect_type_names(inner, out),
        TypeExpr::Union(parts) | TypeExpr::Intersection(parts) => {
            for part in parts {
                collect_type_names(part, out);
            }
        }
        TypeExpr::Object(props) => {
            for prop in props {
                collect_type_names(&prop.r#type, out);
            }
        }
        TypeExpr::StrLit(_) | TypeExpr::NoAnnotation | TypeExpr::Other(_) => {}
    }
}

fn infer_initializer_wire_type(
    node: Node,
    content: &str,
    rel_path: &str,
    line: u32,
    prop_name: &str,
) -> WireType {
    if node.kind() == "as_expression" || node.kind() == "type_assertion" {
        if let Some(type_node) = node.child_by_field_name("type") {
            let type_text = strip_type_annotation(slice_node(type_node, content));
            if type_text != "const" {
                return parse_type_str_to_wire(&type_text, rel_path, line);
            }
        }
        if let Some(expr) = node.child_by_field_name("expression") {
            return infer_initializer_wire_type(expr, content, rel_path, line, prop_name);
        }
    }
    if node.kind() == "parenthesized_expression" {
        if let Some(inner) = node.named_child(0) {
            return infer_initializer_wire_type(inner, content, rel_path, line, prop_name);
        }
    }
    match node.kind() {
        "string" | "template_string" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: None,
            provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
        }),
        "number" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Number,
            format: None,
            provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
        }),
        "true" | "false" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Boolean,
            format: None,
            provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
        }),
        "null" => WireType::Nullable(contract_core::ir::NullableWireType {
            inner_type: Box::new(unknown_type(
                format!("Class property `{prop_name}` initialized to null has unknown type"),
                rel_path,
                line,
            )),
            provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
        }),
        "array" => {
            if let Some(elem) = node.named_child(0) {
                let elem_type =
                    infer_initializer_wire_type(elem, content, rel_path, line, prop_name);
                WireType::Array(ArrayWireType {
                    element_type: Box::new(elem_type),
                    is_stream_or_flux: None,
                    provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
                })
            } else {
                WireType::Array(ArrayWireType {
                    element_type: Box::new(unknown_type(
                        format!("Class property `{prop_name}` initialized with empty array has unknown element type"),
                        rel_path,
                        line,
                    )),
                    is_stream_or_flux: None,
                    provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
                })
            }
        }
        "unary_expression" => {
            let operator = node
                .child_by_field_name("operator")
                .map(|op| slice_node(op, content).trim())
                .unwrap_or_default();
            if operator == "!" {
                WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Boolean,
                    format: None,
                    provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
                })
            } else if operator == "-" || operator == "+" {
                WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Number,
                    format: None,
                    provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
                })
            } else {
                unknown_type(
                    format!("Class property `{prop_name}` has unsupported unary initializer"),
                    rel_path,
                    line,
                )
            }
        }
        "member_expression" => {
            // e.g. Direction.Up, Theme.Dark
            if let Some(obj) = node.child_by_field_name("object") {
                let obj_text = slice_node(obj, content).trim();
                if is_valid_type_identifier(obj_text)
                    && !matches!(
                        obj_text,
                        "this" | "window" | "document" | "console" | "Math" | "JSON"
                    )
                {
                    return parse_type_str_to_wire(obj_text, rel_path, line);
                }
            }
            unknown_type(
                format!(
                    "Class property `{prop_name}` initialized with unresolvable member expression"
                ),
                rel_path,
                line,
            )
        }
        "identifier" => {
            let text = slice_node(node, content).trim();
            if text == "undefined" {
                WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Void,
                    format: None,
                    provenance: Some(ts_provenance(rel_path, line, Some(prop_name.to_string()))),
                })
            } else if is_valid_type_identifier(text) {
                parse_type_str_to_wire(text, rel_path, line)
            } else {
                unknown_type(
                    format!("Class property `{prop_name}` initialized with identifier `{text}`"),
                    rel_path,
                    line,
                )
            }
        }
        "new_expression" => {
            if let Some(ctor) = node.child_by_field_name("constructor") {
                let ctor_text = slice_node(ctor, content).trim();
                if ctor_text == "Date" {
                    return WireType::Primitive(PrimitiveWireType {
                        scalar: PrimitiveScalar::String,
                        format: None,
                        provenance: Some(ts_provenance(
                            rel_path,
                            line,
                            Some(prop_name.to_string()),
                        )),
                    });
                } else if ctor_text == "Set" || ctor_text == "Map" {
                    return unknown_type(
                        format!("Class property `{prop_name}` initialized with `{ctor_text}` has no static wire representation"),
                        rel_path,
                        line,
                    );
                } else if is_valid_type_identifier(ctor_text) {
                    return parse_type_str_to_wire(ctor_text, rel_path, line);
                }
            }
            unknown_type(
                format!("Class property `{prop_name}` has no type annotation and constructor cannot be resolved"),
                rel_path,
                line,
            )
        }
        _ => unknown_type(
            format!("Class property `{prop_name}` has no type annotation"),
            rel_path,
            line,
        ),
    }
}

fn class_property(
    member: Node,
    content: &str,
    rel_path: &str,
    owner: &str,
    optional_by_kind: bool,
) -> Option<WirePropertyContract> {
    let name_node = member
        .child_by_field_name("name")
        .or_else(|| member.child_by_field_name("pattern"))?;
    let prop_name = slice_node(name_node, content).trim().to_string();
    if prop_name.is_empty() {
        return None;
    }
    let prop_line = (member.start_position().row + 1) as u32;
    let optional = optional_by_kind || has_question_marker(member);
    let prop_type = match member.child_by_field_name("type") {
        Some(type_ann) => {
            let text = strip_type_annotation(slice_node(type_ann, content));
            parse_type_str_to_wire(&text, rel_path, prop_line)
        }
        None => match member.child_by_field_name("value") {
            Some(value_node) => {
                infer_initializer_wire_type(value_node, content, rel_path, prop_line, &prop_name)
            }
            None => unknown_type(
                format!("Class property `{prop_name}` has no type annotation"),
                rel_path,
                prop_line,
            ),
        },
    };
    let (prop_type, nullable, nullish_optional) = peel_nullish_wrappers(prop_type);
    Some(WirePropertyContract {
        wire_name: prop_name.clone(),
        aliases: Vec::new(),
        r#type: prop_type,
        optional: optional || nullish_optional,
        nullable,
        server_assigned: false,
        validation_constraints: Vec::new(),
        provenance: Some(ts_provenance(
            rel_path,
            prop_line,
            Some(format!("{owner}.{prop_name}")),
        )),
    })
}

fn has_question_marker(node: Node) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| child.kind() == "?");
    found
}

/// `private` and `protected` members are not part of the wire payload.
fn is_wire_visible(node: Node, content: &str) -> bool {
    let mut cursor = node.walk();
    let hidden = node.children(&mut cursor).any(|child| {
        child.kind() == "accessibility_modifier"
            && matches!(slice_node(child, content).trim(), "private" | "protected")
    });
    !hidden
}

fn has_parameter_property_modifier(node: Node, content: &str) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| {
        child.kind() == "accessibility_modifier"
            || (!child.is_named() && slice_node(child, content).trim() == "readonly")
    });
    found
}

fn strip_type_annotation(text: &str) -> String {
    text.trim()
        .strip_prefix(':')
        .unwrap_or(text.trim())
        .trim()
        .trim_end_matches(';')
        .trim_end_matches(',')
        .trim()
        .to_string()
}

fn collect_type_params(node: Node, content: &str) -> Vec<String> {
    let Some(type_params) = node.child_by_field_name("type_parameters") else {
        return Vec::new();
    };
    let mut params = Vec::new();
    let mut cursor = type_params.walk();
    for child in type_params.children(&mut cursor) {
        if child.kind() != "type_parameter" {
            continue;
        }
        let Some(param_name) = child.child_by_field_name("name") else {
            continue;
        };
        let param = slice_node(param_name, content).trim();
        if !param.is_empty() && !params.iter().any(|p: &String| p == param) {
            params.push(param.to_string());
        }
    }
    params
}

fn collect_alias_def(node: Node, content: &str, rel_path: &str) -> Option<(String, AliasDef)> {
    let name_node = node.child_by_field_name("name")?;
    let name = slice_node(name_node, content).trim().to_string();
    if name.is_empty() {
        return None;
    }
    let value_node = node.child_by_field_name("value")?;
    let params = collect_type_params(node, content);
    Some((
        format!("ts:{}#{}", rel_path, name),
        AliasDef {
            file: rel_path.to_string(),
            line: (node.start_position().row + 1) as u32,
            params,
            body: parse_type_expr(slice_node(value_node, content)),
        },
    ))
}

/// A generic `interface` is captured as a type expression so each use site can bind its own
/// type arguments. Two shapes are left out on purpose: a declaration with an `extends` clause,
/// because expanding only the declared body would drop inherited properties and a narrower
/// consumer shape turns an untouched field into a false `required field is absent` finding; and
/// one with an index signature, which already abstains in the pool.
fn collect_generic_interface(
    node: Node,
    content: &str,
    rel_path: &str,
) -> Option<(String, GenericDecl)> {
    let params = collect_type_params(node, content);
    if params.is_empty() || !collect_heritage(node, content).is_empty() {
        return None;
    }
    let name_node = node.child_by_field_name("name")?;
    let name = slice_node(name_node, content).trim();
    if name.is_empty() {
        return None;
    }
    let body = node.child_by_field_name("body")?;
    if body.kind() != "interface_body" {
        return None;
    }
    let mut props = Vec::new();
    let mut cursor = body.walk();
    for child in body.children(&mut cursor) {
        match child.kind() {
            "index_signature" | "call_signature" | "construct_signature" => return None,
            "property_signature" => {
                let Some(prop_name_node) = child.child_by_field_name("name") else {
                    continue;
                };
                let prop_name = slice_node(prop_name_node, content).trim().to_string();
                if prop_name.is_empty() {
                    continue;
                }
                let optional = (0..child.child_count())
                    .any(|j| child.child(j as u32).map_or(false, |c| c.kind() == "?"));
                let r#type = match child.child_by_field_name("type") {
                    Some(annotation) => {
                        parse_type_expr(&strip_type_annotation(slice_node(annotation, content)))
                    }
                    None => TypeExpr::NoAnnotation,
                };
                props.push(PropExpr {
                    name: prop_name,
                    optional,
                    r#type,
                });
            }
            // A method signature describes behaviour, not a wire property, and the pooled
            // declaration skips it the same way.
            _ => {}
        }
    }
    Some((
        format!("ts:{}#{}", rel_path, name),
        GenericDecl {
            file: rel_path.to_string(),
            line: (node.start_position().row + 1) as u32,
            params,
            body: TypeExpr::Object(props),
        },
    ))
}

const MAX_TYPE_EXPANSION_DEPTH: usize = 24;

fn ts_provenance(file: &str, line: u32, identity: Option<String>) -> SourceProvenance {
    SourceProvenance {
        sha256: None,
        language: SourceLanguage::TypeScript,
        file: file.to_string(),
        line,
        column: None,
        ast_identity: identity,
        annotation_or_schema: None,
        evidence_classification: None,
    }
}

/// `true` only when the response root names a shape a consumer could assert on. A reference to a
/// pooled declaration that abstained, or that carries no properties, matches any payload, so
/// counting it as traversed converts an abstention into a false preservation.
fn root_declares_a_shape(root: &WireType, pool: &BTreeMap<String, WireType>) -> bool {
    let peeled = match root {
        WireType::Nullable(wrapper) => wrapper.inner_type.as_ref(),
        WireType::Optional(wrapper) => wrapper.inner_type.as_ref(),
        other => other,
    };
    match peeled {
        WireType::Unknown(_) => false,
        WireType::Object(object) => !object.properties.is_empty(),
        WireType::Ref(reference) => match pool.get(&reference.r#ref) {
            None => false,
            Some(WireType::Object(object)) => !object.properties.is_empty(),
            Some(WireType::Unknown(_)) => false,
            Some(_) => true,
        },
        _ => true,
    }
}

fn unknown_type(reason: String, file: &str, line: u32) -> WireType {
    WireType::Unknown(UnknownWireType {
        reason,
        provenance: Some(ts_provenance(file, line, None)),
    })
}

/// Type expressions are parsed only as far as their shape meaning goes. Anything the
/// parser does not model becomes `Other`, which degrades to UNKNOWN instead of being
/// guessed at.
fn parse_type_expr(text: &str) -> TypeExpr {
    let mut parser = TypeParser { s: text, pos: 0 };
    match parser.parse_union(0) {
        Some(expr) => {
            parser.skip_ws();
            if parser.pos == parser.s.len() {
                expr
            } else {
                TypeExpr::Other(text.trim().to_string())
            }
        }
        None => TypeExpr::Other(text.trim().to_string()),
    }
}

struct TypeParser<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> TypeParser<'a> {
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<char> {
        self.s[self.pos..].chars().next()
    }

    fn eat(&mut self, ch: char) -> bool {
        self.skip_ws();
        if self.peek() == Some(ch) {
            self.pos += ch.len_utf8();
            true
        } else {
            false
        }
    }

    fn starts_with_word(&self, word: &str) -> bool {
        let rest = &self.s[self.pos..];
        if !rest.starts_with(word) {
            return false;
        }
        match rest[word.len()..].chars().next() {
            Some(c) => !is_ident_char(c),
            None => true,
        }
    }

    fn read_ident(&mut self) -> String {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if is_ident_char(c) {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        self.s[start..self.pos].to_string()
    }

    fn parse_string_literal(&mut self) -> Option<String> {
        let quote = self.peek()?;
        if quote != '\'' && quote != '"' {
            return None;
        }
        self.pos += quote.len_utf8();
        let mut out = String::new();
        while let Some(c) = self.peek() {
            self.pos += c.len_utf8();
            if c == '\\' {
                if let Some(escaped) = self.peek() {
                    out.push(escaped);
                    self.pos += escaped.len_utf8();
                }
                continue;
            }
            if c == quote {
                return Some(out);
            }
            out.push(c);
        }
        None
    }

    fn parse_union(&mut self, depth: usize) -> Option<TypeExpr> {
        if depth > MAX_TYPE_EXPANSION_DEPTH {
            return None;
        }
        let first = self.parse_intersection(depth)?;
        let mut parts = vec![first];
        loop {
            self.skip_ws();
            if self.peek() == Some('|') {
                self.pos += 1;
                parts.push(self.parse_intersection(depth)?);
            } else {
                break;
            }
        }
        if parts.len() == 1 {
            parts.pop()
        } else {
            Some(TypeExpr::Union(parts))
        }
    }

    fn parse_intersection(&mut self, depth: usize) -> Option<TypeExpr> {
        let first = self.parse_postfix(depth)?;
        let mut parts = vec![first];
        loop {
            self.skip_ws();
            if self.peek() == Some('&') {
                self.pos += 1;
                parts.push(self.parse_postfix(depth)?);
            } else {
                break;
            }
        }
        if parts.len() == 1 {
            parts.pop()
        } else {
            Some(TypeExpr::Intersection(parts))
        }
    }

    fn parse_postfix(&mut self, depth: usize) -> Option<TypeExpr> {
        let mut expr = self.parse_primary(depth)?;
        loop {
            self.skip_ws();
            if self.peek() == Some('[') {
                let save = self.pos;
                self.pos += 1;
                self.skip_ws();
                if self.peek() == Some(']') {
                    self.pos += 1;
                    expr = TypeExpr::Array(Box::new(expr));
                } else {
                    self.pos = save;
                    break;
                }
            } else {
                break;
            }
        }
        Some(expr)
    }

    fn parse_primary(&mut self, depth: usize) -> Option<TypeExpr> {
        self.skip_ws();
        let start = self.pos;
        match self.peek()? {
            '{' => self.parse_object(depth),
            '(' => {
                self.pos += 1;
                let inner = self.parse_union(depth + 1)?;
                self.eat(')').then_some(inner)
            }
            '\'' | '"' => self.parse_string_literal().map(TypeExpr::StrLit),
            c if is_ident_start(c) => {
                let ident = self.read_ident();
                if ident == "readonly" {
                    return self.parse_postfix(depth + 1);
                }
                if matches!(
                    ident.as_str(),
                    "keyof" | "typeof" | "infer" | "unique" | "asserts"
                ) {
                    self.skip_ws();
                    let _ = self.parse_postfix(depth + 1);
                    return Some(TypeExpr::Other(self.s[start..self.pos].trim().to_string()));
                }
                self.skip_ws();
                if self.peek() == Some('<') {
                    self.pos += 1;
                    let mut args = Vec::new();
                    loop {
                        self.skip_ws();
                        if self.peek() == Some('>') {
                            self.pos += 1;
                            break;
                        }
                        args.push(self.parse_union(depth + 1)?);
                        self.skip_ws();
                        match self.peek() {
                            Some(',') => {
                                self.pos += 1;
                            }
                            Some('>') => {
                                self.pos += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                    return Some(TypeExpr::Generic(ident, args));
                }
                Some(TypeExpr::Name(ident))
            }
            _ => None,
        }
    }

    fn parse_object(&mut self, depth: usize) -> Option<TypeExpr> {
        self.eat('{').then_some(())?;
        let mut props = Vec::new();
        loop {
            self.skip_ws();
            match self.peek() {
                Some('}') => {
                    self.pos += 1;
                    break;
                }
                Some(';') | Some(',') => {
                    self.pos += 1;
                    continue;
                }
                None => return None,
                _ => {}
            }
            if self.starts_with_word("readonly") {
                self.read_ident();
                self.skip_ws();
            }
            let name = match self.peek() {
                Some('\'') | Some('"') => self.parse_string_literal()?,
                Some(c) if is_ident_start(c) => self.read_ident(),
                _ => return None,
            };
            self.skip_ws();
            let optional = if self.peek() == Some('?') {
                self.pos += 1;
                true
            } else {
                false
            };
            if !self.eat(':') {
                // Method or call signatures carry behaviour, not a wire shape.
                return None;
            }
            let r#type = self.parse_union(depth + 1)?;
            props.push(PropExpr {
                name,
                optional,
                r#type,
            });
        }
        Some(TypeExpr::Object(props))
    }
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.'
}

type TypeSubst = HashMap<String, (TypeExpr, String, u32)>;

struct TypeResolver<'a> {
    pool: &'a BTreeMap<String, WireType>,
    aliases: &'a BTreeMap<String, AliasDef>,
    generics: &'a BTreeMap<String, GenericDecl>,
    import_maps: &'a BTreeMap<String, HashMap<String, ImportBinding>>,
    export_maps: Option<&'a BTreeMap<String, HashMap<String, ExportBinding>>>,
}

impl<'a> TypeResolver<'a> {
    /// Resolve a call-site type argument (text) into a wire type, expanding aliases.
    fn map(&self, type_name: &str, file: &str, line: u32) -> WireType {
        let trimmed = type_name.trim();
        if trimmed.is_empty() {
            return unknown_type("Empty type expression".to_string(), file, line);
        }
        if let Some(scalar) = primitive_scalar(trimmed) {
            return WireType::Primitive(PrimitiveWireType {
                scalar,
                format: None,
                provenance: None,
            });
        }
        if trimmed.ends_with("[]") {
            let inner = &trimmed[..trimmed.len() - 2];
            return WireType::Array(ArrayWireType {
                element_type: Box::new(self.map(inner, file, line)),
                is_stream_or_flux: None,
                provenance: None,
            });
        }
        if let Some(inner) =
            generic_inner(trimmed, "Array").or_else(|| generic_inner(trimmed, "ReadonlyArray"))
        {
            return WireType::Array(ArrayWireType {
                element_type: Box::new(self.map(inner, file, line)),
                is_stream_or_flux: None,
                provenance: None,
            });
        }
        match parse_type_expr(trimmed) {
            TypeExpr::Name(name) => self.resolve_name(&name, file, line, &mut Vec::new(), 0),
            other => self.eval(&other, file, line, &TypeSubst::new(), &mut Vec::new(), 0),
        }
    }

    fn resolve_ref(&self, name: &str, file: &str) -> Option<String> {
        let local_ref = format!("ts:{}#{}", file, name);
        if self.pool.contains_key(&local_ref) {
            return Some(local_ref);
        }
        if let Some(imports) = self.import_maps.get(file) {
            if let Some(found) = import_candidate_refs(name, file, imports, self.export_maps)
                .into_iter()
                .find(|key| self.pool.contains_key(key))
            {
                return Some(found);
            }
        }
        // A suffix match is only evidence when exactly one declaration carries the
        // name. Picking the first of several same-named declarations invents a shape.
        let suffix = format!("#{}", name);
        let mut matches = self.pool.keys().filter(|k| k.ends_with(&suffix));
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(first.clone())
    }

    /// Name the module a failed reference was imported from. An unresolved local
    /// name and an unresolved dependency are different debts; only the import
    /// binding can tell them apart.
    fn import_note(&self, name: &str, file: &str) -> String {
        self.import_maps
            .get(file)
            .and_then(|imports| imports.get(name))
            .map(|binding| format!(" (imported from `{}`)", binding.module))
            .unwrap_or_default()
    }

    fn resolve_name(
        &self,
        name: &str,
        file: &str,
        line: u32,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        if let Some(scalar) = primitive_scalar(name) {
            return WireType::Primitive(PrimitiveWireType {
                scalar,
                format: None,
                provenance: None,
            });
        }
        if matches!(name, "any" | "unknown") {
            return unknown_type(format!("Type `{}` carries no shape", name), file, line);
        }
        let Some(key) = self.resolve_ref(name, file) else {
            return unknown_type(
                format!(
                    "Type `{}` could not be resolved in local type pool{}",
                    name,
                    self.import_note(name, file)
                ),
                file,
                line,
            );
        };
        if self.aliases.contains_key(&key) {
            return self.expand_alias(&key, Vec::new(), stack, depth);
        }
        WireType::Ref(RefWireType {
            r#ref: key,
            provenance: Some(ts_provenance(file, line, Some(name.to_string()))),
        })
    }

    fn expand_alias(
        &self,
        key: &str,
        args: Vec<(TypeExpr, String, u32)>,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        let Some(def) = self.aliases.get(key) else {
            return self.pool.get(key).cloned().unwrap_or_else(|| {
                unknown_type(format!("Type alias `{}` is not declared", key), "", 0)
            });
        };
        if def.params.len() != args.len() {
            return unknown_type(
                format!(
                    "Type alias `{}` takes {} type argument(s) but was used with {}",
                    short_name(key),
                    def.params.len(),
                    args.len()
                ),
                &def.file,
                def.line,
            );
        }
        if depth > MAX_TYPE_EXPANSION_DEPTH {
            return unknown_type(
                format!(
                    "Type alias `{}` exceeded the expansion depth budget ({MAX_TYPE_EXPANSION_DEPTH}); the declaration may be recursive",
                    short_name(key)
                ),
                &def.file,
                def.line,
            );
        }
        if stack.iter().any(|k| k == key) {
            return unknown_type(
                format!(
                    "Type alias `{}` is recursive, so its full shape cannot be resolved",
                    short_name(key)
                ),
                &def.file,
                def.line,
            );
        }
        stack.push(key.to_string());
        let subst: TypeSubst = def.params.iter().cloned().zip(args.into_iter()).collect();
        let out = self.eval(&def.body, &def.file, def.line, &subst, stack, depth + 1);
        stack.pop();
        out
    }

    /// Bind a generic declaration's type parameters to the arguments one use site wrote, and
    /// expand its body with them. Only this declaration's own properties are expanded here;
    /// every type named inside them stays a pool reference, so the shared shape is not
    /// duplicated across the artifact.
    fn instantiate_generic(
        &self,
        key: &str,
        decl: &GenericDecl,
        args: &[TypeExpr],
        use_file: &str,
        use_line: u32,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        if decl.params.len() != args.len() {
            return unknown_type(
                format!(
                    "Generic type `{}` takes {} type argument(s) but was used with {}",
                    short_name(key),
                    decl.params.len(),
                    args.len()
                ),
                use_file,
                use_line,
            );
        }
        if depth > MAX_TYPE_EXPANSION_DEPTH {
            return unknown_type(
                format!(
                    "Generic type `{}` exceeded the expansion depth budget ({MAX_TYPE_EXPANSION_DEPTH}); the declaration may be recursive",
                    short_name(key)
                ),
                &decl.file,
                decl.line,
            );
        }
        let instance = instantiated_key(key, args);
        if stack.iter().any(|k| k == key || k == &instance) {
            return unknown_type(
                format!(
                    "Generic type `{}` is recursive, so its full shape cannot be resolved",
                    short_name(key)
                ),
                &decl.file,
                decl.line,
            );
        }
        let subst: TypeSubst = decl
            .params
            .iter()
            .cloned()
            .zip(
                args.iter()
                    .map(|arg| (arg.clone(), use_file.to_string(), use_line)),
            )
            .collect();
        stack.push(instance);
        let out = self.eval(&decl.body, &decl.file, decl.line, &subst, stack, depth + 1);
        stack.pop();
        out
    }

    fn eval(
        &self,
        expr: &TypeExpr,
        file: &str,
        line: u32,
        subst: &TypeSubst,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        if depth > MAX_TYPE_EXPANSION_DEPTH {
            return unknown_type(
                format!("Type expansion exceeded the depth budget ({MAX_TYPE_EXPANSION_DEPTH})"),
                file,
                line,
            );
        }
        match expr {
            TypeExpr::Name(name) => match subst.get(name) {
                Some((bound, bound_file, bound_line)) => {
                    self.eval(bound, bound_file, *bound_line, subst, stack, depth + 1)
                }
                None => self.resolve_name(name, file, line, stack, depth),
            },
            TypeExpr::Array(inner) => WireType::Array(ArrayWireType {
                element_type: Box::new(self.eval(inner, file, line, subst, stack, depth + 1)),
                is_stream_or_flux: None,
                provenance: Some(ts_provenance(file, line, None)),
            }),
            TypeExpr::Generic(name, args) => {
                self.eval_generic(name, args, file, line, subst, stack, depth)
            }
            TypeExpr::Object(props) if props.is_empty() => unknown_type(
                "Empty object type `{}` accepts any non-null value and carries no wire shape"
                    .to_string(),
                file,
                line,
            ),
            TypeExpr::Object(props) => {
                let properties = props
                    .iter()
                    .map(|prop| {
                        let (wire, nullable, nullish_optional) = peel_nullish_wrappers(self.eval(
                            &prop.r#type,
                            file,
                            line,
                            subst,
                            stack,
                            depth + 1,
                        ));
                        WirePropertyContract {
                            wire_name: prop.name.clone(),
                            aliases: Vec::new(),
                            r#type: wire,
                            optional: prop.optional || nullish_optional,
                            nullable,
                            server_assigned: false,
                            validation_constraints: Vec::new(),
                            provenance: Some(ts_provenance(file, line, Some(prop.name.clone()))),
                        }
                    })
                    .collect();
                WireType::Object(ObjectWireType {
                    name: None,
                    properties,
                    strict: Some(false),
                    provenance: Some(ts_provenance(file, line, None)),
                })
            }
            TypeExpr::Intersection(parts) => {
                self.eval_intersection(parts, file, line, subst, stack, depth)
            }
            TypeExpr::Union(parts) => self.eval_union(parts, file, line, subst, stack, depth),
            TypeExpr::StrLit(value) => unknown_type(
                format!("Literal type `'{value}'` carries no structural shape"),
                file,
                line,
            ),
            TypeExpr::NoAnnotation => {
                unknown_type("Missing property type annotation".to_string(), file, line)
            }
            TypeExpr::Other(text) => {
                unknown_type(format!("Unsupported type expression `{text}`"), file, line)
            }
        }
    }

    fn eval_union(
        &self,
        parts: &[TypeExpr],
        file: &str,
        line: u32,
        subst: &TypeSubst,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        let mut nullable = false;
        let mut optional = false;
        let mut members: Vec<&TypeExpr> = Vec::new();
        for part in parts {
            match part {
                TypeExpr::Name(name) if name == "null" => nullable = true,
                TypeExpr::Name(name) if name == "undefined" => optional = true,
                other => members.push(other),
            }
        }

        let base = if members.is_empty() {
            WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Void,
                format: None,
                provenance: None,
            })
        } else if let Some(values) = members
            .iter()
            .map(|member| match member {
                TypeExpr::StrLit(value) => Some(value.clone()),
                _ => None,
            })
            .collect::<Option<Vec<String>>>()
        {
            enum_from_values(values, file, line)
        } else if members.len() == 1 {
            self.eval(members[0], file, line, subst, stack, depth + 1)
        } else {
            let mut types = Vec::new();
            for member in &members {
                let member_wire = self.eval(member, file, line, subst, stack, depth + 1);
                if matches!(member_wire, WireType::Unknown(_)) {
                    return unknown_type(
                        "A union arm is not resolvable, so the whole union stays unresolved"
                            .to_string(),
                        file,
                        line,
                    );
                }
                types.push(member_wire);
            }
            WireType::Union(UnionWireType {
                types,
                provenance: Some(ts_provenance(file, line, None)),
            })
        };

        wrap_nullish(base, nullable, optional, file, line)
    }

    fn eval_generic(
        &self,
        name: &str,
        args: &[TypeExpr],
        file: &str,
        line: u32,
        subst: &TypeSubst,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        match name {
            "Array" | "ReadonlyArray" => {
                if let Some(inner) = args.first() {
                    return WireType::Array(ArrayWireType {
                        element_type: Box::new(self.eval(
                            inner,
                            file,
                            line,
                            subst,
                            stack,
                            depth + 1,
                        )),
                        is_stream_or_flux: None,
                        provenance: Some(ts_provenance(file, line, None)),
                    });
                }
                return unknown_type(format!("`{name}` requires an element type"), file, line);
            }
            "Partial" | "Required" | "Readonly" | "NonNullable" => {
                let Some(inner) = args.first() else {
                    return unknown_type(format!("`{name}` requires a type argument"), file, line);
                };
                let expanded = self.eval(inner, file, line, subst, stack, depth + 1);
                if name == "NonNullable" {
                    return expanded;
                }
                let Some(mut object) = self.as_object(expanded, stack, depth + 1) else {
                    return unknown_type(
                        format!("`{name}<...>` was applied to a type without known properties"),
                        file,
                        line,
                    );
                };
                if name == "Partial" {
                    for prop in &mut object.properties {
                        prop.optional = true;
                    }
                } else if name == "Required" {
                    for prop in &mut object.properties {
                        prop.optional = false;
                    }
                }
                WireType::Object(object)
            }
            "Pick" | "Omit" => {
                if args.len() != 2 {
                    return unknown_type(
                        format!("`{name}` requires a type and a key union"),
                        file,
                        line,
                    );
                }
                let base = self.eval(&args[0], file, line, subst, stack, depth + 1);
                let Some(mut object) = self.as_object(base, stack, depth + 1) else {
                    return unknown_type(
                        format!("`{name}<...>` was applied to a type without known properties"),
                        file,
                        line,
                    );
                };
                let Some(keys) = literal_keys(&args[1]) else {
                    return unknown_type(
                        format!("`{name}<...>` keys are not a literal union"),
                        file,
                        line,
                    );
                };
                if name == "Pick" {
                    object
                        .properties
                        .retain(|prop| keys.contains(&prop.wire_name));
                } else {
                    object
                        .properties
                        .retain(|prop| !keys.contains(&prop.wire_name));
                }
                WireType::Object(object)
            }
            "AxiosResponse" | "HttpResponse" | "HttpEvent" => {
                let Some(inner) = args.first() else {
                    return unknown_type(format!("`{name}` requires a type argument"), file, line);
                };
                self.eval(inner, file, line, subst, stack, depth + 1)
            }
            "Record" | "Map" | "Promise" | "Observable" | "ReadonlyMap" => unknown_type(
                format!("Generic type `{name}<...>` is not expanded"),
                file,
                line,
            ),
            _ => {
                let Some(key) = self.resolve_ref(name, file) else {
                    return unknown_type(
                        format!(
                            "Generic type `{}<...>` could not be resolved in local type pool{}",
                            name,
                            self.import_note(name, file)
                        ),
                        file,
                        line,
                    );
                };
                if !self.aliases.contains_key(&key) {
                    let bound_args: Vec<TypeExpr> =
                        args.iter().map(|arg| bind_expr(arg, subst)).collect();
                    if let Some(decl) = self.generics.get(&key) {
                        return self.instantiate_generic(
                            &key,
                            decl,
                            &bound_args,
                            file,
                            line,
                            stack,
                            depth,
                        );
                    }
                    if self.pool.contains_key(&key) {
                        return WireType::Ref(RefWireType {
                            r#ref: key,
                            provenance: Some(ts_provenance(file, line, Some(name.to_string()))),
                        });
                    }
                    return unknown_type(
                        format!(
                            "`{}<...>` resolves to a declaration that is not a generic type alias",
                            name
                        ),
                        file,
                        line,
                    );
                }
                let bound: Vec<(TypeExpr, String, u32)> = args
                    .iter()
                    .map(|arg| (bind_expr(arg, subst), file.to_string(), line))
                    .collect();
                self.expand_alias(&key, bound, stack, depth + 1)
            }
        }
    }

    fn eval_intersection(
        &self,
        parts: &[TypeExpr],
        file: &str,
        line: u32,
        subst: &TypeSubst,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> WireType {
        let mut merged: Option<ObjectWireType> = None;
        for part in parts {
            let expanded = self.eval(part, file, line, subst, stack, depth + 1);
            let Some(object) = self.as_object(expanded, stack, depth + 1) else {
                return unknown_type(
                    "Intersection includes a type without known properties".to_string(),
                    file,
                    line,
                );
            };
            match &mut merged {
                None => merged = Some(object),
                Some(acc) => {
                    for prop in object.properties {
                        match acc
                            .properties
                            .iter_mut()
                            .find(|existing| existing.wire_name == prop.wire_name)
                        {
                            Some(existing) => {
                                // Intersection requires a property only if both sides
                                // require it, and the more specific type wins.
                                existing.optional = existing.optional && prop.optional;
                                if matches!(existing.r#type, WireType::Unknown(_))
                                    && !matches!(prop.r#type, WireType::Unknown(_))
                                {
                                    existing.r#type = prop.r#type;
                                }
                            }
                            None => acc.properties.push(prop),
                        }
                    }
                }
            }
        }
        match merged {
            Some(object) => WireType::Object(object),
            None => unknown_type("Empty type intersection".to_string(), file, line),
        }
    }

    fn as_object(
        &self,
        wt: WireType,
        stack: &mut Vec<String>,
        depth: usize,
    ) -> Option<ObjectWireType> {
        match wt {
            WireType::Object(object) => Some(object),
            WireType::Ref(reference) => {
                if let Some(WireType::Object(object)) = self.pool.get(&reference.r#ref) {
                    return Some(object.clone());
                }
                if self.aliases.contains_key(&reference.r#ref) {
                    if let WireType::Object(object) =
                        self.expand_alias(&reference.r#ref, Vec::new(), stack, depth + 1)
                    {
                        return Some(object);
                    }
                }
                None
            }
            _ => None,
        }
    }
}

fn primitive_scalar(name: &str) -> Option<PrimitiveScalar> {
    match name {
        "string" => Some(PrimitiveScalar::String),
        "number" => Some(PrimitiveScalar::Number),
        "boolean" => Some(PrimitiveScalar::Boolean),
        "void" | "null" | "undefined" => Some(PrimitiveScalar::Void),
        _ => None,
    }
}

fn generic_inner<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(name)?.trim_start();
    let inner = rest.strip_prefix('<')?.strip_suffix('>')?;
    if inner.trim().is_empty() {
        None
    } else {
        Some(inner)
    }
}

fn literal_keys(expr: &TypeExpr) -> Option<HashSet<String>> {
    match expr {
        TypeExpr::StrLit(value) => Some(HashSet::from([value.clone()])),
        TypeExpr::Union(parts) => {
            let mut keys = HashSet::new();
            for part in parts {
                keys.extend(literal_keys(part)?);
            }
            Some(keys)
        }
        _ => None,
    }
}

fn short_name(key: &str) -> &str {
    key.rsplit_once('#').map(|(_, name)| name).unwrap_or(key)
}

/// Resolve the type arguments a use site wrote against the bindings already in scope. Without
/// this, an outer parameter is passed by name into an inner declaration that happens to name its
/// own parameter the same way, and the two shadow each other into a self-referential binding.
fn bind_expr(expr: &TypeExpr, subst: &TypeSubst) -> TypeExpr {
    match expr {
        TypeExpr::Name(name) => match subst.get(name) {
            Some((bound, _, _)) => {
                if *bound == *expr {
                    expr.clone()
                } else {
                    bind_expr(bound, subst)
                }
            }
            None => expr.clone(),
        },
        TypeExpr::Array(inner) => TypeExpr::Array(Box::new(bind_expr(inner, subst))),
        TypeExpr::Generic(name, args) => TypeExpr::Generic(
            name.clone(),
            args.iter().map(|arg| bind_expr(arg, subst)).collect(),
        ),
        TypeExpr::Union(parts) => {
            TypeExpr::Union(parts.iter().map(|part| bind_expr(part, subst)).collect())
        }
        TypeExpr::Intersection(parts) => {
            TypeExpr::Intersection(parts.iter().map(|part| bind_expr(part, subst)).collect())
        }
        TypeExpr::Object(props) => TypeExpr::Object(
            props
                .iter()
                .map(|prop| PropExpr {
                    name: prop.name.clone(),
                    optional: prop.optional,
                    r#type: bind_expr(&prop.r#type, subst),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A stable identity for one instantiation, used only as a recursion guard. The bound
/// arguments are named differently at each use site, so `PageData<Image>` and `PageData<User>`
/// must not be treated as the same expansion.
fn instantiated_key(key: &str, args: &[TypeExpr]) -> String {
    let mut out = String::from(key);
    out.push('<');
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&type_expr_text(arg));
    }
    out.push('>');
    out
}

fn type_expr_text(expr: &TypeExpr) -> String {
    match expr {
        TypeExpr::Name(name) => name.clone(),
        TypeExpr::Object(_) => "object".to_string(),
        TypeExpr::Generic(name, args) => format!(
            "{}<{}>",
            name,
            args.iter()
                .map(type_expr_text)
                .collect::<Vec<_>>()
                .join(",")
        ),
        TypeExpr::Array(inner) => format!("{}[]", type_expr_text(inner)),
        TypeExpr::Union(parts) => parts
            .iter()
            .map(type_expr_text)
            .collect::<Vec<_>>()
            .join("|"),
        TypeExpr::Intersection(parts) => parts
            .iter()
            .map(type_expr_text)
            .collect::<Vec<_>>()
            .join("&"),
        TypeExpr::StrLit(value) => format!("'{value}'"),
        TypeExpr::NoAnnotation => String::new(),
        TypeExpr::Other(text) => text.clone(),
    }
}

/// Replace `type` alias placeholders with their expanded shape. Aliases that need type
/// arguments cannot be materialized on their own and stay explicitly unresolved.
fn materialize_type_aliases(
    pool: &mut BTreeMap<String, WireType>,
    aliases: &BTreeMap<String, AliasDef>,
    generics: &BTreeMap<String, GenericDecl>,
    import_maps: &BTreeMap<String, HashMap<String, ImportBinding>>,
) {
    if aliases.is_empty() {
        return;
    }
    let mut updates: Vec<(String, WireType)> = Vec::new();
    {
        let resolver = TypeResolver {
            pool,
            aliases,
            generics,
            import_maps,
            export_maps: None,
        };
        for (key, def) in aliases {
            if !def.params.is_empty() {
                if matches!(pool.get(key), Some(WireType::Object(object)) if !object.properties.is_empty())
                {
                    continue;
                }
                updates.push((
                    key.clone(),
                    unknown_type(
                        format!(
                            "Generic type alias `{}` is only expanded where its type arguments are known",
                            short_name(key)
                        ),
                        &def.file,
                        def.line,
                    ),
                ));
                continue;
            }
            updates.push((
                key.clone(),
                resolver.expand_alias(key, Vec::new(), &mut Vec::new(), 0),
            ));
        }
    }
    for (key, wt) in updates {
        pool.insert(key, wt);
    }
}

pub(crate) fn slice_node<'a>(node: Node, content: &'a str) -> &'a str {
    &content[node.start_byte()..node.end_byte()]
}

pub(crate) fn unquote_str(s: &str) -> String {
    let t = s.trim();
    if (t.starts_with('\'') && t.ends_with('\''))
        || (t.starts_with('"') && t.ends_with('"'))
        || (t.starts_with('`') && t.ends_with('`'))
    {
        if t.len() >= 2 {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

pub(crate) fn path_to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Directories that hold build output, dependencies, tests, or vendored code. Contracts
/// are extracted from the application's own client sources; sweeping these produces
/// phantom calls and can make a whole self-checkout look like a consumer.
const EXCLUDED_CLIENT_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "jspm_packages",
    "dist",
    "target",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".sajimora",
    ".tmp",
    ".tmp-extract",
    "test",
    "tests",
    "__tests__",
    "__mocks__",
    "__snapshots__",
    "e2e",
    "cypress",
    "playwright",
    "vendor",
    "third_party",
    "storybook-static",
];

fn is_test_or_story_source(name: &str) -> bool {
    [
        ".spec.ts",
        ".spec.tsx",
        ".spec.js",
        ".spec.jsx",
        ".spec.mts",
        ".spec.cts",
        ".spec.mjs",
        ".spec.cjs",
        ".spec.svelte",
        ".test.ts",
        ".test.tsx",
        ".test.js",
        ".test.jsx",
        ".test.mts",
        ".test.cts",
        ".test.mjs",
        ".test.cjs",
        ".test.svelte",
        ".stories.ts",
        ".stories.tsx",
        ".stories.js",
        ".stories.jsx",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

fn is_ts_family_source(name: &str) -> bool {
    [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

fn is_declaration_file(name: &str) -> bool {
    name.ends_with(".d.ts") || name.ends_with(".d.mts") || name.ends_with(".d.cts")
}

fn collect_ts_files(
    dir: &Path,
    files: &mut Vec<PathBuf>,
    vue_files: &mut Vec<PathBuf>,
) -> Result<()> {
    let mut visited = HashSet::new();
    walk_ts(dir, files, vue_files, &mut visited)
}

/// Walk for client sources that refuses a directory it has already entered, so a symlink or
/// junction aliasing an ancestor cannot make the traversal unbounded or re-emit the same call
/// site under an unreadable alias path.
fn walk_ts(
    dir: &Path,
    files: &mut Vec<PathBuf>,
    vue_files: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if !visited.insert(key) {
        return Ok(());
    }

    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if path.is_dir() {
            if EXCLUDED_CLIENT_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            // A nested checkout is a different repository with its own build and tests;
            // its calls are not this repository's consumer surface.
            if path.join(".git").exists() {
                continue;
            }
            walk_ts(&path, files, vue_files, visited)?;
        } else if path.is_file() {
            if name_str.ends_with(".vue") || name_str.ends_with(".svelte") {
                if !is_test_or_story_source(&name_str) {
                    vue_files.push(path);
                }
                continue;
            }
            if is_ts_family_source(&name_str)
                && !is_declaration_file(&name_str)
                && !name_str.ends_with(".min.js")
                && !is_test_or_story_source(&name_str)
            {
                files.push(path);
            }
        }
    }

    Ok(())
}

pub fn merge_frontend_payload(into: &mut FrontendContractPayload, from: FrontendContractPayload) {
    into.client_contracts.extend(from.client_contracts);
    into.client_contracts.sort_by(|a, b| {
        a.target_service_id
            .cmp(&b.target_service_id)
            .then(a.normalized_route.cmp(&b.normalized_route))
            .then(a.http_method.cmp(&b.http_method))
            .then(a.source_file.cmp(&b.source_file))
            .then(a.source_line.cmp(&b.source_line))
    });

    if let Some(from_pool) = from.type_pool {
        let pool = into
            .type_pool
            .get_or_insert_with(std::collections::BTreeMap::new);
        for (name, wire) in from_pool {
            pool.entry(name).or_insert(wire);
        }
    }

    if let Some(from_paths) = from.path_pool {
        let paths = into.path_pool.get_or_insert_with(Vec::new);
        paths.extend(from_paths);
        paths.sort();
        paths.dedup();
    }
}

pub fn merge_completeness(
    mut left: ArtifactCompleteness,
    right: ArtifactCompleteness,
) -> ArtifactCompleteness {
    let complete = left.complete && right.complete;
    left.blockers.extend(right.blockers);
    left.blockers
        .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
    left.blockers
        .dedup_by(|a, b| a.code == b.code && a.message == b.message && a.file == b.file);
    left.unresolved_endpoints.extend(right.unresolved_endpoints);
    left.unresolved_endpoints.sort();
    left.unresolved_endpoints.dedup();
    ArtifactCompleteness {
        complete: complete && left.blockers.is_empty() && left.unresolved_endpoints.is_empty(),
        unresolved_endpoints: left.unresolved_endpoints,
        blockers: left.blockers,
    }
}

pub fn build_merged_frontend_envelope(
    payload: FrontendContractPayload,
    completeness: ArtifactCompleteness,
    service_id: &str,
    revision: &str,
    client_profile: &str,
    config_fingerprint: Option<String>,
) -> Result<ContractArtifactEnvelope> {
    let envelope = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::FrontendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: format!("git-root:{service_id}"),
            service_id: service_id.to_string(),
            api_version: None,
            parent_commit: revision.to_string(),
            candidate_snapshot: revision.to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
            framework_profile: None,
            codec_profile: None,
            client_profile: Some(client_profile.to_string()),
            config_fingerprint,
        },
        completeness,
        signature: None,
        issued_at_unix: None,
        payload: ArtifactPayload::Frontend(payload),
        integrity: None,
        raw_value: None,
    };
    seal_envelope(envelope)
}

pub fn extract_frontend_envelope(
    repo_path: &Path,
    scan_dir: &Path,
    service_id: &str,
    target_service_id: &str,
    revision: &str,
) -> Result<ContractArtifactEnvelope> {
    if crate::provider::has_java_source(scan_dir) {
        if let Ok(java_extractor) =
            crate::java_routes::JavaRouteExtractor::new(repo_path.to_path_buf(), scan_dir)
        {
            if java_extractor.has_client_evidence() {
                let ts_extractor = TypeScriptRouteExtractor::new(repo_path.to_path_buf(), scan_dir)?;
                let (mut payload, ts_completeness) =
                    ts_extractor.extract_payload(service_id, target_service_id);
                let ts_contracts = payload.client_contracts.len();
                let java_config = java_extractor.config_fingerprint().to_string();
                let (java_payload, java_completeness) =
                    java_extractor.extract_client_payload(service_id, target_service_id);
                let java_contracts = java_payload.client_contracts.len();
                merge_frontend_payload(&mut payload, java_payload);
                let completeness = merge_completeness(ts_completeness, java_completeness);
                let (profile, fingerprint) = if java_contracts > 0 && ts_contracts == 0 {
                    ("JAVA_HTTP_CLIENT", Some(java_config))
                } else if java_contracts > 0 && ts_contracts > 0 {
                    (
                        "JAVA_AND_TYPESCRIPT",
                        Some("mixed:native-ts-fast".to_string()),
                    )
                } else {
                    ("STATIC_FETCH_V1", Some("native-ts-fast".to_string()))
                };
                return build_merged_frontend_envelope(
                    payload,
                    completeness,
                    service_id,
                    revision,
                    profile,
                    fingerprint,
                );
            }
        }
    }

    let extractor = TypeScriptRouteExtractor::new(repo_path.to_path_buf(), scan_dir)?;
    extractor.build_envelope(service_id, target_service_id, revision)
}
