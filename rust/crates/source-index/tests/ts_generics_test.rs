use contract_core::ir::WireType;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

/// A generic interface declared in one module and named at a call site in another. Each test
/// writes its own fixture, so nothing here depends on the shape of a particular repository.
fn extract(files: &[(&str, &str)]) -> contract_core::envelope::FrontendContractPayload {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");
    for (name, body) in files {
        fs::write(src_dir.join(name), body).expect("write source");
    }
    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    // The tempdir is dropped here, but the payload owns every string it reports.
    payload
}

fn contract<'a>(
    payload: &'a contract_core::envelope::FrontendContractPayload,
    route: &str,
) -> &'a contract_core::envelope::FrontendClientContract {
    payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == route)
        .unwrap_or_else(|| {
            panic!(
                "no contract for {route}; got {:?}",
                payload
                    .client_contracts
                    .iter()
                    .map(|c| c.normalized_route.as_str())
                    .collect::<Vec<_>>()
            )
        })
}

fn object_of<'a>(wire: &'a WireType, what: &str) -> &'a contract_core::ir::ObjectWireType {
    match wire {
        WireType::Object(object) => object,
        other => panic!("expected an OBJECT for {what}, got {other:?}"),
    }
}

fn reason_of_unknown(wire: &WireType) -> &str {
    match wire {
        WireType::Unknown(unknown) => unknown.reason.as_str(),
        other => panic!("expected UNKNOWN, got {other:?}"),
    }
}

fn property<'a>(
    object: &'a contract_core::ir::ObjectWireType,
    name: &str,
) -> &'a contract_core::ir::WirePropertyContract {
    object
        .properties
        .iter()
        .find(|p| p.wire_name == name)
        .unwrap_or_else(|| {
            panic!(
                "{name} is absent from {:?}",
                object
                    .properties
                    .iter()
                    .map(|p| p.wire_name.as_str())
                    .collect::<Vec<_>>()
            )
        })
}

const PAGE_DATA: &str = r#"
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
"#;

#[test]
fn binds_type_arguments_at_the_use_site() {
    let payload = extract(&[
        ("page-data.ts", PAGE_DATA),
        (
            "event.service.ts",
            r#"
import { PageData, EventItem } from './page-data';
export class EventService {
    constructor(private http: any) {}
    getEvents() { return this.http.get<PageData<EventItem>>('/api/events'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/events");

    let object = object_of(&item.expected_response, "PageData<EventItem>");
    let names: Vec<&str> = object
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["data", "totalPages", "totalElements", "hasNext"],
        "the declaration's own properties, in declared order"
    );

    let data = property(object, "data");
    let WireType::Array(array) = &data.r#type else {
        panic!("data must stay an ARRAY, got {:?}", data.r#type)
    };
    let WireType::Ref(element) = array.element_type.as_ref() else {
        panic!(
            "`T` must become the type the use site named, got {:?}",
            array.element_type
        )
    };
    assert!(
        element.r#ref.ends_with("#EventItem"),
        "data must be an array of the bound type, got {}",
        element.r#ref
    );
    assert!(
        item.consumer_traversal_complete.unwrap_or(false),
        "a bound generic is a shape: {:?}",
        item.unresolved_evidence
    );
}

#[test]
fn different_use_sites_bind_different_arguments() {
    let payload = extract(&[
        ("page-data.ts", PAGE_DATA),
        (
            "device.ts",
            "export interface DeviceInfo { name: string; }\n",
        ),
        (
            "two.service.ts",
            r#"
import { PageData, EventItem } from './page-data';
import { DeviceInfo } from './device';
export class TwoService {
    constructor(private http: any) {}
    getEvents() { return this.http.get<PageData<EventItem>>('/api/events'); }
    getDevices() { return this.http.get<PageData<DeviceInfo>>('/api/devices'); }
}
"#,
        ),
    ]);

    for (route, expected) in [
        ("/api/events", "#EventItem"),
        ("/api/devices", "#DeviceInfo"),
    ] {
        let object = object_of(&contract(&payload, route).expected_response, route);
        let WireType::Array(array) = &property(object, "data").r#type else {
            panic!("{route}: data must be an ARRAY")
        };
        let WireType::Ref(element) = array.element_type.as_ref() else {
            panic!(
                "{route}: data element must be a reference, got {:?}",
                array.element_type
            )
        };
        assert!(
            element.r#ref.ends_with(expected),
            "{route} must bind {expected}, got {}",
            element.r#ref
        );
    }
}

#[test]
fn unbound_type_parameter_says_so_instead_of_blaming_the_pool() {
    let payload = extract(&[
        ("page-data.ts", PAGE_DATA),
        (
            "raw.service.ts",
            r#"
import { PageData } from './page-data';
export class RawService {
    constructor(private http: any) {}
    getAll() { return this.http.get<PageData>('/api/raw'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/raw");

    let WireType::Ref(reference) = &item.expected_response else {
        panic!(
            "a use site that names no argument keeps the pooled reference, got {:?}",
            item.expected_response
        )
    };
    let pool = payload.type_pool.as_ref().expect("type pool");
    let object = object_of(
        pool.get(&reference.r#ref)
            .unwrap_or_else(|| panic!("{} names no pooled declaration", reference.r#ref)),
        "pooled PageData",
    );
    let data = property(object, "data");
    let WireType::Array(array) = &data.r#type else {
        panic!(
            "data must stay an ARRAY of the unbound parameter, got {:?}",
            data.r#type
        )
    };
    let reason = reason_of_unknown(&array.element_type);
    assert!(
        reason.contains("type parameter `T`") && reason.contains("not bound"),
        "the reason must name the unbound parameter, got {reason}"
    );
    assert!(
        !reason.contains("could not be resolved in local type pool"),
        "an unbound parameter is a silent source, not a resolver failure, got {reason}"
    );
    assert!(
        matches!(
            property(object, "totalPages").r#type,
            WireType::Primitive(_)
        ),
        "the parameter-free members of the shape are still known: {:?}",
        object.properties
    );
}

#[test]
fn wrong_type_argument_count_stays_unknown() {
    let payload = extract(&[
        ("page-data.ts", PAGE_DATA),
        (
            "bad.service.ts",
            r#"
import { PageData, EventItem } from './page-data';
export class BadService {
    constructor(private http: any) {}
    getTooMany() { return this.http.get<PageData<EventItem, string>>('/api/too-many'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/too-many");

    let reason = reason_of_unknown(&item.expected_response);
    assert!(
        reason.contains("takes 1 type argument(s) but was used with 2"),
        "the declaration's arity must be reported, got {reason}"
    );
    assert_eq!(
        item.consumer_traversal_complete,
        Some(false),
        "a shape whose argument count is wrong is not traversal-complete"
    );
}

/// `Paged<T>` adds `cursor` to what it inherits. Expanding only the declared body would drop the
/// inherited properties, and a narrower consumer shape turns a field the producer still sends
/// into a false `required field is absent` finding.
#[test]
fn generic_extends_is_not_instantiated_narrowly() {
    let payload = extract(&[
        ("page-data.ts", PAGE_DATA),
        (
            "paged.ts",
            "import { PageData } from './page-data';\nexport interface Paged<T> extends PageData<T> { cursor: string; }\n",
        ),
        (
            "paged.service.ts",
            r#"
import { Paged, EventItem } from './paged';
export class PagedService {
    constructor(private http: any) {}
    get() { return this.http.get<Paged<EventItem>>('/api/paged'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/paged");

    let WireType::Ref(reference) = &item.expected_response else {
        panic!(
            "a declaration with an extends clause must keep its merged pooled shape, got {:?}",
            item.expected_response
        )
    };
    let pool = payload.type_pool.as_ref().expect("type pool");
    let object = object_of(
        pool.get(&reference.r#ref)
            .unwrap_or_else(|| panic!("{} names no pooled declaration", reference.r#ref)),
        "pooled Paged",
    );
    let names: Vec<&str> = object
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert!(
        names.contains(&"cursor") && names.contains(&"totalPages"),
        "inherited and own properties must both survive: {names:?}"
    );
}

#[test]
fn recursive_generic_instantiation_abstains_instead_of_expanding_forever() {
    let payload = extract(&[
        (
            "tree.ts",
            "export interface Tree<T> { label: string; children: Array<Tree<T>>; }\nexport interface NodeInfo { id: string; }\n",
        ),
        (
            "tree.service.ts",
            r#"
import { Tree, NodeInfo } from './tree';
export class TreeService {
    constructor(private http: any) {}
    getTree() { return this.http.get<Tree<NodeInfo>>('/api/tree'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/tree");

    let object = object_of(&item.expected_response, "Tree<NodeInfo>");
    let WireType::Array(array) = &property(object, "children").r#type else {
        panic!(
            "children must stay an ARRAY, got {:?}",
            property(object, "children").r#type
        )
    };
    let reason = reason_of_unknown(&array.element_type);
    assert!(
        reason.contains("recursive"),
        "the abstention must name recursion, got {reason}"
    );
    assert!(
        matches!(property(object, "label").r#type, WireType::Primitive(_)),
        "the first level is still known"
    );
}

#[test]
fn nested_generic_arguments_bind_innermost_first() {
    let payload = extract(&[
        (
            "models.ts",
            r#"
export interface Box<T> { value: T; }
export interface Holder<T> { held: Box<T>; name: string; }
export interface Leaf { token: string; }
"#,
        ),
        (
            "holder.service.ts",
            r#"
import { Holder, Leaf } from './models';
export class HolderService {
    constructor(private http: any) {}
    get() { return this.http.get<Holder<Leaf>>('/api/holder'); }
}
"#,
        ),
    ]);
    let item = contract(&payload, "/api/holder");

    let outer = object_of(&item.expected_response, "Holder<Leaf>");
    let WireType::Object(held) = &property(outer, "held").r#type else {
        panic!(
            "held must expand to Box<Leaf>, got {:?}",
            property(outer, "held").r#type
        )
    };
    let WireType::Ref(value) = &property(held, "value").r#type else {
        panic!(
            "Box<Leaf> must bind value to Leaf, got {:?}",
            property(held, "value").r#type
        )
    };
    assert!(
        value.r#ref.ends_with("#Leaf"),
        "the innermost argument must survive two hops, got {}",
        value.r#ref
    );
}

#[test]
fn two_generic_instantiations_of_one_route_stay_deterministic() {
    let files = [
        ("page-data.ts", PAGE_DATA),
        (
            "event.service.ts",
            r#"
import { PageData, EventItem } from './page-data';
export class EventService {
    constructor(private http: any) {}
    getEvents() { return this.http.get<PageData<EventItem>>('/api/events'); }
}
"#,
        ),
    ];
    let first = extract(&files);
    let second = extract(&files);
    assert_eq!(
        serde_json::to_string(&first.client_contracts).expect("serialize"),
        serde_json::to_string(&second.client_contracts).expect("serialize"),
        "an instantiated shape must not depend on file walk order"
    );
}
