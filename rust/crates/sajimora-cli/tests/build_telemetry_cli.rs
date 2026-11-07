use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use telemetry_core::types::{
    verify_telemetry_integrity, TelemetryArtifactEnvelope, TELEMETRY_ARTIFACT_VERSION_V1,
};

#[test]
fn build_telemetry_help_exposes_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["build-telemetry", "--help"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--service-id"));
    assert!(help.contains("--api-version"));
    assert!(help.contains("--jacoco"));
    assert!(help.contains("--otel"));
    assert!(help.contains("--out"));
}

#[test]
fn build_telemetry_produces_valid_sealed_artifact() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-telemetry-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let jacoco_file = tmp_dir.join("jacoco.xml");
    let otel_file = tmp_dir.join("otel.json");
    let out_file = tmp_dir.join("telemetry.contract.json");

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

    let sample_otel = r#"
{"resourceSpans":[{"scopeSpans":[{"spans":[
    {"name":"HTTP GET","attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/api/sample/{id}"}},{"key":"http.status_code","value":{"intValue":200}}]},
    {"name":"HTTP POST","attributes":[{"key":"http.method","value":{"stringValue":"POST"}},{"key":"http.route","value":{"stringValue":"/api/sample"}},{"key":"http.status_code","value":{"intValue":201}}]}
]}]}]}
"#;

    fs::write(&jacoco_file, sample_jacoco).unwrap();
    fs::write(&otel_file, sample_otel).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "build-telemetry",
            "--service-id",
            "sample-service",
            "--api-version",
            "v1",
            "--jacoco",
            jacoco_file.to_str().unwrap(),
            "--otel",
            otel_file.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "sajimora build-telemetry should exit with 0"
    );
    assert!(out_file.exists(), "Output telemetry artifact must exist");

    let bytes = fs::read(&out_file).unwrap();
    let env: TelemetryArtifactEnvelope = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(env.envelope_version, TELEMETRY_ARTIFACT_VERSION_V1);
    assert_eq!(env.service_id, "sample-service");
    assert_eq!(env.api_version.as_deref(), Some("v1"));

    // Check coverage
    assert!(env
        .coverage
        .contains_key("com/example/sample/SampleController.java"));
    let cov = &env.coverage["com/example/sample/SampleController.java"];
    assert_eq!(cov.covered_lines, vec![15, 16]);
    assert_eq!(cov.missed_lines, vec![20]);

    // Check span summaries
    assert_eq!(env.span_summaries.len(), 2);

    // Check integrity verification
    assert!(
        verify_telemetry_integrity(&env).expect("integrity verification call must succeed"),
        "Sealed telemetry envelope must pass SHA-256 integrity verification"
    );

    // Clean up
    let _ = fs::remove_file(jacoco_file);
    let _ = fs::remove_file(otel_file);
    let _ = fs::remove_file(out_file);
    let _ = fs::remove_dir(tmp_dir);
}
