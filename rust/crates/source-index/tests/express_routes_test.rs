use contract_core::envelope::{verify_envelope_integrity, ArtifactKind, ArtifactPayload};
use contract_core::ir::ContractDirection;
use source_index::express_routes::{
    is_express_source_file, looks_like_express_root, ExpressRouteExtractor,
};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn test_express_source_file_detection() {
    assert!(is_express_source_file("src/routes/users.ts"));
    assert!(is_express_source_file("app.js"));
    assert!(!is_express_source_file("node_modules/express/index.js"));
    assert!(!is_express_source_file("src/routes/users.test.ts"));
}

#[test]
fn test_express_producer_extraction_full() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-test-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let pkg_json = r#"{
  "name": "sample-express",
  "dependencies": {
    "express": "^4.18.2"
  }
}"#;
    fs::write(tmp_dir.join("package.json"), pkg_json).unwrap();

    let server_ts = r#"
import express, { Request, Response } from 'express';

export interface UserDto {
    id: string;
    name: string;
}

export interface CreateUserDto {
    name: string;
}

const app = express();

app.get('/api/users/:id', (req: Request<{ id: string }, UserDto>, res: Response<UserDto>) => {
    res.json({ id: req.params.id, name: 'Alice' });
});

app.post('/api/users', (req: Request<{}, UserDto, CreateUserDto>, res: Response<UserDto>) => {
    res.json({ id: '1', name: req.body.name });
});

app.delete('/api/users/:id', (req: Request<{ id: string }>, res: Response<void>) => {
    res.status(204).send();
});
"#;

    fs::write(src_dir.join("server.ts"), server_ts).unwrap();

    assert!(looks_like_express_root(&tmp_dir));

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    assert_eq!(extractor.endpoints_count(), 3);

    let env = extractor
        .build_envelope("express-service", Some("v1"), "HEAD")
        .unwrap();

    assert!(verify_envelope_integrity(&env).unwrap());
    assert_eq!(env.kind, ArtifactKind::BackendContract);
    assert_eq!(env.profile.framework_profile.as_deref(), Some("EXPRESS"));
    assert!(env.completeness.complete);
    assert_eq!(env.completeness.blockers.len(), 0);

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            // GET has :id (Req + Res) = 2
            // POST has CreateUserDto body (Req + Res) = 2
            // DELETE has :id (Req + Res) = 2
            // Total = 6 endpoints
            assert_eq!(payload.endpoints.len(), 6);

            let type_pool = payload.type_pool.expect("type_pool must be present");
            assert!(type_pool.contains_key("UserDto"));
            assert!(type_pool.contains_key("CreateUserDto"));

            let get_res = payload
                .endpoints
                .iter()
                .find(|e| {
                    e.identity.http_method == "GET"
                        && e.identity.direction == ContractDirection::Response
                })
                .expect("GET response endpoint must exist");

            assert_eq!(get_res.identity.normalized_route.raw_path, "/api/users/:id");
            assert_eq!(get_res.path_parameters.len(), 1);
            assert_eq!(get_res.path_parameters[0].name, "id");

            let post_req = payload
                .endpoints
                .iter()
                .find(|e| {
                    e.identity.http_method == "POST"
                        && e.identity.direction == ContractDirection::Request
                })
                .expect("POST request endpoint must exist");

            assert!(post_req.body.is_some());
        }
        _ => panic!("Payload must be ArtifactPayload::Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn untyped_express_response_is_incomplete_not_silent() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-untyped-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("server.js"),
        "const express = require('express');\nconst app = express();\napp.get('/api/ping', (req, res) => { res.json(buildPayload()); });\n",
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();
    assert!(
        !env.completeness.complete,
        "a route without a declared response type must not be complete"
    );
    assert!(
        env.completeness
            .unresolved_endpoints
            .iter()
            .any(|endpoint| endpoint == "GET /api/ping"),
        "missing response attestation: {:?}",
        env.completeness.unresolved_endpoints
    );

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_json_object_literal_is_extracted() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-literal-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("server.js"),
        "const express = require('express');\nconst app = express();\napp.get('/api/status', (req, res) => { res.json({ ok: true, count: 2 }); });\n",
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();
    assert!(
        env.completeness.complete,
        "{:?}",
        env.completeness.unresolved_endpoints
    );
    match env.payload {
        ArtifactPayload::Backend(payload) => {
            let response = payload
                .endpoints
                .iter()
                .find(|endpoint| endpoint.identity.direction == ContractDirection::Response)
                .expect("response endpoint");
            match response.body.as_ref().expect("literal response body") {
                contract_core::ir::WireType::Object(object) => {
                    let names: Vec<&str> = object
                        .properties
                        .iter()
                        .map(|property| property.wire_name.as_str())
                        .collect();
                    assert_eq!(names, vec!["ok", "count"]);
                }
                other => panic!("expected object literal, got {other:?}"),
            }
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_client_calls_are_not_server_routes() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-client-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2","axios":"^1.6.0"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("server.ts"),
        r#"
import express, { Request, Response } from 'express';
import axios from 'axios';
interface HealthDto { status: string; }
const app = express();
const client = axios.create();
client.get('/client-only');
app.get('/server-only', (req: Request, res: Response<HealthDto>) => {
    res.json({ status: 'ok' });
});
"#,
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    assert_eq!(
        extractor.endpoints_count(),
        1,
        "axios.get must not become a server route"
    );
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();
    assert!(
        env.completeness.complete,
        "{:?}",
        env.completeness.unresolved_endpoints
    );
    match env.payload {
        ArtifactPayload::Backend(payload) => {
            assert_eq!(payload.endpoints.len(), 1);
            assert_eq!(
                payload.endpoints[0].identity.normalized_route.raw_path,
                "/server-only"
            );
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_unresolved_mount_and_route_chain_are_blocked() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-mount-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("server.ts"),
        r#"
import express, { Request, Response } from 'express';
import users from './users';
interface HealthDto { status: string; }
const app = express();
app.use('/api', users);
app.route('/items').get((req, res) => res.json({ ok: true }));
app.get('/health', (req: Request, res: Response<HealthDto>) => {
    res.json({ status: 'ok' });
});
"#,
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();
    assert!(!env.completeness.complete);
    let codes: Vec<&str> = env
        .completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();
    assert!(
        codes.contains(&"EXPRESS_MOUNT_PREFIX_UNRESOLVED"),
        "{codes:?}"
    );
    assert!(codes.contains(&"EXPRESS_ROUTE_CHAIN_UNPARSED"), "{codes:?}");

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_parse_error_is_a_named_blocker() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-parse-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("broken.ts"),
        "import express from 'express';\nconst app = express();\napp.get('/api/broken', (req, res) => {\n",
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();
    assert!(!env.completeness.complete);
    assert!(
        env.completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "EXPRESS_PARSE_ERROR"),
        "missing parse blocker: {:?}",
        env.completeness.blockers
    );

    let _ = fs::remove_dir_all(tmp_dir);
}

fn node_router_fixture(
    name: &str,
    package: &str,
    source: &str,
) -> (
    std::path::PathBuf,
    contract_core::envelope::ContractArtifactEnvelope,
) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora-node-router-{name}-{nanos}"));
    let src = root.join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(
        root.join("package.json"),
        format!("{{\"dependencies\":{{\"{package}\":\"1.0.0\"}}}}"),
    )
    .unwrap();
    fs::write(src.join("server.ts"), source).unwrap();
    let extractor = ExpressRouteExtractor::new(root.clone(), root.as_path()).unwrap();
    let env = extractor
        .build_envelope_bound("svc", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    (root, env)
}

fn response_routes(
    env: &contract_core::envelope::ContractArtifactEnvelope,
) -> Vec<(String, String)> {
    let ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload")
    };
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    routes
}

#[test]
fn a_node_router_with_no_literal_routes_is_not_complete() {
    let (root, env) = node_router_fixture(
        "koa-no-route",
        "koa",
        "import Koa from 'koa';\nconst app = new Koa();\napp.use(async (ctx) => { ctx.body = 'pong'; });\n",
    );
    assert!(!env.completeness.complete);
    assert!(env
        .completeness
        .blockers
        .iter()
        .any(|blocker| blocker.code == "NODE_ROUTER_NO_ROUTE_RECOGNIZED"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn hono_routes_and_profile_are_extracted() {
    let (root, env) = node_router_fixture(
        "hono",
        "hono",
        "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/api/hono/:id', (c) => c.json({ id: 1 }));\n",
    );
    assert_eq!(env.profile.framework_profile.as_deref(), Some("HONO"));
    assert_eq!(
        response_routes(&env),
        vec![("GET".to_string(), "/api/hono/:id".to_string())]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn koa_router_mount_prefix_is_applied() {
    let (root, env) = node_router_fixture(
        "koa",
        "@koa/router",
        "import Koa from 'koa';\nimport Router from '@koa/router';\nconst app = new Koa();\nconst router = new Router();\nrouter.get('/api/koa', (ctx) => {});\napp.use('/base', router.routes());\n",
    );
    assert_eq!(env.profile.framework_profile.as_deref(), Some("KOA"));
    assert_eq!(
        response_routes(&env),
        vec![("GET".to_string(), "/base/api/koa".to_string())]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn hapi_object_routes_are_extracted() {
    let (root, env) = node_router_fixture(
        "hapi",
        "@hapi/hapi",
        "import Hapi from '@hapi/hapi';\nconst server = Hapi.server();\nserver.route({ method: ['GET', 'POST'], path: '/api/hapi', handler: () => ({ ok: true }) });\n",
    );
    assert_eq!(env.profile.framework_profile.as_deref(), Some("HAPI"));
    assert_eq!(
        response_routes(&env),
        vec![
            ("GET".to_string(), "/api/hapi".to_string()),
            ("POST".to_string(), "/api/hapi".to_string()),
        ]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn restify_polka_and_elysia_routes_are_extracted() {
    for (name, package, source, profile, path) in [
        (
            "restify",
            "restify",
            "import restify from 'restify';\nconst server = restify.createServer();\nserver.get('/api/restify', (req, res, next) => {});\n",
            "RESTIFY",
            "/api/restify",
        ),
        (
            "polka",
            "polka",
            "import polka from 'polka';\nconst app = polka();\napp.get('/api/polka', (req, res) => {});\n",
            "POLKA",
            "/api/polka",
        ),
        (
            "elysia",
            "elysia",
            "import { Elysia } from 'elysia';\nnew Elysia().get('/api/elysia', () => ({ ok: true }));\n",
            "ELYSIA",
            "/api/elysia",
        ),
    ] {
        let (root, env) = node_router_fixture(name, package, source);
        assert_eq!(env.profile.framework_profile.as_deref(), Some(profile), "{name}");
        assert_eq!(
            response_routes(&env),
            vec![("GET".to_string(), path.to_string())],
            "{name}"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn bun_serve_object_routes_are_extracted() {
    let server = r#"
Bun.serve({
  port: 3000,
  routes: {
    '/api/health': { GET: () => Response.json({ ok: true }) },
    '/api/items': {
      GET: () => Response.json({ items: [] }),
      POST: () => new Response(JSON.stringify({ id: '1' }), { status: 201 }),
    },
    '/api/items/:id': { DELETE: () => new Response(null, { status: 204 }) },
  },
});
"#;
    let extractor = ExpressRouteExtractor::from_sources(vec![(
        "src/server.ts".to_string(),
        server.to_string(),
    )])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("bun-svc", None, "HEAD")
        .expect("envelope");
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("DELETE".to_string(), "/api/items/:id".to_string()),
            ("GET".to_string(), "/api/health".to_string()),
            ("GET".to_string(), "/api/items".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
        ]
    );

    let health = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/api/health"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .expect("health endpoint");
    match health.body.as_ref().expect("health body") {
        contract_core::ir::WireType::Object(object) => {
            assert!(object
                .properties
                .iter()
                .any(|property| property.wire_name == "ok"));
        }
        other => panic!("expected object body, got {other:?}"),
    }
    let post = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/api/items"
                && endpoint.identity.http_method == "POST"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .expect("post endpoint");
    assert_eq!(
        post.status_code_family,
        Some(contract_core::ir::StatusCodeFamily::Success2xx)
    );
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .all(|blocker| !blocker.code.starts_with("BUN_")),
        "{:?}",
        envelope.completeness.blockers
    );
}

#[test]
fn bun_serve_unreadable_forms_are_named_not_guessed() {
    let server = r#"
Bun.serve({ fetch(req) { return new Response('ok'); } });
Bun.serve({ routes: { '/api/every': (req) => new Response('ok') } });
Bun.serve({ routes: makeRoutes() });
"#;
    let extractor = ExpressRouteExtractor::from_sources(vec![(
        "src/server.ts".to_string(),
        server.to_string(),
    )])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("bun-svc", None, "HEAD")
        .expect("envelope");
    let codes: Vec<&str> = envelope
        .completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();
    assert!(codes.contains(&"BUN_SERVE_ROUTES_UNRESOLVED"), "{codes:?}");
    assert!(codes.contains(&"BUN_ROUTE_METHOD_UNRESOLVED"), "{codes:?}");
    assert!(codes.contains(&"BUN_ROUTES_UNRESOLVED"), "{codes:?}");
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(payload.endpoints.is_empty(), "{:?}", payload.endpoints);
}

#[test]
fn bun_serve_source_is_detected_as_a_node_backend_root() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sajimora-bun-root-{}", nanos));
    let src = root.join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(
        src.join("server.ts"),
        "Bun.serve({ routes: { '/api/health': { GET: () => Response.json({ ok: true }) } } });\n",
    )
    .unwrap();
    assert!(looks_like_express_root(&root));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cloudflare_workers_fetch_dispatch_is_extracted() {
    let server = r#"
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/users') {
      if (request.method === 'GET') {
        return Response.json({ users: [] });
      }
      if (request.method === 'POST') {
        return new Response(JSON.stringify({ id: '1' }), { status: 201 });
      }
    }
    switch (url.pathname) {
      case '/api/health':
        if (request.method === 'GET') {
          return Response.json({ ok: true });
        }
        break;
      default:
        break;
    }
    return new Response('not found', { status: 404 });
  },
};
"#;
    let extractor =
        ExpressRouteExtractor::from_sources(vec![("src/index.ts".to_string(), server.to_string())])
            .expect("extractor");
    let envelope = extractor
        .build_envelope("workers-svc", None, "HEAD")
        .expect("envelope");
    assert_eq!(
        envelope.profile.framework_profile.as_deref(),
        Some("CLOUDFLARE_WORKERS")
    );
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/health".to_string()),
            ("GET".to_string(), "/api/users".to_string()),
            ("POST".to_string(), "/api/users".to_string()),
        ]
    );

    let get_users = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/api/users"
                && endpoint.identity.http_method == "GET"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .expect("GET /api/users");
    match get_users.body.as_ref().expect("GET body") {
        contract_core::ir::WireType::Object(object) => {
            assert!(object
                .properties
                .iter()
                .any(|property| property.wire_name == "users"));
        }
        other => panic!("expected GET object body, got {other:?}"),
    }
    let post_users = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/api/users"
                && endpoint.identity.http_method == "POST"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .expect("POST /api/users");
    match post_users.body.as_ref().expect("POST body") {
        contract_core::ir::WireType::Object(object) => {
            assert!(object
                .properties
                .iter()
                .any(|property| property.wire_name == "id"));
        }
        other => panic!("expected POST object body, got {other:?}"),
    }
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .all(|blocker| !blocker.code.starts_with("WORKERS_")),
        "{:?}",
        envelope.completeness.blockers
    );
}

#[test]
fn cloudflare_workers_service_worker_listener_is_extracted() {
    let server = r#"
addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/v1/') && event.request.method === 'DELETE') {
    event.respondWith(new Response(null, { status: 204 }));
  }
});
"#;
    let extractor =
        ExpressRouteExtractor::from_sources(vec![("worker.ts".to_string(), server.to_string())])
            .expect("extractor");
    let envelope = extractor
        .build_envelope("workers-svc", None, "HEAD")
        .expect("envelope");
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(routes, vec![("DELETE".to_string(), "/api/v1/".to_string())]);
}

#[test]
fn cloudflare_workers_dynamic_path_and_missing_method_are_named() {
    let server = r#"
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/open') {
      return new Response('ok');
    }
    if (url.pathname === target) {
      return new Response('x');
    }
  },
};
"#;
    let extractor =
        ExpressRouteExtractor::from_sources(vec![("src/index.ts".to_string(), server.to_string())])
            .expect("extractor");
    let envelope = extractor
        .build_envelope("workers-svc", None, "HEAD")
        .expect("envelope");
    let codes: Vec<&str> = envelope
        .completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();
    assert!(codes.contains(&"WORKERS_METHOD_UNRESOLVED"), "{codes:?}");
    assert!(codes.contains(&"WORKERS_PATH_UNRESOLVED"), "{codes:?}");
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(payload.endpoints.is_empty(), "{:?}", payload.endpoints);
}

#[test]
fn browser_pathname_checks_are_not_workers_routes() {
    let source = r#"
const url = new URL(document.location.href);
if (url.pathname === '/api/x') {
  doSomething();
}
"#;
    let extractor =
        ExpressRouteExtractor::from_sources(vec![("src/app.ts".to_string(), source.to_string())])
            .expect("extractor");
    let envelope = extractor
        .build_envelope("app", None, "HEAD")
        .expect("envelope");
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(payload.endpoints.is_empty());
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .all(|blocker| !blocker.code.starts_with("WORKERS_")),
        "{:?}",
        envelope.completeness.blockers
    );
}

#[test]
fn tsx_sources_do_not_produce_false_parse_errors() {
    let server = r#"
import { Hono } from 'hono';
const app = new Hono();
app.get('/api/tsx', (c) => c.json({ ok: true }));
"#;
    let component = r#"
export default function App() {
  return <div>hello</div>;
}
"#;
    let extractor = ExpressRouteExtractor::from_sources(vec![
        ("src/server.ts".to_string(), server.to_string()),
        ("src/App.tsx".to_string(), component.to_string()),
    ])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("hono-svc", None, "HEAD")
        .expect("envelope");
    assert_eq!(envelope.profile.framework_profile.as_deref(), Some("HONO"));
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "EXPRESS_PARSE_ERROR"),
        "{:?}",
        envelope.completeness.blockers
    );
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(payload
        .endpoints
        .iter()
        .any(|endpoint| { endpoint.identity.normalized_route.raw_path == "/api/tsx" }));
}

#[test]
fn hono_aliases_keep_provider_detection() {
    let server = r#"
import { Hono as App } from 'hono';
const app = new App();
app.get('/api/alias', (c) => c.json({ ok: true }));
"#;
    let extractor = ExpressRouteExtractor::from_sources(vec![(
        "src/server.ts".to_string(),
        server.to_string(),
    )])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("hono-alias", None, "HEAD")
        .expect("envelope");
    assert_eq!(envelope.profile.framework_profile.as_deref(), Some("HONO"));
    let ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(payload.endpoints.iter().any(|endpoint| {
        endpoint.identity.normalized_route.raw_path == "/api/alias"
            && endpoint.identity.http_method == "GET"
    }));
}

#[test]
fn medusa_file_routes_are_named_as_unparsed() {
    let extractor = ExpressRouteExtractor::from_sources(vec![
        (
            "packages/medusa/src/api/admin/products/route.ts".to_string(),
            "import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';\nexport const GET = async (req: MedusaRequest, res: MedusaResponse) => {};\n".to_string(),
        ),
        (
            "packages/medusa/src/commands/start.ts".to_string(),
            "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.json({ ok: true }));\n".to_string(),
        ),
    ])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("medusa", None, "HEAD")
        .expect("envelope");
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "MEDUSA_FILE_ROUTES_UNPARSED"),
        "{:?}",
        envelope.completeness.blockers
    );
    assert!(!envelope.completeness.complete);
}

#[test]
fn trpc_server_on_express_is_named() {
    let extractor = ExpressRouteExtractor::from_sources(vec![
        (
            "src/server.ts".to_string(),
            "import * as trpcExpress from '@trpc/server/adapters/express';\nimport express from 'express';\nconst app = express();\napp.use('/trpc', trpcExpress.createExpressMiddleware({ router }));\napp.get('/health', (req, res) => res.json({ ok: true }));\n".to_string(),
        ),
    ])
    .expect("extractor");
    let envelope = extractor
        .build_envelope("trpc-svc", None, "HEAD")
        .expect("envelope");
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "TRPC_ROUTES_UNMODELED"),
        "{:?}",
        envelope.completeness.blockers
    );
    assert!(!envelope.completeness.complete);
}

#[test]
fn express_shorthand_and_spread_properties_are_resolved() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-shorthand-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        tmp_dir.join("package.json"),
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    )
    .unwrap();
    fs::write(
        src_dir.join("server.js"),
        r#"
const express = require('express');
const app = express();
app.get('/api/resolved', (req, res) => {
    const ok = true;
    const count = 42;
    const { id } = req.params;
    res.json({ ok, count, id });
});
"#,
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();

    assert!(
        env.completeness.complete,
        "Shorthand properties must be statically resolved: {:?}",
        env.completeness.blockers
    );

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            let response = payload
                .endpoints
                .iter()
                .find(|endpoint| endpoint.identity.direction == ContractDirection::Response)
                .expect("response endpoint");
            match response.body.as_ref().expect("literal response body") {
                contract_core::ir::WireType::Object(object) => {
                    let ok_prop = object.properties.iter().find(|p| p.wire_name == "ok").unwrap();
                    assert!(matches!(ok_prop.r#type, contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::Boolean));
                    let count_prop = object.properties.iter().find(|p| p.wire_name == "count").unwrap();
                    assert!(matches!(count_prop.r#type, contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::Number));
                    let id_prop = object.properties.iter().find(|p| p.wire_name == "id").unwrap();
                    assert!(matches!(id_prop.r#type, contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::String));
                }
                other => panic!("expected object literal, got {other:?}"),
            }
        }
        _ => panic!("Payload must be Backend"),
    }
    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_empty_array_and_mutation_scope_inference() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-arr-test-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let pkg_json = r#"{
  "name": "sample-express",
  "dependencies": {
    "express": "^4.18.2"
  }
}"#;
    fs::write(tmp_dir.join("package.json"), pkg_json).unwrap();

    fs::write(
        src_dir.join("index.ts"),
        r#"
import express from 'express';

export interface UserDto {
    id: string;
    name: string;
}

const app = express();

// Route 1: Array populated via .push() in handler
app.get('/api/pushed', (req, res) => {
    const items = [];
    items.push({ id: 101, title: 'Item 1' });
    res.json({ items });
});

// Route 2: Explicit type annotation on empty array variable
app.get('/api/annotated', (req, res) => {
    const tags: string[] = [];
    const users: UserDto[] = [];
    res.json({ tags, users });
});

// Route 3: Inline `as` assertion and Generic Array type
app.get('/api/asserted', (req, res) => {
    const counts = [] as Array<number>;
    res.json({ counts, direct: [] as boolean[] });
});
"#,
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();

    assert!(
        env.completeness.complete,
        "Array scope inference must resolve completely without unknowns: {:?}",
        env.completeness.blockers
    );

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            // Check Route 1 (/api/pushed)
            let pushed_endpoint = payload
                .endpoints
                .iter()
                .find(|ep| ep.identity.direction == ContractDirection::Response && ep.identity.normalized_route.raw_path == "/api/pushed")
                .expect("pushed endpoint");
            if let contract_core::ir::WireType::Object(obj) = pushed_endpoint.body.as_ref().unwrap() {
                let items_prop = obj.properties.iter().find(|p| p.wire_name == "items").unwrap();
                if let contract_core::ir::WireType::Array(arr) = &items_prop.r#type {
                    if let contract_core::ir::WireType::Object(elem_obj) = arr.element_type.as_ref() {
                        let id_p = elem_obj.properties.iter().find(|p| p.wire_name == "id").unwrap();
                        let title_p = elem_obj.properties.iter().find(|p| p.wire_name == "title").unwrap();
                        assert!(matches!(id_p.r#type, contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::Number));
                        assert!(matches!(title_p.r#type, contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::String));
                    } else {
                        panic!("expected ObjectWireType in array elements, got {:?}", arr.element_type);
                    }
                } else {
                    panic!("expected ArrayWireType for items, got {:?}", items_prop.r#type);
                }
            } else {
                panic!("expected ObjectWireType for pushed response body");
            }

            // Check Route 2 (/api/annotated)
            let ann_endpoint = payload
                .endpoints
                .iter()
                .find(|ep| ep.identity.direction == ContractDirection::Response && ep.identity.normalized_route.raw_path == "/api/annotated")
                .expect("annotated endpoint");
            if let contract_core::ir::WireType::Object(obj) = ann_endpoint.body.as_ref().unwrap() {
                let tags_prop = obj.properties.iter().find(|p| p.wire_name == "tags").unwrap();
                if let contract_core::ir::WireType::Array(arr) = &tags_prop.r#type {
                    assert!(matches!(arr.element_type.as_ref(), contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::String));
                } else {
                    panic!("expected Array of string for tags, got {:?}", tags_prop.r#type);
                }
                let users_prop = obj.properties.iter().find(|p| p.wire_name == "users").unwrap();
                if let contract_core::ir::WireType::Array(arr) = &users_prop.r#type {
                    assert!(matches!(arr.element_type.as_ref(), contract_core::ir::WireType::Ref(ref r) if r.r#ref == "UserDto"));
                } else {
                    panic!("expected Array of UserDto for users, got {:?}", users_prop.r#type);
                }
            }

            // Check Route 3 (/api/asserted)
            let asserted_endpoint = payload
                .endpoints
                .iter()
                .find(|ep| ep.identity.direction == ContractDirection::Response && ep.identity.normalized_route.raw_path == "/api/asserted")
                .expect("asserted endpoint");
            if let contract_core::ir::WireType::Object(obj) = asserted_endpoint.body.as_ref().unwrap() {
                let counts_prop = obj.properties.iter().find(|p| p.wire_name == "counts").unwrap();
                if let contract_core::ir::WireType::Array(arr) = &counts_prop.r#type {
                    assert!(matches!(arr.element_type.as_ref(), contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::Number));
                } else {
                    panic!("expected Array of number for counts, got {:?}", counts_prop.r#type);
                }
                let direct_prop = obj.properties.iter().find(|p| p.wire_name == "direct").unwrap();
                if let contract_core::ir::WireType::Array(arr) = &direct_prop.r#type {
                    assert!(matches!(arr.element_type.as_ref(), contract_core::ir::WireType::Primitive(ref p) if p.scalar == contract_core::ir::PrimitiveScalar::Boolean));
                } else {
                    panic!("expected Array of boolean for direct, got {:?}", direct_prop.r#type);
                }
            }
        }
        _ => panic!("Payload must be Backend"),
    }
    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn express_top_level_array_response() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-express-toparr-test-{}", nanos));
    let src_dir = tmp_dir.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let pkg_json = r#"{
  "name": "sample-express",
  "dependencies": {
    "express": "^4.18.2"
  }
}"#;
    fs::write(tmp_dir.join("package.json"), pkg_json).unwrap();

    fs::write(
        src_dir.join("index.ts"),
        r#"
import express from 'express';

const app = express();

app.get('/api/items', (req, res) => {
    const items = [];
    items.push({ id: 1, name: "Widget" });
    res.json(items);
});

app.get('/api/inline-items', (req, res) => {
    res.json([{ id: 2, name: "Gadget" }]);
});
"#,
    )
    .unwrap();

    let extractor = ExpressRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("express-service", None, "HEAD")
        .unwrap();

    assert!(
        env.completeness.complete,
        "Top-level array responses must be complete: {:?}",
        env.completeness.blockers
    );

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            let ep1 = payload
                .endpoints
                .iter()
                .find(|ep| ep.identity.direction == ContractDirection::Response && ep.identity.normalized_route.raw_path == "/api/items")
                .expect("/api/items endpoint");
            assert!(matches!(ep1.body.as_ref().unwrap(), contract_core::ir::WireType::Array(_)));

            let ep2 = payload
                .endpoints
                .iter()
                .find(|ep| ep.identity.direction == ContractDirection::Response && ep.identity.normalized_route.raw_path == "/api/inline-items")
                .expect("/api/inline-items endpoint");
            assert!(matches!(ep2.body.as_ref().unwrap(), contract_core::ir::WireType::Array(_)));
        }
        _ => panic!("Payload must be Backend"),
    }
    let _ = fs::remove_dir_all(tmp_dir);
}
