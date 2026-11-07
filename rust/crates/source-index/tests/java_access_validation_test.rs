use contract_core::envelope::BackendContractPayload;
use contract_core::ir::{
    ContractDirection, EndpointContract, ValidationConstraintKind, WirePropertyContract, WireType,
};
use source_index::java_routes::{ConfigInputs, JacksonAccess, JavaRouteExtractor};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn fixture(dto: &str, declarations: &str) -> BackendContractPayload {
    let source = format!(
        r#"
package demo;
import com.fasterxml.jackson.annotation.*;
import jakarta.validation.constraints.*;
import org.springframework.web.bind.annotation.*;
{declarations}
@RestController
class Controller {{
    @PostMapping("/value")
    public {dto} value(@RequestBody {dto} value) {{ return value; }}
}}
"#
    );
    payload(vec![("Fixture.java", source)])
}

fn payload(sources: Vec<(&str, String)>) -> BackendContractPayload {
    let blobs = sources
        .into_iter()
        .map(|(file, source)| (format!("src/demo/{file}"), source))
        .collect();
    JavaRouteExtractor::from_blobs(
        PathBuf::from("E:/java-access-blob-fixture"),
        blobs,
        ConfigInputs::default(),
    )
    .expect("blob extractor")
    .extract_payload("access-validation")
    .0
}

fn endpoint(p: &BackendContractPayload, direction: ContractDirection) -> &EndpointContract {
    p.endpoints
        .iter()
        .find(|e| e.identity.direction == direction)
        .expect("endpoint")
}

fn deref<'a>(p: &'a BackendContractPayload, wire: &'a WireType) -> &'a WireType {
    match wire {
        WireType::Ref(r) => &p.type_pool.as_ref().expect("pool")[&r.r#ref],
        other => other,
    }
}

fn body(p: &BackendContractPayload, direction: ContractDirection) -> &WireType {
    deref(p, endpoint(p, direction).body.as_ref().expect("body"))
}

fn props(p: &BackendContractPayload, direction: ContractDirection) -> &[WirePropertyContract] {
    match body(p, direction) {
        WireType::Object(o) => &o.properties,
        other => panic!("expected object, got {other:?}"),
    }
}

fn names(p: &BackendContractPayload, direction: ContractDirection) -> BTreeSet<&str> {
    props(p, direction)
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect()
}

fn expected<'a>(names: &[&'a str]) -> BTreeSet<&'a str> {
    names.iter().copied().collect()
}

fn assert_unsupported(wire: &WireType, annotation: &str) {
    let WireType::Unknown(u) = wire else {
        panic!("expected Unknown, got {wire:?}");
    };
    assert!(
        u.reason.starts_with("UNSUPPORTED_CONSTRUCT"),
        "{}",
        u.reason
    );
    assert!(u.reason.contains(annotation), "{}", u.reason);
    assert!(u.reason.contains("src/demo/Fixture.java:"), "{}", u.reason);
    assert!(u.provenance.is_some());
}

#[test]
fn field_access_modes_project_both_directions() {
    assert_eq!(JacksonAccess::default(), JacksonAccess::Auto);
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty(access = JsonProperty.Access.AUTO) private String auto;
        @JsonProperty(access = Access.READ_ONLY) private String read;
        @JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.WRITE_ONLY) private String password;
        @JsonProperty(access = JsonProperty.Access.READ_WRITE) private String both;
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["auto", "read", "both"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["auto", "password", "both"])
    );
}

#[test]
fn getter_access_modes_merge_real_private_fields() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        private String auto, read, write, both;
        @JsonProperty(access = Access.AUTO) public String getAuto() { return auto; }
        @JsonProperty(access = Access.READ_ONLY) public String getRead() { return read; }
        @JsonProperty(access = Access.WRITE_ONLY) public String getWrite() { return write; }
        @JsonProperty(access = Access.READ_WRITE) public String getBoth() { return both; }
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["auto", "read", "both"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["auto", "write", "both"])
    );
}

#[test]
fn setter_access_modes_merge_without_inventing_output() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        private String auto, read, write, both;
        @JsonProperty(access = Access.AUTO) public void setAuto(String v) {}
        @JsonProperty(access = Access.READ_ONLY) public void setRead(String v) {}
        @JsonProperty(access = Access.WRITE_ONLY) private void setWrite(String v) {}
        @JsonProperty(access = Access.READ_WRITE) public void setBoth(String v) {}
    }"#,
    );
    assert!(names(&p, ContractDirection::Response).is_empty());
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["auto", "write", "both"])
    );
}

#[test]
fn record_access_modes_and_renames_are_projected() {
    let p = fixture(
        "Dto",
        r#"record Dto(
        @JsonProperty(access = Access.AUTO) String auto,
        @JsonProperty(access = Access.READ_ONLY) String read,
        @JsonProperty(value = "secret", access = Access.WRITE_ONLY) String password,
        @JsonProperty(access = Access.READ_WRITE) String both) {}"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["auto", "read", "both"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["auto", "secret", "both"])
    );
}

#[test]
fn computed_getters_do_not_create_input_but_lombok_fields_do() {
    let p = fixture(
        "Dto",
        r#"@lombok.Getter class Dto {
        private String stored;
        public String getComputed() { return "value"; }
        @JsonSetter("input_name") private void accept(String input) {}
        public void setInvalid(String a, String b) {}
        private void setHidden(String a) {}
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["stored", "computed"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["stored", "input_name"])
    );
}

#[test]
fn json_ignore_false_is_not_inferred_from_other_strings() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonIgnore(false) public String field;
        @JsonIgnore(value = false) public String getComputed() { return "x"; }
        @JsonIgnore public String hidden;
        @JsonIgnore public String getHiddenGetter() { return "false"; }
        @JsonIgnore(false) public void setInput(String v) {}
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["field", "computed"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["field", "input"])
    );
    let p = fixture(
        "Dto",
        "record Dto(@JsonIgnore(false) String shown, @JsonIgnore String hidden) {}",
    );
    assert_eq!(names(&p, ContractDirection::Request), expected(&["shown"]));
}

#[test]
fn json_property_uses_value_not_unrelated_string_elements() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty(defaultValue = "wrong", access = Access.WRITE_ONLY, value = "wire_secret") private String password;
        @JsonProperty(defaultValue = "also_wrong", access = Access.AUTO) private String ordinary;
        @JsonProperty(defaultValue = "getter_wrong", value = "wire_computed") public String getComputed() { return ""; }
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["ordinary", "wire_computed"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["ordinary", "wire_secret"])
    );
}

#[test]
fn statically_imported_access_constants_require_source_evidence() {
    let p = fixture(
        "Dto",
        r#"import static com.fasterxml.jackson.annotation.JsonProperty.Access.WRITE_ONLY;
        class Dto { @JsonProperty(access = WRITE_ONLY) public String password; }"#,
    );
    assert!(names(&p, ContractDirection::Response).is_empty());
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["password"])
    );
    for expression in ["WRITE_ONLY", "\"Access.WRITE_ONLY\"", "Modes.WRITE_ONLY"] {
        let p = fixture(
            "Dto",
            &format!(
                "class Dto {{ @JsonProperty(access = {expression}) public String password; }}"
            ),
        );
        assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
    }
}

#[test]
fn explicit_access_conflicts_fail_closed_instead_of_selecting_a_member() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty(access = Access.READ_ONLY) public String secret;
        @JsonProperty(access = Access.WRITE_ONLY) public String getSecret() { return secret; }
    }"#,
    );
    assert_unsupported(body(&p, ContractDirection::Response), "JsonProperty");
    assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
}

#[test]
fn ignore_properties_named_exceptions_cover_all_flag_combinations() {
    for (getters, setters) in [(false, false), (true, false), (false, true), (true, true)] {
        let p = fixture(
            "Dto",
            &format!(
                r#"
            @JsonIgnoreProperties(value = {{"getterBacked", "fieldOnly", "setterOnly"}}, allowGetters = {getters}, allowSetters = {setters})
            class Dto {{
                private String getterBacked;
                public String fieldOnly;
                public String untouched;
                public String getGetterBacked() {{ return getterBacked; }}
                public void setSetterOnly(String v) {{}}
            }}"#
            ),
        );
        let response = if getters {
            expected(&["getterBacked", "fieldOnly", "untouched"])
        } else {
            expected(&["untouched"])
        };
        let request = if setters {
            expected(&["getterBacked", "fieldOnly", "setterOnly", "untouched"])
        } else {
            expected(&["untouched"])
        };
        assert_eq!(names(&p, ContractDirection::Response), response);
        assert_eq!(names(&p, ContractDirection::Request), request);
    }
}

#[test]
fn inherited_ignored_json_names_keep_direction_and_declaration_provenance() {
    let p = fixture(
        "Dto",
        r#"
        @JsonIgnoreProperties(value = {"wire_hidden"}, allowSetters = true)
        class Base {
            @JsonProperty("wire_hidden") @Size(min = 2) public String hidden;
            public String visible;
        }
        class Dto extends Base { public String own; }
    "#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["visible", "own"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["wire_hidden", "visible", "own"])
    );
    let hidden = props(&p, ContractDirection::Request)
        .iter()
        .find(|p| p.wire_name == "wire_hidden")
        .unwrap();
    assert_eq!(
        hidden.validation_constraints[0]
            .provenance
            .as_ref()
            .unwrap()
            .annotation_or_schema
            .as_deref(),
        Some("@Size(min = 2)")
    );
}

#[test]
fn record_ignore_exceptions_restore_named_components_in_both_directions() {
    let p = fixture(
        "Dto",
        r#"@JsonIgnoreProperties(value = {"hidden"}, allowGetters = true, allowSetters = true)
        record Dto(String hidden, String ordinary) {}"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["hidden", "ordinary"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["hidden", "ordinary"])
    );
}

#[test]
fn nested_arrays_maps_and_recursive_dtos_use_distinct_direction_pools() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty(access = Access.WRITE_ONLY) public String password;
        @JsonProperty(access = Access.READ_ONLY) public String id;
        public Dto[] children;
        public java.util.Map<String, Dto> byName;
        public Dto next;
    }"#,
    );
    let pool = p.type_pool.as_ref().unwrap();
    assert!(pool.contains_key("java:demo.Dto"));
    assert!(pool.contains_key("java:demo.Dto:request"));
    for (direction, key, allowed, excluded) in [
        (
            ContractDirection::Response,
            "java:demo.Dto",
            "id",
            "password",
        ),
        (
            ContractDirection::Request,
            "java:demo.Dto:request",
            "password",
            "id",
        ),
    ] {
        assert!(names(&p, direction.clone()).contains(allowed));
        assert!(!names(&p, direction.clone()).contains(excluded));
        for prop in props(&p, direction) {
            let nested = match &prop.r#type {
                WireType::Array(a) => Some(a.element_type.as_ref()),
                WireType::Map(m) => Some(m.value_type.as_ref()),
                WireType::Ref(_) => Some(&prop.r#type),
                _ => None,
            };
            if let Some(WireType::Ref(r)) = nested {
                assert_eq!(r.r#ref, key);
            }
        }
    }
}

#[test]
fn recursive_generic_requests_and_map_subclasses_keep_direction() {
    let p = fixture(
        "Box<Dto>",
        r#"
        class Dto { @JsonProperty(access = Access.READ_ONLY) public String id; public String value; }
        class Box<T> { public T value; public Box<T> next; public java.util.List<T> values; }
    "#,
    );
    let request = props(&p, ContractDirection::Request);
    assert_eq!(request.len(), 3);
    let WireType::Ref(r) = &request[0].r#type else {
        panic!("DTO ref");
    };
    assert_eq!(r.r#ref, "java:demo.Dto:request");
    let WireType::Ref(r) = &request[1].r#type else {
        panic!("recursive generic ref");
    };
    assert_eq!(r.r#ref, "java:demo.Box<demo.Dto>:request");
    assert_eq!(props(&p, ContractDirection::Response).len(), 3);
    let p = fixture(
        "DtoMap",
        r#"
        class Dto { @JsonProperty(access = Access.READ_ONLY) public String id; public String value; }
        class DtoMap extends java.util.HashMap<String, Dto> {}
    "#,
    );
    let WireType::Map(m) = body(&p, ContractDirection::Request) else {
        panic!("map");
    };
    let WireType::Ref(r) = m.value_type.as_ref() else {
        panic!("map value ref");
    };
    assert_eq!(r.r#ref, "java:demo.Dto:request");
}

#[test]
fn extracted_request_projection_drives_constraint_conforming_samples() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty(access = Access.WRITE_ONLY) @NotBlank @Size(min = 8, max = 12) public String password;
        @JsonProperty(access = Access.READ_ONLY) public String id;
        @NotBlank @Email public String email;
        @Positive @Min(5) public int quantity;
        @NotEmpty @Size(min = 2, max = 3) public java.util.List<String> items;
    }"#,
    );
    let request = contract_core::request_synthesis::synthesize_request(
        endpoint(&p, ContractDirection::Response),
        &p.endpoints,
        p.type_pool.as_ref(),
        None,
    )
    .unwrap();
    let value = request.body.unwrap();
    assert_eq!(value["password"], "sajimora");
    assert!(value.get("id").is_none());
    assert_eq!(value["email"], "sajimora@example.test");
    assert_eq!(value["quantity"], 5);
    assert_eq!(value["items"].as_array().unwrap().len(), 2);
    assert!(!names(&p, ContractDirection::Response).contains("password"));
}

#[test]
fn field_validation_defaults_literals_positive_and_pattern_preserve_source() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @NotNull @NotBlank @NotEmpty @Email @Size @Pattern(regexp = "[A-Z]+", message = "original") public String value;
        @Size(min = 2, max = 7) public String bounded;
        @Min(-2L) @Max(value = 9) @Positive public double amount;
    }"#,
    );
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        let fields = props(&p, direction);
        assert!(!fields[0].nullable);
        let constraints = &fields[0].validation_constraints;
        assert_eq!(constraints.len(), 6);
        assert_eq!(
            constraints[4].value,
            Some(serde_json::json!({"min": 0, "max": 2147483647_i64}))
        );
        assert_eq!(constraints[5].value, Some(serde_json::json!("[A-Z]+")));
        assert_eq!(constraints[5].message.as_deref(), Some("original"));
        let provenance = constraints[5].provenance.as_ref().unwrap();
        assert_eq!(provenance.file, "src/demo/Fixture.java");
        assert!(provenance.line > 0);
        assert_eq!(
            provenance.annotation_or_schema.as_deref(),
            Some("@Pattern(regexp = \"[A-Z]+\", message = \"original\")")
        );
        assert_eq!(
            fields[1].validation_constraints[0].value,
            Some(serde_json::json!({"min": 2, "max": 7}))
        );
        assert_eq!(
            fields[2].validation_constraints[0].value,
            Some(serde_json::json!(-2))
        );
        assert_eq!(
            fields[2].validation_constraints[1].value,
            Some(serde_json::json!(9))
        );
        assert_eq!(
            fields[2].validation_constraints[2].kind,
            ValidationConstraintKind::Positive
        );
        assert_eq!(fields[2].validation_constraints[2].value, None);
    }
}

#[test]
fn record_and_getter_validation_are_not_discarded() {
    let p = fixture("Dto", "record Dto(@NotNull @Size(min = 1) String value) {}");
    assert_eq!(
        props(&p, ContractDirection::Request)[0]
            .validation_constraints
            .len(),
        2
    );
    let p = fixture(
        "Dto",
        r#"class Dto {
        private String value;
        @NotBlank @Email public String getValue() { return value; }
    }"#,
    );
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        let field = &props(&p, direction)[0];
        assert!(!field.nullable);
        assert_eq!(field.validation_constraints.len(), 2);
        assert_eq!(
            field.validation_constraints[0]
                .provenance
                .as_ref()
                .unwrap()
                .annotation_or_schema
                .as_deref(),
            Some("@NotBlank")
        );
    }
}

#[test]
fn setter_validation_is_input_only_and_includes_formal_parameter_constraints() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        public String value;
        @NotNull public void setValue(@Size(max = 8) String value) {}
    }"#,
    );
    let input = &props(&p, ContractDirection::Request)[0];
    assert_eq!(input.validation_constraints.len(), 2);
    assert!(!input.nullable);
    let output = &props(&p, ContractDirection::Response)[0];
    assert!(output.validation_constraints.is_empty());
    assert!(output.nullable);
}

#[test]
fn route_parameter_validation_populates_parameter_vectors_and_provenance() {
    let p = payload(vec![(
        "Fixture.java",
        r#"
        package demo;
        @RestController class Controller {
            @GetMapping("/value/{id}") public String value(
                @PathVariable @Min(2) long id,
                @RequestParam @NotBlank @Size(max = 12) String q,
                @RequestHeader @Pattern(regexp = "x+") String token) { return null; }
        }
    "#
        .to_string(),
    )]);
    let e = endpoint(&p, ContractDirection::Request);
    assert_eq!(
        e.path_parameters[0]
            .validation_constraints
            .as_ref()
            .unwrap()[0]
            .kind,
        ValidationConstraintKind::Min
    );
    assert_eq!(
        e.query_parameters[0]
            .validation_constraints
            .as_ref()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        e.headers[0].validation_constraints.as_ref().unwrap()[0].value,
        Some(serde_json::json!("x+"))
    );
    assert_eq!(
        e.path_parameters[0].provenance.as_ref().unwrap().file,
        "src/demo/Fixture.java"
    );
}

#[test]
fn unknown_validation_bounds_and_groups_are_explicitly_unsupported() {
    for annotation in [
        "@Size(min = Limits.MIN)",
        "@Min(value = LOW)",
        "@Max(1 + 2)",
        "@Pattern(regexp = RX)",
        "@NotNull(groups = Create.class)",
    ] {
        let p = fixture(
            "Dto",
            &format!("class Dto {{ {annotation} public String value; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), annotation);
        assert_eq!(names(&p, ContractDirection::Response), expected(&["value"]));
    }
    let p = payload(vec![("Fixture.java", "package demo; @RestController class Controller { @GetMapping(\"/value\") public String value(@RequestParam @Min(LOW) int q) { return null; } }".to_string())]);
    assert_unsupported(
        &endpoint(&p, ContractDirection::Request).query_parameters[0].r#type,
        "@Min(LOW)",
    );
}

#[test]
fn ignore_on_one_accessor_with_explicit_opposite_accessor_splits_direction() {
    // ThingsBoard's `CalculatedField.debugMode`: `@JsonIgnore` reader plus `@JsonSetter` writer.
    // Jackson removes only the annotated accessor, so this is a write-only property, not a
    // contradiction, and it must not abstain the whole DTO.
    let p = fixture(
        "Dto",
        r#"class Dto {
        private boolean debugMode;
        @JsonIgnore public boolean isDebugMode() { return debugMode; }
        @JsonSetter public void setDebugMode(boolean debugMode) { this.debugMode = debugMode; }
    }"#,
    );
    assert!(names(&p, ContractDirection::Response).is_empty());
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["debugMode"])
    );

    let p = fixture(
        "Dto",
        r#"class Dto {
        private String token;
        @JsonProperty public String getToken() { return token; }
        @JsonIgnore public void setToken(String token) {}
    }"#,
    );
    // Measured: an `@JsonIgnore` setter does not block input when the property is already
    // visible through an explicit getter, so this pair projects in both directions.
    assert_eq!(names(&p, ContractDirection::Response), expected(&["token"]));
    assert_eq!(names(&p, ContractDirection::Request), expected(&["token"]));

    // Without an explicit counterpart, an accessor ignore still hides the property entirely.
    let p = fixture(
        "Dto",
        r#"class Dto {
        private boolean debugMode;
        @JsonIgnore public boolean isDebugMode() { return debugMode; }
        public void setDebugMode(boolean debugMode) { this.debugMode = debugMode; }
    }"#,
    );
    assert!(names(&p, ContractDirection::Response).is_empty());
    assert!(names(&p, ContractDirection::Request).is_empty());
}

#[test]
fn same_class_string_constant_is_folded_into_the_json_name() {
    // The compiler inlines this literal, so the wire name is source evidence rather than a
    // runtime decision. A qualified `Names.NAME` still abstains: that constant lives elsewhere.
    let p = fixture(
        "Dto",
        r#"class Dto {
        public static final String WIRE = "wire_constant";
        @JsonProperty(WIRE) private String internal;
        public String plain;
    }"#,
    );
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        assert_eq!(
            names(&p, direction.clone()),
            expected(&["wire_constant", "plain"])
        );
    }
    let property = props(&p, ContractDirection::Request)
        .into_iter()
        .find(|property| property.wire_name == "wire_constant")
        .unwrap();
    assert!(property.provenance.as_ref().unwrap().line > 0);
}

#[test]
fn unmodelled_and_repeated_bean_constraints_require_explicit_input() {
    for annotation in [
        "@DecimalMin(\"1.5\")",
        "@Digits(integer = 3, fraction = 2)",
        "@Future",
        "@PositiveOrZero",
        "@Pattern.List({@Pattern(regexp = \"a+\")})",
        "@jakarta.validation.constraints.FutureOrPresent",
    ] {
        let p = fixture(
            "Dto",
            &format!("class Dto {{ {annotation} public String value; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), annotation);
        assert_eq!(names(&p, ContractDirection::Response), expected(&["value"]));
        let response = endpoint(&p, ContractDirection::Response);
        assert!(contract_core::request_synthesis::synthesize_request(
            response,
            &p.endpoints,
            p.type_pool.as_ref(),
            None
        )
        .is_err());
        let fixture = contract_core::request_synthesis::EndpointRequestFixture {
            body: Some(serde_json::json!({"value": "configured"})),
            ..Default::default()
        };
        assert!(contract_core::request_synthesis::synthesize_request(
            response,
            &p.endpoints,
            p.type_pool.as_ref(),
            Some(&fixture)
        )
        .is_ok());
    }
}

#[test]
fn custom_deserializers_block_requests_not_ordinary_responses() {
    for annotation in [
        "@JsonDeserialize(using = Custom.class)",
        "@JsonDeserialize(converter = Custom.class)",
        "@JsonDeserialize(contentUsing = Custom.class)",
        "@JsonDeserialize(keyUsing = Custom.class)",
    ] {
        let p = fixture(
            "Dto",
            &format!("{annotation} class Dto {{ public String ordinary; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), "JsonDeserialize");
        assert_eq!(
            names(&p, ContractDirection::Response),
            expected(&["ordinary"])
        );
        let p = fixture(
            "Dto",
            &format!("class Dto {{ {annotation} public String ordinary; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), "JsonDeserialize");
        assert_eq!(
            names(&p, ContractDirection::Response),
            expected(&["ordinary"])
        );
    }
}

#[test]
fn source_proven_serializer_response_is_not_reused_for_request_input() {
    let p = fixture(
        "Dto",
        r#"
        @JsonSerialize(using = Writer.class) class Dto { public String ordinary; }
        class Writer extends JsonSerializer<Dto> {
            public void serialize(Dto value, JsonGenerator gen, SerializerProvider provider) {
                gen.writeStartObject(); gen.writeStringField("wire", value.ordinary); gen.writeEndObject();
            }
        }
    "#,
    );
    assert_eq!(names(&p, ContractDirection::Response), expected(&["wire"]));
    assert_unsupported(body(&p, ContractDirection::Request), "JsonSerialize");
}

#[test]
fn closed_polymorphic_response_remains_proven_but_input_requires_runtime_fixture() {
    let p = fixture(
        "Base",
        r#"
        @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "kind")
        @JsonSubTypes({@JsonSubTypes.Type(value = Child.class, name = "child")})
        interface Base {}
        class Child { public String value; @JsonProperty(access = Access.WRITE_ONLY) public String secret; }
    "#,
    );
    let WireType::Union(u) = body(&p, ContractDirection::Response) else {
        panic!("proven response union");
    };
    let WireType::Object(o) = deref(&p, &u.types[0]) else {
        panic!("subtype object");
    };
    assert_eq!(
        o.properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect::<BTreeSet<_>>(),
        expected(&["kind", "value"])
    );
    assert_unsupported(body(&p, ContractDirection::Request), "JsonTypeInfo");
    let p = fixture("Dto", "@JsonTypeInfo(use = JsonTypeInfo.Id.CUSTOM, property = \"kind\") class Dto { public String ordinary; }");
    assert_unsupported(body(&p, ContractDirection::Response), "JsonTypeInfo");
}

#[test]
fn json_type_info_none_does_not_activate_polymorphism() {
    for annotation in ["@JsonTypeInfo(use = JsonTypeInfo.Id.NONE)",
        "@JsonTypeInfo(use = JsonTypeInfo.Id.NONE) @JsonSubTypes({@JsonSubTypes.Type(value = Dto.class)})"] {
        let p = fixture("Dto", &format!("{annotation} class Dto {{ public String ordinary; }}"));
        assert_eq!(names(&p, ContractDirection::Request), expected(&["ordinary"]));
        assert_eq!(names(&p, ContractDirection::Response), expected(&["ordinary"]));
    }
}

#[test]
fn unknown_jackson_names_and_ignore_arguments_fail_closed() {
    for annotation in [
        "@JsonProperty(value = Names.NAME)",
        "@JsonIgnore(value = Flags.IGNORE)",
        "@JsonIgnoreProperties(value = Names.NAMES)",
        "@JsonIgnoreProperties(value = {\"value\"}, allowSetters = Flags.ALLOW)",
    ] {
        let p = if annotation.contains("IgnoreProperties") {
            fixture(
                "Dto",
                &format!("{annotation} class Dto {{ public String value; }}"),
            )
        } else {
            fixture(
                "Dto",
                &format!("class Dto {{ {annotation} public String value; }}"),
            )
        };
        assert_unsupported(body(&p, ContractDirection::Request), annotation);
        assert_unsupported(body(&p, ContractDirection::Response), annotation);
    }
}

#[test]
fn escaped_pattern_keeps_regexp_value_and_original_annotation() {
    let p = fixture(
        "Dto",
        r#"class Dto { @Pattern(regexp = "\\d{2,4}") public String value; }"#,
    );
    let constraint = &props(&p, ContractDirection::Request)[0].validation_constraints[0];
    assert_eq!(constraint.value, Some(serde_json::json!(r"\d{2,4}")));
    assert_eq!(
        constraint
            .provenance
            .as_ref()
            .unwrap()
            .annotation_or_schema
            .as_deref(),
        Some(r#"@Pattern(regexp = "\\d{2,4}")"#)
    );
}

#[test]
fn inherited_constraints_keep_the_parent_file_and_annotation_line() {
    let p = payload(vec![
        ("Base.java", "package demo;\nclass Base {\n    @NotNull @Size(min = 2) public String value;\n}".to_string()),
        ("Fixture.java", "package demo; class Dto extends Base {} @RestController class Controller { @PostMapping(\"/value\") public Dto value(@RequestBody Dto value) { return value; } }".to_string()),
    ]);
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        let field = &props(&p, direction)[0];
        assert_eq!(
            field.provenance.as_ref().unwrap().file,
            "src/demo/Base.java"
        );
        for constraint in &field.validation_constraints {
            let provenance = constraint.provenance.as_ref().unwrap();
            assert_eq!(provenance.file, "src/demo/Base.java");
            assert_eq!(provenance.line, 3);
        }
    }
}

#[test]
fn annotated_non_bean_getters_and_setters_merge_wire_names() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonGetter("wire") private String read() { return "x"; }
        @JsonSetter("wire") private void accept(String value) {}
        public String getVarargs(String... values) { return "x"; }
        public void setVarargs(String... values) {}
    }"#,
    );
    assert_eq!(names(&p, ContractDirection::Response), expected(&["wire"]));
    assert_eq!(names(&p, ContractDirection::Request), expected(&["wire"]));
}

#[test]
fn getter_and_setter_member_types_are_resolved_in_their_own_direction() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        private String value;
        public String getValue() { return value; }
        public void setValue(Long value) { this.value = value.toString(); }
    }"#,
    );
    let WireType::Primitive(input) = &props(&p, ContractDirection::Request)[0].r#type else {
        panic!("input scalar");
    };
    let WireType::Primitive(output) = &props(&p, ContractDirection::Response)[0].r#type else {
        panic!("output scalar");
    };
    assert_eq!(input.scalar, contract_core::ir::PrimitiveScalar::Number);
    assert_eq!(output.scalar, contract_core::ir::PrimitiveScalar::String);
}

#[test]
fn ignore_and_explicit_member_pairings_project_measured_directions() {
    // Every pairing here was run through a real ObjectMapper (scratch-app JacksonAccessOracleTest):
    // each is a directional split, so abstaining the whole DTO would have thrown away a shape the
    // server really does emit.
    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonIgnore public String value;
        @JsonProperty public String getValue() { return value; }
    }"#,
    );
    assert_eq!(names(&p, ContractDirection::Response), expected(&["value"]));
    assert!(names(&p, ContractDirection::Request).is_empty());

    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonIgnore public String value;
        @JsonSetter public void setValue(String value) {}
    }"#,
    );
    assert!(names(&p, ContractDirection::Response).is_empty());
    assert_eq!(names(&p, ContractDirection::Request), expected(&["value"]));

    let p = fixture(
        "Dto",
        r#"class Dto {
        @JsonProperty public String value;
        @JsonIgnore public String getValue() { return value; }
    }"#,
    );
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        assert_eq!(names(&p, direction.clone()), expected(&["value"]));
    }
}

#[test]
fn ordinary_response_without_access_annotations_keeps_existing_visibility() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        public String publicField;
        private String hidden;
        public String getComputed() { return "x"; }
        public void setInput(String v) {}
        public static String constant;
        public transient String transientField;
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["publicField", "computed"])
    );
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["publicField", "input"])
    );
    let WireType::Ref(r) = endpoint(&p, ContractDirection::Response)
        .body
        .as_ref()
        .unwrap()
    else {
        panic!("response ref");
    };
    assert_eq!(r.r#ref, "java:demo.Dto");
}

#[test]
fn qualified_and_static_imported_constants_fold_across_classes() {
    let p = payload(vec![
        ("Constants.java", "package demo;\npublic class Constants {\n    public static final String STATE_PATTERN = \"^(active|disabled)$\";\n}".to_string()),
        ("Fixture.java", r#"package demo;
import static demo.Constants.STATE_PATTERN;
class Dto {
    @jakarta.validation.constraints.Pattern(regexp = Constants.STATE_PATTERN) public String qualified;
    @jakarta.validation.constraints.Pattern(regexp = STATE_PATTERN) public String imported;
}
@org.springframework.web.bind.annotation.RestController
class Controller {
    @org.springframework.web.bind.annotation.PostMapping("/value")
    public Dto value(@org.springframework.web.bind.annotation.RequestBody Dto body) { return body; }
}
"#.to_string()),
    ]);
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["qualified", "imported"])
    );
    let request = contract_core::request_synthesis::synthesize_request(
        endpoint(&p, ContractDirection::Response),
        &p.endpoints,
        p.type_pool.as_ref(),
        None,
    )
    .expect("patterns resolved from cross-class constants");
    let body = request.body.expect("body");
    assert_eq!(body["qualified"], "active");
    assert_eq!(body["imported"], "active");
}

#[test]
fn unresolvable_constant_owner_still_fails_closed() {
    let p = payload(vec![("Fixture.java", r#"package demo;
class Dto { @jakarta.validation.constraints.Pattern(regexp = Missing.STATE_PATTERN) public String value; }
@org.springframework.web.bind.annotation.RestController
class Controller {
    @org.springframework.web.bind.annotation.PostMapping("/value")
    public Dto value(@org.springframework.web.bind.annotation.RequestBody Dto body) { return body; }
}
"#.to_string())]);
    assert_unsupported(body(&p, ContractDirection::Request), "Pattern");
    assert_eq!(names(&p, ContractDirection::Response), expected(&["value"]));
}

#[test]
fn generated_value_identifiers_are_flagged_but_client_supplied_ids_are_not() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        @jakarta.persistence.Id @jakarta.persistence.GeneratedValue public Long id;
        public String label;
        @jakarta.persistence.Id public String code;
    }"#,
    );
    assert_eq!(
        names(&p, ContractDirection::Response),
        expected(&["id", "label", "code"])
    );
    let request = props(&p, ContractDirection::Request);
    let id = request
        .iter()
        .find(|property| property.wire_name == "id")
        .expect("updates need the body id");
    assert!(
        id.server_assigned,
        "a provider-assigned id is flagged so creates can omit it"
    );
    let code = request
        .iter()
        .find(|property| property.wire_name == "code")
        .expect("a client-supplied @Id is still input");
    assert!(!code.server_assigned);
}

#[test]
fn numeric_annotation_bounds_fold_configured_constants() {
    let p = payload(vec![
        ("Constants.java", "package demo;\npublic class Constants {\n    public static final int MIN = 4;\n    public static final long MAX = 100L;\n}".to_string()),
        ("Fixture.java", r#"package demo;
class Dto { @jakarta.validation.constraints.Size(min = Constants.MIN, max = Constants.MAX) public String value; }
@org.springframework.web.bind.annotation.RestController
class Controller { @org.springframework.web.bind.annotation.PostMapping("/value") public Dto value(@org.springframework.web.bind.annotation.RequestBody Dto body) { return body; } }
"#.to_string()),
    ]);
    let field = &props(&p, ContractDirection::Request)[0];
    assert_eq!(
        field.validation_constraints[0].value,
        Some(serde_json::json!({"min": 4, "max": 100}))
    );
}

#[test]
fn integer_constant_aliases_and_cycles_abstain_without_recursion() {
    for declarations in [
        "static final int MIN = 1; static final int MAX = MIN;",
        "static final int MIN = MAX; static final int MAX = MIN;",
        "static final int MAX = MAX;",
    ] {
        let p = fixture(
            "Dto",
            &format!("class Dto {{ {declarations} @Size(max = MAX) public String value; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), "@Size(max = MAX)");
    }
    let p = fixture("Dto", "class Dto { static final int MIN = 1; static final int MAX = MIN; @Size(min = MIN) public String value; }");
    assert_eq!(
        props(&p, ContractDirection::Request)[0].validation_constraints[0].value,
        Some(serde_json::json!({"min": 1, "max": 2147483647_i64}))
    );
}

fn constant_scope_fixture(
    imports: &str,
    declarations: &str,
    expression: &str,
) -> BackendContractPayload {
    let mut sources = vec![(
        "Fixture.java",
        format!(
            r#"package demo;
{imports}
class Dto {{ {declarations}
    @JsonProperty({expression}) @Size(min = MIN) public String value;
}}
@RestController class Controller {{
    @PostMapping("/value") public Dto value(@RequestBody Dto value) {{ return value; }}
}}
"#
        ),
    )];
    for (file, package, wire, min) in [
        ("Local.java", "demo", "local", 2),
        ("First.java", "first", "first", 3),
        ("Second.java", "second", "second", 4),
    ] {
        sources.push((file, format!("package {package}; public class Names {{ public static final String WIRE = \"{wire}\"; public static final String OTHER = \"other\"; public static final int MIN = {min}; public static final int OTHER_MIN = 9; }}")));
    }
    payload(sources)
}

fn assert_constant_scope(p: &BackendContractPayload, wire: &str, min: i64) {
    for direction in [ContractDirection::Request, ContractDirection::Response] {
        assert_eq!(names(p, direction.clone()), expected(&[wire]));
        assert_eq!(
            props(p, direction)[0].validation_constraints[0].value,
            Some(serde_json::json!({"min": min, "max": 2147483647_i64}))
        );
    }
}

#[test]
fn constant_scope_explicit_static_imports_preserve_member_identity() {
    let p = constant_scope_fixture(
        "import static first.Names.OTHER; import static first.Names.OTHER_MIN; import static second.Names.WIRE; import static second.Names.MIN;",
        "", "WIRE");
    assert_constant_scope(&p, "second", 4);
}

#[test]
fn constant_scope_lexical_members_shadow_static_imports() {
    let p = constant_scope_fixture(
        "import static first.Names.*;",
        "static final String WIRE = \"lexical\"; static final int MIN = 7;",
        "WIRE",
    );
    assert_constant_scope(&p, "lexical", 7);
    for declaration in [
        "static final String WIRE = missing();",
        "static final int MIN = missing();",
    ] {
        let p = constant_scope_fixture("import static first.Names.*;", declaration, "WIRE");
        assert_unsupported(
            body(&p, ContractDirection::Request),
            if declaration.contains("String") {
                "JsonProperty"
            } else {
                "Size"
            },
        );
    }
}

#[test]
fn constant_scope_same_package_precedes_on_demand_type_imports() {
    let p = constant_scope_fixture(
        "import first.*; import static first.Names.MIN;",
        "",
        "Names.WIRE",
    );
    assert_constant_scope(&p, "local", 3);
    let p = constant_scope_fixture(
        "import second.Names; import first.*; import static first.Names.MIN;",
        "",
        "Names.WIRE",
    );
    assert_constant_scope(&p, "second", 3);
}

#[test]
fn constant_scope_qualified_wildcard_and_fully_qualified_owners() {
    let imports = "import first.*; import static second.Names.MIN;";
    let p = constant_scope_fixture(imports, "", "first.Names.WIRE");
    assert_constant_scope(&p, "first", 4);
    let p = payload(vec![
        ("Names.java", "package first; public class Names { public static final String WIRE = \"wildcard\"; }".to_string()),
        ("Fixture.java", "package demo; import first.*; class Dto { @JsonProperty(Names.WIRE) public String value; } @RestController class Controller { @PostMapping(\"/value\") public Dto value(@RequestBody Dto value) { return value; } }".to_string()),
    ]);
    assert_eq!(
        names(&p, ContractDirection::Request),
        expected(&["wildcard"])
    );
}

#[test]
fn constant_scope_static_conflicts_and_unresolved_explicit_members_abstain() {
    for imports in [
        "import static first.Names.WIRE; import static second.Names.WIRE; import static first.Names.MIN;",
        "import static first.Names.*; import static second.Names.*;",
        "import static missing.Names.WIRE; import static first.Names.*;",
        "import static missing.Names.*; import static first.Names.*;",
    ] {
        let p = constant_scope_fixture(imports, "", "WIRE");
        assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
    }
    let p = constant_scope_fixture(
        "import static first.Names.MIN; import static second.Names.MIN;",
        "",
        "\"literal\"",
    );
    assert_unsupported(body(&p, ContractDirection::Request), "Size");
    let p = constant_scope_fixture(
        "import static missing.Names.MIN; import static first.Names.*;",
        "",
        "\"literal\"",
    );
    assert_unsupported(body(&p, ContractDirection::Request), "Size");
}

#[test]
fn constant_scope_type_import_conflicts_and_unresolved_owners_abstain() {
    for imports in [
        "import first.Names; import second.Names;",
        "import missing.Names; import first.*;",
    ] {
        let p = constant_scope_fixture(imports, "static final int MIN = 1;", "Names.WIRE");
        assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
    }
    let p = payload(vec![
        ("First.java", "package first; public class Names { public static final String WIRE = \"first\"; }".to_string()),
        ("Second.java", "package second; public class Names { public static final String WIRE = \"second\"; }".to_string()),
        ("Fixture.java", "package demo; import first.*; import second.*; class Dto { @JsonProperty(Names.WIRE) public String value; } @RestController class Controller { @PostMapping(\"/value\") public Dto value(@RequestBody Dto value) { return value; } }".to_string()),
    ]);
    assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
}

#[test]
fn constant_scope_explicit_imports_precede_wildcards_and_order_is_irrelevant() {
    for imports in [
        "import static first.Names.*; import static second.Names.WIRE; import static second.Names.MIN;",
        "import static second.Names.MIN; import static second.Names.WIRE; import static first.Names.*;",
        "import static second.Names.*; import static second.Names.*;",
    ] {
        assert_constant_scope(&constant_scope_fixture(imports, "", "WIRE"), "second", 4);
    }
}

#[test]
fn constant_scope_outer_and_nested_types_keep_lexical_precedence() {
    let p = fixture(
        "Outer.Dto",
        r#"import static missing.Names.*;
        class Outer {
            static final String WIRE = "outer";
            static final int MIN = 5;
            static class Dto { @JsonProperty(WIRE) @Size(min = MIN) public String value; }
        }"#,
    );
    assert_constant_scope(&p, "outer", 5);
    let p = fixture(
        "Dto",
        r#"import first.Names;
        class Dto {
            static class Names { static final String WIRE = "nested"; }
            @JsonProperty(Names.WIRE) public String value;
        }"#,
    );
    assert_eq!(names(&p, ContractDirection::Request), expected(&["nested"]));
}

#[test]
fn constant_scope_nested_sibling_members_are_not_lexical_evidence() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        static class Other { static final String WIRE = "sibling"; }
        @JsonProperty(WIRE) public String value;
    }"#,
    );
    assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
}

#[test]
fn temporal_spring_formatter_metadata_requires_explicit_parameter_fixtures() {
    let p = payload(vec![("Fixture.java", r#"package demo;
@RestController class Controller {
    @GetMapping("/value/{date}") public String value(
        @PathVariable @org.springframework.format.annotation.DateTimeFormat(pattern = "dd-MM-yyyy") java.time.LocalDate date,
        @RequestParam @org.springframework.format.annotation.DateTimeFormat(pattern = "dd/MM/yyyy") java.time.LocalDate query) { return "ok"; }
}"#.to_string())]);
    let request = endpoint(&p, ContractDirection::Request);
    assert_unsupported(&request.path_parameters[0].r#type, "DateTimeFormat");
    assert_unsupported(&request.query_parameters[0].r#type, "DateTimeFormat");
}

#[test]
fn generated_metadata_requires_the_jpa_annotation_not_a_matching_simple_name() {
    for (imports, annotation) in [
        ("", "@demo.GeneratedValue"),
        ("import demo.GeneratedValue;", "@GeneratedValue"),
        ("", "@GeneratedValue"),
    ] {
        let p = fixture("Dto", &format!("{imports} class Dto {{ {annotation} @NotNull public Long id; }} @interface GeneratedValue {{}}"));
        assert!(!props(&p, ContractDirection::Request)[0].server_assigned);
        let request = contract_core::request_synthesis::synthesize_request(
            endpoint(&p, ContractDirection::Response),
            &p.endpoints,
            p.type_pool.as_ref(),
            None,
        )
        .unwrap();
        assert_eq!(request.body.unwrap()["id"], 1);
    }
}

#[test]
fn generated_metadata_unresolved_or_conflicting_imports_abstain() {
    for imports in [
        "",
        "import jakarta.persistence.GeneratedValue; import demo.GeneratedValue;",
        "import jakarta.persistence.*; import other.*;",
    ] {
        let p = fixture(
            "Dto",
            &format!("{imports} class Dto {{ @GeneratedValue public Long id; }}"),
        );
        assert_unsupported(body(&p, ContractDirection::Request), "GeneratedValue");
    }
}

#[test]
fn generated_metadata_supports_qualified_and_explicit_jpa_imports() {
    for annotation in [
        "@jakarta.persistence.GeneratedValue",
        "@javax.persistence.GeneratedValue",
        "@GeneratedValue",
    ] {
        let p = fixture("Dto", &format!("import jakarta.persistence.GeneratedValue; class Dto {{ {annotation} public Long id; }}"));
        assert!(props(&p, ContractDirection::Request)[0].server_assigned);
    }
}

#[test]
fn generated_required_and_nullable_post_requests_do_not_guess_creation() {
    for validation in ["@NotNull", ""] {
        let p = fixture("Dto", &format!("class Dto {{ @jakarta.persistence.GeneratedValue {validation} public Long id; public String label; }}"));
        assert!(props(&p, ContractDirection::Request)[0].server_assigned);
        assert!(
            contract_core::request_synthesis::synthesize_request(
                endpoint(&p, ContractDirection::Response),
                &p.endpoints,
                p.type_pool.as_ref(),
                None,
            )
            .is_err(),
            "POST alone does not establish create semantics"
        );
    }
}

#[test]
fn generated_accessor_metadata_abstains_without_inventing_create_semantics() {
    let p = fixture(
        "Dto",
        r#"class Dto {
        private Long id;
        @jakarta.persistence.GeneratedValue public Long getId() { return id; }
        public void setId(Long id) { this.id = id; }
    }"#,
    );
    assert_unsupported(body(&p, ContractDirection::Request), "GeneratedValue");
    assert_eq!(names(&p, ContractDirection::Response), expected(&["id"]));
}

#[test]
fn temporal_custom_json_formats_require_explicit_request_fixtures() {
    for declarations in [
        r#"class Dto { @JsonFormat(pattern = "dd/MM/yyyy") public java.time.LocalDate value; }"#,
        r#"record Dto(@JsonFormat(shape = JsonFormat.Shape.NUMBER) java.time.Instant value) {}"#,
        r#"class Dto { private java.time.LocalDate value; @JsonFormat(pattern = "dd/MM/yyyy") public java.time.LocalDate getValue() { return value; } }"#,
    ] {
        let p = fixture("Dto", declarations);
        assert_unsupported(body(&p, ContractDirection::Request), "JsonFormat");
    }
}

#[test]
fn constant_scope_unmodeled_inheritance_cannot_fall_through_to_imports() {
    for (members, expression, annotation) in [
        (
            "static final String WIRE = \"base\";",
            "WIRE",
            "JsonProperty",
        ),
        ("static final int MIN = 8;", "\"literal\"", "Size"),
    ] {
        let source = format!(
            r#"package demo; import static first.Names.*;
class Base {{ {members} }}
class Dto extends Base {{ @JsonProperty({expression}) @Size(min = MIN) public String value; }}
@RestController class Controller {{ @PostMapping("/value") public Dto value(@RequestBody Dto value) {{ return value; }} }}"#
        );
        let p = payload(vec![
            ("Names.java", "package first; public class Names { public static final String WIRE = \"imported\"; public static final int MIN = 2; }".to_string()),
            ("Fixture.java", source),
        ]);
        assert_unsupported(body(&p, ContractDirection::Request), annotation);
    }
    let p = payload(vec![
        ("Base.java", "package first; class Base { public static final String WIRE = \"inherited\"; } public class Names extends Base {}".to_string()),
        ("Other.java", "package second; public class Names { public static final String WIRE = \"direct\"; }".to_string()),
        ("Fixture.java", "package demo; import static first.Names.*; import static second.Names.*; class Dto { @JsonProperty(WIRE) public String value; } @RestController class Controller { @PostMapping(\"/value\") public Dto value(@RequestBody Dto value) { return value; } }".to_string()),
    ]);
    assert_unsupported(body(&p, ContractDirection::Request), "JsonProperty");
}
