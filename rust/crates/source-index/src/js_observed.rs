//! Plain-JavaScript observed evidence.
//!
//! Untyped clients do not declare a wire shape. This pass follows response values from
//! the HTTP call through local variables, destructuring, state setters, local helper
//! parameters and one-hop service wrappers, then records the property paths the source
//! actually reads. Request bodies are followed in the opposite direction: a wrapper's body
//! parameter is resolved back to what its callers pass.
//!
//! The output is deliberately not a `WireType`. A field the client reads is not a field
//! the producer is proven to emit, and a field it never reads is not required. The
//! comparison layer may only use these paths against a base→candidate producer delta, and
//! only when `guaranteed` is true.

use crate::ts_routes::{
    collect_client_alias_bindings, grammar_for, path_to_posix, resolve_import_module,
    strip_script_extension, unquote_str, RawClientCall, TsGrammar,
};
use contract_core::ir::{
    ObservedAccess, ObservedKind, ObservedRequestBody, ObservedRequestField,
    ObservedResponseEvidence, ObservedResponseStatus, SourceLanguage, SourceProvenance,
};
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser, Tree};

pub(crate) fn attach_js_observed_evidence(
    repo_root: &Path,
    source_files: &[PathBuf],
    calls: &mut [RawClientCall],
) {
    if calls.is_empty() || source_files.is_empty() {
        return;
    }
    // This pass re-parses sources. Typed Angular trees produce nothing here, so do not pay
    // for a second parse when every call already carries a declared response type.
    let needs_pass = calls
        .iter()
        .any(|c| c.response_type.is_none() || c.request_body_expr.is_some());
    if !needs_pass {
        return;
    }

    let mut anchors_by_file: HashMap<String, HashMap<usize, String>> = HashMap::new();
    let mut transports_by_file: HashMap<String, HashMap<usize, usize>> = HashMap::new();
    for call in calls.iter() {
        anchors_by_file
            .entry(call.file.clone())
            .or_default()
            .insert(call.anchor, call.http_method.clone());
        if let Some(transport) = call.transport_anchor {
            if transport != call.anchor {
                transports_by_file
                    .entry(call.file.clone())
                    .or_default()
                    .insert(call.anchor, transport);
            }
        }
    }

    let mut models: Vec<FileModel> = source_files
        .par_iter()
        .filter_map(|path| {
            let rel = path_to_posix(path.strip_prefix(repo_root).unwrap_or(path));
            let key = rel_path_key(path, repo_root);
            parse_model(
                path,
                rel,
                anchors_by_file.get(&key),
                transports_by_file.get(&key),
            )
        })
        .collect();
    models.sort_by(|a, b| a.file.cmp(&b.file));
    if models.is_empty() {
        return;
    }

    apply_anchor_clients(&mut models);

    let mut analyses = Vec::with_capacity(models.len());
    let mut next_scope_id = 1usize;
    for model in &models {
        analyses.push(analyze_file(model, &mut next_scope_id));
    }

    let clients: HashMap<(String, usize), ClientKind> = analyses
        .iter()
        .flat_map(|a| {
            a.anchor_clients
                .iter()
                .map(move |(anchor, kind)| ((a.file.clone(), *anchor), *kind))
        })
        .collect();

    let registry = WrapperRegistry::build(&analyses, &clients);
    let helper_summaries = HelperSummaries::build(&analyses);
    let composed = compose_helper_accesses(&analyses, &helper_summaries);

    let mut evidence: BTreeMap<(String, usize), Evidence> = BTreeMap::new();

    for access in analyses
        .iter()
        .flat_map(|a| a.accesses.iter())
        .chain(composed.iter())
    {
        add_access(&mut evidence, access, &clients, &registry);
    }

    for analysis in &analyses {
        for (anchor, usage) in &analysis.anchor_usage {
            let entry = evidence
                .entry((analysis.file.clone(), *anchor))
                .or_default();
            entry.request.extend(usage.body_facts.iter().cloned());
            entry.no_body |= usage.no_body;
            entry.discarded |= usage.discarded;
            entry.transport_read |= usage.transport_read;
            if usage.dynamic {
                entry.dynamic = true;
            }
        }

        for call in &analysis.calls {
            let Some(info) = registry.lookup_target(&call.target) else {
                continue;
            };
            let entry = evidence
                .entry((info.file.clone(), info.anchor))
                .or_default();
            entry.has_callers = true;
            entry.consumed_call |= !call.discarded;
            if let Some(index) = info.body_param {
                if let Some(arg) = call.arg_facts.get(index) {
                    entry.request.push(arg.clone());
                }
            }
        }
    }

    for call in calls.iter_mut() {
        let key = (call.file.clone(), call.anchor);
        let entry = evidence.get(&key);
        let wrapper = registry.by_anchor(&call.file, call.anchor);

        if call.response_type.is_none() {
            let status = if entry.is_some_and(|e| !e.accesses.is_empty()) {
                ObservedResponseStatus::Observed
            } else if wrapper.is_some_and(|w| w.exported && !w.has_callers) {
                ObservedResponseStatus::NoCallers
            } else if wrapper.is_some_and(|w| w.has_callers && !w.consumed_call)
                || entry.is_some_and(|e| e.discarded)
                || entry.is_some_and(|e| e.transport_read && e.accesses.is_empty())
            {
                ObservedResponseStatus::NotConsumed
            } else {
                ObservedResponseStatus::Inconclusive
            };

            let mut accesses: Vec<ObservedAccess> = Vec::new();
            if let Some(e) = entry {
                accesses = build_accesses(e);
            }

            let mut reasons: Vec<String> = Vec::new();
            if status == ObservedResponseStatus::Inconclusive {
                reasons.push(
                    "response is used, but its value cannot be followed to a property read"
                        .to_string(),
                );
                if entry.is_some_and(|e| e.dynamic) {
                    reasons.push("dynamic property access cannot be enumerated statically".into());
                }
            } else if status == ObservedResponseStatus::NoCallers {
                reasons.push("no scanned source calls this exported helper".to_string());
            } else if status == ObservedResponseStatus::NotConsumed {
                reasons
                    .push("the response value is discarded; no body shape is needed".to_string());
            } else if entry.is_some_and(|e| e.dynamic) {
                reasons.push(
                    "a dynamic property access is also present; observed paths are not exhaustive"
                        .to_string(),
                );
            }
            if status == ObservedResponseStatus::Inconclusive
                && wrapper.is_some_and(|w| w.has_callers && w.consumed_call)
            {
                reasons.push(
                    "callers consume the result but do not read a followable property".to_string(),
                );
            }
            reasons.sort();
            reasons.dedup();

            call.observed_response = Some(ObservedResponseEvidence {
                status,
                accesses,
                reason: if reasons.is_empty() {
                    None
                } else {
                    Some(reasons.join("; "))
                },
            });
        }

        if call.request_body_expr.is_some() || call.request_body_explicit_none {
            call.observed_request_body = Some(build_request_evidence(call, entry));
        }
    }
}

fn add_access(
    evidence: &mut BTreeMap<(String, usize), Evidence>,
    access: &AccessFact,
    clients: &HashMap<(String, usize), ClientKind>,
    registry: &WrapperRegistry,
) {
    let resolved = resolve_origin(&access.origin, clients, registry, 0, &access.file);
    for target in resolved {
        let entry = evidence
            .entry((target.file.clone(), target.anchor))
            .or_default();
        if target.path.is_empty() {
            continue;
        }
        entry.accesses.push(AccessRecord {
            path: target.path,
            kind: access.kind,
            guaranteed: !access.guarded && !target.advisory,
            alt_site: access.alt_site,
            file: access.file.clone(),
            line: access.line,
        });
    }
    if access.dynamic {
        for base in resolve_base(&access.origin, clients, registry, 0, &access.file) {
            evidence
                .entry((base.file, base.anchor))
                .or_default()
                .dynamic = true;
        }
    }
}

fn rel_path_key(path: &Path, repo_root: &Path) -> String {
    path_to_posix(path.strip_prefix(repo_root).unwrap_or(path))
}

fn parse_model(
    path: &Path,
    rel: String,
    anchors: Option<&HashMap<usize, String>>,
    transports: Option<&HashMap<usize, usize>>,
) -> Option<FileModel> {
    let anchors = anchors.cloned().unwrap_or_default();
    if rel.ends_with(".d.ts") || rel.ends_with(".d.mts") || rel.ends_with(".d.cts") {
        return None;
    }
    let (source, grammar_enum) = if rel.ends_with(".vue") || rel.ends_with(".svelte") {
        let content = fs::read_to_string(path).ok()?;
        let scan = if rel.ends_with(".svelte") {
            crate::ts_routes::scan_svelte_scripts(&content)
        } else {
            crate::ts_routes::scan_vue_scripts(&content)
        };
        (scan.masked, scan.grammar)
    } else {
        let source = fs::read_to_string(path).ok()?;
        let g = grammar_for(&rel);
        (source, g)
    };
    let grammar = match grammar_enum {
        TsGrammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        TsGrammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    };
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;
    let tree = parser.parse(&source, None)?;
    let parse_ok = !tree.root_node().has_error();
    let meta = scan_module_meta(tree.root_node(), &source);
    Some(FileModel {
        file: rel,
        source,
        tree,
        anchors,
        transports: transports.cloned().unwrap_or_default(),
        imports: meta.imports,
        module_export_names: meta.export_names,
        has_default_export: meta.has_default_export,
        default_export_ident: meta.default_export_ident,
        default_export_is_axios_create: meta.default_export_is_axios_create,
        axios_names: meta.axios_names,
        axios_instances: meta.axios_instances,
        default_client: ClientKind::Unknown,
        anchor_clients: HashMap::new(),
        parse_ok,
    })
}

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ImportBinding {
    module: String,
    imported: String,
}

#[derive(Default)]
struct ModuleMeta {
    imports: HashMap<String, ImportBinding>,
    export_names: HashSet<String>,
    has_default_export: bool,
    default_export_ident: Option<String>,
    default_export_is_axios_create: bool,
    axios_names: HashSet<String>,
    axios_instances: HashSet<String>,
}

fn scan_module_meta(root: Node, src: &str) -> ModuleMeta {
    let mut meta = ModuleMeta::default();
    collect_imports(root, src, &mut meta.imports);
    // A client handed through a wrapper call (`const superagent = promisify(_superagent, …)`)
    // is the same client, so its name joins the binding map before anything reads it.
    let aliases = collect_client_alias_bindings(
        root,
        src,
        &|name| {
            meta.imports
                .get(name)
                .map(|binding| (binding.module.clone(), binding.imported.clone()))
        },
        &|module| {
            is_axios_module(module)
                || is_superagent_module(module)
                || module.contains("angular/common/http")
        },
    );
    for alias in aliases {
        meta.imports.entry(alias.name).or_insert(ImportBinding {
            module: alias.module,
            imported: alias.imported,
        });
    }
    // A namespaced import is the common way a client is bound (`import axios from
    // "axios"`). Register local names before any `axios.create` analysis so exported
    // instances and default exports can be attributed.
    for (local, binding) in &meta.imports {
        if is_axios_module(&binding.module)
            && matches!(binding.imported.as_str(), "default" | "*" | "axios")
        {
            meta.axios_names.insert(local.clone());
        }
    }
    collect_export_names(root, src, &mut meta);
    collect_axios_bindings(root, src, &mut meta);
    meta
}

fn collect_imports(node: Node, src: &str, out: &mut HashMap<String, ImportBinding>) {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "import_statement" => {
                let Some(source) = node.child_by_field_name("source") else {
                    continue;
                };
                let module = unquote_str(node_text(source, src));
                if module.is_empty() {
                    continue;
                }
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.kind() != "import_clause" {
                        continue;
                    }
                    let mut inner = child.walk();
                    for clause in child.named_children(&mut inner) {
                        match clause.kind() {
                            "identifier" => {
                                out.insert(
                                    node_text(clause, src).trim().to_string(),
                                    ImportBinding {
                                        module: module.clone(),
                                        imported: "default".to_string(),
                                    },
                                );
                            }
                            "namespace_import" => {
                                let mut nc = clause.walk();
                                for id in clause.named_children(&mut nc) {
                                    if id.kind() == "identifier" {
                                        out.insert(
                                            node_text(id, src).trim().to_string(),
                                            ImportBinding {
                                                module: module.clone(),
                                                imported: "*".to_string(),
                                            },
                                        );
                                    }
                                }
                            }
                            "named_imports" => {
                                let mut nc = clause.walk();
                                for spec in clause.named_children(&mut nc) {
                                    if spec.kind() != "import_specifier" {
                                        continue;
                                    }
                                    let Some(name) = spec.child_by_field_name("name") else {
                                        continue;
                                    };
                                    let alias = spec.child_by_field_name("alias");
                                    let local = alias.unwrap_or(name);
                                    out.insert(
                                        node_text(local, src).trim().to_string(),
                                        ImportBinding {
                                            module: module.clone(),
                                            imported: node_text(name, src).trim().to_string(),
                                        },
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
        push_named_children(node, &mut stack);
    }
}

fn collect_export_names(node: Node, src: &str, meta: &mut ModuleMeta) {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if node.kind() == "export_statement" {
            let text = node_text(node, src).trim_start();
            if text.starts_with("export default") {
                meta.has_default_export = true;
                // `export default foo;` is an expression in the `value` field while
                // `export default function foo() {}` uses `declaration`.
                if let Some(value) = node
                    .child_by_field_name("value")
                    .or_else(|| node.child_by_field_name("declaration"))
                {
                    let value = unwrap_expression(value);
                    if is_function_node(value.kind()) {
                        if let Some(name) = value.child_by_field_name("name") {
                            meta.default_export_ident =
                                Some(node_text(name, src).trim().to_string());
                        }
                    } else if value.kind() == "call_expression" {
                        meta.default_export_is_axios_create =
                            callee_is_axios_create(value, src, &meta.axios_names);
                    } else if value.kind() == "identifier" {
                        meta.default_export_ident = Some(node_text(value, src).trim().to_string());
                    }
                }
            } else {
                if let Some(decl) = node.child_by_field_name("declaration") {
                    match decl.kind() {
                        "function_declaration" | "class_declaration" => {
                            if let Some(name) = decl.child_by_field_name("name") {
                                meta.export_names
                                    .insert(node_text(name, src).trim().to_string());
                            }
                        }
                        "lexical_declaration" | "variable_declaration" => {
                            let mut cursor = decl.walk();
                            for d in decl.named_children(&mut cursor) {
                                if d.kind() != "variable_declarator" {
                                    continue;
                                }
                                if let Some(name) = d.child_by_field_name("name") {
                                    if name.kind() == "identifier" {
                                        meta.export_names
                                            .insert(node_text(name, src).trim().to_string());
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let mut cursor = node.walk();
                for clause in node.named_children(&mut cursor) {
                    if clause.kind() != "export_clause" {
                        continue;
                    }
                    let mut cc = clause.walk();
                    for spec in clause.named_children(&mut cc) {
                        if spec.kind() != "export_specifier" {
                            continue;
                        }
                        if let Some(name) = spec.child_by_field_name("name") {
                            let name_text = node_text(name, src).trim().to_string();
                            let alias = spec
                                .child_by_field_name("alias")
                                .map(|a| node_text(a, src).trim().to_string());
                            if alias.as_deref() == Some("default") && name_text != "default" {
                                meta.has_default_export = true;
                                meta.default_export_ident = Some(name_text.clone());
                            }
                            meta.export_names.insert(name_text);
                        }
                    }
                }
            }
        }
        push_named_children(node, &mut stack);
    }
}

fn collect_axios_bindings(node: Node, src: &str, meta: &mut ModuleMeta) {
    let mut declarators = Vec::new();
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if node.kind() == "variable_declarator" {
            if let (Some(name), Some(value)) = (
                node.child_by_field_name("name"),
                node.child_by_field_name("value"),
            ) {
                if name.kind() == "identifier" {
                    declarators.push((name, value));
                }
            }
        }
        push_named_children(node, &mut stack);
    }
    declarators.sort_by_key(|(name, _)| name.start_byte());
    // Aliases may point at a binding declared later in source order inside nested scopes;
    // iterate until the set stops growing.
    for _ in 0..4 {
        let before = meta.axios_instances.len();
        for (name, value) in &declarators {
            let local = node_text(*name, src).trim().to_string();
            let value = unwrap_expression(*value);
            if callee_is_axios_create(value, src, &meta.axios_names) {
                meta.axios_instances.insert(local);
            } else if value.kind() == "identifier" {
                let source = node_text(value, src).trim();
                if meta.axios_names.contains(source) || meta.axios_instances.contains(source) {
                    meta.axios_instances.insert(local);
                }
            }
        }
        if meta.axios_instances.len() == before {
            break;
        }
    }
}

fn callee_is_axios_create(node: Node, src: &str, axios_names: &HashSet<String>) -> bool {
    if node.kind() != "call_expression" {
        return false;
    }
    let Some(callee) = node.child_by_field_name("function") else {
        return false;
    };
    if callee.kind() == "member_expression" {
        let Some(object) = callee.child_by_field_name("object") else {
            return false;
        };
        let Some(property) = callee.child_by_field_name("property") else {
            return false;
        };
        let object = node_text(object, src).trim();
        let property = node_text(property, src).trim();
        return property == "create" && (object == "axios" || axios_names.contains(object));
    }
    false
}

// ---------------------------------------------------------------------------
// Client classification
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ClientKind {
    Axios,
    /// Angular `HttpClient`-style clients: the response value is the body.
    Direct,
    Fetch,
    /// superagent: the payload is `res.body`, and the response object itself is transport.
    Superagent,
    Unknown,
}

fn apply_anchor_clients(models: &mut [FileModel]) {
    // A module's default export can itself be an axios instance created elsewhere.
    // Resolve that chain before classifying imports of it. Named exports carry the same
    // problem (`export const api = axios.create()`), so both are resolved to a fixpoint.
    let mut module_kinds: HashMap<String, ClientKind> = models
        .iter()
        .map(|m| {
            (
                strip_script_extension(&m.file).to_string(),
                ClientKind::Unknown,
            )
        })
        .collect();
    let mut export_kinds: HashMap<(String, String), ClientKind> = HashMap::new();
    for _ in 0..6 {
        let mut next = module_kinds.clone();
        let mut next_exports = export_kinds.clone();
        for model in models.iter() {
            let module = strip_script_extension(&model.file).to_string();
            let kind = default_client_kind(model, &module_kinds, &export_kinds);
            if kind != ClientKind::Unknown {
                next.insert(module.clone(), kind);
            }
            for name in &model.module_export_names {
                if let Some(kind) =
                    named_export_client_kind(model, name, &module_kinds, &export_kinds)
                {
                    next_exports.insert((module.clone(), name.clone()), kind);
                }
            }
        }
        if next == module_kinds && next_exports == export_kinds {
            break;
        }
        module_kinds = next;
        export_kinds = next_exports;
    }
    for model in models.iter_mut() {
        let module = strip_script_extension(&model.file).to_string();
        model.default_client = module_kinds
            .get(&module)
            .copied()
            .unwrap_or(ClientKind::Unknown);
        let anchors: Vec<usize> = model.anchors.keys().copied().collect();
        for anchor in anchors {
            let Some(call_node) = find_call_at(model.tree.root_node(), anchor) else {
                continue;
            };
            let mut kind = classify_call(model, call_node, &module_kinds, &export_kinds);
            if kind == ClientKind::Unknown {
                // A wrapper-hop site names its wrapper, not a transport. The envelope the
                // response arrives in belongs to the wrapper's own call, so classify that node
                // rather than keeping `data`/`body` as if they were wire fields.
                if let Some(transport) = model.transports.get(&anchor).copied() {
                    if let Some(node) = find_call_at(model.tree.root_node(), transport) {
                        kind = classify_call(model, node, &module_kinds, &export_kinds);
                    }
                }
            }
            model.anchor_clients.insert(anchor, kind);
        }
    }
}

fn named_export_client_kind(
    model: &FileModel,
    name: &str,
    module_kinds: &HashMap<String, ClientKind>,
    export_kinds: &HashMap<(String, String), ClientKind>,
) -> Option<ClientKind> {
    if model.axios_instances.contains(name) || model.axios_names.contains(name) {
        return Some(ClientKind::Axios);
    }
    let binding = model.imports.get(name)?;
    if is_axios_module(&binding.module) {
        return Some(ClientKind::Axios);
    }
    if is_superagent_module(&binding.module) {
        return Some(ClientKind::Superagent);
    }
    if binding.module.contains("angular/common/http") {
        return Some(ClientKind::Direct);
    }
    let resolved = resolve_import_module(&model.file, &binding.module)?;
    let module = strip_script_extension(&resolved).to_string();
    let kind = if binding.imported == "default" || binding.imported == "*" {
        module_kinds.get(&module).copied()
    } else {
        export_kinds
            .get(&(module, binding.imported.clone()))
            .copied()
    };
    kind.filter(|k| *k != ClientKind::Unknown)
}

fn default_client_kind(
    model: &FileModel,
    module_kinds: &HashMap<String, ClientKind>,
    export_kinds: &HashMap<(String, String), ClientKind>,
) -> ClientKind {
    if model.default_export_is_axios_create {
        return ClientKind::Axios;
    }
    if let Some(ident) = &model.default_export_ident {
        if model.axios_instances.contains(ident) || model.axios_names.contains(ident) {
            return ClientKind::Axios;
        }
        if let Some(binding) = model.imports.get(ident) {
            if binding.imported == "default" || binding.imported == "*" {
                if is_axios_module(&binding.module) {
                    return ClientKind::Axios;
                }
                if is_superagent_module(&binding.module) {
                    return ClientKind::Superagent;
                }
                if binding.module.contains("angular/common/http") {
                    return ClientKind::Direct;
                }
                if let Some(resolved) = resolve_import_module(&model.file, &binding.module) {
                    let module = strip_script_extension(&resolved).to_string();
                    if let Some(kind) = module_kinds.get(&module) {
                        return *kind;
                    }
                }
            } else if let Some(resolved) = resolve_import_module(&model.file, &binding.module) {
                let module = strip_script_extension(&resolved).to_string();
                if let Some(kind) = export_kinds.get(&(module, binding.imported.clone())) {
                    return *kind;
                }
            }
        }
    }
    if !model.has_default_export
        && model
            .imports
            .values()
            .any(|b| b.module.contains("angular/common/http"))
    {
        return ClientKind::Direct;
    }
    ClientKind::Unknown
}

fn classify_call(
    model: &FileModel,
    call_node: Node,
    module_kinds: &HashMap<String, ClientKind>,
    export_kinds: &HashMap<(String, String), ClientKind>,
) -> ClientKind {
    let Some(callee) = call_node.child_by_field_name("function") else {
        return ClientKind::Unknown;
    };
    let callee = unwrap_expression(callee);
    match callee.kind() {
        "identifier" => {
            let name = node_text(callee, &model.source).trim();
            if name == "fetch" {
                return ClientKind::Fetch;
            }
            if model.axios_names.contains(name) || model.axios_instances.contains(name) {
                return ClientKind::Axios;
            }
            if let Some(binding) = model.imports.get(name) {
                return binding_client_kind(model, binding, module_kinds, export_kinds);
            }
            ClientKind::Unknown
        }
        "member_expression" => {
            let Some(object) = callee.child_by_field_name("object") else {
                return ClientKind::Unknown;
            };
            let object = unwrap_expression(object);
            let object_text = node_text(object, &model.source).trim();
            let lookup = object_text.strip_prefix("this.").unwrap_or(object_text);
            if lookup == "axios" || model.axios_names.contains(lookup) {
                return ClientKind::Axios;
            }
            if lookup.ends_with("http") {
                return ClientKind::Direct;
            }
            if let Some(binding) = model.imports.get(lookup) {
                let kind = binding_client_kind(model, binding, module_kinds, export_kinds);
                if kind != ClientKind::Unknown {
                    return kind;
                }
            }
            if model.axios_instances.contains(lookup) {
                return ClientKind::Axios;
            }
            ClientKind::Unknown
        }
        _ => ClientKind::Unknown,
    }
}

fn binding_client_kind(
    model: &FileModel,
    binding: &ImportBinding,
    module_kinds: &HashMap<String, ClientKind>,
    export_kinds: &HashMap<(String, String), ClientKind>,
) -> ClientKind {
    if is_axios_module(&binding.module) {
        return ClientKind::Axios;
    }
    if is_superagent_module(&binding.module) {
        return ClientKind::Superagent;
    }
    if binding.module.contains("angular/common/http") {
        return ClientKind::Direct;
    }
    if let Some(resolved) = resolve_import_module(&model.file, &binding.module) {
        let module = strip_script_extension(&resolved).to_string();
        if binding.imported == "default" || binding.imported == "*" {
            if let Some(kind) = module_kinds.get(&module) {
                return *kind;
            }
        } else if let Some(kind) = export_kinds.get(&(module, binding.imported.clone())) {
            return *kind;
        }
    }
    ClientKind::Unknown
}

fn is_axios_module(module: &str) -> bool {
    module == "axios" || module.starts_with("axios/")
}

/// `superagent-promise` and similar packages wrap the client rather than being one, so only
/// the exact module (or a path into it) names superagent.
fn is_superagent_module(module: &str) -> bool {
    module == "superagent" || module.starts_with("superagent/")
}

fn find_node_at(root: Node, byte: usize) -> Option<Node> {
    if root.start_byte() > byte || root.end_byte() <= byte {
        return None;
    }
    let mut node = root;
    loop {
        let mut next = None;
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.start_byte() <= byte && child.end_byte() > byte {
                next = Some(child);
                break;
            }
        }
        match next {
            Some(child) if child.id() != node.id() => node = child,
            _ => return Some(node),
        }
    }
}

/// The anchor recorded by route extraction is a call expression's start byte, but that
/// byte is usually shared by the callee's receiver, so the deepest node is an identifier.
/// Ascend to the enclosing call expression that begins exactly at the anchor.
fn find_call_at(root: Node, byte: usize) -> Option<Node> {
    let mut node = find_node_at(root, byte)?;
    loop {
        if node.kind() == "call_expression" && node.start_byte() == byte {
            return Some(node);
        }
        node = node.parent()?;
    }
}

// ---------------------------------------------------------------------------
// File model and analysis output
// ---------------------------------------------------------------------------

struct FileModel {
    file: String,
    source: String,
    tree: Tree,
    anchors: HashMap<usize, String>,
    /// Call sites published through a wrapper hop, mapped to the wrapper's own client call.
    transports: HashMap<usize, usize>,
    imports: HashMap<String, ImportBinding>,
    module_export_names: HashSet<String>,
    has_default_export: bool,
    default_export_ident: Option<String>,
    default_export_is_axios_create: bool,
    axios_names: HashSet<String>,
    axios_instances: HashSet<String>,
    default_client: ClientKind,
    anchor_clients: HashMap<usize, ClientKind>,
    parse_ok: bool,
}

struct FileAnalysis {
    file: String,
    accesses: Vec<AccessFact>,
    scopes: Vec<FunctionScope>,
    calls: Vec<CallFact>,
    anchor_usage: HashMap<usize, AnchorUsage>,
    anchor_clients: HashMap<usize, ClientKind>,
}

#[derive(Clone, Debug, PartialEq)]
enum Origin {
    /// The transport response value (axios response, fetch Response).
    Http {
        anchor: usize,
    },
    /// The wire body (axios `data`, fetch `json()`, Angular direct response).
    Body {
        anchor: usize,
    },
    /// The wire body of a transport value produced by a wrapper: `res.json()` where `res`
    /// came from an imported helper rather than from this file's own `fetch` call.
    AwaitBody(Box<Origin>),
    Path {
        base: Box<Origin>,
        path: String,
    },
    Param {
        scope: usize,
        index: usize,
    },
    /// A call to a local or imported helper. Resolution decides whether it is a wrapper.
    Call {
        local: Option<usize>,
        module: String,
        name: String,
    },
    Unknown,
    Union(Vec<Origin>),
}

impl Origin {
    fn union(self, other: Origin) -> Origin {
        let mut types = match self {
            Origin::Union(t) => t,
            one => vec![one],
        };
        match other {
            Origin::Union(t) => types.extend(t),
            one => types.push(one),
        }
        types.retain(|t| !matches!(t, Origin::Unknown));
        types.sort_by_key(origin_sort_key);
        types.dedup();
        match types.len() {
            0 => Origin::Unknown,
            1 => types.pop().unwrap(),
            _ => Origin::Union(types),
        }
    }
}

fn origin_sort_key(origin: &Origin) -> String {
    match origin {
        Origin::Http { anchor } => format!("0:{}", anchor),
        Origin::Body { anchor } => format!("1:{}", anchor),
        Origin::AwaitBody(base) => format!("6:{}", origin_sort_key(base)),
        Origin::Path { base, path } => format!("2:{}:{}", origin_sort_key(base), path),
        Origin::Param { scope, index } => format!("3:{}:{}", scope, index),
        Origin::Call {
            local,
            module,
            name,
        } => format!("4:{:?}:{}:{}", local, module, name),
        Origin::Unknown => "9".to_string(),
        Origin::Union(types) => format!(
            "5:{:?}",
            types.iter().map(origin_sort_key).collect::<Vec<_>>()
        ),
    }
}

#[derive(Clone, Debug)]
struct ValueRef {
    origin: Origin,
    guarded: bool,
    dynamic: bool,
}

impl Default for ValueRef {
    fn default() -> Self {
        ValueRef {
            origin: Origin::Unknown,
            guarded: false,
            dynamic: false,
        }
    }
}

impl ValueRef {
    fn unknown() -> Self {
        Self::default()
    }
}

#[derive(Clone)]
struct AccessFact {
    origin: Origin,
    kind: Option<ObservedKind>,
    guarded: bool,
    alt_site: Option<usize>,
    dynamic: bool,
    line: u32,
    file: String,
}

#[derive(Default, Clone)]
struct AnchorUsage {
    body_facts: Vec<ArgFact>,
    body_param: Option<usize>,
    no_body: bool,
    discarded: bool,
    transport_read: bool,
    dynamic: bool,
}

#[derive(Clone)]
struct FunctionScope {
    id: usize,
    name: Option<String>,
    export_names: Vec<String>,
    module_level: bool,
    file: String,
    returns: Vec<ValueRef>,
    body_params: Vec<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CallTarget {
    Local(usize),
    Imported { module: String, name: String },
}

#[derive(Clone)]
struct CallFact {
    target: CallTarget,
    args: Vec<ValueRef>,
    arg_facts: Vec<ArgFact>,
    guarded: bool,
    alt_site: Option<usize>,
    discarded: bool,
    line: u32,
    file: String,
}

#[derive(Clone, Debug)]
enum ArgKind {
    Object,
    Scalar(ObservedKind),
    Nullish,
    Dynamic,
}

#[derive(Clone, Debug)]
struct ArgFact {
    kind: ArgKind,
    fields: Vec<(String, Option<ObservedKind>)>,
    complete: bool,
    line: u32,
    file: String,
    reason: Option<String>,
}

impl ArgFact {
    fn dynamic(file: &str, line: u32, reason: &str) -> Self {
        ArgFact {
            kind: ArgKind::Dynamic,
            fields: vec![],
            complete: false,
            line,
            file: file.to_string(),
            reason: Some(reason.to_string()),
        }
    }

    fn nullish(file: &str, line: u32) -> Self {
        ArgFact {
            kind: ArgKind::Nullish,
            fields: vec![],
            complete: true,
            line,
            file: file.to_string(),
            reason: None,
        }
    }
}

#[derive(Clone)]
struct Binding {
    origin: Origin,
    guarded: bool,
    value: Option<ArgFact>,
}

impl Default for Binding {
    fn default() -> Self {
        Binding {
            origin: Origin::Unknown,
            guarded: false,
            value: None,
        }
    }
}

#[derive(Default)]
struct Env {
    vars: HashMap<String, Binding>,
    functions: HashMap<String, usize>,
    setters: HashMap<String, String>,
}

#[derive(Clone, Copy)]
enum GuardKind {
    Fallback,
    Conditional,
}

struct Guard {
    kind: GuardKind,
    site: usize,
}

struct Walker<'a> {
    model: &'a FileModel,
    envs: Vec<Env>,
    guards: Vec<Guard>,
    accesses: Vec<AccessFact>,
    scopes: BTreeMap<usize, FunctionScope>,
    calls: Vec<CallFact>,
    anchor_usage: HashMap<usize, AnchorUsage>,
    current_scope: usize,
    anon_depth: usize,
    /// One frame per inline callback being visited, holding the values its `return`
    /// statements produced. A `.then(...)` chain continues with that value.
    anon_returns: Vec<Vec<ValueRef>>,
    /// Whether each function frame on the stack is an inline callback, so a named function
    /// nested inside one cannot donate its returns to the callback's chain.
    fn_stack: Vec<bool>,
    next_scope_id: &'a mut usize,
    /// Module-level function declarations by byte offset. Function declarations are
    /// hoisted, so calls that appear before the declaration must still resolve.
    preassigned: HashMap<usize, usize>,
    /// Current AST recursion depth. A generated file can hold an expression nested
    /// thousands of levels deep (a long string concatenation is the common shape), and
    /// an unbounded recursive walk over it overflows the stack.
    depth: usize,
}

/// Deep enough for real code, far below the stack budget of the recursive walker.
const MAX_AST_DEPTH: usize = 128;

fn analyze_file(model: &FileModel, next_scope_id: &mut usize) -> FileAnalysis {
    let mut walker = Walker {
        model,
        envs: vec![Env::default()],
        guards: vec![],
        accesses: vec![],
        scopes: BTreeMap::new(),
        calls: vec![],
        anchor_usage: HashMap::new(),
        current_scope: 0,
        anon_depth: 0,
        anon_returns: Vec::new(),
        fn_stack: Vec::new(),
        next_scope_id,
        preassigned: HashMap::new(),
        depth: 0,
    };
    if model.parse_ok {
        walker.preregister_functions(model.tree.root_node());
        walker.visit(model.tree.root_node());
    }
    let scopes: Vec<FunctionScope> = walker.scopes.into_values().collect();
    let anchor_clients = model.anchor_clients.clone();
    FileAnalysis {
        file: model.file.clone(),
        accesses: walker.accesses,
        scopes,
        calls: walker.calls,
        anchor_usage: walker.anchor_usage,
        anchor_clients,
    }
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

impl<'a> Walker<'a> {
    fn src(&self) -> &str {
        &self.model.source
    }

    fn visit(&mut self, node: Node) {
        if self.depth >= MAX_AST_DEPTH {
            return;
        }
        self.depth += 1;
        self.visit_node(node);
        self.depth -= 1;
    }

    fn visit_node(&mut self, node: Node) {
        match node.kind() {
            "program" | "statement_block" => self.visit_children(node),
            "lexical_declaration" | "variable_declaration" => self.visit_declaration(node),
            "expression_statement" => {
                if let Some(expr) = node.named_child(0) {
                    self.visit_expr(expr);
                }
            }
            "return_statement" => {
                if let Some(value) = node.named_child(0) {
                    let vr = self.visit_expr(value);
                    if self.fn_stack.last().copied().unwrap_or(false) {
                        if let Some(frame) = self.anon_returns.last_mut() {
                            frame.push(vr);
                        }
                    } else if self.anon_depth == 0 && self.current_scope != 0 {
                        if let Some(scope) = self.scopes.get_mut(&self.current_scope) {
                            scope.returns.push(vr);
                        }
                    }
                }
            }
            "if_statement" => {
                if let Some(condition) = node.child_by_field_name("condition") {
                    self.visit_expr(condition);
                }
                let site = node.start_byte();
                let len = self.guards.len();
                self.guards.push(Guard {
                    kind: GuardKind::Conditional,
                    site,
                });
                if let Some(consequence) = node.child_by_field_name("consequence") {
                    self.visit(consequence);
                }
                if let Some(alternative) = node.child_by_field_name("alternative") {
                    self.visit(alternative);
                }
                self.guards.truncate(len);
            }
            "switch_statement" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.visit_expr(value);
                }
                let site = node.start_byte();
                let len = self.guards.len();
                self.guards.push(Guard {
                    kind: GuardKind::Conditional,
                    site,
                });
                if let Some(body) = node.child_by_field_name("body") {
                    self.visit(body);
                }
                self.guards.truncate(len);
            }
            "function_declaration" => {
                let name = node
                    .child_by_field_name("name")
                    .map(|n| node_text(n, self.src()).trim().to_string());
                if let Some(name) = name {
                    let exports = self.export_names_for(&node, &name);
                    let preset = self.preassigned.get(&node.start_byte()).copied();
                    self.enter_named_function(node, name, exports, self.current_scope == 0, preset);
                }
            }
            "class_declaration" | "class" => {
                if let Some(body) = node.child_by_field_name("body") {
                    self.visit(body);
                }
            }
            "class_body" => self.visit_children(node),
            "method_definition" => {
                let name = node
                    .child_by_field_name("name")
                    .map(|n| node_text(n, self.src()).trim().to_string());
                if let Some(name) = name {
                    self.enter_named_function(node, name, vec![], false, None);
                }
            }
            "public_field_definition" | "property_definition" | "field_definition" => {
                if let Some(value) = node.child_by_field_name("value") {
                    if is_function_node(value.kind()) {
                        let name = node
                            .child_by_field_name("name")
                            .map(|n| node_text(n, self.src()).trim().to_string());
                        if let Some(name) = name {
                            self.enter_named_function(value, name, vec![], false, None);
                            return;
                        }
                    }
                    self.visit_expr(value);
                }
            }
            "export_statement" => {
                if let Some(decl) = node.child_by_field_name("declaration") {
                    if is_function_node(decl.kind()) {
                        let name = decl
                            .child_by_field_name("name")
                            .map(|n| node_text(n, self.src()).trim().to_string())
                            .unwrap_or_else(|| "default".to_string());
                        let mut exports = self.export_names_for(&node, &name);
                        if node_text(node, self.src())
                            .trim_start()
                            .starts_with("export default")
                        {
                            exports = vec!["default".to_string()];
                        }
                        let preset = self.preassigned.get(&decl.start_byte()).copied();
                        self.enter_named_function(
                            decl,
                            name,
                            exports,
                            self.current_scope == 0,
                            preset,
                        );
                    } else {
                        self.visit(decl);
                    }
                } else if let Some(value) = node.named_child(0) {
                    self.visit_expr(value);
                }
            }
            "import_statement" | "empty_statement" => {}
            "try_statement" => self.visit_children(node),
            "for_statement" | "for_in_statement" | "while_statement" | "do_statement" => {
                self.visit_children(node)
            }
            "throw_statement" => {
                if let Some(value) = node.named_child(0) {
                    self.visit_expr(value);
                }
            }
            "labeled_statement" => {
                if let Some(body) = node.child_by_field_name("body") {
                    self.visit(body);
                }
            }
            _ => {
                self.visit_expr(node);
            }
        }
    }

    fn visit_children(&mut self, node: Node) {
        let mut cursor = node.walk();
        let children: Vec<Node> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    fn visit_declaration(&mut self, node: Node) {
        let mut cursor = node.walk();
        let declarators: Vec<Node> = node
            .named_children(&mut cursor)
            .filter(|n| n.kind() == "variable_declarator")
            .collect();
        for declarator in declarators {
            self.visit_declarator(declarator);
        }
    }

    fn visit_declarator(&mut self, node: Node) {
        let name = node.child_by_field_name("name");
        let value = node.child_by_field_name("value");
        let Some(name) = name else { return };

        let is_state_hook = value.map(|v| self.is_use_state_call(v)).unwrap_or(false);
        if is_state_hook && matches!(name.kind(), "array_pattern") {
            let names = array_pattern_names(name, self.src());
            let state = names.first().cloned().unwrap_or_default();
            let setter = names.get(1).cloned().unwrap_or_default();
            if !state.is_empty() && !setter.is_empty() {
                if let Some(env) = self.envs.last_mut() {
                    env.setters.insert(setter, state.clone());
                }
                self.bind_var(
                    state,
                    Binding {
                        origin: Origin::Unknown,
                        guarded: true,
                        value: None,
                    },
                );
            }
            if let Some(value) = value {
                self.visit_expr(value);
            }
            return;
        }

        let vr = match value {
            Some(value) if is_function_node(value.kind()) => {
                if name.kind() == "identifier" {
                    let local = node_text(name, self.src()).trim().to_string();
                    let exports = self.export_names_for(&node, &local);
                    // The function scope is registered by name in the current environment;
                    // the variable itself carries no value origin.
                    self.enter_named_function(
                        value,
                        local.clone(),
                        exports,
                        self.current_scope == 0,
                        None,
                    );
                    self.bind_var(local, Binding::default());
                    return;
                }
                ValueRef::unknown()
            }
            Some(value) => self.visit_expr(value),
            None => ValueRef::unknown(),
        };

        let fact = value.and_then(|v| self.literal_fact(v));
        self.bind_pattern(name, &vr.origin, vr.guarded, fact);
    }

    fn is_use_state_call(&self, node: Node) -> bool {
        let node = unwrap_expression(node);
        if node.kind() != "call_expression" {
            return false;
        }
        let Some(callee) = node.child_by_field_name("function") else {
            return false;
        };
        let callee = node_text(callee, self.src()).trim();
        let last = callee.rsplit('.').next().unwrap_or(callee);
        last.starts_with("use") && last.ends_with("State")
    }

    fn bind_pattern(
        &mut self,
        pattern: Node,
        origin: &Origin,
        guarded: bool,
        fact: Option<ArgFact>,
    ) {
        let pattern = unwrap_parameter(pattern);
        match pattern.kind() {
            "identifier" => {
                let name = node_text(pattern, self.src()).trim().to_string();
                let mut binding = Binding {
                    origin: origin.clone(),
                    guarded,
                    value: fact,
                };
                if binding.value.is_none() {
                    if let Some(existing) = self.lookup_var(&name).and_then(|b| b.value.clone()) {
                        binding.value = Some(existing);
                    }
                }
                self.bind_var(name, binding);
            }
            "object_pattern" => {
                let mut cursor = pattern.walk();
                for child in pattern.named_children(&mut cursor) {
                    match child.kind() {
                        "pair_pattern" => {
                            let Some(key) = child.child_by_field_name("key") else {
                                continue;
                            };
                            let Some(value) = child.child_by_field_name("value") else {
                                continue;
                            };
                            let name = unquote_str(node_text(key, self.src()).trim());
                            if name.is_empty() || name.contains('[') {
                                self.mark_dynamic(
                                    origin,
                                    guarded,
                                    child.start_position().row as u32 + 1,
                                );
                                continue;
                            }
                            let field = with_key(origin.clone(), &name);
                            self.record_soft_field(&field, child.start_position().row as u32 + 1);
                            self.bind_pattern(value, &field, guarded, None);
                        }
                        "shorthand_property_identifier_pattern" => {
                            let name = node_text(child, self.src()).trim().to_string();
                            let field = with_key(origin.clone(), &name);
                            self.record_soft_field(&field, child.start_position().row as u32 + 1);
                            self.bind_pattern(child, &field, guarded, None);
                        }
                        "object_assignment_pattern" => {
                            let Some(left) = child.child_by_field_name("left") else {
                                continue;
                            };
                            let Some(name) = object_key_name(left, self.src()) else {
                                continue;
                            };
                            let field = with_key(origin.clone(), &name);
                            self.record_soft_field(&field, child.start_position().row as u32 + 1);
                            self.bind_pattern(left, &field, true, None);
                        }
                        "rest_pattern" => {
                            self.mark_dynamic(
                                origin,
                                guarded,
                                child.start_position().row as u32 + 1,
                            );
                            if let Some(inner) = child.named_child(0) {
                                self.bind_pattern(inner, &Origin::Unknown, guarded, None);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "array_pattern" => {
                let mut cursor = pattern.walk();
                for child in pattern.named_children(&mut cursor) {
                    if child.kind() == "rest_pattern" {
                        self.mark_dynamic(origin, guarded, child.start_position().row as u32 + 1);
                        if let Some(inner) = child.named_child(0) {
                            self.bind_pattern(inner, &Origin::Unknown, guarded, None);
                        }
                        continue;
                    }
                    let element = with_segment(origin.clone(), "[]");
                    self.bind_pattern(child, &element, guarded, None);
                }
            }
            "assignment_pattern" => {
                let Some(left) = child_left(pattern) else {
                    return;
                };
                self.bind_pattern(left, origin, true, fact);
            }
            "rest_pattern" => {
                if let Some(inner) = pattern.named_child(0) {
                    self.bind_pattern(inner, origin, guarded, fact);
                }
            }
            _ => {}
        }
    }

    fn record_soft_field(&mut self, origin: &Origin, line: u32) {
        self.push_origin_access(origin.clone(), true, None, line, false);
    }

    fn mark_dynamic(&mut self, origin: &Origin, _guarded: bool, line: u32) {
        self.accesses.push(AccessFact {
            origin: origin.clone(),
            kind: None,
            guarded: true,
            alt_site: None,
            dynamic: true,
            line,
            file: self.model.file.clone(),
        });
    }

    fn bind_var(&mut self, name: String, binding: Binding) {
        if let Some(env) = self.envs.last_mut() {
            env.vars.insert(name, binding);
        }
    }

    fn lookup_var(&self, name: &str) -> Option<&Binding> {
        for env in self.envs.iter().rev() {
            if let Some(binding) = env.vars.get(name) {
                return Some(binding);
            }
        }
        None
    }

    fn lookup_function(&self, name: &str) -> Option<usize> {
        for env in self.envs.iter().rev() {
            if let Some(id) = env.functions.get(name) {
                return Some(*id);
            }
        }
        None
    }

    fn lookup_setter(&self, name: &str) -> Option<String> {
        for env in self.envs.iter().rev() {
            if let Some(state) = env.setters.get(name) {
                return Some(state.clone());
            }
        }
        None
    }

    fn set_state_origin(&mut self, state: &str, origin: Origin) {
        for env in self.envs.iter_mut().rev() {
            if let Some(binding) = env.vars.get_mut(state) {
                binding.origin = if matches!(binding.origin, Origin::Unknown) {
                    origin
                } else {
                    std::mem::replace(&mut binding.origin, Origin::Unknown).union(origin)
                };
                binding.guarded = true;
                return;
            }
        }
    }

    fn export_names_for(&self, node: &Node, name: &str) -> Vec<String> {
        let mut current = Some(*node);
        let mut depth = 0;
        while let Some(n) = current {
            if n.kind() == "export_statement" {
                let text = node_text(n, self.src()).trim_start();
                if text.starts_with("export default") {
                    return vec!["default".to_string()];
                }
                let mut names = Vec::new();
                if self.current_scope == 0 && self.model.module_export_names.contains(name) {
                    names.push(name.to_string());
                }
                if names.is_empty() {
                    names.push(name.to_string());
                }
                return names;
            }
            current = n.parent();
            depth += 1;
            if depth > 5 {
                break;
            }
        }
        if self.current_scope == 0 && self.model.module_export_names.contains(name) {
            vec![name.to_string()]
        } else {
            vec![]
        }
    }

    fn preregister_functions(&mut self, root: Node) {
        let mut cursor = root.walk();
        let children: Vec<Node> = root.named_children(&mut cursor).collect();
        for child in children {
            let mut export_default = false;
            let mut decl = child;
            if child.kind() == "export_statement" {
                export_default = node_text(child, self.src())
                    .trim_start()
                    .starts_with("export default");
                match child.child_by_field_name("declaration") {
                    Some(node) if node.kind() == "function_declaration" => decl = node,
                    _ => continue,
                }
            }
            if decl.kind() != "function_declaration" {
                continue;
            }
            let Some(name_node) = decl.child_by_field_name("name") else {
                continue;
            };
            let name = node_text(name_node, self.src()).trim().to_string();
            let exports = if export_default {
                vec!["default".to_string()]
            } else {
                self.export_names_for(&decl, &name)
            };
            let id = *self.next_scope_id;
            *self.next_scope_id += 1;
            self.scopes.insert(
                id,
                FunctionScope {
                    id,
                    name: Some(name.clone()),
                    export_names: exports,
                    module_level: true,
                    file: self.model.file.clone(),
                    returns: vec![],
                    body_params: vec![],
                },
            );
            self.preassigned.insert(decl.start_byte(), id);
            self.envs[0].functions.insert(name, id);
        }
    }

    fn enter_named_function(
        &mut self,
        fn_node: Node,
        name: String,
        export_names: Vec<String>,
        module_level: bool,
        preset: Option<usize>,
    ) -> usize {
        let id = match preset {
            Some(id) => id,
            None => {
                let id = *self.next_scope_id;
                *self.next_scope_id += 1;
                self.scopes.insert(
                    id,
                    FunctionScope {
                        id,
                        name: Some(name.clone()),
                        export_names,
                        module_level,
                        file: self.model.file.clone(),
                        returns: vec![],
                        body_params: vec![],
                    },
                );
                id
            }
        };
        if let Some(env) = self.envs.last_mut() {
            env.functions.insert(name, id);
        }
        let previous_scope = self.current_scope;
        let previous_anon = self.anon_depth;
        let previous_guards = self.guards.len();
        self.current_scope = id;
        self.anon_depth = 0;
        self.guards.clear();
        self.envs.push(Env::default());
        self.fn_stack.push(false);
        self.bind_params(fn_node, Some(id));
        if let Some(body) = function_body(fn_node) {
            if body.kind() == "statement_block" {
                self.visit(body);
            } else {
                self.visit_expr(body);
            }
        }
        self.fn_stack.pop();
        self.envs.pop();
        self.guards.truncate(previous_guards);
        self.current_scope = previous_scope;
        self.anon_depth = previous_anon;
        id
    }

    fn enter_callback(
        &mut self,
        fn_node: Node,
        param_origins: &[Origin],
        guarded: bool,
    ) -> ValueRef {
        let previous_guards = self.guards.len();
        self.guards.clear();
        self.anon_depth += 1;
        self.envs.push(Env::default());
        self.fn_stack.push(true);
        self.anon_returns.push(Vec::new());
        self.bind_callback_params(fn_node, param_origins, guarded);
        let body = match function_body(fn_node) {
            Some(body) => body,
            None => {
                self.leave_callback(previous_guards);
                return ValueRef::unknown();
            }
        };
        let returned = if body.kind() == "statement_block" {
            self.visit(body);
            self.collect_callback_returns()
        } else {
            self.visit_expr(body)
        };
        self.leave_callback(previous_guards);
        returned
    }

    /// A callback's value is whatever its `return` statements produce; nothing returned means
    /// nothing flows on, so a chain over it cannot be followed.
    fn collect_callback_returns(&mut self) -> ValueRef {
        let returns = self
            .anon_returns
            .last_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        match returns.len() {
            0 => ValueRef::unknown(),
            1 => returns.into_iter().next().unwrap(),
            _ => {
                let guarded = returns.iter().all(|vr| vr.guarded);
                let dynamic = returns.iter().any(|vr| vr.dynamic);
                let origin =
                    Origin::union_origins(returns.into_iter().map(|vr| vr.origin).collect());
                ValueRef {
                    origin,
                    guarded,
                    dynamic,
                }
            }
        }
    }

    fn leave_callback(&mut self, previous_guards: usize) {
        self.anon_returns.pop();
        self.fn_stack.pop();
        self.envs.pop();
        self.guards.truncate(previous_guards);
        self.anon_depth -= 1;
    }

    fn bind_params(&mut self, fn_node: Node, scope: Option<usize>) {
        for (index, param) in param_nodes(fn_node).into_iter().enumerate() {
            let param = unwrap_parameter(param);
            let origin = match scope {
                Some(scope) => Origin::Param { scope, index },
                None => Origin::Unknown,
            };
            match param.kind() {
                "identifier" => {
                    let name = node_text(param, self.src()).trim().to_string();
                    self.bind_var(
                        name,
                        Binding {
                            origin,
                            guarded: false,
                            value: None,
                        },
                    );
                }
                _ => self.bind_pattern(param, &origin, false, None),
            }
        }
    }

    fn bind_callback_params(&mut self, fn_node: Node, origins: &[Origin], guarded: bool) {
        for (index, param) in param_nodes(fn_node).into_iter().enumerate() {
            let param = unwrap_parameter(param);
            let origin = origins.get(index).cloned().unwrap_or(Origin::Unknown);
            match param.kind() {
                "identifier" => {
                    let name = node_text(param, self.src()).trim().to_string();
                    self.bind_var(
                        name,
                        Binding {
                            origin,
                            guarded,
                            value: None,
                        },
                    );
                }
                "assignment_pattern" => {
                    if let Some(left) = child_left(param) {
                        self.bind_pattern(left, &origin, true, None);
                    }
                }
                _ => self.bind_pattern(param, &origin, guarded, None),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Expressions
    // -----------------------------------------------------------------------

    fn visit_expr(&mut self, node: Node) -> ValueRef {
        if self.depth >= MAX_AST_DEPTH {
            return ValueRef::unknown();
        }
        self.depth += 1;
        let value = self.visit_expr_node(node);
        self.depth -= 1;
        value
    }

    fn visit_expr_node(&mut self, node: Node) -> ValueRef {
        let node = unwrap_expression(node);
        match node.kind() {
            "call_expression" => self.eval_call(node),
            "member_expression" | "subscript_expression" => {
                let mut segs = Vec::new();
                let Some(base) = collect_chain(node, self.src(), &mut segs) else {
                    return ValueRef::unknown();
                };
                let mut length_tail = false;
                if segs.last().is_some_and(|s| s.name == "length") {
                    segs.pop();
                    length_tail = true;
                }
                let base_vr = self.eval_value(base);
                let result = self.apply_segments(base_vr, &segs);
                let line = node.start_position().row as u32 + 1;
                for (origin, kind) in &result.extras {
                    self.push_origin_access(
                        origin.clone(),
                        !self.guards.is_empty(),
                        *kind,
                        line,
                        false,
                    );
                }
                if let Some(anchor) = result.transport {
                    self.anchor_usage.entry(anchor).or_default().transport_read = true;
                }
                if length_tail {
                    self.push_origin_access(
                        result.vr.origin.clone(),
                        !self.guards.is_empty() || result.vr.guarded,
                        Some(ObservedKind::Array),
                        line,
                        false,
                    );
                } else {
                    self.record_read(&result.vr, node);
                }
                result.vr
            }
            "identifier" => {
                let name = node_text(node, self.src()).trim();
                let vr = self
                    .lookup_var(name)
                    .map(|b| ValueRef {
                        origin: b.origin.clone(),
                        guarded: b.guarded,
                        dynamic: false,
                    })
                    .unwrap_or_default();
                // A bare use of a destructured field is a read, but undefined does not
                // throw; only member access does. Keep it soft so verification cannot
                // turn a truthiness check into a break.
                self.push_origin_access(
                    vr.origin.clone(),
                    true,
                    vr.kind_hint(),
                    node.start_position().row as u32 + 1,
                    false,
                );
                vr
            }
            "binary_expression" => self.eval_binary(node),
            "ternary_expression" => self.eval_ternary(node),
            "assignment_expression" => {
                if let Some(right) = node.child_by_field_name("right") {
                    let vr = self.visit_expr(right);
                    if let Some(left) = node.child_by_field_name("left") {
                        if left.kind() == "identifier" {
                            let name = node_text(left, self.src()).trim().to_string();
                            self.bind_var(
                                name,
                                Binding {
                                    origin: vr.origin.clone(),
                                    guarded: vr.guarded,
                                    value: None,
                                },
                            );
                        }
                    }
                    vr
                } else {
                    ValueRef::unknown()
                }
            }
            "parenthesized_expression"
            | "await_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression"
            | "type_assertion" => {
                if let Some(child) = node.named_child(0) {
                    self.visit_expr(child)
                } else {
                    ValueRef::unknown()
                }
            }
            "arrow_function" | "function_expression" => {
                self.enter_callback(node, &[], false);
                ValueRef::unknown()
            }
            "object" => {
                self.visit_object_literal(node);
                ValueRef::unknown()
            }
            "array"
            | "template_string"
            | "jsx_element"
            | "jsx_self_closing_element"
            | "jsx_fragment"
            | "jsx_expression" => {
                self.visit_children(node);
                ValueRef::unknown()
            }
            "jsx_attribute" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.visit_expr(value);
                }
                ValueRef::unknown()
            }
            "pair" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.visit_expr(value);
                }
                ValueRef::unknown()
            }
            "shorthand_property_identifier" => {
                let name = node_text(node, self.src()).trim();
                let vr = self
                    .lookup_var(name)
                    .map(|b| ValueRef {
                        origin: b.origin.clone(),
                        guarded: b.guarded,
                        dynamic: false,
                    })
                    .unwrap_or_default();
                self.record_read(&vr, node);
                vr
            }
            "sequence_expression" => {
                let mut last = ValueRef::unknown();
                let mut cursor = node.walk();
                let children: Vec<Node> = node.named_children(&mut cursor).collect();
                for child in children {
                    last = self.visit_expr(child);
                }
                last
            }
            "unary_expression" | "update_expression" | "yield_expression" | "new_expression"
            | "spread_element" => {
                self.visit_children(node);
                ValueRef::unknown()
            }
            "property_identifier" | "type_identifier" | "predefined_type" => ValueRef::unknown(),
            _ => {
                self.visit_children(node);
                ValueRef::unknown()
            }
        }
    }

    fn visit_object_literal(&mut self, node: Node) {
        let mut cursor = node.walk();
        let children: Vec<Node> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "pair" => {
                    if let Some(value) = child.child_by_field_name("value") {
                        self.visit_expr(value);
                    }
                }
                "shorthand_property_identifier" => {
                    self.visit_expr(child);
                }
                "method_definition" => {
                    self.enter_callback(child, &[], false);
                }
                _ => self.visit(child),
            }
        }
    }

    fn eval_binary(&mut self, node: Node) -> ValueRef {
        let operator = node
            .child_by_field_name("operator")
            .map(|n| node_text(n, self.src()).trim().to_string())
            .or_else(|| {
                node.child(1)
                    .map(|n| node_text(n, self.src()).trim().to_string())
            })
            .unwrap_or_default();
        let left_node = node
            .child_by_field_name("left")
            .or_else(|| node.named_child(0));
        let right_node = node
            .child_by_field_name("right")
            .or_else(|| node.named_child(1));
        let site = node.start_byte();
        match operator.as_str() {
            "??" | "||" => {
                let len = self.guards.len();
                self.guards.push(Guard {
                    kind: GuardKind::Fallback,
                    site,
                });
                let left = left_node.map(|n| self.visit_expr(n)).unwrap_or_default();
                let right = right_node.map(|n| self.visit_expr(n)).unwrap_or_default();
                self.guards.truncate(len);
                let origin = match (&left.origin, &right.origin) {
                    (Origin::Unknown, _) => right.origin.clone(),
                    (_, Origin::Unknown) => left.origin.clone(),
                    _ => left.origin.clone().union(right.origin.clone()),
                };
                ValueRef {
                    origin,
                    guarded: true,
                    dynamic: left.dynamic || right.dynamic,
                }
            }
            "&&" => {
                let left = left_node.map(|n| self.visit_expr(n)).unwrap_or_default();
                let len = self.guards.len();
                self.guards.push(Guard {
                    kind: GuardKind::Conditional,
                    site,
                });
                let right = right_node.map(|n| self.visit_expr(n)).unwrap_or_default();
                self.guards.truncate(len);
                ValueRef {
                    origin: if matches!(left.origin, Origin::Unknown) {
                        right.origin
                    } else {
                        left.origin
                    },
                    guarded: true,
                    dynamic: left.dynamic || right.dynamic,
                }
            }
            _ => {
                if let Some(left) = left_node {
                    self.visit_expr(left);
                }
                if let Some(right) = right_node {
                    self.visit_expr(right);
                }
                ValueRef::unknown()
            }
        }
    }

    fn eval_ternary(&mut self, node: Node) -> ValueRef {
        let condition = node
            .child_by_field_name("condition")
            .or_else(|| node.named_child(0));
        let consequence = node
            .child_by_field_name("consequence")
            .or_else(|| node.named_child(1));
        let alternative = node
            .child_by_field_name("alternative")
            .or_else(|| node.named_child(2));
        if let Some(condition) = condition {
            self.visit_expr(condition);
        }
        let site = node.start_byte();
        let len = self.guards.len();
        self.guards.push(Guard {
            kind: GuardKind::Conditional,
            site,
        });
        let left = consequence.map(|n| self.visit_expr(n)).unwrap_or_default();
        let right = alternative.map(|n| self.visit_expr(n)).unwrap_or_default();
        self.guards.truncate(len);
        let origin = match (&left.origin, &right.origin) {
            (Origin::Unknown, _) => right.origin.clone(),
            (_, Origin::Unknown) => left.origin.clone(),
            _ => left.origin.clone().union(right.origin.clone()),
        };
        ValueRef {
            origin,
            guarded: true,
            dynamic: left.dynamic || right.dynamic,
        }
    }

    fn eval_value(&mut self, node: Node) -> ValueRef {
        let node = unwrap_expression(node);
        match node.kind() {
            "identifier" => self
                .lookup_var(node_text(node, self.src()).trim())
                .map(|b| ValueRef {
                    origin: b.origin.clone(),
                    guarded: b.guarded,
                    dynamic: false,
                })
                .unwrap_or_default(),
            "call_expression" => self.eval_call(node),
            "member_expression" | "subscript_expression" => {
                let mut segs = Vec::new();
                let Some(base) = collect_chain(node, self.src(), &mut segs) else {
                    return ValueRef::unknown();
                };
                let base_vr = self.eval_value(base);
                self.apply_segments(base_vr, &segs).vr
            }
            "binary_expression" => self.eval_binary(node),
            "ternary_expression" => self.eval_ternary(node),
            "parenthesized_expression"
            | "await_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression"
            | "type_assertion" => node
                .named_child(0)
                .map(|child| self.eval_value(child))
                .unwrap_or_default(),
            _ => ValueRef::unknown(),
        }
    }

    fn apply_segments(&mut self, base: ValueRef, segs: &[Segment]) -> ChainResult {
        let mut origin = base.origin;
        let mut guarded = base.guarded;
        let mut dynamic = base.dynamic;
        let mut extras: Vec<(Origin, Option<ObservedKind>)> = vec![];
        let mut transport: Option<usize> = None;

        for (index, seg) in segs.iter().enumerate() {
            guarded |= seg.optional;
            if seg.dynamic {
                dynamic = true;
                break;
            }
            match origin.clone() {
                Origin::Http { anchor } => {
                    let client = self
                        .model
                        .anchor_clients
                        .get(&anchor)
                        .copied()
                        .unwrap_or(ClientKind::Unknown);
                    match client {
                        ClientKind::Direct => {
                            origin = with_segment(Origin::Body { anchor }, &seg.name);
                        }
                        ClientKind::Axios => {
                            if index == 0 && seg.name == "data" {
                                origin = Origin::Body { anchor };
                            } else if index == 0 && is_axios_metadata(&seg.name) {
                                transport = Some(anchor);
                                return ChainResult {
                                    vr: ValueRef {
                                        origin: Origin::Unknown,
                                        guarded,
                                        dynamic,
                                    },
                                    extras,
                                    transport,
                                };
                            } else {
                                // Not a field of the envelope and not `data`: the read is
                                // reported, but resolution must keep it advisory.
                                origin = with_segment(Origin::Http { anchor }, &seg.name);
                            }
                        }
                        ClientKind::Superagent => {
                            if index == 0 && seg.name == "body" {
                                origin = Origin::Body { anchor };
                            } else if index == 0 && is_superagent_metadata(&seg.name) {
                                transport = Some(anchor);
                                return ChainResult {
                                    vr: ValueRef {
                                        origin: Origin::Unknown,
                                        guarded,
                                        dynamic,
                                    },
                                    extras,
                                    transport,
                                };
                            } else {
                                origin = with_segment(Origin::Http { anchor }, &seg.name);
                            }
                        }
                        ClientKind::Fetch => {
                            transport = Some(anchor);
                            return ChainResult {
                                vr: ValueRef {
                                    origin: Origin::Unknown,
                                    guarded,
                                    dynamic,
                                },
                                extras,
                                transport,
                            };
                        }
                        ClientKind::Unknown => {
                            origin = with_segment(Origin::Http { anchor }, &seg.name);
                        }
                    }
                }
                Origin::Union(types) => {
                    let mut branched = Vec::new();
                    for t in types {
                        let vr = ValueRef {
                            origin: t,
                            guarded,
                            dynamic,
                        };
                        let branch = self.apply_segments(vr, &segs[index..]);
                        branched.push(branch.vr.origin);
                        extras.extend(branch.extras);
                        if branch.transport.is_some() {
                            transport = branch.transport;
                        }
                    }
                    origin = Origin::union_origins(branched);
                    break;
                }
                _ => {
                    if seg.name == "[]" {
                        extras.push((origin.clone(), Some(ObservedKind::Array)));
                    }
                    origin = with_segment(origin, &seg.name);
                }
            }
        }

        ChainResult {
            vr: ValueRef {
                origin,
                guarded,
                dynamic,
            },
            extras,
            transport,
        }
    }

    fn record_read(&mut self, vr: &ValueRef, node: Node) {
        let line = node.start_position().row as u32 + 1;
        if vr.dynamic {
            self.accesses.push(AccessFact {
                origin: vr.origin.clone(),
                kind: None,
                guarded: true,
                alt_site: None,
                dynamic: true,
                line,
                file: self.model.file.clone(),
            });
            return;
        }
        let guarded = vr.guarded || !self.guards.is_empty();
        let alt_site = self.current_alt_site();
        self.push_origin_access(vr.origin.clone(), guarded, None, line, false);
        if let Some(site) = alt_site {
            if let Some(last) = self.accesses.last_mut() {
                last.alt_site = Some(site);
            }
        }
    }

    fn push_origin_access(
        &mut self,
        origin: Origin,
        guarded: bool,
        kind: Option<ObservedKind>,
        line: u32,
        dynamic: bool,
    ) {
        match origin {
            Origin::Union(types) => {
                for t in types {
                    self.push_origin_access(t, guarded, kind, line, dynamic);
                }
            }
            Origin::Unknown => {}
            origin => {
                let Some(path) = origin_relative_path(&origin) else {
                    return;
                };
                if path.is_empty() {
                    return;
                }
                self.accesses.push(AccessFact {
                    origin,
                    kind,
                    guarded,
                    alt_site: if guarded {
                        self.current_alt_site()
                    } else {
                        None
                    },
                    dynamic,
                    line,
                    file: self.model.file.clone(),
                });
            }
        }
    }

    fn current_alt_site(&self) -> Option<usize> {
        self.guards
            .iter()
            .rev()
            .find(|g| matches!(g.kind, GuardKind::Fallback))
            .map(|g| g.site)
    }

    fn eval_call(&mut self, node: Node) -> ValueRef {
        let Some(callee) = node.child_by_field_name("function") else {
            return ValueRef::unknown();
        };
        let args_node = node.child_by_field_name("arguments");
        let discarded = is_discarded(node);
        let line = node.start_position().row as u32 + 1;
        let anchor = node.start_byte();

        // A chain continuation starts where its receiver starts, so `api.get("/x").then(cb)`
        // sits on the same byte as the anchored `api.get("/x")`. Only the innermost call owns
        // the anchor; a chain over it is a value derived from the response, and falling
        // through to the member handling is what follows the response into the callback.
        let owns_anchor = chain_over_call(node, anchor).is_none();
        if let Some(method) = owns_anchor
            .then(|| self.model.anchors.get(&anchor).cloned())
            .flatten()
        {
            if let Some(args) = args_node {
                self.visit_arguments(args);
                if matches!(method.as_str(), "POST" | "PUT" | "PATCH") {
                    let client = self
                        .model
                        .anchor_clients
                        .get(&anchor)
                        .copied()
                        .unwrap_or(ClientKind::Unknown);
                    let body = if client == ClientKind::Fetch {
                        fetch_body_input(args, self.src())
                    } else {
                        body_argument(args, self.src()).map(BodyInput::Value)
                    };
                    let mut no_body = false;
                    let mut body_param = None;
                    let mut body_fact = None;
                    match body {
                        Some(BodyInput::Value(body)) => {
                            let text = node_text(body, self.src()).trim();
                            if text == "null" || text == "undefined" {
                                no_body = true;
                            } else if let Some((scope, index)) =
                                param_binding(&self.eval_param_origin(body), self.src())
                            {
                                body_param = Some((scope, index));
                            } else {
                                body_fact = Some(self.eval_arg(body, 0));
                            }
                        }
                        Some(BodyInput::Dynamic(reason)) => {
                            body_fact = Some(ArgFact::dynamic(&self.model.file, line, reason));
                        }
                        None => no_body = true,
                    }
                    let usage = self.anchor_usage.entry(anchor).or_default();
                    usage.discarded |= discarded;
                    usage.no_body |= no_body;
                    if let Some((scope, index)) = body_param {
                        usage.body_param = Some(index);
                        if let Some(scope) = self.scopes.get_mut(&scope) {
                            scope.body_params.push((anchor, index));
                        }
                    }
                    if let Some(fact) = body_fact {
                        usage.body_facts.push(fact);
                    }
                } else {
                    self.anchor_usage.entry(anchor).or_default().discarded |= discarded;
                }
            } else {
                self.anchor_usage.entry(anchor).or_default().discarded |= discarded;
            }
            return ValueRef {
                origin: Origin::Http { anchor },
                guarded: !self.guards.is_empty(),
                dynamic: false,
            };
        }

        let callee = unwrap_expression(callee);
        match callee.kind() {
            "identifier" => {
                let name = node_text(callee, self.src()).trim().to_string();
                if name == "fetch" {
                    if let Some(args) = args_node {
                        self.visit_arguments(args);
                    }
                    return ValueRef::unknown();
                }
                if let Some(state) = self.lookup_setter(&name) {
                    if let Some(args) = args_node {
                        let facts = self.visit_arguments(args);
                        if let Some(arg) = args.named_child(0) {
                            if is_function_node(unwrap_expression(arg).kind()) {
                                let cb = unwrap_expression(arg);
                                self.enter_callback(cb, &[], false);
                            } else {
                                let vr = self.eval_value(arg);
                                if !matches!(vr.origin, Origin::Unknown) {
                                    self.set_state_origin(&state, vr.origin);
                                }
                                let _ = facts;
                            }
                        }
                    }
                    return ValueRef::unknown();
                }

                let target = if let Some(scope) = self.lookup_function(&name) {
                    Some(CallTarget::Local(scope))
                } else {
                    self.model.imports.get(&name).map(|binding| {
                        let module = resolve_import_module(&self.model.file, &binding.module)
                            .map(|m| strip_script_extension(&m).to_string())
                            .unwrap_or_else(|| binding.module.clone());
                        CallTarget::Imported {
                            module,
                            name: if binding.imported == "default" || binding.imported == "*" {
                                "default".to_string()
                            } else {
                                binding.imported.clone()
                            },
                        }
                    })
                };

                let args = args_node
                    .map(|a| self.visit_arguments(a))
                    .unwrap_or_default();
                let arg_facts = args_node
                    .map(|a| self.argument_facts(a))
                    .unwrap_or_default();
                let guarded = !self.guards.is_empty();
                if let Some(target) = target {
                    let origin = match &target {
                        CallTarget::Local(id) => Origin::Call {
                            local: Some(*id),
                            module: String::new(),
                            name: name.clone(),
                        },
                        CallTarget::Imported { module, name } => Origin::Call {
                            local: None,
                            module: module.clone(),
                            name: name.clone(),
                        },
                    };
                    self.calls.push(CallFact {
                        target,
                        args,
                        arg_facts,
                        guarded,
                        alt_site: self.current_alt_site(),
                        discarded,
                        line,
                        file: self.model.file.clone(),
                    });
                    // Resolution decides whether the callee is an HTTP wrapper. Until
                    // then the value keeps its provenance instead of collapsing to
                    // Unknown, so callers of the wrapper can follow their reads.
                    return ValueRef {
                        origin,
                        guarded,
                        dynamic: false,
                    };
                }
                ValueRef::unknown()
            }
            "member_expression" | "subscript_expression" => {
                let Some(object) = callee.child_by_field_name("object") else {
                    return ValueRef::unknown();
                };
                let method = callee
                    .child_by_field_name("property")
                    .map(|n| node_text(n, self.src()).trim().to_string())
                    .or_else(|| subscript_name(callee, self.src()))
                    .unwrap_or_default();
                let receiver = self.eval_value(object);

                if method == "json" {
                    if let Origin::Http { anchor } = &receiver.origin {
                        let client = self
                            .model
                            .anchor_clients
                            .get(anchor)
                            .copied()
                            .unwrap_or(ClientKind::Unknown);
                        if client == ClientKind::Fetch {
                            if let Some(args) = args_node {
                                self.visit_arguments(args);
                            }
                            return ValueRef {
                                origin: Origin::Body { anchor: *anchor },
                                guarded: receiver.guarded,
                                dynamic: false,
                            };
                        }
                    } else if matches!(
                        &receiver.origin,
                        Origin::Call { .. } | Origin::Union(_) | Origin::AwaitBody(_)
                    ) {
                        // The transport value came from a wrapper in another scope; the
                        // registry resolves it after analysis, so record the intended
                        // body extraction now.
                        if let Some(args) = args_node {
                            self.visit_arguments(args);
                        }
                        return ValueRef {
                            origin: Origin::AwaitBody(Box::new(receiver.origin)),
                            guarded: receiver.guarded,
                            dynamic: false,
                        };
                    }
                }

                if matches!(method.as_str(), "then" | "subscribe" | "finally" | "catch") {
                    if let Some(args) = args_node {
                        let mut cursor = args.walk();
                        let callback = args.named_children(&mut cursor).next();
                        if let Some(callback) = callback {
                            let callback = unwrap_expression(callback);
                            if is_function_node(callback.kind()) {
                                let param_origin = if method == "catch" {
                                    Origin::Unknown
                                } else {
                                    receiver.origin.clone()
                                };
                                let continued = self.enter_callback(
                                    callback,
                                    &[param_origin],
                                    receiver.guarded,
                                );
                                // A fulfilled promise carries the callback's value, so
                                // `.then(res => res.json()).then(body => body.items)` puts
                                // `items` on the wire, not on the transport response.
                                if method == "then" && !matches!(continued.origin, Origin::Unknown)
                                {
                                    return continued;
                                }
                            } else if callback.kind() == "identifier" && method != "catch" {
                                // `.then(handleResponse)` names a local function: record the
                                // hand-off so the registry can bind its parameter to this
                                // response, the same way an array callback binds its element.
                                let name = node_text(callback, self.src()).trim().to_string();
                                if let Some(scope) = self.lookup_function(&name) {
                                    self.calls.push(CallFact {
                                        target: CallTarget::Local(scope),
                                        args: vec![ValueRef {
                                            origin: receiver.origin.clone(),
                                            guarded: receiver.guarded,
                                            dynamic: false,
                                        }],
                                        arg_facts: vec![],
                                        guarded: receiver.guarded || !self.guards.is_empty(),
                                        alt_site: self.current_alt_site(),
                                        discarded: false,
                                        line: callback.start_position().row as u32 + 1,
                                        file: self.model.file.clone(),
                                    });
                                } else {
                                    self.visit_expr(callback);
                                }
                            } else {
                                self.visit_expr(callback);
                            }
                        }
                    }
                    return ValueRef {
                        origin: receiver.origin,
                        guarded: receiver.guarded,
                        dynamic: false,
                    };
                }

                if is_array_method(&method) {
                    let element = with_segment(receiver.origin.clone(), "[]");
                    self.record_receiver_read(&receiver, node, Some(ObservedKind::Array));
                    if let Some(args) = args_node {
                        self.visit_array_callback(args, &method, &element, receiver.guarded);
                    }
                    let result = if matches!(
                        method.as_str(),
                        "map" | "flatMap" | "filter" | "slice" | "toSorted" | "sort"
                    ) {
                        ValueRef {
                            origin: element,
                            guarded: receiver.guarded,
                            dynamic: false,
                        }
                    } else {
                        ValueRef::unknown()
                    };
                    return result;
                }

                self.record_receiver_read(&receiver, node, None);
                if let Some(args) = args_node {
                    self.visit_arguments(args);
                }
                ValueRef::unknown()
            }
            _ => {
                if let Some(args) = args_node {
                    self.visit_arguments(args);
                }
                ValueRef::unknown()
            }
        }
    }

    fn eval_param_origin(&mut self, node: Node) -> ValueRef {
        let node = unwrap_expression(node);
        if node.kind() != "identifier" {
            return ValueRef::unknown();
        }
        self.lookup_var(node_text(node, self.src()).trim())
            .map(|b| ValueRef {
                origin: b.origin.clone(),
                guarded: b.guarded,
                dynamic: false,
            })
            .unwrap_or_default()
    }

    fn record_receiver_read(
        &mut self,
        receiver: &ValueRef,
        node: Node,
        kind: Option<ObservedKind>,
    ) {
        if let Some(path) = origin_relative_path(&receiver.origin) {
            if !path.is_empty() && !path.ends_with("[]") {
                self.accesses.push(AccessFact {
                    origin: receiver.origin.clone(),
                    kind,
                    guarded: receiver.guarded || !self.guards.is_empty(),
                    alt_site: self.current_alt_site(),
                    dynamic: false,
                    line: node.start_position().row as u32 + 1,
                    file: self.model.file.clone(),
                });
            }
        }
    }

    fn visit_array_callback(&mut self, args: Node, method: &str, element: &Origin, guarded: bool) {
        let Some(callback) = args.named_child(0) else {
            return;
        };
        let callback = unwrap_expression(callback);
        if is_function_node(callback.kind()) {
            let element_index = if matches!(method, "reduce" | "reduceRight") {
                1
            } else {
                0
            };
            let mut origins = vec![Origin::Unknown; element_index + 1];
            origins[element_index] = element.clone();
            self.enter_callback(callback, &origins, guarded);
        } else if callback.kind() == "identifier" {
            let name = node_text(callback, self.src()).trim().to_string();
            if let Some(scope) = self.lookup_function(&name) {
                self.calls.push(CallFact {
                    target: CallTarget::Local(scope),
                    args: vec![ValueRef {
                        origin: element.clone(),
                        guarded,
                        dynamic: false,
                    }],
                    arg_facts: vec![],
                    guarded: !self.guards.is_empty(),
                    alt_site: self.current_alt_site(),
                    discarded: true,
                    line: callback.start_position().row as u32 + 1,
                    file: self.model.file.clone(),
                });
            }
        } else {
            self.visit_expr(callback);
        }
    }

    fn visit_arguments(&mut self, args: Node) -> Vec<ValueRef> {
        let mut out = Vec::new();
        let mut cursor = args.walk();
        let children: Vec<Node> = args.named_children(&mut cursor).collect();
        for child in children {
            if child.kind() == "spread_element" {
                if let Some(inner) = child.named_child(0) {
                    out.push(self.visit_expr(inner));
                }
                continue;
            }
            out.push(self.visit_expr(child));
        }
        out
    }

    fn argument_facts(&mut self, args: Node) -> Vec<ArgFact> {
        let mut out = Vec::new();
        let mut cursor = args.walk();
        let children: Vec<Node> = args.named_children(&mut cursor).collect();
        for child in children {
            out.push(self.eval_arg(child, 0));
        }
        out
    }

    // -----------------------------------------------------------------------
    // Request bodies
    // -----------------------------------------------------------------------

    fn literal_fact(&mut self, node: Node) -> Option<ArgFact> {
        let node = unwrap_expression(node);
        match node.kind() {
            "object" => Some(self.object_fact(node, 0)),
            "string" => Some(scalar_fact(
                ObservedKind::String,
                &self.model.file,
                node.start_position().row as u32 + 1,
            )),
            "number" => Some(scalar_fact(
                ObservedKind::Number,
                &self.model.file,
                node.start_position().row as u32 + 1,
            )),
            "true" | "false" => Some(scalar_fact(
                ObservedKind::Boolean,
                &self.model.file,
                node.start_position().row as u32 + 1,
            )),
            "array" => Some(scalar_fact(
                ObservedKind::Array,
                &self.model.file,
                node.start_position().row as u32 + 1,
            )),
            "null" | "undefined" => Some(ArgFact::nullish(
                &self.model.file,
                node.start_position().row as u32 + 1,
            )),
            "identifier" => self
                .lookup_var(node_text(node, self.src()).trim())
                .and_then(|b| b.value.clone()),
            _ => None,
        }
    }

    fn eval_arg(&mut self, node: Node, depth: usize) -> ArgFact {
        let line = node.start_position().row as u32 + 1;
        let node = unwrap_expression(node);
        if depth > 8 {
            return ArgFact::dynamic(&self.model.file, line, "request body nests too deeply");
        }
        match node.kind() {
            "object" => self.object_fact(node, depth),
            "string" => scalar_fact(ObservedKind::String, &self.model.file, line),
            "template_string" => {
                let text = node_text(node, self.src());
                if text.contains("${") {
                    ArgFact::dynamic(
                        &self.model.file,
                        line,
                        "request body is a template with interpolated keys or values",
                    )
                } else {
                    scalar_fact(ObservedKind::String, &self.model.file, line)
                }
            }
            "number" => scalar_fact(ObservedKind::Number, &self.model.file, line),
            "true" | "false" => scalar_fact(ObservedKind::Boolean, &self.model.file, line),
            "array" => scalar_fact(ObservedKind::Array, &self.model.file, line),
            "null" | "undefined" => ArgFact::nullish(&self.model.file, line),
            "identifier" => {
                let name = node_text(node, self.src()).trim();
                if let Some(binding) = self.lookup_var(name) {
                    if let Some(fact) = &binding.value {
                        return fact.clone();
                    }
                    match &binding.origin {
                        Origin::Param { .. } | Origin::Path { .. } => {
                            if matches!(binding.origin, Origin::Param { .. })
                                || matches!(&binding.origin, Origin::Path { base, .. } if matches!(**base, Origin::Param { .. }))
                            {
                                return ArgFact::dynamic(
                                    &self.model.file,
                                    line,
                                    "request body is a parameter of the calling function; its caller was not followed",
                                );
                            }
                        }
                        _ => {}
                    }
                }
                ArgFact::dynamic(
                    &self.model.file,
                    line,
                    "request body variable has no statically enumerable initializer in scope",
                )
            }
            "binary_expression" => {
                let left = node
                    .child_by_field_name("left")
                    .or_else(|| node.named_child(0));
                match left.map(|n| self.eval_arg(n, depth + 1)) {
                    Some(mut fact) => {
                        fact.complete = false;
                        fact.reason = Some(
                            "request body is conditionally constructed; field set is incomplete"
                                .to_string(),
                        );
                        fact
                    }
                    None => ArgFact::dynamic(
                        &self.model.file,
                        line,
                        "request body is conditionally constructed",
                    ),
                }
            }
            "ternary_expression" => {
                let branch = node
                    .child_by_field_name("consequence")
                    .or_else(|| node.named_child(1));
                match branch.map(|n| self.eval_arg(n, depth + 1)) {
                    Some(mut fact) => {
                        fact.complete = false;
                        fact.reason = Some(
                            "request body is conditionally constructed; field set is incomplete"
                                .to_string(),
                        );
                        fact
                    }
                    None => ArgFact::dynamic(
                        &self.model.file,
                        line,
                        "request body is conditionally constructed",
                    ),
                }
            }
            "call_expression" => ArgFact::dynamic(
                &self.model.file,
                line,
                "request body is computed by a call this pass does not follow",
            ),
            _ => ArgFact::dynamic(
                &self.model.file,
                line,
                "request body is not a statically enumerable expression",
            ),
        }
    }

    fn object_fact(&mut self, node: Node, depth: usize) -> ArgFact {
        let line = node.start_position().row as u32 + 1;
        let mut fields: Vec<(String, Option<ObservedKind>)> = vec![];
        let mut complete = true;
        let mut reason: Option<String> = None;
        let mut cursor = node.walk();
        let children: Vec<Node> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "pair" => {
                    let Some(key) = child.child_by_field_name("key") else {
                        continue;
                    };
                    if !matches!(key.kind(), "property_identifier" | "string" | "number") {
                        complete = false;
                        reason = Some(
                            "request body contains a computed key; field set is incomplete"
                                .to_string(),
                        );
                        continue;
                    }
                    let name = unquote_str(node_text(key, self.src()).trim());
                    if name.is_empty() {
                        complete = false;
                        continue;
                    }
                    let kind = child
                        .child_by_field_name("value")
                        .and_then(|v| self.value_kind(v));
                    fields.push((name, kind));
                }
                "shorthand_property_identifier" => {
                    let name = node_text(child, self.src()).trim().to_string();
                    let kind = self
                        .lookup_var(&name)
                        .and_then(|b| b.value.as_ref())
                        .and_then(|f| match f.kind {
                            ArgKind::Scalar(k) => Some(k),
                            ArgKind::Object => Some(ObservedKind::Object),
                            _ => None,
                        });
                    fields.push((name, kind));
                }
                "spread_element" => {
                    complete = false;
                    reason = Some(
                        "request body spreads another object; field set is incomplete".to_string(),
                    );
                }
                "method_definition" => {
                    complete = false;
                    reason = Some("request body declares a method; field set is incomplete".into());
                }
                _ => {
                    complete = false;
                }
            }
        }
        let _ = depth;
        ArgFact {
            kind: ArgKind::Object,
            fields,
            complete,
            line,
            file: self.model.file.clone(),
            reason,
        }
    }

    fn value_kind(&mut self, node: Node) -> Option<ObservedKind> {
        let node = unwrap_expression(node);
        match node.kind() {
            "string" | "template_string" => Some(ObservedKind::String),
            "number" => Some(ObservedKind::Number),
            "true" | "false" => Some(ObservedKind::Boolean),
            "object" => Some(ObservedKind::Object),
            "array" => Some(ObservedKind::Array),
            "identifier" => {
                let name = node_text(node, self.src()).trim();
                self.lookup_var(name)
                    .and_then(|b| b.value.as_ref())
                    .map(|f| match f.kind {
                        ArgKind::Scalar(k) => Some(k),
                        ArgKind::Object => Some(ObservedKind::Object),
                        _ => None,
                    })
                    .unwrap_or(None)
            }
            _ => None,
        }
    }
}

struct ChainResult {
    vr: ValueRef,
    extras: Vec<(Origin, Option<ObservedKind>)>,
    transport: Option<usize>,
}

impl Origin {
    fn union_origins(types: Vec<Origin>) -> Origin {
        let mut out: Vec<Origin> = Vec::new();
        for t in types {
            match t {
                Origin::Unknown => {}
                Origin::Union(inner) => out.extend(inner),
                one => out.push(one),
            }
        }
        out.sort_by_key(origin_sort_key);
        out.dedup();
        match out.len() {
            0 => Origin::Unknown,
            1 => out.pop().unwrap(),
            _ => Origin::Union(out),
        }
    }
}

#[derive(Clone)]
struct Segment {
    name: String,
    optional: bool,
    dynamic: bool,
}

fn collect_chain<'a>(node: Node<'a>, src: &str, out: &mut Vec<Segment>) -> Option<Node<'a>> {
    match node.kind() {
        "member_expression" => {
            let object = node.child_by_field_name("object")?;
            let base = collect_chain(object, src, out)?;
            let property = node.child_by_field_name("property")?;
            let optional = node.child_by_field_name("optional_chain").is_some();
            out.push(Segment {
                name: node_text(property, src).trim().to_string(),
                optional,
                dynamic: false,
            });
            Some(base)
        }
        "subscript_expression" => {
            let object = node.child_by_field_name("object")?;
            let base = collect_chain(object, src, out)?;
            let optional = node.child_by_field_name("optional_chain").is_some();
            let index = node.child_by_field_name("index")?;
            match index.kind() {
                "string" => out.push(Segment {
                    name: unquote_str(node_text(index, src).trim()),
                    optional,
                    dynamic: false,
                }),
                "number" => out.push(Segment {
                    name: "[]".to_string(),
                    optional,
                    dynamic: false,
                }),
                _ => out.push(Segment {
                    name: String::new(),
                    optional,
                    dynamic: true,
                }),
            }
            Some(base)
        }
        _ => Some(node),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn node_text<'a>(node: Node, src: &'a str) -> &'a str {
    &src[node.start_byte()..node.end_byte()]
}

fn push_named_children<'a>(node: Node<'a>, stack: &mut Vec<Node<'a>>) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        stack.push(child);
    }
}

pub(crate) fn is_function_node(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration" | "function_expression" | "arrow_function" | "method_definition"
    )
}

pub(crate) fn unwrap_expression(mut node: Node) -> Node {
    loop {
        let next = match node.kind() {
            "parenthesized_expression"
            | "await_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression"
            | "type_assertion" => node.named_child(0),
            _ => None,
        };
        match next {
            Some(child) => node = child,
            None => return node,
        }
    }
}

fn unwrap_parameter(mut node: Node) -> Node {
    loop {
        match node.kind() {
            "required_parameter" | "optional_parameter" => {
                let next = node
                    .child_by_field_name("pattern")
                    .or_else(|| node.named_child(0));
                match next {
                    Some(child) => node = child,
                    None => return node,
                }
            }
            _ => return node,
        }
    }
}

fn function_body(node: Node) -> Option<Node> {
    if let Some(body) = node.child_by_field_name("body") {
        return Some(body);
    }
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .find(|n| n.kind() == "statement_block");
    found
}

fn param_nodes(fn_node: Node) -> Vec<Node> {
    if let Some(params) = fn_node.child_by_field_name("parameters") {
        let mut cursor = params.walk();
        return params
            .named_children(&mut cursor)
            .filter(|n| !matches!(n.kind(), "type_annotation" | "type_parameters" | "comment"))
            .collect();
    }
    if let Some(param) = fn_node.child_by_field_name("parameter") {
        return vec![param];
    }
    vec![]
}

fn child_left(node: Node) -> Option<Node> {
    node.child_by_field_name("left")
        .or_else(|| node.child_by_field_name("pattern"))
        .or_else(|| node.named_child(0))
}

fn object_key_name(node: Node, src: &str) -> Option<String> {
    let name = node_text(node, src).trim();
    if name.is_empty() {
        return None;
    }
    Some(unquote_str(name))
}

fn array_pattern_names(node: Node, src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "identifier" => out.push(node_text(child, src).trim().to_string()),
            "assignment_pattern" => {
                if let Some(left) = child_left(child) {
                    if left.kind() == "identifier" {
                        out.push(node_text(left, src).trim().to_string());
                    }
                }
            }
            _ => out.push(String::new()),
        }
    }
    out
}

fn subscript_name(node: Node, src: &str) -> Option<String> {
    let index = node.child_by_field_name("index")?;
    if index.kind() == "string" {
        Some(unquote_str(node_text(index, src).trim()))
    } else {
        None
    }
}

enum BodyInput<'a> {
    Value(Node<'a>),
    Dynamic(&'static str),
}

/// `fetch(url, init)`: the body lives in `init.body`, not in the second argument itself.
/// `JSON.stringify(x)` is unwrapped so the caller's literals are what gets observed.
fn fetch_body_input<'a>(args: Node<'a>, src: &str) -> Option<BodyInput<'a>> {
    let init = unwrap_expression(args.named_child(1)?);
    if init.kind() != "object" {
        return Some(BodyInput::Dynamic(
            "fetch init argument is not an object literal",
        ));
    }
    let dynamic = Some(BodyInput::Dynamic(
        "fetch init argument is not a literal; body may be conditional",
    ));
    let mut cursor = init.walk();
    for child in init.named_children(&mut cursor) {
        match child.kind() {
            "pair" => {
                let key = child
                    .child_by_field_name("key")
                    .map(|k| unquote_str(node_text(k, src).trim()))
                    .unwrap_or_default();
                if key == "body" {
                    let Some(value) = child.child_by_field_name("value") else {
                        return None;
                    };
                    return Some(BodyInput::Value(unwrap_json_stringify(value, src)));
                }
            }
            "shorthand_property_identifier" => {
                if node_text(child, src).trim() == "body" {
                    return Some(BodyInput::Value(child));
                }
            }
            "spread_element" => return dynamic,
            _ => {}
        }
    }
    // An init object without `body` sends no payload (GET/HEAD-style call fields aside).
    None
}

fn unwrap_json_stringify<'a>(node: Node<'a>, src: &str) -> Node<'a> {
    let node = unwrap_expression(node);
    if node.kind() != "call_expression" {
        return node;
    }
    let Some(callee) = node.child_by_field_name("function") else {
        return node;
    };
    if node_text(unwrap_expression(callee), src).trim() != "JSON.stringify" {
        return node;
    }
    node.child_by_field_name("arguments")
        .and_then(|args| args.named_child(0))
        .map(unwrap_expression)
        .unwrap_or(node)
}

fn body_argument<'a>(args: Node<'a>, src: &str) -> Option<Node<'a>> {
    let first = args.named_child(0)?;
    if first.kind() == "object" {
        let mut cursor = first.walk();
        let pairs: Vec<Node> = first
            .named_children(&mut cursor)
            .filter(|n| n.kind() == "pair")
            .collect();
        let has_url = pairs.iter().any(|p| {
            p.child_by_field_name("key")
                .map(|k| unquote_str(node_text(k, src).trim()) == "url")
                .unwrap_or(false)
        });
        if has_url {
            for pair in pairs {
                let key = pair
                    .child_by_field_name("key")
                    .map(|k| unquote_str(node_text(k, src).trim()))
                    .unwrap_or_default();
                if key == "data" || key == "body" {
                    return pair.child_by_field_name("value");
                }
            }
            return None;
        }
    }
    args.named_child(1)
}

/// The call a node continues when both begin at the same byte: `api.get("/x")` inside
/// `api.get("/x").then(cb)`. Byte offsets alone cannot tell an anchored client call from a
/// chain built on it, and only the inner one is the HTTP call.
fn chain_over_call(node: Node, byte: usize) -> Option<Node> {
    let callee = unwrap_expression(node.child_by_field_name("function")?);
    if !matches!(callee.kind(), "member_expression" | "subscript_expression") {
        return None;
    }
    let object = unwrap_expression(callee.child_by_field_name("object")?);
    (object.kind() == "call_expression" && object.start_byte() == byte).then_some(object)
}

fn is_discarded(node: Node) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            "await_expression"
            | "parenthesized_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression" => current = parent,
            "member_expression" | "call_expression" => {
                // Dropping a chain at statement level drops the response it started from:
                // `api.get("/x").then(cb);` keeps no value either.
                if parent.start_byte() == current.start_byte() {
                    current = parent;
                } else {
                    return false;
                }
            }
            "expression_statement" => return true,
            _ => return false,
        }
    }
    false
}

fn param_binding(vr: &ValueRef, _src: &str) -> Option<(usize, usize)> {
    match &vr.origin {
        Origin::Param { scope, index } => Some((*scope, *index)),
        Origin::Path { base, .. } => match &**base {
            Origin::Param { scope, index } => Some((*scope, *index)),
            _ => None,
        },
        _ => None,
    }
}

fn is_axios_metadata(name: &str) -> bool {
    matches!(
        name,
        "status" | "statusText" | "headers" | "config" | "request"
    )
}

/// A superagent response's transport fields. `body` is deliberately absent: it is the
/// payload, not a description of the exchange.
fn is_superagent_metadata(name: &str) -> bool {
    matches!(
        name,
        "text" | "headers" | "status" | "statusCode" | "ok" | "error"
    )
}

fn with_segment(origin: Origin, name: &str) -> Origin {
    match origin {
        Origin::Union(types) => Origin::Union(
            types
                .into_iter()
                .map(|t| with_segment(t, name))
                .collect::<Vec<_>>(),
        ),
        Origin::Body { anchor } => Origin::Path {
            base: Box::new(Origin::Body { anchor }),
            path: name.to_string(),
        },
        Origin::AwaitBody(base) => Origin::Path {
            base: Box::new(Origin::AwaitBody(base)),
            path: name.to_string(),
        },
        Origin::Path { base, path } => Origin::Path {
            base,
            path: join_path(&path, name),
        },
        // An HTTP origin names the transport response, not the wire body. Only the
        // client-kind branch may turn a member read into a body path.
        Origin::Http { anchor } => Origin::Path {
            base: Box::new(Origin::Http { anchor }),
            path: name.to_string(),
        },
        Origin::Param { scope, index } => Origin::Path {
            base: Box::new(Origin::Param { scope, index }),
            path: name.to_string(),
        },
        Origin::Call {
            local,
            module,
            name: call_name,
        } => Origin::Path {
            base: Box::new(Origin::Call {
                local,
                module,
                name: call_name,
            }),
            path: name.to_string(),
        },
        Origin::Unknown => Origin::Unknown,
    }
}

fn with_key(origin: Origin, key: &str) -> Origin {
    with_segment(origin, key)
}

fn join_path(base: &str, name: &str) -> String {
    if base.is_empty() {
        return name.to_string();
    }
    if name.is_empty() {
        return base.to_string();
    }
    if name == "[]" {
        format!("{}[]", base)
    } else {
        format!("{}.{}", base, name)
    }
}

fn origin_relative_path(origin: &Origin) -> Option<String> {
    match origin {
        Origin::Path { path, .. } => Some(path.clone()),
        Origin::Body { .. }
        | Origin::Http { .. }
        | Origin::AwaitBody(_)
        | Origin::Call { .. }
        | Origin::Param { .. } => Some(String::new()),
        Origin::Unknown => None,
        Origin::Union(types) => types
            .iter()
            .filter_map(origin_relative_path)
            .max_by_key(|p| p.len()),
    }
}

fn origin_path_parts(origin: &Origin) -> (Option<usize>, Option<usize>, String) {
    match origin {
        Origin::Param { scope, index } => (Some(*scope), Some(*index), String::new()),
        Origin::Path { base, path } => {
            let (scope, index, base_path) = origin_path_parts(base);
            (scope, index, join_path(&base_path, path))
        }
        _ => (None, None, origin_relative_path(origin).unwrap_or_default()),
    }
}

fn compose_path(origin: Origin, relative: &str) -> Origin {
    if relative.is_empty() {
        return origin;
    }
    match origin {
        Origin::Union(types) => Origin::Union(
            types
                .into_iter()
                .map(|t| compose_path(t, relative))
                .collect(),
        ),
        Origin::Path { base, path } => Origin::Path {
            base,
            path: join_path(&path, relative),
        },
        other => Origin::Path {
            base: Box::new(other),
            path: relative.to_string(),
        },
    }
}

fn is_array_method(name: &str) -> bool {
    matches!(
        name,
        "map"
            | "flatMap"
            | "forEach"
            | "filter"
            | "find"
            | "findLast"
            | "some"
            | "every"
            | "reduce"
            | "reduceRight"
            | "sort"
            | "toSorted"
            | "findIndex"
            | "findLastIndex"
    )
}

fn scalar_fact(kind: ObservedKind, file: &str, line: u32) -> ArgFact {
    ArgFact {
        kind: ArgKind::Scalar(kind),
        fields: vec![],
        complete: true,
        line,
        file: file.to_string(),
        reason: None,
    }
}

// Keep the kind hint used for bare identifier reads; it is intentionally conservative.
impl ValueRef {
    fn kind_hint(&self) -> Option<ObservedKind> {
        None
    }
}

// ---------------------------------------------------------------------------
// Wrapper and helper registries
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct WrapperInfo {
    file: String,
    anchor: usize,
    body: bool,
    body_path: String,
    client: ClientKind,
    body_param: Option<usize>,
    exported: bool,
    has_callers: bool,
    consumed_call: bool,
}

#[derive(Default)]
struct WrapperRegistry {
    by_scope: HashMap<usize, WrapperInfo>,
    by_module: HashMap<(String, String), usize>,
    by_anchor: HashMap<(String, usize), WrapperInfo>,
}

impl WrapperRegistry {
    fn build(analyses: &[FileAnalysis], clients: &HashMap<(String, usize), ClientKind>) -> Self {
        let mut registry = WrapperRegistry::default();
        for analysis in analyses {
            for scope in &analysis.scopes {
                let Some(info) = wrapper_info(scope, clients) else {
                    continue;
                };
                registry.by_scope.insert(scope.id, info);
                if scope.module_level {
                    let module = strip_script_extension(&scope.file).to_string();
                    for export in &scope.export_names {
                        registry
                            .by_module
                            .insert((module.clone(), export.clone()), scope.id);
                    }
                }
            }
        }

        for analysis in analyses {
            for call in &analysis.calls {
                let Some(scope_id) = registry.target_scope(&call.target) else {
                    continue;
                };
                if let Some(info) = registry.by_scope.get_mut(&scope_id) {
                    info.has_callers = true;
                    info.consumed_call |= !call.discarded;
                }
            }
        }

        for info in registry.by_scope.values() {
            registry
                .by_anchor
                .entry((info.file.clone(), info.anchor))
                .or_insert_with(|| info.clone());
        }
        registry
    }

    fn target_scope(&self, target: &CallTarget) -> Option<usize> {
        match target {
            CallTarget::Local(id) => self.by_scope.contains_key(id).then_some(*id),
            CallTarget::Imported { module, name } => {
                self.by_module.get(&(module.clone(), name.clone())).copied()
            }
        }
    }

    fn lookup_target(&self, target: &CallTarget) -> Option<&WrapperInfo> {
        self.target_scope(target)
            .and_then(|id| self.by_scope.get(&id))
    }

    fn by_anchor(&self, file: &str, anchor: usize) -> Option<&WrapperInfo> {
        self.by_anchor.get(&(file.to_string(), anchor))
    }
}

fn wrapper_info(
    scope: &FunctionScope,
    clients: &HashMap<(String, usize), ClientKind>,
) -> Option<WrapperInfo> {
    if scope.returns.is_empty() {
        return None;
    }
    let mut resolved: Option<(usize, bool, String, ClientKind)> = None;
    for value in &scope.returns {
        let target = resolve_return_origin(&value.origin, scope, clients)?;
        match &resolved {
            None => resolved = Some(target),
            Some(existing) => {
                if existing.0 != target.0 || existing.1 != target.1 || existing.2 != target.2 {
                    return None;
                }
            }
        }
    }
    let (anchor, body, body_path, client) = resolved?;

    let body_param = scope
        .body_params
        .iter()
        .find(|(a, _)| *a == anchor)
        .map(|(_, index)| *index);
    Some(WrapperInfo {
        file: scope.file.clone(),
        anchor,
        body,
        body_path,
        client,
        body_param,
        exported: !scope.export_names.is_empty(),
        has_callers: false,
        consumed_call: false,
    })
}

fn resolve_return_origin(
    origin: &Origin,
    scope: &FunctionScope,
    clients: &HashMap<(String, usize), ClientKind>,
) -> Option<(usize, bool, String, ClientKind)> {
    match origin {
        Origin::Http { anchor } => {
            let client = clients
                .get(&(scope.file.clone(), *anchor))
                .copied()
                .unwrap_or(ClientKind::Unknown);
            Some((*anchor, client == ClientKind::Direct, String::new(), client))
        }
        Origin::Body { anchor } => Some((
            *anchor,
            true,
            String::new(),
            clients
                .get(&(scope.file.clone(), *anchor))
                .copied()
                .unwrap_or(ClientKind::Unknown),
        )),
        Origin::Path { base, path } => {
            let (anchor, body, base_path, client) = resolve_return_origin(base, scope, clients)?;
            if body {
                return Some((anchor, true, join_path(&base_path, path), client));
            }
            match client {
                ClientKind::Direct => Some((anchor, true, join_path(&base_path, path), client)),
                ClientKind::Axios => {
                    let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
                    match segments.first().copied() {
                        Some("data") => {
                            let rest = segments[1..].join(".");
                            Some((anchor, true, join_path(&base_path, &rest), client))
                        }
                        Some(first) if is_axios_metadata(first) => None,
                        Some(_) => None,
                        None => Some((anchor, true, base_path, client)),
                    }
                }
                ClientKind::Superagent => {
                    let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
                    match segments.first().copied() {
                        Some("body") => {
                            let rest = segments[1..].join(".");
                            Some((anchor, true, join_path(&base_path, &rest), client))
                        }
                        Some(first) if is_superagent_metadata(first) => None,
                        Some(_) => None,
                        None => Some((anchor, true, base_path, client)),
                    }
                }
                ClientKind::Fetch | ClientKind::Unknown => None,
            }
        }
        Origin::Union(types) => {
            let mut out: Option<(usize, bool, String, ClientKind)> = None;
            for t in types {
                let target = resolve_return_origin(t, scope, clients)?;
                match &out {
                    None => out = Some(target),
                    Some(existing) if *existing == target => {}
                    Some(_) => return None,
                }
            }
            out
        }
        _ => None,
    }
}

struct ParamAccess {
    index: usize,
    path: String,
    kind: Option<ObservedKind>,
    guarded: bool,
}

struct HelperSummaries {
    by_scope: HashMap<usize, Vec<ParamAccess>>,
    module_scope: HashMap<(String, String), usize>,
}

impl HelperSummaries {
    fn build(analyses: &[FileAnalysis]) -> Self {
        let mut by_scope: HashMap<usize, Vec<ParamAccess>> = HashMap::new();
        let mut module_scope: HashMap<(String, String), usize> = HashMap::new();
        for analysis in analyses {
            for scope in &analysis.scopes {
                if scope.module_level {
                    let module = strip_script_extension(&scope.file).to_string();
                    if let Some(name) = &scope.name {
                        module_scope
                            .entry((module, name.clone()))
                            .or_insert(scope.id);
                    }
                    for export in &scope.export_names {
                        module_scope
                            .entry((
                                strip_script_extension(&scope.file).to_string(),
                                export.clone(),
                            ))
                            .or_insert(scope.id);
                    }
                }
                by_scope.entry(scope.id).or_default();
            }
            for fact in &analysis.accesses {
                let (scope, index, path) = origin_path_parts(&fact.origin);
                let (Some(scope), Some(index)) = (scope, index) else {
                    continue;
                };
                if path.is_empty() {
                    continue;
                }
                by_scope.entry(scope).or_default().push(ParamAccess {
                    index,
                    path,
                    kind: fact.kind,
                    guarded: fact.guarded,
                });
            }
        }
        HelperSummaries {
            by_scope,
            module_scope,
        }
    }

    fn summary_for(&self, target: &CallTarget) -> Option<&Vec<ParamAccess>> {
        match target {
            CallTarget::Local(id) => self.by_scope.get(id),
            CallTarget::Imported { module, name } => self
                .module_scope
                .get(&(module.clone(), name.clone()))
                .and_then(|id| self.by_scope.get(id)),
        }
    }
}

fn compose_helper_accesses(
    analyses: &[FileAnalysis],
    helpers: &HelperSummaries,
) -> Vec<AccessFact> {
    let mut out = Vec::new();
    for analysis in analyses {
        for call in &analysis.calls {
            let Some(summary) = helpers.summary_for(&call.target) else {
                continue;
            };
            for access in summary {
                let Some(arg) = call.args.get(access.index) else {
                    continue;
                };
                if matches!(arg.origin, Origin::Unknown) {
                    continue;
                }
                let origin = compose_path(arg.origin.clone(), &access.path);
                out.push(AccessFact {
                    origin,
                    kind: access.kind,
                    guarded: access.guarded || arg.guarded || call.guarded,
                    alt_site: call.alt_site,
                    dynamic: false,
                    line: call.line,
                    file: call.file.clone(),
                });
            }
        }
    }
    out
}

#[derive(Clone)]
struct ResolvedTarget {
    file: String,
    anchor: usize,
    path: String,
    advisory: bool,
}

/// The transport value an origin ultimately names, before any envelope handling. The
/// source file travels with the anchor: identical byte offsets in two files are different
/// call sites.
#[derive(Clone)]
struct BaseTarget {
    file: String,
    anchor: usize,
    /// The origin already names the wire body rather than the transport response.
    body: bool,
    path: String,
    client: ClientKind,
}

fn resolve_base(
    origin: &Origin,
    clients: &HashMap<(String, usize), ClientKind>,
    registry: &WrapperRegistry,
    depth: usize,
    file: &str,
) -> Vec<BaseTarget> {
    if depth > 16 {
        return vec![];
    }
    match origin {
        Origin::Http { anchor } => {
            let client = clients
                .get(&(file.to_string(), *anchor))
                .copied()
                .unwrap_or(ClientKind::Unknown);
            vec![BaseTarget {
                file: file.to_string(),
                anchor: *anchor,
                body: false,
                path: String::new(),
                client,
            }]
        }
        Origin::Body { anchor } => {
            let client = clients
                .get(&(file.to_string(), *anchor))
                .copied()
                .unwrap_or(ClientKind::Unknown);
            vec![BaseTarget {
                file: file.to_string(),
                anchor: *anchor,
                body: true,
                path: String::new(),
                client,
            }]
        }
        Origin::AwaitBody(inner) => resolve_base(inner, clients, registry, depth + 1, file)
            .into_iter()
            .map(|mut target| {
                target.body = true;
                target
            })
            .collect(),
        Origin::Path { base, path } => resolve_base(base, clients, registry, depth + 1, file)
            .into_iter()
            .map(|mut target| {
                target.path = join_path(&target.path, path);
                target
            })
            .collect(),
        Origin::Call {
            local,
            module,
            name,
        } => {
            let info = match local {
                Some(id) => registry.by_scope.get(id),
                None => registry
                    .by_module
                    .get(&(module.clone(), name.clone()))
                    .and_then(|id| registry.by_scope.get(id)),
            };
            let Some(info) = info else {
                return vec![];
            };
            vec![BaseTarget {
                file: info.file.clone(),
                anchor: info.anchor,
                body: info.body,
                path: info.body_path.clone(),
                client: info.client,
            }]
        }
        Origin::Param { .. } | Origin::Unknown => vec![],
        Origin::Union(types) => types
            .iter()
            .flat_map(|t| resolve_base(t, clients, registry, depth + 1, file))
            .collect(),
    }
}

fn resolve_origin(
    origin: &Origin,
    clients: &HashMap<(String, usize), ClientKind>,
    registry: &WrapperRegistry,
    depth: usize,
    file: &str,
) -> Vec<ResolvedTarget> {
    let mut out = Vec::new();
    for base in resolve_base(origin, clients, registry, depth, file) {
        if base.body {
            if !base.path.is_empty() {
                out.push(ResolvedTarget {
                    file: base.file,
                    anchor: base.anchor,
                    path: base.path,
                    advisory: false,
                });
            }
        } else {
            out.extend(resolve_transport_path(
                base.anchor,
                base.client,
                &base.path,
                &base.file,
            ));
        }
    }
    out
}

fn resolve_transport_path(
    anchor: usize,
    client: ClientKind,
    path: &str,
    file: &str,
) -> Vec<ResolvedTarget> {
    if path.is_empty() {
        return vec![];
    }
    let target = |path: String, advisory: bool| ResolvedTarget {
        file: file.to_string(),
        anchor,
        path,
        advisory,
    };
    match client {
        ClientKind::Axios => {
            let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
            match segments.first().copied() {
                Some("data") => {
                    let rest = segments[1..].join(".");
                    if rest.is_empty() {
                        vec![]
                    } else {
                        vec![target(rest, false)]
                    }
                }
                Some(first) if is_axios_metadata(first) => vec![],
                Some(_) => vec![target(path.to_string(), true)],
                None => vec![],
            }
        }
        ClientKind::Superagent => {
            let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
            match segments.first().copied() {
                Some("body") => {
                    let rest = segments[1..].join(".");
                    if rest.is_empty() {
                        vec![]
                    } else {
                        vec![target(rest, false)]
                    }
                }
                Some(first) if is_superagent_metadata(first) => vec![],
                Some(_) => vec![target(path.to_string(), true)],
                None => vec![],
            }
        }
        ClientKind::Direct => vec![target(path.to_string(), false)],
        ClientKind::Fetch => vec![],
        ClientKind::Unknown => vec![target(path.to_string(), true)],
    }
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Evidence {
    accesses: Vec<AccessRecord>,
    request: Vec<ArgFact>,
    has_callers: bool,
    consumed_call: bool,
    discarded: bool,
    transport_read: bool,
    dynamic: bool,
    no_body: bool,
}

#[derive(Clone)]
struct AccessRecord {
    path: String,
    kind: Option<ObservedKind>,
    guaranteed: bool,
    alt_site: Option<usize>,
    file: String,
    line: u32,
}

fn build_accesses(evidence: &Evidence) -> Vec<ObservedAccess> {
    let mut records = evidence.accesses.clone();
    records.sort_by(|a, b| {
        (&a.path, a.alt_site, a.guaranteed, &a.file, a.line).cmp(&(
            &b.path,
            b.alt_site,
            b.guaranteed,
            &b.file,
            b.line,
        ))
    });

    let mut sites: Vec<usize> = records.iter().filter_map(|r| r.alt_site).collect();
    sites.sort_unstable();
    sites.dedup();
    let groups: HashMap<usize, u32> = sites
        .into_iter()
        .enumerate()
        .map(|(i, site)| (site, i as u32 + 1))
        .collect();

    let mut by_path: BTreeMap<String, ObservedAccess> = BTreeMap::new();
    for record in records {
        let entry = by_path
            .entry(record.path.clone())
            .or_insert_with(|| ObservedAccess {
                path: record.path.clone(),
                kind: record.kind,
                guaranteed: record.guaranteed,
                alternative_group: record.alt_site.and_then(|s| groups.get(&s).copied()),
                provenance: provenance(&record.file, record.line, None),
            });
        if record.guaranteed {
            entry.guaranteed = true;
            entry.alternative_group = None;
        }
        if entry.kind.is_none() {
            entry.kind = record.kind;
        }
    }
    by_path.into_values().collect()
}

/// Merge the evidence of every call site that produced one contract. Reads that only one
/// consumer performs are still reads of the endpoint, but alternative groups are local to
/// a call site, so they are dropped when more than one site contributes.
pub(crate) fn merge_observed_response(
    calls: &[&RawClientCall],
) -> Option<ObservedResponseEvidence> {
    let evidence: Vec<&ObservedResponseEvidence> = calls
        .iter()
        .filter_map(|c| c.observed_response.as_ref())
        .collect();
    if evidence.is_empty() {
        return None;
    }

    let mut accesses: BTreeMap<String, ObservedAccess> = BTreeMap::new();
    for ev in &evidence {
        for access in &ev.accesses {
            match accesses.get_mut(&access.path) {
                Some(existing) => {
                    existing.guaranteed |= access.guaranteed;
                    if existing.kind.is_none() {
                        existing.kind = access.kind;
                    }
                }
                None => {
                    accesses.insert(access.path.clone(), access.clone());
                }
            }
        }
    }
    let mut accesses: Vec<ObservedAccess> = accesses.into_values().collect();
    if calls.len() > 1 {
        for access in &mut accesses {
            access.alternative_group = None;
        }
    }

    let has_observed = !accesses.is_empty();
    let status = if has_observed {
        ObservedResponseStatus::Observed
    } else if evidence
        .iter()
        .all(|e| e.status == ObservedResponseStatus::NoCallers)
    {
        ObservedResponseStatus::NoCallers
    } else if evidence
        .iter()
        .all(|e| e.status == ObservedResponseStatus::NotConsumed)
    {
        ObservedResponseStatus::NotConsumed
    } else {
        ObservedResponseStatus::Inconclusive
    };

    // A dynamic access or a partial follow means the observed set is not exhaustive,
    // even when some paths were recovered. Status-specific reasons from call sites that
    // the merged status contradicts ("discarded" next to OBSERVED) are dropped.
    let mut reasons: Vec<String> = evidence
        .iter()
        .filter(|e| status != ObservedResponseStatus::Observed || e.status == status)
        .filter_map(|e| e.reason.clone())
        .collect();
    reasons.sort();
    reasons.dedup();

    Some(ObservedResponseEvidence {
        status,
        accesses,
        reason: if reasons.is_empty() {
            None
        } else {
            Some(reasons.join("; "))
        },
    })
}

pub(crate) fn merge_observed_request(calls: &[&RawClientCall]) -> Option<ObservedRequestBody> {
    let evidence: Vec<&ObservedRequestBody> = calls
        .iter()
        .filter_map(|c| c.observed_request_body.as_ref())
        .collect();
    let first = *evidence.first()?;

    let mut fields: BTreeMap<String, ObservedRequestField> = BTreeMap::new();
    let mut scalar_kind: Option<ObservedKind> = None;
    let mut reasons: Vec<String> = Vec::new();
    for ev in &evidence {
        for field in &ev.fields {
            fields
                .entry(field.wire_name.clone())
                .and_modify(|existing| {
                    if existing.kind.is_none() {
                        existing.kind = field.kind;
                    }
                })
                .or_insert_with(|| field.clone());
        }
        scalar_kind = scalar_kind.or(ev.scalar_kind);
        if let Some(reason) = &ev.reason {
            reasons.push(reason.clone());
        }
    }
    reasons.sort();
    reasons.dedup();

    Some(ObservedRequestBody {
        fields: fields.into_values().collect(),
        scalar_kind,
        reason: if reasons.is_empty() {
            None
        } else {
            Some(reasons.join("; "))
        },
        provenance: first.provenance.clone(),
    })
}

fn build_request_evidence(call: &RawClientCall, entry: Option<&Evidence>) -> ObservedRequestBody {
    let mut reasons: Vec<String> = Vec::new();
    let mut fields: BTreeMap<String, (Option<ObservedKind>, SourceProvenance)> = BTreeMap::new();
    let mut scalar_kind: Option<ObservedKind> = None;
    let mut no_body = false;
    let mut saw_object = false;
    let mut saw_nullish = false;

    if call.request_body_explicit_none {
        no_body = true;
    }
    if let Some(entry) = entry {
        if entry.no_body {
            no_body = true;
        }
        for fact in &entry.request {
            match &fact.kind {
                ArgKind::Object => {
                    saw_object = true;
                    for (name, kind) in &fact.fields {
                        let slot = fields.entry(name.clone()).or_insert_with(|| {
                            (*kind, provenance(&fact.file, fact.line, Some(name.clone())))
                        });
                        if slot.0.is_none() {
                            slot.0 = *kind;
                        }
                    }
                    if !fact.complete {
                        if let Some(reason) = &fact.reason {
                            reasons.push(reason.clone());
                        }
                    }
                }
                ArgKind::Scalar(kind) => scalar_kind = Some(*kind),
                ArgKind::Nullish => saw_nullish = true,
                ArgKind::Dynamic => {
                    if let Some(reason) = &fact.reason {
                        reasons.push(reason.clone());
                    }
                }
            }
        }
    }

    if call.request_body_expr.is_some() && fields.is_empty() && scalar_kind.is_none() {
        if !saw_object && !saw_nullish && reasons.is_empty() {
            reasons.push(
                "request body expression could not be followed to a caller literal".to_string(),
            );
        }
    }
    if no_body || (saw_nullish && !saw_object && !call.request_body_explicit_none) {
        reasons.push("call site sends no request body (null/undefined)".to_string());
    }
    if saw_object && (scalar_kind.is_some() || saw_nullish) {
        reasons.push(
            "call sites disagree on whether the request body is an object, a scalar or absent"
                .to_string(),
        );
    }
    reasons.sort();
    reasons.dedup();

    ObservedRequestBody {
        fields: fields
            .into_iter()
            .map(|(wire_name, (kind, provenance))| ObservedRequestField {
                wire_name,
                kind,
                provenance,
            })
            .collect(),
        scalar_kind,
        reason: if reasons.is_empty() {
            None
        } else {
            Some(reasons.join("; "))
        },
        provenance: provenance(&call.file, call.line, None),
    }
}

fn provenance(file: &str, line: u32, identity: Option<String>) -> SourceProvenance {
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
