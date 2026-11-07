//! report.rs -- Report DTOs, assurance constants, verdicts, findings, and finding IDs.
//!
//! Mirrors CrossLanguageContracts.ts exactly.
//! buildFindingId: sha256(method\0path\0javaFile\0wirePath)[..16] as hex

use crate::canonical::canonical_json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Schema / assurance constants
// ---------------------------------------------------------------------------

pub const SCHEMA_VERSION: &str = "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1";
pub const ASSURANCE: &str = "ADVISORY_ONLY";

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/// Overall compatibility verdict. Precedence (highest wins):
/// ANALYSIS_ERROR > LIKELY_VIOLATED > INCONCLUSIVE > LIKELY_PRESERVED
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrossLanguageVerdict {
    #[serde(rename = "LIKELY_VIOLATED")]
    LikelyViolated,
    #[serde(rename = "LIKELY_PRESERVED")]
    LikelyPreserved,
    #[serde(rename = "INCONCLUSIVE")]
    Inconclusive,
    #[serde(rename = "ANALYSIS_ERROR")]
    AnalysisError,
}

impl CrossLanguageVerdict {
    fn rank(self) -> u8 {
        match self {
            CrossLanguageVerdict::AnalysisError => 3,
            CrossLanguageVerdict::LikelyViolated => 2,
            CrossLanguageVerdict::Inconclusive => 1,
            CrossLanguageVerdict::LikelyPreserved => 0,
        }
    }

    pub fn merge(self, other: CrossLanguageVerdict) -> CrossLanguageVerdict {
        if self.rank() >= other.rank() {
            self
        } else {
            other
        }
    }
}

pub fn merge_verdicts(
    verdicts: impl IntoIterator<Item = CrossLanguageVerdict>,
) -> CrossLanguageVerdict {
    verdicts
        .into_iter()
        .fold(CrossLanguageVerdict::LikelyPreserved, |acc, v| acc.merge(v))
}

// ---------------------------------------------------------------------------
// Snapshot identity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIdentity {
    pub repository_id: String,
    pub parent_commit: String,
    pub candidate_snapshot: String,
}

// ---------------------------------------------------------------------------
// Endpoint location
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointLocation {
    pub method: String,
    pub path: String,
    pub java_file: String,
    pub line: u32,
}

// ---------------------------------------------------------------------------
// TypeScript client reference
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TsExpectationKind {
    #[serde(rename = "TYPE_ASSERTION")]
    TypeAssertion,
    #[serde(rename = "ZOD_DECODER")]
    ZodDecoder,
    #[serde(rename = "INFERRED_TYPE")]
    InferredType,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeScriptClientRef {
    pub file: String,
    pub line: u32,
    pub expectation: String,
    pub expectation_kind: TsExpectationKind,
}

// ---------------------------------------------------------------------------
// Consumer site
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerSite {
    pub file: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub usage: String,
}

// ---------------------------------------------------------------------------
// Evidence item
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceKind {
    #[serde(rename = "JAVA_SOURCE")]
    JavaSource,
    #[serde(rename = "TS_SOURCE")]
    TsSource,
    #[serde(rename = "CONFIG_FILE")]
    ConfigFile,
    #[serde(rename = "MANIFEST")]
    Manifest,
    #[serde(rename = "TELEMETRY")]
    Telemetry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceItem {
    pub kind: EvidenceKind,
    pub file: String,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

// ---------------------------------------------------------------------------
// Finding ID
// ---------------------------------------------------------------------------

/// Schema tag for the canonical (v2) finding identity (spec §6.1).
pub const FINDING_ID_SCHEMA_V1: &str = "SAJIMORA_FINDING_V1";

/// Build a stable 16-char hex finding ID from (method, path, javaFile, wirePath).
/// Matches CrossLanguageContracts.ts:buildFindingId exactly.
///
/// raw = [method, path, javaFile, wirePath].map(s => s.replace(/\\/g, '/')).join('\0')
/// id  = sha256(raw).hex()[..16]
pub fn build_finding_id(method: &str, path: &str, java_file: &str, wire_path: &str) -> String {
    // Normalize backslashes to forward slashes (matches TS .replace(/\\/g, '/'))
    let norm = |s: &str| s.replace('\\', "/");
    let raw = format!(
        "{}\0{}\0{}\0{}",
        norm(method),
        norm(path),
        norm(java_file),
        norm(wire_path)
    );
    let hash = Sha256::digest(raw.as_bytes());
    hex::encode(hash)[..16].to_string()
}

/// Canonical finding identity input (spec §6.1). The digest is computed over
/// the RFC 8785 canonical JSON of this structure, so identity is independent
/// of line-number drift and of boundary-delimiter collisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingDigestInput {
    pub version: String,
    pub method: String,
    pub normalized_route: String,
    pub wire_path: String,
    pub change_kind: String,
    pub consumer_file: String,
}

/// Infer a coarse change kind from a before/after pair. An empty side denotes
/// addition or removal; any other pair is a type/shape change. This mapping is
/// frozen: changing it changes every v2 finding id.
pub fn infer_change_kind(before: &str, after: &str) -> &'static str {
    if before.is_empty() {
        "FIELD_ADDED"
    } else if after.is_empty() {
        "FIELD_REMOVED"
    } else {
        "TYPE_CHANGED"
    }
}

/// Compute the canonical v2 finding id (spec §6.1):
/// `sha256(JCS(FindingDigestInput))` as 64 lowercase hex characters.
pub fn build_finding_id_v2(input: &FindingDigestInput) -> String {
    let canonical =
        canonical_json(&serde_json::to_value(input).expect("FindingDigestInput serializes"));
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

/// Populate `id_v2` on a finding from its stable fields. Uses the endpoint
/// method/path as the normalized route, the inferred change kind, and the
/// consumer file — never line numbers.
pub fn populate_finding_id_v2(finding: &mut CrossLanguageFinding) {
    let input = FindingDigestInput {
        version: FINDING_ID_SCHEMA_V1.to_string(),
        method: finding.endpoint.method.clone(),
        normalized_route: finding.endpoint.path.clone(),
        wire_path: finding.wire_path.clone(),
        change_kind: infer_change_kind(&finding.change.before, &finding.change.after).to_string(),
        consumer_file: finding.typescript_client.file.clone(),
    };
    finding.id_v2 = Some(build_finding_id_v2(&input));
}

/// Build finding ID from the canonical_json wire-path string used by ArtifactComparisonEngine.
/// wire_path_json = canonical_json([direction, wirePath, before, after, tsFile, tsLine, repoId, snapshot])
#[allow(clippy::too_many_arguments)]
pub fn build_finding_id_from_parts(
    method: &str,
    path: &str,
    java_file: &str,
    direction: &str,
    wire_path: &str,
    before: &str,
    after: &str,
    ts_file: &str,
    ts_line: u32,
    repo_id: &str,
    candidate_snapshot: &str,
) -> String {
    use serde_json::json;
    let wire_path_json = canonical_json(&json!([
        direction,
        wire_path,
        before,
        after,
        ts_file,
        ts_line,
        repo_id,
        candidate_snapshot
    ]));
    build_finding_id(method, path, java_file, &wire_path_json)
}

// ---------------------------------------------------------------------------
// CrossLanguageFinding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossLanguageFinding {
    pub id: String,
    /// Canonical v2 identity (spec §6.1); line-number independent. Absent on
    /// legacy findings that predate the ratchet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_v2: Option<String>,
    /// Differential ratchet classification (spec §6.1): findings known to the
    /// baseline are FROZEN_LEGACY_DEBT, others NEW_VIOLATIONS, resolved
    /// baseline findings RESOLVED. Stamped by `apply_finding_ratchet`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<FindingClassification>,
    pub endpoint: EndpointLocation,
    pub wire_path: String,
    pub change: ChangeRecord,
    pub typescript_client: TypeScriptClientRef,
    pub consumers: Vec<ConsumerSite>,
    pub evidence: Vec<EvidenceItem>,
    pub repair_hint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FindingClassification {
    #[serde(rename = "NEW_VIOLATIONS")]
    NewViolations,
    #[serde(rename = "FROZEN_LEGACY_DEBT")]
    FrozenLegacyDebt,
    #[serde(rename = "RESOLVED")]
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub before: String,
    pub after: String,
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockerCode {
    #[serde(rename = "UNRESOLVED_ROUTE")]
    UnresolvedRoute,
    #[serde(rename = "DYNAMIC_URL")]
    DynamicUrl,
    #[serde(rename = "AMBIGUOUS_ENDPOINT")]
    AmbiguousEndpoint,
    #[serde(rename = "AMBIGUOUS_ENDPOINT_MAPPING")]
    AmbiguousEndpointMapping,
    #[serde(rename = "UNLINKED_CHANGED_ENDPOINT")]
    UnlinkedChangedEndpoint,
    #[serde(rename = "UNSUPPORTED_FRAMEWORK")]
    UnsupportedFramework,
    #[serde(rename = "EVIDENCE_CONFLICT")]
    EvidenceConflict,
    #[serde(rename = "UNSUPPORTED_SERIALIZER")]
    UnsupportedSerializer,
    #[serde(rename = "CUSTOM_JACKSON_SERIALIZER")]
    CustomJacksonSerializer,
    #[serde(rename = "CUSTOM_JACKSON_DESERIALIZER")]
    CustomJacksonDeserializer,
    #[serde(rename = "UNSUPPORTED_JACKSON_FEATURE")]
    UnsupportedJacksonFeature,
    #[serde(rename = "AMBIGUOUS_WIRE_PROPERTY")]
    AmbiguousWireProperty,
    #[serde(rename = "UNRESOLVED_JAVA_GENERIC")]
    UnresolvedJavaGeneric,
    #[serde(rename = "UNSUPPORTED_LOMBOK_ACCESSOR")]
    UnsupportedLombokAccessor,
    #[serde(rename = "UNRESOLVED_TS_CLIENT")]
    UnresolvedTsClient,
    #[serde(rename = "UNRESOLVED_TS_TYPE")]
    UnresolvedTsType,
    #[serde(rename = "UNRESOLVED_TS_PROJECT")]
    UnresolvedTsProject,
    #[serde(rename = "UNSUPPORTED_CLIENT_WRAPPER")]
    UnsupportedClientWrapper,
    #[serde(rename = "UNRESOLVED_HTTP_WRAPPER")]
    UnresolvedHttpWrapper,
    #[serde(rename = "UNRESOLVED_CONSUMER_ALIAS")]
    UnresolvedConsumerAlias,
    #[serde(rename = "INCOMPLETE_CONSUMER_GRAPH")]
    IncompleteConsumerGraph,
    #[serde(rename = "NO_CONSUMER_CONTRACTS")]
    NoConsumerContracts,
    #[serde(rename = "UNMATCHED_TARGET_SERVICE_ID")]
    UnmatchedTargetServiceId,
    #[serde(rename = "UNSUPPORTED_VALIDATION_RULE")]
    UnsupportedValidationRule,
    #[serde(rename = "DYNAMIC_ZOD_SCHEMA")]
    DynamicZodSchema,
    #[serde(rename = "DYNAMIC_ZOD_TRANSFORM")]
    DynamicZodTransform,
    #[serde(rename = "UNSUPPORTED_ZOD_TYPE")]
    UnsupportedZodType,
    #[serde(rename = "BUDGET_EXCEEDED")]
    BudgetExceeded,
    #[serde(rename = "EXTERNAL_CONSUMER_BOUNDARY")]
    ExternalConsumerBoundary,
    #[serde(rename = "UNRESOLVED_JACKSON_CONFIG")]
    UnresolvedJacksonConfig,
    #[serde(rename = "UNSAFE_FILE_PATH")]
    UnsafeFilePath,
    #[serde(rename = "FILE_READ_ERROR")]
    FileReadError,
    #[serde(rename = "DUPLICATE_FILE_PATH")]
    DuplicateFilePath,
    #[serde(rename = "FILE_CHANGED_DURING_CAPTURE")]
    FileChangedDuringCapture,
    #[serde(rename = "MISSING_PARENT_BLOB")]
    MissingParentBlob,
    #[serde(rename = "TOOL_FAILURE")]
    ToolFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBlocker {
    pub code: BlockerCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

// ---------------------------------------------------------------------------
// Abstention code taxonomy (12 canonical classes)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AbstentionCode {
    WireShapeUnresolved,
    ParamValueNoEvidence,
    ClientUntypedUsageInconclusive,
    ClientTraversalIncomplete,
    NoLinkedBackendEndpoint,
    RoutePrefixUnresolved,
    ShapeUntypedCall,
    ShapeEmptyObjectDecl,
    RouteConstraintUnverified,
    ArtifactHeadIncomplete,
    StaticRouteUnresolvedUrl,
    StaticFrameworkNotParsed,
}

impl AbstentionCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WireShapeUnresolved => "WIRE_SHAPE_UNRESOLVED",
            Self::ParamValueNoEvidence => "PARAM_VALUE_NO_EVIDENCE",
            Self::ClientUntypedUsageInconclusive => "CLIENT_UNTYPED_USAGE_INCONCLUSIVE",
            Self::ClientTraversalIncomplete => "CLIENT_TRAVERSAL_INCOMPLETE",
            Self::NoLinkedBackendEndpoint => "NO_LINKED_BACKEND_ENDPOINT",
            Self::RoutePrefixUnresolved => "ROUTE_PREFIX_UNRESOLVED",
            Self::ShapeUntypedCall => "SHAPE_UNTYPED_CALL",
            Self::ShapeEmptyObjectDecl => "SHAPE_EMPTY_OBJECT_DECL",
            Self::RouteConstraintUnverified => "ROUTE_CONSTRAINT_UNVERIFIED",
            Self::ArtifactHeadIncomplete => "ARTIFACT_HEAD_INCOMPLETE",
            Self::StaticRouteUnresolvedUrl => "STATIC_ROUTE_UNRESOLVED_URL",
            Self::StaticFrameworkNotParsed => "STATIC_FRAMEWORK_NOT_PARSED",
        }
    }

    pub fn classify(message: &str) -> Option<Self> {
        let lower = message.to_ascii_lowercase();
        if lower.contains("wire contract is unresolved") {
            Some(Self::WireShapeUnresolved)
        } else if lower.contains("requires unqualified consumer evidence")
            || lower.contains("path parameter")
            || lower.contains("query parameter")
            || lower.contains("header parameter")
            || lower.contains("v1 consumers carry no evidence")
        {
            Some(Self::ParamValueNoEvidence)
        } else if lower.contains("cannot be followed to a property read")
            || lower.contains("untyped response usage is inconclusive")
        {
            Some(Self::ClientUntypedUsageInconclusive)
        } else if lower.contains("consumer traversal incomplete") {
            Some(Self::ClientTraversalIncomplete)
        } else if lower.contains("has no resolved candidate backend endpoint")
            || lower.contains("has no linked candidate backend endpoint")
            || lower.contains("no linked backend endpoint")
        {
            Some(Self::NoLinkedBackendEndpoint)
        } else if lower.contains("not resolvable from source and is treated as an authority")
            || lower.contains("route begins with")
        {
            Some(Self::RoutePrefixUnresolved)
        } else if lower.contains("requires type annotation or reconciliation")
            || lower.contains("response return from untyped client call")
        {
            Some(Self::ShapeUntypedCall)
        } else if lower.contains("empty or unshaped object") {
            Some(Self::ShapeEmptyObjectDecl)
        } else if lower.contains("route constraint or wildcard is unverified") {
            Some(Self::RouteConstraintUnverified)
        } else if lower.contains("head is incomplete") || lower.contains("artifact head incomplete")
        {
            Some(Self::ArtifactHeadIncomplete)
        } else if lower.contains("do not expose a statically resolvable endpoint")
            || lower.contains("ts_unresolved_client_url")
        {
            Some(Self::StaticRouteUnresolvedUrl)
        } else if lower.contains("reads spring mvc annotations only")
            || lower.contains("java_mapping_framework_unparsed")
            || lower.contains("grpc")
            || lower.contains("jax-rs")
            || lower.contains("feign")
        {
            Some(Self::StaticFrameworkNotParsed)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Specific reason codes for unresolved evidence
// ---------------------------------------------------------------------------

/// The root cause behind one unresolved or UNKNOWN item. `AbstentionCode` stays
/// the stable counting family; this taxonomy names why the evidence is missing,
/// so an INCONCLUSIVE verdict is actionable instead of merely reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    MissingGenericArgumentBinding,
    UnresolvedDependencyImport,
    DynamicControllerDelegation,
    RuntimeSerializationDecidesShape,
    UnsupportedConstruct,
    PolymorphicSubtypesUnresolved,
    JavaTypeUnresolved,
    TsTypeReferenceUnresolved,
    ResponseTypeUnresolved,
    ResponseTypeNonJson,
    RequestBodyExpressionUnresolved,
    UntypedUsageInconclusive,
    ParameterValueNoEvidence,
    ClientTraversalIncomplete,
    NoLinkedEndpoint,
    RoutePlaceholderUnresolved,
    RoutePrefixAssumed,
    RouteConstraintUnverified,
    ServiceTargetMismatch,
    ApiVersionMismatch,
    ServiceMappingRequired,
    UndeclaredAbsoluteUrl,
    EmptyObjectDeclaration,
    ArtifactIncomplete,
    StaticFrameworkUnparsed,
    WireContractUnresolved,
    Unclassified,
}

impl ReasonCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingGenericArgumentBinding => "MISSING_GENERIC_ARGUMENT_BINDING",
            Self::UnresolvedDependencyImport => "UNRESOLVED_DEPENDENCY_IMPORT",
            Self::DynamicControllerDelegation => "DYNAMIC_CONTROLLER_DELEGATION",
            Self::RuntimeSerializationDecidesShape => "RUNTIME_SERIALIZATION_DECIDES_SHAPE",
            Self::UnsupportedConstruct => "UNSUPPORTED_CONSTRUCT",
            Self::PolymorphicSubtypesUnresolved => "POLYMORPHIC_SUBTYPES_UNRESOLVED",
            Self::JavaTypeUnresolved => "UNRESOLVED_JAVA_TYPE",
            Self::TsTypeReferenceUnresolved => "UNRESOLVED_TS_TYPE_REFERENCE",
            Self::ResponseTypeUnresolved => "RESPONSE_TYPE_UNRESOLVED",
            Self::ResponseTypeNonJson => "RESPONSE_TYPE_NON_JSON",
            Self::RequestBodyExpressionUnresolved => "REQUEST_BODY_EXPRESSION_UNRESOLVED",
            Self::UntypedUsageInconclusive => "UNTYPED_USAGE_INCONCLUSIVE",
            Self::ParameterValueNoEvidence => "PARAMETER_VALUE_NO_EVIDENCE",
            Self::ClientTraversalIncomplete => "CLIENT_TRAVERSAL_INCOMPLETE",
            Self::NoLinkedEndpoint => "NO_LINKED_ENDPOINT",
            Self::RoutePlaceholderUnresolved => "ROUTE_PLACEHOLDER_UNRESOLVED",
            Self::RoutePrefixAssumed => "ROUTE_PREFIX_ASSUMED",
            Self::RouteConstraintUnverified => "ROUTE_CONSTRAINT_UNVERIFIED",
            Self::ServiceTargetMismatch => "SERVICE_TARGET_MISMATCH",
            Self::ApiVersionMismatch => "API_VERSION_MISMATCH",
            Self::ServiceMappingRequired => "SERVICE_MAPPING_REQUIRED",
            Self::UndeclaredAbsoluteUrl => "UNDECLARED_ABSOLUTE_URL",
            Self::EmptyObjectDeclaration => "EMPTY_OBJECT_DECLARATION",
            Self::ArtifactIncomplete => "ARTIFACT_INCOMPLETE",
            Self::StaticFrameworkUnparsed => "STATIC_FRAMEWORK_UNPARSED",
            Self::WireContractUnresolved => "WIRE_CONTRACT_UNRESOLVED",
            Self::Unclassified => "UNCLASSIFIED",
        }
    }

    /// Name the cause from an evidence string produced by an extractor or the
    /// inclusion pass. Order matters: a more specific cause wins over the
    /// generic wire-shape wording that may accompany it.
    pub fn classify(message: &str) -> Option<Self> {
        let lower = message.to_ascii_lowercase();
        if lower.contains("unsupported_construct") {
            Some(Self::UnsupportedConstruct)
        } else if lower.contains("imported from `") {
            Some(Self::UnresolvedDependencyImport)
        } else if lower.contains("generic type")
            || lower.contains("type argument")
            || lower.contains("generic declaration")
        {
            Some(Self::MissingGenericArgumentBinding)
        } else if lower.contains("polymorphic type")
            || lower.contains("subtypes are not enumerable")
        {
            Some(Self::PolymorphicSubtypesUnresolved)
        } else if lower.contains("runtime serialization decides the wire shape") {
            Some(Self::RuntimeSerializationDecidesShape)
        } else if lower.contains("whichever implementation the producer returns at runtime") {
            Some(Self::DynamicControllerDelegation)
        } else if lower.contains("unresolved java type") || lower.contains("non-scalar type") {
            Some(Self::JavaTypeUnresolved)
        } else if lower.contains("response type could not be resolved") {
            Some(Self::ResponseTypeUnresolved)
        } else if lower.contains("returns a non-json body") {
            Some(Self::ResponseTypeNonJson)
        } else if lower.contains("request body expression") {
            Some(Self::RequestBodyExpressionUnresolved)
        } else if lower.contains("could not be resolved in local type pool")
            || lower.contains("unresolvable type expression")
            || lower.contains("union arm")
            || lower.contains("intersection includes a type")
            || lower.contains("type expansion exceeded")
            || lower.contains("is not expanded")
            || lower.contains("expansion depth budget")
            || lower.contains("is recursive")
        {
            Some(Self::TsTypeReferenceUnresolved)
        } else if lower.contains("untyped response usage")
            || lower.contains("untyped client observation")
            || lower.contains("requires type annotation or reconciliation")
            || lower.contains("response return from untyped client call")
            || lower.contains("cannot be followed to a property read")
            || lower.contains("bodyless response with unknown consumer expectation")
        {
            Some(Self::UntypedUsageInconclusive)
        } else if lower.contains("requires unqualified consumer evidence") {
            Some(Self::ParameterValueNoEvidence)
        } else if lower.contains("traversal incomplete") {
            Some(Self::ClientTraversalIncomplete)
        } else if lower.contains("has no resolved candidate backend endpoint")
            || lower.contains("has no linked candidate backend endpoint")
            || lower.contains("has no linked backend endpoint")
        {
            Some(Self::NoLinkedEndpoint)
        } else if lower.contains("unresolved interpolation")
            || lower.contains("unresolved placeholder")
        {
            Some(Self::RoutePlaceholderUnresolved)
        } else if lower.contains("route begins with") || lower.contains("treated as an authority") {
            Some(Self::RoutePrefixAssumed)
        } else if lower.contains("route constraint or wildcard is unverified") {
            Some(Self::RouteConstraintUnverified)
        } else if lower.contains("target api version mismatch") {
            Some(Self::ApiVersionMismatch)
        } else if lower.contains("target service mismatch") {
            Some(Self::ServiceTargetMismatch)
        } else if lower.contains("relative route requires targetserviceid") {
            Some(Self::ServiceMappingRequired)
        } else if lower.contains("undeclared absolute") {
            Some(Self::UndeclaredAbsoluteUrl)
        } else if lower.contains("empty or unshaped object") {
            Some(Self::EmptyObjectDeclaration)
        } else if lower.contains("artifact head is incomplete") || lower.contains("is incomplete.")
        {
            Some(Self::ArtifactIncomplete)
        } else if lower.contains("reads spring mvc annotations only")
            || lower.contains("java_mapping_framework_unparsed")
            || lower.contains("grpc")
            || lower.contains("jax-rs")
            || lower.contains("feign")
        {
            Some(Self::StaticFrameworkUnparsed)
        } else if lower.contains("wire contract is unresolved") {
            Some(Self::WireContractUnresolved)
        } else {
            None
        }
    }
}

/// Where the unresolved item was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonSource {
    Producer,
    Consumer,
    Artifact,
    Comparison,
}

/// The route an unresolved item is about. For a consumer with no linked
/// endpoint this is the route the consumer called.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonEndpointRef {
    pub method: String,
    pub path: String,
}

/// One structured unresolved item: why one piece of evidence is missing, plus
/// the context that makes it actionable. The human-readable `detail` is the
/// same text carried in `unresolvedEvidence`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCodeRecord {
    pub code: ReasonCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<AbstentionCode>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ReasonSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<ReasonEndpointRef>,
}

impl ReasonCodeRecord {
    pub fn new(code: ReasonCode, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        ReasonCodeRecord {
            code,
            family: AbstentionCode::classify(&detail),
            detail,
            source: None,
            file: None,
            line: None,
            endpoint: None,
        }
    }

    pub fn with_source(mut self, source: ReasonSource) -> Self {
        self.source = Some(source);
        self
    }

    pub fn with_location(mut self, file: impl Into<String>, line: Option<u32>) -> Self {
        self.file = Some(file.into());
        self.line = line;
        self
    }

    pub fn with_endpoint(mut self, method: impl Into<String>, path: impl Into<String>) -> Self {
        self.endpoint = Some(ReasonEndpointRef {
            method: method.into(),
            path: path.into(),
        });
        self
    }
}

// ---------------------------------------------------------------------------
// Completeness accounting
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessAccounting {
    pub endpoint_resolved: bool,
    pub java_wire_resolved: bool,
    pub ts_contract_resolved: bool,
    pub request_resolved: bool,
    pub response_resolved: bool,
    pub consumer_traversal_complete: bool,
    pub unresolved_evidence: Vec<String>,
}

// ---------------------------------------------------------------------------
// Analysis counts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisCounts {
    pub changed_endpoints: usize,
    pub linked_endpoints: usize,
    pub affected_consumers: usize,
    pub unresolved_links: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abstentions_by_code: Option<std::collections::BTreeMap<String, usize>>,
}

// ---------------------------------------------------------------------------
// Analysis scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisScope {
    pub framework: String,
    pub codec: String,
    pub client: String,
    pub complete: bool,
}

// ---------------------------------------------------------------------------
// Artifact reference
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub repository_id: String,
    pub service_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    pub snapshot: String,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRef {
    pub artifact_sha256: String,
    pub service_id: String,
    pub total_observations: u64,
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/// Spec §4: the former "Mathematical Proof" label, replaced by a modest scope
/// statement. LIKELY_PRESERVED certifies solely that all analyzed TypeScript
/// consumer call sites are structural subtypes of the candidate backend wire
/// models according to the supported type lattice. It does not assert runtime
/// network availability, database transaction state, or unanalyzed dynamic
/// reflection.
pub const VERDICT_SCOPE_STATIC_COMPAT: &str = "Static Compatibility Supported";

/// The assessed property names the producer language, so a NestJS provider must
/// not be reported as a Java one. Spring keeps the V1 label verbatim: every
/// sealed Spring report, the packaging smoke tests, and the TS parity harness
/// carry it, and changing it would relabel measured evidence.
pub const ASSESSED_PROPERTY_JAVA_PRODUCER: &str = "JAVA_JSON_TS_RESPONSE_COMPATIBILITY";
pub const ASSESSED_PROPERTY_TS_PRODUCER: &str = "TS_JSON_TS_RESPONSE_COMPATIBILITY";

pub fn assessed_property_for_framework(framework: &str) -> &'static str {
    match framework {
        crate::envelope::FRAMEWORK_NESTJS => ASSESSED_PROPERTY_TS_PRODUCER,
        _ => ASSESSED_PROPERTY_JAVA_PRODUCER,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossLanguageImpactReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<FindingDelta>,
    pub schema_version: String,
    pub assurance: String,
    pub verdict: CrossLanguageVerdict,
    pub property: String,
    /// Formal verdict scope label (spec §4 "Formal Verdict Scope & Modesty").
    /// States exactly what a verdict asserts — AST model compatibility of
    /// analyzed TypeScript call sites against the supported type lattice — and
    /// replaces the former "Mathematical Proof" wording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_scope: Option<String>,
    pub repository: SnapshotIdentity,
    pub scope: AnalysisScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completeness: Option<CompletenessAccounting>,
    /// Structured root causes for the unresolved evidence above: one record per
    /// item, each naming the specific code, source, file and endpoint when known.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reason_codes: Vec<ReasonCodeRecord>,
    pub findings: Vec<CrossLanguageFinding>,
    pub blockers: Vec<AnalysisBlocker>,
    /// Evidence-admission advisories (spec §2); empty for pure comparison runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advisories: Vec<crate::advisory::EvidenceAdvisory>,
    pub counts: AnalysisCounts,
    pub artifacts: Option<ArtifactRefs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<TelemetryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRefs {
    pub base: ArtifactRef,
    pub candidate: ArtifactRef,
    pub targets: Vec<ArtifactRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingDelta {
    pub new_findings: Vec<CrossLanguageFinding>,
    pub existing_findings: Vec<CrossLanguageFinding>,
    pub resolved_findings: Vec<CrossLanguageFinding>,
}

// ---------------------------------------------------------------------------
// Baseline ratchet (spec §6.1)
// ---------------------------------------------------------------------------

/// Result of the differential baseline ratchet.
#[derive(Debug, Clone, PartialEq)]
pub struct RatchetSplit {
    /// Findings absent from the baseline: NEW_VIOLATIONS.
    pub new_violations: Vec<CrossLanguageFinding>,
    /// Findings whose identity exists in the baseline: FROZEN_LEGACY_DEBT.
    pub frozen_legacy_debt: Vec<CrossLanguageFinding>,
    /// Baseline findings absent from the candidate: RESOLVED.
    pub resolved: Vec<CrossLanguageFinding>,
}

/// Differential ratchet over canonical finding identities (spec §6.1).
///
/// Matching prefers the line-drift-independent v2 identity; findings without
/// one fall back to the legacy v1 id. Every returned finding is stamped with
/// its classification, so downstream gates can gate on NEW_VIOLATIONS alone
/// and never silently absorb new violations into legacy debt.
pub fn apply_finding_ratchet(
    mut candidate: Vec<CrossLanguageFinding>,
    mut baseline: Vec<CrossLanguageFinding>,
) -> RatchetSplit {
    for finding in candidate.iter_mut().chain(baseline.iter_mut()) {
        if finding.id_v2.is_none() {
            populate_finding_id_v2(finding);
        }
    }

    let baseline_v1: std::collections::HashSet<String> =
        baseline.iter().map(|f| f.id.clone()).collect();
    let baseline_v2: std::collections::HashSet<String> =
        baseline.iter().filter_map(|f| f.id_v2.clone()).collect();
    let candidate_v1: std::collections::HashSet<String> =
        candidate.iter().map(|f| f.id.clone()).collect();
    let candidate_v2: std::collections::HashSet<String> =
        candidate.iter().filter_map(|f| f.id_v2.clone()).collect();

    let mut new_violations = Vec::new();
    let mut frozen_legacy_debt = Vec::new();
    for mut finding in candidate {
        let known_in_baseline = baseline_v1.contains(&finding.id)
            && match finding.id_v2.as_deref() {
                Some(v2) => baseline_v2.contains(v2),
                None => true,
            };
        finding.classification = Some(if known_in_baseline {
            FindingClassification::FrozenLegacyDebt
        } else {
            FindingClassification::NewViolations
        });
        if known_in_baseline {
            frozen_legacy_debt.push(finding);
        } else {
            new_violations.push(finding);
        }
    }

    let mut resolved = Vec::new();
    for mut finding in baseline {
        let absent_from_candidate = !candidate_v1.contains(&finding.id)
            && match finding.id_v2.as_deref() {
                Some(v2) => !candidate_v2.contains(v2),
                None => true,
            };
        if absent_from_candidate {
            finding.classification = Some(FindingClassification::Resolved);
            resolved.push(finding);
        }
    }

    RatchetSplit {
        new_violations,
        frozen_legacy_debt,
        resolved,
    }
}

// ---------------------------------------------------------------------------
// Factory functions (mirrors CrossLanguageContracts.ts)
// ---------------------------------------------------------------------------

pub fn make_inconclusive_report(
    repository: SnapshotIdentity,
    blockers: Vec<AnalysisBlocker>,
) -> CrossLanguageImpactReport {
    CrossLanguageImpactReport {
        delta: None,
        schema_version: SCHEMA_VERSION.to_string(),
        assurance: ASSURANCE.to_string(),
        verdict: CrossLanguageVerdict::Inconclusive,
        property: "JAVA_JSON_TS_RESPONSE_COMPATIBILITY".to_string(),
        verdict_scope: Some(VERDICT_SCOPE_STATIC_COMPAT.to_string()),
        repository,
        scope: AnalysisScope {
            framework: "SPRING_MVC".to_string(),
            codec: "JACKSON_DEFAULT_V1".to_string(),
            client: "STATIC_FETCH_V1".to_string(),
            complete: false,
        },
        completeness: None,
        reason_codes: vec![],
        findings: vec![],
        blockers,
        advisories: vec![],
        counts: AnalysisCounts {
            changed_endpoints: 0,
            linked_endpoints: 0,
            affected_consumers: 0,
            unresolved_links: 0,
            abstentions_by_code: None,
        },
        artifacts: None,
        telemetry: None,
    }
}

pub fn make_error_report(
    repository: SnapshotIdentity,
    code: BlockerCode,
    message: String,
) -> CrossLanguageImpactReport {
    CrossLanguageImpactReport {
        delta: None,
        schema_version: SCHEMA_VERSION.to_string(),
        assurance: ASSURANCE.to_string(),
        verdict: CrossLanguageVerdict::AnalysisError,
        property: "JAVA_JSON_TS_RESPONSE_COMPATIBILITY".to_string(),
        verdict_scope: Some(VERDICT_SCOPE_STATIC_COMPAT.to_string()),
        repository,
        scope: AnalysisScope {
            framework: "SPRING_MVC".to_string(),
            codec: "JACKSON_DEFAULT_V1".to_string(),
            client: "STATIC_FETCH_V1".to_string(),
            complete: false,
        },
        completeness: None,
        reason_codes: vec![],
        findings: vec![],
        blockers: vec![AnalysisBlocker {
            code,
            message,
            file: None,
        }],
        advisories: vec![],
        counts: AnalysisCounts {
            changed_endpoints: 0,
            linked_endpoints: 0,
            affected_consumers: 0,
            unresolved_links: 0,
            abstentions_by_code: None,
        },
        artifacts: None,
        telemetry: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ratchet_finding(
        method: &str,
        path: &str,
        wire_path: &str,
        before: &str,
        after: &str,
        ts_file: &str,
        line: u32,
    ) -> CrossLanguageFinding {
        CrossLanguageFinding {
            id: build_finding_id(method, path, "com/example/C.java", wire_path),
            id_v2: None,
            classification: None,
            endpoint: EndpointLocation {
                method: method.to_string(),
                path: path.to_string(),
                java_file: "com/example/C.java".to_string(),
                line,
            },
            wire_path: wire_path.to_string(),
            change: ChangeRecord {
                before: before.to_string(),
                after: after.to_string(),
            },
            typescript_client: TypeScriptClientRef {
                file: ts_file.to_string(),
                line,
                expectation: format!("{method} {path}"),
                expectation_kind: TsExpectationKind::TypeAssertion,
            },
            consumers: vec![],
            evidence: vec![],
            repair_hint: "hint".to_string(),
        }
    }

    #[test]
    fn finding_id_v2_matches_independent_jcs_digest() {
        let input = FindingDigestInput {
            version: FINDING_ID_SCHEMA_V1.to_string(),
            method: "GET".to_string(),
            normalized_route: "/api/users/{id}".to_string(),
            wire_path: "user.id".to_string(),
            change_kind: "TYPE_CHANGED".to_string(),
            consumer_file: "src/client.ts".to_string(),
        };
        let id = build_finding_id_v2(&input);

        // Independent construction: canonicalize the same data assembled as a
        // raw JSON value with deliberately scrambled key order. JCS sorts keys,
        // so this must reproduce the exact same digest.
        let value = serde_json::json!({
            "consumerFile": "src/client.ts",
            "changeKind": "TYPE_CHANGED",
            "method": "GET",
            "normalizedRoute": "/api/users/{id}",
            "version": "SAJIMORA_FINDING_V1",
            "wirePath": "user.id"
        });
        let expected = hex::encode(Sha256::digest(canonical_json(&value).as_bytes()));

        assert_eq!(id, expected);
        assert_eq!(id.len(), 64);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));

        // Determinism: identical inputs produce identical ids.
        assert_eq!(build_finding_id_v2(&input), id);
    }

    #[test]
    fn finding_id_v2_is_line_number_independent() {
        let mut a = ratchet_finding(
            "GET",
            "/api/items",
            "item.id",
            "string",
            "number",
            "src/a.ts",
            10,
        );
        let mut b = ratchet_finding(
            "GET",
            "/api/items",
            "item.id",
            "string",
            "number",
            "src/a.ts",
            999,
        );
        populate_finding_id_v2(&mut a);
        populate_finding_id_v2(&mut b);
        assert_eq!(a.id_v2, b.id_v2);
        assert!(a.id_v2.is_some());
    }

    #[test]
    fn infer_change_kind_mapping_is_frozen() {
        assert_eq!(infer_change_kind("", "number"), "FIELD_ADDED");
        assert_eq!(infer_change_kind("string", ""), "FIELD_REMOVED");
        assert_eq!(infer_change_kind("string", "number"), "TYPE_CHANGED");
    }

    #[test]
    fn ratchet_classifies_new_frozen_and_resolved() {
        let baseline = vec![ratchet_finding(
            "GET", "/api/a", "a.x", "string", "number", "src/a.ts", 10,
        )];
        let candidate = vec![
            ratchet_finding("GET", "/api/a", "a.x", "string", "number", "src/a.ts", 10),
            ratchet_finding("POST", "/api/b", "b.y", "", "boolean", "src/b.ts", 20),
        ];

        let split = apply_finding_ratchet(candidate, baseline);

        assert_eq!(split.new_violations.len(), 1);
        assert_eq!(split.frozen_legacy_debt.len(), 1);
        assert_eq!(split.resolved.len(), 0);

        assert_eq!(
            split.new_violations[0].classification,
            Some(FindingClassification::NewViolations)
        );
        assert_eq!(
            split.frozen_legacy_debt[0].classification,
            Some(FindingClassification::FrozenLegacyDebt)
        );
    }

    #[test]
    fn ratchet_line_drift_still_counts_as_legacy_debt() {
        // Same stable identity, different line numbers: both the v1 id (which
        // never included lines) and the v2 canonical id match, so the finding
        // stays frozen debt instead of being re-reported as new.
        let baseline = vec![ratchet_finding(
            "GET", "/api/a", "a.x", "string", "number", "src/a.ts", 10,
        )];
        let candidate = vec![ratchet_finding(
            "GET", "/api/a", "a.x", "string", "number", "src/a.ts", 4242,
        )];

        assert_eq!(baseline[0].id, candidate[0].id);

        let split = apply_finding_ratchet(candidate, baseline);

        assert_eq!(split.frozen_legacy_debt.len(), 1);
        assert_eq!(split.new_violations.len(), 0);
        assert_eq!(split.resolved.len(), 0);
        assert_eq!(
            split.frozen_legacy_debt[0].classification,
            Some(FindingClassification::FrozenLegacyDebt)
        );
    }

    #[test]
    fn v2_identity_separates_changes_v1_conflates() {
        // Same method/path/wire path, but a different change kind (removal vs
        // type change): the v1 delimiter-joined id is identical for both, while
        // the v2 canonical id distinguishes them.
        let removal = ratchet_finding("GET", "/api/a", "a.x", "string", "", "src/a.ts", 10);
        let type_change =
            ratchet_finding("GET", "/api/a", "a.x", "string", "number", "src/a.ts", 10);

        assert_eq!(removal.id, type_change.id);
        let mut removal = removal;
        populate_finding_id_v2(&mut removal);
        let mut type_change = type_change;
        populate_finding_id_v2(&mut type_change);
        assert_ne!(removal.id_v2, type_change.id_v2);
    }

    #[test]
    fn factory_reports_carry_verdict_scope_label() {
        let repository = SnapshotIdentity {
            repository_id: "repo".to_string(),
            parent_commit: "HEAD~1".to_string(),
            candidate_snapshot: "HEAD".to_string(),
        };
        let inconclusive = make_inconclusive_report(repository.clone(), vec![]);
        assert_eq!(
            inconclusive.verdict_scope.as_deref(),
            Some(VERDICT_SCOPE_STATIC_COMPAT)
        );

        let blocker = make_error_report(repository, BlockerCode::ToolFailure, "boom".to_string());
        assert_eq!(
            blocker.verdict_scope.as_deref(),
            Some(VERDICT_SCOPE_STATIC_COMPAT)
        );
    }

    #[test]
    fn ratchet_reports_resolved_baseline_findings() {
        let baseline = vec![ratchet_finding(
            "GET", "/api/a", "a.x", "string", "number", "src/a.ts", 10,
        )];
        let candidate = vec![];

        let split = apply_finding_ratchet(candidate, baseline);

        assert_eq!(split.resolved.len(), 1);
        assert_eq!(split.new_violations.len(), 0);
        assert_eq!(split.frozen_legacy_debt.len(), 0);
        assert_eq!(
            split.resolved[0].classification,
            Some(FindingClassification::Resolved)
        );
    }

    #[test]
    fn test_abstention_code_classification_covers_all_twelve_classes() {
        let cases = [
            (
                "src/a.ts:12 $: wire contract is unresolved",
                AbstentionCode::WireShapeUnresolved,
            ),
            (
                "POST /api/test: path parameter id requires unqualified consumer evidence",
                AbstentionCode::ParamValueNoEvidence,
            ),
            (
                "src/agent.js:54: response is used, but its value cannot be followed to a property read",
                AbstentionCode::ClientUntypedUsageInconclusive,
            ),
            (
                "src/app/core.ts: consumer traversal incomplete or unqualified",
                AbstentionCode::ClientTraversalIncomplete,
            ),
            (
                "client expectation GET /api/users has no linked candidate backend endpoint (not found). Deletion is not established.",
                AbstentionCode::NoLinkedBackendEndpoint,
            ),
            (
                "Route begins with `IMAGES_URL_PREFIX`, which is not resolvable from source and is treated as an authority/base-URL prefix; matching uses the remaining path",
                AbstentionCode::RoutePrefixUnresolved,
            ),
            (
                "Response return from untyped client call requires type annotation or reconciliation",
                AbstentionCode::ShapeUntypedCall,
            ),
            (
                "Response resolves to an empty or unshaped object declaration",
                AbstentionCode::ShapeEmptyObjectDecl,
            ),
            (
                "src/routes.ts: route constraint or wildcard is unverified",
                AbstentionCode::RouteConstraintUnverified,
            ),
            (
                "candidate artifact HEAD is incomplete",
                AbstentionCode::ArtifactHeadIncomplete,
            ),
            (
                "1 HTTP client call(s) (GET at line 12) do not expose a statically resolvable endpoint; their routes are absent from this artifact",
                AbstentionCode::StaticRouteUnresolvedUrl,
            ),
            (
                "JAVA_MAPPING_FRAMEWORK_UNPARSED: gRPC/JAX-RS/Feign endpoints absent from this artifact",
                AbstentionCode::StaticFrameworkNotParsed,
            ),
        ];

        for (msg, expected) in cases {
            assert_eq!(
                AbstentionCode::classify(msg),
                Some(expected),
                "Failed to classify: {msg}"
            );
        }
    }

    #[test]
    fn reason_code_classification_names_specific_causes() {
        let cases = [
            (
                "Type `PaginatedResponse` imported from `./api-types` could not be resolved in local type pool",
                ReasonCode::UnresolvedDependencyImport,
            ),
            (
                "Generic type `ApiResponse` takes 1 type argument(s) but was used with 0",
                ReasonCode::MissingGenericArgumentBinding,
            ),
            (
                "Generic type `Envelope<...>` could not be resolved in local type pool",
                ReasonCode::MissingGenericArgumentBinding,
            ),
            (
                "com.acme.Shape is an interface; its JSON properties come from whichever implementation the producer returns at runtime",
                ReasonCode::DynamicControllerDelegation,
            ),
            (
                "com.acme.Event declares @JsonSerialize; runtime serialization decides the wire shape, so its static properties are inconclusive",
                ReasonCode::RuntimeSerializationDecidesShape,
            ),
            (
                "Unresolved Java type: TimeUnit",
                ReasonCode::JavaTypeUnresolved,
            ),
            (
                "Type `OrderDto` could not be resolved in local type pool",
                ReasonCode::TsTypeReferenceUnresolved,
            ),
            (
                "Response type could not be resolved from call context",
                ReasonCode::ResponseTypeUnresolved,
            ),
            (
                "responseType `blob` returns a non-JSON body; declared type `Report` describes a client-derived value, not the wire response",
                ReasonCode::ResponseTypeNonJson,
            ),
            (
                "Request body expression: { id, name }",
                ReasonCode::RequestBodyExpressionUnresolved,
            ),
            (
                "src/app.js:54: untyped response usage is Inconclusive; response body cannot be followed to property reads",
                ReasonCode::UntypedUsageInconclusive,
            ),
            (
                "Response return from untyped client call requires type annotation or reconciliation",
                ReasonCode::UntypedUsageInconclusive,
            ),
            (
                "Response body cannot be followed to a property read",
                ReasonCode::UntypedUsageInconclusive,
            ),
            (
                "POST /api/test: path parameter id requires unqualified consumer evidence",
                ReasonCode::ParameterValueNoEvidence,
            ),
            (
                "src/app/core.ts: consumer traversal incomplete or unqualified",
                ReasonCode::ClientTraversalIncomplete,
            ),
            (
                "client expectation GET /api/users has no linked candidate backend endpoint (not found). Deletion is not established.",
                ReasonCode::NoLinkedEndpoint,
            ),
            (
                "src/client.ts:14: client expectation GET /api/{id} is built from an unresolved interpolation; route cannot be matched",
                ReasonCode::RoutePlaceholderUnresolved,
            ),
            (
                "Route begins with `IMAGES_URL_PREFIX`, which is not resolvable from source and is treated as an authority/base-URL prefix; matching uses the remaining path",
                ReasonCode::RoutePrefixAssumed,
            ),
            (
                "src/routes.ts: route constraint or wildcard is unverified",
                ReasonCode::RouteConstraintUnverified,
            ),
            (
                "src/client.ts: target API version mismatch",
                ReasonCode::ApiVersionMismatch,
            ),
            (
                "src/client.ts: target service mismatch",
                ReasonCode::ServiceTargetMismatch,
            ),
            (
                "src/client.ts: relative route requires targetServiceId",
                ReasonCode::ServiceMappingRequired,
            ),
            (
                "src/client.ts: undeclared absolute service URL",
                ReasonCode::UndeclaredAbsoluteUrl,
            ),
            (
                "Response resolves to an empty or unshaped object declaration",
                ReasonCode::EmptyObjectDeclaration,
            ),
            (
                "candidate artifact HEAD is incomplete",
                ReasonCode::ArtifactIncomplete,
            ),
            (
                "JAVA_MAPPING_FRAMEWORK_UNPARSED: gRPC/JAX-RS/Feign endpoints absent from this artifact",
                ReasonCode::StaticFrameworkUnparsed,
            ),
            (
                "src/a.ts:12 $: wire contract is unresolved",
                ReasonCode::WireContractUnresolved,
            ),
        ];

        for (msg, expected) in cases {
            assert_eq!(
                ReasonCode::classify(msg),
                Some(expected),
                "Failed to classify: {msg}"
            );
        }
        assert_eq!(ReasonCode::classify("unmatched prose"), None);
    }

    #[test]
    fn reason_code_record_carries_family_and_context() {
        let record = ReasonCodeRecord::new(
            ReasonCode::UnresolvedDependencyImport,
            "src/api/orders.ts:12 $: wire contract is unresolved (consumer: Type `OrderDto` imported from `./orders` could not be resolved in local type pool)",
        )
        .with_source(ReasonSource::Consumer)
        .with_location("src/api/orders.ts", Some(12))
        .with_endpoint("GET", "/api/orders");

        assert_eq!(record.family, Some(AbstentionCode::WireShapeUnresolved));
        assert_eq!(record.source, Some(ReasonSource::Consumer));
        assert_eq!(record.line, Some(12));
        assert_eq!(
            record.endpoint.as_ref().map(|e| e.path.as_str()),
            Some("/api/orders")
        );
        assert_eq!(
            serde_json::to_value(&record).unwrap()["code"],
            serde_json::json!("UNRESOLVED_DEPENDENCY_IMPORT")
        );
        assert_eq!(
            serde_json::to_value(&record).unwrap()["family"],
            serde_json::json!("WIRE_SHAPE_UNRESOLVED")
        );
    }

    #[test]
    fn assessed_property_names_the_producer_lane() {
        assert_eq!(
            assessed_property_for_framework(crate::envelope::FRAMEWORK_SPRING_MVC),
            ASSESSED_PROPERTY_JAVA_PRODUCER
        );
        assert_eq!(
            assessed_property_for_framework(crate::envelope::FRAMEWORK_NESTJS),
            ASSESSED_PROPERTY_TS_PRODUCER
        );
        // An absent profile keeps the V1 label instead of inventing a lane.
        assert_eq!(
            assessed_property_for_framework(""),
            ASSESSED_PROPERTY_JAVA_PRODUCER
        );
    }
}
