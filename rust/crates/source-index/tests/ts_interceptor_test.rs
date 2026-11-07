use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn extract(files: &[(&str, &str)]) -> (serde_json::Value, Vec<String>, Vec<(String, String)>) {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    for (rel, content) in files {
        write(repo, rel, content);
    }
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    (
        payload
            .interceptor_evidence
            .clone()
            .unwrap_or(serde_json::Value::Null),
        completeness
            .blockers
            .iter()
            .map(|b| b.code.clone())
            .collect(),
        routes,
    )
}

#[test]
fn angular_interceptor_literal_prefix_is_recorded() {
    let (evidence, blockers, routes) = extract(&[
        (
            "src/app/auth.interceptor.ts",
            r#"
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';

export class AuthInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const authReq = req.clone({ url: '/api' + req.url });
    return next.handle(authReq);
  }
}
"#,
        ),
        (
            "src/app/user.service.ts",
            r#"
import axios from 'axios';

export class UserService {
  load() {
    axios.get('/users');
  }
}
"#,
        ),
    ]);
    assert!(blockers.is_empty(), "unexpected blockers: {blockers:?}");
    assert_eq!(evidence["complete"], serde_json::Value::Bool(true));
    let prefixes = evidence["prefixes"].as_array().unwrap();
    assert_eq!(prefixes.len(), 1);
    assert_eq!(prefixes[0]["prefix"], "/api");
    assert_eq!(prefixes[0]["framework"], "angular");
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/users".to_string())],
        "interceptor prefixes are evidence, not route rewrites"
    );
}

#[test]
fn axios_interceptor_base_url_constant_is_resolved() {
    let (evidence, blockers, _) = extract(&[(
        "src/api/client.ts",
        r#"
import axios from 'axios';

export const GATEWAY = '/gateway';

const client = axios.create();
client.interceptors.request.use((config) => {
  config.baseURL = GATEWAY;
  return config;
});
client.get('/ping');
"#,
    )]);
    assert!(blockers.is_empty(), "unexpected blockers: {blockers:?}");
    let prefixes = evidence["prefixes"].as_array().unwrap();
    assert_eq!(prefixes.len(), 1);
    assert_eq!(prefixes[0]["prefix"], "/gateway");
    assert_eq!(prefixes[0]["framework"], "axios");
}

#[test]
fn angular_functional_interceptor_is_scanned() {
    let (evidence, blockers, _) = extract(&[(
        "src/app/api.interceptor.ts",
        r#"
import { HttpInterceptorFn } from '@angular/common/http';

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const apiReq = req.clone({ url: '/api' + req.url });
  return next(apiReq);
};
"#,
    )]);
    assert!(
        !blockers
            .iter()
            .any(|code| code == "TS_INTERCEPTOR_PREFIX_UNRESOLVED"),
        "unexpected blockers: {blockers:?}"
    );
    assert_eq!(evidence["frameworks"], serde_json::json!(["angular"]));
    let prefixes = evidence["prefixes"].as_array().unwrap();
    assert_eq!(prefixes.len(), 1);
    assert_eq!(prefixes[0]["prefix"], "/api");
}

#[test]
fn unresolved_interceptor_prefix_blocks_without_inventing_one() {
    let (evidence, blockers, _) = extract(&[(
        "src/app/base.interceptor.ts",
        r#"
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';

export class BaseInterceptor implements HttpInterceptor {
  constructor(private config: any) {}
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const prefixed = req.clone({ url: this.config.apiBase + req.url });
    return next.handle(prefixed);
  }
}
"#,
    )]);
    assert!(
        blockers
            .iter()
            .any(|code| code == "TS_INTERCEPTOR_PREFIX_UNRESOLVED"),
        "expected the unresolved-prefix blocker, got {blockers:?}"
    );
    assert_eq!(evidence["complete"], serde_json::Value::Bool(false));
    assert!(evidence["prefixes"].as_array().unwrap().is_empty());
}
