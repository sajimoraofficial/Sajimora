use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn routes(repo: &std::path::Path, ts_root: &str) -> (Vec<(String, String)>, Vec<String>) {
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join(ts_root)).unwrap();
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    (
        payload
            .client_contracts
            .iter()
            .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
            .collect(),
        completeness
            .blockers
            .iter()
            .map(|b| b.code.clone())
            .collect(),
    )
}

#[test]
fn relative_imported_constant_resolves_the_prefix() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(repo, "src/urls.ts", "export const API_ROOT = '/api';\n");
    write(
        repo,
        "src/service.ts",
        "import { API_ROOT } from './urls';\nexport function load() { return fetch(`${API_ROOT}/users`); }\n",
    );

    let (routes, _) = routes(repo, "src");
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/users".to_string())],
        "an imported constant must resolve instead of becoming :param"
    );
}

#[test]
fn barrel_re_exported_constant_resolves_the_prefix() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/api/urls.ts",
        "export const API_ROOT = '/api/v2';\n",
    );
    write(
        repo,
        "src/api/index.ts",
        "export { API_ROOT } from './urls';\n",
    );
    write(
        repo,
        "src/service.ts",
        "import { API_ROOT } from './api';\nexport const load = () => fetch(`${API_ROOT}/items`);\n",
    );

    let (routes, _) = routes(repo, "src");
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/v2/items".to_string())]
    );
}

#[test]
fn tsconfig_paths_alias_resolves_the_prefix() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "web/tsconfig.json",
        r#"{
  // comments and trailing commas are legal in tsconfig
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "@shared/*": ["src/shared/*"],
    },
  },
}
"#,
    );
    write(
        repo,
        "web/src/shared/urls.ts",
        "export const API_ROOT = '/api/aliased';\n",
    );
    write(
        repo,
        "web/src/service.ts",
        "import { API_ROOT } from '@shared/urls';\nexport const load = () => fetch(`${API_ROOT}/orders`);\n",
    );

    let (routes, _) = routes(repo, "web/src");
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/aliased/orders".to_string())]
    );
}

#[test]
fn a_shadowing_local_still_poisons_the_imported_constant() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(repo, "src/urls.ts", "export const API_ROOT = '/api';\n");
    write(
        repo,
        "src/service.ts",
        "import { API_ROOT } from './urls';\nexport function load() { const API_ROOT = compute(); return fetch(`${API_ROOT}/users`); }\n",
    );

    let (routes, _) = routes(repo, "src");
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/users".to_string())],
        "the shadowed local must win over the import; the unresolved leading prefix is an assumption, not /api"
    );
}
