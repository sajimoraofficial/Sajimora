//! contract-core -- Sajimora contract artifact DTOs, canonicalization, admission, and comparison.
//!
//! Corresponds to the TypeScript modules in:
//!   packages/analysis/src/sajimora/cross-language/

pub mod admission;
pub mod advisory;
pub mod canonical;
pub mod comparison;
pub mod envelope;
pub mod expansion;
pub mod identity;
pub mod inclusion;
pub mod ir;
pub mod observed;
pub mod policy;
pub mod replay;
pub mod report;
pub mod request_synthesis;
pub mod routes;
pub mod serialization;
pub mod service;
pub mod shape_report;
pub mod synthesis;
pub mod validation;

pub use admission::{
    admit_artifact, admit_artifact_at, load_signing_key, sign_ed25519, sign_envelope_value,
    sign_envelope_value_v2, verify_ed25519_signature, verify_manifest_admission,
    verify_manifest_admission_expected, verify_shard_content, AdmissionError, AdmittedManifest,
    ArtifactTrustPolicy, TrustedProducer, WaiverApprover, SIGNATURE_FORMAT_V1,
    SIGNATURE_FORMAT_V2_ENVELOPE,
};
pub use advisory::{EvidenceAdvisory, EVIDENCE_ADVISORY_CONTRACT_AGE};
pub use envelope::{
    build_envelope_sign_payload, build_sign_payload, canonical_manifest_bytes,
    compute_manifest_digest, seal_envelope, verify_envelope_integrity, ArtifactComparisonVerdict,
    ArtifactKind, ContractArtifactEnvelope, ManifestShard, ManifestSignature, ShardDescriptor,
    SignedManifest, UnsignedManifest, ARTIFACT_ENVELOPE_VERSION, ARTIFACT_ENVELOPE_VERSION_V2,
    ARTIFACT_MANIFEST_VERSION_V2, ENVELOPE_SIGN_DOMAIN_HEADER,
};
pub use expansion::expand_type_pool;
pub use policy::{
    build_admission_audit, build_waiver_sign_payload, evaluate_admission_policy,
    AdmissionAuditArtifact, AdmissionDecision, EndpointTrafficContext, PolicyMode, TelemetryProof,
    WaiverEndpointScope, WaiverEntry, WaiverLedger, ADMISSION_AUDIT_SCHEMA, WAIVER_LEDGER_SCHEMA,
};
pub use replay::{
    check_replay, parse_deployment_seq, DeploymentStateLedger, DEPLOYMENT_STATE_SCHEMA,
};
pub use report::{AbstentionCode, ASSURANCE, SCHEMA_VERSION};
pub use synthesis::{
    synthesize_fast_check, synthesize_jqwik, synthesize_jqwik_with_package, synthesize_junit4,
    synthesize_junit5, synthesize_tests, synthesize_tests_with_package, TestSynthesisFramework,
};
