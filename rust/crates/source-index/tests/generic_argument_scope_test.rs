//! A generic class binds its type parameters from the text of whoever *uses* it, but the
//! extractor then read that text in the scope of the generic declaration. javac substitutes the
//! type, not the letters, so `Holder<Schedule>` written in a file that imports
//! `…condition.schedule.AlarmSchedule` means that declaration even though `Holder.java` sees a
//! different `Schedule` - or none at all. ThingsBoard loses 756 wire positions to exactly this
//! (`AlarmConditionValue<AlarmSchedule>`), so the rule has to be the scope rule, not a name table.
//!
//! These fixtures keep the same-named decoy in the generic class's own package, which is the
//! version of the bug that silently resolves to the wrong declaration instead of abstaining.

use contract_core::envelope::BackendContractPayload;
use contract_core::ir::{ContractDirection, WireType};
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};

fn payload(tag: &str, sources: &[(&str, &str)]) -> BackendContractPayload {
    let blobs = sources
        .iter()
        .map(|(path, body)| (path.to_string(), body.to_string()))
        .collect();
    JavaRouteExtractor::from_blobs(
        std::path::PathBuf::from("generic-scope-fixture"),
        blobs,
        ConfigInputs::default(),
    )
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
                && e.identity.direction == ContractDirection::Response
        })
        .unwrap_or_else(|| panic!("RESPONSE endpoint for {path} must exist"))
        .body
        .clone()
        .unwrap_or_else(|| panic!("RESPONSE endpoint for {path} must publish a body type"))
}

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

/// Reads the property named `wire_name` off an object shape, following one reference first.
fn property<'a>(
    payload: &'a BackendContractPayload,
    wt: &'a WireType,
    wire_name: &str,
) -> WireType {
    let obj = match deref(payload, wt) {
        WireType::Object(obj) => obj,
        other => panic!("expected an object shape, got {other:?}"),
    };
    let prop = obj
        .properties
        .iter()
        .find(|p| p.wire_name == wire_name)
        .unwrap_or_else(|| panic!("`{wire_name}` must be published: {:?}", obj.properties));
    prop.r#type.clone()
}

const HOLDER: &str = r#"
package com.demo;

public class Holder<T> {
    public T value;
    public java.util.List<T> values;
}
"#;

/// The decoy: visible to `Holder.java` without an import, and a hollow interface, so reading the
/// bound name in the wrong file resolves it to something that publishes no properties.
const LOCAL_WIDGET: &str = r#"
package com.demo;

public interface Widget {
}
"#;

/// The declaration the use site actually means: polymorphic, enumerable, and distinguishable from
/// the decoy by its discriminator token.
const OTHER_WIDGET: &str = r#"
package com.demo.other;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "kind")
@JsonSubTypes({
        @JsonSubTypes.Type(value = Round.class, name = "ROUND"),
        @JsonSubTypes.Type(value = Square.class, name = "SQUARE")})
public interface Widget {
}

class Round {
    public String radius;
}

class Square {
    public String side;
}
"#;

const CONTROLLER: &str = r#"
package com.demo.use;

import com.demo.Holder;
import com.demo.other.Widget;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/g")
public class GController {
    @GetMapping("/direct")
    public Holder<Widget> direct() { return null; }

    @GetMapping("/nested")
    public Holder<java.util.List<Widget>> nested() { return null; }
}
"#;

fn sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("src/main/java/com/demo/Holder.java", HOLDER),
        ("src/main/java/com/demo/Widget.java", LOCAL_WIDGET),
        ("src/main/java/com/demo/other/Widget.java", OTHER_WIDGET),
        ("src/main/java/com/demo/use/GController.java", CONTROLLER),
    ]
}

fn assert_widget_union(payload: &BackendContractPayload, wt: &WireType, site: &str) {
    let union = deref(payload, wt);
    let WireType::Union(union) = &union else {
        panic!("{site}: the bound argument must be the imported polymorphic Widget, got {union:?}");
    };
    assert_eq!(union.types.len(), 2, "{site}: one arm per declared subtype");
    let arms: Vec<Vec<String>> = union
        .types
        .iter()
        .map(|arm| match deref(payload, arm) {
            WireType::Object(obj) => obj.properties.iter().map(|p| p.wire_name.clone()).collect(),
            other => panic!("{site}: expected an object arm, got {other:?}"),
        })
        .collect();
    assert_eq!(
        arms,
        vec![
            vec!["kind".to_string(), "radius".to_string()],
            vec!["kind".to_string(), "side".to_string()],
        ],
        "{site}: the arms of the imported declaration, not the decoy"
    );
}

#[test]
fn test_type_argument_is_bound_in_the_scope_that_wrote_it() {
    let src = sources();
    let payload = payload("g", &src);
    let body = response_body(&payload, "/api/g/direct");
    let value = property(&payload, &body, "value");
    assert_widget_union(&payload, &value, "field type argument");
    // A composed argument travels the same rule: `List<T>` binds to the use site's Widget too.
    let values = property(&payload, &body, "values");
    let WireType::Array(array) = &values else {
        panic!("List<T> is an array on the wire, got {values:?}");
    };
    assert_widget_union(&payload, &array.element_type, "composed type argument");
}

#[test]
fn test_a_bound_argument_survives_another_generic_hop() {
    // `Grid<W>` uses `Holder<W>`; W is bound at the controller, so the fully qualified name has to
    // be carried through both substitutions instead of degrading to a simple lookup.
    let mut src = sources();
    src.push((
        "src/main/java/com/demo/Grid.java",
        r#"
package com.demo;

public class Grid<W> {
    public Holder<W> items;
}
"#,
    ));
    src.push((
        "src/main/java/com/demo/use/HController.java",
        r#"
package com.demo.use;

import com.demo.Grid;
import com.demo.other.Widget;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/h")
public class HController {
    @GetMapping("/grid")
    public Grid<Widget> grid() { return null; }
}
"#,
    ));
    let payload = payload("g2", &src);
    let body = response_body(&payload, "/api/h/grid");
    let items = property(&payload, &body, "items");
    let inner = property(&payload, &items, "value");
    assert_widget_union(&payload, &inner, "argument carried through two generics");
}

#[test]
fn test_a_bound_jdk_argument_needs_the_use_site_import() {
    // The same scope rule on the other side: the argument is a JDK library type whose name the
    // generic class never imports, so the use site's import is the only evidence there is.
    let src = vec![
        (
            "src/main/java/com/demo/Holder.java",
            r#"
package com.demo;

public class Holder<T> {
    public T value;
}
"#,
        ),
        (
            "src/main/java/com/demo/use/TimeController.java",
            r#"
package com.demo.use;

import com.demo.Holder;
import java.util.concurrent.TimeUnit;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/t")
public class TimeController {
    @GetMapping("/unit")
    public Holder<TimeUnit> unit() { return null; }
}
"#,
        ),
    ];
    let payload = payload("g3", &src);
    let body = response_body(&payload, "/api/t/unit");
    let value = property(&payload, &body, "value");
    let WireType::Enum(enum_wire) = &value else {
        panic!("TimeUnit bound from the use site is an enum, got {value:?}");
    };
    let names: Vec<&str> = enum_wire
        .values
        .iter()
        .map(|v| v.as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        names,
        vec![
            "NANOSECONDS",
            "MICROSECONDS",
            "MILLISECONDS",
            "SECONDS",
            "MINUTES",
            "HOURS",
            "DAYS"
        ]
    );
}

#[test]
fn test_a_parameterized_argument_is_canonicalized_inside_out() {
    let src = sources();
    let payload = payload("g", &src);
    let body = response_body(&payload, "/api/g/nested");
    let value = property(&payload, &body, "value");
    let WireType::Array(array) = &value else {
        panic!("`Holder<List<Widget>>` binds T to a list, got {value:?}");
    };
    assert_widget_union(&payload, &array.element_type, "parameterized type argument");
}

#[test]
fn test_an_argument_the_use_site_sees_beats_the_generic_class_own_package() {
    // `com.demo.use2.Widget` is in the writing file's package, so javac binds that one and the
    // decoy in `com.demo` never enters the substitution. The extractor must agree.
    let mut src = sources();
    src.push((
        "src/main/java/com/demo/use2/AmbiguousController.java",
        r#"
package com.demo.use2;

import com.demo.Holder;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/a")
public class AmbiguousController {
    @GetMapping("/widget")
    public Holder<Widget> widget() { return null; }
}
"#,
    ));
    src.push((
        "src/main/java/com/demo/use2/Widget.java",
        r#"
package com.demo.use2;

public class Widget {
    public String ownName;
}
"#,
    ));
    let payload = payload("g4", &src);
    let body = response_body(&payload, "/api/a/widget");
    let value = property(&payload, &body, "value");
    let bound = deref(&payload, &value);
    let WireType::Object(obj) = &bound else {
        panic!("the argument the use site resolves must not be re-bound by the generic file, got {bound:?}");
    };
    let names: Vec<&str> = obj
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["ownName"],
        "the use site's package declaration wins, exactly as javac binds it"
    );
}
