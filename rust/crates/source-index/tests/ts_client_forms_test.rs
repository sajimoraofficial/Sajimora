use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn routes(source: &str) -> Vec<(String, String)> {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(repo, "src/client.ts", source);
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    routes
}

#[test]
fn namespace_and_named_aliases_keep_http_evidence() {
    let found = routes(
        r#"
import * as transport from 'axios';
import { got as fetchJson } from 'got';

transport.get('/api/namespace');
fetchJson('/api/alias');
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/alias".to_string()),
            ("GET".to_string(), "/api/namespace".to_string()),
        ]
    );
}

#[test]
fn nestjs_http_service_and_axios_ref_are_recognized() {
    let found = routes(
        r#"
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export class UsersService {
  constructor(private readonly httpService: HttpService) {}

  async load() {
    await firstValueFrom(this.httpService.get('/api/nest-users'));
    await firstValueFrom(this.httpService.axiosRef.post('/api/nest-users', {}));
  }
}
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/nest-users".to_string()),
            ("POST".to_string(), "/api/nest-users".to_string()),
        ]
    );
}

#[test]
fn axios_ref_without_the_nest_package_is_not_a_client() {
    let found = routes(
        r#"
class Holder {
  axiosRef = { get: (_url: string) => 1 };
}
const holder = new Holder();
holder.axiosRef.get('/api/not-http');
"#,
    );
    assert!(found.is_empty(), "{found:?}");
}

#[test]
fn direct_call_clients_are_recognized() {
    let found = routes(
        r#"
import got from 'got';
import ky from 'ky';
import { ofetch } from 'ofetch';
import axios from 'axios';

got('/api/got', { method: 'POST', json: { a: 1 } });
ky('/api/ky');
ofetch('/api/of', { method: 'DELETE' });
axios('/api/ax', { method: 'PATCH' });
"#,
    );
    assert_eq!(
        found,
        vec![
            ("DELETE".to_string(), "/api/of".to_string()),
            ("GET".to_string(), "/api/ky".to_string()),
            ("PATCH".to_string(), "/api/ax".to_string()),
            ("POST".to_string(), "/api/got".to_string()),
        ]
    );
}

#[test]
fn head_options_window_fetch_and_angular_request_are_recognized() {
    let found = routes(
        r#"
import axios from 'axios';
class Service {
  constructor(private http: any) {}
  load() {
    axios.head('/api/head');
    this.http.options('/api/options');
    window.fetch('/api/window', { method: 'PUT' });
    this.http.request('POST', '/api/request', { value: 1 });
  }
}
"#,
    );
    assert_eq!(
        found,
        vec![
            ("HEAD".to_string(), "/api/head".to_string()),
            ("OPTIONS".to_string(), "/api/options".to_string()),
            ("POST".to_string(), "/api/request".to_string()),
            ("PUT".to_string(), "/api/window".to_string()),
        ]
    );
}

#[test]
fn jquery_calls_are_recognized() {
    let found = routes(
        r#"
$.getJSON('/api/jq');
$.ajax({ url: '/api/ja', type: 'POST', data: { x: 1 } });
$.post('/api/jp', { value: 2 });
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/jq".to_string()),
            ("POST".to_string(), "/api/ja".to_string()),
            ("POST".to_string(), "/api/jp".to_string()),
        ]
    );
}

#[test]
fn nuxt_and_swr_wrappers_require_import_evidence() {
    let found = routes(
        r#"
import { useFetch } from '#app';
import useSWR from 'swr';

$fetch('/api/nuxt', { method: 'POST' });
useFetch('/api/uf');
useSWR('/api/swr');
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/swr".to_string()),
            ("GET".to_string(), "/api/uf".to_string()),
            ("POST".to_string(), "/api/nuxt".to_string()),
        ]
    );
}

#[test]
fn xhr_and_send_beacon_are_recognized() {
    let found = routes(
        r#"
navigator.sendBeacon('/api/beacon', payload);
const xhr = new XMLHttpRequest();
xhr.open('GET', '/api/xhr');
xhr.send();
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/xhr".to_string()),
            ("POST".to_string(), "/api/beacon".to_string()),
        ]
    );
}

#[test]
fn destructured_client_verbs_are_recognized() {
    let found = routes(
        r#"
import { get } from 'axios';
get('/api/destructured');
const { post } = axios;
post('/api/destructured-post', { value: 1 });
"#,
    );
    assert_eq!(
        found,
        vec![
            ("GET".to_string(), "/api/destructured".to_string()),
            ("POST".to_string(), "/api/destructured-post".to_string()),
        ]
    );
}

#[test]
fn test_untyped_delete_defaults_to_void() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
import axios from 'axios';
export class DeviceService {
    deleteDevice(id: string) {
        return axios.delete(`/api/device/${id}`);
    }
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    assert_eq!(contract.http_method, "DELETE");
    assert_eq!(contract.normalized_route, "/api/device/:param");
    match &contract.expected_response {
        contract_core::ir::WireType::Primitive(p) => {
            assert_eq!(p.scalar, contract_core::ir::PrimitiveScalar::Void);
        }
        other => panic!("Expected Primitive(Void), got {:?}", other),
    }
}

#[test]
fn test_observable_void_resolves_to_void() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
import { Observable } from 'rxjs';
export class DeviceService {
    http: any;
    deleteDevice(id: string): Observable<void> {
        return this.http.delete(`/api/device/${id}`);
    }
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    match &contract.expected_response {
        contract_core::ir::WireType::Primitive(p) => {
            assert_eq!(p.scalar, contract_core::ir::PrimitiveScalar::Void);
        }
        other => panic!("Expected Primitive(Void), got {:?}", other),
    }
}

#[test]
fn test_contextual_type_from_variable_declarator() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
import axios from 'axios';
interface UserDto {
    id: string;
    name: string;
}
export async function loadUser(id: string) {
    const user: UserDto = await axios.get(`/api/user/${id}`);
    return user;
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    assert_eq!(contract.http_method, "GET");
    match &contract.expected_response {
        contract_core::ir::WireType::Ref(r) => {
            assert!(r.r#ref.contains("UserDto"));
        }
        other => panic!("Expected Ref(UserDto), got {:?}", other),
    }
}

#[test]
fn test_contextual_type_from_as_expression() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
import axios from 'axios';
interface UserDto {
    id: string;
    name: string;
}
export async function loadUser(id: string) {
    return (await axios.get(`/api/user/${id}`)) as UserDto;
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    match &contract.expected_response {
        contract_core::ir::WireType::Ref(r) => {
            assert!(r.r#ref.contains("UserDto"));
        }
        other => panic!("Expected Ref(UserDto), got {:?}", other),
    }
}

#[test]
fn test_contextual_type_from_rxjs_pipe() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
import { Observable } from 'rxjs';
interface UserDto {
    id: string;
    name: string;
}
export class UserService {
    http: any;
    loadUser(id: string): Observable<UserDto> {
        return this.http.get(`/api/user/${id}`).pipe();
    }
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    match &contract.expected_response {
        contract_core::ir::WireType::Ref(r) => {
            assert!(r.r#ref.contains("UserDto"));
        }
        other => panic!("Expected Ref(UserDto), got {:?}", other),
    }
}

#[test]
fn test_contextual_type_from_subscribe_callback() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/client.ts",
        r#"
interface UserDto {
    id: string;
    name: string;
}
export class UserService {
    http: any;
    loadUser(id: string) {
        this.http.get(`/api/user/${id}`).subscribe((user: UserDto) => {
            console.log(user);
        });
    }
}
"#,
    );
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    let contract = &payload.client_contracts[0];
    match &contract.expected_response {
        contract_core::ir::WireType::Ref(r) => {
            assert!(r.r#ref.contains("UserDto"));
        }
        other => panic!("Expected Ref(UserDto), got {:?}", other),
    }
}
