use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write_file(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn test_adversarial_nested_template_literals() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let source = r#"
export interface ScopeDetails {
    scope: string;
    itemId: string;
}

export interface CatalogPage {
    items: string[];
    page: number;
}

export class NestedRouteService {
    constructor(private http: any) {}

    fetchNested(scope: string, subId: string) {
        return this.http.get<ScopeDetails>(`/api/scopes/${scope}/sub/${`item_${subId}`}/details`);
    }

    fetchWithQuery(category: string, page: number) {
        return this.http.get<CatalogPage>(`/api/catalog?cat=${category}&page=${page}`);
    }
}
"#;

    write_file(&repo_root, "src/nested.service.ts", source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(completeness.complete, "Extraction should be complete: {:?}", completeness.blockers);
    assert_eq!(payload.client_contracts.len(), 2);

    let query_route = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route.starts_with("/api/catalog"))
        .expect("catalog route must be found");
    assert_eq!(query_route.http_method, "GET");

    let nested_route = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route.contains("/api/scopes"))
        .expect("nested scope route must be found");
    assert_eq!(nested_route.http_method, "GET");
}

#[test]
fn test_adversarial_rxjs_pipe_operators_preserves_dto_and_route() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let source = r#"
import { Observable } from 'rxjs';
import { map, catchError, filter, tap } from 'rxjs/operators';

export interface UserSummary {
    id: string;
    username: string;
    active: boolean;
}

export class UserStreamService {
    constructor(private http: any) {}

    getUsers(): Observable<UserSummary[]> {
        return this.http.get<UserSummary[]>('/api/v2/users').pipe(
            filter((users: UserSummary[]) => users.length > 0),
            map((users: UserSummary[]) => users.map(u => ({ ...u, username: u.username.toLowerCase() }))),
            tap(users => console.log(users.length)),
            catchError(err => { throw err; })
        );
    }
}
"#;

    write_file(&repo_root, "src/stream.service.ts", source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(
        completeness.complete,
        "Completeness failed: blockers={:?}, unresolved={:?}",
        completeness.blockers,
        completeness.unresolved_endpoints
    );
    assert_eq!(payload.client_contracts.len(), 1);

    let contract = &payload.client_contracts[0];
    assert_eq!(contract.http_method, "GET");
    assert_eq!(contract.normalized_route, "/api/v2/users");
}

#[test]
fn test_adversarial_base_client_inheritance() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let base_source = r#"
export abstract class BaseHttpClient {
    constructor(protected http: any) {}
}
"#;

    let sub_source = r#"
import { BaseHttpClient } from './base';

export interface BillingInvoice {
    invoiceId: string;
    amountCents: number;
}

export class InvoiceClient extends BaseHttpClient {
    loadInvoice(id: string) {
        return this.http.get<BillingInvoice>(`/api/invoices/${id}`);
    }

    createInvoice(invoice: BillingInvoice) {
        return this.http.post<BillingInvoice>('/api/invoices', invoice);
    }
}
"#;

    write_file(&repo_root, "src/base.ts", base_source);
    write_file(&repo_root, "src/invoice.client.ts", sub_source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(
        completeness.complete,
        "Completeness failed: blockers={:?}, unresolved={:?}",
        completeness.blockers,
        completeness.unresolved_endpoints
    );
    assert_eq!(payload.client_contracts.len(), 2);

    let get_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET")
        .expect("must find GET /api/invoices/:param");
    assert_eq!(get_contract.normalized_route, "/api/invoices/:param");

    let post_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST")
        .expect("must find POST /api/invoices");
    assert_eq!(post_contract.normalized_route, "/api/invoices");
}

#[test]
fn test_adversarial_comments_and_multiline_url_expressions() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let source = r#"
export interface HealthStatus {
    status: string;
}

export interface AuditEntry {
    action: string;
}

export class CommentedService {
    constructor(private http: any) {}

    fetchData() {
        return this.http.get<HealthStatus>(
            /* leading comment */ '/api/system/health' /* trailing comment */
        );
    }

    postData(body: any) {
        return this.http.post<AuditEntry>(
            // Inline comment before url
            '/api/system/audit',
            body
        );
    }
}
"#;

    write_file(&repo_root, "src/commented.service.ts", source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(
        completeness.complete,
        "Completeness failed: blockers={:?}, unresolved={:?}",
        completeness.blockers,
        completeness.unresolved_endpoints
    );
    assert_eq!(payload.client_contracts.len(), 2);

    let health = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/system/health")
        .expect("must resolve health route cleanly despite comments");
    assert_eq!(health.http_method, "GET");

    let audit = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/system/audit")
        .expect("must resolve audit route cleanly despite comments");
    assert_eq!(audit.http_method, "POST");
}

#[test]
fn test_adversarial_recursive_interface_and_nested_generics() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let source = r#"
export interface TreeNode {
    id: string;
    label: string;
    parent?: TreeNode;
    children?: TreeNode[];
    metadata?: Record<string, string>;
}

export class TreeService {
    constructor(private http: any) {}

    getTreeRoot(treeId: string) {
        return this.http.get<TreeNode>(`/api/trees/${treeId}/root`);
    }
}
"#;

    write_file(&repo_root, "src/tree.service.ts", source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(
        completeness.complete,
        "Completeness failed: blockers={:?}, unresolved={:?}",
        completeness.blockers,
        completeness.unresolved_endpoints
    );
    assert_eq!(payload.client_contracts.len(), 1);

    let tree_route = &payload.client_contracts[0];
    assert_eq!(tree_route.http_method, "GET");
    assert_eq!(tree_route.normalized_route, "/api/trees/:param/root");
}

#[test]
fn test_adversarial_multiple_clients_with_overlapping_routes() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");

    let auth_source = r#"
export interface SessionToken {
    token: string;
}

export interface LogoutResult {
    ok: boolean;
}

export class AuthService {
    constructor(private http: any) {}
    login(creds: any) {
        return this.http.post<SessionToken>('/api/v1/auth/session', creds);
    }
    logout() {
        return this.http.delete<LogoutResult>('/api/v1/auth/session');
    }
}
"#;

    let session_source = r#"
export interface SessionInfo {
    active: boolean;
}

export class SessionInspector {
    constructor(private http: any) {}
    checkSession() {
        return this.http.get<SessionInfo>('/api/v1/auth/session');
    }
}
"#;

    write_file(&repo_root, "src/auth.service.ts", auth_source);
    write_file(&repo_root, "src/session.inspector.ts", session_source);

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui-app", "backend-svc");

    assert!(
        completeness.complete,
        "Completeness failed: blockers={:?}, unresolved={:?}",
        completeness.blockers,
        completeness.unresolved_endpoints
    );
    // POST /api/v1/auth/session, DELETE /api/v1/auth/session, GET /api/v1/auth/session
    assert_eq!(payload.client_contracts.len(), 3);

    let methods: Vec<String> = payload
        .client_contracts
        .iter()
        .map(|c| c.http_method.clone())
        .collect();
    assert!(methods.contains(&"POST".to_string()));
    assert!(methods.contains(&"DELETE".to_string()));
    assert!(methods.contains(&"GET".to_string()));
}
