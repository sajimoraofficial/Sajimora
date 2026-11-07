//! TS `enum` members carry their wire value in the declaration, so an extracted ENUM is a closed
//! set of accepted literals. Every member the extractor cannot enumerate must therefore make the
//! whole declaration UNKNOWN: a truncated set rejects values the producer legitimately sends, and
//! an empty set is not even a schema-valid artifact.
use contract_core::ir::WireType;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn pool_for(source: &str, suffix: &str) -> contract_core::envelope::FrontendContractPayload {
    let dir = tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src");
    fs::create_dir_all(&src_dir).expect("create src");
    fs::write(src_dir.join("models.ts"), source).expect("write source");
    fs::write(
        src_dir.join("api.ts"),
        format!(
            "import {{ {suffix} }} from './models';\n\
             import axios from 'axios';\n\
             export function fetchOne(): Promise<{suffix}> {{\n  return axios.get('/one');\n}}\n"
        ),
    )
    .expect("write api");
    let extractor = TypeScriptRouteExtractor::new(repo_root, &src_dir).expect("extract");
    let (payload, _) = extractor.extract_payload("ui", "backend");
    payload
}

fn pooled<'a>(
    payload: &'a contract_core::envelope::FrontendContractPayload,
    suffix: &str,
) -> &'a WireType {
    let pool = payload.type_pool.as_ref().expect("type pool");
    let key = pool
        .keys()
        .find(|k| k.ends_with(&format!("#{suffix}")))
        .unwrap_or_else(|| {
            panic!(
                "{suffix} is absent from {:?}",
                pool.keys().collect::<Vec<_>>()
            )
        });
    &pool[key]
}

fn enum_values(wire: &WireType, what: &str) -> Vec<serde_json::Value> {
    match wire {
        WireType::Enum(value) => {
            assert!(!value.values.is_empty(), "{what} must not be an empty enum");
            value.values.clone()
        }
        other => panic!("expected an ENUM for {what}, got {other:?}"),
    }
}

fn unknown_reason(wire: &WireType, what: &str) -> String {
    match wire {
        WireType::Unknown(value) => value.reason.clone(),
        other => panic!("expected UNKNOWN for {what}, got {other:?}"),
    }
}

#[test]
fn quoted_member_names_enumerate_with_typescript_numbering() {
    // `enum E { 'A', 'B' }` is a *numeric* enum whose keys are quoted: at runtime A === 0, B === 1.
    let payload = pool_for(
        "export enum CellActionDescriptorType { 'DEFAULT', 'COPY_BUTTON' }\n",
        "CellActionDescriptorType",
    );
    assert_eq!(
        enum_values(
            pooled(&payload, "CellActionDescriptorType"),
            "quoted bare members"
        ),
        vec![serde_json::json!(0), serde_json::json!(1)]
    );
}

#[test]
fn string_and_number_literals_survive_as_declared() {
    let payload = pool_for(
        "export enum Status { ACTIVE = 'ACTIVE', ARCHIVED = 7, SILENT = `silent` }\n",
        "Status",
    );
    assert_eq!(
        enum_values(pooled(&payload, "Status"), "literal members"),
        vec![
            serde_json::json!("ACTIVE"),
            serde_json::json!(7),
            serde_json::json!("silent")
        ]
    );
}

#[test]
fn implicit_numbers_follow_the_previous_member() {
    let payload = pool_for("export enum Level { LOW = 5, MEDIUM, HIGH }\n", "Level");
    assert_eq!(
        enum_values(pooled(&payload, "Level"), "auto-incremented members"),
        vec![
            serde_json::json!(5),
            serde_json::json!(6),
            serde_json::json!(7)
        ]
    );
}

#[test]
fn computed_members_make_the_whole_declaration_unknown() {
    let payload = pool_for("export enum Flags { A = 1 << 0, B = 1 << 1 }\n", "Flags");
    let reason = unknown_reason(pooled(&payload, "Flags"), "computed members");
    assert!(
        reason.contains("Flags"),
        "the reason must name the declaration: {reason}"
    );
    assert!(
        reason.contains("cannot be enumerated"),
        "the reason must say why: {reason}"
    );
}

#[test]
fn cross_referenced_members_make_the_whole_declaration_unknown() {
    let payload = pool_for(
        "export enum Other { Q = 1 }\nexport enum Ref { P = Other.Q }\n",
        "Ref",
    );
    let reason = unknown_reason(pooled(&payload, "Ref"), "cross-referenced members");
    assert!(
        reason.contains("Ref"),
        "the reason must name the declaration: {reason}"
    );
}

#[test]
fn a_declaration_without_members_is_not_an_enumerable_shape() {
    let payload = pool_for("export enum Nothing {}\n", "Nothing");
    unknown_reason(pooled(&payload, "Nothing"), "empty enum body");
}

#[test]
fn enum_shapes_are_stable_across_two_extractions() {
    let source = "export enum Mixed { 'A', B = 'bee', C = 2 }\n";
    let first = enum_values(pooled(&pool_for(source, "Mixed"), "Mixed"), "first run");
    let second = enum_values(pooled(&pool_for(source, "Mixed"), "Mixed"), "second run");
    assert_eq!(first, second);
    assert_eq!(
        first,
        vec![
            serde_json::json!(0),
            serde_json::json!("bee"),
            serde_json::json!(2)
        ]
    );
}

#[test]
fn a_use_site_of_an_unenumerable_enum_stays_unresolved() {
    let payload = pool_for("export enum Flags { A = 1 << 0, B = 1 << 1 }\n", "Flags");
    let contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/one")
        .expect("contract for /one");
    assert_eq!(
        contract.consumer_traversal_complete,
        Some(false),
        "a REF into an UNKNOWN pool node is not a proven shape"
    );
}
