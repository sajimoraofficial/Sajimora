//! what_if_semantics_test.rs — fixture-backed what-if verdicts.
//!
//! These tests never touch a real checkout: they seal tiny backend/frontend
//! artifacts in a temp repository and assert the verdicts, so the semantics are
//! pinned independently of any benchmark corpus.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ConsumerLocation, ContractArtifactEnvelope, DecoderKind, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{RefWireType, WireType};
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
            "sajimora-what-if-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(path.join(".sajimora")).unwrap();
        write_artifacts(&path);
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
    private String firstName;
    private String lastName;

    public String getFirstName() { return firstName; }
    public void setFirstName(String firstName) { this.firstName = firstName; }
    public String getLastName() { return lastName; }
    public void setLastName(String lastName) { this.lastName = lastName; }
}
"#
            .to_string(),
        ),
    ]
}

fn backend_envelope() -> ContractArtifactEnvelope {
    let extractor = JavaRouteExtractor::from_blobs(
        PathBuf::from("what-if-fixture"),
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

fn frontend_envelope(route: &str) -> ContractArtifactEnvelope {
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
                normalized_route: route.to_string(),
                request_body: None,
                expected_response: WireType::Ref(RefWireType {
                    r#ref: "ts:src/api/users.ts#UserDto".to_string(),
                    provenance: None,
                }),
                decoder_kind: DecoderKind::InferredType,
                consumers: vec![ConsumerLocation {
                    file: "src/api/users.ts".to_string(),
                    line: 7,
                    column: None,
                    usage: "http.get('/api/users/1')".to_string(),
                }],
                unresolved_evidence: vec![],
                observed_response: None,
                observed_request_body: None,
                source_file: "src/api/users.ts".to_string(),
                source_line: 7,
            }],
            type_pool: None,
            path_pool: None,
        }),
        raw_value: None,
    };
    seal_envelope(envelope).expect("seal frontend fixture")
}

fn write_artifacts(repo: &Path) {
    let dir = repo.join(".sajimora");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("backend-contract.json"),
        serde_json::to_vec_pretty(&seal_envelope(backend_envelope()).unwrap()).unwrap(),
    )
    .unwrap();
    fs::write(
        dir.join("frontend-contract.json"),
        serde_json::to_vec_pretty(&frontend_envelope("/api/users/{id}")).unwrap(),
    )
    .unwrap();
}

fn what_if(repo: &Path, args: serde_json::Value) -> serde_json::Value {
    let allowed = vec![repo.to_path_buf()];
    let mut map = serde_json::Map::new();
    map.insert(
        "repoRoot".to_string(),
        serde_json::json!(repo.to_string_lossy()),
    );
    for (key, value) in args.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    let raw = sajimora_mcp::what_if::run_what_if(&allowed, &map).expect("what-if runs");
    serde_json::from_str(&raw).unwrap()
}

fn mutation(action: &str, dto: &str, field: &str) -> serde_json::Value {
    serde_json::json!({
        "mutation": {
            "action": action,
            "targetDto": dto,
            "field": field,
            "renameTo": "givenName",
        }
    })
}

#[test]
fn rename_without_annotation_is_breaking_with_exact_dto() {
    let temp = Temp::new("rename");
    let result = what_if(&temp.path, mutation("RENAME_FIELD", "UserDto", "firstName"));
    assert_eq!(result["verdict"], "BREAKING_CHANGE", "{result}");
    assert_eq!(result["breakingConsumersCount"], 1, "{result}");
    assert_eq!(
        result["matchedTypeRefs"],
        serde_json::json!(["java:com.demo.UserDto"])
    );
    assert_eq!(
        result["affectedFiles"],
        serde_json::json!(["src/api/users.ts"])
    );
    let fix = result["suggestedFix"].as_str().unwrap();
    assert!(fix.contains("@JsonProperty(\"firstName\")"), "{fix}");
    assert!(result["telemetry"]["tokensSavedEstimate"].as_u64().unwrap() > 0);
    assert!(result["telemetry"]["apiDollarsSavedUsd"].as_f64().unwrap() > 0.0);
    assert_eq!(result["telemetry"]["preventedFailedAgentLoop"], true);
}

#[test]
fn rename_with_retained_json_property_is_preserved() {
    let temp = Temp::new("retained");
    let mut args = mutation("RENAME_FIELD", "UserDto", "firstName");
    args["mutation"]["jsonPropertyRetained"] = serde_json::json!(true);
    let result = what_if(&temp.path, args);
    assert_eq!(result["verdict"], "NON_BREAKING_PRESERVED", "{result}");
    assert_eq!(result["safeConsumersCount"], 1);
}

#[test]
fn unknown_dto_and_field_are_inconclusive_not_breaking() {
    let temp = Temp::new("unknown");
    let unknown_dto = what_if(&temp.path, mutation("RENAME_FIELD", "Missing", "firstName"));
    assert_eq!(unknown_dto["verdict"], "NO_MATCH", "{unknown_dto}");

    let unknown_field = what_if(&temp.path, mutation("RENAME_FIELD", "UserDto", "nickname"));
    assert_eq!(
        unknown_field["verdict"], "FIELD_NOT_FOUND",
        "{unknown_field}"
    );
}

#[test]
fn delete_endpoint_uses_route_and_method() {
    let temp = Temp::new("delete");
    let breaking = what_if(
        &temp.path,
        serde_json::json!({
            "mutation": {
                "action": "DELETE_ENDPOINT",
                "route": "/api/users/{id}",
                "method": "GET",
            }
        }),
    );
    assert_eq!(breaking["verdict"], "BREAKING_CHANGE", "{breaking}");
    assert_eq!(breaking["breakingConsumersCount"], 1);

    let safe = what_if(
        &temp.path,
        serde_json::json!({
            "mutation": {
                "action": "DELETE_ENDPOINT",
                "route": "/api/users/{id}",
                "method": "POST",
            }
        }),
    );
    assert_eq!(safe["verdict"], "SAFE_NO_OBSERVED_CONSUMERS", "{safe}");
}

#[test]
fn delete_endpoint_requires_a_route() {
    let temp = Temp::new("delete-missing-route");
    let allowed = vec![temp.path.clone()];
    let mut map = serde_json::Map::new();
    map.insert(
        "repoRoot".to_string(),
        serde_json::json!(temp.path.to_string_lossy()),
    );
    map.insert(
        "mutation".to_string(),
        serde_json::json!({ "action": "DELETE_ENDPOINT" }),
    );
    let error = sajimora_mcp::what_if::run_what_if(&allowed, &map).expect_err("route required");
    assert!(format!("{error:#}").contains("mutation.route"));
}

#[test]
fn candidate_code_is_parsed_by_the_real_extractor() {
    let temp = Temp::new("candidate");
    let result = what_if(
        &temp.path,
        serde_json::json!({
            "targetFile": "src/main/java/com/demo/UserController.java",
            "candidateCode": r#"package com.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping(path = "/api/users/{id}")
    public String get(@PathVariable String id) {
        return id;
    }
}
"#
        }),
    );
    assert_eq!(result["verdict"], "CONSUMERS_OBSERVED", "{result}");
    assert_eq!(result["breakingConsumersCount"], 1, "{result}");
    assert_eq!(
        result["detectedRoutes"],
        serde_json::json!([{ "method": "GET", "route": "/api/users/{id}" }])
    );
}

#[test]
fn unparseable_or_route_free_candidate_code_is_inconclusive() {
    let temp = Temp::new("candidate-bad");
    let garbage = what_if(
        &temp.path,
        serde_json::json!({ "targetFile": "Candidate.java", "candidateCode": "not java at all (" }),
    );
    assert_eq!(garbage["verdict"], "INCONCLUSIVE", "{garbage}");

    let route_free = what_if(
        &temp.path,
        serde_json::json!({
            "targetFile": "src/main/java/com/demo/Service.java",
            "candidateCode": "package com.demo;\npublic class Service { public String name() { return \"x\"; } }\n"
        }),
    );
    assert_eq!(route_free["verdict"], "INCONCLUSIVE", "{route_free}");
}

#[test]
fn unknown_action_is_rejected() {
    let temp = Temp::new("bad-action");
    let allowed = vec![temp.path.clone()];
    let mut map = serde_json::Map::new();
    map.insert(
        "repoRoot".to_string(),
        serde_json::json!(temp.path.to_string_lossy()),
    );
    map.insert(
        "mutation".to_string(),
        serde_json::json!({ "action": "DROP_TABLE", "targetDto": "UserDto", "field": "firstName" }),
    );
    let error = sajimora_mcp::what_if::run_what_if(&allowed, &map).expect_err("unknown action");
    assert!(format!("{error:#}").contains("Unknown mutation action"));
}
