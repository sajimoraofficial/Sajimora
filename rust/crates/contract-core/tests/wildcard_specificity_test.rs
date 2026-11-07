//! A consumer must link to the concrete handler, not a catch-all that also matches.
//! And a consumer whose leading prefix is unresolved must not link to a catch-all at all.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    BackendContractPayload, ConsumerLocation, ContractArtifactEnvelope, DecoderKind,
    ExtractionProfile, FrontendClientContract, FrontendContractPayload,
};
use contract_core::ir::{
    ContractDirection, EndpointContract, EndpointIdentityContract, NormalizedRouteContract,
    ObjectWireType, PrimitiveScalar, PrimitiveWireType, RouteSegmentContract, SourceLanguage,
    SourceProvenance, WirePropertyContract, WireType,
};
use contract_core::service::{run_check_contract_envelope_service, CheckContractEnvelopeRequest};

const REPO: &str = "github.com/example/shop";
const SERVICE: &str = "image-service";

fn provenance(file: &str, line: u32) -> SourceProvenance {
    SourceProvenance {
        sha256: None,
        language: SourceLanguage::Java,
        file: file.to_string(),
        line,
        column: None,
        ast_identity: None,
        annotation_or_schema: None,
        evidence_classification: None,
    }
}

fn string_type() -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::String,
        format: None,
        provenance: None,
    })
}

fn object(properties: Vec<(&str, WireType)>) -> WireType {
    WireType::Object(ObjectWireType {
        name: None,
        properties: properties
            .into_iter()
            .map(|(name, r#type)| WirePropertyContract {
                wire_name: name.to_string(),
                r#type,
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
                aliases: vec![],
            })
            .collect(),
        strict: None,
        provenance: None,
    })
}

fn segment(
    text: &str,
    is_param: bool,
    is_wildcard: Option<bool>,
    regex_constraint: Option<&str>,
) -> RouteSegmentContract {
    RouteSegmentContract {
        text: text.to_string(),
        is_param,
        param_index: is_param.then_some(0),
        param_name: is_param.then(|| "param".to_string()),
        regex_constraint: regex_constraint.map(|value| value.to_string()),
        is_wildcard,
    }
}

fn route(raw: &str, segments: Vec<RouteSegmentContract>) -> NormalizedRouteContract {
    NormalizedRouteContract {
        raw_path: raw.to_string(),
        segments,
    }
}

fn endpoint(method: &str, route: NormalizedRouteContract, body: WireType) -> EndpointContract {
    EndpointContract {
        identity: EndpointIdentityContract {
            service: Some(SERVICE.to_string()),
            http_method: method.to_string(),
            normalized_route: route,
            direction: ContractDirection::Response,
        },
        path_parameters: vec![],
        query_parameters: vec![],
        headers: vec![],
        body: Some(body),
        provenance: provenance("src/main/java/com/example/ImageController.java", 83),
        evidence_classification: None,
        declared_responses: None,
        status_code_family: None,
        mapping_conditions: None,
    }
}

fn client(route: &str, line: u32) -> FrontendClientContract {
    FrontendClientContract {
        target_service_id: Some(SERVICE.to_string()),
        target_api_version: None,
        source_sha256: None,
        consumer_traversal_complete: Some(true),
        http_method: "PUT".to_string(),
        normalized_route: route.to_string(),
        request_body: None,
        expected_response: object(vec![("resourceKey", string_type())]),
        decoder_kind: DecoderKind::InferredType,
        consumers: vec![ConsumerLocation {
            file: "web/src/image.service.ts".to_string(),
            line,
            column: None,
            usage: "image update".to_string(),
        }],
        unresolved_evidence: vec![],
        observed_response: None,
        observed_request_body: None,
        source_file: "web/src/image.service.ts".to_string(),
        source_line: line,
    }
}

fn envelope(
    kind: ArtifactKind,
    payload: ArtifactPayload,
    complete: bool,
    service: &str,
) -> ContractArtifactEnvelope {
    let is_backend = kind == ArtifactKind::BackendContract;
    let is_frontend = kind == ArtifactKind::FrontendContract;
    ContractArtifactEnvelope {
        envelope_version: "SAJIMORA_CONTRACT_ARTIFACT_V1".to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind,
        profile: ExtractionProfile {
            tool_version: "0.1.0-test".to_string(),
            framework_profile: is_backend.then(|| "SPRING_MVC".to_string()),
            codec_profile: is_backend.then(|| "JACKSON_DEFAULT_V1".to_string()),
            client_profile: is_frontend.then(|| "STATIC_FETCH_V1".to_string()),
            config_fingerprint: None,
        },
        snapshot: ArtifactSnapshotRef {
            repository_id: REPO.to_string(),
            service_id: service.to_string(),
            api_version: None,
            parent_commit: "1111111111111111111111111111111111111111".to_string(),
            candidate_snapshot: "sha:test".to_string(),
            deployment_id: None,
            environment: None,
        },
        completeness: ArtifactCompleteness {
            complete,
            unresolved_endpoints: vec![],
            blockers: vec![],
        },
        integrity: None,
        signature: None,
        issued_at_unix: None,
        payload,
        raw_value: None,
    }
}

fn run(
    base: ArtifactKind,
    candidate: ArtifactKind,
    target: ArtifactKind,
) -> contract_core::report::CrossLanguageImpactReport {
    let concrete = endpoint(
        "PUT",
        route(
            "/api/images/{type}/{key}/info",
            vec![
                segment("api", false, None, None),
                segment("images", false, None, None),
                segment("{0}", true, None, None),
                segment("{1}", true, None, None),
                segment("info", false, None, None),
            ],
        ),
        object(vec![("resourceKey", string_type())]),
    );
    let constrained_catch_all = endpoint(
        "PUT",
        route(
            "/{path:^(?!api$)[^.]*}/**",
            vec![
                segment("{0}", true, None, Some("^(?!api$)[^.]*")),
                segment("**", false, Some(true), None),
            ],
        ),
        string_type(),
    );
    let root_catch_all = endpoint(
        "PUT",
        route("/**", vec![segment("**", false, Some(true), None)]),
        string_type(),
    );
    let backend = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            base_urls: vec![],
            proxy_prefixes: vec![],
            endpoints: vec![concrete, constrained_catch_all, root_catch_all],
            type_pool: None,
            path_pool: None,
        }),
        true,
        SERVICE,
    );
    let frontend = |route: &str, line: u32| {
        envelope(
            ArtifactKind::FrontendContract,
            ArtifactPayload::Frontend(FrontendContractPayload {
                dependency_context: None,
                interceptor_evidence: None,
                client_contracts: vec![client(route, line)],
                type_pool: None,
                path_pool: None,
            }),
            true,
            "web",
        )
    };

    let (base_env, candidate_env, target_env) = match (base, candidate, target) {
        (
            ArtifactKind::BackendContract,
            ArtifactKind::BackendContract,
            ArtifactKind::FrontendContract,
        ) => (
            backend.clone(),
            backend.clone(),
            frontend("/:param/:param/info", 66),
        ),
        (
            ArtifactKind::FrontendContract,
            ArtifactKind::FrontendContract,
            ArtifactKind::BackendContract,
        ) => {
            let fe = frontend("/api/images/:param/:param/info", 66);
            (fe.clone(), fe, backend.clone())
        }
        _ => panic!("unsupported test direction"),
    };

    let report = run_check_contract_envelope_service(CheckContractEnvelopeRequest {
        base: seal_envelope(base_env).unwrap(),
        candidate: seal_envelope(candidate_env).unwrap(),
        targets: vec![seal_envelope(target_env).unwrap()],
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    })
    .expect("comparison should run");
    report
}

#[test]
fn unresolved_prefix_client_never_links_a_catch_all() {
    let report = run(
        ArtifactKind::BackendContract,
        ArtifactKind::BackendContract,
        ArtifactKind::FrontendContract,
    );
    assert_eq!(
        report.counts.linked_endpoints, 0,
        "an unresolved leading prefix must not link any catch-all handler"
    );
    assert!(
        report.findings.is_empty(),
        "no finding may be produced from a catch-all link: {:?}",
        report
            .findings
            .iter()
            .map(|f| (
                f.endpoint.method.clone(),
                f.endpoint.path.clone(),
                f.wire_path.clone()
            ))
            .collect::<Vec<_>>()
    );
}

#[test]
fn resolved_client_links_the_concrete_handler_not_the_catch_all() {
    let report = run(
        ArtifactKind::FrontendContract,
        ArtifactKind::FrontendContract,
        ArtifactKind::BackendContract,
    );
    assert_eq!(report.counts.linked_endpoints, 1);
    assert!(
        report.findings.is_empty(),
        "the catch-all must not be compared once the concrete handler matched: {:?}",
        report
            .findings
            .iter()
            .map(|f| (
                f.endpoint.method.clone(),
                f.endpoint.path.clone(),
                f.wire_path.clone()
            ))
            .collect::<Vec<_>>()
    );
}
