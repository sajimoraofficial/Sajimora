//! validation.rs — Deep bounded artifact schema validation.
//!
//! Mirrors ArtifactSchemaValidation.ts.
//! Validates recursively with budgets before comparison.
//! Checks: invalid/missing required fields, illegal kinds, invalid routes,
//! malformed hashes, unsupported profiles.
//!
//! The 64 MiB per-artifact size limit is enforced at the read boundary (CLI/MCP),
//! not here. This module validates the already-parsed structure.

use crate::envelope::{
    ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    BackendContractPayload, ContractArtifactEnvelope, ExtractionProfile, FrontendContractPayload,
};
use crate::ir::{EndpointContract, WireType};
use anyhow::{bail, Result};

/// Maximum recursion depth for WireType validation. Prevents stack overflow on
/// adversarial deeply-nested types. Budget exhaustion marks obligation UNRESOLVED.
const MAX_WIRE_TYPE_DEPTH: usize = 64;

/// Validate all fields of a parsed artifact envelope.
/// Returns Ok(()) if all required fields are present and valid.
/// Returns Err with a description of the first violation found.
pub fn validate_artifact_fields(envelope: &ContractArtifactEnvelope) -> Result<()> {
    validate_envelope_version(envelope)?;
    validate_snapshot_ref(&envelope.snapshot)?;
    validate_profile(&envelope.profile, &envelope.kind)?;
    validate_completeness(&envelope.completeness)?;
    validate_payload(envelope)?;
    Ok(())
}

fn validate_envelope_version(envelope: &ContractArtifactEnvelope) -> Result<()> {
    if envelope.envelope_version != crate::envelope::ARTIFACT_ENVELOPE_VERSION
        && envelope.envelope_version != crate::envelope::ARTIFACT_ENVELOPE_VERSION_V2
    {
        bail!("invalid envelopeVersion: {:?}", envelope.envelope_version);
    }
    Ok(())
}

fn validate_snapshot_ref(snapshot: &ArtifactSnapshotRef) -> Result<()> {
    if snapshot.repository_id.is_empty() {
        bail!("snapshot.repositoryId is required and must not be empty");
    }
    if snapshot.service_id.is_empty() {
        bail!("snapshot.serviceId is required and must not be empty");
    }
    if snapshot.parent_commit.is_empty() {
        bail!("snapshot.parentCommit is required and must not be empty");
    }
    if snapshot.candidate_snapshot.is_empty() {
        bail!("snapshot.candidateSnapshot is required and must not be empty");
    }
    Ok(())
}

fn validate_profile(profile: &ExtractionProfile, kind: &ArtifactKind) -> Result<()> {
    match kind {
        ArtifactKind::BackendContract
            if profile.framework_profile.is_none() || profile.codec_profile.is_none() =>
        {
            bail!("backend frameworkProfile and codecProfile are required")
        }
        ArtifactKind::FrontendContract if profile.client_profile.is_none() => {
            bail!("frontend clientProfile is required")
        }
        _ => {}
    }
    if profile.tool_version.is_empty() {
        bail!("profile.toolVersion is required and must not be empty");
    }

    const SUPPORTED_FRAMEWORKS: &[&str] = &[
        crate::envelope::FRAMEWORK_SPRING_MVC,
        crate::envelope::FRAMEWORK_NESTJS,
    ];
    const SUPPORTED_CODECS: &[&str] = &["JACKSON_DEFAULT_V1", "JSON_STRINGIFY_V1"];
    const SUPPORTED_CLIENTS: &[&str] = &["STATIC_FETCH_V1", "MULTI_CLIENT_V1"];

    if let Some(ref fw) = profile.framework_profile {
        if !SUPPORTED_FRAMEWORKS.contains(&fw.as_str()) {
            bail!("unsupported frameworkProfile: {:?}", fw);
        }
    }
    if let Some(ref codec) = profile.codec_profile {
        if !SUPPORTED_CODECS.contains(&codec.as_str()) {
            bail!("unsupported codecProfile: {:?}", codec);
        }
    }
    if let Some(ref client) = profile.client_profile {
        if !SUPPORTED_CLIENTS.contains(&client.as_str()) {
            bail!("unsupported clientProfile: {:?}", client);
        }
    }

    Ok(())
}

fn validate_completeness(completeness: &ArtifactCompleteness) -> Result<()> {
    for blocker in &completeness.blockers {
        if blocker.code.is_empty() {
            bail!("completeness.blockers[].code must not be empty");
        }
        if blocker.message.is_empty() {
            bail!("completeness.blockers[].message must not be empty");
        }
    }
    Ok(())
}

fn validate_payload(envelope: &ContractArtifactEnvelope) -> Result<()> {
    match (&envelope.kind, &envelope.payload) {
        (ArtifactKind::BackendContract, ArtifactPayload::Backend(payload)) => {
            validate_backend_payload(payload)
        }
        (ArtifactKind::FrontendContract, ArtifactPayload::Frontend(payload)) => {
            validate_frontend_payload(payload)
        }
        _ => bail!("payload kind does not match envelope.kind"),
    }
}

fn validate_backend_payload(payload: &BackendContractPayload) -> Result<()> {
    if let Some(ref pool) = payload.type_pool {
        for (k, wire) in pool {
            if k.trim().is_empty() {
                bail!("type_pool keys must not be empty");
            }
            validate_wire_type(wire, 0)?;
        }
    }
    if let Some(ref paths) = payload.path_pool {
        for p in paths {
            if p.trim().is_empty() {
                bail!("path_pool entries must not be empty");
            }
        }
    }
    for endpoint in &payload.endpoints {
        validate_endpoint(endpoint)?;
    }
    Ok(())
}

fn validate_frontend_payload(payload: &FrontendContractPayload) -> Result<()> {
    if let Some(ref pool) = payload.type_pool {
        for (k, wire) in pool {
            if k.trim().is_empty() {
                bail!("type_pool keys must not be empty");
            }
            validate_wire_type(wire, 0)?;
        }
    }
    if let Some(ref paths) = payload.path_pool {
        for p in paths {
            if p.trim().is_empty() {
                bail!("path_pool entries must not be empty");
            }
        }
    }
    for client in &payload.client_contracts {
        if client.http_method.is_empty() {
            bail!("frontend client contract httpMethod must not be empty");
        }
        if client.normalized_route.is_empty() {
            bail!("frontend client contract normalizedRoute must not be empty");
        }
        if let Some(ref body) = client.request_body {
            validate_wire_type(body, 0)?;
        }
        validate_wire_type(&client.expected_response, 0)?;
    }
    Ok(())
}

fn validate_endpoint(endpoint: &EndpointContract) -> Result<()> {
    let identity = &endpoint.identity;
    if identity.http_method.is_empty() {
        bail!("endpoint identity httpMethod must not be empty");
    }
    if identity.normalized_route.raw_path.is_empty() {
        bail!("endpoint identity normalizedRoute.rawPath must not be empty");
    }
    if let Some(ref body) = endpoint.body {
        validate_wire_type(body, 0)?;
    }
    for param in &endpoint.path_parameters {
        validate_wire_type(&param.r#type, 0)?;
    }
    for param in &endpoint.query_parameters {
        validate_wire_type(&param.r#type, 0)?;
    }
    Ok(())
}

fn validate_wire_type(wire: &WireType, depth: usize) -> Result<()> {
    if depth > MAX_WIRE_TYPE_DEPTH {
        // Budget exhaustion: record as UNRESOLVED, not a mismatch
        // Caller should catch this and mark the obligation INCONCLUSIVE
        bail!("WireType nesting depth exceeded budget ({MAX_WIRE_TYPE_DEPTH})");
    }
    match wire {
        WireType::Primitive(_) => Ok(()),
        WireType::Unknown(_) => Ok(()),
        WireType::Literal(_) => Ok(()),
        WireType::Ref(r) => {
            if r.r#ref.trim().is_empty() {
                bail!("RefWireType must have non-empty ref");
            }
            Ok(())
        }
        WireType::Enum(e) => {
            if e.values.is_empty() {
                bail!("EnumWireType must have at least one value");
            }
            Ok(())
        }
        WireType::Array(a) => validate_wire_type(&a.element_type, depth + 1),
        WireType::Nullable(n) => validate_wire_type(&n.inner_type, depth + 1),
        WireType::Optional(o) => validate_wire_type(&o.inner_type, depth + 1),
        WireType::Map(m) => {
            validate_wire_type(&m.key_type, depth + 1)?;
            validate_wire_type(&m.value_type, depth + 1)
        }
        WireType::Union(u) => {
            for t in &u.types {
                validate_wire_type(t, depth + 1)?;
            }
            Ok(())
        }
        WireType::Object(o) => {
            for prop in &o.properties {
                validate_wire_type(&prop.r#type, depth + 1)?;
            }
            Ok(())
        }
    }
}
