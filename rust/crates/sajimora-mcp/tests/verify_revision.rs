//! verify_revision.rs — Phase A/B behaviour tests for `sajimora_verify`.
//!
//! Covers the three claims the tool makes:
//!  * `stagedVsBaseline` observes index blobs only, never unstaged file bytes.
//!  * `commitRange` reads both endpoints from Git trees, never the working tree.
//!  * with no consumer evidence the gate abstains instead of preserving.
//!
//! Plus discovery precedence, dedupe, and the path confinement rules.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ConsumerLocation, ContractArtifactEnvelope, DecoderKind, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ObjectWireType, PrimitiveScalar, PrimitiveWireType, WirePropertyContract, WireType,
};
use contract_core::report::CrossLanguageVerdict;
use contract_core::service::{read_bounded, validate_path_under_roots};
use sajimora_mcp::verify::{self, RevisionMode, VerifyRequest};
use serde_json::Value;
use source_index::discovery;
use source_index::revision::{self, BackendScope};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Temp {
    path: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-verify-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn repo(&self) -> PathBuf {
        let repo = self.path.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        git(&repo, &["config", "user.name", "Fixture"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        repo
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn controller(route: &str) -> String {
    format!(
        r#"package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("{route}")
public class UserController {{

    @GetMapping
    public UserDto list() {{
        return new UserDto();
    }}
}}
"#
    )
}

const USER_DTO: &str = r#"package com.example.demo;

public class UserDto {
    private Long id;
    private String name;

    public Long getId() { return id; }
    public String getName() { return name; }
}
"#;

fn write_source(repo: &Path, route: &str) {
    let dir = repo.join("src/main/java/com/example/demo");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("UserController.java"), controller(route)).unwrap();
    fs::write(dir.join("UserDto.java"), USER_DTO).unwrap();
}

/// Write the pieces `sajimora init --apply` would leave behind, sealing the
/// baseline from the current working tree exactly as init does.
fn seal_baseline(repo: &Path, service_id: &str) {
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();
    let manifest = serde_json::json!({
        "manifestVersion": 1,
        "status": "COMPLETE",
        "roots": {
            "repoRoot": repo.to_string_lossy().replace('\\', "/"),
            "backendRoot": "",
            "frontendRoot": "",
            "serviceId": service_id,
        },
    });
    fs::write(
        sajimora.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let envelope =
        revision::extract_working_tree(repo, &BackendScope::new(repo, ""), service_id).unwrap();
    fs::write(
        sajimora.join("backend-contract.json"),
        serde_json::to_string_pretty(&envelope).unwrap(),
    )
    .unwrap();
}

fn routes(envelope: &ContractArtifactEnvelope) -> Vec<String> {
    let payload = match &envelope.payload {
        contract_core::envelope::ArtifactPayload::Backend(backend) => backend,
        _ => panic!("expected a backend contract payload"),
    };
    let mut found: Vec<String> = payload
        .endpoints
        .iter()
        .map(|endpoint| {
            format!(
                "{} {}",
                endpoint.identity.http_method, endpoint.identity.normalized_route.raw_path
            )
        })
        .collect();
    found.sort();
    found
}

/// A consumer that calls the route `write_source` serves, sealed the way
/// `sajimora init` seals `.sajimora/frontend-contract.json` — V2 envelope over
/// the `SAJIMORA_CROSS_LANGUAGE_IMPACT_V1` report schema. The repo's V1
/// fixture cannot be compared against an extracted V2 producer because
/// `compare` refuses mixed envelope versions.
fn consumer(service_id: &str) -> Vec<u8> {
    consumer_fields(
        service_id,
        &[
            ("id", PrimitiveScalar::Number),
            ("name", PrimitiveScalar::String),
        ],
    )
}

fn consumer_fields(service_id: &str, fields: &[(&str, PrimitiveScalar)]) -> Vec<u8> {
    let prop = |wire_name: &str, scalar: PrimitiveScalar| WirePropertyContract {
        wire_name: wire_name.to_string(),
        aliases: vec![],
        r#type: WireType::Primitive(PrimitiveWireType {
            scalar,
            format: None,
            provenance: None,
        }),
        optional: false,
        // Java reference fields extract as nullable, so a consumer that only
        // accepts a value would be reported as broken. This one accepts null.
        nullable: true,
        server_assigned: false,
        validation_constraints: vec![],
        provenance: None,
    };
    let envelope = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::FrontendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: format!("git-root:{service_id}"),
            service_id: service_id.to_string(),
            api_version: None,
            parent_commit: "HEAD".to_string(),
            candidate_snapshot: "HEAD".to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "32.9.0".to_string(),
            framework_profile: None,
            codec_profile: None,
            client_profile: Some("STATIC_FETCH_V1".to_string()),
            config_fingerprint: None,
        },
        completeness: ArtifactCompleteness {
            complete: true,
            unresolved_endpoints: vec![],
            blockers: vec![],
        },
        integrity: None,
        signature: None,
        issued_at_unix: None,
        payload: ArtifactPayload::Frontend(FrontendContractPayload {
            dependency_context: None,
            interceptor_evidence: None,
            client_contracts: vec![FrontendClientContract {
                target_service_id: Some("user-service".to_string()),
                target_api_version: None,
                source_sha256: None,
                consumer_traversal_complete: Some(true),
                http_method: "GET".to_string(),
                normalized_route: "/api/users".to_string(),
                request_body: None,
                expected_response: WireType::Object(ObjectWireType {
                    name: Some("User".to_string()),
                    properties: fields
                        .iter()
                        .map(|(wire_name, scalar)| prop(wire_name, scalar.clone()))
                        .collect(),
                    strict: None,
                    provenance: None,
                }),
                decoder_kind: DecoderKind::InferredType,
                consumers: vec![ConsumerLocation {
                    file: "src/api/users.ts".to_string(),
                    line: 4,
                    column: None,
                    usage: "fetch".to_string(),
                }],
                unresolved_evidence: vec![],
                observed_response: None,
                observed_request_body: None,
                source_file: "src/api/users.ts".to_string(),
                source_line: 4,
            }],
            type_pool: None,
            path_pool: None,
        }),
        raw_value: None,
    };
    let sealed = seal_envelope(envelope).expect("consumer envelope seals");
    serde_json::to_vec_pretty(&sealed).unwrap()
}

fn consumer_fixture() -> Vec<u8> {
    consumer("frontend-app")
}

/// The same shape under a different service id, so content-based dedupe keeps
/// both. `parse_envelope` does not verify the seal, and discovery never admits
/// an envelope on the strength of a signature.
fn consumer_variant(service_id: &str) -> Vec<u8> {
    consumer(service_id)
}

// ---------------------------------------------------------------------------
// stagedVsBaseline reads the index, not the working tree
// ---------------------------------------------------------------------------

#[test]
fn staged_mode_ignores_unstaged_bytes() {
    let temp = Temp::new("staged");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    // Stage a route change, then edit the same file again without staging it.
    write_source(&repo, "/api/staged-only");
    git(
        &repo,
        &["add", "src/main/java/com/example/demo/UserController.java"],
    );
    write_source(&repo, "/api/unstaged-only");

    let backend = BackendScope::new(&repo, "");
    let head = revision::head_commit(&repo).unwrap();
    let (staged, token) = revision::extract_staged(&repo, &backend, "user-service", &head).unwrap();
    let staged_routes = routes(&staged);
    assert!(
        staged_routes
            .iter()
            .any(|route| route == "GET /api/staged-only"),
        "staged revision must show the staged route: {staged_routes:?}"
    );
    assert!(
        !staged_routes.iter().any(|route| route.contains("unstaged")),
        "unstaged working-tree bytes leaked into the staged revision: {staged_routes:?}"
    );

    // The same file read from disk does show the unstaged route, so the two
    // modes are genuinely different observers rather than both reading one.
    let working = revision::extract_working_tree(&repo, &backend, "user-service").unwrap();
    assert!(
        routes(&working)
            .iter()
            .any(|route| route == "GET /api/unstaged-only"),
        "working-tree mode must observe the unstaged edit"
    );

    assert_eq!(token.len(), 16);
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        staged.snapshot.candidate_snapshot,
        format!("staged:{token}"),
        "the staged snapshot must name the exact blob set that was analyzed"
    );
    assert_eq!(staged.snapshot.parent_commit, head);
}

#[test]
fn staged_mode_refuses_an_unmerged_index() {
    let temp = Temp::new("unmerged");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);

    let dto = repo.join("src/main/java/com/example/demo/UserDto.java");
    let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    fs::write(&dto, USER_DTO.replace("String name", "String nameA")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "main-side"]);
    git(&repo, &["checkout", "-b", "side", "HEAD~1"]);
    fs::write(&dto, USER_DTO.replace("String name", "String nameB")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "side"]);
    git(&repo, &["checkout", &branch]);
    let merged = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["merge", "side", "-m", "conflict"])
        .env("GIT_MERGE_AUTOEDIT", "no")
        .output()
        .unwrap();
    if merged.status.success() {
        eprintln!("git merged cleanly on this platform; nothing unmerged to assert");
        return;
    }

    let error = revision::index_entries(&repo)
        .expect_err("a conflicted index must not be read as one revision");
    assert!(
        error.to_string().contains("Unmerged index entry"),
        "unexpected error: {error}"
    );
}

// ---------------------------------------------------------------------------
// commitRange reads Git trees
// ---------------------------------------------------------------------------

#[test]
fn commit_range_reads_trees_without_the_working_tree() {
    let temp = Temp::new("range");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "first"]);
    write_source(&repo, "/api/renamed");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "second"]);

    let parent = git(&repo, &["rev-parse", "HEAD~1"]);
    let child = git(&repo, &["rev-parse", "HEAD"]);

    // Delete the source from disk: any mode that needed the working tree now fails.
    fs::remove_dir_all(repo.join("src")).unwrap();

    let backend = BackendScope::new(&repo, "");
    let base = revision::extract_tree(&repo, &backend, "user-service", &parent, &parent).unwrap();
    let candidate =
        revision::extract_tree(&repo, &backend, "user-service", &child, &parent).unwrap();

    assert!(
        routes(&base).iter().any(|route| route == "GET /api/users"),
        "the parent tree must be readable: {:?}",
        routes(&base)
    );
    assert!(
        routes(&candidate)
            .iter()
            .any(|route| route == "GET /api/renamed"),
        "the candidate tree must be readable: {:?}",
        routes(&candidate)
    );
    assert_eq!(base.snapshot.candidate_snapshot, parent);
    assert_eq!(candidate.snapshot.candidate_snapshot, child);
    assert_eq!(candidate.snapshot.parent_commit, parent);
}

#[test]
fn revisions_are_resolved_explicitly_and_option_like_input_is_rejected() {
    let temp = Temp::new("resolve");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "first"]);

    let sha = revision::resolve_commit(&repo, "HEAD").unwrap();
    assert_eq!(sha.len(), 40);
    assert!(sha.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(revision::resolve_commit(&repo, &sha).unwrap(), sha);

    for hostile in ["--help", "-b", "", "definitely-not-a-revision"] {
        assert!(
            revision::resolve_commit(&repo, hostile).is_err(),
            "revision {hostile:?} must not be accepted"
        );
    }
    // A tree listing needs a resolved id, so a moving ref cannot shift between
    // the two reads that make up one comparison.
    assert!(revision::tree_entries(&repo, "HEAD").is_err());
}

// ---------------------------------------------------------------------------
// Fail-closed abstention and the comparison pipeline
// ---------------------------------------------------------------------------

fn verify_request(repo: &Path, mode: RevisionMode, range: Option<String>) -> VerifyRequest {
    VerifyRequest {
        repo_root: repo.to_path_buf(),
        target_services: None,
        revision_mode: mode,
        commit_range: range,
        strict: false,
    }
}

#[test]
fn no_consumer_contract_abstains_and_never_preserves() {
    let temp = Temp::new("noconsumer");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    let resolution = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .expect("verification runs");
    assert_eq!(
        resolution.report.verdict,
        CrossLanguageVerdict::Inconclusive
    );
    let codes: Vec<String> = resolution
        .report
        .blockers
        .iter()
        .map(|blocker| {
            serde_json::to_value(&blocker.code)
                .unwrap()
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert_eq!(codes, vec!["NO_CONSUMER_CONTRACTS".to_string()]);
    assert!(
        resolution.consumers.is_empty(),
        "no consumer may be reported when none was discovered"
    );
    // Advisory abstention is not a violation, but --strict must surface it.
    assert!(!verify::is_blocking(&resolution.report, false));
    assert!(verify::is_blocking(&resolution.report, true));
}

#[test]
fn missing_baseline_is_an_analysis_error_not_a_preservation() {
    let temp = Temp::new("nobaseline");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    let resolution = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .expect("the gate reports rather than throws");
    assert_eq!(
        resolution.report.verdict,
        CrossLanguageVerdict::AnalysisError
    );
    assert!(resolution.report.blockers[0]
        .message
        .contains("sajimora init --apply"));
}

#[test]
fn discovered_consumer_feeds_the_comparison_service() {
    let temp = Temp::new("pipeline");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    let targets = repo.join(".sajimora/targets");
    fs::create_dir_all(&targets).unwrap();
    fs::write(targets.join("frontend-app.json"), consumer_fixture()).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    let resolution = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .expect("comparison runs with a discovered consumer");
    assert_eq!(resolution.consumers.len(), 1);
    assert_eq!(resolution.consumers[0].step, discovery::TARGETS_DIR);
    assert_eq!(resolution.consumers[0].service_id, "frontend-app");
    // The discovered consumer must actually reach the comparison, not merely
    // be tolerated: its call site is linked to the served route.
    assert_eq!(
        resolution.report.counts.linked_endpoints, 1,
        "counts: {:?}",
        resolution.report.counts
    );
    // A provider that still serves the consumed route is preserved, and the
    // verdict is only ever advisory.
    assert_eq!(
        resolution.report.verdict,
        CrossLanguageVerdict::LikelyPreserved,
        "blockers: {:?}, findings: {:?}",
        resolution.report.blockers,
        resolution.report.findings
    );
    assert_eq!(resolution.report.assurance, "ADVISORY_ONLY");
    assert_eq!(
        resolution.report.verdict_scope.as_deref(),
        Some(contract_core::report::VERDICT_SCOPE_STATIC_COMPAT)
    );
}

// ---------------------------------------------------------------------------
// Phase B discovery
// ---------------------------------------------------------------------------

#[test]
fn discovery_precedence_is_deterministic_and_deduplicates() {
    let temp = Temp::new("discover");
    let repo = temp.repo();
    let consumer = consumer_fixture();

    // Step A: the repository's own committed consumer contract.
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(sajimora.join("targets")).unwrap();
    fs::write(sajimora.join("frontend-contract.json"), &consumer).unwrap();
    // Same bytes reachable a second way: must collapse to one contract.
    fs::write(sajimora.join("targets/duplicate.json"), &consumer).unwrap();

    // Step B: a configured sibling holding a different envelope.
    let configured = temp.path.join("configured-sibling");
    fs::create_dir_all(configured.join(".sajimora")).unwrap();
    fs::write(
        configured.join(".sajimora/frontend-contract.json"),
        consumer_variant("configured-app"),
    )
    .unwrap();
    fs::write(
        sajimora.join("config.json"),
        serde_json::json!({ "polyrepo": { "localSiblings": ["../configured-sibling"] } })
            .to_string(),
    )
    .unwrap();

    // Step C: an ambient sibling directory.
    let ambient = temp.path.join("ambient-sibling");
    fs::create_dir_all(ambient.join(".sajimora")).unwrap();
    fs::write(
        ambient.join(".sajimora/frontend-contract.json"),
        consumer_variant("ambient-app"),
    )
    .unwrap();

    let allowed = vec![temp.path.clone()];
    let first = discovery::discover(&repo, &allowed).unwrap();
    let second = discovery::discover(&repo, &allowed).unwrap();
    let paths = |d: &discovery::Discovery| -> Vec<String> {
        d.contracts
            .iter()
            .map(|entry| entry.0.path.to_string_lossy().replace('\\', "/"))
            .collect()
    };
    assert_eq!(
        paths(&first),
        paths(&second),
        "discovery order must not depend on directory iteration"
    );
    let steps: Vec<&str> = first.contracts.iter().map(|entry| entry.0.step).collect();
    assert_eq!(
        steps,
        vec![
            discovery::SELF_FRONTEND,
            discovery::CONFIGURED_SIBLINGS,
            discovery::AMBIENT_SIBLINGS
        ],
        "the identical envelope must be admitted once, in precedence order"
    );
    assert!(
        first.rejected.is_empty(),
        "unexpected rejections: {:?}",
        first.rejected
    );
    assert_eq!(
        first.service_ids(),
        vec!["frontend-app", "configured-app", "ambient-app"]
    );

    // Without an allowed root there is no boundary the ambient scan could be
    // confined to. The sibling project is named in the rejections, never
    // admitted; an explicitly configured sibling still is.
    let unconfined = discovery::discover(&repo, &[]).unwrap();
    assert_eq!(
        unconfined.service_ids(),
        vec!["frontend-app", "configured-app"],
        "a sibling project's contract is not evidence without a boundary"
    );
    let ambient: Vec<&discovery::RejectedContract> = unconfined
        .rejected
        .iter()
        .filter(|rejected| rejected.step == discovery::AMBIENT_SIBLINGS)
        .collect();
    assert_eq!(ambient.len(), 1, "{:?}", unconfined.rejected);
    assert!(
        ambient[0]
            .reason
            .contains("outside the repository boundary"),
        "{}",
        ambient[0].reason
    );
    assert_eq!(
        ambient[0].path,
        temp.path
            .join("ambient-sibling")
            .join(".sajimora")
            .join("frontend-contract.json")
    );
}

#[test]
fn escapes_and_unreadable_artifacts_are_reported_not_dropped() {
    let temp = Temp::new("escape");
    let repo = temp.repo();
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();

    // Outside the allowed roots, reached through a configured sibling path.
    let outside = temp.path.join("../outside-workspace");
    fs::create_dir_all(outside.join(".sajimora")).unwrap();
    fs::write(
        outside.join(".sajimora/frontend-contract.json"),
        consumer_fixture(),
    )
    .unwrap();
    fs::write(
        sajimora.join("config.json"),
        serde_json::json!({ "polyrepo": { "localSiblings": ["../../outside-workspace"] } })
            .to_string(),
    )
    .unwrap();
    // Malformed JSON is a rejection with a reason, never a silent skip.
    fs::create_dir_all(sajimora.join("targets")).unwrap();
    fs::write(sajimora.join("targets/broken.json"), b"{ not json").unwrap();

    let allowed = vec![repo.clone()];
    let found = discovery::discover(&repo, &allowed).unwrap();
    assert!(
        found.contracts.is_empty(),
        "nothing outside the roots may be admitted"
    );
    let reasons: Vec<&str> = found
        .rejected
        .iter()
        .map(|rejected| rejected.reason.as_str())
        .collect();
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("outside all allowed roots")),
        "configured sibling escape must be reported: {reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|reason| !reason.contains("allowed roots")),
        "the malformed artifact must be reported too: {reasons:?}"
    );

    // A traversal-shaped path is refused by the same confinement helper the
    // artifact service uses.
    let traversal = repo
        .join(".sajimora")
        .join("..")
        .join("..")
        .join("escape.json");
    assert!(validate_path_under_roots(&traversal, &allowed).is_err());
}

#[test]
fn symlinked_artifact_is_not_read() {
    let temp = Temp::new("symlink");
    let repo = temp.repo();
    let secret = temp.path.join("secret.json");
    fs::write(&secret, consumer_fixture()).unwrap();
    let link = repo.join("frontend-contract.json");
    if !make_symlink(&secret, &link) {
        eprintln!("symlink creation unavailable without developer privileges; skipped");
        return;
    }
    let error = read_bounded(&link, 1 << 20).unwrap_err().to_string();
    assert!(
        error.contains("symbolic links are not followed"),
        "a symlinked artifact must be refused: {error}"
    );
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_file(target, link).is_ok()
}

#[test]
fn malformed_config_is_surfaced_as_a_rejection() {
    let temp = Temp::new("badconfig");
    let repo = temp.repo();
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();
    fs::write(sajimora.join("config.json"), b"{\"polyrepo\": 5}").unwrap();
    let error = discovery::load_config(&sajimora).unwrap_err().to_string();
    assert!(error.contains("config.json"), "got {error}");

    // Absent configuration is the documented default, not an error.
    let absent = discovery::load_config(&temp.path.join("nothing")).unwrap();
    assert!(absent.local_siblings().is_empty());
}

#[test]
fn verify_rejects_a_repo_root_outside_the_allowed_roots() {
    let temp = Temp::new("rootconfinement");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    let other = temp.path.join("not-a-root");
    fs::create_dir_all(&other).unwrap();
    let outcome = verify::run(
        std::slice::from_ref(&other),
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    );
    match outcome {
        Ok(resolution) => panic!(
            "repoRoot outside the allowed roots was accepted: {:?}",
            resolution.report.verdict
        ),
        Err(error) => assert!(
            error.to_string().contains("outside the allowed roots"),
            "got {error:#}"
        ),
    }
}

#[test]
fn target_services_filter_narrows_the_consumer_set() {
    let temp = Temp::new("filter");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(sajimora.join("targets")).unwrap();
    fs::write(sajimora.join("frontend-contract.json"), consumer_fixture()).unwrap();

    let mut request = verify_request(&repo, RevisionMode::WorkingTree, None);
    request.target_services = Some(vec!["someone-else".to_string()]);
    let resolution = verify::run(&[], None, true, false, request).unwrap();
    // Filtering to nothing is the same evidentiary state as discovering nothing.
    assert_eq!(
        resolution.report.verdict,
        CrossLanguageVerdict::Inconclusive
    );
    assert_eq!(resolution.consumers.len(), 0);
    let code: Value = serde_json::to_value(&resolution.report.blockers[0].code).unwrap();
    assert_eq!(code, "NO_CONSUMER_CONTRACTS");

    request = verify_request(&repo, RevisionMode::WorkingTree, None);
    request.target_services = Some(vec!["frontend-app".to_string()]);
    let kept = verify::run(&[], None, true, false, request).unwrap();
    assert_eq!(kept.consumers.len(), 1);
}

/// A directory reparse point. Windows accepts a junction for an unprivileged
/// user, so the ancestor-escape vector the plan requires is exercised here
/// rather than left to a host that can create real symlinks; on Unix the same
/// shape is an ordinary directory symlink.
fn make_junction(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

#[test]
fn a_sibling_reached_through_a_reparse_point_cannot_escape_the_roots() {
    let temp = Temp::new("reparse");
    let repo = temp.repo();
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");

    // Two levels below the temporary root, so the ambient sibling scan cannot
    // be the thing that finds (or refuses) this contract.
    let outside = temp.path.join("outside").join("frontend");
    fs::create_dir_all(outside.join(".sajimora")).unwrap();
    fs::write(
        outside.join(".sajimora/frontend-contract.json"),
        consumer_fixture(),
    )
    .unwrap();

    // repo/linked is the reparse point, so every literal path below it starts
    // with the repository root while resolving to bytes that do not.
    let link = repo.join("linked");
    if !make_junction(&temp.path.join("outside"), &link) {
        eprintln!("reparse-point creation unavailable on this host; skipped");
        return;
    }
    fs::write(
        sajimora.join("config.json"),
        serde_json::json!({ "polyrepo": { "localSiblings": ["linked/frontend"] } }).to_string(),
    )
    .unwrap();
    let through = link
        .join("frontend")
        .join(".sajimora")
        .join("frontend-contract.json");
    assert!(
        through.is_file(),
        "the fixture must be readable through the reparse point for this to test anything"
    );

    let allowed = vec![repo.clone()];
    let error = validate_path_under_roots(&through, &allowed)
        .expect_err("a path that resolves outside the roots must be refused");
    assert!(
        error.to_string().contains("outside all allowed roots"),
        "got {error}"
    );

    let found = discovery::discover(&repo, &allowed).unwrap();
    assert!(
        found.contracts.is_empty(),
        "a consumer outside the roots was admitted through a reparse point"
    );
    let refused = found
        .rejected
        .iter()
        .find(|rejected| rejected.step == discovery::CONFIGURED_SIBLINGS);
    assert!(
        refused.is_some_and(|rejected| rejected.reason.contains("outside all allowed roots")),
        "the reparse-point sibling must be reported: {:?}",
        found.rejected
    );

    // Losing the only consumer evidence must abstain, never preserve.
    let outcome = verify::run(
        &allowed,
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .unwrap();
    assert_ne!(
        outcome.report.verdict,
        CrossLanguageVerdict::LikelyPreserved
    );
    assert_eq!(outcome.consumers.len(), 0);
}

#[test]
fn two_runs_over_unchanged_inputs_produce_identical_bytes() {
    let temp = Temp::new("determinism");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    seal_baseline(&repo, "user-service");
    fs::write(
        repo.join(".sajimora/frontend-contract.json"),
        consumer_fixture(),
    )
    .unwrap();

    let first = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .unwrap();
    let second = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_vec(&first.report).unwrap(),
        serde_json::to_vec(&second.report).unwrap(),
        "spec §2: identical inputs must produce a byte-identical report"
    );
    // Equality is only interesting if a real comparison took place.
    assert_eq!(first.report.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert_eq!(first.report.counts.linked_endpoints, 1);
    assert_eq!(first.revision, second.revision);
    assert_eq!(
        first
            .consumers
            .iter()
            .map(|entry| entry.sha256.clone())
            .collect::<Vec<_>>(),
        second
            .consumers
            .iter()
            .map(|entry| entry.sha256.clone())
            .collect::<Vec<_>>()
    );
}

const NAMING_DTO: &str = r#"package com.example.demo;

public class UserDto {
    private Long id;
    private String displayName;

    public Long getId() { return id; }
    public String getDisplayName() { return displayName; }
}
"#;

#[test]
fn a_staged_naming_config_change_is_never_admitted_as_preserved() {
    let temp = Temp::new("naming");
    let repo = temp.repo();
    write_source(&repo, "/api/users");
    // A multi-word wire name is the only shape a naming strategy can rewrite.
    fs::write(
        repo.join("src/main/java/com/example/demo/UserDto.java"),
        NAMING_DTO,
    )
    .unwrap();
    seal_baseline(&repo, "user-service");
    fs::write(
        repo.join(".sajimora/frontend-contract.json"),
        consumer_fields(
            "frontend-app",
            &[
                ("id", PrimitiveScalar::Number),
                ("displayName", PrimitiveScalar::String),
            ],
        ),
    )
    .unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    // Control: the same inputs with no staged config are preserved, so the
    // verdict below is caused by the properties blob and not by the fixture.
    let control = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::Staged, None),
    )
    .unwrap();
    assert_eq!(
        control.report.verdict,
        CrossLanguageVerdict::LikelyPreserved,
        "blockers: {:?}, findings: {:?}",
        control.report.blockers,
        control.report.findings
    );

    let properties = repo.join("src/main/resources/application.properties");
    fs::create_dir_all(properties.parent().unwrap()).unwrap();
    fs::write(
        &properties,
        "spring.jackson.property-naming-strategy=SNAKE_CASE\n",
    )
    .unwrap();
    git(&repo, &["add", "src/main/resources/application.properties"]);

    let after = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::Staged, None),
    )
    .unwrap();
    // `configFingerprint` is not part of the profile-migration check, so the
    // rename has to surface at the wire level for the gate to stay fail-closed.
    assert!(
        after.report.counts.linked_endpoints > 0,
        "the endpoint stopped being linked, so this no longer tests a comparison: {:?}",
        after.report.blockers
    );
    assert_ne!(
        after.report.verdict,
        CrossLanguageVerdict::LikelyPreserved,
        "a staged naming change was admitted as compatibility"
    );
    assert!(
        !after.report.findings.is_empty(),
        "a wire-name rewrite must produce findings, not silence"
    );
}

#[test]
fn snake_case_manifest_roots_are_honoured() {
    let temp = Temp::new("snakemanifest");
    let repo = temp.repo();
    let backend = repo.join("backend");
    write_source(&backend, "/api/users");

    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();
    let manifest = serde_json::json!({
        "manifestVersion": 1,
        "status": "COMPLETE",
        "roots": {
            "repo_root": repo.to_string_lossy().replace('\\', "/"),
            "backend_root": "backend",
            "frontend_root": "",
            "service_id": "user-service",
        },
    });
    fs::write(
        sajimora.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let envelope =
        revision::extract_working_tree(&repo, &BackendScope::new(&repo, "backend"), "user-service")
            .unwrap();
    fs::write(
        sajimora.join("backend-contract.json"),
        serde_json::to_string_pretty(&envelope).unwrap(),
    )
    .unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "baseline"]);

    let working = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(&repo, RevisionMode::WorkingTree, None),
    )
    .unwrap();
    assert_eq!(working.revision["backendRoot"], "backend");

    fs::write(
        backend.join("src/main/java/com/example/demo/UserDto.java"),
        "package com.example.demo;\n\npublic class UserDto {\n    private Long id;\n    private String email;\n    public Long getId() { return id; }\n    public String getEmail() { return email; }\n}\n",
    )
    .unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "extend dto"]);

    // commitRange has no sealed baseline to name the producer, so the manifest
    // service_id is the only identity the extraction can use.
    let ranged = verify::run(
        &[],
        None,
        true,
        false,
        verify_request(
            &repo,
            RevisionMode::CommitRange,
            Some("HEAD~1..HEAD".to_string()),
        ),
    )
    .unwrap();
    assert_eq!(ranged.revision["backendRoot"], "backend");
    assert_eq!(ranged.revision["providerServiceId"], "user-service");
}
