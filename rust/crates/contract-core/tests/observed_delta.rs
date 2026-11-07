//! Delta-gated verification of observed (untyped JavaScript) response evidence.
//!
//! An observed read is usage evidence, not a declared shape. It may only become a
//! finding when the producer regressed between base and candidate; a single snapshot
//! that lacks the field proves nothing about what the client ever depended on.

use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    BackendContractPayload, ConsumerLocation, ContractArtifactEnvelope, ExtractionProfile,
    FrontendClientContract, FrontendContractPayload,
};
use contract_core::ir::{
    ArrayWireType, ContractDirection, EndpointContract, EndpointIdentityContract,
    NormalizedRouteContract, ObjectWireType, ObservedAccess, ObservedResponseEvidence,
    ObservedResponseStatus, PrimitiveScalar, PrimitiveWireType, RefWireType, RouteSegmentContract,
    SourceLanguage, SourceProvenance, UnknownWireType, WirePropertyContract, WireType,
};
use contract_core::report::{CrossLanguageVerdict, FindingDelta};
use contract_core::service::{run_check_contract_envelope_service, CheckContractEnvelopeRequest};
use std::collections::BTreeMap;

const REPO: &str = "github.com/example/shop";
const SERVICE: &str = "order-service";

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

fn number_type() -> WireType {
    WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::Number,
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

fn array(element_type: WireType) -> WireType {
    WireType::Array(ArrayWireType {
        element_type: Box::new(element_type),
        is_stream_or_flux: None,
        provenance: None,
    })
}

fn unknown_response() -> WireType {
    WireType::Unknown(UnknownWireType {
        reason: "untyped client response".to_string(),
        provenance: None,
    })
}

fn route_segments(path: &str) -> NormalizedRouteContract {
    NormalizedRouteContract {
        raw_path: path.to_string(),
        segments: path
            .trim_start_matches('/')
            .split('/')
            .map(|text| RouteSegmentContract {
                text: text.to_string(),
                is_param: false,
                param_index: None,
                param_name: None,
                regex_constraint: None,
                is_wildcard: None,
            })
            .collect(),
    }
}

fn orders_endpoint(body: Option<WireType>) -> EndpointContract {
    EndpointContract {
        identity: EndpointIdentityContract {
            service: Some(SERVICE.to_string()),
            http_method: "GET".to_string(),
            normalized_route: route_segments("/api/orders"),
            direction: ContractDirection::Response,
        },
        path_parameters: vec![],
        query_parameters: vec![],
        headers: vec![],
        body,
        provenance: provenance("src/main/java/com/example/OrderController.java", 42),
        evidence_classification: None,
        declared_responses: None,
        status_code_family: None,
        mapping_conditions: None,
    }
}

fn backend_snapshot(
    snapshot: &str,
    body: Option<WireType>,
    pool: Option<BTreeMap<String, WireType>>,
) -> ContractArtifactEnvelope {
    ContractArtifactEnvelope {
        envelope_version: "SAJIMORA_CONTRACT_ARTIFACT_V1".to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::BackendContract,
        profile: ExtractionProfile {
            tool_version: "0.1.0-test".to_string(),
            framework_profile: Some("SPRING_MVC".to_string()),
            codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
            client_profile: None,
            config_fingerprint: None,
        },
        snapshot: ArtifactSnapshotRef {
            repository_id: REPO.to_string(),
            service_id: SERVICE.to_string(),
            api_version: None,
            parent_commit: "1111111111111111111111111111111111111111".to_string(),
            candidate_snapshot: snapshot.to_string(),
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
        payload: ArtifactPayload::Backend(BackendContractPayload {
            serialization_assumptions: None,
            base_urls: vec![],
            proxy_prefixes: vec![],
            endpoints: vec![orders_endpoint(body)],
            type_pool: pool,
            path_pool: None,
        }),
        raw_value: None,
    }
}

fn observed_access(path: &str, guaranteed: bool) -> ObservedAccess {
    ObservedAccess {
        path: path.to_string(),
        kind: None,
        guaranteed,
        alternative_group: None,
        provenance: SourceProvenance {
            sha256: None,
            language: SourceLanguage::TypeScript,
            file: "web/src/orders.js".to_string(),
            line: 12,
            column: None,
            ast_identity: None,
            annotation_or_schema: None,
            evidence_classification: None,
        },
    }
}

fn frontend_snapshot(
    snapshot: &str,
    observed: Option<ObservedResponseEvidence>,
) -> ContractArtifactEnvelope {
    ContractArtifactEnvelope {
        envelope_version: "SAJIMORA_CONTRACT_ARTIFACT_V1".to_string(),
        report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
        kind: ArtifactKind::FrontendContract,
        profile: ExtractionProfile {
            tool_version: "0.1.0-test".to_string(),
            framework_profile: None,
            codec_profile: None,
            client_profile: Some("STATIC_FETCH_V1".to_string()),
            config_fingerprint: None,
        },
        snapshot: ArtifactSnapshotRef {
            repository_id: REPO.to_string(),
            service_id: "web".to_string(),
            api_version: None,
            parent_commit: "1111111111111111111111111111111111111111".to_string(),
            candidate_snapshot: snapshot.to_string(),
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
        payload: ArtifactPayload::Frontend(FrontendContractPayload {
            dependency_context: None,
            interceptor_evidence: None,
            client_contracts: vec![FrontendClientContract {
                target_service_id: None,
                target_api_version: None,
                source_sha256: None,
                consumer_traversal_complete: Some(false),
                http_method: "GET".to_string(),
                normalized_route: "/api/orders".to_string(),
                request_body: None,
                expected_response: unknown_response(),
                decoder_kind: contract_core::envelope::DecoderKind::Unknown,
                consumers: vec![ConsumerLocation {
                    file: "web/src/OrdersPage.jsx".to_string(),
                    line: 21,
                    column: None,
                    usage: "response consumer".to_string(),
                }],
                unresolved_evidence: vec![
                    "Response return from untyped client call requires type annotation or reconciliation"
                        .to_string(),
                ],
                observed_response: observed,
                observed_request_body: None,
                source_file: "web/src/orders.js".to_string(),
                source_line: 12,
            }],
            type_pool: None,
            path_pool: None,
        }),
        raw_value: None,
    }
}

fn checked(
    base_body: Option<WireType>,
    cand_body: Option<WireType>,
    observed: Option<ObservedResponseEvidence>,
) -> contract_core::report::CrossLanguageImpactReport {
    checked_with_pools(base_body, cand_body, None, None, observed)
}

fn checked_with_pools(
    base_body: Option<WireType>,
    cand_body: Option<WireType>,
    base_pool: Option<BTreeMap<String, WireType>>,
    cand_pool: Option<BTreeMap<String, WireType>>,
    observed: Option<ObservedResponseEvidence>,
) -> contract_core::report::CrossLanguageImpactReport {
    let base = seal_envelope(backend_snapshot("sha:base", base_body, base_pool)).unwrap();
    let candidate = seal_envelope(backend_snapshot("sha:candidate", cand_body, cand_pool)).unwrap();
    let target = seal_envelope(frontend_snapshot("sha:web", observed)).unwrap();
    run_check_contract_envelope_service(CheckContractEnvelopeRequest {
        base,
        candidate,
        targets: vec![target],
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

fn observed(accesses: Vec<ObservedAccess>) -> ObservedResponseEvidence {
    ObservedResponseEvidence {
        status: ObservedResponseStatus::Observed,
        accesses,
        reason: None,
    }
}

fn delta_of(report: &contract_core::report::CrossLanguageImpactReport) -> &FindingDelta {
    report.delta.as_ref().expect("service computes a delta")
}

fn finding_paths(report: &contract_core::report::CrossLanguageImpactReport) -> Vec<&str> {
    report
        .findings
        .iter()
        .map(|f| f.wire_path.as_str())
        .collect()
}

#[test]
fn observed_read_of_removed_field_is_a_new_finding() {
    let base = object(vec![
        ("totalSales", number_type()),
        (
            "content",
            array(object(vec![
                ("orderId", string_type()),
                ("status", string_type()),
            ])),
        ),
    ]);
    let candidate = object(vec![(
        "content",
        array(object(vec![("orderId", string_type())])),
    )]);
    let report = checked(
        Some(base),
        Some(candidate),
        Some(observed(vec![
            observed_access("totalSales", true),
            observed_access("content[].status", true),
        ])),
    );

    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
    let paths = finding_paths(&report);
    assert!(paths.contains(&"totalSales"), "paths: {paths:?}");
    assert!(paths.contains(&"content[].status"), "paths: {paths:?}");
    let new_paths: Vec<&str> = delta_of(&report)
        .new_findings
        .iter()
        .map(|f| f.wire_path.as_str())
        .collect();
    assert!(
        new_paths.contains(&"content[].status"),
        "delta: {new_paths:?}"
    );
}

#[test]
fn observed_read_missing_from_both_snapshots_is_not_a_finding() {
    // The client reads `coupon`, but the base producer never emitted it.
    // A missing field in one snapshot is not a regression.
    let base = object(vec![(
        "content",
        array(object(vec![("orderId", string_type())])),
    )]);
    let candidate = object(vec![(
        "content",
        array(object(vec![("orderId", string_type())])),
    )]);
    let report = checked(
        Some(base),
        Some(candidate),
        Some(observed(vec![observed_access("content[].coupon", true)])),
    );

    assert!(
        report.findings.is_empty(),
        "findings: {:?}",
        report.findings
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
}

#[test]
fn unchanged_producer_produces_no_findings_for_observed_reads() {
    let body = || {
        object(vec![(
            "content",
            array(object(vec![("orderId", string_type())])),
        )])
    };
    let report = checked(
        Some(body()),
        Some(body()),
        Some(observed(vec![observed_access("content[].orderId", true)])),
    );

    assert!(
        report.findings.is_empty(),
        "findings: {:?}",
        report.findings
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
}

#[test]
fn guarded_read_of_removed_field_is_not_a_finding() {
    let base = object(vec![("status", string_type())]);
    let candidate = object(vec![("statusText", string_type())]);
    let report = checked(
        Some(base),
        Some(candidate),
        Some(observed(vec![observed_access("status", false)])),
    );

    assert!(
        report.findings.is_empty(),
        "findings: {:?}",
        report.findings
    );
}

#[test]
fn not_consumed_client_tolerates_a_bodyless_candidate() {
    let base = object(vec![("orderId", string_type())]);
    let report = checked(
        Some(base),
        None,
        Some(ObservedResponseEvidence {
            status: ObservedResponseStatus::NotConsumed,
            accesses: vec![],
            reason: Some("call site discards the response".to_string()),
        }),
    );

    assert!(
        report.findings.is_empty(),
        "findings: {:?}",
        report.findings
    );
    assert_ne!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}

#[test]
fn inconclusive_observation_of_a_bodyless_candidate_is_unresolved_not_a_finding() {
    let base = object(vec![("orderId", string_type())]);
    let report = checked(
        Some(base),
        None,
        Some(ObservedResponseEvidence {
            status: ObservedResponseStatus::Inconclusive,
            accesses: vec![],
            reason: Some("dynamic access".to_string()),
        }),
    );

    assert!(
        report.findings.is_empty(),
        "findings: {:?}",
        report.findings
    );
    assert_ne!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}

#[test]
fn root_array_observed_read_of_a_removed_field_is_a_new_finding() {
    let base = array(object(vec![
        ("productName", string_type()),
        ("quantity", number_type()),
    ]));
    let candidate = array(object(vec![("quantity", number_type())]));
    let report = checked(
        Some(base),
        Some(candidate),
        Some(observed(vec![observed_access("[].productName", true)])),
    );

    assert_eq!(finding_paths(&report), vec!["[].productName"]);
    let new_paths: Vec<&str> = delta_of(&report)
        .new_findings
        .iter()
        .map(|f| f.wire_path.as_str())
        .collect();
    assert_eq!(new_paths, vec!["[].productName"]);
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}

#[test]
fn observed_delta_resolves_references_through_the_type_pool() {
    let reference = || {
        WireType::Ref(RefWireType {
            r#ref: "com.example.OrderPage".to_string(),
            provenance: None,
        })
    };
    let mut base_pool = BTreeMap::new();
    base_pool.insert(
        "com.example.OrderPage".to_string(),
        object(vec![
            ("totalSales", number_type()),
            ("status", string_type()),
        ]),
    );
    let mut cand_pool = BTreeMap::new();
    cand_pool.insert(
        "com.example.OrderPage".to_string(),
        object(vec![("totalSales", number_type())]),
    );
    let report = checked_with_pools(
        Some(reference()),
        Some(reference()),
        Some(base_pool),
        Some(cand_pool),
        Some(observed(vec![observed_access("status", true)])),
    );

    let paths = finding_paths(&report);
    assert_eq!(paths, vec!["status"]);
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}
