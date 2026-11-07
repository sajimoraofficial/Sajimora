//! JDK library types whose Jackson wire shape is fixed by the platform rather than by anything a
//! repository declares: a plain enum writes `name()`, and `ZoneIdSerializer` writes `getId()`.
//! This table is worth ~2,000 unresolved leaf positions in the ThingsBoard corpus on its own, so
//! the tests below pin both halves of the bargain - the shapes that are publishable and the gate
//! that keeps the table from ever shadowing a project type or firing on a name the source did not
//! prove. `Duration` is deliberately excluded: `WRITE_DURATIONS_AS_TIMESTAMPS` decides its shape,
//! and a repository can flip that feature without saying so in the analyzed source.

use contract_core::envelope::BackendContractPayload;
use contract_core::ir::{PrimitiveScalar, WireType};
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};

const CONSTROLLER: &str = r#"
package com.demo;

import java.time.DayOfWeek;
import java.util.concurrent.TimeUnit;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/jdk")
public class JdkController {
    @GetMapping("/unit")
    public TimeUnit unit() { return null; }

    @GetMapping("/zone")
    public java.time.ZoneId zone() { return null; }

    @GetMapping("/days")
    public java.util.List<DayOfWeek> days() { return null; }

    // Same simple name, different package, no import that would bring the JDK type into scope.
    @GetMapping("/bare")
    public Monthish bare() { return null; }

    @GetMapping("/hobbit")
    public java.time.Duration hobbit() { return null; }
}
"#;

/// The file proves `TimeUnit` and `DayOfWeek` through single-type imports and `ZoneId` and `List`
/// through fully-qualified names. `Monthish` is a project type, so it must resolve to the project.
const PROJECT_SHADOW: &str = r#"
package com.demo;

public class Monthish {
    public String label;
}
"#;

const UNIT_DTO: &str = r#"
package com.demo;

import java.util.concurrent.TimeUnit;

public class Rate {
    public long value;
    public TimeUnit unit;
}
"#;

const UNIT_DTO_CONTROLLER: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/rate")
public class RateController {
    @GetMapping
    public Rate rate() { return null; }
}
"#;

/// A repository that declares its own type named `TimeUnit` wins over the JDK table, exactly as it
/// wins in javac: the project declaration is resolved first, and the table is only consulted after
/// every project resolution has failed.
const LOCAL_TIME_UNIT: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

public enum TimeUnit {
    TICK, TOCK
}

@RestController
@RequestMapping("/api/local")
public class LocalController {
    @GetMapping("/unit")
    public TimeUnit unit() { return null; }
}
"#;

/// Without import evidence the name is not proven, even though it is a JDK type name. Real javac
/// would not compile this file - the point is that the table never fires on a bare guess.
const NO_IMPORT: &str = r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/unproven")
public class UnprovenController {
    @GetMapping("/unit")
    public TimeUnit unit() { return null; }
}
"#;

const ON_DEMAND: &str = r#"
package com.demo;

import java.util.concurrent.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/star")
public class StarController {
    @GetMapping("/unit")
    public TimeUnit unit() { return null; }
}
"#;

/// A static on-demand import brings the constants into scope, not the type name, so it must not be
/// read as proof that a `TimeUnit`-typed position means the JDK enum.
const STATIC_ON_DEMAND: &str = r#"
package com.demo;

import static java.util.concurrent.TimeUnit.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/static-star")
public class StaticStarController {
    @GetMapping("/unit")
    public TimeUnit unit() { return null; }
}
"#;

fn payload(tag: &str, sources: &[(&str, &str)]) -> BackendContractPayload {
    let root = std::path::PathBuf::from("jdk-type-fixture");
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

fn enum_names(wt: &WireType) -> Vec<String> {
    let WireType::Enum(e) = wt else {
        panic!("expected an ENUM wire, got {wt:?}");
    };
    e.values
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect()
}

#[test]
fn test_jdk_enum_publishes_its_constant_names() {
    let sources = vec![
        ("JdkController.java", CONSTROLLER),
        ("Monthish.java", PROJECT_SHADOW),
    ];
    let payload = payload("jdk", &sources);

    let unit = enum_names(&response_body(&payload, "/api/jdk/unit"));
    assert_eq!(
        unit,
        vec![
            "NANOSECONDS",
            "MICROSECONDS",
            "MILLISECONDS",
            "SECONDS",
            "MINUTES",
            "HOURS",
            "DAYS"
        ],
        "java.util.concurrent.TimeUnit has exactly these seven constants"
    );

    // A generic container resolves its element through the same gate.
    let days = response_body(&payload, "/api/jdk/days");
    let WireType::Array(array) = &days else {
        panic!("List<DayOfWeek> is a JSON array, got {days:?}");
    };
    assert_eq!(
        enum_names(&array.element_type),
        vec![
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
            "SUNDAY"
        ]
    );
}

#[test]
fn test_zoneid_is_a_string_and_duration_is_not_claimed() {
    let sources = vec![
        ("JdkController.java", CONSTROLLER),
        ("Monthish.java", PROJECT_SHADOW),
    ];
    let payload = payload("jdk", &sources);

    // Jackson's ZoneIdSerializer writes getId() with no feature flag behind it.
    let WireType::Primitive(p) = response_body(&payload, "/api/jdk/zone") else {
        panic!("a fully-qualified java.time.ZoneId must be a string");
    };
    assert_eq!(p.scalar, PrimitiveScalar::String);

    // Duration's shape depends on WRITE_DURATIONS_AS_TIMESTAMPS, so it must stay inconclusive.
    let WireType::Unknown(u) = response_body(&payload, "/api/jdk/hobbit") else {
        panic!("java.time.Duration must not be guessed");
    };
    assert!(u.reason.contains("Duration"), "reason: {}", u.reason);

    // The project type keeps its own identity; the JDK table never reached for it.
    let WireType::Object(obj) = deref(&payload, &response_body(&payload, "/api/jdk/bare")) else {
        panic!("Monthish is a project class");
    };
    assert_eq!(obj.properties[0].wire_name, "label");
}

#[test]
fn test_dto_field_resolves_through_the_imported_type() {
    let sources = vec![
        ("Rate.java", UNIT_DTO),
        ("RateController.java", UNIT_DTO_CONTROLLER),
    ];
    let payload = payload("rate", &sources);
    let WireType::Object(rate) = deref(&payload, &response_body(&payload, "/api/rate")) else {
        panic!("Rate is an object");
    };
    let unit = rate
        .properties
        .iter()
        .find(|p| p.wire_name == "unit")
        .expect("the declared field keeps its name");
    assert_eq!(
        enum_names(&unit.r#type),
        vec![
            "NANOSECONDS",
            "MICROSECONDS",
            "MILLISECONDS",
            "SECONDS",
            "MINUTES",
            "HOURS",
            "DAYS"
        ],
        "a field whose file imports java.util.concurrent.TimeUnit is that enum"
    );
}

#[test]
fn test_inherited_field_binds_in_the_declaring_file() {
    // The ThingsBoard shape this reproduces: an interval base class imports java.time.ZoneId and
    // declares the field, while the concrete interval that reaches the wire does not mention
    // ZoneId at all. javac binds the inherited declaration in the base's file, so the JDK table
    // must be consulted with that file's imports, not the subclass's.
    let sources = vec![
        (
            "BaseInterval.java",
            r#"
package com.demo;

import java.time.ZoneId;

public class BaseInterval {
    public ZoneId zoneId;
}
"#,
        ),
        (
            "DayInterval.java",
            r#"
package com.demo;

public class DayInterval extends BaseInterval {
    public int dayOfMonth;
}
"#,
        ),
        (
            "IntervalController.java",
            r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/interval")
public class IntervalController {
    @GetMapping
    public DayInterval interval() { return null; }
}
"#,
        ),
    ];
    let payload = payload("interval", &sources);
    let WireType::Object(interval) = deref(&payload, &response_body(&payload, "/api/interval"))
    else {
        panic!("DayInterval is an object");
    };
    let zone = interval
        .properties
        .iter()
        .find(|p| p.wire_name == "zoneId")
        .unwrap_or_else(|| {
            panic!(
                "the inherited field keeps its name: {:?}",
                interval.properties
            )
        });
    assert!(
        matches!(&zone.r#type, WireType::Primitive(p) if p.scalar == PrimitiveScalar::String),
        "an inherited ZoneId field is resolved through the base class's import, got {:?}",
        zone.r#type
    );
}

#[test]
fn test_project_declaration_beats_the_jdk_table() {
    let sources = vec![("LocalController.java", LOCAL_TIME_UNIT)];
    let payload = payload("local", &sources);
    // A project enum is interned in the type pool and reached by reference; the JDK table publishes
    // its shape inline. Both must resolve, and the project one must win the simple name.
    let body = response_body(&payload, "/api/local/unit");
    assert!(
        matches!(body, WireType::Ref(_)),
        "a project enum is a pool reference, got {body:?}"
    );
    let unit = enum_names(&deref(&payload, &body));
    assert_eq!(
        unit,
        vec!["TICK", "TOCK"],
        "the repository's own enum named TimeUnit must be the one published"
    );
}

#[test]
fn test_the_gate_needs_import_or_a_fully_qualified_name() {
    // No import of java.util.concurrent.TimeUnit anywhere in the file: nothing proves the name.
    let unproven = vec![("UnprovenController.java", NO_IMPORT)];
    let unproven_payload = payload("unproven", &unproven);
    let WireType::Unknown(u) = response_body(&unproven_payload, "/api/unproven/unit") else {
        panic!("an unproven simple name must stay Unknown");
    };
    assert!(u.reason.contains("TimeUnit"), "reason: {}", u.reason);

    // `import java.util.concurrent.*` does put every type of the package in scope.
    let starred = vec![("StarController.java", ON_DEMAND)];
    let starred_payload = payload("star", &starred);
    assert_eq!(
        enum_names(&response_body(&starred_payload, "/api/star/unit")).len(),
        7
    );

    // `import static java.util.concurrent.TimeUnit.*` puts the constants in scope, not the type.
    let static_star = vec![("StaticStarController.java", STATIC_ON_DEMAND)];
    let static_payload = payload("static-star", &static_star);
    let WireType::Unknown(u) = response_body(&static_payload, "/api/static-star/unit") else {
        panic!("a static on-demand import must not prove a type name");
    };
    assert!(u.reason.contains("TimeUnit"), "reason: {}", u.reason);
}
