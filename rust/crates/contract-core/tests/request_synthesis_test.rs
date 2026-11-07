use contract_core::ir::*;
use contract_core::request_synthesis::{
    synthesize_request, validate_fixtures, AuthenticationFixture, EndpointRequestFixture,
    RequestFixtures, SynthesizedRequest,
};
use contract_core::routes::normalize_route_segments;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn primitive(scalar: &str) -> WireType {
    serde_json::from_value(json!({"kind": "PRIMITIVE", "scalar": scalar})).unwrap()
}

fn reference(name: &str) -> WireType {
    serde_json::from_value(json!({"kind": "REF", "ref": name})).unwrap()
}

fn literal(value: Value) -> WireType {
    serde_json::from_value(json!({"kind": "LITERAL", "value": value})).unwrap()
}

fn array(element: WireType) -> WireType {
    WireType::Array(ArrayWireType {
        element_type: Box::new(element),
        is_stream_or_flux: None,
        provenance: None,
    })
}

fn nullable(inner: WireType) -> WireType {
    WireType::Nullable(NullableWireType {
        inner_type: Box::new(inner),
        provenance: None,
    })
}

fn optional(inner: WireType) -> WireType {
    WireType::Optional(OptionalWireType {
        inner_type: Box::new(inner),
        provenance: None,
    })
}

fn union(types: Vec<WireType>) -> WireType {
    WireType::Union(UnionWireType {
        types,
        provenance: None,
    })
}

fn enumeration(values: Vec<Value>) -> WireType {
    WireType::Enum(EnumWireType {
        name: None,
        values,
        provenance: None,
    })
}

fn constraint(kind: ValidationConstraintKind, value: Option<Value>) -> ValidationConstraint {
    ValidationConstraint {
        kind,
        value,
        message: None,
        provenance: None,
    }
}

fn property(name: &str, wire: WireType) -> WirePropertyContract {
    WirePropertyContract {
        wire_name: name.to_string(),
        r#type: wire,
        optional: false,
        nullable: false,
        server_assigned: false,
        validation_constraints: vec![],
        provenance: None,
        aliases: vec![],
    }
}

fn constrained_property(
    name: &str,
    wire: WireType,
    constraints: Vec<ValidationConstraint>,
) -> WirePropertyContract {
    let mut property = property(name, wire);
    property.validation_constraints = constraints;
    property
}

fn object(properties: Vec<WirePropertyContract>) -> WireType {
    WireType::Object(ObjectWireType {
        name: None,
        properties,
        strict: None,
        provenance: None,
    })
}

fn param(name: &str, wire: WireType, required: bool) -> ParamContract {
    ParamContract {
        name: name.to_string(),
        r#type: wire,
        required,
        validation_constraints: None,
        provenance: None,
    }
}

fn endpoint(direction: &str, method: &str, path: &str, body: Option<WireType>) -> EndpointContract {
    serde_json::from_value(json!({
        "identity": {
            "service": "inventory",
            "httpMethod": method,
            "normalizedRoute": normalize_route_segments(path),
            "direction": direction
        },
        "pathParameters": [], "queryParameters": [], "headers": [],
        "body": body,
        "provenance": {"language": "JAVA", "file": "Controller.java", "line": 1}
    }))
    .unwrap()
}

fn sampled(
    wire: WireType,
    pool: Option<&BTreeMap<String, WireType>>,
) -> anyhow::Result<SynthesizedRequest> {
    let response = endpoint("RESPONSE", "POST", "/items", Some(primitive("number")));
    let request = endpoint("REQUEST", "POST", "/items", Some(wire));
    synthesize_request(&response, &[request], pool, None)
}

fn fixture_for(response: &EndpointContract, fixture: EndpointRequestFixture) -> RequestFixtures {
    RequestFixtures {
        endpoints: BTreeMap::from([(
            format!(
                "{} {}",
                response.identity.http_method, response.identity.normalized_route.raw_path
            ),
            fixture,
        )]),
        ..Default::default()
    }
}

fn synthesis_error(wire: WireType, pool: Option<&BTreeMap<String, WireType>>) -> String {
    format!("{:#}", sampled(wire, pool).unwrap_err())
}

#[test]
fn fixture_schema_defaults_camel_case_and_rejects_unknown_fields() {
    let fixtures: RequestFixtures = serde_json::from_value(json!({})).unwrap();
    assert!(!fixtures.transactional);
    assert!(fixtures.endpoints.is_empty());
    assert!(fixtures.setup_sql.is_empty());
    assert!(fixtures.cleanup_sql.is_empty());
    assert!(fixtures.authentication.is_none());
    for value in [
        json!({"transaction": true}),
        json!({"setup_sql": []}),
        json!({"authentication": {"username": "user", "password": "secret"}}),
        json!({"endpoints": {"POST /items": {"queryParamters": {}}}}),
        json!({"endpoints": {"POST /items": {"authentication": {"userName": "user"}}}}),
        json!({"setupSql": [12]}),
    ] {
        assert!(serde_json::from_value::<RequestFixtures>(value).is_err());
    }
    let fixture: EndpointRequestFixture = serde_json::from_value(json!({
        "queryParameters": {"page": "1"},
        "headersFromEnv": {"Authorization": "LOCAL_TOKEN"},
        "expectedStatus": 201
    }))
    .unwrap();
    assert_eq!(fixture.query_parameters["page"], "1");
    assert_eq!(fixture.expected_status, Some(201));
    let serialized = serde_json::to_value(fixture).unwrap();
    assert!(serialized.get("headersFromEnv").is_some());
    assert!(serialized.get("body").is_none());
}

#[test]
fn explicit_json_bodies_preserve_scalars_null_and_empty_objects() {
    let response = endpoint("RESPONSE", "POST", "/items", Some(primitive("number")));
    let request = endpoint("REQUEST", "POST", "/items", Some(reference("missing")));
    for value in [
        json!("configured"),
        json!(7),
        json!(true),
        Value::Null,
        json!({}),
        json!([]),
    ] {
        let fixture: EndpointRequestFixture =
            serde_json::from_value(json!({"body": value})).unwrap();
        assert_eq!(fixture.body, Some(value.clone()));
        let round_trip: EndpointRequestFixture =
            serde_json::from_value(serde_json::to_value(&fixture).unwrap()).unwrap();
        assert_eq!(round_trip.body, Some(value.clone()));
        let result =
            synthesize_request(&response, &[request.clone()], None, Some(&fixture)).unwrap();
        assert_eq!(result.body, Some(value));
        assert!(result
            .evidence
            .iter()
            .any(|note| note.contains("explicit fixture: request body")));
        assert!(!result
            .evidence
            .iter()
            .any(|note| note.contains("schema sample: body")));
    }
}

#[test]
fn deterministic_nested_objects_references_enums_literals_arrays_and_nullable() {
    let mut skipped = property("optionalCycle", reference("Nested"));
    skipped.optional = true;
    let mut nullable_property = property("nullableFlag", nullable(primitive("boolean")));
    nullable_property.nullable = true;
    let nested = object(vec![
        property("name", primitive("string")),
        property("count", primitive("number")),
        property("big", primitive("bigint")),
        property(
            "state",
            enumeration(vec![json!("DEFINED_FIRST"), json!("SECOND")]),
        ),
        property("tag", literal(json!("fixed"))),
        property("boolLiteral", literal(json!(false))),
        property("numberLiteral", literal(json!(3))),
        property("empty", array(reference("Nested"))),
        property("optionalType", optional(primitive("any"))),
        nullable_property,
        skipped,
    ]);
    let pool = BTreeMap::from([("Nested".to_string(), nested)]);
    let wire = object(vec![
        property("a", reference("Nested")),
        property("b", reference("Nested")),
    ]);
    let result = sampled(wire.clone(), Some(&pool)).unwrap();
    let expected = json!({
        "name": "sajimora", "count": 1, "big": 1, "state": "DEFINED_FIRST",
        "tag": "fixed", "boolLiteral": false, "numberLiteral": 3,
        "empty": [], "nullableFlag": true
    });
    assert_eq!(result.body, Some(json!({"a": expected, "b": expected})));
    assert_eq!(result, sampled(wire, Some(&pool)).unwrap());
    assert!(result
        .evidence
        .iter()
        .any(|note| note.contains("not evidence of domain validity")));
}

#[test]
fn constraints_generate_bounded_nonblank_email_numbers_and_nonempty_arrays() {
    use ValidationConstraintKind::*;
    let wire = object(vec![
        constrained_property(
            "email",
            nullable(primitive("string")),
            vec![
                constraint(NotNull, None),
                constraint(NotBlank, None),
                constraint(Email, None),
            ],
        ),
        constrained_property(
            "minimum",
            primitive("number"),
            vec![
                constraint(Min, Some(json!(5))),
                constraint(Max, Some(json!(9))),
            ],
        ),
        constrained_property(
            "maximum",
            primitive("number"),
            vec![constraint(Max, Some(json!(-2)))],
        ),
        constrained_property(
            "long",
            primitive("string"),
            vec![constraint(Size, Some(json!({"min": 10, "max": 12})))],
        ),
        constrained_property(
            "short",
            primitive("string"),
            vec![constraint(Size, Some(json!({"max": 3})))],
        ),
        constrained_property(
            "emptyString",
            primitive("string"),
            vec![constraint(Size, Some(json!({"max": 0})))],
        ),
        constrained_property(
            "list",
            array(primitive("boolean")),
            vec![
                constraint(NotEmpty, None),
                constraint(Size, Some(json!({"min": 2, "max": 3}))),
            ],
        ),
        constrained_property(
            "one",
            array(literal(json!("element"))),
            vec![constraint(NotEmpty, None)],
        ),
        constrained_property(
            "enum",
            enumeration(vec![json!(0), json!(2)]),
            vec![constraint(Min, Some(json!(1)))],
        ),
    ]);
    assert_eq!(
        sampled(wire, None).unwrap().body,
        Some(json!({
            "email": "sajimora@example.test", "minimum": 5, "maximum": -2,
            "long": "sajimorass", "short": "saj", "emptyString": "",
            "list": [true, true], "one": ["element"], "enum": 2
        }))
    );
}

#[test]
fn contradictions_unsupported_constraints_and_size_budgets_fail_closed() {
    use ValidationConstraintKind::*;
    let cases = vec![
        (
            primitive("number"),
            vec![
                constraint(Min, Some(json!(5))),
                constraint(Max, Some(json!(3))),
            ],
        ),
        (primitive("number"), vec![constraint(Min, None)]),
        (primitive("number"), vec![constraint(Max, Some(json!(1.5)))]),
        (primitive("boolean"), vec![constraint(Min, Some(json!(1)))]),
        (
            primitive("string"),
            vec![constraint(Size, Some(json!({"min": 4, "max": 2})))],
        ),
        (
            primitive("string"),
            vec![
                constraint(NotBlank, None),
                constraint(Size, Some(json!({"max": 0}))),
            ],
        ),
        (
            primitive("string"),
            vec![
                constraint(Email, None),
                constraint(Size, Some(json!({"max": 4}))),
            ],
        ),
        (primitive("string"), vec![constraint(Size, Some(json!(5)))]),
        (
            primitive("string"),
            vec![constraint(Size, Some(json!({"min": -1})))],
        ),
        (
            primitive("string"),
            vec![constraint(Size, Some(json!({"exact": 3})))],
        ),
        (
            primitive("string"),
            vec![constraint(Size, Some(json!({"min": 5000})))],
        ),
        (
            primitive("number"),
            vec![constraint(Min, Some(json!(2_000_000_000)))],
        ),
        (
            array(primitive("string")),
            vec![constraint(Size, Some(json!({"min": 257})))],
        ),
        (
            array(primitive("string")),
            vec![
                constraint(NotEmpty, None),
                constraint(Size, Some(json!({"max": 0}))),
            ],
        ),
        (literal(json!(0)), vec![constraint(Min, Some(json!(1)))]),
        (object(vec![]), vec![constraint(NotEmpty, None)]),
    ];
    for (wire, constraints) in cases {
        assert!(sampled(
            object(vec![constrained_property("value", wire, constraints)]),
            None
        )
        .is_err());
    }
}

#[test]
fn union_constraints_apply_to_every_selected_branch_and_pattern_is_never_certified() {
    use ValidationConstraintKind::*;
    let constrained = constrained_property(
        "choice",
        union(vec![literal(json!(0)), primitive("number")]),
        vec![
            constraint(Min, Some(json!(2))),
            constraint(Max, Some(json!(4))),
        ],
    );
    assert_eq!(
        sampled(object(vec![constrained]), None).unwrap().body,
        Some(json!({"choice": 2}))
    );
    let pattern = constrained_property(
        "choice",
        union(vec![primitive("string"), literal(json!("sajimora"))]),
        vec![constraint(Pattern, Some(json!(".*")))],
    );
    assert!(synthesis_error(object(vec![pattern]), None).contains("Pattern"));
    assert!(sampled(union(vec![]), None).is_err());
    assert!(sampled(union(vec![primitive("any"), primitive("void")]), None).is_err());
}

#[test]
fn defined_null_literals_are_not_guesses_and_nonnull_union_enum_values_are_preferred() {
    assert_eq!(
        sampled(literal(Value::Null), None).unwrap().body,
        Some(Value::Null)
    );
    assert_eq!(
        sampled(
            nullable(union(vec![literal(Value::Null), primitive("string")])),
            None
        )
        .unwrap()
        .body,
        Some(json!("sajimora"))
    );
    assert_eq!(
        sampled(enumeration(vec![Value::Null, json!("defined")]), None)
            .unwrap()
            .body,
        Some(json!("defined"))
    );
    let not_null_literal = object(vec![constrained_property(
        "required",
        literal(Value::Null),
        vec![constraint(ValidationConstraintKind::NotNull, None)],
    )]);
    assert!(sampled(not_null_literal, None).is_err());
}

#[test]
fn required_cycles_unresolved_references_any_unknown_and_void_are_errors() {
    for wire in [
        primitive("any"),
        primitive("void"),
        reference("missing"),
        nullable(reference("missing")),
        WireType::Unknown(UnknownWireType {
            reason: "unresolved DTO".to_string(),
            provenance: None,
        }),
        enumeration(vec![]),
    ] {
        assert!(sampled(wire, None).is_err());
    }
    let pool = BTreeMap::from([(
        "Loop".to_string(),
        object(vec![property("next", reference("Loop"))]),
    )]);
    assert!(synthesis_error(reference("Loop"), Some(&pool)).contains("required reference cycle"));
    assert!(synthesis_error(reference("missing"), Some(&pool)).contains("unresolved reference"));
    let nullable_pool = BTreeMap::from([("Loop".to_string(), nullable(reference("Loop")))]);
    assert!(sampled(reference("Loop"), Some(&nullable_pool)).is_err());
    let nonempty_any = object(vec![constrained_property(
        "list",
        array(primitive("any")),
        vec![constraint(ValidationConstraintKind::NotEmpty, None)],
    )]);
    assert!(sampled(nonempty_any, None).is_err());
    assert_eq!(
        sampled(optional(reference("missing")), None).unwrap().body,
        None
    );
}

#[test]
fn exact_request_matching_uses_service_method_raw_path_and_conditions() {
    let mut response = endpoint("RESPONSE", "POST", "/items/{id}", Some(primitive("number")));
    response.mapping_conditions = Some(json!({"consumes": ["application/json"]}));
    let mut matching = endpoint(
        "REQUEST",
        "POST",
        "/items/{id}",
        Some(literal(json!("matched"))),
    );
    matching.mapping_conditions = response.mapping_conditions.clone();
    let mut other_service = matching.clone();
    other_service.identity.service = Some("other".to_string());
    let mut other_method = matching.clone();
    other_method.identity.http_method = "post".to_string();
    let mut other_path = matching.clone();
    other_path.identity.normalized_route = normalize_route_segments("/items/{otherName}");
    let mut other_conditions = matching.clone();
    other_conditions.mapping_conditions = Some(json!({"consumes": ["text/plain"]}));
    let mismatches = vec![other_service, other_method, other_path, other_conditions];
    assert_eq!(
        synthesize_request(&response, &mismatches, None, None)
            .unwrap()
            .body,
        None
    );
    let mut records = mismatches;
    records.push(matching);
    assert_eq!(
        synthesize_request(&response, &records, None, None)
            .unwrap()
            .body,
        Some(json!("matched"))
    );
}

#[test]
fn root_level_string_body_is_marked_raw_text_and_requires_a_string_fixture() {
    let response = endpoint("RESPONSE", "POST", "/reset", None);
    let request = endpoint("REQUEST", "POST", "/reset", Some(primitive("string")));
    let sampled =
        synthesize_request(&response, std::slice::from_ref(&request), None, None).unwrap();
    assert!(sampled.raw_text_body);
    assert!(sampled.body.as_ref().is_some_and(Value::is_string));

    let fixture = EndpointRequestFixture {
        body: Some(json!("admin@example.com")),
        ..Default::default()
    };
    let explicit = synthesize_request(
        &response,
        std::slice::from_ref(&request),
        None,
        Some(&fixture),
    )
    .unwrap();
    assert!(explicit.raw_text_body);
    assert_eq!(explicit.body, Some(json!("admin@example.com")));

    let malformed = EndpointRequestFixture {
        body: Some(json!({"email": "admin@example.com"})),
        ..Default::default()
    };
    let error = synthesize_request(
        &response,
        std::slice::from_ref(&request),
        None,
        Some(&malformed),
    )
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("root-level String parameter must be a JSON string"));

    let object_request = endpoint(
        "REQUEST",
        "POST",
        "/reset",
        Some(object(vec![property("email", primitive("string"))])),
    );
    assert!(
        !synthesize_request(&response, &[object_request], None, None)
            .unwrap()
            .raw_text_body
    );

    let temporal = WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::String,
        format: Some(PrimitiveFormat::DateTime),
        provenance: None,
    });
    let temporal_request = endpoint("REQUEST", "POST", "/reset", Some(temporal));
    assert!(
        !synthesize_request(&response, &[temporal_request], None, None)
            .unwrap()
            .raw_text_body
    );
}

#[test]
fn ambiguous_request_records_fail_even_with_explicit_body() {
    let response = endpoint("RESPONSE", "POST", "/items", Some(primitive("number")));
    let first = endpoint("REQUEST", "POST", "/items", Some(literal(json!("first"))));
    let second = endpoint("REQUEST", "POST", "/items", Some(literal(json!("second"))));
    let fixture = EndpointRequestFixture {
        body: Some(json!({})),
        ..Default::default()
    };
    let error = synthesize_request(&response, &[first, second], None, Some(&fixture)).unwrap_err();
    assert!(error
        .to_string()
        .contains("insufficient evidence: ambiguous REQUEST"));
    let request = endpoint("REQUEST", "GET", "/items", None);
    assert!(synthesize_request(&request, &[], None, None).is_err());
}

#[test]
fn no_request_record_never_invents_a_body_from_http_verb_or_response_schema() {
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
        let response = endpoint("RESPONSE", method, "/items", Some(primitive("any")));
        let result = synthesize_request(&response, &[], None, None).unwrap();
        assert_eq!(result.body, None);
        assert!(result
            .evidence
            .iter()
            .any(|note| note.contains("no body invented")));
    }
}

#[test]
fn response_metadata_fallback_required_params_only_and_static_raw_path_preserved() {
    let mut response = endpoint("RESPONSE", "GET", "/api//users/{id}/", None);
    response.path_parameters = vec![param("id", primitive("number"), true)];
    response.query_parameters = vec![
        param("q", primitive("string"), true),
        param("optional", primitive("any"), false),
    ];
    response.headers = vec![
        param("X-Required", primitive("boolean"), true),
        param("X-Optional", primitive("any"), false),
    ];
    let result = synthesize_request(&response, &[], None, None).unwrap();
    assert_eq!(result.path, "/api//users/1/");
    assert_eq!(
        result.query_parameters,
        BTreeMap::from([("q".to_string(), "sajimora".to_string())])
    );
    assert_eq!(
        result.headers,
        BTreeMap::from([("X-Required".to_string(), "true".to_string())])
    );
    assert!(result
        .evidence
        .iter()
        .any(|note| note.contains("schema sample: path")
            && note.contains("not proof of entity existence")));
}

#[test]
fn explicit_params_override_required_schema_and_env_headers_are_not_read() {
    let mut response = endpoint("RESPONSE", "GET", "/items/{id}", None);
    response.path_parameters = vec![param("id", primitive("any"), true)];
    response.query_parameters = vec![
        param("q", primitive("any"), true),
        param("extra", primitive("any"), false),
    ];
    response.headers = vec![
        param("Authorization", primitive("any"), true),
        param("X-Direct", primitive("any"), true),
    ];
    let fixture = EndpointRequestFixture {
        path_parameters: BTreeMap::from([("id".to_string(), "configured-id".to_string())]),
        query_parameters: BTreeMap::from([
            ("q".to_string(), "fixture".to_string()),
            ("extra".to_string(), "included".to_string()),
        ]),
        headers: BTreeMap::from([("x-direct".to_string(), "direct".to_string())]),
        headers_from_env: BTreeMap::from([(
            "authorization".to_string(),
            "SAJIMORA_UNREAD_TEST_TOKEN".to_string(),
        )]),
        ..Default::default()
    };
    let result = synthesize_request(&response, &[], None, Some(&fixture)).unwrap();
    assert_eq!(result.path, "/items/configured-id");
    assert_eq!(result.query_parameters, fixture.query_parameters);
    assert_eq!(result.headers, fixture.headers);
    assert_eq!(result.headers_from_env, fixture.headers_from_env);
    assert!(!result
        .evidence
        .iter()
        .any(|note| note.starts_with("schema sample:")));
}

#[test]
fn request_parameter_metadata_takes_precedence_over_response_metadata() {
    let mut response = endpoint("RESPONSE", "POST", "/items/{id}", None);
    response.path_parameters = vec![param("id", primitive("any"), true)];
    response.query_parameters = vec![param("responseOnly", primitive("any"), true)];
    let mut request = endpoint("REQUEST", "POST", "/items/{id}", Some(primitive("string")));
    request.path_parameters = vec![param("id", primitive("number"), true)];
    request.query_parameters = vec![param("requestOnly", primitive("number"), true)];
    let result = synthesize_request(&response, &[request], None, None).unwrap();
    assert_eq!(result.path, "/items/1");
    assert_eq!(
        result.query_parameters,
        BTreeMap::from([("requestOnly".to_string(), "1".to_string())])
    );
}

#[test]
fn mapping_only_equality_selectors_accept_fixtures_and_autofill_without_mutation() {
    let mut response = endpoint("RESPONSE", "GET", "/items", None);
    response.mapping_conditions = Some(json!({"params": ["view=full"], "complete": true}));
    let mut request = endpoint("REQUEST", "GET", "/items", None);
    request.mapping_conditions = response.mapping_conditions.clone();
    let records = [response.clone(), request];
    let fixture = EndpointRequestFixture {
        query_parameters: BTreeMap::from([("view".to_string(), "full".to_string())]),
        ..Default::default()
    };
    validate_fixtures(&fixture_for(&response, fixture.clone()), &records).unwrap();
    let explicit = synthesize_request(&response, &records, None, Some(&fixture)).unwrap();
    assert_eq!(explicit.query_parameters, fixture.query_parameters);
    assert!(explicit
        .evidence
        .iter()
        .any(|note| note.contains("explicit fixture: query parameter view")));
    assert!(!explicit
        .evidence
        .iter()
        .any(|note| note.contains("params equality")));

    let missing = EndpointRequestFixture::default();
    validate_fixtures(&fixture_for(&response, missing.clone()), &records).unwrap();
    let filled = synthesize_request(&response, &records, None, Some(&missing)).unwrap();
    assert_eq!(filled.query_parameters, fixture.query_parameters);
    assert!(filled
        .evidence
        .iter()
        .any(|note| note.contains("mappingConditions params equality")));
    assert!(missing.query_parameters.is_empty());
    assert_eq!(
        filled,
        synthesize_request(&response, &records, None, None).unwrap()
    );

    response.query_parameters = vec![param("view", primitive("any"), true)];
    assert_eq!(
        synthesize_request(&response, &[], None, None)
            .unwrap()
            .query_parameters,
        fixture.query_parameters
    );
}

#[test]
fn presence_selectors_sample_bound_parameters_and_route_only_names() {
    let mut response = endpoint("RESPONSE", "GET", "/items", None);
    response.mapping_conditions = Some(
        json!({"params": ["routeOnly", "count", "label", "flag", "flag!=false"], "complete": true}),
    );
    response.query_parameters = vec![param("count", primitive("any"), true)];
    let mut request = endpoint("REQUEST", "GET", "/items", None);
    request.mapping_conditions = response.mapping_conditions.clone();
    let mut count = param("count", primitive("number"), false);
    count.validation_constraints = Some(vec![constraint(
        ValidationConstraintKind::Min,
        Some(json!(5)),
    )]);
    let mut label = param("label", primitive("string"), false);
    label.validation_constraints = Some(vec![constraint(
        ValidationConstraintKind::Size,
        Some(json!({"max": 3})),
    )]);
    request.query_parameters = vec![count, label, param("flag", primitive("boolean"), true)];
    let records = [response.clone(), request];
    let result = synthesize_request(&response, &records, None, None).unwrap();
    assert_eq!(
        result.query_parameters,
        BTreeMap::from([
            ("count".to_string(), "5".to_string()),
            ("flag".to_string(), "true".to_string()),
            ("label".to_string(), "saj".to_string()),
            ("routeOnly".to_string(), "sajimora".to_string()),
        ])
    );
    assert!(result
        .evidence
        .iter()
        .any(|note| note.contains("schema sample:")
            && note.contains("presence query parameter routeOnly")));
    let fixture = EndpointRequestFixture {
        query_parameters: BTreeMap::from([
            ("count".to_string(), "42".to_string()),
            ("flag".to_string(), "true".to_string()),
            ("label".to_string(), "set".to_string()),
            ("routeOnly".to_string(), String::new()),
        ]),
        ..Default::default()
    };
    validate_fixtures(&fixture_for(&response, fixture.clone()), &records).unwrap();
    let explicit = synthesize_request(&response, &records, None, Some(&fixture)).unwrap();
    assert_eq!(explicit.query_parameters, fixture.query_parameters);
    assert!(!explicit
        .evidence
        .iter()
        .any(|note| note.starts_with("schema sample:")));
}

#[test]
fn negative_selectors_satisfy_absence_without_sampling_optional_parameters() {
    let mut response = endpoint("RESPONSE", "GET", "/items", None);
    response.mapping_conditions = Some(
        json!({"params": ["!hidden", "mode!=disabled", "routeOnly!=blocked", "!absentOnly", "absentOnly!=x"], "complete": true}),
    );
    response.query_parameters = vec![
        param("hidden", primitive("any"), false),
        param("mode", primitive("any"), false),
        param("absentOnly", primitive("any"), false),
    ];
    let result = synthesize_request(&response, &[], None, None).unwrap();
    assert!(result.query_parameters.is_empty());
    assert!(!result
        .evidence
        .iter()
        .any(|note| note.starts_with("schema sample:")));
    let fixture = EndpointRequestFixture {
        query_parameters: BTreeMap::from([
            ("mode".to_string(), "enabled".to_string()),
            ("routeOnly".to_string(), "open".to_string()),
        ]),
        ..Default::default()
    };
    validate_fixtures(
        &fixture_for(&response, fixture.clone()),
        &[response.clone()],
    )
    .unwrap();
    assert_eq!(
        synthesize_request(&response, &[], None, Some(&fixture))
            .unwrap()
            .query_parameters,
        fixture.query_parameters
    );
}

#[test]
fn required_query_inequalities_check_samples_and_allow_explicit_satisfying_values() {
    let mut response = endpoint("RESPONSE", "GET", "/items", None);
    response.query_parameters = vec![param("page", primitive("number"), true)];
    response.mapping_conditions = Some(json!({"params": ["page!=0"], "complete": true}));
    assert_eq!(
        synthesize_request(&response, &[], None, None)
            .unwrap()
            .query_parameters["page"],
        "1"
    );
    response.mapping_conditions = Some(json!({"params": ["page!=1"], "complete": true}));
    assert!(synthesize_request(&response, &[], None, None)
        .unwrap_err()
        .to_string()
        .contains("explicit satisfying fixture required"));
    let fixture = EndpointRequestFixture {
        query_parameters: BTreeMap::from([("page".to_string(), "2".to_string())]),
        ..Default::default()
    };
    validate_fixtures(
        &fixture_for(&response, fixture.clone()),
        &[response.clone()],
    )
    .unwrap();
    assert_eq!(
        synthesize_request(&response, &[], None, Some(&fixture))
            .unwrap()
            .query_parameters,
        fixture.query_parameters
    );
    response.mapping_conditions = Some(json!({"params": ["!page"], "complete": true}));
    let missing = EndpointRequestFixture::default();
    let error = synthesize_request(&response, &[], None, Some(&missing)).unwrap_err();
    assert!(error.to_string().contains("insufficient endpoint evidence"));
    assert!(validate_fixtures(&fixture_for(&response, missing), &[response]).is_err());
}

#[test]
fn explicit_query_selector_conflicts_are_rejected_without_mutating_fixtures() {
    for (selectors, name, value) in [
        (json!(["view=full"]), "view", "brief"),
        (json!(["!debug"]), "debug", ""),
        (json!(["mode!=disabled"]), "mode", "disabled"),
        (json!(["mode", "mode!=sajimora"]), "mode", "sajimora"),
    ] {
        let mut response = endpoint("RESPONSE", "GET", "/items", None);
        response.mapping_conditions = Some(json!({"params": selectors, "complete": true}));
        let fixture = EndpointRequestFixture {
            query_parameters: BTreeMap::from([(name.to_string(), value.to_string())]),
            ..Default::default()
        };
        let before = serde_json::to_value(&fixture).unwrap();
        let error = synthesize_request(&response, &[], None, Some(&fixture)).unwrap_err();
        assert!(error.to_string().contains("explicit query parameter"));
        assert!(error.to_string().contains("conflicts"));
        assert!(validate_fixtures(&fixture_for(&response, fixture.clone()), &[response]).is_err());
        assert_eq!(serde_json::to_value(&fixture).unwrap(), before);
    }
}

#[test]
fn malformed_and_contradictory_selectors_are_insufficient_endpoint_evidence() {
    for mapping in [
        json!(["view=full"]),
        json!({"params": "view=full"}),
        json!({"params": null}),
        json!({"params": [12]}),
        json!({"params": [], "complete": "true"}),
        json!({"params": [""]}),
        json!({"params": ["!"]}),
        json!({"params": ["=full"]}),
        json!({"params": ["!=full"]}),
        json!({"params": ["!view=full"]}),
        json!({"params": ["view!!=full"]}),
        json!({"params": ["view!full"]}),
        json!({"params": [" view=full"]}),
        json!({"params": ["view =full"]}),
        json!({"params": ["vi\new=full"]}),
        json!({"params": ["view=bad\nvalue"]}),
        json!({"params": ["view", "!view"]}),
        json!({"params": ["view=full", "!view"]}),
        json!({"params": ["view=full", "view=brief"]}),
        json!({"params": ["view=full", "view!=full"]}),
    ] {
        let mut response = endpoint("RESPONSE", "GET", "/items", None);
        response.mapping_conditions = Some(mapping.clone());
        let error = synthesize_request(&response, &[], None, None).unwrap_err();
        assert!(
            error.to_string().contains("insufficient endpoint evidence"),
            "{mapping}: {error}"
        );
        let fixtures = fixture_for(&response, EndpointRequestFixture::default());
        let error = validate_fixtures(&fixtures, &[response]).unwrap_err();
        assert!(
            format!("{error:#}").contains("insufficient endpoint evidence"),
            "{mapping}: {error:#}"
        );
    }
}

#[test]
fn selector_conjunctions_are_order_independent_and_preserve_exact_equality_values() {
    let mut selectors = vec![
        "view",
        "view!=brief",
        "view=full",
        "view=full",
        "empty=",
        "token=a=b",
    ];
    let mut response = endpoint("RESPONSE", "GET", "/items", None);
    response.mapping_conditions = Some(json!({"params": selectors, "complete": true}));
    let first = synthesize_request(&response, &[], None, None).unwrap();
    assert_eq!(
        first.query_parameters,
        BTreeMap::from([
            ("view".to_string(), "full".to_string()),
            ("empty".to_string(), String::new()),
            ("token".to_string(), "a=b".to_string()),
        ])
    );
    selectors.reverse();
    response.mapping_conditions = Some(json!({"params": selectors, "complete": true}));
    assert_eq!(
        synthesize_request(&response, &[], None, None).unwrap(),
        first
    );
}

#[test]
fn mapping_selector_keys_reject_typos_and_incomplete_conditions_keep_the_limitation() {
    for complete in [true, false] {
        let mut response = endpoint("RESPONSE", "GET", "/items", None);
        response.mapping_conditions = Some(json!({"params": ["view=full"], "complete": complete}));
        let fixture = EndpointRequestFixture {
            query_parameters: BTreeMap::from([("veiw".to_string(), "full".to_string())]),
            ..Default::default()
        };
        assert!(synthesize_request(&response, &[], None, Some(&fixture))
            .unwrap_err()
            .to_string()
            .contains("unknown endpoint query parameter"));
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).is_err());
        let result = synthesize_request(&response, &[], None, None).unwrap();
        assert_eq!(result.query_parameters["view"], "full");
        assert_eq!(
            result
                .evidence
                .iter()
                .any(|note| note.contains("complete=false") && note.contains("not exhaustive")),
            !complete
        );
    }
}

#[test]
fn empty_complete_mapping_params_leave_existing_request_samples_unchanged() {
    let mut response = endpoint("RESPONSE", "GET", "/api//items/{id:[0-9]+}/", None);
    response.path_parameters = vec![param("id", primitive("number"), true)];
    response.query_parameters = vec![
        param("page", primitive("number"), true),
        param("optional", primitive("any"), false),
    ];
    response.headers = vec![param("X-Required", primitive("boolean"), true)];
    let baseline = synthesize_request(&response, &[], None, None).unwrap();
    response.mapping_conditions = Some(json!({"params": [], "complete": true}));
    assert_eq!(
        synthesize_request(&response, &[], None, None).unwrap(),
        baseline
    );
    let fixture = EndpointRequestFixture {
        path_parameters: BTreeMap::from([("id".to_string(), "42".to_string())]),
        query_parameters: BTreeMap::from([("page".to_string(), "7".to_string())]),
        ..Default::default()
    };
    validate_fixtures(
        &fixture_for(&response, fixture.clone()),
        &[response.clone()],
    )
    .unwrap();
    let mapped = synthesize_request(&response, &[], None, Some(&fixture)).unwrap();
    response.mapping_conditions = None;
    assert_eq!(
        synthesize_request(&response, &[], None, Some(&fixture)).unwrap(),
        mapped
    );
}

#[test]
fn route_regex_samples_digits_literals_and_checks_even_explicit_values() {
    for (path, expected) in [
        ("/items/{id:\\d+}", "/items/1"),
        ("/items/{id:[0-9]+}", "/items/1"),
        ("/items/{id:alpha|beta}", "/items/alpha"),
        ("/items/{id:(alpha|beta)}", "/items/alpha"),
        ("/items/{id:^(?:alpha|beta)$}", "/items/alpha"),
    ] {
        let response = endpoint("RESPONSE", "GET", path, None);
        assert_eq!(
            synthesize_request(&response, &[], None, None).unwrap().path,
            expected
        );
        let bad_fixture = EndpointRequestFixture {
            path_parameters: BTreeMap::from([("id".to_string(), "not-matching".to_string())]),
            ..Default::default()
        };
        assert!(synthesize_request(&response, &[], None, Some(&bad_fixture)).is_err());
        assert!(validate_fixtures(&fixture_for(&response, bad_fixture), &[response]).is_err());
    }
    let mut response = endpoint("RESPONSE", "GET", "/items/{id:[0-9]+}", None);
    let mut id = param("id", primitive("number"), true);
    id.validation_constraints = Some(vec![constraint(
        ValidationConstraintKind::Min,
        Some(json!(10)),
    )]);
    response.path_parameters = vec![id];
    assert_eq!(
        synthesize_request(&response, &[], None, None).unwrap().path,
        "/items/10"
    );
    response.path_parameters[0].r#type = primitive("string");
    response.path_parameters[0].validation_constraints = Some(vec![constraint(
        ValidationConstraintKind::Size,
        Some(json!({"min": 2, "max": 2})),
    )]);
    assert_eq!(
        synthesize_request(&response, &[], None, None).unwrap().path,
        "/items/11"
    );
}

#[test]
fn unsupported_route_regex_needs_fixture_and_labels_configured_responsibility() {
    for path in ["/items/{id:[a-z]{2}}", "/items/{id:.*}"] {
        let response = endpoint("RESPONSE", "GET", path, None);
        assert!(synthesize_request(&response, &[], None, None).is_err());
        let fixture = EndpointRequestFixture {
            path_parameters: BTreeMap::from([("id".to_string(), "configured".to_string())]),
            ..Default::default()
        };
        let result = synthesize_request(&response, &[], None, Some(&fixture)).unwrap();
        assert_eq!(result.path, "/items/configured");
        assert!(result
            .evidence
            .iter()
            .any(|note| note.contains("unsupported route regex")
                && note.contains("configured responsibility; not validated")));
        validate_fixtures(&fixture_for(&response, fixture), &[response]).unwrap();
    }
}

#[test]
fn decoded_path_segments_encode_utf8_but_preserve_unreserved_static_paths_and_slashes() {
    let response = endpoint("RESPONSE", "GET", "/api//items%20raw+v1/{id}/", None);
    for (decoded, encoded) in [
        ("red apple", "red%20apple"),
        ("a\"b'c", "a%22b%27c"),
        ("café 東京", "caf%C3%A9%20%E6%9D%B1%E4%BA%AC"),
        ("Az09-._~", "Az09-._~"),
        ("12345", "12345"),
        ("a+b;c:@", "a%2Bb%3Bc%3A%40"),
    ] {
        let fixture = EndpointRequestFixture {
            path_parameters: BTreeMap::from([("id".to_string(), decoded.to_string())]),
            ..Default::default()
        };
        validate_fixtures(
            &fixture_for(&response, fixture.clone()),
            &[response.clone()],
        )
        .unwrap();
        let expected = format!("/api//items%20raw+v1/{encoded}/");
        assert_eq!(
            synthesize_request(&response, &[], None, Some(&fixture))
                .unwrap()
                .path,
            expected
        );
        assert_eq!(fixture.path_parameters["id"], decoded);
        let mut sampled_response = response.clone();
        sampled_response.path_parameters = vec![param("id", literal(json!(decoded)), true)];
        assert_eq!(
            synthesize_request(&sampled_response, &[], None, None)
                .unwrap()
                .path,
            expected
        );
    }
}

#[test]
fn unsafe_explicit_path_values_and_wildcards_are_rejected() {
    let response = endpoint("RESPONSE", "GET", "/items/{id}", None);
    for value in [
        "", ".", "..", "a/b", "a\\b", "a?b", "a#b", "a\nb", "a\rb", "a\tb", "a\0b", "a\u{7f}b",
        "a\u{85}b", "%2e%2e", "%2E%2E", "%2f", "%2F", "%5c", "%5C", "%252e", "%252f", "%25",
        "a%2fb", "a%00b",
    ] {
        let fixture = EndpointRequestFixture {
            path_parameters: BTreeMap::from([("id".to_string(), value.to_string())]),
            ..Default::default()
        };
        assert!(
            synthesize_request(&response, &[], None, Some(&fixture)).is_err(),
            "{value:?}"
        );
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).is_err());
        let mut sampled_response = response.clone();
        sampled_response.path_parameters = vec![param("id", literal(json!(value)), true)];
        assert!(
            synthesize_request(&sampled_response, &[], None, None).is_err(),
            "{value:?}"
        );
    }
    for path in ["/items/*", "/items/**", "/items/prefix*"] {
        let response = endpoint("RESPONSE", "GET", path, None);
        assert!(synthesize_request(&response, &[], None, None)
            .unwrap_err()
            .to_string()
            .contains("wildcard"));
    }
}

#[test]
fn fixture_keys_reject_malformed_unmatched_and_ambiguous_response_identity() {
    let response = endpoint("RESPONSE", "GET", "/items", None);
    for key in [
        "get /items",
        "GET/items",
        "GET  /items",
        "GET items",
        "GET /missing",
        "GET /items\n",
        "GET /items/",
    ] {
        let fixtures = RequestFixtures {
            endpoints: BTreeMap::from([(key.to_string(), EndpointRequestFixture::default())]),
            ..Default::default()
        };
        assert!(
            validate_fixtures(&fixtures, &[response.clone()]).is_err(),
            "{key}"
        );
    }
    let fixtures = fixture_for(&response, EndpointRequestFixture::default());
    let mut other = response.clone();
    other.identity.service = Some("another".to_string());
    assert!(validate_fixtures(&fixtures, &[response.clone(), other])
        .unwrap_err()
        .to_string()
        .contains("ambiguous response"));
    let mut other = response.clone();
    other.mapping_conditions = Some(json!({"params": ["view=full"]}));
    assert!(validate_fixtures(&fixtures, &[response.clone(), other]).is_err());
    validate_fixtures(&fixtures, &[response.clone(), response]).unwrap();
}

#[test]
fn fixture_parameter_typos_are_rejected_when_endpoint_evidence_is_known() {
    let mut response = endpoint("RESPONSE", "GET", "/items/{id}", None);
    response.query_parameters = vec![param("page", primitive("number"), false)];
    for fixture in [
        EndpointRequestFixture {
            path_parameters: BTreeMap::from([("idd".to_string(), "1".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            query_parameters: BTreeMap::from([("paeg".to_string(), "1".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            query_parameters: BTreeMap::from([(String::new(), "1".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            query_parameters: BTreeMap::from([("pa\nge".to_string(), "1".to_string())]),
            ..Default::default()
        },
    ] {
        assert!(validate_fixtures(
            &fixture_for(&response, fixture.clone()),
            &[response.clone()]
        )
        .is_err());
        assert!(synthesize_request(&response, &[], None, Some(&fixture)).is_err());
    }
    response.query_parameters.clear();
    let fixture = EndpointRequestFixture {
        query_parameters: BTreeMap::from([("configuredUnknown".to_string(), "1".to_string())]),
        ..Default::default()
    };
    validate_fixtures(
        &fixture_for(&response, fixture.clone()),
        &[response.clone()],
    )
    .unwrap();
    let request = endpoint("REQUEST", "GET", "/items/{id}", None);
    assert!(validate_fixtures(&fixture_for(&response, fixture), &[response, request]).is_err());
}

#[test]
fn header_token_crlf_env_names_and_case_insensitive_duplicates_are_validated() {
    let response = endpoint("RESPONSE", "GET", "/items", None);
    for fixture in [
        EndpointRequestFixture {
            headers: BTreeMap::from([("Bad Header".to_string(), "ok".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers: BTreeMap::from([("X-Test".to_string(), "a\r\nb".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers: BTreeMap::from([("X-Test".to_string(), "a\rb".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers_from_env: BTreeMap::from([("X-Test".to_string(), "1TOKEN".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers_from_env: BTreeMap::from([("X-Test".to_string(), "TOKEN-NAME".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers: BTreeMap::from([("X-Test".to_string(), "ok".to_string())]),
            headers_from_env: BTreeMap::from([("x-test".to_string(), "TOKEN".to_string())]),
            ..Default::default()
        },
        EndpointRequestFixture {
            headers: BTreeMap::from([
                ("X-Test".to_string(), "one".to_string()),
                ("x-test".to_string(), "two".to_string()),
            ]),
            ..Default::default()
        },
    ] {
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).is_err());
    }
    let fixture = EndpointRequestFixture {
        headers: BTreeMap::from([("X-Token_Valid".to_string(), "value".to_string())]),
        headers_from_env: BTreeMap::from([(
            "Authorization".to_string(),
            "_LOCAL_TOKEN2".to_string(),
        )]),
        ..Default::default()
    };
    validate_fixtures(&fixture_for(&response, fixture), &[response]).unwrap();
}

#[test]
fn status_range_and_204_never_disable_nonvoid_or_unresolved_body_assertions() {
    let response = endpoint("RESPONSE", "GET", "/items", Some(primitive("string")));
    for status in [0, 199, 204, 300, 404, 500] {
        let fixture = EndpointRequestFixture {
            expected_status: Some(status),
            ..Default::default()
        };
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).is_err());
    }
    for status in [200, 201, 202, 299] {
        let fixture = EndpointRequestFixture {
            expected_status: Some(status),
            ..Default::default()
        };
        validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).unwrap();
    }
    for body in [
        None,
        Some(primitive("void")),
        Some(optional(nullable(primitive("void")))),
    ] {
        let response = endpoint("RESPONSE", "DELETE", "/items", body);
        let fixture = EndpointRequestFixture {
            expected_status: Some(204),
            ..Default::default()
        };
        validate_fixtures(&fixture_for(&response, fixture), &[response]).unwrap();
    }
    for body in [
        reference("unresolved"),
        nullable(primitive("string")),
        union(vec![primitive("void"), primitive("string")]),
    ] {
        let response = endpoint("RESPONSE", "GET", "/items", Some(body));
        let fixture = EndpointRequestFixture {
            expected_status: Some(204),
            ..Default::default()
        };
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response]).is_err());
    }
}

#[test]
fn authentication_session_scalars_and_transactional_sql_validation() {
    let response = endpoint("RESPONSE", "GET", "/items", None);
    for username in ["", "  \n\t"] {
        let mut fixtures = RequestFixtures {
            authentication: Some(AuthenticationFixture {
                username: username.to_string(),
            }),
            ..Default::default()
        };
        assert!(validate_fixtures(&fixtures, &[]).is_err());
        let endpoint_fixture = EndpointRequestFixture {
            authentication: fixtures.authentication.take(),
            ..Default::default()
        };
        assert!(validate_fixtures(
            &fixture_for(&response, endpoint_fixture),
            &[response.clone()]
        )
        .is_err());
    }
    for value in [
        Value::Null,
        json!({"nested": true}),
        json!([]),
        json!(u64::MAX),
    ] {
        let fixture = EndpointRequestFixture {
            session_attributes: BTreeMap::from([("attr".to_string(), value)]),
            ..Default::default()
        };
        assert!(validate_fixtures(&fixture_for(&response, fixture), &[response.clone()]).is_err());
    }
    let fixture = EndpointRequestFixture {
        authentication: Some(AuthenticationFixture {
            username: "endpoint-user".to_string(),
        }),
        session_attributes: BTreeMap::from([
            ("text".to_string(), json!("configured")),
            ("flag".to_string(), json!(true)),
            ("long".to_string(), json!(i64::MAX)),
            ("negative".to_string(), json!(-7)),
            ("decimal".to_string(), json!(1.5)),
        ]),
        setup_sql: vec!["INSERT INTO items (id) VALUES (1)".to_string()],
        cleanup_sql: vec!["DELETE FROM items WHERE id = 1".to_string()],
        ..Default::default()
    };
    let mut fixtures = fixture_for(&response, fixture);
    assert!(validate_fixtures(&fixtures, &[response.clone()]).is_err());
    fixtures.transactional = true;
    fixtures.authentication = Some(AuthenticationFixture {
        username: "global-user".to_string(),
    });
    fixtures.setup_sql = vec!["INSERT INTO items (id) VALUES (2)".to_string()];
    fixtures.cleanup_sql = vec!["DELETE FROM items WHERE id = 2".to_string()];
    validate_fixtures(&fixtures, &[response]).unwrap();
    for (setup_sql, cleanup_sql) in [
        (vec!["SELECT 1".to_string()], vec![]),
        (vec![], vec!["SELECT 1".to_string()]),
    ] {
        let fixtures = RequestFixtures {
            setup_sql,
            cleanup_sql,
            ..Default::default()
        };
        assert!(validate_fixtures(&fixtures, &[]).is_err());
    }
}

#[test]
fn bean_validation_password_email_quantity_and_nonempty_array_samples_conform() {
    use ValidationConstraintKind::*;
    let wire = object(vec![
        constrained_property(
            "password",
            primitive("string"),
            vec![
                constraint(Size, Some(json!({"min": 8, "max": 12}))),
                constraint(NotBlank, None),
            ],
        ),
        constrained_property(
            "email",
            primitive("string"),
            vec![constraint(Email, None), constraint(NotBlank, None)],
        ),
        constrained_property(
            "quantity",
            primitive("number"),
            vec![constraint(Positive, None), constraint(Min, Some(json!(5)))],
        ),
        constrained_property(
            "items",
            array(primitive("string")),
            vec![
                constraint(NotEmpty, None),
                constraint(Size, Some(json!({"min": 2, "max": 3}))),
            ],
        ),
    ]);
    let body = sampled(wire, None).unwrap().body.unwrap();
    let password = body["password"].as_str().unwrap();
    assert!((8..=12).contains(&password.len()) && !password.trim().is_empty());
    assert_eq!(body["email"], "sajimora@example.test");
    assert_eq!(body["quantity"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
}

#[test]
fn positive_is_not_fabricated_as_minimum_one_for_fractional_values() {
    let wire = object(vec![constrained_property(
        "price",
        enumeration(vec![json!(0), json!(-1), json!(0.5)]),
        vec![constraint(ValidationConstraintKind::Positive, None)],
    )]);
    assert_eq!(sampled(wire, None).unwrap().body.unwrap()["price"], 0.5);
    assert_eq!(
        serde_json::to_value(ValidationConstraintKind::Positive).unwrap(),
        "POSITIVE"
    );
    let impossible = object(vec![constrained_property(
        "count",
        primitive("number"),
        vec![
            constraint(ValidationConstraintKind::Positive, None),
            constraint(ValidationConstraintKind::Max, Some(json!(0))),
        ],
    )]);
    assert!(sampled(impossible, None).is_err());
}

#[test]
fn supported_pattern_samples_respect_size_and_other_constraints() {
    use ValidationConstraintKind::*;
    let wire = object(vec![
        constrained_property(
            "digits",
            primitive("string"),
            vec![
                constraint(Pattern, Some(json!("^[0-9]+$"))),
                constraint(Size, Some(json!({"min": 8, "max": 8}))),
                constraint(NotBlank, None),
            ],
        ),
        constrained_property(
            "state",
            primitive("string"),
            vec![
                constraint(Pattern, Some(json!("^(active|disabled)$"))),
                constraint(Size, Some(json!({"min": 6}))),
            ],
        ),
    ]);
    let body = sampled(wire, None).unwrap().body.unwrap();
    assert_eq!(body["digits"], "11111111");
    assert_eq!(body["state"], "active");
}

#[test]
fn unsupported_pattern_has_reason_code_and_requires_explicit_fixture() {
    use contract_core::report::ReasonCode;
    let wire = object(vec![constrained_property(
        "password",
        primitive("string"),
        vec![constraint(
            ValidationConstraintKind::Pattern,
            Some(json!("^(?=.{8,}$)(?=.*[A-Z])(?=.*[0-9]).+$")),
        )],
    )]);
    let detail = synthesis_error(wire.clone(), None);
    assert_eq!(
        ReasonCode::classify(&detail),
        Some(ReasonCode::UnsupportedConstruct)
    );
    assert!(detail.contains("--request-fixtures"));
    let response = endpoint("RESPONSE", "POST", "/items", Some(primitive("number")));
    let request = endpoint("REQUEST", "POST", "/items", Some(wire));
    let fixture = EndpointRequestFixture {
        body: Some(json!({"password": "Strong123"})),
        ..Default::default()
    };
    assert_eq!(
        synthesize_request(&response, &[request], None, Some(&fixture))
            .unwrap()
            .body,
        fixture.body
    );
}

#[test]
fn unsupported_runtime_request_never_manufactures_a_payload() {
    use contract_core::report::ReasonCode;
    let wire = WireType::Unknown(UnknownWireType {
        reason: "UNSUPPORTED_CONSTRUCT: @JsonDeserialize(using = Custom.class)".into(),
        provenance: None,
    });
    let detail = synthesis_error(wire, None);
    assert_eq!(
        ReasonCode::classify(&detail),
        Some(ReasonCode::UnsupportedConstruct)
    );
    assert!(detail.contains("JsonDeserialize"));
}

#[test]
fn pattern_length_and_alternative_budgets_fail_closed() {
    use contract_core::report::ReasonCode;
    for pattern in [
        "a".repeat(70_000),
        (0..65).map(|i| i.to_string()).collect::<Vec<_>>().join("|"),
    ] {
        let wire = object(vec![constrained_property(
            "value",
            primitive("string"),
            vec![constraint(
                ValidationConstraintKind::Pattern,
                Some(json!(pattern)),
            )],
        )]);
        let detail = synthesis_error(wire, None);
        assert_eq!(
            ReasonCode::classify(&detail),
            Some(ReasonCode::UnsupportedConstruct)
        );
        assert!(detail.contains("--request-fixtures"));
        assert!(detail.len() < 1000);
    }
}

#[test]
fn positive_and_pattern_allow_null_unless_not_null_is_present() {
    for validation in [
        constraint(ValidationConstraintKind::Positive, None),
        constraint(
            ValidationConstraintKind::Pattern,
            Some(json!("active|disabled")),
        ),
    ] {
        for wire in [literal(Value::Null), enumeration(vec![Value::Null])] {
            let body = object(vec![constrained_property(
                "value",
                wire.clone(),
                vec![validation.clone()],
            )]);
            assert_eq!(
                sampled(body, None).unwrap().body.unwrap()["value"],
                Value::Null
            );
            let body = object(vec![constrained_property(
                "value",
                wire,
                vec![
                    validation.clone(),
                    constraint(ValidationConstraintKind::NotNull, None),
                ],
            )]);
            assert!(sampled(body, None).is_err());
        }
    }
}

#[test]
fn unsupported_reason_code_round_trips_and_wins_over_generic_wording() {
    use contract_core::report::{ReasonCode, ReasonCodeRecord};
    let detail =
        "UNSUPPORTED_CONSTRUCT: generic type declares runtime serialization decides the wire shape";
    assert_eq!(
        ReasonCode::classify(detail),
        Some(ReasonCode::UnsupportedConstruct)
    );
    let record = ReasonCodeRecord::new(ReasonCode::UnsupportedConstruct, detail);
    let json = serde_json::to_value(&record).unwrap();
    assert_eq!(json["code"], "UNSUPPORTED_CONSTRUCT");
    assert_eq!(
        serde_json::from_value::<ReasonCodeRecord>(json).unwrap(),
        record
    );
}

#[test]
fn temporal_scalars_sample_iso_8601_instead_of_a_word() {
    use PrimitiveFormat::*;
    let temporal = |name: &str, format: Option<PrimitiveFormat>| {
        constrained_property(
            name,
            WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format,
                provenance: None,
            }),
            vec![],
        )
    };
    let wire = object(vec![
        temporal("instant", Some(DateTime)),
        temporal("local", Some(LocalDateTime)),
        temporal("date", Some(Date)),
        temporal("time", Some(Time)),
        temporal("plain", None),
    ]);
    let body = sampled(wire, None).unwrap().body.unwrap();
    assert_eq!(body["instant"], "2024-01-01T00:00:00Z");
    assert_eq!(body["local"], "2024-01-01T00:00:00");
    assert_eq!(body["date"], "2024-01-01");
    assert_eq!(body["time"], "00:00:00");
    assert_eq!(
        body["plain"], "sajimora",
        "non-temporal strings keep the generic sample"
    );
}

#[test]
fn temporal_format_round_trips_and_never_changes_wire_compatibility() {
    use PrimitiveFormat::*;
    let instant = WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::String,
        format: Some(DateTime),
        provenance: None,
    });
    let plain = WireType::Primitive(PrimitiveWireType {
        scalar: PrimitiveScalar::String,
        format: None,
        provenance: None,
    });
    assert_eq!(
        instant, plain,
        "format is a representation detail of the same JSON string"
    );
    let json = serde_json::to_value(&instant).unwrap();
    assert_eq!(json["format"], "DATE_TIME");
    let back: WireType = serde_json::from_value(json).unwrap();
    assert_eq!(back, instant);
    let legacy: WireType =
        serde_json::from_value(serde_json::json!({"kind":"PRIMITIVE","scalar":"string"})).unwrap();
    assert_eq!(
        legacy, plain,
        "seals written before the field existed still parse"
    );
}

#[test]
fn unverified_atomic_groups_classes_and_lookarounds_require_fixtures() {
    use ValidationConstraintKind::*;
    let login_regex = r"^(?>[a-zA-Z0-9!$&*+=?^_`{|}~.-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)|(?>[_.@A-Za-z0-9-]+)$";
    for pattern in [login_regex, "^[^0-9]{4}$", "^(?=.*[A-Z]).+$"] {
        let wire = object(vec![constrained_property(
            "value",
            primitive("string"),
            vec![constraint(Pattern, Some(json!(pattern)))],
        )]);
        assert!(sampled(wire, None).is_err());
    }
}

#[test]
fn post_generated_ids_require_fixtures_but_updates_keep_them() {
    let mut id = property("id", primitive("number"));
    id.server_assigned = true;
    let wire = object(vec![id, property("label", primitive("string"))]);
    for method in ["POST", "PUT"] {
        let response = endpoint("RESPONSE", method, "/labels", Some(primitive("string")));
        let request = endpoint("REQUEST", method, "/labels", Some(wire.clone()));
        let synthesized = synthesize_request(&response, &[request], None, None);
        if method == "POST" {
            assert!(format!("{:#}", synthesized.unwrap_err()).contains("ambiguous POST"));
        } else {
            let body = synthesized.unwrap().body.expect("body");
            assert_eq!(body["id"], 1);
            assert_eq!(body["label"], "sajimora");
        }
    }
}

#[test]
fn pattern_uppercase_and_size_cannot_certify_a_lowercase_fallback() {
    let wire = object(vec![constrained_property(
        "code",
        primitive("string"),
        vec![
            constraint(ValidationConstraintKind::Pattern, Some(json!("^[A-Z]+$"))),
            constraint(
                ValidationConstraintKind::Size,
                Some(json!({"min": 4, "max": 4})),
            ),
        ],
    )]);
    assert!(
        sampled(wire, None).is_err(),
        "unverified Pattern must require a fixture, not emit saji"
    );
}

#[test]
fn pattern_contradictory_predicates_cannot_certify_a_sample() {
    let wire = object(vec![constrained_property(
        "code",
        primitive("string"),
        vec![
            constraint(ValidationConstraintKind::Pattern, Some(json!("^[A-Z]+$"))),
            constraint(ValidationConstraintKind::Pattern, Some(json!("^[a-z]+$"))),
        ],
    )]);
    assert!(
        sampled(wire, None).is_err(),
        "every Pattern predicate must be enforced"
    );
}

#[test]
fn pattern_backreferences_cannot_be_treated_as_literal_digits() {
    let wire = object(vec![constrained_property(
        "code",
        primitive("string"),
        vec![constraint(
            ValidationConstraintKind::Pattern,
            Some(json!(r"^(a)\1$")),
        )],
    )]);
    assert!(
        sampled(wire, None).is_err(),
        "backreferences are outside the verified subset"
    );
}

#[test]
fn pattern_unverified_predicates_abstain_for_literals_enums_and_parameters() {
    use contract_core::report::ReasonCode;
    for wire in [
        primitive("string"),
        literal(json!("lowercase")),
        enumeration(vec![json!("lowercase")]),
    ] {
        let constraints = vec![constraint(
            ValidationConstraintKind::Pattern,
            Some(json!("^[A-Z]+$")),
        )];
        let detail = synthesis_error(
            object(vec![constrained_property(
                "value",
                wire.clone(),
                constraints.clone(),
            )]),
            None,
        );
        assert_eq!(
            ReasonCode::classify(&detail),
            Some(ReasonCode::UnsupportedConstruct)
        );
        for kind in ["query", "header", "path"] {
            let path = if kind == "path" {
                "/items/{value}"
            } else {
                "/items"
            };
            let mut response = endpoint("RESPONSE", "GET", path, None);
            let mut parameter = param("value", wire.clone(), true);
            parameter.validation_constraints = Some(constraints.clone());
            match kind {
                "query" => response.query_parameters.push(parameter),
                "header" => response.headers.push(parameter),
                _ => response.path_parameters.push(parameter),
            }
            assert!(
                synthesize_request(&response, &[], None, None).is_err(),
                "{kind}"
            );
        }
    }
}

#[test]
fn post_generated_not_null_identifier_cannot_be_silently_omitted() {
    let mut id = constrained_property(
        "id",
        primitive("number"),
        vec![constraint(ValidationConstraintKind::NotNull, None)],
    );
    id.server_assigned = true;
    assert!(
        sampled(object(vec![id]), None).is_err(),
        "generated/required create semantics require an explicit fixture"
    );
}

#[test]
fn post_generated_nullable_identifier_requires_explicit_operation_semantics() {
    let mut id = property("id", nullable(primitive("number")));
    id.nullable = true;
    id.server_assigned = true;
    let wire = object(vec![id, property("label", primitive("string"))]);
    for path in ["/items", "/items/upsert", "/items/{id}/validate"] {
        let response = endpoint("RESPONSE", "POST", path, None);
        let request = endpoint("REQUEST", "POST", path, Some(wire.clone()));
        assert!(
            synthesize_request(&response, &[request.clone()], None, None).is_err(),
            "POST {path} is not proof of creation"
        );
        for body in [
            json!({"label": "configured"}),
            json!({"id": 17, "label": "configured"}),
        ] {
            let fixture = EndpointRequestFixture {
                body: Some(body.clone()),
                ..Default::default()
            };
            assert_eq!(
                synthesize_request(&response, &[request.clone()], None, Some(&fixture))
                    .unwrap()
                    .body,
                Some(body)
            );
        }
    }
}

#[test]
fn client_supplied_ids_remain_inputs_without_generated_metadata() {
    let wire = object(vec![constrained_property(
        "id",
        primitive("number"),
        vec![constraint(ValidationConstraintKind::NotNull, None)],
    )]);
    assert_eq!(sampled(wire, None).unwrap().body, Some(json!({"id": 1})));
}

#[test]
fn temporal_route_regex_cannot_replace_a_formatted_sample_with_a_word() {
    let mut response = endpoint("RESPONSE", "GET", "/items/{date:alpha|beta}", None);
    response.path_parameters.push(param(
        "date",
        WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: Some(PrimitiveFormat::Date),
            provenance: None,
        }),
        true,
    ));
    assert!(
        synthesize_request(&response, &[], None, None).is_err(),
        "route fallback must preserve temporal grammar"
    );
}

#[test]
fn temporal_samples_keep_explicit_format_through_refs_and_validate_constraints() {
    for (format, expected) in [
        (PrimitiveFormat::DateTime, "2024-01-01T00:00:00Z"),
        (PrimitiveFormat::LocalDateTime, "2024-01-01T00:00:00"),
        (PrimitiveFormat::Date, "2024-01-01"),
        (PrimitiveFormat::Time, "00:00:00"),
    ] {
        let wire = WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: Some(format),
            provenance: None,
        });
        let pool = BTreeMap::from([("Temporal".to_string(), wire)]);
        let constraints = vec![constraint(
            ValidationConstraintKind::Size,
            Some(json!({"min": expected.len(), "max": expected.len()})),
        )];
        let body = object(vec![constrained_property(
            "value",
            nullable(reference("Temporal")),
            constraints,
        )]);
        assert_eq!(
            sampled(body, Some(&pool)).unwrap().body.unwrap()["value"],
            expected
        );
        let body = object(vec![constrained_property(
            "value",
            reference("Temporal"),
            vec![constraint(
                ValidationConstraintKind::Size,
                Some(json!({"max": 2})),
            )],
        )]);
        assert!(sampled(body, Some(&pool)).is_err());
    }
}
