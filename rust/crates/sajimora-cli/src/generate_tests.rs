//! generate_tests.rs — Native Rust property and contract test synthesis CLI command.
//!
//! Synthesizes:
//! - Standard JUnit 5 integration tests (MockMvc) for Spring WebMvc
//! - JUnit 4 vintage integration tests (MockMvc) for legacy Spring WebMvc
//! - jqwik property tests (MockMvc + Arbitrary) when explicitly requested
//! - fast-check property tests for TypeScript HTTP clients
//!
//! Enforces:
//! - Strict abstention on WireType::Unknown
//! - Zero silent modifications of pom.xml, build.gradle, or version catalogs
//! - Automatic package and source root resolution
//! - Atomic file placement and compilation rollback validation

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::envelope::parse_envelope;
use contract_core::request_synthesis::RequestFixtures;
use contract_core::synthesis::{
    synthesize_tests_with_summary, SynthesisOptions, SynthesisSummary, TestSynthesisFramework,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Args, Debug)]
pub struct GenerateTestsArgs {
    /// Path to the input contract artifact JSON (defaults to auto-detecting .sajimora/backend-contract.json).
    #[arg(long)]
    pub contract: Option<PathBuf>,

    /// Framework to synthesize tests for: "junit5" (default, MockMvc), "junit4" (Vintage MockMvc), "jqwik" (Java property), or "fast-check" (TypeScript).
    #[arg(long, default_value = "junit5")]
    pub framework: TestSynthesisFramework,

    /// Output path for the synthesized test source file.
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Class name (Java) or test suite name (TypeScript).
    #[arg(long)]
    pub name: Option<String>,

    /// Explicit package name for Java tests (auto-detected from source if omitted).
    #[arg(long)]
    pub package: Option<String>,

    /// Verify generated tests compile cleanly using the project build system (mvn test-compile or gradle testClasses).
    #[arg(long)]
    pub verify_build: bool,

    /// Local JSON request fixtures for JUnit 5: endpoint bodies, parameters, authentication, SQL and expected status.
    #[arg(long)]
    pub request_fixtures: Option<PathBuf>,

    /// Target Spring Boot major version (2, 3, or 4). Defaults to auto-detection from the project the
    /// contract's provenance points at; `@AutoConfigureMockMvc` lives in a different package on
    /// Boot 4, so a wrong guess does not compile.
    #[arg(long)]
    pub spring_boot_major: Option<u8>,
}

pub(crate) struct GenerateTestsOutcome {
    pub path: PathBuf,
    pub summary: SynthesisSummary,
    pub generated_class: Option<String>,
}

pub fn run(args: GenerateTestsArgs) -> i32 {
    match run_cli(args) {
        Ok(outcome) => {
            let no_checks = outcome.summary.executable_contract_checks == 0;
            let partial = outcome.summary.partial_checks > 0
                || outcome.summary.status_only_checks > 0
                || outcome.summary.diagnostics > 0
                || outcome.summary.abstentions > 0;
            eprintln!(
                "{}",
                serde_json::json!({
                    "generation": {
                        "outcome": if no_checks { "no_executable_contract_checks" } else if partial { "partial" } else { "complete" },
                        "failures": usize::from(no_checks),
                        "summary": outcome.summary,
                    },
                    "path": outcome.path,
                })
            );
            i32::from(no_checks)
        }
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::json!({"error": format!("{e:#}"), "generation": {"outcome": "failed", "failures": 1}})
            );
            1
        }
    }
}

fn run_cli(mut args: GenerateTestsArgs) -> Result<GenerateTestsOutcome> {
    let repo_root = std::env::current_dir()?;
    let contract_path = resolve_contract_path(args.contract.as_deref())?;
    let backend_root = if args.framework == TestSynthesisFramework::FastCheck
        || args.framework == TestSynthesisFramework::Supertest
    {
        repo_root.clone()
    } else {
        let candidate_from_contract = if let Some(parent) = contract_path.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some(".sajimora") {
                parent.parent().map(|p| p.to_path_buf())
            } else {
                Some(parent.to_path_buf())
            }
        } else {
            None
        };

        if let Some(cand) = candidate_from_contract {
            if cand.join("pom.xml").exists()
                || cand.join("build.gradle").exists()
                || cand.join("build.gradle.kts").exists()
                || cand.join("src/main/java").exists()
            {
                fs::canonicalize(cand)?
            } else {
                fs::canonicalize(resolve_backend_dir())?
            }
        } else {
            fs::canonicalize(resolve_backend_dir())?
        }
    };
    // Preserve explicit CLI paths relative to the invocation directory.
    args.contract = Some(contract_path);
    if let Some(out) = args.out.as_mut() {
        *out = repo_root.join(&*out);
    }
    run_for_backend(args, &backend_root, &repo_root)
}

/// Explicit roots: contract/fixture paths are repository-relative and output paths
/// are backend-relative. No process-CWD changes or ambient backend rediscovery.
pub(crate) fn run_for_backend(
    args: GenerateTestsArgs,
    backend_root: &Path,
    repo_root: &Path,
) -> Result<GenerateTestsOutcome> {
    let backend_dir = fs::canonicalize(backend_root)?;
    let repo_root = fs::canonicalize(repo_root)?;
    let mut framework = args.framework;
    let contract_path = if let Some(contract) = args.contract.as_deref() {
        repo_root.join(contract)
    } else {
        [repo_root.join(".sajimora/backend-contract.json"), backend_dir.join(".sajimora/backend-contract.json"),
         repo_root.join(".sajimora/candidate-contract.json"), backend_dir.join(".sajimora/candidate-contract.json")]
            .into_iter().find(|path| path.is_file())
            .ok_or_else(|| anyhow!("Could not find `.sajimora/backend-contract.json`. Please specify --contract <PATH>"))?
    };

    let is_java = matches!(
        framework,
        TestSynthesisFramework::JUnit5
            | TestSynthesisFramework::JUnit4
            | TestSynthesisFramework::Jqwik
    );

    let mut detected_package = args.package.clone();

    if is_java {
        let allow_standalone = args.out.is_some();
        inspect_java_environment(&backend_dir, &mut framework, allow_standalone)?;

        if detected_package.is_none() {
            let main_src = backend_dir.join("src/main/java");
            detected_package = detect_java_package(&main_src);
            if detected_package.is_none() {
                let test_src = backend_dir.join("src/test/java");
                detected_package = detect_java_package(&test_src);
            }
        }
    }

    let default_class_name = if framework == TestSynthesisFramework::Jqwik {
        "ContractPropertyTest"
    } else if framework == TestSynthesisFramework::FastCheck {
        "Contract Property Tests"
    } else if framework == TestSynthesisFramework::Supertest {
        "NestJS Contract E2E"
    } else {
        "ContractTest"
    };

    let class_name = args.name.as_deref().unwrap_or(default_class_name);
    if is_java {
        validate_java_names(class_name, detected_package.as_deref())?;
        if args
            .spring_boot_major
            .is_some_and(|major| major != 2 && major != 3 && major != 4)
        {
            return Err(anyhow!(
                "DIAGNOSTIC_SYNTAX_ERROR: --spring-boot-major must be 2, 3, or 4"
            ));
        }
    }

    let out_path = if let Some(ref o) = args.out {
        backend_dir.join(o)
    } else {
        match framework {
            TestSynthesisFramework::FastCheck => backend_dir.join("tests/contract.spec.ts"),
            TestSynthesisFramework::Supertest => backend_dir.join("test/contract.e2e-spec.ts"),
            TestSynthesisFramework::JUnit5
            | TestSynthesisFramework::JUnit4
            | TestSynthesisFramework::Jqwik => {
                let test_root = backend_dir.join("src/test/java");
                if let Some(ref pkg) = detected_package {
                    let pkg_rel = pkg.replace('.', "/");
                    test_root.join(pkg_rel).join(format!("{}.java", class_name))
                } else {
                    test_root.join(format!("{}.java", class_name))
                }
            }
        }
    };

    let bytes = fs::read(&contract_path).map_err(|e| {
        anyhow!(
            "Failed to read contract artifact at {:?}: {}",
            contract_path,
            e
        )
    })?;

    let envelope =
        parse_envelope(&bytes).map_err(|e| anyhow!("Failed to parse contract envelope: {}", e))?;

    let options = synthesis_options(&backend_dir, &envelope, args.spring_boot_major);
    let fixtures = args
        .request_fixtures
        .as_deref()
        .map(|path| {
            let path = repo_root.join(path);
            serde_json::from_slice::<RequestFixtures>(&fs::read(&path).map_err(|error| {
                anyhow!("Failed to read request fixtures at {:?}: {}", path, error)
            })?)
            .map_err(|error| anyhow!("Invalid request fixture configuration: {}", error))
        })
        .transpose()?;
    let synthesis = synthesize_tests_with_summary(
        &envelope,
        framework,
        Some(class_name),
        detected_package.as_deref(),
        fixtures.as_ref(),
        options,
    )?;

    write_atomic_validated(&out_path, &synthesis.code, || {
        if args.verify_build {
            if !is_java {
                return Err(anyhow!(
                    "SAFE_ABSTENTION: compilation validation is not supported for this framework"
                ));
            }
            let source_root = fs::canonicalize(backend_dir.join("src/test/java"))
                .map_err(|_| anyhow!("SAFE_ABSTENTION: standalone destination is outside the recognized Java test source root"))?;
            if !fs::canonicalize(&out_path)?.starts_with(&source_root) {
                return Err(anyhow!("SAFE_ABSTENTION: standalone destination is outside the recognized Java test source root"));
            }
            verify_build_compilation(&backend_dir, &repo_root, class_name)?;
        }
        Ok(())
    })?;

    let generated_class = is_java.then(|| {
        detected_package.as_ref().map_or_else(
            || class_name.to_string(),
            |package| format!("{package}.{class_name}"),
        )
    });
    Ok(GenerateTestsOutcome {
        path: out_path,
        summary: synthesis.summary,
        generated_class,
    })
}

fn resolve_contract_path(contract_opt: Option<&Path>) -> Result<PathBuf> {
    if let Some(c) = contract_opt {
        if c.exists() {
            return Ok(c.to_path_buf());
        }
        return Err(anyhow!(
            "Specified contract artifact does not exist: {:?}",
            c
        ));
    }

    let candidates = [
        PathBuf::from(".sajimora/backend-contract.json"),
        PathBuf::from(".sajimora/candidate-contract.json"),
        PathBuf::from("../.sajimora/backend-contract.json"),
        PathBuf::from("../.sajimora/candidate-contract.json"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    Err(anyhow!(
        "Could not find `.sajimora/backend-contract.json`. Please specify --contract <PATH>"
    ))
}

/// Reads the target project's Spring Boot major version so the generated MockMvc import matches
/// the package layout it will compile against: Boot 4 moved `@AutoConfigureMockMvc` to
/// `org.springframework.boot.webmvc.test.autoconfigure`.
fn synthesis_options(
    backend_dir: &Path,
    envelope: &contract_core::envelope::ContractArtifactEnvelope,
    explicit: Option<u8>,
) -> SynthesisOptions {
    if let Some(major) = explicit {
        return SynthesisOptions {
            spring_boot_major: major,
        };
    }
    // Absolute roots supplied to run_for_backend are explicitly selected by the
    // caller, not inferred from artifact provenance in an unrelated CWD.
    if !backend_dir.is_absolute() && !contract_points_at(backend_dir, envelope) {
        eprintln!(
            "[WARN] The contract's provenance does not resolve under {:?}; assuming Spring Boot 3 for the generated imports. Pass --spring-boot-major to override.",
            backend_dir
        );
        return SynthesisOptions::default();
    }
    SynthesisOptions {
        spring_boot_major: detect_spring_boot_major(backend_dir),
    }
}

/// A backend directory is only trusted for version detection when the contract being generated was
/// actually extracted from it (or from its parent). Otherwise an unrelated project in the working
/// tree supplies the version - which is how a Boot-4 scratch copy once decided a Boot-3 project's
/// imports.
fn contract_points_at(
    backend_dir: &Path,
    envelope: &contract_core::envelope::ContractArtifactEnvelope,
) -> bool {
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &envelope.payload else {
        return false;
    };
    let mut files: Vec<&str> = payload
        .endpoints
        .iter()
        .map(|endpoint| endpoint.provenance.file.as_str())
        .filter(|file| !file.is_empty())
        .collect();
    if let Some(pool) = payload.type_pool.as_ref() {
        files.extend(pool.values().filter_map(|wire| match wire {
            contract_core::ir::WireType::Object(object) => {
                object.provenance.as_ref().map(|p| p.file.as_str())
            }
            _ => None,
        }));
    }
    files.into_iter().take(24).any(|file| {
        backend_dir.join(file).exists()
            || backend_dir
                .parent()
                .is_some_and(|parent| parent.join(file).exists())
    })
}

fn detect_spring_boot_major(backend_dir: &Path) -> u8 {
    let mut build = String::new();
    let mut cur = Some(backend_dir);
    while let Some(dir) = cur {
        for name in ["pom.xml", "build.gradle", "build.gradle.kts"] {
            if let Ok(text) = fs::read_to_string(dir.join(name)) {
                build.push_str(&text);
                build.push('\n');
            }
        }
        if !build.is_empty() {
            break;
        }
        cur = dir.parent();
    }
    if !build.is_empty() {
        if let Some(major) = spring_boot_major_from(&build) {
            return major;
        }
    }
    if detect_javax_usage(backend_dir) {
        return 2;
    }
    3
}

fn detect_javax_usage(backend_dir: &Path) -> bool {
    let main_java = backend_dir.join("src/main/java");
    let target = if main_java.is_dir() {
        main_java
    } else {
        backend_dir.to_path_buf()
    };
    let mut stack = vec![target];
    let mut count = 0;
    while let Some(d) = stack.pop() {
        if let Ok(entries) = fs::read_dir(d) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()) == Some("java") {
                    if let Ok(text) = fs::read_to_string(&path) {
                        if text.contains("javax.servlet")
                            || text.contains("javax.validation")
                            || text.contains("javax.persistence")
                        {
                            return true;
                        }
                    }
                    count += 1;
                    if count >= 12 {
                        return false;
                    }
                }
            }
        }
    }
    false
}

fn spring_boot_major_from(build: &str) -> Option<u8> {
    let parse_major = |v: &str| -> Option<u8> {
        let cleaned = v.trim().trim_matches(|c| c == '\'' || c == '"');
        cleaned.split('.').next()?.trim().parse().ok()
    };

    // 1. Maven parent: <artifactId>spring-boot-starter-parent</artifactId> ... <version>X.Y.Z</version>
    if let Some(idx) = build.find("spring-boot-starter-parent") {
        let rest = &build[idx..];
        if let Some(v_start) = rest.find("<version>") {
            let start = v_start + "<version>".len();
            if let Some(end) = rest[start..].find("</version>") {
                if let Some(major) = parse_major(&rest[start..start + end]) {
                    return Some(major);
                }
            }
        }
    }

    // 2. Maven property: <spring-boot.version> or <spring.boot.version>
    for tag in ["<spring-boot.version>", "<spring.boot.version>"] {
        if let Some(idx) = build.find(tag) {
            let rest = &build[idx + tag.len()..];
            let closing = tag.replace('<', "</");
            if let Some(end) = rest.find(&closing) {
                if let Some(major) = parse_major(&rest[..end]) {
                    return Some(major);
                }
            }
        }
    }

    // 3. Gradle classpath: spring-boot-gradle-plugin:X.Y.Z
    if let Some(idx) = build.find("spring-boot-gradle-plugin") {
        let rest = &build[idx + "spring-boot-gradle-plugin".len()..];
        if let Some(colon_idx) = rest.find(':') {
            let after = rest[colon_idx + 1..].trim_start();
            let end = after
                .find(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == ')' || c == ',')
                .unwrap_or(after.len());
            if let Some(major) = parse_major(&after[..end]) {
                return Some(major);
            }
        }
    }

    // 4. Gradle springBootVersion = 'X.Y.Z' or spring_boot_version = 'X.Y.Z'
    for var_name in ["springbootversion", "spring_boot_version"] {
        let lower = build.to_lowercase();
        if let Some(idx) = lower.find(var_name) {
            let rest = &build[idx + var_name.len()..];
            if let Some(eq_idx) = rest.find('=') {
                let after = rest[eq_idx + 1..].trim_start();
                if let Some(quote) = after.chars().next().filter(|&c| c == '\'' || c == '"') {
                    if let Some(end) = after[1..].find(quote) {
                        if let Some(major) = parse_major(&after[1..=end]) {
                            return Some(major);
                        }
                    }
                }
            }
        }
    }

    // 5. Gradle id 'org.springframework.boot' version 'X.Y.Z'
    if let Some(idx) = build.find("org.springframework.boot") {
        let rest = &build[idx..];
        if let Some(v_idx) = rest.find("version") {
            let after = rest[v_idx + "version".len()..].trim_start();
            if let Some(quote) = after.chars().next().filter(|&c| c == '\'' || c == '"') {
                if let Some(end) = after[1..].find(quote) {
                    if let Some(major) = parse_major(&after[1..=end]) {
                        return Some(major);
                    }
                }
            }
        }
    }

    // 6. Direct starter dependencies with version: org.springframework.boot:spring-boot-starter...:X.Y.Z
    for line in build.lines() {
        if line.contains("spring-boot-starter") {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 3 {
                let ver = parts[2]
                    .trim()
                    .trim_matches(|c: char| c == '\'' || c == '"' || c == ')' || c == ',');
                if let Some(major) = parse_major(ver) {
                    return Some(major);
                }
            }
        }
    }

    // 7. Maven dependency on spring-boot-starter with explicit version
    if let Some(idx) = build.find("<artifactId>spring-boot-starter") {
        let rest = &build[idx..];
        if let Some(v_start) = rest.find("<version>") {
            let start = v_start + "<version>".len();
            if let Some(end) = rest[start..].find("</version>") {
                if let Some(major) = parse_major(&rest[start..start + end]) {
                    return Some(major);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod boot_version_tests {
    use super::spring_boot_major_from;

    #[test]
    fn detects_both_pom_layouts_and_gradle() {
        assert_eq!(spring_boot_major_from("<parent><artifactId>spring-boot-starter-parent</artifactId><version>4.1.1</version></parent>"), Some(4));
        assert_eq!(
            spring_boot_major_from(
                "<artifactId>spring-boot-starter-parent</artifactId>\n<version>3.2.5</version>"
            ),
            Some(3)
        );
        assert_eq!(spring_boot_major_from("<parent><artifactId>spring-boot-starter-parent</artifactId><version>2.7.5</version></parent>"), Some(2));
        assert_eq!(
            spring_boot_major_from("<spring-boot.version>4.0.6</spring-boot.version>"),
            Some(4)
        );
        assert_eq!(
            spring_boot_major_from("<spring-boot.version>2.7.14</spring-boot.version>"),
            Some(2)
        );
        assert_eq!(
            spring_boot_major_from("id 'org.springframework.boot' version '3.2.5'"),
            Some(3)
        );
        assert_eq!(
            spring_boot_major_from("id 'org.springframework.boot' version '2.6.3'"),
            Some(2)
        );
        assert_eq!(
            spring_boot_major_from(
                "classpath 'org.springframework.boot:spring-boot-gradle-plugin:2.6.3'"
            ),
            Some(2)
        );
        assert_eq!(
            spring_boot_major_from("springBootVersion = '2.7.0'"),
            Some(2)
        );
        assert_eq!(spring_boot_major_from("<project/>"), None);
    }
}

fn resolve_backend_dir() -> PathBuf {
    let manifest_candidates = [
        PathBuf::from(".sajimora/init-manifest.json"),
        PathBuf::from("../.sajimora/init-manifest.json"),
    ];

    for mf_path in &manifest_candidates {
        if let Ok(bytes) = fs::read(mf_path) {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(backend_str) = val["roots"]["backend_root"].as_str() {
                    let parent = mf_path
                        .parent()
                        .and_then(|p| p.parent())
                        .unwrap_or(Path::new("."));
                    let resolved = parent.join(backend_str);
                    if resolved.exists() {
                        return resolved;
                    }
                }
            }
        }
    }

    let cur = PathBuf::from(".");
    if cur.join("pom.xml").exists()
        || cur.join("build.gradle").exists()
        || cur.join("build.gradle.kts").exists()
        || cur.join("src/main/java").exists()
    {
        return cur;
    }

    if let Ok(detected) = crate::init::detect_backend(&cur) {
        return detected;
    }

    cur
}

fn contains_artifact(content: &str, artifact: &str) -> bool {
    for (idx, _) in content.match_indices(artifact) {
        let after = &content[idx + artifact.len()..];
        let next_char = after.chars().next();
        match next_char {
            None | Some('<') | Some('"') | Some('\'') | Some(' ') | Some('\t') | Some('\n')
            | Some('\r') | Some(':') | Some(',') => return true,
            Some(c) if !c.is_alphanumeric() && c != '-' && c != '_' => return true,
            _ => continue,
        }
    }
    false
}

fn inspect_java_environment(
    backend_dir: &Path,
    framework: &mut TestSynthesisFramework,
    allow_standalone: bool,
) -> Result<()> {
    let pom = backend_dir.join("pom.xml");
    let gradle = backend_dir.join("build.gradle");
    let gradle_kts = backend_dir.join("build.gradle.kts");

    let mut combined_content = String::new();
    let mut build_tool_found = false;

    if pom.exists() {
        build_tool_found = true;
        if let Ok(c) = fs::read_to_string(&pom) {
            combined_content.push_str(&c.to_lowercase());
        }
    }
    if gradle.exists() {
        build_tool_found = true;
        if let Ok(c) = fs::read_to_string(&gradle) {
            combined_content.push_str(&c.to_lowercase());
        }
    }
    if gradle_kts.exists() {
        build_tool_found = true;
        if let Ok(c) = fs::read_to_string(&gradle_kts) {
            combined_content.push_str(&c.to_lowercase());
        }
    }

    if !build_tool_found && !backend_dir.join("src/main/java").exists() {
        if allow_standalone {
            return Ok(());
        }
        return Err(anyhow!(
            "SAFE_ABSTENTION: No Maven (pom.xml) or Gradle (build.gradle) build descriptor found in {:?}. Test synthesis requires a recognized build system.",
            backend_dir
        ));
    }

    if combined_content.is_empty() {
        return Ok(());
    }

    let has_webflux = contains_artifact(&combined_content, "spring-boot-starter-webflux")
        || contains_artifact(&combined_content, "spring-webflux");
    let has_webmvc = contains_artifact(&combined_content, "spring-boot-starter-web")
        || contains_artifact(&combined_content, "spring-webmvc");

    // Clean abstention on WebFlux if WebMvc is absent
    if has_webflux && !has_webmvc {
        return Err(anyhow!(
            "UNSUPPORTED_WEBFLUX_TEST_INFRASTRUCTURE: Spring WebFlux detected. MockMvc cannot dispatch reactive handlers without WebTestClient. Test synthesis cleanly abstains."
        ));
    }

    // Clean abstention if neither web framework is present
    if !has_webmvc && !has_webflux {
        return Err(anyhow!(
            "TEST_INFRASTRUCTURE_ABSENT: Neither Spring WebMvc nor WebFlux web infrastructure was detected in build configuration. MockMvc test synthesis cannot proceed."
        ));
    }

    // Strict dependency check for optional jqwik
    if *framework == TestSynthesisFramework::Jqwik {
        if !combined_content.contains("jqwik") {
            return Err(anyhow!(
                "DEPENDENCY_MISSING: Jqwik was requested via --framework jqwik, but 'net.jqwik:jqwik' was not found in pom.xml / build.gradle.\n\
                 Sajimora strictly enforces zero silent modifications of project build files.\n\
                 Please add jqwik to your test dependencies or omit --framework to use standard JUnit 5 MockMvc."
            ));
        }
    }

    // Auto-detect JUnit 4 vintage vs JUnit 5 Jupiter
    if *framework == TestSynthesisFramework::JUnit5 {
        let has_junit5 = combined_content.contains("junit-jupiter")
            || combined_content.contains("spring-boot-starter-test")
            || combined_content.contains("org.junit.jupiter");
        let has_junit4 =
            combined_content.contains("junit:junit") || combined_content.contains("junit-4");

        if has_junit4 && !has_junit5 {
            eprintln!("ℹ️  JUnit 4 Vintage detected without JUnit 5 Jupiter; synthesizing JUnit 4 MockMvc test.");
            *framework = TestSynthesisFramework::JUnit4;
        }
    }

    Ok(())
}

fn validate_java_names(class_name: &str, package: Option<&str>) -> Result<()> {
    fn identifier(name: &str) -> bool {
        let mut chars = name.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
            && !matches!(
                name,
                "abstract"
                    | "assert"
                    | "boolean"
                    | "break"
                    | "byte"
                    | "case"
                    | "catch"
                    | "char"
                    | "class"
                    | "const"
                    | "continue"
                    | "default"
                    | "do"
                    | "double"
                    | "else"
                    | "enum"
                    | "extends"
                    | "final"
                    | "finally"
                    | "float"
                    | "for"
                    | "goto"
                    | "if"
                    | "implements"
                    | "import"
                    | "instanceof"
                    | "int"
                    | "interface"
                    | "long"
                    | "native"
                    | "new"
                    | "package"
                    | "private"
                    | "protected"
                    | "public"
                    | "return"
                    | "short"
                    | "static"
                    | "strictfp"
                    | "super"
                    | "switch"
                    | "synchronized"
                    | "this"
                    | "throw"
                    | "throws"
                    | "transient"
                    | "try"
                    | "void"
                    | "volatile"
                    | "while"
                    | "true"
                    | "false"
                    | "null"
                    | "_"
                    | "record"
                    | "var"
                    | "yield"
                    | "sealed"
                    | "permits"
            )
    }
    if !identifier(class_name)
        || package.is_some_and(|package| {
            !package.trim().is_empty() && !package.trim().split('.').all(identifier)
        })
    {
        return Err(anyhow!(
            "DIAGNOSTIC_SYNTAX_ERROR: invalid Java class or package identifier"
        ));
    }
    Ok(())
}

fn detect_java_package(search_dir: &Path) -> Option<String> {
    if !search_dir.exists() {
        return None;
    }

    let mut java_files = Vec::new();
    collect_java_files(search_dir, &mut java_files);

    if java_files.is_empty() {
        return None;
    }

    // Preference: *Application.java first, then *Controller.java, then others
    java_files.sort_by_key(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.ends_with("Application.java") {
            0
        } else if name.ends_with("Controller.java") {
            1
        } else {
            2
        }
    });

    for file in java_files {
        if let Ok(content) = fs::read_to_string(&file) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("package ") && trimmed.ends_with(';') {
                    let pkg = trimmed
                        .strip_prefix("package ")
                        .and_then(|s| s.strip_suffix(';'))
                        .map(|s| s.trim().to_string());
                    if let Some(p) = pkg {
                        if !p.is_empty() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

fn collect_java_files(dir: &Path, acc: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with('.') && name != "target" && name != "build" {
                    collect_java_files(&path, acc);
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("java") {
                acc.push(path);
            }
        }
    }
}

fn verify_build_compilation(backend_dir: &Path, repo_root: &Path, class_name: &str) -> Result<()> {
    eprintln!(
        "Verifying build compilation for {} (offline)...",
        class_name
    );
    let runner = crate::run::detect_build_runner(
        backend_dir,
        repo_root,
        source_index::provider::ProviderKind::Spring,
    )
    .ok_or_else(|| anyhow!("SAFE_ABSTENTION: no recognized compilation runner"))?;
    let (bin, args) = runner.compilation_command().ok_or_else(|| {
        anyhow!("SAFE_ABSTENTION: runner does not support compilation validation")
    })?;
    // Wrapper bootstrapping is independent of Maven/Gradle offline flags. Refuse
    // download-capable launchers rather than install a missing runtime online.
    if Path::new(&bin).is_file() {
        let script = fs::read_to_string(&bin)?;
        let text = script.to_lowercase();
        if [
            "curl",
            "wget",
            "downloadfile",
            "invoke-webrequest",
            "gradlewrappermain",
            "mavenwrappermain",
        ]
        .iter()
        .any(|needle| text.contains(needle))
        {
            return Err(anyhow!("SAFE_ABSTENTION: wrapper may bootstrap a runtime online; use a preinstalled offline build runner"));
        }
    }
    let output = std::process::Command::new(&bin)
        .current_dir(backend_dir)
        .args(&args)
        .output()
        .map_err(|error| anyhow!("Failed to execute offline compilation runner: {}", error))?;
    // Build output may contain actual response/header credentials; never relay it.
    if !output.status.success() {
        return Err(anyhow!(
            "Compilation command exited with status code {:?}",
            output.status.code()
        ));
    }
    Ok(())
}

fn generated_ownership(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut lines = text.lines();
    let mut header = lines.next();
    if header.is_some_and(|line| line.starts_with("package ") && line.ends_with(';')) {
        if lines.next() != Some("") {
            return false;
        }
        header = lines.next();
    }
    matches!(
        header,
        Some("// Generated by Sajimora Native Synthesis (JUnit 5)")
            | Some("// Generated by Sajimora Native Synthesis (JUnit 4 Vintage)")
            | Some("// Generated by Sajimora Native Synthesis (jqwik)")
            | Some("// Generated by Sajimora Native Synthesis (fast-check)")
    )
}

fn stage_bytes(parent: &Path, bytes: &[u8]) -> Result<PathBuf> {
    use std::io::Write;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temp_path = parent.join(format!(
        ".sajimora_tmp_{}_{}.tmp",
        std::process::id(),
        nanos
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }
    Ok(temp_path)
}

fn write_atomic_validated(
    dest: &Path,
    content: &str,
    validate: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let prior = match fs::symlink_metadata(dest) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(anyhow!(
                    "COLLISION_REFUSAL: Target {:?} is not an owned regular file",
                    dest
                ));
            }
            let bytes = fs::read(dest).map_err(|error| {
                anyhow!(
                    "COLLISION_REFUSAL: cannot read target {:?}: {}",
                    dest,
                    error
                )
            })?;
            if !generated_ownership(&bytes) {
                return Err(anyhow!("COLLISION_REFUSAL: Target {:?} lacks an exact generated ownership header; refusing to overwrite user-authored test", dest));
            }
            Some(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(anyhow!(
                "COLLISION_REFUSAL: cannot inspect target {:?}: {}",
                dest,
                error
            ))
        }
    };
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temp_path = stage_bytes(parent, content.as_bytes())?;
    let backup = match prior
        .as_ref()
        .map(|bytes| stage_bytes(parent, bytes))
        .transpose()
    {
        Ok(backup) => backup,
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
    };
    // Fail closed on another writer changing the destination after ownership inspection.
    let unchanged = match &prior {
        Some(bytes) => fs::read(dest).is_ok_and(|current| current == *bytes),
        None => {
            matches!(fs::symlink_metadata(dest), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        }
    };
    if !unchanged {
        let _ = fs::remove_file(&temp_path);
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
        return Err(anyhow!(
            "COLLISION_REFUSAL: destination changed during generation"
        ));
    }
    if let Err(error) = replace_output(&temp_path, dest) {
        let _ = fs::remove_file(&temp_path);
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
        return Err(error.into());
    }
    if let Err(error) = validate() {
        let rollback = match &backup {
            Some(backup) => replace_output(backup, dest),
            None => fs::remove_file(dest),
        };
        if let Err(rollback) = rollback {
            return Err(anyhow!("DIAGNOSTIC_SYNTAX_ERROR: validation failed: {}; rollback failed: {}; prior bytes retained at {:?}", error, rollback, backup));
        }
        return Err(anyhow!("DIAGNOSTIC_SYNTAX_ERROR: Compilation validation failed: {}. Safe rollback restored prior output", error));
    }
    if let Some(backup) = backup {
        fs::remove_file(backup)?;
    }
    Ok(())
}

#[cfg(test)]
mod remediation_tests {
    use super::*;

    fn workspace(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sajimora-generate-unit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn args() -> GenerateTestsArgs {
        GenerateTestsArgs {
            contract: None,
            framework: TestSynthesisFramework::JUnit5,
            out: None,
            name: None,
            package: None,
            verify_build: false,
            request_fixtures: None,
            spring_boot_major: None,
        }
    }

    #[test]
    fn remediation_explicit_backend_root_controls_paths_and_boot_version() {
        let repo = workspace("explicit-root");
        let backend = repo.join("nested/backend");
        fs::create_dir_all(backend.join("src/main/java/com/example/backend")).unwrap();
        fs::create_dir_all(repo.join(".sajimora")).unwrap();
        fs::write(backend.join("pom.xml"), "<project><artifactId>spring-boot-starter-parent</artifactId><version>4.0.0</version><artifactId>spring-boot-starter-web</artifactId><artifactId>spring-boot-starter-test</artifactId></project>").unwrap();
        fs::write(
            backend.join("src/main/java/com/example/backend/BackendApplication.java"),
            "package com.example.backend;\nclass BackendApplication {}\n",
        )
        .unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/spring-sample.contract.json");
        fs::copy(fixture, repo.join(".sajimora/backend-contract.json")).unwrap();
        let cwd = std::env::current_dir().unwrap();
        let output = run_for_backend(args(), &backend, &repo).unwrap();
        assert_eq!(std::env::current_dir().unwrap(), cwd);
        assert_eq!(
            output.path,
            fs::canonicalize(&backend)
                .unwrap()
                .join("src/test/java/com/example/backend/ContractTest.java")
        );
        assert_eq!(output.summary.framework, "junit5");
        assert_eq!(output.summary.executable_contract_checks, 3);
        assert_eq!(output.summary.partial_checks, 1);
        let code = fs::read_to_string(&output.path).unwrap();
        assert!(code.starts_with("package com.example.backend;\n\n"));
        assert!(code
            .contains("org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc"));
        let mut explicit = args();
        explicit.out = Some(PathBuf::from("custom/ExplicitTest.java"));
        explicit.name = Some("ExplicitTest".into());
        let output = run_for_backend(explicit, &backend, &repo).unwrap();
        assert_eq!(
            output.path,
            fs::canonicalize(&backend)
                .unwrap()
                .join("custom/ExplicitTest.java")
        );
    }

    #[test]
    fn remediation_atomic_validation_failure_preserves_prior_binary_tail() {
        let root = workspace("atomic-validation");
        let dest = root.join("ContractTest.java");
        let prior = b"package example;\r\n\r\n// Generated by Sajimora Native Synthesis (JUnit 5)\r\n// exact old bytes\r\n";
        fs::write(&dest, prior).unwrap();
        let error = write_atomic_validated(&dest, "// candidate", || {
            Err(anyhow!("forced compile failure"))
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("Safe rollback restored prior output"));
        assert_eq!(fs::read(&dest).unwrap(), prior);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }
}

#[cfg(not(windows))]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(source, dest)
}

#[cfg(windows)]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
