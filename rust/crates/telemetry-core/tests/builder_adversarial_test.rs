use std::io::Cursor;
use telemetry_core::builder::TelemetryBuilder;
use telemetry_core::jacoco::parse_jacoco_xml;
use telemetry_core::otel::reduce_otel_spans;
use telemetry_core::types::{
    compute_telemetry_digest, FileCoverage, TELEMETRY_ARTIFACT_VERSION_V1,
};

#[test]
fn test_telemetry_builder_empty_envelope_has_deterministic_digest() {
    let builder = TelemetryBuilder::new("order-service")
        .with_api_version(Some("v2.1"))
        .with_timestamp("2026-11-14T08:00:00Z");

    let envelope = builder
        .build::<Cursor<&[u8]>, Cursor<&[u8]>>(None, None)
        .expect("empty builder must succeed");

    assert_eq!(envelope.envelope_version, TELEMETRY_ARTIFACT_VERSION_V1);
    assert_eq!(envelope.service_id, "order-service");
    assert_eq!(envelope.api_version.as_deref(), Some("v2.1"));
    assert_eq!(envelope.created_at, "2026-11-14T08:00:00Z");
    assert!(envelope.coverage.is_empty());
    assert!(envelope.span_summaries.is_empty());

    let integrity = envelope.integrity.as_ref().expect("integrity must be populated");
    assert_eq!(integrity.sha256.len(), 64);

    let recomputed = compute_telemetry_digest(&envelope).expect("recomputed digest");
    assert_eq!(integrity.sha256, recomputed);
}

#[test]
fn test_telemetry_builder_fallback_timestamp_when_omitted() {
    let builder = TelemetryBuilder::new("auth-service");
    let envelope = builder
        .build::<Cursor<&[u8]>, Cursor<&[u8]>>(None, None)
        .expect("fallback timestamp builder");

    assert_eq!(envelope.created_at, "2026-10-19T00:00:00Z");
    assert!(envelope.api_version.is_none());
}

#[test]
fn test_jacoco_streaming_parser_with_windows_package_separators() {
    let xml_data = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="demo-coverage">
    <package name="com\example\service\sub">
        <sourcefile name="OrderService.java">
            <line nr="10" mi="0" ci="2" mb="0" cb="0"/>
            <line nr="11" mi="0" ci="1" mb="0" cb="0"/>
            <line nr="15" mi="1" ci="0" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>
"#;

    let cursor = Cursor::new(xml_data.as_bytes());
    let coverage = parse_jacoco_xml(cursor).expect("must parse jacoco xml");

    assert_eq!(coverage.len(), 1);
    let key = "com/example/service/sub/OrderService.java";
    let file_cov = coverage.get(key).expect("must normalize backslashes to slashes");

    assert_eq!(file_cov.covered_lines, vec![10, 11]);
    assert_eq!(file_cov.missed_lines, vec![15]);
}

#[test]
fn test_jacoco_parser_handles_multi_package_and_uncovered_files() {
    let xml_data = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="multi-package">
    <package name="com/billing">
        <sourcefile name="Invoice.java">
            <line nr="5" mi="0" ci="1" mb="0" cb="0"/>
        </sourcefile>
        <sourcefile name="UnusedDto.java">
            <line nr="1" mi="1" ci="0" mb="0" cb="0"/>
            <line nr="2" mi="1" ci="0" mb="0" cb="0"/>
        </sourcefile>
    </package>
    <package name="com/shipping">
        <sourcefile name="Carrier.java">
            <line nr="20" mi="0" ci="4" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>
"#;

    let cursor = Cursor::new(xml_data.as_bytes());
    let coverage = parse_jacoco_xml(cursor).expect("must parse multi package");

    assert_eq!(coverage.len(), 3);
    assert_eq!(
        coverage.get("com/billing/Invoice.java").unwrap(),
        &FileCoverage {
            covered_lines: vec![5],
            missed_lines: vec![],
            total_lines: 1,
            line_coverage_ratio: 1.0,
        }
    );
    assert_eq!(
        coverage.get("com/billing/UnusedDto.java").unwrap(),
        &FileCoverage {
            covered_lines: vec![],
            missed_lines: vec![1, 2],
            total_lines: 2,
            line_coverage_ratio: 0.0,
        }
    );
    assert_eq!(
        coverage.get("com/shipping/Carrier.java").unwrap(),
        &FileCoverage {
            covered_lines: vec![20],
            missed_lines: vec![],
            total_lines: 1,
            line_coverage_ratio: 1.0,
        }
    );
}

#[test]
fn test_jacoco_malformed_xml_fails_cleanly() {
    let broken_xml = "<report><package name='open'><sourcefile name='Broken.java'><line nr='NaN'></package>";
    let cursor = Cursor::new(broken_xml.as_bytes());
    // Either fails or safely handles malformed input without panicking
    let _ = parse_jacoco_xml(cursor);
}

#[test]
fn test_otel_spans_ndjson_mixed_stream() {
    let ndjson = r#"
{"attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/users"}},{"key":"http.status_code","value":{"intValue":200}}]}
{"unrelated":"span","name":"internal.compute"}

{"attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/users"}},{"key":"http.status_code","value":{"intValue":200}}]}
{"attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/users"}},{"key":"http.status_code","value":{"intValue":404}}]}
{"attributes":[{"key":"http.method","value":{"stringValue":"POST"}},{"key":"http.route","value":{"stringValue":"/api/users"}},{"key":"http.status_code","value":{"intValue":201}}]}
"#;

    let cursor = Cursor::new(ndjson.as_bytes());
    let summaries = reduce_otel_spans(cursor).expect("must parse ndjson");

    assert_eq!(summaries.len(), 2);

    let get_summary = summaries.iter().find(|s| s.http_method == "GET").unwrap();
    assert_eq!(get_summary.normalized_route, "/api/users");
    assert_eq!(get_summary.observation_count, 3);
    assert_eq!(get_summary.status_codes.get(&200), Some(&2));
    assert_eq!(get_summary.status_codes.get(&404), Some(&1));

    let post_summary = summaries.iter().find(|s| s.http_method == "POST").unwrap();
    assert_eq!(post_summary.normalized_route, "/api/users");
    assert_eq!(post_summary.observation_count, 1);
    assert_eq!(post_summary.status_codes.get(&201), Some(&1));
}

#[test]
fn test_otel_otlp_standard_resource_spans_json() {
    let otlp_json = r#"{
  "resourceSpans": [
    {
      "scopeSpans": [
        {
          "spans": [
            {
              "name": "HTTP GET /items/{id}",
              "attributes": [
                { "key": "http.request.method", "value": { "stringValue": "get" } },
                { "key": "http.target", "value": { "stringValue": "/items/42" } },
                { "key": "http.response.status_code", "value": { "intValue": 200 } }
              ]
            },
            {
              "name": "HTTP DELETE /items/{id}",
              "attributes": [
                { "key": "http.method", "value": { "stringValue": "DELETE" } },
                { "key": "http.route", "value": { "stringValue": "/items/:id" } },
                { "key": "http.status_code", "value": { "intValue": 204 } }
              ]
            }
          ]
        }
      ]
    }
  ]
}"#;

    let cursor = Cursor::new(otlp_json.as_bytes());
    let summaries = reduce_otel_spans(cursor).expect("must parse standard OTLP JSON");

    assert_eq!(summaries.len(), 2);
    let del = summaries.iter().find(|s| s.http_method == "DELETE").unwrap();
    assert_eq!(del.normalized_route, "/items/:id");
    assert_eq!(del.status_codes.get(&204), Some(&1));

    let get_item = summaries.iter().find(|s| s.http_method == "GET").unwrap();
    assert_eq!(get_item.normalized_route, "/items/42");
    assert_eq!(get_item.status_codes.get(&200), Some(&1));
}

#[test]
fn test_otel_span_flat_array_json() {
    let flat_json = r#"[
        {
            "attributes": [
                { "key": "http.method", "value": { "stringValue": "PATCH" } },
                { "key": "url.path", "value": { "stringValue": "/v1/settings" } },
                { "key": "http.status_code", "value": { "intValue": 200 } }
            ]
        }
    ]"#;

    let cursor = Cursor::new(flat_json.as_bytes());
    let summaries = reduce_otel_spans(cursor).expect("must parse flat array");

    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].http_method, "PATCH");
    assert_eq!(summaries[0].normalized_route, "/v1/settings");
    assert_eq!(summaries[0].observation_count, 1);
}

#[test]
fn test_full_builder_assembly_with_coverage_and_otel() {
    let jacoco_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="full-test">
    <package name="org/acme/order">
        <sourcefile name="OrderResource.java">
            <line nr="42" mi="0" ci="1" mb="0" cb="0"/>
            <line nr="43" mi="0" ci="1" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>
"#;

    let otel_json = r#"[
        {
            "attributes": [
                { "key": "http.method", "value": { "stringValue": "GET" } },
                { "key": "http.route", "value": { "stringValue": "/orders/summary" } },
                { "key": "http.status_code", "value": { "intValue": 200 } }
            ]
        }
    ]"#;

    let builder = TelemetryBuilder::new("acme-order-service")
        .with_api_version(Some("1.0.0"))
        .with_timestamp("2026-11-14T08:15:30Z");

    let envelope = builder
        .build(
            Some(Cursor::new(jacoco_xml.as_bytes())),
            Some(Cursor::new(otel_json.as_bytes())),
        )
        .expect("builder must succeed with both streams");

    assert_eq!(envelope.service_id, "acme-order-service");
    assert_eq!(envelope.coverage.len(), 1);
    assert_eq!(envelope.span_summaries.len(), 1);
    assert_eq!(envelope.span_summaries[0].http_method, "GET");
    assert_eq!(envelope.span_summaries[0].normalized_route, "/orders/summary");

    let integrity = envelope.integrity.as_ref().unwrap();
    assert_eq!(integrity.sha256.len(), 64);
}
