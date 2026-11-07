use contract_core::envelope::ArtifactPayload;
use contract_core::ir::ContractDirection;
use source_index::file_system_routes::{route_for, FileFramework, FileSystemRouteExtractor};
use source_index::provider::ProviderKind;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn response_routes(
    env: &contract_core::envelope::ContractArtifactEnvelope,
) -> Vec<(String, String)> {
    let ArtifactPayload::Backend(payload) = &env.payload else {
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
    routes
}

#[test]
fn sveltekit_endpoint_route_methods_and_shapes() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/routes/api/users/+server.ts",
        r#"
import { json } from '@sveltejs/kit';
interface User { id: string }
export async function GET() {
    return json({ users: [] });
}
export async function POST({ request }) {
    const body = await request.json() as User;
    return json({ ok: true });
}
"#,
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::SvelteKit);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert_eq!(env.profile.framework_profile.as_deref(), Some("SVELTEKIT"));
    assert_eq!(
        response_routes(&env),
        vec![
            ("GET".to_string(), "/api/users".to_string()),
            ("POST".to_string(), "/api/users".to_string()),
        ]
    );
    let ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    let get = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.http_method == "GET"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .unwrap();
    assert!(get.body.is_some(), "json({{...}}) must produce a body");
    let post_request = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.http_method == "POST"
                && endpoint.identity.direction == ContractDirection::Request
        })
        .expect("POST request endpoint");
    assert!(
        post_request.body.is_some(),
        "request.json() as User is evidence"
    );
}

#[test]
fn nuxt_file_suffix_and_inline_return_shape() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "server/api/items/[id].get.ts",
        "export default defineEventHandler(() => ({ id: '1', name: 'a' }));\n",
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::Nuxt);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert_eq!(
        response_routes(&env),
        vec![("GET".to_string(), "/api/items/:id".to_string())]
    );
    let ArtifactPayload::Backend(payload) = &env.payload else {
        panic!("backend payload");
    };
    let get = payload
        .endpoints
        .iter()
        .find(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .unwrap();
    assert!(
        get.body.is_some(),
        "returned object literal must be a shape"
    );
}

#[test]
fn remix_loader_and_action_methods() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "app/routes/api.users.$id.tsx",
        r#"
import { json } from '@remix-run/node';
export async function loader({ params }: any) {
    return json({ id: params.id });
}
export async function action() {
    return json({ ok: true });
}
"#,
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::Remix);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert_eq!(
        response_routes(&env),
        vec![
            ("DELETE".to_string(), "/api/users/:id".to_string()),
            ("GET".to_string(), "/api/users/:id".to_string()),
            ("PATCH".to_string(), "/api/users/:id".to_string()),
            ("POST".to_string(), "/api/users/:id".to_string()),
            ("PUT".to_string(), "/api/users/:id".to_string()),
        ]
    );
}

#[test]
fn astro_endpoint_exports() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "package.json",
        "{\"dependencies\":{\"astro\":\"4.0.0\"}}",
    );
    write(
        repo,
        "src/pages/api/health.ts",
        "export const GET = async () => Response.json({ ok: true });\n",
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::Astro);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert_eq!(
        response_routes(&env),
        vec![("GET".to_string(), "/api/health".to_string())]
    );
}

#[test]
fn route_derivation_covers_params_and_index_files() {
    assert_eq!(
        route_for(
            FileFramework::SvelteKit,
            "src/routes/api/users/[id]/+server.ts"
        )
        .as_deref(),
        Some("/api/users/:id")
    );
    assert_eq!(
        route_for(FileFramework::Nuxt, "server/api/files/[...path].ts").as_deref(),
        Some("/api/files/:path*")
    );
    assert_eq!(
        route_for(FileFramework::Remix, "app/routes/users._index.tsx").as_deref(),
        Some("/users")
    );
    assert_eq!(
        route_for(FileFramework::Astro, "src/pages/api/users/index.ts").as_deref(),
        Some("/api/users")
    );
}

#[test]
fn pages_and_file_router_roots_detect_as_filerouter() {
    for (framework, file, manifest) in [
        (
            FileFramework::SvelteKit,
            "src/routes/api/health/+server.ts",
            "{\"dependencies\":{\"vite\":\"5.0.0\"}}",
        ),
        (
            FileFramework::Nuxt,
            "server/api/health.ts",
            "{\"dependencies\":{\"nuxt\":\"3.0.0\"}}",
        ),
        (
            FileFramework::Remix,
            "app/routes/health.tsx",
            "{\"dependencies\":{\"@remix-run/dev\":\"2.0.0\"}}",
        ),
        (
            FileFramework::Astro,
            "src/pages/api/health.ts",
            "{\"dependencies\":{\"astro\":\"4.0.0\"}}",
        ),
    ] {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        write(repo, "package.json", manifest);
        write(
            repo,
            file,
            "export default function handler() { return {}; }\n",
        );
        assert_eq!(
            ProviderKind::detect_on_disk(repo),
            ProviderKind::FileRouter,
            "{framework:?}"
        );
    }
}

#[test]
fn path_shapes_without_framework_evidence_are_not_file_routers() {
    // An Express app may keep controllers under `src/app/routes`; that path
    // shape alone used to select Remix and publish an empty complete artifact.
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "package.json",
        "{\"dependencies\":{\"express\":\"4.21.0\"}}",
    );
    write(
        repo,
        "src/app/routes/users.ts",
        "import express from 'express';\nexport const router = express.Router();\nrouter.get('/users', (req, res) => res.json([]));\n",
    );
    assert!(!source_index::file_system_routes::looks_like_file_router_root(repo));
    assert_eq!(ProviderKind::detect_on_disk(repo), ProviderKind::Express);
}

#[test]
fn nuxt_proxy_routes_do_not_claim_fresh() {
    // `proxy/routes/**` is not Fresh evidence; without a deno.json/fresh.gen the
    // repository is a Nuxt app and its server/api route must be the one extracted.
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "package.json",
        "{\"dependencies\":{\"nuxt\":\"3.0.0\"}}",
    );
    write(
        repo,
        "proxy/routes/index.ts",
        "export default defineEventHandler(() => 'proxy');\n",
    );
    write(
        repo,
        "server/api/health.ts",
        "export default defineEventHandler(() => ({ ok: true }));\n",
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::Nuxt);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    let routes = response_routes(&env);
    assert!(
        routes.contains(&("GET".to_string(), "/api/health".to_string())),
        "{routes:?}"
    );
    assert!(
        !routes.iter().any(|(_, path)| path.contains("proxy")),
        "the proxy/routes file must not be read as a Fresh endpoint: {routes:?}"
    );
}

#[test]
fn remix_loader_declared_with_const_is_extracted() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "package.json",
        "{\"dependencies\":{\"@remix-run/dev\":\"2.0.0\"}}",
    );
    write(
        repo,
        "app/routes/jokes[.]rss.tsx",
        "export const loader = async () => new Response('<rss/>');\n",
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).unwrap();
    assert_eq!(extractor.framework(), FileFramework::Remix);
    let env = extractor
        .build_envelope_bound("web", None, "git-root:test", "HEAD", "HEAD")
        .unwrap();
    assert_eq!(
        response_routes(&env),
        vec![("GET".to_string(), "/jokes.rss".to_string())]
    );
}

#[test]
fn fresh_routes_are_extracted_and_ui_or_middleware_files_are_skipped() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "deno.json",
        r#"{"imports": {"fresh": "jsr:@fresh/core", "$fresh/": "https://deno.land/x/fresh@1.6.8/"}}"#,
    );
    write(
        repo,
        "routes/api/users.ts",
        r#"
import { Handlers } from "$fresh/server.ts";

export const handler: Handlers = {
  GET(_req) {
    return Response.json({ users: [] });
  },
  POST(_req) {
    return new Response(JSON.stringify({ id: "1" }), { status: 201 });
  },
};
"#,
    );
    write(
        repo,
        "routes/api/users/[id].ts",
        r#"
import { Handlers } from "$fresh/server.ts";

export const handler: Handlers = {
  DELETE(_req) {
    return new Response(null, { status: 204 });
  },
};
"#,
    );
    write(
        repo,
        "routes/index.tsx",
        "export const handler = { GET: () => new Response('page') };\nexport default function Home() { return <div>home</div>; }\n",
    );
    write(
        repo,
        "routes/_middleware.ts",
        "export const handler = { GET: () => new Response('mw') };\n",
    );

    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).expect("extractor");
    assert_eq!(extractor.framework(), FileFramework::Fresh);
    let envelope = extractor
        .build_envelope("fresh-svc", None, "HEAD")
        .expect("envelope");
    assert_eq!(
        response_routes(&envelope),
        vec![
            ("DELETE".to_string(), "/api/users/:id".to_string()),
            ("GET".to_string(), "/api/users".to_string()),
            ("POST".to_string(), "/api/users".to_string()),
        ]
    );
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "FILE_ROUTER_HANDLER_UNRESOLVED"),
        "{:?}",
        envelope.completeness.blockers
    );
    assert_eq!(
        route_for(FileFramework::Fresh, "routes/api/users/[id].ts"),
        Some("/api/users/:id".to_string())
    );
}

#[test]
fn fresh_route_without_handler_or_page_export_is_blocked() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "deno.json",
        r#"{"imports": {"fresh": "jsr:@fresh/core"}}"#,
    );
    write(
        repo,
        "routes/api/broken.ts",
        "export const notAHandler = 1;\n",
    );
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).expect("extractor");
    assert_eq!(extractor.framework(), FileFramework::Fresh);
    let envelope = extractor
        .build_envelope("fresh-svc", None, "HEAD")
        .expect("envelope");
    assert!(response_routes(&envelope).is_empty());
    assert!(
        envelope
            .completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "FILE_ROUTER_HANDLER_UNRESOLVED"),
        "{:?}",
        envelope.completeness.blockers
    );
}

#[test]
fn fresh_requires_its_config_before_a_routes_directory_counts() {
    let dir = tempdir().unwrap();
    let bare = dir.path().join("bare");
    fs::create_dir_all(bare.join("routes/api")).unwrap();
    fs::write(
        bare.join("routes/api/health.ts"),
        "export const handler = { GET: () => Response.json({ ok: true }) };\n",
    )
    .unwrap();
    assert_ne!(
        ProviderKind::detect_on_disk(&bare),
        ProviderKind::FileRouter
    );

    let fresh = dir.path().join("fresh");
    fs::create_dir_all(fresh.join("routes/api")).unwrap();
    fs::write(
        fresh.join("deno.json"),
        r#"{"imports": {"fresh": "jsr:@fresh/core"}}"#,
    )
    .unwrap();
    fs::write(
        fresh.join("routes/api/health.ts"),
        "export const handler = { GET: () => Response.json({ ok: true }) };\n",
    )
    .unwrap();
    assert_eq!(
        ProviderKind::detect_on_disk(&fresh),
        ProviderKind::FileRouter
    );
}

#[test]
fn fresh_2_vite_plugin_project_is_detected_by_its_generated_directory() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    fs::create_dir_all(repo.join("_fresh")).unwrap();
    write(
        repo,
        "package.json",
        r#"{"dependencies": {"@fresh/plugin-vite": "^1.0.0"}}"#,
    );
    write(
        repo,
        "routes/api/health.ts",
        "export const handler = { GET: () => Response.json({ ok: true }) };\n",
    );
    assert_eq!(ProviderKind::detect_on_disk(repo), ProviderKind::FileRouter);
    let extractor = FileSystemRouteExtractor::new(repo.to_path_buf(), repo).expect("extractor");
    assert_eq!(extractor.framework(), FileFramework::Fresh);
    let envelope = extractor
        .build_envelope("fresh2", None, "HEAD")
        .expect("envelope");
    assert_eq!(
        response_routes(&envelope),
        vec![("GET".to_string(), "/api/health".to_string())]
    );
}
