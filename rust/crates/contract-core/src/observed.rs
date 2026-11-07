//! Delta-gated interpretation of observed client evidence.
//!
//! An observed access records what an untyped client *reads*, not what the producer
//! must emit. It may only become a finding when the producer itself regressed: the
//! base artifact emitted the field and the candidate stopped emitting it. Presence is
//! therefore tri-state — `None` means the artifacts do not establish either answer,
//! and a single snapshot never produces a finding on its own.

use crate::ir::WireType;
use std::collections::{BTreeMap, HashSet};

const MAX_LOOKUP_DEPTH: usize = 64;

/// Whether `body` emits the field addressed by `path`.
///
/// `path` is the observed-access syntax produced by the JavaScript pass: dot-separated
/// names where a trailing `[]` marks an array iteration (`content[].status`). A path may
/// begin with `[]` when the response body itself is the array (`[].productName`).
/// `None` means the wire type or a reference cycle makes presence unknowable, and the
/// caller must not treat that as either presence or absence.
pub fn path_present(
    body: &WireType,
    path: &str,
    pool: Option<&BTreeMap<String, WireType>>,
) -> Option<bool> {
    if path.is_empty() {
        return None;
    }
    let segments: Vec<&str> = path.split('.').collect();
    let mut current = body;
    let mut visited: HashSet<String> = HashSet::new();
    for (index, segment) in segments.iter().enumerate() {
        let (name, iterates) = split_iteration(segment);
        if name.is_empty() {
            // `[]` / `[].field`: the observed access starts at an element of the
            // response itself, so the body must be a list to answer anything.
            if !iterates {
                return None;
            }
            current = array_element_type(current, pool, &mut visited, 0)?;
            if index + 1 == segments.len() {
                return Some(true);
            }
            continue;
        }
        if !named_presence(current, name, pool, &mut visited, 0)? {
            return Some(false);
        }
        if index + 1 == segments.len() {
            return Some(true);
        }
        current = if iterates {
            array_element(current, name, pool, &mut visited, 0)?
        } else {
            property_type(current, name, pool, &mut visited, 0)?
        };
    }
    None
}

fn split_iteration(segment: &str) -> (&str, bool) {
    let mut name = segment;
    let mut iterates = false;
    while let Some(stripped) = name.strip_suffix("[]") {
        name = stripped;
        iterates = true;
    }
    (name, iterates)
}

fn named_presence<'a>(
    wire: &'a WireType,
    name: &str,
    pool: Option<&'a BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Option<bool> {
    let wire = resolve(wire, pool, visited, depth)?;
    match wire {
        WireType::Nullable(n) => named_presence(&n.inner_type, name, pool, visited, depth + 1),
        WireType::Optional(o) => named_presence(&o.inner_type, name, pool, visited, depth + 1),
        WireType::Object(o) => Some(lookup_property(o, name).is_some()),
        WireType::Union(u) => {
            let mut answer: Option<bool> = None;
            for arm in &u.types {
                let arm_answer = named_presence(arm, name, pool, visited, depth + 1)?;
                match answer {
                    Some(previous) if previous != arm_answer => return None,
                    Some(_) => {}
                    None => answer = Some(arm_answer),
                }
            }
            answer
        }
        // Keys are not declared, so neither presence nor absence is established.
        WireType::Map(_) | WireType::Unknown(_) => None,
        _ => Some(false),
    }
}

fn property_type<'a>(
    wire: &'a WireType,
    name: &str,
    pool: Option<&'a BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Option<&'a WireType> {
    let wire = resolve(wire, pool, visited, depth)?;
    match wire {
        WireType::Nullable(n) => property_type(&n.inner_type, name, pool, visited, depth + 1),
        WireType::Optional(o) => property_type(&o.inner_type, name, pool, visited, depth + 1),
        WireType::Object(o) => lookup_property(o, name).map(|p| &p.r#type),
        WireType::Union(u) => {
            let mut found: Option<&WireType> = None;
            for arm in &u.types {
                let candidate = property_type(arm, name, pool, visited, depth + 1)?;
                match found {
                    Some(existing) if !same_structural(existing, candidate) => return None,
                    Some(_) => {}
                    None => found = Some(candidate),
                }
            }
            found
        }
        _ => None,
    }
}

fn array_element<'a>(
    wire: &'a WireType,
    name: &str,
    pool: Option<&'a BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Option<&'a WireType> {
    let wire = resolve(wire, pool, visited, depth)?;
    match wire {
        WireType::Nullable(n) => array_element(&n.inner_type, name, pool, visited, depth + 1),
        WireType::Optional(o) => array_element(&o.inner_type, name, pool, visited, depth + 1),
        WireType::Object(o) => {
            let property = lookup_property(o, name)?;
            array_element_type(&property.r#type, pool, visited, depth + 1)
        }
        WireType::Array(a) => Some(&a.element_type),
        _ => None,
    }
}

fn array_element_type<'a>(
    wire: &'a WireType,
    pool: Option<&'a BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Option<&'a WireType> {
    let wire = resolve(wire, pool, visited, depth)?;
    match wire {
        WireType::Nullable(n) => array_element_type(&n.inner_type, pool, visited, depth + 1),
        WireType::Optional(o) => array_element_type(&o.inner_type, pool, visited, depth + 1),
        WireType::Array(a) => Some(&a.element_type),
        _ => None,
    }
}

fn lookup_property<'a>(
    object: &'a crate::ir::ObjectWireType,
    name: &str,
) -> Option<&'a crate::ir::WirePropertyContract> {
    object
        .properties
        .iter()
        .find(|property| property.wire_name == name)
}

fn resolve<'a>(
    wire: &'a WireType,
    pool: Option<&'a BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Option<&'a WireType> {
    if depth > MAX_LOOKUP_DEPTH {
        return None;
    }
    match wire {
        WireType::Ref(reference) => {
            let target = pool?.get(&reference.r#ref)?;
            if !visited.insert(reference.r#ref.clone()) {
                return None;
            }
            let resolved = resolve(target, pool, visited, depth + 1);
            visited.remove(&reference.r#ref);
            resolved
        }
        other => Some(other),
    }
}

fn same_structural(left: &WireType, right: &WireType) -> bool {
    match (left, right) {
        (WireType::Object(a), WireType::Object(b)) => {
            a.properties.len() == b.properties.len()
                && a.properties.iter().all(|p| {
                    b.properties.iter().any(|q| {
                        q.wire_name == p.wire_name && same_structural(&p.r#type, &q.r#type)
                    })
                })
        }
        (WireType::Array(a), WireType::Array(b)) => {
            same_structural(&a.element_type, &b.element_type)
        }
        (WireType::Primitive(a), WireType::Primitive(b)) => a.scalar == b.scalar,
        (WireType::Unknown(_), WireType::Unknown(_)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        ArrayWireType, ObjectWireType, OptionalWireType, PrimitiveScalar, PrimitiveWireType,
        RefWireType, UnknownWireType, WirePropertyContract,
    };

    fn object(properties: Vec<(&str, WireType)>) -> WireType {
        WireType::Object(ObjectWireType {
            name: None,
            properties: properties
                .into_iter()
                .map(|(name, r#type)| WirePropertyContract {
                    wire_name: name.to_string(),
                    r#type,
                    optional: false,
                    nullable: false,
                    server_assigned: false,
                    validation_constraints: vec![],
                    provenance: None,
                    aliases: vec![],
                })
                .collect(),
            strict: None,
            provenance: None,
        })
    }

    fn string() -> WireType {
        WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: None,
            provenance: None,
        })
    }

    fn array(element_type: WireType) -> WireType {
        WireType::Array(ArrayWireType {
            element_type: Box::new(element_type),
            is_stream_or_flux: None,
            provenance: None,
        })
    }

    #[test]
    fn nested_object_field_is_present() {
        let body = object(vec![("content", array(object(vec![("status", string())])))]);
        assert_eq!(path_present(&body, "content[].status", None), Some(true));
        assert_eq!(path_present(&body, "content[].missing", None), Some(false));
        assert_eq!(path_present(&body, "content.missing", None), Some(false));
    }

    #[test]
    fn root_array_paths_are_answered() {
        let body = array(object(vec![
            ("productName", string()),
            ("quantity", string()),
        ]));
        assert_eq!(path_present(&body, "[].productName", None), Some(true));
        assert_eq!(path_present(&body, "[].missing", None), Some(false));
        assert_eq!(path_present(&body, "[]", None), Some(true));

        // An object body does not establish that the response is a list.
        let object_body = object(vec![("productName", string())]);
        assert_eq!(path_present(&object_body, "[].productName", None), None);
    }

    #[test]
    fn iterating_a_non_array_property_is_unknowable() {
        let body = object(vec![("items", object(vec![("sku", string())]))]);
        assert_eq!(path_present(&body, "items[].sku", None), None);
    }

    #[test]
    fn unknown_and_map_are_unknowable() {
        let unknown = WireType::Unknown(UnknownWireType {
            reason: "test".to_string(),
            provenance: None,
        });
        assert_eq!(path_present(&unknown, "anything", None), None);
        let map = WireType::Map(crate::ir::MapWireType {
            key_type: Box::new(string()),
            value_type: Box::new(string()),
            provenance: None,
        });
        assert_eq!(path_present(&map, "anything", None), None);
    }

    #[test]
    fn refs_resolve_through_the_pool() {
        let reference = WireType::Ref(RefWireType {
            r#ref: "com.example.Body".to_string(),
            provenance: None,
        });
        let mut pool = BTreeMap::new();
        pool.insert(
            "com.example.Body".to_string(),
            object(vec![("total", string())]),
        );
        assert_eq!(path_present(&reference, "total", Some(&pool)), Some(true));
        assert_eq!(path_present(&reference, "other", Some(&pool)), Some(false));
        assert_eq!(path_present(&reference, "total", None), None);
    }

    #[test]
    fn reference_cycles_are_unknowable() {
        let mut pool = BTreeMap::new();
        pool.insert(
            "Node".to_string(),
            WireType::Ref(RefWireType {
                r#ref: "Node".to_string(),
                provenance: None,
            }),
        );
        let reference = WireType::Ref(RefWireType {
            r#ref: "Node".to_string(),
            provenance: None,
        });
        assert_eq!(path_present(&reference, "child", Some(&pool)), None);
    }

    #[test]
    fn optional_wrappers_keep_presence_answerable() {
        let body = WireType::Optional(OptionalWireType {
            inner_type: Box::new(object(vec![("total", string())])),
            provenance: None,
        });
        assert_eq!(path_present(&body, "total", None), Some(true));
    }

    #[test]
    fn union_arms_must_agree() {
        let body = WireType::Union(crate::ir::UnionWireType {
            types: vec![
                object(vec![("total", string())]),
                object(vec![("total", string())]),
            ],
            provenance: None,
        });
        assert_eq!(path_present(&body, "total", None), Some(true));
        let disagreeing = WireType::Union(crate::ir::UnionWireType {
            types: vec![object(vec![("total", string())]), object(vec![])],
            provenance: None,
        });
        assert_eq!(path_present(&disagreeing, "total", None), None);
    }
}
