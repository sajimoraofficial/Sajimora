use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ConsumerLocation, ContractArtifactEnvelope, DecoderKind, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{RefWireType, WireType};
use rusqlite::OptionalExtension;
use source_index::contracts_db::*;
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};
use std::fs;
use std::path::{Path, PathBuf};
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
            "sajimora-contracts-db-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(path.join(".sajimora")).unwrap();
        Self { path }
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn backend_source() -> Vec<(String, String)> {
    vec![
        (
            "src/main/java/com/demo/UserController.java".to_string(),
            r#"package com.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users/{id}")
    public UserDto get(@PathVariable String id) {
        return null;
    }
}
"#
            .to_string(),
        ),
        (
            "src/main/java/com/demo/UserDto.java".to_string(),
            r#"package com.demo;

public class UserDto {
    private String name;
    private int age;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public int getAge() { return age; }
    public void setAge(int age) { this.age = age; }
}
"#
            .to_string(),
        ),
    ]
}

fn backend_envelope() -> ContractArtifactEnvelope {
    let extractor = JavaRouteExtractor::from_blobs(
        PathBuf::from("contracts-db-fixture"),
        backend_source(),
        ConfigInputs::default(),
    )
    .expect("backend fixture extractor");
    let (payload, completeness) = extractor.extract_payload("user-service");
    ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: "git-root:user-service".to_string(),
            service_id: "user-service".to_string(),
            api_version: None,
            parent_commit: "HEAD".to_string(),
            candidate_snapshot: "HEAD".to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
            framework_profile: Some("SPRING_MVC".to_string()),
            codec_profile: None,
            client_profile: None,
            config_fingerprint: None,
        },
        completeness,
        integrity: None,
        signature: None,
        issued_at_unix: None,
        payload: ArtifactPayload::Backend(payload),
        raw_value: None,
    }
}

fn frontend_envelope() -> ContractArtifactEnvelope {
    let envelope = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::FrontendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: "git-root:frontend".to_string(),
            service_id: "frontend".to_string(),
            api_version: None,
            parent_commit: "HEAD".to_string(),
            candidate_snapshot: "HEAD".to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
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
                normalized_route: "/api/users/{id}".to_string(),
                request_body: None,
                expected_response: WireType::Ref(RefWireType {
                    r#ref: "java:com.demo.UserDto".to_string(),
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
    seal_envelope(envelope).expect("seal frontend fixture")
}

fn write_artifacts(repo: &Path) -> (PathBuf, PathBuf) {
    let dir = repo.join(".sajimora");
    fs::create_dir_all(&dir).unwrap();
    let backend = dir.join("backend-contract.json");
    let frontend = dir.join("frontend-contract.json");
    fs::write(
        &backend,
        serde_json::to_vec_pretty(&seal_envelope(backend_envelope()).unwrap()).unwrap(),
    )
    .unwrap();
    fs::write(
        &frontend,
        serde_json::to_vec_pretty(&frontend_envelope()).unwrap(),
    )
    .unwrap();
    (backend, frontend)
}

fn consumer_rows(repo: &Path) -> i64 {
    let conn = open_reader(&repo.join(".sajimora").join(CONTRACTS_DB_NAME)).expect("reader");
    conn.query_row("SELECT count(*) FROM consumer_contracts", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn test_canonical_route_key() {
    assert_eq!(canonical_route_key("/api/user/{id}"), "/api/user/*PARAM*");
    assert_eq!(canonical_route_key("/api/user/${id}"), "/api/user/*PARAM*");
    assert_eq!(canonical_route_key("/api/user/:param"), "/api/user/*PARAM*");
    assert_eq!(
        canonical_route_key("/api/user/{id:[0-9]+}"),
        "/api/user/*PARAM*"
    );
    assert_eq!(
        canonical_route_key("/api/device/{deviceId}/data"),
        "/api/device/*PARAM*/data"
    );
}

#[test]
fn canonical_route_key_is_idempotent() {
    for raw in [
        "/api/user/{id}",
        "/api/user/${id}",
        "/api/user/:id",
        "/api/user/{id:[0-9]+}",
        "/api/device/{deviceId}/data",
        "/api/**",
        "/",
    ] {
        let once = canonical_route_key(raw);
        assert_eq!(canonical_route_key(&once), once, "not idempotent for {raw}");
    }
    assert_eq!(
        canonical_route_key("/api/user/*PARAM*"),
        "/api/user/*PARAM*"
    );
    assert_eq!(
        canonical_route_key("/api/user/*param*"),
        "/api/user/*PARAM*"
    );
}

#[test]
fn canonical_route_key_preserves_static_case() {
    assert_eq!(
        canonical_route_key("/api/UserSettings/{id}"),
        "/api/UserSettings/*PARAM*"
    );
    assert_eq!(
        canonical_route_key("/api/UserSettings"),
        "/api/UserSettings"
    );
}

#[test]
fn raw_and_canonical_route_forms_find_the_same_consumers() {
    let dir = std::env::temp_dir().join(format!(
        "sajimora-contracts-db-query-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("contracts.db");
    {
        let conn = open_writer(&db_path).expect("writer");
        conn.execute(
            "INSERT INTO consumer_contracts
             (target_service_id, http_method, normalized_route, expected_response_ref,
              source_file, source_line, call_site_usage, complete)
             VALUES ('backend', 'GET', ?1, NULL, 'ui/service.ts', 12, 'http.get(\"/api/user/{id}\")', 1)",
            [canonical_route_key("/api/user/{id}")],
        )
        .unwrap();
    }
    let conn = open_reader(&db_path).expect("reader");
    let raw = query_consumers_by_route(&conn, "/api/user/{id}", Some("GET")).unwrap();
    let canonical = query_consumers_by_route(&conn, "/api/user/*PARAM*", Some("GET")).unwrap();
    assert_eq!(raw.len(), 1);
    assert_eq!(canonical.len(), 1);
    assert_eq!(raw[0].source_line, canonical[0].source_line);
    let wrong_case = query_consumers_by_route(&conn, "/api/User/{id}", Some("GET")).unwrap();
    assert!(
        wrong_case.is_empty(),
        "route keys must be case-sensitive like the matcher"
    );
    let wrong_method = query_consumers_by_route(&conn, "/api/user/{id}", Some("POST")).unwrap();
    assert!(wrong_method.is_empty(), "method filter must be exact");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sync_ingests_sealed_artifacts_and_serves_both_route_forms() {
    let temp = Temp::new("sync");
    write_artifacts(&temp.path);
    let db = sync_if_needed(&temp.path).expect("sync");
    let conn = open_reader(&db).expect("reader");

    let stats = get_catalog_stats(&conn, &db).unwrap();
    assert!(
        stats.backend_endpoints_count >= 2,
        "request+response records"
    );
    assert_eq!(stats.consumer_contracts_count, 1);

    for target in ["/api/users/{id}", "/api/users/*PARAM*"] {
        let consumers = query_consumers_by_route(&conn, target, Some("GET")).unwrap();
        assert_eq!(consumers.len(), 1, "target {target}");
        assert_eq!(consumers[0].source_file, "src/api/users.ts");
    }

    let endpoints = query_endpoints_by_dto(&conn, "UserDto").unwrap();
    assert!(
        endpoints.iter().any(|e| e.raw_path == "/api/users/{id}"),
        "endpoints by DTO must find the controller: {endpoints:?}"
    );
    let request_return: Option<Option<String>> = conn
        .query_row(
            "SELECT return_type_ref FROM backend_endpoints WHERE direction = 'REQUEST' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    match request_return {
        Some(value) => assert!(
            value.is_none(),
            "a REQUEST record's body must not be published as a response type"
        ),
        None => panic!("the parameterized endpoint must publish a REQUEST record"),
    }
    let response_returns: i64 = conn
        .query_row(
            "SELECT count(*) FROM backend_endpoints WHERE direction = 'RESPONSE' AND return_type_ref IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        response_returns >= 1,
        "RESPONSE records keep the response type"
    );
}

#[test]
fn deleting_the_frontend_artifact_clears_stale_consumers() {
    let temp = Temp::new("delete");
    let (_, frontend) = write_artifacts(&temp.path);
    sync_if_needed(&temp.path).expect("first sync");
    assert_eq!(consumer_rows(&temp.path), 1);
    fs::remove_file(&frontend).unwrap();
    sync_if_needed(&temp.path).expect("second sync");
    assert_eq!(
        consumer_rows(&temp.path),
        0,
        "removing the artifact must remove its consumer rows"
    );
}

#[test]
fn unreadable_artifacts_fail_closed() {
    let temp = Temp::new("corrupt");
    let (_, frontend) = write_artifacts(&temp.path);
    sync_if_needed(&temp.path).expect("first sync");
    fs::write(&frontend, b"{\"envelopeVersion\":").unwrap();
    let error = sync_if_needed(&temp.path).expect_err("truncated artifact must fail");
    let message = format!("{error:#}");
    assert!(
        message.contains("not a readable sealed artifact"),
        "unexpected error: {message}"
    );
}

#[test]
fn tampered_frontend_artifact_is_cached_as_invalid_and_not_served() {
    let temp = Temp::new("tamper");
    let (_, frontend) = write_artifacts(&temp.path);
    sync_if_needed(&temp.path).expect("first sync");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&frontend).unwrap()).unwrap();
    value["payload"]["clientContracts"][0]["consumers"][0]["usage"] = serde_json::json!("tampered");
    fs::write(&frontend, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

    sync_if_needed(&temp.path).expect("tampered artifact is cached, not crashed on");
    assert_eq!(consumer_rows(&temp.path), 0);
    let conn = open_reader(&temp.path.join(".sajimora").join(CONTRACTS_DB_NAME)).unwrap();
    let integrity: i64 = conn
        .query_row(
            "SELECT integrity_valid FROM contract_artifact_cache WHERE path LIKE '%frontend-contract.json'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(integrity, 0, "integrity verdict must be cached as invalid");
}

#[test]
fn tampered_backend_artifact_fails_closed() {
    let temp = Temp::new("tamper-backend");
    let (backend, _) = write_artifacts(&temp.path);
    sync_if_needed(&temp.path).expect("first sync");

    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&backend).unwrap()).unwrap();
    value["payload"]["endpoints"][0]["identity"]["httpMethod"] = serde_json::json!("DELETE");
    fs::write(&backend, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

    let error = sync_if_needed(&temp.path).expect_err("tampered backend must fail");
    assert!(
        format!("{error:#}").contains("failed integrity verification"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn schema_version_mismatch_and_emptied_tables_rebuild() {
    let temp = Temp::new("rebuild");
    write_artifacts(&temp.path);
    let db = sync_if_needed(&temp.path).expect("sync");
    assert_eq!(consumer_rows(&temp.path), 1);

    {
        let conn = open_writer(&db).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
    }
    sync_if_needed(&temp.path).expect("schema rebuild");
    assert_eq!(consumer_rows(&temp.path), 1);

    {
        let conn = open_writer(&db).unwrap();
        conn.execute("DELETE FROM backend_endpoints", []).unwrap();
        conn.execute("DELETE FROM consumer_contracts", []).unwrap();
    }
    sync_if_needed(&temp.path).expect("emptied-table rebuild");
    assert_eq!(consumer_rows(&temp.path), 1);
    let conn = open_reader(&db).unwrap();
    let backend_rows: i64 = conn
        .query_row("SELECT count(*) FROM backend_endpoints", [], |r| r.get(0))
        .unwrap();
    assert!(backend_rows >= 2);
}

#[test]
fn missing_baseline_is_an_error() {
    let temp = Temp::new("missing");
    let error = sync_if_needed(&temp.path).expect_err("no artifacts");
    assert!(format!("{error:#}").contains("Sealed contract baseline missing"));
}

#[test]
fn test_sync_and_query_thingsboard() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    if !tb_path.exists() {
        return;
    }
    let db_path = sync_if_needed(&tb_path).expect("Sync should succeed");
    assert!(db_path.exists());

    let conn = open_reader(&db_path).expect("Read connection should open");
    let stats = get_catalog_stats(&conn, &db_path).expect("Stats should calculate");
    println!("Thingsboard Catalog Stats: {:?}", stats);
    assert!(stats.backend_endpoints_count > 0);
    assert!(stats.consumer_contracts_count > 0);

    let consumers = query_consumers_by_route(&conn, "/api/user/{id}", None).expect("Query route");
    println!("Found {} consumers for /api/user/{{id}}", consumers.len());
    for c in &consumers {
        println!(
            "  {} {} -> {}:{}",
            c.http_method, c.normalized_route, c.source_file, c.source_line
        );
    }

    let user_consumers = query_consumers_by_dto(&conn, "User").expect("Query DTO");
    println!(
        "Found {} consumers expecting User DTO",
        user_consumers.len()
    );
}
