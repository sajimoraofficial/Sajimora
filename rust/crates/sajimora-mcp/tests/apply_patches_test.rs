//! apply_patches_test.rs — end-to-end proof of the deterministic apply path.
//!
//! Seals tiny backend/frontend artifacts (with a TypeScript client type pool),
//! writes real consumer files on disk, then asserts `sajimora_apply_patches`
//! edits them atomically, idempotently, and honors dry-run / allowed-roots.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ConsumerLocation, ContractArtifactEnvelope, DecoderKind, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ObjectWireType, PrimitiveScalar, PrimitiveWireType, RefWireType, WirePropertyContract, WireType,
};
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TS_REL: &str = "src/api/users.ts";
const HTML_REL: &str = "src/app/user.component.html";
const TS_SRC: &str = "export interface UserDto {\n  firstName: string;\n  lastName: string;\n}\n";
const HTML_SRC: &str = "<p>{{ user.firstName }}</p>\n<p>{{ user.lastName }}</p>\n";

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
            "sajimora-apply-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(path.join(".sajimora")).unwrap();
        write_artifacts(&path);
        fs::create_dir_all(path.join("src/api")).unwrap();
        fs::create_dir_all(path.join("src/app")).unwrap();
        fs::write(path.join(TS_REL), TS_SRC).unwrap();
        fs::write(path.join(HTML_REL), HTML_SRC).unwrap();
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
    public UserDto get(@PathVariable String id) { return null; }
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
    public void setFirstName(String v) { this.firstName = v; }
    public String getLastName() { return lastName; }
    public void setLastName(String v) { this.lastName = v; }
}
"#
            .to_string(),
        ),
    ]
}

fn backend_envelope() -> ContractArtifactEnvelope {
    let extractor = JavaRouteExtractor::from_blobs(
        PathBuf::from("apply-fixture"),
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

fn string_prop(name: &str) -> WirePropertyContract {
    WirePropertyContract {
        wire_name: name.to_string(),
        r#type: WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: None,
            provenance: None,
        }),
        optional: false,
        nullable: false,
        server_assigned: false,
        validation_constraints: vec![],
        provenance: None,
        aliases: vec![],
    }
}

fn frontend_envelope() -> ContractArtifactEnvelope {
    let mut type_pool = BTreeMap::new();
    type_pool.insert(
        format!("ts:{TS_REL}#UserDto"),
        WireType::Object(ObjectWireType {
            name: Some("UserDto".to_string()),
            properties: vec![string_prop("firstName"), string_prop("lastName")],
            strict: None,
            provenance: None,
        }),
    );
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
                    r#ref: format!("ts:{TS_REL}#UserDto"),
                    provenance: None,
                }),
                decoder_kind: DecoderKind::InferredType,
                consumers: vec![ConsumerLocation {
                    file: TS_REL.to_string(),
                    line: 7,
                    column: None,
                    usage: "http.get('/api/users/1')".to_string(),
                }],
                unresolved_evidence: vec![],
                observed_response: None,
                observed_request_body: None,
                source_file: TS_REL.to_string(),
                source_line: 7,
            }],
            type_pool: Some(type_pool),
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
        serde_json::to_vec_pretty(&frontend_envelope()).unwrap(),
    )
    .unwrap();
}

fn apply(repo: &Path, mutation: serde_json::Value, dry_run: bool) -> serde_json::Value {
    let allowed = vec![repo.to_path_buf()];
    let mut map = serde_json::Map::new();
    map.insert("repoRoot".to_string(), serde_json::json!(repo.to_string_lossy()));
    map.insert("mutation".to_string(), mutation);
    map.insert("dryRun".to_string(), serde_json::json!(dry_run));
    let raw = sajimora_mcp::apply::run_apply_patches(&allowed, &map).expect("apply runs");
    serde_json::from_str(&raw).unwrap()
}

fn rename_mutation() -> serde_json::Value {
    serde_json::json!({
        "action": "RENAME_FIELD", "targetDto": "UserDto",
        "field": "firstName", "renameTo": "givenName"
    })
}

#[test]
fn rename_applies_ts_model_and_template() {
    let temp = Temp::new("rename");
    let res = apply(&temp.path, rename_mutation(), false);
    assert_eq!(res["counts"]["applied"], 2, "{res}");
    assert_eq!(res["counts"]["abstained"], 0, "{res}");

    let ts = fs::read_to_string(temp.path.join(TS_REL)).unwrap();
    assert!(ts.contains("givenName: string;"), "{ts}");
    assert!(ts.contains("lastName: string;"), "{ts}");
    assert!(!ts.contains("firstName"), "{ts}");

    let html = fs::read_to_string(temp.path.join(HTML_REL)).unwrap();
    assert!(html.contains("user.givenName"), "{html}");
    assert!(html.contains("user.lastName"), "{html}");
}

#[test]
fn rename_dry_run_writes_nothing() {
    let temp = Temp::new("dry");
    let res = apply(&temp.path, rename_mutation(), true);
    assert_eq!(res["dryRun"], true);
    assert_eq!(res["counts"]["applied"], 2, "{res}");
    assert_eq!(res["applied"][0]["written"], false, "{res}");
    assert_eq!(fs::read_to_string(temp.path.join(TS_REL)).unwrap(), TS_SRC);
    assert_eq!(fs::read_to_string(temp.path.join(HTML_REL)).unwrap(), HTML_SRC);
}

#[test]
fn rename_is_idempotent() {
    let temp = Temp::new("idem");
    let first = apply(&temp.path, rename_mutation(), false);
    assert_eq!(first["counts"]["applied"], 2, "{first}");
    let second = apply(&temp.path, rename_mutation(), false);
    // Re-running applies nothing. The TS model patch is re-planned from the sealed
    // baseline but reports ALREADY_APPLIED; the template is no longer re-planned
    // because the live file no longer references the old field.
    assert_eq!(second["counts"]["applied"], 0, "{second}");
    assert_eq!(second["counts"]["abstained"], 0, "{second}");
    assert!(second["counts"]["noOp"].as_u64().unwrap() >= 1, "{second}");
}

#[test]
fn remove_applies_ts_and_abstains_template() {
    let temp = Temp::new("remove");
    let res = apply(
        &temp.path,
        serde_json::json!({ "action": "REMOVE_FIELD", "targetDto": "UserDto", "field": "firstName" }),
        false,
    );
    assert_eq!(res["counts"]["applied"], 1, "{res}");
    assert!(res["counts"]["abstained"].as_u64().unwrap() >= 1, "{res}");
    let ts = fs::read_to_string(temp.path.join(TS_REL)).unwrap();
    assert!(!ts.contains("firstName"), "{ts}");
    assert!(ts.contains("lastName: string;"), "{ts}");
    // Template binding for a removed field is manual-review, never auto-edited.
    assert_eq!(fs::read_to_string(temp.path.join(HTML_REL)).unwrap(), HTML_SRC);
}

#[test]
fn empty_allowed_roots_is_rejected() {
    let temp = Temp::new("roots");
    let mut map = serde_json::Map::new();
    map.insert("repoRoot".to_string(), serde_json::json!(temp.path.to_string_lossy()));
    map.insert("mutation".to_string(), rename_mutation());
    let err = sajimora_mcp::apply::run_apply_patches(&[], &map).expect_err("needs allowed root");
    assert!(format!("{err:#}").contains("allowed root"));
}

#[test]
fn rename_preserves_variable_prefix_with_subtoken_field_name() {
    let temp = Temp::new("prefix");
    // Write a template where the variable name contains the field name as prefix
    let custom_html = "<p>{{ firstNameUser.firstName }}</p>\n";
    fs::write(temp.path.join(HTML_REL), custom_html).unwrap();

    let res = apply(&temp.path, rename_mutation(), false);
    assert_eq!(res["counts"]["applied"], 2, "{res}");
    let html = fs::read_to_string(temp.path.join(HTML_REL)).unwrap();
    // firstNameUser must NOT become givenNameUser!
    assert!(html.contains("firstNameUser.givenName"), "{html}");
    assert!(!html.contains("givenNameUser"), "{html}");
}