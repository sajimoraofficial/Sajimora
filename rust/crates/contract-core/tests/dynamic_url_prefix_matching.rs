//! dynamic_url_prefix_matching.rs — verifies that dynamic URLs, multi-version prefixes (/api/v1, /rest, /gateway),
//! and suffix matching resolve cleanly, eliminating false INCONCLUSIVE verdicts on private enterprise codebases.

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
use contract_core::report::CrossLanguageVerdict;
use contract_core::service::{run_check_contract_envelope_service, CheckContractEnvelopeRequest};

const REPO: &str = "github.com/example/enterprise-shop";
const SERVICE: &str = "enterprise-service";

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
        strict: Some(false),
        properties: properties
            .into_iter()
            .map(|(name, r#type)| WirePropertyContract {
                wire_name: name.to_string(),
                r#type,
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                aliases: vec![],
                provenance: None,
            })
            .collect(),
        provenance: None,
    })
}

fn segment(text: &str, is_param: bool) -> RouteSegmentContract {
    RouteSegmentContract {
        text: text.to_string(),
        is_param,
        param_index: None,
        param_name: None,
        regex_constraint: None,
        is_wildcard: None,
    }
}

fn endpoint(method: &str, raw_path: &str, segments: Vec<RouteSegmentContract>, body: WireType) -> EndpointContract {
    EndpointContract {
        identity: EndpointIdentityContract {
            service: Some(SERVICE.to_string()),
            http_method: method.to_string(),
            normalized_route: NormalizedRouteContract {
                raw_path: raw_path.to_string(),
                segments,
            },
            direction: ContractDirection::Response,
        },
        path_parameters: vec![],
        query_parameters: vec![],
        headers: vec![],
        body: Some(body),
        provenance: provenance("src/main/java/com/example/EnterpriseController.java", 20),
        evidence_classification: None,
        declared_responses: None,
        status_code_family: None,
        mapping_conditions: None,
    }
}

fn client(method: &str, normalized_route: &str, expected_response: WireType) -> FrontendClientContract {
    FrontendClientContract {
        target_service_id: Some(SERVICE.to_string()),
        target_api_version: None,
        source_sha256: None,
        consumer_traversal_complete: Some(true),
        http_method: method.to_string(),
        normalized_route: normalized_route.to_string(),
        request_body: None,
        expected_response,
        decoder_kind: DecoderKind::InferredType,
        consumers: vec![ConsumerLocation {
            file: "web/src/client.service.ts".to_string(),
            line: 45,
            column: None,
            usage: "http call".to_string(),
        }],
        unresolved_evidence: vec![],
        observed_response: None,
        observed_request_body: None,
        source_file: "web/src/client.service.ts".to_string(),
        source_line: 45,
    }
}

fn envelope(
    kind: ArtifactKind,
    payload: ArtifactPayload,
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
            complete: true,
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

fn check_envelopes(
    base: ContractArtifactEnvelope,
    candidate: ContractArtifactEnvelope,
    target: ContractArtifactEnvelope,
) -> contract_core::report::CrossLanguageImpactReport {
    run_check_contract_envelope_service(CheckContractEnvelopeRequest {
        base: seal_envelope(base).unwrap(),
        candidate: seal_envelope(candidate).unwrap(),
        targets: vec![seal_envelope(target).unwrap()],
        base_targets: None,
        trust_policy_path: None,
        trusted_local: true,
        require_service_mapping: false,
        telemetry: None,
        evaluation_time_unix: None,
        deployment_liveness_verified: false,
        max_artifact_bytes: None,
    })
    .expect("comparison should run")
}

#[test]
fn test_dynamic_url_api_v1_prefix_stripping() {
    // Backend has /api/v1/customers, frontend called /customers via gateway
    let backend_ep = endpoint(
        "GET",
        "/api/v1/customers",
        vec![segment("api", false), segment("v1", false), segment("customers", false)],
        object(vec![("name", string_type())]),
    );
    let frontend_cl = client("GET", "/customers", object(vec![("name", string_type())]));

    let base = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep.clone()],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let cand = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let target = envelope(
        ArtifactKind::FrontendContract,
        ArtifactPayload::Frontend(FrontendContractPayload {
            client_contracts: vec![frontend_cl],
            type_pool: Default::default(),
            interceptor_evidence: None,
            dependency_context: None,
            path_pool: None,
        }),
        "frontend",
    );

    let rep = check_envelopes(base, cand, target);

    assert_eq!(rep.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert_eq!(rep.counts.linked_endpoints, 1);
    assert_eq!(rep.counts.unresolved_links, 0);
}


#[test]
fn test_dynamic_url_suffix_matching() {
    // Backend has /gateway/portal/catalog/items, frontend called /catalog/items
    let backend_ep = endpoint(
        "GET",
        "/gateway/portal/catalog/items",
        vec![
            segment("gateway", false),
            segment("portal", false),
            segment("catalog", false),
            segment("items", false),
        ],
        object(vec![("title", string_type())]),
    );
    let frontend_cl = client("GET", "/catalog/items", object(vec![("title", string_type())]));

    let base = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep.clone()],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let cand = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let target = envelope(
        ArtifactKind::FrontendContract,
        ArtifactPayload::Frontend(FrontendContractPayload {
            client_contracts: vec![frontend_cl],
            type_pool: Default::default(),
            interceptor_evidence: None,
            dependency_context: None,
            path_pool: None,
        }),
        "frontend",
    );

    let rep = check_envelopes(base, cand, target);

    assert_eq!(rep.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert_eq!(rep.counts.linked_endpoints, 1);
    assert_eq!(rep.counts.unresolved_links, 0);
}


#[test]
fn test_dynamic_url_arbitrary_prefix_xxxxx_and_yyyyy() {
    // Backend has arbitrary prefix /xxxxx/enterprise/orders/{id}
    // Frontend has arbitrary prefix /yyyyy/client/orders/{id}
    // Neither /xxxxx nor /yyyyy is in any hardcoded list!
    let backend_ep = endpoint(
        "GET",
        "/xxxxx/enterprise/orders/{id}",
        vec![
            segment("xxxxx", false),
            segment("enterprise", false),
            segment("orders", false),
            segment("{0}", true),
        ],
        object(vec![("orderId", string_type())]),
    );
    let frontend_cl = client(
        "GET",
        "/yyyyy/client/orders/:param",
        object(vec![("orderId", string_type())]),
    );

    let base = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep.clone()],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let cand = envelope(
        ArtifactKind::BackendContract,
        ArtifactPayload::Backend(BackendContractPayload {
            endpoints: vec![backend_ep],
            base_urls: vec![],
            proxy_prefixes: vec![],
            type_pool: Default::default(),
            serialization_assumptions: None,
            path_pool: None,
        }),
        SERVICE,
    );

    let target = envelope(
        ArtifactKind::FrontendContract,
        ArtifactPayload::Frontend(FrontendContractPayload {
            client_contracts: vec![frontend_cl],
            type_pool: Default::default(),
            interceptor_evidence: None,
            dependency_context: None,
            path_pool: None,
        }),
        "frontend",
    );

    let rep = check_envelopes(base, cand, target);

    assert_eq!(rep.verdict, CrossLanguageVerdict::LikelyPreserved);
    assert_eq!(rep.counts.linked_endpoints, 1);
    assert_eq!(rep.counts.unresolved_links, 0);
}
