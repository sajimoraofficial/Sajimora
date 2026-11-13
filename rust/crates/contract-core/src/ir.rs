//! ir.rs � Canonical Contract IR
//!
//! Language-independent canonical contract intermediate representation.
//! Mirrors CanonicalContractIR.ts exactly.
//! Both Java Spring endpoints and TypeScript HTTP clients normalize into this IR
//! before comparison.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Source Provenance
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProvenance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub language: SourceLanguage,
    /// Repository-relative POSIX file path.
    pub file: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    /// AST node identity or symbol name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ast_identity: Option<String>,
    /// Originating annotation or schema.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_or_schema: Option<String>,
    /// Evidence classification tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_classification: Option<EvidenceClassification>,
}

// ---------------------------------------------------------------------------
// Evidence Classification & OpenAPI Metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceClassification {
    #[serde(rename = "IMPLEMENTATION_DERIVED")]
    ImplementationDerived,
    #[serde(rename = "EMPIRICAL_TELEMETRY")]
    EmpiricalTelemetry,
    #[serde(rename = "DECLARED_SPECIFICATION")]
    DeclaredSpecification,
    #[serde(rename = "INCONCLUSIVE_OR_CONFLICTING")]
    InconclusiveOrConflicting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StatusCodeFamily {
    #[serde(rename = "SUCCESS_2XX")]
    Success2xx,
    #[serde(rename = "ERROR_4XX_5XX")]
    Error4xx5xx,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredResponseEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_type: Option<WireType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceLanguage {
    #[serde(rename = "JAVA")]
    Java,
    #[serde(rename = "TYPESCRIPT")]
    TypeScript,
    #[serde(rename = "PYTHON")]
    Python,
    #[serde(rename = "GO")]
    Go,
    #[serde(rename = "RUST")]
    Rust,
}

// ---------------------------------------------------------------------------
// Validation Constraints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationConstraint {
    pub kind: ValidationConstraintKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValidationConstraintKind {
    #[serde(rename = "NOT_NULL")]
    NotNull,
    #[serde(rename = "NOT_BLANK")]
    NotBlank,
    #[serde(rename = "NOT_EMPTY")]
    NotEmpty,
    #[serde(rename = "SIZE")]
    Size,
    #[serde(rename = "MIN")]
    Min,
    #[serde(rename = "MAX")]
    Max,
    #[serde(rename = "POSITIVE")]
    Positive,
    #[serde(rename = "PATTERN")]
    Pattern,
    #[serde(rename = "EMAIL")]
    Email,
}

// ---------------------------------------------------------------------------
// Canonical WireType
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WireType {
    #[serde(rename = "PRIMITIVE")]
    Primitive(PrimitiveWireType),
    #[serde(rename = "OBJECT")]
    Object(ObjectWireType),
    #[serde(rename = "ARRAY")]
    Array(ArrayWireType),
    #[serde(rename = "UNION")]
    Union(UnionWireType),
    #[serde(rename = "ENUM")]
    Enum(EnumWireType),
    #[serde(rename = "NULLABLE")]
    Nullable(NullableWireType),
    #[serde(rename = "OPTIONAL")]
    Optional(OptionalWireType),
    #[serde(rename = "MAP")]
    Map(MapWireType),
    #[serde(rename = "LITERAL")]
    Literal(LiteralWireType),
    #[serde(rename = "UNKNOWN")]
    Unknown(UnknownWireType),
    #[serde(rename = "REF")]
    Ref(RefWireType),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrimitiveScalar {
    #[serde(rename = "string")]
    String,
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "boolean")]
    Boolean,
    #[serde(rename = "bigint")]
    BigInt,
    #[serde(rename = "void")]
    Void,
    #[serde(rename = "any")]
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrimitiveFormat {
    /// ISO-8601 with an offset (`2024-01-01T00:00:00Z`), as `Instant`, `OffsetDateTime` and
    /// `ZonedDateTime` require.
    #[serde(rename = "DATE_TIME")]
    DateTime,
    /// ISO-8601 without an offset (`2024-01-01T00:00:00`), as `LocalDateTime` requires.
    #[serde(rename = "LOCAL_DATE_TIME")]
    LocalDateTime,
    #[serde(rename = "DATE")]
    Date,
    #[serde(rename = "TIME")]
    Time,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveWireType {
    pub scalar: PrimitiveScalar,
    /// A JSON string whose textual grammar is fixed by the producer's type. Request synthesis
    /// must emit a value Jackson's parser accepts; an arbitrary string is rejected when the
    /// field is a `java.time` value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<PrimitiveFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

/// Format is a representation detail, not a wire-type distinction: both sides are JSON strings,
/// so compatibility must not turn `Instant` vs `LocalDateTime` into a change.
impl PartialEq for PrimitiveWireType {
    fn eq(&self, other: &Self) -> bool {
        self.scalar == other.scalar
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePropertyContract {
    pub wire_name: String,
    pub r#type: WireType,
    pub optional: bool,
    pub nullable: bool,
    /// The provider assigns this value (`@GeneratedValue`). It must be omitted from a create
    /// request but stays in update bodies, where servers validate it against the path id.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub server_assigned: bool,
    pub validation_constraints: Vec<ValidationConstraint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectWireType {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub properties: Vec<WirePropertyContract>,
    /// Whether the object forbids extra properties. Default false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrayWireType {
    pub element_type: Box<WireType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_stream_or_flux: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnionWireType {
    pub types: Vec<WireType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumWireType {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub values: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NullableWireType {
    pub inner_type: Box<WireType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionalWireType {
    pub inner_type: Box<WireType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapWireType {
    pub key_type: Box<WireType>,
    pub value_type: Box<WireType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteralWireType {
    pub value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownWireType {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefWireType {
    #[serde(rename = "ref")]
    pub r#ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

// ---------------------------------------------------------------------------
// Observed client evidence
//
// Untyped JavaScript has no declared wire shape. These records state what the
// source *uses*; they are not a contract the producer must satisfy. Keeping them
// out of `WireType` prevents a usage observation from being counted as a proven
// shape or asserted against a single snapshot.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObservedKind {
    Object,
    Array,
    String,
    Number,
    Boolean,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedAccess {
    /// Path relative to the response body, e.g. `content[].status`.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ObservedKind>,
    /// False when every read happens behind `?.`, `??`, `||`, a logical guard or a
    /// conditional branch. A missing field cannot break a guarded read, so verification
    /// must not report one.
    #[serde(default = "default_true")]
    pub guaranteed: bool,
    /// Accesses that belong to one `a ?? b` / `a || b` chain are alternatives. At least
    /// one of them is used, not all of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternative_group: Option<u32>,
    pub provenance: SourceProvenance,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObservedResponseStatus {
    /// The client reads at least one field of the response body.
    Observed,
    /// The call site discards the response; no body shape is needed.
    NotConsumed,
    /// The URL targets an absolute host outside the producer service.
    ExternalOrigin,
    /// The call is only reachable through a helper that no scanned source calls.
    NoCallers,
    /// The response is used, but the value cannot be followed statically.
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedResponseEvidence {
    pub status: ObservedResponseStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accesses: Vec<ObservedAccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedRequestField {
    pub wire_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ObservedKind>,
    pub provenance: SourceProvenance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedRequestBody {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<ObservedRequestField>,
    /// A bare scalar body (for example `newStatus`) rather than an object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_kind: Option<ObservedKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub provenance: SourceProvenance,
}

// ---------------------------------------------------------------------------
// Route & Endpoint Contract
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSegmentContract {
    pub text: String,
    pub is_param: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex_constraint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_wildcard: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRouteContract {
    pub raw_path: String,
    pub segments: Vec<RouteSegmentContract>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractDirection {
    #[serde(rename = "REQUEST")]
    Request,
    #[serde(rename = "RESPONSE")]
    Response,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointIdentityContract {
    pub service: Option<String>,
    pub http_method: String,
    pub normalized_route: NormalizedRouteContract,
    pub direction: ContractDirection,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamContract {
    pub name: String,
    pub r#type: WireType,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_constraints: Option<Vec<ValidationConstraint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SourceProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointContract {
    pub identity: EndpointIdentityContract,
    pub path_parameters: Vec<ParamContract>,
    pub query_parameters: Vec<ParamContract>,
    pub headers: Vec<ParamContract>,
    pub body: Option<WireType>,
    pub provenance: SourceProvenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_classification: Option<EvidenceClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_responses: Option<Vec<DeclaredResponseEvidence>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code_family: Option<StatusCodeFamily>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping_conditions: Option<serde_json::Value>,
}
