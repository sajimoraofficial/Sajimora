use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn generate_tests_help_exposes_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["generate-tests", "--help"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--contract"));
    assert!(help.contains("--framework"));
    assert!(help.contains("--out"));
    assert!(help.contains("--name"));
    assert!(help.contains("--package"));
    assert!(
        help.lines().any(|line| line
            .trim()
            .starts_with("--request-fixtures <REQUEST_FIXTURES>")),
        "{help}"
    );
}

#[test]
fn generate_tests_synthesizes_jqwik_and_fast_check() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let contract_file = repo_root.join("fixtures/spring-sample.contract.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-gentests-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let jqwik_out = tmp_dir.join("SampleControllerPropertyTest.java");
    let fc_out = tmp_dir.join("sample.property.test.ts");

    // 1. Synthesize Jqwik
    let jqwik_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
            "--framework",
            "jqwik",
            "--name",
            "SampleControllerPropertyTest",
            "--out",
            jqwik_out.to_str().unwrap(),
        ])
        .status()
        .unwrap();

    assert!(jqwik_status.success(), "jqwik generation should exit 0");
    assert!(jqwik_out.exists());
    let jqwik_code = fs::read_to_string(&jqwik_out).unwrap();
    assert!(jqwik_code.contains("public class SampleControllerPropertyTest"));
    assert!(jqwik_code.contains("@Property"));
    assert!(jqwik_code.contains("mockMvc.perform("));

    // 2. Synthesize Fast-Check
    let fc_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
            "--framework",
            "fast-check",
            "--name",
            "Sample Client Fuzz Tests",
            "--out",
            fc_out.to_str().unwrap(),
        ])
        .status()
        .unwrap();

    assert_eq!(
        fc_status.code(),
        Some(0),
        "fixture-aware FastCheck GET synthesis should succeed"
    );
    assert!(fc_out.exists());
    let fc_code = fs::read_to_string(&fc_out).unwrap();
    assert!(fc_code.contains("describe('Sample Client Fuzz Tests'"));
    assert!(fc_code.contains("ABSTAIN: nonGET"));
    assert!(fc_code.contains("SAJIMORA_TOKEN"));
    assert!(fc_code.contains("await fetch("));
    assert!(fc_code.contains("shape_"));

    // 3. Synthesize Supertest
    let st_out = tmp_dir.join("sample.e2e-spec.ts");
    let st_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
            "--framework",
            "supertest",
            "--name",
            "Sample NestJS E2E",
            "--out",
            st_out.to_str().unwrap(),
        ])
        .status()
        .unwrap();

    assert_eq!(
        st_status.code(),
        Some(0),
        "supertest synthesis should succeed"
    );
    assert!(st_out.exists());
    let st_code = fs::read_to_string(&st_out).unwrap();
    assert!(st_code.contains("describe('Sample NestJS E2E'"));
    assert!(st_code.contains("import { Test, TestingModule } from '@nestjs/testing';"));
    assert!(st_code.contains("import request from 'supertest';"));
    assert!(st_code.contains("request(app.getHttpServer())"));
    let _ = fs::remove_file(st_out);

    // Clean up
    let _ = fs::remove_file(jqwik_out);
    let _ = fs::remove_file(fc_out);
    let _ = fs::remove_dir(tmp_dir);
}

#[test]
fn generate_tests_synthesizes_junit5_with_package() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let contract_file = repo_root.join("fixtures/spring-sample.contract.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-junit5-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let junit5_out = tmp_dir.join("ContractTest.java");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
            "--framework",
            "junit5",
            "--package",
            "com.example.sample",
            "--name",
            "ContractTest",
            "--out",
            junit5_out.to_str().unwrap(),
        ])
        .status()
        .unwrap();

    assert!(status.success(), "junit5 generation should exit 0");
    assert!(junit5_out.exists());
    let code = fs::read_to_string(&junit5_out).unwrap();
    assert!(code.contains("package com.example.sample;"));
    assert!(code.contains("public class ContractTest"));
    assert!(code.contains("@SpringBootTest"));
    assert!(code.contains("@AutoConfigureMockMvc(addFilters = false)"));
    assert!(code.contains("@ActiveProfiles(\"test\")"));
    assert!(code.contains("import org.junit.jupiter.api.Test;"));
    assert!(code.contains("@Test"));
    assert!(!code.contains("@Property")); // Zero jqwik dependency

    let _ = fs::remove_file(junit5_out);
    let _ = fs::remove_dir(tmp_dir);
}

#[test]
fn generate_tests_abstains_on_unsupported_webflux() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let contract_file = repo_root.join("fixtures/spring-sample.contract.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-webflux-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    // Create a mock WebFlux pom.xml
    let pom_file = tmp_dir.join("pom.xml");
    fs::write(
        &pom_file,
        r#"<project><dependencies>
            <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-webflux</artifactId></dependency>
        </dependencies></project>"#,
    ).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "WebFlux without WebMvc must exit non-zero"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("UNSUPPORTED_WEBFLUX_TEST_INFRASTRUCTURE"));

    let _ = fs::remove_file(pom_file);
    let _ = fs::remove_dir(tmp_dir);
}

#[test]
fn generate_tests_abstains_on_missing_jqwik_dependency() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let contract_file = repo_root.join("fixtures/spring-sample.contract.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-nojqwik-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    // Create a mock WebMvc pom without jqwik
    let pom_file = tmp_dir.join("pom.xml");
    fs::write(
        &pom_file,
        r#"<project><dependencies>
            <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
            <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId></dependency>
        </dependencies></project>"#,
    ).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
            "--framework",
            "jqwik",
        ])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "Missing jqwik dependency must exit non-zero"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("DEPENDENCY_MISSING"));
    assert!(stderr.contains("net.jqwik:jqwik"));

    let _ = fs::remove_file(pom_file);
    let _ = fs::remove_dir(tmp_dir);
}

#[test]
fn generate_tests_abstains_on_unsupported_structure() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let contract_file = repo_root.join("fixtures/spring-sample.contract.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-empty-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&tmp_dir)
        .args([
            "generate-tests",
            "--contract",
            contract_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "Empty project structure must exit non-zero"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("SAFE_ABSTENTION"));

    let _ = fs::remove_dir(tmp_dir);
}

struct RequestFixtureCliWorkspace {
    root: PathBuf,
    contract_bytes: Vec<u8>,
}

impl RequestFixtureCliWorkspace {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sajimora-request-fixtures-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".sajimora")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/spring-sample.contract.json");
        let contract_bytes = fs::read(fixture).unwrap();
        fs::write(
            root.join(".sajimora/backend-contract.json"),
            &contract_bytes,
        )
        .unwrap();
        Self {
            root,
            contract_bytes,
        }
    }

    fn generate(&self, framework: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sajimora"))
            .current_dir(&self.root)
            .arg("generate-tests")
            .arg("--contract")
            .arg(self.root.join(".sajimora/backend-contract.json"))
            .args([
                "--framework",
                framework,
                "--package",
                "com.example.custom",
                "--name",
                "FixtureContractTest",
            ])
            .arg("--request-fixtures")
            .arg(self.root.join("requests.json"))
            .arg("--out")
            .arg(self.root.join("FixtureContractTest.java"))
            .output()
            .unwrap()
    }

    fn assert_contract_and_seal_untouched(&self) {
        assert_eq!(
            fs::read(self.root.join(".sajimora/backend-contract.json")).unwrap(),
            self.contract_bytes
        );
        let entries: Vec<_> = fs::read_dir(self.root.join(".sajimora"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            entries,
            vec![std::ffi::OsString::from("backend-contract.json")],
            "generation must not create or replace seal artifacts"
        );
    }
}

impl Drop for RequestFixtureCliWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn generate_tests_request_fixtures_use_custom_package_without_modifying_contract_seal() {
    let workspace = RequestFixtureCliWorkspace::new("valid");
    let fixtures = serde_json::to_vec(&json!({"endpoints": {
        "POST /api/sample": {"body": {"name": "fixture \"name\""}, "expectedStatus": 201},
        "GET /api/sample/{id}": {"pathParameters": {"id": "42"}}
    }}))
    .unwrap();
    fs::write(workspace.root.join("requests.json"), &fixtures).unwrap();
    let output = workspace.generate("junit5");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let code = fs::read_to_string(workspace.root.join("FixtureContractTest.java")).unwrap();
    assert!(code.starts_with("package com.example.custom;\n\n"));
    assert!(code
        .lines()
        .any(|line| line == "public class FixtureContractTest {"));
    assert!(code.lines().any(|line| line.trim() ==
        r#"request.contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"fixture \\\"name\\\"\"}");"#));
    assert!(code
        .lines()
        .any(|line| line.trim() == "result.andExpect(status().is(201));"));
    assert!(code.contains("request(org.springframework.http.HttpMethod.valueOf(\"GET\"), java.net.URI.create(\"/api/sample/42\"))"));
    assert!(code
        .lines()
        .any(|line| line.trim() == "result.andExpect(jsonPath(\"$.active\").isBoolean());"));
    assert_eq!(code.matches("    @Test\n").count(), 3);
    assert!(!code.contains("is2xxSuccessful"));
    assert_eq!(
        fs::read(workspace.root.join("requests.json")).unwrap(),
        fixtures
    );
    workspace.assert_contract_and_seal_untouched();
    let mut entries: Vec<_> = fs::read_dir(&workspace.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        [".sajimora", "FixtureContractTest.java", "requests.json"]
            .map(std::ffi::OsString::from)
            .to_vec()
    );
}

#[test]
fn generate_tests_request_fixture_config_errors_preserve_existing_output() {
    let workspace = RequestFixtureCliWorkspace::new("invalid");
    let out = workspace.root.join("FixtureContractTest.java");
    let existing = b"// Existing hand-written test must survive configuration errors.\r\n";
    fs::write(&out, existing).unwrap();
    for (config, framework, expected_error) in [
        (
            json!({"setupSQL": []}),
            "junit5",
            "Invalid request fixture configuration: unknown field",
        ),
        (
            json!({"endpoints": {"POST /api/sample": {"queryParamters": {}}}}),
            "junit5",
            "queryParamters",
        ),
        (
            json!({"endpoints": {"GET /api/missing": {"body": {}}}}),
            "junit5",
            "unmatched endpoint fixture key",
        ),
        (
            json!({"endpoints": {"GET /api/sample/{id}": {"pathParameters": {"idd": "42"}}}}),
            "junit5",
            "unknown endpoint path parameter",
        ),
        (
            json!({"endpoints": {"POST /api/sample": {"expectedStatus": 204}}}),
            "junit5",
            "204 conflicts with a nonvoid or unresolved RESPONSE body",
        ),
        (
            json!({}),
            "junit4",
            "Request fixtures currently require junit5 or fast-check",
        ),
        (
            json!({}),
            "jqwik",
            "Request fixtures currently require junit5 or fast-check",
        ),
    ] {
        let fixtures = serde_json::to_vec(&config).unwrap();
        fs::write(workspace.root.join("requests.json"), &fixtures).unwrap();
        let output = workspace.generate(framework);
        assert_eq!(
            output.status.code(),
            Some(1),
            "framework={framework}, config={config}"
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            stderr.contains(expected_error),
            "expected {expected_error:?}, got {stderr}"
        );
        assert!(!stderr.contains("Synthesized tests written"));
        assert_eq!(
            fs::read(&out).unwrap(),
            existing,
            "existing output was replaced for framework={framework}, config={config}"
        );
        assert_eq!(
            fs::read(workspace.root.join("requests.json")).unwrap(),
            fixtures
        );
        workspace.assert_contract_and_seal_untouched();
        assert!(
            fs::read_dir(&workspace.root).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".sajimora_tmp_")
            }),
            "configuration errors must be rejected before atomic output staging"
        );
    }
}

#[test]
fn remediation_collision_refuses_nonutf8_and_manual_quoted_headers() {
    for existing in [
        b"\xff\xfe user test".as_slice(),
        b"class Manual { String note = \"Generated by Sajimora Native Synthesis (JUnit 5)\"; }\r\n"
            .as_slice(),
        b"// Generated by Sajimora Native Synthesis (JUnit 5) forged suffix\n".as_slice(),
    ] {
        let workspace = RequestFixtureCliWorkspace::new("collision");
        fs::write(workspace.root.join("requests.json"), b"{}").unwrap();
        let dest = workspace.root.join("FixtureContractTest.java");
        fs::write(&dest, existing).unwrap();
        let output = workspace.generate("junit5");
        assert_eq!(
            output.status.code(),
            Some(1),
            "manual ownership must fail closed"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("COLLISION_REFUSAL"));
        assert_eq!(fs::read(&dest).unwrap(), existing);
    }
}

#[test]
fn remediation_failed_compilation_restores_owned_output_exactly() {
    let workspace = RequestFixtureCliWorkspace::new("rollback");
    let dest = workspace
        .root
        .join("src/test/java/FixtureContractTest.java");
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    let prior =
        b"// Generated by Sajimora Native Synthesis (JUnit 5)\r\n// preserved prior bytes\r\n";
    fs::write(&dest, prior).unwrap();
    fs::write(workspace.root.join("pom.xml"), b"<project><artifactId>spring-boot-starter-web</artifactId><artifactId>spring-boot-starter-test</artifactId></project>").unwrap();
    fs::write(workspace.root.join("mvnw.cmd"), b"@exit /b 7\r\n").unwrap();
    fs::write(workspace.root.join("mvnw"), b"#!/bin/sh\nexit 7\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            workspace.root.join("mvnw"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&workspace.root)
        .arg("generate-tests")
        .arg("--contract")
        .arg(workspace.root.join(".sajimora/backend-contract.json"))
        .args(["--verify-build", "--name", "FixtureContractTest", "--out"])
        .arg(&dest)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("status code Some(7)"),
        "the selected wrapper must actually be invoked"
    );
    assert_eq!(
        fs::read(&dest).expect("prior output must survive compilation failure"),
        prior
    );
}

#[test]
fn remediation_wholly_unknown_output_reports_non_success_and_actual_summary() {
    let workspace = RequestFixtureCliWorkspace::new("unknown-summary");
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&workspace.contract_bytes).unwrap();
    for endpoint in envelope["payload"]["endpoints"].as_array_mut().unwrap() {
        if endpoint["identity"]["direction"] == "RESPONSE" {
            endpoint["body"] = json!({"kind": "UNKNOWN", "reason": "unresolved response"});
        }
    }
    fs::write(
        workspace.root.join(".sajimora/backend-contract.json"),
        serde_json::to_vec(&envelope).unwrap(),
    )
    .unwrap();
    fs::write(workspace.root.join("requests.json"), b"{}").unwrap();
    let output = workspace.generate("junit5");
    assert_eq!(
        output.status.code(),
        Some(1),
        "wholly abstained generation is not success"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("\"executable_contract_checks\":0"));
    assert!(stderr.contains("\"abstentions\":3"));
}

#[test]
fn remediation_invalid_java_names_and_boot_major_preserve_owned_output() {
    let workspace = RequestFixtureCliWorkspace::new("invalid-java");
    let dest = workspace.root.join("ContractTest.java");
    let prior = b"// Generated by Sajimora Native Synthesis (JUnit 5)\r\n// prior bytes\r\n";
    for extra in [
        vec!["--name", "../Escape"],
        vec!["--package", "bad.\"injected"],
        vec!["--spring-boot-major", "9"],
    ] {
        fs::write(&dest, prior).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
            .current_dir(&workspace.root)
            .arg("generate-tests")
            .arg("--contract")
            .arg(workspace.root.join(".sajimora/backend-contract.json"))
            .arg("--out")
            .arg(&dest)
            .args(&extra)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(1),
            "invalid generated Java should not be written: {extra:?}"
        );
        assert_eq!(fs::read(&dest).unwrap(), prior);
        assert!(String::from_utf8_lossy(&output.stderr).contains("\"failures\":1"));
    }
}

#[test]
fn remediation_wholly_diagnostic_generation_reports_failure_counts() {
    let workspace = RequestFixtureCliWorkspace::new("diagnostics-summary");
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&workspace.contract_bytes).unwrap();
    for endpoint in envelope["payload"]["endpoints"].as_array_mut().unwrap() {
        if endpoint["identity"]["direction"] == "RESPONSE" {
            endpoint["body"] = json!({"kind": "UNKNOWN", "reason": "UNSUPPORTED_CONSTRUCT: runtime response codec"});
        }
    }
    fs::write(
        workspace.root.join(".sajimora/backend-contract.json"),
        serde_json::to_vec(&envelope).unwrap(),
    )
    .unwrap();
    fs::write(workspace.root.join("requests.json"), b"{}").unwrap();
    let output = workspace.generate("junit5");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("\"diagnostics\":3"));
    assert!(stderr.contains("\"abstentions\":0"));
    assert!(stderr.contains("\"executable_contract_checks\":0"));
    assert!(stderr.contains("\"failures\":1"));
}

#[test]
fn remediation_verify_build_does_not_claim_compile_for_standalone_destination() {
    let workspace = RequestFixtureCliWorkspace::new("standalone-compile");
    let dest = workspace.root.join("ContractTest.java");
    let prior = b"// Generated by Sajimora Native Synthesis (JUnit 5)\n// prior\n";
    fs::write(&dest, prior).unwrap();
    fs::write(
        workspace.root.join("pom.xml"),
        b"<project><artifactId>spring-boot-starter-web</artifactId></project>",
    )
    .unwrap();
    fs::write(workspace.root.join("mvnw.cmd"), b"@exit /b 0\r\n").unwrap();
    fs::write(workspace.root.join("mvnw"), b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            workspace.root.join("mvnw"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .current_dir(&workspace.root)
        .arg("generate-tests")
        .arg("--contract")
        .arg(workspace.root.join(".sajimora/backend-contract.json"))
        .arg("--out")
        .arg(&dest)
        .arg("--verify-build")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(1),
        "project compilation cannot prove an out-of-source candidate compiles"
    );
    assert_eq!(fs::read(&dest).unwrap(), prior);
}
