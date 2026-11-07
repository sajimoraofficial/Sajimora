use source_index::express_routes::ExpressRouteExtractor;
use source_index::nestjs_routes::NestJsRouteExtractor;
use source_index::nextjs_routes::NextJsRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn next_app() -> Vec<(String, String)> {
    vec![
        (
            "next.config.mjs".to_string(),
            "export default { basePath: '/shop' };\n".to_string(),
        ),
        (
            "app/api/items/route.ts".to_string(),
            "export async function GET() { return Response.json({ ok: true }); }\n".to_string(),
        ),
        (
            "pages/api/legacy.ts".to_string(),
            "export default function handler(req: any, res: any) { res.status(200).json({}); }\n"
                .to_string(),
        ),
    ]
}

#[test]
fn hybrid_app_and_pages_routes_are_both_extracted_with_base_path() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    for (rel, content) in next_app() {
        write(repo, &rel, &content);
    }

    let extractor = NextJsRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    let routes: Vec<&str> = payload
        .endpoints
        .iter()
        .map(|e| e.identity.normalized_route.raw_path.as_str())
        .collect();
    assert!(routes.contains(&"/shop/api/items"), "{routes:?}");
    assert!(
        routes.contains(&"/shop/api/legacy"),
        "Pages Router handlers must be extracted, not blocked: {routes:?}"
    );
    assert!(
        env.completeness
            .blockers
            .iter()
            .all(|b| b.code != "NEXTJS_PAGES_ROUTER_UNPARSED"),
        "pages/api is now extracted: {:?}",
        env.completeness.blockers
    );
}

#[test]
fn revision_sources_extract_pages_routes() {
    let extractor = NextJsRouteExtractor::from_sources(next_app()).unwrap();
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    assert!(
        payload
            .endpoints
            .iter()
            .any(|e| e.identity.normalized_route.raw_path == "/shop/api/legacy"),
        "Pages Router sources must survive the revision path"
    );
}

#[test]
fn pages_router_route_derivation_handles_index_and_catch_all() {
    use source_index::nextjs_routes::route_from_pages_api_path;
    assert_eq!(
        route_from_pages_api_path("pages/api/users/index.ts").as_deref(),
        Some("/api/users")
    );
    assert_eq!(
        route_from_pages_api_path("src/pages/api/users/[id].ts").as_deref(),
        Some("/api/users/:id")
    );
    assert_eq!(
        route_from_pages_api_path("pages/api/files/[...path].ts").as_deref(),
        Some("/api/files/:path*")
    );
    assert_eq!(
        route_from_pages_api_path("pages/api/items/[[...slug]].ts").as_deref(),
        Some("/api/items/:slug*")
    );
}

#[test]
fn pages_router_methods_and_shapes_are_extracted() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "pages/api/users/[id].ts",
        r#"
import type { NextApiRequest, NextApiResponse } from 'next';
interface User { id: string; name: string }

export default function handler(req: NextApiRequest, res: NextApiResponse<User>) {
  if (req.method === 'GET') {
    res.status(200).json({ id: '1', name: 'a' });
  } else if (req.method === 'PUT') {
    res.status(200).json({ id: '1', name: 'a' });
  }
}
"#,
    );

    let extractor = NextJsRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    let mut methods: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|e| e.identity.direction == contract_core::ir::ContractDirection::Response)
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    methods.sort();
    assert_eq!(
        methods,
        vec![
            ("GET".to_string(), "/api/users/:id".to_string()),
            ("PUT".to_string(), "/api/users/:id".to_string()),
        ]
    );
    assert!(
        env.completeness
            .blockers
            .iter()
            .all(|b| b.code != "NEXTJS_PAGES_METHOD_DYNAMIC"),
        "{:?}",
        env.completeness.blockers
    );
}

#[test]
fn pages_only_repo_detects_as_nextjs() {
    use source_index::provider::ProviderKind;
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "package.json",
        "{\"dependencies\":{\"next\":\"14.0.0\"}}",
    );
    write(
        repo,
        "pages/api/health.ts",
        "export default function handler(req: any, res: any) { res.status(200).json({ ok: true }); }\n",
    );
    assert_eq!(ProviderKind::detect_on_disk(repo), ProviderKind::NextJs);
}

#[test]
fn fastify_route_objects_are_extracted() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/server.ts",
        r#"
import Fastify from 'fastify';
const fastify = Fastify();

fastify.route({
  method: ['GET', 'POST'],
  url: '/api/items',
  handler: async () => {
    return { ok: true };
  },
});

fastify.route({ method: 'DELETE', path: '/api/items/:id', handler: async () => ({}) });
"#,
    );

    let extractor = ExpressRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    let env = extractor
        .build_envelope_bound("api", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|e| e.identity.direction == contract_core::ir::ContractDirection::Response)
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("DELETE".to_string(), "/api/items/:id".to_string()),
            ("GET".to_string(), "/api/items".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
        ]
    );
    assert!(
        env.completeness
            .blockers
            .iter()
            .all(|b| b.code != "FASTIFY_ROUTE_OBJECT_UNRESOLVED"),
        "{:?}",
        env.completeness.blockers
    );
}

#[test]
fn nest_runtime_responses_and_uri_versioning_are_blocked() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/main.ts",
        "import { VersioningType } from '@nestjs/common';\nconst app: any = {};\napp.enableVersioning({ type: VersioningType.URI });\n",
    );
    write(
        repo,
        "src/items.controller.ts",
        r#"
import { Controller, Get, Post, Res, Version } from '@nestjs/common';

interface Item { id: string; }

@Controller('items')
export class ItemController {
  @Get()
  @Version('2')
  findAll(): Item[] { return []; }

  @Post()
  create(@Res() res: any) { res.status(201).json({ ok: true }); }
}
"#,
    );

    let extractor = NestJsRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    let env = extractor
        .build_envelope_bound("api", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let codes: Vec<&str> = env
        .completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        codes.contains(&"NESTJS_URI_VERSIONING_UNMODELED"),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"NESTJS_RUNTIME_RESPONSE_UNMODELED"),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"NESTJS_VERSION_DECORATOR_UNMODELED"),
        "{codes:?}"
    );
    assert!(!env.completeness.complete);
}

#[test]
fn unresolved_base_path_is_reported_not_silently_dropped() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "next.config.js",
        "const prefix = process.env.BASE_PATH;\nexport default { basePath: prefix };\n",
    );
    write(
        repo,
        "app/api/items/route.ts",
        "export async function GET() { return Response.json({ ok: true }); }\n",
    );

    let extractor = NextJsRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert!(env
        .completeness
        .blockers
        .iter()
        .any(|b| b.code == "NEXTJS_BASE_PATH_UNRESOLVED"));
}
