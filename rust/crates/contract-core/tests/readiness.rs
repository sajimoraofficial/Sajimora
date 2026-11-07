use contract_core::{
    admission::ArtifactTrustPolicy,
    comparison::{check_contract, CheckContractInput},
    envelope::{compute_envelope_digest_from_value, parse_envelope, ContractArtifactEnvelope},
    report::{AbstentionCode, CrossLanguageVerdict, ReasonCode, ReasonSource},
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/envelopes")
        .join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn sealed(mut value: Value) -> ContractArtifactEnvelope {
    value["integrity"] =
        json!({"sha256": compute_envelope_digest_from_value(value.clone()).unwrap()});
    parse_envelope(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn compare(
    base: Value,
    candidate: Value,
    target: Value,
) -> contract_core::report::CrossLanguageImpactReport {
    check_contract(CheckContractInput {
        base: sealed(base),
        candidate: sealed(candidate),
        targets: vec![sealed(target)],
        policy: ArtifactTrustPolicy {
            producers: vec![
                contract_core::admission::TrustedProducer {
                    repository_id: "github.com/example/monorepo".into(),
                    service_id: "user-service".into(),
                    trusted_digests: None,
                    public_key_pem: None,
                    public_key_id: None,
                    public_key_der_hex: None,
                    valid_until: None,
                    environments: None,
                    signature_format: None,
                },
                contract_core::admission::TrustedProducer {
                    repository_id: "github.com/example/monorepo".into(),
                    service_id: "frontend-app".into(),
                    trusted_digests: None,
                    public_key_pem: None,
                    public_key_id: None,
                    public_key_der_hex: None,
                    valid_until: None,
                    environments: None,
                    signature_format: None,
                },
            ],
            require_signatures: false,
            ..Default::default()
        },
        trusted_local: true,
        require_service_mapping: true,
    })
    .unwrap()
}
#[test]
fn bodyless_backend_target_is_not_preserved() {
    let mut backend = fixture("backend_same");
    backend["payload"]["endpoints"][0]["body"] = Value::Null;
    let report = compare(
        fixture("frontend_complete"),
        fixture("frontend_complete"),
        backend,
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}
#[test]
fn bodyless_unknown_expectation_is_inconclusive_in_both_directions() {
    let mut backend = fixture("backend_same");
    backend["payload"]["endpoints"][0]["body"] = Value::Null;
    let mut frontend = fixture("frontend_complete");
    frontend["payload"]["clientContracts"][0]["expectedResponse"] =
        json!({"kind":"UNKNOWN","reason":"unsupported decoder"});
    assert_eq!(
        compare(
            fixture("backend_complete"),
            backend.clone(),
            frontend.clone()
        )
        .verdict,
        CrossLanguageVerdict::Inconclusive
    );
    assert_eq!(
        compare(frontend.clone(), frontend, backend).verdict,
        CrossLanguageVerdict::Inconclusive
    );
}
#[test]
fn parameter_obligations_are_unresolved_and_counted() {
    for field in ["queryParameters", "headers", "pathParameters"] {
        let mut candidate = fixture("backend_same");
        candidate["payload"]["endpoints"][0][field] =
            json!([{"name":"token","type":{"kind":"PRIMITIVE","scalar":"string"},"required":true}]);
        let report = compare(
            fixture("backend_complete"),
            candidate,
            fixture("frontend_complete"),
        );
        assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
        assert_eq!(report.counts.changed_endpoints, 1);
    }
}
#[test]
fn missing_kind_specific_profiles_are_rejected() {
    for (name, field) in [
        ("backend_complete", "frameworkProfile"),
        ("backend_complete", "codecProfile"),
        ("frontend_complete", "clientProfile"),
    ] {
        let mut value = fixture(name);
        value["profile"].as_object_mut().unwrap().remove(field);
        assert!(contract_core::validation::validate_artifact_fields(&sealed(value)).is_err());
    }
}
#[test]
fn numeric_shortest_roundtrip_and_integer_binary64_match_javascript() {
    for (input, expected) in [
        ("123456789012345680000", "123456789012345680000"),
        ("100000000000000020000", "100000000000000020000"),
        ("9007199254740993", "9007199254740992"),
        ("-0.0", "0"),
        ("1e21", "1e+21"),
    ] {
        let value: Value = serde_json::from_str(input).unwrap();
        assert_eq!(contract_core::canonical::canonical_json(&value), expected);
    }
}

#[test]
fn extraction_warnings_preserve_verdict_and_codes() {
    for code in [
        "UNRESOLVED_JACKSON_CONFIG",
        "UNRESOLVED_JAVA_GENERIC",
        "DYNAMIC_URL",
        "FUTURE_WARNING",
    ] {
        let mut candidate = fixture("backend_same");
        candidate["completeness"]["complete"] = json!(false);
        candidate["completeness"]["blockers"] =
            json!([{"code":code,"message":"Unsupported extraction fact"}]);
        let report = compare(
            fixture("backend_complete"),
            candidate,
            fixture("frontend_complete"),
        );
        assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
        if code != "FUTURE_WARNING" {
            assert_eq!(
                serde_json::to_value(&report.blockers[0].code).unwrap(),
                code
            );
        }
    }
}

#[test]
fn warnings_do_not_hide_violations_and_tool_failures_stay_fatal() {
    let mut breaking = fixture("backend_candidate");
    breaking["completeness"]["complete"] = json!(false);
    // Use a type mismatch rather than an absence inferred from incomplete inventory.
    breaking["payload"]["endpoints"] = fixture("backend_same")["payload"]["endpoints"].clone();
    breaking["payload"]["endpoints"][0]["body"]["properties"][0]["type"] =
        json!({"kind":"PRIMITIVE","scalar":"string"});
    for (code, expected) in [
        (
            "UNRESOLVED_JACKSON_CONFIG",
            CrossLanguageVerdict::LikelyViolated,
        ),
        ("TOOL_FAILURE", CrossLanguageVerdict::AnalysisError),
        ("FILE_READ_ERROR", CrossLanguageVerdict::AnalysisError),
    ] {
        breaking["completeness"]["blockers"] =
            json!([{"code":code,"message":"Extraction blocker"}]);
        assert_eq!(
            compare(
                fixture("backend_complete"),
                breaking.clone(),
                fixture("frontend_complete")
            )
            .verdict,
            expected
        );
    }
}

#[test]
fn artifact_incompleteness_is_evidence_not_an_unresolved_link() {
    let mut backend = fixture("backend_same");
    backend["completeness"]["complete"] = json!(false);
    let report = compare(backend.clone(), backend, fixture("frontend_complete"));
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
    assert_eq!(report.counts.unresolved_links, 0);
    assert_eq!(report.completeness.unwrap().unresolved_evidence.len(), 2);
    assert_eq!(
        report
            .reason_codes
            .iter()
            .filter(|record| record.code == ReasonCode::ArtifactIncomplete
                && record.source == Some(ReasonSource::Artifact))
            .count(),
        2,
        "artifact incompleteness is coded evidence, not a link: {:?}",
        report.reason_codes
    );
}

#[test]
fn unresolved_parameters_carry_specific_codes_and_endpoint_context() {
    let mut candidate = fixture("backend_same");
    candidate["payload"]["endpoints"][0]["queryParameters"] =
        json!([{"name":"token","type":{"kind":"PRIMITIVE","scalar":"string"},"required":true}]);
    let report = compare(
        fixture("backend_complete"),
        candidate,
        fixture("frontend_complete"),
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
    let record = report
        .reason_codes
        .iter()
        .find(|record| record.code == ReasonCode::ParameterValueNoEvidence)
        .expect("a parameter obligation must carry its specific code");
    assert_eq!(record.family, Some(AbstentionCode::ParamValueNoEvidence));
    assert_eq!(record.source, Some(ReasonSource::Producer));
    let endpoint = record
        .endpoint
        .as_ref()
        .expect("the record names the endpoint the parameter belongs to");
    assert_eq!(endpoint.method, "GET");
    assert!(record.detail.contains("query parameter token"));

    let census: usize = report
        .counts
        .abstentions_by_code
        .as_ref()
        .expect("abstention census")
        .values()
        .sum();
    assert_eq!(census, report.counts.unresolved_links);
}

#[test]
fn unknown_wire_shapes_name_the_extractor_reason() {
    let mut candidate = fixture("backend_same");
    candidate["payload"]["endpoints"][0]["body"] = json!({
        "kind": "UNKNOWN",
        "reason": "com.acme.Shape is an interface; its JSON properties come from whichever implementation the producer returns at runtime"
    });
    let report = compare(
        fixture("backend_complete"),
        candidate,
        fixture("frontend_complete"),
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
    let record = report
        .reason_codes
        .iter()
        .find(|record| record.code == ReasonCode::DynamicControllerDelegation)
        .unwrap_or_else(|| {
            panic!(
                "an interface-shaped producer must carry DYNAMIC_CONTROLLER_DELEGATION: {:?}",
                report.reason_codes
            )
        });
    assert_eq!(record.family, Some(AbstentionCode::WireShapeUnresolved));
    assert!(
        record.detail.contains("is an interface"),
        "{}",
        record.detail
    );
    assert!(record.endpoint.is_some(), "the record names the endpoint");
    assert!(record.file.is_some(), "the record names the consumer file");
    assert!(
        report
            .counts
            .abstentions_by_code
            .as_ref()
            .unwrap()
            .contains_key("WIRE_SHAPE_UNRESOLVED"),
        "the twelve-code census is unchanged: {:?}",
        report.counts.abstentions_by_code
    );
}

#[test]
fn reason_codes_keep_each_occurrence_while_the_census_deduplicates_messages() {
    // A bare extractor message can surface at several consumer call sites. The
    // twelve-code census counts the distinct message (unresolvedLinks must not
    // multiply), while reasonCodes keeps every occurrence with its file and
    // endpoint so the debt stays actionable.
    let evidence = json!("Response resolves to an empty or unshaped object declaration");
    let mut frontend = fixture("frontend_complete");
    frontend["payload"]["clientContracts"][0]["unresolvedEvidence"] = json!([evidence.clone()]);
    let mut second = frontend["payload"]["clientContracts"][0].clone();
    second["sourceFile"] = json!("src/api/orderClient.ts");
    second["sourceLine"] = json!(40);
    second["unresolvedEvidence"] = json!([evidence]);
    frontend["payload"]["clientContracts"]
        .as_array_mut()
        .unwrap()
        .push(second);

    let report = compare(
        fixture("backend_complete"),
        fixture("backend_complete"),
        frontend,
    );
    let records: Vec<_> = report
        .reason_codes
        .iter()
        .filter(|record| record.code == ReasonCode::EmptyObjectDeclaration)
        .collect();
    assert_eq!(
        records.len(),
        2,
        "both occurrences must stay in the report: {:?}",
        report.reason_codes
    );
    let files: BTreeSet<_> = records
        .iter()
        .filter_map(|record| record.file.clone())
        .collect();
    assert_eq!(
        files,
        BTreeSet::from([
            "src/api/orderClient.ts".to_string(),
            "src/api/userClient.ts".to_string()
        ])
    );
    assert_eq!(
        report
            .counts
            .abstentions_by_code
            .as_ref()
            .and_then(|census| census.get(AbstentionCode::ShapeEmptyObjectDecl.as_str())),
        Some(&1),
        "the census must count the message once: {:?}",
        report.counts.abstentions_by_code
    );
    assert_eq!(report.counts.unresolved_links, 1);
}

#[test]
fn scalar_changes_use_wire_names_for_stable_finding_ids() {
    let mut backend = fixture("backend_same");
    backend["payload"]["endpoints"][0]["body"]["properties"][0]["type"] =
        json!({"kind":"PRIMITIVE","scalar":"string"});
    let report = compare(
        fixture("backend_complete"),
        backend,
        fixture("frontend_complete"),
    );
    assert!(report
        .findings
        .iter()
        .any(|f| f.change.before == "number" && f.change.after == "string"));
}

#[test]
fn evidence_conflict_yields_inconclusive_verdict() {
    let mut backend = fixture("backend_same");
    backend["payload"]["endpoints"][0]["evidenceClassification"] =
        json!("INCONCLUSIVE_OR_CONFLICTING");
    let report = compare(
        fixture("backend_complete"),
        backend,
        fixture("frontend_complete"),
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
    assert!(report
        .blockers
        .iter()
        .any(|b| serde_json::to_value(&b.code).unwrap() == "EVIDENCE_CONFLICT"));
}

#[test]
fn error_4xx_5xx_status_family_does_not_satisfy_client_200_expectation() {
    let mut backend = fixture("backend_same");
    backend["payload"]["endpoints"][0]["statusCodeFamily"] = json!("ERROR_4XX_5XX");
    let report = compare(
        fixture("backend_complete"),
        backend,
        fixture("frontend_complete"),
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyViolated);
}

#[test]
fn consumer_200_expectation_matches_success_endpoint_not_error_envelope() {
    let mut backend = fixture("backend_same");
    let mut error_ep = backend["payload"]["endpoints"][0].clone();
    error_ep["statusCodeFamily"] = json!("ERROR_4XX_5XX");
    error_ep["body"] = json!({
        "kind": "OBJECT",
        "name": "ProblemDetail",
        "properties": [
            {
                "wireName": "title",
                "type": { "kind": "PRIMITIVE", "scalar": "string" },
                "optional": false,
                "nullable": true,
                "validationConstraints": []
            },
            {
                "wireName": "status",
                "type": { "kind": "PRIMITIVE", "scalar": "number" },
                "optional": false,
                "nullable": false,
                "validationConstraints": []
            }
        ]
    });
    backend["payload"]["endpoints"]
        .as_array_mut()
        .unwrap()
        .push(error_ep);

    let report = compare(
        fixture("backend_complete"),
        backend,
        fixture("frontend_complete"),
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::LikelyPreserved);
}

#[test]
fn unmatched_target_service_id_blocks_instead_of_reporting_nothing() {
    // A consumer artifact extracted with the wrong --target-service-id links to nothing.
    // That must read as a configuration error, not as "no impact".
    let mut mismatched = fixture("frontend_complete");
    for contract in mismatched["payload"]["clientContracts"]
        .as_array_mut()
        .unwrap()
    {
        contract["targetServiceId"] = json!("user-services");
    }
    let report = compare(
        fixture("backend_complete"),
        fixture("backend_complete"),
        mismatched,
    );
    assert_eq!(report.verdict, CrossLanguageVerdict::Inconclusive);
    assert_eq!(report.counts.linked_endpoints, 0);
    let blockers = serde_json::to_value(&report.blockers).unwrap();
    assert!(
        blockers.as_array().unwrap().iter().any(|b| {
            b["code"] == json!("UNMATCHED_TARGET_SERVICE_ID")
                && b["message"]
                    .as_str()
                    .unwrap_or("")
                    .contains("user-services")
        }),
        "a consumer targeting no compared producer must raise a blocker: {blockers}"
    );

    // Control: matching ids must not raise it.
    let report = compare(
        fixture("backend_complete"),
        fixture("backend_complete"),
        fixture("frontend_complete"),
    );
    let blockers = serde_json::to_value(&report.blockers).unwrap();
    assert!(
        !blockers
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["code"] == json!("UNMATCHED_TARGET_SERVICE_ID")),
        "matching ids must not raise the blocker: {blockers}"
    );
}
