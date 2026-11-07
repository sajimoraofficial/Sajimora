//! Jackson declarations that hand the wire shape to runtime code are the largest single
//! UNKNOWN class in the Spring Boot corpora. Five of them fix the shape in the source itself,
//! and this file pins both the gain and the abstention:
//!
//!  * `@JsonTypeInfo` paired with an enumerated `@JsonSubTypes` list, including a base that
//!    one of its own subtypes names back (the recursion is the declared shape).
//!  * `@JsonSerialize(using = X.class)` where X's own `serialize` body writes a fixed shape.
//!  * A guard inside such a body, which can hide a field but cannot invent a field name.
//!  * An annotation placed on a *member* rather than on the type: an `@JsonAnyGetter` only
//!    adds inlined entries to an open object, and `use = Id.NONE` forbids a type id.
//!  * A class that extends a JDK map, whose content is the map contract in its `extends`
//!    clause rather than any declared field.
//!
//! Everything that depends on a runtime resolver, a data-driven field set, or an unnamed
//! discriminator must stay Unknown, because an abstention is evidence and a guess is a bug.

use contract_core::envelope::BackendContractPayload;
use contract_core::ir::{PrimitiveScalar, WireType};
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};

fn payload(tag: &str, sources: &[(&str, &str)]) -> BackendContractPayload {
    let root = std::path::PathBuf::from("jackson-shape-fixture");
    let blobs = sources
        .iter()
        .map(|(name, body)| (format!("src/main/java/com/demo/{name}"), body.to_string()))
        .collect();
    JavaRouteExtractor::from_blobs(root, blobs, ConfigInputs::default())
        .expect("extractor")
        .extract_payload(tag)
        .0
}

fn response_body(payload: &BackendContractPayload, path: &str) -> WireType {
    payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == path
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .unwrap_or_else(|| panic!("RESPONSE endpoint for {path} must exist"))
        .body
        .clone()
        .unwrap_or_else(|| panic!("RESPONSE endpoint for {path} must publish a body type"))
}

/// Jackson-derived composite shapes are interned in the type pool, so a test that wants the
/// declared shape has to follow the reference the way `expand_type_pool` does.
fn deref(payload: &BackendContractPayload, wt: &WireType) -> WireType {
    match wt {
        WireType::Ref(r) => payload
            .type_pool
            .as_ref()
            .and_then(|pool| pool.get(&r.r#ref).cloned())
            .unwrap_or_else(|| panic!("the type pool must contain {}", r.r#ref)),
        other => other.clone(),
    }
}

const TRANSPORT_BASE: &str = r#"
package com.demo;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(
        use = JsonTypeInfo.Id.NAME,
        include = JsonTypeInfo.As.PROPERTY,
        property = "kind")
@JsonSubTypes({
        @JsonSubTypes.Type(value = DefaultTransport.class, name = "DEFAULT"),
        @JsonSubTypes.Type(value = MqttTransport.class, name = "MQTT")})
public interface TransportConfig {
}
"#;

const TRANSPORT_SUBTYPES: &str = r#"
package com.demo;

class DefaultTransport {
    public String username;
    public Integer port;
}

class MqttTransport {
    public String clientId;
    public Boolean cleanSession;
}
"#;

const POLY_CONTROLLER: &str = r#"
package com.demo;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/poly")
public class PolyController {
    @GetMapping("/config")
    public TransportConfig config() { return null; }

    @GetMapping("/custom")
    public CustomConfig custom() { return null; }

    @GetMapping("/nosubs")
    public NoSubTypes nosubs() { return null; }

    @GetMapping("/noprop")
    public NoProperty named() { return null; }
}

@JsonTypeInfo(use = JsonTypeInfo.Id.CUSTOM, property = "kind")
@JsonSubTypes({@JsonSubTypes.Type(value = MqttTransport.class, name = "MQTT")})
interface CustomConfig {}

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "kind")
interface NoSubTypes {}

// The discriminator's name is Jackson's own default here, not something this source states.
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME)
@JsonSubTypes({@JsonSubTypes.Type(value = MqttTransport.class, name = "MQTT")})
interface NoProperty {}
"#;

fn poly_sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("TransportConfig.java", TRANSPORT_BASE),
        ("Transports.java", TRANSPORT_SUBTYPES),
        ("PolyController.java", POLY_CONTROLLER),
    ]
}

#[test]
fn test_json_subtypes_publishes_a_discriminated_union() {
    let sources = poly_sources();
    let payload = payload("poly", &sources);
    // The union is interned under the base's own key, because a subtype may name the base back
    // and that recursion has to point at a node instead of expanding forever.
    let body = deref(&payload, &response_body(&payload, "/api/poly/config"));
    let WireType::Union(union) = &body else {
        panic!("an enumerated @JsonSubTypes list fixes the wire shape, got {body:?}");
    };
    assert_eq!(union.types.len(), 2, "one arm per declared subtype");

    let mut arms: Vec<(String, String, usize)> = Vec::new();
    for arm in &union.types {
        let arm = deref(&payload, arm);
        let WireType::Object(obj) = &arm else {
            panic!("each subtype is an object arm, got {arm:?}");
        };
        let disc = obj
            .properties
            .iter()
            .find(|p| p.wire_name == "kind")
            .unwrap_or_else(|| {
                panic!(
                    "the annotation's property name must appear: {:?}",
                    obj.properties
                )
            });
        let WireType::Literal(lit) = &disc.r#type else {
            panic!(
                "the discriminator is a fixed literal token, got {:?}",
                disc.r#type
            );
        };
        arms.push((
            obj.name.clone().unwrap_or_default(),
            lit.value.as_str().unwrap_or_default().to_string(),
            obj.properties.len(),
        ));
    }
    assert_eq!(
        arms,
        vec![
            ("DefaultTransport".to_string(), "DEFAULT".to_string(), 3),
            ("MqttTransport".to_string(), "MQTT".to_string(), 3),
        ],
        "arms carry the discriminator plus the subtype's own fields, in annotation order"
    );
}

#[test]
fn test_runtime_resolved_or_unnamed_polymorphism_stays_unknown() {
    let sources = poly_sources();
    let payload = payload("poly", &sources);

    // Id.CUSTOM delegates subtype selection to code Jackson calls at runtime.
    let WireType::Unknown(u) = response_body(&payload, "/api/poly/custom") else {
        panic!("Id.CUSTOM must stay inconclusive");
    };
    assert!(u.reason.contains("@JsonTypeInfo"), "reason: {}", u.reason);

    // @JsonTypeInfo with no enumerated subtypes cannot be closed either.
    let WireType::Unknown(u) = response_body(&payload, "/api/poly/nosubs") else {
        panic!("an unenumerated polymorphic type must stay inconclusive");
    };
    assert!(
        u.reason.starts_with("UNSUPPORTED_CONSTRUCT:"),
        "reason: {}",
        u.reason
    );
    assert!(u.reason.contains("@JsonTypeInfo"), "reason: {}", u.reason);

    // Without a written property name the discriminator's wire name is not evidence.
    let WireType::Unknown(u) = response_body(&payload, "/api/poly/noprop") else {
        panic!("a discriminator name Jackson picks for us must not be published");
    };
    assert!(u.reason.contains("@JsonTypeInfo"), "reason: {}", u.reason);
}

const SERIALIZER_FIXTURES: &str = r#"
package com.demo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;

@JsonSerialize(using = RefIdSerializer.class)
class RefId {
    public String entityType;
    public String raw;
}

class RefIdSerializer extends com.fasterxml.jackson.databind.JsonSerializer<RefId> {
    @Override
    public void serialize(RefId value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writeStartObject();
        // A comment mentioning gen.writeString must not be read as a write.
        gen.writeStringField("entityType", value.entityType);
        gen.writeStringField("id", value.raw);
        gen.writeEndObject();
    }
}

@JsonSerialize(using = NameSerializer.class)
class PersonName {
    public String full;
}

class NameSerializer extends com.fasterxml.jackson.databind.JsonSerializer<PersonName> {
    @Override
    public void serialize(PersonName value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writeString(value.full);
    }
}

@JsonSerialize(using = DynamicSerializer.class)
class DynamicShape {
    public java.util.Map<String, String> rows;
}

class DynamicSerializer extends com.fasterxml.jackson.databind.JsonSerializer<DynamicShape> {
    @Override
    public void serialize(DynamicShape value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writeStartObject();
        for (String key : value.rows.keySet()) {
            gen.writeStringField(key, value.rows.get(key));
        }
        gen.writeEndObject();
    }
}

@JsonSerialize(using = DelegatingSerializer.class)
class OpaqueShape {
    public String value;
}

class DelegatingSerializer extends com.fasterxml.jackson.databind.JsonSerializer<OpaqueShape> {
    @Override
    public void serialize(OpaqueShape value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writePOJO(value.value);
    }
}
"#;

const SERIALIZER_CONTROLLER: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/ser")
public class SerController {
    @GetMapping("/ref")
    public RefId ref() { return null; }

    @GetMapping("/name")
    public PersonName name() { return null; }

    @GetMapping("/dynamic")
    public DynamicShape dynamic() { return null; }

    @GetMapping("/delegating")
    public OpaqueShape delegating() { return null; }
}
"#;

fn serializer_sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Serializers.java", SERIALIZER_FIXTURES),
        ("SerController.java", SERIALIZER_CONTROLLER),
    ]
}

#[test]
fn test_custom_serializer_body_fixes_the_published_shape() {
    let sources = serializer_sources();
    let payload = payload("ser", &sources);

    let body = deref(&payload, &response_body(&payload, "/api/ser/ref"));
    let WireType::Object(obj) = &body else {
        panic!("a serializer writing a literal field set fixes an object, got {body:?}");
    };
    let names: Vec<&str> = obj
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["entityType", "id"],
        "written field names in written order"
    );
    for prop in &obj.properties {
        assert!(
            matches!(&prop.r#type, WireType::Primitive(p) if p.scalar == PrimitiveScalar::String),
            "writeStringField fixes a string value: {:?}",
            prop.r#type
        );
    }
    // The declared `raw` field is not what the wire carries; the serializer renamed it.
    assert!(
        !names.contains(&"raw"),
        "declared fields must not leak into a serializer-authored shape"
    );

    let WireType::Primitive(p) = response_body(&payload, "/api/ser/name") else {
        panic!("a single gen.writeString fixes a string");
    };
    assert_eq!(p.scalar, PrimitiveScalar::String);
}

#[test]
fn test_self_referencing_polymorphic_base_publishes_its_own_union() {
    // A subtype whose field names the polymorphic base re-enters the modelling rule. The base is
    // interned while its arms are built, so the nested occurrence points at that node instead of
    // expanding forever or falling back to an abstention.
    let sources = vec![
        (
            "Tree.java",
            r#"
package com.demo;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "kind")
@JsonSubTypes({
        @JsonSubTypes.Type(value = Branch.class, name = "BRANCH"),
        @JsonSubTypes.Type(value = Leaf.class, name = "LEAF")})
public interface Tree {
}

class Branch {
    public Tree next;
}

class Leaf {
    public String label;
}
"#,
        ),
        (
            "TreeController.java",
            r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/tree")
public class TreeController {
    @GetMapping
    public Tree tree() { return null; }
}
"#,
        ),
    ];
    let payload = payload("tree", &sources);
    let body = deref(&payload, &response_body(&payload, "/api/tree"));
    let WireType::Union(union) = &body else {
        panic!("the enumerated base must still publish a union");
    };
    assert_eq!(union.types.len(), 2);
    let branch_arm = deref(&payload, &union.types[0]);
    let WireType::Object(branch) = &branch_arm else {
        panic!("branch arm should be an object, got {branch_arm:?}");
    };
    let next = branch
        .properties
        .iter()
        .find(|p| p.wire_name == "next")
        .expect("the self-referencing field keeps its name");
    // `Tree next` inside a Tree subtype is not an unknown: the base's own union is the shape, so
    // the nested occurrence has to resolve to the interned union rather than to an abstention.
    let WireType::Ref(next_ref) = &next.r#type else {
        panic!(
            "the recursive occurrence names the base, got {:?}",
            next.r#type
        );
    };
    let pool = payload
        .type_pool
        .as_ref()
        .expect("the pool carries the interned union");
    let nested = pool
        .get(&next_ref.r#ref)
        .unwrap_or_else(|| panic!("{} must be in the pool", next_ref.r#ref));
    let WireType::Union(nested_union) = nested else {
        panic!("the recursive occurrence is the base union, got {nested:?}");
    };
    assert_eq!(
        nested_union.types.len(),
        2,
        "one recursion level is published, and the walk stops at the reference"
    );
}

#[test]
fn test_serializer_that_delegates_or_varies_its_fields_stays_unknown() {
    let sources = serializer_sources();
    let payload = payload("ser", &sources);

    // A loop over runtime keys writes a field set nothing in the source enumerates.
    let WireType::Unknown(u) = response_body(&payload, "/api/ser/dynamic") else {
        panic!("a data-driven field set must stay inconclusive");
    };
    assert!(u.reason.contains("@JsonSerialize"), "reason: {}", u.reason);

    // writePOJO hands the value to the framework's own serializer chain.
    let WireType::Unknown(u) = response_body(&payload, "/api/ser/delegating") else {
        panic!("a delegating serializer must stay inconclusive");
    };
    assert!(u.reason.contains("@JsonSerialize"), "reason: {}", u.reason);
}

const CONDITIONAL_SERIALIZER_FIXTURES: &str = r#"
package com.demo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;

@JsonSerialize(using = AliasSerializer.class)
class Alias {
    public String aliasType;
    public String realType;
    public String raw;
}

class AliasSerializer extends com.fasterxml.jackson.databind.JsonSerializer<Alias> {
    @Override
    public void serialize(Alias value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writeStartObject();
        String entityType;
        // The branch picks a value, not a field: `entityType` is written either way.
        if (value.aliasType != null) {
            entityType = value.aliasType;
        } else {
            entityType = value.realType;
        }
        gen.writeStringField("entityType", entityType);
        String id = value.raw;
        if (id != null) {
            gen.writeStringField("id", id);
        }
        gen.writeEndObject();
    }
}

@JsonSerialize(using = EitherSerializer.class)
class Either {
    public boolean numeric;
    public Double n;
    public String s;
}

class EitherSerializer extends com.fasterxml.jackson.databind.JsonSerializer<Either> {
    @Override
    public void serialize(Either value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        gen.writeStartObject();
        if (value.numeric) {
            gen.writeNumberField("amount", value.n);
        } else {
            gen.writeStringField("amount", value.s);
        }
        gen.writeEndObject();
    }
}

@JsonSerialize(using = EnvelopeSerializer.class)
class MaybeObject {
    public String text;
}

class EnvelopeSerializer extends com.fasterxml.jackson.databind.JsonSerializer<MaybeObject> {
    @Override
    public void serialize(MaybeObject value, com.fasterxml.jackson.core.JsonGenerator gen,
                          com.fasterxml.jackson.databind.SerializerProvider serializers)
            throws java.io.IOException {
        if (value.text == null) {
            gen.writeNull();
        } else {
            gen.writeStartObject();
            gen.writeStringField("text", value.text);
            gen.writeEndObject();
        }
    }
}
"#;

const CONDITIONAL_CONTROLLER: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/cond")
public class CondController {
    @GetMapping("/alias")
    public Alias alias() { return null; }

    @GetMapping("/either")
    public Either either() { return null; }

    @GetMapping("/maybe")
    public MaybeObject maybe() { return null; }
}
"#;

fn conditional_sources() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "ConditionalSerializers.java",
            CONDITIONAL_SERIALIZER_FIXTURES,
        ),
        ("CondController.java", CONDITIONAL_CONTROLLER),
    ]
}

#[test]
fn test_guarded_field_write_is_an_optional_property_not_an_abstention() {
    let sources = conditional_sources();
    let payload = payload("cond", &sources);
    let body = deref(&payload, &response_body(&payload, "/api/cond/alias"));
    let WireType::Object(obj) = &body else {
        panic!("a serializer whose guard only hides a field fixes that field set, got {body:?}");
    };
    let found: Vec<(String, bool)> = obj
        .properties
        .iter()
        .map(|p| (p.wire_name.clone(), p.optional))
        .collect();
    assert_eq!(
        found,
        vec![("entityType".to_string(), false), ("id".to_string(), true)],
        "an unguarded write is always present; a write inside `if (id != null)` may be absent"
    );
    for prop in &obj.properties {
        assert!(
            matches!(&prop.r#type, WireType::Primitive(p) if p.scalar == PrimitiveScalar::String),
            "both writes are string writes: {:?}",
            prop.r#type
        );
    }
}

#[test]
fn test_guard_that_changes_a_value_kind_or_the_envelope_stays_unknown() {
    let sources = conditional_sources();
    let payload = payload("cond", &sources);

    // The same field name written as a number on one branch and a string on the other: the guard
    // decides the shape, not the presence, so nothing may be published.
    let WireType::Unknown(u) = response_body(&payload, "/api/cond/either") else {
        panic!("a branch that changes a value kind must stay inconclusive");
    };
    assert!(u.reason.contains("@JsonSerialize"), "reason: {}", u.reason);

    // A guard around `writeStartObject` decides whether the object exists at all.
    let WireType::Unknown(u) = response_body(&payload, "/api/cond/maybe") else {
        panic!("a guarded envelope must stay inconclusive");
    };
    assert!(u.reason.contains("@JsonSerialize"), "reason: {}", u.reason);
}

/// ThingsBoard's polymorphic subtypes override a `getType()` accessor whose name is also the
/// `@JsonTypeInfo` discriminator. Jackson writes that name once, as the discriminator.
const DISCRIMINATOR_COLLISION: &str = r#"
package com.demo;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import org.springframework.web.bind.annotation.*;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = FastWidget.class, name = "FAST"),
        @JsonSubTypes.Type(value = SlowWidget.class, name = "SLOW")})
public interface Widget {
}

enum WidgetKind {
    FAST,
    SLOW
}

class FastWidget {
    public String url;

    public WidgetKind getType() { return WidgetKind.FAST; }
}

class SlowWidget {
    public int latencyMs;

    public WidgetKind getType() { return WidgetKind.SLOW; }
}

@RestController
@RequestMapping("/api/widget")
public class WidgetController {
    @GetMapping
    public Widget widget() { return null; }
}
"#;

#[test]
fn test_a_getter_sharing_the_discriminator_name_does_not_duplicate_the_property() {
    let payload = payload("collision", &[("Widget.java", DISCRIMINATOR_COLLISION)]);
    let body = deref(&payload, &response_body(&payload, "/api/widget"));
    let WireType::Union(union) = &body else {
        panic!("the enumerated base publishes a union, got {body:?}");
    };
    for arm in &union.types {
        let WireType::Object(obj) = deref(&payload, arm) else {
            panic!("arms are objects, got {arm:?}");
        };
        let names: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        let type_positions = names.iter().filter(|n| **n == "type").count();
        assert_eq!(
            type_positions, 1,
            "one `type` on the wire, and it is the arm's own shape: {names:?}"
        );
        let discriminator = &obj.properties[names.iter().position(|n| *n == "type").unwrap()];
        assert!(
            matches!(&discriminator.r#type, WireType::Literal(_)),
            "the surviving `type` is the discriminator the annotation states, not a getter's enum: {:?}",
            discriminator.r#type
        );
    }
    let first = match deref(&payload, &union.types[0]) {
        WireType::Object(obj) => obj,
        other => panic!("{other:?}"),
    };
    let names: Vec<&str> = first
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["type", "url"],
        "discriminator plus the subtype's own field"
    );
}

// A Jackson annotation placed on a member speaks about that member, not about the object that
// declares it. `@JsonAnyGetter` inlines the entries of a map into an object that also has
// declared fields, and `use = Id.NONE` forbids a type id outright. Both used to abstain the
// whole declaring class, which threw away the fields the source did state.
const MEMBER_SHAPE_CLASSES: &str = r#"
package com.demo;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import java.util.HashMap;
import java.util.Map;

@JsonTypeInfo(
        use = JsonTypeInfo.Id.NAME,
        include = JsonTypeInfo.As.PROPERTY,
        property = "kind")
@JsonSubTypes({
        @JsonSubTypes.Type(value = PlainBag.class, name = "PLAIN"),
        @JsonSubTypes.Type(value = OpenBag.class, name = "OPEN")})
interface Bag {}

class PlainBag {
    public String name;
}

class OpenBag {
    public String label;
    private final Map<String, Object> extra = new HashMap<>();

    @JsonAnyGetter
    public Map<String, Object> extra() { return extra; }

    @JsonAnySetter
    public void put(String key, Object value) { extra.put(key, value); }
}

class StepMarker {
    @JsonTypeInfo(use = JsonTypeInfo.Id.NONE)
    public String marker;

    public String title;
}
"#;

const MEMBER_SHAPE_CONTROLLER: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/member")
public class MemberShapeController {
    @GetMapping("/bag")
    public Bag bag() { return null; }

    @GetMapping("/marker")
    public StepMarker marker() { return null; }
}
"#;

#[test]
fn test_a_member_annotation_leaves_the_rest_of_the_object_published() {
    let sources = vec![
        ("Bag.java", MEMBER_SHAPE_CLASSES),
        ("MemberShapeController.java", MEMBER_SHAPE_CONTROLLER),
    ];
    let payload = payload("member", &sources);

    // One arm that inlines extra properties no longer makes the whole union inconclusive.
    let body = deref(&payload, &response_body(&payload, "/api/member/bag"));
    let WireType::Union(union) = &body else {
        panic!("an enumerated @JsonSubTypes list still fixes the shape, got {body:?}");
    };
    assert_eq!(union.types.len(), 2, "both arms are publishable");

    let open = match deref(&payload, &union.types[1]) {
        WireType::Object(obj) => obj,
        other => panic!("the any-getter arm is an object, got {other:?}"),
    };
    let names: Vec<&str> = open
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["kind", "label"],
        "the discriminator and the declared field are published; the inlined entries are the open part"
    );
    assert_eq!(
        open.strict,
        Some(false),
        "an object with an @JsonAnyGetter accepts properties no field names"
    );

    // `use = NONE` decides no runtime anything: it forbids the type id, so the bean shape stands.
    let marker = match deref(&payload, &response_body(&payload, "/api/member/marker")) {
        WireType::Object(obj) => obj,
        other => panic!("a member-level Id.NONE must not abstain the class, got {other:?}"),
    };
    let names: Vec<&str> = marker
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(names, vec!["marker", "title"]);
}

// Content that lives in map entries never appears as declared fields, and Jackson's map
// serializer writes the entries while ignoring the bean's own properties.
const MAP_SUBCLASS_CLASSES: &str = r#"
package com.demo;

import java.util.HashMap;

enum Region { EU, APAC }

class RoutingConfig {
    public Integer retries;
    public Boolean enabled;
}

class RoutingTable extends HashMap<Region, RoutingConfig> {
    private static final long serialVersionUID = 1L;
}

// A raw supertype states no key or value type, so there is no map contract to publish and the
// class keeps the shape its own fields give it.
class LooseTable extends HashMap {
    public String owner;
}
"#;

const MAP_SUBCLASS_CONTROLLER: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/mapshape")
public class MapShapeController {
    @GetMapping("/table")
    public RoutingTable table() { return null; }

    @GetMapping("/loose")
    public LooseTable loose() { return null; }
}
"#;

#[test]
fn test_a_map_subclass_publishes_the_map_contract_of_its_extends_clause() {
    let sources = vec![
        ("RoutingTable.java", MAP_SUBCLASS_CLASSES),
        ("MapShapeController.java", MAP_SUBCLASS_CONTROLLER),
    ];
    let payload = payload("mapshape", &sources);

    let WireType::Map(map) = response_body(&payload, "/api/mapshape/table") else {
        panic!("a class extending HashMap<String, X> serializes as that map");
    };
    let WireType::Enum(key) = deref(&payload, &map.key_type) else {
        panic!(
            "the key type is read from the extends clause, got {:?}",
            map.key_type
        );
    };
    assert_eq!(key.values, vec!["EU".to_string(), "APAC".to_string()]);
    let WireType::Object(value) = deref(&payload, &map.value_type) else {
        panic!(
            "the value type is read from the extends clause, got {:?}",
            map.value_type
        );
    };
    let names: Vec<&str> = value
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(names, vec!["retries", "enabled"]);

    // Nothing is invented for a supertype that names no key or value type.
    let loose = match deref(&payload, &response_body(&payload, "/api/mapshape/loose")) {
        WireType::Object(obj) => obj,
        other => panic!("a raw HashMap states no map contract, got {other:?}"),
    };
    let names: Vec<&str> = loose
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(names, vec!["owner"]);
}
