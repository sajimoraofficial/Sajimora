use contract_core::envelope::{parse_envelope, ArtifactPayload, ContractArtifactEnvelope};
use contract_core::ir::{
    ContractDirection, EndpointContract, EndpointIdentityContract, SourceLanguage,
    SourceProvenance, UnknownWireType, WireType,
};
use contract_core::request_synthesis::RequestFixtures;
use contract_core::synthesis::{
    synthesize_fast_check, synthesize_jqwik, synthesize_junit4, synthesize_junit5,
    synthesize_supertest, synthesize_tests, synthesize_tests_with_package,
    synthesize_tests_with_request_fixtures, TestSynthesisFramework,
};
use serde_json::json;
use std::fs;
use std::path::Path;

#[test]
fn test_junit5_synthesis_spring_sample() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    let java_code = synthesize_tests_with_package(
        &envelope,
        TestSynthesisFramework::JUnit5,
        Some("SampleControllerContractTest"),
        Some("com.example.sample"),
    )
    .expect("JUnit 5 synthesis must succeed");

    assert!(java_code.contains("package com.example.sample;"));
    assert!(java_code.contains("public class SampleControllerContractTest"));
    assert!(java_code.contains("@SpringBootTest"));
    assert!(java_code.contains("@AutoConfigureMockMvc(addFilters = false)"));
    assert!(java_code.contains("@ActiveProfiles(\"test\")"));
    assert!(java_code.contains("import org.junit.jupiter.api.Test;"));
    assert!(java_code.contains("@Test"));
    assert!(!java_code.contains("@Property")); // No jqwik dependency
    assert!(java_code.contains("mockMvc.perform("));
    assert!(java_code.contains("/api/sample"));
}

#[test]
fn test_junit4_synthesis_spring_sample() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    let java_code = synthesize_junit4(
        &envelope,
        Some("SampleControllerVintageTest"),
        Some("com.example.sample"),
    )
    .expect("JUnit 4 synthesis must succeed");

    assert!(java_code.contains("package com.example.sample;"));
    assert!(java_code.contains("public class SampleControllerVintageTest"));
    assert!(java_code.contains("@RunWith(SpringRunner.class)"));
    assert!(java_code.contains("import org.junit.Test;"));
    assert!(java_code.contains("import org.springframework.test.context.junit4.SpringRunner;"));
}

#[test]
fn test_jqwik_synthesis_spring_sample() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    let java_code = synthesize_jqwik(&envelope, Some("SampleControllerPropertyTest"))
        .expect("Jqwik synthesis must succeed");

    assert!(java_code.contains("public class SampleControllerPropertyTest"));
    assert!(java_code.contains("@SpringBootTest"));
    assert!(java_code.contains("@AutoConfigureMockMvc"));
    assert!(java_code.contains("@Property"));
    assert!(java_code.contains("mockMvc.perform("));
    assert!(java_code.contains("/api/sample"));
}

#[test]
fn test_fast_check_synthesis_spring_sample() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    let ts_code = synthesize_fast_check(&envelope, Some("SampleService Client Tests"))
        .expect("Fast-check synthesis must succeed");

    assert!(ts_code.contains("describe('SampleService Client Tests'"));
    assert!(ts_code.contains("import fc from 'fast-check'"));
    assert!(ts_code.contains("ABSTAIN: nonGET"));
    assert!(ts_code.contains("SAJIMORA_TOKEN"));
    assert!(ts_code.contains("authHeaders"));
    assert!(ts_code.contains("await fetch("));
    assert!(ts_code.contains("shape_"));
}

#[test]
fn fast_check_fixtures_supply_path_values_headers_and_bearer_auth() {
    use contract_core::synthesis::{synthesize_tests_with_summary, SynthesisOptions};
    let envelope = spring_sample_envelope();
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {
            "GET /api/sample/{id}": {
                "pathParameters": {"id": "42"},
                "headers": {"X-Fixture": "yes"},
                "headersFromEnv": {"X-From-Env": "X_TOKEN"}
            }
        }
    }))
    .unwrap();
    let output = synthesize_tests_with_summary(
        &envelope,
        TestSynthesisFramework::FastCheck,
        Some("FixtureContractTest"),
        None,
        Some(&fixtures),
        SynthesisOptions::default(),
    )
    .unwrap();
    assert!(output.code.contains("SAJIMORA_TOKEN"), "{}", output.code);
    assert!(output.code.contains("authHeaders"), "{}", output.code);
    assert!(
        output.code.contains("\"/api/sample/42\""),
        "{}",
        output.code
    );
    assert!(
        output.code.contains("\"X-Fixture\": \"yes\""),
        "{}",
        output.code
    );
    assert!(
        output.code.contains("process.env[\"X_TOKEN\"]"),
        "{}",
        output.code
    );
    assert!(
        output.summary.executable_contract_checks > 0,
        "{:?}",
        output.summary
    );
}

#[test]
fn fast_check_fixtures_supply_non_get_request_method_body_and_status() {
    use contract_core::synthesis::{synthesize_tests_with_summary, SynthesisOptions};
    let envelope = spring_sample_envelope();
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {
            "POST /api/sample": {
                "body": {"name": "sample_name", "id": 101},
                "expectedStatus": 201
            }
        }
    }))
    .unwrap();
    let output = synthesize_tests_with_summary(
        &envelope,
        TestSynthesisFramework::FastCheck,
        Some("PostFixtureContractTest"),
        None,
        Some(&fixtures),
        SynthesisOptions::default(),
    )
    .unwrap();
    assert!(output.code.contains("method: 'POST'"), "{}", output.code);
    assert!(
        output.code.contains("body: JSON.stringify("),
        "{}",
        output.code
    );
    assert!(
        output
            .code
            .contains(r#"'Content-Type': "application/json""#),
        "{}",
        output.code
    );
    assert!(
        output.code.contains("expect(response.status).toBe(201);"),
        "{}",
        output.code
    );
    assert!(output.code.contains("expect(shape_"), "{}", output.code);
}

#[test]
fn test_junit5_generated_test_asserts_contract_fields() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    let java_code = synthesize_tests_with_package(
        &envelope,
        TestSynthesisFramework::JUnit5,
        Some("SampleControllerContractTest"),
        None,
    )
    .expect("JUnit 5 synthesis must succeed");

    assert!(
        java_code.contains(".andExpect(jsonPath(\"$.active\").isBoolean())"),
        "Required non-null field must produce a type matcher:\n{java_code}"
    );
    assert!(
        java_code.contains("org.hamcrest.Matchers.hasKey(\"id\")"),
        "Required nullable field must produce a key-presence matcher:\n{java_code}"
    );
}

#[test]
fn test_fast_check_generated_test_is_not_circular() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let mut envelope = parse_envelope(&content).expect("Envelope parsing must succeed");
    // Exercise the preexisting supported GET shape path without expanding TS synthesis.
    if let ArtifactPayload::Backend(payload) = &mut envelope.payload {
        for wire in payload.type_pool.as_mut().unwrap().values_mut() {
            if let WireType::Object(object) = wire {
                for property in &mut object.properties {
                    property.nullable = false;
                }
            }
        }
    }
    let ts_code =
        synthesize_fast_check(&envelope, None).expect("Fast-check synthesis must succeed");

    assert!(
        ts_code.contains("const shape_1 = (v: unknown): boolean => isRecord(v)"),
        "A contract-derived predicate must be emitted:\n{ts_code}"
    );
    assert!(
        ts_code.contains("delete mutated[key];"),
        "The predicate must be mutation-checked:\n{ts_code}"
    );
    assert!(
        !ts_code.contains("expect(data).toBeDefined();"),
        "The self-referential assertion must be gone:\n{ts_code}"
    );
}

#[test]
fn test_strict_abstention_on_unknown_wire_type() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir.join("../../fixtures/spring-sample.contract.json");
    let content = fs::read(&fixture_path).expect("Fixture must be readable");
    let mut envelope = parse_envelope(&content).expect("Envelope parsing must succeed");

    // Introduce an endpoint with WireType::Unknown
    if let contract_core::envelope::ArtifactPayload::Backend(payload) = &mut envelope.payload {
        payload.endpoints.push(EndpointContract {
            identity: EndpointIdentityContract {
                service: Some("sample-service".to_string()),
                http_method: "GET".to_string(),
                normalized_route: contract_core::routes::normalize_route_segments(
                    "/api/sample/unresolved",
                ),
                direction: ContractDirection::Response,
            },
            path_parameters: vec![],
            query_parameters: vec![],
            headers: vec![],
            body: Some(WireType::Unknown(UnknownWireType {
                reason: "Unresolved generic projection".to_string(),
                provenance: None,
            })),
            provenance: SourceProvenance {
                language: SourceLanguage::Java,
                file: "SampleController.java".to_string(),
                line: 99,
                column: None,
                ast_identity: None,
                annotation_or_schema: None,
                evidence_classification: None,
                sha256: None,
            },
            evidence_classification: None,
            declared_responses: None,
            status_code_family: None,
            mapping_conditions: None,
        });
    }

    let java_code = synthesize_tests(&envelope, TestSynthesisFramework::Jqwik, None).unwrap();
    assert!(
        java_code.contains(
            "// ABSTAIN: Endpoint GET /api/sample/unresolved contains unresolved WireType::Unknown"
        ),
        "Generator must abstain with comment on unknown wire type"
    );

    let ts_code = synthesize_tests(&envelope, TestSynthesisFramework::FastCheck, None).unwrap();
    assert!(
        ts_code.contains(
            "// ABSTAIN: Endpoint GET /api/sample/unresolved contains unresolved WireType::Unknown"
        ),
        "TS generator must abstain with comment on unknown wire type"
    );
}

fn spring_sample_envelope() -> ContractArtifactEnvelope {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/spring-sample.contract.json");
    parse_envelope(&fs::read(path).unwrap()).unwrap()
}

fn sample_endpoints(envelope: &mut ContractArtifactEnvelope) -> &mut Vec<EndpointContract> {
    match &mut envelope.payload {
        ArtifactPayload::Backend(payload) => &mut payload.endpoints,
        _ => panic!("spring sample must be a backend contract"),
    }
}

fn generated_method<'a>(code: &'a str, endpoint: &str) -> &'a str {
    let marker = format!("        String endpoint = \"{endpoint}\";");
    let (before, after) = code.split_once(&marker).expect("endpoint must have a test");
    let start = before
        .rfind("    @Test\n")
        .expect("endpoint must be an executable @Test");
    let end = after.find("\n    }\n").expect("test method must close");
    &code[start..before.len() + marker.len() + end + "\n    }\n".len()]
}

fn junit5_with_fixtures(envelope: &ContractArtifactEnvelope, fixtures: &RequestFixtures) -> String {
    synthesize_tests_with_request_fixtures(
        envelope,
        TestSynthesisFramework::JUnit5,
        Some("RequestContractTest"),
        None,
        fixtures,
    )
    .unwrap()
}

fn assert_java_statements_in_order(code: &str, statements: &[&str]) {
    let mut remaining = code;
    for statement in statements {
        let offset = remaining.find(statement).unwrap_or_else(|| {
            panic!("missing or out-of-order Java statement {statement:?}:\n{code}")
        });
        remaining = &remaining[offset + statement.len()..];
    }
}

#[test]
fn junit5_explicit_object_and_scalar_bodies_are_json_and_java_escaped() {
    let envelope = spring_sample_envelope();
    for (body, expected_content) in [
        (
            json!({"name": "quote \" slash \\ line\n\r\t"}),
            r#"request.contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"quote \\\" slash \\\\ line\\n\\r\\t\"}");"#,
        ),
        (
            json!("quote \" slash \\ line\n"),
            r#"request.contentType(MediaType.APPLICATION_JSON).content("\"quote \\\" slash \\\\ line\\n\"");"#,
        ),
        (
            json!(7),
            r#"request.contentType(MediaType.APPLICATION_JSON).content("7");"#,
        ),
        (
            json!(true),
            r#"request.contentType(MediaType.APPLICATION_JSON).content("true");"#,
        ),
        (
            json!(null),
            r#"request.contentType(MediaType.APPLICATION_JSON).content("null");"#,
        ),
    ] {
        let fixtures: RequestFixtures = serde_json::from_value(json!({
            "endpoints": {
                "POST /api/sample": {"body": body},
                "GET /api/sample/{id}": {"pathParameters": {"id": "42"}}
            }
        }))
        .unwrap();
        let code = junit5_with_fixtures(&envelope, &fixtures);
        let post = generated_method(&code, "POST /api/sample");
        assert!(
            post.lines().any(|line| line.trim() == expected_content),
            "{post}"
        );
        assert_eq!(post.matches("request.contentType(").count(), 1);
        assert!(post.contains(concat!(
            "MockHttpServletRequestBuilder request = request(org.springframework.http.HttpMethod.valueOf(\"POST\"), java.net.URI.create(\"/api/sample\"))\n",
            "                .accept(MediaType.APPLICATION_JSON);"
        )));
        let get = generated_method(&code, "GET /api/sample/{id}");
        assert!(get.contains("request(org.springframework.http.HttpMethod.valueOf(\"GET\"), java.net.URI.create(\"/api/sample/42\"))"));
        assert!(!get.contains("request.contentType("));
    }
}

#[test]
fn junit5_root_level_string_body_is_sent_as_raw_text() {
    let mut envelope = spring_sample_envelope();
    let request = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "POST"
        })
        .expect("sample envelope must have a POST request record");
    request.body =
        Some(serde_json::from_value(json!({"kind": "PRIMITIVE", "scalar": "string"})).unwrap());
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {
            "POST /api/sample": {"body": "admin@example.com"},
            "GET /api/sample/{id}": {"pathParameters": {"id": "42"}}
        }
    }))
    .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let post = generated_method(&code, "POST /api/sample");
    assert!(
        post.contains(r#"request.contentType(MediaType.TEXT_PLAIN).content("admin@example.com");"#),
        "{post}"
    );
    assert!(
        !post.contains(r#"\"admin@example.com\""#),
        "raw text must not be JSON-quoted:\n{post}"
    );
    assert_eq!(post.matches("request.contentType(").count(), 1);
    assert!(
        post.contains("root-level String body emitted as raw text"),
        "{post}"
    );

    let mut temporal_envelope = spring_sample_envelope();
    let request = sample_endpoints(&mut temporal_envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "POST"
        })
        .expect("sample envelope must have a POST request record");
    request.body = Some(
        serde_json::from_value(
            json!({"kind": "PRIMITIVE", "scalar": "string", "format": "DATE_TIME"}),
        )
        .unwrap(),
    );
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {
            "POST /api/sample": {"body": "2024-01-01T00:00:00Z"},
            "GET /api/sample/{id}": {"pathParameters": {"id": "42"}}
        }
    }))
    .unwrap();
    let code = junit5_with_fixtures(&temporal_envelope, &fixtures);
    let post = generated_method(&code, "POST /api/sample");
    assert!(
        post.contains(r#"request.contentType(MediaType.APPLICATION_JSON).content("\"2024-01-01T00:00:00Z\"");"#),
        "temporal root strings remain JSON values:\n{post}"
    );
    assert!(!post.contains("MediaType.TEXT_PLAIN"), "{post}");
}

#[test]
fn junit5_nullable_container_properties_get_nested_assertions() {
    use contract_core::synthesis::{synthesize_tests_with_summary, SynthesisOptions};
    let mut envelope = spring_sample_envelope();
    let response = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Response
                && endpoint.identity.http_method == "GET"
                && endpoint.identity.normalized_route.raw_path == "/api/sample/{id}"
        })
        .expect("sample envelope must have GET /api/sample/{id}");
    response.body = Some(serde_json::from_value(json!({
        "kind": "OBJECT",
        "properties": [
            {"wireName": "id", "type": {"kind": "PRIMITIVE", "scalar": "number"}, "optional": false, "nullable": true, "validationConstraints": []},
            {"wireName": "items", "type": {"kind": "ARRAY", "elementType": {"kind": "PRIMITIVE", "scalar": "string"}}, "optional": false, "nullable": true, "validationConstraints": []},
            {"wireName": "child", "type": {"kind": "OBJECT", "properties": [{"wireName": "name", "type": {"kind": "PRIMITIVE", "scalar": "string"}, "optional": false, "nullable": false, "validationConstraints": []}]}, "optional": false, "nullable": true, "validationConstraints": []},
            {"wireName": "required", "type": {"kind": "PRIMITIVE", "scalar": "string"}, "optional": false, "nullable": false, "validationConstraints": []}
        ]
    })).unwrap());
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {"GET /api/sample/{id}": {"pathParameters": {"id": "42"}}}
    }))
    .unwrap();
    let output = synthesize_tests_with_summary(
        &envelope,
        TestSynthesisFramework::JUnit5,
        Some("RequestContractTest"),
        None,
        Some(&fixtures),
        SynthesisOptions::default(),
    )
    .unwrap();
    let get = generated_method(&output.code, "GET /api/sample/{id}");
    assert!(!get.contains("UNSUPPORTED_CONSTRUCT"), "{get}");
    assert!(
        !get.contains("INSUFFICIENT_EVIDENCE_TO_ASSERT_RESPONSE_CONTRACT"),
        "{get}"
    );
    assert!(get.contains("mockMvc.perform("), "{get}");
    assert!(
        get.contains("jsonPath(\"$.items\", org.hamcrest.Matchers.anyOf("),
        "{get}"
    );
    assert!(
        get.contains(
            "everyItem((org.hamcrest.Matcher) org.hamcrest.Matchers.instanceOf(String.class))"
        ),
        "{get}"
    );
    assert!(
        get.contains("jsonPath(\"$.child\", org.hamcrest.Matchers.anyOf("),
        "{get}"
    );
    assert!(get.contains(r#"hasEntry((org.hamcrest.Matcher) org.hamcrest.Matchers.equalTo("name"), (org.hamcrest.Matcher) org.hamcrest.Matchers.instanceOf(String.class))"#), "{get}");
    assert!(get.contains("jsonPath(\"$.required\").isString()"), "{get}");
    assert!(get.contains("category = \"PASS_PARTIAL\";"), "{get}");
    assert!(
        output
            .code
            .contains("[PARTIAL_CONTRACT_CHECK] Endpoint GET /api/sample/{id}"),
        "{}",
        output.code
    );
}

#[test]
fn nullable_union_response_still_fails_closed() {
    let mut envelope = spring_sample_envelope();
    let response = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Response
                && endpoint.identity.http_method == "GET"
                && endpoint.identity.normalized_route.raw_path == "/api/sample/{id}"
        })
        .expect("sample envelope must have GET /api/sample/{id}");
    response.body = Some(
        serde_json::from_value(json!({
            "kind": "OBJECT",
            "properties": [{
                "wireName": "choice",
                "type": {"kind": "UNION", "types": [
                    {"kind": "PRIMITIVE", "scalar": "string"},
                    {"kind": "PRIMITIVE", "scalar": "number"}
                ]},
                "optional": false,
                "nullable": true,
                "validationConstraints": []
            }]
        }))
        .unwrap(),
    );
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "endpoints": {"GET /api/sample/{id}": {"pathParameters": {"id": "42"}}}
    }))
    .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let get = generated_method(&code, "GET /api/sample/{id}");
    assert!(get.contains("UNSUPPORTED_CONSTRUCT"), "{get}");
    assert!(get.contains("throw new AssertionError"), "{get}");
    assert!(!get.contains("mockMvc.perform("), "{get}");
}

#[test]
fn junit5_wrappers_automatically_sample_only_the_exact_request_pair() {
    let mut envelope = spring_sample_envelope();
    let endpoints = sample_endpoints(&mut envelope);
    let request = endpoints
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "POST"
        })
        .unwrap();
    if let Some(WireType::Object(body)) = &mut request.body {
        body.properties[0].optional = false;
        body.properties[0].nullable = false;
    } else {
        panic!("sample POST request must be an object");
    }
    let matching = request.clone();
    // Each decoy differs in exactly one component of the pairing identity.
    for component in ["service", "method", "route", "conditions"] {
        let mut decoy = matching.clone();
        decoy.body = Some(WireType::Unknown(UnknownWireType {
            reason: format!("wrong {component} request must not be sampled"),
            provenance: None,
        }));
        match component {
            "service" => decoy.identity.service = Some("other-service".into()),
            "method" => decoy.identity.http_method = "PUT".into(),
            "route" => {
                decoy.identity.normalized_route =
                    contract_core::routes::normalize_route_segments("/api/other")
            }
            "conditions" => {
                decoy.mapping_conditions = Some(json!({"params": ["view=other"], "complete": true}))
            }
            _ => unreachable!(),
        }
        endpoints.insert(0, decoy);
    }
    let direct = synthesize_junit5(&envelope, Some("RequestContractTest"), None).unwrap();
    assert_eq!(
        direct,
        synthesize_tests(
            &envelope,
            TestSynthesisFramework::JUnit5,
            Some("RequestContractTest")
        )
        .unwrap()
    );
    assert_eq!(
        direct,
        synthesize_tests_with_package(
            &envelope,
            TestSynthesisFramework::JUnit5,
            Some("RequestContractTest"),
            None
        )
        .unwrap()
    );
    assert_eq!(
        direct,
        junit5_with_fixtures(&envelope, &RequestFixtures::default())
    );
    let post = generated_method(&direct, "POST /api/sample");
    assert!(post.lines().any(|line| line.trim() == r#"request.contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"sajimora\"}");"#));
    assert!(!post.contains("INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST]"));
    assert_eq!(
        direct.matches("    @Test\n").count(),
        3,
        "REQUEST records must not become response tests"
    );
}

#[test]
fn junit5_required_query_and_path_values_use_request_schema_and_explicit_overrides() {
    let mut envelope = spring_sample_envelope();
    let endpoints = sample_endpoints(&mut envelope);
    let request = endpoints
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "GET"
        })
        .unwrap();
    request.query_parameters = serde_json::from_value(json!([
        {"name": "page", "required": true, "type": {"kind": "PRIMITIVE", "scalar": "number"},
            "validationConstraints": [{"kind": "MIN", "value": 5}]},
        {"name": "q", "required": true, "type": {"kind": "PRIMITIVE", "scalar": "string"}},
        {"name": "optional", "required": false, "type": {"kind": "UNKNOWN", "reason": "not required"}}
    ])).unwrap();
    let response = endpoints
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Response
                && endpoint.identity.normalized_route.raw_path == "/api/sample/{id}"
        })
        .unwrap();
    response.query_parameters = serde_json::from_value(json!([
        {"name": "responseOnly", "required": true, "type": {"kind": "UNKNOWN", "reason": "not request evidence"}}
    ])).unwrap();
    let code = junit5_with_fixtures(&envelope, &RequestFixtures::default());
    let get = generated_method(&code, "GET /api/sample/{id}");
    assert!(get.contains("java.net.URI.create(\"/api/sample/1\")"));
    assert_eq!(
        get.lines()
            .filter(|line| line.trim().starts_with("request.param("))
            .map(str::trim)
            .collect::<Vec<_>>(),
        vec![
            r#"request.param("page", "5");"#,
            r#"request.param("q", "sajimora");"#
        ]
    );
    let fixtures = serde_json::from_value(json!({"endpoints": {"GET /api/sample/{id}": {
        "pathParameters": {"id": "42"}, "queryParameters": {"q": "a\"b\\c\n"}
    }}}))
    .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let get = generated_method(&code, "GET /api/sample/{id}");
    assert!(get.contains("java.net.URI.create(\"/api/sample/42\")"));
    assert_eq!(
        get.lines()
            .filter(|line| line.trim().starts_with("request.param("))
            .map(str::trim)
            .collect::<Vec<_>>(),
        vec![
            r#"request.param("page", "5");"#,
            r#"request.param("q", "a\"b\\c\n");"#
        ]
    );
}

#[test]
fn junit5_never_infers_a_request_body_from_response_or_http_method() {
    for method in ["POST", "PUT", "PATCH", "DELETE"] {
        let mut envelope = spring_sample_envelope();
        let endpoints = sample_endpoints(&mut envelope);
        endpoints.retain(|endpoint| endpoint.identity.direction == ContractDirection::Response);
        let response = endpoints
            .iter_mut()
            .find(|endpoint| endpoint.identity.http_method == "POST")
            .unwrap();
        response.identity.http_method = method.into();
        let key = format!("{method} /api/sample");
        let code = synthesize_tests(&envelope, TestSynthesisFramework::JUnit5, None).unwrap();
        let test = generated_method(&code, &key);
        assert!(!test.contains("request.contentType("), "{test}");
        assert!(test.contains(
            "no REQUEST body evidence; no body invented from HTTP method or RESPONSE body"
        ));
        assert!(test
            .lines()
            .any(|line| line.trim() == "result.andExpect(jsonPath(\"$.active\").isBoolean());"));
        assert!(test
            .lines()
            .any(|line| line.trim() == "result.andExpect(status().is(200));"));
    }
}

#[test]
fn junit5_unknown_required_request_body_emits_a_failing_test_and_zero_attempt_record() {
    let mut envelope = spring_sample_envelope();
    let request = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "POST"
        })
        .unwrap();
    request.body = Some(WireType::Unknown(UnknownWireType {
        reason: "required DTO is unresolved".into(),
        provenance: None,
    }));
    let code = synthesize_tests(&envelope, TestSynthesisFramework::JUnit5, None).unwrap();
    let post = generated_method(&code, "POST /api/sample");
    let message = "REQUEST body requires an explicit fixture or supported schema: UNKNOWN request schema: required DTO is unresolved; explicit fixture required";
    assert!(post.lines().any(|line| line.trim() == format!(
        "recordResult(endpoint, null, 200, 0, 0, \"INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST\", \"{message}\", null);"
    )), "{post}");
    assert!(post.lines().any(|line| line.trim() == format!(
        "throw new AssertionError(endpoint + \" [INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST] \" + \"{message}\");"
    )));
    assert!(!post.contains("mockMvc.perform("));
    assert_eq!(code.matches("    @Test\n").count(), 3);
    assert!(generated_method(&code, "GET /api/sample/{id}").contains("mockMvc.perform(request)"));
    let fixtures = serde_json::from_value(
        json!({"endpoints": {"POST /api/sample": {"body": {"name": "configured"}}}}),
    )
    .unwrap();
    let repaired = junit5_with_fixtures(&envelope, &fixtures);
    assert!(generated_method(&repaired, "POST /api/sample").contains("mockMvc.perform(request)"));
}

#[test]
fn junit5_auth_sql_session_and_result_lifecycle_are_opt_in_and_exception_safe() {
    let envelope = spring_sample_envelope();
    let baseline = junit5_with_fixtures(&envelope, &RequestFixtures::default());
    for absent in [
        "import org.springframework.security.",
        "JdbcTemplate",
        "@Transactional",
        "request.sessionAttr(",
        "request.principal(",
    ] {
        assert!(
            !baseline.contains(absent),
            "unexpected opt-in dependency: {absent}"
        );
    }
    let fixtures: RequestFixtures = serde_json::from_value(json!({
        "authentication": {"username": "global-user"}, "transactional": true,
        "setupSql": ["INSERT INTO global_rows VALUES (1)"], "cleanupSql": ["DELETE FROM global_rows WHERE id = 1"],
        "endpoints": {"POST /api/sample": {
            "authentication": {"username": "endpoint-user"},
            "sessionAttributes": {"count": 7, "flag": true, "negative": -2, "text": "a\"b"},
            "setupSql": ["INSERT INTO endpoint_rows VALUES (2)"], "cleanupSql": ["DELETE FROM endpoint_rows WHERE id = 2"]
        }}
    })).unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    for import in [
        "import org.springframework.security.core.userdetails.UserDetailsService;",
        "import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;",
        "import org.springframework.security.core.context.SecurityContextHolder;",
        "import org.springframework.jdbc.core.JdbcTemplate;",
        "import org.springframework.transaction.annotation.Transactional;",
    ] {
        assert!(code.lines().any(|line| line == import));
    }
    assert!(code.contains("    @Autowired\n    private UserDetailsService userDetailsService;"));
    assert!(code.contains("    @Autowired\n    private JdbcTemplate jdbcTemplate;"));
    assert!(!code.contains("@Rollback(false)"));
    assert!(!code.contains("@Commit"));
    assert!(!code.contains("security.test"));
    assert!(!code.contains("@WithMockUser"));
    let post = generated_method(&code, "POST /api/sample");
    assert!(post.starts_with("    @Test\n    @Transactional\n"));
    assert_java_statements_in_order(post, &[
        "org.springframework.security.core.context.SecurityContext previousContext = SecurityContextHolder.getContext();",
        "try {",
        "jdbcTemplate.execute(\"INSERT INTO global_rows VALUES (1)\");",
        "jdbcTemplate.execute(\"INSERT INTO endpoint_rows VALUES (2)\");",
        "org.springframework.security.core.userdetails.UserDetails user = userDetailsService.loadUserByUsername(\"endpoint-user\");",
        "UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities());",
        "org.springframework.security.core.context.SecurityContext context = SecurityContextHolder.createEmptyContext();",
        "context.setAuthentication(authentication);",
        "SecurityContextHolder.setContext(context);",
        "request.sessionAttr(\"count\", 7L);",
        "request.sessionAttr(\"flag\", true);",
        "request.sessionAttr(\"negative\", -2L);",
        r#"request.sessionAttr("text", "a\"b");"#,
        "request.principal(authentication);",
        "ResultActions result = mockMvc.perform(request);",
        "response = result.andReturn();",
        "result.andExpect(status().is(200));",
        "} catch (Exception | AssertionError error) {",
        "failure = error;",
        "} finally {\n            try {",
        "jdbcTemplate.execute(\"DELETE FROM endpoint_rows WHERE id = 2\");",
        "jdbcTemplate.execute(\"DELETE FROM global_rows WHERE id = 1\");",
        "} catch (RuntimeException cleanupError) {",
        "failure.addSuppressed(cleanupError);",
        "} finally {\n                SecurityContextHolder.setContext(previousContext);",
        "recordResult(endpoint, response, 200, attempted, completed, category, evidence + (failure == null ? \"\" : \"; \" + failure.getClass().getName()), null);",
    ]);
    assert!(!post.contains("loadUserByUsername(\"global-user\")"));
    assert!(generated_method(&code, "GET /api/sample/{id}")
        .contains("loadUserByUsername(\"global-user\")"));
    assert!(post.contains("            attempted++;\n            result.andExpect(jsonPath(\"$.active\").isBoolean());\n            completed++;"));
    for statement in [
        "record.put(\"assertionsAttempted\", attempted);", "record.put(\"assertionsCompleted\", completed);",
        "record.put(\"classification\", category);", "record.put(\"response\", responseEvidence(response));",
        "record.put(\"evidence\", evidence);",
        "System.out.println(\"SAJIMORA_RESULT \" + new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(record));",
    ] {
        assert!(code.lines().any(|line| line.trim() == statement));
    }
    assert!(code.contains("+ \"; error=[REDACTED]; body=\" + redactResponse(result.getResponse().getContentAsString());"));
    for config in [
        json!({"setupSql": ["SELECT 1"]}),
        json!({"cleanupSql": ["SELECT 1"]}),
        json!({"endpoints": {"POST /api/sample": {"setupSql": ["SELECT 1"]}}}),
        json!({"endpoints": {"POST /api/sample": {"cleanupSql": ["SELECT 1"]}}}),
    ] {
        let fixtures = serde_json::from_value(config).unwrap();
        let error = synthesize_tests_with_request_fixtures(
            &envelope,
            TestSynthesisFramework::JUnit5,
            None,
            None,
            &fixtures,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("SQL requires transactional=true"));
    }
    for (config, has_auth, has_sql) in [
        (json!({"authentication": {"username": "user"}}), true, false),
        (
            json!({"transactional": true, "setupSql": ["SELECT 1"]}),
            false,
            true,
        ),
        (
            json!({"endpoints": {"POST /api/sample": {"sessionAttributes": {"count": 7}}}}),
            false,
            false,
        ),
    ] {
        let code = junit5_with_fixtures(&envelope, &serde_json::from_value(config).unwrap());
        assert_eq!(
            code.contains("private UserDetailsService userDetailsService;"),
            has_auth
        );
        assert_eq!(
            code.contains("import org.springframework.security."),
            has_auth
        );
        assert_eq!(code.contains("private JdbcTemplate jdbcTemplate;"), has_sql);
    }
}

#[test]
fn junit5_status_is_exact_204_requires_explicit_void_and_response_matchers_are_unchanged() {
    let envelope = spring_sample_envelope();
    let baseline = junit5_with_fixtures(&envelope, &RequestFixtures::default());
    let fixtures =
        serde_json::from_value(json!({"endpoints": {"POST /api/sample": {"expectedStatus": 201}}}))
            .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let post = generated_method(&code, "POST /api/sample");
    assert!(post
        .lines()
        .any(|line| line.trim() == "result.andExpect(status().is(201));"));
    let matchers = |method: &str| {
        method
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("result.andExpect(jsonPath("))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let original_matchers = matchers(generated_method(&baseline, "POST /api/sample"));
    assert_eq!(
        original_matchers,
        vec![
            r#"result.andExpect(jsonPath("$").isMap());"#,
            r#"result.andExpect(jsonPath("$", org.hamcrest.Matchers.hasKey("id")));"#,
            r#"result.andExpect(jsonPath("$.id", org.hamcrest.Matchers.anyOf(org.hamcrest.Matchers.nullValue(), org.hamcrest.Matchers.instanceOf(Number.class))));"#,
            r#"result.andExpect(jsonPath("$", org.hamcrest.Matchers.hasKey("name")));"#,
            r#"result.andExpect(jsonPath("$.name", org.hamcrest.Matchers.anyOf(org.hamcrest.Matchers.nullValue(), org.hamcrest.Matchers.instanceOf(String.class))));"#,
            r#"result.andExpect(jsonPath("$.active").isBoolean());"#,
        ]
    );
    assert_eq!(matchers(post), original_matchers);
    assert!(!code.contains("is2xxSuccessful"));
    assert!(!code.contains("PASS_NO_CONTENT"));
    for status in [199, 204, 300, 404, 500] {
        let fixtures = serde_json::from_value(
            json!({"endpoints": {"POST /api/sample": {"expectedStatus": status}}}),
        )
        .unwrap();
        let error = synthesize_tests_with_request_fixtures(
            &envelope,
            TestSynthesisFramework::JUnit5,
            None,
            None,
            &fixtures,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains(if status == 204 {
            "204 conflicts with"
        } else {
            "expectedStatus must be in 200..299"
        }));
    }
    for body in [
        None,
        Some(serde_json::from_value(json!({"kind": "PRIMITIVE", "scalar": "void"})).unwrap()),
    ] {
        let mut envelope = envelope.clone();
        let response = sample_endpoints(&mut envelope)
            .iter_mut()
            .find(|endpoint| {
                endpoint.identity.direction == ContractDirection::Response
                    && endpoint.identity.http_method == "POST"
            })
            .unwrap();
        response.body = body;
        let default = junit5_with_fixtures(&envelope, &RequestFixtures::default());
        let default_post = generated_method(&default, "POST /api/sample");
        assert!(default_post.contains("result.andExpect(status().is(200));"));
        assert!(!default_post.contains("content().string(\"\")"));
        let fixtures = serde_json::from_value(
            json!({"endpoints": {"POST /api/sample": {"expectedStatus": 204}}}),
        )
        .unwrap();
        let explicit = junit5_with_fixtures(&envelope, &fixtures);
        let post = generated_method(&explicit, "POST /api/sample");
        assert_java_statements_in_order(
            post,
            &[
                "result.andExpect(status().is(204));",
                "result.andExpect(content().string(\"\"));",
                "category = \"PASS_NO_CONTENT\";",
            ],
        );
        assert!(matchers(post).is_empty());
        assert!(!explicit.contains("is2xxSuccessful"));
    }
}

#[test]
fn explicit_request_fixture_api_rejects_other_frameworks_without_changing_legacy_wrappers() {
    let envelope = spring_sample_envelope();
    let fixtures: RequestFixtures =
        serde_json::from_value(json!({"endpoints": {"POST /api/sample": {"body": {}}}})).unwrap();
    for framework in [
        TestSynthesisFramework::JUnit4,
        TestSynthesisFramework::Jqwik,
        TestSynthesisFramework::FastCheck,
    ] {
        assert!(synthesize_tests(&envelope, framework, None).is_ok());
        assert!(synthesize_tests_with_package(
            &envelope,
            framework,
            None,
            Some("com.example.custom")
        )
        .is_ok());
        for fixtures in [&RequestFixtures::default(), &fixtures] {
            let error =
                synthesize_tests_with_request_fixtures(&envelope, framework, None, None, fixtures)
                    .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Request fixtures currently require the junit5 framework"
            );
        }
    }
}

#[test]
fn junit5_helpers_preserve_java8_syntax_and_classify_thrown_auth_causes() {
    let envelope = spring_sample_envelope();
    let auth: RequestFixtures = serde_json::from_value(json!({
        "authentication": {"username": "configured-user"}
    }))
    .unwrap();
    for fixtures in [&RequestFixtures::default(), &auth] {
        let code = junit5_with_fixtures(&envelope, fixtures);
        assert!(!code.contains("var "));
        assert!(!code.contains(".isBlank()"));
        assert!(code
            .contains("// [CONTRACT_TEST] Verified contract constraints for GET /api/sample/{id}"));
        assert!(code.contains(
            "java.util.Map<String, Object> record = new java.util.LinkedHashMap<String, Object>();"
        ));
        assert!(
            code.contains("for (Throwable cause = error; cause != null; cause = cause.getCause())")
        );
        assert!(code.contains(
            "for (Class<?> type = cause.getClass(); type != null; type = type.getSuperclass())"
        ));
        assert!(code.contains("org.springframework.security.core.AuthenticationException"));
        assert!(code.contains("org.springframework.security.access.AccessDeniedException"));
        assert!(code.contains("Exception exception = result.getResolvedException();"));
        let post = generated_method(&code, "POST /api/sample");
        assert_java_statements_in_order(
            post,
            &[
                "ResultActions result = mockMvc.perform(request);",
                "} catch (Exception | AssertionError error) {",
                "category = classifyFailure(error, category);",
                "failure = error;",
                "throw new AssertionError(endpoint +",
            ],
        );
    }
}

#[test]
fn unsupported_request_emits_structured_reason_and_fixture_preserves_response_assertions() {
    let mut envelope = spring_sample_envelope();
    let request = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Request
                && endpoint.identity.http_method == "POST"
        })
        .unwrap();
    request.body = Some(WireType::Unknown(UnknownWireType {
        reason: "UNSUPPORTED_CONSTRUCT: @JsonDeserialize(using = Custom.class); explicit fixture required".into(), provenance: None,
    }));
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    let post = generated_method(&code, "POST /api/sample");
    assert!(post.contains(", \"UNSUPPORTED_CONSTRUCT\");"));
    assert!(post.contains("throw new AssertionError"));
    assert!(!post.contains("mockMvc.perform("));
    assert!(code.contains("record.put(\"reasonCode\", reasonCode);"));
    let fixtures: RequestFixtures = serde_json::from_value(
        json!({"endpoints": {"POST /api/sample": {"body": {"name": "fixture"}}}}),
    )
    .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let post = generated_method(&code, "POST /api/sample");
    assert!(post.contains("mockMvc.perform(request)"));
    assert!(post.contains("result.andExpect(jsonPath(\"$.active\").isBoolean());"));
}

#[test]
fn unsupported_response_is_an_executable_diagnostic_not_a_silent_skip() {
    let mut envelope = spring_sample_envelope();
    let response = sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Response
                && endpoint.identity.http_method == "POST"
        })
        .unwrap();
    response.body = Some(WireType::Unknown(UnknownWireType {
        reason: "UNSUPPORTED_CONSTRUCT: dynamic @JsonTypeInfo runtime subtype".into(),
        provenance: None,
    }));
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    let post = generated_method(&code, "POST /api/sample");
    assert!(post.contains("throw new AssertionError"));
    assert!(
        post.contains("an explicit request fixture cannot establish an unknown response contract")
    );
    assert!(post.contains("INSUFFICIENT_EVIDENCE_TO_ASSERT_RESPONSE_CONTRACT"));
    assert!(!post.contains("INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST"));
    assert!(post.contains(", \"UNSUPPORTED_CONSTRUCT\");"));
    assert!(!post.contains("mockMvc.perform("));
    assert_eq!(code.matches("    @Test\n").count(), 3);
}

#[test]
fn deeply_nested_unsupported_response_cannot_become_a_status_only_pass() {
    let mut envelope = spring_sample_envelope();
    let mut wire = WireType::Unknown(UnknownWireType {
        reason: "UNSUPPORTED_CONSTRUCT: runtime serializer".into(),
        provenance: None,
    });
    for _ in 0..40 {
        wire = WireType::Nullable(contract_core::ir::NullableWireType {
            inner_type: Box::new(wire),
            provenance: None,
        });
    }
    sample_endpoints(&mut envelope)
        .iter_mut()
        .find(|endpoint| {
            endpoint.identity.direction == ContractDirection::Response
                && endpoint.identity.http_method == "POST"
        })
        .unwrap()
        .body = Some(wire);
    let fixtures = serde_json::from_value(
        json!({"endpoints": {"POST /api/sample": {"body": {"name": "configured"}}}}),
    )
    .unwrap();
    let code = junit5_with_fixtures(&envelope, &fixtures);
    let post = generated_method(&code, "POST /api/sample");
    assert!(post.contains("throw new AssertionError"));
    assert!(post.contains("INSUFFICIENT_EVIDENCE_TO_ASSERT_RESPONSE_CONTRACT"));
    assert!(!post.contains("PASS_STATUS_ONLY"));
    assert!(!post.contains("mockMvc.perform("));
    assert_eq!(code.matches("    @Test\n").count(), 3);
}

#[test]
fn junit5_import_matches_the_target_spring_boot_major() {
    use contract_core::synthesis::{synthesize_tests_with_options, SynthesisOptions};
    let envelope = spring_sample_envelope();
    let fixtures = RequestFixtures::default();
    let boot3 = synthesize_tests_with_options(
        &envelope,
        TestSynthesisFramework::JUnit5,
        None,
        None,
        &fixtures,
        SynthesisOptions::default(),
    )
    .unwrap();
    assert!(boot3.contains(
        "import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;"
    ));
    let boot4 = synthesize_tests_with_options(
        &envelope,
        TestSynthesisFramework::JUnit5,
        None,
        None,
        &fixtures,
        SynthesisOptions {
            spring_boot_major: 4,
        },
    )
    .unwrap();
    assert!(
        boot4.contains(
            "import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;"
        ),
        "{boot4}"
    );
    assert!(!boot4.contains("autoconfigure.web.servlet.AutoConfigureMockMvc"));
    assert!(boot4.contains("@AutoConfigureMockMvc(addFilters = false)"));
}

fn single_response(body: serde_json::Value) -> ContractArtifactEnvelope {
    let mut envelope = spring_sample_envelope();
    let endpoints = sample_endpoints(&mut envelope);
    endpoints.retain(|endpoint| endpoint.identity.direction == ContractDirection::Response);
    endpoints.truncate(1);
    endpoints[0].body = Some(serde_json::from_value(body).unwrap());
    envelope
}

fn single_response_with_pool(
    body: serde_json::Value,
    pool: serde_json::Value,
) -> ContractArtifactEnvelope {
    let mut envelope = single_response(body);
    match &mut envelope.payload {
        ArtifactPayload::Backend(payload) => {
            payload.type_pool = Some(serde_json::from_value(pool).unwrap());
        }
        _ => panic!("sample envelope must be a backend contract"),
    }
    envelope
}

#[test]
fn remediation_enum_asserts_membership_not_just_scalar_type() {
    let envelope = single_response(json!({"kind": "ENUM", "values": ["OPEN", "CLOSED"]}));
    for framework in [
        TestSynthesisFramework::JUnit5,
        TestSynthesisFramework::JUnit4,
        TestSynthesisFramework::Jqwik,
    ] {
        let code = synthesize_tests(&envelope, framework, None).unwrap();
        assert!(
            code.contains(
                "org.hamcrest.Matchers.isIn(java.util.Arrays.asList(\"OPEN\", \"CLOSED\"))"
            ),
            "enum membership missing for {framework}"
        );
    }
}

#[test]
fn remediation_java_json_paths_are_literal_escaped() {
    let envelope = single_response(json!({"kind": "OBJECT", "properties": [{
        "wireName": "a'b\"c\\d\n", "type": {"kind": "PRIMITIVE", "scalar": "string"},
        "nullable": false, "optional": false, "validationConstraints": []
    }]}));
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    assert!(
        code.contains(r#"jsonPath("$['a\\'b\"c\\\\d\n']").isString()"#),
        "path must be escaped at both Jayway and Java layers"
    );
}

#[test]
fn remediation_required_nullable_checks_nonnull_type_or_abstains() {
    let envelope = single_response(json!({"kind": "OBJECT", "properties": [{
        "wireName": "count", "type": {"kind": "PRIMITIVE", "scalar": "number"},
        "nullable": true, "optional": false, "validationConstraints": []
    }]}));
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    assert!(
        code.contains("org.hamcrest.Matchers.nullValue()")
            && code.contains("org.hamcrest.Matchers.instanceOf(Number.class)"),
        "presence alone accepts a wrong nonnull type"
    );
}

#[test]
fn remediation_union_cannot_advertise_full_contract_coverage() {
    let envelope = single_response(json!({"kind": "UNION", "types": [
        {"kind": "PRIMITIVE", "scalar": "string"}, {"kind": "PRIMITIVE", "scalar": "number"}
    ]}));
    for framework in [
        TestSynthesisFramework::JUnit5,
        TestSynthesisFramework::JUnit4,
        TestSynthesisFramework::Jqwik,
        TestSynthesisFramework::FastCheck,
    ] {
        let code = synthesize_tests(&envelope, framework, None).unwrap();
        assert!(
            !code.contains("[CONTRACT_TEST]"),
            "unsupported union advertised by {framework}"
        );
        assert!(code.contains("UNSUPPORTED_CONSTRUCT") || code.contains("ABSTAIN"));
    }
}

#[test]
fn remediation_fast_check_never_gets_nonget_endpoints() {
    let mut envelope = single_response(json!({"kind": "PRIMITIVE", "scalar": "string"}));
    sample_endpoints(&mut envelope)[0].identity.http_method = "DELETE".into();
    let code = synthesize_fast_check(&envelope, None).unwrap();
    assert!(
        !code.contains("await fetch("),
        "nonGET must not silently dispatch GET"
    );
    assert!(code.contains("ABSTAIN"));
}

#[test]
fn remediation_runtime_response_evidence_is_redacted_before_emission() {
    let code = synthesize_junit5(&spring_sample_envelope(), None, None).unwrap();
    assert!(!code.contains("+ \"; body=\" + result.getResponse().getContentAsString()"));
    assert!(code.contains("redactResponse"));
    assert!(code.contains("[REDACTED]"));
}

#[test]
fn remediation_partial_and_status_only_are_not_full_contract_passes() {
    use contract_core::synthesis::{synthesize_tests_with_summary, SynthesisOptions};
    let envelope = single_response(
        json!({"kind": "MAP", "keyType": {"kind": "PRIMITIVE", "scalar": "string"}, "valueType": {"kind": "PRIMITIVE", "scalar": "string"}}),
    );
    let output = synthesize_tests_with_summary(
        &envelope,
        TestSynthesisFramework::JUnit5,
        None,
        None,
        None,
        SynthesisOptions::default(),
    )
    .unwrap();
    assert_eq!(output.summary.executable_contract_checks, 1);
    assert_eq!(output.summary.partial_checks, 1);
    assert!(output.code.contains("category = \"PASS_PARTIAL\";"));
    let mut envelope = envelope;
    sample_endpoints(&mut envelope)[0].body = None;
    let output = synthesize_tests_with_summary(
        &envelope,
        TestSynthesisFramework::JUnit5,
        None,
        None,
        None,
        SynthesisOptions::default(),
    )
    .unwrap();
    assert_eq!(output.summary.executable_contract_checks, 0);
    assert_eq!(output.summary.status_only_checks, 1);
    assert!(!output.code.contains("[CONTRACT_TEST]"));
}

#[test]
fn remediation_numeric_enums_use_compilable_java_literals() {
    let envelope = single_response(
        json!({"kind": "ENUM", "values": [2147483648_i64, 9223372036854775807_i64]}),
    );
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    assert!(code.contains("java.util.Arrays.asList(2147483648L, 9223372036854775807L)"));
    let unsupported =
        single_response(json!({"kind": "ENUM", "values": [18446744073709551615_u64]}));
    let code = synthesize_junit5(&unsupported, None, None).unwrap();
    assert!(code.contains("UNSUPPORTED_CONSTRUCT"));
    assert!(!code.contains("mockMvc.perform(request)"));
}

#[test]
fn remediation_recursive_and_unresolved_refs_abstain_without_advertised_coverage() {
    for resolved in [false, true] {
        let mut envelope = single_response(json!({"kind": "REF", "ref": "loop"}));
        if resolved {
            if let ArtifactPayload::Backend(payload) = &mut envelope.payload {
                payload.type_pool.as_mut().unwrap().insert(
                    "loop".into(),
                    serde_json::from_value(json!({"kind": "REF", "ref": "loop"})).unwrap(),
                );
            }
        }
        for framework in [
            TestSynthesisFramework::JUnit5,
            TestSynthesisFramework::JUnit4,
            TestSynthesisFramework::Jqwik,
            TestSynthesisFramework::FastCheck,
        ] {
            let code = synthesize_tests(&envelope, framework, None).unwrap();
            assert!(!code.contains("[CONTRACT_TEST]"));
            assert!(code.contains("UNSUPPORTED_CONSTRUCT") || code.contains("ABSTAIN"));
        }
    }
}

#[test]
fn remediation_legacy_java_routes_escape_literals_and_comment_newlines() {
    let mut envelope = single_response(json!({"kind": "PRIMITIVE", "scalar": "string"}));
    sample_endpoints(&mut envelope)[0].identity.normalized_route =
        contract_core::routes::normalize_route_segments("/quoted\"\\path\nnotJavaCode");
    for framework in [
        TestSynthesisFramework::JUnit4,
        TestSynthesisFramework::Jqwik,
    ] {
        let code = synthesize_tests(&envelope, framework, None).unwrap();
        assert!(code.contains(r#"get("/quoted\"\\path\nnotJavaCode")"#));
        assert!(
            !code.lines().any(|line| line == "notJavaCode"),
            "route must not break out of a generated comment"
        );
    }
}

#[test]
fn remediation_generated_redaction_helper_compiles_and_redacts_at_runtime() {
    // Opt-in local, cached Java tooling only: never resolve/install dependencies.
    let Ok(classpath) = std::env::var("SAJIMORA_JAVA_TEST_CLASSPATH") else {
        return;
    };
    let code = synthesize_junit5(&spring_sample_envelope(), None, None).unwrap();
    let start = code
        .find("    private static com.fasterxml.jackson.databind.JsonNode redactNode")
        .unwrap();
    let end = code
        .find("    private static String responseEvidence")
        .unwrap();
    let main = r#"
    public static void main(String[] args) throws Exception {
        String canary = "fixture-credential-canary";
        String body = "{\"id_token\":\"" + canary + "\",\"nested\":[{\"password\":\"" + canary
            + "\",\"oddField\":\"" + canary + "\",\"api_key\":42}],\"active\":true}";
        String safe = redactResponse(body);
        if (safe.contains(canary) || safe.contains("42") || !safe.contains("[REDACTED]") || !safe.contains("true")) {
            throw new AssertionError("redaction failed; raw evidence intentionally withheld");
        }
        if (redactResponse(canary).contains(canary)) throw new AssertionError("non-JSON was emitted raw");
        System.out.println("redaction runtime checks passed");
    }
"#;
    let root = std::env::temp_dir().join(format!(
        "sajimora-redaction-runtime-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("RedactionHarness.java");
    fs::write(
        &source,
        format!(
            "public class RedactionHarness {{\n{}{}\n}}",
            &code[start..end],
            main
        ),
    )
    .unwrap();
    let compiled = std::process::Command::new("javac")
        .args(["--release", "8", "-cp", &classpath])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "generated helper failed Java 8 compilation"
    );
    let separator = if cfg!(windows) { ';' } else { ':' };
    let runtime = format!("{}{separator}{classpath}", root.display());
    let result = std::process::Command::new("java")
        .args(["-cp", &runtime, "RedactionHarness"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "redaction runtime assertions failed (raw output withheld)"
    );
    assert_eq!(
        String::from_utf8(result.stdout).unwrap().trim(),
        "redaction runtime checks passed"
    );
}

#[test]
fn remediation_request_diagnostics_do_not_advertise_contract_checks() {
    let mut envelope = single_response(json!({"kind": "PRIMITIVE", "scalar": "string"}));
    let mut request = sample_endpoints(&mut envelope)[0].clone();
    request.identity.direction = ContractDirection::Request;
    request.body = Some(
        serde_json::from_value(json!({"kind": "UNKNOWN", "reason": "request body unresolved"}))
            .unwrap(),
    );
    sample_endpoints(&mut envelope).push(request);
    let code = synthesize_junit5(&envelope, None, None).unwrap();
    assert!(code.contains("INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST"));
    assert!(
        !code.contains("[CONTRACT_TEST]"),
        "diagnostic-only methods are not contract checks"
    );
}

#[test]
fn remediation_generated_java_matchers_reject_enum_and_nullable_mutations() {
    let Ok(classpath) = std::env::var("SAJIMORA_JAVA_MATCHER_CLASSPATH") else {
        return;
    };
    let checks = |envelope: &ContractArtifactEnvelope| {
        synthesize_junit5(envelope, None, None)
            .unwrap()
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("result.andExpect(jsonPath(")
                    .map(|rest| format!("        check(jsonPath({rest}\n"))
            })
            .collect::<String>()
    };
    let nullable = checks(&single_response(json!({"kind": "OBJECT", "properties": [{
        "wireName": "count", "type": {"kind": "PRIMITIVE", "scalar": "number"},
        "nullable": true, "optional": false, "validationConstraints": []
    }]})));
    let enums = checks(&single_response(
        json!({"kind": "ENUM", "values": ["OPEN", "CLOSED"]}),
    ));
    let path = checks(&single_response(json!({"kind": "OBJECT", "properties": [{
        "wireName": "a'b\"c\\d\n", "type": {"kind": "PRIMITIVE", "scalar": "string"},
        "nullable": false, "optional": false, "validationConstraints": []
    }]})));
    let harness = r#"
    static String json;
    static class Check {
        Object value;
        org.hamcrest.Matcher<?> matcher;
        Check(Object value, org.hamcrest.Matcher<?> matcher) { this.value = value; this.matcher = matcher; }
        Check isMap() { matcher = org.hamcrest.Matchers.instanceOf(java.util.Map.class); return this; }
        Check isString() { matcher = org.hamcrest.Matchers.instanceOf(String.class); return this; }
    }
    static Check jsonPath(String path) { return new Check(com.jayway.jsonpath.JsonPath.read(json, path), null); }
    static Check jsonPath(String path, org.hamcrest.Matcher<?> matcher) { return new Check(com.jayway.jsonpath.JsonPath.read(json, path), matcher); }
    static void check(Check check) { if (!check.matcher.matches(check.value)) throw new AssertionError("response contract mismatch; raw value withheld"); }
    static void mustFail(Runnable check) {
        boolean failed = false;
        try { check.run(); } catch (AssertionError | com.jayway.jsonpath.PathNotFoundException error) { failed = true; }
        if (!failed) throw new AssertionError("mutation was incorrectly accepted");
    }
"#;
    let methods = format!("    static void nullableChecks() {{\n{nullable}    }}\n    static void enumChecks() {{\n{enums}    }}\n    static void pathChecks() {{\n{path}    }}\n");
    let main = r#"
    public static void main(String[] args) {
        json = "{\"count\":null}"; nullableChecks();
        json = "{\"count\":7}"; nullableChecks();
        json = "{\"count\":\"wrong\"}"; mustFail(() -> nullableChecks());
        json = "{}"; mustFail(() -> nullableChecks());
        json = "\"OPEN\""; enumChecks();
        json = "\"not-a-member\""; mustFail(() -> enumChecks());
        json = "{\"a'b\\\"c\\\\d\\n\":\"valid\"}"; pathChecks();
        System.out.println("enum nullable and literal-path runtime checks passed");
    }
"#;
    let root = std::env::temp_dir().join(format!(
        "sajimora-java-matchers-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("MatcherHarness.java");
    fs::write(
        &source,
        format!("public class MatcherHarness {{\n{harness}{methods}{main}\n}}"),
    )
    .unwrap();
    let compiled = std::process::Command::new("javac")
        .args(["--release", "8", "-cp", &classpath])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "generated matcher Java 8 compilation failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let separator = if cfg!(windows) { ';' } else { ':' };
    let runtime = format!("{}{separator}{classpath}", root.display());
    let result = std::process::Command::new("java")
        .args(["-cp", &runtime, "MatcherHarness"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "generated matcher runtime checks failed (raw output withheld); workspace={}",
        root.display()
    );
    assert_eq!(
        String::from_utf8(result.stdout).unwrap().trim(),
        "enum nullable and literal-path runtime checks passed"
    );
}

#[test]
fn fast_check_nested_array_and_deep_entity_projections() {
    let envelope = single_response(json!({
        "kind": "ARRAY",
        "elementType": {
            "kind": "OBJECT",
            "properties": [
                {
                    "wireName": "id",
                    "type": {"kind": "PRIMITIVE", "scalar": "number"},
                    "nullable": false,
                    "optional": false,
                    "validationConstraints": []
                },
                {
                    "wireName": "name",
                    "type": {"kind": "PRIMITIVE", "scalar": "string"},
                    "nullable": false,
                    "optional": false,
                    "validationConstraints": []
                }
            ]
        }
    }));
    let ts_code = synthesize_fast_check(&envelope, Some("Deep Array Test")).unwrap();
    assert!(
        ts_code.contains(r#"Array.isArray(v) && v.every((e: unknown) => isRecord(e) && typeof e["id"] === 'number' && typeof e["name"] === 'string')"#),
        "{}",
        ts_code
    );
}

#[test]
fn fast_check_deep_nested_nullable_and_array_validation() {
    let envelope = single_response(json!({
        "kind": "OBJECT",
        "properties": [
            {
                "wireName": "author",
                "type": {
                    "kind": "OBJECT",
                    "properties": [
                        {
                            "wireName": "bio",
                            "type": {"kind": "PRIMITIVE", "scalar": "string"},
                            "nullable": true,
                            "optional": false,
                            "validationConstraints": []
                        }
                    ]
                },
                "nullable": true,
                "optional": false,
                "validationConstraints": []
            }
        ]
    }));

    let ts_code = synthesize_fast_check(&envelope, Some("Deep Nullable Test")).unwrap();
    assert!(
        ts_code.contains(r#"("bio" in v["author"] && (v["author"]["bio"] === null || typeof v["author"]["bio"] === 'string'))"#),
        "Nested nullable bio property must assert null or string: {}",
        ts_code
    );
}

#[test]
fn test_supertest_synthesis_generates_valid_nestjs_spec() {
    let envelope = single_response(json!({
        "kind": "OBJECT",
        "properties": [
            {
                "wireName": "username",
                "type": {"kind": "PRIMITIVE", "scalar": "string"},
                "nullable": false,
                "optional": false,
                "validationConstraints": []
            }
        ]
    }));

    let code = synthesize_supertest(&envelope, Some("UserController E2E")).unwrap();
    assert!(
        code.contains("import { Test, TestingModule } from '@nestjs/testing';"),
        "{}",
        code
    );
    assert!(
        code.contains("import request from 'supertest';"),
        "{}",
        code
    );
    assert!(
        code.contains("import { AppModule } from '../src/app.module';"),
        "{}",
        code
    );
    assert!(
        code.contains("imports: [AppModule]"),
        "boot the real module: {}",
        code
    );
    assert!(
        code.contains("describe('UserController E2E', () => {"),
        "{}",
        code
    );
    assert!(
        code.contains(
            r#"const response = await request(app.getHttpServer()).get("/api/sample/1");"#
        ),
        "{}",
        code
    );
    assert!(
        code.contains("expect(response.status).toBeGreaterThanOrEqual(200);"),
        "{}",
        code
    );
    assert!(
        code.contains("expect(shape_1(response.body)).toBe(true);"),
        "{}",
        code
    );
}

#[test]
fn recursive_shape_abstains_instead_of_emitting_true() {
    let envelope = single_response_with_pool(
        json!({"kind": "REF", "ref": "Node"}),
        json!({
            "Node": {
                "kind": "OBJECT",
                "properties": [{
                    "wireName": "next",
                    "type": {"kind": "REF", "ref": "Node"},
                    "nullable": false,
                    "optional": false,
                    "validationConstraints": []
                }]
            }
        }),
    );

    let code = synthesize_fast_check(&envelope, Some("Recursive")).unwrap();
    assert!(
        !code.contains("const shape_"),
        "recursive shape must abstain, got:\n{code}"
    );
    assert!(
        code.contains("ABSTAIN") || code.contains("contract resolves no checkable field"),
        "expected an explicit abstention:\n{code}"
    );
}

#[test]
fn unresolved_ref_shape_abstains_instead_of_skipping_the_property() {
    let envelope = single_response_with_pool(
        json!({
            "kind": "OBJECT",
            "properties": [{
                "wireName": "child",
                "type": {"kind": "REF", "ref": "MissingDto"},
                "nullable": false,
                "optional": false,
                "validationConstraints": []
            }]
        }),
        json!({}),
    );

    let code = synthesize_fast_check(&envelope, Some("Missing Ref")).unwrap();
    assert!(
        !code.contains("const shape_"),
        "unresolved ref must abstain, got:\n{code}"
    );
    assert!(
        code.contains("ABSTAIN") || code.contains("contract resolves no checkable field"),
        "expected an explicit abstention:\n{code}"
    );
}
