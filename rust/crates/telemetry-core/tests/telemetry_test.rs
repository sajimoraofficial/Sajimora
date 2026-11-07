use std::io::Cursor;
use telemetry_core::builder::TelemetryBuilder;
use telemetry_core::jacoco::parse_jacoco_xml;
use telemetry_core::otel::reduce_otel_spans;
use telemetry_core::types::{verify_telemetry_integrity, TELEMETRY_ARTIFACT_VERSION_V1};

#[test]
fn test_jacoco_streaming_parser() {
    let sample_jacoco = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="sample-service">
    <package name="com/example/sample">
        <sourcefile name="SampleController.java">
            <line nr="15" mi="0" ci="3" mb="0" cb="0"/>
            <line nr="16" mi="0" ci="2" mb="0" cb="0"/>
            <line nr="20" mi="4" ci="0" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>"#;

    let cursor = Cursor::new(sample_jacoco);
    let coverage = parse_jacoco_xml(cursor).expect("JaCoCo parsing must succeed");

    assert!(coverage.contains_key("com/example/sample/SampleController.java"));
    let file_cov = &coverage["com/example/sample/SampleController.java"];
    assert_eq!(file_cov.covered_lines, vec![15, 16]);
    assert_eq!(file_cov.missed_lines, vec![20]);
    assert_eq!(file_cov.total_lines, 3);
    assert!((file_cov.line_coverage_ratio - 0.6667).abs() < 0.001);
}

#[test]
fn test_otel_span_reduction() {
    let sample_otel = r#"
{"resourceSpans":[{"scopeSpans":[{"spans":[
    {"name":"HTTP GET","attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/sample/{id}"}},{"key":"http.status_code","value":{"intValue":200}}]},
    {"name":"HTTP GET","attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/sample/{id}"}},{"key":"http.status_code","value":{"intValue":404}}]},
    {"name":"HTTP POST","attributes":[{"key":"http.method","value":{"stringValue":"POST"}},{"key":"http.route","value":{"stringValue":"/api/sample"}},{"key":"http.status_code","value":{"intValue":200}}]}
]}]}]}
"#;

    let cursor = Cursor::new(sample_otel);
    let summaries = reduce_otel_spans(cursor).expect("OTel reduction must succeed");

    assert_eq!(summaries.len(), 2);
    let get_summary = summaries
        .iter()
        .find(|s| s.http_method == "GET" && s.normalized_route == "/api/sample/{id}")
        .expect("GET summary must be present");

    assert_eq!(get_summary.observation_count, 2);
    assert_eq!(get_summary.status_codes.get(&200), Some(&1));
    assert_eq!(get_summary.status_codes.get(&404), Some(&1));

    let post_summary = summaries
        .iter()
        .find(|s| s.http_method == "POST" && s.normalized_route == "/api/sample")
        .expect("POST summary must be present");

    assert_eq!(post_summary.observation_count, 1);
    assert_eq!(post_summary.status_codes.get(&200), Some(&1));
}

#[test]
fn test_sealed_telemetry_artifact_integrity() {
    let sample_jacoco = r#"<?xml version="1.0" encoding="UTF-8"?>
<report name="sample-service">
    <package name="com/example/sample">
        <sourcefile name="SampleController.java">
            <line nr="15" mi="0" ci="3" mb="0" cb="0"/>
        </sourcefile>
    </package>
</report>"#;

    let sample_otel = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[
    {"name":"HTTP GET","attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/sample/{id}"}},{"key":"http.status_code","value":{"intValue":200}}]}
]}]}]}"#;

    let envelope = TelemetryBuilder::new("sample-service")
        .with_api_version(Some("v1"))
        .with_timestamp("2026-10-19T12:00:00Z")
        .build(
            Some(Cursor::new(sample_jacoco)),
            Some(Cursor::new(sample_otel)),
        )
        .expect("Building telemetry envelope must succeed");

    assert_eq!(envelope.envelope_version, TELEMETRY_ARTIFACT_VERSION_V1);
    assert!(envelope.integrity.is_some());

    // Verify integrity succeeds on untampered envelope
    assert!(
        verify_telemetry_integrity(&envelope).expect("verification call must succeed"),
        "Untampered envelope must pass integrity check"
    );

    // Verify tampering fails closed
    let mut tampered = envelope.clone();
    tampered.service_id = "tampered-service".to_string();
    assert!(
        !verify_telemetry_integrity(&tampered).expect("verification call must succeed"),
        "Tampered envelope must fail integrity check"
    );
}
