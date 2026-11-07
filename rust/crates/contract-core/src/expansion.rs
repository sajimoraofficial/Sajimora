//! expansion.rs — Type pool expansion pass for V2 contract envelopes.
//!
//! Mirrors ContractArtifactEnvelope.ts:expandTypePool exactly.
//! Replaces all `WireType::Ref` occurrences in endpoints and client contracts
//! with the concrete structural `WireType` from `type_pool`.

use crate::envelope::{
    ArtifactPayload, BackendContractPayload, ContractArtifactEnvelope, FrontendClientContract,
    FrontendContractPayload,
};
use crate::ir::{EndpointContract, ParamContract, WireType};
use anyhow::{bail, Result};
use std::collections::{BTreeMap, HashSet};

const MAX_EXPANSION_DEPTH: usize = 80;

/// Expand all `WireType::Ref` references in an envelope using its payload's `type_pool`.
pub fn expand_type_pool(envelope: &mut ContractArtifactEnvelope) -> Result<()> {
    match &mut envelope.payload {
        ArtifactPayload::Backend(ref mut bp) => expand_backend_payload(bp),
        ArtifactPayload::Frontend(ref mut fp) => expand_frontend_payload(fp),
    }
}

fn expand_backend_payload(payload: &mut BackendContractPayload) -> Result<()> {
    let pool = match &payload.type_pool {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(()),
    };

    for ep in &mut payload.endpoints {
        expand_endpoint(ep, pool)?;
    }
    Ok(())
}

fn expand_frontend_payload(payload: &mut FrontendContractPayload) -> Result<()> {
    let pool = match &payload.type_pool {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(()),
    };

    for client in &mut payload.client_contracts {
        expand_client(client, pool)?;
    }
    Ok(())
}

fn expand_endpoint(ep: &mut EndpointContract, pool: &BTreeMap<String, WireType>) -> Result<()> {
    if let Some(ref mut body) = ep.body {
        *body = expand_wire_type(body.clone(), pool, &mut HashSet::new(), 0)?;
    }
    for param in &mut ep.path_parameters {
        expand_param(param, pool)?;
    }
    for param in &mut ep.query_parameters {
        expand_param(param, pool)?;
    }
    for param in &mut ep.headers {
        expand_param(param, pool)?;
    }
    Ok(())
}

fn expand_param(param: &mut ParamContract, pool: &BTreeMap<String, WireType>) -> Result<()> {
    param.r#type = expand_wire_type(param.r#type.clone(), pool, &mut HashSet::new(), 0)?;
    Ok(())
}

fn expand_client(
    client: &mut FrontendClientContract,
    pool: &BTreeMap<String, WireType>,
) -> Result<()> {
    if let Some(ref mut body) = client.request_body {
        *body = expand_wire_type(body.clone(), pool, &mut HashSet::new(), 0)?;
    }
    client.expected_response = expand_wire_type(
        client.expected_response.clone(),
        pool,
        &mut HashSet::new(),
        0,
    )?;
    Ok(())
}

fn expand_wire_type(
    wire: WireType,
    pool: &BTreeMap<String, WireType>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<WireType> {
    if depth > MAX_EXPANSION_DEPTH {
        bail!("expand_type_pool: recursion depth exceeded budget ({MAX_EXPANSION_DEPTH})");
    }

    match wire {
        WireType::Ref(r) => {
            let target_wire = match pool.get(&r.r#ref) {
                Some(w) => w,
                None => {
                    bail!(
                        "expandTypePool: unresolved RefWireType reference \"{}\" in type_pool.",
                        r.r#ref
                    );
                }
            };

            if visited.contains(&r.r#ref) {
                // The raw pool entry still contains refs; splicing it in would leave a Ref in
                // the expanded tree, and a downstream comparison would read it as a shape
                // mismatch instead of an unmodelled recursive type.
                return Ok(WireType::Unknown(crate::ir::UnknownWireType {
                    reason: format!(
                        "Recursive reference to `{}` is not expanded",
                        r.r#ref.rsplit('#').next().unwrap_or(&r.r#ref)
                    ),
                    provenance: r.provenance.clone(),
                }));
            }

            visited.insert(r.r#ref.clone());
            let expanded = expand_wire_type(target_wire.clone(), pool, visited, depth + 1)?;
            visited.remove(&r.r#ref);
            Ok(expanded)
        }
        WireType::Primitive(_)
        | WireType::Literal(_)
        | WireType::Unknown(_)
        | WireType::Enum(_) => Ok(wire),
        WireType::Nullable(mut n) => {
            n.inner_type = Box::new(expand_wire_type(*n.inner_type, pool, visited, depth + 1)?);
            Ok(WireType::Nullable(n))
        }
        WireType::Optional(mut o) => {
            o.inner_type = Box::new(expand_wire_type(*o.inner_type, pool, visited, depth + 1)?);
            Ok(WireType::Optional(o))
        }
        WireType::Array(mut a) => {
            a.element_type = Box::new(expand_wire_type(*a.element_type, pool, visited, depth + 1)?);
            Ok(WireType::Array(a))
        }
        WireType::Map(mut m) => {
            m.key_type = Box::new(expand_wire_type(*m.key_type, pool, visited, depth + 1)?);
            m.value_type = Box::new(expand_wire_type(*m.value_type, pool, visited, depth + 1)?);
            Ok(WireType::Map(m))
        }
        WireType::Union(mut u) => {
            let mut expanded_types = Vec::with_capacity(u.types.len());
            for t in u.types {
                expanded_types.push(expand_wire_type(t, pool, visited, depth + 1)?);
            }
            u.types = expanded_types;
            Ok(WireType::Union(u))
        }
        WireType::Object(mut o) => {
            for prop in &mut o.properties {
                prop.r#type = expand_wire_type(prop.r#type.clone(), pool, visited, depth + 1)?;
            }
            Ok(WireType::Object(o))
        }
    }
}
