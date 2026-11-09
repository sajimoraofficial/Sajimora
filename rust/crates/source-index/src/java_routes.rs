//! java_routes.rs — AST-based Spring MVC controller endpoint and DTO extraction.
//!
//! Parses Java sources via tree-sitter-java to extract:
//! - Spring @RestController / @RequestMapping / @GetMapping / @PostMapping endpoints
//! - Method path parameters (@PathVariable) and request bodies (@RequestBody)
//! - Return types and DTO field schemas (@JsonProperty, snake_case/camel_case naming strategies)
//! - Type interning into type_pool (SAJIMORA_CONTRACT_ARTIFACT_V2)

use anyhow::{anyhow, Result};
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload, ConsumerLocation,
    ContractArtifactEnvelope, DecoderKind, ExtractionProfile, FrontendClientContract,
    FrontendContractPayload, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::ir::{
    ContractDirection, DeclaredResponseEvidence, EndpointContract, EndpointIdentityContract,
    EvidenceClassification, LiteralWireType, ObjectWireType, ParamContract, PrimitiveScalar,
    PrimitiveWireType, RefWireType, SourceLanguage, SourceProvenance, StatusCodeFamily,
    UnionWireType, UnknownWireType, ValidationConstraint, ValidationConstraintKind,
    WirePropertyContract, WireType,
};
use contract_core::report::SCHEMA_VERSION;
use contract_core::routes::normalize_route_segments;
use rayon::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

// FQCNs whose Jackson wire shape is currently being modelled on this thread. The set cuts
// self-reference (`a subtype field naming its own polymorphic base`) and the length cap bounds
// a chain of distinct polymorphic types, so expansion always terminates.
/// Compile-time constants of every indexed type, keyed by FQCN. Annotation arguments name them
/// (`@Pattern(regexp = Constants.LOGIN_REGEX)`, `@Size(min = PASSWORD_MIN_LENGTH)`), and the
/// compiler inlines both kinds, so both are source evidence.
#[derive(Default, Clone)]
struct ConstantTable {
    strings: BTreeMap<String, BTreeMap<String, String>>,
    ints: BTreeMap<String, BTreeMap<String, i64>>,
    // Include types and nonliteral fields: an unresolved declaration still shadows imports.
    members: BTreeMap<String, BTreeSet<String>>,
    inherited_scopes: BTreeSet<String>,
}

/// Method signatures declared by every class in the extracted source set.
/// Cross-service payload inference used to read sibling `src/main/java` files
/// from disk, which made a blob-mode artifact depend on the checkout. The
/// table is built from the same in-memory sources the extractor parses, so
/// working-tree and revision modes resolve the same method or abstain.
#[derive(Default, Clone)]
struct ServiceMethodTable {
    /// Simple class name -> method name -> return type. `None` records an
    /// overload set whose returns disagree; such a call cannot be resolved.
    methods: HashMap<String, HashMap<String, Option<String>>>,
}

impl ServiceMethodTable {
    fn lookup(&self, service_type: &str, method_name: &str) -> Option<String> {
        let simple = service_type
            .split('<')
            .next()
            .unwrap_or(service_type)
            .trim()
            .rsplit('.')
            .next()
            .unwrap_or(service_type)
            .trim();
        self.methods
            .get(simple)?
            .get(method_name)?
            .clone()
            .filter(|return_type| return_type != "void" && return_type != "Void")
    }
}

thread_local! {
    static JACKSON_MODELLING: std::cell::RefCell<std::collections::HashSet<String>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

const JACKSON_MODELLING_DEPTH: usize = 12;

/// Outcomes of trying to enter the modelling rule for one type, kept as names because the
/// re-entrant case is deliberately *not* a failure: see `jackson_declared_wire`.
const JACKSON_ENTERED: u8 = 0;
const JACKSON_RE_ENTERED: u8 = 1;
const JACKSON_DEPTH_CUT: u8 = 2;

/// The pool entry for a polymorphic base's own union. Arms are interned per subtype under
/// `#subtype#`; the base needs a key of its own because a subtype may name the base again, and
/// that recursion has to point at a node rather than expand forever.
fn polymorphic_union_key(fqcn: &str) -> String {
    format!("java:{}#polymorphic", fqcn)
}

#[derive(Debug, Clone)]
pub struct JavaClassInfo {
    pub file_path: String,
    pub package_name: String,
    pub class_name: String,
    pub fqcn: String,
    pub is_controller: bool,
    pub is_controller_advice: bool,
    pub is_enum: bool,
    pub is_interface: bool,
    pub is_abstract: bool,
    pub is_jax_rs: bool,
    /// The class carries Quarkus reactive `@Route` methods.
    pub is_reactive_routes: bool,
    /// `@ApplicationPath` declared by a JAX-RS application class, applied to resources.
    pub jax_rs_application_path: Option<String>,
    pub is_client_interface: bool,
    pub client_target_service: Option<String>,
    /// A type declared inside another type. Nested types share their outer type's
    /// source file and are resolved by simple name only when no top-level type
    /// already claims that name.
    pub is_nested: bool,
    /// Declared type-parameter names in source order, e.g. `["T"]` for `PageResult<T>`.
    pub type_params: Vec<String>,
    pub enum_values: Vec<String>,
    /// `static final String NAME = "literal"` members declared by this type, for compile-time
    /// constant resolution across the repository.
    pub string_constants: BTreeMap<String, String>,
    pub superclass: Option<String>,
    pub implemented: Vec<String>,
    pub accessor_prefixes: Vec<String>,
    pub class_paths: Vec<String>,
    /// A class-level mapping declared a path expression this reader could not resolve.
    /// The class contributes no endpoints rather than pretending its paths are empty.
    pub class_path_unresolved: bool,
    /// Class-level `@RequestMapping(params = …)` selectors, which apply to every method.
    pub class_mapping_params: Vec<String>,
    /// False when the class-level mapping carries a condition this extractor cannot
    /// express (headers/consumes/produces, or a params value that is not literal).
    pub class_mapping_conditions_complete: bool,
    /// JSON names excluded by a class-level `@JsonIgnoreProperties` annotation.
    pub ignored_properties: Vec<String>,
    pub ignored_properties_allow_getters: Vec<String>,
    pub ignored_properties_allow_setters: Vec<String>,
    pub unsupported_deserialization: Option<String>,
    /// The first annotation that hands the wire shape to runtime serialization
    /// (polymorphism or a custom serializer). Such a class has no honest static
    /// object shape, so it is reported as inconclusive.
    pub unsupported_serialization: Option<String>,
    /// `@JsonTypeInfo(use = …, include = …, property = "…")` on this declaration, when present.
    pub json_type_info: Option<JavaJsonTypeInfo>,
    /// The `@JsonSubTypes` list, in declaration order. Empty when the annotation is absent.
    pub json_sub_types: Vec<JavaJsonSubType>,
    /// Simple name of the class in `@JsonSerialize(using = X.class)`.
    pub json_serialize_using: Option<String>,
    /// Source text of a `serialize(...)` method, captured only for classes that extend
    /// `JsonSerializer`, so a hand-written serializer's own writes can be read as wire shape.
    pub serializer_body: Option<String>,
    pub is_annotation: bool,
    pub composed_mapping: Option<ComposedMappingInfo>,
    /// Annotations on the type declaration that the framework does not recognize by
    /// name. A custom annotation can be composed from `@RestController`/`@RequestMapping`,
    /// so whether this type is a controller is only decidable after every declaration
    /// in the repository is indexed.
    pub custom_annotations: Vec<JavaCustomAnnotationUsage>,
    pub methods: Vec<JavaMethodInfo>,
    pub fields: Vec<JavaFieldInfo>,
}

#[derive(Debug, Clone, Default)]
pub struct ComposedMappingInfo {
    pub http_methods: Vec<String>,
    pub base_paths: Vec<String>,
    pub path_attributes: Vec<String>,
    pub meta_annotations: Vec<String>,
    /// `params` conditions declared on the mapping meta-annotation.
    pub params: Vec<String>,
    /// False when a meta-annotation carries headers/consumes/produces or a non-literal
    /// params value. Endpoints using this annotation must not claim complete conditions.
    pub conditions_complete: bool,
    /// The composed annotation type declares an attribute aliased to a mapping condition.
    /// A use site can supply it, and this extractor does not read that value.
    pub declares_condition_attribute: bool,
    /// A meta-annotation declared a path expression this reader could not resolve.
    pub path_unresolved: bool,
}

/// The `use`/`include`/`property` elements of a `@JsonTypeInfo` annotation, kept as the
/// literal tokens the source spells so the modelling rule can decide without guessing
/// Jackson's own defaults (only an explicit property name is ever published).
#[derive(Debug, Clone)]
pub struct JavaJsonTypeInfo {
    pub use_id: String,
    pub include: String,
    pub property: Option<String>,
}

/// One `@JsonSubTypes.Type(value = X.class, name = "T")` entry.
#[derive(Debug, Clone)]
pub struct JavaJsonSubType {
    pub type_name: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ComposedControllerInfo {
    base_paths: Vec<String>,
    advice: bool,
    class_mapping_params: Vec<String>,
    conditions_complete: bool,
    path_unresolved: bool,
}

/// An annotation the analyzer cannot resolve is only worth a blocker when its name
/// marks a controller or a mapping; blocking on every unknown annotation (JPA, Lombok,
/// validation, telemetry) would make a normal repository look inconclusive.
fn likely_controller_annotation_name(name: &str) -> bool {
    let simple = name.split('.').last().unwrap_or(name);
    simple.ends_with("Controller") || simple.ends_with("Advice") || simple.ends_with("Mapping")
}

#[derive(Debug, Clone)]
pub struct JavaCustomAnnotationUsage {
    pub name: String,
    pub paths: Vec<String>,
    /// The use-site path argument exists but could not be resolved.
    pub paths_unresolved: bool,
    pub line: u32,
}

#[derive(Debug, Clone, Default)]
struct AnnotationPaths {
    paths: Vec<String>,
    /// A `value`/`path` argument is written at the use site.
    present: bool,
    /// The argument is written but is not a resolvable literal/constant expression.
    unresolved: bool,
}

#[derive(Debug, Clone)]
pub struct JavaDeclaredResponse {
    pub status_code: Option<u16>,
    pub schema_name: Option<String>,
    pub media_type: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JavaMethodInfo {
    pub name: String,
    pub line: u32,
    pub http_methods: Vec<String>,
    pub paths: Vec<String>,
    /// The method carries a Quarkus reactive `@Route` annotation.
    pub is_reactive_route: bool,
    /// `params` selectors declared by the method's own mapping annotation.
    pub mapping_params: Vec<String>,
    /// False when the mapping declares headers/consumes/produces or a non-literal condition.
    pub mapping_conditions_complete: bool,
    /// A mapping annotation this extractor could not read (for example a `method`
    /// condition built from a constant). The endpoint is not published.
    pub unmodeled_mapping: Option<String>,
    /// The mapping's path argument exists but could not be resolved. The endpoint is
    /// not published instead of being anchored at `/`.
    pub path_unresolved: bool,
    /// Caller-supplied request surfaces the extractor does not model (Spring
    /// `@ModelAttribute`, multipart, cookies, matrix variables). Each entry names the
    /// parameter and the reason; the endpoint is still published, but the artifact is
    /// marked incomplete.
    pub unmodeled_parameters: Vec<String>,
    pub return_type: String,
    pub parameters: Vec<JavaParamInfo>,
    pub is_mapped: bool,
    pub is_exception_handler: bool,
    pub status_code: Option<u16>,
    pub declared_responses: Vec<JavaDeclaredResponse>,
    pub custom_annotations: Vec<JavaCustomAnnotationUsage>,
    /// Imperative HTTP client calls in the method body (RestTemplate, WebClient,
    /// RestClient). The receiver type is resolved later from the class fields.
    pub client_calls: Vec<JavaClientCall>,
    /// Declared local variable types in the body. A `RestClient` built in a method
    /// is not a class field, but it is still a client receiver.
    pub local_types: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JavaClientKind {
    Field,
    HttpRequestBuilder,
    OkHttpRequestBuilder,
    /// Apache HttpClient request objects (`new HttpGet(...)` + `client.execute(...)`).
    ApacheHttpMethod,
    /// JAX-RS / Jersey client chains (`target(...).path(...).request().get(...)`).
    JerseyWebTarget,
    /// Generated SDK wrappers (`apiClient.invokeAPI("/path", HttpMethod.GET, ...)`).
    /// The call is only a client when the receiver's class holds a known HTTP client.
    SdkWrapper,
}

#[derive(Debug, Clone)]
pub struct JavaClientCall {
    pub kind: JavaClientKind,
    pub receiver: String,
    pub http_method: String,
    pub url: Option<String>,
    pub response_type: Option<String>,
    pub request_body_type: Option<String>,
    pub line: u32,
    pub unresolved: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JavaPagingKind {
    Pageable,
    Sort,
}

impl JavaPagingKind {
    fn query_names(self) -> &'static [(&'static str, bool)] {
        match self {
            JavaPagingKind::Pageable => &[("page", false), ("size", false), ("sort", true)],
            JavaPagingKind::Sort => &[("sort", true)],
        }
    }
}

#[derive(Debug, Clone)]
pub struct JavaParamInfo {
    pub name: String,
    pub param_type: String,
    pub is_path_variable: bool,
    pub is_request_body: bool,
    pub is_request_param: bool,
    pub is_request_header: bool,
    /// Server-supplied request context (`Principal`, `BindingResult`, servlet types). It has
    /// no wire surface and must never be treated as a body or a query parameter.
    pub is_context: bool,
    /// Spring Data's resolved pagination argument. Its wire surface is the standard
    /// `page`/`size`/`sort` query keys.
    pub paging_kind: Option<JavaPagingKind>,
    /// A caller-supplied surface this reader does not model. The description is reported
    /// as a blocker instead of silently dropping the parameter.
    pub unmodeled: Option<String>,
    pub alias: Option<String>,
    pub required: bool,
    pub validation_constraints: Vec<ValidationConstraint>,
    pub unsupported_metadata: Option<String>,
    /// Jersey managed-client target from `@Uri("...")` on a `WebTarget` parameter.
    pub uri_template: Option<String>,
    pub provenance: SourceProvenance,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum JacksonAccess {
    #[default]
    Auto,
    ReadOnly,
    WriteOnly,
    ReadWrite,
}

#[derive(Debug, Clone)]
pub struct JavaFieldInfo {
    pub name: String,
    pub field_type: String,
    pub input_type: Option<String>,
    pub line: u32,
    pub json_property: Option<String>,
    pub explicit_property: bool,
    pub is_json_ignored: bool,
    /// The field declaration is usable as a reader/writer on its own. `@JsonIgnore` on the field
    /// removes it from both directions, but not from a sibling accessor.
    pub field_readable: bool,
    pub field_writable: bool,
    /// A getter/setter for this property exists, and whether that accessor carries `@JsonIgnore`.
    /// Jackson removes only the annotated accessor, which is how one property can be serialized
    /// but not deserialized without any `Access` mode at all.
    pub getter_present: bool,
    pub setter_present: bool,
    pub ignored_output: bool,
    pub ignored_input: bool,
    /// An explicit `@JsonProperty`/`@JsonGetter`/`@JsonSetter` on that side. A `@JsonIgnore` with
    /// no explicit counterpart is a *hard* ignore and removes the property in both directions;
    /// with one, the ignore applies only to its own accessor. Both branches were measured against
    /// a real `ObjectMapper`.
    pub explicit_reader: bool,
    pub explicit_writer: bool,
    /// Whether Jackson can see this property at all: a public field, an
    /// annotated member, a Lombok-generated accessor, or a matching getter.
    pub is_serialized: bool,
    pub is_deserialized: bool,
    pub has_backing_field: bool,
    pub jackson_access: JacksonAccess,
    pub explicit_access: bool,
    pub validation_constraints: Vec<ValidationConstraint>,
    pub input_validation_constraints: Vec<ValidationConstraint>,
    pub unsupported_metadata: Option<String>,
    pub unsupported_input_validation: Option<String>,
    /// `@JsonUnwrapped`: the nested object's properties are emitted at this level.
    pub is_unwrapped: bool,
    pub has_getter: bool,
    /// Source-resolved JPA `@GeneratedValue` metadata; `@Id` alone is not provider assignment.
    /// Whether an endpoint creates or updates is not established by this field annotation.
    pub is_server_assigned: bool,
    pub is_nullable: Option<bool>,
    pub json_aliases: Vec<String>,
    /// Repository-relative path of the compilation unit that declares this member. Inherited
    /// fields are resolved in the scope of the file that *writes* their type, exactly as javac
    /// binds it: a base class importing `java.time.ZoneId` does not make that name mean the JDK
    /// type in the subclass that inherits the field, and a subclass importing something else must
    /// not re-bind the base's declaration. Empty until `collect_class_fields` stamps it.
    pub declaring_file: String,
}

/// A Jackson property declared by a zero-argument accessor. Reading only field
/// annotations misses both `@JsonProperty("id_token") String getIdToken()` and
/// computed getters such as `getLeaf()`, which Jackson serializes.
struct JavaGetterProperty {
    property_name: String,
    wire_name: Option<String>,
    ignored: bool,
    unwrapped: bool,
    return_type: String,
    line: u32,
    aliases: Vec<String>,
    access: JacksonAccess,
    explicit_access: bool,
    explicit_property: bool,
    validation_constraints: Vec<ValidationConstraint>,
    unsupported_metadata: Option<String>,
    unsupported_input_validation: Option<String>,
    nullable: Option<bool>,
    file: String,
    is_setter: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamingStrategy {
    CamelCase,
    SnakeCase,
}

impl NamingStrategy {
    pub fn apply(&self, name: &str) -> String {
        match self {
            NamingStrategy::CamelCase => name.to_string(),
            NamingStrategy::SnakeCase => {
                let chars: Vec<char> = name.chars().collect();
                let len = chars.len();
                let mut out = String::with_capacity(len + 4);
                for i in 0..len {
                    let c = chars[i];
                    if c.is_uppercase() {
                        if i > 0 {
                            let prev = chars[i - 1];
                            let next = chars.get(i + 1).copied();
                            let prev_is_lower_or_digit =
                                prev.is_lowercase() || prev.is_ascii_digit();
                            let prev_is_upper = prev.is_uppercase();
                            let next_is_lower = next.map(|n| n.is_lowercase()).unwrap_or(false);
                            if prev_is_lower_or_digit || (prev_is_upper && next_is_lower) {
                                if !out.ends_with('_') && prev != '_' {
                                    out.push('_');
                                }
                            }
                        }
                        for lc in c.to_lowercase() {
                            out.push(lc);
                        }
                    } else {
                        out.push(c);
                    }
                }
                out
            }
        }
    }
}

pub struct JavaRouteExtractor {
    classes: HashMap<String, JavaClassInfo>,
    /// Top-level types by simple name, in registration order. More than one
    /// entry means the simple name is ambiguous and must not be bound by guess.
    classes_by_simple: HashMap<String, Vec<String>>,
    /// Explicit imports per file. A simple name must resolve through them before
    /// any global lookup, because two packages can declare the same class name.
    file_imports: HashMap<String, Vec<String>>,
    file_packages: HashMap<String, String>,
    /// Nested types by simple name. Kept separate from `classes_by_simple` so a
    /// nested declaration can never displace a top-level type. Repeated simple
    /// names are disambiguated by the declaring file and otherwise left
    /// unresolved: binding to an arbitrary same-named nested class would
    /// invent fields the server never emits.
    nested_by_simple: HashMap<String, Vec<String>>,
    /// Compile-time String constants of every indexed type, keyed by FQCN. Built before the
    /// member-parsing pass because an annotation may name a constant declared in another file.
    constant_table: ConstantTable,
    naming_strategy: NamingStrategy,
    config_fingerprint: String,
    repo_root: PathBuf,
    /// Revision-bound source text keyed by repository-relative POSIX path.
    /// `Some` means the extraction ran entirely from Git objects, so no
    /// working-tree bytes may be consulted during payload build.
    blobs: Option<HashMap<String, String>>,
    /// Per-file read/parse failures. A source that could not be fully analysed
    /// makes the artifact incomplete; without this the envelope would claim a
    /// total endpoint set while individual files silently contributed nothing.
    source_blockers: Vec<ArtifactBlocker>,
    /// Repository-relative POSIX prefix of the directory whose controllers are served by this
    /// service id. Types are indexed repository-wide so a DTO declared in a sibling Maven or
    /// Gradle module resolves, but a type-only module that happens to declare Spring controllers
    /// is not silently credited with endpoints: `None` disables the gate, which is what blob mode
    /// wants because the caller chose which blobs belong to the service.
    endpoint_root: Option<String>,
    pub context_path: Option<String>,
    pub enable_jax_rs: bool,
}

impl JavaRouteExtractor {
    pub fn with_jax_rs(mut self, enable: bool) -> Self {
        self.enable_jax_rs = enable;
        self
    }

    /// Record a JVM source family this extractor does not parse. An endpoint missing
    /// from the artifact is then not evidence of absence.
    pub fn note_unparsed_source(&mut self, family: &str, label: &str) {
        self.source_blockers.push(source_blocker(
            label,
            "JAVA_SOURCE_NOT_PARSED",
            format!(
                "{family} sources are present but {family} is not parsed by this extractor, so an endpoint missing from this artifact is not evidence that the service does not declare it"
            ),
        ));
    }

    pub fn note_unparsed_kotlin(&mut self, label: &str) {
        self.note_unparsed_source("Kotlin", label);
    }

    /// The caller's `--java-root`/`--ts-root` scopes both provider endpoints and client
    /// contracts. Type indexing stays repository-wide so a scoped module can resolve
    /// types from its siblings, but a client declared in a sibling module is not part
    /// of this artifact.
    fn class_in_scope(&self, file_path: &str) -> bool {
        match &self.endpoint_root {
            Some(root) if !root.is_empty() => {
                file_path == root
                    || file_path.starts_with(&format!("{}/", root.trim_end_matches('/')))
            }
            // A repository-root scan records an empty root; every file is in scope.
            _ => true,
        }
    }

    /// An `invokeAPI` wrapper is only HTTP evidence when its class actually holds a
    /// known client. This keeps a generated-SDK call site from being read as a
    /// client while a user class that happens to have the same method stays out.
    /// Generated API classes often inherit the `apiClient` field from a base class
    /// (`FakeApi extends BaseApi`), so a direct-field lookup misses their calls.
    fn field_type_in_hierarchy(
        &self,
        class: &JavaClassInfo,
        field_name: &str,
        depth: usize,
    ) -> Option<String> {
        if let Some(field) = class.fields.iter().find(|field| field.name == field_name) {
            return Some(field.field_type.clone());
        }
        if depth == 0 {
            return None;
        }
        let parent_name = class
            .superclass
            .as_deref()?
            .split('<')
            .next()?
            .trim()
            .rsplit('.')
            .next()?
            .trim();
        let parent = self
            .classes
            .values()
            .find(|c| c.class_name == parent_name && self.class_in_scope(&c.file_path))
            .or_else(|| self.classes.values().find(|c| c.class_name == parent_name))?;
        self.field_type_in_hierarchy(parent, field_name, depth - 1)
    }

    fn wrapper_uses_http_client(&self, field_type: &str) -> bool {
        let wrapper = field_type
            .split('<')
            .next()
            .unwrap_or(field_type)
            .trim()
            .rsplit('.')
            .next()
            .unwrap_or("")
            .trim();
        if wrapper.is_empty() {
            return false;
        }
        let class = self
            .classes
            .values()
            .find(|c| c.class_name == wrapper && self.class_in_scope(&c.file_path))
            .or_else(|| self.classes.values().find(|c| c.class_name == wrapper));
        let Some(class) = class else {
            return false;
        };
        let jax_rs_client = self
            .file_imports
            .get(&class.file_path)
            .is_some_and(|imports| {
                imports.iter().any(|import| {
                    import.starts_with("jakarta.ws.rs.client.")
                        || import.starts_with("javax.ws.rs.client.")
                })
            });
        class.fields.iter().any(|field| {
            let full = field.field_type.trim();
            let base = full.split('<').next().unwrap_or(full).trim();
            if base == "HttpClient.Builder" {
                return true;
            }
            let simple = base.rsplit('.').next().unwrap_or(base).trim();
            match simple {
                "RestTemplate"
                | "WebClient"
                | "RestClient"
                | "OkHttpClient"
                | "HttpClient"
                | "CloseableHttpClient"
                | "WebTarget" => true,
                "Client" => jax_rs_client,
                _ => false,
            }
        })
    }

    pub fn has_client_interfaces(&self) -> bool {
        self.classes
            .values()
            .any(|c| self.class_in_scope(&c.file_path) && c.is_interface && c.is_client_interface)
    }

    /// Declarative interfaces are not the only Java client lane. A repository that
    /// calls RestTemplate/WebClient/RestClient/OkHttp/java.net.http/Jersey directly has
    /// client evidence too, and skipping the Java lane for it would emit an empty
    /// frontend artifact with nothing to say why.
    pub fn has_client_evidence(&self) -> bool {
        self.has_client_interfaces()
            || self.classes.values().any(|c| {
                self.class_in_scope(&c.file_path)
                    && c.methods.iter().any(|m| !m.client_calls.is_empty())
            })
    }

    pub fn config_fingerprint(&self) -> &str {
        &self.config_fingerprint
    }

    /// The Java lane covers Spring MVC, Micronaut, Quarkus reactive and Helidon SE on the
    /// same annotation/AST reader; the profile names the framework the imports prove.
    pub fn framework_profile(&self) -> String {
        self.detected_framework_profile()
    }

    fn detected_framework_profile(&self) -> String {
        if self.enable_jax_rs {
            return "JAX_RS".to_string();
        }
        let imports: Vec<&String> = self.file_imports.values().flatten().collect();
        let has = |prefix: &str| imports.iter().any(|import| import.starts_with(prefix));
        if has("io.micronaut.") && !has("org.springframework.") {
            "MICRONAUT".to_string()
        } else if has("io.quarkus.") && !has("org.springframework.") {
            "QUARKUS".to_string()
        } else if has("io.helidon.") && !has("org.springframework.") {
            "HELIDON".to_string()
        } else if has("org.springframework.web.reactive.function.server.")
            && !has("org.springframework.web.bind.annotation.RestController")
        {
            "SPRING_WEBFLUX_FUNCTIONAL".to_string()
        } else {
            "SPRING_MVC".to_string()
        }
    }

    pub fn new(repo_root: PathBuf, java_dir: &Path) -> Result<Self> {
        let (naming_strategy, config_fingerprint, config_blockers) =
            detect_config(&repo_root, java_dir);
        let context_path = extract_context_path(&read_config_inputs(&repo_root, java_dir));

        let mut extractor = JavaRouteExtractor {
            classes: HashMap::new(),
            classes_by_simple: HashMap::new(),
            file_imports: HashMap::new(),
            file_packages: HashMap::new(),
            nested_by_simple: HashMap::new(),
            constant_table: ConstantTable::default(),
            naming_strategy,
            config_fingerprint,
            repo_root,
            blobs: None,
            source_blockers: config_blockers,
            endpoint_root: None,
            context_path,
            enable_jax_rs: false,
        };

        // If java_dir is a module root (not the whole repo) and has a `src/main/java` subdirectory,
        // anchor to `src/main/java` so that the primary root matches discovered sibling roots and
        // does not encompass test trees.
        let effective_java_dir =
            if java_dir != extractor.repo_root && java_dir.join(JAVA_SOURCE_ROOT_SUFFIX).is_dir() {
                java_dir.join(JAVA_SOURCE_ROOT_SUFFIX)
            } else {
                java_dir.to_path_buf()
            };

        // A caller that hands over a directory outside the repository gives the extractor no
        // base to make provenance paths from, so it also gets no endpoint gate.
        if let Ok(rel) = effective_java_dir.strip_prefix(&extractor.repo_root) {
            extractor.endpoint_root = Some(path_to_posix(rel));
        }

        let mut roots = vec![effective_java_dir];
        if java_dir != extractor.repo_root {
            let (discovered, gaps) = discover_source_roots(&extractor.repo_root);
            roots.extend(discovered);
            if !gaps.is_empty() {
                extractor.source_blockers.push(source_blocker(
                    if gaps.len() == 1 { &gaps[0] } else { "." },
                    "JAVA_MODULE_ROOTS_UNINDEXED",
                    format!(
                        "{} module root(s) declared by the build were not indexed, so a type or endpoint declared in them may be absent from this artifact: {}; a missing entry here is not evidence that the repository does not declare it",
                        gaps.len(),
                        summarize(&gaps)
                    ),
                ));
            }
        }
        extractor.scan_roots(&roots)?;
        Ok(extractor)
    }

    /// Build an extractor from caller-supplied source text without touching the
    /// working tree. `sources` are `(repository-relative POSIX path, content)`
    /// pairs, typically staged index blobs or blobs read from a Git tree.
    ///
    /// `config` is the configuration of the same revision as `sources`: the naming strategy,
    /// `configFingerprint` and every configuration blocker are part of the sealed envelope digest,
    /// so mixing a working-tree document with a historical tree would produce an artifact that
    /// cannot be reproduced. The leading entry of `config.files` is the blob that won the
    /// `CONFIG_TAILS` precedence, and its path decides whether the content is read as properties
    /// or YAML.
    pub fn from_blobs(
        repo_root: PathBuf,
        sources: Vec<(String, String)>,
        config: ConfigInputs,
    ) -> Result<Self> {
        let context_path = extract_context_path(&config);
        let (naming_strategy, config_fingerprint, config_blockers) = resolve_config(config);

        let mut extractor = JavaRouteExtractor {
            classes: HashMap::new(),
            classes_by_simple: HashMap::new(),
            file_imports: HashMap::new(),
            file_packages: HashMap::new(),
            nested_by_simple: HashMap::new(),
            constant_table: ConstantTable::default(),
            naming_strategy,
            config_fingerprint,
            repo_root,
            blobs: None,
            source_blockers: config_blockers,
            endpoint_root: None,
            context_path,
            enable_jax_rs: false,
        };

        let mut ordered: Vec<(String, String)> = sources;
        // Parse order is explicit so a changed blob ordering cannot reorder class
        // registration side effects.
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        let mut indexed = HashMap::with_capacity(ordered.len());
        let mut parser = Self::parser()?;
        let constant_table = build_constant_table(&ordered)?;
        let service_methods = build_service_method_table(&ordered)?;
        for (path, content) in ordered {
            extractor.ingest(
                &mut parser,
                &path,
                &content,
                &constant_table,
                &service_methods,
            );
            indexed.insert(path, content);
        }
        extractor.constant_table = constant_table;
        extractor.blobs = Some(indexed);
        Ok(extractor)
    }

    fn parser() -> Result<Parser> {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_java::LANGUAGE.into())
            .map_err(|e| anyhow!("Failed to set tree-sitter Java language: {}", e))?;
        Ok(parser)
    }

    fn ingest(
        &mut self,
        parser: &mut Parser,
        rel_path: &str,
        content: &str,
        constants: &ConstantTable,
        service_methods: &ServiceMethodTable,
    ) {
        let (classes, blocker) =
            parse_decoded(parser, rel_path, content, constants, service_methods, None);
        if let Some(blocker) = blocker {
            self.source_blockers.push(blocker);
        }
        if let Some(setting) = mapper_shape_setting(content) {
            self.source_blockers.push(source_blocker(
                rel_path,
                "UNSUPPORTED_JACKSON_FEATURE",
                format!(
                    "`{setting}` configures a Jackson mapper in a way that changes which properties serialize or what they are called, and it overrides anything the configuration file declares"
                ),
            ));
        }
        check_unsupported_frameworks(content, rel_path, &mut self.source_blockers);
        self.file_imports
            .insert(rel_path.to_string(), scan_imports(content));
        for cls in classes {
            self.register_class(cls);
        }
    }

    fn register_class(&mut self, cls: JavaClassInfo) {
        if cls.is_nested {
            let candidates = self
                .nested_by_simple
                .entry(cls.class_name.clone())
                .or_default();
            if !candidates.contains(&cls.fqcn) {
                candidates.push(cls.fqcn.clone());
            }
        } else {
            let candidates = self
                .classes_by_simple
                .entry(cls.class_name.clone())
                .or_default();
            if !candidates.contains(&cls.fqcn) {
                candidates.push(cls.fqcn.clone());
            }
        }
        self.file_packages
            .entry(cls.file_path.clone())
            .or_insert_with(|| cls.package_name.clone());
        // Sibling modules can reuse a package and class name (generated SDK samples
        // do this wholesale). When extraction is scoped to one module, its own
        // declaration must win over a same-FQCN class discovered in a sibling.
        if let Some(existing) = self.classes.get(&cls.fqcn) {
            let existing_in_scope = self.class_in_scope(&existing.file_path);
            let incoming_in_scope = self.class_in_scope(&cls.file_path);
            if existing_in_scope && !incoming_in_scope {
                return;
            }
        }
        self.classes.insert(cls.fqcn.clone(), cls);
    }

    /// Detect unsupported server frameworks from the nearest build manifest and
    /// from route configuration files (Struts XML, JSF faces config, Play routes).
    /// Source imports cover the normal case; this covers a repository whose only
    /// evidence is a dependency or an XML route file, which would otherwise read
    /// as an empty complete Spring service.
    fn add_manifest_framework_blockers(&mut self, source_root: &Path) {
        const TOKENS: &[(&str, &str)] = &[
            ("vertx-web", "Vert.x"),
            ("spark-core", "Spark Java"),
            ("struts2-core", "Struts2"),
            ("javax.faces", "JSF"),
            ("jakarta.faces", "JSF"),
            ("rsocket-core", "RSocket"),
            ("javalin", "Javalin"),
            ("play_2.", "Play MVC"),
        ];

        let mut manifest = None;
        let mut cursor = Some(source_root);
        while let Some(dir) = cursor {
            if !dir.starts_with(&self.repo_root) {
                break;
            }
            for name in ["pom.xml", "build.gradle", "build.gradle.kts"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    manifest = Some(candidate);
                    break;
                }
            }
            if manifest.is_some() {
                break;
            }
            if dir == self.repo_root {
                break;
            }
            cursor = dir.parent();
        }

        let mut seen_families = HashSet::new();
        if let Some(path) = manifest {
            if let Ok(text) = fs::read_to_string(&path) {
                for (token, family) in TOKENS {
                    if !text.contains(token) || !seen_families.insert(*family) {
                        continue;
                    }
                    let label = path_to_posix(path.strip_prefix(&self.repo_root).unwrap_or(&path));
                    self.source_blockers.push(source_blocker(
                        &label,
                        "JAVA_FRAMEWORK_DEPENDENCY_UNPARSED",
                        format!(
                            "Build declares {family} ({token}); endpoints declared by {family} are absent from this artifact and its emptiness is not evidence of absence"
                        ),
                    ));
                }
            }
        }

        const ROUTE_FILES: &[(&str, &str)] = &[
            ("src/main/resources/struts.xml", "Struts2"),
            ("struts.xml", "Struts2"),
            ("src/main/resources/faces-config.xml", "JSF"),
            ("faces-config.xml", "JSF"),
            ("conf/routes", "Play MVC"),
        ];
        let mut dir = Some(source_root);
        while let Some(current) = dir {
            if !current.starts_with(&self.repo_root) {
                break;
            }
            for (tail, family) in ROUTE_FILES {
                let candidate = current.join(tail);
                if candidate.is_file() && seen_families.insert(*family) {
                    let label = path_to_posix(
                        candidate
                            .strip_prefix(&self.repo_root)
                            .unwrap_or(&candidate),
                    );
                    self.source_blockers.push(source_blocker(
                        &label,
                        "JAVA_FRAMEWORK_CONFIG_UNPARSED",
                        format!(
                            "Route configuration {tail} declares {family} routes; this reader does not parse it, so those endpoints are absent from this artifact"
                        ),
                    ));
                }
            }
            if current == self.repo_root {
                break;
            }
            dir = current.parent();
        }

        // A deployment descriptor can map URLs onto servlets this reader never sees.
        // Only a descriptor that actually declares a servlet-mapping is named, so a
        // Spring Boot `web.xml` carrying just mime types stays silent.
        const HANDLED_SERVLETS: &[&str] = &[
            "DispatcherServlet",
            "FacesServlet",
            "ServletContainer",
            "HttpServletDispatcher",
        ];
        let mut descriptor_named = false;
        for tail in ["src/main/webapp/WEB-INF/web.xml", "webapp/WEB-INF/web.xml"] {
            if descriptor_named {
                break;
            }
            let mut dir = Some(source_root);
            while let Some(current) = dir {
                if !current.starts_with(&self.repo_root) {
                    break;
                }
                let candidate = current.join(tail);
                if let Ok(text) = fs::read_to_string(&candidate) {
                    if text.contains("<servlet-mapping>")
                        && !HANDLED_SERVLETS
                            .iter()
                            .any(|handled| text.contains(handled))
                    {
                        let label = path_to_posix(
                            candidate
                                .strip_prefix(&self.repo_root)
                                .unwrap_or(&candidate),
                        );
                        self.source_blockers.push(source_blocker(
                            &label,
                            "JAVA_FRAMEWORK_CONFIG_UNPARSED",
                            "web.xml declares <servlet-mapping> entries for Servlet API classes; those routes are absent from this artifact and its emptiness is not evidence of absence".to_string(),
                        ));
                        descriptor_named = true;
                        break;
                    }
                }
                if current == self.repo_root {
                    break;
                }
                dir = current.parent();
            }
        }
    }

    /// Index every given root, but only `roots[0]` may contribute endpoints. The remaining roots
    /// exist because a multi-module repository declares the DTOs its controllers speak in a
    /// sibling module: indexing only the served module left every one of those names unresolved,
    /// which reads to a consumer as an untyped API rather than as a missing index.
    fn scan_roots(&mut self, roots: &[PathBuf]) -> Result<()> {
        let roots = nest_free_roots(roots);
        self.add_manifest_framework_blockers(&roots[0]);
        let mut primary_files = Vec::new();
        collect_java_files(&roots[0], &mut primary_files)?;
        let mut java_files = primary_files.clone();
        for root in roots.iter().skip(1) {
            collect_java_files(root, &mut java_files)?;
        }
        // `read_dir` order is unspecified. Registration order decides which class wins a
        // duplicated simple name, so an unsorted walk makes the artifact unstable.
        java_files.sort();
        java_files.dedup();

        let repo_root = self.repo_root.clone();

        // A constant declared by another class is needed while that file's members are parsed,
        // so the whole source set is parsed once for constants before the real pass.
        let mut sources: Vec<(String, String)> = Vec::with_capacity(java_files.len());
        for file_path in &java_files {
            let rel_path = path_to_posix(file_path.strip_prefix(&repo_root).unwrap_or(file_path));
            if let Ok(content) = fs::read_to_string(file_path) {
                sources.push((rel_path, content));
            }
        }
        let constant_table = build_constant_table(&sources)?;
        self.constant_table = constant_table.clone();
        let service_methods = build_service_method_table(&sources)?;

        // Multi-threaded AST parsing across all CPU threads via Rayon
        let outcomes: Vec<(String, Vec<JavaClassInfo>, Vec<ArtifactBlocker>, Vec<String>)> =
            java_files
                .par_iter()
                .map(|file_path| {
                    let rel_path = path_to_posix(
                        file_path
                            .strip_prefix(&repo_root)
                            .unwrap_or(file_path),
                    );

                    let bytes = match fs::read(file_path) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            return (
                                rel_path.clone(),
                                Vec::new(),
                                vec![source_blocker(
                                    &rel_path,
                                    "JAVA_SOURCE_UNREADABLE",
                                    format!(
                                        "Source file could not be read ({e}); every endpoint and type declared in it is absent from this artifact"
                                    ),
                                )],
                                Vec::new(),
                            );
                        }
                    };

                    let mut blockers = Vec::new();
                    let content = match String::from_utf8(bytes) {
                        Ok(content) => content,
                        Err(e) => {
                            blockers.push(source_blocker(
                                &rel_path,
                                "JAVA_SOURCE_NOT_UTF8",
                                "Source is not valid UTF-8; decoded lossily so identifiers survive, but non-ASCII text in it is unreliable".to_string(),
                            ));
                            String::from_utf8_lossy(&e.into_bytes()).into_owned()
                        }
                    };

                    check_unsupported_frameworks(&content, &rel_path, &mut blockers);

                    // Import statements bind simple type names to declarations; they
                    // must be captured on the working-tree path too, not just in blob
                    // mode, or every cross-package DTO resolves by global guess.
                    let imports = scan_imports(&content);

                    // Fast rejection: files without any class/interface/record/enum cannot define controllers or DTOs
                    if !content.contains("class")
                        && !content.contains("record")
                        && !content.contains("interface")
                        && !content.contains("enum")
                    {
                        return (rel_path, Vec::new(), blockers, imports);
                    }

                    let mut parser = match Self::parser() {
                        Ok(parser) => parser,
                        Err(e) => {
                            blockers.push(source_blocker(
                                &rel_path,
                                "JAVA_PARSE_FAILED",
                                format!("Tree-sitter Java language could not be initialised ({e})"),
                            ));
                            return (rel_path, Vec::new(), blockers, imports);
                        }
                    };

                    let (classes, parse_blocker) = parse_decoded(
                        &mut parser,
                        &rel_path,
                        &content,
                        &constant_table,
                        &service_methods,
                        file_path.to_str(),
                    );
                    if let Some(parse_blocker) = parse_blocker {
                        blockers.push(parse_blocker);
                    }
                    (rel_path, classes, blockers, imports)
                })
                .collect();

        // A Kotlin service reads as an empty Java tree, which would otherwise be published as a
        // complete artifact with no endpoints. The conventional source root is enough for a
        // mixed module; only a service with no Java at all pays for a full `.kt` walk.
        let mut kotlin_label: Option<String> = roots
            .iter()
            .chain(std::iter::once(&self.repo_root))
            .map(|root| root.join("src/main/kotlin"))
            .find(|dir| dir.is_dir())
            .map(|dir| path_to_posix(dir.strip_prefix(&self.repo_root).unwrap_or(&dir)));
        if kotlin_label.is_none() && primary_files.is_empty() {
            let mut kotlin_files = Vec::new();
            for root in &roots {
                collect_sources_with_ext(root, "kt", &mut kotlin_files)?;
                if !kotlin_files.is_empty() {
                    break;
                }
            }
            kotlin_label = kotlin_files
                .first()
                .map(|path| path_to_posix(path.strip_prefix(&self.repo_root).unwrap_or(path)));
        }
        if let Some(label) = kotlin_label {
            self.note_unparsed_kotlin(if label.is_empty() { "." } else { &label });
        }
        for (extension, family, conventional) in [
            ("scala", "Scala", "src/main/scala"),
            ("groovy", "Groovy", "src/main/groovy"),
        ] {
            let mut label: Option<String> = roots
                .iter()
                .chain(std::iter::once(&self.repo_root))
                .map(|root| root.join(conventional))
                .find(|dir| dir.is_dir())
                .map(|dir| path_to_posix(dir.strip_prefix(&self.repo_root).unwrap_or(&dir)));
            if label.is_none() && primary_files.is_empty() {
                let mut files = Vec::new();
                for root in &roots {
                    collect_sources_with_ext(root, extension, &mut files)?;
                    if !files.is_empty() {
                        break;
                    }
                }
                label = files
                    .first()
                    .map(|path| path_to_posix(path.strip_prefix(&self.repo_root).unwrap_or(path)));
            }
            if let Some(label) = label {
                self.note_unparsed_source(family, if label.is_empty() { "." } else { &label });
            }
        }

        for (rel_path, classes, blockers, imports) in outcomes {
            self.file_imports.insert(rel_path, imports);
            for blocker in blockers {
                self.source_blockers.push(blocker);
            }
            for cls in classes {
                self.register_class(cls);
            }
        }
        sort_blockers(&mut self.source_blockers);

        Ok(())
    }

    fn file_content(&self, rel_path: &str) -> Option<String> {
        if let Some(blobs) = &self.blobs {
            return blobs.get(rel_path).cloned();
        }
        fs::read_to_string(self.repo_root.join(rel_path)).ok()
    }

    /// Functional route DSLs are not annotations; the same parsed source set is scanned
    /// for WebFlux `RouterFunctions` and Helidon `Routing.builder` chains.
    fn collect_dsl_routes(
        &self,
    ) -> (
        Vec<crate::java_dsl_routes::JavaDslRoute>,
        Vec<ArtifactBlocker>,
    ) {
        let mut routes = Vec::new();
        let mut blockers = Vec::new();
        let mut files: Vec<&String> = self.file_imports.keys().collect();
        files.sort();

        // Helidon services register on a routing builder under a literal prefix;
        // compose the prefix across files before reading the service classes.
        let mut helidon_prefixes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut helidon_register_files: HashSet<String> = HashSet::new();
        let mut helidon_unresolved_files: HashSet<String> = HashSet::new();
        for file in &files {
            let Some(content) = self.file_content(file) else {
                continue;
            };
            if !content.contains("register(") {
                continue;
            }
            let (registrations, unresolved) =
                crate::java_dsl_routes::extract_helidon_registrations(&content);
            if unresolved {
                helidon_unresolved_files.insert((*file).clone());
            }
            if !registrations.is_empty() {
                helidon_register_files.insert((*file).clone());
            }
            for registration in registrations {
                helidon_prefixes
                    .entry(registration.service)
                    .or_default()
                    .push(registration.prefix);
            }
        }
        for prefixes in helidon_prefixes.values_mut() {
            prefixes.sort();
            prefixes.dedup();
        }

        for file in files {
            let Some(content) = self.file_content(file) else {
                continue;
            };
            if content.contains("RouterFunctions")
                || content.contains("Routing.builder")
                || content.contains("HttpRouting")
            {
                let mut extraction = crate::java_dsl_routes::extract_dsl_routes(file, &content);
                // Registered services compose the routes, so "no literal route in
                // this file" is not a gap; unresolved groups keep their blocker.
                if helidon_register_files.contains(file) {
                    extraction
                        .blockers
                        .retain(|blocker| blocker.code != "JAVA_HELIDON_ROUTES_UNPARSED");
                }
                if crate::java_dsl_routes::uses_helidon4_routing(&content)
                    && extraction.routes.is_empty()
                {
                    extraction.blockers.push(ArtifactBlocker {
                        code: "JAVA_HELIDON_ROUTES_UNPARSED".to_string(),
                        message: "Helidon 4 HttpRouting/WebServer routing is not composed by this reader; the routes it declares are absent from this artifact".to_string(),
                        file: Some(file.clone()),
                    });
                }
                routes.extend(extraction.routes);
                blockers.extend(extraction.blockers);
            }
            if let Some(service) = crate::java_dsl_routes::extract_helidon_service(&content) {
                if service.routes.is_empty() {
                    blockers.push(ArtifactBlocker {
                        code: "JAVA_HELIDON_SERVICE_ROUTES_UNPARSED".to_string(),
                        message: format!(
                            "Helidon service {} registers no literal routes this reader can read; its endpoints are absent",
                            service.class_name
                        ),
                        file: Some(file.clone()),
                    });
                } else if let Some(prefixes) = helidon_prefixes.get(&service.class_name) {
                    for prefix in prefixes {
                        for (verb, path, line) in &service.routes {
                            let combined = if path.trim_matches('/').is_empty() {
                                let prefix = prefix.trim_end_matches('/');
                                if prefix.is_empty() {
                                    "/".to_string()
                                } else {
                                    prefix.to_string()
                                }
                            } else {
                                combine_spring_routes(prefix, path)
                            };
                            routes.push(crate::java_dsl_routes::JavaDslRoute {
                                file: file.clone(),
                                line: *line,
                                http_method: verb.clone(),
                                path: combined,
                            });
                        }
                    }
                } else {
                    blockers.push(ArtifactBlocker {
                        code: "JAVA_HELIDON_SERVICE_UNREGISTERED".to_string(),
                        message: format!(
                            "Helidon service {} is registered without a literal prefix in this source set; its routes cannot be addressed and are absent",
                            service.class_name
                        ),
                        file: Some(file.clone()),
                    });
                }
            }
        }
        // A fully composed registration file is not an unparsed group; a file with
        // health/metrics-style registrations keeps the blocker.
        blockers.retain(|blocker| {
            !(blocker.code == "JAVA_HELIDON_ROUTE_REGISTER_UNPARSED"
                && blocker.file.as_ref().is_some_and(|file| {
                    helidon_register_files.contains(file)
                        && !helidon_unresolved_files.contains(file)
                }))
        });
        routes.sort_by(|a, b| {
            (a.path.as_str(), a.http_method.as_str(), a.line).cmp(&(
                b.path.as_str(),
                b.http_method.as_str(),
                b.line,
            ))
        });
        routes.dedup();
        blockers
            .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
        blockers.dedup_by(|a, b| a.code == b.code && a.message == b.message && a.file == b.file);
        (routes, blockers)
    }

    fn dsl_endpoints(
        &self,
        service_id: &str,
        routes: &[crate::java_dsl_routes::JavaDslRoute],
    ) -> Vec<EndpointContract> {
        let mut endpoints = Vec::new();
        for route in routes {
            let normalized_route = normalize_route_segments(&route.path);
            let path_parameters: Vec<ParamContract> = route
                .path
                .split('/')
                .filter(|segment| segment.starts_with('{') || segment.starts_with(':'))
                .map(|segment| {
                    let name = segment
                        .trim_matches(|c| c == '{' || c == '}')
                        .trim_start_matches(':')
                        .trim_end_matches('*')
                        .to_string();
                    ParamContract {
                        name,
                        r#type: WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::String,
                            format: None,
                            provenance: None,
                        }),
                        required: true,
                        validation_constraints: None,
                        provenance: None,
                    }
                })
                .collect();
            let provenance = SourceProvenance {
                language: SourceLanguage::Java,
                file: route.file.clone(),
                line: route.line,
                column: None,
                ast_identity: Some(format!("functional {} {}", route.http_method, route.path)),
                annotation_or_schema: None,
                sha256: None,
                evidence_classification: None,
            };
            let unknown_body = |reason: &str| {
                WireType::Unknown(UnknownWireType {
                    reason: reason.to_string(),
                    provenance: Some(provenance.clone()),
                })
            };
            endpoints.push(EndpointContract {
                identity: EndpointIdentityContract {
                    service: Some(service_id.to_string()),
                    http_method: route.http_method.clone(),
                    normalized_route: normalized_route.clone(),
                    direction: ContractDirection::Response,
                },
                path_parameters: path_parameters.clone(),
                query_parameters: Vec::new(),
                headers: Vec::new(),
                body: Some(unknown_body(
                    "Functional route handler response is not statically typed",
                )),
                provenance: provenance.clone(),
                evidence_classification: None,
                declared_responses: None,
                status_code_family: Some(StatusCodeFamily::Success2xx),
                mapping_conditions: Some(json!({"params": [], "complete": true})),
            });
            let body_may_exist = matches!(route.http_method.as_str(), "POST" | "PUT" | "PATCH");
            if body_may_exist || !path_parameters.is_empty() {
                endpoints.push(EndpointContract {
                    identity: EndpointIdentityContract {
                        service: Some(service_id.to_string()),
                        http_method: route.http_method.clone(),
                        normalized_route,
                        direction: ContractDirection::Request,
                    },
                    path_parameters,
                    query_parameters: Vec::new(),
                    headers: Vec::new(),
                    body: body_may_exist.then(|| {
                        unknown_body("Functional route request body is not statically typed")
                    }),
                    provenance: provenance.clone(),
                    evidence_classification: None,
                    declared_responses: None,
                    status_code_family: Some(StatusCodeFamily::Success2xx),
                    mapping_conditions: Some(json!({"params": [], "complete": true})),
                });
            }
        }
        endpoints
    }

    /// Prefixes under which sub-resource classes are reachable, discovered from
    /// `@Path` locator methods that return another resource type. The resolved set
    /// suppresses the "locator not composed" blocker for methods that were followed.
    fn jax_rs_locator_prefixes(&self) -> (BTreeMap<String, Vec<String>>, HashSet<(String, u32)>) {
        let mut prefixes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut resolved: HashSet<(String, u32)> = HashSet::new();
        if !self.enable_jax_rs {
            return (prefixes, resolved);
        }
        let mut class_keys: Vec<&String> = self.classes.keys().collect();
        class_keys.sort();
        for class_key in class_keys {
            let cls = &self.classes[class_key];
            if !cls.is_jax_rs {
                continue;
            }
            let base = if cls.class_paths.is_empty() {
                vec!["".to_string()]
            } else {
                cls.class_paths.clone()
            };
            let mut visited = HashSet::new();
            self.collect_locator_prefixes(
                cls,
                &base,
                &mut prefixes,
                &mut resolved,
                &mut visited,
                0,
            );
        }
        for values in prefixes.values_mut() {
            values.sort();
            values.dedup();
        }
        (prefixes, resolved)
    }

    fn collect_locator_prefixes(
        &self,
        cls: &JavaClassInfo,
        class_prefixes: &[String],
        prefixes: &mut BTreeMap<String, Vec<String>>,
        resolved: &mut HashSet<(String, u32)>,
        visited: &mut HashSet<String>,
        depth: usize,
    ) {
        if depth > 4 {
            return;
        }
        for method in &cls.methods {
            if !method.http_methods.is_empty() || method.paths.is_empty() {
                continue;
            }
            let return_type = method.return_type.trim();
            let simple = return_type
                .split('<')
                .next()
                .unwrap_or(return_type)
                .rsplit('.')
                .next()
                .unwrap_or(return_type)
                .trim();
            let Some(sub_fqcn) = self.find_class_fqcn(simple, &cls.file_path) else {
                continue;
            };
            let Some(sub) = self.classes.get(&sub_fqcn) else {
                continue;
            };
            let visit_key = format!("{sub_fqcn}|{}", class_prefixes.join(","));
            if !visited.insert(visit_key) {
                continue;
            }
            let mut next_prefixes = Vec::new();
            for class_prefix in class_prefixes {
                for locator_path in &method.paths {
                    let locator_base = combine_spring_routes(class_prefix, locator_path);
                    let sub_paths = if sub.class_paths.is_empty() {
                        vec!["".to_string()]
                    } else {
                        sub.class_paths.clone()
                    };
                    for sub_path in sub_paths {
                        let full = combine_spring_routes(&locator_base, &sub_path);
                        prefixes
                            .entry(sub_fqcn.clone())
                            .or_default()
                            .push(full.clone());
                        next_prefixes.push(full);
                    }
                }
            }
            resolved.insert((cls.file_path.clone(), method.line));
            self.collect_locator_prefixes(
                sub,
                &next_prefixes,
                prefixes,
                resolved,
                visited,
                depth + 1,
            );
        }
    }

    pub fn extract_payload(
        &self,
        service_id: &str,
    ) -> (BackendContractPayload, ArtifactCompleteness) {
        let mut endpoints = Vec::new();
        let mut type_pool: BTreeMap<String, WireType> = BTreeMap::new();

        // `classes` is a HashMap whose iteration order differs between processes. The
        // endpoint Vec is serialized verbatim, so an unsorted walk yields a different
        // artifact digest for identical sources.
        let mut class_keys: Vec<&String> = self.classes.keys().collect();
        class_keys.sort();

        let mut surface_blockers: Vec<ArtifactBlocker> = Vec::new();
        let mut excluded: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let (dsl_routes, dsl_blockers) = self.collect_dsl_routes();
        surface_blockers.extend(dsl_blockers);

        // `@ApplicationPath` is declared once by the JAX-RS application class and prefixes
        // every resource in the deployment. Conflicting declarations cannot be applied.
        let application_paths: BTreeSet<String> = if self.enable_jax_rs {
            self.classes
                .values()
                .filter_map(|class| class.jax_rs_application_path.clone())
                .collect()
        } else {
            BTreeSet::new()
        };
        let (locator_prefixes, locator_resolved) = self.jax_rs_locator_prefixes();
        let jax_rs_base_path = if application_paths.len() == 1 {
            application_paths.iter().next().cloned()
        } else {
            if application_paths.len() > 1 {
                surface_blockers.push(source_blocker(
                    ".",
                    "JAVA_JAXRS_APPLICATION_PATH_UNPARSED",
                    format!(
                        "Multiple @ApplicationPath values were found ({}); no base path was applied to JAX-RS routes",
                        application_paths.iter().cloned().collect::<Vec<_>>().join(", ")
                    ),
                ));
            }
            None
        };

        for class_key in class_keys {
            let cls = &self.classes[class_key];
            let (
                is_controller,
                is_controller_advice,
                composed_class_paths,
                composed_class_params,
                composed_conditions_complete,
                composed_path_unresolved,
            ) = if cls.is_controller {
                (
                    true,
                    cls.is_controller_advice,
                    Vec::new(),
                    Vec::new(),
                    true,
                    false,
                )
            } else if cls.is_jax_rs && self.enable_jax_rs {
                (true, false, Vec::new(), Vec::new(), true, false)
            } else if cls.is_reactive_routes {
                (true, false, Vec::new(), Vec::new(), true, false)
            } else if self.enable_jax_rs && locator_prefixes.contains_key(&cls.fqcn) {
                (true, false, Vec::new(), Vec::new(), true, false)
            } else {
                let (controller, advice, paths, params, complete, path_unresolved) =
                    self.resolve_class_level_controller(cls, &mut surface_blockers);
                if !controller && cls.methods.iter().any(|m| m.is_mapped) {
                    surface_blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_MAPPING_ON_NON_CONTROLLER",
                        format!(
                            "Type {} declares HTTP method annotations but is not recognized as a controller ({}), so its endpoints are absent from this artifact",
                            cls.fqcn,
                            if cls.is_interface {
                                "the type is an interface, possibly a generated API contract implemented elsewhere"
                            } else {
                                "no controller stereotype resolved from its annotations"
                            }
                        ),
                    ));
                }
                (controller, advice, paths, params, complete, path_unresolved)
            };
            if !is_controller {
                continue;
            }
            if cls.class_path_unresolved || composed_path_unresolved {
                surface_blockers.push(source_blocker(
                    &cls.file_path,
                    "JAVA_MAPPING_PATH_UNRESOLVED",
                    format!(
                        "{} declares a class-level mapping path this reader cannot resolve; its endpoints are absent from this artifact and their absence is not evidence that the class exposes none",
                        cls.fqcn
                    ),
                ));
                continue;
            }
            let mut class_mapping_params = cls.class_mapping_params.clone();
            for param in composed_class_params {
                if !class_mapping_params.contains(&param) {
                    class_mapping_params.push(param);
                }
            }
            let class_mapping_conditions_complete =
                cls.class_mapping_conditions_complete && composed_conditions_complete;

            // Types are indexed repository-wide so a DTO declared in a sibling module resolves,
            // but only the served root's controllers are this service's endpoints. Excluding them
            // silently would publish an artifact that looks like it enumerated the whole API.
            if let Some(endpoint_root) = &self.endpoint_root {
                if !is_inside_endpoint_root(&cls.file_path, endpoint_root) {
                    excluded
                        .entry(source_root_of(&cls.file_path))
                        .or_default()
                        .push(cls.fqcn.clone());
                    continue;
                }
            }

            let mut resolved_method_mappings: Vec<(
                &JavaMethodInfo,
                Vec<String>,
                Vec<String>,
                Vec<String>,
                bool,
            )> = Vec::new();
            for method in &cls.methods {
                if let Some(reason) = &method.unmodeled_mapping {
                    surface_blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_MAPPING_CONDITION_UNRESOLVED",
                        format!(
                            "{}#{} {}. The endpoint is not published because its HTTP method condition is not statically readable",
                            cls.fqcn, method.name, reason
                        ),
                    ));
                }
                if method.path_unresolved {
                    surface_blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_MAPPING_PATH_UNRESOLVED",
                        format!(
                            "{}#{} declares a mapping path this reader cannot resolve; the endpoint is not published instead of being anchored at `/`",
                            cls.fqcn, method.name
                        ),
                    ));
                    continue;
                }
                if method.is_mapped {
                    if !cls.is_jax_rs && !method.unmodeled_parameters.is_empty() {
                        surface_blockers.push(source_blocker(
                            &cls.file_path,
                            "JAVA_SPRING_PARAMETER_UNMODELED",
                            format!(
                                "{}#{} declares request parameters this reader does not model: {}; the published contract omits them, so its request signature is incomplete",
                                cls.fqcn,
                                method.name,
                                method.unmodeled_parameters.join("; ")
                            ),
                        ));
                    }
                    let method_paths = if method.paths.is_empty() {
                        vec!["".to_string()]
                    } else {
                        method.paths.clone()
                    };
                    resolved_method_mappings.push((
                        method,
                        method.http_methods.clone(),
                        method_paths,
                        method.mapping_params.clone(),
                        method.mapping_conditions_complete,
                    ));
                } else if !method.custom_annotations.is_empty() {
                    for custom_ann in &method.custom_annotations {
                        let mut visited = HashSet::new();
                        match self.resolve_composed_mapping(
                            &custom_ann.name,
                            &cls.file_path,
                            &mut visited,
                            0,
                        ) {
                            Ok(Some(composed)) => {
                                if custom_ann.paths_unresolved || composed.path_unresolved {
                                    surface_blockers.push(source_blocker(
                                        &cls.file_path,
                                        "JAVA_MAPPING_PATH_UNRESOLVED",
                                        format!(
                                            "{}#{} uses composed annotation @{} with a path this reader cannot resolve; the endpoint is not published instead of being anchored at `/`",
                                            cls.fqcn, method.name, custom_ann.name
                                        ),
                                    ));
                                    continue;
                                }
                                if !cls.is_jax_rs && !method.unmodeled_parameters.is_empty() {
                                    surface_blockers.push(source_blocker(
                                        &cls.file_path,
                                        "JAVA_SPRING_PARAMETER_UNMODELED",
                                        format!(
                                            "{}#{} declares request parameters this reader does not model: {}; the published contract omits them, so its request signature is incomplete",
                                            cls.fqcn,
                                            method.name,
                                            method.unmodeled_parameters.join("; ")
                                        ),
                                    ));
                                }
                                let method_paths = if !custom_ann.paths.is_empty() {
                                    custom_ann.paths.clone()
                                } else if !composed.base_paths.is_empty() {
                                    composed.base_paths.clone()
                                } else {
                                    vec!["".to_string()]
                                };
                                let method_conditions_complete = composed.conditions_complete
                                    && !composed.declares_condition_attribute;
                                resolved_method_mappings.push((
                                    method,
                                    composed.http_methods.clone(),
                                    method_paths,
                                    composed.params.clone(),
                                    method_conditions_complete,
                                ));
                            }
                            Err(err_msg) => {
                                surface_blockers.push(source_blocker(
                                    &cls.file_path,
                                    "JAVA_UNSUPPORTED_COMPOSED_MAPPING",
                                    format!(
                                        "Controller {} method {} uses composed annotation @{} which could not be resolved: {}",
                                        cls.fqcn, method.name, custom_ann.name, err_msg
                                    ),
                                ));
                            }
                            Ok(None) => {
                                if custom_ann.name.ends_with("Mapping") {
                                    surface_blockers.push(source_blocker(
                                        &cls.file_path,
                                        "JAVA_UNSUPPORTED_COMPOSED_MAPPING",
                                        format!(
                                            "Controller {} method {} uses unrecognized mapping annotation @{}",
                                            cls.fqcn, method.name, custom_ann.name
                                        ),
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            if cls.is_jax_rs && self.enable_jax_rs {
                for method in &cls.methods {
                    if method.http_methods.is_empty()
                        && !method.paths.is_empty()
                        && !locator_resolved.contains(&(cls.file_path.clone(), method.line))
                    {
                        surface_blockers.push(source_blocker(
                            &cls.file_path,
                            "JAVA_JAXRS_SUBRESOURCE_UNPARSED",
                            format!(
                                "{}#{} declares a JAX-RS sub-resource locator (@Path without an HTTP verb); the locator's routes are not composed under the parent path",
                                cls.fqcn, method.name
                            ),
                        ));
                    }
                }
            }

            let already_unparsed = self.source_blockers.iter().any(|b| {
                b.file.as_deref() == Some(&cls.file_path)
                    && b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED"
            });

            // A controller that contributes no mapped method is not proof of an API with no
            // endpoints: the common OpenAPI-first pattern declares every @Get/@Post mapping on a
            // generated `*Api` interface, and this extractor never follows that edge. Say so
            // instead of publishing a complete-looking artifact that silently omits the surface.
            let has_resolved_locator = cls
                .methods
                .iter()
                .any(|method| locator_resolved.contains(&(cls.file_path.clone(), method.line)));
            if !is_controller_advice
                && !cls.methods.is_empty()
                && resolved_method_mappings.is_empty()
                && !already_unparsed
                && !has_resolved_locator
            {
                let surface = if cls.implemented.is_empty() {
                    String::new()
                } else {
                    let names: Vec<&str> = cls.implemented.iter().map(|s| s.as_str()).collect();
                    let unscanned: Vec<&str> = cls
                        .implemented
                        .iter()
                        .map(|s| s.as_str())
                        .filter(|iface| !self.classes_by_simple.contains_key(*iface))
                        .collect();
                    format!(
                        " and implements {}{}",
                        names.join(", "),
                        if unscanned.is_empty() {
                            ""
                        } else {
                            ", which is not among the parsed sources"
                        }
                    )
                };
                surface_blockers.push(source_blocker(
                    &cls.file_path,
                    "JAVA_CONTROLLER_WITHOUT_MAPPINGS",
                    format!(
                        "{} declares no HTTP method annotation of its own{}, so every endpoint of this class is absent from this artifact; a missing endpoint is not evidence that the service does not expose it",
                        cls.fqcn, surface
                    ),
                ));
            }

            let mut class_paths = if let Some(prefixes) = locator_prefixes.get(&cls.fqcn) {
                prefixes.clone()
            } else if !cls.class_paths.is_empty() {
                cls.class_paths.clone()
            } else if !composed_class_paths.is_empty() {
                composed_class_paths.clone()
            } else {
                vec!["".to_string()]
            };
            if self.enable_jax_rs && cls.is_jax_rs {
                if let Some(base) = &jax_rs_base_path {
                    class_paths = class_paths
                        .into_iter()
                        .map(|path| combine_spring_routes(base, &path))
                        .collect();
                }
            }

            for (method, http_methods, method_paths, method_params, method_conditions_complete) in
                resolved_method_mappings
            {
                let mut mapping_params = class_mapping_params.clone();
                mapping_params.extend(method_params.iter().cloned());
                mapping_params.sort();
                mapping_params.dedup();
                let mapping_conditions_complete =
                    class_mapping_conditions_complete && method_conditions_complete;
                for http_verb in &http_methods {
                    for prefix in &class_paths {
                        for subpath in &method_paths {
                            let full_path = combine_spring_routes(prefix, subpath);
                            let normalized_route = normalize_route_segments(&full_path);

                            // Path parameters
                            let mut path_parameters: Vec<ParamContract> = Vec::new();
                            let mut query_parameters: Vec<ParamContract> = Vec::new();
                            let mut headers: Vec<ParamContract> = Vec::new();
                            let mut request_body_type: Option<WireType> = None;

                            for param in &method.parameters {
                                if param.is_path_variable {
                                    let param_name =
                                        param.alias.as_ref().unwrap_or(&param.name).clone();
                                    let wire_type = self.resolve_parameter(
                                        param,
                                        &mut type_pool,
                                        &cls.file_path,
                                    );
                                    path_parameters.push(ParamContract {
                                        name: param_name,
                                        r#type: wire_type,
                                        required: param.required,
                                        validation_constraints: Some(
                                            param.validation_constraints.clone(),
                                        ),
                                        provenance: Some(param.provenance.clone()),
                                    });
                                } else if param.is_request_body {
                                    request_body_type = Some(self.resolve_parameter(
                                        param,
                                        &mut type_pool,
                                        &cls.file_path,
                                    ));
                                } else if let Some(kind) = param.paging_kind {
                                    // Spring Data resolves Pageable/Sort into these query keys. They
                                    // are caller-supplied and part of the endpoint signature.
                                    for (name, is_sort) in kind.query_names() {
                                        if query_parameters.iter().any(|p| p.name == *name) {
                                            continue;
                                        }
                                        let wire_type = if *is_sort {
                                            WireType::Array(contract_core::ir::ArrayWireType {
                                                element_type: Box::new(WireType::Primitive(
                                                    PrimitiveWireType {
                                                        scalar: PrimitiveScalar::String,
                                                        format: None,
                                                        provenance: None,
                                                    },
                                                )),
                                                is_stream_or_flux: Some(false),
                                                provenance: None,
                                            })
                                        } else {
                                            WireType::Primitive(PrimitiveWireType {
                                                scalar: PrimitiveScalar::Number,
                                                format: None,
                                                provenance: None,
                                            })
                                        };
                                        query_parameters.push(ParamContract {
                                            name: name.to_string(),
                                            r#type: wire_type,
                                            required: false,
                                            validation_constraints: Some(Vec::new()),
                                            provenance: Some(param.provenance.clone()),
                                        });
                                    }
                                } else if param.is_request_param || param.is_request_header {
                                    // A parameter the caller supplies by name, in the query string or
                                    // in a header. Renaming or retyping one breaks every caller, so it
                                    // belongs in the endpoint signature instead of being dropped.
                                    let wire_type = self.resolve_parameter(
                                        param,
                                        &mut type_pool,
                                        &cls.file_path,
                                    );
                                    let entry = ParamContract {
                                        name: param.alias.as_ref().unwrap_or(&param.name).clone(),
                                        r#type: wire_type,
                                        required: param.required,
                                        validation_constraints: Some(
                                            param.validation_constraints.clone(),
                                        ),
                                        provenance: Some(param.provenance.clone()),
                                    };
                                    if param.is_request_header {
                                        headers.push(entry);
                                    } else {
                                        query_parameters.push(entry);
                                    }
                                }
                            }

                            // Determine status code family
                            let is_error_family = method.status_code.map_or(false, |c| c >= 400)
                                || method.is_exception_handler
                                || is_controller_advice;

                            let status_code_family = if is_error_family {
                                StatusCodeFamily::Error4xx5xx
                            } else {
                                StatusCodeFamily::Success2xx
                            };

                            let unwrapped_return = unwrap_generic_wrapper(&method.return_type);

                            // Find declared response matching target status family (2xx or 4xx/5xx)
                            let matching_declared = method.declared_responses.iter().find(|dr| {
                                if let Some(sc) = dr.status_code {
                                    if is_error_family {
                                        sc >= 400
                                    } else {
                                        sc < 300
                                    }
                                } else {
                                    !is_error_family
                                }
                            });

                            let (response_body, evidence_classification) = if unwrapped_return
                                == "void"
                                || unwrapped_return == "Void"
                            {
                                let writes_to_response_sink = method.parameters.iter().any(|p| {
                                    let pt = p.param_type.trim();
                                    pt.ends_with("HttpServletResponse")
                                        || pt.ends_with("ServletResponse")
                                        || pt.ends_with("OutputStream")
                                        || pt.ends_with("Writer")
                                        || pt.ends_with("PrintWriter")
                                        || pt.ends_with("HttpOutputMessage")
                                });

                                if writes_to_response_sink {
                                    if let Some(decl) = matching_declared {
                                        if let Some(ref schema) = decl.schema_name {
                                            let resolved = self.resolve_type(
                                                schema,
                                                &mut type_pool,
                                                &cls.file_path,
                                            );
                                            (
                                                Some(resolved),
                                                EvidenceClassification::DeclaredSpecification,
                                            )
                                        } else {
                                            (Some(WireType::Primitive(PrimitiveWireType {
                                                scalar: PrimitiveScalar::Any,
                                                format: None,
                                                provenance: Some(SourceProvenance {
                                                    language: SourceLanguage::Java,
                                                    file: cls.file_path.clone(),
                                                    line: method.line,
                                                    column: None,
                                                    ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                                    annotation_or_schema: Some("HttpServletResponse stream sink".to_string()),
                                                    sha256: None,
                                                    evidence_classification: Some(EvidenceClassification::DeclaredSpecification),
                                                }),
                                            })), EvidenceClassification::DeclaredSpecification)
                                        }
                                    } else {
                                        (Some(WireType::Primitive(PrimitiveWireType {
                                            scalar: PrimitiveScalar::Any,
                                            format: None,
                                            provenance: Some(SourceProvenance {
                                                language: SourceLanguage::Java,
                                                file: cls.file_path.clone(),
                                                line: method.line,
                                                column: None,
                                                ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                                annotation_or_schema: Some("HttpServletResponse stream sink".to_string()),
                                                sha256: None,
                                                evidence_classification: Some(EvidenceClassification::DeclaredSpecification),
                                            }),
                                        })), EvidenceClassification::DeclaredSpecification)
                                    }
                                } else {
                                    (None, EvidenceClassification::ImplementationDerived)
                                }
                            } else if unwrapped_return == "?"
                                || unwrapped_return == "Object"
                                || unwrapped_return.is_empty()
                            {
                                if let Some(decl) = matching_declared {
                                    if let Some(ref schema) = decl.schema_name {
                                        let resolved = self.resolve_type(
                                            schema,
                                            &mut type_pool,
                                            &cls.file_path,
                                        );
                                        (
                                            Some(resolved),
                                            EvidenceClassification::DeclaredSpecification,
                                        )
                                    } else {
                                        (Some(WireType::Primitive(PrimitiveWireType {
                                            scalar: PrimitiveScalar::Any,
                                            format: None,
                                            provenance: Some(SourceProvenance {
                                                language: SourceLanguage::Java,
                                                file: cls.file_path.clone(),
                                                line: method.line,
                                                column: None,
                                                ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                                annotation_or_schema: None,
                                                sha256: None,
                                                evidence_classification: Some(EvidenceClassification::DeclaredSpecification),
                                            }),
                                        })), EvidenceClassification::DeclaredSpecification)
                                    }
                                } else {
                                    (
                                        Some(WireType::Primitive(PrimitiveWireType {
                                            scalar: PrimitiveScalar::Any,
                                            format: None,
                                            provenance: Some(SourceProvenance {
                                                language: SourceLanguage::Java,
                                                file: cls.file_path.clone(),
                                                line: method.line,
                                                column: None,
                                                ast_identity: Some(format!(
                                                    "{}#{}",
                                                    cls.fqcn, method.name
                                                )),
                                                annotation_or_schema: None,
                                                sha256: None,
                                                evidence_classification: Some(
                                                    EvidenceClassification::DeclaredSpecification,
                                                ),
                                            }),
                                        })),
                                        EvidenceClassification::DeclaredSpecification,
                                    )
                                }
                            } else {
                                // Concrete AST return type
                                let resolved = self.resolve_type(
                                    &method.return_type,
                                    &mut type_pool,
                                    &cls.file_path,
                                );
                                if let Some(decl) = matching_declared {
                                    if let Some(ref schema) = decl.schema_name {
                                        let unwrapped_simple = unwrapped_return
                                            .rsplit('.')
                                            .next()
                                            .unwrap_or(&unwrapped_return);
                                        let schema_simple =
                                            schema.rsplit('.').next().unwrap_or(schema);
                                        if unwrapped_simple != schema_simple {
                                            // Conflict between AST return and @ApiResponse!
                                            (Some(WireType::Unknown(UnknownWireType {
                                                reason: format!("Evidence conflict: AST return type '{}' differs from declared @ApiResponse schema '{}'", unwrapped_return, schema),
                                                provenance: Some(SourceProvenance {
                                                    language: SourceLanguage::Java,
                                                    file: cls.file_path.clone(),
                                                    line: method.line,
                                                    column: None,
                                                    ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                                    annotation_or_schema: Some(format!("Declared schema: {}", schema)),
                                                    sha256: None,
                                                    evidence_classification: Some(EvidenceClassification::InconclusiveOrConflicting),
                                                }),
                                            })), EvidenceClassification::InconclusiveOrConflicting)
                                        } else {
                                            (
                                                Some(resolved),
                                                EvidenceClassification::ImplementationDerived,
                                            )
                                        }
                                    } else {
                                        (
                                            Some(resolved),
                                            EvidenceClassification::ImplementationDerived,
                                        )
                                    }
                                } else {
                                    (
                                        Some(resolved),
                                        EvidenceClassification::ImplementationDerived,
                                    )
                                }
                            };

                            let declared_responses_val = if method.declared_responses.is_empty() {
                                None
                            } else {
                                Some(
                                    method
                                        .declared_responses
                                        .iter()
                                        .map(|dr| {
                                            let wire_type = dr.schema_name.as_ref().map(|s| {
                                                self.resolve_type(s, &mut type_pool, &cls.file_path)
                                            });
                                            DeclaredResponseEvidence {
                                                status_code: dr.status_code,
                                                schema_name: dr.schema_name.clone(),
                                                media_type: dr.media_type.clone(),
                                                description: dr.description.clone(),
                                                wire_type,
                                            }
                                        })
                                        .collect(),
                                )
                            };

                            let file_hash = self.source_sha256(&cls.file_path);

                            endpoints.push(EndpointContract {
                                identity: EndpointIdentityContract {
                                    service: Some(service_id.to_string()),
                                    http_method: http_verb.clone(),
                                    normalized_route: normalized_route.clone(),
                                    direction: ContractDirection::Response,
                                },
                                path_parameters: path_parameters.clone(),
                                query_parameters: query_parameters.clone(),
                                headers: headers.clone(),
                                body: response_body,
                                provenance: SourceProvenance {
                                    language: SourceLanguage::Java,
                                    file: cls.file_path.clone(),
                                    line: method.line,
                                    column: None,
                                    ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                    annotation_or_schema: None,
                                    sha256: file_hash.clone(),
                                    evidence_classification: Some(evidence_classification),
                                },
                                evidence_classification: Some(evidence_classification),
                                declared_responses: declared_responses_val,
                                status_code_family: Some(status_code_family),
                                mapping_conditions: Some(json!({
                                    "params": mapping_params.clone(),
                                    "complete": mapping_conditions_complete
                                })),
                            });

                            // 2. Request endpoint (if a request body or any caller-supplied
                            // parameter exists)
                            if request_body_type.is_some()
                                || !path_parameters.is_empty()
                                || !query_parameters.is_empty()
                                || !headers.is_empty()
                            {
                                endpoints.push(EndpointContract {
                                    identity: EndpointIdentityContract {
                                        service: Some(service_id.to_string()),
                                        http_method: http_verb.clone(),
                                        normalized_route,
                                        direction: ContractDirection::Request,
                                    },
                                    path_parameters,
                                    query_parameters,
                                    headers,
                                    body: request_body_type,
                                    provenance: SourceProvenance {
                                        language: SourceLanguage::Java,
                                        file: cls.file_path.clone(),
                                        line: method.line,
                                        column: None,
                                        ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                        annotation_or_schema: None,
                                        sha256: file_hash,
                                        evidence_classification: Some(
                                            EvidenceClassification::ImplementationDerived,
                                        ),
                                    },
                                    evidence_classification: Some(
                                        EvidenceClassification::ImplementationDerived,
                                    ),
                                    declared_responses: None,
                                    status_code_family: Some(StatusCodeFamily::Success2xx),
                                    mapping_conditions: Some(json!({
                                        "params": mapping_params.clone(),
                                        "complete": mapping_conditions_complete
                                    })),
                                });
                            }
                        }
                    }
                }
            }
        }

        endpoints.extend(self.dsl_endpoints(service_id, &dsl_routes));

        endpoints.sort_by(|a, b| {
            (
                &a.identity.normalized_route.raw_path,
                &a.identity.http_method,
            )
                .cmp(&(
                    &b.identity.normalized_route.raw_path,
                    &b.identity.http_method,
                ))
        });

        let type_pool_val = if type_pool.is_empty() {
            None
        } else {
            Some(type_pool)
        };

        // Endpoint-level resolution failures are not yet classified by this extractor, so
        // `unresolved_endpoints` stays empty; incompleteness comes from sources that could
        // not be read or parsed, which previously vanished without a trace.
        if let Some(endpoint_root) = &self.endpoint_root {
            for (root, controllers) in &excluded {
                surface_blockers.push(source_blocker(
                    root,
                    "JAVA_ENDPOINT_ROOT_EXCLUDES_MODULE",
                    format!(
                        "{} Spring controller(s) are declared in {}, which is indexed for types but is not the endpoint root of this service ({}); their endpoints are absent from this artifact and a missing endpoint is not evidence that the service does not expose them: {}",
                        controllers.len(),
                        root,
                        if endpoint_root.is_empty() { "." } else { endpoint_root },
                        summarize(controllers)
                    ),
                ));
            }
        }

        let mut blockers = self.source_blockers.clone();
        if self.enable_jax_rs {
            blockers.retain(|b| {
                !(b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED" && b.message.contains("JAX-RS"))
            });
            if jax_rs_base_path.is_some() {
                blockers.retain(|b| b.code != "JAVA_JAXRS_APPLICATION_PATH_UNPARSED");
            }
        }
        blockers.retain(|b| {
            !(b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED"
                && (b.message.contains("OpenFeign")
                    || b.message.contains("Spring HTTP Interface")
                    || b.message.contains("MicroProfile REST Client")))
        });
        blockers.extend(surface_blockers);
        // The product claim is that an empty artifact always says why. A source tree
        // that yields neither endpoints nor a named reason is outside every lane this
        // reader knows, so name that instead of sealing a clean empty contract.
        if endpoints.is_empty() && blockers.is_empty() {
            blockers.push(source_blocker(
                self.endpoint_root.as_deref().unwrap_or("."),
                "JAVA_NO_PROVIDER_EVIDENCE",
                "No provider endpoint was extracted and no file named a reason; this source tree declares no REST framework this reader supports, so emptiness here is not evidence of absence".to_string(),
            ));
        }
        sort_blockers(&mut blockers);
        let completeness = ArtifactCompleteness {
            complete: blockers.is_empty(),
            unresolved_endpoints: Vec::new(),
            blockers,
        };

        let payload = BackendContractPayload {
            serialization_assumptions: None,
            base_urls: if let Some(cp) = &self.context_path {
                vec![cp.clone()]
            } else {
                vec![]
            },
            proxy_prefixes: vec![],
            endpoints,
            type_pool: type_pool_val,
            path_pool: None,
        };

        (payload, completeness)
    }

    fn resolve_parameter(
        &self,
        param: &JavaParamInfo,
        type_pool: &mut BTreeMap<String, WireType>,
        file: &str,
    ) -> WireType {
        if let Some(reason) = &param.unsupported_metadata {
            return WireType::Unknown(UnknownWireType {
                reason: reason.clone(),
                provenance: Some(param.provenance.clone()),
            });
        }
        self.resolve_type_in_direction(
            &param.param_type,
            type_pool,
            file,
            ContractDirection::Request,
        )
    }

    fn resolve_type(
        &self,
        type_str: &str,
        type_pool: &mut BTreeMap<String, WireType>,
        enclosing_file: &str,
    ) -> WireType {
        self.resolve_type_in_direction(
            type_str,
            type_pool,
            enclosing_file,
            ContractDirection::Response,
        )
    }

    fn resolve_type_in_direction(
        &self,
        type_str: &str,
        type_pool: &mut BTreeMap<String, WireType>,
        enclosing_file: &str,
        direction: ContractDirection,
    ) -> WireType {
        let trimmed = type_str.trim();

        if trimmed == "ProblemDetail" || trimmed.ends_with(".ProblemDetail") {
            return problem_detail_wire_type();
        }

        let simple_name = trimmed.rsplit('.').next().unwrap_or(trimmed);
        if simple_name == "ResponseEntity" || simple_name == "HttpEntity" {
            return WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Any,
                format: None,
                provenance: None,
            });
        }

        if trimmed.starts_with("MapWrapper<") && trimmed.ends_with('>') {
            let inner = &trimmed["MapWrapper<".len()..trimmed.len() - 1];
            if let Some((key, val_type)) = inner.split_once(',') {
                let key = key.trim().trim_matches('"');
                let val_type = val_type.trim();
                let val_wire = self.resolve_type_in_direction(
                    val_type,
                    type_pool,
                    enclosing_file,
                    direction.clone(),
                );
                return WireType::Object(ObjectWireType {
                    name: None,
                    properties: vec![WirePropertyContract {
                        wire_name: key.to_string(),
                        aliases: vec![],
                        r#type: val_wire,
                        optional: false,
                        nullable: false,
                        server_assigned: false,
                        validation_constraints: vec![],
                        provenance: None,
                    }],
                    strict: Some(false),
                    provenance: None,
                });
            }
        } else if trimmed.starts_with("MultiMapWrapper<") && trimmed.ends_with('>') {
            let inner = &trimmed["MultiMapWrapper<".len()..trimmed.len() - 1];
            let mut props = Vec::new();
            for part in inner.split(',') {
                if let Some((k, v)) = part.split_once(':') {
                    let key = k.trim().trim_matches('"');
                    let val_type = v.trim();
                    let val_wire = self.resolve_type_in_direction(
                        val_type,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    props.push(WirePropertyContract {
                        wire_name: key.to_string(),
                        aliases: vec![],
                        r#type: val_wire,
                        optional: false,
                        nullable: false,
                        server_assigned: false,
                        validation_constraints: vec![],
                        provenance: None,
                    });
                }
            }
            return WireType::Object(ObjectWireType {
                name: None,
                properties: props,
                strict: Some(false),
                provenance: None,
            });
        }

        // Check primitives / common scalars
        let scalar = scalar_to_wire_type(trimmed);
        if !matches!(scalar, WireType::Unknown(_)) {
            return scalar;
        }

        // Every non-byte Java array is a JSON array. `byte[]` and `Byte[]` never reach here:
        // Jackson writes them as a base64 string, and scalar_to_wire_type already maps them.
        if let Some(element) = trimmed.strip_suffix("[]") {
            let element = element.trim();
            if !element.is_empty() {
                let inner = self.resolve_type_in_direction(
                    element,
                    type_pool,
                    enclosing_file,
                    direction.clone(),
                );
                return WireType::Array(contract_core::ir::ArrayWireType {
                    element_type: Box::new(inner),
                    is_stream_or_flux: Some(false),
                    provenance: None,
                });
            }
        }

        // Generic container matching, e.g. GenericContainer<SampleDto>, ResponseEntity<T>, List<T>
        if let Some((container, generic_arg)) = parse_generic_type(trimmed) {
            let container_simple = container.rsplit('.').next().unwrap_or(container);
            match crate::wire_wrapper::classify(container_simple) {
                Some(crate::wire_wrapper::WrapperClass::Transparent) => {
                    return self.resolve_type_in_direction(
                        generic_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                }
                Some(crate::wire_wrapper::WrapperClass::Stream) => {
                    let inner_wire = self.resolve_type_in_direction(
                        generic_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    return WireType::Array(contract_core::ir::ArrayWireType {
                        element_type: Box::new(inner_wire),
                        is_stream_or_flux: Some(true),
                        provenance: None,
                    });
                }
                Some(crate::wire_wrapper::WrapperClass::Collection) => {
                    let inner_wire = self.resolve_type_in_direction(
                        generic_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    return WireType::Array(contract_core::ir::ArrayWireType {
                        element_type: Box::new(inner_wire),
                        is_stream_or_flux: Some(false),
                        provenance: None,
                    });
                }
                _ => {}
            }
            match container_simple {
                paged @ ("Page" | "Slice" | "PageImpl") => {
                    let inner_wire = self.resolve_type_in_direction(
                        generic_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    let array_wire = WireType::Array(contract_core::ir::ArrayWireType {
                        element_type: Box::new(inner_wire),
                        is_stream_or_flux: Some(false),
                        provenance: None,
                    });
                    let number = || {
                        WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::Number,
                            format: None,
                            provenance: None,
                        })
                    };
                    let boolean = || {
                        WireType::Primitive(PrimitiveWireType {
                            scalar: PrimitiveScalar::Boolean,
                            format: None,
                            provenance: None,
                        })
                    };
                    let prop = |wire_name: &str, r#type: WireType| WirePropertyContract {
                        wire_name: wire_name.to_string(),
                        aliases: vec![],
                        r#type,
                        optional: false,
                        nullable: false,
                        server_assigned: false,
                        validation_constraints: vec![],
                        provenance: None,
                    };
                    // A `Slice` is an uncounted window: Spring Data cannot compute a total for
                    // it, so neither total field reaches the wire. Publishing them here would
                    // let a consumer reading `$.totalElements` be certified against an endpoint
                    // that never emits it.
                    let is_slice = paged == "Slice";
                    let mut props = vec![prop("content", array_wire)];
                    if !is_slice {
                        props.push(prop("totalPages", number()));
                        props.push(prop("totalElements", number()));
                    }
                    props.extend([
                        prop("size", number()),
                        prop("number", number()),
                        prop("first", boolean()),
                        prop("last", boolean()),
                        prop("numberOfElements", number()),
                        prop("empty", boolean()),
                    ]);
                    return WireType::Object(ObjectWireType {
                        name: Some(format!(
                            "{}<{}>",
                            if is_slice { "Slice" } else { "Page" },
                            generic_arg
                        )),
                        properties: props,
                        strict: Some(false),
                        provenance: None,
                    });
                }
                // Spring's MultiValueMap serializes as an object whose values are arrays.
                "MultiValueMap" | "LinkedMultiValueMap" => {
                    let mut parts = generic_arg.splitn(2, ',');
                    let key_arg = parts.next().unwrap_or("String").trim();
                    let val_arg = parts.next().unwrap_or("Object").trim();
                    let key_wire = self.resolve_type_in_direction(
                        key_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    let val_wire = self.resolve_type_in_direction(
                        val_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    return WireType::Map(contract_core::ir::MapWireType {
                        key_type: Box::new(key_wire),
                        value_type: Box::new(WireType::Array(contract_core::ir::ArrayWireType {
                            element_type: Box::new(val_wire),
                            is_stream_or_flux: Some(false),
                            provenance: None,
                        })),
                        provenance: None,
                    });
                }
                "Map" | "HashMap" | "LinkedHashMap" | "TreeMap" | "ConcurrentHashMap"
                | "ConcurrentMap" | "SortedMap" | "NavigableMap" | "EnumMap" | "WeakHashMap"
                | "IdentityHashMap" | "Hashtable" => {
                    let mut parts = generic_arg.splitn(2, ',');
                    let key_arg = parts.next().unwrap_or("String").trim();
                    let val_arg = parts.next().unwrap_or("Object").trim();
                    let key_wire = self.resolve_type_in_direction(
                        key_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    let val_wire = self.resolve_type_in_direction(
                        val_arg,
                        type_pool,
                        enclosing_file,
                        direction.clone(),
                    );
                    return WireType::Map(contract_core::ir::MapWireType {
                        key_type: Box::new(key_wire),
                        value_type: Box::new(val_wire),
                        provenance: None,
                    });
                }
                _ => {}
            }

            if let Some(fqcn) = self.find_class_fqcn(container, enclosing_file) {
                if let Some(cls_info) = self.classes.get(&fqcn) {
                    // `PageResult<UserDto>` binds the declared `T` for every field,
                    // including composed types such as `List<T>` and `Map<String, T>`.
                    let type_bindings = self.bind_type_params_at(
                        &cls_info.type_params,
                        generic_arg,
                        enclosing_file,
                    );
                    let fields =
                        self.collect_class_fields(&fqcn, 0, &mut HashSet::new(), direction.clone());
                    if let Some(declared) =
                        self.jackson_declared_wire(cls_info, type_pool, direction.clone())
                    {
                        return declared;
                    }
                    if let Some(hollow) = hollow_abstraction_wire(cls_info, &fields) {
                        return hollow;
                    }
                    let args = cls_info
                        .type_params
                        .iter()
                        .map(|name| {
                            type_bindings
                                .get(name)
                                .cloned()
                                .unwrap_or_else(|| name.clone())
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    let key = java_type_key(&format!("{}<{}>", fqcn, args), direction.clone());
                    if let Some(existing) = type_pool.get(&key) {
                        if direction == ContractDirection::Response
                            && !matches!(existing, WireType::Unknown(_))
                        {
                            return existing.clone();
                        }
                        return WireType::Ref(RefWireType {
                            r#ref: key,
                            provenance: Some(java_provenance(cls_info, 1)),
                        });
                    }
                    type_pool.insert(
                        key.clone(),
                        inconclusive_class_wire(
                            cls_info,
                            "Recursive generic type is being resolved",
                        ),
                    );
                    let props = match self.build_field_properties(
                        cls_info,
                        &fields,
                        &type_bindings,
                        type_pool,
                        direction.clone(),
                    ) {
                        Ok(props) => props,
                        Err(detail) => {
                            let unknown = inconclusive_class_wire(cls_info, &detail);
                            type_pool.insert(key, unknown.clone());
                            return unknown;
                        }
                    };
                    let object = WireType::Object(ObjectWireType {
                        name: Some(container_simple.to_string()),
                        properties: props,
                        strict: Some(false),
                        provenance: Some(java_provenance(cls_info, 3)),
                    });
                    type_pool.insert(key.clone(), object.clone());
                    return if direction == ContractDirection::Request {
                        WireType::Ref(RefWireType {
                            r#ref: key,
                            provenance: Some(java_provenance(cls_info, 3)),
                        })
                    } else {
                        object
                    };
                }
            }
        }

        // Find DTO class in compilation unit
        if let Some(fqcn) = self.find_class_fqcn(trimmed, enclosing_file) {
            if let Some(cls_info) = self.classes.get(&fqcn) {
                let ref_key = java_type_key(&cls_info.fqcn, direction.clone());

                // A runtime-serialization annotation makes even an enum's wire
                // form unknowable, so this check runs before the enum shortcut.
                let declared_fields =
                    self.collect_class_fields(&fqcn, 0, &mut HashSet::new(), direction.clone());
                if let Some(declared) =
                    self.jackson_declared_wire(cls_info, type_pool, direction.clone())
                {
                    return declared;
                }
                if let Some(hollow) = hollow_abstraction_wire(cls_info, &declared_fields) {
                    return hollow;
                }
                if let Some(map) = self.map_subclass_wire(cls_info, type_pool, direction.clone()) {
                    return map;
                }

                if cls_info.is_enum {
                    if !type_pool.contains_key(&ref_key) {
                        let values: Vec<serde_json::Value> = cls_info
                            .enum_values
                            .iter()
                            .map(|v| serde_json::Value::String(v.clone()))
                            .collect();
                        type_pool.insert(
                            ref_key.clone(),
                            WireType::Enum(contract_core::ir::EnumWireType {
                                name: Some(cls_info.class_name.clone()),
                                values,
                                provenance: Some(SourceProvenance {
                                    language: SourceLanguage::Java,
                                    file: cls_info.file_path.clone(),
                                    line: 1,
                                    column: None,
                                    ast_identity: Some(cls_info.fqcn.clone()),
                                    annotation_or_schema: None,
                                    sha256: None,
                                    evidence_classification: Some(
                                        EvidenceClassification::ImplementationDerived,
                                    ),
                                }),
                            }),
                        );
                    }
                    return WireType::Ref(RefWireType {
                        r#ref: ref_key,
                        provenance: Some(SourceProvenance {
                            language: SourceLanguage::Java,
                            file: cls_info.file_path.clone(),
                            line: 1,
                            column: None,
                            ast_identity: Some(cls_info.fqcn.clone()),
                            annotation_or_schema: None,
                            sha256: None,
                            evidence_classification: Some(
                                EvidenceClassification::ImplementationDerived,
                            ),
                        }),
                    });
                }

                if !type_pool.contains_key(&ref_key) {
                    // Pre-insert an empty object placeholder to break circular reference cycles!
                    type_pool.insert(
                        ref_key.clone(),
                        WireType::Object(ObjectWireType {
                            name: Some(cls_info.class_name.clone()),
                            properties: vec![],
                            strict: Some(false),
                            provenance: Some(SourceProvenance {
                                language: SourceLanguage::Java,
                                file: cls_info.file_path.clone(),
                                line: 5,
                                column: None,
                                ast_identity: Some(cls_info.fqcn.clone()),
                                annotation_or_schema: None,
                                sha256: None,
                                evidence_classification: Some(
                                    EvidenceClassification::ImplementationDerived,
                                ),
                            }),
                        }),
                    );

                    let properties = match self.build_field_properties(
                        cls_info,
                        &declared_fields,
                        &HashMap::new(),
                        type_pool,
                        direction.clone(),
                    ) {
                        Ok(properties) => properties,
                        Err(detail) => {
                            // Replace the placeholder, including for recursive references.
                            let unknown = inconclusive_class_wire(cls_info, &detail);
                            type_pool.insert(ref_key.clone(), unknown.clone());
                            return unknown;
                        }
                    };

                    let object_wire = WireType::Object(ObjectWireType {
                        name: Some(cls_info.class_name.clone()),
                        properties,
                        strict: Some(false),
                        provenance: Some(SourceProvenance {
                            language: SourceLanguage::Java,
                            file: cls_info.file_path.clone(),
                            line: 5,
                            column: None,
                            ast_identity: Some(cls_info.fqcn.clone()),
                            annotation_or_schema: None,
                            sha256: None,
                            evidence_classification: Some(
                                EvidenceClassification::ImplementationDerived,
                            ),
                        }),
                    });

                    type_pool.insert(ref_key.clone(), object_wire);
                }

                return WireType::Ref(RefWireType {
                    r#ref: ref_key,
                    provenance: Some(SourceProvenance {
                        language: SourceLanguage::Java,
                        file: cls_info.file_path.clone(),
                        line: 5,
                        column: None,
                        ast_identity: Some(cls_info.fqcn.clone()),
                        annotation_or_schema: None,
                        sha256: None,
                        evidence_classification: Some(
                            EvidenceClassification::ImplementationDerived,
                        ),
                    }),
                });
            }
        }

        if let Some(jdk) = self.jdk_library_wire(trimmed, enclosing_file) {
            return jdk;
        }

        WireType::Unknown(UnknownWireType {
            reason: format!("Unresolved Java type: {}", trimmed),
            provenance: None,
        })
    }

    /// Wire shapes fixed by the JDK type itself rather than by anything a repository declares.
    /// Consulted only after every project resolution has failed, and only when the referencing
    /// compilation unit proves the written name means the JDK type: the type is fully qualified,
    /// or the file imports that exact FQCN, or it on-demand imports the package declaring it.
    /// Java demands an import for every referenced type outside `java.lang`, so that proof is the
    /// same evidence the compiler already uses - it is not a guess about the repository. A project
    /// that declares its own `TimeUnit` is bound earlier by `find_class_fqcn`, so this table can
    /// never shadow project code.
    ///
    /// The shapes are Jackson's own defaults with the JSR-310 module registered, which is what
    /// `spring-boot-starter-json` ships: a plain enum writes `name()`, and `ZoneIdSerializer`
    /// writes `zone.getId()` unconditionally, so neither entry needs a feature-level assumption.
    /// `Duration` is deliberately absent because its shape is decided by
    /// `WRITE_DURATIONS_AS_TIMESTAMPS`, which a repository can flip and this corpus never sets;
    /// inventing one of the two shapes would manufacture findings either way.
    fn jdk_library_wire(&self, type_str: &str, enclosing_file: &str) -> Option<WireType> {
        let written = type_str.trim();
        let (_, fqcn, shape) = self.proven_jdk_library_type(written, enclosing_file)?;
        let simple = fqcn.rsplit('.').next()?;
        match shape {
            JdkWireShape::EnumOfNames(constants) => {
                Some(WireType::Enum(contract_core::ir::EnumWireType {
                    name: Some(simple.to_string()),
                    values: constants
                        .iter()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .collect(),
                    provenance: None,
                }))
            }
            JdkWireShape::JsonString => Some(WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: None,
                provenance: None,
            })),
        }
    }

    /// True when `enclosing_file` brings `fqcn` into scope by name. A static on-demand import
    /// (`java.util.concurrent.TimeUnit.*`) names constants rather than the type, so it does not
    /// qualify: the prefix it leaves is the type itself, not its package.
    fn file_imports_jdk_type(&self, enclosing_file: &str, fqcn: &str) -> bool {
        let Some(imports) = self.file_imports.get(enclosing_file) else {
            return false;
        };
        imports.iter().any(|import| {
            if import == fqcn {
                return true;
            }
            match import.strip_suffix(".*") {
                Some(pkg) => fqcn
                    .strip_prefix(pkg)
                    .and_then(|rest| rest.get(1..))
                    .map(|member| !member.is_empty() && !member.contains('.'))
                    .unwrap_or(false),
                None => false,
            }
        })
    }

    /// The JDK table entry `written` denotes, but only when the compilation unit proves the name:
    /// it is spelled fully qualified, or the file imports that FQCN or the package declaring it.
    /// Shared by the abstention site and by type-argument binding, so a name carried across files
    /// can never be accepted on weaker evidence than a name written in place.
    fn proven_jdk_library_type(
        &self,
        written: &str,
        enclosing_file: &str,
    ) -> Option<&'static (&'static str, &'static str, JdkWireShape)> {
        let simple = written.rsplit('.').next()?;
        let entry = JDK_WIRE_TYPES.iter().find(|(name, _, _)| *name == simple)?;
        if written != entry.1 && !self.file_imports_jdk_type(enclosing_file, entry.1) {
            return None;
        }
        Some(entry)
    }

    /// Rewrites a bound type argument into a form that needs no second name lookup.
    ///
    /// javac substitutes the *type* a type parameter stands for, not the letters that spelled it,
    /// so the file declaring the generic class must not get to re-read the argument's simple name:
    /// `AlarmConditionValue<AlarmSchedule>` written in a compilation unit that imports
    /// `…rule.condition.schedule.AlarmSchedule` denotes that interface, while the generic class's
    /// own file resolves the same letters to another declaration or to nothing. Fully qualifying
    /// the argument at the use site is how the extractor keeps that binding, and it is the same
    /// rule already applied to inherited *fields* through `JavaFieldInfo::declaring_file`.
    ///
    /// Names that are not proved by the use site keep their text: a scalar, a wildcard, an
    /// unimported library type or another type variable stays exactly as written, so the argument
    /// can only ever become more precise, never a guess.
    fn canonicalize_type_name(&self, arg: &str, use_site_file: &str) -> String {
        let arg = arg.trim();
        if arg.is_empty() || arg == "*" || arg.starts_with('?') {
            return arg.to_string();
        }
        if let Some(element) = arg.strip_suffix("[]") {
            let element = element.trim();
            if !element.is_empty() {
                return format!("{}[]", self.canonicalize_type_name(element, use_site_file));
            }
            return arg.to_string();
        }
        if let Some((container, generic_arg)) = parse_generic_type(arg) {
            let args: Vec<String> = split_generic_args(generic_arg)
                .into_iter()
                .map(|a| self.canonicalize_type_name(a, use_site_file))
                .collect();
            if args.is_empty() {
                return arg.to_string();
            }
            let head = self.canonicalize_type_name(container, use_site_file);
            return format!("{}<{}>", head, args.join(", "));
        }
        if let Some(fqcn) = self.find_class_fqcn(arg, use_site_file) {
            return fqcn;
        }
        if let Some((_, fqcn, _)) = self.proven_jdk_library_type(arg, use_site_file) {
            return fqcn.to_string();
        }
        arg.to_string()
    }

    /// `bind_type_params` reads arguments in the text of the use site; this puts them in the scope
    /// that wrote them.
    fn bind_type_params_at(
        &self,
        params: &[String],
        args_text: &str,
        use_site_file: &str,
    ) -> HashMap<String, String> {
        bind_type_params(params, args_text)
            .into_iter()
            .map(|(param, arg)| {
                let bound = self.canonicalize_type_name(&arg, use_site_file);
                (param, bound)
            })
            .collect()
    }

    /// A class that extends a JDK map carries its content in the entries, not in declared
    /// fields: Jackson's map serializer writes the entries and ignores the bean's own
    /// properties, so the wire shape is the map contract spelled out in the `extends` clause,
    /// read in that clause's own file.
    ///
    /// Two cases are left to the existing behaviour. A declaration whose own annotations hand
    /// the shape to runtime code is inconclusive whether it extends a map or not. And a key or
    /// value that names the subclass again is left alone, because the map form is inlined
    /// rather than interned, so nothing cuts that recursion.
    fn map_subclass_wire(
        &self,
        cls_info: &JavaClassInfo,
        type_pool: &mut BTreeMap<String, WireType>,
        direction: ContractDirection,
    ) -> Option<WireType> {
        if cls_info.unsupported_serialization.is_some() || cls_info.is_enum || cls_info.is_interface
        {
            return None;
        }
        let superclass = cls_info.superclass.as_deref().map(str::trim)?;
        let (container, generic_arg) = parse_generic_type(superclass)?;
        let simple = container.rsplit('.').next().unwrap_or(container);
        if !matches!(
            simple,
            "HashMap"
                | "LinkedHashMap"
                | "TreeMap"
                | "EnumMap"
                | "ConcurrentHashMap"
                | "ConcurrentSkipListMap"
                | "Hashtable"
                | "AbstractMap"
        ) {
            return None;
        }
        let args: Vec<String> = split_generic_args(generic_arg)
            .into_iter()
            .map(|arg| arg.trim().to_string())
            .collect();
        if args.len() != 2 {
            return None;
        }
        for arg in &args {
            if self.canonicalize_type_name(arg, &cls_info.file_path) == cls_info.fqcn {
                return None;
            }
        }
        let key_type = self.resolve_type_in_direction(
            &args[0],
            type_pool,
            &cls_info.file_path,
            direction.clone(),
        );
        let value_type = self.resolve_type_in_direction(
            &args[1],
            type_pool,
            &cls_info.file_path,
            direction.clone(),
        );
        Some(WireType::Map(contract_core::ir::MapWireType {
            key_type: Box::new(key_type),
            value_type: Box::new(value_type),
            provenance: Some(java_provenance(cls_info, 1)),
        }))
    }

    /// Models the Jackson declarations that hand the wire shape to runtime code, but only when
    /// the declaration itself fixes the shape:
    ///
    /// * `@JsonTypeInfo(use = NAME|MINIMAL|CLASS, include = PROPERTY|EXISTING_PROPERTY,
    ///   property = "p")` paired with a complete `@JsonSubTypes` list becomes a union of the
    ///   subtype objects, each carrying the discriminator literal the annotation spells.
    /// * `@JsonSerialize(using = X.class)` becomes the shape X's own `serialize` body writes,
    ///   provided that body only writes literal field names and scalars.
    ///
    /// Every other case keeps the existing abstention. A partial or guessed union would publish
    /// values the server may never send, which is exactly the fabrication the UNKNOWN class
    /// exists to prevent.
    fn jackson_declared_wire(
        &self,
        cls_info: &JavaClassInfo,
        type_pool: &mut BTreeMap<String, WireType>,
        direction: ContractDirection,
    ) -> Option<WireType> {
        if direction == ContractDirection::Request {
            return cls_info
                .unsupported_deserialization
                .as_ref()
                .or(cls_info.unsupported_serialization.as_ref())
                .map(|detail| inconclusive_class_wire(cls_info, detail));
        }
        if cls_info.unsupported_serialization.is_none() {
            return None;
        }
        // A subtype's fields can name the polymorphic base again, and every field resolution
        // re-enters this rule. Without a cut the expansion never terminates.
        let state = JACKSON_MODELLING.with(|set| {
            let mut set = set.borrow_mut();
            if set.contains(&cls_info.fqcn) {
                return JACKSON_RE_ENTERED;
            }
            if set.len() >= JACKSON_MODELLING_DEPTH {
                return JACKSON_DEPTH_CUT;
            }
            set.insert(cls_info.fqcn.clone());
            JACKSON_ENTERED
        });
        if state != JACKSON_ENTERED {
            // Re-entering the base whose arms are still being built is not a failure to find a
            // shape: `@JsonTypeInfo` on a type that names itself (`List<KeyFilterPredicate>`
            // inside a COMPLEX subtype) declares the recursion, and a Jackson parser follows it.
            // Referencing the pool node under construction publishes that recursion, the same way
            // the pool's placeholders already carry ordinary cyclic DTOs. A depth cut is a real
            // truncation and stays the abstention.
            if state == JACKSON_RE_ENTERED {
                let key = polymorphic_union_key(&cls_info.fqcn);
                if type_pool.contains_key(&key) {
                    return Some(WireType::Ref(RefWireType {
                        r#ref: key,
                        provenance: Some(java_provenance(cls_info, 1)),
                    }));
                }
            }
            return None;
        }
        let out = self
            .polymorphic_subtype_wire(cls_info, type_pool, direction.clone())
            .or_else(|| self.custom_serializer_wire(cls_info, type_pool));
        JACKSON_MODELLING.with(|set| {
            set.borrow_mut().remove(&cls_info.fqcn);
        });
        out
    }

    fn polymorphic_subtype_wire(
        &self,
        cls_info: &JavaClassInfo,
        type_pool: &mut BTreeMap<String, WireType>,
        direction: ContractDirection,
    ) -> Option<WireType> {
        let info = cls_info.json_type_info.as_ref()?;
        if cls_info.json_sub_types.is_empty() {
            return None;
        }
        if !matches!(info.use_id.as_str(), "NAME" | "MINIMAL" | "CLASS") {
            return None;
        }
        if !matches!(info.include.as_str(), "PROPERTY" | "EXISTING_PROPERTY") {
            return None;
        }
        // Without an explicit property name the discriminator's wire name is Jackson's own
        // default, which is not evidence in this repository. Refuse to name a field the
        // producer might not emit.
        let property = info.property.clone()?;
        // Reserve the base's pool entry before reading a single arm. A subtype that names the base
        // back resolves this rule while the union is still under construction, and `jackson_
        // declared_wire` hands it this node to point at. The reservation is the honest abstention,
        // so an arm list that turns out not to be enumerable leaves a reference to evidence rather
        // than to a name that is not in the pool; on success the union replaces it below.
        let union_key = polymorphic_union_key(&cls_info.fqcn);
        if !type_pool.contains_key(&union_key) {
            let abstention = hollow_abstraction_wire(cls_info, &[]).unwrap_or_else(|| {
                WireType::Unknown(UnknownWireType {
                    reason: format!(
                        "UNSUPPORTED_CONSTRUCT: {} is a polymorphic type whose subtypes are not enumerable from source",
                        cls_info.fqcn
                    ),
                    provenance: Some(java_provenance(cls_info, 1)),
                })
            });
            type_pool.insert(union_key.clone(), abstention);
        }
        let mut arms: Vec<WireType> = Vec::new();
        for sub in &cls_info.json_sub_types {
            let fqcn = self.find_class_fqcn(&sub.type_name, &cls_info.file_path)?;
            let sub_info = self.classes.get(&fqcn)?;
            // A subtype that itself delegates its shape to runtime code would need this rule
            // applied again; one unresolved arm makes the whole union inconclusive rather than
            // silently short.
            if sub_info.unsupported_serialization.is_some() {
                return None;
            }
            let token = match info.use_id.as_str() {
                "CLASS" => fqcn.clone(),
                // `Id.NAME`/`Id.MINIMAL` fall back to the simple class name when the annotation
                // omits `name`, which is the substitution Jackson itself performs.
                _ => sub.token.clone().unwrap_or_else(|| sub.type_name.clone()),
            };
            let fields =
                self.collect_class_fields(&fqcn, 0, &mut HashSet::new(), direction.clone());
            if let Some(hollow) = hollow_abstraction_wire(sub_info, &fields) {
                arms.push(hollow);
                continue;
            }
            let bindings = bind_type_params(&sub_info.type_params, "");
            let props = match self.build_field_properties(
                sub_info,
                &fields,
                &bindings,
                type_pool,
                direction.clone(),
            ) {
                Ok(props) => props,
                Err(_) => return None,
            };
            // `include = PROPERTY` means Jackson writes the discriminator name once, and the
            // annotation says what it holds. A subtype that also exposes a member of that name -
            // a `getType()` beside `@JsonTypeInfo(property = "type")`, which is the usual ThingsBoard
            // shape - would otherwise publish two properties with one wire name: a malformed object,
            // a position counted twice, and an enum reference that contradicts its own literal arm.
            let props: Vec<WirePropertyContract> = props
                .into_iter()
                .filter(|candidate| candidate.wire_name != property)
                .collect();
            let properties = vec![WirePropertyContract {
                wire_name: property.clone(),
                aliases: vec![],
                r#type: WireType::Literal(LiteralWireType {
                    value: json!(token),
                    provenance: None,
                }),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: Some(java_provenance(cls_info, 1)),
            }];
            let mut properties = properties;
            properties.extend(props);
            let arm = WireType::Object(ObjectWireType {
                name: Some(sub_info.class_name.clone()),
                properties,
                strict: Some(false),
                provenance: Some(java_provenance(sub_info, 1)),
            });
            // Intern each arm once per (subtype, discriminator) pair. A polymorphic base used by
            // hundreds of endpoints would otherwise inline every arm at every call site, and the
            // artifact would grow with use count rather than with declared shape.
            let key = format!("java:{}#subtype#{}", sub_info.fqcn, token);
            if !type_pool.contains_key(&key) {
                type_pool.insert(key.clone(), arm);
            }
            arms.push(WireType::Ref(RefWireType {
                r#ref: key,
                provenance: Some(java_provenance(sub_info, 1)),
            }));
        }
        let union = WireType::Union(UnionWireType {
            types: arms,
            provenance: Some(java_provenance(cls_info, 1)),
        });
        // Every enumerable arm is known, so the reserved node becomes the union the recursive
        // subtypes already point at. Interning the base also keeps a polymorphic type used by
        // hundreds of endpoints from inlining the same union at each of them.
        type_pool.insert(union_key.clone(), union);
        Some(WireType::Ref(RefWireType {
            r#ref: union_key,
            provenance: Some(java_provenance(cls_info, 1)),
        }))
    }

    /// A class whose `serialize` method writes a fixed field set or a single scalar does fix its
    /// wire shape, and the evidence is the serializer's own body in this repository.
    fn custom_serializer_wire(
        &self,
        cls_info: &JavaClassInfo,
        type_pool: &mut BTreeMap<String, WireType>,
    ) -> Option<WireType> {
        let name = cls_info.json_serialize_using.as_ref()?;
        let fqcn = self.find_class_fqcn(name, &cls_info.file_path)?;
        let serializer = self.classes.get(&fqcn)?;
        let body = serializer.serializer_body.as_deref()?;
        let shape = serializer_wire_from_body(body)?;
        // A serializer decides one shape no matter how many endpoints reference the type, so
        // composite results are interned and only scalars stay inline.
        if matches!(
            shape,
            WireType::Object(_) | WireType::Array(_) | WireType::Map(_)
        ) {
            let key = format!("java:{}#serialized", cls_info.fqcn);
            if !type_pool.contains_key(&key) {
                type_pool.insert(key.clone(), shape);
            }
            return Some(WireType::Ref(RefWireType {
                r#ref: key,
                provenance: Some(java_provenance(cls_info, 1)),
            }));
        }
        Some(shape)
    }

    fn find_class_fqcn(&self, name: &str, enclosing_file: &str) -> Option<String> {
        if self.classes.contains_key(name) {
            return Some(name.to_string());
        }
        let simple = name.rsplit('.').next().unwrap_or(name);

        // The declaration in the referencing compilation unit wins, exactly as
        // Java resolves its own top-level and nested types first.
        let mut same_file: Vec<&String> = self
            .classes
            .values()
            .filter(|c| c.file_path == enclosing_file && c.class_name == simple)
            .map(|c| &c.fqcn)
            .collect();
        if same_file.len() == 1 {
            return Some(same_file.remove(0).clone());
        }
        if !same_file.is_empty() {
            return None;
        }

        // A single-type import names the declaration unambiguously.
        if let Some(imports) = self.file_imports.get(enclosing_file) {
            for import in imports.iter().filter(|i| !i.ends_with(".*")) {
                if import.rsplit('.').next() == Some(simple) && self.classes.contains_key(import) {
                    return Some(import.clone());
                }
            }
            // Wildcard imports are a candidate set, not an answer.
            let wildcard_hits: Vec<String> = imports
                .iter()
                .filter(|i| i.ends_with(".*"))
                .map(|i| format!("{}.{}", i.trim_end_matches(".*"), simple))
                .filter(|fqcn| self.classes.contains_key(fqcn))
                .collect();
            if wildcard_hits.len() == 1 {
                return wildcard_hits.into_iter().next();
            }
            if wildcard_hits.len() > 1 {
                return None;
            }
        }

        // Types in the same package are visible without an import.
        if let Some(package) = self.file_packages.get(enclosing_file) {
            let same_package = if package.is_empty() {
                simple.to_string()
            } else {
                format!("{}.{}", package, simple)
            };
            if self.classes.contains_key(&same_package) {
                return Some(same_package);
            }
        }

        if let Some(candidates) = self.classes_by_simple.get(simple) {
            if candidates.len() == 1 {
                return candidates.first().cloned();
            }
            return None;
        }

        let candidates = self.nested_by_simple.get(simple)?;
        if candidates.len() == 1 {
            return candidates.first().cloned();
        }
        let in_enclosing_file = |fqcn: &&String| {
            self.classes
                .get(*fqcn)
                .map(|c| c.file_path == enclosing_file)
                .unwrap_or(false)
        };
        let mut matches = candidates.iter().filter(in_enclosing_file);
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(first.clone())
    }

    pub fn resolve_composed_mapping(
        &self,
        ann_name: &str,
        file_path: &str,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> Result<Option<ComposedMappingInfo>, String> {
        if depth > 10 {
            return Err(format!(
                "Exceeded maximum depth resolving composed annotation @{}",
                ann_name
            ));
        }
        if !visited.insert(ann_name.to_string()) {
            return Err(format!(
                "Circular composed annotation reference detected at @{}",
                ann_name
            ));
        }

        let simple_name = ann_name.split('.').last().unwrap_or(ann_name);
        let target_fqcn = match self.find_class_fqcn(simple_name, file_path) {
            Some(fqcn) => fqcn,
            None => {
                if let Some(candidates) = self.classes_by_simple.get(simple_name) {
                    if candidates.len() > 1 {
                        return Err(format!("Ambiguous composed annotation @{}: multiple declarations exist across repository", ann_name));
                    }
                }
                return Ok(None);
            }
        };

        let cls = match self.classes.get(&target_fqcn) {
            Some(c) => c,
            None => return Ok(None),
        };

        if !cls.is_annotation {
            return Ok(None);
        }

        if let Some(mapping) = &cls.composed_mapping {
            if !mapping.http_methods.is_empty() {
                return Ok(Some(mapping.clone()));
            }
            for meta in &mapping.meta_annotations {
                if matches!(
                    meta.as_str(),
                    "Target" | "Retention" | "Documented" | "Inherited"
                ) {
                    continue;
                }
                match self.resolve_composed_mapping(meta, &cls.file_path, visited, depth + 1)? {
                    Some(parent) => {
                        let mut combined = parent;
                        combined.base_paths.extend(mapping.base_paths.clone());
                        combined.params.extend(mapping.params.clone());
                        combined.conditions_complete &= mapping.conditions_complete;
                        combined.declares_condition_attribute |=
                            mapping.declares_condition_attribute;
                        combined.path_unresolved |= mapping.path_unresolved;
                        return Ok(Some(combined));
                    }
                    None => {}
                }
            }
            return Err(format!("Composed annotation @{} declares meta-annotations ({}) that do not resolve to an HTTP mapping", ann_name, mapping.meta_annotations.join(", ")));
        }

        Ok(None)
    }

    /// Resolve a type-level annotation through its meta-annotation chain to a Spring
    /// controller stereotype. `@RestController`, `@Controller`, the advice variants, and
    /// `@RequestMapping` all count, matching what a direct annotation on the class means.
    fn resolve_composed_controller(
        &self,
        ann_name: &str,
        file_path: &str,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> Result<Option<ComposedControllerInfo>, String> {
        if depth > 10 {
            return Err(format!(
                "Exceeded maximum depth resolving composed annotation @{}",
                ann_name
            ));
        }
        if !visited.insert(ann_name.to_string()) {
            return Err(format!(
                "Circular composed annotation reference detected at @{}",
                ann_name
            ));
        }

        let simple_name = ann_name.split('.').last().unwrap_or(ann_name);
        let target_fqcn = match self.find_class_fqcn(simple_name, file_path) {
            Some(fqcn) => fqcn,
            None => {
                if let Some(candidates) = self.classes_by_simple.get(simple_name) {
                    if candidates.len() > 1 {
                        return Err(format!(
                            "Ambiguous composed annotation @{}: multiple declarations exist across repository",
                            ann_name
                        ));
                    }
                }
                return Ok(None);
            }
        };

        let cls = match self.classes.get(&target_fqcn) {
            Some(c) if c.is_annotation => c,
            _ => return Ok(None),
        };
        let Some(mapping) = &cls.composed_mapping else {
            return Ok(None);
        };

        let mut base_paths = mapping.base_paths.clone();
        let class_mapping_params = mapping.params.clone();
        let conditions_complete =
            mapping.conditions_complete && !mapping.declares_condition_attribute;
        let path_unresolved = mapping.path_unresolved;
        for meta in &mapping.meta_annotations {
            match meta.as_str() {
                "RestController" | "Controller" => {
                    return Ok(Some(ComposedControllerInfo {
                        base_paths,
                        advice: false,
                        class_mapping_params,
                        conditions_complete,
                        path_unresolved,
                    }))
                }
                "RestControllerAdvice" | "ControllerAdvice" => {
                    return Ok(Some(ComposedControllerInfo {
                        base_paths,
                        advice: true,
                        class_mapping_params,
                        conditions_complete,
                        path_unresolved,
                    }))
                }
                "RequestMapping" => {
                    return Ok(Some(ComposedControllerInfo {
                        base_paths,
                        advice: false,
                        class_mapping_params,
                        conditions_complete,
                        path_unresolved,
                    }))
                }
                "Target" | "Retention" | "Documented" | "Inherited" => {}
                _ => {
                    if let Some(parent) =
                        self.resolve_composed_controller(meta, &cls.file_path, visited, depth + 1)?
                    {
                        base_paths.extend(parent.base_paths);
                        return Ok(Some(ComposedControllerInfo {
                            base_paths,
                            advice: parent.advice,
                            class_mapping_params,
                            conditions_complete: conditions_complete && parent.conditions_complete,
                            path_unresolved: path_unresolved || parent.path_unresolved,
                        }));
                    }
                }
            }
        }

        Ok(None)
    }

    /// A controller whose stereotype comes from a composed annotation is only visible
    /// after the whole repository is indexed. Unknown annotations that cannot plausibly
    /// be controllers are ignored; controller- or mapping-shaped ones, and chains that
    /// cannot be resolved, become blockers instead of silent omissions.
    fn resolve_class_level_controller(
        &self,
        cls: &JavaClassInfo,
        surface_blockers: &mut Vec<ArtifactBlocker>,
    ) -> (bool, bool, Vec<String>, Vec<String>, bool, bool) {
        let mut controller = false;
        let mut advice = false;
        let mut paths: Vec<String> = Vec::new();
        let mut class_mapping_params: Vec<String> = Vec::new();
        let mut conditions_complete = true;
        let mut path_unresolved = false;

        for ann in &cls.custom_annotations {
            let mut visited = HashSet::new();
            match self.resolve_composed_controller(&ann.name, &cls.file_path, &mut visited, 0) {
                Ok(Some(info)) => {
                    controller = true;
                    advice |= info.advice;
                    for param in &info.class_mapping_params {
                        if !class_mapping_params.contains(param) {
                            class_mapping_params.push(param.clone());
                        }
                    }
                    conditions_complete &= info.conditions_complete;
                    path_unresolved |= info.path_unresolved || ann.paths_unresolved;
                    let ann_paths = if ann.paths.is_empty() {
                        info.base_paths
                    } else {
                        ann.paths.clone()
                    };
                    for path in ann_paths {
                        if !paths.contains(&path) {
                            paths.push(path);
                        }
                    }
                }
                Ok(None) => {
                    if likely_controller_annotation_name(&ann.name) {
                        surface_blockers.push(source_blocker(
                            &cls.file_path,
                            "JAVA_UNSUPPORTED_COMPOSED_MAPPING",
                            format!(
                                "Type {} is annotated with @{}, which is not declared among the parsed sources, so it cannot be proven whether the type is a controller; any endpoints it declares are absent from this artifact",
                                cls.fqcn, ann.name
                            ),
                        ));
                    }
                }
                Err(err) => {
                    surface_blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_UNSUPPORTED_COMPOSED_MAPPING",
                        format!(
                            "Type {} uses composed annotation @{} which could not be resolved: {}",
                            cls.fqcn, ann.name, err
                        ),
                    ));
                }
            }
        }

        (
            controller,
            advice,
            paths,
            class_mapping_params,
            conditions_complete,
            path_unresolved,
        )
    }

    fn collect_class_fields(
        &self,
        fqcn: &str,
        depth: usize,
        visited: &mut HashSet<String>,
        direction: ContractDirection,
    ) -> Vec<JavaFieldInfo> {
        if depth > 8 || !visited.insert(fqcn.to_string()) {
            return Vec::new();
        }
        let cls_info = match self.classes.get(fqcn) {
            Some(c) => c,
            None => return Vec::new(),
        };

        let mut all_fields = Vec::new();
        if let Some(ref sc) = cls_info.superclass {
            let (parent_name, generic_arg) = if let Some(open) = sc.find('<') {
                let close = sc.rfind('>').unwrap_or(sc.len());
                (sc[..open].trim(), Some(sc[open + 1..close].trim()))
            } else {
                (sc.trim(), None)
            };

            if let Some(parent_fqcn) = self.find_class_fqcn(parent_name, &cls_info.file_path) {
                let mut parent_fields =
                    self.collect_class_fields(&parent_fqcn, depth + 1, visited, direction.clone());
                if let Some(g_arg) = generic_arg {
                    let parent_params = self
                        .classes
                        .get(&parent_fqcn)
                        .map(|c| c.type_params.clone())
                        .unwrap_or_default();
                    if !parent_params.is_empty() {
                        // The `extends Base<X>` clause is written in this class's file, so `X`
                        // means what this file says it means, not what the parent's file reads.
                        let bindings =
                            self.bind_type_params_at(&parent_params, g_arg, &cls_info.file_path);
                        for pf in &mut parent_fields {
                            pf.field_type = substitute_type_params(&pf.field_type, &bindings);
                            pf.input_type = pf
                                .input_type
                                .as_ref()
                                .map(|t| substitute_type_params(t, &bindings));
                        }
                    }
                }
                all_fields.extend(parent_fields);
            }
        }

        for field in &cls_info.fields {
            let mut field = field.clone();
            // This class's own members are written in this class's file; members inherited from a
            // parent already carry the parent's file, and an override replaces both the field and
            // its scope.
            field.declaring_file = cls_info.file_path.clone();
            if let Some(pos) = all_fields.iter().position(|f| f.name == field.name) {
                all_fields[pos] = field;
            } else {
                all_fields.push(field);
            }
        }

        if depth == 0 {
            let mut ignore_rules = Vec::new();
            let mut current = Some(cls_info);
            let mut seen = HashSet::new();
            while let Some(class) = current {
                if !seen.insert(class.fqcn.clone()) || seen.len() > 9 {
                    break;
                }
                ignore_rules.push(class);
                current = class.superclass.as_ref().and_then(|parent| {
                    let name = parse_generic_type(parent)
                        .map(|(name, _)| name)
                        .unwrap_or(parent);
                    self.find_class_fqcn(name, &class.file_path)
                        .and_then(|fqcn| self.classes.get(&fqcn))
                });
            }
            all_fields.retain(|field| {
                let raw_name = apply_accessor_prefix(&field.name, &cls_info.accessor_prefixes);
                let wire_name = field
                    .json_property
                    .clone()
                    .unwrap_or_else(|| self.naming_strategy.apply(&raw_name));
                ignore_rules.iter().all(|class| {
                    if !class.ignored_properties.contains(&wire_name) {
                        return true;
                    }
                    match direction {
                        ContractDirection::Response => {
                            class.ignored_properties_allow_getters.contains(&wire_name)
                        }
                        ContractDirection::Request => {
                            class.ignored_properties_allow_setters.contains(&wire_name)
                        }
                    }
                })
            });
        }

        all_fields
    }

    fn build_field_properties(
        &self,
        cls_info: &JavaClassInfo,
        fields: &[JavaFieldInfo],
        type_bindings: &HashMap<String, String>,
        type_pool: &mut BTreeMap<String, WireType>,
        direction: ContractDirection,
    ) -> Result<Vec<WirePropertyContract>, String> {
        let mut properties: Vec<WirePropertyContract> = Vec::new();
        for field in fields {
            if let Some(detail) = &field.unsupported_metadata {
                return Err(detail.clone());
            }
            // Jackson binds a property from *any* accessor, and `@JsonIgnore` removes only the
            // accessor it annotates - unless no accessor is explicitly annotated, in which case
            // the ignore is hard and the property disappears from both directions. Both branches
            // were measured against a real ObjectMapper.
            let any_ignore = field.is_json_ignored || field.ignored_output || field.ignored_input;
            let split = field.explicit_reader || field.explicit_writer;
            if any_ignore && !split {
                continue;
            }
            let field_ok = !field.is_json_ignored;
            let readable = (field.field_readable && field_ok)
                || (field.getter_present && !field.ignored_output);
            // A surviving getter also lets Jackson bind input through the backing field it reads.
            let writable = (field.field_writable && field_ok)
                || (field.setter_present && !field.ignored_input)
                || (field.getter_present
                    && !field.ignored_output
                    && field.has_backing_field
                    && field_ok);
            let visible = match direction {
                ContractDirection::Response => {
                    readable && field.jackson_access != JacksonAccess::WriteOnly
                }
                ContractDirection::Request => {
                    writable && field.jackson_access != JacksonAccess::ReadOnly
                }
            };
            if !visible {
                continue;
            }
            if direction == ContractDirection::Request {
                if let Some(detail) = &field.unsupported_input_validation {
                    return Err(detail.clone());
                }
            }
            let raw_name = apply_accessor_prefix(&field.name, &cls_info.accessor_prefixes);
            let wire_name = field
                .json_property
                .clone()
                .unwrap_or_else(|| self.naming_strategy.apply(&raw_name));

            let member_type = if direction == ContractDirection::Request {
                field.input_type.as_deref().unwrap_or(&field.field_type)
            } else {
                field.field_type.as_str()
            };
            let substituted = substitute_type_params(member_type, type_bindings);
            // Bind the written type in the scope of the compilation unit that declares the member.
            // For an inherited field that is the parent's file, which is where its imports are.
            let scope = if field.declaring_file.is_empty() {
                cls_info.file_path.as_str()
            } else {
                field.declaring_file.as_str()
            };
            let property_type =
                self.resolve_type_in_direction(&substituted, type_pool, scope, direction.clone());

            if field.is_unwrapped {
                let unwrapped =
                    unwrapped_object_properties(&property_type, type_pool).map_err(|detail| {
                        format!(
                            "Unresolved @JsonUnwrapped target `{} {}`: {}",
                            field.field_type, field.name, detail
                        )
                    })?;
                for mut property in unwrapped {
                    property.provenance = Some(SourceProvenance {
                        language: SourceLanguage::Java,
                        file: scope.to_string(),
                        line: field.line,
                        column: None,
                        ast_identity: Some(format!("{}.{}", cls_info.fqcn, field.name)),
                        annotation_or_schema: None,
                        sha256: None,
                        evidence_classification: Some(
                            EvidenceClassification::ImplementationDerived,
                        ),
                    });
                    upsert_property(&mut properties, property);
                }
                continue;
            }

            let is_primitive = matches!(
                member_type,
                "boolean" | "int" | "long" | "float" | "double" | "short" | "byte"
            );
            let mut constraints = field.validation_constraints.clone();
            if direction == ContractDirection::Request {
                constraints.extend(field.input_validation_constraints.clone());
            }
            let nullable = if direction == ContractDirection::Request {
                validation_nullability(&constraints)
                    .or(field.is_nullable)
                    .unwrap_or(!is_primitive)
            } else {
                field.is_nullable.unwrap_or(!is_primitive)
            };

            upsert_property(
                &mut properties,
                WirePropertyContract {
                    wire_name,
                    aliases: field.json_aliases.clone(),
                    r#type: property_type,
                    optional: false,
                    nullable,
                    server_assigned: field.is_server_assigned,
                    validation_constraints: constraints,
                    provenance: Some(SourceProvenance {
                        language: SourceLanguage::Java,
                        file: scope.to_string(),
                        line: field.line,
                        column: None,
                        ast_identity: Some(format!("{}.{}", cls_info.fqcn, field.name)),
                        annotation_or_schema: None,
                        sha256: None,
                        evidence_classification: Some(
                            EvidenceClassification::ImplementationDerived,
                        ),
                    }),
                },
            );
        }
        Ok(properties)
    }

    /// SHA-256 of the source text that produced these facts. In blob mode the
    /// hash is taken from the captured object, never from a working-tree file
    /// that may since have moved.
    fn source_sha256(&self, rel_path: &str) -> Option<String> {
        if let Some(blobs) = &self.blobs {
            let content = blobs.get(rel_path)?;
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            return Some(hex::encode(hasher.finalize()));
        }
        compute_file_sha256(&self.repo_root.join(rel_path))
    }

    pub fn build_envelope(
        &self,
        service_id: &str,
        api_version: Option<&str>,
        candidate_snapshot: &str,
    ) -> Result<ContractArtifactEnvelope> {
        self.build_envelope_bound(
            service_id,
            api_version,
            "git-root:native",
            "HEAD",
            candidate_snapshot,
        )
    }

    /// `build_envelope` with the snapshot identity supplied by the caller, for
    /// revisions that are not the working tree. The default form keeps the
    /// historical `git-root:native` / `HEAD` placeholders byte-identical.
    pub fn build_envelope_bound(
        &self,
        service_id: &str,
        api_version: Option<&str>,
        repository_id: &str,
        parent_commit: &str,
        candidate_snapshot: &str,
    ) -> Result<ContractArtifactEnvelope> {
        let (payload, completeness) = self.extract_payload(service_id);

        let mut env = ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::BackendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: repository_id.to_string(),
                service_id: service_id.to_string(),
                api_version: api_version.map(|v| v.to_string()),
                parent_commit: parent_commit.to_string(),
                candidate_snapshot: candidate_snapshot.to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: Some(self.detected_framework_profile()),
                codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
                client_profile: None,
                config_fingerprint: Some(self.config_fingerprint.clone()),
            },
            completeness,
            payload: contract_core::envelope::ArtifactPayload::Backend(payload),
            integrity: None,
            signature: None,
            issued_at_unix: None,
            raw_value: None,
        };

        let digest = compute_envelope_digest(&env)
            .map_err(|e| anyhow!("Failed to compute envelope digest: {}", e))?;
        env.integrity = Some(ArtifactIntegrity { sha256: digest });

        Ok(env)
    }

    pub fn extract_client_payload(
        &self,
        _service_id: &str,
        default_target_service_id: &str,
    ) -> (FrontendContractPayload, ArtifactCompleteness) {
        let mut client_contracts = Vec::new();
        let mut type_pool: BTreeMap<String, WireType> = BTreeMap::new();
        let mut blockers: Vec<ArtifactBlocker> = Vec::new();

        let mut class_keys: Vec<&String> = self.classes.keys().collect();
        class_keys.sort();

        for class_key in &class_keys {
            let cls = &self.classes[*class_key];
            if !cls.is_interface || !cls.is_client_interface || !self.class_in_scope(&cls.file_path)
            {
                continue;
            }
            if cls.class_path_unresolved {
                blockers.push(source_blocker(
                    &cls.file_path,
                    "JAVA_CLIENT_MAPPING_UNRESOLVED",
                    format!(
                        "{} declares a class-level client path this reader cannot resolve; its endpoints are absent from this artifact",
                        cls.fqcn
                    ),
                ));
                continue;
            }
            let target_svc = cls
                .client_target_service
                .as_deref()
                .unwrap_or(default_target_service_id)
                .to_string();

            let class_paths = if cls.class_paths.is_empty() {
                vec!["".to_string()]
            } else {
                cls.class_paths.clone()
            };

            for method in &cls.methods {
                if let Some(reason) = &method.unmodeled_mapping {
                    blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_CLIENT_MAPPING_UNRESOLVED",
                        format!(
                            "{}#{} {}. The client method's endpoint is absent from this artifact and its emptiness is not evidence that the client does not call it",
                            cls.fqcn, method.name, reason
                        ),
                    ));
                    continue;
                }
                if method.path_unresolved {
                    blockers.push(source_blocker(
                        &cls.file_path,
                        "JAVA_CLIENT_MAPPING_UNRESOLVED",
                        format!(
                            "{}#{} declares a client path this reader cannot resolve; the endpoint is absent from this artifact",
                            cls.fqcn, method.name
                        ),
                    ));
                    continue;
                }
                if !method.is_mapped || method.http_methods.is_empty() {
                    continue;
                }
                let method_paths = if method.paths.is_empty() {
                    vec!["".to_string()]
                } else {
                    method.paths.clone()
                };

                let mut request_body_type = None;
                for param in &method.parameters {
                    if param.is_request_body {
                        request_body_type =
                            Some(self.resolve_parameter(param, &mut type_pool, &cls.file_path));
                        break;
                    }
                }

                let unwrapped_return = unwrap_generic_wrapper(&method.return_type);
                let expected_response = if unwrapped_return == "void" || unwrapped_return == "Void"
                {
                    WireType::Primitive(PrimitiveWireType {
                        scalar: PrimitiveScalar::Any,
                        format: None,
                        provenance: None,
                    })
                } else {
                    self.resolve_type(&unwrapped_return, &mut type_pool, &cls.file_path)
                };

                for verb in &method.http_methods {
                    for prefix in &class_paths {
                        for subpath in &method_paths {
                            let mut full_path = combine_spring_routes(prefix, subpath);
                            if !full_path.starts_with('/') {
                                full_path = format!("/{full_path}");
                            }
                            let normalized_route = normalize_route_segments(&full_path);

                            client_contracts.push(FrontendClientContract {
                                target_service_id: Some(target_svc.clone()),
                                target_api_version: None,
                                source_sha256: None,
                                consumer_traversal_complete: Some(true),
                                http_method: verb.clone(),
                                normalized_route: normalized_route.raw_path,
                                request_body: request_body_type.clone(),
                                expected_response: expected_response.clone(),
                                decoder_kind: DecoderKind::TypeAssertion,
                                consumers: vec![ConsumerLocation {
                                    file: cls.file_path.clone(),
                                    line: method.line,
                                    column: None,
                                    usage: format!("{}.{}", cls.fqcn, method.name),
                                }],
                                unresolved_evidence: vec![],
                                observed_response: None,
                                observed_request_body: None,
                                source_file: cls.file_path.clone(),
                                source_line: method.line,
                            });
                        }
                    }
                }
            }
        }

        for class_key in &class_keys {
            let cls = &self.classes[*class_key];
            if !self.class_in_scope(&cls.file_path) {
                continue;
            }
            // Imperative clients: the receiver's declared field type decides whether a
            // recorded call is RestTemplate/WebClient/RestClient traffic.
            let field_types: HashMap<String, String> = cls
                .fields
                .iter()
                .map(|field| (field.name.clone(), field.field_type.clone()))
                .collect();
            for method in &cls.methods {
                for call in &method.client_calls {
                    if call.kind == JavaClientKind::SdkWrapper {
                        let receiver = call
                            .receiver
                            .trim()
                            .trim_start_matches("this.")
                            .rsplit('.')
                            .next()
                            .unwrap_or("")
                            .trim();
                        let receiver_type = method
                            .local_types
                            .get(receiver)
                            .cloned()
                            .or_else(|| self.field_type_in_hierarchy(cls, receiver, 4));
                        let Some(field_type) = receiver_type else {
                            continue;
                        };
                        if !self.wrapper_uses_http_client(&field_type) {
                            continue;
                        }
                    }
                    if call.kind == JavaClientKind::Field {
                        let receiver = call
                            .receiver
                            .trim()
                            .trim_start_matches("this.")
                            .rsplit('.')
                            .next()
                            .unwrap_or("")
                            .trim();
                        let receiver_type = method
                            .local_types
                            .get(receiver)
                            .cloned()
                            .or_else(|| field_types.get(receiver).cloned());
                        let Some(field_type) = receiver_type else {
                            continue;
                        };
                        let full_type = field_type.as_str();
                        let simple_type = full_type
                            .split('<')
                            .next()
                            .unwrap_or(full_type)
                            .trim()
                            .rsplit('.')
                            .next()
                            .unwrap_or(full_type)
                            .trim();
                        if !matches!(simple_type, "RestTemplate" | "WebClient" | "RestClient") {
                            continue;
                        }
                    }
                    if let Some(reason) = &call.unresolved {
                        blockers.push(source_blocker(
                            &cls.file_path,
                            "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED",
                            format!(
                            "{}#{} line {}: {reason}; the client call is absent from this artifact",
                            cls.fqcn, method.name, call.line
                        ),
                        ));
                        continue;
                    }
                    let Some(url) = &call.url else {
                        continue;
                    };
                    let route = if url.starts_with('/') || url.starts_with("http") {
                        url.clone()
                    } else {
                        format!("/{url}")
                    };
                    let normalized_route = normalize_route_segments(&route);
                    let expected_response = call
                        .response_type
                        .as_ref()
                        .map(|response_type| {
                            self.resolve_type(response_type, &mut type_pool, &cls.file_path)
                        })
                        .unwrap_or_else(|| {
                            WireType::Unknown(UnknownWireType {
                                reason: "Imperative client response type is not declared"
                                    .to_string(),
                                provenance: Some(SourceProvenance {
                                    language: SourceLanguage::Java,
                                    file: cls.file_path.clone(),
                                    line: call.line,
                                    column: None,
                                    ast_identity: Some(format!("{}#{}", cls.fqcn, method.name)),
                                    annotation_or_schema: None,
                                    sha256: None,
                                    evidence_classification: None,
                                }),
                            })
                        });
                    let request_body = call.request_body_type.as_ref().map(|body_type| {
                        self.resolve_type(body_type, &mut type_pool, &cls.file_path)
                    });
                    client_contracts.push(FrontendClientContract {
                        target_service_id: Some(default_target_service_id.to_string()),
                        target_api_version: None,
                        source_sha256: None,
                        consumer_traversal_complete: Some(true),
                        http_method: call.http_method.clone(),
                        normalized_route: normalized_route.raw_path,
                        request_body,
                        expected_response,
                        decoder_kind: DecoderKind::TypeAssertion,
                        consumers: vec![ConsumerLocation {
                            file: cls.file_path.clone(),
                            line: call.line,
                            column: None,
                            usage: format!(
                                "{}.{} -> {} {}",
                                cls.fqcn, method.name, call.http_method, url
                            ),
                        }],
                        unresolved_evidence: vec![],
                        observed_response: None,
                        observed_request_body: None,
                        source_file: cls.file_path.clone(),
                        source_line: call.line,
                    });
                }
            }
        }

        // A generated wrapper whose call sites this reader did not recognize must not
        // leave an empty, complete client artifact. Name the gap instead.
        if client_contracts.is_empty() {
            let mut wrapper_file: Option<String> = None;
            let mut marker_file: Option<String> = None;
            for cls in self.classes.values() {
                if !self.class_in_scope(&cls.file_path) {
                    continue;
                }
                if wrapper_file.is_none() && self.wrapper_uses_http_client(&cls.class_name) {
                    wrapper_file = Some(cls.file_path.clone());
                }
                if marker_file.is_none()
                    && self.file_content(&cls.file_path).is_some_and(|content| {
                        [
                            "invokeAPI(",
                            ".buildCall(",
                            ".prepareRequest(",
                            "memberVarHttpClient.send(",
                        ]
                        .iter()
                        .any(|needle| content.contains(needle))
                    })
                {
                    marker_file = Some(cls.file_path.clone());
                }
            }
            if let (Some(wrapper_file), Some(marker_file)) = (wrapper_file, marker_file) {
                blockers.push(source_blocker(
                    &marker_file,
                    "JAVA_HTTP_CLIENT_UNRECOGNIZED",
                    format!(
                        "an HTTP-client wrapper in {wrapper_file} is present but no call site with a literal URL was recognized; its client calls are absent from this artifact"
                    ),
                ));
            }
        }

        sort_blockers(&mut blockers);
        let payload = FrontendContractPayload {
            dependency_context: None,
            interceptor_evidence: None,
            client_contracts,
            type_pool: if type_pool.is_empty() {
                None
            } else {
                Some(type_pool)
            },
            path_pool: None,
        };
        let completeness = ArtifactCompleteness {
            complete: blockers.is_empty(),
            unresolved_endpoints: vec![],
            blockers,
        };
        (payload, completeness)
    }

    pub fn build_client_envelope(
        &self,
        service_id: &str,
        target_service_id: &str,
        candidate_snapshot: &str,
    ) -> Result<ContractArtifactEnvelope> {
        let (payload, completeness) = self.extract_client_payload(service_id, target_service_id);

        let mut env = ContractArtifactEnvelope {
            envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::FrontendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: "git-root:native".to_string(),
                service_id: service_id.to_string(),
                api_version: None,
                parent_commit: "HEAD".to_string(),
                candidate_snapshot: candidate_snapshot.to_string(),
                deployment_id: None,
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "0.1.0".to_string(),
                framework_profile: Some("OPENFEIGN".to_string()),
                codec_profile: Some("JACKSON_DEFAULT_V1".to_string()),
                client_profile: Some("JAVA_HTTP_CLIENT".to_string()),
                config_fingerprint: Some(self.config_fingerprint.clone()),
            },
            completeness,
            payload: ArtifactPayload::Frontend(payload),
            integrity: None,
            signature: None,
            issued_at_unix: None,
            raw_value: None,
        };

        let digest = compute_envelope_digest(&env)
            .map_err(|e| anyhow!("Failed to compute envelope digest: {}", e))?;
        env.integrity = Some(ArtifactIntegrity { sha256: digest });

        Ok(env)
    }
}

// ---------------------------------------------------------------------------
// Tree-Sitter Java Parsing Helpers
// ---------------------------------------------------------------------------

fn parse_compilation_unit(
    root: Node,
    source: &str,
    file_path: &str,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
) -> Vec<JavaClassInfo> {
    let mut package_name = String::new();
    let mut classes = Vec::new();

    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "package_declaration" {
            let mut pkg_cursor = child.walk();
            for pkg_child in child.children(&mut pkg_cursor) {
                if matches!(pkg_child.kind(), "identifier" | "scoped_identifier") {
                    package_name = node_text(pkg_child, source);
                    break;
                }
            }
        } else if is_type_declaration(child.kind()) {
            if child.kind() == "enum_declaration" {
                if let Some(en) = parse_enum(child, source, &package_name, file_path) {
                    collect_nested_types(
                        child,
                        source,
                        &package_name,
                        file_path,
                        &en.fqcn,
                        &mut classes,
                        constants,
                        service_methods,
                        disk_path,
                    );
                    classes.push(en);
                }
            } else if let Some(cls) = parse_class(
                child,
                source,
                &package_name,
                file_path,
                constants,
                service_methods,
                disk_path,
            ) {
                collect_nested_types(
                    child,
                    source,
                    &package_name,
                    file_path,
                    &cls.fqcn,
                    &mut classes,
                    constants,
                    service_methods,
                    disk_path,
                );
                classes.push(cls);
            }
        }
    }

    classes
}

fn is_type_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration"
            | "record_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "annotation_type_declaration"
    )
}

/// Types declared inside another type are addressable and Jackson-serializable
/// whether or not they carry `static` (an inner class is flattened the same way),
/// so every nested declaration is indexed under `Outer.Inner`. The recursion
/// continues through non-indexed scopes so `Outer.Inner.Leaf` keeps a valid FQCN.
fn collect_nested_types<'a>(
    node: Node<'a>,
    source: &str,
    package_name: &str,
    file_path: &str,
    outer_fqcn: &str,
    out: &mut Vec<JavaClassInfo>,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
) {
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for type_node in type_declarations_in_body(body) {
        let Some(name_node) = type_node.child_by_field_name("name") else {
            continue;
        };
        let nested_fqcn = format!("{}.{}", outer_fqcn, node_text(name_node, source));
        let parsed = if type_node.kind() == "enum_declaration" {
            parse_enum_qualified(type_node, source, package_name, file_path, Some(outer_fqcn))
        } else {
            parse_class_qualified(
                type_node,
                source,
                package_name,
                file_path,
                Some(outer_fqcn),
                constants,
                service_methods,
                disk_path,
            )
        };
        if let Some(cls) = parsed {
            out.push(cls);
        }
        collect_nested_types(
            type_node,
            source,
            package_name,
            file_path,
            &nested_fqcn,
            out,
            constants,
            service_methods,
            disk_path,
        );
    }
}

fn type_declarations_in_body<'a>(body: Node<'a>) -> Vec<Node<'a>> {
    let mut declarations = Vec::new();
    if body.kind() == "enum_body" {
        // Enum constants and declarations share `enum_body`; only the
        // `enum_body_declarations` child can contain type declarations.
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            if child.kind() != "enum_body_declarations" {
                continue;
            }
            let mut inner = child.walk();
            for decl in child.children(&mut inner) {
                if is_type_declaration(decl.kind()) {
                    declarations.push(decl);
                }
            }
        }
        return declarations;
    }
    let mut cursor = body.walk();
    for child in body.children(&mut cursor) {
        if is_type_declaration(child.kind()) {
            declarations.push(child);
        }
    }
    declarations
}

fn parse_type_params(node: Node, source: &str) -> Vec<String> {
    let Some(params) = node.child_by_field_name("type_parameters") else {
        return Vec::new();
    };
    let mut names = Vec::new();
    let mut cursor = params.walk();
    for child in params.children(&mut cursor) {
        if child.kind() != "type_parameter" {
            continue;
        }
        let mut inner = child.walk();
        for part in child.children(&mut inner) {
            if part.kind() == "type_identifier" {
                names.push(node_text(part, source).to_string());
                break;
            }
        }
    }
    names
}

fn parse_class(
    node: Node,
    source: &str,
    package_name: &str,
    file_path: &str,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
) -> Option<JavaClassInfo> {
    parse_class_qualified(
        node,
        source,
        package_name,
        file_path,
        None,
        constants,
        service_methods,
        disk_path,
    )
}

fn parse_class_qualified(
    node: Node,
    source: &str,
    package_name: &str,
    file_path: &str,
    outer_fqcn: Option<&str>,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
) -> Option<JavaClassInfo> {
    let name_node = node.child_by_field_name("name")?;
    let class_name = node_text(name_node, source);
    let fqcn = match outer_fqcn {
        Some(outer) => format!("{}.{}", outer, class_name),
        None if package_name.is_empty() => class_name.clone(),
        None => format!("{}.{}", package_name, class_name),
    };
    let type_params = parse_type_params(node, source);

    let mut is_controller = false;
    let mut is_controller_advice = false;
    let mut class_paths = Vec::new();
    let mut class_path_unresolved = false;
    let mut class_mapping_params = Vec::new();
    let mut class_mapping_conditions_complete = true;
    let mut accessor_prefixes = Vec::new();
    let mut class_lombok_getters = false;
    let mut class_getter_suppressed = false;
    let mut ignored_properties = Vec::new();
    let mut ignored_properties_allow_getters = Vec::new();
    let mut ignored_properties_allow_setters = Vec::new();
    let mut unsupported_deserialization =
        unsupported_deserialization_marker(node, source, file_path);
    let mut unsupported_serialization =
        unsupported_serialization_marker(node, source, file_path, false);
    let mut json_type_info = None;
    let mut json_sub_types = Vec::new();
    let mut json_serialize_using = None;
    let mut serializer_body = None;
    let mut custom_annotations = Vec::new();

    let is_interface = node.kind() == "interface_declaration";
    let is_annotation = node.kind() == "annotation_type_declaration";
    let composed_mapping = if is_annotation {
        parse_composed_mapping(node, source, constants)
    } else {
        None
    };
    let mut is_abstract = false;
    let mut is_jax_rs = false;
    let mut jax_rs_application_path = None;
    let mut is_client_interface = false;
    let mut client_target_service = None;
    {
        let mut mod_cursor = node.walk();
        for child in node.children(&mut mod_cursor) {
            if child.kind() == "modifiers" {
                is_abstract = node_text(child, source)
                    .split_whitespace()
                    .any(|word| word == "abstract");
            }
        }
    }

    for child in collect_annotations(node) {
        let name = extract_annotation_name(child, source);
        if name == "RestController" {
            is_controller = true;
        } else if name == "Controller" {
            is_controller = true;
            if source.contains("io.micronaut.") {
                let extracted = annotation_paths(child, source, constants);
                class_paths.extend(extracted.paths);
                class_path_unresolved |= extracted.unresolved;
            }
        } else if name == "RestControllerAdvice" || name == "ControllerAdvice" {
            is_controller = true;
            is_controller_advice = true;
        } else if name == "RequestMapping" {
            is_controller = true;
            let extracted = annotation_paths(child, source, constants);
            class_paths.extend(extracted.paths);
            class_path_unresolved |= extracted.unresolved;
            let (params, complete) = parse_mapping_conditions(child, source);
            class_mapping_params.extend(params);
            class_mapping_conditions_complete &= complete;
        } else if name == "Path" || name.ends_with(".Path") {
            is_jax_rs = true;
            let extracted = annotation_paths(child, source, constants);
            class_paths.extend(extracted.paths);
            class_path_unresolved |= extracted.unresolved;
        } else if name == "ApplicationPath" {
            let extracted = annotation_paths(child, source, constants);
            if !extracted.unresolved {
                if let Some(path) = extracted.paths.into_iter().next() {
                    if !path.is_empty() {
                        jax_rs_application_path = Some(path);
                    }
                }
            }
        } else if name == "FeignClient" || name.ends_with(".FeignClient") {
            is_client_interface = true;
            if let Some(target) = annotation_arg_string(child, source, "name")
                .or_else(|| annotation_arg_string(child, source, "value"))
            {
                client_target_service = Some(target);
            }
            if let Some(path) = annotation_arg_string(child, source, "path") {
                if !path.is_empty() {
                    class_paths.push(path);
                }
            }
        } else if name == "HttpExchange" || name.ends_with(".HttpExchange") {
            if is_interface {
                is_client_interface = true;
            }
            if let Some(path) = annotation_arg_string(child, source, "value")
                .or_else(|| annotation_arg_string(child, source, "url"))
            {
                if !path.is_empty() {
                    class_paths.push(path);
                }
            }
        } else if name == "RegisterRestClient" || name.ends_with(".RegisterRestClient") {
            is_client_interface = true;
            if let Some(target) = annotation_arg_string(child, source, "configKey") {
                client_target_service = Some(target);
            }
        } else if name == "Data" || name == "Value" || name == "Getter" {
            if name == "Getter" && node_text(child, source).contains("NONE") {
                class_getter_suppressed = true;
            } else {
                class_lombok_getters = true;
            }
        } else if name == "JsonIgnoreProperties" {
            let mut names = Vec::new();
            if let Some(value) = annotation_arg_node(child, source, "value") {
                extract_paths_from_value(value, source, &mut names);
                let invalid = if value.kind() == "element_value_array_initializer" {
                    let mut cursor = value.walk();
                    let invalid = value.named_children(&mut cursor).any(|n| {
                        !matches!(
                            n.kind(),
                            "string_literal" | "line_comment" | "block_comment"
                        )
                    });
                    invalid
                } else {
                    value.kind() != "string_literal"
                };
                if invalid {
                    let marker = unsupported_annotation(child, source, file_path);
                    unsupported_serialization = Some(marker.clone());
                    unsupported_deserialization = Some(marker);
                }
            }
            if extract_annotation_bool_arg(child, source, "allowGetters") == Some(true) {
                ignored_properties_allow_getters.extend(names.clone());
            }
            if extract_annotation_bool_arg(child, source, "allowSetters") == Some(true) {
                ignored_properties_allow_setters.extend(names.clone());
            }
            ignored_properties.extend(names);
            for key in ["allowGetters", "allowSetters"] {
                if extract_annotation_named_arg(child, source, key).is_some()
                    && extract_annotation_bool_arg(child, source, key).is_none()
                {
                    let marker = unsupported_annotation(child, source, file_path);
                    unsupported_serialization = Some(marker.clone());
                    unsupported_deserialization = Some(marker);
                }
            }
        } else if name == "JsonTypeInfo" {
            json_type_info = parse_json_type_info(child, source);
        } else if name == "JsonSubTypes" {
            json_sub_types = parse_json_sub_types(child, source);
        } else if name == "JsonSerialize" {
            // Only `using` is modelled. A `converter` composes two serializers and the
            // framework decides the result, so the declaration alone is inconclusive.
            json_serialize_using = extract_annotation_named_arg(child, source, "using")
                .map(|v| {
                    let v = v.trim().trim_end_matches(".class").trim().to_string();
                    v.rsplit('.').next().unwrap_or(&v).to_string()
                })
                .filter(|v| !v.is_empty());
        } else if name == "Accessors" {
            if let Some(prefix_val) = extract_annotation_named_arg(child, source, "prefix")
                .or_else(|| extract_annotation_value(child, source))
            {
                let clean = prefix_val.trim_matches(|c| c == '{' || c == '}' || c == '"');
                for p in clean.split(',') {
                    let p_trimmed = p.trim().trim_matches('"');
                    if !p_trimmed.is_empty() {
                        accessor_prefixes.push(p_trimmed.to_string());
                    }
                }
            }
        } else {
            let extracted = annotation_paths(child, source, constants);
            custom_annotations.push(JavaCustomAnnotationUsage {
                name,
                paths: extracted.paths,
                paths_unresolved: extracted.unresolved,
                line: child.start_position().row as u32 + 1,
            });
        }
    }

    let superclass = node.child_by_field_name("superclass").map(|sc| {
        let t = node_text(sc, source);
        t.trim_start_matches("extends").trim().to_string()
    });

    let mut methods = Vec::new();
    let mut fields = Vec::new();
    let mut getter_properties = Vec::new();

    // Java 17 records: components are public properties by definition, and
    // Jackson annotations placed on a component apply to the generated member.
    if node.kind() == "record_declaration" {
        if let Some(params_node) = node.child_by_field_name("parameters") {
            let mut cursor = params_node.walk();
            for child in params_node.children(&mut cursor) {
                if child.kind() == "formal_parameter" {
                    if let Some((name, param_type, line)) = parse_record_component(child, source) {
                        let (
                            json_property,
                            json_aliases,
                            is_json_ignored,
                            is_unwrapped,
                            is_nullable,
                        ) = record_component_annotations(child, source, constants);
                        if unsupported_serialization.is_none() {
                            unsupported_serialization =
                                unsupported_serialization_marker(child, source, file_path, true);
                        }
                        if unsupported_deserialization.is_none() {
                            unsupported_deserialization =
                                unsupported_deserialization_marker(child, source, file_path);
                        }
                        let (jackson_access, explicit_access, access_error) =
                            parse_jackson_access(child, source, file_path);
                        let (validation_constraints, validation_error) =
                            parse_validation(child, source, file_path, constants);
                        let record_explicit = collect_annotations(child).iter().any(|&ann| {
                            matches!(
                                extract_annotation_name(ann, source).as_str(),
                                "JsonProperty" | "JsonGetter"
                            )
                        });
                        let record_setter = collect_annotations(child)
                            .iter()
                            .any(|&ann| extract_annotation_name(ann, source) == "JsonSetter");
                        fields.push(JavaFieldInfo {
                            name,
                            input_type: Some(param_type.clone()),
                            field_type: param_type,
                            line,
                            json_property,
                            explicit_property: record_explicit,
                            is_json_ignored,
                            field_readable: true,
                            field_writable: true,
                            getter_present: false,
                            setter_present: false,
                            ignored_output: false,
                            ignored_input: false,
                            explicit_reader: record_explicit,
                            explicit_writer: record_explicit || record_setter,
                            is_serialized: true,
                            is_deserialized: true,
                            has_backing_field: true,
                            jackson_access,
                            explicit_access,
                            is_server_assigned: false,
                            validation_constraints,
                            input_validation_constraints: Vec::new(),
                            unsupported_metadata: access_error.or_else(|| {
                                member_annotation_error(child, source, file_path, constants)
                            }),
                            unsupported_input_validation: validation_error,
                            is_unwrapped,
                            has_getter: false,
                            is_nullable,
                            json_aliases,
                            declaring_file: String::new(),
                        });
                    }
                }
            }
        }
    }

    if let Some(body) = node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            match child.kind() {
                "method_declaration" => {
                    if unsupported_serialization.is_none() {
                        unsupported_serialization =
                            unsupported_serialization_marker(child, source, file_path, true);
                    }
                    // A hand-written serializer decides the wire shape by what it writes, so
                    // its method body is the only evidence of the produced form.
                    if serializer_body.is_none()
                        && superclass
                            .as_deref()
                            .is_some_and(|sc| sc.replace(' ', "").contains("JsonSerializer"))
                        && method_declaration_name(child, source).as_deref() == Some("serialize")
                    {
                        serializer_body = Some(node_text(child, source).to_string());
                    }
                    if unsupported_deserialization.is_none() {
                        unsupported_deserialization =
                            unsupported_deserialization_marker(child, source, file_path);
                    }
                    if let Some(prop) = parse_getter_property(child, source, file_path, constants) {
                        getter_properties.push(prop);
                    }
                    if let Some(prop) = parse_setter_property(child, source, file_path, constants) {
                        getter_properties.push(prop);
                    }
                    if let Some(method) = parse_method(
                        child,
                        source,
                        file_path,
                        constants,
                        service_methods,
                        disk_path,
                        is_jax_rs || is_client_interface,
                    ) {
                        methods.push(method);
                    }
                }
                "field_declaration" => {
                    if unsupported_serialization.is_none() {
                        unsupported_serialization =
                            unsupported_serialization_marker(child, source, file_path, true);
                    }
                    if unsupported_deserialization.is_none() {
                        unsupported_deserialization =
                            unsupported_deserialization_marker(child, source, file_path);
                    }
                    fields.extend(parse_fields(
                        child,
                        source,
                        file_path,
                        class_lombok_getters && !class_getter_suppressed,
                        constants,
                    ));
                }
                _ => {}
            }
        }
    }
    apply_getter_properties(&mut fields, getter_properties);
    let is_reactive_routes = methods.iter().any(|method| method.is_reactive_route);

    // A Retrofit service or a plain Feign interface is an interface whose methods carry
    // verb annotations; neither has a class-level marker equivalent to @FeignClient.
    let is_client_interface = is_client_interface
        || (is_interface
            && (source.contains("retrofit2.") || source.contains("feign."))
            && methods.iter().any(|method| method.is_mapped));

    Some(JavaClassInfo {
        file_path: file_path.to_string(),
        package_name: package_name.to_string(),
        class_name,
        fqcn,
        is_controller,
        is_controller_advice,
        is_enum: false,
        is_interface,
        is_abstract,
        is_jax_rs,
        is_reactive_routes,
        jax_rs_application_path,
        is_client_interface,
        client_target_service,
        is_nested: outer_fqcn.is_some(),
        type_params,
        enum_values: vec![],
        string_constants: collect_static_string_constants(node, source),
        superclass,
        implemented: collect_implemented_interfaces(node, source),
        accessor_prefixes,
        class_paths,
        class_path_unresolved,
        class_mapping_params,
        class_mapping_conditions_complete,
        ignored_properties,
        ignored_properties_allow_getters,
        ignored_properties_allow_setters,
        unsupported_deserialization,
        unsupported_serialization,
        json_type_info,
        json_sub_types,
        json_serialize_using,
        serializer_body,
        is_annotation,
        composed_mapping,
        custom_annotations,
        methods,
        fields,
    })
}

/// Implemented type names, captured even though no edge to their declarations is
/// followed. A controller can inherit its whole HTTP surface from an interface that
/// lives outside the scanned tree, and that has to be visible in the artifact.
fn collect_implemented_interfaces(node: Node, source: &str) -> Vec<String> {
    let Some(interfaces) = node.child_by_field_name("interfaces") else {
        return Vec::new();
    };
    let mut names = Vec::new();
    {
        let mut cursor = interfaces.walk();
        for child in interfaces.children(&mut cursor) {
            if child.kind() != "type_list" {
                push_interface_name(child, source, &mut names);
                continue;
            }
            // Grammar revisions differ on whether the list is inline or wrapped.
            let mut inner = child.walk();
            for ty in child.children(&mut inner) {
                push_interface_name(ty, source, &mut names);
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

fn push_interface_name(node: Node, source: &str, names: &mut Vec<String>) {
    if !matches!(
        node.kind(),
        "type_identifier" | "generic_type" | "scoped_type_identifier"
    ) {
        return;
    }
    let text = node_text(node, source);
    let name = text.split('<').next().unwrap_or(&text).trim().to_string();
    if !name.is_empty() {
        names.push(name);
    }
}

fn parse_enum(
    node: Node,
    source: &str,
    package_name: &str,
    file_path: &str,
) -> Option<JavaClassInfo> {
    parse_enum_qualified(node, source, package_name, file_path, None)
}

fn parse_enum_qualified(
    node: Node,
    source: &str,
    package_name: &str,
    file_path: &str,
    outer_fqcn: Option<&str>,
) -> Option<JavaClassInfo> {
    let name_node = node.child_by_field_name("name")?;
    let class_name = node_text(name_node, source);
    let fqcn = match outer_fqcn {
        Some(outer) => format!("{}.{}", outer, class_name),
        None if package_name.is_empty() => class_name.clone(),
        None => format!("{}.{}", package_name, class_name),
    };

    let mut enum_values = Vec::new();
    let mut unsupported_serialization =
        unsupported_serialization_marker(node, source, file_path, false);
    if let Some(body) = node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            if child.kind() == "enum_constant" {
                if let Some(c_name_node) = child.child_by_field_name("name") {
                    enum_values.push(node_text(c_name_node, source));
                }
            } else if child.kind() == "enum_body_declarations"
                && unsupported_serialization.is_none()
            {
                let mut decl_cursor = child.walk();
                for declaration in child.children(&mut decl_cursor) {
                    if matches!(
                        declaration.kind(),
                        "method_declaration" | "field_declaration"
                    ) {
                        unsupported_serialization =
                            unsupported_serialization_marker(declaration, source, file_path, true);
                        if unsupported_serialization.is_some() {
                            break;
                        }
                    }
                }
            }
        }
    }

    Some(JavaClassInfo {
        file_path: file_path.to_string(),
        package_name: package_name.to_string(),
        class_name,
        fqcn,
        is_controller: false,
        is_controller_advice: false,
        is_enum: true,
        is_interface: false,
        is_abstract: false,
        is_jax_rs: false,
        is_reactive_routes: false,
        jax_rs_application_path: None,
        is_client_interface: false,
        client_target_service: None,
        is_nested: outer_fqcn.is_some(),
        type_params: vec![],
        enum_values,
        string_constants: collect_static_string_constants(node, source),
        superclass: None,
        implemented: Vec::new(),
        accessor_prefixes: vec![],
        class_paths: vec![],
        class_path_unresolved: false,
        class_mapping_params: vec![],
        class_mapping_conditions_complete: true,
        ignored_properties: vec![],
        ignored_properties_allow_getters: vec![],
        ignored_properties_allow_setters: vec![],
        unsupported_deserialization: unsupported_deserialization_marker(node, source, file_path),
        unsupported_serialization,
        json_type_info: None,
        json_sub_types: Vec::new(),
        json_serialize_using: None,
        serializer_body: None,
        is_annotation: false,
        composed_mapping: None,
        custom_annotations: vec![],
        methods: vec![],
        fields: vec![],
    })
}

fn parse_method(
    node: Node,
    source: &str,
    file_path: &str,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
    implicit_body: bool,
) -> Option<JavaMethodInfo> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source);
    let return_type_node = node.child_by_field_name("type")?;
    let return_type = node_text(return_type_node, source);
    let line = node.start_position().row as u32 + 1;

    let mut is_mapped = false;
    let mut is_exception_handler = false;
    let mut status_code = None;
    let mut declared_responses = Vec::new();
    let mut http_methods = Vec::new();
    let mut paths = Vec::new();
    let mut mapping_params = Vec::new();
    let mut mapping_conditions_complete = true;
    let mut unmodeled_mapping = None;
    let mut path_unresolved = false;
    let mut is_reactive_route = false;
    let mut custom_annotations = Vec::new();
    let mut client_calls = Vec::new();

    for child in collect_annotations(node) {
        let ann_name = extract_annotation_name(child, source);
        let mut is_mapping_annotation = true;
        let extracted = annotation_paths(child, source, constants);
        let extracted_paths = extracted.paths.clone();
        let (verbs, ann_paths) = match ann_name.as_str() {
            "GetMapping" => (vec!["GET".to_string()], extracted_paths),
            "PostMapping" => (vec!["POST".to_string()], extracted_paths),
            "PutMapping" => (vec!["PUT".to_string()], extracted_paths),
            "DeleteMapping" => (vec!["DELETE".to_string()], extracted_paths),
            "PatchMapping" => (vec!["PATCH".to_string()], extracted_paths),
            "RequestMapping" => {
                match extract_request_mapping_methods(child, source) {
                    // A server controller with no `method` condition matches every verb. A
                    // client method must choose one, and which verb the client sends is not
                    // written down, so publishing all seven would invent six calls.
                    Ok(_) if implicit_body && !annotation_has_arg(child, source, "method") => {
                        unmodeled_mapping = Some(
                            "@RequestMapping on a client method declares no HTTP method"
                                .to_string(),
                        );
                        (Vec::new(), extracted_paths)
                    }
                    Ok(verbs) => (verbs, extracted_paths),
                    Err(reason) => {
                        unmodeled_mapping = Some(format!("@RequestMapping {reason}"));
                        (Vec::new(), extracted_paths)
                    }
                }
            }
            "GetExchange" => (vec!["GET".to_string()], extracted_paths),
            "PostExchange" => (vec!["POST".to_string()], extracted_paths),
            "PutExchange" => (vec!["PUT".to_string()], extracted_paths),
            "DeleteExchange" => (vec!["DELETE".to_string()], extracted_paths),
            "PatchExchange" => (vec!["PATCH".to_string()], extracted_paths),
            "HttpExchange" => (Vec::new(), extracted_paths),
            "Get" => (vec!["GET".to_string()], extracted_paths),
            "Post" => (vec!["POST".to_string()], extracted_paths),
            "Put" => (vec!["PUT".to_string()], extracted_paths),
            "Delete" => (vec!["DELETE".to_string()], extracted_paths),
            "Patch" => (vec!["PATCH".to_string()], extracted_paths),
            "Head" => (vec!["HEAD".to_string()], extracted_paths),
            "Options" => (vec!["OPTIONS".to_string()], extracted_paths),
            "GET" => (vec!["GET".to_string()], extracted_paths),
            "POST" => (vec!["POST".to_string()], extracted_paths),
            "PUT" => (vec!["PUT".to_string()], extracted_paths),
            "DELETE" => (vec!["DELETE".to_string()], extracted_paths),
            "PATCH" => (vec!["PATCH".to_string()], extracted_paths),
            "HEAD" => (vec!["HEAD".to_string()], extracted_paths),
            "OPTIONS" => (vec!["OPTIONS".to_string()], extracted_paths),
            "Route" => {
                is_reactive_route = true;
                match quarkus_route_methods(child, source) {
                    Ok(verbs) => (verbs, extracted_paths),
                    Err(reason) => {
                        unmodeled_mapping = Some(format!("@Route {reason}"));
                        (Vec::new(), extracted_paths)
                    }
                }
            }
            "Path" => (Vec::new(), extracted_paths),
            "RequestLine" => match parse_request_line(child, source) {
                Ok((verb, path)) => (vec![verb], vec![path]),
                Err(reason) => {
                    unmodeled_mapping = Some(format!("@RequestLine {reason}"));
                    (Vec::new(), vec![])
                }
            },
            "ExceptionHandler" => {
                is_exception_handler = true;
                is_mapping_annotation = false;
                (Vec::new(), vec![])
            }
            "ResponseStatus" => {
                status_code = extract_response_status(child, source);
                is_mapping_annotation = false;
                (Vec::new(), vec![])
            }
            "ApiResponse" | "ApiResponses" | "Operation" => {
                extract_declared_responses(child, source, &mut declared_responses);
                is_mapping_annotation = false;
                (Vec::new(), vec![])
            }
            _ => {
                custom_annotations.push(JavaCustomAnnotationUsage {
                    name: ann_name.clone(),
                    paths: extracted.paths.clone(),
                    paths_unresolved: extracted.unresolved,
                    line: child.start_position().row as u32 + 1,
                });
                is_mapping_annotation = false;
                (Vec::new(), vec![])
            }
        };

        if !ann_paths.is_empty() {
            paths.extend(ann_paths);
        }
        if is_mapping_annotation || ann_name == "Path" {
            path_unresolved |= extracted.unresolved;
        }
        if is_mapping_annotation {
            let (params, complete) = parse_mapping_conditions(child, source);
            mapping_params.extend(params);
            mapping_conditions_complete &= complete;
        }
        if !verbs.is_empty() {
            is_mapped = true;
            http_methods.extend(verbs);
        }
    }
    http_methods.sort();
    http_methods.dedup();

    if is_mapped && paths.is_empty() {
        paths.push("".to_string());
    }

    let mut parameters = Vec::new();
    if let Some(params_node) = node.child_by_field_name("parameters") {
        let mut cursor = params_node.walk();
        for child in params_node.children(&mut cursor) {
            if child.kind() == "formal_parameter" {
                if let Some(param) = parse_parameter(child, source, file_path, constants) {
                    parameters.push(param);
                }
            }
        }
    }

    let mut unmodeled_parameters = Vec::new();
    for param in &parameters {
        if let Some(reason) = &param.unmodeled {
            unmodeled_parameters.push(format!(
                "`{} {}` ({})",
                param.param_type, param.name, reason
            ));
        }
    }

    // An unannotated entity parameter is a body only where the framework's own binding rules
    // say so: JAX-RS resources and declarative client interfaces. In Spring MVC an unannotated
    // complex parameter is a model attribute, and an unannotated simple one is a request
    // parameter; promoting either to a JSON body fabricates a wire shape the handler never had.
    if implicit_body
        && is_mapped
        && http_methods
            .iter()
            .any(|v| v == "POST" || v == "PUT" || v == "PATCH")
        && !parameters.iter().any(|p| p.is_request_body)
    {
        for param in &mut parameters {
            if !param.is_path_variable
                && !param.is_request_param
                && !param.is_request_header
                && !param.is_context
                && param.paging_kind.is_none()
                && param.unmodeled.is_none()
            {
                param.is_request_body = true;
                break;
            }
        }
    }

    if !implicit_body {
        for param in &mut parameters {
            if param.is_path_variable
                || param.is_request_body
                || param.is_request_param
                || param.is_request_header
                || param.is_context
                || param.paging_kind.is_some()
                || param.unmodeled.is_some()
            {
                continue;
            }
            if is_simple_spring_param_type(&param.param_type) {
                param.is_request_param = true;
            } else {
                let reason = "an unannotated complex parameter binds as a model attribute; its query/form fields are not modeled";
                param.unmodeled = Some(reason.to_string());
                unmodeled_parameters.push(format!(
                    "`{} {}` ({})",
                    param.param_type, param.name, reason
                ));
            }
        }
    }

    let mut local_types = HashMap::new();
    if let Some(body) = node.child_by_field_name("body") {
        let local_strings = crate::def_use::fold_locals(body, source, &|name| {
            lookup_constant_text(name, constants)
        });
        local_types = collect_local_variable_types(body, source);
        client_calls =
            collect_java_client_calls(body, source, &parameters, constants, &local_strings);
    }

    let actual_path = disk_path.unwrap_or(file_path);
    let return_type = if is_generic_or_raw_response_entity(&return_type) {
        if let Some(body_node) = node.child_by_field_name("body") {
            if let Some(inferred) = infer_response_entity_payload(
                node,
                body_node,
                source,
                &parameters,
                actual_path,
                service_methods,
            ) {
                wrap_inferred_response_entity(&return_type, &inferred)
            } else {
                return_type
            }
        } else {
            return_type
        }
    } else {
        return_type
    };

    Some(JavaMethodInfo {
        name,
        line,
        http_methods,
        paths,
        is_reactive_route,
        mapping_params,
        mapping_conditions_complete,
        unmodeled_mapping,
        path_unresolved,
        unmodeled_parameters,
        return_type,
        parameters,
        is_mapped,
        is_exception_handler,
        status_code,
        declared_responses,
        custom_annotations,
        client_calls,
        local_types,
    })
}

fn collect_local_variable_types(body: Node, source: &str) -> HashMap<String, String> {
    let mut types = HashMap::new();
    walk_java_nodes(body, &mut |node| {
        if node.kind() != "local_variable_declaration" {
            return;
        }
        let Some(type_node) = node.child_by_field_name("type") else {
            return;
        };
        let declared_type = node_text(type_node, source).trim().to_string();
        let mut cursor = node.walk();
        for declarator in node.named_children(&mut cursor) {
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            if let Some(name) = declarator.child_by_field_name("name") {
                types.insert(
                    node_text(name, source).trim().to_string(),
                    declared_type.clone(),
                );
            }
        }
    });
    types
}

fn walk_java_nodes<F: FnMut(Node)>(node: Node, visit: &mut F) {
    visit(node);
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index as u32) {
            walk_java_nodes(child, visit);
        }
    }
}

fn parameter_type(parameters: &[JavaParamInfo], name: &str) -> Option<String> {
    parameters
        .iter()
        .find(|parameter| parameter.name == name)
        .map(|parameter| parameter.param_type.clone())
}

fn class_literal_type(node: Node, source: &str) -> Option<String> {
    let text = node_text(node, source);
    let text = text.trim().strip_suffix(".class")?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Resolve a URL argument that may be wrapped in `URI.create(...)`.
fn resolve_uri_argument(node: Node, source: &str, constants: &ConstantTable) -> Option<String> {
    if node.kind() == "method_invocation" {
        let name = node
            .child_by_field_name("name")
            .map(|name| node_text(name, source))?;
        if name.trim() == "create" {
            if let Some(arguments) = node.child_by_field_name("arguments") {
                let mut cursor = arguments.walk();
                let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
                if let Some(first) = children.first() {
                    return resolve_path_expr(*first, source, constants);
                }
            }
        }
        return None;
    }
    resolve_path_expr(node, source, constants)
}

/// Resolve a unique class/file constant by the name written in source.
///
/// Only used where the def-use folder needs a value; ambiguous names stay
/// unresolved so a same-named constant in another class is never guessed.
fn lookup_constant_text(text: &str, constants: &ConstantTable) -> Option<String> {
    let trimmed = text.trim();
    let (class_filter, field) = match trimmed.rsplit_once('.') {
        Some((class_ref, field)) => (
            Some(class_ref.rsplit('.').next().unwrap_or(class_ref)),
            field,
        ),
        None => (None, trimmed),
    };
    let mut found: Option<String> = None;
    for (fqcn, fields) in &constants.strings {
        if let Some(class_simple) = class_filter {
            if fqcn.rsplit('.').next().unwrap_or(fqcn) != class_simple {
                continue;
            }
        }
        let Some(value) = fields.get(field) else {
            continue;
        };
        match &found {
            Some(existing) if existing != value => return None,
            Some(_) => {}
            None => found = Some(value.clone()),
        }
    }
    found
}

/// A client URL after local folding. Multiple possible values are not expanded
/// into several contracts in this slice; they keep the existing unresolved
/// blocker rather than publishing a partial route.
fn resolve_client_url(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    locals: &crate::def_use::LocalStrings,
) -> Option<String> {
    let value = crate::def_use::eval_expression(node, source, locals, &|name| {
        lookup_constant_text(name, constants)
    });
    match value {
        crate::def_use::LocalValue::Literal(value) => Some(value),
        crate::def_use::LocalValue::FiniteSet(mut values) => {
            if values.len() == 1 {
                values.pop_first()
            } else {
                None
            }
        }
        crate::def_use::LocalValue::Opaque => {
            // A local that shadows a class constant must not fall back to it.
            if node.kind() == "identifier" && locals.contains(node_text(node, source).trim()) {
                return None;
            }
            resolve_uri_argument(node, source, constants)
        }
    }
}

fn resttemplate_call_shape(name: &str) -> Option<(&'static str, usize, Option<usize>, bool)> {
    match name {
        "getForObject" | "getForEntity" => Some(("GET", 0, None, true)),
        "postForObject" | "postForEntity" => Some(("POST", 0, Some(1), true)),
        "put" => Some(("PUT", 0, Some(1), false)),
        "patchForObject" => Some(("PATCH", 0, Some(1), true)),
        "delete" => Some(("DELETE", 0, None, false)),
        _ => None,
    }
}

fn http_method_from_expression(
    node: Node,
    source: &str,
    constants: &ConstantTable,
) -> Option<String> {
    if let Some(value) = resolve_path_expr(node, source, constants) {
        let value = value.trim().to_ascii_uppercase();
        if matches!(
            value.as_str(),
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
        ) {
            return Some(value);
        }
    }
    let text = node_text(node, source);
    let last = text.trim().rsplit('.').next()?.trim().to_ascii_uppercase();
    matches!(
        last.as_str(),
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
    )
    .then_some(last)
}

fn webclient_call(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    parameters: &[JavaParamInfo],
    locals: &crate::def_use::LocalStrings,
) -> Option<JavaClientCall> {
    let mut current = node;
    let mut receiver = None;
    let mut http_method = None;
    let mut uri_arg = None;
    let mut request_body_type = None;
    for _ in 0..12 {
        if current.kind() != "method_invocation" {
            break;
        }
        let name = current
            .child_by_field_name("name")
            .map(|name| node_text(name, source))?;
        let arguments = current
            .child_by_field_name("arguments")
            .map(|arguments| {
                let mut cursor = arguments.walk();
                arguments.named_children(&mut cursor).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let lower = name.trim().to_ascii_lowercase();
        if http_method.is_none()
            && matches!(
                lower.as_str(),
                "get" | "post" | "put" | "delete" | "patch" | "head" | "options"
            )
        {
            http_method = Some(lower.to_ascii_uppercase());
        }
        if http_method.is_none() && lower == "method" {
            if let Some(first) = arguments.first() {
                if let Some(verb) = http_method_from_expression(*first, source, constants) {
                    http_method = Some(verb);
                }
            }
        }
        if lower == "uri" && uri_arg.is_none() {
            uri_arg = arguments.first().copied();
        }
        if lower == "bodyvalue" {
            if let Some(first) = arguments.first() {
                let text = node_text(*first, source);
                request_body_type = parameter_type(parameters, text.trim());
            }
        }
        let Some(object) = current.child_by_field_name("object") else {
            break;
        };
        if matches!(
            object.kind(),
            "identifier" | "field_access" | "member_expression"
        ) {
            let name = node_text(object, source);
            receiver = Some(name.trim().to_string());
            break;
        }
        current = object;
    }
    let receiver = receiver?;
    let http_method = http_method?;
    let url = uri_arg.and_then(|argument| resolve_client_url(argument, source, constants, locals));
    let response_type = current_argument_class(node, source);
    Some(JavaClientCall {
        kind: JavaClientKind::Field,
        receiver,
        http_method,
        url: url.clone(),
        response_type,
        request_body_type,
        line: node.start_position().row as u32 + 1,
        unresolved: if url.is_none() {
            Some("client URI is not a literal/constant expression".to_string())
        } else {
            None
        },
    })
}

fn current_argument_class(node: Node, source: &str) -> Option<String> {
    let arguments = node.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let children: Vec<Node> = arguments.named_children(&mut cursor).collect();
    children
        .into_iter()
        .find_map(|argument| class_literal_type(argument, source))
}

/// `HttpRequest.newBuilder(...)` and OkHttp `new Request.Builder()` chains.
fn builder_http_client_call(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    locals: &crate::def_use::LocalStrings,
) -> Option<JavaClientCall> {
    let mut current = node;
    let mut uri_argument = None;
    let mut builder_argument = None;
    let mut http_method = None;
    let mut kind = None;
    for _ in 0..12 {
        if current.kind() != "method_invocation" {
            break;
        }
        let name = current
            .child_by_field_name("name")
            .map(|name| node_text(name, source))?;
        let arguments = current
            .child_by_field_name("arguments")
            .map(|arguments| {
                let mut cursor = arguments.walk();
                let values: Vec<Node> = arguments.named_children(&mut cursor).collect();
                values
            })
            .unwrap_or_default();
        let lower = name.trim().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "get" | "post" | "put" | "delete" | "patch" | "head" | "options"
        ) {
            http_method.get_or_insert(lower.to_ascii_uppercase());
        }
        if lower == "method" {
            if let Some(first) = arguments.first() {
                let verb = clean_string_literal(&node_text(*first, source)).to_ascii_uppercase();
                if matches!(
                    verb.as_str(),
                    "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
                ) {
                    http_method.get_or_insert(verb);
                }
            }
        }
        if lower == "uri" {
            uri_argument.get_or_insert_with(|| arguments.first().copied());
        }
        if lower == "url" {
            uri_argument.get_or_insert_with(|| arguments.first().copied());
        }
        if lower == "newbuilder" {
            builder_argument = arguments.first().copied();
        }
        let object_text = current
            .child_by_field_name("object")
            .map(|object| node_text(object, source))
            .unwrap_or_default();
        if object_text.contains("HttpRequest.newBuilder") {
            kind = Some(JavaClientKind::HttpRequestBuilder);
        }
        if object_text.contains("Request.Builder") {
            kind = Some(JavaClientKind::OkHttpRequestBuilder);
        }
        let Some(object) = current.child_by_field_name("object") else {
            break;
        };
        if matches!(
            object.kind(),
            "identifier" | "field_access" | "member_expression"
        ) {
            break;
        }
        current = object;
    }
    let kind = kind?;
    let http_method = http_method?;
    let url = uri_argument
        .and_then(|argument| {
            argument.and_then(|node| resolve_client_url(node, source, constants, locals))
        })
        .or_else(|| {
            builder_argument.and_then(|node| resolve_client_url(node, source, constants, locals))
        });
    Some(JavaClientCall {
        kind,
        receiver: match kind {
            JavaClientKind::HttpRequestBuilder => "HttpRequest",
            JavaClientKind::OkHttpRequestBuilder => "Request.Builder",
            JavaClientKind::ApacheHttpMethod => "HttpClient",
            JavaClientKind::JerseyWebTarget => "WebTarget",
            JavaClientKind::Field | JavaClientKind::SdkWrapper => "",
        }
        .to_string(),
        http_method,
        url: url.clone(),
        response_type: None,
        request_body_type: None,
        line: node.start_position().row as u32 + 1,
        unresolved: if url.is_none() {
            Some("client URL is not a literal/constant expression".to_string())
        } else {
            None
        },
    })
}

const APACHE_HTTP_METHODS: &[(&str, &str)] = &[
    ("HttpGet", "GET"),
    ("HttpPost", "POST"),
    ("HttpPut", "PUT"),
    ("HttpDelete", "DELETE"),
    ("HttpPatch", "PATCH"),
    ("HttpHead", "HEAD"),
    ("HttpOptions", "OPTIONS"),
];

/// The verb of an Apache HttpClient request object (`new HttpPost(...)`), when the
/// creation expression names one of its method classes.
fn apache_request_verb(node: Node, source: &str) -> Option<&'static str> {
    if node.kind() != "object_creation_expression" {
        return None;
    }
    let type_text = node
        .child_by_field_name("type")
        .map(|node| node_text(node, source))
        .unwrap_or_default();
    let simple = type_text.trim().rsplit('.').next().unwrap_or("").trim();
    APACHE_HTTP_METHODS
        .iter()
        .find(|(name, _)| *name == simple)
        .map(|(_, verb)| *verb)
}

fn apache_request_url(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    locals: &crate::def_use::LocalStrings,
) -> Option<String> {
    let arguments = node.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let first = arguments.named_children(&mut cursor).next()?;
    resolve_client_url(first, source, constants, locals)
}

/// Request objects declared in this method: `HttpGet get = new HttpGet(url)`,
/// `var post = new HttpPost(url)`, or assignment to an existing identifier.
fn apache_request_bindings(
    body: Node,
    source: &str,
    constants: &ConstantTable,
    locals: &crate::def_use::LocalStrings,
) -> HashMap<String, (String, Option<String>)> {
    let mut bindings = HashMap::new();
    walk_java_nodes(body, &mut |node| match node.kind() {
        "variable_declarator" => {
            let (Some(name), Some(value)) = (
                node.child_by_field_name("name"),
                node.child_by_field_name("value"),
            ) else {
                return;
            };
            let Some(verb) = apache_request_verb(value, source) else {
                return;
            };
            bindings.insert(
                node_text(name, source).trim().to_string(),
                (
                    verb.to_string(),
                    apache_request_url(value, source, constants, locals),
                ),
            );
        }
        "assignment_expression" => {
            let (Some(left), Some(right)) = (
                node.child_by_field_name("left"),
                node.child_by_field_name("right"),
            ) else {
                return;
            };
            if left.kind() != "identifier" {
                return;
            }
            let Some(verb) = apache_request_verb(right, source) else {
                return;
            };
            bindings.insert(
                node_text(left, source).trim().to_string(),
                (
                    verb.to_string(),
                    apache_request_url(right, source, constants, locals),
                ),
            );
        }
        _ => {}
    });
    bindings
}

/// JAX-RS / Jersey client chain: `client.target("/api").path("users").request().get(X.class)`.
/// Only literal target/path segments are composed; a dynamic segment is reported as an
/// unresolved client call instead of publishing a partial route.
fn jersey_web_target_call(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    parameters: &[JavaParamInfo],
    locals: &crate::def_use::LocalStrings,
) -> Option<JavaClientCall> {
    let mut current = node;
    let mut verb: Option<String> = None;
    let mut method_literal: Option<String> = None;
    let mut target_url: Option<Option<String>> = None;
    let mut segments: Vec<Option<String>> = Vec::new();
    let mut response_type: Option<String> = None;
    let mut body_argument: Option<Node> = None;
    for _ in 0..20 {
        if current.kind() != "method_invocation" {
            break;
        }
        let name = current
            .child_by_field_name("name")
            .map(|name| node_text(name, source).trim().to_string())?;
        let arguments = current
            .child_by_field_name("arguments")
            .map(|arguments| {
                let mut cursor = arguments.walk();
                arguments.named_children(&mut cursor).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        match name.as_str() {
            "get" | "post" | "put" | "delete" | "patch" | "head" | "options" => {
                verb.get_or_insert_with(|| name.to_ascii_uppercase());
                for argument in &arguments {
                    if let Some(ty) = class_literal_type(*argument, source) {
                        response_type.get_or_insert(ty);
                    }
                }
                if matches!(name.as_str(), "post" | "put" | "patch") {
                    body_argument = arguments.first().copied();
                }
            }
            "method" => {
                if let Some(first) = arguments.first() {
                    if let Some(value) = http_method_from_expression(*first, source, constants) {
                        method_literal = Some(value);
                    }
                }
            }
            "path" => {
                segments.push(
                    arguments.first().and_then(|argument| {
                        resolve_client_url(*argument, source, constants, locals)
                    }),
                );
            }
            "target" => {
                target_url =
                    Some(arguments.first().and_then(|argument| {
                        resolve_client_url(*argument, source, constants, locals)
                    }));
            }
            "request"
            | "property"
            | "queryParam"
            | "matrixParam"
            | "resolveTemplate"
            | "resolveTemplateFromEncoded"
            | "register" => {}
            _ => {}
        }
        let Some(object) = current.child_by_field_name("object") else {
            break;
        };
        if object.kind() == "identifier" {
            // Jersey managed client: `@Uri("resource/dog") WebTarget target`.
            let receiver = node_text(object, source).trim().to_string();
            if let Some(parameter) = parameters.iter().find(|parameter| {
                parameter.name == receiver
                    && parameter_type_simple_name(&parameter.param_type) == "WebTarget"
            }) {
                target_url = Some(parameter.uri_template.clone());
            }
            break;
        }
        if object.kind() != "method_invocation" {
            break;
        }
        current = object;
    }
    let http_method = verb.or(method_literal)?;
    let target_url = target_url?;
    // The chain was walked outermost-first; path segments apply innermost-first.
    segments.reverse();
    let mut dynamic = target_url.is_none();
    let mut url = target_url.unwrap_or_default();
    for segment in segments {
        match segment {
            Some(segment) => {
                let trimmed = segment.trim();
                if trimmed.is_empty() {
                    continue;
                }
                url = format!(
                    "{}/{}",
                    url.trim_end_matches('/'),
                    trimmed.trim_start_matches('/')
                );
            }
            None => dynamic = true,
        }
    }
    let url = if dynamic { None } else { Some(url) };
    let request_body_type = body_argument.and_then(|argument| {
        let text = node_text(argument, source);
        let text = text.trim();
        let value = entity_json_argument(text).unwrap_or(text);
        parameter_type(parameters, value)
    });
    Some(JavaClientCall {
        kind: JavaClientKind::JerseyWebTarget,
        receiver: "WebTarget".to_string(),
        http_method,
        url: url.clone(),
        response_type,
        request_body_type,
        line: node.start_position().row as u32 + 1,
        unresolved: if url.is_none() {
            Some("Jersey WebTarget URL is not a literal/constant expression".to_string())
        } else {
            None
        },
    })
}

/// The payload argument of `Entity.json(...)` / `Entity.entity(...)`.
fn entity_json_argument(text: &str) -> Option<&str> {
    for prefix in ["Entity.json(", "Entity.entity("] {
        if let Some(rest) = text.strip_prefix(prefix) {
            if let Some(inner) = rest.strip_suffix(')') {
                return Some(inner.split(',').next().unwrap_or(inner).trim());
            }
        }
    }
    None
}

fn collect_java_client_calls(
    body: Node,
    source: &str,
    parameters: &[JavaParamInfo],
    constants: &ConstantTable,
    locals: &crate::def_use::LocalStrings,
) -> Vec<JavaClientCall> {
    let mut calls = Vec::new();
    // Apache HttpClient is recognized only in files that import it, so a local
    // class that happens to be called HttpGet is never read as a client.
    // HttpClient 5 moved to `org.apache.hc.client5`; version 4 uses `org.apache.http`.
    let apache_http = source.contains("org.apache.http") || source.contains("org.apache.hc.");
    let apache_bindings = if apache_http {
        apache_request_bindings(body, source, constants, locals)
    } else {
        HashMap::new()
    };
    walk_java_nodes(body, &mut |node| {
        if node.kind() != "method_invocation" {
            return;
        }
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = node_text(name_node, source);
        let arguments = node
            .child_by_field_name("arguments")
            .map(|arguments| {
                let mut cursor = arguments.walk();
                arguments.named_children(&mut cursor).collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if apache_http && name.trim() == "execute" {
            let Some(first) = arguments.first() else {
                return;
            };
            let request = if let Some(verb) = apache_request_verb(*first, source) {
                Some((
                    verb.to_string(),
                    apache_request_url(*first, source, constants, locals),
                ))
            } else if first.kind() == "identifier" {
                apache_bindings
                    .get(node_text(*first, source).trim())
                    .cloned()
            } else {
                None
            };
            // An untraced argument is not claimed: it may be any `execute(...)`
            // method, and guessing would emit either a false contract or a false
            // unresolved-client blocker.
            let Some((http_method, url)) = request else {
                return;
            };
            let receiver = node
                .child_by_field_name("object")
                .map(|object| node_text(object, source).trim().to_string())
                .unwrap_or_default();
            calls.push(JavaClientCall {
                kind: JavaClientKind::ApacheHttpMethod,
                receiver,
                http_method,
                url: url.clone(),
                response_type: None,
                request_body_type: None,
                line: node.start_position().row as u32 + 1,
                unresolved: if url.is_none() {
                    Some(
                        "Apache HttpClient request URL is not a literal/constant expression"
                            .to_string(),
                    )
                } else {
                    None
                },
            });
            return;
        }

        // OpenAPI Generator (and similar) put every operation's literal URL in a
        // generated SDK method that delegates to one wrapper class:
        //   apiClient.invokeAPI("/pet", HttpMethod.POST, ...)
        // The wrapper class is validated against its HTTP-client field later, so a
        // user class that happens to expose `invokeAPI` is not read as a client.
        if name.trim() == "invokeAPI" && arguments.len() >= 2 {
            let receiver = node
                .child_by_field_name("object")
                .map(|object| node_text(object, source).trim().to_string())
                .unwrap_or_default();
            // OpenAPI's Java templates use two argument orders:
            //   invokeAPI("/pet", HttpMethod.POST, ...)
            //   invokeAPI("OperationId", "/pet", "POST", ...)   (Jersey)
            let first_url = resolve_client_url(arguments[0], source, constants, locals);
            let first_method = http_method_from_expression(arguments[1], source, constants);
            let path_like = first_url
                .as_deref()
                .is_some_and(|url| url.starts_with('/') || url.starts_with("http"));
            let (url, http_method) = if first_method.is_some() && path_like {
                (first_url, first_method)
            } else if arguments.len() >= 3 {
                (
                    resolve_client_url(arguments[1], source, constants, locals),
                    http_method_from_expression(arguments[2], source, constants),
                )
            } else {
                (first_url, first_method)
            };
            if let Some(http_method) = http_method {
                calls.push(JavaClientCall {
                    kind: JavaClientKind::SdkWrapper,
                    receiver,
                    http_method,
                    url: url.clone(),
                    response_type: None,
                    request_body_type: None,
                    line: node.start_position().row as u32 + 1,
                    unresolved: if url.is_none() {
                        Some(
                            "generated SDK wrapper path is not a literal/constant expression"
                                .to_string(),
                        )
                    } else {
                        None
                    },
                });
            }
            return;
        }
        // OkHttp's generated client keeps the literal path in a local and passes it to
        // buildCall(basePath, localVarPath, "PATCH", ...).
        if name.trim() == "buildCall" && arguments.len() >= 3 {
            let receiver = node
                .child_by_field_name("object")
                .map(|object| node_text(object, source).trim().to_string())
                .unwrap_or_default();
            if let Some(http_method) = http_method_from_expression(arguments[2], source, constants)
            {
                let url = resolve_client_url(arguments[1], source, constants, locals);
                calls.push(JavaClientCall {
                    kind: JavaClientKind::SdkWrapper,
                    receiver,
                    http_method,
                    url: url.clone(),
                    response_type: None,
                    request_body_type: None,
                    line: node.start_position().row as u32 + 1,
                    unresolved: if url.is_none() {
                        Some(
                            "generated SDK wrapper path is not a literal/constant expression"
                                .to_string(),
                        )
                    } else {
                        None
                    },
                });
            }
            return;
        }

        if source.contains("jakarta.ws.rs.client.") || source.contains("javax.ws.rs.client.") {
            if matches!(
                name.as_str(),
                "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "method"
            ) {
                if let Some(call) =
                    jersey_web_target_call(node, source, constants, parameters, locals)
                {
                    calls.push(call);
                    return;
                }
            }
        }

        if let Some((http_method, url_index, body_index, response_from_class)) =
            resttemplate_call_shape(&name)
        {
            let receiver = node
                .child_by_field_name("object")
                .map(|object| node_text(object, source).trim().to_string())
                .unwrap_or_default();
            let url = arguments
                .get(url_index)
                .and_then(|argument| resolve_client_url(*argument, source, constants, locals));
            let response_type = if response_from_class {
                arguments
                    .iter()
                    .rev()
                    .find_map(|argument| class_literal_type(*argument, source))
            } else {
                None
            };
            let request_body_type = body_index.and_then(|index| {
                arguments.get(index).and_then(|argument| {
                    parameter_type(parameters, node_text(*argument, source).trim())
                })
            });
            calls.push(JavaClientCall {
                kind: JavaClientKind::Field,
                receiver,
                http_method: http_method.to_string(),
                url: url.clone(),
                response_type,
                request_body_type,
                line: node.start_position().row as u32 + 1,
                unresolved: if url.is_none() {
                    Some("client URL is not a literal/constant expression".to_string())
                } else {
                    None
                },
            });
            return;
        }

        if matches!(name.as_str(), "exchange" | "execute") {
            let receiver = node
                .child_by_field_name("object")
                .map(|object| node_text(object, source).trim().to_string())
                .unwrap_or_default();
            let url = arguments
                .first()
                .and_then(|argument| resolve_client_url(*argument, source, constants, locals));
            let http_method = arguments
                .get(1)
                .and_then(|argument| http_method_from_expression(*argument, source, constants));
            let response_type = arguments
                .iter()
                .rev()
                .find_map(|argument| class_literal_type(*argument, source));
            let request_body_type = arguments.get(2).and_then(|argument| {
                parameter_type(parameters, node_text(*argument, source).trim())
            });
            if http_method.is_none() || url.is_none() {
                calls.push(JavaClientCall {
                    kind: JavaClientKind::Field,
                    receiver,
                    http_method: http_method.clone().unwrap_or_else(|| "UNKNOWN".to_string()),
                    url,
                    response_type,
                    request_body_type,
                    line: node.start_position().row as u32 + 1,
                    unresolved: Some(if http_method.is_none() {
                        "exchange/execute HTTP method is not a literal HttpMethod value".to_string()
                    } else {
                        "client URL is not a literal/constant expression".to_string()
                    }),
                });
            } else {
                calls.push(JavaClientCall {
                    kind: JavaClientKind::Field,
                    receiver,
                    http_method: http_method.unwrap(),
                    url,
                    response_type,
                    request_body_type,
                    line: node.start_position().row as u32 + 1,
                    unresolved: None,
                });
            }
            return;
        }

        if let Some(call) = builder_http_client_call(node, source, constants, locals) {
            calls.push(call);
            return;
        }

        let is_response_call =
            matches!(name.as_str(), "bodyToMono" | "exchangeToMono" | "toEntity")
                || (name == "body"
                    && arguments
                        .first()
                        .and_then(|argument| class_literal_type(*argument, source))
                        .is_some());
        if is_response_call {
            if let Some(call) = webclient_call(node, source, constants, parameters, locals) {
                calls.push(call);
            }
        }
    });
    calls
}

fn is_generic_or_raw_response_entity(ret: &str) -> bool {
    let simple = ret.rsplit('.').next().unwrap_or(ret).trim();
    simple == "ResponseEntity"
        || simple == "ResponseEntity<?>"
        || simple == "ResponseEntity<Object>"
        || simple == "ResponseEntity<? extends Object>"
        || simple == "HttpEntity"
        || simple == "HttpEntity<?>"
        || simple == "HttpEntity<Object>"
}

fn wrap_inferred_response_entity(original: &str, inferred: &str) -> String {
    let simple = original.rsplit('.').next().unwrap_or(original).trim();
    if simple.starts_with("HttpEntity") {
        format!("HttpEntity<{inferred}>")
    } else {
        format!("ResponseEntity<{inferred}>")
    }
}

struct SiblingMethodInfo<'tree> {
    return_type: String,
    parameters: Vec<(String, String)>,
    body: Option<Node<'tree>>,
}

fn find_class_body<'tree>(node: Node<'tree>) -> Option<Node<'tree>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "class_body" {
            return Some(child);
        }
    }
    None
}

fn find_put_invocations<'tree>(
    node: Node<'tree>,
    source: &str,
    puts: &mut Vec<(Node<'tree>, Node<'tree>)>,
) {
    if node.kind() == "method_invocation" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let n_str = node_text(name_node, source);
            if n_str.trim() == "put" {
                if let Some(args) = node.child_by_field_name("arguments") {
                    if let (Some(a0), Some(a1)) = (args.named_child(0), args.named_child(1)) {
                        puts.push((a0, a1));
                    }
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        find_put_invocations(child, source, puts);
    }
}

fn extract_map_puts_from_class_body<'tree>(
    class_body: Node<'tree>,
    source: &str,
    local_vars: &std::collections::HashMap<String, String>,
    sibling_methods: &std::collections::HashMap<String, SiblingMethodInfo<'tree>>,
    sibling_fields: &std::collections::HashMap<String, String>,
    file_path: &str,
    service_methods: &ServiceMethodTable,
) -> Option<String> {
    let mut puts = Vec::new();
    find_put_invocations(class_body, source, &mut puts);
    let mut entries = Vec::new();
    for (k_node, v_node) in puts {
        let k_str = node_text(k_node, source);
        let key = k_str.trim().trim_matches('"');
        if let Some(val_type) = infer_type_of_arg(
            v_node,
            source,
            local_vars,
            sibling_methods,
            sibling_fields,
            file_path,
            service_methods,
        ) {
            entries.push((key.to_string(), val_type));
        }
    }
    if !entries.is_empty() {
        if entries.len() == 1 {
            return Some(format!("MapWrapper<{}, {}>", entries[0].0, entries[0].1));
        } else {
            let inner = entries
                .iter()
                .map(|(k, v)| format!("{k}:{v}"))
                .collect::<Vec<_>>()
                .join(",");
            return Some(format!("MultiMapWrapper<{inner}>"));
        }
    }
    None
}

thread_local! {
    /// Reentrancy guard for the mutually recursive payload-inference walkers.
    /// A helper that calls itself, or two helpers that call each other, must not
    /// be able to exhaust the stack; after this depth the expression is unknown.
    static INFERENCE_DEPTH: Cell<usize> = Cell::new(0);
}

struct InferenceDepthGuard;

impl Drop for InferenceDepthGuard {
    fn drop(&mut self) {
        INFERENCE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

fn enter_inference() -> Option<InferenceDepthGuard> {
    INFERENCE_DEPTH.with(|depth| {
        let next = depth.get() + 1;
        if next > 16 {
            None
        } else {
            depth.set(next);
            Some(InferenceDepthGuard)
        }
    })
}

fn infer_response_entity_payload(
    node: Node,
    body: Node,
    source: &str,
    parameters: &[JavaParamInfo],
    file_path: &str,
    service_methods: &ServiceMethodTable,
) -> Option<String> {
    let mut local_vars = std::collections::HashMap::new();
    for p in parameters {
        local_vars.insert(p.name.clone(), p.param_type.clone());
    }
    collect_local_vars(body, source, &mut local_vars);

    let mut sibling_methods = std::collections::HashMap::new();
    let mut sibling_fields = std::collections::HashMap::new();
    if let Some(parent) = node.parent() {
        let mut cursor = parent.walk();
        for child in parent.children(&mut cursor) {
            if child.kind() == "method_declaration" {
                if let (Some(n_node), Some(t_node)) = (
                    child.child_by_field_name("name"),
                    child.child_by_field_name("type"),
                ) {
                    let m_name = node_text(n_node, source).trim().to_string();
                    let m_type = node_text(t_node, source).trim().to_string();
                    let mut params = Vec::new();
                    if let Some(params_node) = child.child_by_field_name("parameters") {
                        let mut p_cursor = params_node.walk();
                        for p_child in params_node.children(&mut p_cursor) {
                            if p_child.kind() == "formal_parameter" {
                                if let (Some(pt_node), Some(pn_node)) = (
                                    p_child.child_by_field_name("type"),
                                    p_child.child_by_field_name("name"),
                                ) {
                                    let pt_name = node_text(pt_node, source).trim().to_string();
                                    let pn_name = node_text(pn_node, source).trim().to_string();
                                    params.push((pn_name, pt_name));
                                }
                            }
                        }
                    }
                    sibling_methods.insert(
                        m_name,
                        SiblingMethodInfo {
                            return_type: m_type,
                            parameters: params,
                            body: child.child_by_field_name("body"),
                        },
                    );
                }
            } else if child.kind() == "field_declaration" {
                if let Some(t_node) = child.child_by_field_name("type") {
                    let f_type = node_text(t_node, source).trim().to_string();
                    let mut f_cursor = child.walk();
                    for f_child in child.children(&mut f_cursor) {
                        if f_child.kind() == "variable_declarator" {
                            if let Some(n_node) = f_child.child_by_field_name("name") {
                                let f_name = node_text(n_node, source).trim().to_string();
                                sibling_fields.insert(f_name, f_type.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    let mut return_exprs = Vec::new();
    collect_return_expressions(body, &mut return_exprs);

    for expr in return_exprs {
        if let Some(payload_type) = extract_payload_type_from_expr(
            expr,
            source,
            &local_vars,
            &sibling_methods,
            &sibling_fields,
            file_path,
            service_methods,
        ) {
            return Some(payload_type);
        }
    }
    None
}

fn collect_local_vars(
    node: Node,
    source: &str,
    vars: &mut std::collections::HashMap<String, String>,
) {
    if node.kind() == "local_variable_declaration" {
        if let Some(type_node) = node.child_by_field_name("type") {
            let type_text = node_text(type_node, source);
            let type_trimmed = type_text.trim();
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "variable_declarator" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name_text = node_text(name_node, source);
                        vars.insert(name_text.trim().to_string(), type_trimmed.to_string());
                    }
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_local_vars(child, source, vars);
    }
}

fn collect_return_expressions<'tree>(node: Node<'tree>, returns: &mut Vec<Node<'tree>>) {
    if node.kind() == "return_statement" {
        if let Some(expr) = node.named_child(0) {
            returns.push(expr);
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_return_expressions(child, returns);
    }
}

fn extract_payload_type_from_expr<'tree>(
    expr: Node<'tree>,
    source: &str,
    local_vars: &std::collections::HashMap<String, String>,
    sibling_methods: &std::collections::HashMap<String, SiblingMethodInfo<'tree>>,
    sibling_fields: &std::collections::HashMap<String, String>,
    file_path: &str,
    service_methods: &ServiceMethodTable,
) -> Option<String> {
    let _depth = enter_inference()?;
    match expr.kind() {
        "object_creation_expression" => {
            if let Some(type_node) = expr.child_by_field_name("type") {
                let type_text = node_text(type_node, source);
                let trimmed = type_text.trim();
                let simple = trimmed.rsplit('.').next().unwrap_or(trimmed);
                if simple.starts_with("ResponseEntity") || simple.starts_with("HttpEntity") {
                    if let Some((_, arg)) = parse_generic_type(trimmed) {
                        if arg != "?" && arg != "Object" {
                            return Some(arg.to_string());
                        }
                    }
                    if let Some(args_node) = expr.child_by_field_name("arguments") {
                        if let Some(first_arg) = args_node.named_child(0) {
                            return infer_type_of_arg(
                                first_arg,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            );
                        }
                    }
                } else if simple.contains("Map") {
                    if let Some(class_body) = find_class_body(expr) {
                        if let Some(wrapper) = extract_map_puts_from_class_body(
                            class_body,
                            source,
                            local_vars,
                            sibling_methods,
                            sibling_fields,
                            file_path,
                            service_methods,
                        ) {
                            return Some(wrapper);
                        }
                    }
                    return Some(trimmed.to_string());
                } else {
                    return Some(trimmed.to_string());
                }
            }
            None
        }
        "method_invocation" => {
            if let Some(name_node) = expr.child_by_field_name("name") {
                let method_name = node_text(name_node, source);
                let trimmed = method_name.trim();
                match trimmed {
                    "ok" | "of" | "body" => {
                        if let Some(args_node) = expr.child_by_field_name("arguments") {
                            if let Some(first_arg) = args_node.named_child(0) {
                                return infer_type_of_arg(
                                    first_arg,
                                    source,
                                    local_vars,
                                    sibling_methods,
                                    sibling_fields,
                                    file_path,
                                    service_methods,
                                );
                            }
                        }
                    }
                    "build" | "noContent" => {
                        return Some("Void".to_string());
                    }
                    "map" | "flatMap" => {
                        if let Some(args_node) = expr.child_by_field_name("arguments") {
                            if let Some(first_arg) = args_node.named_child(0) {
                                if first_arg.kind() == "lambda_expression" {
                                    let mut lambda_local_vars = local_vars.clone();
                                    let p_name = first_arg
                                        .child_by_field_name("parameters")
                                        .or_else(|| first_arg.child_by_field_name("parameter"))
                                        .or_else(|| {
                                            first_arg
                                                .named_child(0)
                                                .filter(|c| c.kind() == "identifier")
                                        })
                                        .map(|n| node_text(n, source).trim().to_string());
                                    if let Some(p_name) = p_name {
                                        if let Some(obj_node) = expr.child_by_field_name("object") {
                                            if let Some(obj_type) = infer_type_of_arg(
                                                obj_node,
                                                source,
                                                local_vars,
                                                sibling_methods,
                                                sibling_fields,
                                                file_path,
                                                service_methods,
                                            ) {
                                                let inner = if let Some((_, inner_arg)) =
                                                    parse_generic_type(&obj_type)
                                                {
                                                    inner_arg.to_string()
                                                } else {
                                                    obj_type
                                                };
                                                lambda_local_vars.insert(p_name, inner);
                                            }
                                        }
                                    }
                                    if let Some(l_body) = first_arg.child_by_field_name("body") {
                                        if l_body.kind() == "block" {
                                            let mut l_returns = Vec::new();
                                            collect_return_expressions(l_body, &mut l_returns);
                                            for ret_expr in l_returns {
                                                if let Some(t) = extract_payload_type_from_expr(
                                                    ret_expr,
                                                    source,
                                                    &lambda_local_vars,
                                                    sibling_methods,
                                                    sibling_fields,
                                                    file_path,
                                                    service_methods,
                                                ) {
                                                    return Some(t);
                                                }
                                            }
                                        } else {
                                            if let Some(t) = extract_payload_type_from_expr(
                                                l_body,
                                                source,
                                                &lambda_local_vars,
                                                sibling_methods,
                                                sibling_fields,
                                                file_path,
                                                service_methods,
                                            ) {
                                                return Some(t);
                                            }
                                        }
                                    }
                                } else if first_arg.kind() == "method_reference" {
                                    let ref_text = node_text(first_arg, source);
                                    let m_name = ref_text
                                        .trim()
                                        .rsplit("::")
                                        .next()
                                        .unwrap_or(ref_text.trim());
                                    if let Some(sibling_info) = sibling_methods.get(m_name) {
                                        let trimmed_target = sibling_info.return_type.trim();
                                        let simple_target = trimmed_target
                                            .rsplit('.')
                                            .next()
                                            .unwrap_or(trimmed_target);
                                        if simple_target.starts_with("ResponseEntity")
                                            || simple_target.starts_with("HttpEntity")
                                        {
                                            if let Some((_, inner)) =
                                                parse_generic_type(trimmed_target)
                                            {
                                                if !inner.contains("Map")
                                                    && inner != "?"
                                                    && inner != "Object"
                                                {
                                                    return Some(inner.to_string());
                                                }
                                            }
                                        }
                                        if is_generic_or_raw_response_entity(trimmed_target)
                                            || simple_target.contains("Map")
                                            || simple_target == "Object"
                                        {
                                            if let Some(b) = sibling_info.body {
                                                let mut sibling_local_vars =
                                                    std::collections::HashMap::new();
                                                for (p_name, p_type) in &sibling_info.parameters {
                                                    sibling_local_vars
                                                        .insert(p_name.clone(), p_type.clone());
                                                }
                                                collect_local_vars(
                                                    b,
                                                    source,
                                                    &mut sibling_local_vars,
                                                );
                                                let mut m_returns = Vec::new();
                                                collect_return_expressions(b, &mut m_returns);
                                                for ret_expr in m_returns {
                                                    if let Some(t) = extract_payload_type_from_expr(
                                                        ret_expr,
                                                        source,
                                                        &sibling_local_vars,
                                                        sibling_methods,
                                                        sibling_fields,
                                                        file_path,
                                                        service_methods,
                                                    ) {
                                                        return Some(t);
                                                    }
                                                }
                                            }
                                        } else {
                                            return Some(sibling_info.return_type.clone());
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(obj_node) = expr.child_by_field_name("object") {
                            return extract_payload_type_from_expr(
                                obj_node,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            );
                        }
                    }
                    m if sibling_methods.contains_key(m) => {
                        let sibling_info = &sibling_methods[m];
                        let trimmed_target = sibling_info.return_type.trim();
                        let simple_target =
                            trimmed_target.rsplit('.').next().unwrap_or(trimmed_target);
                        if simple_target.starts_with("ResponseEntity")
                            || simple_target.starts_with("HttpEntity")
                        {
                            if let Some((_, inner)) = parse_generic_type(trimmed_target) {
                                if !inner.contains("Map") && inner != "?" && inner != "Object" {
                                    return Some(inner.to_string());
                                }
                            }
                        }
                        if is_generic_or_raw_response_entity(trimmed_target)
                            || simple_target.contains("Map")
                            || simple_target == "Object"
                        {
                            if let Some(b) = sibling_info.body {
                                let mut sibling_local_vars = std::collections::HashMap::new();
                                for (p_name, p_type) in &sibling_info.parameters {
                                    sibling_local_vars.insert(p_name.clone(), p_type.clone());
                                }
                                collect_local_vars(b, source, &mut sibling_local_vars);
                                let mut m_returns = Vec::new();
                                collect_return_expressions(b, &mut m_returns);
                                for ret_expr in m_returns {
                                    if let Some(t) = extract_payload_type_from_expr(
                                        ret_expr,
                                        source,
                                        &sibling_local_vars,
                                        sibling_methods,
                                        sibling_fields,
                                        file_path,
                                        service_methods,
                                    ) {
                                        return Some(t);
                                    }
                                }
                            }
                        }
                        if is_generic_or_raw_response_entity(sibling_info.return_type.trim()) {
                            return None;
                        }
                        return Some(sibling_info.return_type.clone());
                    }
                    _ => {
                        if let Some(obj_node) = expr.child_by_field_name("object") {
                            return extract_payload_type_from_expr(
                                obj_node,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            );
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn infer_type_of_arg<'tree>(
    arg: Node<'tree>,
    source: &str,
    local_vars: &std::collections::HashMap<String, String>,
    sibling_methods: &std::collections::HashMap<String, SiblingMethodInfo<'tree>>,
    sibling_fields: &std::collections::HashMap<String, String>,
    file_path: &str,
    service_methods: &ServiceMethodTable,
) -> Option<String> {
    let _depth = enter_inference()?;
    match arg.kind() {
        "identifier" => {
            let name = node_text(arg, source);
            local_vars.get(name.trim()).cloned()
        }
        "object_creation_expression" => {
            let type_node = arg.child_by_field_name("type")?;
            let text = node_text(type_node, source);
            let trimmed = text.trim();
            let simple = trimmed.rsplit('.').next().unwrap_or(trimmed);
            if simple.contains("Map") {
                if let Some(class_body) = find_class_body(arg) {
                    if let Some(wrapper) = extract_map_puts_from_class_body(
                        class_body,
                        source,
                        local_vars,
                        sibling_methods,
                        sibling_fields,
                        file_path,
                        service_methods,
                    ) {
                        return Some(wrapper);
                    }
                }
            }
            Some(trimmed.to_string())
        }
        "string_literal" => Some("String".to_string()),
        "decimal_integer_literal" => Some("Integer".to_string()),
        "true" | "false" => Some("Boolean".to_string()),
        "method_invocation" => {
            if let Some(name_node) = arg.child_by_field_name("name") {
                let m_name = node_text(name_node, source);
                let trimmed = m_name.trim();
                if trimmed == "of" || trimmed == "ofNullable" {
                    if let Some(obj) = arg.child_by_field_name("object") {
                        let obj_str = node_text(obj, source);
                        let obj_name = obj_str.trim();
                        if obj_name.ends_with("Map") {
                            if let Some(inner_args) = arg.child_by_field_name("arguments") {
                                if let (Some(k_node), Some(v_node)) =
                                    (inner_args.named_child(0), inner_args.named_child(1))
                                {
                                    let k_str = node_text(k_node, source);
                                    let key = k_str.trim().trim_matches('"');
                                    if let Some(val_type) = infer_type_of_arg(
                                        v_node,
                                        source,
                                        local_vars,
                                        sibling_methods,
                                        sibling_fields,
                                        file_path,
                                        service_methods,
                                    ) {
                                        return Some(format!("MapWrapper<{}, {}>", key, val_type));
                                    }
                                }
                            }
                        }
                    }
                    if let Some(inner_args) = arg.child_by_field_name("arguments") {
                        if let Some(first_inner) = inner_args.named_child(0) {
                            return infer_type_of_arg(
                                first_inner,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            );
                        }
                    }
                } else if trimmed == "singletonMap" {
                    if let Some(inner_args) = arg.child_by_field_name("arguments") {
                        if let (Some(k_node), Some(v_node)) =
                            (inner_args.named_child(0), inner_args.named_child(1))
                        {
                            let k_str = node_text(k_node, source);
                            let key = k_str.trim().trim_matches('"');
                            if let Some(val_type) = infer_type_of_arg(
                                v_node,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            ) {
                                return Some(format!("MapWrapper<{}, {}>", key, val_type));
                            }
                        }
                    }
                } else if trimmed == "singletonList" || trimmed == "asList" {
                    if let Some(inner_args) = arg.child_by_field_name("arguments") {
                        if let Some(first_inner) = inner_args.named_child(0) {
                            if let Some(inner_type) = infer_type_of_arg(
                                first_inner,
                                source,
                                local_vars,
                                sibling_methods,
                                sibling_fields,
                                file_path,
                                service_methods,
                            ) {
                                return Some(format!("List<{inner_type}>"));
                            }
                        }
                    }
                } else if trimmed == "get" || trimmed == "orElse" || trimmed == "orElseGet" {
                    if let Some(obj_node) = arg.child_by_field_name("object") {
                        if let Some(obj_type) = infer_type_of_arg(
                            obj_node,
                            source,
                            local_vars,
                            sibling_methods,
                            sibling_fields,
                            file_path,
                            service_methods,
                        ) {
                            if let Some((container, inner)) = parse_generic_type(&obj_type) {
                                if container.ends_with("Optional") {
                                    return Some(inner.to_string());
                                }
                            }
                            return Some(obj_type);
                        }
                    }
                } else if let Some(sibling_info) = sibling_methods.get(trimmed) {
                    let trimmed_target = sibling_info.return_type.trim();
                    let simple_target = trimmed_target.rsplit('.').next().unwrap_or(trimmed_target);
                    if simple_target.starts_with("ResponseEntity")
                        || simple_target.starts_with("HttpEntity")
                    {
                        if let Some((_, inner)) = parse_generic_type(trimmed_target) {
                            if !inner.contains("Map") && inner != "?" && inner != "Object" {
                                return Some(inner.to_string());
                            }
                        }
                    }
                    if is_generic_or_raw_response_entity(trimmed_target)
                        || simple_target.contains("Map")
                        || simple_target == "Object"
                    {
                        if let Some(b) = sibling_info.body {
                            let mut sibling_local_vars = std::collections::HashMap::new();
                            for (p_name, p_type) in &sibling_info.parameters {
                                sibling_local_vars.insert(p_name.clone(), p_type.clone());
                            }
                            if let Some(call_args) = arg.child_by_field_name("arguments") {
                                for (i, (p_name, _)) in sibling_info.parameters.iter().enumerate() {
                                    if let Some(arg_child) = call_args.named_child(i as u32) {
                                        if let Some(inferred_arg_type) = infer_type_of_arg(
                                            arg_child,
                                            source,
                                            local_vars,
                                            sibling_methods,
                                            sibling_fields,
                                            file_path,
                                            service_methods,
                                        ) {
                                            sibling_local_vars
                                                .insert(p_name.clone(), inferred_arg_type);
                                        }
                                    }
                                }
                            }
                            collect_local_vars(b, source, &mut sibling_local_vars);
                            let mut m_returns = Vec::new();
                            collect_return_expressions(b, &mut m_returns);
                            for ret_expr in m_returns {
                                if let Some(t) = extract_payload_type_from_expr(
                                    ret_expr,
                                    source,
                                    &sibling_local_vars,
                                    sibling_methods,
                                    sibling_fields,
                                    file_path,
                                    service_methods,
                                ) {
                                    return Some(t);
                                }
                            }
                        }
                    }
                    if is_generic_or_raw_response_entity(sibling_info.return_type.trim()) {
                        return None;
                    }
                    return Some(sibling_info.return_type.clone());
                } else if let Some(obj_node) = arg.child_by_field_name("object") {
                    let obj_name = node_text(obj_node, source);
                    if let Some(field_type) = sibling_fields.get(obj_name.trim()) {
                        if let Some(resolved) = service_methods.lookup(field_type, trimmed) {
                            return Some(resolved);
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn annotation_required(node: Node, source: &str) -> bool {
    if extract_annotation_named_arg(node, source, "defaultValue").is_some() {
        return false;
    }
    extract_annotation_named_arg(node, source, "required")
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn parse_parameter(
    node: Node,
    source: &str,
    file_path: &str,
    constants: &ConstantTable,
) -> Option<JavaParamInfo> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source);
    let type_node = node.child_by_field_name("type")?;
    let param_type = node_text(type_node, source);

    let mut is_path_variable = false;
    let mut is_request_body = false;
    let mut is_request_param = false;
    let mut is_request_header = false;
    let mut is_context = false;
    let mut paging_kind = None;
    let mut unmodeled = None;
    let mut alias = None;
    let mut required = true;
    let mut uri_template = None;

    for child in collect_annotations(node) {
        let ann_name = extract_annotation_name(child, source);
        match ann_name.as_str() {
            "PathVariable" | "PathParam" => {
                is_path_variable = true;
                alias = extract_annotation_param_name(child, source);
                required = annotation_required(child, source);
            }
            "RequestBody" => {
                is_request_body = true;
                required = annotation_required(child, source);
            }
            "RequestParam" | "QueryParam" => {
                is_request_param = true;
                alias = extract_annotation_param_name(child, source);
                required = annotation_required(child, source);
            }
            "RequestHeader" | "HeaderParam" => {
                is_request_header = true;
                alias = extract_annotation_param_name(child, source);
                required = annotation_required(child, source);
            }
            // Jersey injects a managed WebTarget whose base is the @Uri value.
            "Uri" => {
                uri_template = annotation_string_value(child, source, constants);
            }
            // Retrofit parameter annotations.
            "Body" => {
                is_request_body = true;
            }
            "Query" => {
                is_request_param = true;
                alias = extract_annotation_param_name(child, source);
            }
            "Path" => {
                is_path_variable = true;
                alias = extract_annotation_param_name(child, source);
            }
            "Header" => {
                is_request_header = true;
                alias = extract_annotation_param_name(child, source);
            }
            "QueryValue" => {
                is_request_param = true;
                alias = extract_annotation_param_name(child, source);
            }
            "RequestBean" | "Part" => {
                unmodeled = Some(format!("@{} parameter is not modeled", ann_name));
            }
            "HeaderMap" | "QueryMap" | "Field" | "FieldMap" | "Url" => {
                unmodeled = Some(format!("@{} parameter is not modeled", ann_name));
            }
            "ModelAttribute" => {
                unmodeled = Some(
                    "@ModelAttribute binds an object from query/form fields; its property set is not modeled"
                        .to_string(),
                );
            }
            "RequestPart" => {
                unmodeled =
                    Some("@RequestPart multipart request bodies are not modeled".to_string());
            }
            "CookieValue" | "CookieParam" => {
                unmodeled = Some("cookie parameters are not modeled".to_string());
            }
            "MatrixVariable" | "MatrixParam" => {
                unmodeled = Some("matrix parameters are not modeled".to_string());
            }
            "RequestAttribute" | "SessionAttribute" => {
                is_context = true;
            }
            "AuthenticationPrincipal" | "CurrentSecurityContext" => {
                is_context = true;
            }
            _ => {}
        }
    }

    if unmodeled.is_none()
        && !is_path_variable
        && !is_request_body
        && !is_request_param
        && !is_request_header
        && !is_context
    {
        if let Some(kind) = paging_kind_for(&param_type) {
            paging_kind = Some(kind);
        } else if is_context_parameter_type(&param_type) {
            is_context = true;
        } else if is_multipart_parameter_type(&param_type) {
            unmodeled = Some("multipart request bodies are not modeled".to_string());
        }
    }

    let (validation_constraints, unsupported_metadata) =
        parse_validation(node, source, file_path, constants);
    Some(JavaParamInfo {
        name,
        param_type,
        is_path_variable,
        is_request_body,
        is_request_param,
        is_request_header,
        is_context,
        paging_kind,
        unmodeled,
        alias,
        required,
        validation_constraints,
        unsupported_metadata,
        uri_template,
        provenance: annotation_provenance(node, source, file_path),
    })
}

/// The simple name of a parameter type, with generics and array markers removed.
fn parameter_type_simple_name(param_type: &str) -> &str {
    let trimmed = param_type.trim();
    let without_array = trimmed.strip_suffix("[]").unwrap_or(trimmed);
    let head = without_array
        .split('<')
        .next()
        .unwrap_or(without_array)
        .trim();
    head.rsplit('.').next().unwrap_or(head).trim()
}

fn paging_kind_for(param_type: &str) -> Option<JavaPagingKind> {
    match parameter_type_simple_name(param_type) {
        "Pageable" | "PageRequest" => Some(JavaPagingKind::Pageable),
        "Sort" => Some(JavaPagingKind::Sort),
        _ => None,
    }
}

fn is_multipart_parameter_type(param_type: &str) -> bool {
    matches!(
        parameter_type_simple_name(param_type),
        "MultipartFile" | "Part" | "MultipartHttpServletRequest"
    )
}

/// Server-supplied request context. These values never describe a caller-supplied wire
/// surface, so treating one as a request body or query parameter would fabricate a contract.
fn is_context_parameter_type(param_type: &str) -> bool {
    matches!(
        parameter_type_simple_name(param_type),
        "Principal"
            | "Authentication"
            | "UserDetails"
            | "GrantedAuthority"
            | "SecurityContext"
            | "CsrfToken"
            | "BindingResult"
            | "Errors"
            | "HttpServletRequest"
            | "HttpServletResponse"
            | "ServletRequest"
            | "ServletResponse"
            | "HttpSession"
            | "ServerHttpRequest"
            | "ServerHttpResponse"
            | "ServerWebExchange"
            | "ServerRequest"
            | "ServerResponse"
            | "RoutingContext"
            | "WebSession"
            | "WebRequest"
            | "NativeWebRequest"
            | "Locale"
            | "TimeZone"
            | "InputStream"
            | "OutputStream"
            | "Reader"
            | "Writer"
            | "HttpHeaders"
            | "UriComponentsBuilder"
            | "Model"
            | "ModelMap"
            | "ModelAndView"
            | "RedirectAttributes"
            | "SessionStatus"
            | "UriInfo"
            | "UriBuilder"
            | "ResourceContext"
            | "Providers"
    )
}

/// A Spring MVC parameter with no binding annotation is a request parameter when its type is
/// one the conversion service reads directly from text, and a model attribute otherwise.
fn is_simple_spring_param_type(param_type: &str) -> bool {
    let trimmed = param_type.trim();
    let head = trimmed.split('<').next().unwrap_or(trimmed).trim();
    let simple = head.rsplit('.').next().unwrap_or(head).trim();
    matches!(
        simple,
        "String"
            | "CharSequence"
            | "char"
            | "Character"
            | "boolean"
            | "Boolean"
            | "byte"
            | "Byte"
            | "short"
            | "Short"
            | "int"
            | "Integer"
            | "long"
            | "Long"
            | "float"
            | "Float"
            | "double"
            | "Double"
            | "BigDecimal"
            | "BigInteger"
            | "Number"
            | "UUID"
            | "Instant"
            | "ZoneId"
            | "Date"
            | "Timestamp"
            | "LocalDate"
            | "LocalTime"
            | "LocalDateTime"
            | "ZonedDateTime"
            | "OffsetDateTime"
            | "OffsetTime"
            | "Duration"
            | "Period"
            | "Year"
            | "YearMonth"
            | "MonthDay"
    ) || (trimmed.starts_with("Optional<") && {
        let inner = trimmed
            .strip_prefix("Optional<")
            .and_then(|rest| rest.strip_suffix('>'))
            .unwrap_or("");
        is_simple_spring_param_type(inner)
    }) || (trimmed.ends_with("[]") && is_simple_spring_param_type(trimmed.trim_end_matches("[]")))
}

fn parse_fields(
    node: Node,
    source: &str,
    file_path: &str,
    class_lombok_getters: bool,
    constants: &ConstantTable,
) -> Vec<JavaFieldInfo> {
    let mut fields = Vec::new();

    // Static and transient fields are never serialized by Jackson.
    let mut is_static_or_transient = false;
    let mut is_public = false;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for m in child.children(&mut mod_cursor) {
                let m_text = node_text(m, source);
                if m_text == "static" || m_text == "transient" {
                    is_static_or_transient = true;
                } else if m_text == "public" {
                    is_public = true;
                }
            }
        } else if child.kind() == "static" || child.kind() == "transient" {
            is_static_or_transient = true;
        } else if child.kind() == "public" {
            is_public = true;
        }
    }
    if is_static_or_transient {
        return fields;
    }

    let type_node = match node.child_by_field_name("type") {
        Some(t) => t,
        None => return fields,
    };
    let field_type = node_text(type_node, source);

    let mut json_property = None;
    let mut is_json_ignored = false;
    let mut is_unwrapped = false;
    let mut field_lombok_getter = class_lombok_getters;
    let mut is_nullable = None;
    let mut json_aliases = Vec::new();

    for child in collect_annotations(node) {
        let ann_name = extract_annotation_name(child, source);
        if ann_name == "JsonProperty" {
            json_property = annotation_string_value(child, source, constants);
        } else if ann_name == "JsonSetter" && json_property.is_none() {
            json_property = annotation_string_value(child, source, constants);
        } else if ann_name == "JsonAlias" {
            json_aliases.extend(extract_annotation_string_array(child, source));
        } else if ann_name == "JsonIgnore" {
            is_json_ignored = json_ignored(child, source);
        } else if ann_name == "JsonUnwrapped" {
            is_unwrapped = true;
        } else if ann_name == "Nullable" {
            is_nullable = Some(true);
        } else if ann_name == "NotNull"
            || ann_name == "NonNull"
            || ann_name == "NotBlank"
            || ann_name == "NotEmpty"
        {
            is_nullable = Some(false);
        } else if ann_name == "Getter" {
            field_lombok_getter = !node_text(child, source).contains("NONE");
        }
    }
    json_aliases.sort();
    json_aliases.dedup();

    // Jackson's default field visibility is PUBLIC_ONLY. A private field becomes
    // a property only through an annotation, a getter, or Lombok generation.
    let explicit_property = collect_annotations(node)
        .iter()
        .any(|&ann| extract_annotation_name(ann, source) == "JsonProperty");
    let is_serialized = is_public || explicit_property || field_lombok_getter;
    let field_json_setter = collect_annotations(node)
        .iter()
        .any(|&ann| extract_annotation_name(ann, source) == "JsonSetter");
    let (jackson_access, explicit_access, access_error) =
        parse_jackson_access(node, source, file_path);
    let (validation_constraints, mut validation_error) =
        parse_validation(node, source, file_path, constants);
    let mut is_server_assigned = false;
    for annotation in collect_annotations(node) {
        if extract_annotation_name(annotation, source) != "GeneratedValue" {
            continue;
        }
        match jpa_generated_value(annotation, source, constants) {
            Some(true) => is_server_assigned = true,
            Some(false) => {}
            None => {
                validation_error
                    .get_or_insert_with(|| unsupported_annotation(annotation, source, file_path));
            }
        }
    }
    let unsupported_metadata =
        access_error.or_else(|| member_annotation_error(node, source, file_path, constants));

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declarator" {
            if let Some(name_node) = child.child_by_field_name("name") {
                let name = node_text(name_node, source);
                let line = child.start_position().row as u32 + 1;
                fields.push(JavaFieldInfo {
                    name,
                    field_type: field_type.clone(),
                    input_type: Some(field_type.clone()),
                    line,
                    json_property: json_property.clone(),
                    explicit_property,
                    is_json_ignored,
                    field_readable: is_serialized,
                    field_writable: is_serialized || field_json_setter,
                    getter_present: false,
                    setter_present: field_json_setter,
                    ignored_output: false,
                    ignored_input: false,
                    explicit_reader: explicit_property,
                    explicit_writer: explicit_property || field_json_setter,
                    is_serialized,
                    is_deserialized: is_serialized
                        || collect_annotations(node)
                            .iter()
                            .any(|&ann| extract_annotation_name(ann, source) == "JsonSetter"),
                    has_backing_field: true,
                    jackson_access,
                    explicit_access,
                    is_server_assigned,
                    validation_constraints: validation_constraints.clone(),
                    input_validation_constraints: Vec::new(),
                    unsupported_metadata: unsupported_metadata.clone(),
                    unsupported_input_validation: validation_error.clone(),
                    is_unwrapped,
                    has_getter: field_lombok_getter,
                    is_nullable,
                    json_aliases: json_aliases.clone(),
                    declaring_file: String::new(),
                });
            }
        }
    }

    fields
}

/// Jackson reads properties from zero-argument accessors as well as fields. Both
/// annotated and plain public getters are captured: an unannotated getter may be
/// computed (`getLeaf()`), and dropping it hides a property the server emits.
fn parse_getter_property(
    node: Node,
    source: &str,
    file_path: &str,
    constants: &ConstantTable,
) -> Option<JavaGetterProperty> {
    let mut is_static = false;
    let mut is_public = false;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            for word in node_text(child, source).split_whitespace() {
                if word == "static" {
                    is_static = true;
                } else if word == "public" {
                    is_public = true;
                }
            }
        }
    }
    if is_static {
        return None;
    }

    let name_node = node.child_by_field_name("name")?;
    let method_name = node_text(name_node, source);
    if method_name == "getClass" {
        return None;
    }
    let (seed, is_is_getter) = if method_name.starts_with("get") && method_name.len() > 3 {
        (&method_name[3..], false)
    } else if method_name.starts_with("is") && method_name.len() > 2 {
        (&method_name[2..], true)
    } else if collect_annotations(node).iter().any(|&annotation| {
        matches!(
            extract_annotation_name(annotation, source).as_str(),
            "JsonProperty" | "JsonGetter"
        )
    }) {
        (method_name.as_str(), false)
    } else {
        return None;
    };

    let params = node.child_by_field_name("parameters")?;
    let mut param_cursor = params.walk();
    if params
        .children(&mut param_cursor)
        .any(|c| matches!(c.kind(), "formal_parameter" | "spread_parameter"))
    {
        return None;
    }

    let return_type = node
        .child_by_field_name("type")
        .map(|t| node_text(t, source).to_string())
        .unwrap_or_default();
    if return_type == "void" {
        return None;
    }
    // Jackson only treats `isX()` as a getter for boolean-typed returns.
    if is_is_getter && !matches!(return_type.as_str(), "boolean" | "Boolean") {
        return None;
    }

    let mut wire_name = None;
    let mut ignored = false;
    let mut unwrapped = false;
    let mut annotated = false;
    let mut aliases = Vec::new();
    for annotation in collect_annotations(node) {
        match extract_annotation_name(annotation, source).as_str() {
            "JsonProperty" | "JsonGetter" => {
                annotated = true;
                if let Some(value) = annotation_string_value(annotation, source, constants) {
                    wire_name = Some(value);
                }
            }
            "JsonAlias" => {
                annotated = true;
                aliases.extend(extract_annotation_string_array(annotation, source));
            }
            "JsonIgnore" => {
                annotated = true;
                ignored = json_ignored(annotation, source);
            }
            "JsonUnwrapped" => unwrapped = true,
            _ => {}
        }
    }
    aliases.sort();
    aliases.dedup();
    if !is_public && !annotated {
        return None;
    }

    let (access, explicit_access, access_error) = parse_jackson_access(node, source, file_path);
    let (validation_constraints, validation_error) =
        parse_validation(node, source, file_path, constants);
    let nullable = validation_nullability(&validation_constraints);
    Some(JavaGetterProperty {
        property_name: bean_property_name(seed),
        wire_name,
        ignored,
        unwrapped,
        return_type,
        line: node.start_position().row as u32 + 1,
        aliases,
        access,
        explicit_access,
        explicit_property: collect_annotations(node).iter().any(|&annotation| {
            matches!(
                extract_annotation_name(annotation, source).as_str(),
                "JsonProperty" | "JsonGetter"
            )
        }),
        validation_constraints,
        unsupported_metadata: access_error
            .or_else(|| member_annotation_error(node, source, file_path, constants)),
        unsupported_input_validation: validation_error,
        nullable,
        file: file_path.to_string(),
        is_setter: false,
    })
}

fn parse_setter_property(
    node: Node,
    source: &str,
    file: &str,
    constants: &ConstantTable,
) -> Option<JavaGetterProperty> {
    let mut is_public = false;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "modifiers" {
            continue;
        }
        let mut cursor = child.walk();
        for modifier in child.children(&mut cursor) {
            match modifier.kind() {
                "static" => return None,
                "public" => is_public = true,
                _ => {}
            }
        }
    }
    let method_name = method_declaration_name(node, source)?;
    let annotations = collect_annotations(node);
    let explicit = annotations.iter().any(|&ann| {
        matches!(
            extract_annotation_name(ann, source).as_str(),
            "JsonSetter" | "JsonProperty"
        )
    });
    if !is_public && !explicit {
        return None;
    }
    let seed = method_name.strip_prefix("set").filter(|s| !s.is_empty());
    if seed.is_none() && !explicit {
        return None;
    }
    let params = node.child_by_field_name("parameters")?;
    let mut cursor = params.walk();
    let parameters: Vec<_> = params
        .named_children(&mut cursor)
        .filter(|c| matches!(c.kind(), "formal_parameter" | "spread_parameter"))
        .collect();
    if parameters.len() != 1 || parameters[0].kind() != "formal_parameter" {
        return None;
    }
    let parameter = parameters[0];
    let return_type = node_text(parameter.child_by_field_name("type")?, source);
    let mut wire_name = None;
    let mut ignored = false;
    let mut aliases = Vec::new();
    let mut unwrapped = false;
    for annotation in annotations {
        match extract_annotation_name(annotation, source).as_str() {
            "JsonSetter" | "JsonProperty" => {
                wire_name = annotation_string_value(annotation, source, constants)
            }
            "JsonIgnore" => ignored = json_ignored(annotation, source),
            "JsonAlias" => aliases.extend(extract_annotation_string_array(annotation, source)),
            "JsonUnwrapped" => unwrapped = true,
            _ => {}
        }
    }
    let (access, explicit_access, access_error) = parse_jackson_access(node, source, file);
    let (mut validation_constraints, validation_error) =
        parse_validation(node, source, file, constants);
    let (parameter_constraints, parameter_error) =
        parse_validation(parameter, source, file, constants);
    validation_constraints.extend(parameter_constraints);
    let nullable = validation_nullability(&validation_constraints);
    Some(JavaGetterProperty {
        property_name: bean_property_name(seed.unwrap_or(&method_name)),
        wire_name,
        ignored,
        unwrapped,
        return_type,
        line: node.start_position().row as u32 + 1,
        aliases,
        access,
        explicit_access,
        explicit_property: explicit,
        validation_constraints,
        unsupported_metadata: access_error
            .or_else(|| member_annotation_error(node, source, file, constants)),
        unsupported_input_validation: validation_error.or(parameter_error),
        nullable,
        file: file.to_string(),
        is_setter: true,
    })
}

fn apply_getter_properties(fields: &mut Vec<JavaFieldInfo>, getters: Vec<JavaGetterProperty>) {
    for gi in 0..getters.len() {
        let getter = &getters[gi];
        let existing = fields
            .iter()
            .position(|f| f.name == getter.property_name)
            .or_else(|| {
                getter.wire_name.as_ref().and_then(|wire_name| {
                    fields.iter().position(|f| {
                        f.json_property.as_ref() == Some(wire_name) || &f.name == wire_name
                    })
                })
            });
        if let Some(index) = existing {
            let field = &mut fields[index];
            let conflict = format!(
                "UNSUPPORTED_CONSTRUCT: conflicting @JsonProperty members for {} at {}:{}",
                field.name, getter.file, getter.line
            );
            if getter.is_setter {
                field.setter_present = true;
                field.ignored_input |= getter.ignored;
                field.explicit_writer |= getter.explicit_property;
            } else {
                field.getter_present = true;
                field.ignored_output |= getter.ignored;
                field.explicit_reader |= getter.explicit_property;
            }
            field.explicit_property |= getter.explicit_property;
            if field.explicit_access
                && getter.explicit_access
                && field.jackson_access != getter.access
            {
                field.unsupported_metadata = Some(conflict.clone());
            } else if getter.explicit_access {
                field.jackson_access = getter.access;
                field.explicit_access = true;
            }
            if let (Some(field_name), Some(getter_name)) = (&field.json_property, &getter.wire_name)
            {
                if field_name != getter_name {
                    field.unsupported_metadata = Some(conflict);
                }
            } else if getter.wire_name.is_some() {
                field.json_property = getter.wire_name.clone();
            }
            if !getter.ignored {
                if getter.is_setter {
                    field.is_deserialized = true;
                    field.input_type = Some(getter.return_type.clone());
                } else {
                    field.is_serialized = true;
                    field.has_getter = true;
                    field.is_deserialized |= field.has_backing_field;
                    field.field_type = getter.return_type.clone();
                }
                field.is_unwrapped |= getter.unwrapped;
                if getter.is_setter {
                    field
                        .input_validation_constraints
                        .extend(getter.validation_constraints.iter().cloned());
                } else {
                    field.is_nullable = getter.nullable.or(field.is_nullable);
                    field
                        .validation_constraints
                        .extend(getter.validation_constraints.iter().cloned());
                }
            }
            field.unsupported_metadata = field
                .unsupported_metadata
                .take()
                .or_else(|| getter.unsupported_metadata.clone());
            field.unsupported_input_validation = field
                .unsupported_input_validation
                .take()
                .or_else(|| getter.unsupported_input_validation.clone());
            field.json_aliases.extend(getter.aliases.iter().cloned());
            field.json_aliases.sort();
            field.json_aliases.dedup();
            continue;
        }
        fields.push(JavaFieldInfo {
            name: getter.property_name.clone(),
            input_type: getter.is_setter.then(|| getter.return_type.clone()),
            field_type: getter.return_type.clone(),
            line: getter.line,
            json_property: getter.wire_name.clone(),
            explicit_property: getter.explicit_property,
            is_json_ignored: false,
            field_readable: false,
            field_writable: false,
            getter_present: !getter.is_setter,
            setter_present: getter.is_setter,
            ignored_output: !getter.is_setter && getter.ignored,
            ignored_input: getter.is_setter && getter.ignored,
            explicit_reader: !getter.is_setter && getter.explicit_property,
            explicit_writer: getter.is_setter && getter.explicit_property,
            is_serialized: !getter.is_setter,
            is_deserialized: getter.is_setter,
            has_backing_field: false,
            jackson_access: getter.access,
            explicit_access: getter.explicit_access,
            validation_constraints: if getter.is_setter {
                Vec::new()
            } else {
                getter.validation_constraints.clone()
            },
            input_validation_constraints: if getter.is_setter {
                getter.validation_constraints.clone()
            } else {
                Vec::new()
            },
            unsupported_metadata: getter.unsupported_metadata.clone(),
            unsupported_input_validation: getter.unsupported_input_validation.clone(),
            is_unwrapped: getter.unwrapped,
            has_getter: !getter.is_setter,
            is_server_assigned: false,
            is_nullable: getter.nullable,
            json_aliases: getter.aliases.clone(),
            declaring_file: String::new(),
        });
    }
}

/// `@JsonUnwrapped` replaces the field with the nested object's own properties.
/// A target whose shape is not a known non-empty object cannot be flattened:
/// falling back to the wrapper field's own name would publish a key Jackson
/// never writes, so the caller must treat the whole shape as inconclusive.
fn unwrapped_object_properties(
    property_type: &WireType,
    type_pool: &BTreeMap<String, WireType>,
) -> Result<Vec<WirePropertyContract>, String> {
    match property_type {
        WireType::Ref(reference) => match type_pool.get(&reference.r#ref) {
            Some(WireType::Object(object)) if !object.properties.is_empty() => {
                Ok(object.properties.clone())
            }
            Some(WireType::Object(_)) => Err(format!(
                "{} resolved to an object with no serializable properties",
                reference.r#ref
            )),
            Some(WireType::Unknown(unknown)) => Err(unknown.reason.clone()),
            Some(_) => Err(format!(
                "{} resolved to a non-object wire type",
                reference.r#ref
            )),
            None => Err(format!("{} is absent from the type pool", reference.r#ref)),
        },
        WireType::Object(object) if !object.properties.is_empty() => Ok(object.properties.clone()),
        WireType::Unknown(unknown) => Err(unknown.reason.clone()),
        _ => Err("the target does not resolve to a known non-empty object".to_string()),
    }
}

fn upsert_property(properties: &mut Vec<WirePropertyContract>, property: WirePropertyContract) {
    if let Some(existing) = properties
        .iter_mut()
        .find(|p| p.wire_name == property.wire_name)
    {
        *existing = property;
    } else {
        properties.push(property);
    }
}

fn parse_record_component(node: Node, source: &str) -> Option<(String, String, u32)> {
    let name_node = node.child_by_field_name("name")?;
    let type_node = node.child_by_field_name("type")?;
    Some((
        node_text(name_node, source),
        node_text(type_node, source),
        node.start_position().row as u32 + 1,
    ))
}

fn record_component_annotations(
    node: Node,
    source: &str,
    constants: &ConstantTable,
) -> (Option<String>, Vec<String>, bool, bool, Option<bool>) {
    let mut json_property = None;
    let mut json_aliases = Vec::new();
    let mut is_json_ignored = false;
    let mut is_unwrapped = false;
    let mut is_nullable = None;
    for annotation in collect_annotations(node) {
        match extract_annotation_name(annotation, source).as_str() {
            "JsonProperty" => {
                json_property = annotation_string_value(annotation, source, constants)
            }
            "JsonAlias" => json_aliases.extend(extract_annotation_string_array(annotation, source)),
            "JsonIgnore" => is_json_ignored = json_ignored(annotation, source),
            "JsonUnwrapped" => is_unwrapped = true,
            "Nullable" => is_nullable = Some(true),
            "NotNull" | "NonNull" | "NotBlank" | "NotEmpty" => is_nullable = Some(false),
            _ => {}
        }
    }
    json_aliases.sort();
    json_aliases.dedup();
    (
        json_property,
        json_aliases,
        is_json_ignored,
        is_unwrapped,
        is_nullable,
    )
}

fn parse_composed_mapping(
    node: Node,
    source: &str,
    constants: &ConstantTable,
) -> Option<ComposedMappingInfo> {
    let mut http_methods = Vec::new();
    let mut base_paths = Vec::new();
    let mut path_attributes = Vec::new();
    let mut meta_annotations = Vec::new();
    let mut params = Vec::new();
    let mut conditions_complete = true;
    let mut declares_condition_attribute = false;
    let mut path_unresolved = false;

    for child in collect_annotations(node) {
        let ann_name = extract_annotation_name(child, source);
        meta_annotations.push(ann_name.clone());
        let extracted = annotation_paths(child, source, constants);
        let verbs: Vec<String> = match ann_name.as_str() {
            "GetMapping" => vec!["GET".to_string()],
            "PostMapping" => vec!["POST".to_string()],
            "PutMapping" => vec!["PUT".to_string()],
            "DeleteMapping" => vec!["DELETE".to_string()],
            "PatchMapping" => vec!["PATCH".to_string()],
            "RequestMapping" => match extract_request_mapping_methods(child, source) {
                Ok(verbs) => verbs,
                Err(_) => {
                    conditions_complete = false;
                    Vec::new()
                }
            },
            _ => continue,
        };
        if !verbs.is_empty() {
            http_methods.extend(verbs);
            base_paths.extend(extracted.paths);
            path_unresolved |= extracted.unresolved;
        }
        let (mapping_params, complete) = parse_mapping_conditions(child, source);
        params.extend(mapping_params);
        conditions_complete &= complete;
    }
    http_methods.sort();
    http_methods.dedup();

    if let Some(body) = node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            if child.kind() == "annotation_type_element_declaration" {
                if let Some(elem_name_node) = child.child_by_field_name("name") {
                    let elem_name = node_text(elem_name_node, source);
                    let mut is_path_alias = elem_name == "value" || elem_name == "path";
                    if matches!(
                        elem_name.as_str(),
                        "params" | "headers" | "consumes" | "produces" | "method"
                    ) {
                        declares_condition_attribute = true;
                    }
                    for ann in collect_annotations(child) {
                        let ann_name = extract_annotation_name(ann, source);
                        if ann_name == "AliasFor" {
                            let target_attr =
                                extract_annotation_named_arg(ann, source, "attribute")
                                    .or_else(|| extract_annotation_named_arg(ann, source, "value"))
                                    .or_else(|| extract_annotation_value(ann, source));
                            if let Some(attr) = target_attr {
                                if attr == "path" || attr == "value" {
                                    is_path_alias = true;
                                } else if matches!(
                                    attr.as_str(),
                                    "params" | "headers" | "consumes" | "produces" | "method"
                                ) {
                                    declares_condition_attribute = true;
                                }
                            } else {
                                is_path_alias = true;
                            }
                        }
                    }
                    if is_path_alias {
                        path_attributes.push(elem_name);
                    }
                }
            }
        }
    }

    if path_attributes.is_empty() {
        path_attributes.push("value".to_string());
        path_attributes.push("path".to_string());
    }
    if declares_condition_attribute {
        conditions_complete = false;
    }

    let has_non_standard_meta = meta_annotations.iter().any(|m| {
        !matches!(
            m.as_str(),
            "Target" | "Retention" | "Documented" | "Inherited"
        )
    });

    if !http_methods.is_empty() || has_non_standard_meta {
        Some(ComposedMappingInfo {
            http_methods,
            base_paths,
            path_attributes,
            meta_annotations,
            params,
            conditions_complete,
            declares_condition_attribute,
            path_unresolved,
        })
    } else {
        None
    }
}

fn extract_annotation_string_array(node: Node, source: &str) -> Vec<String> {
    let Some(args) = node.child_by_field_name("arguments") else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut stack = vec![args];
    while let Some(current) = stack.pop() {
        if current.kind() == "string_literal" {
            values.push(clean_string_literal(&node_text(current, source)));
            continue;
        }
        let mut cursor = current.walk();
        for child in current.children(&mut cursor) {
            stack.push(child);
        }
    }
    values
}

/// JavaBeans decapitalisation: `URL` stays `URL`, `IdToken` becomes `idToken`.
fn bean_property_name(seed: &str) -> String {
    let mut chars = seed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let rest = chars.as_str();
    if rest
        .chars()
        .next()
        .map(|c| c.is_uppercase())
        .unwrap_or(false)
    {
        return seed.to_string();
    }
    let mut out = String::with_capacity(seed.len());
    for c in first.to_lowercase() {
        out.push(c);
    }
    out.push_str(rest);
    out
}

fn collect_annotations<'a>(node: Node<'a>) -> Vec<Node<'a>> {
    let mut annotations = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mod_cursor = child.walk();
            for mod_child in child.children(&mut mod_cursor) {
                if matches!(mod_child.kind(), "annotation" | "marker_annotation") {
                    annotations.push(mod_child);
                }
            }
        } else if matches!(child.kind(), "annotation" | "marker_annotation") {
            annotations.push(child);
        }
    }
    annotations
}

fn extract_annotation_name(node: Node, source: &str) -> String {
    if let Some(name_node) = node.child_by_field_name("name") {
        let full = node_text(name_node, source);
        full.rsplit('.').next().unwrap_or(&full).to_string()
    } else {
        String::new()
    }
}

/// Path arguments written at a mapping use site, resolved through compile-time constant
/// expressions (`PATH`, `Constants.PATH`, `BASE + "/x"`). A path argument that is present
/// but cannot be resolved marks the annotation unresolved so the caller fails closed
/// instead of anchoring the endpoint at `/`.
fn annotation_paths(node: Node, source: &str, constants: &ConstantTable) -> AnnotationPaths {
    let mut out = AnnotationPaths::default();
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return out;
    };
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        match child.kind() {
            "line_comment" | "block_comment" => {}
            "string_literal" => {
                out.present = true;
                collect_annotation_path_value(child, source, constants, &mut out);
            }
            "element_value_pair" => {
                let Some(key) = child.child_by_field_name("key") else {
                    continue;
                };
                let key = node_text(key, source);
                if key != "value" && key != "path" {
                    continue;
                }
                out.present = true;
                if let Some(value) = child.child_by_field_name("value") {
                    collect_annotation_path_value(value, source, constants, &mut out);
                }
            }
            "element_value_array_initializer"
            | "identifier"
            | "field_access"
            | "scoped_identifier"
            | "binary_expression"
            | "parenthesized_expression" => {
                out.present = true;
                collect_annotation_path_value(child, source, constants, &mut out);
            }
            _ => {}
        }
    }
    out
}

fn collect_annotation_path_value(
    node: Node,
    source: &str,
    constants: &ConstantTable,
    out: &mut AnnotationPaths,
) {
    if node.kind() == "element_value_array_initializer" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if matches!(child.kind(), "line_comment" | "block_comment") {
                continue;
            }
            match resolve_path_expr(child, source, constants) {
                Some(path) => out.paths.push(path),
                None => out.unresolved = true,
            }
        }
        return;
    }
    match resolve_path_expr(node, source, constants) {
        Some(path) => out.paths.push(path),
        None => out.unresolved = true,
    }
}

/// Literal strings in an annotation value array, used by non-path annotations such as
/// `@JsonIgnoreProperties`; constants are deliberately not resolved here.
fn extract_paths_from_value(node: Node, source: &str, paths: &mut Vec<String>) {
    if node.kind() == "string_literal" {
        paths.push(clean_string_literal(&node_text(node, source)));
    } else if node.kind() == "element_value_array_initializer" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "string_literal" {
                paths.push(clean_string_literal(&node_text(child, source)));
            }
        }
    }
}

fn resolve_path_expr(node: Node, source: &str, constants: &ConstantTable) -> Option<String> {
    match node.kind() {
        "string_literal" => Some(clean_string_literal(&node_text(node, source))),
        "identifier" | "field_access" | "scoped_identifier" => {
            resolved_wire_name(node, source, constants)
        }
        "parenthesized_expression" => resolve_path_expr(node.named_child(0)?, source, constants),
        "binary_expression" => {
            let operator = node
                .child_by_field_name("operator")
                .map(|op| node_text(op, source))
                .unwrap_or_default();
            if operator != "+" {
                return None;
            }
            let left = resolve_path_expr(node.child_by_field_name("left")?, source, constants)?;
            let right = resolve_path_expr(node.child_by_field_name("right")?, source, constants)?;
            Some(format!("{left}{right}"))
        }
        _ => None,
    }
}

fn extract_annotation_value(node: Node, source: &str) -> Option<String> {
    if let Some(args_node) = node.child_by_field_name("arguments") {
        let mut cursor = args_node.walk();
        for child in args_node.children(&mut cursor) {
            if child.kind() == "string_literal" {
                return Some(clean_string_literal(&node_text(child, source)));
            } else if child.kind() == "element_value_pair" {
                if let Some(val_node) = child.child_by_field_name("value") {
                    if val_node.kind() == "string_literal" {
                        return Some(clean_string_literal(&node_text(val_node, source)));
                    }
                }
            }
        }
    }
    None
}

/// Reads a named boolean element such as `allowGetters = true` structurally, so a
/// string literal containing the option name cannot be mistaken for the option.
fn extract_annotation_bool_arg(node: Node, source: &str, key: &str) -> Option<bool> {
    let args_node = node.child_by_field_name("arguments")?;
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "element_value_pair" {
            continue;
        }
        let Some(key_node) = child.child_by_field_name("key") else {
            continue;
        };
        if node_text(key_node, source) != key {
            continue;
        }
        let Some(value_node) = child.child_by_field_name("value") else {
            continue;
        };
        return match node_text(value_node, source).trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        };
    }
    None
}

/// Annotations that hand the serialized shape to runtime logic: subtype
/// selection, dynamic map properties, or a hand-written serializer. None of
/// those can be reconstructed from the declaration, so publishing the declared
/// fields as the whole shape would invent a contract.
/// Provenance for a wire type derived from a Java declaration.
fn java_provenance(cls_info: &JavaClassInfo, line: u32) -> SourceProvenance {
    SourceProvenance {
        language: SourceLanguage::Java,
        file: cls_info.file_path.clone(),
        line,
        column: None,
        ast_identity: Some(cls_info.fqcn.clone()),
        annotation_or_schema: None,
        sha256: None,
        evidence_classification: Some(EvidenceClassification::ImplementationDerived),
    }
}

/// Removes Java comments so a `writeString` inside a comment cannot read as a serialization call.
fn strip_java_comments(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == '/' && i + 1 < bytes.len() && bytes[i + 1] == '/' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
        } else if bytes[i] == '/' && i + 1 < bytes.len() && bytes[i + 1] == '*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i = i.min(bytes.len()).saturating_add(2);
        } else if bytes[i] == '"' {
            out.push(bytes[i]);
            i += 1;
            while i < bytes.len() && bytes[i] != '"' {
                if bytes[i] == '\\' && i + 1 < bytes.len() {
                    out.push(bytes[i]);
                    i += 1;
                }
                out.push(bytes[i]);
                i += 1;
            }
            if i < bytes.len() {
                out.push('"');
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// The name of the `JsonGenerator` parameter, so only writes on the real generator count.
fn json_generator_param_name(body: &str) -> Option<String> {
    let at = body.find("JsonGenerator")? + "JsonGenerator".len();
    let rest = body[at..].trim_start();
    let ident: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

/// One `gen.writeX(...)` occurrence: the method name, the first argument when it is a string
/// literal (a statically fixed JSON field name), and where in the body it appears so a guard can
/// be attributed to it.
#[derive(Debug, Clone)]
struct SerializerWrite {
    method: String,
    literal_first_arg: Option<String>,
    at: usize,
}

fn serializer_writes(body: &str, generator: &str) -> Option<Vec<SerializerWrite>> {
    let chars: Vec<char> = body.chars().collect();
    let receiver = format!("{}.", generator);
    let mut writes = Vec::new();
    let mut i = 0usize;
    while i + receiver.len() <= chars.len() {
        let window: String = chars[i..i + receiver.len()].iter().collect();
        if window != receiver {
            i += 1;
            continue;
        }
        // A write on any other receiver (a nested generator, a mocked delegate) is not evidence
        // about this serializer's output.
        let before_is_ident =
            i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_' || chars[i - 1] == '.');
        if before_is_ident {
            i += 1;
            continue;
        }
        let mut j = i + receiver.len();
        let mut name = String::new();
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
            name.push(chars[j]);
            j += 1;
        }
        if !name.starts_with("write") {
            i = j.max(i + 1);
            continue;
        }
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j >= chars.len() || chars[j] != '(' {
            i = j.max(i + 1);
            continue;
        }
        let args = balanced_slice(&chars, j, '(', ')');
        writes.push(SerializerWrite {
            method: name,
            literal_first_arg: first_string_literal(&args),
            at: i,
        });
        i = j + 1;
    }
    // Any generator write we could not attribute to a call site makes the sequence unreliable.
    let textual = body.matches(&format!(".write")).count();
    if textual != writes.len() {
        return None;
    }
    Some(writes)
}

/// The source text between an opening and its matching closing delimiter.
fn balanced_slice(chars: &[char], open_at: usize, open: char, close: char) -> String {
    let mut depth = 0usize;
    let mut out = String::new();
    let mut i = open_at;
    while i < chars.len() {
        let c = chars[i];
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return out;
            }
        }
        if depth > 0 && i != open_at {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn first_string_literal(args: &str) -> Option<String> {
    let trimmed = args.trim_start();
    if !trimmed.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut chars = trimmed.chars().skip(1).peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
            continue;
        }
        if c == '"' {
            return Some(out);
        }
        out.push(c);
    }
    None
}

/// True when the set of fields a serializer writes depends on data rather than on the source:
/// a loop or a `switch` can visit keys the file never enumerates, so no field list is evidence.
/// A plain `if` is *not* in this class. It guards a fixed field name, which the shape can state
/// as an optional property; see `guarded_regions`.
fn serializer_body_is_data_driven(body: &str) -> bool {
    body.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|w| matches!(w, "for" | "while" | "switch" | "do" | "Stream" | "forEach"))
}

/// Byte ranges of the blocks an `if` or `else` governs, so a write can be attributed to a guard.
///
/// Only the guarded *block* is recorded, never the condition text: a serializer that picks a
/// value from a condition still writes the same field, while one whose `else` branch writes a
/// different field leaves both names optional, which is what the ranges make them.
/// An `else if` is one condition, so its block is recorded once and the trailing `else` of that
/// chain is found by the next iteration.
fn guarded_regions(body: &str) -> Vec<(usize, usize)> {
    // Indexes are char offsets, the same space `serializer_writes` reports, so a write and its
    // guard are located on one ruler even when the source is not ASCII.
    let b: Vec<char> = body.chars().collect();
    let starts_with = |at: usize, word: &str| -> bool {
        word.chars()
            .enumerate()
            .all(|(k, c)| b.get(at + k) == Some(&c))
    };
    let is_word_char = |c: &char| c.is_alphanumeric() || *c == '_' || *c == '$';
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let boundary_before = i == 0 || (!is_word_char(&b[i - 1]) && b[i - 1] != '.');
        if !boundary_before {
            i += 1;
            continue;
        }
        let keyword = if starts_with(i, "if") && !b.get(i + 2).is_some_and(is_word_char) {
            "if"
        } else if starts_with(i, "else") && !b.get(i + 4).is_some_and(is_word_char) {
            "else"
        } else {
            i += 1;
            continue;
        };
        let mut j = i + keyword.len();
        while b.get(j).is_some_and(|c| c.is_whitespace()) {
            j += 1;
        }
        if keyword == "if" {
            // Skip the parenthesised condition; a malformed one stops the scan rather than
            // guessing where the block begins.
            if b.get(j) != Some(&'(') {
                i = j;
                continue;
            }
            let Some(closing) = matching_delimiter(&b, j, '(', ')') else {
                break;
            };
            j = closing + 1;
            while b.get(j).is_some_and(|c| c.is_whitespace()) {
                j += 1;
            }
        }
        if keyword == "else" && starts_with(j, "if") {
            i = j;
            continue;
        }
        if b.get(j) == Some(&'{') {
            let Some(end) = matching_delimiter(&b, j, '{', '}') else {
                break;
            };
            out.push((j + 1, end));
            i = end + 1;
            continue;
        }
        // A guardless single statement (`if (x) gen.writeNull();`) runs to the next semicolon.
        if let Some(rel) = b[j..].iter().position(|c| *c == ';') {
            out.push((j, j + rel));
            i = j + rel + 1;
            continue;
        }
        break;
    }
    out
}

/// Index of the delimiter closing the one at `open`, or None when the body is unbalanced.
fn matching_delimiter(
    chars: &[char],
    open: usize,
    open_delim: char,
    close_delim: char,
) -> Option<usize> {
    let mut depth = 0usize;
    for (idx, c) in chars.iter().enumerate().skip(open) {
        if *c == open_delim {
            depth += 1;
        } else if *c == close_delim {
            depth -= 1;
            if depth == 0 {
                return Some(idx);
            }
        }
    }
    None
}

/// The wire shape a hand-written serializer fixes, or None when its body does not.
fn serializer_wire_from_body(body: &str) -> Option<WireType> {
    let body = strip_java_comments(body);
    let generator = json_generator_param_name(&body)?;
    if serializer_body_is_data_driven(&body) {
        return None;
    }
    let writes = serializer_writes(&body, &generator)?;
    if writes.is_empty() {
        return None;
    }
    let regions = guarded_regions(&body);
    let guarded = |write_at: usize| {
        regions
            .iter()
            .any(|(start, end)| write_at >= *start && write_at < *end)
    };
    for write in &writes {
        // Anything that delegates the value to the framework is not a fixed shape.
        if matches!(
            write.method.as_str(),
            "writePOJO"
                | "writeObject"
                | "writeTree"
                | "writeRaw"
                | "writeBinary"
                | "writeFieldName"
                | "writeUTF"
                | "writeStringNoEscaping"
        ) {
            return None;
        }
    }

    let scalar_of = |name: &str| -> Option<PrimitiveScalar> {
        match name {
            "writeString" | "writeStringField" => Some(PrimitiveScalar::String),
            "writeNumber" | "writeNumberField" => Some(PrimitiveScalar::Number),
            "writeBoolean" | "writeBooleanField" => Some(PrimitiveScalar::Boolean),
            _ => None,
        }
    };

    let is_field_write = |m: &str| {
        m == "writeStringField"
            || m == "writeNumberField"
            || m == "writeBooleanField"
            || m == "writeObjectField"
            || m == "writeNullField"
    };

    // Object form: writeStartObject, a literal-named field set, writeEndObject.
    if writes
        .first()
        .is_some_and(|w| w.method == "writeStartObject")
        && writes.last().is_some_and(|w| w.method == "writeEndObject")
    {
        // A guard around the envelope itself decides whether the object exists at all, which an
        // object shape cannot express. Only a guard around a field write is expressible.
        let first_guarded = guarded(writes[0].at);
        let last_guarded = guarded(writes[writes.len() - 1].at);
        if first_guarded || last_guarded {
            return None;
        }
        let mut properties: Vec<WirePropertyContract> = Vec::new();
        for write in &writes[1..writes.len() - 1] {
            if !is_field_write(&write.method) {
                return None;
            }
            // A field name built at runtime is not a publishable property name.
            let Some(name) = write.literal_first_arg.clone() else {
                return None;
            };
            let r#type = match scalar_of(&write.method) {
                Some(scalar) => WireType::Primitive(PrimitiveWireType {
                    scalar,
                    format: None,
                    provenance: None,
                }),
                None => WireType::Unknown(UnknownWireType {
                    reason: format!(
                        "`{}` writes `{}` through {}; the field name is fixed but its value type is not",
                        "serializer",
                        name,
                        write.method
                    ),
                    provenance: None,
                }),
            };
            // A guard around a field write can only hide the field. The name is still a literal
            // and the value kind is still the write's own method, so the source fixes the shape
            // and the guard fixes its presence: an optional property, not an abstention.
            let hidden_by_guard = guarded(write.at);
            if let Some(existing) = properties.iter_mut().find(|p| p.wire_name == name) {
                // One name written twice - an `if`/`else` pair over the same field, say - is a
                // single property only while both writes agree on the value kind. Different kinds
                // means the branch decides the shape, which is not publishable.
                if existing.r#type != r#type {
                    return None;
                }
                existing.optional = existing.optional && hidden_by_guard;
                continue;
            }
            properties.push(WirePropertyContract {
                wire_name: name,
                aliases: vec![],
                r#type,
                optional: hidden_by_guard,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            });
        }
        // A serializer that writes `{}` fixes no properties, so it stays unknown rather than
        // publishing a shape that can never disagree with anything.
        if properties.is_empty() {
            return None;
        }
        return Some(WireType::Object(ObjectWireType {
            name: None,
            properties,
            strict: Some(false),
            provenance: None,
        }));
    }

    // A guard cannot be expressed in the scalar and array forms below: it changes how many
    // elements an array carries, or whether the value appears at all, and neither form has a
    // field name to hang the optionality on. Those bodies stay inconclusive.
    if writes.iter().any(|w| guarded(w.at)) {
        return None;
    }

    // Scalar form: exactly one kind of scalar write.
    if writes
        .iter()
        .all(|w| w.method == "writeNull" || scalar_of(&w.method).is_some())
    {
        let kinds: Vec<PrimitiveScalar> =
            writes.iter().filter_map(|w| scalar_of(&w.method)).collect();
        let first = kinds.first()?;
        if kinds.iter().all(|k| k == first) {
            if writes.len() == kinds.len() {
                return Some(WireType::Primitive(PrimitiveWireType {
                    scalar: first.clone(),
                    format: None,
                    provenance: None,
                }));
            }
        }
    }

    // Array form: writeStartArray, repeated scalar writes, writeEndArray.
    if writes
        .first()
        .is_some_and(|w| w.method == "writeStartArray")
        && writes.last().is_some_and(|w| w.method == "writeEndArray")
    {
        let kinds: Vec<PrimitiveScalar> = writes[1..writes.len() - 1]
            .iter()
            .filter_map(|w| scalar_of(&w.method))
            .collect();
        if writes.len() - 2 == kinds.len() && !kinds.is_empty() {
            let first = kinds[0].clone();
            if kinds.iter().all(|k| *k == first) {
                return Some(WireType::Array(contract_core::ir::ArrayWireType {
                    element_type: Box::new(WireType::Primitive(PrimitiveWireType {
                        scalar: first,
                        format: None,
                        provenance: None,
                    })),
                    is_stream_or_flux: Some(false),
                    provenance: None,
                }));
            }
        }
    }

    None
}

/// The first annotation on `node` that hands the declaration's wire shape to runtime
/// serialization, so no static object shape can be published for it.
///
/// Scope matters. A class-level `@JsonTypeInfo` decides what the whole object looks like, but
/// the same annotation on a field or getter only tags that one member: the containing object
/// keeps its declared properties. `@JsonAnyGetter` exists only in member form and says the
/// object also carries inlined entries from a map, which the open-object shape already
/// expresses - treating it as inconclusive threw away the fields that were declared. And
/// `use = NONE` forbids a type id rather than deferring it to runtime, so it decides nothing
/// that the static shape does not already know.
fn unsupported_deserialization_marker(node: Node, source: &str, file: &str) -> Option<String> {
    let annotations = collect_annotations(node);
    let no_type_id = annotations.iter().any(|&annotation| {
        extract_annotation_name(annotation, source) == "JsonTypeInfo"
            && parse_json_type_info(annotation, source).is_some_and(|info| info.use_id == "NONE")
    });
    for annotation in annotations {
        let name = extract_annotation_name(annotation, source);
        // Generated metadata on accessors is not merged into the field marker. Abstain rather
        // than synthesizing a client-chosen identifier without the assignment evidence.
        if node.kind() == "method_declaration" && name == "GeneratedValue" {
            return Some(unsupported_annotation(annotation, source, file));
        }
        // Configured temporal/shape grammars are not represented by PrimitiveFormat. Do not
        // certify a default ISO sample under a custom Jackson input format.
        if name == "JsonFormat"
            && annotation
                .child_by_field_name("arguments")
                .is_some_and(|args| args.named_child_count() > 0)
        {
            return Some(unsupported_annotation(annotation, source, file));
        }
        if !matches!(
            name.as_str(),
            "JsonDeserialize"
                | "JsonSerialize"
                | "JsonTypeInfo"
                | "JsonSubTypes"
                | "JsonValue"
                | "JsonRawValue"
                | "JsonTypeIdResolver"
                | "JsonTypeResolver"
        ) {
            continue;
        }
        if name == "JsonTypeInfo"
            && parse_json_type_info(annotation, source).is_some_and(|info| info.use_id == "NONE")
        {
            continue;
        }
        if no_type_id
            && matches!(
                name.as_str(),
                "JsonSubTypes" | "JsonTypeIdResolver" | "JsonTypeResolver"
            )
        {
            continue;
        }
        if name == "JsonDeserialize"
            && annotation
                .child_by_field_name("arguments")
                .is_none_or(|args| args.named_child_count() == 0)
        {
            continue;
        }
        return Some(unsupported_annotation(annotation, source, file));
    }
    None
}

fn unsupported_serialization_marker(
    node: Node,
    source: &str,
    file: &str,
    member: bool,
) -> Option<String> {
    let annotations = collect_annotations(node);
    let no_type_id = annotations.iter().any(|&annotation| {
        extract_annotation_name(annotation, source) == "JsonTypeInfo"
            && parse_json_type_info(annotation, source).is_some_and(|info| info.use_id == "NONE")
    });
    for annotation in annotations {
        let name = extract_annotation_name(annotation, source);
        let blocks_member = matches!(
            name.as_str(),
            "JsonTypeInfo"
                | "JsonSubTypes"
                | "JsonSerialize"
                | "JsonValue"
                | "JsonRawValue"
                | "JsonTypeIdResolver"
                | "JsonTypeResolver"
        );
        if no_type_id
            && matches!(
                name.as_str(),
                "JsonSubTypes" | "JsonTypeIdResolver" | "JsonTypeResolver"
            )
        {
            continue;
        }
        if !(blocks_member || (!member && name == "JsonAnyGetter")) {
            continue;
        }
        if name == "JsonTypeInfo"
            && parse_json_type_info(annotation, source).is_some_and(|info| info.use_id == "NONE")
        {
            continue;
        }
        return Some(unsupported_annotation(annotation, source, file));
    }
    None
}

/// The declared name of a method, read structurally so a body can be captured by identity
/// rather than by matching source text that may also appear in a comment.
fn method_declaration_name(node: Node, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .map(|n| node_text(n, source).trim().to_string())
}

/// Reads `@JsonTypeInfo` without supplying Jackson's own defaults for the discriminator
/// property: a property name that is not written in the source is not published as a wire
/// property, because guessing it would assert a field name the producer may never emit.
fn parse_json_type_info(node: Node, source: &str) -> Option<JavaJsonTypeInfo> {
    let use_id = extract_annotation_named_arg(node, source, "use")
        .map(|v| v.rsplit('.').next().unwrap_or("").trim().to_string())?;
    if use_id.is_empty() {
        return None;
    }
    let include = extract_annotation_named_arg(node, source, "include")
        .map(|v| v.rsplit('.').next().unwrap_or("").trim().to_string())
        .unwrap_or_else(|| "PROPERTY".to_string());
    let property = extract_annotation_named_arg(node, source, "property")
        .map(|v| clean_string_literal(v.trim()))
        .filter(|v| !v.is_empty());
    Some(JavaJsonTypeInfo {
        use_id,
        include,
        property,
    })
}

/// Reads the `@JsonSubTypes({ @JsonSubTypes.Type(value = X.class, name = "T"), … })` list in
/// declaration order, which is the order the artifact must publish so sealed digests stay
/// reproducible across runs.
fn parse_json_sub_types(node: Node, source: &str) -> Vec<JavaJsonSubType> {
    let mut out = Vec::new();
    let Some(args) = node.child_by_field_name("arguments") else {
        return out;
    };
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        collect_sub_type_entries(child, source, &mut out);
    }
    out
}

fn collect_sub_type_entries(node: Node, source: &str, out: &mut Vec<JavaJsonSubType>) {
    if node.kind() == "annotation" {
        let name = extract_annotation_name(node, source);
        if name.ends_with("JsonSubTypes.Type") || name == "Type" {
            if let Some(type_name) = extract_annotation_named_arg(node, source, "value") {
                let clean = type_name
                    .trim()
                    .trim_end_matches(".class")
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !clean.is_empty() {
                    let token = extract_annotation_named_arg(node, source, "name")
                        .map(|v| clean_string_literal(v.trim()))
                        .filter(|v| !v.is_empty());
                    out.push(JavaJsonSubType {
                        type_name: clean,
                        token,
                    });
                }
            }
            return;
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_sub_type_entries(child, source, out);
    }
}

/// The caller-visible name of a bound parameter: a bare positional literal, or the `value` /
/// `name` element. Other literals in the same annotation, such as `defaultValue = "0"`, are
/// values rather than names and must not become the parameter's identity.
fn extract_annotation_param_name(node: Node, source: &str) -> Option<String> {
    let args_node = node.child_by_field_name("arguments")?;
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "string_literal" {
            return Some(clean_string_literal(&node_text(child, source)));
        }
        if child.kind() == "element_value_pair" {
            let key = child
                .child_by_field_name("key")
                .map(|k| node_text(k, source));
            if matches!(key.as_deref(), Some("value") | Some("name")) {
                if let Some(val_node) = child.child_by_field_name("value") {
                    if val_node.kind() == "string_literal" {
                        return Some(clean_string_literal(&node_text(val_node, source)));
                    }
                }
            }
        }
    }
    None
}

fn java_type_key(fqcn: &str, direction: ContractDirection) -> String {
    match direction {
        ContractDirection::Response => format!("java:{}", fqcn),
        ContractDirection::Request => format!("java:{}:request", fqcn),
    }
}

fn annotation_provenance(node: Node, source: &str, file: &str) -> SourceProvenance {
    SourceProvenance {
        language: SourceLanguage::Java,
        file: file.to_string(),
        line: node.start_position().row as u32 + 1,
        column: Some(node.start_position().column as u32 + 1),
        ast_identity: None,
        annotation_or_schema: Some(node_text(node, source)),
        sha256: None,
        evidence_classification: Some(EvidenceClassification::ImplementationDerived),
    }
}

fn unsupported_annotation(node: Node, source: &str, file: &str) -> String {
    format!(
        "UNSUPPORTED_CONSTRUCT: {} at {}:{}",
        node_text(node, source),
        file,
        node.start_position().row + 1
    )
}

fn annotation_arg_node<'a>(node: Node<'a>, source: &str, key: &str) -> Option<Node<'a>> {
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.named_children(&mut cursor) {
        if child.kind() == "element_value_pair" {
            if child
                .child_by_field_name("key")
                .is_some_and(|n| node_text(n, source) == key)
            {
                return child.child_by_field_name("value");
            }
        } else if key == "value"
            && child.kind() != "line_comment"
            && child.kind() != "block_comment"
        {
            return Some(child);
        }
    }
    None
}

fn annotation_string_value(node: Node, source: &str, constants: &ConstantTable) -> Option<String> {
    let value = annotation_arg_node(node, source, "value")?;
    resolved_wire_name(value, source, constants).filter(|s| !s.is_empty())
}

/// Resolve only literal constants in supported lexical/import scopes. Unresolved declarations
/// and ambiguous imports fail closed rather than borrowing another owner's value.
fn resolved_wire_name(value: Node, source: &str, constants: &ConstantTable) -> Option<String> {
    if let Some(literal) = literal_string(value, source) {
        return Some(literal);
    }
    match value.kind() {
        "identifier" => {
            let name = node_text(value, source).trim().to_string();
            let mut class = value.parent()?;
            loop {
                if matches!(
                    class.kind(),
                    "class_declaration"
                        | "interface_declaration"
                        | "enum_declaration"
                        | "record_declaration"
                ) {
                    if direct_field_names(class, source).contains(&name) {
                        return find_string_constant(class, &name, source);
                    }
                    if has_inherited_scope(class) {
                        return None;
                    }
                }
                match class.parent() {
                    Some(parent) => class = parent,
                    None => break,
                }
            }
            let owner = static_import_owner(value, source, &name, constants)?;
            lookup_constant(constants, &owner, &name)
        }
        // `Constants.LOGIN_REGEX`: a compile-time constant of another type. It is only evidence
        // when that type is indexed and really declares the literal, so anything unresolved
        // (a different class with the same simple name, a computed value) stays None.
        "field_access" | "scoped_identifier" => {
            let text: String = node_text(value, source)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("");
            let (qualifier, name) = text.rsplit_once('.')?;
            let fqcn = resolve_qualifier_fqcn(value, qualifier.trim(), source, constants);
            let fqcn = fqcn?;
            if let Some(found) = lookup_constant(constants, &fqcn, name.trim()) {
                return Some(found);
            }
            // A nested type is written `Outer.Inner.NAME` while the index is keyed by FQCN.
            None
        }
        _ => None,
    }
}

/// Resolve an indexed type owner; never select the first of competing import candidates.
fn resolve_qualifier_fqcn(
    value: Node,
    qualifier: &str,
    source: &str,
    constants: &ConstantTable,
) -> Option<String> {
    let mut root = value;
    while let Some(parent) = root.parent() {
        root = parent;
    }
    let mut package = String::new();
    let mut imports: Vec<String> = Vec::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        match child.kind() {
            "package_declaration" => {
                package = node_text(child, source)
                    .trim_start_matches("package")
                    .trim()
                    .trim_end_matches(';')
                    .trim()
                    .to_string();
            }
            "import_declaration" => {
                let text = node_text(child, source);
                let path = text
                    .trim_start_matches("import")
                    .trim()
                    .trim_end_matches(';')
                    .trim()
                    .to_string();
                if !path.starts_with("static ") && !path.is_empty() {
                    imports.push(path);
                }
            }
            _ => {}
        }
    }
    let (head, tail) = match qualifier.split_once('.') {
        Some((head, tail)) => (head, Some(tail)),
        None => (qualifier, None),
    };
    // A field named like the qualifier may denote a value, not a type; do not guess.
    let mut enclosing = Vec::new();
    let mut node = value;
    while let Some(parent) = node.parent() {
        node = parent;
        if matches!(
            node.kind(),
            "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "record_declaration"
        ) {
            if direct_field_names(node, source).contains(head) {
                return None;
            }
            enclosing.push(node);
        }
    }
    let qualify = |prefix: &str, name: &str| {
        if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}.{name}")
        }
    };
    let with_tail = |owner: String| match tail {
        Some(tail) => format!("{owner}.{tail}"),
        None => owner,
    };
    // Enclosing and nested types precede compilation-unit imports.
    for index in 0..enclosing.len() {
        let names: Vec<_> = enclosing[index..]
            .iter()
            .rev()
            .filter_map(|node| {
                node.child_by_field_name("name")
                    .map(|name| node_text(name, source))
            })
            .collect();
        let owner = qualify(&package, &names.join("."));
        if names.last().is_some_and(|name| name == head) {
            return Some(with_tail(owner));
        }
        let nested = qualify(&owner, head);
        if constants.members.contains_key(&nested) {
            return Some(with_tail(nested));
        }
        // A qualified static member names a type, not an inherited field; the indexed
        // type below is stronger evidence than the superclass ambiguity this used to
        // fail on. Only a directly declared field of the same name still blocks.
    }
    let exact: BTreeSet<_> = imports
        .iter()
        .filter(|import| import.rsplit('.').next() == Some(head) && !import.ends_with('*'))
        .collect();
    if !exact.is_empty() {
        return (exact.len() == 1).then(|| with_tail((*exact.first().unwrap()).clone()));
    }
    let local = qualify(&package, head);
    if constants.members.contains_key(&local) {
        return Some(with_tail(local));
    }
    // A fully qualified, indexed owner needs no import.
    if constants.members.contains_key(qualifier) {
        return Some(qualifier.to_string());
    }
    let wildcard: BTreeSet<_> = imports
        .iter()
        .filter(|import| import.ends_with(".*"))
        .collect();
    let candidates: BTreeSet<_> = wildcard
        .iter()
        .map(|import| qualify(import.trim_end_matches(".*"), head))
        .filter(|owner| constants.members.contains_key(owner))
        .collect();
    // Multiple unindexed packages cannot prove absence of a competing type.
    if wildcard.len() > 1 || candidates.len() != 1 {
        return None;
    }
    candidates.into_iter().next().map(with_tail)
}

fn lookup_constant(constants: &ConstantTable, fqcn: &str, name: &str) -> Option<String> {
    constants
        .strings
        .get(fqcn)
        .and_then(|class| class.get(name))
        .cloned()
}

fn lookup_int_constant(constants: &ConstantTable, fqcn: &str, name: &str) -> Option<i64> {
    constants
        .ints
        .get(fqcn)
        .and_then(|class| class.get(name))
        .copied()
}

fn find_int_constant(
    class: Node,
    name: &str,
    source: &str,
    _constants: &ConstantTable,
) -> Option<i64> {
    collect_static_int_constants(class, source)
        .get(name)
        .copied()
}

/// Collects `static final int|long NAME = <integer literal>` members declared directly by a type.
fn collect_static_int_constants(node: Node, source: &str) -> BTreeMap<String, i64> {
    let mut constants = BTreeMap::new();
    let Some(body) = node.child_by_field_name("body") else {
        return constants;
    };
    let mut cursor = body.walk();
    for child in body.children(&mut cursor) {
        if child.kind() != "field_declaration" {
            continue;
        }
        let mut modifiers = String::new();
        let mut declared_type = String::new();
        let mut declarators = Vec::new();
        let mut inner = child.walk();
        for part in child.children(&mut inner) {
            match part.kind() {
                "modifiers" => modifiers = node_text(part, source),
                "integral_type" => {
                    if declared_type.is_empty() {
                        declared_type = node_text(part, source).trim().to_string();
                    }
                }
                "variable_declarator" => declarators.push(part),
                _ => {}
            }
        }
        let words: Vec<&str> = modifiers.split_whitespace().collect();
        if !(words.contains(&"static")
            && words.contains(&"final")
            && matches!(declared_type.as_str(), "int" | "long"))
        {
            continue;
        }
        for declarator in declarators {
            let declared = declarator
                .child_by_field_name("name")
                .map(|n| node_text(n, source))
                .unwrap_or_default();
            if let Some(value) = declarator
                .child_by_field_name("value")
                .and_then(|v| integer_literal(v, source))
            {
                if !declared.is_empty() {
                    constants.insert(declared, value);
                }
            }
        }
    }
    constants
}

/// Preserve the imported member and Java's explicit-before-on-demand precedence.
fn static_import_owner(
    value: Node,
    source: &str,
    name: &str,
    constants: &ConstantTable,
) -> Option<String> {
    let mut root = value;
    while let Some(parent) = root.parent() {
        root = parent;
    }
    let mut explicit = BTreeSet::new();
    let mut wildcard = BTreeSet::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "import_declaration" {
            continue;
        }
        let text = node_text(child, source);
        let Some(path) = text
            .trim()
            .trim_start_matches("import")
            .trim()
            .trim_end_matches(';')
            .trim()
            .strip_prefix("static ")
        else {
            continue;
        };
        let Some((owner, member)) = path.rsplit_once('.') else {
            continue;
        };
        if member == name {
            explicit.insert(owner.to_string());
        }
        if member == "*" {
            wildcard.insert(owner.to_string());
        }
    }
    if !explicit.is_empty() {
        return (explicit.len() == 1).then(|| explicit.into_iter().next().unwrap());
    }
    let mut candidates = BTreeSet::new();
    for owner in wildcard {
        // An unindexed owner might declare this member: its absence is not evidence.
        let members = constants.members.get(&owner)?;
        if members.contains(name) {
            candidates.insert(owner);
        } else if constants.inherited_scopes.contains(&owner) {
            return None;
        }
    }
    (candidates.len() == 1).then(|| candidates.into_iter().next().unwrap())
}

/// A same-named custom annotation is not evidence of provider assignment.
fn jpa_generated_value(annotation: Node, source: &str, constants: &ConstantTable) -> Option<bool> {
    let written = node_text(annotation.child_by_field_name("name")?, source);
    let is_jpa = |name: &str| {
        matches!(
            name,
            "jakarta.persistence.GeneratedValue" | "javax.persistence.GeneratedValue"
        )
    };
    if written.contains('.') {
        return Some(is_jpa(&written));
    }
    if let Some(owner) = resolve_qualifier_fqcn(annotation, &written, source, constants) {
        return Some(is_jpa(&owner));
    }
    let mut root = annotation;
    while let Some(parent) = root.parent() {
        root = parent;
    }
    let mut cursor = root.walk();
    let imports: Vec<_> = root
        .named_children(&mut cursor)
        .filter(|node| node.kind() == "import_declaration")
        .map(|node| {
            node_text(node, source)
                .trim_start_matches("import")
                .trim()
                .trim_end_matches(';')
                .trim()
                .to_string()
        })
        .filter(|path| !path.starts_with("static "))
        .collect();
    if imports
        .iter()
        .any(|path| path.rsplit('.').next() == Some(written.as_str()))
    {
        return None;
    }
    let wildcard: BTreeSet<_> = imports.iter().filter(|path| path.ends_with(".*")).collect();
    // Unindexed competing on-demand packages cannot establish annotation identity.
    if wildcard.len() == 1 {
        let owner = format!("{}.{}", wildcard.first()?.trim_end_matches(".*"), written);
        if is_jpa(&owner) {
            return Some(true);
        }
    }
    None
}

/// Inherited constants/types are not evaluated by this literal-only resolver.
fn has_inherited_scope(class: Node) -> bool {
    if class.child_by_field_name("superclass").is_some()
        || class.child_by_field_name("interfaces").is_some()
    {
        return true;
    }
    let mut cursor = class.walk();
    let inherited = class
        .named_children(&mut cursor)
        .any(|node| node.kind() == "extends_interfaces");
    inherited
}

fn direct_field_names(class: Node, source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Some(body) = class.child_by_field_name("body") else {
        return names;
    };
    let mut cursor = body.walk();
    for field in body
        .named_children(&mut cursor)
        .filter(|node| node.kind() == "field_declaration")
    {
        let mut inner = field.walk();
        for declarator in field
            .named_children(&mut inner)
            .filter(|node| node.kind() == "variable_declarator")
        {
            if let Some(name) = declarator.child_by_field_name("name") {
                names.insert(node_text(name, source));
            }
        }
    }
    names
}

/// Parses every source once to build the compile-time constant table consulted while members are
/// parsed. Only literal `static final String` members are recorded; anything else stays unresolved.
fn build_service_method_table(sources: &[(String, String)]) -> Result<ServiceMethodTable> {
    let mut table = ServiceMethodTable::default();
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .map_err(|e| anyhow!("Failed to set tree-sitter Java language: {}", e))?;
    for (_path, content) in sources {
        let Some(tree) = parser.parse(content, None) else {
            continue;
        };
        collect_service_methods(tree.root_node(), content, &mut table, None);
    }
    Ok(table)
}

fn collect_service_methods(
    node: Node,
    source: &str,
    table: &mut ServiceMethodTable,
    class_name: Option<&str>,
) {
    let current_class = if matches!(
        node.kind(),
        "class_declaration"
            | "interface_declaration"
            | "record_declaration"
            | "enum_declaration"
            | "annotation_type_declaration"
    ) {
        node.child_by_field_name("name")
            .map(|name| node_text(name, source).trim().to_string())
    } else {
        None
    };
    let active_class = current_class.as_deref().or(class_name);

    if node.kind() == "method_declaration" {
        if let (Some(name), Some(return_type)) = (
            node.child_by_field_name("name"),
            node.child_by_field_name("type"),
        ) {
            if let Some(class_name) = active_class {
                let method = node_text(name, source).trim().to_string();
                let return_type = node_text(return_type, source).trim().to_string();
                let methods = table.methods.entry(class_name.to_string()).or_default();
                match methods.get(&method) {
                    None => {
                        methods.insert(method, Some(return_type));
                    }
                    Some(Some(existing)) if existing == &return_type => {}
                    Some(_) => {
                        methods.insert(method, None);
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_service_methods(child, source, table, active_class);
    }
}

fn build_constant_table(sources: &[(String, String)]) -> Result<ConstantTable> {
    let mut table = ConstantTable::default();
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .map_err(|e| anyhow!("Failed to set tree-sitter Java language: {}", e))?;
    for (_path, content) in sources {
        let Some(tree) = parser.parse(content, None) else {
            continue;
        };
        let root = tree.root_node();
        let mut package = String::new();
        let mut cursor = root.walk();
        for child in root.children(&mut cursor) {
            if child.kind() == "package_declaration" {
                package = node_text(child, content)
                    .trim_start_matches("package")
                    .trim()
                    .trim_end_matches(';')
                    .trim()
                    .to_string();
            }
        }
        collect_type_constants(root, content, &package, &mut table);
    }
    Ok(table)
}

fn collect_type_constants(node: Node, source: &str, prefix: &str, table: &mut ConstantTable) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if !is_type_declaration(child.kind()) {
            continue;
        }
        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        let name = node_text(name_node, source);
        let fqcn = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        table
            .members
            .insert(fqcn.clone(), direct_field_names(child, source));
        if has_inherited_scope(child) {
            table.inherited_scopes.insert(fqcn.clone());
        }
        let constants = collect_static_string_constants(child, source);
        if !constants.is_empty() {
            table.strings.insert(fqcn.clone(), constants);
        }
        let integer_constants = collect_static_int_constants(child, source);
        if !integer_constants.is_empty() {
            table.ints.insert(fqcn.clone(), integer_constants);
        }
        if let Some(body) = child.child_by_field_name("body") {
            collect_type_constants(body, source, &fqcn, table);
        }
    }
}

/// Collects `static final String NAME = "literal"` members declared directly by a type.
fn collect_static_string_constants(node: Node, source: &str) -> BTreeMap<String, String> {
    let mut constants = BTreeMap::new();
    let body = match node.child_by_field_name("body") {
        Some(body) => body,
        None => {
            let mut cursor = node.walk();
            let found = node.children(&mut cursor).find(|child| {
                matches!(
                    child.kind(),
                    "class_body" | "interface_body" | "enum_body" | "record_body"
                )
            });
            match found {
                Some(body) => body,
                None => return constants,
            }
        }
    };
    let mut cursor = body.walk();
    for child in body.children(&mut cursor) {
        if child.kind() != "field_declaration" {
            continue;
        }
        let mut modifiers = String::new();
        let mut declared_type = String::new();
        let mut declarators = Vec::new();
        let mut inner = child.walk();
        for part in child.children(&mut inner) {
            match part.kind() {
                "modifiers" => modifiers = node_text(part, source),
                "type_identifier" | "generic_type" | "scoped_type_identifier" => {
                    if declared_type.is_empty() {
                        declared_type = node_text(part, source).trim().to_string();
                    }
                }
                "variable_declarator" => declarators.push(part),
                _ => {}
            }
        }
        let words: Vec<&str> = modifiers.split_whitespace().collect();
        if !(words.contains(&"static")
            && words.contains(&"final")
            && matches!(declared_type.as_str(), "String" | "java.lang.String"))
        {
            continue;
        }
        for declarator in declarators {
            let declared = declarator
                .child_by_field_name("name")
                .map(|n| node_text(n, source))
                .unwrap_or_default();
            if let Some(literal) = declarator
                .child_by_field_name("value")
                .and_then(|v| literal_string(v, source))
            {
                if !declared.is_empty() {
                    constants.insert(declared, literal);
                }
            }
        }
    }
    constants
}

fn find_string_constant(node: Node, name: &str, source: &str) -> Option<String> {
    collect_static_string_constants(node, source)
        .get(name)
        .cloned()
}

fn literal_string(node: Node, source: &str) -> Option<String> {
    if node.kind() != "string_literal" {
        return None;
    }
    serde_json::from_str(&node_text(node, source)).ok()
}

fn member_annotation_error(
    node: Node,
    source: &str,
    file: &str,
    constants: &ConstantTable,
) -> Option<String> {
    for annotation in collect_annotations(node) {
        let name = extract_annotation_name(annotation, source);
        let invalid = match name.as_str() {
            "JsonProperty" | "JsonGetter" | "JsonSetter" => {
                annotation_arg_node(annotation, source, "value")
                    .is_some_and(|value| resolved_wire_name(value, source, constants).is_none())
            }
            "JsonIgnore" => annotation_arg_node(annotation, source, "value")
                .is_some_and(|value| !matches!(value.kind(), "true" | "false")),
            _ => false,
        };
        if invalid {
            return Some(unsupported_annotation(annotation, source, file));
        }
    }
    None
}

fn json_ignored(node: Node, source: &str) -> bool {
    annotation_arg_node(node, source, "value")
        .map(|value| value.kind() != "false")
        .unwrap_or(true)
}

fn parse_jackson_access(
    node: Node,
    source: &str,
    file: &str,
) -> (JacksonAccess, bool, Option<String>) {
    for annotation in collect_annotations(node) {
        if extract_annotation_name(annotation, source) != "JsonProperty" {
            continue;
        }
        let Some(raw) = extract_annotation_named_arg(annotation, source, "access") else {
            return (JacksonAccess::Auto, false, None);
        };
        let Some(value) = annotation_arg_node(annotation, source, "access") else {
            continue;
        };
        let parts: Vec<&str> = raw.trim().split('.').collect();
        let token = parts.last().copied().unwrap_or("");
        let qualified = matches!(
            parts[..parts.len().saturating_sub(1)].join(".").as_str(),
            "Access"
                | "JsonProperty.Access"
                | "com.fasterxml.jackson.annotation.JsonProperty.Access"
        );
        let static_import = if value.kind() == "identifier" {
            let mut root = node;
            while let Some(parent) = root.parent() {
                root = parent;
            }
            let mut cursor = root.walk();
            let imported = root.named_children(&mut cursor).any(|child| {
                if child.kind() != "import_declaration" {
                    return false;
                }
                let text = node_text(child, source);
                let tokens: Vec<_> = text.split_whitespace().collect();
                tokens.get(1) == Some(&"static")
                    && tokens.get(2).is_some_and(|target| {
                        let target = target.trim_end_matches(';');
                        target
                            == format!(
                                "com.fasterxml.jackson.annotation.JsonProperty.Access.{}",
                                token
                            )
                            || target == "com.fasterxml.jackson.annotation.JsonProperty.Access.*"
                    })
            });
            imported
        } else {
            false
        };
        let access = match token {
            "AUTO" => Some(JacksonAccess::Auto),
            "READ_ONLY" => Some(JacksonAccess::ReadOnly),
            "WRITE_ONLY" => Some(JacksonAccess::WriteOnly),
            "READ_WRITE" => Some(JacksonAccess::ReadWrite),
            _ => None,
        };
        if matches!(
            value.kind(),
            "field_access" | "scoped_identifier" | "identifier"
        ) && (qualified || static_import)
        {
            if let Some(access) = access {
                return (access, true, None);
            }
        }
        return (
            JacksonAccess::Auto,
            true,
            Some(unsupported_annotation(annotation, source, file)),
        );
    }
    (JacksonAccess::Auto, false, None)
}

fn literal_integer(node: Node, source: &str, constants: &ConstantTable) -> Option<i64> {
    if matches!(
        node.kind(),
        "identifier" | "field_access" | "scoped_identifier"
    ) {
        let text: String = node_text(node, source)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("");
        if let Some((qualifier, name)) = text.rsplit_once('.') {
            let fqcn = resolve_qualifier_fqcn(node, qualifier.trim(), source, constants)?;
            return lookup_int_constant(constants, &fqcn, name.trim());
        } else {
            let mut class = node.parent()?;
            loop {
                if matches!(
                    class.kind(),
                    "class_declaration"
                        | "interface_declaration"
                        | "enum_declaration"
                        | "record_declaration"
                ) {
                    if direct_field_names(class, source).contains(text.trim()) {
                        return find_int_constant(class, text.trim(), source, constants);
                    }
                    if has_inherited_scope(class) {
                        return None;
                    }
                }
                match class.parent() {
                    Some(parent) => class = parent,
                    None => break,
                }
            }
            let owner = static_import_owner(node, source, text.trim(), constants)?;
            return lookup_int_constant(constants, &owner, text.trim());
        }
    }
    integer_literal(node, source)
}

/// Literal-only collection must never re-enter constant-name resolution through an initializer.
fn integer_literal(node: Node, source: &str) -> Option<i64> {
    let raw = node_text(node, source).replace('_', "");
    if !matches!(node.kind(), "decimal_integer_literal" | "unary_expression") {
        return None;
    }
    let raw = raw.trim_end_matches(['l', 'L']);
    if !raw
        .trim_start_matches(['-', '+'])
        .chars()
        .all(|c| c.is_ascii_digit())
    {
        return None;
    }
    raw.parse().ok()
}

fn parse_validation(
    node: Node,
    source: &str,
    file: &str,
    constants: &ConstantTable,
) -> (Vec<ValidationConstraint>, Option<String>) {
    let mut constraints = Vec::new();
    let mut unsupported = None;
    for annotation in collect_annotations(node) {
        let name = extract_annotation_name(annotation, source);
        // Spring's configured binding grammar is not captured by the default temporal format.
        if name == "DateTimeFormat" {
            unsupported.get_or_insert_with(|| unsupported_annotation(annotation, source, file));
            continue;
        }
        let kind = match name.as_str() {
            "NotNull" => ValidationConstraintKind::NotNull,
            "NotBlank" => ValidationConstraintKind::NotBlank,
            "NotEmpty" => ValidationConstraintKind::NotEmpty,
            "Email" => ValidationConstraintKind::Email,
            "Size" => ValidationConstraintKind::Size,
            "Min" => ValidationConstraintKind::Min,
            "Max" => ValidationConstraintKind::Max,
            "Positive" => ValidationConstraintKind::Positive,
            "Pattern" => ValidationConstraintKind::Pattern,
            _ => {
                let written = annotation
                    .child_by_field_name("name")
                    .map(|n| node_text(n, source))
                    .unwrap_or_default();
                let base = written
                    .strip_suffix(".List")
                    .unwrap_or(&written)
                    .rsplit('.')
                    .next()
                    .unwrap_or(&written);
                if matches!(
                    base,
                    "AssertFalse"
                        | "AssertTrue"
                        | "DecimalMax"
                        | "DecimalMin"
                        | "Digits"
                        | "Future"
                        | "FutureOrPresent"
                        | "Past"
                        | "PastOrPresent"
                        | "Null"
                        | "Negative"
                        | "NegativeOrZero"
                        | "PositiveOrZero"
                        | "NotNull"
                        | "NotBlank"
                        | "NotEmpty"
                        | "Email"
                        | "Size"
                        | "Min"
                        | "Max"
                        | "Positive"
                        | "Pattern"
                ) || written.starts_with("jakarta.validation.constraints.")
                    || written.starts_with("javax.validation.constraints.")
                {
                    unsupported
                        .get_or_insert_with(|| unsupported_annotation(annotation, source, file));
                }
                continue;
            }
        };
        let mut invalid = false;
        if let Some(args) = annotation.child_by_field_name("arguments") {
            let mut cursor = args.walk();
            for arg in args.named_children(&mut cursor) {
                if arg.kind() != "element_value_pair" {
                    continue;
                }
                let key = arg
                    .child_by_field_name("key")
                    .map(|k| node_text(k, source))
                    .unwrap_or_default();
                if key == "groups" {
                    let empty = arg.child_by_field_name("value").is_some_and(|v| {
                        v.kind() == "element_value_array_initializer" && v.named_child_count() == 0
                    });
                    invalid |= !empty;
                } else if !(key == "message"
                    || (name == "Size" && matches!(key.as_str(), "min" | "max"))
                    || (matches!(name.as_str(), "Min" | "Max") && key == "value")
                    || (name == "Pattern" && key == "regexp"))
                {
                    invalid = true;
                }
            }
        }
        let value = match name.as_str() {
            "Size" => {
                let min = annotation_arg_node(annotation, source, "min")
                    .map(|v| literal_integer(v, source, constants))
                    .unwrap_or(Some(0));
                let max = annotation_arg_node(annotation, source, "max")
                    .map(|v| literal_integer(v, source, constants))
                    .unwrap_or(Some(i32::MAX as i64));
                match (min, max) {
                    (Some(min), Some(max)) if min >= 0 && max >= min && max <= i32::MAX as i64 => {
                        Some(json!({"min": min, "max": max}))
                    }
                    _ => {
                        invalid = true;
                        None
                    }
                }
            }
            "Min" | "Max" => {
                let value = annotation_arg_node(annotation, source, "value")
                    .and_then(|v| literal_integer(v, source, constants));
                invalid |= value.is_none();
                value.map(|v| json!(v))
            }
            "Pattern" => {
                // `regexp` may name a compile-time constant; only a resolvable literal is evidence.
                let value = annotation_arg_node(annotation, source, "regexp")
                    .and_then(|v| resolved_wire_name(v, source, constants));
                invalid |= value.is_none();
                value.map(|v| json!(v))
            }
            _ => None,
        };
        if invalid {
            unsupported.get_or_insert_with(|| unsupported_annotation(annotation, source, file));
            continue;
        }
        constraints.push(ValidationConstraint {
            kind,
            value,
            message: annotation_arg_node(annotation, source, "message")
                .filter(|v| v.kind() == "string_literal")
                .map(|v| clean_string_literal(&node_text(v, source))),
            provenance: Some(annotation_provenance(annotation, source, file)),
        });
    }
    (constraints, unsupported)
}

fn validation_nullability(constraints: &[ValidationConstraint]) -> Option<bool> {
    constraints
        .iter()
        .any(|c| {
            matches!(
                c.kind,
                ValidationConstraintKind::NotNull
                    | ValidationConstraintKind::NotBlank
                    | ValidationConstraintKind::NotEmpty
            )
        })
        .then_some(false)
}

fn extract_annotation_named_arg(node: Node, source: &str, target_key: &str) -> Option<String> {
    if let Some(args_node) = node.child_by_field_name("arguments") {
        let mut cursor = args_node.walk();
        for child in args_node.children(&mut cursor) {
            if child.kind() == "element_value_pair" {
                if let Some(key_node) = child.child_by_field_name("key") {
                    if node_text(key_node, source) == target_key {
                        if let Some(val_node) = child.child_by_field_name("value") {
                            return Some(node_text(val_node, source));
                        }
                    }
                }
            }
        }
    }
    None
}

/// Every HTTP method Spring MVC's standard `HttpMethod` enum names. A `@RequestMapping`
/// without a `method` condition matches all of them, so each one is a real endpoint row.
const ALL_SPRING_HTTP_METHODS: &[&str] =
    &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// Quarkus reactive `@Route` methods: `methods` may be one `HttpMethod` or an array;
/// absent means the handler accepts every method.
fn quarkus_route_methods(node: Node, source: &str) -> Result<Vec<String>, String> {
    let Some(args) = node.child_by_field_name("arguments") else {
        return Ok(ALL_SPRING_HTTP_METHODS
            .iter()
            .map(|verb| verb.to_string())
            .collect());
    };
    let mut saw_methods = false;
    let mut verbs = Vec::new();
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        if child.kind() != "element_value_pair" {
            continue;
        }
        let Some(key) = child.child_by_field_name("key") else {
            continue;
        };
        if node_text(key, source).trim() != "methods" {
            continue;
        }
        saw_methods = true;
        let Some(value) = child.child_by_field_name("value") else {
            return Err("has a methods condition without a value".to_string());
        };
        if !collect_request_method_names(value, source, &mut verbs) {
            return Err("uses a methods condition this reader cannot resolve".to_string());
        }
    }
    if !saw_methods || verbs.is_empty() {
        return Ok(ALL_SPRING_HTTP_METHODS
            .iter()
            .map(|verb| verb.to_string())
            .collect());
    }
    verbs.sort();
    verbs.dedup();
    Ok(verbs)
}

/// The verbs a `@RequestMapping` declares. Multi-verb arrays expand to every verb; an
/// annotation with no `method` condition matches every method. A `method` condition built
/// from a constant cannot be read from this annotation alone, and is reported instead of
/// guessed.
/// The `@RequestLine("GET /path")` grammar of native OpenFeign. The annotation's value is a
/// literal method token followed by a URI template; anything else is reported, not guessed.
fn parse_request_line(node: Node, source: &str) -> Result<(String, String), String> {
    let Some(value) = annotation_single_string(node, source) else {
        return Err("does not carry a literal \"METHOD /path\" value".to_string());
    };
    let value = value.trim();
    let mut parts = value.splitn(2, char::is_whitespace);
    let method = parts.next().unwrap_or("").trim().to_ascii_uppercase();
    if !ALL_SPRING_HTTP_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "uses `{method}`, which is not a standard HTTP method"
        ));
    }
    let path = parts.next().unwrap_or("").trim();
    Ok((method, path.to_string()))
}

fn annotation_has_arg(node: Node, source: &str, wanted: &str) -> bool {
    let Some(args) = node.child_by_field_name("arguments") else {
        return false;
    };
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        if child.kind() != "element_value_pair" {
            continue;
        }
        if let Some(key) = child.child_by_field_name("key") {
            if node_text(key, source).trim() == wanted {
                return true;
            }
        }
    }
    false
}

/// The single string argument of an annotation, whether written positionally or as
/// `value = "..."`.
fn annotation_single_string(node: Node, source: &str) -> Option<String> {
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.named_children(&mut cursor) {
        if child.kind() == "string_literal" {
            return Some(clean_string_literal(&node_text(child, source)));
        }
        if child.kind() == "element_value_pair" {
            let key = child
                .child_by_field_name("key")
                .map(|k| node_text(k, source))
                .unwrap_or_default();
            if key.trim() == "value" {
                if let Some(value) = child.child_by_field_name("value") {
                    if value.kind() == "string_literal" {
                        return Some(clean_string_literal(&node_text(value, source)));
                    }
                }
            }
        }
    }
    None
}

fn extract_request_mapping_methods(node: Node, source: &str) -> Result<Vec<String>, String> {
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return Ok(ALL_SPRING_HTTP_METHODS
            .iter()
            .map(|v| v.to_string())
            .collect());
    };
    let mut saw_method = false;
    let mut methods = Vec::new();
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "element_value_pair" {
            continue;
        }
        let Some(key) = child.child_by_field_name("key") else {
            continue;
        };
        if node_text(key, source).trim() != "method" {
            continue;
        }
        saw_method = true;
        let Some(value) = child.child_by_field_name("value") else {
            continue;
        };
        if !collect_request_method_names(value, source, &mut methods) {
            return Err(
                "uses a `method` condition this reader cannot resolve to literal RequestMethod values"
                    .to_string(),
            );
        }
    }
    if !saw_method {
        return Ok(ALL_SPRING_HTTP_METHODS
            .iter()
            .map(|v| v.to_string())
            .collect());
    }
    if methods.is_empty() {
        // `method = {}` places no restriction on the HTTP method.
        return Ok(ALL_SPRING_HTTP_METHODS
            .iter()
            .map(|v| v.to_string())
            .collect());
    }
    methods.sort();
    methods.dedup();
    Ok(methods)
}

/// True when the method-expression node names only literal `RequestMethod` values (or is an
/// empty array, which Spring treats as no restriction).
fn collect_request_method_names(node: Node, source: &str, out: &mut Vec<String>) -> bool {
    match node.kind() {
        "element_value_array_initializer" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if !collect_request_method_names(child, source, out) {
                    return false;
                }
            }
            true
        }
        "field_access" | "member_expression" | "identifier" | "scoped_identifier" => {
            let text = node_text(node, source);
            let name = text.trim().rsplit('.').next().unwrap_or("").trim();
            if ALL_SPRING_HTTP_METHODS.contains(&name) {
                out.push(name.to_string());
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

/// `params` selectors a mapping annotation declares, and whether every other condition on
/// that annotation is one this reader can represent. `headers`, `consumes` and `produces`
/// select requests too, but the contract IR has no selector for them.
fn parse_mapping_conditions(node: Node, source: &str) -> (Vec<String>, bool) {
    let mut params = Vec::new();
    let mut complete = true;
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return (params, complete);
    };
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "element_value_pair" {
            continue;
        }
        let Some(key) = child.child_by_field_name("key") else {
            continue;
        };
        let key = node_text(key, source);
        let Some(value) = child.child_by_field_name("value") else {
            complete = false;
            continue;
        };
        match key.trim() {
            "params" => match exact_string_array(value, source) {
                Some(values) => params.extend(values),
                None => complete = false,
            },
            // A JSON media type is the extractor's own assumption, so an endpoint restricted
            // to JSON is fully described. Any other media type, or a value this reader cannot
            // resolve, changes the wire and makes the conditions incomplete.
            "consumes" | "produces" => match media_type_values(value, source) {
                Some(values)
                    if values
                        .iter()
                        .all(|value| value.to_ascii_lowercase().contains("json")) => {}
                _ => complete = false,
            },
            "headers" => complete = false,
            _ => {}
        }
    }
    (params, complete)
}

/// Media types named by a mapping annotation. Jackson's own constants
/// (`MediaType.APPLICATION_JSON_VALUE`) are read as their final identifier, which carries
/// the media type's name; any other expression is unresolved.
fn media_type_values(node: Node, source: &str) -> Option<Vec<String>> {
    match node.kind() {
        "string_literal" => Some(vec![clean_string_literal(&node_text(node, source))]),
        "field_access" | "member_expression" | "identifier" | "scoped_identifier" => {
            let text = node_text(node, source);
            Some(vec![text
                .trim()
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_string()])
        }
        "element_value_array_initializer" => {
            let mut values = Vec::new();
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                match child.kind() {
                    "line_comment" | "block_comment" => {}
                    _ => values.extend(media_type_values(child, source)?),
                }
            }
            Some(values)
        }
        _ => None,
    }
}

/// A string literal or an array of string literals, exactly. Anything else (a constant, an
/// expression) is not statically known here and must not be read as an empty selector set.
fn exact_string_array(node: Node, source: &str) -> Option<Vec<String>> {
    match node.kind() {
        "string_literal" => Some(vec![clean_string_literal(&node_text(node, source))]),
        "element_value_array_initializer" => {
            let mut values = Vec::new();
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                match child.kind() {
                    "string_literal" => {
                        values.push(clean_string_literal(&node_text(child, source)))
                    }
                    "line_comment" | "block_comment" => {}
                    _ => return None,
                }
            }
            Some(values)
        }
        _ => None,
    }
}

fn node_text(node: Node, source: &str) -> String {
    source[node.start_byte()..node.end_byte()].to_string()
}

fn extract_declared_responses(node: Node, source: &str, out: &mut Vec<JavaDeclaredResponse>) {
    let name = extract_annotation_name(node, source);
    if name == "ApiResponse" {
        let mut status_code = None;
        let mut description = None;
        let mut schema_name = None;
        let mut media_type = None;

        if let Some(args_node) = node.child_by_field_name("arguments") {
            let mut cursor = args_node.walk();
            for child in args_node.children(&mut cursor) {
                if child.kind() == "element_value_pair" {
                    if let (Some(k), Some(v)) = (
                        child.child_by_field_name("key"),
                        child.child_by_field_name("value"),
                    ) {
                        let key_text = node_text(k, source);
                        match key_text.as_str() {
                            "responseCode" | "value" => {
                                let val_text = clean_string_literal(&node_text(v, source));
                                status_code = val_text.parse::<u16>().ok();
                            }
                            "description" => {
                                description = Some(clean_string_literal(&node_text(v, source)));
                            }
                            "content" => {
                                parse_content_annotation(
                                    v,
                                    source,
                                    &mut schema_name,
                                    &mut media_type,
                                );
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        out.push(JavaDeclaredResponse {
            status_code,
            schema_name,
            media_type,
            description,
        });
    } else if name == "ApiResponses" || name == "Operation" {
        if let Some(args_node) = node.child_by_field_name("arguments") {
            let mut cursor = args_node.walk();
            for child in args_node.children(&mut cursor) {
                if child.kind() == "element_value_pair" {
                    if let (Some(k), Some(v)) = (
                        child.child_by_field_name("key"),
                        child.child_by_field_name("value"),
                    ) {
                        let key_text = node_text(k, source);
                        if key_text == "value" || key_text == "responses" {
                            inspect_nested_api_responses(v, source, out);
                        }
                    }
                }
            }
        }
    }
}

fn inspect_nested_api_responses(node: Node, source: &str, out: &mut Vec<JavaDeclaredResponse>) {
    if node.kind() == "element_value_array_initializer" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "annotation" {
                extract_declared_responses(child, source, out);
            }
        }
    } else if node.kind() == "annotation" {
        extract_declared_responses(node, source, out);
    }
}

fn parse_content_annotation(
    node: Node,
    source: &str,
    schema_name: &mut Option<String>,
    media_type: &mut Option<String>,
) {
    if node.kind() == "element_value_array_initializer" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "annotation" {
                parse_single_content_annotation(child, source, schema_name, media_type);
            }
        }
    } else if node.kind() == "annotation" {
        parse_single_content_annotation(node, source, schema_name, media_type);
    }
}

fn parse_single_content_annotation(
    node: Node,
    source: &str,
    schema_name: &mut Option<String>,
    media_type: &mut Option<String>,
) {
    if let Some(args_node) = node.child_by_field_name("arguments") {
        let mut cursor = args_node.walk();
        for child in args_node.children(&mut cursor) {
            if child.kind() == "element_value_pair" {
                if let (Some(k), Some(v)) = (
                    child.child_by_field_name("key"),
                    child.child_by_field_name("value"),
                ) {
                    let key_text = node_text(k, source);
                    if key_text == "mediaType" {
                        *media_type = Some(clean_string_literal(&node_text(v, source)));
                    } else if key_text == "schema" && v.kind() == "annotation" {
                        parse_schema_annotation(v, source, schema_name);
                    }
                }
            }
        }
    }
}

fn parse_schema_annotation(node: Node, source: &str, schema_name: &mut Option<String>) {
    if let Some(args_node) = node.child_by_field_name("arguments") {
        let mut cursor = args_node.walk();
        for child in args_node.children(&mut cursor) {
            if child.kind() == "element_value_pair" {
                if let (Some(k), Some(v)) = (
                    child.child_by_field_name("key"),
                    child.child_by_field_name("value"),
                ) {
                    let key_text = node_text(k, source);
                    if key_text == "implementation" {
                        let text = node_text(v, source);
                        let clean = text.trim_end_matches(".class").trim();
                        let simple = clean.rsplit('.').next().unwrap_or(clean);
                        *schema_name = Some(simple.to_string());
                    } else if key_text == "name" {
                        let val = clean_string_literal(&node_text(v, source));
                        if !val.is_empty() {
                            *schema_name = Some(val);
                        }
                    }
                }
            }
        }
    }
}

fn extract_response_status(node: Node, source: &str) -> Option<u16> {
    if let Some(args_node) = node.child_by_field_name("arguments") {
        let mut cursor = args_node.walk();
        for child in args_node.children(&mut cursor) {
            let val_node = if child.kind() == "element_value_pair" {
                child.child_by_field_name("value")
            } else {
                Some(child)
            };
            if let Some(v) = val_node {
                let text = node_text(v, source);
                if let Ok(code) = text.parse::<u16>() {
                    return Some(code);
                }
                if text.contains("NOT_FOUND") {
                    return Some(404);
                }
                if text.contains("BAD_REQUEST") {
                    return Some(400);
                }
                if text.contains("UNAUTHORIZED") {
                    return Some(401);
                }
                if text.contains("FORBIDDEN") {
                    return Some(403);
                }
                if text.contains("CONFLICT") {
                    return Some(409);
                }
                if text.contains("INTERNAL_SERVER_ERROR") {
                    return Some(500);
                }
                if text.contains("CREATED") {
                    return Some(201);
                }
                if text.contains("NO_CONTENT") {
                    return Some(204);
                }
                if text.contains("OK") {
                    return Some(200);
                }
            }
        }
    }
    None
}

fn unwrap_generic_wrapper(type_str: &str) -> String {
    crate::wire_wrapper::peel_declared_type(type_str).unwrap_or_else(|| type_str.trim().to_string())
}

fn problem_detail_wire_type() -> WireType {
    WireType::Object(ObjectWireType {
        name: Some("ProblemDetail".to_string()),
        properties: vec![
            WirePropertyContract {
                wire_name: "type".to_string(),
                aliases: vec![],
                r#type: WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::String,
                    format: None,
                    provenance: None,
                }),
                optional: true,
                nullable: true,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
            WirePropertyContract {
                wire_name: "title".to_string(),
                aliases: vec![],
                r#type: WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::String,
                    format: None,
                    provenance: None,
                }),
                optional: true,
                nullable: true,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
            WirePropertyContract {
                wire_name: "status".to_string(),
                aliases: vec![],
                r#type: WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::Number,
                    format: None,
                    provenance: None,
                }),
                optional: false,
                nullable: false,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
            WirePropertyContract {
                wire_name: "detail".to_string(),
                aliases: vec![],
                r#type: WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::String,
                    format: None,
                    provenance: None,
                }),
                optional: true,
                nullable: true,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
            WirePropertyContract {
                wire_name: "instance".to_string(),
                aliases: vec![],
                r#type: WireType::Primitive(PrimitiveWireType {
                    scalar: PrimitiveScalar::String,
                    format: None,
                    provenance: None,
                }),
                optional: true,
                nullable: true,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
            WirePropertyContract {
                wire_name: "properties".to_string(),
                aliases: vec![],
                r#type: WireType::Map(contract_core::ir::MapWireType {
                    key_type: Box::new(WireType::Primitive(PrimitiveWireType {
                        scalar: PrimitiveScalar::String,
                        format: None,
                        provenance: None,
                    })),
                    value_type: Box::new(WireType::Primitive(PrimitiveWireType {
                        scalar: PrimitiveScalar::Any,
                        format: None,
                        provenance: None,
                    })),
                    provenance: None,
                }),
                optional: true,
                nullable: true,
                server_assigned: false,
                validation_constraints: vec![],
                provenance: None,
            },
        ],
        strict: Some(false),
        provenance: None,
    })
}

fn clean_string_literal(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn combine_spring_routes(prefix: &str, subpath: &str) -> String {
    let p = prefix.trim();
    let s = subpath.trim();
    let p_clean = if p.is_empty() {
        ""
    } else if !p.starts_with('/') {
        &format!("/{}", p)
    } else {
        p
    };
    let p_clean = p_clean.trim_end_matches('/');

    let s_clean = if s.is_empty() {
        ""
    } else if !s.starts_with('/') {
        &format!("/{}", s)
    } else {
        s
    };

    let combined = format!("{}{}", p_clean, s_clean);
    if combined.is_empty() {
        "/".to_string()
    } else if !combined.starts_with('/') {
        format!("/{}", combined)
    } else {
        combined
    }
}

/// How a JDK library type reaches the JSON wire. `EnumOfNames` is the plain-enum default: Jackson
/// writes `name()`, and a JDK enum's constants are fixed by the platform rather than by any
/// repository, so the value set is publishable without reading project source.
enum JdkWireShape {
    EnumOfNames(&'static [&'static str]),
    JsonString,
}

/// Simple name, FQCN, wire shape. Matching is by simple name, and every hit still has to prove the
/// FQCN through the referencing compilation unit, so an unrelated project type that happens to share
/// a name can never land here.
const JDK_WIRE_TYPES: &[(&str, &str, JdkWireShape)] = &[
    (
        "TimeUnit",
        "java.util.concurrent.TimeUnit",
        JdkWireShape::EnumOfNames(&[
            "NANOSECONDS",
            "MICROSECONDS",
            "MILLISECONDS",
            "SECONDS",
            "MINUTES",
            "HOURS",
            "DAYS",
        ]),
    ),
    (
        "DayOfWeek",
        "java.time.DayOfWeek",
        JdkWireShape::EnumOfNames(&[
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
            "SUNDAY",
        ]),
    ),
    (
        "Month",
        "java.time.Month",
        JdkWireShape::EnumOfNames(&[
            "JANUARY",
            "FEBRUARY",
            "MARCH",
            "APRIL",
            "MAY",
            "JUNE",
            "JULY",
            "AUGUST",
            "SEPTEMBER",
            "OCTOBER",
            "NOVEMBER",
            "DECEMBER",
        ]),
    ),
    ("ZoneId", "java.time.ZoneId", JdkWireShape::JsonString),
    (
        "ZoneOffset",
        "java.time.ZoneOffset",
        JdkWireShape::JsonString,
    ),
];

fn scalar_to_wire_type(t: &str) -> WireType {
    match t.trim() {
        "String"
        | "java.lang.String"
        | "CharSequence"
        | "char"
        | "Character"
        | "java.lang.Character"
        | "UUID"
        | "java.util.UUID" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: None,
            provenance: None,
        }),
        // Jackson parses these as ISO-8601 text, so a request sample must be a legal temporal
        // literal - an arbitrary word such as "sajimora" is rejected with 400 by the date
        // deserializer before the controller ever runs.
        "Instant"
        | "java.time.Instant"
        | "ZonedDateTime"
        | "OffsetDateTime"
        | "java.time.ZonedDateTime"
        | "java.time.OffsetDateTime"
        | "Date"
        | "java.util.Date"
        | "Timestamp"
        | "java.sql.Timestamp" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: Some(contract_core::ir::PrimitiveFormat::DateTime),
            provenance: None,
        }),
        "LocalDateTime" | "java.time.LocalDateTime" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::String,
            format: Some(contract_core::ir::PrimitiveFormat::LocalDateTime),
            provenance: None,
        }),
        "LocalDate" | "java.time.LocalDate" | "java.sql.Date" => {
            WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: Some(contract_core::ir::PrimitiveFormat::Date),
                provenance: None,
            })
        }
        "LocalTime" | "java.time.LocalTime" | "java.sql.Time" => {
            WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: Some(contract_core::ir::PrimitiveFormat::Time),
                provenance: None,
            })
        }
        "int"
        | "Integer"
        | "java.lang.Integer"
        | "long"
        | "Long"
        | "java.lang.Long"
        | "short"
        | "Short"
        | "byte"
        | "Byte"
        | "float"
        | "Float"
        | "double"
        | "Double"
        | "java.lang.Short"
        | "java.lang.Byte"
        | "java.lang.Float"
        | "java.lang.Double"
        | "BigDecimal"
        | "java.math.BigDecimal"
        | "BigInteger"
        | "java.math.BigInteger"
        | "Number"
        | "java.lang.Number"
        | "AtomicInteger"
        | "AtomicLong"
        | "DoubleAdder"
        | "LongAdder"
        | "java.util.concurrent.atomic.AtomicInteger"
        | "java.util.concurrent.atomic.AtomicLong"
        | "java.util.concurrent.atomic.DoubleAdder"
        | "java.util.concurrent.atomic.LongAdder" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Number,
            format: None,
            provenance: None,
        }),
        "boolean" | "Boolean" | "java.lang.Boolean" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Boolean,
            format: None,
            provenance: None,
        }),
        "void" | "Void" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Void,
            format: None,
            provenance: None,
        }),
        "Object"
        | "java.lang.Object"
        | "?"
        | "? extends Object"
        | "JsonNode"
        | "byte[]"
        | "Byte[]"
        | "Resource"
        | "InputStream"
        | "InputStreamResource"
        | "ByteArrayResource" => WireType::Primitive(PrimitiveWireType {
            scalar: PrimitiveScalar::Any,
            format: None,
            provenance: None,
        }),
        "Map"
        | "java.util.Map"
        | "HashMap"
        | "java.util.HashMap"
        | "EnumMap"
        | "LinkedHashMap"
        | "java.util.LinkedHashMap"
        | "TreeMap"
        | "java.util.TreeMap"
        | "SortedMap"
        | "java.util.SortedMap"
        | "NavigableMap"
        | "java.util.NavigableMap"
        | "ConcurrentMap"
        | "java.util.concurrent.ConcurrentMap"
        | "ConcurrentHashMap"
        | "java.util.concurrent.ConcurrentHashMap"
        | "WeakHashMap"
        | "java.util.WeakHashMap"
        | "IdentityHashMap"
        | "java.util.IdentityHashMap"
        | "Hashtable"
        | "java.util.Hashtable"
        | "Properties"
        | "java.util.Properties" => WireType::Map(contract_core::ir::MapWireType {
            key_type: Box::new(WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::String,
                format: None,
                provenance: None,
            })),
            value_type: Box::new(WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Any,
                format: None,
                provenance: None,
            })),
            provenance: None,
        }),
        // A raw collection has no element type to recover, so its members stay Any.
        "List"
        | "java.util.List"
        | "ArrayList"
        | "java.util.ArrayList"
        | "LinkedList"
        | "java.util.LinkedList"
        | "Set"
        | "java.util.Set"
        | "HashSet"
        | "java.util.HashSet"
        | "TreeSet"
        | "java.util.TreeSet"
        | "SortedSet"
        | "java.util.SortedSet"
        | "NavigableSet"
        | "java.util.NavigableSet"
        | "CopyOnWriteArrayList"
        | "java.util.concurrent.CopyOnWriteArrayList"
        | "ConcurrentSkipListSet"
        | "java.util.concurrent.ConcurrentSkipListSet"
        | "Collection"
        | "java.util.Collection"
        | "Iterable"
        | "java.lang.Iterable" => WireType::Array(contract_core::ir::ArrayWireType {
            element_type: Box::new(WireType::Primitive(PrimitiveWireType {
                scalar: PrimitiveScalar::Any,
                format: None,
                provenance: None,
            })),
            is_stream_or_flux: Some(false),
            provenance: None,
        }),
        _ => WireType::Unknown(UnknownWireType {
            reason: format!("Non-scalar type: {}", t),
            provenance: None,
        }),
    }
}

/// A type whose JSON shape is decided by a runtime implementation, not by its own body.
///
/// An interface fixes no properties at all: its fields are implicitly `static final`
/// constants, which Jackson does not serialize, so treating the declaration as a full
/// object shape asserted a shape the producer never promised. An abstract class with no
/// instance fields of its own has the same problem. Both become Unknown, which keeps the
/// verdict advisory instead of letting a phantom empty object link or break.
fn hollow_abstraction_wire(cls_info: &JavaClassInfo, fields: &[JavaFieldInfo]) -> Option<WireType> {
    if let Some(annotation) = &cls_info.unsupported_serialization {
        return Some(inconclusive_class_wire(cls_info, annotation));
    }
    let kind = if cls_info.is_interface {
        "interface"
    } else if cls_info.is_abstract && fields.is_empty() {
        "abstract class"
    } else {
        return None;
    };
    Some(WireType::Unknown(UnknownWireType {
        reason: format!(
            "UNSUPPORTED_CONSTRUCT: {} is an {}; its JSON properties come from whichever implementation the producer returns at runtime",
            cls_info.fqcn, kind
        ),
        provenance: Some(SourceProvenance {
            language: SourceLanguage::Java,
            file: cls_info.file_path.clone(),
            line: 1,
            column: None,
            ast_identity: Some(cls_info.fqcn.clone()),
            annotation_or_schema: None,
            sha256: None,
            evidence_classification: Some(EvidenceClassification::ImplementationDerived),
        }),
    }))
}

/// A class whose properties could not be built honestly (an `@JsonUnwrapped`
/// member with no statically known target) is unknowable as a whole: the
/// flattened keys come from the target, so no static object can describe it.
fn inconclusive_class_wire(cls_info: &JavaClassInfo, detail: &str) -> WireType {
    let mut provenance = java_provenance(cls_info, 1);
    provenance.annotation_or_schema = Some(detail.to_string());
    if let Some((_, location)) = detail.rsplit_once(" at ") {
        if let Some((file, line)) = location.rsplit_once(':') {
            if let Ok(line) = line.parse::<u32>() {
                provenance.file = file.to_string();
                provenance.line = line;
            }
        }
    }
    let detail = detail
        .strip_prefix("UNSUPPORTED_CONSTRUCT: ")
        .unwrap_or(detail);
    WireType::Unknown(UnknownWireType {
        reason: format!("UNSUPPORTED_CONSTRUCT: {}: {}", cls_info.fqcn, detail),
        provenance: Some(provenance),
    })
}

fn apply_accessor_prefix(name: &str, prefixes: &[String]) -> String {
    for prefix in prefixes {
        if name.starts_with(prefix) && name.len() > prefix.len() {
            let stripped = &name[prefix.len()..];
            let mut chars = stripped.chars();
            if let Some(first) = chars.next() {
                return format!("{}{}", first.to_lowercase(), chars.as_str());
            }
        }
    }
    name.to_string()
}

fn parse_generic_type(t: &str) -> Option<(&str, &str)> {
    let open = t.find('<')?;
    let close = t.rfind('>')?;
    if close > open {
        Some((&t[..open].trim(), &t[open + 1..close].trim()))
    } else {
        None
    }
}

fn split_generic_args(args: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (idx, ch) in args.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(args[start..idx].trim());
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }
    let last = args[start..].trim();
    if !last.is_empty() {
        out.push(last);
    }
    out
}

fn bind_type_params(params: &[String], args_text: &str) -> HashMap<String, String> {
    if params.is_empty() || args_text.trim().is_empty() {
        return HashMap::new();
    }
    params
        .iter()
        .zip(split_generic_args(args_text))
        .map(|(param, arg)| (param.clone(), arg.to_string()))
        .collect()
}

/// Replaces declared type-parameter names with their bound arguments. Type
/// names are whole tokens (qualified names and suffixes such as `TDto` are left
/// alone), so `List<T>` becomes `List<UserDto>` while `Temporal` never matches `T`.
fn substitute_type_params(type_str: &str, bindings: &HashMap<String, String>) -> String {
    if bindings.is_empty() {
        return type_str.to_string();
    }
    let mut out = String::with_capacity(type_str.len());
    let mut token = String::new();
    fn flush(token: &mut String, out: &mut String, bindings: &HashMap<String, String>) {
        if token.is_empty() {
            return;
        }
        match bindings.get(token.as_str()) {
            Some(replacement) => out.push_str(replacement),
            None => out.push_str(token),
        }
        token.clear();
    }
    for ch in type_str.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '$' || ch == '.' {
            token.push(ch);
        } else {
            flush(&mut token, &mut out, bindings);
            out.push(ch);
        }
    }
    flush(&mut token, &mut out, bindings);
    out
}

/// Parse already-decoded Java source. Facts recovered from a file that Tree-sitter could
/// not parse cleanly are kept, and the reason the file is untrustworthy is returned so the
/// artifact declares itself incomplete instead of silently losing whatever the error hid.
fn parse_decoded(
    parser: &mut Parser,
    rel_path: &str,
    content: &str,
    constants: &ConstantTable,
    service_methods: &ServiceMethodTable,
    disk_path: Option<&str>,
) -> (Vec<JavaClassInfo>, Option<ArtifactBlocker>) {
    // Java 23 JEP 476 introduced `import module <name>;` (e.g. `import module java.base;`).
    // Tree-sitter-java grammar 0.23 does not yet recognise module imports, which produces
    // an ERROR node near line 2 on thousands of modern Java 23/25 files.
    // Replacing "import module " with "//port module " (exact 14-byte match) keeps byte
    // offsets, column spans, and line numbers 100% identical while allowing Tree-sitter
    // to cleanly parse all classes, annotations, and methods in the file without false blockers.
    let normalized_storage: String;
    let effective_content = if content.contains("import module ") {
        normalized_storage = content.replace("import module ", "//port module ");
        normalized_storage.as_str()
    } else {
        content
    };

    let Some(tree) = parser.parse(effective_content, None) else {
        return (
            Vec::new(),
            Some(source_blocker(
                rel_path,
                "JAVA_PARSE_FAILED",
                format!(
                    "Tree-sitter could not parse {rel_path}; every endpoint and type declared in it is absent from this artifact"
                ),
            )),
        );
    };

    let root = tree.root_node();
    let blocker = if root.has_error() {
        let location = match first_error_line(root) {
            Some(line) => format!("near line {line}"),
            None => "at an unlocatable position".to_string(),
        };
        Some(source_blocker(
            rel_path,
            "JAVA_PARSE_ERROR",
            format!(
                "Tree-sitter reported a syntax error {location}; facts from this file may be incomplete"
            ),
        ))
    } else {
        None
    };

    (
        parse_compilation_unit(
            root,
            effective_content,
            rel_path,
            constants,
            service_methods,
            disk_path,
        ),
        blocker,
    )
}

fn source_blocker(file: &str, code: &str, message: String) -> ArtifactBlocker {
    ArtifactBlocker {
        code: code.to_string(),
        message,
        file: Some(file.to_string()),
    }
}

/// Blockers carry the evidence in prose, and one blocker per offending class would blow up the
/// artifact the way unresolved evidence already did once.
fn summarize(names: &[String]) -> String {
    const CAP: usize = 8;
    if names.len() <= CAP {
        return names.join(", ");
    }
    format!("{}, +{} more", names[..CAP].join(", "), names.len() - CAP)
}

/// Blockers are serialized into the sealed artifact, so their order has to come from the
/// content rather than from HashMap iteration or per-process file ordering.
fn sort_blockers(blockers: &mut [ArtifactBlocker]) {
    blockers.sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
}

/// One-based line of the first ERROR/MISSING node in the tree.
fn first_error_line(node: Node) -> Option<usize> {
    if node.is_error() || node.is_missing() {
        return Some(node.start_position().row + 1);
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i as u32) {
            if let Some(line) = first_error_line(child) {
                return Some(line);
            }
        }
    }
    None
}

fn collect_java_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    collect_sources_with_ext(dir, "java", files)
}

/// Directory names that hold installed dependencies or a version-control artefact rather than
/// sources a developer wrote.
const NEVER_SOURCES: &[&str] = &[
    "node_modules",
    ".git",
    ".gradle",
    ".hg",
    ".svn",
    ".sajimora",
    "__pycache__",
    ".idea",
];

/// Build output directories. Pruned only when the directory also contains a recognised build
/// artefact, because a module legitimately named `build` or `out` must keep its sources: skipping
/// a real source root loses types silently, and no blocker says so.
const BUILD_MARKERS: &[&str] = &[
    "classes",
    "generated-sources",
    "generated-test-sources",
    "intermediates",
    "libs",
    "resources",
    "tmp",
];

pub(crate) fn is_pruned_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if NEVER_SOURCES.contains(&name) {
        return true;
    }
    // Prune test source trees (Maven/Gradle standard `src/test`, `src/it`, `src/testFixtures`, `src/integrationTest`)
    if is_test_source_dir(name)
        && path
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|p| p == "src")
    {
        return true;
    }
    if !matches!(name, "target" | "build" | "out") {
        return false;
    }
    BUILD_MARKERS
        .iter()
        .any(|marker| path.join(marker).is_dir())
}

fn is_test_source_dir(name: &str) -> bool {
    matches!(
        name,
        "test" | "it" | "androidTest" | "testFixtures" | "integrationTest"
    )
}

/// Whether a POSIX path lies under a directory the working-tree scanner never reads sources from:
/// a dependency or tool directory, or a `src/test`-style test tree. Build-output directories are
/// not decided here, because that rule needs the directory's contents.
pub fn is_excluded_source_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let dirs = &parts[..parts.len().saturating_sub(1)];
    dirs.iter().enumerate().any(|(index, name)| {
        NEVER_SOURCES.contains(name)
            || (is_test_source_dir(name) && index > 0 && dirs[index - 1] == "src")
    })
}

/// Every module source root the build declares, so that a repository which keeps its shared DTOs
/// in a module the served application only depends on can still resolve them.
///
/// The module set comes from the build files, never from a directory scan. Walking the tree
/// instead treats every nested checkout as part of this service: one corpus copy of this
/// repository holds 1,677 `src/main/java` directories under `artifacts/` and `scratch/`, and
/// indexing them turned a test run into 29 minutes of parsing someone else's source. A repository
/// that does not declare modules keeps today's single-root behaviour.
///
/// The second value names module directories that could not be read, which is where a declared
/// module would have been indexed but was not.
fn discover_source_roots(repo_root: &Path) -> (Vec<PathBuf>, Vec<String>) {
    const MODULE_DIR_LIMIT: usize = 4096;
    let mut found = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut gaps = Vec::new();
    let mut queue: Vec<PathBuf> = vec![repo_root.to_path_buf()];
    let mut truncated = false;

    while let Some(dir) = queue.pop() {
        let canonical = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue;
        }
        if visited.len() > MODULE_DIR_LIMIT {
            truncated = true;
            break;
        }
        let module_src = dir.join(JAVA_SOURCE_ROOT_SUFFIX);
        if module_src.is_dir() {
            found.push(module_src);
        } else if dir.join("src").is_dir() && crate::provider::has_java_source(&dir.join("src")) {
            found.push(dir.join("src"));
        } else if crate::provider::has_java_source(&dir) {
            found.push(dir.clone());
        }
        for declared in declared_module_paths(&dir, repo_root) {
            if fs::read_dir(&declared).is_err() {
                gaps.push(path_to_posix(
                    declared.strip_prefix(repo_root).unwrap_or(&declared),
                ));
                continue;
            }
            queue.push(declared);
        }
    }

    if truncated {
        gaps.push(format!(
            "modules beyond the {MODULE_DIR_LIMIT}-directory limit"
        ));
    }
    found.sort();
    found.dedup();
    gaps.sort();
    gaps.dedup();
    (found, gaps)
}

/// Module directories a build file declares, resolved to paths inside `repo_root`. Maven lists
/// children in `<modules><module>name</module></modules>`; Gradle lists the whole tree in
/// `settings.gradle` with `include ':a:b'`, which already names the path from the root.
fn declared_module_paths(dir: &Path, repo_root: &Path) -> Vec<PathBuf> {
    let mut names = Vec::new();
    if let Some(content) = read_if_exists(&dir.join("pom.xml")) {
        names.extend(pom_modules(&content));
    }
    for settings in ["settings.gradle", "settings.gradle.kts"] {
        if let Some(content) = read_if_exists(&dir.join(settings)) {
            names.extend(gradle_includes(&content));
        }
    }

    let mut out = Vec::new();
    for name in names {
        if name.is_empty() || name.contains("..") {
            continue;
        }
        let candidate = dir.join(&name);
        // A build file may point outside the checkout; provenance is repository-relative, so a
        // root the extractor cannot name without an absolute path is not a root.
        if candidate.starts_with(repo_root) && candidate.is_dir() && !is_pruned_dir(&candidate) {
            out.push(candidate);
        }
    }
    out.sort();
    out.dedup();
    out
}

fn read_if_exists(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn pom_modules(content: &str) -> Vec<String> {
    const OPEN: &str = "<module>";
    const CLOSE: &str = "</module>";
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(open) = rest.find(OPEN) {
        let after = &rest[open + OPEN.len()..];
        let Some(close) = after.find(CLOSE) else {
            break;
        };
        let name = after[..close].trim();
        if !name.is_empty() && !name.contains('<') {
            out.push(name.replace('\\', "/"));
        }
        rest = &after[close + CLOSE.len()..];
    }
    out
}

fn gradle_includes(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if !(trimmed.starts_with("include") || trimmed.starts_with("rootProject")) {
            continue;
        }
        if trimmed.contains("rootProject.name") {
            continue;
        }
        for token in quoted_literals(trimmed) {
            let path = token.trim_start_matches(':').replace(':', "/");
            if !path.is_empty() {
                out.push(path);
            }
        }
    }
    out
}

fn quoted_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        let quote = bytes[index];
        if quote != '\'' && quote != '"' {
            index += 1;
            continue;
        }
        let Some(end) = bytes[index + 1..].iter().position(|c| *c == quote) else {
            break;
        };
        out.push(bytes[index + 1..index + 1 + end].iter().collect());
        index += end + 2;
    }
    out
}

/// Standard Maven and Gradle production source root, relative to its module directory.
const JAVA_SOURCE_ROOT_SUFFIX: &str = "src/main/java";

/// Drop roots another root already covers, so a nested root cannot index the same class twice and
/// register one controller under two provenance paths. The primary root is always kept because it
/// is the one whose endpoints are in scope.
fn nest_free_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let canonicalized = |path: &PathBuf| path.canonicalize().unwrap_or_else(|_| path.clone());
    let mut out: Vec<PathBuf> = vec![roots[0].clone()];
    let mut kept = vec![canonicalized(&roots[0])];
    for root in roots.iter().skip(1) {
        let canonical = canonicalized(root);
        // Either direction of nesting means one walk already yields these files, and registering
        // the same class from two paths decides the wire shape by traversal order. The primary
        // root is never the one dropped: its own walk is what the completeness claim describes.
        if kept.iter().any(|existing| {
            existing.strip_prefix(&canonical).is_ok() || canonical.strip_prefix(existing).is_ok()
        }) {
            continue;
        }
        kept.push(canonical);
        out.push(root.clone());
    }
    out
}

/// Repository-relative source root a class was read from, derived from its path so that grouping
/// needs no extra state to keep in step with the walk.
fn source_root_of(rel_path: &str) -> String {
    let marker = "/src/main/java/";
    if let Some(index) = rel_path.rfind(marker) {
        return rel_path[..index + marker.len() - 1].to_string();
    }
    if rel_path.starts_with("src/main/java/") {
        return JAVA_SOURCE_ROOT_SUFFIX.to_string();
    }
    match rel_path.find('/') {
        Some(index) => rel_path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// `true` when `rel_path` lies inside the endpoint root, on a path-component boundary.
fn is_inside_endpoint_root(rel_path: &str, endpoint_root: &str) -> bool {
    endpoint_root.is_empty()
        || rel_path == endpoint_root
        || rel_path.starts_with(&format!("{endpoint_root}/"))
}

fn collect_sources_with_ext(dir: &Path, ext: &str, files: &mut Vec<PathBuf>) -> Result<()> {
    let mut visited = HashSet::new();
    walk_sources(dir, ext, files, &mut visited)
}

/// Walk for sources of one extension that refuses a directory it has already entered. A symlink
/// or Windows junction pointing at an ancestor would otherwise be re-entered forever, and the
/// file it eventually yields carries a provenance path that exists only inside the alias --
/// unreadable by the developer and different on every clone depth.
fn walk_sources(
    dir: &Path,
    ext: &str,
    files: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if !visited.insert(key) {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    // Traversal order decides which alias of a symlinked directory is recorded, so it must
    // not depend on the unspecified order `read_dir` returns.
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if is_pruned_dir(&path) {
                continue;
            }
            walk_sources(&path, ext, files, visited)?;
        } else if path.extension().is_some_and(|e| e == ext) {
            files.push(path);
        }
    }
    Ok(())
}

/// Explicit imports declared by a compilation unit, as written (`a.b.C` or
/// `a.b.*`). Used to bind simple type names before any global-name guess.
fn scan_imports(content: &str) -> Vec<String> {
    let mut imports = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("import ") else {
            continue;
        };
        let rest = rest
            .trim_start()
            .strip_prefix("static ")
            .unwrap_or(rest.trim_start());
        let path = rest.trim().trim_end_matches(';').trim();
        if !path.is_empty() && !imports.iter().any(|i| i == path) {
            imports.push(path.to_string());
        }
    }
    imports
}

/// Web frameworks whose endpoint annotations this extractor does not read. Matched against the
/// file's own import statements, because an import is evidence in the source while a class-name
/// guess is not.
fn unsupported_web_import(content: &str) -> Option<(&'static str, String)> {
    const FAMILIES: &[(&str, &str)] = &[
        ("jakarta.ws.rs.", "JAX-RS"),
        ("javax.ws.rs.", "JAX-RS"),
        (
            "org.springframework.web.service.annotation.",
            "Spring HTTP Interface",
        ),
        ("feign.", "OpenFeign"),
        ("io.grpc.", "gRPC"),
        (
            "org.eclipse.microprofile.rest.client.",
            "MicroProfile REST Client",
        ),
        ("org.springframework.cloud.openfeign.", "OpenFeign"),
        ("play.mvc.", "Play MVC"),
        ("org.springframework.graphql.", "GraphQL"),
        ("org.eclipse.microprofile.graphql.", "GraphQL"),
        ("graphql.", "GraphQL"),
        ("io.vertx.", "Vert.x"),
        ("spark.", "Spark Java"),
        ("org.apache.struts2.", "Struts2"),
        ("org.apache.struts.action", "Struts"),
        ("io.javalin.", "Javalin"),
        ("io.undertow.", "Undertow"),
        ("com.netflix.graphql.dgs.", "GraphQL (DGS)"),
        ("javax.faces.", "JSF"),
        ("jakarta.faces.", "JSF"),
        ("io.rsocket.", "RSocket"),
    ];
    for line in content.lines() {
        let Some(rest) = line.trim().strip_prefix("import") else {
            continue;
        };
        let rest = rest
            .trim_start()
            .trim_start_matches("static")
            .trim()
            .trim_end_matches(';');
        for (prefix, family) in FAMILIES {
            if rest.starts_with(prefix) {
                // Quarkus @Route methods select verbs with Route.HttpMethod, and
                // the enum is sometimes imported directly from Vert.x.
                if *family == "Vert.x" && content.contains("io.quarkus.") {
                    // Quarkus @Route handlers take Vert.x types (RoutingContext,
                    // HttpMethod); the annotation itself is the route evidence.
                    if rest == "io.vertx.core.http.HttpMethod"
                        || rest == "io.vertx.ext.web.RoutingContext"
                    {
                        continue;
                    }
                }
                return Some((family, rest.to_string()));
            }
        }
    }
    None
}

/// A class that serves HTTP directly through the Servlet API declares its routes in
/// `web.xml` or by URL pattern, neither of which this reader parses. Servlet types also
/// appear inside Spring and JAX-RS applications (`ServletContextInitializer`,
/// `ServletContainer`), so only a class that itself handles verbs is named.
fn is_servlet_provider(content: &str) -> bool {
    let compact = content.replace(' ', "");
    let serves = compact.contains("extendsHttpServlet") || content.contains("@WebServlet(");
    if !serves {
        return false;
    }
    let declares_verb = [
        "doGet(",
        "doPost(",
        "doPut(",
        "doDelete(",
        "doHead(",
        "doOptions(",
        "doTrace(",
        "service(HttpServletRequest",
    ]
    .iter()
    .any(|needle| compact.contains(needle));
    if !declares_verb {
        return false;
    }
    let handled_elsewhere = [
        "@RestController",
        "@RequestMapping",
        "@Controller",
        "@Path(",
        "io.micronaut.",
        "io.quarkus.",
        "org.glassfish.jersey.",
    ]
    .iter()
    .any(|needle| content.contains(needle));
    !handled_elsewhere
}

fn has_unsupported_web_annotations(content: &str) -> bool {
    let has_path = content.contains("@Path(")
        || content.contains("@Path (")
        || content.contains("@Path\n")
        || content.contains("@Path\r\n");
    let has_verb = content.contains("@GET")
        || content.contains("@POST")
        || content.contains("@PUT")
        || content.contains("@DELETE")
        || content.contains("@HEAD")
        || content.contains("@OPTIONS");
    has_path && has_verb
}

fn is_declarative_client_file(content: &str) -> bool {
    content.contains("@FeignClient")
        || content.contains("@HttpExchange")
        || content.contains("@RegisterRestClient")
}

fn check_unsupported_frameworks(
    content: &str,
    rel_path: &str,
    blockers: &mut Vec<ArtifactBlocker>,
) {
    if is_declarative_client_file(content) {
        return;
    }
    if let Some((family, import)) = unsupported_web_import(content) {
        blockers.push(source_blocker(
            rel_path,
            "JAVA_MAPPING_FRAMEWORK_UNPARSED",
            format!(
                "File imports {family} ({import}). This extractor does not parse {family} route declarations, so endpoints declared with {family} are absent from this artifact and its emptiness is not evidence of absence"
            ),
        ));
    } else if has_unsupported_web_annotations(content) {
        blockers.push(source_blocker(
            rel_path,
            "JAVA_MAPPING_FRAMEWORK_UNPARSED",
            "File declares JAX-RS / Jakarta REST annotations (@Path / @GET / @POST) in a source tree this reader classifies as a different provider lane, so those endpoints are absent from this artifact and its emptiness is not evidence of absence".to_string(),
        ));
    } else if is_servlet_provider(content) {
        blockers.push(source_blocker(
            rel_path,
            "JAVA_MAPPING_FRAMEWORK_UNPARSED",
            "File serves HTTP from a Servlet API class (extends HttpServlet with doGet/doPost/...). Its URL patterns come from web.xml or a @WebServlet declaration, neither of which this reader parses, so those endpoints are absent from this artifact and its emptiness is not evidence of absence".to_string(),
        ));
    }
    blockers.extend(jax_rs_completeness_blockers(content, rel_path));
}

/// JAX-RS endpoints this reader does not model completely. These are emitted
/// even when JAX-RS extraction is enabled: the route is extracted, but a
/// declared request/response surface is still missing from the artifact.
fn jax_rs_completeness_blockers(content: &str, rel_path: &str) -> Vec<ArtifactBlocker> {
    let is_jax_rs = content.contains("jakarta.ws.rs.")
        || content.contains("javax.ws.rs.")
        || has_unsupported_web_annotations(content);
    if !is_jax_rs {
        return Vec::new();
    }
    let mut blockers = Vec::new();
    for (annotation, label) in [
        ("@BeanParam", "bean parameters"),
        ("@FormParam", "form parameters"),
        ("@CookieParam", "cookie parameters"),
        ("@MatrixParam", "matrix parameters"),
    ] {
        if content.contains(annotation) {
            blockers.push(source_blocker(
                rel_path,
                "JAVA_JAXRS_PARAMETER_UNPARSED",
                format!(
                    "File uses {annotation} ({label}); this reader does not model that request surface, so the endpoint contract is incomplete"
                ),
            ));
        }
    }
    if content.contains("@ApplicationPath") {
        blockers.push(source_blocker(
            rel_path,
            "JAVA_JAXRS_APPLICATION_PATH_UNPARSED",
            "File declares @ApplicationPath; the application base path is not applied to extracted JAX-RS routes".to_string(),
        ));
    }
    let returns_response = content.lines().any(|line| {
        let line = line.trim();
        (line.starts_with("public ") || line.starts_with("protected "))
            && line.contains('(')
            && (line.contains(" Response ")
                || line.contains(" Response<")
                || line.contains("jakarta.ws.rs.core.Response")
                || line.contains("javax.ws.rs.core.Response"))
    });
    if returns_response {
        blockers.push(source_blocker(
            rel_path,
            "JAVA_JAXRS_RESPONSE_UNPARSED",
            "File declares a JAX-RS resource returning Response/ResponseBuilder; the status and body are assembled at runtime and are not modelled".to_string(),
        ));
    }
    for annotation in ["@Produces", "@Consumes"] {
        for argument in annotation_arguments(content, annotation) {
            let argument = argument
                .trim()
                .trim_matches(|c| c == '{' || c == '}')
                .trim();
            if argument.is_empty() {
                continue;
            }
            let has_json = argument.to_ascii_lowercase().contains("json");
            let declares_explicit_media = argument.contains("MediaType.")
                || argument.contains('"')
                || argument.contains('\'');
            if declares_explicit_media && !has_json {
                blockers.push(source_blocker(
                    rel_path,
                    "JAVA_JAXRS_MEDIA_TYPE_UNPARSED",
                    format!(
                        "{annotation}({argument}) is not JSON; this reader assumes a JSON wire body, so the media type is not modelled"
                    ),
                ));
            }
        }
    }
    sort_blockers(&mut blockers);
    blockers.dedup_by(|a, b| a.code == b.code && a.message == b.message);
    blockers
}

fn annotation_arguments<'a>(content: &'a str, annotation: &str) -> Vec<&'a str> {
    let mut arguments = Vec::new();
    let mut offset = 0;
    while let Some(found) = content[offset..].find(annotation) {
        let after = offset + found + annotation.len();
        let rest = &content[after..];
        let Some(open) = rest.find('(') else {
            offset = after;
            continue;
        };
        let Some(close) = rest[open + 1..].find(')') else {
            break;
        };
        arguments.push(&rest[open + 1..open + 1 + close]);
        offset = after + open + 1 + close;
    }
    arguments
}

fn path_to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Spring Boot configuration file names, in resolution order: a `.properties` file wins over
/// `.yml`/`.yaml` in the same directory, and `src/main/resources` wins over the directory itself.
///
/// Published because revision-mode extraction reads the same list out of Git blobs and
/// `configFingerprint` is part of the sealed digest — a mode that consulted a different file, or
/// the same files in a different order, would produce an incomparable artifact.
pub const CONFIG_TAILS: [&str; 6] = [
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
    "src/main/resources/application.yaml",
    "application.properties",
    "application.yml",
    "application.yaml",
];

/// The label reported when no configuration file was found at all.
pub const DEFAULT_CONFIG_LABEL: &str = "application.properties";

/// The configuration one extraction mode could see.
///
/// Working-tree and revision modes have to agree on this, because it decides which blockers are
/// sealed into the artifact: a mode that saw a narrower set of configuration would certify a
/// commit the other mode refuses, and the two artifacts would no longer be comparable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigInputs {
    /// Configuration files in precedence order. The first governs `configFingerprint` and the
    /// naming strategy. The rest are carried along but never audited, because Spring Boot reads
    /// only the winner and a setting in a shadowed file has no effect on the wire.
    pub files: Vec<(String, String)>,
    /// `application-{profile}.*` files beside them. Spring selects one at runtime from the active
    /// profile, which no static snapshot can know.
    pub profile_files: Vec<String>,
    /// The nearest `lombok.config`, when one is visible.
    pub lombok: Option<(String, String)>,
}

impl ConfigInputs {
    /// A single governing document and nothing else beside it.
    pub fn single(label: &str, content: &str) -> Self {
        Self {
            files: vec![(label.to_string(), content.to_string())],
            ..Self::default()
        }
    }
}

/// The directories `CONFIG_TAILS` resolves against, taken from it so a profile-specific file can
/// never be searched for somewhere the governing file was not.
fn config_dirs() -> Vec<&'static str> {
    let mut dirs: Vec<&'static str> = Vec::new();
    for tail in CONFIG_TAILS {
        let dir = tail.rsplit_once('/').map_or("", |(prefix, _)| prefix);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Whether a file name is a profile-specific Spring Boot document, `application-<profile>.<ext>`.
fn is_profile_config(name: &str) -> bool {
    let Some(stem) = name.strip_prefix("application-") else {
        return false;
    };
    [".properties", ".yml", ".yaml"].iter().any(|extension| {
        stem.ends_with(extension)
            // `application-.yml` names no profile, so Spring would not treat it as one.
            && stem.len() > extension.len()
    })
}

/// Whether a scope-relative path is a profile-specific configuration file in one of the
/// directories `CONFIG_TAILS` searches.
///
/// Published so revision mode classifies Git blobs exactly the way the working-tree scanner
/// classifies directory entries: a profile document one mode sees and the other does not would
/// seal a different blocker set into the same commit.
pub fn is_profile_config_path(scoped_path: &str) -> bool {
    let name = scoped_path.rsplit('/').next().unwrap_or(scoped_path);
    if !is_profile_config(name) {
        return false;
    }
    let dir = scoped_path[..scoped_path.len() - name.len()].trim_end_matches('/');
    dir.is_empty()
        || config_dirs()
            .iter()
            .any(|d| !d.is_empty() && dir.ends_with(d))
}

fn detect_config(
    repo_root: &Path,
    java_dir: &Path,
) -> (NamingStrategy, String, Vec<ArtifactBlocker>) {
    resolve_config(read_config_inputs(repo_root, java_dir))
}

/// The configuration inputs of a working tree, read from the same locations in the same order the
/// revision mode reads them out of Git blobs.
fn read_config_inputs(repo_root: &Path, java_dir: &Path) -> ConfigInputs {
    // A service packaged from one module of a larger repository configures Jackson in that
    // module's own resources, so its file governs the wire names even when the repository root
    // carries one too.
    let module = module_root_of(java_dir);
    let mut roots: Vec<PathBuf> = vec![repo_root.join("rust/fixtures/spring-sample")];
    if module != repo_root && module.starts_with(repo_root) {
        roots.push(module);
    }
    roots.push(repo_root.to_path_buf());

    let mut inputs = ConfigInputs::default();
    for root in &roots {
        for tail in CONFIG_TAILS {
            let candidate = root.join(tail);
            if let Ok(content) = fs::read_to_string(&candidate) {
                inputs
                    .files
                    .push((scoped_label(repo_root, &candidate), content));
            }
        }
    }
    for root in &roots {
        for dir in config_dirs() {
            let Ok(entries) = fs::read_dir(root.join(dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !is_profile_config(&name) {
                    continue;
                }
                inputs
                    .profile_files
                    .push(scoped_label(repo_root, &entry.path()));
            }
        }
        if inputs.lombok.is_none() {
            if let Ok(content) = fs::read_to_string(root.join("lombok.config")) {
                // Lombok bubbles configuration up from the source directory, so the nearest file
                // governs and a parent's is only a default it may override.
                inputs.lombok = Some((
                    scoped_label(repo_root, &root.join("lombok.config")),
                    content,
                ));
            }
        }
    }
    inputs.profile_files.sort();
    inputs
}

fn scoped_label(repo_root: &Path, path: &Path) -> String {
    path_to_posix(path.strip_prefix(repo_root).unwrap_or(path))
}

/// Precedence, naming and audit for one set of configuration inputs. Both extraction modes call
/// this so they cannot disagree about which document governs or about what it left unresolved.
fn resolve_config(inputs: ConfigInputs) -> (NamingStrategy, String, Vec<ArtifactBlocker>) {
    let (label, content) = inputs
        .files
        .first()
        .map(|(label, content)| (label.as_str(), content.as_str()))
        .unwrap_or((DEFAULT_CONFIG_LABEL, ""));
    let (strategy, fingerprint, unsupported) = config_naming(label, content);

    let mut blockers = config_blockers(&inputs);
    if let Some(name) = unsupported {
        blockers.push(unsupported_naming_blocker(label, &name));
    }
    sort_blockers(&mut blockers);
    (strategy, fingerprint, blockers)
}

/// Every case where the wire shape depends on configuration the extractor cannot see: an
/// unselected profile document, an imported location, a YAML reference into another part of the
/// file, a Jackson setting that is not the naming strategy, a Lombok accessor rule, or a mapper
/// configured in Java. Assuming camelCase in any of them would certify names the service never
/// emits, so each one fails closed instead.
pub fn config_blockers(inputs: &ConfigInputs) -> Vec<ArtifactBlocker> {
    let mut blockers = Vec::new();

    for path in &inputs.profile_files {
        blockers.push(source_blocker(
            path,
            "UNRESOLVED_JACKSON_CONFIG",
            "Profile-specific configuration cannot be selected from a static snapshot; whether it overrides the governing document depends on the active profile at runtime".to_string(),
        ));
    }

    if let Some((label, content)) = &inputs.lombok {
        let keys = lombok_wire_keys(content);
        if !keys.is_empty() {
            blockers.push(source_blocker(
                label,
                "UNSUPPORTED_LOMBOK_ACCESSOR",
                format!(
                    "lombok.config sets {}, which changes the accessor names or field visibility that Jackson infers property names from; this extractor reads the declared fields, not the generated accessors",
                    summarize(&keys)
                ),
            ));
        }
    }

    // Only the document Spring Boot would actually read is audited. A setting in a shadowed file
    // never reaches the wire, so reporting it would describe a defect the service does not have.
    if let Some((label, content)) = inputs.files.first() {
        blockers.extend(document_blockers(label, content));
    }

    sort_blockers(&mut blockers);
    blockers
}

/// `lombok.config` keys that change the accessor names or the field visibility Jackson infers
/// property names from. Other keys — `config.stopbubbling`, `lombok.copyableAnnotations` — leave
/// the wire alone, and blocking on them would report a defect the project does not have.
const LOMBOK_WIRE_KEY_PREFIXES: [&str; 2] = ["lombok.accessors.", "lombok.fielddefaults."];

fn lombok_wire_keys(content: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        let Some((key, _)) = trimmed.split_once(['=', ':']) else {
            continue;
        };
        let key = key
            .trim()
            .trim_end_matches(['+', '-'])
            .trim()
            .to_ascii_lowercase();
        if LOMBOK_WIRE_KEY_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
            && !found.contains(&key)
        {
            found.push(key);
        }
    }
    found.sort();
    found
}

/// Jackson configuration in Java that changes which properties serialize or what they are called.
///
/// Deliberately narrower than "this file mentions `ObjectMapper`": a mapper used only to read or
/// write a payload has no effect on the wire, and blocking on the type name would flag every
/// service that logs JSON without catching anything that matters.
const MAPPER_SHAPE_SETTINGS: [&str; 16] = [
    "setPropertyNamingStrategy",
    "propertyNamingStrategy(",
    "PropertyNamingStrategies.",
    "PropertyNamingStrategy.",
    "setVisibility(",
    "Jackson2ObjectMapperBuilderCustomizer",
    "setSerializationInclusion(",
    "setDefaultPropertyInclusion(",
    "addMixIn(",
    "setAnnotationIntrospector(",
    "MapperFeature.USE_STD_BEAN_NAMING",
    "MapperFeature.AUTO_DETECT_",
    "MapperFeature.DEFAULT_VIEW_INCLUSION",
    "MapperFeature.INFER_PROPERTY_MUTATORS",
    "MapperFeature.PROPAGATE_TRANSIENT_MARKER",
    "MapperFeature.USE_GETTERS_AS_SETTERS",
];

/// The first mapper setting a source file applies, if any.
fn mapper_shape_setting(content: &str) -> Option<&'static str> {
    for line in content.lines() {
        let trimmed = line.trim_start();
        // A setting that was commented out is not one the service applies. This is line-granular
        // on purpose: a trailing block comment on a line that also holds code still counts, which
        // is the direction that fails closed.
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }
        let code = trimmed
            .split_once("//")
            .map_or(trimmed, |(code, _comment)| code);
        if let Some(setting) = MAPPER_SHAPE_SETTINGS.iter().find(|s| code.contains(**s)) {
            return Some(setting);
        }
    }
    None
}

/// The keys that relocate or condition the effective configuration. Any one of them means the
/// document that governs the wire is not the document that was read.
const EXTERNAL_CONFIG_KEY_PREFIXES: [&str; 2] = ["spring.config.", "spring.profiles."];
/// `spring.jackson.*` settings this extractor models. Everything else under that prefix changes
/// which properties serialize or what they are called.
const MODELLED_JACKSON_KEYS: [&str; 2] = [
    "spring.jackson.property-naming-strategy",
    "spring.jackson.propertyNamingStrategy",
];

fn document_blockers(label: &str, content: &str) -> Vec<ArtifactBlocker> {
    let yaml = is_yaml_label(label);
    let read = read_config(yaml, content);
    let mut blockers = Vec::new();

    if read.multi_document {
        blockers.push(source_blocker(
            label,
            "UNRESOLVED_JACKSON_CONFIG",
            "The file holds more than one YAML document, so which settings reach the wire depends on the active profile at runtime".to_string(),
        ));
    }
    if read.jackson_opaque {
        blockers.push(source_blocker(
            label,
            "UNRESOLVED_JACKSON_CONFIG",
            "A Jackson setting is carried by a YAML alias, merge key or flow collection, so its value is defined somewhere this extractor does not follow".to_string(),
        ));
    }

    for entry in &read.entries {
        let (key, value) = match entry {
            ConfigEntry::Value(key, value) => (key.as_str(), Some(value.as_str())),
            ConfigEntry::Empty(key) => (key.as_str(), None),
        };
        if EXTERNAL_CONFIG_KEY_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
        {
            blockers.push(source_blocker(
                label,
                "UNRESOLVED_JACKSON_CONFIG",
                format!("`{key}` relocates or conditions the effective configuration, so the Jackson settings that reach the wire cannot be resolved from this file"),
            ));
            continue;
        }
        if !key.starts_with("spring.jackson.") || MODELLED_JACKSON_KEYS.contains(&key) {
            continue;
        }
        blockers.push(source_blocker(
            label,
            "UNSUPPORTED_JACKSON_FEATURE",
            format!(
                "Unqualified Jackson setting `{key}`{}; it changes which properties serialize or what they are called, and this extractor models only the naming strategy",
                value.map_or(String::new(), |value| format!(" = {value}"))
            ),
        ));
    }

    // A line the reader could not place is only a problem when it looks like Jackson
    // configuration. Anything else — a list item, a block scalar under an unrelated key — carries
    // no wire meaning and reporting it would bury the blockers that do.
    for line in &read.unparsed {
        if line.contains("jackson") {
            blockers.push(source_blocker(
                label,
                "UNRESOLVED_JACKSON_CONFIG",
                format!("Unsupported configuration syntax on a Jackson line: {line}"),
            ));
        }
    }

    blockers
}

/// The project directory a source root belongs to: `<module>/src/main/java` with the build-tool
/// suffix removed, or the given directory itself when it does not follow the convention.
fn module_root_of(java_dir: &Path) -> PathBuf {
    let components: Vec<_> = java_dir.components().collect();
    let convention_tail = ["src", "main", "java"];
    let matches_tail = components.len() >= convention_tail.len()
        && components
            .iter()
            .rev()
            .zip(convention_tail.iter().rev())
            .all(|(component, name)| component.as_os_str() == *name);
    if matches_tail {
        components[..components.len() - convention_tail.len()]
            .iter()
            .collect::<PathBuf>()
    } else {
        java_dir.to_path_buf()
    }
}

fn unsupported_naming_blocker(label: &str, strategy: &str) -> ArtifactBlocker {
    source_blocker(
        label,
        "JAVA_NAMING_STRATEGY_UNSUPPORTED",
        format!(
            "Jackson naming strategy {strategy} is not modelled by this extractor; wire field names would otherwise be assumed camelCase"
        ),
    )
}

/// The naming strategy a Spring Boot configuration file declares, the digest of the bytes that
/// governed the wire names, and the strategy name to report when it could not be modelled.
fn config_naming(label: &str, content: &str) -> (NamingStrategy, String, Option<String>) {
    let (strategy, unsupported) = if is_yaml_label(label) {
        yaml_naming(content)
    } else {
        properties_naming(content)
    };

    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let fp = hex::encode(hasher.finalize());
    let fingerprint = if fp.len() >= 32 {
        fp[..32].to_string()
    } else {
        fp
    };

    (strategy, fingerprint, unsupported)
}

fn is_yaml_label(label: &str) -> bool {
    label.ends_with(".yml") || label.ends_with(".yaml")
}

/// Only snake_case is modelled beyond the Jackson default. Every other strategy
/// would silently produce wrong wire names, so it is reported as a blocker
/// instead of being treated as camelCase.
fn properties_naming(content: &str) -> (NamingStrategy, Option<String>) {
    let unsupported = [
        "UPPER_SNAKE_CASE",
        "UPPER_CAMEL_CASE",
        "KEBAB_CASE",
        "LOWER_DOT_CASE",
        "LOWER_CASE",
    ]
    .iter()
    .find(|token| content.contains(**token))
    .map(|token| token.to_string());

    let strategy = if unsupported.is_some() {
        // Identity names; the accompanying blocker prevents the artifact from
        // being read as complete.
        NamingStrategy::CamelCase
    } else if content.contains("SNAKE_CASE") {
        NamingStrategy::SnakeCase
    } else {
        NamingStrategy::CamelCase
    };

    (strategy, unsupported)
}

/// The naming strategy declared by an explicit `spring.jackson.property-naming-strategy` key.
///
/// Unlike the properties reader this cannot scan the whole document: a YAML file mentions
/// strategy names in comments and under unrelated keys, and inheriting one of those would
/// either invent a snake_case wire or raise a blocker the project never configured. The full
/// dotted path is required for the same reason — a project's own `property-naming-strategy` key
/// under some other prefix has nothing to do with Jackson. An absent key is Jackson's camelCase
/// default; a present key whose value cannot be resolved statically fails closed rather than
/// guessing.
fn yaml_naming(content: &str) -> (NamingStrategy, Option<String>) {
    let read = read_config(true, content);

    // A key declared with nothing after it is not an absent key: its value is a block this reader
    // does not model, and reading it as Jackson's default would invent wire names.
    if read.entries.iter().any(|entry| {
        matches!(entry, ConfigEntry::Empty(key) if MODELLED_JACKSON_KEYS.contains(&key.as_str()))
    }) {
        return (
            NamingStrategy::CamelCase,
            Some("<no value on the same line>".to_string()),
        );
    }

    let Some(value) = read.entries.iter().find_map(|entry| match entry {
        ConfigEntry::Value(key, value) if MODELLED_JACKSON_KEYS.contains(&key.as_str()) => {
            Some(value.clone())
        }
        _ => None,
    }) else {
        return (NamingStrategy::CamelCase, None);
    };

    match value.as_str() {
        "LOWER_CAMEL_CASE" => (NamingStrategy::CamelCase, None),
        "SNAKE_CASE" => (NamingStrategy::SnakeCase, None),
        // The class form of the same strategy, e.g.
        // `com.fasterxml.jackson.databind.PropertyNamingStrategies$SnakeCaseStrategy`.
        _ if value.ends_with("SnakeCaseStrategy") => (NamingStrategy::SnakeCase, None),
        _ => (NamingStrategy::CamelCase, Some(value)),
    }
}

/// A configuration entry the reader could place.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigEntry {
    /// `key: value`, with the value on the same line.
    Value(String, String),
    /// A key with nothing after it. In YAML that is normally a parent whose children follow on
    /// deeper-indented lines, but it is kept because a Jackson key in this shape is exactly the
    /// case that must not be read as "not configured".
    Empty(String),
}

/// What the configuration reader made of one document.
#[derive(Debug, Default)]
struct ConfigRead {
    entries: Vec<ConfigEntry>,
    /// Lines it could not place, kept so the caller can fail closed on the ones that mention
    /// Jackson instead of concluding the document said nothing about serialization.
    unparsed: Vec<String>,
    /// The file holds more than one YAML document, so which settings reach the wire depends on
    /// the active profile.
    multi_document: bool,
    /// A value under `spring.jackson` this reader cannot see inside: a YAML alias, a merge key, or
    /// a flow collection.
    jackson_opaque: bool,
}

/// Dotted configuration keys from a properties or YAML document.
///
/// This is a line reader and not a YAML parser, and it reports that through `unparsed`: block
/// scalars, flow mappings and multi-line lists come back as lines it could not place. Claiming to
/// understand less than a document says is the honest direction to be wrong in — the alternative
/// is a wire name certified from a key that was never read.
fn read_config(yaml: bool, content: &str) -> ConfigRead {
    let mut read = ConfigRead::default();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut seen_content = false;

    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if !yaml {
            seen_content = true;
            match trimmed.split_once(['=', ':']) {
                Some((key, value)) => read.entries.push(ConfigEntry::Value(
                    key.trim().to_string(),
                    value.trim().to_string(),
                )),
                None => read.unparsed.push(trimmed.to_string()),
            }
            continue;
        }

        if trimmed == "---" || trimmed == "..." {
            // A leading separator only opens the single document that follows it; a later one
            // starts another, and Spring selects between them by profile.
            if seen_content {
                read.multi_document = true;
            }
            stack.clear();
            continue;
        }
        seen_content = true;

        let indent = line.len() - trimmed.len();
        let Some((key, value)) = split_yaml_mapping(trimmed) else {
            read.unparsed.push(trimmed.to_string());
            continue;
        };
        while stack.last().is_some_and(|(top, _)| *top >= indent) {
            stack.pop();
        }
        let dotted = stack
            .iter()
            .map(|(_, segment)| segment.as_str())
            .chain([key])
            .collect::<Vec<_>>()
            .join(".");

        if value.is_empty() {
            stack.push((indent, key.to_string()));
            read.entries.push(ConfigEntry::Empty(dotted));
            continue;
        }
        if (dotted == "spring.jackson" || dotted.starts_with("spring.jackson."))
            && (has_yaml_reference(value) || value.starts_with('{') || value.starts_with('['))
        {
            read.jackson_opaque = true;
        }
        read.entries
            .push(ConfigEntry::Value(dotted, yaml_scalar(value)));
    }

    // A key that turned out to be a parent carries no setting of its own. Keeping it would report
    // every ancestor of one offending key as an offence in its own right, so `spring.config
    // .activate.on-profile: prod` would read as four problems instead of one.
    let parents: Vec<String> = read
        .entries
        .iter()
        .map(|entry| match entry {
            ConfigEntry::Value(key, _) | ConfigEntry::Empty(key) => key.as_str(),
        })
        .filter_map(|key| key.rsplit_once('.'))
        .map(|(prefix, _)| prefix.to_string())
        .collect();
    read.entries.retain(
        |entry| !matches!(entry, ConfigEntry::Empty(key) if parents.iter().any(|p| p == key)),
    );

    read
}

/// The key and inline value of a YAML mapping line, or `None` when the line is not a mapping
/// entry this reader can place.
fn split_yaml_mapping(line: &str) -> Option<(&str, &str)> {
    // A sequence item or an explicit key carries no mapping of its own.
    if line.starts_with("- ") || line == "-" || line.starts_with("? ") {
        return None;
    }
    let mut quote: Option<char> = None;
    for (index, character) in line.char_indices() {
        match quote {
            Some(open) if character == open => quote = None,
            Some(_) => {}
            None if character == '"' || character == '\'' => quote = Some(character),
            None if character == ':' => {
                let rest = &line[index + 1..];
                // `http://host` and `a:b` are values, not keys: a YAML key colon is followed by
                // whitespace or by the end of the line.
                if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t') {
                    let key = line[..index].trim().trim_matches(|c| c == '"' || c == '\'');
                    return Some((key, rest.trim_start()));
                }
            }
            None => {}
        }
    }
    None
}

/// Whether a YAML value pulls in a node defined elsewhere in the document, whose content is
/// therefore not on this line.
fn has_yaml_reference(value: &str) -> bool {
    value
        .split(|character: char| character.is_whitespace() || character == ':')
        .any(|token| {
            let token = token.trim_matches(|c| matches!(c, ',' | '[' | ']' | '{' | '}'));
            token.len() > 1 && (token.starts_with('&') || token.starts_with('*'))
        })
}

/// The scalar to the right of a YAML key, with an inline comment and any surrounding quotes
/// removed.
fn yaml_scalar(raw: &str) -> String {
    let without_comment = match raw.split_once(" #") {
        Some((value, _)) => value,
        None => raw,
    };
    without_comment
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

fn compute_file_sha256(path: &Path) -> Option<String> {
    if let Ok(bytes) = fs::read(path) {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hex::encode(hasher.finalize()))
    } else {
        None
    }
}

fn annotation_arg_string(node: Node, source: &str, key: &str) -> Option<String> {
    let arg_node = annotation_arg_node(node, source, key)?;
    let raw = node_text(arg_node, source).trim().to_string();
    Some(raw.trim_matches('"').trim_matches('\'').to_string())
}

fn extract_context_path(inputs: &ConfigInputs) -> Option<String> {
    for (_, content) in &inputs.files {
        // YAML needs the parent key: a bare `base-path:` is also used by other Spring
        // modules (for example Spring Data REST), and only `spring.webflux.base-path`
        // prefixes the routes of a WebFlux application.
        let mut webflux_indent: Option<usize> = None;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') || trimmed.starts_with("//") {
                continue;
            }
            let indent = line.len() - line.trim_start().len();
            if trimmed == "webflux:" {
                webflux_indent = Some(indent);
                continue;
            }
            if let Some(section_indent) = webflux_indent {
                if !trimmed.is_empty() && indent <= section_indent {
                    webflux_indent = None;
                } else if let Some(rest) = trimmed.strip_prefix("base-path:") {
                    let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if !v.is_empty() && !v.starts_with('{') {
                        return Some(v.to_string());
                    }
                }
            }
            if let Some(rest) = trimmed
                .strip_prefix("server.servlet.context-path")
                .or_else(|| trimmed.strip_prefix("server.servlet.contextPath"))
                .or_else(|| trimmed.strip_prefix("spring.mvc.servlet.path"))
                .or_else(|| trimmed.strip_prefix("spring.webflux.base-path"))
                .or_else(|| trimmed.strip_prefix("spring.webflux.basePath"))
            {
                let rest = rest.trim_start();
                if let Some(val) = rest.strip_prefix('=') {
                    let v = val.trim().trim_matches('"').trim_matches('\'').trim();
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
            if let Some(rest) = trimmed
                .strip_prefix("context-path:")
                .or_else(|| trimmed.strip_prefix("contextPath:"))
            {
                let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() && !v.starts_with('{') {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}
