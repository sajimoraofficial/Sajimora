use contract_core::ir::WireType;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn mjs_cjs_mts_cts_sources_are_scanned() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/queries.mjs",
        "import axios from 'axios';\nexport const load = () => axios.get('/api/legacy');\n",
    );
    write(
        repo,
        "src/server.cjs",
        "const axios = require('axios');\nmodule.exports = () => axios.get('/api/cjs');\n",
    );
    write(
        repo,
        "src/esm.mts",
        "import axios from 'axios';\nexport async function load() { return axios.get('/api/mts'); }\n",
    );
    write(
        repo,
        "src/common.cts",
        "import axios from 'axios';\nexport const load = () => axios.get('/api/cts');\n",
    );

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    assert_eq!(extractor.scanned_source_files, 4);
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let mut routes: Vec<&str> = payload
        .client_contracts
        .iter()
        .map(|c| c.normalized_route.as_str())
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec!["/api/cjs", "/api/cts", "/api/legacy", "/api/mts"]
    );
}

#[test]
fn svelte_script_blocks_are_scanned() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/UserPanel.svelte",
        r#"<img src="/logo.png">
<h1>Users</h1>
<script lang="ts">
import axios from 'axios';
interface User { id: string; name: string; }
const response = axios.get<User>('/api/users/1');
</script>
<p>{response}</p>
"#,
    );

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, completeness) = extractor.extract_payload("ui", "backend");
    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/users/1")
        .expect("fetch inside a Svelte script block");
    assert_eq!(contract.http_method, "GET");
    assert_eq!(contract.source_file, "src/UserPanel.svelte");
    assert!(
        contract.source_line >= 4,
        "the line must point into the SFC, got {}",
        contract.source_line
    );
    assert!(
        matches!(&contract.expected_response, WireType::Ref(r) if r.r#ref.contains("User")),
        "SFC-local interface must resolve, got {:?}",
        contract.expected_response
    );
    assert!(
        completeness
            .blockers
            .iter()
            .all(|b| b.code != "TS_NO_CLIENT_CALL_RECOGNIZED"),
        "Svelte files must count as scanned sources: {:?}",
        completeness.blockers
    );
}

#[test]
fn client_provenance_follows_barrel_re_exports() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/api/client.ts",
        "import axios from 'axios';\nexport const transport = axios.create({ baseURL: '/api' });\n",
    );
    write(
        repo,
        "src/api/index.ts",
        "export { transport } from './client';\n",
    );
    write(
        repo,
        "src/features/list.ts",
        "import { transport } from '../api';\nexport function load() { return transport.get('/api/items'); }\n",
    );

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert!(
        payload
            .client_contracts
            .iter()
            .any(|c| c.normalized_route == "/api/items" && c.http_method == "GET"),
        "a client reached through a barrel re-export must be recognized: {:?}",
        payload
            .client_contracts
            .iter()
            .map(|c| (&c.http_method, &c.normalized_route))
            .collect::<Vec<_>>()
    );
}

#[test]
fn deeply_nested_expressions_do_not_overflow_the_observed_pass() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    let mut source = String::from("const blob = ");
    for index in 0..600 {
        if index > 0 {
            source.push_str(" + ");
        }
        source.push_str("'line'");
    }
    source.push_str(";\nfetch('/api/deep');\n");
    write(repo, "src/deep.js", &source);

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    assert!(
        payload
            .client_contracts
            .iter()
            .any(|c| c.normalized_route == "/api/deep"),
        "the fetch after a 600-term concatenation must still be extracted"
    );
}

#[test]
fn axios_and_angular_envelope_generics_are_unwrapped() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/users.ts",
        r#"
import axios from 'axios';

export interface User { id: string; name: string; }

export async function getUser(): Promise<AxiosResponse<User>> {
    return axios.get('/api/user');
}

export function getUserById() {
    return axios.get<AxiosResponse<User>>('/api/users/1');
}

export async function getAngular(): Promise<Observable<HttpResponse<User>>> {
    return this.http.get('/api/angular/user');
}
"#,
    );

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    for route in ["/api/user", "/api/users/1", "/api/angular/user"] {
        let contract = payload
            .client_contracts
            .iter()
            .find(|c| c.normalized_route == route)
            .unwrap_or_else(|| panic!("contract for {route}"));
        match &contract.expected_response {
            WireType::Ref(r) if r.r#ref.contains("User") => {}
            WireType::Object(obj) => assert!(
                obj.properties.iter().any(|p| p.wire_name == "name"),
                "expected the User shape, got {obj:?}"
            ),
            other => panic!("{route}: envelope generic must resolve User, got {other:?}"),
        }
    }
}

#[test]
fn grouped_route_prefers_a_typed_consumer_over_an_untyped_one() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/device.ts",
        r#"
import axios from 'axios';
interface Device { id: string }

export function sync() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/device');
    xhr.send();
    return axios.get<Device>('/api/device');
}
"#,
    );

    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/device")
        .expect("grouped contract");
    assert!(
        !matches!(contract.expected_response, WireType::Unknown(_)),
        "the typed axios call must supply the grouped response, got {:?}",
        contract.expected_response
    );
    assert_eq!(contract.consumers.len(), 2);
}
