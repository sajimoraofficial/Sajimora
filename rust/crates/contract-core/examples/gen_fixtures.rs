//! gen_fixtures -- Generate canonical integration test fixtures for the R3 test suite.
//! Run: cargo run --manifest-path rust/Cargo.toml --example gen_fixtures
//! Writes to rust/fixtures/{envelopes,trust}/

use contract_core::envelope::{
    seal_envelope, ArtifactBlocker, ArtifactCompleteness, ArtifactKind, ArtifactPayload,
    ArtifactSnapshotRef, BackendContractPayload, ContractArtifactEnvelope, DecoderKind,
    ExtractionProfile, FrontendClientContract, FrontendContractPayload,
};
use contract_core::ir::{
    ContractDirection, EndpointContract, EndpointIdentityContract, NormalizedRouteContract,
    ObjectWireType, PrimitiveScalar, PrimitiveWireType, RouteSegmentContract, SourceLanguage,
    SourceProvenance, WirePropertyContract, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use std::fs;
use std::path::Path;

const ENVELOPE_VERSION: &str = "SAJIMORA_CONTRACT_ARTIFACT_V1";

fn main() {
    let base_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixtures_dir = base_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures");
    let env_dir = fixtures_dir.join("envelopes");
    let trust_dir = fixtures_dir.join("trust");
    fs::create_dir_all(&env_dir).unwrap();
    fs::create_dir_all(&trust_dir).unwrap();

    let snapshot = ArtifactSnapshotRef {
        repository_id: "github.com/example/monorepo".to_string(),
        service_id: "user-service".to_string(),
        api_version: Some("v1".to_string()),
        parent_commit: "abc1234def5678901234567890123456789abcde".to_string(),
        candidate_snapshot: "sha:base000000001111".to_string(),
        deployment_id: None,
        environment: None,
    };
    let backend_profile = ExtractionProfile {
        tool_version: "0.1.0-test".to_string(),
        framework_profile: Some("SPRING_MVC".to_string()),
        codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
        client_profile: None,
        config_fingerprint: None,
    };
    let frontend_profile = ExtractionProfile {
        tool_version: "0.1.0-test".to_string(),
        framework_profile: None,
        codec_profile: None,
        client_profile: Some("MULTI_CLIENT_V1".to_string()),
        config_fingerprint: None,
    };
    let completeness_ok = ArtifactCompleteness {
        complete: true,
        blockers: vec![],
        unresolved_endpoints: vec![],
    };

    // ---- helper: a static route segment
    let seg = |s: &str| RouteSegmentContract {
        text: s.to_string(),
        is_param: false,
        param_index: None,
        param_name: None,
        regex_constraint: None,
        is_wildcard: None,
    };

    // ---- helper: a WireProperty (non-nullable, non-optional, no constraints)
    let prop = |name: &str, scalar: PrimitiveScalar| WirePropertyContract {
        wire_name: name.to_string(),
        aliases: vec![],
        r#type: WireType::Primitive(PrimitiveWireType {
            scalar,
            format: None,
            provenance: None,
        }),
        nullable: false,
        server_assigned: false,
        optional: false,
        validation_constraints: vec![],
        provenance: None,
    };

    // ---- helper: object body {id: number, <field_name>: string}
    let user_body = |field: &str| {
        WireType::Object(ObjectWireType {
            name: None,
            properties: vec![
                prop("id", PrimitiveScalar::Number),
                prop(field, PrimitiveScalar::String),
            ],
            strict: None,
            provenance: None,
        })
    };

    let user_ep = |field: &str, direction: ContractDirection| EndpointContract {
        identity: EndpointIdentityContract {
            service: Some("user-service".to_string()),
            http_method: "GET".to_string(),
            normalized_route: NormalizedRouteContract {
                raw_path: "/api/users".to_string(),
                segments: vec![seg("api"), seg("users")],
            },
            direction,
        },
        path_parameters: vec![],
        query_parameters: vec![],
        headers: vec![],
        body: Some(user_body(field)),
        provenance: SourceProvenance {
            sha256: Some(
                "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222".to_string(),
            ),
            language: SourceLanguage::Java,
            file: "src/main/java/com/example/UserController.java".to_string(),
            line: 42,
            column: None,
            ast_identity: None,
            annotation_or_schema: None,
            evidence_classification: None,
        },
        evidence_classification: None,
        declared_responses: None,
        status_code_family: None,
        mapping_conditions: None,
    };

    // ------------------------------------------------------------------
    // 1. backend_complete.json  (base: GET /api/users -> {id, name})
    // ------------------------------------------------------------------
    let be_base = seal_envelope(ContractArtifactEnvelope {
        envelope_version: ENVELOPE_VERSION.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: snapshot.clone(),
        profile: backend_profile.clone(),
        completeness: completeness_ok.clone(),
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            endpoints: vec![user_ep("name", ContractDirection::Response)],
            base_urls: vec!["http://user-service.internal".to_string()],
            proxy_prefixes: vec![],
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    })
    .unwrap();
    write_json(&env_dir.join("backend_complete.json"), &be_base);
    eprintln!(
        "backend_complete sha256={}",
        be_base.integrity.as_ref().unwrap().sha256
    );

    // ------------------------------------------------------------------
    // 2. backend_candidate.json  (candidate: field renamed name->displayName)
    // ------------------------------------------------------------------
    let mut cand_snap = snapshot.clone();
    cand_snap.candidate_snapshot = "sha:cand000000002222".to_string();
    let be_cand = seal_envelope(ContractArtifactEnvelope {
        envelope_version: ENVELOPE_VERSION.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: cand_snap.clone(),
        profile: backend_profile.clone(),
        completeness: completeness_ok.clone(),
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            endpoints: vec![user_ep("displayName", ContractDirection::Response)],
            base_urls: vec!["http://user-service.internal".to_string()],
            proxy_prefixes: vec![],
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    })
    .unwrap();
    write_json(&env_dir.join("backend_candidate.json"), &be_cand);

    // ------------------------------------------------------------------
    // 3. backend_same.json  (candidate identical to base -> LIKELY_PRESERVED)
    // ------------------------------------------------------------------
    let mut same_snap = snapshot.clone();
    same_snap.candidate_snapshot = "sha:same000000003333".to_string();
    let be_same = seal_envelope(ContractArtifactEnvelope {
        envelope_version: ENVELOPE_VERSION.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: same_snap.clone(),
        profile: backend_profile.clone(),
        completeness: completeness_ok.clone(),
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            endpoints: vec![user_ep("name", ContractDirection::Response)],
            base_urls: vec!["http://user-service.internal".to_string()],
            proxy_prefixes: vec![],
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    })
    .unwrap();
    write_json(&env_dir.join("backend_same.json"), &be_same);

    // ------------------------------------------------------------------
    // 4. frontend_complete.json  (TS consumer expecting {id, name})
    // ------------------------------------------------------------------
    let mut fe_snap = snapshot.clone();
    fe_snap.service_id = "frontend-app".to_string();
    fe_snap.candidate_snapshot = "sha:fe0000000004444".to_string();
    let fe = seal_envelope(ContractArtifactEnvelope {
        envelope_version: ENVELOPE_VERSION.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::FrontendContract,
        snapshot: fe_snap.clone(),
        profile: frontend_profile.clone(),
        completeness: completeness_ok.clone(),
        payload: ArtifactPayload::Frontend(FrontendContractPayload {
            dependency_context: None,
            interceptor_evidence: None,
            client_contracts: vec![FrontendClientContract {
                http_method: "GET".to_string(),
                normalized_route: "http://user-service.internal/api/users".to_string(),
                expected_response: user_body("name"),
                request_body: None,
                source_file: "src/api/userClient.ts".to_string(),
                source_line: 12,
                source_sha256: Some(
                    "bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333".to_string(),
                ),
                decoder_kind: DecoderKind::InferredType,
                target_service_id: Some("user-service".to_string()),
                target_api_version: Some("v1".to_string()),
                consumer_traversal_complete: Some(true),
                consumers: vec![],
                unresolved_evidence: vec![],
                observed_response: None,
                observed_request_body: None,
            }],
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    })
    .unwrap();
    write_json(&env_dir.join("frontend_complete.json"), &fe);

    // ------------------------------------------------------------------
    // 5. backend_incomplete.json  (extraction blockers present)
    // ------------------------------------------------------------------
    let mut inc_snap = snapshot.clone();
    inc_snap.candidate_snapshot = "sha:inc000000005555".to_string();
    let be_incomplete = seal_envelope(ContractArtifactEnvelope {
        envelope_version: ENVELOPE_VERSION.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: inc_snap.clone(),
        profile: backend_profile.clone(),
        completeness: ArtifactCompleteness {
            complete: false,
            blockers: vec![ArtifactBlocker {
                code: "AMBIGUOUS_ENDPOINT".to_string(),
                message: "Cannot resolve overloaded /api/users".to_string(),
                file: Some("UserController.java".to_string()),
            }],
            unresolved_endpoints: vec!["/api/users".to_string()],
        },
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            endpoints: vec![],
            base_urls: vec!["http://user-service.internal".to_string()],
            proxy_prefixes: vec![],
            type_pool: None,
            path_pool: None,
        }),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    })
    .unwrap();
    write_json(&env_dir.join("backend_incomplete.json"), &be_incomplete);

    // ------------------------------------------------------------------
    // 6. tampered.json  (sealed correctly, then snapshot mutated post-seal)
    // ------------------------------------------------------------------
    let mut tampered = be_base.clone();
    tampered.snapshot.candidate_snapshot = "sha:TAMPERED00000000".to_string();
    write_json(&env_dir.join("tampered.json"), &tampered);

    // ------------------------------------------------------------------
    // 7. malformed.json  (not valid JSON)
    // ------------------------------------------------------------------
    fs::write(
        env_dir.join("malformed.json"),
        b"{ this is NOT valid json !!! }",
    )
    .unwrap();

    // ------------------------------------------------------------------
    // 8. wrong_kind_target.json  (backend used as target instead of frontend)
    // ------------------------------------------------------------------
    write_json(&env_dir.join("wrong_kind_target.json"), &be_base);

    // ------------------------------------------------------------------
    // Trust policies
    // ------------------------------------------------------------------
    write_json_val(
        &trust_dir.join("trust_open.json"),
        &serde_json::json!({ "producers": [], "requireSignatures": false }),
    );

    let pin = be_base.integrity.as_ref().unwrap().sha256.clone();
    write_json_val(
        &trust_dir.join("trust_pinned.json"),
        &serde_json::json!({
            "producers": [{
                "repositoryId": "github.com/example/monorepo",
                "serviceId": "user-service",
                "allowedDigests": [pin],
                "publicKeys": []
            }],
            "requireSignatures": false
        }),
    );

    write_json_val(
        &trust_dir.join("trust_nomatch.json"),
        &serde_json::json!({
            "producers": [{
                "repositoryId": "github.com/other/different-repo",
                "serviceId": "other-service",
                "allowedDigests": [],
                "publicKeys": []
            }],
            "requireSignatures": false
        }),
    );

    eprintln!("All fixtures written to {}", fixtures_dir.display());
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) {
    let json = serde_json::to_string_pretty(value).expect("serialize");
    fs::write(path, json.as_bytes()).expect("write");
    eprintln!("  wrote {}", path.display());
}

fn write_json_val(path: &Path, value: &serde_json::Value) {
    let json = serde_json::to_string_pretty(value).expect("serialize");
    fs::write(path, json.as_bytes()).expect("write");
    eprintln!("  wrote {}", path.display());
}
