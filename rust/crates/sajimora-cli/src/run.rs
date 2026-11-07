use anyhow::{anyhow, bail, ensure, Context, Result};
use clap::Args;
use contract_core::envelope::{parse_envelope, ArtifactPayload};
use contract_core::report::CrossLanguageVerdict;
use contract_core::service::{run_check_contract_service, CheckContractServiceRequest};
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use source_index::endpoint_impact::{analyze, ImpactMode, ImpactRequest};
use source_index::provider::ProviderKind;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Instant, SystemTime};

use crate::init::{InitManifest, ManifestStatus};

#[derive(Args, Debug, Clone)]
pub struct RunArgs {
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,
    /// Exit nonzero on violations, failed analysis, or unconfirmed applicable execution.
    #[arg(long, alias = "ci", alias = "strict")]
    pub fail_on_violation: bool,
    /// Skip both live-test synthesis and execution.
    #[arg(long)]
    pub skip_live: bool,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub out: Option<PathBuf>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StageStatus {
    pub name: String,
    pub status: String,
    pub elapsed_ms: u64,
    pub details: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PipelineReport {
    pub schema_version: String,
    pub pipeline: String,
    pub timestamp: String,
    pub repository: String,
    pub stages: Vec<StageStatus>,
    pub overall_verdict: String,
    pub breaking_changes_count: usize,
    pub affected_endpoints_count: usize,
    pub live_assertions_completed: Option<usize>,
    pub exit_code: i32,
    pub recommendations: Vec<String>,
}

fn record(
    stages: &mut Vec<StageStatus>,
    name: &str,
    status: &str,
    start: Instant,
    details: Value,
    quiet: bool,
) {
    if !quiet {
        let label = match name {
            "health_check" => "Health Check",
            "contract_extraction" => "Contract Lattice",
            "cross_language_verification" => "Cross-Language Verify",
            "git_endpoint_impact" => "Git Endpoint Impact",
            "test_synthesis" => "Test Synthesis",
            _ => "Live Contract Tests",
        };
        println!(" [{}/6] {label:<24} {status}", stages.len() + 1);
    }
    stages.push(StageStatus {
        name: name.into(),
        status: status.into(),
        elapsed_ms: start.elapsed().as_millis() as u64,
        details,
    });
}

pub fn run(args: RunArgs) -> i32 {
    let repo = if args.repo.is_absolute() {
        args.repo.clone()
    } else {
        match std::env::current_dir() {
            Ok(dir) => dir.join(&args.repo),
            Err(error) => {
                eprintln!("{error}");
                return 1;
            }
        }
    };
    let mut stages = Vec::new();
    let work = repo.join(".sajimora");
    let manifest_path = work.join("init-manifest.json");
    let t = Instant::now();
    let mut init_exit = None;
    let mut init_error = None;
    if !manifest_path.exists() && repo.is_dir() {
        if !args.json {
            println!("Missing .sajimora/init-manifest.json; initializing repository.");
        }
        match std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .arg("init")
                .arg("--repo")
                .arg(&repo)
                .arg("--apply")
                .output()
        }) {
            Ok(output) => {
                init_exit = output.status.code();
                if !output.status.success() {
                    init_error = Some("Repository initialization failed".to_string());
                }
            }
            Err(error) => init_error = Some(error.to_string()),
        }
    }
    let manifest_result = fs::read(&manifest_path)
        .context("Missing or unreadable init manifest")
        .and_then(|bytes| {
            serde_json::from_slice::<InitManifest>(&bytes).context("Invalid init manifest")
        });
    let manifest = manifest_result.as_ref().ok();
    let backend = manifest
        .map(|m| repo.join(&m.roots.backend_root))
        .unwrap_or_else(|| repo.clone());
    let frontend = manifest
        .and_then(|m| m.roots.frontend_root.as_ref())
        .map(|root| repo.join(root));
    let service_id = manifest
        .map(|m| m.roots.service_id.as_str())
        .unwrap_or("application");
    let health_ok = manifest.is_some_and(|m| m.status == ManifestStatus::Complete)
        && backend.is_dir()
        && frontend.as_ref().is_none_or(|path| path.is_dir())
        && init_error.is_none();
    record(
        &mut stages,
        "health_check",
        if health_ok { "PASS" } else { "ERROR" },
        t,
        json!({"manifest_found": manifest.is_some(), "backend_root": backend, "frontend_root": frontend,
            "service_id": service_id, "initialization_exit_code": init_exit,
            "error": init_error.or_else(|| manifest_result.as_ref().err().map(ToString::to_string)).or_else(|| (!health_ok).then(|| "Incomplete manifest or missing configured source directory".into()))}),
        args.json,
    );

    let provider = ProviderKind::detect_on_disk(&backend);
    let base = work.join("backend-contract.json");
    let candidate = work.join("candidate-contract.json");
    let frontend_file = work.join("frontend-contract.json");
    let source_root = if (provider == ProviderKind::Spring || provider == ProviderKind::JaxRs)
        && backend.join("src/main/java").is_dir()
    {
        backend.join("src/main/java")
    } else {
        backend.clone()
    };
    let t = Instant::now();
    let mut endpoints = 0;
    let mut calls = 0;
    let mut backend_fresh = false;
    let mut frontend_fresh = false;
    let extraction: Result<()> = (|| {
        ensure!(
            health_ok,
            "Source setup failed; previous artifacts are not current-run evidence"
        );
        let envelope = crate::extract_backend::build_backend_envelope(
            &repo,
            &source_root,
            provider,
            service_id,
            None,
            "HEAD",
        )?;
        if let ArtifactPayload::Backend(payload) = &envelope.payload {
            endpoints = payload
                .endpoints
                .iter()
                .filter(|endpoint| {
                    endpoint.identity.direction == contract_core::ir::ContractDirection::Response
                })
                .count();
        }
        let bytes = serde_json::to_vec_pretty(&envelope)?;
        fs::write(&candidate, &bytes).context("Failed to write refreshed backend artifact")?;
        if !base.exists() {
            fs::write(&base, &bytes).context("Failed to write initial backend baseline")?;
        }
        backend_fresh = true;
        if let Some(root) = &frontend {
            let out =
                crate::extract_frontend::run_inner(crate::extract_frontend::ExtractFrontendArgs {
                    repo: repo.clone(),
                    service_id: Some("frontend-service".into()),
                    target_service_id: Some(service_id.into()),
                    ts_root: Some(root.clone()),
                    parent: "HEAD".into(),
                    out: frontend_file.clone(),
                })?;
            let envelope = parse_envelope(&fs::read(out)?)?;
            if let ArtifactPayload::Frontend(payload) = envelope.payload {
                calls = payload.client_contracts.len();
            }
            frontend_fresh = true;
        }
        Ok(())
    })();
    let extracted = extraction.is_ok();
    record(
        &mut stages,
        "contract_extraction",
        if extraction.is_err() {
            "ERROR"
        } else if endpoints == 0 {
            "INCONCLUSIVE"
        } else {
            "PASS"
        },
        t,
        json!({"backend_endpoints": endpoints, "frontend_call_sites": calls, "provider": format!("{provider:?}"), "backend_refreshed": backend_fresh,
            "frontend_refreshed": frontend_fresh, "error": extraction.err().map(|error| format!("{error:#}"))}),
        args.json,
    );

    let t = Instant::now();
    let mut verdict = "INCONCLUSIVE".to_string();
    let mut breaking = 0;
    let mut new_breaking = 0;
    let mut samples = Vec::new();
    let mut comparison_status = "SKIPPED";
    let mut comparison_error = None;
    if extracted && backend_fresh && frontend_fresh {
        match run_check_contract_service(CheckContractServiceRequest {
            base_path: base.clone(),
            candidate_path: candidate.clone(),
            target_paths: vec![frontend_file.clone()],
            trust_policy_path: None,
            trusted_local: true,
            require_service_mapping: false,
            allowed_roots: None,
            max_artifact_bytes: None,
            telemetry_path: work
                .join("telemetry.json")
                .is_file()
                .then(|| work.join("telemetry.json")),
            evaluation_time_unix: None,
            deployment_liveness_verified: false,
        }) {
            Ok(report) => {
                breaking = report.findings.len();
                new_breaking = report
                    .delta
                    .as_ref()
                    .map_or(breaking, |delta| delta.new_findings.len());
                let (status, value) = match report.verdict {
                    CrossLanguageVerdict::LikelyPreserved => ("PASS", "LIKELY_PRESERVED"),
                    CrossLanguageVerdict::LikelyViolated => ("VIOLATION", "LIKELY_VIOLATED"),
                    CrossLanguageVerdict::Inconclusive => ("INCONCLUSIVE", "INCONCLUSIVE"),
                    CrossLanguageVerdict::AnalysisError => ("ERROR", "ANALYSIS_ERROR"),
                };
                comparison_status = status;
                verdict = value.into();
                samples = report.findings.iter().take(5).map(|finding| json!({"endpoint": format!("{} {}", finding.endpoint.method, finding.endpoint.path), "wire_path": finding.wire_path, "repair_hint": finding.repair_hint})).collect();
            }
            Err(error) => {
                comparison_status = "ERROR";
                verdict = "ANALYSIS_ERROR".into();
                comparison_error = Some(format!("{error:#}"));
            }
        }
    }
    record(
        &mut stages,
        "cross_language_verification",
        comparison_status,
        t,
        json!({"verdict": verdict, "breaking_changes": breaking, "new_breaking_changes": new_breaking, "sample_violations": samples, "error": comparison_error,
            "reason": (comparison_status == "SKIPPED").then_some("Requires successful current-run backend and configured frontend extraction"), "skipped": comparison_status == "SKIPPED"}),
        args.json,
    );

    let t = Instant::now();
    let mut affected = 0;
    let impact = analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.clone(),
            mode: ImpactMode::WorkingTree,
            commit_range: None,
            generated_tests: vec![],
        },
    );
    let impact_details = match &impact {
        Ok(report) => {
            affected = report
                .pointer("/summary/affectedEndpoints")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            report.get("summary").cloned().unwrap_or_else(|| json!({}))
        }
        Err(error) => json!({"error": format!("{error:#}")}),
    };
    record(
        &mut stages,
        "git_endpoint_impact",
        if impact.is_ok() { "PASS" } else { "ERROR" },
        t,
        impact_details,
        args.json,
    );

    let t = Instant::now();
    let mut synthesis_status = "SKIPPED";
    let mut synthesis_details = json!({"skipped": true, "reason": "Live synthesis disabled or current backend evidence unavailable"});
    let mut synthesized = false;
    let mut generated_test = None;
    if !args.skip_live && backend_fresh && extracted {
        if provider == ProviderKind::Spring || provider == ProviderKind::JaxRs {
            let fixtures = work.join("request-fixtures.json");
            match crate::generate_tests::run_for_backend(
                crate::generate_tests::GenerateTestsArgs {
                    contract: Some(candidate.clone()),
                    framework: contract_core::synthesis::TestSynthesisFramework::JUnit5,
                    out: None,
                    name: Some("GeneratedContractTest".into()),
                    package: None,
                    verify_build: false,
                    request_fixtures: fixtures.is_file().then_some(fixtures),
                    spring_boot_major: None,
                },
                &backend,
                &repo,
            ) {
                Ok(outcome) => {
                    generated_test = outcome.generated_class.map(|class_name| GeneratedTest {
                        class_name,
                        tests: outcome.summary.executable_contract_checks
                            + outcome.summary.diagnostics
                            + outcome.summary.status_only_checks,
                    });
                    synthesized =
                        outcome.summary.executable_contract_checks > 0 && generated_test.is_some();
                    synthesis_status = if !synthesized
                        || outcome.summary.diagnostics > 0
                        || outcome.summary.abstentions > 0
                        || outcome.summary.partial_checks > 0
                        || outcome.summary.status_only_checks > 0
                    {
                        "INCONCLUSIVE"
                    } else {
                        "PASS"
                    };
                    synthesis_details = json!({"skipped": false, "generated_file": outcome.path, "summary": outcome.summary, "expected_execution": generated_test});
                }
                Err(error) => {
                    synthesis_status = "ERROR";
                    synthesis_details = json!({"skipped": false, "error": format!("{error:#}")});
                }
            }
        } else {
            synthesis_details = json!({"skipped": true, "reason": "NestJS test synthesis is unsupported; existing configured tests may still execute"});
        }
    }
    record(
        &mut stages,
        "test_synthesis",
        synthesis_status,
        t,
        synthesis_details,
        args.json,
    );

    let t = Instant::now();
    let live = if args.skip_live {
        LiveResult::skipped("Live execution explicitly disabled")
    } else if !backend_fresh || !extracted {
        LiveResult::skipped("Extraction failed; stale contract tests will not execute")
    } else if (provider == ProviderKind::Spring || provider == ProviderKind::JaxRs) && !synthesized
    {
        LiveResult::skipped("No executable contract checks synthesized in this run")
    } else {
        let module = if has_build_metadata(&backend, provider) {
            &backend
        } else {
            &repo
        };
        match detect_build_runner(module, &repo, provider) {
            Some(runner) => execute_runner(&runner, module, generated_test.as_ref()),
            None => LiveResult::skipped(
                "No unambiguous supported module-level runner or configured test framework",
            ),
        }
    };
    let assertions = live.assertions;
    record(
        &mut stages,
        "live_contract_tests",
        &live.status,
        t,
        live.details,
        args.json,
    );
    if stages.iter().any(|stage| stage.status == "ERROR") {
        verdict = "ANALYSIS_ERROR".into();
    } else if verdict != "LIKELY_VIOLATED"
        && stages.iter().any(|stage| {
            stage.status != "PASS"
                && !(args.skip_live
                    && matches!(
                        stage.name.as_str(),
                        "test_synthesis" | "live_contract_tests"
                    ))
        })
    {
        verdict = "INCONCLUSIVE".into();
    }
    let complete = stages.iter().all(|stage| {
        stage.status == "PASS"
            || (args.skip_live
                && matches!(
                    stage.name.as_str(),
                    "test_synthesis" | "live_contract_tests"
                ))
    });
    let exit = i32::from(args.fail_on_violation && !complete);
    let mut report = PipelineReport {
        schema_version: "1.0.0".into(),
        pipeline: "sajimora_run".into(),
        timestamp: format!(
            "{}s (unix epoch)",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        ),
        repository: repo.to_string_lossy().into(),
        stages,
        overall_verdict: verdict,
        breaking_changes_count: breaking,
        affected_endpoints_count: affected,
        live_assertions_completed: assertions,
        exit_code: exit,
        recommendations: vec![if complete {
            "Required checks completed within their reported assurance scope; review limitations before committing.".into()
        } else {
            "Review failed, inconclusive, or skipped checks before committing; no safety conclusion was established.".into()
        }],
    };
    let out = args
        .out
        .unwrap_or_else(|| work.join("pipeline-report.json"));
    if let Err(error) = serde_json::to_vec_pretty(&report)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| fs::write(&out, bytes).map_err(anyhow::Error::from))
    {
        report.exit_code = 1;
        report.overall_verdict = "ANALYSIS_ERROR".into();
        report.recommendations = vec![format!("Pipeline report could not be saved: {error}")];
    }
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!(
            "\nCONSOLIDATED PIPELINE REPORT\nVerdict: {}",
            report.overall_verdict
        );
        println!(
            "Findings: {breaking}; new findings: {new_breaking}; affected endpoints: {affected}"
        );
        for recommendation in &report.recommendations {
            println!("{recommendation}");
        }
    }
    report.exit_code
}

pub(crate) enum BuildRunner {
    Maven { bin: String, args: Vec<String> },
    Gradle { bin: String, args: Vec<String> },
    Npm { bin: String, args: Vec<String> },
}

impl BuildRunner {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Maven { .. } => "Maven",
            Self::Gradle { .. } => "Gradle",
            Self::Npm { .. } => "npm/Jest",
        }
    }
    pub(crate) fn command(&self) -> (String, Vec<String>) {
        match self {
            Self::Maven { bin, args } | Self::Gradle { bin, args } | Self::Npm { bin, args } => {
                (bin.clone(), args.clone())
            }
        }
    }
    pub(crate) fn compilation_command(&self) -> Option<(String, Vec<String>)> {
        match self {
            Self::Maven { bin, args } => Some((
                bin.clone(),
                args.iter()
                    .filter(|arg| {
                        !arg.starts_with("-Dtest=") && !arg.starts_with("-DfailIfNoTests")
                    })
                    .map(|arg| {
                        if arg == "test" {
                            "test-compile".into()
                        } else {
                            arg.clone()
                        }
                    })
                    .collect(),
            )),
            Self::Gradle { bin, .. } => {
                Some((bin.clone(), vec!["--offline".into(), "testClasses".into()]))
            }
            Self::Npm { .. } => None,
        }
    }
}

fn has_build_metadata(target: &Path, provider: ProviderKind) -> bool {
    target.join("pom.xml").is_file()
        || target.join("build.gradle").is_file()
        || target.join("build.gradle.kts").is_file()
        || ((provider == ProviderKind::NestJs
            || provider == ProviderKind::NextJs
            || provider == ProviderKind::Express)
            && target.join("package.json").is_file())
}

fn wrapper(target: &Path, repo: &Path, filename: &str, global: &str) -> String {
    [target.join(filename), repo.join(filename)]
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into())
        .unwrap_or_else(|| global.into())
}

pub(crate) fn detect_build_runner(
    target: &Path,
    repo: &Path,
    provider: ProviderKind,
) -> Option<BuildRunner> {
    let maven = target.join("pom.xml").is_file();
    let gradle = target.join("build.gradle").is_file() || target.join("build.gradle.kts").is_file();
    if maven && gradle {
        return None;
    }
    if maven {
        return Some(BuildRunner::Maven {
            bin: wrapper(
                target,
                repo,
                if cfg!(windows) { "mvnw.cmd" } else { "mvnw" },
                if cfg!(windows) { "mvn.cmd" } else { "mvn" },
            ),
            args: vec![
                "-o".into(),
                "-B".into(),
                "-f".into(),
                target.join("pom.xml").to_string_lossy().into(),
                "test".into(),
                "-Dtest=*ContractTest*".into(),
                "-DfailIfNoTests=true".into(),
            ],
        });
    }
    if gradle {
        return Some(BuildRunner::Gradle {
            bin: wrapper(
                target,
                repo,
                if cfg!(windows) {
                    "gradlew.bat"
                } else {
                    "gradlew"
                },
                if cfg!(windows) {
                    "gradle.bat"
                } else {
                    "gradle"
                },
            ),
            args: vec![
                "--offline".into(),
                "test".into(),
                "--tests".into(),
                "*ContractTest*".into(),
                "--rerun-tasks".into(),
            ],
        });
    }
    if provider != ProviderKind::NestJs
        && provider != ProviderKind::NextJs
        && provider != ProviderKind::Express
    {
        return None;
    }
    let pkg: Value = serde_json::from_slice(&fs::read(target.join("package.json")).ok()?).ok()?;
    let script = pkg.pointer("/scripts/test")?.as_str()?;
    let words: Vec<_> = script.split_whitespace().collect();
    if !(words.first() == Some(&"jest") || words.get(..2) == Some(&["npx", "jest"][..]))
        || script.contains(['&', '|', ';', '>'])
    {
        return None;
    }
    let version = pkg
        .pointer("/devDependencies/jest")
        .or_else(|| pkg.pointer("/dependencies/jest"))?
        .as_str()?;
    let major: u32 = version
        .trim_start_matches(['^', '~'])
        .split('.')
        .next()?
        .parse()
        .ok()?;
    let pattern = if major >= 30 {
        "--testPathPatterns=ContractTest"
    } else {
        "--testPathPattern=ContractTest"
    };
    Some(BuildRunner::Npm {
        bin: if cfg!(windows) { "npm.cmd" } else { "npm" }.into(),
        args: vec![
            "test".into(),
            "--".into(),
            pattern.into(),
            "--runInBand".into(),
            "--json".into(),
            format!(
                "--outputFile={}",
                target.join(".sajimora/live-jest-results.json").display()
            ),
            "--passWithNoTests=false".into(),
        ],
    })
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
struct TestCounts {
    tests: usize,
    failures: usize,
    errors: usize,
    skipped: usize,
}
impl TestCounts {
    fn add(&mut self, other: &Self) -> Result<()> {
        self.tests = self
            .tests
            .checked_add(other.tests)
            .context("Test total overflow")?;
        self.failures = self
            .failures
            .checked_add(other.failures)
            .context("Failure total overflow")?;
        self.errors = self
            .errors
            .checked_add(other.errors)
            .context("Error total overflow")?;
        self.skipped = self
            .skipped
            .checked_add(other.skipped)
            .context("Skipped total overflow")?;
        Ok(())
    }
    fn passed(&self) -> usize {
        self.tests.saturating_sub(
            self.failures
                .saturating_add(self.errors)
                .saturating_add(self.skipped),
        )
    }
}

#[derive(Debug, Serialize)]
struct GeneratedTest {
    class_name: String,
    tests: usize,
}

struct ExecutionEvidence {
    counts: TestCounts,
    generated_tests: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
struct ReportStamp {
    modified: SystemTime,
    length: u64,
    digest: Vec<u8>,
}
fn stamp(path: &Path) -> Result<ReportStamp> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "Symlinked test report is not execution evidence"
    );
    Ok(ReportStamp {
        modified: metadata.modified()?,
        length: metadata.len(),
        digest: Sha256::digest(fs::read(path)?).to_vec(),
    })
}
fn report_paths(target: &Path, runner: &BuildRunner) -> Result<Vec<PathBuf>> {
    if matches!(runner, BuildRunner::Npm { .. }) {
        let path = target.join(".sajimora/live-jest-results.json");
        return Ok(if path.is_file() { vec![path] } else { vec![] });
    }
    let dirs = if matches!(runner, BuildRunner::Maven { .. }) {
        vec![
            target.join("target/surefire-reports"),
            target.join("target/failsafe-reports"),
        ]
    } else {
        vec![target.join("build/test-results/test")]
    };
    let mut paths = Vec::new();
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        ensure!(
            !fs::symlink_metadata(&dir)?.file_type().is_symlink(),
            "Symlinked report directory is not execution evidence"
        );
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("TEST-") && name.ends_with(".xml"))
            {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
}
fn snapshot(target: &Path, runner: &BuildRunner) -> Result<BTreeMap<PathBuf, ReportStamp>> {
    report_paths(target, runner)?
        .into_iter()
        .map(|path| stamp(&path).map(|value| (path, value)))
        .collect()
}

#[cfg(test)]
#[test]
fn xml_hierarchy_rejects_mixed_cases_and_unreconciled_parent_summaries() {
    for xml in [
        "<testsuite name='ParentContractTest' tests='2' failures='1'><testcase><failure/></testcase><testsuite name='ChildContractTest' tests='1'><testcase/></testsuite></testsuite>",
        "<testsuite name='ParentContractTest' tests='2'><testsuite name='ChildContractTest' tests='1'><testcase/></testsuite></testsuite>",
        "<testsuite name='GeneratedContractTest' tests='1'><system-out><testcase/></system-out></testsuite>",
    ] {
        assert!(parse_test_xml(xml.as_bytes()).is_err(), "Invalid hierarchy accepted: {xml}");
    }
}

fn parse_test_xml(bytes: &[u8]) -> Result<Option<TestCounts>> {
    parse_named_test_xml(bytes, None)
}

struct XmlSuite {
    declared: TestCounts,
    direct: TestCounts,
    children: TestCounts,
    child_suites: usize,
    relevant: bool,
}

fn parse_named_test_xml(bytes: &[u8], expected_class: Option<&str>) -> Result<Option<TestCounts>> {
    let mut reader = Reader::from_reader(bytes);
    let mut suites: Vec<XmlSuite> = Vec::new();
    let mut ancestors: Vec<Vec<u8>> = Vec::new();
    let mut total = TestCounts::default();
    let mut root_total = TestCounts::default();
    let mut root_declared = None;
    let mut seen = false;
    let mut roots = 0;
    let mut buffer = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buffer)?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::DocType(_) => bail!("DTD-bearing test report is unsupported"),
            Event::Text(text) if ancestors.is_empty() => ensure!(
                text.unescape()?.trim().is_empty(),
                "Text outside test report root"
            ),
            Event::CData(_) if ancestors.is_empty() => bail!("CDATA outside test report root"),
            Event::Start(element) | Event::Empty(element) => {
                let name = element.name().as_ref().to_vec();
                let parent = ancestors.last().map(Vec::as_slice);
                if parent.is_none() {
                    ensure!(
                        matches!(name.as_slice(), b"testsuite" | b"testsuites"),
                        "Unsupported test report root"
                    );
                    roots += 1;
                }
                if matches!(name.as_slice(), b"testsuite" | b"testsuites") {
                    let mut attrs = BTreeMap::new();
                    for attribute in element.attributes() {
                        let attribute = attribute?;
                        attrs.insert(
                            String::from_utf8(attribute.key.as_ref().to_vec())?,
                            attribute.unescape_value()?.into_owned(),
                        );
                    }
                    let read_counts = || -> Result<TestCounts> {
                        let read = |key: &str, required: bool| -> Result<usize> {
                            match attrs.get(key) {
                                Some(value) => value
                                    .parse()
                                    .with_context(|| format!("Invalid testsuite {key}")),
                                None if !required => Ok(0),
                                None => bail!("Missing testsuite {key}"),
                            }
                        };
                        let counts = TestCounts {
                            tests: read("tests", true)?,
                            failures: read("failures", false)?,
                            errors: read("errors", false)?,
                            skipped: read("skipped", false)?,
                        };
                        let nonpassing = counts
                            .failures
                            .checked_add(counts.errors)
                            .and_then(|value| value.checked_add(counts.skipped))
                            .context("Test count overflow")?;
                        ensure!(nonpassing <= counts.tests, "Inconsistent testsuite counts");
                        Ok(counts)
                    };
                    if name == b"testsuites" {
                        ensure!(
                            parent.is_none(),
                            "Nested testsuites container is unsupported"
                        );
                        if ["tests", "failures", "errors", "skipped"]
                            .iter()
                            .any(|key| attrs.contains_key(*key))
                        {
                            root_declared = Some(read_counts()?);
                        }
                    } else {
                        ensure!(
                            parent.is_none()
                                || matches!(parent, Some(b"testsuites" | b"testsuite")),
                            "Invalid testsuite parent"
                        );
                        let declared = read_counts()?;
                        let relevant = attrs.get("name").is_some_and(|name| {
                            expected_class.map_or_else(
                                || name.contains("ContractTest"),
                                |expected| name == expected,
                            )
                        });
                        if empty {
                            ensure!(
                                declared == TestCounts::default(),
                                "Test suite declares execution but contains no testcases"
                            );
                            if let Some(parent) = suites.last_mut() {
                                parent.child_suites += 1;
                                parent.children.add(&declared)?;
                            } else {
                                root_total.add(&declared)?;
                            }
                            if relevant {
                                total.add(&declared)?;
                                seen = true;
                            }
                        } else {
                            suites.push(XmlSuite {
                                declared,
                                direct: TestCounts::default(),
                                children: TestCounts::default(),
                                child_suites: 0,
                                relevant,
                            });
                        }
                    }
                } else if name == b"testcase" {
                    ensure!(
                        parent == Some(b"testsuite".as_slice()),
                        "Testcase must be a direct testsuite child"
                    );
                    let suite = suites.last_mut().context("Testcase outside a suite")?;
                    if suite.relevant {
                        if let Some(expected) = expected_class {
                            for attribute in element.attributes() {
                                let attribute = attribute?;
                                if attribute.key.as_ref() == b"classname" {
                                    ensure!(
                                        attribute.unescape_value()?.as_ref() == expected,
                                        "Testcase classname disagrees with generated suite"
                                    );
                                }
                            }
                        }
                    }
                    suite.direct.add(&TestCounts {
                        tests: 1,
                        ..Default::default()
                    })?;
                } else if matches!(name.as_slice(), b"failure" | b"error" | b"skipped") {
                    ensure!(
                        parent == Some(b"testcase".as_slice()),
                        "Outcome must be a direct testcase child"
                    );
                    let observed = match name.as_slice() {
                        b"failure" => TestCounts {
                            failures: 1,
                            ..Default::default()
                        },
                        b"error" => TestCounts {
                            errors: 1,
                            ..Default::default()
                        },
                        _ => TestCounts {
                            skipped: 1,
                            ..Default::default()
                        },
                    };
                    suites
                        .last_mut()
                        .context("Outcome outside a suite")?
                        .direct
                        .add(&observed)?;
                }
                if !empty {
                    ancestors.push(name);
                }
            }
            Event::End(element) => {
                ensure!(
                    ancestors.pop().as_deref() == Some(element.name().as_ref()),
                    "Unbalanced test report"
                );
                if element.name().as_ref() == b"testsuite" {
                    let suite = suites.pop().context("Unbalanced testsuite")?;
                    ensure!(
                        suite.child_suites == 0 || suite.direct == TestCounts::default(),
                        "Mixed direct testcases and child suites are unsupported"
                    );
                    let observed = if suite.child_suites == 0 {
                        &suite.direct
                    } else {
                        &suite.children
                    };
                    ensure!(
                        *observed == suite.declared,
                        "Testcase or child-suite outcomes disagree with summary"
                    );
                    if suite.child_suites == 0 && suite.relevant {
                        total.add(&suite.declared)?;
                        seen = true;
                    }
                    if let Some(parent) = suites.last_mut() {
                        parent.child_suites += 1;
                        parent.children.add(&suite.declared)?;
                    } else {
                        root_total.add(&suite.declared)?;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    ensure!(
        roots == 1 && ancestors.is_empty() && suites.is_empty(),
        "Incomplete or invalid test report"
    );
    if let Some(declared) = root_declared {
        ensure!(
            declared == root_total,
            "Root suite totals disagree with child suites"
        );
    }
    Ok(seen.then_some(total))
}

fn parse_jest(bytes: &[u8]) -> Result<TestCounts> {
    let report: Value = serde_json::from_slice(bytes)?;
    let number = |key: &str| -> Result<usize> {
        report
            .get(key)
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .ok_or_else(|| anyhow!("Missing Jest result {key}"))
    };
    let tests = number("numTotalTests")?;
    let failures = number("numFailedTests")?;
    let skipped = number("numPendingTests")?
        .checked_add(
            report
                .get("numTodoTests")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        )
        .context("Jest count overflow")?;
    let total = number("numPassedTests")?
        .checked_add(failures)
        .and_then(|value| value.checked_add(skipped))
        .context("Jest count overflow")?;
    ensure!(total == tests, "Inconsistent Jest counts");
    let success = report
        .get("success")
        .and_then(Value::as_bool)
        .context("Missing Jest execution status")?;
    ensure!(
        success || failures > 0 || tests == 0,
        "Jest reported unsuccessful execution without completed failures"
    );
    ensure!(
        report
            .get("numRuntimeErrorTestSuites")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0,
        "Jest runtime-error suites did not complete"
    );
    let suites = report
        .get("testResults")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Missing Jest testResults"))?;
    ensure!(
        suites.iter().all(|suite| suite
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.contains("ContractTest"))),
        "Jest report includes tests outside the requested contract-test filter"
    );
    let mut observed = TestCounts::default();
    for suite in suites {
        for case in suite
            .get("assertionResults")
            .and_then(Value::as_array)
            .context("Missing Jest cases")?
        {
            let outcome = match case.get("status").and_then(Value::as_str) {
                Some("passed") => TestCounts {
                    tests: 1,
                    ..Default::default()
                },
                Some("failed") => TestCounts {
                    tests: 1,
                    failures: 1,
                    ..Default::default()
                },
                Some("pending" | "todo" | "disabled") => TestCounts {
                    tests: 1,
                    skipped: 1,
                    ..Default::default()
                },
                _ => bail!("Unknown Jest testcase outcome"),
            };
            observed.add(&outcome)?;
        }
    }
    let expected = TestCounts {
        tests,
        failures,
        errors: 0,
        skipped,
    };
    ensure!(observed == expected, "Jest test cases disagree with totals");
    Ok(observed)
}

fn current_counts(
    target: &Path,
    runner: &BuildRunner,
    before: &BTreeMap<PathBuf, ReportStamp>,
    generated: Option<&GeneratedTest>,
) -> Result<Option<ExecutionEvidence>> {
    let mut total = TestCounts::default();
    let mut matching = None;
    let mut seen = false;
    for path in report_paths(target, runner)? {
        if before.get(&path) == Some(&stamp(&path)?) {
            continue;
        }
        let bytes = fs::read(path)?;
        let counts = if matches!(runner, BuildRunner::Npm { .. }) {
            Some(parse_jest(&bytes)?)
        } else {
            parse_test_xml(&bytes)?
        };
        if let Some(counts) = counts {
            seen = true;
            total.add(&counts)?;
        }
        if let Some(generated) = generated {
            if !matches!(runner, BuildRunner::Npm { .. }) {
                if let Some(counts) = parse_named_test_xml(&bytes, Some(&generated.class_name))? {
                    matching = Some(
                        matching
                            .unwrap_or(0usize)
                            .checked_add(counts.tests)
                            .context("Generated test count overflow")?,
                    );
                }
            }
        }
    }
    Ok(seen.then_some(ExecutionEvidence {
        counts: total,
        generated_tests: matching,
    }))
}

fn completed_assertions(output: &Output) -> Option<usize> {
    let text = String::from_utf8_lossy(&output.stdout);
    let mut total: usize = 0;
    let mut seen = false;
    for line in text
        .lines()
        .filter_map(|line| line.strip_prefix("SAJIMORA_RESULT "))
    {
        let record: Value = serde_json::from_str(line).ok()?;
        let attempted = record.get("assertionsAttempted")?.as_u64()?;
        let completed = record.get("assertionsCompleted")?.as_u64()?;
        if completed > attempted {
            return None;
        }
        total = total.checked_add(usize::try_from(completed).ok()?)?;
        seen = true;
    }
    seen.then_some(total)
}

struct LiveResult {
    status: String,
    assertions: Option<usize>,
    details: Value,
}
impl LiveResult {
    fn skipped(reason: &str) -> Self {
        Self {
            status: "SKIPPED".into(),
            assertions: None,
            details: json!({"skipped": true, "reason": reason, "tests_run": null, "tests_passed": null, "tests_failed": null, "tests_errors": null, "tests_skipped": null, "assertions_completed": null}),
        }
    }
}

fn may_retry_online(
    runner: &BuildRunner,
    output: &Output,
    current: &Result<Option<ExecutionEvidence>>,
) -> bool {
    if !matches!(runner, BuildRunner::Maven { .. })
        || !runner.command().1.iter().any(|arg| arg == "-o")
        || output.status.success()
        || !matches!(current, Ok(None))
    {
        return false;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_lowercase();
    text.contains("offline mode")
        && (text.contains("could not resolve")
            || text.contains("cannot access")
            || text.contains("cannot be resolved"))
        && !text.contains("tests run:")
        && !text.contains("running ")
        && !text.contains("test failures")
}

fn execute_runner(
    runner: &BuildRunner,
    target: &Path,
    generated: Option<&GeneratedTest>,
) -> LiveResult {
    let (bin, mut args) = runner.command();
    if let Some(generated) = generated {
        match runner {
            BuildRunner::Maven { .. } => {
                for arg in &mut args {
                    if arg.starts_with("-Dtest=") {
                        *arg = format!("-Dtest={}", generated.class_name);
                    }
                }
            }
            BuildRunner::Gradle { .. } => {
                if let Some(index) = args.iter().position(|arg| arg == "--tests") {
                    args[index + 1] = generated.class_name.clone();
                }
            }
            BuildRunner::Npm { .. } => {}
        }
    }
    let mut attempts = Vec::new();
    let result: Result<(Output, Option<ExecutionEvidence>)> = (|| {
        if matches!(runner, BuildRunner::Npm { .. }) {
            fs::create_dir_all(target.join(".sajimora"))?;
        }
        let mut before = snapshot(target, runner)?;
        let run = |args: &[String],
                   retry_reason: Option<&str>,
                   attempts: &mut Vec<Value>|
         -> Result<Output> {
            match Command::new(&bin).args(args).current_dir(target).output() {
                Ok(output) => {
                    attempts.push(json!({"command": bin, "arguments": args, "working_directory": target, "exit_code": output.status.code(), "success": output.status.success(), "retry_reason": retry_reason}));
                    Ok(output)
                }
                Err(error) => {
                    attempts.push(json!({"command": bin, "arguments": args, "working_directory": target, "exit_code": null, "spawn_error": error.to_string(), "retry_reason": retry_reason}));
                    Err(error.into())
                }
            }
        };
        let mut output = run(&args, None, &mut attempts)?;
        let mut counts = current_counts(target, runner, &before, generated);
        if may_retry_online(runner, &output, &counts) {
            before = snapshot(target, runner)?;
            let online: Vec<String> = args
                .iter()
                .filter(|arg| arg.as_str() != "-o")
                .cloned()
                .collect();
            output = run(
                &online,
                Some("Confirmed offline dependency-resolution failure before test execution"),
                &mut attempts,
            )?;
            counts = current_counts(target, runner, &before, generated);
        }
        Ok((output, counts?))
    })();
    match result {
        Err(error) => LiveResult {
            status: "ERROR".into(),
            assertions: None,
            details: json!({"runner": runner.name(), "skipped": false, "attempts": attempts, "error": format!("{error:#}"), "tests_run": null, "tests_passed": null, "tests_failed": null, "tests_errors": null, "tests_skipped": null, "assertions_completed": null}),
        },
        Ok((output, evidence)) => {
            let counts = evidence.as_ref().map(|evidence| &evidence.counts);
            let bound = generated.is_none_or(|required| {
                evidence
                    .as_ref()
                    .is_some_and(|evidence| evidence.generated_tests == Some(required.tests))
            });
            let mut status = execution_status(output.status.success(), counts);
            if status == "PASS" && !bound {
                status = "INCONCLUSIVE";
            }
            let assertions = counts.and_then(|_| completed_assertions(&output));
            LiveResult {
                status: status.into(),
                assertions,
                details: json!({"runner": runner.name(), "skipped": false, "attempts": attempts,
                "tests_run": counts.map(|counts| counts.tests), "tests_passed": counts.map(TestCounts::passed), "tests_failed": counts.map(|counts| counts.failures),
                "tests_errors": counts.map(|counts| counts.errors), "tests_skipped": counts.map(|counts| counts.skipped), "assertions_completed": assertions,
                "expected_generated_suite": generated, "generated_suite_tests": evidence.as_ref().and_then(|evidence| evidence.generated_tests),
                "assertion_scope": assertions.map(|_| "Instrumented JSONPath checks, not all framework assertions"),
                "reason": if !bound { Some("Fresh results do not cover the generated suite and its emitted checks") } else if counts.is_none() { Some("No trustworthy current-run applicable results") } else if counts.is_some_and(|counts| counts.tests == 0) { Some("Zero applicable tests executed") } else { None } }),
            }
        }
    }
}

fn execution_status(success: bool, counts: Option<&TestCounts>) -> &'static str {
    if !success {
        return if counts.is_some_and(|counts| counts.failures > 0 || counts.errors > 0) {
            "FAIL"
        } else {
            "ERROR"
        };
    }
    match counts {
        None => "INCONCLUSIVE",
        Some(counts) if counts.failures > 0 || counts.errors > 0 => "FAIL",
        Some(counts) if counts.tests == 0 || counts.skipped > 0 => "INCONCLUSIVE",
        Some(_) => "PASS",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structured_results_aggregate_leaf_suites_and_errors_and_skips() {
        let xml = br#"<testsuites><testsuite name="parent" tests="5" failures="1" errors="1" skipped="1"><testsuite name="FirstContractTest" tests="2" failures="0" errors="0" skipped="1"><testcase/><testcase><skipped/></testcase></testsuite><testsuite name="SecondContractTest" tests="3" failures="1" errors="1" skipped="0"><testcase/><testcase><failure/></testcase><testcase><error/></testcase></testsuite></testsuite></testsuites>"#;
        let counts = parse_test_xml(xml).unwrap().unwrap();
        assert_eq!(
            counts,
            TestCounts {
                tests: 5,
                failures: 1,
                errors: 1,
                skipped: 1
            }
        );
        assert_eq!(counts.passed(), 2);
        assert_eq!(execution_status(true, Some(&counts)), "FAIL");
    }
    #[test]
    fn malformed_and_inconsistent_results_are_rejected() {
        for xml in [
            "<testsuite",
            "<testsuite name='ContractTest' tests='x'/>",
            "<testsuite name='ContractTest' tests='1' failures='2'/>",
            "<testsuite name='ContractTest' tests='2'><testcase/></testsuite>",
            "<!DOCTYPE x><testsuite name='ContractTest' tests='1'/>",
        ] {
            assert!(parse_test_xml(xml.as_bytes()).is_err(), "{xml}");
        }
    }
    #[test]
    fn no_counts_or_zero_or_skipped_or_failed_process_never_pass() {
        assert_eq!(execution_status(true, None), "INCONCLUSIVE");
        assert_eq!(
            execution_status(true, Some(&TestCounts::default())),
            "INCONCLUSIVE"
        );
        let passing = TestCounts {
            tests: 2,
            ..Default::default()
        };
        assert_eq!(execution_status(false, Some(&passing)), "ERROR");
        assert_eq!(execution_status(true, Some(&passing)), "PASS");
        assert_eq!(
            execution_status(
                true,
                Some(&TestCounts {
                    skipped: 1,
                    ..passing
                })
            ),
            "INCONCLUSIVE"
        );
    }
    #[test]
    fn unrelated_suites_are_not_contract_execution_evidence() {
        assert!(parse_test_xml(
            br#"<testsuite name="OtherTest" tests="2"><testcase/><testcase/></testsuite>"#
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn jest_counts_require_applicable_cases_and_consistency() {
        let bytes = br#"{"success":true,"numTotalTests":1,"numFailedTests":0,"numPendingTests":0,"numPassedTests":1,"testResults":[{"name":"SomeContractTest.spec.ts","assertionResults":[{"status":"passed"}]}]}"#;
        assert_eq!(parse_jest(bytes).unwrap().tests, 1);
        assert!(parse_jest(br#"{"success":true,"numTotalTests":1,"numFailedTests":0,"numPendingTests":0,"numPassedTests":1,"testResults":[]}"#).is_err());
    }

    fn failed_output(text: &str) -> Output {
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(1)
        };
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(256)
        };
        Output {
            status,
            stdout: text.as_bytes().to_vec(),
            stderr: vec![],
        }
    }

    #[test]
    fn offline_retry_requires_resolution_failure_before_any_tests() {
        let runner = BuildRunner::Maven {
            bin: "mock".into(),
            args: vec!["-o".into()],
        };
        assert!(!may_retry_online(
            &runner,
            &failed_output("Tests run: 1, Failures: 1\nAssertion: was not found in collection"),
            &Ok(None)
        ));
        let dependency =
            failed_output("Cannot access repository in offline mode: could not resolve dependency");
        assert!(may_retry_online(&runner, &dependency, &Ok(None)));
        assert!(!may_retry_online(
            &runner,
            &dependency,
            &Ok(Some(ExecutionEvidence {
                counts: TestCounts {
                    tests: 1,
                    ..Default::default()
                },
                generated_tests: None,
            }))
        ));
        assert!(!may_retry_online(
            &runner,
            &failed_output("Running ContractTest\nCannot access repository in offline mode"),
            &Ok(None)
        ));
    }

    #[test]
    fn assertion_counters_are_structured_or_unavailable() {
        let output = failed_output("SAJIMORA_RESULT {\"assertionsAttempted\":7,\"assertionsCompleted\":7}\nSAJIMORA_RESULT {\"assertionsAttempted\":0,\"assertionsCompleted\":0}\n");
        assert_eq!(completed_assertions(&output), Some(7));
        assert_eq!(
            completed_assertions(&failed_output("SAJIMORA_RESULT invalid")),
            None
        );
        assert_eq!(completed_assertions(&failed_output("Tests run: 7")), None);
    }

    #[test]
    fn module_gradle_metadata_does_not_select_parent_maven_wrapper() {
        let root = std::env::temp_dir().join(format!(
            "sajimora-module-runner-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let module = root.join("backend");
        fs::create_dir_all(&module).unwrap();
        fs::write(root.join("pom.xml"), "parent").unwrap();
        fs::write(
            root.join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" }),
            "mock",
        )
        .unwrap();
        fs::write(module.join("build.gradle"), "plugins {}").unwrap();
        let wrapper_name = if cfg!(windows) {
            "gradlew.bat"
        } else {
            "gradlew"
        };
        fs::write(root.join(wrapper_name), "mock").unwrap();
        let runner = detect_build_runner(&module, &root, ProviderKind::Spring).unwrap();
        assert_eq!(runner.name(), "Gradle");
        assert_eq!(
            runner.command().0,
            root.join(wrapper_name).to_string_lossy()
        );
        assert_eq!(runner.compilation_command().unwrap().0, runner.command().0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nesting_framework_is_identified_not_guessed() {
        let root = std::env::temp_dir().join(format!(
            "sajimora-jest-runner-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"test":"jest"},"devDependencies":{"jest":"^30.0.0"}}"#,
        )
        .unwrap();
        let runner = detect_build_runner(&root, &root, ProviderKind::NestJs).unwrap();
        assert!(runner
            .command()
            .1
            .iter()
            .any(|arg| arg == "--testPathPatterns=ContractTest"));
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"test":"echo success"}}"#,
        )
        .unwrap();
        assert!(detect_build_runner(&root, &root, ProviderKind::NestJs).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
