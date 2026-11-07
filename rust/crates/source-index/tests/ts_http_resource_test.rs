//! Angular `httpResource` and `fetch(new Request(...))` consumer forms.
//!
//! Both are literal-only: a URL that is not a literal/constant is recorded as an
//! unresolved client call, never as a guessed route.

use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn extract(source: &str) -> (Vec<(String, String)>, Vec<String>) {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(repo, "src/client.ts", source);
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    let blockers = completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.clone())
        .collect();
    (routes, blockers)
}

#[test]
fn http_resource_literal_and_object_forms_are_recognized() {
    let (routes, blockers) = extract(
        r#"
import { httpResource } from '@angular/common/http';

export class Api {
  readonly status = httpResource(() => '/api/status');
  readonly items = httpResource(() => ({
    url: '/api/items',
    method: 'POST',
    body: { name: 'x' },
  }));
  readonly raw = httpResource.text(() => '/api/raw-text');
}
"#,
    );
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/raw-text".to_string()),
            ("GET".to_string(), "/api/status".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
        ]
    );
    assert!(blockers.is_empty(), "{blockers:?}");
}

#[test]
fn guarded_resource_return_uses_the_request_and_not_the_undefined_guard() {
    // Shape used by JHipster's generated Angular services: the arrow can return
    // `undefined` while the signal has no params, then the real request object.
    let (routes, blockers) = extract(
        r#"
import { httpResource } from '@angular/common/http';

export class AuthoritiesService {
  protected readonly resourceUrl = '/api/authorities';
  readonly authoritiesResource = httpResource<any[]>(() => {
    const params = this.params();
    if (!params) {
      return undefined;
    }
    return { url: this.resourceUrl, params };
  });
  private params() { return null; }
}
"#,
    );
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/authorities".to_string())]
    );
    assert!(blockers.is_empty(), "{blockers:?}");
}

#[test]
fn http_resource_dynamic_url_is_unresolved_not_invented() {
    let (routes, blockers) = extract(
        r#"
import { httpResource } from '@angular/common/http';

export class Api {
  readonly current = httpResource(() => buildUrl());
}

declare const buildUrl: () => string;
"#,
    );
    assert!(routes.is_empty(), "{routes:?}");
    assert!(
        blockers
            .iter()
            .any(|code| code == "TS_UNRESOLVED_CLIENT_URL"),
        "{blockers:?}"
    );
}

#[test]
fn http_resource_with_a_dynamic_method_is_unresolved() {
    let (routes, blockers) = extract(
        r#"
import { httpResource } from '@angular/common/http';

export function make(verb: string) {
  return httpResource(() => ({ url: '/api/things', method: verb }));
}
"#,
    );
    assert!(routes.is_empty(), "{routes:?}");
    assert!(
        blockers
            .iter()
            .any(|code| code == "TS_UNRESOLVED_CLIENT_URL"),
        "{blockers:?}"
    );
}

#[test]
fn a_lookalike_http_resource_helper_is_not_a_client() {
    let (routes, blockers) = extract(
        r#"
function httpResource<T>(factory: () => T): T {
  return factory();
}
httpResource(() => '/api/not-http');
"#,
    );
    assert!(routes.is_empty(), "{routes:?}");
    assert!(blockers
        .iter()
        .all(|code| code != "TS_UNRESOLVED_CLIENT_URL"));
}

#[test]
fn fetch_with_request_objects_covers_direct_and_one_hop_forms() {
    let (routes, blockers) = extract(
        r#"
const direct = fetch(new Request('/api/direct'));
const posted = fetch(new Request('/api/direct-items', { method: 'POST', body: 'x' }));
const local = new Request('/api/local', { method: 'PUT' });
const oneHop = fetch(local);
"#,
    );
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/direct".to_string()),
            ("POST".to_string(), "/api/direct-items".to_string()),
            ("PUT".to_string(), "/api/local".to_string()),
        ]
    );
    assert!(blockers.is_empty(), "{blockers:?}");
}

#[test]
fn request_with_a_dynamic_url_is_unresolved() {
    let (routes, blockers) = extract(
        r#"
export function load(path: string) {
  return fetch(new Request(path));
}
"#,
    );
    assert!(routes.is_empty(), "{routes:?}");
    assert!(
        blockers
            .iter()
            .any(|code| code == "TS_UNRESOLVED_CLIENT_URL"),
        "{blockers:?}"
    );
}

#[test]
fn a_class_named_request_is_not_the_ambient_type() {
    let (routes, blockers) = extract(
        r#"
class Request {
  constructor(public url: string) {}
}
declare const doFetch: (r: Request) => void;
doFetch(new Request('/api/not-http'));
"#,
    );
    assert!(routes.is_empty(), "{routes:?}");
    assert!(blockers
        .iter()
        .all(|code| code != "TS_UNRESOLVED_CLIENT_URL"));
}
