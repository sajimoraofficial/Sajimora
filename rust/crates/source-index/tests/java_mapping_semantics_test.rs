use contract_core::ir::{ContractDirection, WireType};
use source_index::java_routes::JavaRouteExtractor;
use std::path::PathBuf;

fn write_fixture(name: &str, file: &str, source: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("sajimora-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let src_dir = root.join("src/main/java/com/example/demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join(file), source).unwrap();
    (root, src_dir)
}

#[test]
fn request_mapping_verbs_and_conditions_are_honest() {
    let source = r#"
package com.example.demo;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping(value = "/api/things", params = {"tenant"})
public class DemoController {
    @PostMapping(value = "/json", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public String json() { return ""; }

    @RequestMapping(method = {RequestMethod.GET, RequestMethod.POST}, path = "/{id}")
    public String both(@PathVariable String id) { return ""; }

    @RequestMapping(params = {"!archived"})
    public String any() { return ""; }

    @RequestMapping(method = RequestMethod.DELETE, headers = "X-Admin", path = "/del")
    public String del() { return ""; }
}
"#;
    let (root, src_dir) = write_fixture("verbs-conditions", "DemoController.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");

    let response_verbs = |route: &str| -> Vec<String> {
        let mut verbs: Vec<String> = payload
            .endpoints
            .iter()
            .filter(|e| {
                e.identity.direction == ContractDirection::Response
                    && e.identity.normalized_route.raw_path == route
            })
            .map(|e| e.identity.http_method.clone())
            .collect();
        verbs.sort();
        verbs
    };

    assert_eq!(response_verbs("/api/things/{id}"), vec!["GET", "POST"]);
    assert_eq!(
        response_verbs("/api/things"),
        vec!["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
        "a method-less @RequestMapping matches every standard HTTP method"
    );

    let conditions = |method: &str, route: &str| -> serde_json::Value {
        payload
            .endpoints
            .iter()
            .find(|e| {
                e.identity.http_method == method
                    && e.identity.normalized_route.raw_path == route
                    && e.identity.direction == ContractDirection::Response
            })
            .and_then(|e| e.mapping_conditions.clone())
            .expect("mapping conditions")
    };
    let both = conditions("GET", "/api/things/{id}");
    assert_eq!(both["params"], serde_json::json!(["tenant"]));
    assert_eq!(both["complete"], serde_json::json!(true));

    let any = conditions("GET", "/api/things");
    assert_eq!(any["params"], serde_json::json!(["!archived", "tenant"]));
    assert_eq!(any["complete"], serde_json::json!(true));

    let del = conditions("DELETE", "/api/things/del");
    assert_eq!(
        del["complete"],
        serde_json::json!(false),
        "headers select requests and cannot be represented"
    );

    let json = conditions("POST", "/api/things/json");
    assert_eq!(
        json["complete"],
        serde_json::json!(true),
        "a JSON-only consumes/produces restriction matches the extractor's own assumption"
    );

    assert!(
        completeness.complete,
        "condition parsing must not add blockers: {:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn spring_parameters_are_classified_not_promoted_to_body() {
    let source = r#"
package com.example.demo;
import java.security.Principal;
import org.springframework.data.domain.Pageable;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

class Payload { public String name; }
class Query { public String q; }

@RestController
public class DemoController {
    @PostMapping("/login")
    public String login(@AuthenticationPrincipal UserDetails user, Principal principal, BindingResult errors) {
        return "";
    }

    @PostMapping("/body")
    public String body(@RequestBody Payload payload) { return ""; }

    @PostMapping("/form")
    public String form(@ModelAttribute Query query) { return ""; }

    @PostMapping("/upload")
    public String upload(@RequestPart("file") MultipartFile file) { return ""; }

    @GetMapping("/list")
    public String list(Pageable page, String q) { return ""; }
}
"#;
    let (root, src_dir) = write_fixture("spring-params", "DemoController.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");

    let login_requests = payload
        .endpoints
        .iter()
        .filter(|e| e.identity.direction == ContractDirection::Request)
        .filter(|e| e.identity.normalized_route.raw_path == "/login")
        .count();
    assert_eq!(
        login_requests, 0,
        "auth/context parameters must not become a request body"
    );

    let body_request = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.direction == ContractDirection::Request
                && e.identity.normalized_route.raw_path == "/body"
        })
        .expect("POST /body request endpoint");
    assert!(
        matches!(&body_request.body, Some(WireType::Ref(r)) if r.r#ref.contains("Payload")),
        "explicit @RequestBody must still resolve, got {:?}",
        body_request.body
    );

    for route in ["/form", "/upload"] {
        let request = payload.endpoints.iter().find(|e| {
            e.identity.direction == ContractDirection::Request
                && e.identity.normalized_route.raw_path == route
        });
        assert!(
            request.is_none(),
            "{route} must not fabricate a request body"
        );
    }

    let unmodeled: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|b| b.code == "JAVA_SPRING_PARAMETER_UNMODELED")
        .map(|b| b.message.as_str())
        .collect();
    assert_eq!(
        unmodeled.len(),
        2,
        "model attribute and multipart must each block: {:?}",
        unmodeled
    );
    assert!(unmodeled.iter().any(|m| m.contains("@ModelAttribute")));
    assert!(unmodeled.iter().any(|m| m.contains("multipart")));

    let list_request = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.direction == ContractDirection::Request
                && e.identity.normalized_route.raw_path == "/list"
        })
        .expect("GET /list request endpoint");
    let mut query_names: Vec<&str> = list_request
        .query_parameters
        .iter()
        .map(|p| p.name.as_str())
        .collect();
    query_names.sort();
    assert_eq!(query_names, vec!["page", "q", "size", "sort"]);
    for param in &list_request.query_parameters {
        let optional = matches!(param.name.as_str(), "page" | "size" | "sort");
        assert_eq!(
            param.required, !optional,
            "paging keys are optional; an unannotated simple parameter is required ({})",
            param.name
        );
    }

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn webflux_base_path_is_read_without_confusing_other_base_paths() {
    let root =
        std::env::temp_dir().join(format!("sajimora-webflux-basepath-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let java_root = root.join("src/main/java");
    std::fs::create_dir_all(&java_root).unwrap();
    let res = root.join("src/main/resources");
    std::fs::create_dir_all(&res).unwrap();
    std::fs::write(
        res.join("application.yml"),
        "spring:\n  data:\n    rest:\n      base-path: /data\n  webflux:\n    base-path: /flux\nmanagement:\n  endpoints:\n    web:\n      base-path: /actuator\n",
    )
    .unwrap();

    let extractor = JavaRouteExtractor::new(root.clone(), &java_root).expect("extractor");
    let (payload, _) = extractor.extract_payload("svc");
    assert_eq!(payload.base_urls, vec!["/flux".to_string()]);

    let props_root = std::env::temp_dir().join(format!(
        "sajimora-webflux-basepath-props-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&props_root);
    let props_java = props_root.join("src/main/java");
    std::fs::create_dir_all(&props_java).unwrap();
    let props_res = props_root.join("src/main/resources");
    std::fs::create_dir_all(&props_res).unwrap();
    std::fs::write(
        props_res.join("application.properties"),
        "spring.webflux.base-path=/wf\n",
    )
    .unwrap();
    let extractor = JavaRouteExtractor::new(props_root.clone(), &props_java).expect("extractor");
    let (payload, _) = extractor.extract_payload("svc");
    assert_eq!(payload.base_urls, vec!["/wf".to_string()]);

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(props_root);
}

#[test]
fn mapping_path_constants_are_resolved_and_unresolved_paths_fail_closed() {
    let source = r#"
package com.example.demo;
import org.springframework.web.bind.annotation.*;

class Constants { static final String BASE = "/api/v1"; }
class Base { protected String inheritedField; }

@RestController
@RequestMapping(Constants.BASE)
public class DemoController extends Base {
    private static final String ITEM = "/items/{id}";

    @GetMapping(ITEM)
    public String item(@PathVariable String id) { return ""; }

    @PutMapping(ITEM + "/info")
    public String info(@PathVariable String id) { return ""; }
}

@RestController
public class BrokenController {
    @GetMapping(UNRESOLVED_PATH)
    public String broken() { return ""; }
}
"#;
    let (root, src_dir) = write_fixture("path-constants", "DemoController.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");

    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|e| e.identity.direction == ContractDirection::Response)
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/v1/items/{id}".to_string()),
            ("PUT".to_string(), "/api/v1/items/{id}/info".to_string()),
        ],
        "constants and concatenations must resolve; the broken controller must not publish `/`"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_MAPPING_PATH_UNRESOLVED"
                && b.message.contains("BrokenController")),
        "an unresolvable path must be a named blocker: {:?}",
        completeness.blockers
    );
    assert!(
        !payload
            .endpoints
            .iter()
            .any(|e| e.identity.normalized_route.raw_path == "/"),
        "no endpoint may be fabricated at the root"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn feign_request_line_clients_are_extracted_or_blocked() {
    let source = r#"
package com.example.demo;
import feign.FeignClient;
import feign.Param;
import feign.RequestLine;

class Item { public String id; }
class Unreadable { public String id; }

@FeignClient(name = "item-service", path = "/api/items")
interface ItemClient {
    @RequestLine("GET /{id}")
    Item get(@Param("id") String id);

    @RequestLine("POST")
    Item create(Item item);

    @RequestLine(Unreadable.LINE)
    Item broken();
}
"#;
    let (root, src_dir) = write_fixture("feign-request-line", "ItemClient.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    assert!(extractor.has_client_interfaces());

    let (payload, completeness) = extractor.extract_client_payload("demo", "fallback-service");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/items/{id}".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
        ]
    );
    assert!(payload
        .client_contracts
        .iter()
        .all(|c| c.target_service_id.as_deref() == Some("item-service")));

    let post = payload
        .client_contracts
        .iter()
        .find(|c| c.http_method == "POST")
        .expect("POST contract");
    assert!(
        matches!(&post.request_body, Some(WireType::Ref(r)) if r.r#ref.contains("Item")),
        "native Feign's unannotated entity parameter is the body, got {:?}",
        post.request_body
    );

    assert!(!completeness.complete);
    assert!(
        completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_CLIENT_MAPPING_UNRESOLVED" && b.message.contains("broken")),
        "an unreadable @RequestLine must block instead of sealing an empty client artifact: {:?}",
        completeness.blockers
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jaxrs_application_path_prefixes_resource_routes() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.*;

@ApplicationPath("/api")
class RestApplication extends jakarta.ws.rs.core.Application {}

@Path("/items")
class ItemResource {
    @GET
    public String list() { return ""; }
}
"#;
    let (root, src_dir) = write_fixture("jaxrs-app-path", "ItemResource.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, completeness) = extractor.extract_payload("demo");

    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|e| e.identity.direction == ContractDirection::Response)
        .map(|e| {
            (
                e.identity.http_method.clone(),
                e.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/items".to_string())],
        "the application base path must prefix resource routes"
    );
    assert!(
        completeness
            .blockers
            .iter()
            .all(|b| b.code != "JAVA_JAXRS_APPLICATION_PATH_UNPARSED"),
        "a resolved @ApplicationPath must not remain a blocker: {:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jaxrs_unannotated_entity_is_still_the_body() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;

@Path("/widgets")
public class WidgetResource {
    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public String create(Widget widget) { return ""; }
}
"#;
    let (root, src_dir) = write_fixture("jaxrs-entity", "WidgetResource.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, _) = extractor.extract_payload("demo");
    let request = payload
        .endpoints
        .iter()
        .find(|e| {
            e.identity.direction == ContractDirection::Request
                && e.identity.normalized_route.raw_path == "/widgets"
        })
        .expect("JAX-RS request endpoint");
    match &request.body {
        Some(WireType::Ref(r)) if r.r#ref.contains("Widget") => {}
        Some(WireType::Unknown(u)) if u.reason.contains("Widget") => {}
        other => panic!(
            "JAX-RS entity parameter must remain the implicit body, got {:?}",
            other
        ),
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn imperative_java_clients_emit_contracts() {
    let source = r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.client.RestClient;

class User { public String id; }
class Item { public String id; }
class Order { public String id; }

class Clients {
    private final RestTemplate restTemplate = null;
    private final WebClient webClient = null;
    private final RestClient restClient = null;

    public void load() {
        restTemplate.getForObject("/api/users/{id}", User.class);
        restTemplate.postForObject("/api/users", new User(), User.class);
        webClient.get().uri("/api/items").retrieve().bodyToMono(Item.class);
        restClient.post().uri("/api/orders").body(new Order()).retrieve().body(Order.class);
    }
}
"#;
    let (root, src_dir) = write_fixture("java-clients", "Clients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/items".to_string()),
            ("GET".to_string(), "/api/users/{id}".to_string()),
            ("POST".to_string(), "/api/orders".to_string()),
            ("POST".to_string(), "/api/users".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn retrofit_interfaces_are_clients_and_unresolved_urls_block() {
    let retrofit = r#"
package com.example.demo;
import retrofit2.Call;
import retrofit2.http.Body;
import retrofit2.http.GET;
import retrofit2.http.POST;
import retrofit2.http.Path;

class User { public String id; }

interface RetroApi {
    @GET("users/{id}")
    Call<User> get(@Path("id") String id);

    @POST("users")
    Call<User> create(@Body User user);
}
"#;
    let (root, src_dir) = write_fixture("retrofit", "RetroApi.java", retrofit);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    assert!(extractor.has_client_interfaces());
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/users/{id}".to_string()),
            ("POST".to_string(), "/users".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);

    let dynamic = r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;
class User { public String id; }
class Clients {
    private final RestTemplate restTemplate = null;
    public void load(String path) {
        restTemplate.getForObject(path, User.class);
    }
}
"#;
    let (root, src_dir) = write_fixture("java-client-dynamic", "Clients.java", dynamic);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(payload.client_contracts.is_empty());
    assert!(!completeness.complete);
    assert!(completeness
        .blockers
        .iter()
        .any(|blocker| blocker.code == "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn micronaut_controllers_are_extracted_with_a_micronaut_profile() {
    let source = r#"
package com.example.demo;
import io.micronaut.http.annotation.*;

class Book { public String id; }

@Controller("/api/books")
class BookController {
    @Get("/{id}")
    public Book get(@PathVariable String id) { return null; }

    @Post
    public Book create(@Body Book book) { return null; }
}
"#;
    let (root, src_dir) = write_fixture("micronaut", "BookController.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/books/{id}".to_string()),
            ("POST".to_string(), "/api/books".to_string()),
        ]
    );
    assert_eq!(extractor.framework_profile(), "MICRONAUT");
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn quarkus_reactive_routes_are_extracted() {
    let source = r#"
package com.example.demo;
import io.quarkus.vertx.web.Route;
import io.vertx.core.http.HttpMethod;
import io.vertx.ext.web.RoutingContext;

class ReactiveRoutes {
    @Route(path = "/api/hello", methods = HttpMethod.GET)
    public void hello(RoutingContext context) {}
}
"#;
    let (root, src_dir) = write_fixture("quarkus-routes", "ReactiveRoutes.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    assert_eq!(extractor.framework_profile(), "QUARKUS");
    assert!(payload.endpoints.iter().any(|endpoint| {
        endpoint.identity.http_method == "GET"
            && endpoint.identity.normalized_route.raw_path == "/api/hello"
    }));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jaxrs_sub_resource_locators_are_composed() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.*;

class Order { public String id; }

@Path("/accounts")
class AccountResource {
    @Path("{id}/orders")
    public OrderResource orders(@PathParam("id") String id) { return null; }
}

class OrderResource {
    @GET
    @Path("{orderId}")
    public Order get(@PathParam("orderId") String orderId) { return null; }

    @POST
    public Order create(Order order) { return null; }
}
"#;
    let (root, src_dir) = write_fixture("jaxrs-subresource", "AccountResource.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir)
        .expect("extractor")
        .with_jax_rs(true);
    let (payload, completeness) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            (
                "GET".to_string(),
                "/accounts/{id}/orders/{orderId}".to_string()
            ),
            ("POST".to_string(), "/accounts/{id}/orders".to_string()),
        ]
    );
    assert!(
        completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "JAVA_JAXRS_SUBRESOURCE_UNPARSED"),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn webflux_functional_and_helidon_dsl_routes_are_extracted() {
    let webflux = r#"
package com.example.demo;
import org.springframework.web.reactive.function.server.RouterFunctions;
class Routes {
    Object routes = RouterFunctions.route()
        .GET("/api/users/{id}", request -> null)
        .POST("/api/users", request -> null)
        .build();
}
"#;
    let (root, src_dir) = write_fixture("webflux-functional", "Routes.java", webflux);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/users/{id}".to_string()),
            ("POST".to_string(), "/api/users".to_string()),
        ]
    );
    assert_eq!(extractor.framework_profile(), "SPRING_WEBFLUX_FUNCTIONAL");
    let _ = std::fs::remove_dir_all(root);

    let helidon = r#"
package com.example.demo;
import io.helidon.webserver.Routing;
class App {
    Routing routes = Routing.builder()
        .get("/api/health", (request, response) -> {})
        .post("/api/items", (request, response) -> {})
        .build();
}
"#;
    let (root, src_dir) = write_fixture("helidon", "App.java", helidon);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/health".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
        ]
    );
    assert_eq!(extractor.framework_profile(), "HELIDON");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn apache_http_client_methods_emit_contracts() {
    let source = r#"
package com.example.demo;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.impl.client.CloseableHttpClient;

class ApacheClients {
    private final CloseableHttpClient client = null;

    void load() {
        HttpGet get = new HttpGet("/api/orders");
        client.execute(get);
        HttpPost post = new HttpPost("/api/orders");
        client.execute(post);
        client.execute(new HttpGet("/api/health"));
    }
}
"#;
    let (root, src_dir) = write_fixture("apache-clients", "ApacheClients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/health".to_string()),
            ("GET".to_string(), "/api/orders".to_string()),
            ("POST".to_string(), "/api/orders".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn local_strings_fold_into_client_urls() {
    let source = r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;

class LocalClients {
    static final String BASE = "/api";
    private final RestTemplate restTemplate = null;
    private final CloseableHttpClient httpClient = null;

    void run() {
        String path = BASE + "/local";
        restTemplate.getForObject(path, UserDto.class);

        String SHADOWED = "/api/local-shadow";
        restTemplate.getForObject(SHADOWED, UserDto.class);

        String apachePath = "/api/apache-local";
        httpClient.execute(new HttpGet(apachePath));
    }
}

class UserDto {}
"#;
    let (root, src_dir) = write_fixture("local-strings", "LocalClients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/apache-local".to_string()),
            ("GET".to_string(), "/api/local".to_string()),
            ("GET".to_string(), "/api/local-shadow".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ternary_and_opaque_local_urls_stay_fail_closed() {
    let source = r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;

class LocalClients {
    private final RestTemplate restTemplate = null;

    void run(boolean v2) {
        String base = v2 ? "/v1" : "/v2";
        restTemplate.getForObject(base, UserDto.class);

        String dynamic = build();
        restTemplate.getForObject(dynamic, UserDto.class);
    }

    String build() { return "/x"; }
}

class UserDto {}
"#;
    let (root, src_dir) = write_fixture("local-strings-opaque", "LocalClients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(
        payload.client_contracts.is_empty(),
        "{:?}",
        payload.client_contracts
    );
    let unresolved = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED")
        .count();
    assert_eq!(unresolved, 2, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn apache_http_client5_package_is_recognized() {
    let source = r#"
package com.example.demo;
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;

class Apache5Clients {
    private final CloseableHttpClient httpclient = null;

    void load() throws Exception {
        final HttpGet httpget = new HttpGet("http://httpbin.org/get");
        httpclient.execute(httpget, response -> null);
    }
}
"#;
    let (root, src_dir) = write_fixture("apache5-clients", "Apache5Clients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert_eq!(
        payload.client_contracts.len(),
        1,
        "{:?}",
        payload.client_contracts
    );
    let contract = &payload.client_contracts[0];
    assert_eq!(contract.http_method, "GET");
    assert!(
        contract.normalized_route.ends_with("/get"),
        "{}",
        contract.normalized_route
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn apache_http_client_dynamic_url_and_untraced_requests_are_not_invented() {
    let source = r#"
package com.example.demo;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.impl.client.CloseableHttpClient;

class ApacheClients {
    private final CloseableHttpClient client = null;

    void load(String base, String id) {
        HttpGet dynamic = new HttpGet(base + "/orders/" + id);
        client.execute(dynamic);
        client.execute(buildRequest());
    }

    Object buildRequest() { return null; }
}
"#;
    let (root, src_dir) = write_fixture("apache-clients-dynamic", "ApacheClients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(
        payload.client_contracts.is_empty(),
        "{:?}",
        payload.client_contracts
    );
    let unresolved: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED")
        .map(|blocker| blocker.message.as_str())
        .collect();
    assert_eq!(unresolved.len(), 1, "{:?}", completeness.blockers);
    assert!(unresolved[0].contains("Apache HttpClient request URL"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_local_class_named_http_get_is_not_read_as_an_apache_client() {
    let source = r#"
package com.example.demo;

class HttpGet {
    HttpGet(String path) {}
}

class Runner {
    void run(Executor executor) {
        Object request = new HttpGet("/api/orders");
        executor.execute(request);
    }
}
"#;
    let (root, src_dir) = write_fixture("apache-lookalike", "Runner.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(payload.client_contracts.is_empty());
    assert!(
        completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED"),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn async_and_response_wrappers_resolve_to_their_payloads() {
    let source = r#"
package com.example.demo;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class Wrappers {
    @GetMapping("/uni")
    public Uni<UserDto> uni() { return null; }

    @GetMapping("/multi")
    public Multi<UserDto> multi() { return null; }

    @GetMapping("/rest")
    public RestResponse<UserDto> rest() { return null; }

    @GetMapping("/stage")
    public CompletionStage<UserDto> stage() { return null; }
}

class Uni<T> {}
class Multi<T> {}
class RestResponse<T> {}
class CompletionStage<T> {}

class UserDto {
    private String name;
    public String getName() { return name; }
}
"#;
    let (root, src_dir) = write_fixture("async-wrappers", "Wrappers.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let response = |path: &str| {
        payload
            .endpoints
            .iter()
            .find(|endpoint| {
                endpoint.identity.normalized_route.raw_path == path
                    && endpoint.identity.direction == ContractDirection::Response
            })
            .unwrap_or_else(|| panic!("response endpoint {path}"))
            .body
            .clone()
    };
    for path in ["/uni", "/rest", "/stage"] {
        assert!(
            matches!(
                response(path),
                Some(contract_core::ir::WireType::Ref(reference))
                    if reference.r#ref.ends_with("UserDto")
            ),
            "{path}: {:?}",
            response(path)
        );
    }
    match response("/multi") {
        Some(contract_core::ir::WireType::Array(array)) => {
            assert!(matches!(
                *array.element_type,
                contract_core::ir::WireType::Ref(reference) if reference.r#ref.ends_with("UserDto")
            ));
            assert_eq!(array.is_stream_or_flux, Some(true));
        }
        other => panic!("/multi: {other:?}"),
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn micronaut_http_response_payload_is_the_wire_body() {
    let source = r#"
package com.example.demo;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.PathVariable;

@Controller("/subscriptions")
class SubscriptionController {
    @Get("/{id}")
    HttpResponse<Subscription> findById(@PathVariable Long id) {
        return HttpResponse.ok(new Subscription());
    }
}

class Subscription {
    private String name;
    public String getName() { return name; }
}
"#;
    let (root, src_dir) = write_fixture(
        "micronaut-http-response",
        "SubscriptionController.java",
        source,
    );
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let response = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/subscriptions/{id}"
                && endpoint.identity.direction == ContractDirection::Response
        })
        .expect("response endpoint");
    assert!(
        matches!(
            response.body.as_ref(),
            Some(contract_core::ir::WireType::Ref(reference))
                if reference.r#ref == "java:com.example.demo.Subscription"
        ),
        "{:?}",
        response.body
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn helidon_registered_services_compose_their_routes() {
    let main = r#"
package com.example.demo;
import io.helidon.webserver.Routing;

class Main {
    static Routing createRouting(Object health) {
        GreetService greetService = new GreetService();
        return Routing.builder()
                .register(health)
                .register("/greet", greetService)
                .build();
    }
}
"#;
    let service = r#"
package com.example.demo;
import io.helidon.webserver.Routing;
import io.helidon.webserver.Service;

class GreetService implements Service {
    @Override
    public void update(Routing.Rules rules) {
        rules.get("/", this::getDefault)
             .get("/{name}", this::getMessage)
             .put("/greeting", this::updateGreeting);
    }

    private void getDefault() {}
    private void getMessage() {}
    private void updateGreeting() {}
}
"#;
    let (root, src_dir) = write_fixture("helidon-service", "Main.java", main);
    std::fs::write(
        root.join("src/main/java/com/example/demo/GreetService.java"),
        service,
    )
    .unwrap();
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/greet".to_string()),
            ("GET".to_string(), "/greet/{name}".to_string()),
            ("PUT".to_string(), "/greet/greeting".to_string()),
        ]
    );
    let codes: Vec<&str> = completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();
    assert!(
        codes.contains(&"JAVA_HELIDON_ROUTE_REGISTER_UNPARSED"),
        "unresolved register(health) groups must stay named: {codes:?}"
    );
    assert!(
        !codes.contains(&"JAVA_HELIDON_ROUTES_UNPARSED"),
        "composed service routes must not be reported as unparsed: {codes:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn java_net_http_and_okhttp_builders_emit_contracts() {
    let source = r#"
package com.example.demo;
import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;

class Clients {
    void load() {
        HttpRequest.newBuilder(URI.create("/api/ping")).GET().build();
        HttpRequest.newBuilder(URI.create("/api/items")).method("POST", HttpRequest.BodyPublishers.noBody()).build();
        new Request.Builder().url("/api/ok").get().build();
        new Request.Builder().url("/api/ok-items").post(null).build();
    }
}
"#;
    let (root, src_dir) = write_fixture("builder-clients", "Clients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/ok".to_string()),
            ("GET".to_string(), "/api/ping".to_string()),
            ("POST".to_string(), "/api/items".to_string()),
            ("POST".to_string(), "/api/ok-items".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jersey_web_target_chains_are_extracted() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.client.Client;
import jakarta.ws.rs.client.Entity;
import jakarta.ws.rs.client.WebTarget;

class JerseyClients {
    void load(Client client, Order order, String id) {
        client.target("/api/users").request().get(UserDto.class);
        client.target("/api").path("orders").path("active").request().get(UserDto.class);
        client.target("/api/orders").request().post(Entity.json(order));
        client.target("/api/orders").path(id).request().get(UserDto.class);
    }
}

class UserDto {}
class Order {}
"#;
    let (root, src_dir) = write_fixture("jersey-clients", "JerseyClients.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/orders/active".to_string()),
            ("GET".to_string(), "/api/users".to_string()),
            ("POST".to_string(), "/api/orders".to_string()),
        ]
    );
    let unresolved: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED")
        .map(|blocker| blocker.message.as_str())
        .collect();
    assert_eq!(unresolved.len(), 1, "{:?}", completeness.blockers);
    assert!(unresolved[0].contains("Jersey WebTarget URL"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jersey_injected_uri_web_targets_are_clients() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.client.WebTarget;
import org.glassfish.jersey.server.Uri;

@Path("/client")
class ClientResource {
    @GET
    @Path("/animals")
    String animals(@Uri("resource/dog") WebTarget dogWebTarget) {
        return dogWebTarget.request().get(String.class);
    }

    @GET
    @Path("/unknown")
    String unknown(WebTarget target) {
        return target.request().get(String.class);
    }
}
"#;
    let (root, src_dir) = write_fixture("jersey-injected", "ClientResource.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/resource/dog".to_string())]
    );
    let unresolved: Vec<&str> = completeness
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED")
        .map(|blocker| blocker.message.as_str())
        .collect();
    assert_eq!(unresolved.len(), 1, "{:?}", completeness.blockers);
    assert!(unresolved[0].contains("Jersey WebTarget URL"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jersey_lookalike_chains_are_not_clients_without_jaxrs_client_imports() {
    let source = r#"
package com.example.demo;

class Fluent {
    Fluent target(String value) { return this; }
    Fluent path(String value) { return this; }
    Fluent request() { return this; }
    Fluent get() { return this; }
}

class Runner {
    void run(Fluent fluent) {
        fluent.target("/api").path("orders").request().get();
    }
}
"#;
    let (root, src_dir) = write_fixture("jersey-lookalike", "Runner.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(
        payload.client_contracts.is_empty(),
        "{:?}",
        payload.client_contracts
    );
    assert!(
        completeness
            .blockers
            .iter()
            .all(|blocker| blocker.code != "JAVA_HTTP_CLIENT_MAPPING_UNRESOLVED"),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn wildcard_and_fully_qualified_client_imports_are_recognized() {
    let source = r#"
package com.example.demo;
import org.apache.hc.client5.http.classic.methods.*;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;

class ApacheImports {
    private final CloseableHttpClient client = null;

    void run() {
        HttpGet wild = new HttpGet("/api/wild");
        client.execute(wild);

        Object qualified = new org.apache.hc.client5.http.classic.methods.HttpGet("/api/fq");
        client.execute(qualified);
    }
}
"#;
    let (root, src_dir) = write_fixture("apache-import-forms", "ApacheImports.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/fq".to_string()),
            ("GET".to_string(), "/api/wild".to_string()),
        ]
    );
    assert!(completeness.complete, "{:?}", completeness.blockers);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn helidon_static_builder_import_is_recognized() {
    let source = r#"
package com.example.demo;
import io.helidon.webserver.Routing;
import static io.helidon.webserver.Routing.builder;

class StaticRoutes {
    static Routing routes() {
        Routing.Builder routes = builder();
        routes.get("/static-route", (req, res) -> {});
        return routes.build();
    }
}
"#;
    let (root, src_dir) = write_fixture("helidon-static-builder", "StaticRoutes.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/static-route".to_string())]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn jaxrs_wildcard_client_import_keeps_injected_targets() {
    let source = r#"
package com.example.demo;
import jakarta.ws.rs.client.*;
import org.glassfish.jersey.server.Uri;

class WildClient {
    String get(@Uri("/api/wild-client") WebTarget target) {
        return target.request().get(String.class);
    }
}
"#;
    let (root, src_dir) = write_fixture("jaxrs-wildcard-client", "WildClient.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|contract| {
            (
                contract.http_method.clone(),
                contract.normalized_route.clone(),
            )
        })
        .collect();
    assert_eq!(
        routes,
        vec![("GET".to_string(), "/api/wild-client".to_string())]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn builder_variables_are_recognized_in_dsl_lanes() {
    let helidon = r#"
package com.example.demo;
import io.helidon.webserver.Routing;

class HelidonVarRoutes {
    static Routing routes() {
        Routing.Builder builder = Routing.builder();
        builder.get("/var-a", (req, res) -> {});
        builder.post("/var-b", (req, res) -> {});
        return builder.build();
    }
}
"#;
    let webflux = r#"
package com.example.demo;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

class WebfluxVarRoutes {
    static RouterFunction<ServerResponse> routes() {
        RouterFunctions.Builder builder = RouterFunctions.route();
        builder.GET("/var-c", request -> ServerResponse.ok().build());
        builder.path("/var-nest", () -> RouterFunctions.route()
                .GET("/leaf", request -> ServerResponse.ok().build()));
        return builder.build();
    }
}
"#;
    let (root, src_dir) = write_fixture("builder-vars", "HelidonVarRoutes.java", helidon);
    std::fs::write(
        root.join("src/main/java/com/example/demo/WebfluxVarRoutes.java"),
        webflux,
    )
    .unwrap();
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/var-a".to_string()),
            ("GET".to_string(), "/var-c".to_string()),
            ("GET".to_string(), "/var-nest/leaf".to_string()),
            ("POST".to_string(), "/var-b".to_string()),
        ]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn webflux_static_imports_and_nested_paths_are_composed() {
    let source = r#"
package com.example.demo;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;
import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

class Routes {
    RouterFunction<ServerResponse> routes() {
        return route()
            .GET("/api/static", request -> ServerResponse.ok().build())
            .path("/nested", () -> route()
                .GET("/leaf", request -> ServerResponse.ok().build()))
            .build();
    }

    RouterFunction<ServerResponse> direct() {
        return route(GET("/api/one"), request -> ServerResponse.ok().build());
    }
}
"#;
    let (root, src_dir) = write_fixture("webflux-static", "Routes.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, _) = extractor.extract_payload("demo");
    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.identity.direction == ContractDirection::Response)
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();
    routes.sort();
    routes.dedup();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/one".to_string()),
            ("GET".to_string(), "/api/static".to_string()),
            ("GET".to_string(), "/nested/leaf".to_string()),
        ]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn webflux_nested_route_without_a_composed_prefix_is_blocked() {
    let source = r#"
package com.example.demo;
import static org.springframework.web.reactive.function.server.RouterFunctions.nest;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;
import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

class Routes {
    RouterFunction<ServerResponse> nested() {
        return nest(GET("/parent"),
            route().GET("/child", request -> ServerResponse.ok().build()));
    }
}
"#;
    let (root, src_dir) = write_fixture("webflux-nest", "Routes.java", source);
    let extractor = JavaRouteExtractor::new(root.clone(), &src_dir).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");
    assert!(
        payload
            .endpoints
            .iter()
            .all(|endpoint| { endpoint.identity.normalized_route.raw_path != "/child" }),
        "a nested route must not be published without its prefix: {:?}",
        payload
            .endpoints
            .iter()
            .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "JAVA_FUNCTIONAL_ROUTE_NEST_UNPARSED"),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(root);
}
