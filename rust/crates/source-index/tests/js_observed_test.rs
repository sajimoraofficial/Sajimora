//! Adversarial coverage for the plain-JS observed-evidence pass.
//!
//! These tests pin the boundary the lane exists to protect: observed reads are
//! evidence, never a declared shape, and only unguarded, followed reads carry
//! `guaranteed = true`.

use contract_core::ir::ObservedResponseStatus;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn extractor(files: &[(&str, &str)]) -> TypeScriptRouteExtractor {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");
    for (name, content) in files {
        let path = src_dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write fixture");
    }
    TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract")
}

fn contract<'a>(
    payload: &'a contract_core::envelope::FrontendContractPayload,
    method: &str,
    route: &str,
) -> &'a contract_core::envelope::FrontendClientContract {
    payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == method && c.normalized_route == route)
        .unwrap_or_else(|| {
            panic!(
                "missing {method} {route}; got {:?}",
                payload
                    .client_contracts
                    .iter()
                    .map(|c| (c.http_method.as_str(), c.normalized_route.as_str()))
                    .collect::<Vec<_>>()
            )
        })
}

/// `export default api` must carry the axios-kind through the module graph, otherwise
/// `res.data` is kept as a transport property and every observed path gains a `data.`
/// prefix.
#[test]
fn axios_default_export_wrapper_strips_the_envelope() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "users.js",
            r#"
import api from "./api";
export async function fetchUser(id) {
  const res = await api.get(`/users/${id}`);
  return res.data;
}
"#,
        ),
        (
            "page.js",
            r#"
import { fetchUser } from "./users";
export function render(id) {
  const data = fetchUser(id);
  return data.name;
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/users/:param");
    let observed = c.observed_response.as_ref().expect("observed evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["name"], "envelope must not leak into paths");
    assert!(
        observed.accesses[0].guaranteed,
        "unconditional read is guaranteed"
    );
    assert!(
        matches!(c.expected_response, contract_core::ir::WireType::Unknown(_)),
        "observed evidence must not resolve the shape"
    );
}

/// Fetch keeps the body in `init.body`; the init object itself is not the payload.
#[test]
fn fetch_request_body_reads_init_body_not_the_init_object() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "auth.js",
            r#"
export async function login(username, password) {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("no");
  const body = await res.json();
  return body.token;
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "POST", "/auth/login");
    let request = c.observed_request_body.as_ref().expect("request evidence");
    let mut names: Vec<&str> = request
        .fields
        .iter()
        .map(|f| f.wire_name.as_str())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["password", "username"],
        "init metadata must not become fields"
    );

    let observed = c.observed_response.as_ref().expect("response evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    assert_eq!(observed.accesses[0].path, "token");
}

/// A fetch response without `.json()` is transport; reading `res.ok` is not a body read.
#[test]
fn fetch_transport_members_are_not_body_reads() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "status.js",
            r#"
export async function check() {
  const res = await fetch("/status");
  return res.ok;
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/status");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NotConsumed);
    assert!(observed.accesses.is_empty());
}

/// Fallback chains are alternatives and optional reads are not guaranteed: removing one
/// of them cannot break the client.
#[test]
fn fallback_and_optional_reads_are_not_guaranteed() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "things.js",
            r#"
import api from "./api";
export async function load() {
  const res = await api.get("/things");
  return res.data?.items ?? res.data.rows ?? [];
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/things");
    let observed = c.observed_response.as_ref().expect("evidence");
    let items = observed
        .accesses
        .iter()
        .find(|a| a.path == "items")
        .expect("items read");
    assert!(!items.guaranteed);
    assert!(
        items.alternative_group.is_some(),
        "fallback chains are alternatives"
    );
    let rows = observed
        .accesses
        .iter()
        .find(|a| a.path == "rows")
        .expect("rows read");
    assert!(!rows.guaranteed);
    assert_eq!(items.alternative_group, rows.alternative_group);
}

/// Response values flowing into React state stay observable, but are never guaranteed:
/// the initial state or a later setter may replace them before the read.
#[test]
fn state_setter_reads_are_observed_but_not_guaranteed() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "items.js",
            r#"
import { useState } from "react";
import api from "./api";
export function useItems() {
  const [items, setItems] = useState([]);
  const load = async () => {
    const res = await api.get("/items");
    setItems(res.data.items);
  };
  load();
  return items.map((item) => item.sku);
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/items");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    let sku = observed
        .accesses
        .iter()
        .find(|a| a.path == "items[].sku")
        .expect("state-derived element read");
    assert!(!sku.guaranteed);
}

/// A local helper's parameter accesses are composed back onto the caller's value.
#[test]
fn local_helper_parameter_reads_compose_onto_the_response() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "helpers.js",
            r#"
import api from "./api";
function firstSku(data) {
  return data.items.map((item) => item.sku)[0];
}
export async function load() {
  const res = await api.get("/items");
  return firstSku(res.data);
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/items");
    let observed = c.observed_response.as_ref().expect("evidence");
    let sku = observed
        .accesses
        .iter()
        .find(|a| a.path == "items[].sku")
        .expect("helper-composed read");
    assert!(sku.guaranteed);
}

/// A wrapper's body parameter is resolved back to the caller's object literal.
#[test]
fn caller_literals_become_request_body_evidence() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "things.js",
            r#"
import api from "./api";
export const create = async (payload) => {
  const res = await api.post("/things", payload);
  return res.data;
};
export async function submit() {
  const id = await create({ name: "widget", count: 2 });
  return id;
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "POST", "/things");
    let request = c.observed_request_body.as_ref().expect("request evidence");
    let mut names: Vec<&str> = request
        .fields
        .iter()
        .map(|f| f.wire_name.as_str())
        .collect();
    names.sort();
    assert_eq!(names, vec!["count", "name"]);
    assert!(
        request.reason.is_none(),
        "complete caller literal needs no caveat"
    );
}

/// An explicit `null` body is a deliberate no-body call, not an unfollowed expression.
#[test]
fn explicit_null_body_is_recorded_as_no_body() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "ping.js",
            r#"
import api from "./api";
export async function ping() {
  await api.post("/ping", null, { params: { fast: true } });
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "POST", "/ping");
    let request = c.observed_request_body.as_ref().expect("request evidence");
    assert!(request.fields.is_empty());
    assert!(request
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains("no request body"));
    let observed = c.observed_response.as_ref().expect("response evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NotConsumed);
}

/// Discarded response values are not shape requirements, including DELETE.
#[test]
fn discarded_delete_response_is_not_consumed() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "things.js",
            r#"
import api from "./api";
export const remove = async (id) => {
  await api.delete(`/things/${id}`);
};
export async function purge() {
  await remove(7);
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "DELETE", "/things/:param");
    let observed = c.observed_response.as_ref().expect("response evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NotConsumed);
    assert!(observed.accesses.is_empty());
}

/// A dynamic key makes the observed set non-exhaustive instead of inventing paths.
#[test]
fn dynamic_property_access_is_inconclusive() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "dyn.js",
            r#"
import api from "./api";
export async function load(key) {
  const res = await api.get("/dyn");
  return res.data[key];
}
export const started = load("x");
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/dyn");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Inconclusive);
    assert!(
        observed.accesses.is_empty(),
        "no static path may be invented"
    );
    assert!(observed
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains("dynamic"));
}

/// Helper summaries compose one hop. A second hop is not followed, and the result must
/// say so instead of pretending the response is unconsumed or inventing a path.
#[test]
fn two_hop_helper_is_inconclusive_not_unconsumed() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "deep.js",
            r#"
import api from "./api";
function format(record) {
  return record.sku;
}
function parse(data) {
  return format(data);
}
export async function load() {
  const res = await api.get("/deep");
  return parse(res.data);
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/deep");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_ne!(
        observed.status,
        ObservedResponseStatus::NotConsumed,
        "an unfollowed helper still consumes the response value"
    );
    assert!(
        observed.accesses.is_empty(),
        "a second hop must never materialize a partial path: {:?}",
        observed
            .accesses
            .iter()
            .map(|a| a.path.as_str())
            .collect::<Vec<_>>()
    );
}

/// Dead exports are reported as such rather than as endpoints with no reads.
#[test]
fn unused_exported_wrapper_is_no_callers() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "dead.js",
            r#"
import api from "./api";
export const load = async () => {
  const res = await api.get("/dead");
  return res.data;
};
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/dead");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NoCallers);
}

/// Observed evidence never competes with a declared response type.
#[test]
fn typed_response_declaration_suppresses_observed_evidence() {
    let ex = extractor(&[
        (
            "api.js",
            r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
export default api;
"#,
        ),
        (
            "device.service.ts",
            r#"
export interface Device { id: string }
export class DeviceService {
  constructor(private http: any) {}
  getDevice() {
    return this.http.get<Device>("/api/device/1");
  }
}
"#,
        ),
    ]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/api/device/1");
    assert!(
        c.observed_response.is_none(),
        "a declared response type owns the shape"
    );
    assert!(c.observed_request_body.is_none());
}

/// superagent keeps the payload in `res.body`. Treating the client as unknown prefixed every
/// observed path with `body.`, so a read could never be matched to a producer field.
#[test]
fn superagent_body_reads_lose_the_envelope() {
    let ex = extractor(&[(
        "agent.js",
        r#"
import _superagent from "superagent";
import promisePlugin from "superagent-promise";
const superagent = promisePlugin(_superagent, global.Promise);
export function firstSku() {
  const res = superagent.get("/api/items");
  return res.body.items[0].sku;
}
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/api/items");
    let observed = c.observed_response.as_ref().expect("observed evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    assert!(
        observed
            .accesses
            .iter()
            .any(|a| a.path == "items[].sku" && a.guaranteed),
        "body must not be part of the path, got {:?}",
        observed
            .accesses
            .iter()
            .map(|a| &a.path)
            .collect::<Vec<_>>()
    );
    assert!(
        observed
            .accesses
            .iter()
            .all(|a| !a.path.starts_with("body.")),
        "the envelope leaked into the observed paths"
    );
}

/// `res.status` describes the exchange, not the payload.
#[test]
fn superagent_status_is_transport_not_a_body_read() {
    let ex = extractor(&[(
        "agent.js",
        r#"
import superagent from "superagent";
export function check() {
  const res = superagent.get("/api/items");
  return res.status;
}
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/api/items");
    let observed = c.observed_response.as_ref().expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NotConsumed);
    assert!(observed.accesses.is_empty());
}

/// The wrapper-call alias is client-kind logic, not a superagent special case: an aliased
/// axios instance must still strip `data`.
#[test]
fn an_aliased_axios_client_still_strips_data() {
    let ex = extractor(&[(
        "client.js",
        r#"
import axios from "axios";
const client = attachPlugins(axios);
export async function load() {
  const res = await client.get("/api/orders");
  return res.data.total;
}
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let c = contract(&payload, "GET", "/api/orders");
    let observed = c.observed_response.as_ref().expect("observed evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["total"],
        "alias must not lose the axios envelope"
    );
}

/// `api.get("/x").then(res => res.data.items)` is a statement, and a chain continuation starts
/// at the same byte as the call it extends. Only the innermost call owns the anchor; treating
/// the chain as the HTTP call dropped every read in the callback.
#[test]
fn a_statement_level_then_callback_records_its_reads() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
api.get("/items").then(res => res.data.items);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["items"]);
    assert!(
        observed.accesses[0].guaranteed,
        "a read straight off the response is not guarded"
    );
}

/// A callback that binds nothing and reads nothing really does discard the response, so
/// NOT_CONSUMED must survive the chain fix rather than collapse into INCONCLUSIVE.
#[test]
fn a_then_callback_that_reads_nothing_is_still_not_consumed() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
api.get("/items").then(() => { refresh(); });
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::NotConsumed);
    assert!(observed.accesses.is_empty());
}

/// A fulfilled promise carries the callback's value, so the field the second callback reads
/// sits on the payload, not on the transport response. Without this the most common plain-JS
/// fetch idiom yields no evidence at all.
#[test]
fn a_promise_chain_carries_the_callback_value() {
    let ex = extractor(&[(
        "a.js",
        r#"
fetch("/api/items").then(res => res.json()).then(body => body.items);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/api/items")
        .observed_response
        .clone()
        .expect("evidence");
    assert_eq!(observed.status, ObservedResponseStatus::Observed);
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["items"],
        "the json() envelope must not survive twice"
    );
}

/// `.then(show)` hands the response to a local function. Following it through the same
/// registry that binds array callbacks keeps the reads attributable.
#[test]
fn a_named_handler_in_then_is_followed() {
    let ex = extractor(&[(
        "a.js",
        r#"
function show(body) { return body.items.length; }
fetch("/api/items").then(res => res.json()).then(show);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/api/items")
        .observed_response
        .clone()
        .expect("evidence");
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["items"]);
}

/// `.catch(err => ...)` receives an error, not the response body. Its reads must not be
/// attributed to the endpoint as field requirements.
#[test]
fn a_catch_callback_is_not_attributed_to_the_endpoint() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
api.get("/items").then(res => res.data.items).catch(err => log(err.message));
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["items"],
        "an error field is not a response field"
    );
}

/// A named function declared inside a callback has its own return value; donating it to the
/// promise chain would invent a field the caller never receives.
#[test]
fn a_nested_named_functions_return_does_not_join_the_chain() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
const p = api.get("/items").then(res => {
    function inner(r) { return r.data.other; }
    return res.data.items;
});
export const use = () => p.then(v => v.total);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    let mut paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec!["items", "items.total"],
        "only the outer return flows on"
    );
}

/// A pass-through wrapper hands its caller the transport response, so `res.data` at the call
/// site is the envelope and the wire field is `items`.
#[test]
fn a_pass_through_wrapper_gives_its_sites_the_transport_envelope() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
const requests = { get: url => api.get(url) };
export const load = () => requests.get("/items").then(res => res.data.items);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["items"]);
}

/// A wrapper that unwraps hands its caller the payload, so a `res.data` further down names a
/// real nested field. Applying the client envelope again would silently drop one level.
#[test]
fn an_unwrapping_wrapper_does_not_re_apply_the_envelope_at_its_sites() {
    let ex = extractor(&[(
        "a.js",
        r#"
import axios from "axios";
const api = axios.create({ baseURL: "/api" });
const unwrap = res => res.data;
const requests = { get: url => api.get(url).then(unwrap) };
export const load = () => requests.get("/items").then(res => res.data.items);
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/items")
        .observed_response
        .clone()
        .expect("evidence");
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["data.items"]);
}

#[test]
fn a_vue_sfc_plain_js_extracts_observed_access_and_retains_shape() {
    let ex = extractor(&[(
        "Component.vue",
        r#"<template>
  <div>{{ items }}</div>
</template>
<script>
import axios from "axios";
export default {
  data() {
    return { items: [] };
  },
  async mounted() {
    const res = await axios.get("/api/vue-items");
    this.items = res.data.items;
  }
};
</script>
"#,
    )]);

    let (payload, _) = ex.extract_payload("ui", "backend");
    let observed = contract(&payload, "GET", "/api/vue-items")
        .observed_response
        .clone()
        .expect("evidence from vue sfc");
    let paths: Vec<&str> = observed.accesses.iter().map(|a| a.path.as_str()).collect();
    assert_eq!(paths, vec!["items"]);
}
