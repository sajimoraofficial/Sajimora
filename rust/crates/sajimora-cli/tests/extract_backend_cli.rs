use contract_core::envelope::{parse_envelope, verify_envelope_integrity};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn extract_backend_help_exposes_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["extract-backend", "--help"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--repo"));
    assert!(help.contains("--out"));
    assert!(help.contains("--service-id"));
    assert!(help.contains("--api-version"));
    assert!(help.contains("--java-root"));
}

#[test]
fn extract_backend_produces_valid_contract_with_integrity() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let sample_dir = repo_root.join("fixtures/spring-sample");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-extract-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();
    let out_file = tmp_dir.join("sample.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            sample_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "sample-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "sajimora extract-backend should exit with 0"
    );
    assert!(
        out_file.exists(),
        "Output contract artifact file must exist"
    );

    let content = fs::read(&out_file).unwrap();
    let env =
        parse_envelope(&content).expect("Envelope parsing must succeed on extracted artifact");

    // Must pass integrity verification
    assert!(
        verify_envelope_integrity(&env).expect("integrity verification call must succeed"),
        "Contract integrity verification must pass on newly extracted envelope"
    );

    assert_eq!(
        env.envelope_version,
        contract_core::envelope::ARTIFACT_ENVELOPE_VERSION_V2
    );
    assert!(env.completeness.complete);
    assert_eq!(env.completeness.unresolved_endpoints.len(), 0);

    match &env.payload {
        contract_core::envelope::ArtifactPayload::Backend(payload) => {
            assert_eq!(payload.endpoints.len(), 5);
            let type_pool = payload
                .type_pool
                .as_ref()
                .expect("type_pool must be present");
            assert!(type_pool.contains_key("java:com.example.sample.SampleDto"));
        }
        _ => panic!("Payload must be ArtifactPayload::Backend"),
    }

    // Downstream Consumer Test: sajimora check-contract accepts extracted contract
    let frontend_target = repo_root.join("../frontend-contract.json");
    let check_status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "check-contract",
            "--base",
            out_file.to_str().unwrap(),
            "--candidate",
            out_file.to_str().unwrap(),
            "--target",
            frontend_target.to_str().unwrap(),
            "--trusted-local",
        ])
        .output()
        .unwrap();

    assert!(
        check_status.status.success(),
        "sajimora check-contract must exit with 0 on freshly extracted contract"
    );

    // Clean up
    let _ = fs::remove_file(out_file);
    let _ = fs::remove_dir(tmp_dir);
}

#[test]
fn extract_backend_emits_honest_incomplete_for_unsupported_ts_framework() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-express-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();

    let package_json = r#"{
  "name": "h3-sample",
  "version": "1.0.0",
  "dependencies": {
    "h3": "^1.0.0"
  }
}"#;
    fs::write(tmp_dir.join("package.json"), package_json).unwrap();
    fs::write(
        tmp_dir.join("index.js"),
        "import { createApp } from 'h3';\nconst app = createApp();\napp.use('/api', () => ({ ok: true }));\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("express.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "express-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "extract-backend on Express project must exit with 0"
    );
    assert!(out_file.exists(), "Output contract file must be written");

    let content = fs::read(&out_file).unwrap();
    let env =
        parse_envelope(&content).expect("Envelope parsing must succeed on extracted artifact");

    assert!(
        verify_envelope_integrity(&env).expect("integrity verification call must succeed"),
        "Contract integrity verification must pass"
    );

    assert_eq!(
        env.envelope_version,
        contract_core::envelope::ARTIFACT_ENVELOPE_VERSION_V2
    );
    assert!(
        !env.completeness.complete,
        "H3 backend must NOT claim completeness"
    );
    assert_eq!(env.profile.framework_profile.as_deref(), Some("H3"));
    assert_eq!(
        env.profile.codec_profile.as_deref(),
        Some("JSON_STRINGIFY_V1")
    );

    let blocker = env
        .completeness
        .blockers
        .iter()
        .find(|b| b.code == "TS_MAPPING_FRAMEWORK_UNPARSED")
        .expect("Must have TS_MAPPING_FRAMEWORK_UNPARSED blocker");
    assert!(blocker.message.contains("H3"));

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_jax_rs_produces_valid_contract() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-jaxrs-{}", nanos));
    let src_dir = tmp_dir.join("src/main/java/com/demo");
    fs::create_dir_all(&src_dir).unwrap();

    let code = r#"package com.demo;
import jakarta.ws.rs.*;
@Path("/api/v1/items")
public class ItemResource {
    @GET
    @Path("/{id}")
    public String getItem(@PathParam("id") String id) {
        return id;
    }
}
"#;
    fs::write(src_dir.join("ItemResource.java"), code).unwrap();

    let out_file = tmp_dir.join("jaxrs.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--provider",
            "jaxrs",
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "item-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "extract-backend on JAX-RS project must exit with 0"
    );
    assert!(out_file.exists());

    let content = fs::read(&out_file).unwrap();
    let env = parse_envelope(&content).expect("Envelope parsing must succeed");
    assert!(verify_envelope_integrity(&env).unwrap());
    assert!(env.completeness.complete);
    assert_eq!(env.profile.framework_profile.as_deref(), Some("JAX_RS"));

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_frontend_java_feign_client() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-feign-{}", nanos));
    let src_dir = tmp_dir.join("src/main/java/com/demo");
    fs::create_dir_all(&src_dir).unwrap();

    let code = r#"package com.demo;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient(name = "item-service", path = "/api/v1/items")
public interface ItemClient {
    @GetMapping("/{id}")
    String getItem(@PathVariable("id") String id);
}
"#;
    fs::write(src_dir.join("ItemClient.java"), code).unwrap();

    let out_file = tmp_dir.join("feign.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-frontend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "order-service",
            "--target-service-id",
            "item-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "extract-frontend on Feign client project must exit with 0"
    );
    assert!(out_file.exists());

    let content = fs::read(&out_file).unwrap();
    let env = parse_envelope(&content).expect("Envelope parsing must succeed");
    assert!(verify_envelope_integrity(&env).unwrap());
    assert!(env.completeness.complete);
    assert_eq!(
        env.kind,
        contract_core::envelope::ArtifactKind::FrontendContract
    );
    assert_eq!(
        env.profile.client_profile.as_deref(),
        Some("JAVA_HTTP_CLIENT")
    );

    match &env.payload {
        contract_core::envelope::ArtifactPayload::Frontend(payload) => {
            assert_eq!(payload.client_contracts.len(), 1);
            let contract = &payload.client_contracts[0];
            assert_eq!(contract.http_method, "GET");
            assert_eq!(contract.normalized_route, "/api/v1/items/{id}");
            assert_eq!(contract.target_service_id.as_deref(), Some("item-service"));
        }
        _ => panic!("Payload must be Frontend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_auto_extracts_next_pages_router() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-next-pages-{}", nanos));
    let pages = tmp_dir.join("pages/api");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"next":"^14.0.0","react":"^18.0.0"}}"#,
    )
    .unwrap();
    fs::write(
        pages.join("hello.ts"),
        "export default function handler(req, res) { res.status(200).json({ ok: true }); }\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("pages.contract.json");
    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "pages-service",
        ])
        .status()
        .unwrap();
    assert!(status.success());

    let env = parse_envelope(&fs::read(&out_file).unwrap()).expect("Envelope parsing must succeed");
    assert_eq!(env.profile.framework_profile.as_deref(), Some("NEXTJS"));
    assert!(
        env.completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "TS_MAPPING_FRAMEWORK_UNPARSED"),
        "Pages Router is extracted now: {:?}",
        env.completeness.blockers
    );
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    assert!(
        payload
            .endpoints
            .iter()
            .any(|endpoint| endpoint.identity.normalized_route.raw_path == "/api/hello"),
        "{:?}",
        payload
            .endpoints
            .iter()
            .map(|endpoint| &endpoint.identity.normalized_route.raw_path)
            .collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_auto_blocks_unrecognized_ts_backend() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-unknown-ts-{}", nanos));
    fs::create_dir_all(&tmp_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"name":"custom-server","dependencies":{}}"#,
    )
    .unwrap();
    fs::write(
        tmp_dir.join("server.ts"),
        "const server = createServer();\nserver.get('/health', () => ({ ok: true }));\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("unknown.contract.json");
    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "unknown-service",
        ])
        .status()
        .unwrap();
    assert!(status.success());

    let env = parse_envelope(&fs::read(&out_file).unwrap()).expect("Envelope parsing must succeed");
    assert!(
        !env.completeness.complete,
        "unknown TS backends must not pass as complete"
    );
    let blocker = env
        .completeness
        .blockers
        .iter()
        .find(|blocker| blocker.code == "TS_MAPPING_FRAMEWORK_UNPARSED")
        .expect("unrecognized TS must be named");
    assert!(
        blocker.message.contains("unrecognized"),
        "{}",
        blocker.message
    );

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_frontend_merges_java_and_typescript_consumers() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-mixed-clients-{}", nanos));
    let java_dir = tmp_dir.join("src/main/java/com/demo");
    fs::create_dir_all(&java_dir).unwrap();
    fs::write(
        java_dir.join("ItemClient.java"),
        r#"package com.demo;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
@FeignClient(name = "item-service", path = "/api/v1/items")
public interface ItemClient {
    @GetMapping("/{id}")
    String getItem(@PathVariable("id") String id);
}
"#,
    )
    .unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"name":"order-web","dependencies":{"axios":"^1.6.0"}}"#,
    )
    .unwrap();
    fs::write(
        tmp_dir.join("api.ts"),
        "import axios from 'axios';\nexport const listItems = () => axios.get('/api/v1/items');\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("mixed.contract.json");
    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-frontend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "order-service",
            "--target-service-id",
            "item-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "mixed consumer extraction must exit with 0"
    );
    let env = parse_envelope(&fs::read(&out_file).unwrap()).expect("Envelope parsing must succeed");
    assert_eq!(
        env.kind,
        contract_core::envelope::ArtifactKind::FrontendContract
    );
    assert_eq!(
        env.profile.client_profile.as_deref(),
        Some("JAVA_AND_TYPESCRIPT")
    );
    match &env.payload {
        contract_core::envelope::ArtifactPayload::Frontend(payload) => {
            assert!(
                payload.client_contracts.iter().any(|contract| {
                    contract.source_file.ends_with(".java")
                        && contract.normalized_route == "/api/v1/items/{id}"
                }),
                "Java client contract missing: {:?}",
                payload.client_contracts
            );
            assert!(
                payload.client_contracts.iter().any(|contract| {
                    contract.source_file.ends_with(".ts")
                        && contract.normalized_route == "/api/v1/items"
                }),
                "TypeScript consumer contract was dropped: {:?}",
                payload.client_contracts
            );
        }
        _ => panic!("Payload must be Frontend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn auto_detection_is_scoped_to_ts_root_in_a_monorepo() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-monorepo-cli-{}", nanos));
    let next_route = tmp_dir.join("packages/web/app/api/health");
    fs::create_dir_all(&next_route).unwrap();
    fs::write(
        next_route.join("route.ts"),
        "export async function GET() { return Response.json({ ok: true }); }\n",
    )
    .unwrap();
    fs::write(
        tmp_dir.join("packages/web/package.json"),
        r#"{"dependencies":{"next":"14.0.0"}}"#,
    )
    .unwrap();
    let api_src = tmp_dir.join("packages/api/src");
    fs::create_dir_all(&api_src).unwrap();
    fs::write(
        tmp_dir.join("packages/api/package.json"),
        r#"{"dependencies":{"express":"4.21.0"}}"#,
    )
    .unwrap();
    fs::write(
        api_src.join("server.ts"),
        "import express from 'express';\nconst app = express();\napp.get('/things', (req, res) => res.json({ ok: true }));\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("api.contract.json");
    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--ts-root",
            "packages/api/src",
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "api-service",
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let env = parse_envelope(&fs::read(&out_file).unwrap()).expect("Envelope parsing must succeed");
    assert_eq!(env.profile.framework_profile.as_deref(), Some("EXPRESS"));
    match &env.payload {
        contract_core::envelope::ArtifactPayload::Backend(payload) => {
            assert!(
                payload.endpoints.iter().any(|endpoint| endpoint
                    .identity
                    .normalized_route
                    .raw_path
                    == "/things"),
                "the scoped Express route must be extracted, not a sibling Next.js app's lane: {:?}",
                payload
                    .endpoints
                    .iter()
                    .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone())
                    .collect::<Vec<_>>()
            );
        }
        _ => panic!("Payload must be Backend"),
    }
    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_nextjs_produces_valid_contract() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-nextjs-cli-{}", nanos));
    let route_dir = tmp_dir.join("src/app/api/orders/[id]");
    fs::create_dir_all(&route_dir).unwrap();

    let code = r#"
export interface OrderDto {
    id: string;
    total: number;
}

export async function GET(
    request: Request,
    context: { params: { id: string } }
): Promise<NextResponse<OrderDto>> {
    return NextResponse.json({ id: context.params.id, total: 99.9 });
}
"#;
    fs::write(route_dir.join("route.ts"), code).unwrap();

    let out_file = tmp_dir.join("nextjs.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "order-service",
            "--provider",
            "nextjs",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "extract-backend on Next.js project must exit with 0"
    );
    assert!(out_file.exists());

    let content = fs::read(&out_file).unwrap();
    let env = parse_envelope(&content).expect("Envelope parsing must succeed");
    assert!(verify_envelope_integrity(&env).unwrap());
    assert!(env.completeness.complete);
    assert_eq!(env.profile.framework_profile.as_deref(), Some("NEXTJS"));

    match &env.payload {
        contract_core::envelope::ArtifactPayload::Backend(payload) => {
            assert_eq!(payload.endpoints.len(), 2); // 1 Req + 1 Res
            let type_pool = payload
                .type_pool
                .as_ref()
                .expect("type_pool must be present");
            assert!(type_pool.contains_key("OrderDto"));
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_express_produces_valid_contract() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-express-cli-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let code = r#"
import express, { Request, Response } from 'express';

interface HealthDto {
    status: string;
}

const app = express();
app.get('/api/health', (req: Request, res: Response<HealthDto>) => {
    res.json({ status: 'ok' });
});
"#;
    fs::write(src_dir.join("index.ts"), code).unwrap();

    let out_file = tmp_dir.join("express.contract.json");

    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "health-service",
            "--provider",
            "express",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "extract-backend on Express project must exit with 0"
    );
    assert!(out_file.exists());

    let content = fs::read(&out_file).unwrap();
    let env = parse_envelope(&content).expect("Envelope parsing must succeed");
    assert!(verify_envelope_integrity(&env).unwrap());
    assert!(env.completeness.complete);
    assert_eq!(env.profile.framework_profile.as_deref(), Some("EXPRESS"));

    match &env.payload {
        contract_core::envelope::ArtifactPayload::Backend(payload) => {
            assert_eq!(payload.endpoints.len(), 1);
            assert_eq!(
                payload.endpoints[0].identity.normalized_route.raw_path,
                "/api/health"
            );
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn extract_backend_auto_detects_express_provider() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-test-express-auto-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"name":"express-auto","version":"1.0.0","dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("index.ts"),
        "import express from 'express';\nconst app = express();\napp.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });\n",
    )
    .unwrap();

    let out_file = tmp_dir.join("express-auto.contract.json");
    let status = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-backend",
            "--repo",
            tmp_dir.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
            "--service-id",
            "health-service",
        ])
        .status()
        .unwrap();

    assert!(
        status.success(),
        "auto-detected Express extraction must exit with 0"
    );
    let env = parse_envelope(&fs::read(&out_file).unwrap()).expect("Envelope parsing must succeed");
    assert_eq!(env.profile.framework_profile.as_deref(), Some("EXPRESS"));
    match &env.payload {
        contract_core::envelope::ArtifactPayload::Backend(payload) => {
            assert!(
                payload.endpoints.iter().any(|endpoint| endpoint
                    .identity
                    .normalized_route
                    .raw_path
                    == "/api/health"),
                "auto detection must extract the Express route"
            );
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}
