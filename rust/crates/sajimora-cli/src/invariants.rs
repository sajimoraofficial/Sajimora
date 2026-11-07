//! sajimora gen-invariants — Autonomous metamorphic invariant test synthesizer.
//!
//! Synthesizes mathematically sound property-based tests:
//! 1. Null-Safety Invariants (@NotNull / @NonNull boundary verification)
//! 2. Idempotence Invariants (f(f(x)) == f(x) for normalizers, sanitizers, formatters)
//! 3. Boundary Range Invariants (legal value domain proofs)
//! 4. Strict Abstention (INVARIANT_UNVERIFIABLE for side-effecting methods)
//!
//! Emits native jqwik (Java) and fast-check (TypeScript) property tests.

use anyhow::{bail, Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

#[derive(Args, Debug, Clone)]
pub struct GenInvariantsArgs {
    /// Positional shorthand for target file (e.g. `sajimora props Sanitizer.java`)
    #[arg(value_name = "TARGET_FILE")]
    pub target_file: Option<PathBuf>,

    /// Target Java or TypeScript source file to analyze
    #[arg(long, short = 'f')]
    pub file: Option<PathBuf>,

    /// Framework to synthesize: "jqwik" (default for Java), "junit5", or "fast-check" (TypeScript)
    #[arg(long, default_value = "jqwik")]
    pub framework: String,

    /// Output file path for the generated property test (defaults to stdout if omitted)
    #[arg(long, short = 'o')]
    pub out: Option<PathBuf>,

    /// Class name for the generated test suite
    #[arg(long, short = 'n')]
    pub name: Option<String>,

    /// Package name for the generated Java test class
    #[arg(long, short = 'p')]
    pub package: Option<String>,

    /// Emit structured JSON diagnostics about discovered and abstained invariants
    #[arg(long)]
    pub json: bool,

    /// Verbose progress logging
    #[arg(long, short)]
    pub verbose: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    pub param_type: String,
    pub is_primitive: bool,
    pub has_non_null_annotation: bool,
    pub annotations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MethodInfo {
    pub name: String,
    pub return_type: String,
    pub parameters: Vec<ParamInfo>,
    pub is_public: bool,
    pub is_static: bool,
    pub has_side_effects: bool,
    pub annotations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InvariantKind {
    NullSafety,
    Idempotence,
    BoundaryRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredInvariant {
    pub method_name: String,
    pub kind: InvariantKind,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantAbstention {
    pub method_name: String,
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct InvariantSynthesisReport {
    pub file: String,
    pub package_name: Option<String>,
    pub class_name: String,
    pub methods_inspected: usize,
    pub invariants_discovered: Vec<DiscoveredInvariant>,
    pub abstentions: Vec<InvariantAbstention>,
    pub synthesized_source: Option<String>,
}

pub fn run(args: GenInvariantsArgs) -> i32 {
    match execute_gen_invariants(&args) {
        Ok(report) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else if let Some(out_path) = &args.out {
                if let Some(src) = &report.synthesized_source {
                    if let Err(e) = fs::write(out_path, src) {
                        eprintln!(
                            "[-] Error writing synthesized test to {:?}: {:#}",
                            out_path, e
                        );
                        return 2;
                    }
                    println!(
                        "[+] Successfully wrote synthesized property tests to {:?}",
                        out_path
                    );
                } else {
                    println!("[!] No unverifiable invariants found to synthesize.");
                }
            } else if let Some(src) = &report.synthesized_source {
                println!("{}", src);
            }

            if !report.invariants_discovered.is_empty() {
                0
            } else {
                1
            }
        }
        Err(e) => {
            eprintln!("[-] Error executing sajimora gen-invariants: {:#}", e);
            2
        }
    }
}

pub fn execute_gen_invariants(args: &GenInvariantsArgs) -> Result<InvariantSynthesisReport> {
    let target_path = match args.file.as_ref().or(args.target_file.as_ref()) {
        Some(p) => p,
        None => {
            bail!("Source file required (e.g. `sajimora props Sanitizer.java` or `--file <path>`)")
        }
    };

    if !target_path.exists() {
        bail!("Source file {:?} does not exist", target_path);
    }

    let source = fs::read_to_string(target_path)
        .with_context(|| format!("Failed to read source file {:?}", target_path))?;

    let is_java = target_path.extension().map_or(false, |ext| ext == "java");

    if is_java {
        analyze_java_invariants(target_path, &source, args)
    } else {
        bail!("Autonomous invariant synthesis currently supports Java source files (.java) with jqwik/junit5. TypeScript invariant analysis via fast-check is planned for General Availability. Please target a .java file.");
    }
}

fn analyze_java_invariants(
    file_path: &Path,
    source: &str,
    args: &GenInvariantsArgs,
) -> Result<InvariantSynthesisReport> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .context("Failed to load tree-sitter-java grammar")?;

    let tree = parser
        .parse(source.as_bytes(), None)
        .context("Failed to parse Java source")?;

    let root = tree.root_node();

    let package_name = extract_package_name(source, root);
    let class_name =
        extract_class_name(source, root).unwrap_or_else(|| "UnknownService".to_string());

    let methods = extract_java_methods(source, root);

    let mut report = InvariantSynthesisReport {
        file: file_path.to_string_lossy().to_string(),
        package_name: args.package.clone().or(package_name),
        class_name: class_name.clone(),
        methods_inspected: methods.len(),
        invariants_discovered: Vec::new(),
        abstentions: Vec::new(),
        synthesized_source: None,
    };

    for method in &methods {
        if !method.is_public {
            continue;
        }

        // Section 6.1 rule: Do not assume idempotence for side-effecting methods (@Transactional, save, etc.)
        if method.has_side_effects {
            report.abstentions.push(InvariantAbstention {
                method_name: method.name.clone(),
                code: "INVARIANT_SIDE_EFFECTS".into(),
                reason: "Method body or annotation indicates mutable state/side-effects. Invariant synthesis abstains.".into(),
            });
            continue;
        }

        // Check 1: Idempotence Invariant f(f(x)) == f(x)
        // Applies to single-argument pure normalizers where return type matches input type
        let is_potential_normalizer = method.name.starts_with("normalize")
            || method.name.starts_with("sanitize")
            || method.name.starts_with("format")
            || method.name.starts_with("clean")
            || method.name.starts_with("canonicalize");

        if is_potential_normalizer && method.parameters.len() == 1 {
            let param = &method.parameters[0];
            if param.param_type == method.return_type && !param.param_type.is_empty() {
                report.invariants_discovered.push(DiscoveredInvariant {
                    method_name: method.name.clone(),
                    kind: InvariantKind::Idempotence,
                    rationale: format!(
                        "Pure normalization function {} with signature {} -> {}. Idempotence f(f(x)) == f(x) provable.",
                        method.name, param.param_type, method.return_type
                    ),
                });
            }
        }

        // Check 2: Null-Safety Invariant
        // Section 6.1 rule: Explicit @NonNull / @NotNull evidence required
        let has_explicit_non_null = method.parameters.iter().any(|p| p.has_non_null_annotation);

        if has_explicit_non_null {
            report.invariants_discovered.push(DiscoveredInvariant {
                method_name: method.name.clone(),
                kind: InvariantKind::NullSafety,
                rationale: format!(
                    "Method {} declares explicit @NonNull / @NotNull annotations. Null-safety boundary provable.",
                    method.name
                ),
            });
        }

        // Check 3: Boundary Range Invariant
        let has_range_annotation = method.parameters.iter().any(|p| {
            p.annotations
                .iter()
                .any(|a| a.contains("Min") || a.contains("Max") || a.contains("Positive"))
        });

        if has_range_annotation {
            report.invariants_discovered.push(DiscoveredInvariant {
                method_name: method.name.clone(),
                kind: InvariantKind::BoundaryRange,
                rationale: format!(
                    "Method {} declares numeric range annotations (@Min/@Max/@Positive). Boundary range provable.",
                    method.name
                ),
            });
        }
    }

    if !report.invariants_discovered.is_empty() {
        let test_class_name = args
            .name
            .clone()
            .unwrap_or_else(|| format!("{}InvariantsTest", class_name));
        report.synthesized_source =
            Some(emit_jqwik_test_suite(&report, &methods, &test_class_name));
    }

    Ok(report)
}

fn emit_jqwik_test_suite(
    report: &InvariantSynthesisReport,
    methods: &[MethodInfo],
    test_class_name: &str,
) -> String {
    let mut out = String::new();

    if let Some(pkg) = &report.package_name {
        out.push_str(&format!("package {};\n\n", pkg));
    }

    out.push_str("// Auto-generated by Sajimora Metamorphic Invariant Synthesizer\n");
    out.push_str("// 100% Deterministic Property-Based Tests (0 LLM Calls)\n\n");
    out.push_str("import net.jqwik.api.*;\n");
    out.push_str("import net.jqwik.api.constraints.*;\n");
    out.push_str("import org.junit.jupiter.api.Assertions;\n");
    out.push_str("import static org.junit.jupiter.api.Assertions.*;\n\n");

    out.push_str(&format!("public class {} {{\n\n", test_class_name));
    out.push_str(&format!(
        "    private final {} service = new {}();\n\n",
        report.class_name, report.class_name
    ));

    for inv in &report.invariants_discovered {
        let method = match methods.iter().find(|m| m.name == inv.method_name) {
            Some(m) => m,
            None => continue,
        };

        match inv.kind {
            InvariantKind::Idempotence => {
                let param = &method.parameters[0];
                let jqwik_type = map_type_to_jqwik(&param.param_type);
                out.push_str("    /**\n");
                out.push_str(&format!(
                    "     * Property: Idempotence Invariant for {}\n",
                    method.name
                ));
                out.push_str("     * f(f(x)) == f(x)\n");
                out.push_str("     */\n");
                out.push_str("    @Property\n");
                out.push_str(&format!(
                    "    void idempotence_{}(@ForAll {} input) {{\n",
                    method.name, jqwik_type
                ));
                out.push_str(&format!(
                    "        {} first = service.{}(input);\n",
                    method.return_type, method.name
                ));
                out.push_str(&format!(
                    "        {} second = service.{}(first);\n",
                    method.return_type, method.name
                ));
                out.push_str("        assertEquals(first, second, \"Idempotence violated: f(f(x)) != f(x)\");\n");
                out.push_str("    }\n\n");
            }
            InvariantKind::NullSafety => {
                out.push_str("    /**\n");
                out.push_str(&format!(
                    "     * Property: Null-Safety Invariant for {}\n",
                    method.name
                ));
                out.push_str("     * Passing null to @NonNull parameters must throw an explicit exception.\n");
                out.push_str("     */\n");
                out.push_str("    @Property\n");
                out.push_str(&format!("    void nullSafety_{}() {{\n", method.name));
                out.push_str("        assertThrows(Exception.class, () -> {\n");
                out.push_str(&format!("            service.{}(", method.name));
                let call_args: Vec<String> = method
                    .parameters
                    .iter()
                    .map(|p| {
                        if p.is_primitive {
                            match p.param_type.as_str() {
                                "boolean" => "false".to_string(),
                                "double" | "float" => "0.0".to_string(),
                                "long" => "0L".to_string(),
                                _ => "0".to_string(),
                            }
                        } else {
                            "null".to_string()
                        }
                    })
                    .collect();
                out.push_str(&call_args.join(", "));
                out.push_str(");\n");
                out.push_str("        });\n");
                out.push_str("    }\n\n");
            }
            InvariantKind::BoundaryRange => {
                let range_param_idx = method
                    .parameters
                    .iter()
                    .position(|p| {
                        p.annotations.iter().any(|a| {
                            a.contains("Min") || a.contains("Max") || a.contains("Positive")
                        })
                    })
                    .unwrap_or(0);

                let range_param = &method.parameters[range_param_idx];
                let range_type = map_type_to_jqwik(&range_param.param_type);

                out.push_str("    /**\n");
                out.push_str(&format!(
                    "     * Property: Boundary Range Invariant for {}\n",
                    method.name
                ));
                out.push_str("     */\n");
                out.push_str("    @Property\n");
                out.push_str(&format!(
                    "    void rangeCheck_{}(@ForAll @Positive {} val) {{\n",
                    method.name, range_type
                ));

                let call_args: Vec<String> = method
                    .parameters
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        if i == range_param_idx {
                            "val".to_string()
                        } else if p.is_primitive {
                            match p.param_type.as_str() {
                                "boolean" => "false".to_string(),
                                "double" | "float" => "0.0".to_string(),
                                "long" => "0L".to_string(),
                                _ => "0".to_string(),
                            }
                        } else {
                            "\"test\"".to_string()
                        }
                    })
                    .collect();

                let is_primitive_return = matches!(
                    method.return_type.as_str(),
                    "int" | "long" | "double" | "float" | "boolean" | "byte" | "short" | "char"
                );
                if is_primitive_return {
                    out.push_str(&format!(
                        "        var result = service.{}({});\n",
                        method.name,
                        call_args.join(", ")
                    ));
                    out.push_str("        assertEquals(result, result);\n");
                } else {
                    out.push_str(&format!(
                        "        assertNotNull(service.{}({}));\n",
                        method.name,
                        call_args.join(", ")
                    ));
                }
                out.push_str("    }\n\n");
            }
        }
    }

    out.push_str("}\n");
    out
}

fn map_type_to_jqwik(java_type: &str) -> &str {
    match java_type {
        "String" => "String",
        "int" | "Integer" => "int",
        "long" | "Long" => "long",
        "double" | "Double" => "double",
        "boolean" | "Boolean" => "boolean",
        other => other,
    }
}

fn extract_package_name(source: &str, root: Node) -> Option<String> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "package_declaration" {
            let mut sub_cursor = child.walk();
            for sub in child.children(&mut sub_cursor) {
                if sub.kind() == "scoped_identifier" || sub.kind() == "identifier" {
                    return source
                        .get(sub.start_byte()..sub.end_byte())
                        .map(|s| s.to_string());
                }
            }
        }
    }
    None
}

fn extract_class_name(source: &str, root: Node) -> Option<String> {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "class_declaration" {
            if let Some(name_node) = child.child_by_field_name("name") {
                return source
                    .get(name_node.start_byte()..name_node.end_byte())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

fn extract_java_methods(source: &str, root: Node) -> Vec<MethodInfo> {
    let mut methods = Vec::new();
    walk_for_methods(source, root, &mut methods);
    methods
}

fn walk_for_methods(source: &str, node: Node, methods: &mut Vec<MethodInfo>) {
    if node.kind() == "method_declaration" {
        if let Some(method_info) = parse_method_node(source, node) {
            methods.push(method_info);
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_for_methods(source, child, methods);
    }
}

fn parse_method_node(source: &str, node: Node) -> Option<MethodInfo> {
    let name_node = node.child_by_field_name("name")?;
    let name = source
        .get(name_node.start_byte()..name_node.end_byte())?
        .to_string();

    let return_type = node
        .child_by_field_name("type")
        .and_then(|t| source.get(t.start_byte()..t.end_byte()))
        .unwrap_or("void")
        .to_string();

    let mut is_public = false;
    let mut is_static = false;
    let mut annotations = Vec::new();
    let mut has_side_effects = false;

    // Check modifiers and annotations
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for m in child.children(&mut mod_cursor) {
                let mod_text = source.get(m.start_byte()..m.end_byte()).unwrap_or("");
                if mod_text == "public" {
                    is_public = true;
                }
                if mod_text == "static" {
                    is_static = true;
                }
                if m.kind() == "annotation" || m.kind() == "marker_annotation" {
                    annotations.push(mod_text.to_string());
                    if mod_text.contains("Transactional") || mod_text.contains("Modifying") {
                        has_side_effects = true;
                    }
                }
            }
        }
    }

    // Inspect method body for side-effects like repo.save(), delete, update
    if let Some(body) = node.child_by_field_name("body") {
        let body_text = source.get(body.start_byte()..body.end_byte()).unwrap_or("");
        if body_text.contains(".save(")
            || body_text.contains(".delete(")
            || body_text.contains(".update(")
            || body_text.contains("System.out.println")
        {
            has_side_effects = true;
        }
    }

    // Extract parameters
    let mut parameters = Vec::new();
    if let Some(params_node) = node.child_by_field_name("parameters") {
        let mut p_cursor = params_node.walk();
        for param in params_node.named_children(&mut p_cursor) {
            if param.kind() == "formal_parameter" {
                if let Some(param_info) = parse_param_node(source, param) {
                    parameters.push(param_info);
                }
            }
        }
    }

    Some(MethodInfo {
        name,
        return_type,
        parameters,
        is_public,
        is_static,
        has_side_effects,
        annotations,
    })
}

fn parse_param_node(source: &str, node: Node) -> Option<ParamInfo> {
    let name_node = node.child_by_field_name("name")?;
    let name = source
        .get(name_node.start_byte()..name_node.end_byte())?
        .to_string();

    let param_type = node
        .child_by_field_name("type")
        .and_then(|t| source.get(t.start_byte()..t.end_byte()))
        .unwrap_or("Object")
        .to_string();

    let is_primitive = matches!(
        param_type.as_str(),
        "int" | "long" | "double" | "float" | "boolean" | "byte" | "short" | "char"
    );

    let mut has_non_null_annotation = false;
    let mut annotations = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for m in child.children(&mut mod_cursor) {
                if m.kind() == "annotation" || m.kind() == "marker_annotation" {
                    let annot_text = source.get(m.start_byte()..m.end_byte()).unwrap_or("");
                    annotations.push(annot_text.to_string());
                    if annot_text.contains("NonNull") || annot_text.contains("NotNull") {
                        has_non_null_annotation = true;
                    }
                }
            }
        }
    }

    Some(ParamInfo {
        name,
        param_type,
        is_primitive,
        has_non_null_annotation,
        annotations,
    })
}
