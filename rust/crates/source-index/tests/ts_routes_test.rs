use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_unparsable_source_is_recorded_as_blocker() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("broken.ts"),
        "export class BrokenService {\n    getThing() {\n        return this.http.get<Thing>('/api/thing'\n}\n",
    )
    .expect("write broken");
    fs::write(
        src_dir.join("clean.ts"),
        "export interface Thing { id: string }\nexport class CleanService {\n    getOther() {\n        return this.http.get<Thing>('/api/other');\n    }\n}\n",
    )
    .expect("write clean");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (_, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| { b.code == "TS_PARSE_ERROR" && b.file.as_deref() == Some("src/broken.ts") }),
        "Parse failure must be recorded with its file: {:?}",
        completeness.blockers
    );
    assert!(
        !completeness.complete,
        "An unparsable source file must force complete=false"
    );
}

#[test]
fn test_native_typescript_route_extraction() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let service_ts = r#"
export interface DeviceProfile {
    id: string;
    name: string;
}

export class DeviceService {
    constructor(private http: any) {}

    getDevices() {
        return this.http.get<DeviceProfile[]>('/api/deviceProfile');
    }

    saveDevice(device: DeviceProfile) {
        return this.http.post<DeviceProfile>('/api/deviceProfile', device);
    }

    getDeviceById(id: string) {
        return this.http.get<DeviceProfile>(`/api/device/${id}`);
    }

    sendBeacon(data: any) {
        return fetch('/api/v1/beacon', { method: 'POST', body: JSON.stringify(data) });
    }
}
"#;

    fs::write(src_dir.join("device.service.ts"), service_ts).expect("write file");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");

    assert!(!extractor.calls.is_empty(), "Must extract calls");

    let envelope = extractor
        .build_envelope("ui-service", "backend-service", "HEAD")
        .expect("build envelope");

    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("Expected frontend payload"),
    };

    assert_eq!(
        payload.client_contracts.len(),
        4,
        "Must extract 4 unique routes"
    );

    let device_profile_post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/deviceProfile")
        .expect("Must find POST /api/deviceProfile");

    assert_eq!(device_profile_post.source_file, "src/device.service.ts");
    assert!(
        !device_profile_post.consumers.is_empty(),
        "Must have consumer call sites"
    );

    let template_get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/device/:param")
        .expect("Must normalize template literal to /api/device/:param");

    assert_eq!(template_get.source_file, "src/device.service.ts");

    let beacon_post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/v1/beacon")
        .expect("Must find fetch POST /api/v1/beacon");

    assert_eq!(beacon_post.source_file, "src/device.service.ts");
}

#[test]
fn test_generic_scope_and_template_concatenation() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let advanced_ts = r#"
export const API_PREFIX = '/api/images';

export class AdvancedService {
    private readonly baseUrl = '/api/converter/library';
    constructor(private http: any) {}

    // 1. Class field constant resolution (this.baseUrl)
    getLibrary(id: string) {
        return this.http.get(`${this.baseUrl}/${id}/vendors`);
    }

    // 2. Local variable resolution (let url = ...)
    saveAgent(data: any) {
        let url = '/api/agent';
        return this.http.post(url, data);
    }

    // 3. Binary concatenation of template strings + query generator suppression
    getEvents(type: string, id: string, pageLink: any) {
        return this.http.get(`/api/events/${type}/${id}` + `${pageLink.toQuery()}`);
    }

    // 4. File-level constant resolution
    getImage(key: string) {
        return this.http.get(`${API_PREFIX}/${key}`);
    }
}
"#;

    fs::write(src_dir.join("advanced.service.ts"), advanced_ts).expect("write file");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");

    let envelope = extractor
        .build_envelope("ui-service", "backend-service", "HEAD")
        .expect("build envelope");

    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("Expected frontend payload"),
    };

    // 1. baseUrl should resolve to /api/converter/library/:param/vendors
    let library_get = payload
        .client_contracts
        .iter()
        .find(|c| {
            c.http_method == "GET" && c.normalized_route == "/api/converter/library/:param/vendors"
        })
        .expect("Must resolve this.baseUrl to /api/converter/library/:param/vendors");
    assert_eq!(library_get.source_file, "src/advanced.service.ts");

    // 2. local variable url should resolve to /api/agent
    let agent_post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/agent")
        .expect("Must resolve local variable url to /api/agent");
    assert_eq!(agent_post.source_file, "src/advanced.service.ts");

    // 3. binary template concatenation should resolve to /api/events/:param/:param
    let events_get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/events/:param/:param")
        .expect("Must resolve concatenated template string to /api/events/:param/:param");
    assert_eq!(events_get.source_file, "src/advanced.service.ts");

    // 4. file-level constant should resolve to /api/images/:param
    let image_get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/images/:param")
        .expect("Must resolve API_PREFIX to /api/images/:param");
    assert_eq!(image_get.source_file, "src/advanced.service.ts");
}

#[test]
fn test_awaited_generic_http_call_and_interface_extraction() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let types_ts = r#"
export interface LowStock {
    productVariantId: number;
    stock: number;
    threshold: number;
}

export interface HomeDashboard {
    lowStock: LowStock[];
}
"#;

    let api_ts = r#"
import { HomeDashboard } from './types';

export async function fetchHomeDashboard(): Promise<HomeDashboard> {
    const response = await api.get<HomeDashboard>('/home-dashboard');
    return response.data;
}

export async function fetchUntyped() {
    return await api.get('/untyped-endpoint');
}
"#;

    fs::write(src_dir.join("types.ts"), types_ts).expect("write types");
    fs::write(src_dir.join("api.ts"), api_ts).expect("write api");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");

    let mut envelope = extractor
        .build_envelope("frontend", "backend", "HEAD")
        .expect("build envelope");

    contract_core::expansion::expand_type_pool(&mut envelope)
        .expect("expand_type_pool must succeed cleanly on envelope");

    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("Expected frontend payload"),
    };

    // 1. Awaited generic call MUST NOT be dropped!
    let home_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/home-dashboard")
        .expect("Must extract awaited generic call to /home-dashboard");

    assert_eq!(home_contract.source_file, "src/api.ts");
    assert_eq!(
        home_contract.decoder_kind,
        contract_core::envelope::DecoderKind::InferredType
    );

    // 2. Type pool must contain HomeDashboard with properties!
    let type_pool = payload.type_pool.expect("type pool present");
    let hd_entry = type_pool
        .iter()
        .find(|(k, _)| k.ends_with("#HomeDashboard"))
        .expect("HomeDashboard in type pool");
    match hd_entry.1 {
        contract_core::ir::WireType::Object(ref obj) => {
            assert!(
                obj.properties.iter().any(|p| p.wire_name == "lowStock"),
                "Must contain lowStock property"
            );
        }
        _ => panic!("Expected ObjectWireType for HomeDashboard"),
    }

    // 3. Completeness must be honest: fetchUntyped has Unknown response, so complete = false
    assert!(
        !envelope.completeness.complete,
        "Completeness must be false when untyped calls exist"
    );
    assert!(envelope
        .completeness
        .unresolved_endpoints
        .contains(&"GET /untyped-endpoint".to_string()));
}

#[test]
fn test_promise_and_assertion_return_type_inference() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let types_ts = r#"
export interface OrderCreateResponse {
    orderId: string;
    totalAmount: number;
    unionField: string | number;
    callback: () => void;
}

export interface OrderSummaryResponse {
    orderId: string;
    status: string;
}
"#;

    let orders_ts = r#"
import { OrderCreateResponse, OrderSummaryResponse } from './types';

// 1. Inferred from Promise<T> on returned call only, side-effect call remains UNKNOWN
export async function createOrder(): Promise<OrderCreateResponse> {
    await api.get('/unrelated-config');
    const res = await api.post('/orders', undefined);
    return res.data;
}

// 2. Inferred from Promise<T[]> and res.data as T[]
export async function getMyOrders(): Promise<OrderSummaryResponse[]> {
    try {
        const res = await api.get('/orders/me');
        return res.data as OrderSummaryResponse[];
    } catch (e) {
        throw e;
    }
}
"#;

    fs::write(src_dir.join("types.ts"), types_ts).expect("write types");
    fs::write(src_dir.join("orders.ts"), orders_ts).expect("write orders");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");

    let mut envelope = extractor
        .build_envelope("frontend", "backend", "HEAD")
        .expect("build envelope");

    // Critical: expand_type_pool must succeed without bailing on non-identifier expressions!
    contract_core::expansion::expand_type_pool(&mut envelope)
        .expect("expand_type_pool must succeed cleanly on envelope");

    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("Expected frontend payload"),
    };

    // Check that side-effect /unrelated-config did NOT inherit Promise<OrderCreateResponse>!
    let unrelated = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/unrelated-config")
        .expect("Must find GET /unrelated-config");
    assert_eq!(
        unrelated.decoder_kind,
        contract_core::envelope::DecoderKind::Unknown
    );
    assert!(matches!(
        unrelated.expected_response,
        contract_core::ir::WireType::Unknown(_)
    ));

    // Check POST /orders inferred OrderCreateResponse from Promise<OrderCreateResponse>
    let create_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/orders")
        .expect("Must find POST /orders");
    assert_eq!(
        create_contract.decoder_kind,
        contract_core::envelope::DecoderKind::InferredType
    );
    match create_contract.expected_response {
        contract_core::ir::WireType::Object(ref obj) => {
            assert!(obj.name.as_deref() == Some("OrderCreateResponse"));
            // callback has no structural wire shape; unionField is a two-arm union.
            let union_prop = obj
                .properties
                .iter()
                .find(|p| p.wire_name == "unionField")
                .expect("unionField prop");
            match &union_prop.r#type {
                contract_core::ir::WireType::Union(union) => {
                    assert_eq!(union.types.len(), 2, "both scalar arms are retained");
                }
                other => panic!("a resolvable scalar union must stay a union, got {other:?}"),
            }
        }
        _ => panic!(
            "Expected Object for expanded OrderCreateResponse, got {:?}",
            create_contract.expected_response
        ),
    }

    // Check GET /orders/me inferred OrderSummaryResponse[]
    let my_orders = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/orders/me")
        .expect("Must find GET /orders/me");
    assert_eq!(
        my_orders.decoder_kind,
        contract_core::envelope::DecoderKind::InferredType
    );
    match my_orders.expected_response {
        contract_core::ir::WireType::Array(ref arr) => match &*arr.element_type {
            contract_core::ir::WireType::Object(ref obj) => {
                assert!(obj.name.as_deref() == Some("OrderSummaryResponse"));
            }
            _ => panic!("Expected Object for expanded OrderSummaryResponse in array"),
        },
        _ => panic!(
            "Expected Array of OrderSummaryResponse, got {:?}",
            my_orders.expected_response
        ),
    }
}

#[test]
fn test_query_named_path_variable_keeps_its_segment() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let search_ts = r#"
export class SearchService {
    constructor(private http: any) {}

    // A path variable that merely happens to be named "query" is still a path segment.
    search(query: string) {
        return this.http.get(`/api/search/${query}`);
    }

    searchWithinReport(reportId: string, queryId: string) {
        return this.http.get(`/api/reports/${reportId}/queries/${queryId}/export`);
    }

    // A genuine query-string builder contributes no path segment.
    listAlerts(params: any) {
        return this.http.get(`/api/alerts${new URLSearchParams(params).toString()}`);
    }

    // A literal query string is truncated by the path normalizer.
    listThings(active: boolean) {
        return this.http.get(`/api/things?active=${active}`);
    }

    // Glued query accumulators must stay suppressed: these are the idioms a bare
    // segment-boundary rule would otherwise mangle into `installedItems:param`.
    listInstalledItems(query: string) {
        return this.http.get(`/api/iot-hub/installedItems${query}`);
    }

    listSchedulerEvents(type: string, pageLink: any, edgeId: string) {
        return this.http.get(`/api/schedulerEvents${pageLink.toQuery()}${type ? `&type=${type}` : ''}${edgeId ? `&edgeId=${edgeId}` : ''}`);
    }

    clearEvents(entityType: string, id: string, tenantId: string, startTime: number) {
        return this.http.post(`/api/events/${entityType}/${id}/clear?tenantId=${tenantId}` +
            (startTime ? `&startTime=${startTime}` : ``), {});
    }
}
"#;

    fs::write(src_dir.join("search.service.ts"), search_ts).expect("write file");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let envelope = extractor
        .build_envelope("ui-service", "backend-service", "HEAD")
        .expect("build envelope");

    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("Expected frontend payload"),
    };

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();

    for expected in [
        "/api/search/:param",
        "/api/reports/:param/queries/:param/export",
        "/api/alerts",
        "/api/things",
        "/api/iot-hub/installedItems",
        "/api/schedulerEvents",
        "/api/events/:param/:param/clear",
    ] {
        assert!(
            routes.contains(&expected),
            "Must extract {} without deleting a real path segment, got {:?}",
            expected,
            routes
        );
    }

    assert!(
        !routes.contains(&"/api/search"),
        "A substitution must never shorten the route it interpolates into: {:?}",
        routes
    );
    for route in &routes {
        for segment in route.split('/') {
            assert!(
                !segment.contains(":param") || segment == ":param",
                "A parameter token must never be glued to other segment text: {}",
                route
            );
        }
    }
}

/// Zero contracts read from a tree that clearly contains callers is a matcher gap, not an
/// empty client, and publishing it as complete hides the gap from the reader.
#[test]
fn test_unrecognized_call_idioms_are_reported_incomplete_not_empty() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    // A wrapper function called with only a URL string is indistinguishable from a
    // function taking an arbitrary string, so this idiom stays unrecognized.
    fs::write(
        src_dir.join("user.js"),
        "import request from '@/utils/request'\n\
         export function getUsers() {\n\
         \x20 return request('/api/users')\n\
         }\n",
    )
    .expect("write user.js");
    fs::write(
        src_dir.join("UserList.vue"),
        "<template><div/></template>\n\
         <script>\n\
         import request from '@/utils/request'\n\
         export default { methods: { load() { return request('/api/logs') } } }\n\
         </script>\n",
    )
    .expect("write UserList.vue");

    let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    assert_eq!(
        payload.client_contracts.len(),
        0,
        "a bare wrapper call with a string argument must not be guessed into an endpoint"
    );

    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        codes.contains(&"TS_NO_CLIENT_CALL_RECOGNIZED"),
        "reading files but recognizing no call site must be attributed: {codes:?}"
    );
    assert!(
        !codes.contains(&"TS_SOURCE_NOT_PARSED"),
        "SFC scripts are handed to the parser, so a blanket not-parsed blocker would be false: {codes:?}"
    );
    assert_eq!(
        extractor.scanned_source_files, 2,
        "the SFC must count as a scanned source file"
    );
    assert!(
        !completeness.complete,
        "an artifact with no consumer expectations must not claim completeness"
    );

    // Control: one recognized call site must silence the empty-population blocker, otherwise
    // the gate is just a constant and proves nothing.
    fs::write(
        src_dir.join("account.service.ts"),
        "import { HttpClient } from '@angular/common/http';\n\
         export class AccountService { constructor(private http: HttpClient) {}\n\
         \x20 save(body: unknown) { return this.http.post('/api/account', body); } }\n",
    )
    .expect("write account.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract 2");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    assert!(
        !payload.client_contracts.is_empty(),
        "the control fixture must produce a contract"
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_NO_CLIENT_CALL_RECOGNIZED"),
        "the empty-population blocker must not fire once a call site is recognized"
    );
}

#[test]
fn test_unresolved_leading_prefix_is_an_authority_prefix() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    // Real-world shapes: JHipster concatenates a webpack-defined base URL with no slash,
    // Angular style puts a slash between base URL and path, and a path parameter stays a
    // path parameter. Only the leading, unresolvable expression is an authority prefix.
    fs::write(
        src_dir.join("account.service.ts"),
        "export class AccountService {\n\
         \x20   constructor(private http: any) {}\n\
         \x20   activate() { return this.http.get(`${serverApiUrl}api/activate`); }\n\
         \x20   owners() { return this.http.get(`${baseUrl}/api/owners`); }\n\
         \x20   roles(userId: string) { return this.http.get(`/api/users/${userId}/roles`); }\n\
         }\n",
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(
        routes,
        vec!["/api/activate", "/api/owners", "/api/users/:param/roles"],
        "a leading base-URL prefix must not become a route segment: {routes:?}"
    );

    let activate = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/activate")
        .expect("activate contract");
    assert!(
        activate
            .unresolved_evidence
            .iter()
            .any(|e| e.contains("serverApiUrl") && e.contains("base-URL prefix")),
        "dropping the prefix must be recorded on the contract: {:?}",
        activate.unresolved_evidence
    );

    let roles = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/users/:param/roles")
        .expect("roles contract");
    assert!(
        !roles
            .unresolved_evidence
            .iter()
            .any(|e| e.contains("base-URL prefix")),
        "a path parameter after literal text is not a base URL: {:?}",
        roles.unresolved_evidence
    );
}

#[test]
fn test_form_control_get_is_not_an_http_call() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    // Angular `FormGroup.get('field')` is not a request. The receiver, not the whole call
    // expression, decides: `apiKeyForm` and `clientRegistration` must not qualify.
    fs::write(
        src_dir.join("api-key-dialog.component.ts"),
        "export class ApiKeyDialogComponent {\n\
         \x20   constructor(private http: any, private apiKeyForm: any, private clientRegistration: any) {}\n\
         \x20   readFields() {\n\
         \x20       const expiration = this.apiKeyForm.get('expirationTime');\n\
         \x20       const title = this.clientRegistration.get('title');\n\
         \x20       return [expiration, title];\n\
         \x20   }\n\
         \x20   loadUsers() { return this.http.get<unknown[]>('/api/users'); }\n\
         }\n",
    )
    .expect("write component");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    assert_eq!(
        payload.client_contracts.len(),
        1,
        "form-control reads must not become contracts: {:?}",
        payload
            .client_contracts
            .iter()
            .map(|c| c.normalized_route.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(payload.client_contracts[0].normalized_route, "/api/users");
    assert_eq!(payload.client_contracts[0].http_method, "GET");
}

/// Angular services keep the URL prefix in a class field, either initialized inline,
/// built from an unresolved base URL, assigned in the constructor, or as a relative
/// fragment. Reading only rooted string literals made every one of these unlinkable.
#[test]
fn test_class_field_urls_resolve_for_all_initializer_forms() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("resources.service.ts"),
        "export class ResourcesService {\n\
         \x20   protected readonly resourceUrl = 'api/admin/users';\n\
         \x20   protected readonly baseUrl = `${serverApiUrl}api/account`;\n\
         \x20   private entityUrl: string;\n\
         \x20   constructor(private http: any) { this.entityUrl = 'api/owners'; }\n\
         \x20   list() { return this.http.get(this.resourceUrl); }\n\
         \x20   one(id: string) { return this.http.get(`${this.resourceUrl}/${id}`); }\n\
         \x20   account() { return this.http.get(this.baseUrl); }\n\
         \x20   owner(id: string) { return this.http.put(this.entityUrl + '/' + id, {}); }\n\
         }\n\
         class BaseService {\n\
         \x20   protected readonly resourceUrl = 'api/derived/items';\n\
         \x20   constructor(protected http: any) {}\n\
         }\n\
         class MiddleService extends BaseService {}\n\
         export class DerivedService extends MiddleService {\n\
         \x20   one(id: string) { return this.http.get(`${this.resourceUrl}/${id}`); }\n\
         }\n",
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    for expected in [
        "/api/admin/users",
        "/api/admin/users/:param",
        "/api/account",
        "/api/owners/:param",
        "/api/derived/items/:param",
    ] {
        assert!(
            routes.contains(&expected),
            "class-field URL must resolve to {}, got {:?}",
            expected,
            routes
        );
    }

    let account = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/account")
        .expect("account contract");
    assert!(
        account
            .unresolved_evidence
            .iter()
            .any(|e| e.contains("serverApiUrl") && e.contains("base-URL prefix")),
        "a prefix stripped inside a field must still be disclosed: {:?}",
        account.unresolved_evidence
    );
}

/// Two files declare the same simple name; the importer's specifier decides which one is
/// meant, including through an alias and through `import type`.
#[test]
fn test_imports_select_the_declaring_file_for_duplicate_type_names() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let a = repo_root.join("src/a");
    let b = repo_root.join("src/b");
    fs::create_dir_all(&a).expect("create a");
    fs::create_dir_all(&b).expect("create b");

    fs::write(
        a.join("widget.models.ts"),
        "export interface WidgetAction { kind: string; }\n",
    )
    .expect("write a declarations");
    fs::write(
        b.join("other.models.ts"),
        "export interface WidgetAction { action: string; }\n",
    )
    .expect("write b declarations");
    // The import points at the declaration that the suffix fallback would NOT choose:
    // `src/a/...` sorts before `src/b/...`, so only import-aware resolution can be right.
    fs::write(
        b.join("holder.ts"),
        "import { WidgetAction } from '../b/other.models';\n\
         import type { WidgetAction as Action } from '../b/other.models';\n\
         export interface Holder { action: WidgetAction; aliased: Action; }\n\
         export class HolderService {\n\
         \x20   constructor(private http: any) {}\n\
         \x20   getHolder() { return this.http.get<Holder>('/api/holder'); }\n\
         \x20   getAction() { return this.http.get<WidgetAction>('/api/action'); }\n\
         }\n",
    )
    .expect("write holder");

    let src_dir = repo_root.join("src");
    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let pool = payload.type_pool.expect("type pool");

    let holder = pool
        .iter()
        .find(|(k, _)| k.ends_with("#Holder"))
        .map(|(_, v)| v.clone())
        .expect("Holder in type pool");
    let contract_core::ir::WireType::Object(obj) = holder else {
        panic!("Holder must be an object, got {holder:?}");
    };
    for prop_name in ["action", "aliased"] {
        let prop = obj
            .properties
            .iter()
            .find(|p| p.wire_name == prop_name)
            .expect("property present");
        let contract_core::ir::WireType::Ref(r) = &prop.r#type else {
            panic!(
                "{} must reference a declared type, got {:?}",
                prop_name, prop.r#type
            );
        };
        assert_eq!(
            r.r#ref, "ts:src/b/other.models.ts#WidgetAction",
            "the import specifier must win over the lexicographically first same-named declaration"
        );
    }

    let action_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/action")
        .expect("action contract");
    let contract_core::ir::WireType::Ref(r) = &action_contract.expected_response else {
        panic!(
            "response type must resolve through the import, got {:?}",
            action_contract.expected_response
        );
    };
    assert_eq!(r.r#ref, "ts:src/b/other.models.ts#WidgetAction");
}

#[test]
fn test_ambiguous_duplicate_type_names_stay_unresolved_deterministically() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let a = repo_root.join("src/a");
    let b = repo_root.join("src/b");
    fs::create_dir_all(&a).expect("create a");
    fs::create_dir_all(&b).expect("create b");

    // The same simple name is declared twice and this holder imports neither, so no
    // source evidence selects a declaration. Binding the lexicographically first one
    // would fabricate a shape; the reference must stay unresolved instead.
    fs::write(
        a.join("widget.models.ts"),
        "export interface WidgetAction { kind: string; }\n",
    )
    .expect("write a declarations");
    fs::write(
        b.join("other.models.ts"),
        "export interface WidgetAction { action: string; }\n",
    )
    .expect("write b declarations");
    fs::write(
        b.join("holder.ts"),
        "export interface Holder { action: WidgetAction; }\n\
         export class HolderService {\n\
         \x20   constructor(private http: any) {}\n\
         \x20   getHolder() { return this.http.get<Holder>('/api/holder'); }\n\
         }\n",
    )
    .expect("write holder");

    let mut fingerprints = Vec::new();
    for _ in 0..5 {
        let extractor = TypeScriptRouteExtractor::new(repo_root.clone(), &repo_root.join("src"))
            .expect("extract");
        let (payload, _) = extractor.extract_payload("ui", "backend");
        let pool = payload.type_pool.expect("type pool");
        let holder = pool
            .iter()
            .find(|(k, _)| k.ends_with("#Holder"))
            .map(|(_, v)| v.clone())
            .expect("Holder in type pool");
        let contract_core::ir::WireType::Object(obj) = holder else {
            panic!("Holder must be an object, got {holder:?}");
        };
        let action = obj
            .properties
            .iter()
            .find(|p| p.wire_name == "action")
            .map(|p| p.r#type.clone())
            .expect("action property");
        assert!(
            matches!(
                action,
                contract_core::ir::WireType::Unknown(ref u) if u.reason.contains("WidgetAction")
            ),
            "an import-less reference to two same-named declarations must not bind to either, got {action:?}"
        );
        fingerprints.push(format!("{pool:?}"));
    }

    assert!(
        fingerprints.windows(2).all(|w| w[0] == w[1]),
        "repeated extraction of identical sources must produce an identical type pool"
    );
}

#[test]
fn test_type_alias_and_mapped_type_expansion() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
export interface IAddress { street: string; }

export interface IUser {
  login: string;
  lastName?: string | null;
  address: IAddress;
  createdDate?: string;
}

type RestOf<T> = Omit<T, 'createdDate'> & { createdDate?: string | null };
export type RestUser = RestOf<IUser>;
export type PickedUser = Pick<IUser, 'login'>;
export type PartialUser = Partial<IUser>;
export type OmittedUser = Omit<IUser, 'lastName'>;

type LoopA = LoopB;
type LoopB = LoopA;

export class UserService {
  constructor(private http: any) {}
  getRest() { return this.http.get<RestUser>('/api/rest'); }
  getPicked() { return this.http.get<PickedUser>('/api/picked'); }
  getPartial() { return this.http.get<PartialUser>('/api/partial'); }
  getOmitted() { return this.http.get<OmittedUser>('/api/omitted'); }
  getLoop() { return this.http.get<LoopA>('/api/loop'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let response = |route: &str| -> contract_core::ir::WireType {
        payload
            .client_contracts
            .iter()
            .find(|c| c.http_method == "GET" && c.normalized_route == route)
            .unwrap_or_else(|| panic!("{route} contract"))
            .expected_response
            .clone()
    };
    let properties = |route: &str| -> Vec<(String, bool)> {
        match response(route) {
            contract_core::ir::WireType::Object(obj) => obj
                .properties
                .iter()
                .map(|p| (p.wire_name.clone(), p.optional))
                .collect(),
            other => panic!("{route} must expand to an object, got {other:?}"),
        }
    };

    assert_eq!(
        properties("/api/rest"),
        vec![
            ("login".to_string(), false),
            ("lastName".to_string(), true),
            ("address".to_string(), false),
            ("createdDate".to_string(), true),
        ],
        "a generic alias with Omit plus an additive intersection must expand to the base shape"
    );
    assert_eq!(
        properties("/api/picked"),
        vec![("login".to_string(), false)],
        "Pick must keep only the named keys"
    );
    assert_eq!(
        properties("/api/omitted"),
        vec![
            ("login".to_string(), false),
            ("address".to_string(), false),
            ("createdDate".to_string(), true),
        ],
        "Omit must remove the named keys"
    );
    assert_eq!(
        properties("/api/partial"),
        vec![
            ("login".to_string(), true),
            ("lastName".to_string(), true),
            ("address".to_string(), true),
            ("createdDate".to_string(), true),
        ],
        "Partial must make every base property optional"
    );
    match response("/api/loop") {
        contract_core::ir::WireType::Unknown(u) => assert!(
            u.reason.contains("recursive"),
            "a recursive alias must be unresolved with a reason, got {}",
            u.reason
        ),
        other => panic!("a recursive alias must stay unresolved, got {other:?}"),
    }

    let pool = payload.type_pool.expect("type pool");
    let rest_entry = pool
        .iter()
        .find(|(k, _)| k.ends_with("#RestUser"))
        .map(|(_, v)| v.clone())
        .expect("RestUser in type pool");
    match rest_entry {
        contract_core::ir::WireType::Object(obj) => assert_eq!(
            obj.properties.len(),
            4,
            "the pool entry for a non-literal alias must be its expanded shape, not an empty object"
        ),
        other => panic!("RestUser pool entry must be expanded, got {other:?}"),
    }
    let generic_entry = pool
        .iter()
        .find(|(k, _)| k.ends_with("#RestOf"))
        .map(|(_, v)| v.clone())
        .expect("RestOf in type pool");
    match generic_entry {
        contract_core::ir::WireType::Unknown(u) => assert!(
            u.reason.contains("type arguments"),
            "a generic alias must not be materialized without arguments, got {}",
            u.reason
        ),
        other => panic!("RestOf must stay explicitly unresolved, got {other:?}"),
    }

    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope)
        .expect("expanded aliases must not leave unresolved refs behind");
}

#[test]
fn test_empty_object_type_stays_unresolved() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("account.service.ts"),
        r#"
export class AccountService {
  constructor(private http: any) {}
  save(account: any): Observable<{}> {
    return this.http.post('/api/account', account);
  }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/account")
        .expect("POST /api/account contract");
    match &contract.expected_response {
        contract_core::ir::WireType::Unknown(u) => assert!(
            u.reason.contains("non-null"),
            "`{{}}` is TypeScript's non-nullish top type, not a wire shape; got {}",
            u.reason
        ),
        other => panic!(
            "an empty object type must stay unresolved instead of becoming a zero-field shape, got {other:?}"
        ),
    }
    assert!(
        completeness
            .unresolved_endpoints
            .iter()
            .any(|e| e == "POST /api/account"),
        "an untyped response must be reported as unresolved: {:?}",
        completeness.unresolved_endpoints
    );
}

#[test]
fn test_class_declaration_supplies_response_shape() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("account.model.ts"),
        r#"
export class Account {
  constructor(
    public activated: boolean,
    public authorities: string[],
    public email: string,
    public lastName: string | null,
    public nickname?: string,
    private secret: string,
  ) {}
  public login: string = '';
  private cache: string = '';
}
"#,
    )
    .expect("write model");
    // The model file carries no HTTP call and no interface/`type` keyword, so it is only
    // visited because class declarations count as type sources.
    fs::write(
        src_dir.join("account.service.ts"),
        r#"
import { Account } from './account.model';

export class AccountService {
  constructor(private http: any) {}
  getAccount() { return this.http.get<Account>('/api/account'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected a frontend payload"),
    };

    let account = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/account")
        .expect("GET /api/account contract")
        .expected_response
        .clone();
    let contract_core::ir::WireType::Object(obj) = account else {
        panic!("a class-typed response must expand to an object, got {account:?}");
    };
    let props: Vec<(String, bool)> = obj
        .properties
        .iter()
        .map(|p| (p.wire_name.clone(), p.optional))
        .collect();
    assert_eq!(
        props,
        vec![
            ("activated".to_string(), false),
            ("authorities".to_string(), false),
            ("email".to_string(), false),
            ("lastName".to_string(), false),
            ("nickname".to_string(), true),
            ("login".to_string(), false),
        ],
        "constructor parameter properties and declared fields are wire shape; private members are not"
    );

    let pool = payload.type_pool.expect("type pool");
    let account_entry = pool
        .iter()
        .find(|(k, _)| k.ends_with("#Account"))
        .map(|(_, v)| v.clone())
        .expect("Account in type pool");
    match account_entry {
        contract_core::ir::WireType::Object(o) => assert_eq!(
            o.properties.len(),
            6,
            "the pool entry for a class must carry every wire-visible member"
        ),
        other => panic!("Account pool entry must be an object, got {other:?}"),
    }
}

fn object_property<'a>(
    wire: &'a contract_core::ir::WireType,
    name: &str,
) -> &'a contract_core::ir::WirePropertyContract {
    match wire {
        contract_core::ir::WireType::Object(obj) => obj
            .properties
            .iter()
            .find(|p| p.wire_name == name)
            .unwrap_or_else(|| panic!("property {name} must exist in {obj:?}")),
        other => panic!("expected an object carrying `{name}`, got {other:?}"),
    }
}

fn unpeeled(wire: &contract_core::ir::WireType) -> &contract_core::ir::WireType {
    match wire {
        contract_core::ir::WireType::Nullable(n) => unpeeled(&n.inner_type),
        contract_core::ir::WireType::Optional(o) => unpeeled(&o.inner_type),
        other => other,
    }
}

#[test]
fn test_nullish_and_literal_unions_map_to_wire_flags() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.model.ts"),
        r#"
export type Role = 'ADMIN' | 'USER' | 'USER';
export type Mixed = string | number;

export interface IUser {
  lastName?: string | null;
  nickname: string | undefined;
  plain: string | null;
  role: Role;
  inlineRole: 'ON' | 'OFF';
  mixed: Mixed;
  tags: Array<string | null>;
}

export class Badge {
  constructor(public code: 'GOLD' | 'SILVER', public note: string | null) {}
}
"#,
    )
    .expect("write model");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
import { IUser, Badge } from './user.model';

export class UserService {
  constructor(private http: any) {}
  getUser(): Observable<IUser> { return this.http.get<IUser>('/api/user'); }
  getBadge(): Observable<Badge> { return this.http.get<Badge>('/api/badge'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected a frontend payload"),
    };
    let response = |route: &str| -> contract_core::ir::WireType {
        payload
            .client_contracts
            .iter()
            .find(|c| c.http_method == "GET" && c.normalized_route == route)
            .unwrap_or_else(|| panic!("{route} contract"))
            .expected_response
            .clone()
    };
    let is_string = |wire: &contract_core::ir::WireType| {
        matches!(
            unpeeled(wire),
            contract_core::ir::WireType::Primitive(p)
                if p.scalar == contract_core::ir::PrimitiveScalar::String
        )
    };

    let user = response("/api/user");

    let last_name = object_property(&user, "lastName");
    assert!(
        last_name.optional && last_name.nullable,
        "`x?: T | null` must be both omittable and nullable: optional={} nullable={}",
        last_name.optional,
        last_name.nullable
    );
    assert!(is_string(&last_name.r#type), "the null arm must peel to T");

    let nickname = object_property(&user, "nickname");
    assert!(
        nickname.optional && !nickname.nullable,
        "`T | undefined` means omission, not null: optional={} nullable={}",
        nickname.optional,
        nickname.nullable
    );

    let plain = object_property(&user, "plain");
    assert!(
        !plain.optional && plain.nullable,
        "`T | null` means null, not omission: optional={} nullable={}",
        plain.optional,
        plain.nullable
    );

    let role = object_property(&user, "role");
    match unpeeled(&role.r#type) {
        contract_core::ir::WireType::Enum(e) => assert_eq!(
            e.values,
            vec![serde_json::json!("ADMIN"), serde_json::json!("USER")],
            "an all-literal union is a closed value set, deduplicated in source order"
        ),
        other => panic!("a literal union alias must map to an enum, got {other:?}"),
    }

    let inline_role = object_property(&user, "inlineRole");
    match unpeeled(&inline_role.r#type) {
        contract_core::ir::WireType::Enum(e) => assert_eq!(
            e.values,
            vec![serde_json::json!("ON"), serde_json::json!("OFF")],
            "an inline literal union must map to an enum"
        ),
        other => panic!("an inline literal union must map to an enum, got {other:?}"),
    }

    let mixed = object_property(&user, "mixed");
    match unpeeled(&mixed.r#type) {
        contract_core::ir::WireType::Union(union) => {
            assert_eq!(
                union.types.len(),
                2,
                "`string | number` keeps both arms as an exact value set"
            );
            assert!(
                is_string(&union.types[0])
                    && matches!(
                        &union.types[1],
                        contract_core::ir::WireType::Primitive(p)
                            if p.scalar == contract_core::ir::PrimitiveScalar::Number
                    ),
                "the union arms must be the source's string and number, got {:?}",
                union.types
            );
        }
        other => panic!("a resolvable union must stay a union, got {other:?}"),
    }

    match &object_property(&user, "tags").r#type {
        contract_core::ir::WireType::Array(arr) => match &*arr.element_type {
            contract_core::ir::WireType::Nullable(n) => assert!(
                is_string(&n.inner_type),
                "`Array<string | null>` must keep the null arm on the element"
            ),
            other => {
                panic!("the element of `Array<string | null>` must stay nullable, got {other:?}")
            }
        },
        other => panic!("`Array<string | null>` must stay an array, got {other:?}"),
    }

    let badge = response("/api/badge");
    let code = object_property(&badge, "code");
    match unpeeled(&code.r#type) {
        contract_core::ir::WireType::Enum(e) => assert_eq!(
            e.values,
            vec![serde_json::json!("GOLD"), serde_json::json!("SILVER")],
            "constructor parameter properties must map literal unions the same way"
        ),
        other => panic!("a class literal-union member must map to an enum, got {other:?}"),
    }
    assert!(
        object_property(&badge, "note").nullable,
        "a class member typed `T | null` must be nullable"
    );

    let pool = payload.type_pool.expect("type pool");
    let pool_entry = |suffix: &str| -> contract_core::ir::WireType {
        pool.iter()
            .find(|(k, _)| k.ends_with(suffix))
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("{suffix} in type pool"))
    };
    assert!(
        matches!(pool_entry("#Role"), contract_core::ir::WireType::Enum(_)),
        "the alias pool entry for a literal union must be an enum"
    );
    match pool_entry("#Mixed") {
        contract_core::ir::WireType::Union(union) => assert_eq!(
            union.types.len(),
            2,
            "a mixed-union alias keeps both arms, not one of them"
        ),
        other => panic!("Mixed must stay a two-arm union, got {other:?}"),
    }
}

#[test]
fn test_imported_type_inside_a_contract_response_is_resolved_not_dangling() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("bank.model.ts"),
        "export interface IBankAccount {\n  iban: string;\n}\n",
    )
    .expect("write bank model");
    fs::write(
        src_dir.join("operation.model.ts"),
        r#"
import { IBankAccount } from 'app/bank.model';

export interface IOperation {
  id: number;
  bankAccount?: IBankAccount | null;
}

export type RestOperation = Omit<IOperation, 'id'> & { id: number };
"#,
    )
    .expect("write operation model");
    fs::write(
        src_dir.join("operation.service.ts"),
        r#"
import { RestOperation } from './operation.model';

export class OperationService {
  constructor(private http: any) {}
  get(): Observable<RestOperation[]> { return this.http.get<RestOperation[]>('/api/operations'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    // A ref qualified by the declaring file points at the importing file, which has no
    // such declaration. Expansion must not fail on it.
    contract_core::expansion::expand_type_pool(&mut envelope)
        .expect("an imported type nested in a contract response must resolve through the pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected a frontend payload"),
    };

    let response = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/operations")
        .expect("GET /api/operations contract")
        .expected_response
        .clone();
    let contract_core::ir::WireType::Array(arr) = response else {
        panic!("the response must stay an array, got {response:?}");
    };
    let bank_account = object_property(&arr.element_type, "bankAccount");
    match unpeeled(&bank_account.r#type) {
        contract_core::ir::WireType::Object(obj) => assert!(
            obj.properties.iter().any(|p| p.wire_name == "iban"),
            "the imported interface's own shape must be reachable, got {obj:?}"
        ),
        other => panic!("`bankAccount` must expand to the imported interface, got {other:?}"),
    }
}

fn collect_refs(wire: &contract_core::ir::WireType, out: &mut Vec<String>) {
    use contract_core::ir::WireType;
    match wire {
        WireType::Ref(r) => out.push(r.r#ref.clone()),
        WireType::Array(a) => collect_refs(&a.element_type, out),
        WireType::Object(o) => {
            for p in &o.properties {
                collect_refs(&p.r#type, out);
            }
        }
        WireType::Map(m) => {
            collect_refs(&m.key_type, out);
            collect_refs(&m.value_type, out);
        }
        WireType::Nullable(n) => collect_refs(&n.inner_type, out),
        WireType::Optional(o) => collect_refs(&o.inner_type, out),
        WireType::Union(u) => {
            for t in &u.types {
                collect_refs(t, out);
            }
        }
        _ => {}
    }
}

fn collect_recursive_unknowns(wire: &contract_core::ir::WireType, out: &mut Vec<String>) {
    use contract_core::ir::WireType;
    match wire {
        WireType::Unknown(u) => {
            if u.reason.contains("Recursive") {
                out.push(u.reason.clone());
            }
        }
        WireType::Array(a) => collect_recursive_unknowns(&a.element_type, out),
        WireType::Object(o) => {
            for p in &o.properties {
                collect_recursive_unknowns(&p.r#type, out);
            }
        }
        WireType::Map(m) => {
            collect_recursive_unknowns(&m.key_type, out);
            collect_recursive_unknowns(&m.value_type, out);
        }
        WireType::Nullable(n) => collect_recursive_unknowns(&n.inner_type, out),
        WireType::Optional(o) => collect_recursive_unknowns(&o.inner_type, out),
        WireType::Union(u) => {
            for t in &u.types {
                collect_recursive_unknowns(t, out);
            }
        }
        _ => {}
    }
}

#[test]
fn test_recursive_interfaces_expand_without_leaking_refs() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("a.model.ts"),
        "import { B } from './b.model';\n\nexport interface A {\n  id: number;\n  b?: B | null;\n}\n",
    )
    .expect("write a");
    fs::write(
        src_dir.join("b.model.ts"),
        "import { A } from './a.model';\n\nexport interface B {\n  id: number;\n  a?: A | null;\n}\n",
    )
    .expect("write b");
    fs::write(
        src_dir.join("a.service.ts"),
        r#"
import { A } from './a.model';

export class AService {
  constructor(private http: any) {}
  get(): Observable<A> { return this.http.get<A>('/api/a'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected a frontend payload"),
    };
    let response = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/a")
        .expect("GET /api/a contract")
        .expected_response
        .clone();

    let mut refs = Vec::new();
    collect_refs(&response, &mut refs);
    assert!(
        refs.is_empty(),
        "expansion must not leave refs for the comparison to read as shapes: {refs:?}"
    );

    let mut recursive = Vec::new();
    collect_recursive_unknowns(&response, &mut recursive);
    assert!(
        !recursive.is_empty(),
        "the cycle must end in an explicitly unresolved recursive node, got {response:?}"
    );
}

#[test]
fn test_extends_merges_interface_and_class_bases() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("base.ts"),
        "export interface Audit { createdAt: string; createdBy?: string; }\n\
         export class BaseDto { id: number; }\n",
    )
    .expect("write base");
    fs::write(
        src_dir.join("derived.ts"),
        "import { Audit, BaseDto } from './base';\n\
         export interface Page extends Audit { items: string[]; }\n\
         export interface NoOwn extends Audit {}\n\
         export interface Combo extends Audit, Page { total: number; }\n\
         export class UserDto extends BaseDto { name: string; }\n\
         export class HolderService {\n\
         \x20   constructor(private http: any) {}\n\
         \x20   getPage() { return this.http.get<Page>('/api/page'); }\n\
         }\n",
    )
    .expect("write derived");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let pool = payload.type_pool.expect("type pool");

    let props = |key: &str| match pool.get(key) {
        Some(contract_core::ir::WireType::Object(obj)) => obj
            .properties
            .iter()
            .map(|p| p.wire_name.clone())
            .collect::<Vec<_>>(),
        other => panic!("{key} must be an Object, got {other:?}"),
    };

    assert_eq!(
        props("ts:src/derived.ts#Page"),
        vec!["createdAt", "createdBy", "items"],
        "an interface must inherit its base's properties before its own"
    );
    assert_eq!(
        props("ts:src/derived.ts#NoOwn"),
        vec!["createdAt", "createdBy"],
        "a derived interface with no own members still carries the base shape"
    );
    assert_eq!(
        props("ts:src/derived.ts#Combo"),
        vec!["createdAt", "createdBy", "items", "total"],
        "multiple bases merge left to right, then own members append"
    );
    assert_eq!(
        props("ts:src/derived.ts#UserDto"),
        vec!["id", "name"],
        "a class extends clause contributes the base class's fields"
    );

    let page = match pool.get("ts:src/derived.ts#Page") {
        Some(contract_core::ir::WireType::Object(obj)) => obj,
        other => panic!("Page must be an Object, got {other:?}"),
    };
    let created_by = page
        .properties
        .iter()
        .find(|p| p.wire_name == "createdBy")
        .expect("createdBy inherited");
    assert!(
        created_by.optional,
        "inherited optionality must be preserved"
    );

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/page")
        .expect("GET /api/page contract");
    match &contract.expected_response {
        contract_core::ir::WireType::Ref(reference) => {
            assert_eq!(reference.r#ref, "ts:src/derived.ts#Page")
        }
        other => panic!("the response must reference Page, got {other:?}"),
    }
}

#[test]
fn test_unresolved_or_circular_extends_stays_unknown() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("shapes.ts"),
        "import { ExternalBase } from 'some-library';\n\
         export interface ExternalDerived extends ExternalBase { own: string; }\n\
         export interface CycleA extends CycleB { a: string; }\n\
         export interface CycleB extends CycleA { b: string; }\n\
         export interface LocalBase { x: string; }\n\
         export interface LocalDerived extends LocalBase { y: number; }\n",
    )
    .expect("write shapes");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let pool = payload.type_pool.expect("type pool");

    for (key, needle) in [
        ("ts:src/shapes.ts#ExternalDerived", "ExternalBase"),
        ("ts:src/shapes.ts#CycleA", "circular"),
        ("ts:src/shapes.ts#CycleB", "circular"),
    ] {
        match pool.get(key) {
            Some(contract_core::ir::WireType::Unknown(u)) => assert!(
                u.reason.contains(needle),
                "{key} must explain the unresolved base, got {}",
                u.reason
            ),
            other => panic!(
                "{key} must not publish a partial shape from an unresolvable extends, got {other:?}"
            ),
        }
    }

    let local = match pool.get("ts:src/shapes.ts#LocalDerived") {
        Some(contract_core::ir::WireType::Object(obj)) => obj,
        other => panic!("a resolvable base must still merge, got {other:?}"),
    };
    let names: Vec<&str> = local
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["x", "y"],
        "control: local inheritance still works"
    );
}

#[test]
fn test_index_signatures_and_duplicate_declarations_are_not_flattened_away() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("shapes.ts"),
        "export interface Dynamic { [key: string]: string; }\n\
         export interface Mixed { id: string; [key: string]: unknown; }\n\
         export interface Fixed { id: string; }\n\
         export interface Dup { a: string; shared: string; }\n\
         export interface Dup { b: number; shared: number; }\n",
    )
    .expect("write shapes");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let pool = payload.type_pool.expect("type pool");

    for key in ["ts:src/shapes.ts#Dynamic", "ts:src/shapes.ts#Mixed"] {
        match pool.get(key) {
            Some(contract_core::ir::WireType::Unknown(u)) => assert!(
                u.reason.contains("index signature"),
                "{key} must explain that arbitrary keys are unmodeled, got {}",
                u.reason
            ),
            other => {
                panic!("{key} must not masquerade as an enumerable object, got {other:?}")
            }
        }
    }

    let fixed = match pool.get("ts:src/shapes.ts#Fixed") {
        Some(contract_core::ir::WireType::Object(obj)) => obj,
        other => panic!("a plain interface must stay an object, got {other:?}"),
    };
    assert_eq!(
        fixed.properties.len(),
        1,
        "control: named properties survive"
    );

    let dup = match pool.get("ts:src/shapes.ts#Dup") {
        Some(contract_core::ir::WireType::Object(obj)) => obj,
        other => panic!("duplicate interfaces must merge into one object, got {other:?}"),
    };
    let names: Vec<&str> = dup
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["a", "shared", "b"],
        "declaration merging must keep properties from every declaration"
    );
    let shared = dup
        .properties
        .iter()
        .find(|p| p.wire_name == "shared")
        .expect("shared property");
    assert!(
        matches!(
            shared.r#type,
            contract_core::ir::WireType::Primitive(ref p)
                if p.scalar == contract_core::ir::PrimitiveScalar::Number
        ),
        "the later declaration provides the merged member's type, got {:?}",
        shared.r#type
    );
}

fn fixture_line(fixture: &str, needle: &str) -> u32 {
    fixture
        .lines()
        .position(|line| line.contains(needle))
        .unwrap_or_else(|| panic!("fixture must contain {needle}")) as u32
        + 1
}

/// The script block is the only part of a `.vue` file that can hold a client call, and
/// every line number the artifact publishes must point at the original SFC, not at a
/// detached copy of the script.
#[test]
fn test_vue_script_setup_calls_are_extracted_with_sfc_line_numbers() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"<template>
  <div class="panel">{{ users.length }}</div>
</template>

<script setup lang="ts">
import axios from 'axios'

interface User {
  id: string
  name: string
}

const users = await axios.get<User[]>('/api/users')

function ping() {
  return fetch('/api/ping', { method: 'POST', body: '{}' })
}
</script>

<style scoped>
.panel { color: red; }
</style>
"#;
    fs::write(src_dir.join("UserPanel.vue"), fixture).expect("write UserPanel.vue");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/users")
        .unwrap_or_else(|| {
            panic!(
                "a call in <script setup> must produce a contract: {:?}",
                payload.client_contracts
            )
        });
    assert_eq!(get.source_file, "src/UserPanel.vue");
    assert_eq!(get.source_line, fixture_line(fixture, "axios.get<User[]>"));
    assert_eq!(get.consumers.len(), 1);
    assert_eq!(get.consumers[0].file, "src/UserPanel.vue");
    assert_eq!(
        get.consumers[0].line,
        fixture_line(fixture, "axios.get<User[]>"),
        "consumer line must point at the SFC line, not a script-relative line"
    );
    assert!(
        matches!(get.expected_response, contract_core::ir::WireType::Array(_)),
        "<User[]> must resolve against the SFC-local interface, got {:?}",
        get.expected_response
    );

    let post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/ping")
        .unwrap_or_else(|| {
            panic!(
                "fetch in <script setup> must produce a contract: {:?}",
                payload.client_contracts
            )
        });
    assert_eq!(post.source_file, "src/UserPanel.vue");
    assert_eq!(post.source_line, fixture_line(fixture, "fetch('/api/ping'"));

    assert_eq!(
        extractor.scanned_source_files, 1,
        "the SFC must count as a scanned source file"
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR"),
        "template and style regions must be masked, not handed to the TS parser: {:?}",
        completeness.blockers
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_SOURCE_NOT_PARSED"),
        ".vue files are parsed now, so the blanket not-parsed blocker must be gone: {:?}",
        completeness.blockers
    );
}

/// Options API methods and `<script setup>` coexist in real SFCs and compile into one
/// module, so calls from both blocks must be extracted, with per-line fidelity.
#[test]
fn test_vue_options_api_methods_and_script_setup_share_the_module() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"<template><div/></template>
<script>
import axios from 'axios'

export default {
  methods: {
    loadLogs() {
      return this.$http.get('/api/logs')
    },
    saveLog() {
      return axios.post('/api/logs', this.log)
    }
  }
}
</script>
<script setup>
import { onMounted } from 'vue'

onMounted(async () => {
  await fetch('/api/refresh', { method: 'PUT' })
})
</script>
"#;
    fs::write(src_dir.join("LogPanel.vue"), fixture).expect("write LogPanel.vue");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    for (method, route, needle) in [
        ("GET", "/api/logs", "this.$http.get('/api/logs')"),
        ("POST", "/api/logs", "axios.post('/api/logs'"),
        ("PUT", "/api/refresh", "fetch('/api/refresh'"),
    ] {
        let contract = payload
            .client_contracts
            .iter()
            .find(|c| c.http_method == method && c.normalized_route == route)
            .unwrap_or_else(|| {
                panic!(
                    "{method} {route} in an SFC block must produce a contract: {:?}",
                    payload
                        .client_contracts
                        .iter()
                        .map(|c| format!("{} {}", c.http_method, c.normalized_route))
                        .collect::<Vec<_>>()
                )
            });
        assert_eq!(contract.source_file, "src/LogPanel.vue");
        assert_eq!(contract.source_line, fixture_line(fixture, needle));
    }

    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR"),
        "two script blocks in one module must parse cleanly: {:?}",
        completeness.blockers
    );
}

/// Markup is not code. A template that merely displays an HTTP-looking string (including a
/// literal `<script>` sample inside `<pre>`) must never become a contract.
#[test]
fn test_vue_template_markup_is_masked_not_parsed_as_client_code() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("Docs.vue"),
        r#"<template>
  <pre>axios.get('/api/template-only')</pre>
  <pre><script>axios.get('/api/fake-script')</script></pre>
</template>
"#,
    )
    .expect("write Docs.vue");
    fs::write(
        src_dir.join("real.service.ts"),
        "export function real() { return axios.get('/api/real'); }\n",
    )
    .expect("write real.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(
        routes,
        vec!["/api/real"],
        "only script code may produce contracts: {routes:?}"
    );
    assert!(
        completeness.blockers.is_empty(),
        "a template-only SFC has no script to lose, so it is not incomplete: {:?}",
        completeness.blockers
    );
    assert_eq!(extractor.scanned_source_files, 2);
}

/// A script the extractor cannot honestly read must be named, and an unclosed block must
/// not silently swallow the calls that follow it.
#[test]
fn test_vue_unparseable_scripts_fail_closed_instead_of_vanishing() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("External.vue"),
        "<template><div/></template>\n<script src=\"./external.js\"></script>\n",
    )
    .expect("write External.vue");
    fs::write(
        src_dir.join("Coffee.vue"),
        "<template><div/></template>\n<script lang=\"coffee\">\naxios.get('/api/coffee')\n</script>\n",
    )
    .expect("write Coffee.vue");
    fs::write(
        src_dir.join("Unclosed.vue"),
        "<template><div/></template>\n<script>\nconst x = axios.get('/api/unclosed')\n",
    )
    .expect("write Unclosed.vue");
    fs::write(
        src_dir.join("Broken.vue"),
        "<template><div/></template>\n<script setup lang=\"ts\">\nconst broken = (axios.get('/api/broken')\n</script>\n",
    )
    .expect("write Broken.vue");
    fs::write(
        src_dir.join("real.service.ts"),
        "export function real() { return axios.get('/api/real'); }\n",
    )
    .expect("write real.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert!(
        !routes.contains(&"/api/coffee"),
        "a script in a language this extractor cannot parse must not be parsed as TypeScript: {routes:?}"
    );

    let has = |code: &str, file: &str| {
        completeness
            .blockers
            .iter()
            .any(|b| b.code == code && b.file.as_deref() == Some(file))
    };
    assert!(
        has("TS_SFC_EXTERNAL_SCRIPT", "src/External.vue"),
        "an external <script src> leaves the SFC without its code, which must be named: {:?}",
        completeness.blockers
    );
    assert!(
        has("TS_SFC_UNSUPPORTED_LANGUAGE", "src/Coffee.vue"),
        "an unsupported script language must be named: {:?}",
        completeness.blockers
    );
    assert!(
        has("TS_SFC_UNCLOSED_SCRIPT", "src/Unclosed.vue"),
        "an unclosed script block must be named: {:?}",
        completeness.blockers
    );
    assert!(
        has("TS_PARSE_ERROR", "src/Broken.vue"),
        "a syntax error must point at the SFC: {:?}",
        completeness.blockers
    );
    assert!(
        !completeness.complete,
        "an artifact with unreadable SFC scripts must not claim completeness"
    );
    assert_eq!(extractor.scanned_source_files, 5);
}

/// A URL the extractor cannot resolve is a known gap. Dropping the call silently lets the
/// artifact read as though the client never made it.
#[test]
fn test_vue_dynamic_endpoint_is_reported_unresolved_not_fabricated() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"<template><div/></template>
<script setup lang="ts">
import axios from 'axios'

const staticCall = await axios.get('/api/known')

function byPath(path: string) {
  return axios.get(path)
}
</script>
"#;
    fs::write(src_dir.join("Dynamic.vue"), fixture).expect("write Dynamic.vue");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload
            .client_contracts
            .iter()
            .any(|c| c.normalized_route == "/api/known"),
        "the resolvable call must still be extracted: {:?}",
        payload.client_contracts
    );
    assert!(
        completeness.blockers.iter().any(|b| {
            b.code == "TS_UNRESOLVED_CLIENT_URL" && b.file.as_deref() == Some("src/Dynamic.vue")
        }),
        "the dynamic endpoint must be reported, not dropped: {:?}",
        completeness.blockers
    );
    assert!(
        !payload
            .client_contracts
            .iter()
            .any(|c| c.http_method == "GET" && c.normalized_route == "/:param"),
        "an unresolved route must not be published as a parameterized endpoint: {:?}",
        payload.client_contracts
    );
}

/// Mixin members are injected at runtime. A component that uses one cannot claim its call
/// population is complete, and its own direct calls must still be extracted.
#[test]
fn test_vue_mixins_are_reported_instead_of_silently_missing_their_calls() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("Mixed.vue"),
        r#"<template><div/></template>
<script>
import axios from 'axios'
import crud from '@/mixins/crud'

export default {
  mixins: [crud],
  methods: {
    direct() {
      return axios.get('/api/direct')
    }
  }
}
</script>
"#,
    )
    .expect("write Mixed.vue");
    fs::write(
        src_dir.join("Plain.vue"),
        "<template><div/></template>\n\
         <script>\n\
         import axios from 'axios'\n\
         export default { methods: { load() { return axios.get('/api/plain') } } }\n\
         </script>\n",
    )
    .expect("write Plain.vue");
    // A non-component object with a `mixins` property is not a Vue mixin declaration.
    fs::write(
        src_dir.join("options.ts"),
        "export const options = { mixins: [] };\n\
         export function load() { return axios.get('/api/options'); }\n",
    )
    .expect("write options.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert!(routes.contains(&"/api/direct"), "{routes:?}");
    assert!(routes.contains(&"/api/plain"), "{routes:?}");
    assert!(routes.contains(&"/api/options"), "{routes:?}");

    let mixin_blockers: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|b| b.code == "TS_SFC_MIXINS_UNRESOLVED")
        .filter_map(|b| b.file.as_deref())
        .collect();
    assert_eq!(
        mixin_blockers,
        vec!["src/Mixed.vue"],
        "only the SFC that declares mixins is incomplete: {:?}",
        completeness.blockers
    );
}

/// A receiver named like a client does not make every method call an HTTP request; the
/// argument must at least look like a URL.
#[test]
fn test_client_named_receiver_without_a_url_argument_is_not_an_http_call() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("alerts.spec.ts"),
        "export function reads(alertService: any, service: any) {\n\
         \x20 expect(alertService.get()).toHaveLength(1);\n\
         \x20 service.delete(123);\n\
         }\n",
    )
    .expect("write alerts.spec.ts");
    fs::write(
        src_dir.join("real.service.ts"),
        "export class RealService {\n\
         \x20 constructor(private http: any) {}\n\
         \x20 load() { return this.http.get('/api/ok'); }\n\
         }\n",
    )
    .expect("write real.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(routes, vec!["/api/ok"], "only the URL-shaped call is HTTP");
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "argument-less and numeric-argument calls are not unresolved client URLs: {:?}",
        completeness.blockers
    );
}

/// Angular services routinely parenthesize the concatenated URL. The parentheses do not
/// make an otherwise static route dynamic.
#[test]
fn test_parenthesized_url_argument_resolves_like_the_unparenthesized_expression() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("thing.service.ts"),
        "export class ThingService {\n\
         \x20 private readonly entityUrl = '/api/things';\n\
         \x20 constructor(private http: any) {}\n\
         \x20 one(id: string) { return this.http.get(this.entityUrl + '/' + id); }\n\
         \x20 two(id: string) { return this.http.get((this.entityUrl + '/' + id)); }\n\
         }\n",
    )
    .expect("write thing.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/things/:param")
        .expect("both spellings must resolve to the same route");
    assert_eq!(
        contract.consumers.len(),
        2,
        "the parenthesized call site must contribute a consumer: {:?}",
        contract.consumers
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "a parenthesized static URL is not an unresolved endpoint: {:?}",
        completeness.blockers
    );
}

/// axios-style wrappers accept a config object instead of (url, body). The endpoint is
/// fully static in that form, so it must be extracted like any other call.
#[test]
fn test_config_object_call_extracts_method_url_and_generic_response() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"interface HomeDashboard {
    lowStock: number;
}

export function loadUsers() {
    return request({ url: '/api/users', method: 'get' });
}

export function saveUser(user: { name: string }) {
    return request({ url: '/api/users', method: 'post', data: user });
}

export function loadHome() {
    return request<HomeDashboard>({ url: '/api/home', method: 'get' });
}
"#;
    fs::write(src_dir.join("config-api.ts"), fixture).expect("write config-api.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected frontend payload"),
    };
    let completeness = &envelope.completeness;

    let get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/users")
        .unwrap_or_else(|| {
            panic!(
                "a config-object call with a static url must produce a contract: {:?}",
                payload.client_contracts
            )
        });
    assert_eq!(get.source_file, "src/config-api.ts");
    assert_eq!(
        get.source_line,
        fixture_line(
            fixture,
            "return request({ url: '/api/users', method: 'get' })"
        )
    );

    let post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/users")
        .expect("the method must come from the config object, not the callee name");
    assert_eq!(
        post.source_line,
        fixture_line(
            fixture,
            "return request({ url: '/api/users', method: 'post'"
        )
    );
    assert!(
        post.request_body.is_some(),
        "the config object's data property is the request body"
    );

    let home = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/home")
        .expect("a generic type argument on a config-object call must be read");
    match &home.expected_response {
        contract_core::ir::WireType::Object(obj) => assert!(
            obj.properties.iter().any(|p| p.wire_name == "lowStock"),
            "request<HomeDashboard> must resolve the interface, got {:?}",
            home.expected_response
        ),
        other => panic!("expected an object response, got {other:?}"),
    }

    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "all three endpoints are static: {:?}",
        completeness.blockers
    );
}

/// A non-JSON `responseType` means the generic describes a value the client derives after
/// reading the body (ThingsBoard parses SSE text into events), not the wire body. Treating the
/// generic as the response shape turned an abstention into a definite `ARRAY -> UNION` finding
/// once unions became resolvable, so the response must abstain.
#[test]
fn test_non_json_response_type_abstains_instead_of_using_generic_as_body() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"interface ChatEvent {
    kind: string;
}

export class ChatApi {
    constructor(private http: any) {}

    send() {
        return this.http.post<ChatEvent>('/api/chat', { text: 'hi' }, { observe: 'events', responseType: 'text' });
    }

    sendJson() {
        return this.http.post<ChatEvent>('/api/chat-json', { text: 'hi' }, { responseType: 'json' });
    }

    stream() {
        return request<ChatEvent>({ url: '/api/stream', method: 'post', data: { text: 'hi' }, responseType: 'text' });
    }
}
"#;
    fs::write(src_dir.join("chat-api.ts"), fixture).expect("write chat-api.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected frontend payload"),
    };

    let text = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/chat")
        .expect("Angular text call");
    match &text.expected_response {
        contract_core::ir::WireType::Unknown(u) => {
            assert!(
                u.reason.contains("responseType `text`") && u.reason.contains("non-JSON"),
                "the abstention must name the transport setting: {}",
                u.reason
            );
        }
        other => panic!("a text response must abstain, got {other:?}"),
    }
    assert_eq!(
        text.decoder_kind,
        contract_core::envelope::DecoderKind::Unknown
    );
    assert_eq!(text.consumer_traversal_complete, Some(false));
    assert!(
        text.unresolved_evidence
            .iter()
            .any(|e| e.contains("responseType `text`")),
        "the abstention must reach the evidence list: {:?}",
        text.unresolved_evidence
    );

    let json = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/chat-json")
        .expect("Angular json call");
    match &json.expected_response {
        contract_core::ir::WireType::Object(obj) => assert!(
            obj.properties.iter().any(|p| p.wire_name == "kind"),
            "responseType json keeps the generic as the body: {:?}",
            json.expected_response
        ),
        other => panic!("a JSON response must stay typed, got {other:?}"),
    }
    assert_eq!(
        json.decoder_kind,
        contract_core::envelope::DecoderKind::InferredType
    );

    let axios = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/api/stream")
        .expect("axios config-object call");
    assert!(
        matches!(&axios.expected_response, contract_core::ir::WireType::Unknown(u) if u.reason.contains("non-JSON")),
        "the axios config form must honour responseType too: {:?}",
        axios.expected_response
    );
}

/// A config-object URL that is computed at runtime cannot be published, but its method is
/// still known and dropping it silently would misreport the client as making fewer calls.
#[test]
fn test_config_object_dynamic_url_is_unresolved_not_fabricated() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"export function load(id: string) {
    return request({ url: buildUrl(id), method: 'get' });
}
"#;
    fs::write(src_dir.join("dynamic-config.ts"), fixture).expect("write dynamic-config.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload.client_contracts.is_empty(),
        "a dynamic URL must not become a fabricated /:param route: {:?}",
        payload.client_contracts
    );
    let blocker = completeness
        .blockers
        .iter()
        .find(|b| b.code == "TS_UNRESOLVED_CLIENT_URL")
        .unwrap_or_else(|| {
            panic!(
                "a recognized HTTP call with a dynamic URL must be reported: {:?}",
                completeness.blockers
            )
        });
    assert_eq!(blocker.file.as_deref(), Some("src/dynamic-config.ts"));
    assert!(
        blocker.message.contains("GET at line 2"),
        "the known method and line must be recorded: {}",
        blocker.message
    );

    let count = completeness
        .blockers
        .iter()
        .filter(|b| b.code == "TS_NO_CLIENT_CALL_RECOGNIZED")
        .count();
    assert_eq!(
        count, 1,
        "the artifact-level blocker must still say this file produced no contract"
    );
}

/// If the method itself is computed, neither half of the contract is static. It must be
/// reported as unresolved rather than guessed as GET.
#[test]
fn test_config_object_dynamic_method_is_unresolved_not_guessed() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("verb-config.ts"),
        "export function send(verb: string) {\n    return request({ url: '/api/thing', method: verb });\n}\n",
    )
    .expect("write verb-config.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload.client_contracts.is_empty(),
        "a computed method must not be guessed: {:?}",
        payload.client_contracts
    );
    assert!(
        completeness.blockers.iter().any(
            |b| b.code == "TS_UNRESOLVED_CLIENT_URL" && b.message.contains("UNKNOWN at line 2")
        ),
        "the unresolved evidence must name the unknown method and line: {:?}",
        completeness.blockers
    );
}

/// An object argument is not evidence of HTTP by itself. Without a method and without an
/// HTTP-capable callee, url-bearing options objects are just options objects.
#[test]
fn test_config_object_without_http_corroboration_is_not_a_contract() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("shell.ts"),
        "export function note() {\n    logger({ url: '/audit/entry' });\n}\n\nexport function go() {\n    navigate({ url: '/dashboard' });\n}\n",
    )
    .expect("write shell.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload.client_contracts.is_empty(),
        "url-only options objects must not become endpoints: {:?}",
        payload.client_contracts
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "these calls are not HTTP-shaped, so they are not unresolved HTTP: {:?}",
        completeness.blockers
    );
}

/// The client object need not be named http/axios/api. If its defining module is an HTTP
/// wrapper (it imports axios), a member call on it is an HTTP call regardless of name.
#[test]
fn test_imported_client_from_http_wrapper_module_is_recognized_by_provenance() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    let lib_dir = src_dir.join("lib");
    fs::create_dir_all(&lib_dir).expect("create lib");

    fs::write(
        lib_dir.join("transport.ts"),
        "import axios from 'axios';\n\nconst transport = axios.create({ baseURL: '/api' });\nexport const conduit = axios.create({ baseURL: '/api' });\nexport default transport;\n",
    )
    .expect("write transport.ts");

    let fixture = r#"import transport, { conduit } from './lib/transport';

export function loadOrders() {
    return transport.get('/orders');
}

export function loadSummary() {
    return transport({ url: '/orders/summary' });
}

export function saveOrder(order: { id: string }) {
    return conduit.post('/orders', order);
}
"#;
    fs::write(src_dir.join("orders.ts"), fixture).expect("write orders.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/orders")
        .unwrap_or_else(|| {
            panic!(
                "an arbitrarily named client imported from an axios wrapper must be HTTP: {:?}",
                payload.client_contracts
            )
        });
    assert_eq!(
        get.source_line,
        fixture_line(fixture, "return transport.get('/orders')")
    );

    let config_get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/orders/summary")
        .expect("a method-less config call on a proven client defaults to GET");
    assert_eq!(
        config_get.source_line,
        fixture_line(fixture, "return transport({ url: '/orders/summary' })")
    );

    let post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST" && c.normalized_route == "/orders")
        .expect("named imports of proven clients must work too");
    assert_eq!(
        post.source_line,
        fixture_line(fixture, "return conduit.post('/orders', order)")
    );

    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "all three endpoints are static: {:?}",
        completeness.blockers
    );
}

/// Provenance must not degrade into "any imported object supports .get". A module with no
/// HTTP primitive makes no HTTP client, whatever its exports are called.
#[test]
fn test_imported_receiver_from_plain_module_is_not_http() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    let lib_dir = src_dir.join("lib");
    fs::create_dir_all(&lib_dir).expect("create lib");

    fs::write(
        lib_dir.join("geometry.ts"),
        "export const grid = {\n    get(name: string) { return name; }\n};\n",
    )
    .expect("write geometry.ts");

    fs::write(
        src_dir.join("use-grid.ts"),
        "import { grid } from './lib/geometry';\n\nexport function cell(name: string) {\n    return grid.get(name);\n}\n",
    )
    .expect("write use-grid.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload.client_contracts.is_empty(),
        "grid.get is a lookup, not an HTTP GET: {:?}",
        payload.client_contracts
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "a non-HTTP receiver is not unresolved HTTP: {:?}",
        completeness.blockers
    );
}

/// Request-assertion helpers take the same `{ url, method }` shape as an axios config but
/// only inspect calls. They are not consumers, so a non-client receiver must block the
/// shape rule even when both fields are static.
#[test]
fn test_config_object_on_non_client_member_receiver_is_not_http() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("requests.ts"),
        "export function inspect() {\n    mock.expectOne({ url: '/api/owners/1', method: 'GET' });\n    mock.match({ method: 'GET' });\n}\n\nexport function load() {\n    return http.request({ url: '/api/real', method: 'get' });\n}\n",
    )
    .expect("write requests.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(
        routes,
        vec!["/api/real"],
        "only the call on an HTTP client may produce a contract: {:?}",
        payload.client_contracts
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "assertion helpers are not unresolved HTTP calls: {:?}",
        completeness.blockers
    );
}

/// JSX render functions inside a plain Vue `<script>` block are accepted by the SFC
/// compiler but rejected by the TS grammar. The script is not broken, so its calls must
/// survive and no parse blocker may be raised.
#[test]
fn test_vue_jsx_render_function_does_not_break_script_extraction() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"<template><div/></template>
<script>
import axios from 'axios'

export default {
  name: 'JsxPanel',
  methods: {
    load() {
      return axios.get('/api/jsx-panel')
    }
  },
  render(h) {
    return <div class="panel">{this.title}</div>
  }
}
</script>
"#;
    fs::write(src_dir.join("JsxPanel.vue"), fixture).expect("write JsxPanel.vue");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/jsx-panel")
        .unwrap_or_else(|| {
            panic!(
                "a JSX render function must not hide the script's calls: {:?}",
                payload.client_contracts
            )
        });
    assert_eq!(
        contract.source_line,
        fixture_line(fixture, "axios.get('/api/jsx-panel')")
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR"),
        "the TSX fallback should parse this script cleanly: {:?}",
        completeness.blockers
    );
}

/// When the whole path comes from a variable, the normalizer can only emit placeholders.
/// Such a route names no endpoint, so it must be reported as unresolved instead of being
/// published as a root-level `/:param` consumer expectation.
#[test]
fn test_url_that_is_entirely_a_variable_is_unresolved_not_a_root_param_route() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    let fixture = r#"export function getData(url: string, params: unknown) {
    return request({ url: url + '?' + qs.stringify(params), method: 'get' });
}

export function getFixed() {
    return request({ url: '/api/fixed', method: 'get' });
}
"#;
    fs::write(src_dir.join("data-api.ts"), fixture).expect("write data-api.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(
        routes,
        vec!["/api/fixed"],
        "a variable-only path must not become GET /:param: {:?}",
        payload.client_contracts
    );
    assert!(
        completeness.blockers.iter().any(|b| {
            b.code == "TS_UNRESOLVED_CLIENT_URL"
                && b.file.as_deref() == Some("src/data-api.ts")
                && b.message.contains("GET at line 2")
        }),
        "the unresolved call must stay visible with its method and line: {:?}",
        completeness.blockers
    );
}

#[test]
fn test_class_property_initializer_inference_resolves_literals_and_fails_closed_on_unknown_constructors(
) {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("models.ts"),
        r#"
export enum Status {
    ACTIVE = 'ACTIVE',
    INACTIVE = 'INACTIVE'
}

export class ConfigModel {
    retries = 3;
}

export class UserProfile {
    name = 'Ada Lovelace';
    age = 36;
    active = true;
    tags = ['admin', 'research'];
    createdAt = new Date();
    status = Status.ACTIVE;
    config = new ConfigModel();
    subscription = new UnknownSubscription();
}
"#,
    )
    .expect("write models");

    fs::write(
        src_dir.join("profile.service.ts"),
        r#"
import { UserProfile } from './models';

export class ProfileService {
    constructor(private http: any) {}
    getProfile() { return this.http.get<UserProfile>('/api/profile'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let pool = payload.type_pool.expect("type pool");
    let profile_key = pool
        .keys()
        .find(|k| k.ends_with("#UserProfile"))
        .expect("UserProfile in pool");

    let contract_core::ir::WireType::Object(profile) = &pool[profile_key] else {
        panic!("UserProfile must be Object");
    };

    let props: std::collections::HashMap<_, _> = profile
        .properties
        .iter()
        .map(|p| (p.wire_name.as_str(), &p.r#type))
        .collect();

    // 1. Literal string inferred
    assert!(
        matches!(props.get("name"), Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::String),
        "name must be string, got {:?}",
        props.get("name")
    );

    // 2. Literal number inferred
    assert!(
        matches!(props.get("age"), Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::Number),
        "age must be number, got {:?}",
        props.get("age")
    );

    // 3. Literal boolean inferred
    assert!(
        matches!(props.get("active"), Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::Boolean),
        "active must be boolean, got {:?}",
        props.get("active")
    );

    // 4. Array of literals inferred
    assert!(
        matches!(props.get("tags"), Some(contract_core::ir::WireType::Array(arr)) if matches!(&*arr.element_type, contract_core::ir::WireType::Primitive(p) if p.scalar == contract_core::ir::PrimitiveScalar::String)),
        "tags must be Array<String>, got {:?}",
        props.get("tags")
    );

    // 5. new Date() inferred to string
    assert!(
        matches!(props.get("createdAt"), Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::String),
        "createdAt must be String, got {:?}",
        props.get("createdAt")
    );

    // 6. Member expression (enum) references Status
    assert!(
        matches!(props.get("status"), Some(contract_core::ir::WireType::Ref(r)) if r.r#ref.ends_with("#Status")),
        "status must be Ref to Status, got {:?}",
        props.get("status")
    );

    // 7. new ConfigModel() references declared ConfigModel in pool
    assert!(
        matches!(props.get("config"), Some(contract_core::ir::WireType::Ref(r)) if r.r#ref.ends_with("#ConfigModel")),
        "config must be Ref to ConfigModel, got {:?}",
        props.get("config")
    );

    // 8. new UnknownSubscription() fails closed to Unknown
    assert!(
        matches!(props.get("subscription"), Some(contract_core::ir::WireType::Unknown(u)) if u.reason.contains("UnknownSubscription")),
        "subscription must fail closed to Unknown, got {:?}",
        props.get("subscription")
    );
}

#[test]
fn test_abstract_class_declaration_is_indexed_and_inherited_by_subclasses() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("base.component.ts"),
        r#"
export abstract class PageComponent {
    pageTitle = 'Default Page';
    isLoading = false;
}
"#,
    )
    .expect("write base");

    fs::write(
        src_dir.join("device.component.ts"),
        r#"
import { PageComponent } from './base.component';

export class DeviceComponent extends PageComponent {
    deviceId = 'dev-123';
}
"#,
    )
    .expect("write device");

    fs::write(
        src_dir.join("device.service.ts"),
        r#"
import { DeviceComponent } from './device.component';

export class DeviceService {
    constructor(private http: any) {}
    getDevice() { return this.http.get<DeviceComponent>('/api/device'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let pool = payload.type_pool.expect("type pool");

    // PageComponent must be indexed in pool despite being abstract class
    let page_key = pool.keys().find(|k| k.ends_with("#PageComponent"));
    assert!(
        page_key.is_some(),
        "PageComponent must be indexed in pool: {:?}",
        pool.keys()
    );

    // DeviceComponent must inherit pageTitle, isLoading, and have deviceId
    let dev_key = pool
        .keys()
        .find(|k| k.ends_with("#DeviceComponent"))
        .expect("DeviceComponent in pool");
    let contract_core::ir::WireType::Object(dev) = &pool[dev_key] else {
        panic!(
            "DeviceComponent must resolve to an Object, got {:?}",
            &pool[dev_key]
        );
    };

    let prop_names: Vec<&str> = dev
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert!(
        prop_names.contains(&"pageTitle"),
        "inherited pageTitle must be present in {:?}",
        prop_names
    );
    assert!(
        prop_names.contains(&"isLoading"),
        "inherited isLoading must be present in {:?}",
        prop_names
    );
    assert!(
        prop_names.contains(&"deviceId"),
        "own deviceId must be present in {:?}",
        prop_names
    );
}

#[test]
fn test_generic_interface_use_site_keeps_its_type_argument() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("page-data.ts"),
        r#"
export interface PageData<T> {
    data: Array<T>;
    totalPages: number;
    totalElements: number;
    hasNext: boolean;
}

export interface EventItem {
    id: string;
    eventType: string;
}
"#,
    )
    .expect("write page-data");

    fs::write(
        src_dir.join("event.service.ts"),
        r#"
import { PageData, EventItem } from './page-data';

export class EventService {
    constructor(private http: any) {}
    getEvents() { return this.http.post<PageData<EventItem>>('/api/events'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/events")
        .expect("contract for /api/events");

    assert!(
        contract.consumer_traversal_complete.unwrap_or(false),
        "Contract must be traversal complete, got evidence: {:?}",
        contract.unresolved_evidence
    );

    match &contract.expected_response {
        contract_core::ir::WireType::Object(object) => {
            let data = object
                .properties
                .iter()
                .find(|p| p.wire_name == "data")
                .expect("PageData declares data");
            match &data.r#type {
                contract_core::ir::WireType::Array(array) => match array.element_type.as_ref() {
                    contract_core::ir::WireType::Ref(element) => assert!(
                        element.r#ref.ends_with("#EventItem"),
                        "`T` must become the type the use site named, got {}",
                        element.r#ref
                    ),
                    other => panic!("data element resolved to {:?}", other),
                },
                other => panic!("data must stay an ARRAY, got {:?}", other),
            }
        }
        other => panic!(
            "A use site that names its argument must not lose it, got {:?}",
            other
        ),
    }
}

#[test]
fn test_ref_to_unknown_pool_node_is_not_traversal_complete() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("resource.models.ts"),
        r#"
export interface TbResourceInfo<D> extends Omit<MissingBase, 'title'> {
    descriptor: D;
}
"#,
    )
    .expect("write models");

    fs::write(
        src_dir.join("image.service.ts"),
        r#"
import { TbResourceInfo } from './resource.models';

export class ImageService {
    constructor(private http: any) {}
    getImage() { return this.http.get<TbResourceInfo<string>>('/api/image'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/image")
        .expect("contract for /api/image");

    assert_eq!(
        contract.consumer_traversal_complete,
        Some(false),
        "a response that resolves to an unshaped declaration must not read as complete: {:?}",
        contract.expected_response
    );
    assert!(
        contract
            .unresolved_evidence
            .iter()
            .any(|e| e.contains("unshaped")),
        "expected an explicit abstention reason, got {:?}",
        contract.unresolved_evidence
    );
}

#[test]
fn test_heritage_expressions_apply_mapped_and_generic_bases() {
    // `extends Omit<Base, 'field'>` and `extends Base<Arg>` name shapes the bare base
    // name cannot. Dropping the arguments either keeps an omitted property or leaves a
    // substituted field unresolved, so both must be evaluated at the declaration.
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("models.ts"),
        r#"
export type AgentId = string;

export interface BaseData<T> {
    id: T;
    version: number;
}

export interface Agent extends BaseData<AgentId> {
    name: string;
}

export interface AgentInfo extends Omit<BaseData<string>, 'version'> {
    extra: boolean;
}
"#,
    )
    .expect("write models");

    fs::write(
        src_dir.join("agent.service.ts"),
        r#"
import { Agent, AgentInfo } from './models';

export class AgentService {
    constructor(private http: any) {}
    getAgent(): Agent { return this.http.get<Agent>('/api/agent'); }
    getAgentInfo(): AgentInfo { return this.http.get<AgentInfo>('/api/agent-info'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected a frontend payload"),
    };
    let response = |route: &str| -> contract_core::ir::WireType {
        payload
            .client_contracts
            .iter()
            .find(|c| c.normalized_route == route)
            .unwrap_or_else(|| panic!("{route} contract"))
            .expected_response
            .clone()
    };

    let agent = response("/api/agent");
    let id = object_property(&agent, "id");
    assert!(
        matches!(
            unpeeled(&id.r#type),
            contract_core::ir::WireType::Primitive(p)
                if p.scalar == contract_core::ir::PrimitiveScalar::String
        ),
        "`BaseData<AgentId>` must substitute the argument into the base property, got {:?}",
        id.r#type
    );
    object_property(&agent, "version");
    object_property(&agent, "name");

    let info = response("/api/agent-info");
    let info_id = object_property(&info, "id");
    assert!(
        matches!(
            unpeeled(&info_id.r#type),
            contract_core::ir::WireType::Primitive(p)
                if p.scalar == contract_core::ir::PrimitiveScalar::String
        ),
        "`Omit<BaseData<string>, 'version'>` must keep the substituted id, got {:?}",
        info_id.r#type
    );
    assert!(
        matches!(
            &info,
            contract_core::ir::WireType::Object(object)
                if !object.properties.iter().any(|p| p.wire_name == "version")
        ),
        "`Omit` must remove the omitted property, got {info:?}"
    );
    object_property(&info, "extra");
}

#[test]
fn test_typed_request_body_identifier_resolves_instead_of_abstaining() {
    // A request body passed as an identifier is only as shaped as the parameter it
    // names. The annotation is the compiler's fact about what is sent; leaving it as
    // `Request body expression: body` would make every typed client look unshaped.
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("models.ts"),
        r#"
export interface Order {
    id: string;
}

export interface CreateOrderRequest {
    customerId: string;
    items: string[];
}

export type PatchPayload = Partial<CreateOrderRequest>;
"#,
    )
    .expect("write models");

    fs::write(
        src_dir.join("order.service.ts"),
        r#"
import { Order, CreateOrderRequest, PatchPayload } from './models';

export class OrderService {
    constructor(private http: any) {}
    create(body: CreateOrderRequest): Observable<Order> {
        return this.http.post<Order>('/api/orders', body);
    }
    patch(id: string, payload: PatchPayload): Observable<Order> {
        return this.http.put<Order>(`/api/orders/${id}`, payload);
    }
    createInline(body: { sku: string; quantity: number }): Observable<Order> {
        return this.http.post<Order>('/api/orders/inline', body);
    }
    createLiteral(): Observable<Order> {
        return this.http.post<Order>('/api/orders/literal', { sku: 'x' });
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let mut envelope = extractor
        .build_envelope("ui", "backend", "HEAD")
        .expect("build envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    let payload = match envelope.payload {
        contract_core::envelope::ArtifactPayload::Frontend(p) => p,
        _ => panic!("expected frontend payload"),
    };
    let body = |method: &str, route: &str| -> contract_core::ir::WireType {
        payload
            .client_contracts
            .iter()
            .find(|c| c.http_method == method && c.normalized_route == route)
            .unwrap_or_else(|| panic!("{method} {route} contract"))
            .request_body
            .clone()
            .unwrap_or_else(|| panic!("{method} {route} must carry a request body"))
    };

    let create = body("POST", "/api/orders");
    object_property(&create, "customerId");
    match object_property(&create, "items").r#type.clone() {
        contract_core::ir::WireType::Array(array) => assert!(
            matches!(
                *array.element_type,
                contract_core::ir::WireType::Primitive(ref p)
                    if p.scalar == contract_core::ir::PrimitiveScalar::String
            ),
            "`items: string[]` must stay an array of strings, got {:?}",
            array.element_type
        ),
        other => panic!("items must be an ARRAY, got {other:?}"),
    }

    let patch = body("PUT", "/api/orders/:param");
    let patched = object_property(&patch, "customerId");
    assert!(
        patched.optional,
        "`Partial<CreateOrderRequest>` must mark the body fields optional"
    );

    let inline = body("POST", "/api/orders/inline");
    object_property(&inline, "sku");
    object_property(&inline, "quantity");

    match body("POST", "/api/orders/literal") {
        contract_core::ir::WireType::Unknown(unknown) => assert!(
            unknown.reason.contains("Request body expression"),
            "an object literal has no single declaration to bind, got {}",
            unknown.reason
        ),
        other => panic!("an unannotated literal body must abstain, got {other:?}"),
    }
}

#[test]
fn test_propertyless_object_root_is_not_traversal_complete() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("marker.models.ts"),
        r#"
export interface Marker {}
"#,
    )
    .expect("write marker");

    fs::write(
        src_dir.join("mark.service.ts"),
        r#"
import { Marker } from './marker.models';

export class MarkService {
    constructor(private http: any) {}
    mark() { return this.http.post<Marker>('/api/mark'); }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/mark")
        .expect("contract for /api/mark");

    assert_eq!(
        contract.consumer_traversal_complete,
        Some(false),
        "an object with no properties matches every payload, so it cannot be a complete shape: {:?}",
        contract.expected_response
    );
}

#[test]
fn test_unconditional_reassignment_resolves_value_at_each_call_site() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
export class UserService {
    constructor(private http: any) {}

    fetchUsers() {
        let endpoint = '/api/v1/users';
        const first = this.http.get(endpoint);
        endpoint = '/api/v2/users';
        return this.http.get(endpoint);
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert!(
        routes.contains(&"/api/v1/users"),
        "the call before the reassignment must keep the initializer: {routes:?}"
    );
    assert!(
        routes.contains(&"/api/v2/users"),
        "the call after the reassignment must use the new value: {routes:?}"
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "unconditional constant reassignment must not abstain: {:?}",
        completeness.blockers
    );
}

#[test]
fn test_conditional_reassignment_fails_closed_to_blocker() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
export class UserService {
    constructor(private http: any) {}

    fetchUsers(useV2: boolean) {
        let endpoint = '/api/v1/users';
        if (useV2) {
            endpoint = '/api/v2/users';
        }
        return this.http.get(endpoint);
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        !completeness.complete,
        "A branch-dependent URL must fail closed"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "Expected TS_UNRESOLVED_CLIENT_URL blocker, got: {:?}",
        completeness.blockers
    );
    assert_eq!(
        payload.client_contracts.len(),
        0,
        "No contract may be invented from a branch-dependent URL"
    );
}

#[test]
fn test_augmented_and_non_literal_reassignments_fail_closed() {
    for reassignment in [
        "endpoint += '/active';",
        "endpoint = buildEndpoint();",
        "if (active) { endpoint += '/active'; }",
    ] {
        let dir = tempdir().expect("tempdir");
        let repo_root = dir.path().to_path_buf();
        let src_dir = repo_root.join("src");
        fs::create_dir_all(&src_dir).expect("create src");

        fs::write(
            src_dir.join("user.service.ts"),
            format!(
                r#"
export class UserService {{
    constructor(private http: any) {{}}

    fetchUsers() {{
        let endpoint = '/api/v1/users';
        {reassignment}
        return this.http.get(endpoint);
    }}
}}
"#
            ),
        )
        .expect("write service");

        let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
        let (payload, completeness) = extractor.extract_payload("ui", "backend");

        assert!(
            completeness
                .blockers
                .iter()
                .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
            "`{reassignment}` must fail closed, got: {:?}",
            completeness.blockers
        );
        assert_eq!(
            payload.client_contracts.len(),
            0,
            "`{reassignment}` must not invent a contract"
        );
    }
}

#[test]
fn test_query_only_appends_keep_the_route_path_resolvable() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
export class UserService {
    constructor(private http: any) {}

    conditionalQuery() {
        let endpoint = '/api/v1/users';
        if (this.includeArchived) {
            endpoint += '?archived=true';
        }
        return this.http.get(endpoint);
    }

    conditionalQueryTemplate() {
        let endpoint = '/api/v1/items?page=1';
        if (this.includeCustomers) {
            endpoint += `&includeCustomers=${this.includeCustomers}`;
        }
        return this.http.get(endpoint);
    }

    unconditionalQuery() {
        let endpoint = '/api/v1/orders';
        endpoint += '?sort=asc';
        return this.http.get(endpoint);
    }

    queryThenPathAppend() {
        let endpoint = '/api/v1/reports';
        if (this.detail) {
            endpoint += '/detail';
        }
        return this.http.get(endpoint);
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    let mut routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    routes.sort_unstable();
    assert_eq!(
        routes,
        vec!["/api/v1/items", "/api/v1/orders", "/api/v1/users"],
        "query-only appends must not erase the path, while a path append still fails closed"
    );
    assert_eq!(
        completeness
            .blockers
            .iter()
            .filter(|b| b.code == "TS_UNRESOLVED_CLIENT_URL")
            .count(),
        1,
        "only the path append is unresolved, got: {:?}",
        completeness.blockers
    );
}

#[test]
fn test_property_assignment_is_not_a_rebinding_of_the_url_constant() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
export class UserService {
    constructor(private http: any) {}

    fetchUsers() {
        let endpoint: any = '/api/v1/users';
        endpoint.length = 0;
        return this.http.get(endpoint);
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        payload
            .client_contracts
            .iter()
            .any(|c| c.normalized_route == "/api/v1/users"),
        "a property write must not invalidate the binding: {:?}",
        completeness.blockers
    );
}

#[test]
fn test_module_level_let_is_not_folded_to_its_initializer() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.service.ts"),
        r#"
let moduleEndpoint = '/api/v1/users';

export class UserService {
    constructor(private http: any) {}

    fetchUsers() {
        return this.http.get(moduleEndpoint);
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "a mutable module binding must fail closed, got: {:?}",
        completeness.blockers
    );
    assert_eq!(payload.client_contracts.len(), 0);
}

#[test]
fn test_tests_stories_and_e2e_sources_are_not_client_contracts() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(src_dir.join("app")).expect("create app");
    fs::create_dir_all(src_dir.join("e2e")).expect("create e2e");
    fs::create_dir_all(src_dir.join("test")).expect("create test");

    let service = |route: &str| {
        format!(
            r#"
export class GeneratedService {{
    constructor(private http: any) {{}}
    fetch() {{ return this.http.get('{route}'); }}
}}
"#
        )
    };

    fs::write(src_dir.join("app/real.service.ts"), service("/api/app")).expect("real");
    fs::write(
        src_dir.join("app/real.service.spec.ts"),
        service("/api/spec"),
    )
    .expect("spec");
    fs::write(src_dir.join("app/real.stories.ts"), service("/api/story")).expect("stories");
    fs::write(src_dir.join("e2e/login.ts"), service("/api/e2e")).expect("e2e");
    fs::write(src_dir.join("test/helper.ts"), service("/api/helper")).expect("helper");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _completeness) = extractor.extract_payload("ui", "backend");
    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();

    assert!(
        routes.contains(&"/api/app"),
        "application source must still be scanned: {routes:?}"
    );
    for excluded in ["/api/spec", "/api/story", "/api/e2e", "/api/helper"] {
        assert!(
            !routes.contains(&excluded),
            "{excluded} came from a test or story source and must not become a contract: {routes:?}"
        );
    }
}

#[test]
fn test_vendored_and_nested_repository_sources_are_not_client_contracts() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(src_dir.join("app")).expect("create app");
    fs::create_dir_all(src_dir.join("vendor/lib")).expect("create vendor");
    fs::create_dir_all(src_dir.join("nested/.git")).expect("create nested git marker");
    fs::create_dir_all(src_dir.join("nested/legacy/src")).expect("create nested source");

    let service = |route: &str| {
        format!(
            r#"
export class GeneratedService {{
    constructor(private http: any) {{}}
    fetch() {{ return this.http.get('{route}'); }}
}}
"#
        )
    };

    fs::write(src_dir.join("app/real.service.ts"), service("/api/app")).expect("real");
    fs::write(src_dir.join("vendor/lib/client.ts"), service("/api/vendor")).expect("vendor");
    fs::write(
        src_dir.join("nested/legacy/src/client.ts"),
        service("/api/nested"),
    )
    .expect("nested");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _completeness) = extractor.extract_payload("ui", "backend");
    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();

    assert!(
        routes.contains(&"/api/app"),
        "application source must still be scanned: {routes:?}"
    );
    assert!(
        !routes.contains(&"/api/vendor"),
        "vendored sources must not become contracts: {routes:?}"
    );
    assert!(
        !routes.contains(&"/api/nested"),
        "a nested checkout must not become this repository's consumer: {routes:?}"
    );
}

#[test]
fn test_single_hop_and_multi_hop_barrel_re_exports() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    // 1. Definition site
    fs::write(
        src_dir.join("profile.model.ts"),
        r#"
export interface UserProfile {
    id: string;
    displayName: string;
}
"#,
    )
    .expect("write profile.model.ts");

    // 2. Single-hop barrel
    fs::write(
        src_dir.join("models.ts"),
        r#"
export { UserProfile } from './profile.model';
"#,
    )
    .expect("write models.ts");

    // 3. Multi-hop barrel with aliasing
    fs::write(
        src_dir.join("index.ts"),
        r#"
export { UserProfile as PublicProfile } from './models';
"#,
    )
    .expect("write index.ts");

    // 4. Consumer service importing from public index
    fs::write(
        src_dir.join("profile.service.ts"),
        r#"
import { PublicProfile } from './index';

export class ProfileService {
    constructor(private http: any) {}

    getProfile() {
        return this.http.get<PublicProfile>('/api/profile');
    }
}
"#,
    )
    .expect("write profile.service.ts");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        completeness.complete,
        "Barrel resolution should be complete: {:?}",
        completeness.blockers
    );

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/profile")
        .expect("contract for /api/profile");

    // Expected response should have resolved UserProfile properties (id, displayName)
    if let contract_core::ir::WireType::Ref(r) = &contract.expected_response {
        assert_eq!(
            r.r#ref, "ts:src/profile.model.ts#UserProfile",
            "Must resolve to actual declaration file and symbol"
        );
    } else {
        panic!(
            "Expected WireType::Ref, got {:?}",
            contract.expected_response
        );
    }
}

#[test]
fn test_circular_barrel_re_export_terminates_safely() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    // Circular barrel files: a <-> b
    fs::write(
        src_dir.join("barrelA.ts"),
        r#"
export { CircularType } from './barrelB';
"#,
    )
    .expect("write barrelA");

    fs::write(
        src_dir.join("barrelB.ts"),
        r#"
export { CircularType } from './barrelA';
"#,
    )
    .expect("write barrelB");

    fs::write(
        src_dir.join("circular.service.ts"),
        r#"
import { CircularType } from './barrelA';

export class CircularService {
    constructor(private http: any) {}
    getData() {
        return this.http.get<CircularType>('/api/circular');
    }
}
"#,
    )
    .expect("write service");

    // Must not hang or stack overflow
    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/circular")
        .expect("contract for /api/circular");

    // Resolves to Unknown or unresolvable ref, but finishes cleanly
    assert!(
        matches!(
            contract.expected_response,
            contract_core::ir::WireType::Unknown(_)
        ) || matches!(
            contract.expected_response,
            contract_core::ir::WireType::Ref(_)
        )
    );
}

#[test]
fn test_duplicate_types_across_repo_resolve_by_barrel_import() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    let module_a = src_dir.join("moduleA");
    let module_b = src_dir.join("moduleB");
    fs::create_dir_all(&module_a).expect("create moduleA");
    fs::create_dir_all(&module_b).expect("create moduleB");

    // Both modules declare an Account interface
    fs::write(
        module_a.join("account.ts"),
        r#"
export interface Account {
    accountId: string;
}
"#,
    )
    .expect("write moduleA/account");

    fs::write(
        module_a.join("index.ts"),
        r#"
export { Account } from './account';
"#,
    )
    .expect("write moduleA/index");

    fs::write(
        module_b.join("account.ts"),
        r#"
export interface Account {
    bankCode: string;
}
"#,
    )
    .expect("write moduleB/account");

    // Service specifically imports from moduleA's barrel
    fs::write(
        src_dir.join("account.service.ts"),
        r#"
import { Account } from './moduleA/index';

export class AccountService {
    constructor(private http: any) {}
    getAccount() {
        return this.http.get<Account>('/api/account');
    }
}
"#,
    )
    .expect("write service");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        completeness.complete,
        "Must resolve unambiguously without blocker: {:?}",
        completeness.blockers
    );

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/account")
        .expect("contract for /api/account");

    if let contract_core::ir::WireType::Ref(r) = &contract.expected_response {
        assert_eq!(
            r.r#ref, "ts:src/moduleA/account.ts#Account",
            "Must resolve specifically to moduleA's Account, not ambiguous #Account"
        );
    } else {
        panic!(
            "Expected WireType::Ref, got {:?}",
            contract.expected_response
        );
    }
}

#[test]
fn test_react_tsx_component_extraction() {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");

    fs::write(
        src_dir.join("user.types.ts"),
        r#"
export interface UserItem {
    id: string;
    email: string;
}
"#,
    )
    .expect("write user.types.ts");

    // React functional component with TSX markup, hooks, and axios call
    fs::write(
        src_dir.join("UserList.tsx"),
        r#"
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { UserItem } from './user.types';

export const UserList: React.FC = () => {
    const [users, setUsers] = useState<UserItem[]>([]);

    useEffect(() => {
        axios.get<UserItem[]>('/api/v1/users').then(res => {
            setUsers(res.data);
        });
    }, []);

    const deleteUser = (userId: string) => {
        axios.delete<UserItem>(`/api/v1/users/${userId}`);
    };


    return (
        <div className="user-container">
            <h1>Active Users</h1>
            <ul>
                {users.map(u => (
                    <li key={u.id}>
                        <span>{u.email}</span>
                        <button onClick={() => deleteUser(u.id)}>Delete</button>
                    </li>
                ))}
            </ul>
        </div>
    );
};
"#,
    )
    .expect("write UserList.tsx");

    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, completeness) = extractor.extract_payload("ui", "backend");

    assert!(
        completeness.complete,
        "React TSX extraction should be complete: {:?}",
        completeness.blockers
    );
    assert_eq!(
        payload.client_contracts.len(),
        2,
        "Must extract both GET /api/v1/users and DELETE /api/v1/users/:param"
    );

    let get_call = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/v1/users")
        .expect("Must find GET /api/v1/users");
    assert_eq!(get_call.source_file, "src/UserList.tsx");

    let delete_call = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "DELETE" && c.normalized_route == "/api/v1/users/:param")
        .expect("Must find DELETE /api/v1/users/:param");
    assert_eq!(delete_call.source_file, "src/UserList.tsx");
}

fn extract_sources(
    files: &[(&str, &str)],
) -> (
    contract_core::envelope::FrontendContractPayload,
    contract_core::envelope::ArtifactCompleteness,
) {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");
    for (name, content) in files {
        fs::write(src_dir.join(name), content).expect("write fixture");
    }
    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    extractor.extract_payload("ui", "backend")
}

/// Create React App and plain Babel setups ship components with a `.js` extension. The
/// TypeScript grammar reads the markup as a generic call and fails the file, which used to
/// erase every call in it.
#[test]
fn a_js_file_containing_jsx_keeps_its_calls() {
    let (payload, completeness) = extract_sources(&[(
        "Orders.js",
        r#"
import { useEffect, useState } from "react";

export function Orders() {
    const [orders, setOrders] = useState([]);
    useEffect(() => {
        fetch("/api/orders")
            .then(r => r.json())
            .then(d => setOrders(d));
    }, []);
    return <ul>{orders.map(o => <li key={o.id}>{o.total}</li>)}</ul>;
}
"#,
    )]);

    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR"),
        "JSX in a .js file must not be reported as a broken source: {:?}",
        completeness.blockers
    );
    let get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/orders")
        .expect("the call inside the component must survive parsing");
    assert_eq!(get.source_file, "src/Orders.js");
}

/// A client passed through a plugin wrapper is still that client. Recognising only the
/// import binding left `superagent.get(...)` an ordinary method call, so the module produced
/// no contract at all and the artifact read as a client that makes no requests.
#[test]
fn a_client_bound_through_a_wrapper_call_is_still_a_client() {
    let (payload, completeness) = extract_sources(&[(
        "agent.js",
        r#"
import _superagent from "superagent";
import promisePlugin from "superagent-promise";

const superagent = promisePlugin(_superagent, global.Promise);

export const Tags = {
    getAll: () => superagent.get("/api/tags")
};
"#,
    )]);

    let get = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET" && c.normalized_route == "/api/tags")
        .unwrap_or_else(|| {
            panic!(
                "alias was not resolved; blockers {:?}",
                completeness.blockers
            )
        });
    assert_eq!(get.source_file, "src/agent.js");
}

/// superagent spells DELETE `del`. Dropping the last two letters of the verb is the
/// library's own naming, not a repo convention.
#[test]
fn the_del_verb_is_a_delete() {
    let (payload, _) = extract_sources(&[(
        "agent.js",
        r#"
import superagent from "superagent";

export const removeTag = tag => superagent.del(`/api/tags/${tag}`);
"#,
    )]);

    assert!(
        payload
            .client_contracts
            .iter()
            .any(|c| c.http_method == "DELETE" && c.normalized_route == "/api/tags/:param"),
        "del() must become DELETE, got {:?}",
        payload
            .client_contracts
            .iter()
            .map(|c| (&c.http_method, &c.normalized_route))
            .collect::<Vec<_>>()
    );
}

/// `` `${API_ROOT}${url}` `` with no separator between them produces `/api:param` — a segment
/// whose text is partly unknown. No producer mapping has such a segment, so publishing it
/// would invent an endpoint the client never named; the call has to be reported unresolved.
/// A call site that hands the wrapper a real path is a different case, covered by
/// `a_same_module_request_wrapper_publishes_each_call_site_route`.
#[test]
fn a_value_glued_into_a_literal_segment_is_not_published_as_a_route() {
    let (payload, completeness) = extract_sources(&[(
        "agent.js",
        r#"
import superagent from "superagent";

const API_ROOT = "https://example.com/api";

export const requests = {
    get: url => superagent.get(`${API_ROOT}${url}`).then(res => res.body)
};
"#,
    )]);

    assert!(
        payload.client_contracts.is_empty(),
        "a partly-known segment is not a route, got {:?}",
        payload
            .client_contracts
            .iter()
            .map(|c| &c.normalized_route)
            .collect::<Vec<_>>()
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"
                && b.file.as_deref() == Some("src/agent.js")),
        "the call must still be reported as unresolved: {:?}",
        completeness.blockers
    );
    assert!(
        !completeness.complete,
        "an unresolved client URL keeps the artifact incomplete"
    );
}

/// The locatability gate is applied to the normalized route, and normalization keeps an
/// absolute URL intact when the client supplied one. A glued segment behind a real origin is
/// the same fabrication as a relative one.
#[test]
fn an_absolute_url_with_a_glued_segment_is_not_published_as_a_route() {
    let (payload, completeness) = extract_sources(&[(
        "loader.ts",
        r#"
import { HttpClient } from "@angular/common/http";

export class LocaleLoader {
    constructor(private http: HttpClient) {}

    load(lang: string) {
        return this.http.get(`https://cdn.example.com/assets/locale.constant-${lang}.json`);
    }
}
"#,
    )]);

    assert!(
        payload.client_contracts.is_empty(),
        "origin is known, the last segment is not: got {:?}",
        payload
            .client_contracts
            .iter()
            .map(|c| &c.normalized_route)
            .collect::<Vec<_>>()
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"
                && b.file.as_deref() == Some("src/loader.ts")),
        "the call must still be reported as unresolved: {:?}",
        completeness.blockers
    );
}

/// A whole segment standing for a path variable is locatable on both sides of the pair, so
/// gating it would throw away real contracts. This is the over-gate guard.
#[test]
fn a_whole_unknown_segment_is_still_published_as_a_route() {
    let (payload, _) = extract_sources(&[(
        "items.ts",
        r#"
import { HttpClient } from "@angular/common/http";

export class ItemService {
    constructor(private http: HttpClient) {}

    one(id: string) {
        return this.http.get(`/api/items/${id}`);
    }
}
"#,
    )]);

    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(routes, vec!["/api/items/:param"], "got {routes:?}");
}

/// The TS→TSX retry reaches a `.ts` file for the first time with this change, so the two ways
/// it could be wrong are pinned here: a clean file must not switch grammars (an old-style `<T>`
/// cast is JSX element syntax under TSX), and a file that stays broken must keep its blocker
/// rather than trade a parse error for silently mis-parsed facts.
#[test]
fn the_tsx_retry_only_rescues_files_that_genuinely_contain_markup() {
    // JSX markup makes the file invalid TypeScript; the retry is what reads it.
    let (payload, completeness) = extract_sources(&[(
        "widget.ts",
        r#"
import { HttpClient } from "@angular/common/http";

export function render(http: HttpClient, id: string) {
    const node = <div className="card">{"hello"}</div>;
    return http.get(`/api/widgets/${id}`);
}
"#,
    )]);
    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(routes, vec!["/api/widgets/:param"], "got {routes:?}");
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR"),
        "markup in a .ts file is a grammar choice, not a lost file: {:?}",
        completeness.blockers
    );

    // Old-style casts are valid TypeScript, so the file is parsed once, under the TypeScript
    // grammar, and the cast keeps its meaning.
    let (payload, completeness) = extract_sources(&[(
        "clean.ts",
        r#"
import { HttpClient } from "@angular/common/http";

export function pick<T>(http: HttpClient, raw: unknown) {
    const value = <T>raw;
    return http.get(`/api/clean/${value}`);
}
"#,
    )]);
    let routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    assert_eq!(routes, vec!["/api/clean/:param"], "got {routes:?}");
    assert!(
        completeness.blockers.is_empty(),
        "got {:?}",
        completeness.blockers
    );

    // The same casts plus a real syntax error: TSX cannot read the cast either, so the file
    // must stay fail-closed instead of being published from a mis-parsed tree.
    let (_, completeness) = extract_sources(&[(
        "casts.ts",
        r#"
import { HttpClient } from "@angular/common/http";

export function pick<T>(http: HttpClient, raw: unknown) {
    const value = <T>raw;
    return http.get(`/api/picked/${value}`);
}

export function broken( {
"#,
    )]);
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_PARSE_ERROR" && b.file.as_deref() == Some("src/casts.ts")),
        "a file neither grammar reads keeps its blocker: {:?}",
        completeness.blockers
    );
}

fn fanout_routes(payload: &contract_core::envelope::FrontendContractPayload) -> Vec<String> {
    let mut routes: Vec<String> = payload
        .client_contracts
        .iter()
        .map(|c| format!("{} {}", c.http_method, c.normalized_route))
        .collect();
    routes.sort();
    routes
}

/// A mid-size plain-JS app puts its client behind one module function and writes every route
/// at the call sites. The wrapper cannot name an endpoint on its own, so reading only the
/// anchor reported four unresolved calls and no routes at all.
#[test]
fn a_same_module_request_wrapper_publishes_each_call_site_route() {
    let fixture = r#"
import superagentPromise from "superagent-promise";
import _superagent from "superagent";

const superagent = superagentPromise(_superagent, global.Promise);
const API_ROOT = "https://conduit.test/api";
const responseBody = res => res.body;

const requests = {
  del: url => superagent.del(`${API_ROOT}${url}`).then(responseBody),
  get: url => superagent.get(`${API_ROOT}${url}`).then(responseBody),
  put: (url, body) => superagent.put(`${API_ROOT}${url}`, body).then(responseBody),
  post: (url, body) => superagent.post(`${API_ROOT}${url}`, body).then(responseBody)
};

const Auth = {
  current: () => requests.get("/user"),
  login: (email, password) => requests.post("/users/login", { user: { email, password } }),
  save: user => requests.put("/user", { user })
};

const Articles = {
  all: page => requests.get(`/articles?limit=${page}`),
  get: slug => requests.get(`/articles/${slug}`),
  remove: slug => requests.del(`/articles/${slug}`)
};
"#;
    let (payload, completeness) = extract_sources(&[("agent.js", fixture)]);
    assert_eq!(
        fanout_routes(&payload),
        vec![
            "DELETE /api/articles/:param",
            "GET /api/articles",
            "GET /api/articles/:param",
            "GET /api/user",
            "POST /api/users/login",
            "PUT /api/user"
        ]
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "every site named a route, so the wrapper hides nothing: {:?}",
        completeness.blockers
    );

    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "DELETE" && c.normalized_route == "/api/articles/:param")
        .expect("DELETE /api/articles/:param");
    assert_eq!(
        contract.source_line,
        fixture_line(fixture, "requests.del(`/articles/${slug}`)"),
        "the route was chosen at the call site, so that is where it is reported"
    );
    assert_eq!(contract.source_file, "src/agent.js");
}

/// A call site that hands the wrapper something this pass cannot read must not invent a route,
/// and the wrapper must stay on the record as hiding one.
#[test]
fn a_wrapper_call_with_an_unreadable_argument_keeps_the_blocker() {
    let (payload, completeness) = extract_sources(&[(
        "agent.js",
        r#"
import superagent from "superagent";
const API_ROOT = "https://conduit.test/api";
const requests = { get: url => superagent.get(`${API_ROOT}${url}`).then(r => r.body) };
export const load = what => requests.get(what);
"#,
    )]);
    assert_eq!(
        fanout_routes(&payload),
        Vec::<String>::new(),
        "an argument that is only a parameter cannot become a route"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"
                && b.file.as_deref() == Some("src/agent.js")),
        "the wrapper still hides a route: {:?}",
        completeness.blockers
    );
}

/// v1 follows one hop inside the module that declares the wrapper. An imported wrapper has no
/// anchor here, so nothing is substituted: the site keeps whatever its own argument says and
/// the declaring file stays on the record as hiding an endpoint.
#[test]
fn a_wrapper_in_another_module_is_not_fanned_out() {
    let (payload, completeness) = extract_sources(&[
        (
            "http.js",
            r#"
import superagent from "superagent";
const API_ROOT = "https://conduit.test/api";
const requests = { get: url => superagent.get(`${API_ROOT}${url}`) };
export default requests;
"#,
        ),
        (
            "api.js",
            r#"
import requests from "./http";
export const load = () => requests.get("/user");
"#,
        ),
    ]);
    assert_eq!(
        fanout_routes(&payload),
        vec!["GET /user".to_string()],
        "the wrapper's base prefix does not cross the module boundary"
    );
    let blocked: Vec<String> = completeness
        .blockers
        .iter()
        .filter(|b| b.code == "TS_UNRESOLVED_CLIENT_URL")
        .map(|b| b.file.clone().unwrap_or_default())
        .collect();
    assert_eq!(blocked, vec!["src/http.js".to_string()]);
}

/// A wrapper that already names its endpoint publishes that endpoint once. Binding a call-site
/// argument to it as well would report the same client call under two routes.
#[test]
fn a_wrapper_that_names_its_own_endpoint_publishes_it_once() {
    let (payload, _completeness) = extract_sources(&[(
        "fixed.js",
        r#"
import axios from "axios";
const load = url => axios.get("/api/fixed");
export const call = () => load("/api/other");
"#,
    )]);
    assert_eq!(fanout_routes(&payload), vec!["GET /api/fixed".to_string()]);
}

/// A function that makes two client calls has no single endpoint to substitute into; guessing
/// which call an argument belongs to would attach a route to the wrong request.
#[test]
fn a_wrapper_with_two_client_calls_is_not_fanned_out() {
    let (payload, completeness) = extract_sources(&[(
        "dual.js",
        r#"
import superagent from "superagent";
const API_ROOT = "https://conduit.test/api";
const dual = url => {
  superagent.get(`${API_ROOT}${url}`);
  superagent.post(`${API_ROOT}${url}`);
};
export const call = () => dual("/user");
"#,
    )]);
    assert_eq!(fanout_routes(&payload), Vec::<String>::new());
    let message = completeness
        .blockers
        .iter()
        .find(|b| b.code == "TS_UNRESOLVED_CLIENT_URL")
        .map(|b| b.message.clone())
        .expect("both client calls stay on the record");
    assert!(
        message.starts_with("2 HTTP client call(s)"),
        "one blocker must count both calls: {message}"
    );
}

#[test]
fn test_unresolved_prefix_with_query_only_does_not_collapse_to_root() {
    let (payload, completeness) = extract_sources(&[(
        "image.service.ts",
        r#"
export class ImageService {
    constructor(private http: any) {}
    getImages(pageLink: any) {
        return this.http.get(`${IMAGES_URL_PREFIX}${pageLink.toQuery()}&imageSubType=foo`);
    }
}
"#,
    )]);

    // The call must NOT be published as a GET / contract
    assert!(
        !payload
            .client_contracts
            .iter()
            .any(|c| c.normalized_route == "/"),
        "unresolved prefix with query parameters must not collapse to root '/': {:?}",
        payload.client_contracts
    );

    // It must be recorded as an unresolved HTTP call blocker
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "TS_UNRESOLVED_CLIENT_URL"),
        "must be recorded as TS_UNRESOLVED_CLIENT_URL blocker: {:?}",
        completeness.blockers
    );
}
