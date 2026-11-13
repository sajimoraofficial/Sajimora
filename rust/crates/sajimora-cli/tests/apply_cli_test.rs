//! apply_cli_test.rs — Test `sajimora apply` and `sajimora patch` CLI subcommands.

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
use std::process::Command;
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
            "sajimora-apply-cli-{tag}-{}-{nanos}",
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

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

#[test]
fn test_cli_apply_rename_live() {
    let temp = Temp::new("cli-rename");
    let output = Command::new(cli_bin())
        .arg("apply")
        .arg("--repo")
        .arg(&temp.path)
        .arg("--type")
        .arg("UserDto")
        .arg("--field")
        .arg("firstName")
        .arg("--rename-to")
        .arg("givenName")
        .arg("--json")
        .output()
        .expect("sajimora apply should execute");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "apply failed: stdout={stdout}, stderr={stderr}");

    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid json output");
    assert_eq!(parsed["counts"]["applied"], 2);

    let ts = fs::read_to_string(temp.path.join(TS_REL)).unwrap();
    assert!(ts.contains("givenName: string;"), "{ts}");
    assert!(!ts.contains("firstName"), "{ts}");

    let html = fs::read_to_string(temp.path.join(HTML_REL)).unwrap();
    assert!(html.contains("user.givenName"), "{html}");
}

#[test]
fn test_cli_patch_alias_dry_run() {
    let temp = Temp::new("cli-patch");
    let output = Command::new(cli_bin())
        .arg("patch") // Alias for apply
        .arg("--repo")
        .arg(&temp.path)
        .arg("--type")
        .arg("UserDto")
        .arg("--field")
        .arg("firstName")
        .arg("--rename-to")
        .arg("givenName")
        .arg("--dry-run")
        .arg("--json")
        .output()
        .expect("sajimora patch should execute");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "stdout={stdout}");

    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["dryRun"], true);
    assert_eq!(parsed["counts"]["applied"], 2);

    // Dry run must write nothing
    let ts = fs::read_to_string(temp.path.join(TS_REL)).unwrap();
    assert_eq!(ts, TS_SRC);
}

