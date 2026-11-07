use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};
use std::path::Path;

#[test]
fn test_spring_sample_route_extraction_parity() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../../..");
    let sample_dir = repo_root.join("rust/fixtures/spring-sample");

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &sample_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("sample-service");

    assert!(
        completeness.complete,
        "spring-sample extraction should be complete"
    );
    assert_eq!(completeness.unresolved_endpoints.len(), 0);
    assert_eq!(completeness.blockers.len(), 0);

    // Verify 5 endpoints extracted:
    // 1. GET /api/sample/{id} (RESPONSE)
    // 2. GET /api/sample/{id} (REQUEST)
    // 3. POST /api/sample (RESPONSE)
    // 4. POST /api/sample (REQUEST)
    // 5. GET /api/sample/generic (RESPONSE)
    assert_eq!(
        payload.endpoints.len(),
        5,
        "Expected 5 endpoints in spring-sample"
    );

    let routes: Vec<(String, String, String)> = payload
        .endpoints
        .iter()
        .map(|e| {
            let dir = match e.identity.direction {
                contract_core::ir::ContractDirection::Request => "REQUEST",
                contract_core::ir::ContractDirection::Response => "RESPONSE",
            };
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
                dir.to_string(),
            )
        })
        .collect();

    assert!(routes.contains(&(
        "GET".to_string(),
        "/api/sample/{id}".to_string(),
        "RESPONSE".to_string()
    )));
    assert!(routes.contains(&(
        "GET".to_string(),
        "/api/sample/{id}".to_string(),
        "REQUEST".to_string()
    )));
    assert!(routes.contains(&(
        "POST".to_string(),
        "/api/sample".to_string(),
        "RESPONSE".to_string()
    )));
    assert!(routes.contains(&(
        "POST".to_string(),
        "/api/sample".to_string(),
        "REQUEST".to_string()
    )));
    assert!(routes.contains(&(
        "GET".to_string(),
        "/api/sample/generic".to_string(),
        "RESPONSE".to_string()
    )));

    // Verify type pool contains SampleDto
    let type_pool = payload.type_pool.expect("type_pool must be present");
    assert!(type_pool.contains_key("java:com.example.sample.SampleDto"));

    // Verify SampleDto properties in type_pool
    if let contract_core::ir::WireType::Object(obj) =
        &type_pool["java:com.example.sample.SampleDto"]
    {
        let prop_names: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        assert!(prop_names.contains(&"id"));
        assert!(
            prop_names.contains(&"custom_name"),
            "custom_name from @JsonProperty must be preserved"
        );
        assert!(prop_names.contains(&"active"));
    } else {
        panic!("java:com.example.sample.SampleDto in type_pool must be WireType::Object");
    }
}

#[test]
fn test_enterprise_spring_features() {
    let root = std::env::temp_dir().join(format!("sajimora-enterprise-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    // 1. Enum
    std::fs::write(
        src_dir.join("OrderStatus.java"),
        r#"
package com.example.demo;

public enum OrderStatus {
    PENDING,
    PAID,
    CANCELLED
}
"#,
    )
    .unwrap();

    // 2. Base generic class with field T
    std::fs::write(
        src_dir.join("BaseAuditDTO.java"),
        r#"
package com.example.demo;

import java.time.LocalDateTime;
import lombok.Getter;

@Getter
public class BaseAuditDTO<T> {
    private Long id;
    private LocalDateTime createdAt;
    private T payload;
}
"#,
    )
    .unwrap();

    // 3. Child DTO extending BaseAuditDTO, with Lombok @Accessors and @Getter(AccessLevel.NONE)
    std::fs::write(
        src_dir.join("OrderDTO.java"),
        r#"
package com.example.demo;

import lombok.AccessLevel;
import lombok.Getter;
import lombok.experimental.Accessors;

@Getter
@Accessors(prefix = "m_")
public class OrderDTO extends BaseAuditDTO<String> {
    private String m_customerName;
    private OrderStatus status;

    @Getter(AccessLevel.NONE)
    private String internalSecret;
}
"#,
    )
    .unwrap();

    // 4. Java 17 Record
    std::fs::write(
        src_dir.join("ProductRecord.java"),
        r#"
package com.example.demo;

public record ProductRecord(Long productId, String title, boolean inStock) {}
"#,
    )
    .unwrap();

    // 5. Controller exposing Page<OrderDTO>, Record, wildcard ?, and Map
    std::fs::write(
        src_dir.join("EnterpriseController.java"),
        r#"
package com.example.demo;

import org.springframework.data.domain.Page;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/enterprise")
public class EnterpriseController {

    @GetMapping("/orders")
    public ResponseEntity<Page<OrderDTO>> getOrders() {
        return null;
    }

    @GetMapping("/product")
    public ProductRecord getProduct() {
        return null;
    }

    @PostMapping("/dynamic")
    public ResponseEntity<?> createDynamic(@RequestBody Map<String, Object> body) {
        return null;
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("enterprise-service");
    assert!(completeness.complete);

    let type_pool = payload.type_pool.expect("type_pool must be present");

    // A. Verify OrderStatus is interned as EnumWireType
    assert!(type_pool.contains_key("java:com.example.demo.OrderStatus"));
    if let contract_core::ir::WireType::Enum(en) = &type_pool["java:com.example.demo.OrderStatus"] {
        assert_eq!(en.name.as_deref(), Some("OrderStatus"));
        let vals: Vec<&str> = en.values.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(vals, vec!["PENDING", "PAID", "CANCELLED"]);
    } else {
        panic!("OrderStatus must be interned as WireType::Enum");
    }

    // B. Verify OrderDTO inherits BaseAuditDTO fields, strips m_ prefix, and excludes internalSecret
    assert!(type_pool.contains_key("java:com.example.demo.OrderDTO"));
    if let contract_core::ir::WireType::Object(obj) = &type_pool["java:com.example.demo.OrderDTO"] {
        let prop_names: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        // Inherited fields
        assert!(
            prop_names.contains(&"id"),
            "Must inherit id from BaseAuditDTO"
        );
        assert!(
            prop_names.contains(&"createdAt"),
            "Must inherit createdAt from BaseAuditDTO"
        );
        assert!(
            prop_names.contains(&"payload"),
            "Must inherit generic payload from BaseAuditDTO"
        );
        // Accessor prefix stripped: m_customerName -> customerName
        assert!(
            prop_names.contains(&"customerName"),
            "m_customerName prefix m_ must be stripped to customerName"
        );
        assert!(!prop_names.contains(&"m_customerName"));
        // Enum field status
        assert!(prop_names.contains(&"status"));
        // Suppressed getter excluded
        assert!(
            !prop_names.contains(&"internalSecret"),
            "internalSecret with @Getter(AccessLevel.NONE) must be excluded"
        );

        // Verify createdAt is resolved as PrimitiveScalar::String (ISO-8601 temporal)
        let created_at_prop = obj
            .properties
            .iter()
            .find(|p| p.wire_name == "createdAt")
            .unwrap();
        assert!(
            matches!(&created_at_prop.r#type, contract_core::ir::WireType::Primitive(p) if p.scalar == contract_core::ir::PrimitiveScalar::String)
        );

        // Verify payload field had T substituted with String
        let payload_prop = obj
            .properties
            .iter()
            .find(|p| p.wire_name == "payload")
            .unwrap();
        assert!(
            matches!(&payload_prop.r#type, contract_core::ir::WireType::Primitive(p) if p.scalar == contract_core::ir::PrimitiveScalar::String)
        );
    } else {
        panic!("OrderDTO must be interned as WireType::Object");
    }

    // C. Verify ProductRecord fields extracted from record parameters
    assert!(type_pool.contains_key("java:com.example.demo.ProductRecord"));
    if let contract_core::ir::WireType::Object(obj) =
        &type_pool["java:com.example.demo.ProductRecord"]
    {
        let prop_names: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        assert!(prop_names.contains(&"productId"));
        assert!(prop_names.contains(&"title"));
        assert!(prop_names.contains(&"inStock"));
    } else {
        panic!("ProductRecord must be interned as WireType::Object");
    }

    // D. Verify Page<OrderDTO> endpoint resolution
    let orders_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/enterprise/orders"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/enterprise/orders response endpoint must exist");

    if let Some(contract_core::ir::WireType::Object(page_obj)) = &orders_ep.body {
        assert_eq!(page_obj.name.as_deref(), Some("Page<OrderDTO>"));
        let page_prop_names: Vec<&str> = page_obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        assert!(page_prop_names.contains(&"content"));
        assert!(page_prop_names.contains(&"totalPages"));
        assert!(page_prop_names.contains(&"totalElements"));
        assert!(page_prop_names.contains(&"size"));
        assert!(page_prop_names.contains(&"number"));
        assert!(page_prop_names.contains(&"first"));
        assert!(page_prop_names.contains(&"last"));
        assert!(page_prop_names.contains(&"empty"));
        assert!(page_prop_names.contains(&"numberOfElements"));
    } else {
        panic!("Orders endpoint body must resolve to Spring Data Page ObjectWireType");
    }

    // E. Verify wildcard ? maps to PrimitiveScalar::Any
    let dynamic_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/enterprise/dynamic"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("POST /api/enterprise/dynamic response endpoint must exist");

    assert!(
        matches!(&dynamic_ep.body, Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::Any)
    );
}

#[test]
fn test_servlet_response_stream_sink_extraction() {
    let root = std::env::temp_dir().join(format!("sajimora-servlet-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("DashboardController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;
import javax.servlet.http.HttpServletResponse;
import java.io.OutputStream;

@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

    @GetMapping("/home")
    public void getHomeDashboard(HttpServletResponse response) {
        // Writes binary JSON directly to response stream
    }

    @GetMapping("/download")
    public void downloadReport(OutputStream outputStream) {
        // Writes bytes to stream
    }

    @PostMapping("/fire-and-forget")
    public void noSinkEndpoint() {
        // True void endpoint without response sink
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("dashboard-service");
    assert!(completeness.complete);

    // 1. /api/dashboard/home (HttpServletResponse) -> response_body must be Some(PrimitiveScalar::Any)
    let home_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/dashboard/home"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/dashboard/home response endpoint must exist");

    assert!(
        matches!(&home_ep.body, Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::Any),
        "Method writing to HttpServletResponse must be extracted with PrimitiveScalar::Any body"
    );

    // 2. /api/dashboard/download (OutputStream) -> response_body must be Some(PrimitiveScalar::Any)
    let download_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/dashboard/download"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/dashboard/download response endpoint must exist");

    assert!(
        matches!(&download_ep.body, Some(contract_core::ir::WireType::Primitive(p)) if p.scalar == contract_core::ir::PrimitiveScalar::Any),
        "Method writing to OutputStream must be extracted with PrimitiveScalar::Any body"
    );

    // 3. /api/dashboard/fire-and-forget -> response_body must be None
    let fnf_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/dashboard/fire-and-forget"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("POST /api/dashboard/fire-and-forget response endpoint must exist");

    assert!(
        fnf_ep.body.is_none(),
        "True void method without stream sink must have None body"
    );
}

#[test]
fn test_lombok_comprehensive_coverage() {
    let root = std::env::temp_dir().join(format!("sajimora-lombok-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("LombokDTO.java"),
        r#"
package com.example.demo;

import lombok.AccessLevel;
import lombok.Data;
import lombok.Getter;
import lombok.experimental.Accessors;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonIgnore;

@Data
@Accessors(prefix = {"m_", "_"})
public class LombokDTO {
    // 1. static fields must NEVER be serialized
    private static final long serialVersionUID = 1L;
    public static final String CONSTANT = "IGNORED";

    // 2. transient fields must NEVER be serialized
    private transient String cachedToken;

    // 3. Regular fields with prefix stripping
    private String m_userName;
    private Long _accountId;

    // 4. Suppressed getter without @JsonProperty -> EXCLUDED
    @Getter(AccessLevel.NONE)
    private String internalPassword;

    // 5. Suppressed getter WITH @JsonProperty -> INCLUDED
    @Getter(AccessLevel.NONE)
    @JsonProperty("explicit_secret")
    private String secretWithAnnotation;

    // 6. Explicit @JsonIgnore -> EXCLUDED
    @JsonIgnore
    private String ignoredField;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("LombokController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/lombok")
public class LombokController {

    @GetMapping("/dto")
    public LombokDTO getLombok() {
        return null;
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("lombok-service");
    assert!(completeness.complete);

    let type_pool = payload.type_pool.expect("type_pool must be present");
    let dto = type_pool
        .get("java:com.example.demo.LombokDTO")
        .expect("LombokDTO must be interned in type pool");

    if let contract_core::ir::WireType::Object(obj) = dto {
        let prop_names: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();

        // Included properties
        assert!(
            prop_names.contains(&"userName"),
            "m_userName should be stripped to userName"
        );
        assert!(
            prop_names.contains(&"accountId"),
            "_accountId should be stripped to accountId"
        );
        assert!(
            prop_names.contains(&"explicit_secret"),
            "@JsonProperty should override @Getter(AccessLevel.NONE)"
        );

        // Excluded properties
        assert!(
            !prop_names.contains(&"serialVersionUID"),
            "static serialVersionUID must be excluded"
        );
        assert!(
            !prop_names.contains(&"CONSTANT"),
            "static CONSTANT must be excluded"
        );
        assert!(
            !prop_names.contains(&"cachedToken"),
            "transient cachedToken must be excluded"
        );
        assert!(
            !prop_names.contains(&"internalPassword"),
            "@Getter(AccessLevel.NONE) must be excluded"
        );
        assert!(
            !prop_names.contains(&"ignoredField"),
            "@JsonIgnore must be excluded"
        );
    } else {
        panic!("LombokDTO must be interned as WireType::Object");
    }
}

#[test]
fn test_multi_tier_evidence_and_openapi_fallback() {
    let root = std::env::temp_dir().join(format!("sajimora-evidence-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("UserDto.java"),
        r#"
package com.example.demo;

public class UserDto {
    public Long id;
    public String name;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("ExportDto.java"),
        r#"
package com.example.demo;

public class ExportDto {
    public String csvContent;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("ConflictingDto.java"),
        r#"
package com.example.demo;

public class ConflictingDto {
    public String conflictingField;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("ApiController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.servlet.http.HttpServletResponse;

@RestController
@RequestMapping("/api/evidence")
public class ApiController {

    // 1. Concrete AST -> ImplementationDerived
    @GetMapping("/user")
    public UserDto getUser() {
        return null;
    }

    // 2. void + HttpServletResponse sink + @ApiResponse -> DeclaredSpecification with ExportDto
    @GetMapping("/export")
    @ApiResponse(responseCode = "200", description = "Export data", content = @Content(schema = @Schema(implementation = ExportDto.class)))
    public void exportData(HttpServletResponse response) {
    }

    // 3. ResponseEntity<?> + @ApiResponse -> DeclaredSpecification with UserDto
    @GetMapping("/untyped")
    @ApiResponse(responseCode = "200", description = "Untyped success", content = @Content(schema = @Schema(implementation = UserDto.class)))
    public ResponseEntity<?> getUntyped() {
        return null;
    }

    // 4. Conflicting AST (UserDto) vs @ApiResponse (ConflictingDto) -> InconclusiveOrConflicting
    @GetMapping("/conflict")
    @ApiResponse(responseCode = "200", description = "Conflict", content = @Content(schema = @Schema(implementation = ConflictingDto.class)))
    public UserDto getConflict() {
        return null;
    }
}
"#,
    ).unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("evidence-service");
    assert!(completeness.complete);

    // 1. Verify /api/evidence/user is ImplementationDerived
    let user_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/evidence/user"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/evidence/user must exist");

    assert_eq!(
        user_ep.evidence_classification,
        Some(contract_core::ir::EvidenceClassification::ImplementationDerived)
    );
    assert_eq!(
        user_ep.status_code_family,
        Some(contract_core::ir::StatusCodeFamily::Success2xx)
    );

    // 2. Verify /api/evidence/export is DeclaredSpecification with ExportDto
    let export_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/evidence/export"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/evidence/export must exist");

    assert_eq!(
        export_ep.evidence_classification,
        Some(contract_core::ir::EvidenceClassification::DeclaredSpecification)
    );
    if let Some(contract_core::ir::WireType::Ref(r)) = &export_ep.body {
        assert!(r.r#ref.contains("ExportDto"));
    } else {
        panic!("Export endpoint body must resolve to ExportDto ref");
    }

    // 3. Verify /api/evidence/untyped is DeclaredSpecification with UserDto
    let untyped_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/evidence/untyped"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/evidence/untyped must exist");

    assert_eq!(
        untyped_ep.evidence_classification,
        Some(contract_core::ir::EvidenceClassification::DeclaredSpecification)
    );
    if let Some(contract_core::ir::WireType::Ref(r)) = &untyped_ep.body {
        assert!(r.r#ref.contains("UserDto"));
    } else {
        panic!("Untyped endpoint body must resolve to UserDto ref via @ApiResponse");
    }

    // 4. Verify /api/evidence/conflict is InconclusiveOrConflicting with WireType::Unknown
    let conflict_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/evidence/conflict"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/evidence/conflict must exist");

    assert_eq!(
        conflict_ep.evidence_classification,
        Some(contract_core::ir::EvidenceClassification::InconclusiveOrConflicting)
    );
    assert!(
        matches!(
            &conflict_ep.body,
            Some(contract_core::ir::WireType::Unknown(_))
        ),
        "Conflicting endpoint must be WireType::Unknown"
    );
}

#[test]
fn test_rfc7807_and_rfc9457_problem_details() {
    let root = std::env::temp_dir().join(format!("sajimora-problem-detail-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("ErrorController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.ProblemDetail;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/errors")
public class ErrorController {

    @GetMapping("/problem")
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ProblemDetail getDirectProblem() {
        return null;
    }
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("GlobalExceptionHandler.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.ProblemDetail;
import org.springframework.http.HttpStatus;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ProblemDetail handleNotFound(IllegalArgumentException ex) {
        return null;
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, completeness) = extractor.extract_payload("problem-service");
    assert!(completeness.complete);

    // 1. Verify /api/errors/problem endpoint has ProblemDetail schema and Error4xx5xx status family
    let direct_ep = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/errors/problem"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET /api/errors/problem must exist");

    assert_eq!(
        direct_ep.status_code_family,
        Some(contract_core::ir::StatusCodeFamily::Error4xx5xx)
    );

    if let Some(contract_core::ir::WireType::Object(obj)) = &direct_ep.body {
        assert_eq!(obj.name.as_deref(), Some("ProblemDetail"));
        let props: Vec<&str> = obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect();
        assert!(props.contains(&"type"), "RFC 7807 type required");
        assert!(props.contains(&"title"), "RFC 7807 title required");
        assert!(props.contains(&"status"), "RFC 7807 status required");
        assert!(props.contains(&"detail"), "RFC 7807 detail required");
        assert!(props.contains(&"instance"), "RFC 7807 instance required");
        assert!(
            props.contains(&"properties"),
            "RFC 7807/9457 extension properties required"
        );
    } else {
        panic!("Problem endpoint must resolve to RFC 7807 ObjectWireType");
    }

    // 2. An @ExceptionHandler is not a route. It applies to every endpoint in the
    // application, so inventing a path for it makes the fake row deletion-detectable
    // and it can never link to a consumer.
    assert!(
        !payload.endpoints.iter().any(|e| e
            .identity
            .normalized_route
            .raw_path
            .contains("error-handler")),
        "unmapped @ExceptionHandler methods must not be emitted as endpoints"
    );
    assert_eq!(
        payload
            .endpoints
            .iter()
            .filter(|e| e.identity.http_method.as_str() == "ALL")
            .count(),
        0,
        "no endpoint may claim an ALL verb synthesized from an advice class"
    );
}

/// Blob-fed extraction must seal exactly the bytes the working-tree scan seals:
/// the digest is what a signature covers, so a revision mode that re-derived a
/// different artifact would break every existing sealed contract.
#[test]
fn blob_fed_extraction_produces_the_identical_sealed_envelope() {
    use std::fs;
    use std::path::PathBuf;

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        for item in fs::read_dir(dir).expect("read_dir") {
            let path = item.expect("dir entry").path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("java") {
                out.push(path);
            }
        }
    }

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../../..");
    let sample_dir = repo_root.join("rust/fixtures/spring-sample");

    let worktree =
        JavaRouteExtractor::new(repo_root.clone(), &sample_dir).expect("working tree extractor");
    let sealed = worktree
        .build_envelope("sample-service", None, "HEAD")
        .expect("working tree envelope");

    let mut files = Vec::new();
    collect(&sample_dir, &mut files);
    files.sort();
    let sources: Vec<(String, String)> = files
        .iter()
        .map(|path| {
            let rel = path_to_posix(path.strip_prefix(&repo_root).unwrap());
            (rel, fs::read_to_string(path).expect("source"))
        })
        .collect();
    // The label decides properties-vs-YAML parsing and feeds the blocker text, so the blob lane
    // must be handed the same path `detect_config` resolved on disk for the digests to agree.
    let config_label = "rust/fixtures/spring-sample/src/main/resources/application.properties";
    let properties = fs::read_to_string(repo_root.join(config_label)).ok();

    let from_blobs = JavaRouteExtractor::from_blobs(
        repo_root.clone(),
        sources,
        properties
            .as_deref()
            .map_or_else(ConfigInputs::default, |content| {
                ConfigInputs::single(config_label, content)
            }),
    )
    .expect("blob extractor");
    let reproduced = from_blobs
        .build_envelope("sample-service", None, "HEAD")
        .expect("blob envelope");

    assert_eq!(
        sealed.integrity, reproduced.integrity,
        "the digest over a blob-fed envelope must equal the working-tree digest"
    );
    assert_eq!(sealed, reproduced, "envelope bytes must be identical");
}

fn path_to_posix(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[test]
fn test_non_utf8_java_source_is_blocked_but_not_dropped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src = repo_root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create dirs");

    // "Ren" followed by Latin-1 0xE9 is not valid UTF-8. Before this fix the whole file was
    // skipped by `read_to_string().ok()?`, so its endpoint vanished while the artifact still
    // claimed complete = true.
    let mut bytes: Vec<u8> = b"package com.demo;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping(\"/api/legacy\")\npublic class LegacyController {\n    // author: Ren".to_vec();
    bytes.push(0xE9);
    bytes.extend_from_slice(
        b"\n    @GetMapping(\"/paid-endpoint\")\n    public String paid() { return \"p\"; }\n}\n",
    );
    std::fs::write(src.join("LegacyController.java"), &bytes).expect("write latin-1 source");

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");

    assert!(
        payload
            .endpoints
            .iter()
            .any(|e| e.identity.normalized_route.raw_path == "/api/legacy/paid-endpoint"),
        "identifiers survive a lossy decode, so the endpoint must still be extracted"
    );
    assert!(
        !completeness.complete,
        "a lossily decoded source must make the artifact incomplete"
    );
    assert_eq!(
        completeness.blockers.len(),
        1,
        "exactly one blocker expected"
    );
    assert_eq!(completeness.blockers[0].code, "JAVA_SOURCE_NOT_UTF8");
    assert_eq!(
        completeness.blockers[0].file.as_deref(),
        Some("src/main/java/com/demo/LegacyController.java")
    );
}

#[test]
fn test_backend_endpoints_are_emitted_in_a_stable_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src = repo_root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create dirs");

    // Classes are registered in a HashMap, so payload order followed random per-process
    // iteration and the sealed digest changed between identical runs.
    for (name, route) in [
        ("ZetaController", "/api/zeta"),
        ("AlphaController", "/api/alpha"),
        ("MidController", "/api/mid"),
    ] {
        std::fs::write(
            src.join(format!("{name}.java")),
            format!(
                "package com.demo;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping(\"{route}\")\npublic class {name} {{\n    @GetMapping(\"/x\")\n    public String x() {{ return \"x\"; }}\n}}\n"
            ),
        )
        .expect("write controller");
    }

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");

    assert_eq!(payload.endpoints.len(), 3);
    assert!(
        completeness.complete,
        "clean sources must not raise blockers"
    );
    let routes: Vec<&str> = payload
        .endpoints
        .iter()
        .map(|e| e.identity.normalized_route.raw_path.as_str())
        .collect();
    let mut sorted = routes.clone();
    sorted.sort_unstable();
    assert_eq!(
        routes, sorted,
        "endpoint order must not depend on hash iteration order"
    );
}

#[test]
fn test_request_param_and_request_header_are_published_not_discarded() {
    let root = std::env::temp_dir().join(format!("sajimora-qp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create src");
    std::fs::write(
        src.join("QpController.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/qp")
public class QpController {

    @GetMapping("/a")
    public String a(@RequestParam("q") String q) { return q; }

    @GetMapping("/b")
    public String b(@RequestParam int page) { return String.valueOf(page); }

    @GetMapping("/c")
    public String c(@RequestParam(required = false) String s) { return s; }

    @GetMapping("/d")
    public String d(@RequestHeader("X-Tenant") String tenant) { return tenant; }

    @GetMapping("/e")
    public String e(@RequestParam(defaultValue = "0") int n) { return String.valueOf(n); }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor");
    let (payload, _) = extractor.extract_payload("qp");

    let request = |path: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == path
                    && e.identity.direction == contract_core::ir::ContractDirection::Request
            })
            .unwrap_or_else(|| panic!("REQUEST endpoint for {path} must exist"))
    };
    let names = |ps: &[contract_core::ir::ParamContract]| {
        ps.iter()
            .map(|p| (p.name.clone(), p.required))
            .collect::<Vec<_>>()
    };

    // A declared query parameter is part of the contract the caller depends on.
    assert_eq!(
        names(&request("/api/qp/a").query_parameters),
        vec![("q".to_string(), true)]
    );

    // An operation whose only caller-supplied input is a query parameter used to produce no
    // request contract at all, so renaming or deleting it could not be observed.
    assert_eq!(
        names(&request("/api/qp/b").query_parameters),
        vec![("page".to_string(), true)]
    );
    assert!(request("/api/qp/b").body.is_none());

    assert_eq!(
        names(&request("/api/qp/c").query_parameters),
        vec![("s".to_string(), false)],
        "required = false must be honoured"
    );

    // Headers bind by name, never by position, and are not query parameters.
    assert_eq!(
        names(&request("/api/qp/d").headers),
        vec![("X-Tenant".to_string(), true)]
    );
    assert!(request("/api/qp/d").query_parameters.is_empty());

    // `defaultValue` supplies the value the caller omitted, which makes the parameter optional;
    // its literal is a value, not the parameter's name.
    assert_eq!(
        names(&request("/api/qp/e").query_parameters),
        vec![("n".to_string(), false)],
        "defaultValue must not become the parameter name and must relax required"
    );

    // The same operation viewed as a response carries the same parameters, so a change to a
    // parameter is visible whichever direction the consumer contract is linked in.
    let response = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/qp/a"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("RESPONSE endpoint for /api/qp/a");
    assert_eq!(
        names(&response.query_parameters),
        vec![("q".to_string(), true)]
    );
}

#[test]
fn test_java_collections_arrays_and_enums_are_resolved_not_unknown() {
    let root = std::env::temp_dir().join(format!("sajimora-tc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create src");
    std::fs::write(
        src.join("OrderState.java"),
        "package com.demo;\npublic enum OrderState { NEW, PAID, SHIPPED }\n",
    )
    .expect("write enum");
    std::fs::write(
        src.join("TcController.java"),
        r#"
package com.demo;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/tc")
public class TcController {

    @GetMapping("/arr")
    public String arr(@RequestParam String[] ids) { return String.join(",", ids); }

    @GetMapping("/ints")
    public String ints(@RequestParam int[] codes) { return String.valueOf(codes.length); }

    @GetMapping("/bytes")
    public String bytes(@RequestParam byte[] payload) { return new String(payload); }

    @GetMapping("/set")
    public String set(@RequestParam Set<UUID> entities) { return String.valueOf(entities.size()); }

    @GetMapping("/list")
    public String list(@RequestParam List<String> tags) { return String.join(",", tags); }

    @GetMapping("/map")
    public String map(@RequestParam Map<String, String> filters) { return filters.toString(); }

    @GetMapping("/mv")
    public String mv(@RequestParam MultiValueMap<String, String> params) { return params.toString(); }

    @GetMapping("/opt")
    public String opt(@RequestParam Optional<String> maybe) { return maybe.orElse(""); }

    @GetMapping("/atomic")
    public String atomic(@RequestParam AtomicInteger counter) { return String.valueOf(counter.get()); }

    @GetMapping("/enum")
    public String enu(@RequestParam OrderState state) { return state.name(); }

    @GetMapping("/raw")
    public String raw(@RequestParam List whatever) { return String.valueOf(whatever.size()); }

    @GetMapping("/ts")
    public String ts(@RequestParam java.sql.Timestamp since, @RequestParam java.util.Date until) { return since + "" + until; }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor");
    let (payload, _) = extractor.extract_payload("tc");

    let param_type = |path: &str, name: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == path
                    && e.identity.direction == contract_core::ir::ContractDirection::Request
            })
            .unwrap_or_else(|| panic!("REQUEST endpoint for {path} must exist"))
            .query_parameters
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("query parameter {name} on {path}"))
            .r#type
            .clone()
    };

    use contract_core::ir::{PrimitiveScalar, WireType};

    // A Java array is a JSON array of the same element kind.
    let arr = param_type("/api/tc/arr", "ids");
    let WireType::Array(a) = &arr else {
        panic!("String[] must be an array, got {arr:?}");
    };
    assert!(
        matches!(*a.element_type, WireType::Primitive(_)),
        "String[] element must be a string primitive: {a:?}"
    );

    let ints = param_type("/api/tc/ints", "codes");
    let WireType::Array(a) = &ints else {
        panic!("int[] must be an array, got {ints:?}");
    };
    match &*a.element_type {
        WireType::Primitive(p) => assert!(matches!(p.scalar, PrimitiveScalar::Number)),
        other => panic!("int[] element must be numeric, got {other:?}"),
    }

    // byte[] is what Jackson writes as a base64 string, so it must stay a single value.
    match param_type("/api/tc/bytes", "payload") {
        WireType::Primitive(p) => assert!(matches!(p.scalar, PrimitiveScalar::Any)),
        other => panic!("byte[] must stay a scalar, got {other:?}"),
    }

    // Generic collections and maps.
    let set = param_type("/api/tc/set", "entities");
    assert!(
        matches!(set, WireType::Array(_)),
        "Set<UUID> must be an array, got {set:?}"
    );
    let list = param_type("/api/tc/list", "tags");
    assert!(
        matches!(list, WireType::Array(_)),
        "List<String> must be an array, got {list:?}"
    );
    assert_eq!(
        serde_json::to_string(&arr).expect("serialize String[]"),
        serde_json::to_string(&list).expect("serialize List<String>"),
        "`String[]` and `List<String>` must publish the same wire shape, or a list-to-array refactor reads as a break"
    );
    let raw = param_type("/api/tc/raw", "whatever");
    assert!(
        matches!(raw, WireType::Array(_)),
        "a raw List must be an array, got {raw:?}"
    );
    let map = param_type("/api/tc/map", "filters");
    assert!(
        matches!(map, WireType::Map(_)),
        "Map<String, String> must be a map, got {map:?}"
    );
    let mv = param_type("/api/tc/mv", "params");
    let WireType::Map(m) = &mv else {
        panic!("MultiValueMap must be a map, got {mv:?}");
    };
    assert!(
        matches!(*m.value_type, WireType::Array(_)),
        "MultiValueMap values are arrays, got {mv:?}"
    );

    // Optional<T> is T at the wire; AtomicInteger is a number.
    match param_type("/api/tc/opt", "maybe") {
        WireType::Primitive(p) => assert!(matches!(p.scalar, PrimitiveScalar::String)),
        other => panic!("Optional<String> must unwrap to a string, got {other:?}"),
    }
    match param_type("/api/tc/atomic", "counter") {
        WireType::Primitive(p) => assert!(matches!(p.scalar, PrimitiveScalar::Number)),
        other => panic!("AtomicInteger must be numeric, got {other:?}"),
    }

    // An enum parameter is a valued enumeration, not an opaque object or Unknown.
    let enu = param_type("/api/tc/enum", "state");
    let WireType::Ref(r) = &enu else {
        panic!("an enum parameter must reference the pool, got {enu:?}");
    };
    assert!(
        r.r#ref.ends_with("OrderState:request"),
        "ref should name the request enum: {}",
        r.r#ref
    );
    let pool = payload.type_pool.expect("type pool with the enum");
    match &pool[r.r#ref.as_str()] {
        WireType::Enum(e) => assert_eq!(
            e.values
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            vec!["NEW".to_string(), "PAID".to_string(), "SHIPPED".to_string()]
        ),
        other => panic!("pool entry for the enum must be an Enum, got {other:?}"),
    }

    // JPA-generated entities use java.sql date/time types, not java.time. Spring Boot
    // disables WRITE_DATES_AS_TIMESTAMPS, so they serialize as ISO-8601 strings.
    for name in ["since", "until"] {
        match param_type("/api/tc/ts", name) {
            WireType::Primitive(p) => assert!(
                matches!(p.scalar, PrimitiveScalar::String),
                "{name} must be a string scalar, got {:?}",
                p.scalar
            ),
            other => panic!("{name} must resolve to a primitive, got {other:?}"),
        }
    }
}

#[test]
fn test_interface_and_fieldless_abstract_types_are_unknown_not_empty_objects() {
    let root = std::env::temp_dir().join(format!("sajimora-if-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create src");
    std::fs::write(
        src.join("Payable.java"),
        "package com.demo;\n\
         public interface Payable {\n\
         \x20   String DEFAULT_CURRENCY = \"EUR\";\n\
         \x20   String amount();\n\
         }\n",
    )
    .expect("write interface");
    std::fs::write(
        src.join("AbstractWithFields.java"),
        "package com.demo;\n\
         public abstract class AbstractWithFields {\n\
         \x20   public String traceId;\n\
         }\n",
    )
    .expect("write abstract class");
    std::fs::write(
        src.join("IfController.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/if")
public class IfController {

    @GetMapping("/iface")
    public Payable iface() { return null; }

    @GetMapping("/holder")
    public Holder holder() { return null; }

    @GetMapping("/abstract")
    public AbstractWithFields abs() { return null; }
}

class Holder {
    public String name;
    public Payable inner;
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor");
    let (payload, _) = extractor.extract_payload("if");

    let response_body = |path: &str| {
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
    };

    use contract_core::ir::WireType;

    // An interface declares no serialized properties: its fields are `static final`
    // constants and Jackson skips those, so an empty object here is a fabricated shape.
    let iface = response_body("/api/if/iface");
    let WireType::Unknown(u) = &iface else {
        panic!("an interface body must be Unknown, got {iface:?}");
    };
    assert!(
        u.reason.contains("interface"),
        "the reason must name the cause: {}",
        u.reason
    );

    // The same holds one level down: a field of interface type cannot be a confident object.
    let holder = match response_body("/api/if/holder") {
        WireType::Ref(r) => payload
            .type_pool
            .as_ref()
            .and_then(|pool| pool.get(&r.r#ref).cloned())
            .unwrap_or_else(|| panic!("Holder must be published in the type pool: {:?}", r.r#ref)),
        other => other,
    };
    let WireType::Object(obj) = &holder else {
        panic!("Holder is a concrete class and must stay an object, got {holder:?}");
    };
    let names: Vec<&str> = obj
        .properties
        .iter()
        .map(|p| p.wire_name.as_str())
        .collect();
    assert!(
        names.contains(&"name"),
        "declared field must survive: {names:?}"
    );
    assert!(
        !names.contains(&"defaultCurrency"),
        "an interface constant must never become a wire property: {names:?}"
    );
    let inner = obj
        .properties
        .iter()
        .find(|p| p.wire_name == "inner")
        .expect("inner property");
    assert!(
        matches!(inner.r#type, WireType::Unknown(_)),
        "a field of interface type must be Unknown, got {:?}",
        inner.r#type
    );

    // An abstract class that does declare instance fields keeps its object shape.
    let abs = match response_body("/api/if/abstract") {
        WireType::Ref(r) => payload
            .type_pool
            .as_ref()
            .and_then(|pool| pool.get(&r.r#ref).cloned())
            .expect("AbstractWithFields must be published in the type pool"),
        other => other,
    };
    match &abs {
        WireType::Object(obj) => assert!(
            obj.properties.iter().any(|p| p.wire_name == "traceId"),
            "an abstract class with fields must publish them: {:?}",
            obj.properties
        ),
        other => panic!("abstract class with fields must stay an object, got {other:?}"),
    }
}

#[test]
fn test_directory_alias_inside_the_source_root_keeps_real_provenance() {
    let root = std::env::temp_dir().join(format!("sajimora-alias-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");
    std::fs::write(
        pkg.join("AliasedController.java"),
        "package com.demo;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping(\"/api/alias\")\npublic class AliasedController {\n    @GetMapping\n    public String g(@RequestParam int page) { return String.valueOf(page); }\n}\n",
    )
    .expect("write controller");

    // An alias of the source root nested inside itself. Without a traversal guard the walk
    // re-enters it until the platform path limit aborts the stat, so the endpoint is published
    // with a provenance path that exists only inside the alias -- and which shifts with the
    // length of the clone path, taking the sealed digest with it.
    #[cfg(unix)]
    let alias_made = std::os::unix::fs::symlink(&java_root, pkg.join("loop")).is_ok();
    #[cfg(windows)]
    let alias_made = {
        use std::os::windows::process::CommandExt;
        let link = pkg.join("loop").to_string_lossy().to_string();
        let target = java_root.to_string_lossy().to_string();
        // `cmd` re-parses its own command line, so `mklink`'s quoted paths must be passed
        // verbatim rather than through per-argument escaping.
        std::process::Command::new("cmd")
            .raw_arg(format!("/C mklink /J \"{link}\" \"{target}\""))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    assert!(
        alias_made,
        "cannot exercise the traversal guard on a filesystem that refuses a directory alias"
    );

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, _) = extractor.extract_payload("alias");

    assert_eq!(
        payload.endpoints.len(),
        2,
        "the aliased copy must not register the controller a second time"
    );
    for ep in &payload.endpoints {
        assert_eq!(
            ep.provenance.file, "src/main/java/com/demo/AliasedController.java",
            "provenance must name a path the developer can open"
        );
    }
}

#[test]
fn test_unsupported_web_framework_is_blocked_instead_of_reporting_an_empty_complete_service() {
    let root = std::env::temp_dir().join(format!("sajimora-jaxrs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");
    std::fs::write(
        pkg.join("OrderResource.java"),
        "package com.demo;\nimport jakarta.ws.rs.GET;\nimport jakarta.ws.rs.Path;\n@Path(\"/api/orders\")\npublic class OrderResource {\n    @GET\n    public String get() { return \"x\"; }\n}\n",
    )
    .expect("write resource");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("jaxrs");

    assert!(
        payload.endpoints.is_empty(),
        "JAX-RS annotations are not Spring mappings and must not be guessed at"
    );
    assert!(
        !completeness.complete,
        "an artifact that saw a web framework it cannot parse must not claim completeness"
    );
    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        codes.contains(&"JAVA_MAPPING_FRAMEWORK_UNPARSED"),
        "unexpected blockers: {codes:?}"
    );
    let blocker = completeness
        .blockers
        .iter()
        .find(|b| b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED")
        .expect("blocker");
    assert_eq!(
        blocker.file.as_deref(),
        Some("src/main/java/com/demo/OrderResource.java")
    );
}

#[test]
fn test_kotlin_sources_beside_the_java_root_are_declared_not_silently_empty() {
    let root = std::env::temp_dir().join(format!("sajimora-kotlin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src/main/kotlin/com/demo")).expect("create kt pkg");
    std::fs::write(
        root.join("src/main/kotlin/com/demo/KotlinController.kt"),
        "package com.demo\nimport org.springframework.web.bind.annotation.*\n@RestController\nclass KotlinController {\n    @GetMapping\n    fun k(): String = \"k\"\n}\n",
    )
    .expect("write kotlin");

    // Maven-style layout with no Java sources, so the scan root is the repository itself.
    let extractor = JavaRouteExtractor::new(root.clone(), &root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("kotlin");

    assert!(payload.endpoints.is_empty());
    assert!(
        !completeness.complete,
        "Kotlin is not parsed, so an empty artifact must be labelled incomplete"
    );
    assert!(completeness
        .blockers
        .iter()
        .any(|b| b.code == "JAVA_SOURCE_NOT_PARSED"));
    for b in &completeness.blockers {
        if b.code == "JAVA_SOURCE_NOT_PARSED" {
            let file = b.file.clone().unwrap_or_default();
            assert!(
                !file.contains(':') && !file.starts_with('/'),
                "blocker path must stay repo-relative so the digest does not seal the checkout location: {file}"
            );
        }
    }
}

/// An OpenAPI-generated `*Api` interface carries the whole HTTP surface, so a controller can
/// be invisible while the artifact still reads as finished. Absence must be reported, not sealed.
#[test]
fn test_controller_without_own_mappings_is_reported_incomplete() {
    let root = std::env::temp_dir().join(format!("sajimora-unmapped-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create src");
    std::fs::write(
        src.join("OwnerRestController.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class OwnerRestController implements OwnersApi {
    @Override
    public String getOwners() { return ""; }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("unmapped");
    assert!(
        payload
            .endpoints
            .iter()
            .all(|e| e.identity.http_method != "ALL"),
        "no endpoint may be invented for an unmapped controller"
    );

    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        codes.contains(&"JAVA_CONTROLLER_WITHOUT_MAPPINGS"),
        "a controller that yields zero endpoints must be attributed: {codes:?}"
    );
    assert!(
        !completeness.complete,
        "the artifact must not claim completeness"
    );
    let message = completeness
        .blockers
        .iter()
        .find(|b| b.code == "JAVA_CONTROLLER_WITHOUT_MAPPINGS")
        .expect("blocker")
        .message
        .clone();
    assert!(
        message.contains("OwnersApi") && message.contains("not among the parsed sources"),
        "the blocker must name the interface it could not see: {message}"
    );

    // The interface being checked in does not make the surface visible: the extractor still
    // does not follow the implements edge, so the abstention has to survive.
    std::fs::write(
        src.join("OwnersApi.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.*;

public interface OwnersApi {
    @GetMapping("/owners")
    String getOwners();
}
"#,
    )
    .expect("write interface");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor2");
    let (_, completeness) = extractor.extract_payload("unmapped");
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_CONTROLLER_WITHOUT_MAPPINGS"),
        "a scanned interface must not turn an empty controller back into a complete artifact"
    );
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_CONTROLLER_WITHOUT_MAPPINGS"
                && b.message.contains("not among the parsed sources")),
        "the message must not blame a source that was in fact parsed"
    );
}

#[test]
fn test_unsupported_jackson_naming_strategy_fails_closed() {
    let controller = r#"
package demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {
    @GetMapping("/api/accounts")
    public AccountDto list() {
        return new AccountDto();
    }
}
"#;
    let dto = r#"
package demo;

public class AccountDto {
    public String lastName;
}
"#;
    let sources = || {
        vec![
            (
                "src/main/java/demo/AccountController.java".to_string(),
                controller.to_string(),
            ),
            (
                "src/main/java/demo/AccountDto.java".to_string(),
                dto.to_string(),
            ),
        ]
    };
    let extract = |props: Option<&str>| {
        let extractor = JavaRouteExtractor::from_blobs(
            Path::new(".").to_path_buf(),
            sources(),
            props.map_or_else(ConfigInputs::default, |content| {
                ConfigInputs::single("application.properties", content)
            }),
        )
        .expect("extractor");
        extractor.extract_payload("demo-service")
    };

    for strategy in [
        "UPPER_SNAKE_CASE",
        "UPPER_CAMEL_CASE",
        "KEBAB_CASE",
        "LOWER_DOT_CASE",
        "LOWER_CASE",
    ] {
        let props = format!("spring.jackson.property-naming-strategy={strategy}\n");
        let (_, completeness) = extract(Some(&props));
        let blocker = completeness
            .blockers
            .iter()
            .find(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED")
            .unwrap_or_else(|| {
                panic!("{strategy} would produce wrong wire names and must not pass as camelCase")
            });
        assert!(
            blocker.message.contains(strategy),
            "the blocker must name the strategy it could not model: {}",
            blocker.message
        );
        assert!(
            !completeness.complete,
            "an artifact built under an unmodelled naming strategy must not claim completeness"
        );
    }

    for props in [
        None,
        Some("spring.jackson.property-naming-strategy=SNAKE_CASE\n"),
    ] {
        let (_, completeness) = extract(props);
        assert!(
            !completeness
                .blockers
                .iter()
                .any(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED"),
            "camelCase and SNAKE_CASE are modelled and must not be blocked: {props:?}"
        );
        assert!(
            completeness.complete,
            "the control extraction must stay complete: {props:?}"
        );
    }
}

#[test]
fn test_nested_dto_class_is_indexed_with_getter_json_property() {
    let root = std::env::temp_dir().join(format!("sajimora-nested-dto-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("AuthController.java"),
        r#"
package com.example.demo;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    @PostMapping("/login")
    public ResponseEntity<JWTToken> login() {
        return null;
    }

    static class JWTToken {
        private String idToken;

        JWTToken(String idToken) {
            this.idToken = idToken;
        }

        @JsonProperty("id_token")
        String getIdToken() {
            return idToken;
        }

        void setIdToken(String idToken) {
            this.idToken = idToken;
        }
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("auth-service");

    let login = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/auth/login"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("POST /api/auth/login response endpoint must exist");

    let body = login.body.as_ref().expect("response body must be resolved");
    let contract_core::ir::WireType::Ref(reference) = body else {
        panic!("a nested DTO must resolve to a Ref, got {body:?}");
    };
    assert_eq!(
        reference.r#ref, "java:com.example.demo.AuthController.JWTToken",
        "the nested type must be addressable under its enclosing type"
    );

    let type_pool = payload.type_pool.expect("type_pool must be present");
    let contract_core::ir::WireType::Object(obj) =
        &type_pool["java:com.example.demo.AuthController.JWTToken"]
    else {
        panic!("nested JWTToken must be interned as an Object");
    };
    let props: Vec<(&str, bool)> = obj
        .properties
        .iter()
        .map(|p| (p.wire_name.as_str(), p.nullable))
        .collect();
    assert_eq!(
        props,
        vec![("id_token", true)],
        "the accessor's @JsonProperty name is the wire name; a field-only reader would publish `idToken`, which the server never emits"
    );
}

#[test]
fn test_generic_wrapper_type_arguments_bind_through_composed_fields() {
    let root =
        std::env::temp_dir().join(format!("sajimora-generic-wrapper-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("PageResult.java"),
        r#"
package com.example.demo;

import java.util.List;
import java.util.Map;
import lombok.Getter;

@Getter
public class PageResult<T> {
    private List<T> content;
    private T first;
    private Map<String, T> byKey;
    private long totalElements;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("UserDto.java"),
        r#"
package com.example.demo;

import lombok.Getter;

@Getter
public class UserDto {
    private String username;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("Pair.java"),
        r#"
package com.example.demo;

import java.util.List;
import lombok.Getter;

@Getter
public class Pair<A, B> {
    private A first;
    private List<B> rest;
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("CatalogController.java"),
        r#"
package com.example.demo;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/catalog")
public class CatalogController {

    @GetMapping("/page")
    public ResponseEntity<PageResult<UserDto>> page() {
        return null;
    }

    @GetMapping("/pair")
    public Pair<String, UserDto> pair() {
        return null;
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("catalog-service");

    let response_body = |route: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .unwrap_or_else(|| panic!("{route} response endpoint must exist"))
            .body
            .clone()
            .unwrap_or_else(|| panic!("{route} response body must be resolved"))
    };

    let user_ref = |wire: &contract_core::ir::WireType| {
        let contract_core::ir::WireType::Ref(reference) = wire else {
            panic!("a bound type argument must resolve to a Ref, got {wire:?}");
        };
        assert_eq!(reference.r#ref, "java:com.example.demo.UserDto");
    };

    let page = response_body("/api/catalog/page");
    let contract_core::ir::WireType::Object(page_obj) = &page else {
        panic!("PageResult<UserDto> must expand to an Object, got {page:?}");
    };
    assert_eq!(page_obj.name.as_deref(), Some("PageResult"));
    let prop = |name: &str| {
        page_obj
            .properties
            .iter()
            .find(|p| p.wire_name == name)
            .unwrap_or_else(|| panic!("PageResult must publish `{name}`"))
    };

    let contract_core::ir::WireType::Array(content) = &prop("content").r#type else {
        panic!(
            "List<T> must stay an Array, got {:?}",
            prop("content").r#type
        );
    };
    user_ref(&content.element_type);
    user_ref(&prop("first").r#type);
    let contract_core::ir::WireType::Map(by_key) = &prop("byKey").r#type else {
        panic!(
            "Map<String, T> must stay a Map, got {:?}",
            prop("byKey").r#type
        );
    };
    user_ref(&by_key.value_type);
    assert!(
        matches!(&prop("totalElements").r#type, contract_core::ir::WireType::Primitive(p) if p.scalar == contract_core::ir::PrimitiveScalar::Number),
        "non-generic fields must be unaffected"
    );

    let pair = response_body("/api/catalog/pair");
    let contract_core::ir::WireType::Object(pair_obj) = &pair else {
        panic!("Pair<String, UserDto> must expand to an Object, got {pair:?}");
    };
    assert!(
        matches!(&pair_obj.properties.iter().find(|p| p.wire_name == "first").unwrap().r#type,
            contract_core::ir::WireType::Primitive(p) if p.scalar == contract_core::ir::PrimitiveScalar::String),
        "the first type argument binds positionally to A"
    );
    let contract_core::ir::WireType::Array(rest) = &pair_obj
        .properties
        .iter()
        .find(|p| p.wire_name == "rest")
        .unwrap()
        .r#type
    else {
        panic!("List<B> must stay an Array");
    };
    user_ref(&rest.element_type);

    let type_pool = payload.type_pool.expect("type_pool must be present");
    assert!(
        type_pool.contains_key("java:com.example.demo.UserDto"),
        "the bound type argument must be interned"
    );
}

#[test]
fn test_same_named_nested_dtos_resolve_by_declaring_file() {
    let root = std::env::temp_dir().join(format!("sajimora-nested-scope-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("FirstController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/first")
public class FirstController {
    public static class Item {
        public String firstOnly;
    }

    @GetMapping("/item")
    public Item getItem() { return null; }
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("SecondController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/second")
public class SecondController {
    public static class Item {
        public Long secondOnly;
    }

    @GetMapping("/item")
    public Item getItem() { return null; }
}
"#,
    )
    .unwrap();

    // A third file references `Item` with no nested declaration of its own and
    // no top-level `Item` to import. Two nested candidates make the name
    // ambiguous; picking either would fabricate a shape.
    std::fs::write(
        src_dir.join("ThirdController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/third")
public class ThirdController {
    @GetMapping("/item")
    public Item getItem() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");

    let (payload, _completeness) = extractor.extract_payload("nested-scope-service");
    let type_pool = payload.type_pool.expect("type_pool must be present");

    let response_body = |path: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == path
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
    };

    let first_ref = match response_body("/api/first/item") {
        Some(contract_core::ir::WireType::Ref(r)) => r.r#ref.clone(),
        other => panic!(
            "first endpoint must bind its own nested Item, got {:?}",
            other
        ),
    };
    assert_eq!(first_ref, "java:com.example.demo.FirstController.Item");

    let second_ref = match response_body("/api/second/item") {
        Some(contract_core::ir::WireType::Ref(r)) => r.r#ref.clone(),
        other => panic!(
            "second endpoint must bind its own nested Item, got {:?}",
            other
        ),
    };
    assert_eq!(second_ref, "java:com.example.demo.SecondController.Item");

    let first_props: Vec<&str> = match &type_pool[&first_ref] {
        contract_core::ir::WireType::Object(obj) => obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect(),
        other => panic!("FirstController.Item must be an Object, got {:?}", other),
    };
    assert_eq!(first_props, vec!["firstOnly"]);
    let second_props: Vec<&str> = match &type_pool[&second_ref] {
        contract_core::ir::WireType::Object(obj) => obj
            .properties
            .iter()
            .map(|p| p.wire_name.as_str())
            .collect(),
        other => panic!("SecondController.Item must be an Object, got {:?}", other),
    };
    assert_eq!(second_props, vec!["secondOnly"]);

    match response_body("/api/third/item") {
        Some(contract_core::ir::WireType::Unknown(u)) => {
            assert!(
                u.reason.contains("Item"),
                "ambiguous nested name must stay unresolved, got {}",
                u.reason
            );
        }
        other => panic!(
            "an ambiguous nested simple name must not bind to an arbitrary file, got {:?}",
            other
        ),
    }
}

#[test]
fn test_jackson_visibility_accessors_records_and_class_annotations() {
    let root = std::env::temp_dir().join(format!(
        "sajimora-jackson-visibility-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("JacksonController.java"),
        r#"
package com.example.demo;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/jackson")
public class JacksonController {

    @JsonIgnoreProperties({"internalSecret"})
    public static class Visible {
        private String secret;
        @JsonProperty("wire_renamed")
        private String renamed;
        private String name;
        private String internalSecret;

        public String getName() { return name; }
        public String getInternalSecret() { return internalSecret; }
        public String getComputed() { return "computed"; }
    }

    @JsonIgnoreProperties(value = {"keptByAllowGetters"}, allowGetters = true)
    public static class AllowGettersDto {
        private String keptByAllowGetters;

        public String getKeptByAllowGetters() { return keptByAllowGetters; }
    }

    public record RecordDto(
        @JsonProperty("user_name") String name,
        @JsonIgnore String secret,
        String plain
    ) {}

    public static class Address {
        private String street;
        private String city;

        public String getStreet() { return street; }
        public String getCity() { return city; }
    }

    public static class Envelope {
        private Address address;
        private String own;

        @JsonUnwrapped
        public Address getAddress() { return address; }
        public String getOwn() { return own; }
    }

    @GetMapping("/visible")
    public Visible visible() { return null; }

    @GetMapping("/allow-getters")
    public AllowGettersDto allowGetters() { return null; }

    @GetMapping("/record")
    public RecordDto record() { return null; }

    @GetMapping("/unwrapped")
    public Envelope unwrapped() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("jackson-service");
    let type_pool = payload
        .type_pool
        .as_ref()
        .expect("type_pool must be present");

    let object_for = |route: &str, fqcn: &str| {
        let body = payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
            .unwrap_or_else(|| panic!("{route} response body must be resolved"));
        match body {
            contract_core::ir::WireType::Ref(reference) => assert_eq!(
                reference.r#ref, fqcn,
                "{route} must reference its declared DTO"
            ),
            other => panic!("{route} must resolve to a Ref, got {other:?}"),
        }
        match &type_pool[fqcn] {
            contract_core::ir::WireType::Object(obj) => obj,
            other => panic!("{fqcn} must be interned as an Object, got {other:?}"),
        }
    };
    let prop_names = |obj: &contract_core::ir::ObjectWireType| {
        obj.properties
            .iter()
            .map(|p| p.wire_name.clone())
            .collect::<Vec<_>>()
    };

    // A private field with no accessor is invisible to Jackson and must not be
    // published; an annotated private field, a getter-backed field, and a
    // computed getter must be.
    let visible = object_for(
        "/api/jackson/visible",
        "java:com.example.demo.JacksonController.Visible",
    );
    assert_eq!(
        prop_names(visible),
        vec!["wire_renamed", "name", "computed"],
        "field-only visibility publishes `secret` (never sent) and drops computed getters"
    );

    let allow_getters = object_for(
        "/api/jackson/allow-getters",
        "java:com.example.demo.JacksonController.AllowGettersDto",
    );
    assert_eq!(
        prop_names(allow_getters),
        vec!["keptByAllowGetters"],
        "`allowGetters = true` means Jackson keeps serving the property"
    );

    // Record components are serialized by definition, and component-level
    // Jackson annotations decide their wire names.
    let record = object_for(
        "/api/jackson/record",
        "java:com.example.demo.JacksonController.RecordDto",
    );
    assert_eq!(
        prop_names(record),
        vec!["user_name", "plain"],
        "record components must publish their annotated names and honour @JsonIgnore"
    );

    // @JsonUnwrapped replaces the container property with the nested object's
    // own properties at the same level.
    let envelope = object_for(
        "/api/jackson/unwrapped",
        "java:com.example.demo.JacksonController.Envelope",
    );
    assert_eq!(
        prop_names(envelope),
        vec!["street", "city", "own"],
        "@JsonUnwrapped must flatten the nested object, not emit an `address` container"
    );
}

#[test]
fn test_simple_name_resolution_prefers_imports_and_abstains_when_ambiguous() {
    let root = std::env::temp_dir().join(format!("sajimora-java-scope-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    for (package, file, field) in [
        ("com.example.alpha", "UserDto.java", "alphaOnly"),
        ("com.example.beta", "UserDto.java", "betaOnly"),
    ] {
        let dir = root.join("src/main/java").join(package.replace('.', "/"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(file),
            format!(
                r#"
package {package};

public class UserDto {{
    public String {field};
}}
"#
            ),
        )
        .unwrap();
    }

    let demo_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&demo_dir).unwrap();

    std::fs::write(
        demo_dir.join("ImportedController.java"),
        r#"
package com.example.demo;

import com.example.alpha.UserDto;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/imported")
public class ImportedController {
    @GetMapping("/dto")
    public UserDto dto() { return null; }
}
"#,
    )
    .unwrap();

    std::fs::write(
        demo_dir.join("WildcardController.java"),
        r#"
package com.example.demo;

import com.example.alpha.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/wildcard")
public class WildcardController {
    @GetMapping("/dto")
    public UserDto dto() { return null; }
}
"#,
    )
    .unwrap();

    // Two packages declare `UserDto`; this file imports neither. Java would
    // reject the source, but a parser that binds the last declaration by
    // simple name silently invents a shape. Choosing neither is the only
    // honest outcome.
    std::fs::write(
        demo_dir.join("AmbiguousController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/ambiguous")
public class AmbiguousController {
    @GetMapping("/dto")
    public UserDto dto() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &root.join("src/main/java"))
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("scope-service");
    let type_pool = payload
        .type_pool
        .as_ref()
        .expect("type_pool must be present");

    let body_for = |route: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
            .unwrap_or_else(|| panic!("{route} response body must be resolved"))
    };
    let ref_for = |route: &str| match body_for(route) {
        contract_core::ir::WireType::Ref(reference) => reference.r#ref.clone(),
        other => panic!("{route} must bind a named DTO, got {other:?}"),
    };

    assert_eq!(
        ref_for("/api/imported/dto"),
        "java:com.example.alpha.UserDto",
        "a single-type import decides the binding, not declaration order"
    );
    assert_eq!(
        ref_for("/api/wildcard/dto"),
        "java:com.example.alpha.UserDto",
        "a wildcard import that yields exactly one candidate is unambiguous"
    );

    match &type_pool["java:com.example.alpha.UserDto"] {
        contract_core::ir::WireType::Object(obj) => {
            let names: Vec<&str> = obj
                .properties
                .iter()
                .map(|p| p.wire_name.as_str())
                .collect();
            assert_eq!(names, vec!["alphaOnly"]);
        }
        other => panic!("alpha UserDto must be an Object, got {other:?}"),
    }

    match body_for("/api/ambiguous/dto") {
        contract_core::ir::WireType::Unknown(u) => assert!(
            u.reason.contains("UserDto"),
            "an ambiguous simple name must stay unresolved, got {}",
            u.reason
        ),
        other => panic!(
            "without an import, two same-named declarations must not bind arbitrarily, got {other:?}"
        ),
    }
}

#[test]
fn test_unresolved_json_unwrapped_target_is_inconclusive_not_a_wrapper_field() {
    let root = std::env::temp_dir().join(format!(
        "sajimora-unwrapped-unresolved-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("UnwrappedController.java"),
        r#"
package com.example.demo;

import com.example.external.ExternalAddress;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/unwrapped")
public class UnwrappedController {

    public static class MissingTargetEnvelope {
        private ExternalAddress address;
        private String own;

        @JsonUnwrapped
        public ExternalAddress getAddress() { return address; }
        public String getOwn() { return own; }
    }

    public interface Loose {
    }

    public static class InterfaceTargetEnvelope {
        private Loose loose;

        @JsonUnwrapped
        public Loose getLoose() { return loose; }
    }

    @GetMapping("/missing")
    public MissingTargetEnvelope missing() { return null; }

    @GetMapping("/interface")
    public InterfaceTargetEnvelope interfaceTarget() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("unwrapped-service");
    let type_pool = payload.type_pool.as_ref();

    let body_for = |route: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
            .unwrap_or_else(|| panic!("{route} response body must be resolved"))
    };

    for (route, declared_type) in [
        ("/api/unwrapped/missing", "ExternalAddress"),
        ("/api/unwrapped/interface", "Loose"),
    ] {
        match body_for(route) {
            contract_core::ir::WireType::Unknown(unknown) => {
                assert!(
                    unknown.reason.contains("Unresolved @JsonUnwrapped target"),
                    "{route}: an unresolvable unwrapped target must be reported as such, got {}",
                    unknown.reason
                );
                assert!(
                    unknown.reason.contains(declared_type),
                    "{route}: the reason must name the declared target type, got {}",
                    unknown.reason
                );
            }
            other => panic!(
                "{route}: flattening an unresolved {declared_type} invents a wire shape; got {other:?}"
            ),
        }
    }

    // The wrapper field name must not survive as a property anywhere: Jackson
    // never writes `address`/`loose`, so keeping the wrapper name fabricates a
    // key that cannot appear on the wire.
    if let Some(pool) = type_pool {
        for (key, wire) in pool {
            if let contract_core::ir::WireType::Object(object) = wire {
                let names: Vec<&str> = object
                    .properties
                    .iter()
                    .map(|p| p.wire_name.as_str())
                    .collect();
                assert!(
                    !names.contains(&"address") && !names.contains(&"loose"),
                    "{key} must not publish an unwrapped wrapper field, got {names:?}"
                );
            }
        }
    }
}

#[test]
fn test_runtime_serialization_annotations_fail_closed_instead_of_ignoring_them() {
    let root = std::env::temp_dir().join(format!(
        "sajimora-runtime-serialization-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("RuntimeShapeController.java"),
        r#"
package com.example.demo;

import com.fasterxml.jackson.annotation.*;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/runtime-shape")
public class RuntimeShapeController {

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
    public static class TypeInfoDto {
        public String id;
    }

    @JsonSubTypes({@JsonSubTypes.Type(value = TypeInfoDto.class, name = "base")})
    public static class SubTypesDto {
        public String id;
    }

    public static class AnyGetterDto {
        public String known;

        @JsonAnyGetter
        public Map<String, Object> extra() { return null; }
    }

    @JsonSerialize(using = CustomSerializer.class)
    public static class CustomSerializerDto {
        public String raw;
    }

    public static class RawValueDto {
        @JsonRawValue
        public String payload;
    }

    public static class ValueDto {
        public String code;

        @JsonValue
        public String render() { return code; }
    }

    public enum Status {
        ACTIVE;

        @JsonValue
        public String code() { return "active"; }
    }

    public static class PlainDto {
        public String id;
    }

    @GetMapping("/enum-value")
    public Status enumValue() { return null; }

    @GetMapping("/type-info")
    public TypeInfoDto typeInfo() { return null; }

    @GetMapping("/sub-types")
    public SubTypesDto subTypes() { return null; }

    @GetMapping("/any-getter")
    public AnyGetterDto anyGetter() { return null; }

    @GetMapping("/custom-serializer")
    public CustomSerializerDto customSerializer() { return null; }

    @GetMapping("/raw-value")
    public RawValueDto rawValue() { return null; }

    @GetMapping("/value")
    public ValueDto value() { return null; }

    @GetMapping("/plain")
    public PlainDto plain() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("runtime-shape-service");

    let body_for = |route: &str| {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
            .unwrap_or_else(|| panic!("{route} response body must be resolved"))
    };

    for (route, annotation) in [
        ("/api/runtime-shape/type-info", "@JsonTypeInfo"),
        ("/api/runtime-shape/sub-types", "@JsonSubTypes"),
        ("/api/runtime-shape/custom-serializer", "@JsonSerialize"),
        ("/api/runtime-shape/raw-value", "@JsonRawValue"),
        ("/api/runtime-shape/value", "@JsonValue"),
        ("/api/runtime-shape/enum-value", "@JsonValue"),
    ] {
        match body_for(route) {
            contract_core::ir::WireType::Unknown(unknown) => assert!(
                unknown.reason.contains(annotation),
                "{route}: the reason must name {annotation}, got {}",
                unknown.reason
            ),
            other => panic!(
                "{route}: {annotation} decides the runtime shape, so a static object invents properties; got {other:?}"
            ),
        }
    }

    // `@JsonAnyGetter` is the exception, because it adds to a shape instead of replacing it:
    // Jackson writes the bean's own properties and then inlines the map's entries. The named
    // map member must not appear as a property (nothing on the wire carries that name), and the
    // object must stay open, since the inlined entries are exactly the properties no field states.
    let any_getter = match body_for("/api/runtime-shape/any-getter") {
        contract_core::ir::WireType::Ref(reference) => payload
            .type_pool
            .as_ref()
            .and_then(|pool| pool.get(&reference.r#ref).cloned())
            .expect("the DTO is interned in the type pool"),
        other => panic!("an @JsonAnyGetter member must not abstain the class, got {other:?}"),
    };
    match any_getter {
        contract_core::ir::WireType::Object(object) => {
            let names: Vec<&str> = object
                .properties
                .iter()
                .map(|p| p.wire_name.as_str())
                .collect();
            assert_eq!(
                names,
                vec!["known"],
                "the any-getter map is inlined, not named"
            );
            assert_eq!(
                object.strict,
                Some(false),
                "the object accepts inlined entries"
            );
        }
        other => panic!("the any-getter DTO keeps an object shape, got {other:?}"),
    }

    // Control: an unannotated DTO keeps its full static shape.
    match body_for("/api/runtime-shape/plain") {
        contract_core::ir::WireType::Ref(reference) => assert_eq!(
            reference.r#ref,
            "java:com.example.demo.RuntimeShapeController.PlainDto"
        ),
        other => panic!("an unannotated DTO must stay resolvable, got {other:?}"),
    }
}

#[test]
fn test_allow_getters_restores_named_serializable_properties() {
    let root = std::env::temp_dir().join(format!(
        "sajimora-allow-getters-filter-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("AllowGettersController.java"),
        r#"
package com.example.demo;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/allow-getters")
public class AllowGettersController {

    @JsonIgnoreProperties(value = {"fieldOnly", "getterBacked", "setterOnly"}, allowGetters = true)
    public static class AllowGettersFiltering {
        public String fieldOnly;
        private String getterBacked;
        private String setterOnly;
        public String untouched;

        public String getGetterBacked() { return getterBacked; }
        public void setSetterOnly(String setterOnly) { this.setterOnly = setterOnly; }
    }

    @JsonIgnoreProperties({"getterBacked"})
    public static class HardIgnore {
        private String getterBacked;
        public String untouched;

        public String getGetterBacked() { return getterBacked; }
    }

    @JsonIgnoreProperties(value = {"hidden"}, allowGetters = false)
    public static class ExplicitFalse {
        public String hidden;
        public String shown;
    }

    @GetMapping("/filtered")
    public AllowGettersFiltering filtered() { return null; }

    @GetMapping("/hard-ignore")
    public HardIgnore hardIgnore() { return null; }

    @GetMapping("/explicit-false")
    public ExplicitFalse explicitFalse() { return null; }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &src_dir)
        .expect("JavaRouteExtractor initialization must succeed");
    let (payload, _) = extractor.extract_payload("allow-getters-service");
    let type_pool = payload
        .type_pool
        .as_ref()
        .expect("type_pool must be present");

    let prop_names_for = |route: &str, fqcn: &str| -> Vec<String> {
        let body = payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .and_then(|e| e.body.as_ref())
            .unwrap_or_else(|| panic!("{route} response body must be resolved"));
        match body {
            contract_core::ir::WireType::Ref(reference) => {
                assert_eq!(
                    reference.r#ref, fqcn,
                    "{route} must reference its declared DTO"
                )
            }
            other => panic!("{route} must resolve to a Ref, got {other:?}"),
        }
        match &type_pool[fqcn] {
            contract_core::ir::WireType::Object(object) => object
                .properties
                .iter()
                .map(|p| p.wire_name.clone())
                .collect(),
            other => panic!("{fqcn} must be interned as an Object, got {other:?}"),
        }
    };

    assert_eq!(
        prop_names_for(
            "/api/allow-getters/filtered",
            "java:com.example.demo.AllowGettersController.AllowGettersFiltering"
        ),
        vec!["fieldOnly", "getterBacked", "untouched"],
        "`allowGetters = true` restores named public fields and getters without inventing setter-only output"
    );

    assert_eq!(
        prop_names_for(
            "/api/allow-getters/hard-ignore",
            "java:com.example.demo.AllowGettersController.HardIgnore"
        ),
        vec!["untouched"],
        "a plain @JsonIgnoreProperties must drop a getter-backed property too"
    );

    assert_eq!(
        prop_names_for(
            "/api/allow-getters/explicit-false",
            "java:com.example.demo.AllowGettersController.ExplicitFalse"
        ),
        vec!["shown"],
        "`allowGetters = false` must behave like a hard ignore"
    );
}

/// A multi-module Maven/Gradle repository declares the DTOs its controllers speak in a sibling
/// module. Indexing only the served module made every one of those names an unresolved leaf, and
/// the artifact looked like a service with an untyped surface.
fn multi_module_fixture(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("sajimora-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create repo root");

    // The module set has to be declared, because that is where the extractor reads it from: a
    // directory scan would absorb nested checkouts that are not this service.
    std::fs::write(
        root.join("pom.xml"),
        "<project>\n  <modules>\n    <module>api</module>\n    <module>app</module>\n  </modules>\n</project>\n",
    )
    .expect("write root pom");

    let api_pkg = root.join("api/src/main/java/com/demo/api");
    let app_pkg = root.join("app/src/main/java/com/demo/app");
    std::fs::create_dir_all(&api_pkg).expect("create api pkg");
    std::fs::create_dir_all(&app_pkg).expect("create app pkg");

    std::fs::write(
        api_pkg.join("ItemKind.java"),
        "package com.demo.api;\n\npublic enum ItemKind {\n    SENSOR,\n    ACTUATOR\n}\n",
    )
    .expect("write enum");
    std::fs::write(
        api_pkg.join("PageData.java"),
        r#"
package com.demo.api;

public class PageData {
    private long totalElements;
    private ItemKind kind;

    public long getTotalElements() { return totalElements; }
    public ItemKind getKind() { return kind; }
}
"#,
    )
    .expect("write dto");
    std::fs::write(
        app_pkg.join("PageController.java"),
        r#"
package com.demo.app;

import com.demo.api.PageData;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/page")
public class PageController {
    @GetMapping
    public PageData page() { return new PageData(); }
}
"#,
    )
    .expect("write controller");
    root
}

#[test]
fn test_types_declared_in_a_sibling_module_resolve_instead_of_staying_unknown() {
    let root = multi_module_fixture("multimod");
    let app_src = root.join("app/src/main/java");

    let extractor = JavaRouteExtractor::new(root.clone(), &app_src).expect("extractor");
    let (payload, _) = extractor.extract_payload("app");

    let body = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/page"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .and_then(|e| e.body.as_ref())
        .unwrap_or_else(|| panic!("RESPONSE /api/page must exist"));

    let contract_core::ir::WireType::Ref(reference) = body else {
        panic!("a DTO declared in a sibling module must resolve to a Ref, got {body:?}");
    };
    assert_eq!(reference.r#ref, "java:com.demo.api.PageData");

    let pool = payload
        .type_pool
        .expect("pool holding the sibling-module DTO");
    let contract_core::ir::WireType::Object(page) = &pool["java:com.demo.api.PageData"] else {
        panic!(
            "PageData must be interned as an Object, got {:?}",
            &pool["java:com.demo.api.PageData"]
        );
    };
    let names: Vec<String> = page
        .properties
        .iter()
        .map(|p| p.wire_name.clone())
        .collect();
    assert_eq!(names, vec!["totalElements".to_string(), "kind".to_string()]);

    let kind = page
        .properties
        .iter()
        .find(|p| p.wire_name == "kind")
        .expect("kind property")
        .r#type
        .clone();
    let contract_core::ir::WireType::Ref(kind_ref) = kind else {
        panic!("an enum declared in a sibling module must resolve, got {kind:?}");
    };
    assert_eq!(kind_ref.r#ref, "java:com.demo.api.ItemKind");
    let contract_core::ir::WireType::Enum(en) = &pool["java:com.demo.api.ItemKind"] else {
        panic!(
            "ItemKind must be interned as an Enum, got {:?}",
            &pool["java:com.demo.api.ItemKind"]
        );
    };
    let values: Vec<&str> = en.values.iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(values, vec!["SENSOR", "ACTUATOR"]);
}

#[test]
fn test_controller_in_an_excluded_module_is_blocked_not_silently_dropped() {
    let root = multi_module_fixture("excluded");
    let api_src = root.join("api/src/main/java");
    std::fs::write(
        api_src.join("com/demo/api/ReportController.java"),
        r#"
package com.demo.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/report")
public class ReportController {
    @GetMapping
    public PageData report() { return new PageData(); }
}
"#,
    )
    .expect("write module controller");

    let app_src = root.join("app/src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &app_src).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("app");

    let routes: Vec<&str> = payload
        .endpoints
        .iter()
        .map(|e| e.identity.normalized_route.raw_path.as_str())
        .collect();
    assert!(
        !routes.contains(&"/api/report"),
        "a module that is not the served endpoint root must not contribute endpoints: {routes:?}"
    );
    assert!(
        !completeness.complete,
        "an artifact whose endpoint set covers only part of the repository must not claim completeness"
    );

    let blocker = completeness
        .blockers
        .iter()
        .find(|b| b.code == "JAVA_ENDPOINT_ROOT_EXCLUDES_MODULE")
        .unwrap_or_else(|| {
            panic!(
                "unexpected blockers: {:?}",
                completeness
                    .blockers
                    .iter()
                    .map(|b| b.code.as_str())
                    .collect::<Vec<_>>()
            )
        });
    assert!(
        blocker.message.contains("api/src/main/java")
            && blocker.message.contains("ReportController"),
        "the blocker must name the excluded root and what it holds, got: {}",
        blocker.message
    );
    assert!(
        blocker.message.contains("app/src/main/java"),
        "and the root whose endpoints are in scope, got: {}",
        blocker.message
    );
    assert_eq!(
        completeness
            .blockers
            .iter()
            .filter(|b| b.code == "JAVA_ENDPOINT_ROOT_EXCLUDES_MODULE")
            .count(),
        1,
        "one aggregate blocker per excluded root, never one per class"
    );
}

/// Maven and Gradle copy annotated and generated sources under the module output directory, and
/// they carry the same fully-qualified names as the hand-written ones. Indexing them lets a
/// generated shadow replace the declaration a developer can read.
#[test]
fn test_generated_and_build_output_directories_are_never_indexed() {
    let root = std::env::temp_dir().join(format!("sajimora-generated-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_pkg = root.join("src/main/java/com/demo");
    let gen_pkg = root.join("target/generated-sources/annotations/com/demo");
    std::fs::create_dir_all(&src_pkg).expect("create src pkg");
    std::fs::create_dir_all(&gen_pkg).expect("create gen pkg");

    std::fs::write(
        src_pkg.join("Widget.java"),
        "package com.demo;\npublic class Widget {\n    private String name;\n    public String getName() { return name; }\n}\n",
    )
    .expect("write dto");
    std::fs::write(
        gen_pkg.join("Widget.java"),
        "package com.demo;\npublic class Widget {\n    private String name;\n    private Boolean generatedFlag;\n    public String getName() { return name; }\n    public Boolean getGeneratedFlag() { return generatedFlag; }\n}\n",
    )
    .expect("write generated copy");
    std::fs::write(
        src_pkg.join("WidgetController.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/widget")
public class WidgetController {
    @GetMapping
    public Widget widget() { return new Widget(); }
}
"#,
    )
    .expect("write controller");

    // The `--java-root <module>` shape: the scan walk starts at the module, so it meets both
    // copies of the same class name.
    let extractor = JavaRouteExtractor::new(root.clone(), &root).expect("extractor");
    let (payload, _) = extractor.extract_payload("gen");

    let pool = payload.type_pool.expect("pool with Widget");
    let contract_core::ir::WireType::Object(widget) = &pool["java:com.demo.Widget"] else {
        panic!(
            "Widget must be interned as an Object, got {:?}",
            &pool["java:com.demo.Widget"]
        );
    };
    let names: Vec<String> = widget
        .properties
        .iter()
        .map(|p| p.wire_name.clone())
        .collect();
    assert_eq!(
        names,
        vec!["name".to_string()],
        "the build output copy of a class must not redefine the wire shape"
    );
    assert_eq!(
        payload
            .endpoints
            .iter()
            .filter(|e| e.identity.normalized_route.raw_path == "/api/widget")
            .count(),
        1,
        "a generated copy must not register the controller a second time"
    );
}

/// Single-module repositories are the majority of what the tool sees, and their sealed digests
/// must survive a change that only ever adds sibling-module roots.
#[test]
fn test_a_single_module_repo_indexes_only_its_own_root_and_adds_no_blocker() {
    let root = std::env::temp_dir().join(format!("sajimora-singlemod-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&src).expect("create pkg");
    std::fs::write(
        src.join("SingleController.java"),
        r#"
package com.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/single")
public class SingleController {
    @GetMapping
    public String single() { return "ok"; }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &src).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("single");

    assert_eq!(payload.endpoints.len(), 1);
    assert!(
        completeness.complete,
        "unexpected blockers: {:?}",
        completeness
            .blockers
            .iter()
            .map(|b| format!("{}: {}", b.code, b.message))
            .collect::<Vec<_>>()
    );
}

#[test]
fn test_a_gradle_include_adds_the_declared_module_root() {
    let root = std::env::temp_dir().join(format!("sajimora-gradle-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create repo root");
    std::fs::write(
        root.join("settings.gradle"),
        "rootProject.name = 'demo'\ninclude ':api', ':app'\n",
    )
    .expect("write settings");
    let api_pkg = root.join("api/src/main/java/com/demo/api");
    let app_pkg = root.join("app/src/main/java/com/demo/app");
    std::fs::create_dir_all(&api_pkg).expect("create api pkg");
    std::fs::create_dir_all(&app_pkg).expect("create app pkg");
    std::fs::write(
        api_pkg.join("Bundle.java"),
        "package com.demo.api;\npublic class Bundle {\n    private String label;\n    public String getLabel() { return label; }\n}\n",
    )
    .expect("write dto");
    std::fs::write(
        app_pkg.join("BundleController.java"),
        r#"
package com.demo.app;

import com.demo.api.Bundle;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/bundle")
public class BundleController {
    @GetMapping
    public Bundle bundle() { return new Bundle(); }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &app_pkg).expect("extractor");
    let (payload, _) = extractor.extract_payload("gradle");

    let body = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/bundle"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .and_then(|e| e.body.as_ref())
        .expect("RESPONSE /api/bundle");
    let contract_core::ir::WireType::Ref(reference) = body else {
        panic!("a module named only in settings.gradle must be indexed, got {body:?}");
    };
    assert_eq!(reference.r#ref, "java:com.demo.api.Bundle");
}

/// A nested checkout is a separate repository, and a directory scan cannot tell them apart. The
/// cost is measured: one corpus copy of this tool's own repository holds 1,677 `src/main/java`
/// directories under `artifacts/` and `scratch/`, and indexing them turned a test run into 29
/// minutes of parsing other people's source.
#[test]
fn test_an_undeclared_nested_checkout_is_not_indexed_as_a_module() {
    let root = std::env::temp_dir().join(format!("sajimora-vendored-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create repo root");
    std::fs::write(
        root.join("pom.xml"),
        "<project>\n  <modules>\n    <module>app</module>\n  </modules>\n</project>\n",
    )
    .expect("write root pom");
    let app_pkg = root.join("app/src/main/java/com/demo/app");
    let vendored_pkg = root.join("vendor/other/src/main/java/com/demo/other");
    std::fs::create_dir_all(&app_pkg).expect("create app pkg");
    std::fs::create_dir_all(&vendored_pkg).expect("create vendored pkg");
    std::fs::write(
        vendored_pkg.join("Bundle.java"),
        "package com.demo.other;\npublic class Bundle {\n    private String label;\n}\n",
    )
    .expect("write vendored dto");
    std::fs::write(
        app_pkg.join("BundleController.java"),
        r#"
package com.demo.app;

import com.demo.other.Bundle;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/bundle")
public class BundleController {
    @GetMapping
    public Bundle bundle() { return new Bundle(); }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &app_pkg).expect("extractor");
    let (payload, _) = extractor.extract_payload("vendored");

    let body = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/bundle"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .and_then(|e| e.body.as_ref())
        .expect("RESPONSE /api/bundle");
    assert!(
        matches!(body, contract_core::ir::WireType::Unknown(_)),
        "an undeclared directory must not be pulled into the type index, got {body:?}"
    );
    let routes: Vec<&str> = payload
        .endpoints
        .iter()
        .map(|e| e.identity.normalized_route.raw_path.as_str())
        .collect();
    assert_eq!(
        routes,
        vec!["/api/bundle"],
        "the vendored checkout contributes neither endpoints nor types"
    );
}

/// Task #57: A `--java-root <module>` flag pointing to a module directory must not index
/// `src/test/java`, and must produce the exact same type pool and endpoint set as pointing
/// directly to `<module>/src/main/java`.
#[test]
fn test_task_57_module_root_excludes_test_sources_and_matches_src_main_java_spelling() {
    let root = std::env::temp_dir().join(format!("sajimora-task57-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create repo root");
    std::fs::write(
        root.join("pom.xml"),
        "<project>\n  <modules>\n    <module>app</module>\n  </modules>\n</project>\n",
    )
    .expect("write root pom");

    let app_main = root.join("app/src/main/java/com/demo/app");
    let app_test = root.join("app/src/test/java/com/demo/app");
    std::fs::create_dir_all(&app_main).expect("create app main");
    std::fs::create_dir_all(&app_test).expect("create app test");

    std::fs::write(
        app_main.join("AppDto.java"),
        "package com.demo.app;\npublic class AppDto {\n    private String id;\n    public String getId() { return id; }\n}\n",
    )
    .expect("write main dto");

    std::fs::write(
        app_main.join("AppController.java"),
        r#"
package com.demo.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/app")
public class AppController {
    @GetMapping
    public AppDto getApp() { return new AppDto(); }
}
"#,
    )
    .expect("write main controller");

    std::fs::write(
        app_test.join("TestFixture.java"),
        "package com.demo.app;\npublic class TestFixture {\n    private String testToken;\n    public String getTestToken() { return testToken; }\n}\n",
    )
    .expect("write test fixture");

    std::fs::write(
        app_test.join("TestController.java"),
        r#"
package com.demo.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/test-fixture")
public class TestController {
    @GetMapping
    public TestFixture getFixture() { return new TestFixture(); }
}
"#,
    )
    .expect("write test controller");

    // Extraction 1: pointing to the module root `app`
    let extractor_module =
        JavaRouteExtractor::new(root.clone(), &root.join("app")).expect("extractor module");
    let (payload_module, _) = extractor_module.extract_payload("app-service");

    // Extraction 2: pointing to `app/src/main/java`
    let extractor_src_main = JavaRouteExtractor::new(root.clone(), &root.join("app/src/main/java"))
        .expect("extractor src_main");
    let (payload_src_main, _) = extractor_src_main.extract_payload("app-service");

    // 1. Neither payload must contain the test controller endpoint
    for payload in [&payload_module, &payload_src_main] {
        assert!(
            !payload
                .endpoints
                .iter()
                .any(|e| e.identity.normalized_route.raw_path == "/api/test-fixture"),
            "endpoints must never include test controllers from src/test/java"
        );
        assert_eq!(
            payload
                .endpoints
                .iter()
                .filter(|e| e.identity.normalized_route.raw_path == "/api/app")
                .count(),
            1,
            "main controller must be present"
        );
    }

    // 2. Neither payload's type pool must contain the test fixture class
    for payload in [&payload_module, &payload_src_main] {
        if let Some(pool) = &payload.type_pool {
            assert!(
                !pool.contains_key("java:com.demo.app.TestFixture"),
                "type pool must never contain test classes from src/test/java"
            );
            assert!(
                pool.contains_key("java:com.demo.app.AppDto"),
                "production AppDto must be in type pool"
            );
        }
    }

    // 3. Both spellings must yield byte-identical endpoints and type pool keys
    assert_eq!(payload_module.endpoints, payload_src_main.endpoints);
    assert_eq!(
        payload_module
            .type_pool
            .as_ref()
            .map(|p| p.keys().collect::<Vec<_>>()),
        payload_src_main
            .type_pool
            .as_ref()
            .map(|p| p.keys().collect::<Vec<_>>()),
        "both flag spellings must yield the exact same type pool keys"
    );
}

const ACCOUNT_CONTROLLER: &str = r#"
package demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {
    @GetMapping("/api/accounts")
    public AccountDto list() {
        return new AccountDto();
    }
}
"#;

const ACCOUNT_DTO: &str = r#"
package demo;

public class AccountDto {
    public String lastName;
}
"#;

fn account_sources() -> Vec<(String, String)> {
    vec![
        (
            "src/main/java/demo/AccountController.java".to_string(),
            ACCOUNT_CONTROLLER.to_string(),
        ),
        (
            "src/main/java/demo/AccountDto.java".to_string(),
            ACCOUNT_DTO.to_string(),
        ),
    ]
}

/// The properties a response body publishes, following a `Ref` into the type pool. Whether a DTO
/// is inlined or referenced is an extractor detail; the naming strategy applies either way.
fn published_wire_names(
    payload: &contract_core::envelope::BackendContractPayload,
    body: &contract_core::ir::WireType,
) -> Vec<String> {
    let resolved = match body {
        contract_core::ir::WireType::Object(_) => body.clone(),
        contract_core::ir::WireType::Ref(reference) => payload
            .type_pool
            .as_ref()
            .expect("a referenced body must ship a type pool")
            .get(&reference.r#ref)
            .unwrap_or_else(|| panic!("{} must be in the type pool", reference.r#ref))
            .clone(),
        other => panic!("AccountDto must expand to an Object, got {other:?}"),
    };
    let contract_core::ir::WireType::Object(obj) = &resolved else {
        panic!("AccountDto must expand to an Object, got {resolved:?}");
    };
    obj.properties.iter().map(|p| p.wire_name.clone()).collect()
}

/// The wire names the `/api/accounts` response publishes, every blocker raised against it, and
/// whether the artifact still claims completeness.
fn account_contract(
    config: ConfigInputs,
) -> (
    Vec<String>,
    Vec<contract_core::envelope::ArtifactBlocker>,
    bool,
) {
    let extractor =
        JavaRouteExtractor::from_blobs(Path::new(".").to_path_buf(), account_sources(), config)
            .expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");
    let body = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/accounts"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("accounts response endpoint")
        .body
        .clone()
        .expect("accounts response body");
    (
        published_wire_names(&payload, &body),
        completeness.blockers.clone(),
        completeness.complete,
    )
}

/// The same extraction, narrowed to the naming blocker the wire names depend on.
fn account_naming(config: ConfigInputs) -> (Vec<String>, Option<String>, bool) {
    let (names, blockers, complete) = account_contract(config);
    let blocker = blockers
        .iter()
        .find(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED")
        .map(|b| b.message.clone());
    (names, blocker, complete)
}

#[test]
fn test_slice_envelope_omits_page_totals() {
    let controller = r#"
package demo;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Slice;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PagingController {
    @GetMapping("/api/page")
    public Page<UserDto> page() {
        return null;
    }

    @GetMapping("/api/slice")
    public Slice<UserDto> slice() {
        return null;
    }
}
"#;
    let dto = r#"
package demo;

public class UserDto {
    public String lastName;
}
"#;
    let extractor = JavaRouteExtractor::from_blobs(
        Path::new(".").to_path_buf(),
        vec![
            (
                "src/main/java/demo/PagingController.java".to_string(),
                controller.to_string(),
            ),
            (
                "src/main/java/demo/UserDto.java".to_string(),
                dto.to_string(),
            ),
        ],
        ConfigInputs::default(),
    )
    .expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");
    assert!(completeness.complete, "{:?}", completeness.blockers);

    let envelope = |route: &str| -> (Option<String>, Vec<String>) {
        let body = payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.normalized_route.raw_path == route
                    && e.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .unwrap_or_else(|| panic!("{route} response endpoint must exist"))
            .body
            .clone()
            .unwrap_or_else(|| panic!("{route} response body must be resolved"));
        let contract_core::ir::WireType::Object(obj) = &body else {
            panic!("{route} must expand to an Object, got {body:?}");
        };
        (
            obj.name.clone(),
            obj.properties
                .iter()
                .map(|p| p.wire_name.clone())
                .collect::<Vec<_>>(),
        )
    };

    let (page_name, page_props) = envelope("/api/page");
    assert_eq!(page_name.as_deref(), Some("Page<UserDto>"));
    for required in [
        "content",
        "totalPages",
        "totalElements",
        "size",
        "number",
        "first",
        "last",
        "numberOfElements",
        "empty",
    ] {
        assert!(
            page_props.iter().any(|name| name == required),
            "Page must publish `{required}`, got {page_props:?}"
        );
    }

    let (slice_name, slice_props) = envelope("/api/slice");
    assert_eq!(slice_name.as_deref(), Some("Slice<UserDto>"));
    for required in [
        "content",
        "size",
        "number",
        "first",
        "last",
        "numberOfElements",
        "empty",
    ] {
        assert!(
            slice_props.iter().any(|name| name == required),
            "Slice must publish `{required}`, got {slice_props:?}"
        );
    }
    // A Slice is an uncounted window: Spring Data cannot compute a total for it, so neither field
    // reaches the wire. Publishing them would certify a consumer reading `$.totalElements` against
    // an endpoint that never emits it.
    for absent in ["totalPages", "totalElements"] {
        assert!(
            !slice_props.iter().any(|name| name == absent),
            "Slice must not fabricate `{absent}`, got {slice_props:?}"
        );
    }
}

#[test]
fn test_yaml_jackson_naming_strategy_is_inherited() {
    let yaml = |body: &str| {
        account_naming(ConfigInputs::single(
            "src/main/resources/application.yml",
            body,
        ))
    };

    let snake = |document: &str, label: &str| {
        let (names, blocker, complete) = yaml(document);
        assert!(
            blocker.is_none(),
            "{label} must not be blocked: {blocker:?}"
        );
        assert!(complete, "{label} must stay complete");
        assert_eq!(names, vec!["last_name".to_string()], "{label}");
    };

    snake(
        "spring:\n  jackson:\n    property-naming-strategy: SNAKE_CASE\n",
        "nested SNAKE_CASE",
    );
    snake(
        "spring:\n  jackson:\n    property-naming-strategy: \"SNAKE_CASE\"  # agreed in review\n",
        "quoted value carrying an inline comment",
    );
    snake(
        "spring:\n  jackson:\n    propertyNamingStrategy: SNAKE_CASE\n",
        "camelCase key spelling",
    );
    snake(
        "spring:\n  jackson:\n    property-naming-strategy : SNAKE_CASE\n",
        "whitespace between the key and its colon",
    );
    snake(
        "spring:\n  jackson:\n    property-naming-strategy: com.fasterxml.jackson.databind.PropertyNamingStrategies$SnakeCaseStrategy\n",
        "class form of the same strategy",
    );

    let (names, blocker, complete) =
        yaml("spring:\n  jackson:\n    property-naming-strategy: LOWER_CAMEL_CASE\n");
    assert!(
        blocker.is_none(),
        "Jackson's own name for its default must not be blocked: {blocker:?}"
    );
    assert!(complete);
    assert_eq!(names, vec!["lastName".to_string()]);

    // A strategy name in a comment is not configuration. A whole-document substring scan would
    // either inherit it or raise a blocker the project never configured.
    let (names, blocker, complete) = yaml(
        "# spring.jackson.property-naming-strategy: KEBAB_CASE was rejected by the platform team\nspring:\n  application:\n    name: demo\n",
    );
    assert!(
        blocker.is_none(),
        "a commented-out strategy must not block: {blocker:?}"
    );
    assert!(complete);
    assert_eq!(names, vec!["lastName".to_string()]);

    // A key that merely starts with the same prefix is a different setting, so it must not be read
    // as the strategy. It is still an unmodelled `spring.jackson.*` setting: Spring Boot would
    // reject it as unknown rather than let it rename anything, so the honest outcome is camelCase
    // names with completeness withdrawn.
    let (names, blockers, complete) = account_contract(ConfigInputs::single(
        "src/main/resources/application.yml",
        "spring:\n  jackson:\n    property-naming-strategy-override: KEBAB_CASE\n",
    ));
    assert!(
        !blockers
            .iter()
            .any(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED"),
        "a similarly named key must not be read as the strategy: {blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|b| b.code == "UNSUPPORTED_JACKSON_FEATURE"
                && b.message.contains("property-naming-strategy-override")),
        "an unmodelled spring.jackson setting must be named in a blocker: {blockers:?}"
    );
    assert!(
        !complete,
        "an unmodelled Jackson setting must withdraw completeness"
    );
    assert_eq!(names, vec!["lastName".to_string()]);

    for (document, expected) in [
        (
            "spring:\n  jackson:\n    property-naming-strategy: KEBAB_CASE\n",
            "KEBAB_CASE",
        ),
        (
            "spring:\n  jackson:\n    property-naming-strategy: com.acme.LegacyNaming\n",
            "com.acme.LegacyNaming",
        ),
        (
            "spring:\n  jackson:\n    property-naming-strategy:\n",
            "<no value on the same line>",
        ),
    ] {
        let (names, blocker, complete) = yaml(document);
        let message = blocker.unwrap_or_else(|| {
            panic!("{expected} would produce wrong wire names and must not pass as camelCase")
        });
        assert!(
            message.contains(expected),
            "the blocker must name the strategy it could not model: {message}"
        );
        assert!(
            !complete,
            "an unmodelled naming strategy must not claim completeness"
        );
        assert_eq!(
            names,
            vec!["lastName".to_string()],
            "identity names plus a blocker, never a guessed transform"
        );
    }
}

#[test]
fn test_properties_config_wins_over_yaml_in_the_same_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/demo");
    let resources = repo_root.join("src/main/resources");
    std::fs::create_dir_all(&src_dir).expect("create source dir");
    std::fs::create_dir_all(&resources).expect("create resources dir");
    std::fs::write(src_dir.join("AccountController.java"), ACCOUNT_CONTROLLER)
        .expect("write controller");
    std::fs::write(src_dir.join("AccountDto.java"), ACCOUNT_DTO).expect("write dto");
    std::fs::write(
        resources.join("application.properties"),
        "spring.jackson.property-naming-strategy=SNAKE_CASE\n",
    )
    .expect("write properties");
    std::fs::write(
        resources.join("application.yml"),
        "spring:\n  jackson:\n    property-naming-strategy: KEBAB_CASE\n",
    )
    .expect("write yaml");

    // Spring Boot resolves `application.properties` ahead of `application.yml` in the same
    // location, so a strategy in a shadowed YAML file must not raise a blocker.
    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");
    assert!(
        !completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED"),
        "the properties file governs, so the shadowed YAML strategy must not block: {:?}",
        completeness.blockers
    );
    let body = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/accounts"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("accounts response endpoint")
        .body
        .clone()
        .expect("accounts response body");
    assert_eq!(
        published_wire_names(&payload, &body),
        vec!["last_name".to_string()],
        "the properties file must govern the wire names"
    );

    // With the properties file gone the YAML becomes the governing document and must fail closed.
    std::fs::remove_file(resources.join("application.properties")).expect("remove properties");
    let extractor = JavaRouteExtractor::new(repo_root, &src_dir).expect("extractor");
    let (_, completeness) = extractor.extract_payload("demo-service");
    let blocker = completeness
        .blockers
        .iter()
        .find(|b| b.code == "JAVA_NAMING_STRATEGY_UNSUPPORTED")
        .expect("a KEBAB_CASE application.yml must fail closed once it governs");
    assert!(
        blocker.message.contains("KEBAB_CASE"),
        "the blocker must name the strategy: {}",
        blocker.message
    );
    assert!(
        blocker
            .file
            .as_deref()
            .unwrap_or_default()
            .contains("application.yml"),
        "the blocker must name the governing file: {:?}",
        blocker.file
    );
}

/// Configuration that relocates, conditions or obscures the effective Jackson settings.
///
/// None of these can be resolved from a static snapshot, so each has to withdraw completeness
/// instead of letting Jackson's camelCase default be certified by silence. Every case names what
/// it could not resolve: a blocker that only says "unknown" gives nobody a way to fix it.
#[test]
fn test_unresolvable_spring_configuration_fails_closed() {
    let cases: &[(&str, &str, &str, &str)] = &[
        (
            "src/main/resources/application.yml",
            "spring:\n  config:\n    import: classpath:extra.yml\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "spring.config.import",
        ),
        (
            "src/main/resources/application.properties",
            "spring.config.name=thingsboard\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "spring.config.name",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  profiles:\n    active: prod\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "spring.profiles.active",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  config:\n    activate:\n      on-profile: prod\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "spring.config.activate.on-profile",
        ),
        // A value carried in from elsewhere in the document is not on the line declaring it.
        (
            "src/main/resources/application.yml",
            "defaults: &defaults\n  property-naming-strategy: SNAKE_CASE\nspring:\n  jackson: *defaults\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "alias",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  jackson:\n    <<: *shared\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "merge key",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  jackson: {property-naming-strategy: SNAKE_CASE}\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "flow collection",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  application:\n    name: demo\n---\nserver:\n  port: 8081\n",
            "UNRESOLVED_JACKSON_CONFIG",
            "more than one YAML document",
        ),
        // Settings that change which properties serialize, not only what they are called.
        (
            "src/main/resources/application.yml",
            "spring:\n  jackson:\n    default-property-inclusion: non_null\n",
            "UNSUPPORTED_JACKSON_FEATURE",
            "spring.jackson.default-property-inclusion",
        ),
        (
            "src/main/resources/application.properties",
            "spring.jackson.serialization.fail-on-empty-beans=false\n",
            "UNSUPPORTED_JACKSON_FEATURE",
            "spring.jackson.serialization.fail-on-empty-beans",
        ),
        (
            "src/main/resources/application.yml",
            "spring:\n  jackson:\n    visibility:\n      getter: PUBLIC_ONLY\n",
            "UNSUPPORTED_JACKSON_FEATURE",
            "spring.jackson.visibility.getter",
        ),
    ];

    for (label, document, code, expected) in cases {
        let (names, blockers, complete) = account_contract(ConfigInputs::single(label, document));
        let hit = blockers
            .iter()
            .find(|b| b.code == *code)
            .unwrap_or_else(|| panic!("{label} must raise {code}: {blockers:?}"));
        assert!(
            hit.message.contains(expected),
            "the blocker must name what it could not resolve: {}",
            hit.message
        );
        assert!(
            !complete,
            "{label} must not claim completeness: {blockers:?}"
        );
        assert_eq!(
            names,
            vec!["lastName".to_string()],
            "unresolved configuration must fall back to identity names, never a guessed transform: {label}"
        );
    }

    // A second YAML document is selected by profile at runtime, so a readable strategy in it must
    // not be applied as though it governed.
    let (_, blockers, complete) = account_contract(ConfigInputs::single(
        "src/main/resources/application.yml",
        "spring:\n  application:\n    name: demo\n---\nspring:\n  jackson:\n    property-naming-strategy: SNAKE_CASE\n",
    ));
    assert!(
        blockers.iter().any(|b| {
            b.code == "UNRESOLVED_JACKSON_CONFIG"
                && b.message.contains("more than one YAML document")
        }),
        "a profile-selected document must block even when its key is readable: {blockers:?}"
    );
    assert!(!complete);

    // A profile-specific file beside the governing one cannot be selected statically.
    let (_, blockers, complete) = account_contract(ConfigInputs {
        files: vec![(
            "src/main/resources/application.properties".to_string(),
            "spring.jackson.property-naming-strategy=SNAKE_CASE\n".to_string(),
        )],
        profile_files: vec!["src/main/resources/application-prod.yml".to_string()],
        ..ConfigInputs::default()
    });
    assert!(
        blockers.iter().any(|b| {
            b.code == "UNRESOLVED_JACKSON_CONFIG"
                && b.file.as_deref() == Some("src/main/resources/application-prod.yml")
        }),
        "a profile document must be reported against its own path: {blockers:?}"
    );
    assert!(!complete);
}

/// The mirror image of the test above: configuration that is fully resolved must stay certified.
///
/// Over-blocking is a defect too — a tool that fails closed on everything is indistinguishable
/// from one that is broken, and nobody ships it.
#[test]
fn test_resolved_spring_configuration_stays_certified() {
    let cases: &[(&str, &str)] = &[
        // A leading document separator only opens the one document that follows it.
        (
            "---\nspring:\n  jackson:\n    property-naming-strategy: SNAKE_CASE\n",
            "last_name",
        ),
        // Relaxed binding: Spring Boot accepts the flattened spelling in YAML too.
        (
            "spring.jackson.property-naming-strategy: SNAKE_CASE\n",
            "last_name",
        ),
        // Unrelated configuration that happens to mention a strategy name.
        (
            "docs:\n  rejected-strategy: KEBAB_CASE\nspring:\n  application:\n    name: demo\n",
            "lastName",
        ),
        // A project key spelled like the Jackson one, but not under `spring.jackson`, must not be
        // read as the strategy: inheriting it would invent snake_case wire names.
        (
            "myapp:\n  property-naming-strategy: SNAKE_CASE\n",
            "lastName",
        ),
        // A glob under an unrelated key is not a YAML alias.
        ("logging:\n  pattern:\n    file: \"**/*.log\"\n", "lastName"),
    ];
    for (document, expected) in cases {
        let (names, blockers, complete) = account_contract(ConfigInputs::single(
            "src/main/resources/application.yml",
            document,
        ));
        assert!(
            blockers.is_empty(),
            "{document:?} is fully resolved and must not block: {blockers:?}"
        );
        assert!(complete, "{document:?} must stay certified");
        assert_eq!(
            names,
            vec![expected.to_string()],
            "only spring.jackson.property-naming-strategy may change the wire names: {document:?}"
        );
    }

    // The properties spelling of the same setting resolves identically.
    let (names, blockers, complete) = account_contract(ConfigInputs::single(
        "src/main/resources/application.properties",
        "spring.jackson.property-naming-strategy=SNAKE_CASE\n",
    ));
    assert!(blockers.is_empty(), "{blockers:?}");
    assert!(complete);
    assert_eq!(names, vec!["last_name".to_string()]);
}

/// Lombok rewrites the accessors Jackson infers property names from, and this extractor reads the
/// declared fields rather than the generated methods, so an accessor rule it cannot see has to
/// fail closed.
#[test]
fn test_lombok_configuration_governs_accessors_or_blocks() {
    let blocked = [
        "lombok.accessors.chain = true\n",
        "lombok.accessors.fluent=true\n",
        "lombok.accessors.prefix += m\n",
        "lombok.fieldDefaults.defaultPrivate = true\n",
    ];
    for content in blocked {
        let (_, blockers, complete) = account_contract(ConfigInputs {
            lombok: Some(("lombok.config".to_string(), content.to_string())),
            ..ConfigInputs::default()
        });
        let hit = blockers
            .iter()
            .find(|b| b.code == "UNSUPPORTED_LOMBOK_ACCESSOR")
            .unwrap_or_else(|| {
                panic!("{content:?} changes the accessors and must block: {blockers:?}")
            });
        assert!(
            hit.file.as_deref() == Some("lombok.config"),
            "the blocker must name the file: {:?}",
            hit.file
        );
        assert!(!complete, "{content:?} must not claim completeness");
    }

    // Lombok settings that leave the wire alone. Blocking on these would report a defect the
    // project does not have, and would fail on repositories that only scope their Lombok config.
    let allowed = [
        "",
        "# no settings\n",
        "config.stopbubbling = true\nlombok.anyconstructor.addconstructorproperties = true\nlombok.copyableAnnotations += org.springframework.context.annotation.Lazy\n",
        "lombok.log.fieldName = log\n",
    ];
    for content in allowed {
        let (_, blockers, complete) = account_contract(ConfigInputs {
            lombok: Some(("lombok.config".to_string(), content.to_string())),
            ..ConfigInputs::default()
        });
        assert!(
            blockers.is_empty(),
            "{content:?} does not touch the wire and must not block: {blockers:?}"
        );
        assert!(complete, "{content:?} must stay certified");
    }
}

/// A mapper configured in Java overrides whatever the configuration file declares, so it has to
/// block. A mapper merely used to read or write a payload does not, and blocking on the type name
/// would flag every service that logs JSON.
#[test]
fn test_java_mapper_configuration_fails_closed_but_usage_does_not() {
    let configure = |body: &str| {
        let sources = vec![
            (
                "src/main/java/demo/AccountController.java".to_string(),
                ACCOUNT_CONTROLLER.to_string(),
            ),
            (
                "src/main/java/demo/AccountDto.java".to_string(),
                ACCOUNT_DTO.to_string(),
            ),
            (
                "src/main/java/demo/MapperConfig.java".to_string(),
                body.to_string(),
            ),
        ];
        let extractor = JavaRouteExtractor::from_blobs(
            Path::new(".").to_path_buf(),
            sources,
            ConfigInputs::default(),
        )
        .expect("extractor");
        let (_, completeness) = extractor.extract_payload("demo-service");
        completeness
    };

    let blocked = [
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    ObjectMapper mapper() {\n        ObjectMapper m = new ObjectMapper();\n        m.setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);\n        return m;\n    }\n}\n",
        "package demo;\nimport org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;\npublic class MapperConfig implements Jackson2ObjectMapperBuilderCustomizer {\n    public void customize(org.springframework.http.converter.json.Jackson2ObjectMapperBuilder builder) {\n        builder.propertyNamingStrategy(com.fasterxml.jackson.databind.PropertyNamingStrategies.SNAKE_CASE);\n    }\n}\n",
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    void tune(ObjectMapper mapper) {\n        mapper.setVisibility(com.fasterxml.jackson.annotation.PropertyAccessor.FIELD, com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.ANY);\n    }\n}\n",
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    void tune(ObjectMapper mapper) {\n        mapper.addMixIn(AccountDto.class, AccountMixin.class);\n    }\n}\n",
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    void tune(ObjectMapper mapper) {\n        mapper.configure(com.fasterxml.jackson.databind.MapperFeature.USE_STD_BEAN_NAMING, true);\n    }\n}\n",
    ];
    for source in blocked {
        let completeness = configure(source);
        assert!(
            completeness
                .blockers
                .iter()
                .any(|b| b.code == "UNSUPPORTED_JACKSON_FEATURE"
                    && b.file.as_deref() == Some("src/main/java/demo/MapperConfig.java")),
            "a mapper that reconfigures the wire must block: {source}\n{:?}",
            completeness.blockers
        );
        assert!(!completeness.complete, "{source}");
    }

    let allowed = [
        // Plain usage: the type name is not evidence of a custom wire shape.
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    private final ObjectMapper mapper = new ObjectMapper();\n    String write(AccountDto dto) throws Exception {\n        return mapper.writeValueAsString(dto);\n    }\n}\n",
        // Property ordering is not a naming or visibility rule, so it cannot change the shape.
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class MapperConfig {\n    void tune(ObjectMapper mapper) {\n        mapper.configure(com.fasterxml.jackson.databind.MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true);\n    }\n}\n",
        // A commented-out setting is not one the service applies.
        "package demo;\npublic class MapperConfig {\n    // mapper.setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);\n    /* builder.setVisibility(...); */\n}\n",
        // An XML mapper for a different content type does not rename JSON properties.
        "package demo;\nimport org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;\npublic class MapperConfig {\n    Object xml() {\n        return Jackson2ObjectMapperBuilder.xml().build();\n    }\n}\n",
        // Registering a module on a private mapper changes a datatype, not the naming rule.
        "package demo;\nimport com.fasterxml.jackson.databind.ObjectMapper;\nimport com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;\npublic class MapperConfig {\n    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());\n}\n",
    ];
    for source in allowed {
        let completeness = configure(source);
        assert!(
            !completeness
                .blockers
                .iter()
                .any(|b| b.code == "UNSUPPORTED_JACKSON_FEATURE"),
            "{source}\nmust not block: {:?}",
            completeness.blockers
        );
        assert!(
            completeness.complete,
            "{source}\n{:?}",
            completeness.blockers
        );
    }
}

/// The working-tree scanner and the revision reader must agree about what configuration exists.
///
/// `configFingerprint` and the configuration blockers are both sealed into the artifact, so a mode
/// that saw a narrower set of documents would certify a commit the other mode refuses.
#[test]
fn test_config_audit_agrees_between_working_tree_and_blobs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/demo");
    let resources = repo_root.join("src/main/resources");
    std::fs::create_dir_all(&src_dir).expect("create source dir");
    std::fs::create_dir_all(&resources).expect("create resources dir");
    std::fs::write(src_dir.join("AccountController.java"), ACCOUNT_CONTROLLER)
        .expect("write controller");
    std::fs::write(src_dir.join("AccountDto.java"), ACCOUNT_DTO).expect("write dto");
    std::fs::write(
        resources.join("application.yml"),
        "spring:\n  config:\n    import: classpath:extra.yml\n  jackson:\n    default-property-inclusion: non_null\n",
    )
    .expect("write yaml");
    std::fs::write(
        resources.join("application-prod.yml"),
        "server:\n  port: 8081\n",
    )
    .expect("write profile yaml");
    std::fs::write(
        repo_root.join("lombok.config"),
        "config.stopbubbling = true\nlombok.accessors.chain = true\n",
    )
    .expect("write lombok config");

    let (_, working_tree) = JavaRouteExtractor::new(repo_root.clone(), &src_dir)
        .expect("extractor")
        .extract_payload("demo-service");

    let blob_inputs = ConfigInputs {
        files: vec![(
            "src/main/resources/application.yml".to_string(),
            std::fs::read_to_string(resources.join("application.yml")).expect("read yaml"),
        )],
        profile_files: vec!["src/main/resources/application-prod.yml".to_string()],
        lombok: Some((
            "lombok.config".to_string(),
            std::fs::read_to_string(repo_root.join("lombok.config")).expect("read lombok"),
        )),
    };
    let (_, blobs) = JavaRouteExtractor::from_blobs(repo_root, account_sources(), blob_inputs)
        .expect("blob extractor")
        .extract_payload("demo-service");

    assert!(!working_tree.complete, "{:?}", working_tree.blockers);
    let signature = |blockers: &[contract_core::envelope::ArtifactBlocker]| {
        let mut pairs: Vec<(String, String)> = blockers
            .iter()
            .map(|b| (b.code.clone(), b.message.clone()))
            .collect();
        pairs.sort();
        pairs
    };
    assert_eq!(
        signature(&working_tree.blockers),
        signature(&blobs.blockers),
        "the two modes must reach the same verdict from the same documents"
    );
    for code in [
        "UNRESOLVED_JACKSON_CONFIG",
        "UNSUPPORTED_JACKSON_FEATURE",
        "UNSUPPORTED_LOMBOK_ACCESSOR",
    ] {
        assert!(
            working_tree.blockers.iter().any(|b| b.code == code),
            "{code} must be raised by the working-tree scan: {:?}",
            working_tree.blockers
        );
    }
}

#[test]
fn test_composed_spring_mapping_and_alias_for() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    // 1. Custom composed annotation with @AliasFor mapping to RequestMapping path
    std::fs::write(
        src_dir.join("GetCustomMapping.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping(method = RequestMethod.GET)
public @interface GetCustomMapping {
    @AliasFor(annotation = RequestMapping.class, attribute = "path")
    String[] path() default {};
}
"#,
    )
    .unwrap();

    // 2. Controller using @GetCustomMapping
    std::fs::write(
        src_dir.join("CustomController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class CustomController {
    @GetCustomMapping(path = "/api/composed-endpoint")
    public String getComposed() {
        return "ok";
    }

    // Unrelated standard Spring endpoint should remain certified
    @org.springframework.web.bind.annotation.GetMapping("/api/standard-endpoint")
    public String getStandard() {
        return "standard";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Expected complete extraction, got blockers: {:?}",
        completeness.blockers
    );
    assert_eq!(completeness.blockers.len(), 0);

    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();

    assert!(
        routes.contains(&("GET".to_string(), "/api/composed-endpoint".to_string())),
        "Routes found: {:?}",
        routes
    );
    assert!(
        routes.contains(&("GET".to_string(), "/api/standard-endpoint".to_string())),
        "Routes found: {:?}",
        routes
    );
}

#[test]
fn test_class_level_composed_controller_with_hardcoded_base_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("ApiController.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@RestController
@RequestMapping("/api")
public @interface ApiController {
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("WidgetController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;

@ApiController
public class WidgetController {
    @GetMapping("/widgets")
    public String widgets() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Expected complete extraction, got blockers: {:?}",
        completeness.blockers
    );
    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    assert!(
        routes.contains(&("GET".to_string(), "/api/widgets".to_string())),
        "A controller marked by a composed stereotype annotation must not be silently dropped: {routes:?}"
    );
}

#[test]
fn test_class_level_composed_controller_uses_use_site_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("VersionedApi.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;
import org.springframework.web.bind.annotation.RequestMapping;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping
public @interface VersionedApi {
    @AliasFor(annotation = RequestMapping.class, attribute = "path")
    String[] value() default {};
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("OrderController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;

@VersionedApi("/v2")
public class OrderController {
    @GetMapping("/orders")
    public String orders() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Expected complete extraction, got blockers: {:?}",
        completeness.blockers
    );
    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    assert!(
        routes.contains(&("GET".to_string(), "/v2/orders".to_string())),
        "The use-site path of a composed type annotation must become the controller base path: {routes:?}"
    );
}

#[test]
fn test_composed_method_annotation_without_path_uses_its_declared_base_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("ComposedGet.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping(path = "/composed", method = RequestMethod.GET)
public @interface ComposedGet {
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("ComposedPathController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class ComposedPathController {
    @ComposedGet
    public String current() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Expected complete extraction, got blockers: {:?}",
        completeness.blockers
    );
    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    assert!(
        routes.contains(&("GET".to_string(), "/composed".to_string())),
        "An unparameterized composed method annotation must keep the path declared on its meta-annotation: {routes:?}"
    );
}

#[test]
fn test_unresolvable_class_level_controller_annotation_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("LegacyController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import com.external.LegacyController;

@LegacyController
public class InventoryController {
    @GetMapping("/inventory")
    public String inventory() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        !completeness.complete,
        "An unresolvable controller stereotype must not look complete"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_UNSUPPORTED_COMPOSED_MAPPING"),
        "Expected JAVA_UNSUPPORTED_COMPOSED_MAPPING, got: {:?}",
        completeness.blockers
    );
    assert!(
        payload.endpoints.is_empty(),
        "No endpoint may be invented for a type whose stereotype could not be resolved"
    );
}

#[test]
fn test_circular_class_level_composed_annotation_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("AnnA.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@AnnB
public @interface AnnA {
}
"#,
    )
    .unwrap();
    std::fs::write(
        src_dir.join("AnnB.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@AnnA
public @interface AnnB {
}
"#,
    )
    .unwrap();
    std::fs::write(
        src_dir.join("CircularController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;

@AnnA
public class CircularController {
    @GetMapping("/circular")
    public String circular() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(!completeness.complete);
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_UNSUPPORTED_COMPOSED_MAPPING"),
        "Expected a composed-annotation blocker, got: {:?}",
        completeness.blockers
    );
    assert!(payload.endpoints.is_empty());
}

#[test]
fn test_mapping_methods_on_a_non_controller_type_are_reported_not_dropped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("GeneratedAccountsApi.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;

public interface GeneratedAccountsApi {
    @GetMapping("/api/accounts")
    String listAccounts();
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (_payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        !completeness.complete,
        "An interface with HTTP method annotations but no controller stereotype must not look complete"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_MAPPING_ON_NON_CONTROLLER"),
        "Expected JAVA_MAPPING_ON_NON_CONTROLLER, got: {:?}",
        completeness.blockers
    );
}

#[test]
fn test_plain_in_repo_annotation_is_not_a_blocker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("Audited.java"),
        r#"
package com.example.demo;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface Audited {
}
"#,
    )
    .unwrap();
    std::fs::write(
        src_dir.join("AccountService.java"),
        r#"
package com.example.demo;

@Audited
public class AccountService {
    public String status() {
        return "ok";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (_payload, completeness) = extractor.extract_payload("demo-service");

    let controller_candidates: Vec<_> = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code != "JAVA_NO_PROVIDER_EVIDENCE")
        .collect();
    assert!(
        controller_candidates.is_empty(),
        "An ordinary in-repo annotation must not be treated as a controller candidate: {:?}",
        completeness.blockers
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "JAVA_NO_PROVIDER_EVIDENCE"),
        "a tree with no endpoint and no framework claim must not seal complete: {:?}",
        completeness.blockers
    );
    assert!(!completeness.complete);
}

#[test]
fn test_composed_mapping_circular_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    // Circular annotations: A -> B -> A
    std::fs::write(
        src_dir.join("AnnA.java"),
        r#"
package com.example.demo;

@AnnB
public @interface AnnA {
    String value() default "";
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("AnnB.java"),
        r#"
package com.example.demo;

@AnnA
public @interface AnnB {
    String value() default "";
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("BadController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class BadController {
    @AnnA("/api/bad")
    public String bad() {
        return "bad";
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (_, completeness) = extractor.extract_payload("demo-service");

    assert!(
        !completeness.complete,
        "Circular composed annotation must fail closed"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_UNSUPPORTED_COMPOSED_MAPPING"),
        "Expected JAVA_UNSUPPORTED_COMPOSED_MAPPING, got {:?}",
        completeness.blockers
    );
}

#[test]
fn test_jaxrs_detection_in_working_tree_and_blob_mode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    let jaxrs_code = r#"
package com.example.demo;

import javax.ws.rs.Path;
import javax.ws.rs.GET;

@Path("/jaxrs/orders")
public class JaxRsResource {
    @GET
    public String getOrders() {
        return "orders";
    }
}
"#;

    std::fs::write(src_dir.join("JaxRsResource.java"), jaxrs_code).unwrap();

    // 1. Working tree mode
    let extractor_wt = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor wt");
    let (_, completeness_wt) = extractor_wt.extract_payload("demo-service");

    assert!(
        !completeness_wt.complete,
        "JAX-RS working tree must fail closed"
    );
    assert!(
        completeness_wt
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED"),
        "Working tree missing JAVA_MAPPING_FRAMEWORK_UNPARSED: {:?}",
        completeness_wt.blockers
    );

    // 2. Blob mode
    let blob_sources = vec![(
        "src/main/java/com/example/demo/JaxRsResource.java".to_string(),
        jaxrs_code.to_string(),
    )];
    let extractor_blob = JavaRouteExtractor::from_blobs(
        repo_root.clone(),
        blob_sources,
        ConfigInputs {
            files: vec![],
            profile_files: vec![],
            lombok: None,
        },
    )
    .expect("extractor blob");
    let (_, completeness_blob) = extractor_blob.extract_payload("demo-service");

    assert!(
        !completeness_blob.complete,
        "JAX-RS blob mode must fail closed"
    );
    assert!(
        completeness_blob
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED"),
        "Blob mode missing JAVA_MAPPING_FRAMEWORK_UNPARSED: {:?}",
        completeness_blob.blockers
    );
}

#[test]
fn invisible_java_web_frameworks_are_named_blockers() {
    for (import, family) in [
        ("io.vertx.ext.web.Router", "Vert.x"),
        ("spark.Route", "Spark Java"),
        (
            "org.apache.struts2.dispatcher.filter.StrutsPrepareAndExecuteFilter",
            "Struts2",
        ),
        ("javax.faces.context.FacesContext", "JSF"),
        ("io.rsocket.RSocket", "RSocket"),
    ] {
        let root = std::env::temp_dir().join(format!(
            "sajimora-unsupported-java-{}-{}",
            family.replace([' ', '/'], "-"),
            std::process::id()
        ));
        let java_root = root.join("src/main/java/com/demo");
        std::fs::create_dir_all(&java_root).expect("create dir");
        std::fs::write(
            java_root.join("Demo.java"),
            format!("package com.demo;\nimport {import};\npublic class Demo {{}}\n"),
        )
        .expect("write source");
        let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
        let (_, completeness) = extractor.extract_payload("demo");
        assert!(!completeness.complete, "{family} must fail closed");
        assert!(
            completeness.blockers.iter().any(|blocker| {
                blocker.code == "JAVA_MAPPING_FRAMEWORK_UNPARSED"
                    && blocker.message.contains(family)
            }),
            "missing named blocker for {family}: {:?}",
            completeness.blockers
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn manifest_only_java_frameworks_are_blocked() {
    let root = std::env::temp_dir().join(format!("sajimora-manifest-vertx-{}", std::process::id()));
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(
        root.join("pom.xml"),
        "<project><dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-web</artifactId></dependency></dependencies></project>",
    )
    .expect("write pom");
    std::fs::write(
        java_root.join("Demo.java"),
        "package com.demo;\npublic class Demo {}\n",
    )
    .expect("write source");
    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (_, completeness) = extractor.extract_payload("demo");
    assert!(!completeness.complete);
    assert!(
        completeness.blockers.iter().any(|blocker| {
            blocker.code == "JAVA_FRAMEWORK_DEPENDENCY_UNPARSED"
                && blocker.message.contains("Vert.x")
        }),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn struts_route_configuration_is_blocked() {
    let root = std::env::temp_dir().join(format!("sajimora-struts-config-{}", std::process::id()));
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(root.join("struts.xml"), "<struts></struts>").expect("write config");
    std::fs::write(
        java_root.join("Demo.java"),
        "package com.demo;\npublic class Demo {}\n",
    )
    .expect("write source");
    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (_, completeness) = extractor.extract_payload("demo");
    assert!(!completeness.complete);
    assert!(
        completeness.blockers.iter().any(|blocker| {
            blocker.code == "JAVA_FRAMEWORK_CONFIG_UNPARSED" && blocker.message.contains("Struts2")
        }),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn webflux_functional_routes_are_named_without_an_import() {
    let root = std::env::temp_dir().join(format!("sajimora-webflux-fn-{}", std::process::id()));
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(
        java_root.join("Routes.java"),
        "package com.demo;\npublic class Routes { Object routes = RouterFunctions.route(); }\n",
    )
    .expect("write source");
    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (_, completeness) = extractor.extract_payload("demo");
    assert!(!completeness.complete);
    assert!(
        completeness
            .blockers
            .iter()
            .any(|blocker| { blocker.code == "JAVA_WEBFLUX_FUNCTIONAL_UNPARSED" }),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jax_rs_unmodelled_surface_is_blocked_even_when_extraction_is_enabled() {
    let root = std::env::temp_dir().join(format!("sajimora-jaxrs-gaps-{}", std::process::id()));
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(
        java_root.join("GapResource.java"),
        r#"package com.demo;
import jakarta.ws.rs.BeanParam;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/gaps")
public class GapResource {
    @GET
    @Produces(MediaType.APPLICATION_XML)
    public Response get(@BeanParam Filter filter) {
        return Response.ok("x").build();
    }
}
"#,
    )
    .expect("write resource");
    std::fs::write(
        java_root.join("GapApplication.java"),
        r#"package com.demo;
import jakarta.ws.rs.ApplicationPath;
import jakarta.ws.rs.core.Application;
@ApplicationPath("/api")
public class GapApplication extends Application {}
"#,
    )
    .expect("write application");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, completeness) = extractor.extract_payload("gaps");
    assert!(!completeness.complete);
    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();
    assert!(
        codes.contains(&"JAVA_JAXRS_PARAMETER_UNPARSED"),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"JAVA_JAXRS_MEDIA_TYPE_UNPARSED"),
        "{codes:?}"
    );
    assert!(
        !codes.contains(&"JAVA_JAXRS_APPLICATION_PATH_UNPARSED"),
        "a resolved @ApplicationPath must not remain a blocker: {codes:?}"
    );
    assert!(codes.contains(&"JAVA_JAXRS_RESPONSE_UNPARSED"), "{codes:?}");
    assert!(
        payload
            .endpoints
            .iter()
            .any(|endpoint| { endpoint.identity.normalized_route.raw_path == "/api/gaps" }),
        "@ApplicationPath must prefix the extracted route"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jax_rs_subresource_locator_is_composed() {
    let root = std::env::temp_dir().join(format!("sajimora-jaxrs-sub-{}", std::process::id()));
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(
        java_root.join("ParentResource.java"),
        r#"package com.demo;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/parent")
public class ParentResource {
    @Path("/child")
    public ChildResource child() {
        return null;
    }
}

class ChildResource {
    @GET
    public String get() { return "x"; }
}
"#,
    )
    .expect("write resource");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, completeness) = extractor.extract_payload("sub");
    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        !codes.contains(&"JAVA_JAXRS_SUBRESOURCE_UNPARSED"),
        "a resolved locator target must not remain blocked: {codes:?}"
    );
    assert!(
        payload.endpoints.iter().any(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/parent/child"
                && endpoint.identity.http_method == "GET"
                && endpoint.identity.direction == contract_core::ir::ContractDirection::Response
        }),
        "locator prefix must compose with the sub-resource method: {:?}",
        payload
            .endpoints
            .iter()
            .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone())
            .collect::<Vec<_>>()
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn mutually_recursive_response_helpers_terminate() {
    let unique = format!("sajimora-recursive-response-{}", std::process::id());
    let root = std::env::temp_dir().join(unique);
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).expect("create dir");
    std::fs::write(
        java_root.join("CycleController.java"),
        r#"package com.demo;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CycleController {
    @GetMapping("/cycle")
    public ResponseEntity get() {
        return first(0);
    }

    private ResponseEntity first(int depth) {
        return second(depth);
    }

    private ResponseEntity second(int depth) {
        return first(depth);
    }
}
"#,
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, _) = extractor.extract_payload("cycle-service");
    assert!(
        payload
            .endpoints
            .iter()
            .any(|endpoint| endpoint.identity.normalized_route.raw_path == "/cycle"),
        "the route must still be extracted"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_jackson_json_alias_in_type_pool() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("AccountDto.java"),
        r#"
package com.example.demo;

import com.fasterxml.jackson.annotation.JsonAlias;

public class AccountDto {
    @JsonAlias({"userName", "user_name", "login"})
    private String username;

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("AccountController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {
    @GetMapping("/api/account")
    public AccountDto getAccount() {
        return new AccountDto();
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Blockers: {:?}",
        completeness.blockers
    );
    let type_pool = payload.type_pool.expect("type pool present");
    let dto = type_pool
        .get("java:com.example.demo.AccountDto")
        .expect("AccountDto found");

    if let contract_core::ir::WireType::Object(obj) = dto {
        let username_prop = obj
            .properties
            .iter()
            .find(|p| p.wire_name == "username")
            .expect("username property");
        let mut actual = username_prop.aliases.clone();
        let mut expected = vec![
            "userName".to_string(),
            "user_name".to_string(),
            "login".to_string(),
        ];
        actual.sort();
        expected.sort();
        assert_eq!(
            actual, expected,
            "JsonAliases must be preserved in contract"
        );
    } else {
        panic!("AccountDto should be WireType::Object");
    }
}

#[test]
fn test_jackson_snake_case_acronym_strategy() {
    use source_index::java_routes::NamingStrategy;

    // Direct unit testing of Jackson's acronym-aware snake_casing rules
    assert_eq!(NamingStrategy::SnakeCase.apply("userID"), "user_id");
    assert_eq!(NamingStrategy::SnakeCase.apply("XMLParser"), "xml_parser");
    assert_eq!(NamingStrategy::SnakeCase.apply("userName"), "user_name");
    assert_eq!(NamingStrategy::SnakeCase.apply("URLValue"), "url_value");
    assert_eq!(
        NamingStrategy::SnakeCase.apply("already_snake_case"),
        "already_snake_case"
    );
    assert_eq!(NamingStrategy::SnakeCase.apply("A"), "a");
    assert_eq!(NamingStrategy::SnakeCase.apply(""), "");

    let dir = tempfile::tempdir().expect("tempdir");
    let repo_root = dir.path().to_path_buf();
    let src_dir = repo_root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    // Enable SNAKE_CASE strategy via Spring Boot application.properties
    std::fs::write(
        repo_root.join("application.properties"),
        "spring.jackson.property-naming-strategy=SNAKE_CASE\n",
    )
    .unwrap();

    std::fs::write(
        src_dir.join("AcronymDto.java"),
        r#"
package com.example.demo;

public class AcronymDto {
    private String userID;
    private String XMLParser;
    private String userName;
    private String URLValue;

    public String getUserID() { return userID; }
    public String getXMLParser() { return XMLParser; }
    public String getUserName() { return userName; }
    public String getURLValue() { return URLValue; }
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("AcronymController.java"),
        r#"
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AcronymController {
    @GetMapping("/api/acronym")
    public AcronymDto getAcronym() {
        return new AcronymDto();
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(repo_root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");

    assert!(
        completeness.complete,
        "Blockers: {:?}",
        completeness.blockers
    );
    let type_pool = payload.type_pool.expect("type pool present");
    let dto = type_pool
        .get("java:com.example.demo.AcronymDto")
        .expect("AcronymDto found");

    if let contract_core::ir::WireType::Object(obj) = dto {
        let prop_names: Vec<String> = obj.properties.iter().map(|p| p.wire_name.clone()).collect();
        assert!(
            prop_names.contains(&"user_id".to_string()),
            "Expected user_id, got {:?}",
            prop_names
        );
        assert!(
            prop_names.contains(&"xml_parser".to_string()),
            "Expected xml_parser, got {:?}",
            prop_names
        );
        assert!(
            prop_names.contains(&"user_name".to_string()),
            "Expected user_name, got {:?}",
            prop_names
        );
        assert!(
            prop_names.contains(&"url_value".to_string()),
            "Expected url_value, got {:?}",
            prop_names
        );
    } else {
        panic!("AcronymDto should be WireType::Object");
    }
}

#[test]
fn test_raw_and_wildcard_response_entity_body_type_inference() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("sajimora-test-raw-resp-{nanos}"));
    let src_dir = temp_dir.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("UserDto.java"),
        r#"package com.example.demo;
public class UserDto {
    private String username;
    public String getUsername() { return username; }
}
"#,
    )
    .unwrap();

    std::fs::write(
        src_dir.join("RawController.java"),
        r#"package com.example.demo;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RawController {
    @GetMapping("/api/wildcard")
    public ResponseEntity<?> getWildcard() {
        UserDto user = new UserDto();
        return ResponseEntity.ok(user);
    }

    @GetMapping("/api/raw")
    public ResponseEntity getRaw() {
        return ResponseEntity.ok(new UserDto());
    }

    @GetMapping("/api/void")
    public ResponseEntity<?> getVoid() {
        return ResponseEntity.noContent().build();
    }
}
"#,
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(temp_dir.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo-service");
    assert!(completeness.complete, "{:?}", completeness.blockers);

    let endpoints = payload.endpoints;
    let wildcard = endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/wildcard"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("wildcard endpoint");
    assert!(
        matches!(wildcard.body.as_ref().unwrap(), contract_core::ir::WireType::Ref(r) if r.r#ref == "java:com.example.demo.UserDto"),
        "Expected UserDto, got {:?}",
        wildcard.body
    );

    let raw = endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/raw"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("raw endpoint");
    assert!(
        matches!(raw.body.as_ref().unwrap(), contract_core::ir::WireType::Ref(r) if r.r#ref == "java:com.example.demo.UserDto"),
        "Expected UserDto, got {:?}",
        raw.body
    );

    let void_ep = endpoints
        .iter()
        .find(|e| {
            e.identity.normalized_route.raw_path == "/api/void"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("void endpoint");
    assert!(
        void_ep.body.is_none(),
        "Expected void endpoint to have body: None, got {:?}",
        void_ep.body
    );

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[test]
fn test_micronaut_routes_are_extracted_not_blocked() {
    let root = std::env::temp_dir().join(format!("sajimora-micronaut-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");
    std::fs::write(
        pkg.join("HelloController.java"),
        "package com.demo;\nimport io.micronaut.http.annotation.Controller;\nimport io.micronaut.http.annotation.Get;\n@Controller(\"/hello\")\npublic class HelloController {\n    @Get\n    public String index() { return \"Hello World\"; }\n}\n",
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("micronaut-svc");

    assert!(completeness.complete, "{:?}", completeness.blockers);
    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|b| b.code.as_str())
        .collect();
    assert!(
        !codes.contains(&"JAVA_MAPPING_FRAMEWORK_UNPARSED"),
        "{codes:?}"
    );
    assert!(
        !codes.contains(&"JAVA_CONTROLLER_WITHOUT_MAPPINGS"),
        "{codes:?}"
    );
    assert!(
        payload.endpoints.iter().any(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/hello"
                && endpoint.identity.http_method == "GET"
        }),
        "Micronaut route must be extracted: {:?}",
        payload
            .endpoints
            .iter()
            .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone())
            .collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_context_path_in_properties_and_yml_populates_base_urls() {
    let root = std::env::temp_dir().join(format!("sajimora-contextpath-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let res = root.join("src/main/resources");
    std::fs::create_dir_all(&res).expect("create res");
    std::fs::write(
        res.join("application.properties"),
        "server.servlet.context-path=/api/v2\n",
    )
    .expect("write props");
    let java_root = root.join("src/main/java");
    std::fs::create_dir_all(&java_root).expect("create java");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, _) = extractor.extract_payload("svc");
    assert_eq!(payload.base_urls, vec!["/api/v2".to_string()]);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_webflux_flux_unwrapped_to_list() {
    let root = std::env::temp_dir().join(format!("sajimora-webflux-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");
    std::fs::write(
        pkg.join("ItemController.java"),
        "package com.demo;\nimport org.springframework.web.bind.annotation.*;\nimport reactor.core.publisher.Flux;\n@RestController\npublic class ItemController {\n    @GetMapping(\"/items\")\n    public Flux<String> getItems() { return null; }\n}\n",
    )
    .expect("write controller");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, _) = extractor.extract_payload("svc");
    assert_eq!(payload.endpoints.len(), 1);
    let ep = &payload.endpoints[0];
    assert!(
        matches!(ep.body.as_ref().unwrap(), contract_core::ir::WireType::Array(a) if matches!(a.element_type.as_ref(), contract_core::ir::WireType::Primitive(contract_core::ir::PrimitiveWireType { scalar: contract_core::ir::PrimitiveScalar::String, .. })))
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_jax_rs_producer_extraction_full() {
    let root = std::env::temp_dir().join(format!("sajimora-jaxrs-full-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");

    std::fs::write(
        pkg.join("UserDto.java"),
        r#"package com.demo;
public class UserDto {
    private Long id;
    private String name;
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}
"#,
    )
    .expect("write dto");

    std::fs::write(
        pkg.join("UserResource.java"),
        r#"package com.demo;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
@Path("/api/users")
@Produces(MediaType.APPLICATION_JSON)
public class UserResource {
    @GET
    @Path("/{id}")
    public UserDto getUser(@PathParam("id") Long id) {
        return null;
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public UserDto createUser(UserDto body) {
        return body;
    }
}
"#,
    )
    .expect("write resource");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, completeness) = extractor.extract_payload("user-service");

    assert!(
        completeness.complete,
        "JAX-RS extraction must be complete: {:?}",
        completeness.blockers
    );
    assert_eq!(payload.endpoints.len(), 4); // GET response + POST request + POST response

    let get_res = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.http_method == "GET"
                && e.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("GET response");
    assert_eq!(
        get_res.identity.normalized_route.raw_path,
        "/api/users/{id}"
    );
    assert!(get_res.path_parameters.iter().any(|p| p.name == "id"));
    assert!(
        matches!(get_res.body.as_ref().unwrap(), contract_core::ir::WireType::Ref(r) if r.r#ref == "java:com.demo.UserDto")
    );

    let post_req = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.http_method == "POST"
                && e.identity.direction == contract_core::ir::ContractDirection::Request
        })
        .expect("POST request");
    assert_eq!(post_req.identity.normalized_route.raw_path, "/api/users");
    assert!(
        matches!(post_req.body.as_ref().unwrap(), contract_core::ir::WireType::Ref(r) if r.r#ref == "java:com.demo.UserDto:request")
    );

    let env = extractor
        .build_envelope("user-service", None, "HEAD")
        .expect("envelope");
    assert_eq!(env.profile.framework_profile.as_deref(), Some("JAX_RS"));
    assert!(env.completeness.complete);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_feign_declarative_client_extraction_full() {
    let root = std::env::temp_dir().join(format!("sajimora-feign-full-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    let pkg = java_root.join("com/demo");
    std::fs::create_dir_all(&pkg).expect("create pkg");

    std::fs::write(
        pkg.join("UserDto.java"),
        r#"package com.demo;
public class UserDto {
    private Long id;
    private String name;
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}
"#,
    )
    .expect("write dto");

    std::fs::write(
        pkg.join("UserClient.java"),
        r#"package com.demo;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient(name = "user-service", path = "/api/users")
public interface UserClient {
    @GetMapping("/{id}")
    UserDto getUser(@PathVariable("id") Long id);

    @PostMapping
    UserDto createUser(@RequestBody UserDto req);
}
"#,
    )
    .expect("write client");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    assert!(
        extractor.has_client_interfaces(),
        "Must detect client interfaces"
    );

    let (payload, completeness) = extractor.extract_client_payload("order-service", "user-service");
    assert!(completeness.complete);
    assert_eq!(payload.client_contracts.len(), 2);

    let get_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "GET")
        .expect("GET client contract");
    assert_eq!(get_contract.normalized_route, "/api/users/{id}");
    assert_eq!(
        get_contract.target_service_id.as_deref(),
        Some("user-service")
    );
    assert!(
        matches!(get_contract.expected_response, contract_core::ir::WireType::Ref(ref r) if r.r#ref == "java:com.demo.UserDto")
    );

    let post_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST")
        .expect("POST client contract");
    assert_eq!(post_contract.normalized_route, "/api/users");
    assert!(
        matches!(post_contract.request_body.as_ref().unwrap(), contract_core::ir::WireType::Ref(ref r) if r.r#ref == "java:com.demo.UserDto:request")
    );

    let env = extractor
        .build_client_envelope("order-service", "user-service", "HEAD")
        .expect("envelope");
    assert_eq!(
        env.kind,
        contract_core::envelope::ArtifactKind::FrontendContract
    );
    assert_eq!(
        env.profile.client_profile.as_deref(),
        Some("JAVA_HTTP_CLIENT")
    );
    assert!(env.completeness.complete);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn test_raw_response_entity_payload_inference_and_map_wrapper() {
    let unique = format!("sajimora-test-raw-re-{}", std::process::id());
    let root = std::env::temp_dir().join(unique);
    let java_root = root
        .join("src")
        .join("main")
        .join("java")
        .join("com")
        .join("demo");
    std::fs::create_dir_all(&java_root).expect("create dir");

    std::fs::write(
        java_root.join("UserDto.java"),
        r#"package com.demo;
public class UserDto {
    private Long id;
    private String name;
    public Long getId() { return id; }
    public String getName() { return name; }
}
"#,
    )
    .expect("write UserDto");

    std::fs::write(
        java_root.join("UserService.java"),
        r#"package com.demo;
import org.springframework.stereotype.Service;
@Service
public class UserService {
    public UserDto findUser(Long id) {
        return new UserDto();
    }
}
"#,
    )
    .expect("write UserService");

    std::fs::write(
        java_root.join("UserController.java"),
        r#"package com.demo;
import java.util.HashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    private UserService userService;

    @GetMapping("/{id}")
    public ResponseEntity getUser(@PathVariable("id") Long id) {
        return ResponseEntity.ok(userService.findUser(id));
    }

    @PostMapping
    public ResponseEntity createUser(@RequestBody UserDto req) {
        return ResponseEntity.status(201).body(userResponse(req));
    }

    private Map<String, Object> userResponse(UserDto user) {
        return new HashMap<String, Object>() {
            {
                put("user", user);
            }
        };
    }
}
"#,
    )
    .expect("write UserController");

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("user-service");
    assert!(completeness.complete, "Artifact must be complete");

    let get_ep = payload
        .endpoints
        .iter()
        .find(|e| e.identity.http_method == "GET")
        .expect("GET endpoint");
    assert_eq!(get_ep.identity.normalized_route.raw_path, "/api/users/{id}");
    assert!(
        get_ep.body.is_some(),
        "GET endpoint must resolve payload from userService.findUser"
    );
    let get_body = get_ep.body.as_ref().unwrap();
    assert!(
        matches!(get_body, contract_core::ir::WireType::Ref(ref r) if r.r#ref == "java:com.demo.UserDto")
    );

    let post_ep = payload
        .endpoints
        .iter()
        .find(|e| e.identity.http_method == "POST")
        .expect("POST endpoint");
    assert_eq!(post_ep.identity.normalized_route.raw_path, "/api/users");
    assert!(
        post_ep.body.is_some(),
        "POST endpoint must resolve payload from userResponse map wrapper"
    );
    let post_body = post_ep.body.as_ref().unwrap();
    if let contract_core::ir::WireType::Object(ref obj) = post_body {
        assert_eq!(
            obj.properties.len(),
            1,
            "Must have exactly 1 property (user)"
        );
        assert_eq!(obj.properties[0].wire_name, "user");
        assert!(
            matches!(obj.properties[0].r#type, contract_core::ir::WireType::Ref(ref r) if r.r#ref == "java:com.demo.UserDto")
        );
    } else {
        panic!(
            "Expected WireType::Object for map wrapper, found {:?}",
            post_body
        );
    }

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn scala_and_groovy_sources_are_named_unparsed_beside_java() {
    let root = std::env::temp_dir().join(format!("sajimora-jvm-families-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java/com/demo");
    std::fs::create_dir_all(&java_root).unwrap();
    std::fs::write(
        java_root.join("DemoController.java"),
        "package com.demo;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class DemoController {\n    @GetMapping(\"/api/demo\")\n    public String demo() { return \"ok\"; }\n}\n",
    )
    .unwrap();
    let scala_root = root.join("src/main/scala/com/demo");
    std::fs::create_dir_all(&scala_root).unwrap();
    std::fs::write(
        scala_root.join("ScalaController.scala"),
        "package com.demo\n@RestController\nclass ScalaController\n",
    )
    .unwrap();
    let groovy_root = root.join("src/main/groovy/com/demo");
    std::fs::create_dir_all(&groovy_root).unwrap();
    std::fs::write(
        groovy_root.join("GroovyController.groovy"),
        "package com.demo\nclass GroovyController {}\n",
    )
    .unwrap();

    let extractor =
        JavaRouteExtractor::new(root.clone(), &root.join("src/main/java")).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");
    assert!(
        payload
            .endpoints
            .iter()
            .any(|endpoint| endpoint.identity.normalized_route.raw_path == "/api/demo"),
        "Java routes must still be extracted"
    );
    let messages: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "JAVA_SOURCE_NOT_PARSED")
        .map(|blocker| blocker.message.as_str())
        .collect();
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Scala sources")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Groovy sources")),
        "{messages:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}
