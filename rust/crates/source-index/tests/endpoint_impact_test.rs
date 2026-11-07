//! endpoint_impact_test.rs — revision semantics, incomplete evidence, and
//! path restrictions for the advisory endpoint-impact report.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ConsumerLocation, ContractArtifactEnvelope, DecoderKind, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ObjectWireType, PrimitiveScalar, PrimitiveWireType, WirePropertyContract, WireType,
};
use serde_json::Value;
use source_index::endpoint_impact::{
    analyze, resolve_output_path, ImpactMode, ImpactRequest, SCHEMA_VERSION,
};
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
            "sajimora-impact-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("workspace")).unwrap();
        Self { path }
    }

    fn repo(&self) -> PathBuf {
        let repo = self.path.join("workspace").join("repo");
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

const PACKAGE_DIR: &str = "backend/src/main/java/com/example/demo";

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

fn orders_controller() -> String {
    r#"package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping
    public UserDto list() {
        return new UserDto();
    }
}
"#
    .to_string()
}

const USER_DTO: &str = r#"package com.example.demo;

public class UserDto {
    private Long id;
    private String name;

    public Long getId() { return id; }
    public String getName() { return name; }
}
"#;

const USER_DTO_EXTENDED: &str = r#"package com.example.demo;

public class UserDto {
    private Long id;
    private String name;
    private String email;

    public Long getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
}
"#;

fn write_manifest(repo: &Path) {
    let sajimora = repo.join(".sajimora");
    fs::create_dir_all(&sajimora).unwrap();
    let manifest = serde_json::json!({
        "manifestVersion": 1,
        "status": "COMPLETE",
        "sajimoraVersion": "32.9.0",
        "roots": {
            "repo_root": repo.to_string_lossy().replace('\\', "/"),
            "backend_root": "backend",
            "frontend_root": null,
            "service_id": "user-service",
        },
    });
    fs::write(
        sajimora.join("init-manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

fn write_backend(repo: &Path, route: &str) {
    let dir = repo.join(PACKAGE_DIR);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("UserController.java"), controller(route)).unwrap();
    fs::write(dir.join("UserDto.java"), USER_DTO).unwrap();
}

fn commit_all(repo: &Path, message: &str) -> String {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

fn analyze_working(repo: &Path, tests: Vec<PathBuf>) -> Value {
    analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.to_path_buf(),
            mode: ImpactMode::WorkingTree,
            commit_range: None,
            generated_tests: tests,
        },
    )
    .unwrap()
}

fn endpoint<'a>(report: &'a Value, method: &str, path: &str) -> &'a Value {
    report["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["method"] == method && entry["path"] == path)
        .unwrap_or_else(|| panic!("endpoint {method} {path} missing from report"))
}

fn reason_codes(report: &Value, layer: &str) -> Vec<String> {
    report["completeness"][layer]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reason| reason["code"].as_str().unwrap().to_string())
        .collect()
}

fn reason<'a>(report: &'a Value, layer: &str, code: &str) -> &'a Value {
    report["completeness"][layer]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reason| reason["code"] == code)
        .unwrap_or_else(|| panic!("reason {code} missing from {layer}"))
}

#[test]
fn working_tree_maps_added_modified_and_deleted_files() {
    let temp = Temp::new("working");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    commit_all(&repo, "baseline");

    // Untracked endpoint plus an unstaged DTO edit.
    let dir = repo.join(PACKAGE_DIR);
    fs::write(dir.join("OrderController.java"), orders_controller()).unwrap();
    fs::write(dir.join("UserDto.java"), USER_DTO_EXTENDED).unwrap();

    let report = analyze_working(&repo, vec![]);
    assert_eq!(report["schemaVersion"], SCHEMA_VERSION);
    assert_eq!(report["revision"]["mode"], "workingTreeVsHead");
    assert_eq!(report["revision"]["base"]["kind"], "GIT_TREE");
    assert_eq!(report["revision"]["candidate"]["kind"], "WORKING_TREE");
    assert_eq!(report["revision"]["untrackedFiles"]["count"], 1);

    let added = endpoint(&report, "GET", "/api/orders");
    assert_eq!(added["change"], "ADDED");
    // The new endpoint returns UserDto, so the changed DTO is evidence for it
    // as well as the untracked controller that declares it.
    assert_eq!(
        added["attributedFiles"],
        serde_json::json!([
            format!("{PACKAGE_DIR}/OrderController.java"),
            format!("{PACKAGE_DIR}/UserDto.java")
        ])
    );

    let changed = endpoint(&report, "GET", "/api/users");
    assert_eq!(changed["change"], "CONTRACT_CHANGED");
    assert_eq!(
        changed["attributedFiles"],
        serde_json::json!([format!("{PACKAGE_DIR}/UserDto.java")])
    );
    assert_eq!(
        changed["definedAt"]["file"],
        format!("{PACKAGE_DIR}/UserController.java")
    );

    // Deleting the tracked controller removes its endpoint; the untracked
    // controller is still an addition.
    fs::remove_file(dir.join("UserController.java")).unwrap();
    let report = analyze_working(&repo, vec![]);
    let removed = endpoint(&report, "GET", "/api/users");
    assert_eq!(removed["change"], "REMOVED");
    assert_eq!(
        removed["attributedFiles"],
        serde_json::json!([
            format!("{PACKAGE_DIR}/UserController.java"),
            format!("{PACKAGE_DIR}/UserDto.java")
        ])
    );
    assert_eq!(endpoint(&report, "GET", "/api/orders")["change"], "ADDED");
}

#[test]
fn staged_mode_does_not_observe_unstaged_edits() {
    let temp = Temp::new("staged");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    commit_all(&repo, "baseline");

    let dir = repo.join(PACKAGE_DIR);
    fs::write(dir.join("UserDto.java"), USER_DTO_EXTENDED).unwrap();

    let staged = analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.to_path_buf(),
            mode: ImpactMode::Staged,
            commit_range: None,
            generated_tests: vec![],
        },
    )
    .unwrap();
    assert_eq!(staged["revision"]["candidate"]["kind"], "GIT_INDEX");
    assert_eq!(staged["summary"]["changedFiles"], 0);
    assert_eq!(staged["summary"]["affectedEndpoints"], 0);
    assert_eq!(
        staged["provider"]["extraction"],
        "NOT_RUN_NO_PROVIDER_INPUT_CHANGED"
    );

    let working = analyze_working(&repo, vec![]);
    assert_eq!(working["summary"]["affectedEndpoints"], 1);
    assert_eq!(
        endpoint(&working, "GET", "/api/users")["change"],
        "CONTRACT_CHANGED"
    );

    // Staging the same edit makes it observable in the index mode.
    git(&repo, &["add", "-A"]);
    let staged = analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.to_path_buf(),
            mode: ImpactMode::Staged,
            commit_range: None,
            generated_tests: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        endpoint(&staged, "GET", "/api/users")["change"],
        "CONTRACT_CHANGED"
    );
}

#[test]
fn crlf_only_difference_is_unchanged() {
    let temp = Temp::new("crlf");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    commit_all(&repo, "baseline");

    let dir = repo.join(PACKAGE_DIR);
    let crlf = controller("/api/users").replace('\n', "\r\n");
    fs::write(dir.join("UserController.java"), crlf).unwrap();

    let report = analyze_working(&repo, vec![]);
    assert_eq!(report["summary"]["changedFiles"], 0);
    assert_eq!(report["summary"]["affectedEndpoints"], 0);
}

#[test]
fn commit_range_reads_committed_trees_not_the_disk() {
    let temp = Temp::new("range");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    let base = commit_all(&repo, "baseline");

    let dir = repo.join(PACKAGE_DIR);
    fs::write(dir.join("UserController.java"), controller("/api/v2/users")).unwrap();
    let candidate = commit_all(&repo, "rename route");
    // An uncommitted edit must never appear in a committed-tree comparison.
    fs::write(
        dir.join("UserController.java"),
        controller("/api/disk/users"),
    )
    .unwrap();

    let report = analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.to_path_buf(),
            mode: ImpactMode::CommitRange,
            commit_range: Some(format!("{base}..{candidate}")),
            generated_tests: vec![],
        },
    )
    .unwrap();
    assert_eq!(report["revision"]["candidate"]["kind"], "GIT_TREE");
    assert_eq!(report["revision"]["candidate"]["id"], candidate);
    assert_eq!(endpoint(&report, "GET", "/api/v2/users")["change"], "ADDED");
    assert_eq!(endpoint(&report, "GET", "/api/users")["change"], "REMOVED");
    assert!(report["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["path"] != "/api/disk/users"));

    let three_dot = analyze(
        &[],
        &ImpactRequest {
            repo_root: repo.to_path_buf(),
            mode: ImpactMode::CommitRange,
            commit_range: Some(format!("{base}...{candidate}")),
            generated_tests: vec![],
        },
    );
    assert!(three_dot.is_err());
}

#[test]
fn incomplete_evidence_is_reported_not_invented() {
    let temp = Temp::new("incomplete");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    commit_all(&repo, "baseline");

    let dir = repo.join(PACKAGE_DIR);
    fs::write(
        dir.join("UserService.java"),
        "package com.example.demo;\n\npublic class UserService {\n    public String greeting() { return \"hi\"; }\n}\n",
    )
    .unwrap();

    let report = analyze_working(&repo, vec![]);
    assert_eq!(report["summary"]["changedFiles"], 1);
    assert_eq!(report["summary"]["affectedEndpoints"], 0);

    let endpoints = &report["completeness"]["endpoints"];
    assert_eq!(endpoints["complete"], false);
    let codes = reason_codes(&report, "endpoints");
    assert!(
        codes.contains(&"UNATTRIBUTED_SOURCE_CHANGE".to_string()),
        "codes: {codes:?}"
    );
    assert_eq!(
        reason(&report, "endpoints", "UNATTRIBUTED_SOURCE_CHANGE")["files"],
        serde_json::json!([format!("{PACKAGE_DIR}/UserService.java")])
    );

    assert_eq!(
        report["completeness"]["consumers"]["complete"], false,
        "no consumer artifact was provided"
    );
    assert!(reason_codes(&report, "consumers").contains(&"NO_CONSUMER_CONTRACTS".to_string()));

    assert_eq!(report["completeness"]["generatedTests"]["complete"], false);
    assert!(reason_codes(&report, "generatedTests")
        .contains(&"GENERATED_TEST_PROVENANCE_UNRECORDED".to_string()));
    assert_eq!(report["summary"]["exactTestSelection"], false);
}

#[test]
fn consumers_require_a_verifying_artifact_and_tests_require_markers() {
    let temp = Temp::new("consumers");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users");
    commit_all(&repo, "baseline");

    fs::write(
        repo.join(".sajimora/frontend-contract.json"),
        consumer_artifact("user-service"),
    )
    .unwrap();
    let test_file = repo.join("src/generated/UserContractTest.java");
    fs::create_dir_all(test_file.parent().unwrap()).unwrap();
    fs::write(
        &test_file,
        "// Generated by Sajimora Native Synthesis (JUnit 5)\n\nclass UserContractTest {\n    // [CONTRACT_TEST] Verified contract constraints for GET /api/users\n    // Shape of the GET /api/users response\n}\n",
    )
    .unwrap();
    let plain_file = repo.join("src/generated/Plain.java");
    fs::write(&plain_file, "class Plain {}\n").unwrap();

    let dir = repo.join(PACKAGE_DIR);
    fs::write(dir.join("UserDto.java"), USER_DTO_EXTENDED).unwrap();

    let report = analyze_working(&repo, vec![test_file.clone(), plain_file.clone()]);
    let affected = endpoint(&report, "GET", "/api/users");
    let consumers = affected["consumers"].as_array().unwrap();
    assert_eq!(consumers.len(), 1, "report: {report}");
    assert_eq!(consumers[0]["artifact"], ".sajimora/frontend-contract.json");
    assert_eq!(consumers[0]["rule"], "EXACT");
    assert_eq!(consumers[0]["heuristic"], false);
    assert_eq!(consumers[0]["callSites"][0]["file"], "src/api/users.ts");
    assert_eq!(report["summary"]["consumerLinks"], 1);

    let tests = affected["generatedTests"].as_array().unwrap();
    assert_eq!(tests.len(), 2);
    assert_eq!(tests[0]["kind"], "CONTRACT_TEST");
    assert_eq!(tests[1]["kind"], "SHAPE_CHECK");
    assert!(reason_codes(&report, "generatedTests").contains(&"NOT_A_GENERATED_TEST".to_string()));

    // Tampering with one sealed field invalidates the integrity digest; the
    // call site must disappear rather than be reported from a stale artifact.
    let path = repo.join(".sajimora/frontend-contract.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["payload"]["clientContracts"][0]["consumers"][0]["usage"] = serde_json::json!("tampered");
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

    let report = analyze_working(&repo, vec![]);
    assert_eq!(
        endpoint(&report, "GET", "/api/users")["consumers"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(reason_codes(&report, "consumers").contains(&"REJECTED_CONSUMER_CONTRACT".to_string()));
    assert_eq!(
        report["rejectedConsumerArtifacts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn parameterized_routes_link_through_the_contracts_db_fast_path() {
    let temp = Temp::new("param-fast-path");
    let repo = temp.repo();
    write_manifest(&repo);
    write_backend(&repo, "/api/users/{id}");
    commit_all(&repo, "baseline");

    fs::write(
        repo.join(".sajimora/frontend-contract.json"),
        consumer_artifact_for("user-service", "/api/users/{id}"),
    )
    .unwrap();
    let dir = repo.join(PACKAGE_DIR);
    fs::write(dir.join("UserDto.java"), USER_DTO_EXTENDED).unwrap();

    // The first analyze seals the cache; because the artifact is then current,
    // consumer admission takes the contracts.db fast path. That path used to
    // canonicalize the route twice and lose every parameterized link.
    let report = analyze_working(&repo, vec![]);
    {
        let db = repo.join(".sajimora/contracts.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        let rows: Vec<(String, i64, String, i64)> = conn
            .prepare("SELECT path, size, mtime_nanos, integrity_valid FROM contract_artifact_cache")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        eprintln!("PROBE cache rows: {rows:?}");
        let consumers: i64 = conn
            .query_row("SELECT count(*) FROM consumer_contracts", [], |r| r.get(0))
            .unwrap();
        eprintln!("PROBE consumers: {consumers}");
    }
    assert!(repo.join(".sajimora/contracts.db").exists());
    let affected = endpoint(&report, "GET", "/api/users/{id}");
    let consumers = affected["consumers"].as_array().unwrap();
    assert_eq!(consumers.len(), 1, "report: {report}");
    assert_eq!(consumers[0]["callSites"][0]["file"], "src/api/users.ts");
    assert_eq!(report["summary"]["consumerLinks"], 1);
    assert!(!reason_codes(&report, "consumers").contains(&"NO_CONSUMER_CONTRACTS".to_string()));
}

#[test]
fn output_path_restrictions() {
    let temp = Temp::new("output");
    let repo = temp.repo();
    write_manifest(&repo);

    let default = resolve_output_path(&repo, None, &[]).unwrap();
    assert!(default.ends_with(Path::new(".sajimora").join("endpoint-impact.json")));

    let legacy = resolve_output_path(&repo, Some(Path::new("impact-report.json")), &[]);
    assert!(legacy.is_err());
    let legacy_in_dir =
        resolve_output_path(&repo, Some(Path::new(".sajimora/impact-report.json")), &[]);
    assert!(legacy_in_dir.is_err());
    let escape = resolve_output_path(&repo, Some(Path::new("../escape.json")), &[]);
    assert!(escape.is_err());
    let extension = resolve_output_path(&repo, Some(Path::new(".sajimora/report.txt")), &[]);
    assert!(extension.is_err());

    let foreign = repo.join(".sajimora/foreign.json");
    fs::write(&foreign, "{\"hello\":1}").unwrap();
    let refused = resolve_output_path(&repo, Some(&foreign), &[]);
    assert!(
        refused.is_err(),
        "an unknown JSON file must not be overwritten"
    );

    let existing = repo.join(".sajimora/endpoint-impact.json");
    fs::write(
        &existing,
        format!("{{\"schemaVersion\":\"{SCHEMA_VERSION}\"}}"),
    )
    .unwrap();
    assert!(resolve_output_path(&repo, Some(&existing), &[]).is_ok());

    assert!(resolve_output_path(&repo, Some(Path::new("/")), &[]).is_err());
}

fn consumer_artifact(service_id: &str) -> Vec<u8> {
    consumer_artifact_for(service_id, "/api/users")
}

fn consumer_artifact_for(service_id: &str, route: &str) -> Vec<u8> {
    let prop = |wire_name: &str, scalar: PrimitiveScalar| WirePropertyContract {
        wire_name: wire_name.to_string(),
        aliases: vec![],
        r#type: WireType::Primitive(PrimitiveWireType {
            scalar,
            format: None,
            provenance: None,
        }),
        optional: false,
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
                target_service_id: Some(service_id.to_string()),
                target_api_version: None,
                source_sha256: None,
                consumer_traversal_complete: Some(true),
                http_method: "GET".to_string(),
                normalized_route: route.to_string(),
                request_body: None,
                expected_response: WireType::Object(ObjectWireType {
                    name: Some("User".to_string()),
                    properties: vec![
                        prop("id", PrimitiveScalar::Number),
                        prop("name", PrimitiveScalar::String),
                    ],
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
    serde_json::to_vec_pretty(&seal_envelope(envelope).unwrap()).unwrap()
}
