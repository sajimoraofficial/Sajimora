use source_index::java_routes::JavaRouteExtractor;
use std::path::PathBuf;

fn fixture(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "sajimora-client-scope-{}-{}",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    for (rel, content) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    root
}

fn feign_client(package: &str, path: &str, line: &str) -> String {
    format!(
        r#"
package {package};
import feign.FeignClient;
import feign.RequestLine;

class Item {{ public String id; }}

@FeignClient(name = "item-service", path = "{path}")
interface ItemClient {{
    @RequestLine("GET {line}")
    Item get();
}}
"#
    )
}

#[test]
fn client_contracts_are_scoped_to_the_requested_module() {
    let root = fixture(
        "scoped",
        &[
            (
                "a/src/main/java/com/example/a/AClient.java",
                &feign_client("com.example.a", "/a", "/one"),
            ),
            (
                "b/src/main/java/com/example/b/BClient.java",
                &feign_client("com.example.b", "/b", "/two"),
            ),
        ],
    );
    let scope = root.join("a/src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(extractor.has_client_interfaces());
    let (payload, _) = extractor.extract_client_payload("demo", "item-service");
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(routes, vec![("GET".to_string(), "/a/one".to_string())]);
    assert!(payload.client_contracts.iter().all(|c| {
        c.consumers
            .iter()
            .all(|consumer| consumer.file.starts_with("a/"))
    }));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn webclient_method_chain_is_extracted() {
    let root = fixture(
        "webclient-method",
        &[(
            "src/main/java/com/example/demo/WebCaller.java",
            r#"
package com.example.demo;
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

public class WebCaller {
    private final WebClient webClient = WebClient.create("http://localhost");

    public void update(String body) {
        webClient.method(HttpMethod.PUT).uri("/things/1").bodyValue(body)
            .retrieve().bodyToMono(String.class);
    }
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(extractor.has_client_evidence());
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(routes, vec![("PUT".to_string(), "/things/1".to_string())]);
    assert!(
        completeness.blockers.is_empty(),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn generated_sdk_invoke_api_wrapper_is_extracted() {
    let root = fixture(
        "sdk-wrapper",
        &[
            (
                "src/main/java/com/example/demo/ApiClient.java",
                r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;

public class ApiClient {
    protected RestTemplate restTemplate;
    public String invokeAPI(String path, String method) { return path + method; }
}
"#,
            ),
            (
                "src/main/java/com/example/demo/WidgetApi.java",
                r#"
package com.example.demo;
import org.springframework.http.HttpMethod;

public class WidgetApi {
    private final ApiClient apiClient = new ApiClient();

    public String get() {
        return apiClient.invokeAPI("/widgets/1", HttpMethod.GET);
    }
}
"#,
            ),
        ],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(extractor.has_client_evidence());
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(routes, vec![("GET".to_string(), "/widgets/1".to_string())]);
    assert!(
        completeness.blockers.is_empty(),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn invoke_api_without_an_http_client_field_is_not_a_contract() {
    let root = fixture(
        "sdk-negative",
        &[(
            "src/main/java/com/example/demo/WidgetApi.java",
            r#"
package com.example.demo;

class Helper {
    public String invokeAPI(String path, String method) { return path + method; }
}

class WidgetApi {
    private final Helper apiClient = new Helper();

    public String get() {
        return apiClient.invokeAPI("/widgets/1", "GET");
    }
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    let (payload, _) = extractor.extract_client_payload("demo", "backend");
    assert!(
        payload.client_contracts.is_empty(),
        "a non-HTTP helper named invokeAPI must not become a client contract"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn local_rest_client_receiver_is_extracted() {
    let root = fixture(
        "local-restclient",
        &[(
            "src/main/java/com/example/demo/Runner.java",
            r#"
package com.example.demo;
import org.springframework.web.client.RestClient;

public class Runner {
    public void run(RestClient.Builder builder) {
        RestClient restClient = builder.baseUrl("http://localhost:8080").build();
        restClient.get().uri("/api/random").retrieve().body(String.class);
    }
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(extractor.has_client_evidence());
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(routes, vec![("GET".to_string(), "/api/random".to_string())]);
    assert!(
        completeness.blockers.is_empty(),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn jersey_style_invoke_api_argument_order_is_extracted() {
    let root = fixture(
        "sdk-jersey-order",
        &[
            (
                "src/main/java/com/example/demo/ApiClient.java",
                r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;

public class ApiClient {
    protected RestTemplate restTemplate;
    public String invokeAPI(String op, String path, String method) { return op; }
}
"#,
            ),
            (
                "src/main/java/com/example/demo/WidgetApi.java",
                r#"
package com.example.demo;

public class WidgetApi {
    private final ApiClient apiClient = new ApiClient();
    public String update() {
        return apiClient.invokeAPI("WidgetApi.update", "/widgets/2", "PATCH");
    }
}
"#,
            ),
        ],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    let (payload, _) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(
        routes,
        vec![("PATCH".to_string(), "/widgets/2".to_string())]
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn okhttp_build_call_with_a_local_path_is_extracted() {
    let root = fixture(
        "sdk-buildcall",
        &[
            (
                "src/main/java/com/example/demo/ApiClient.java",
                r#"
package com.example.demo;
import okhttp3.OkHttpClient;

public class ApiClient {
    protected OkHttpClient httpClient;
    public Object buildCall(String base, String path, String method) { return path; }
}
"#,
            ),
            (
                "src/main/java/com/example/demo/WidgetApi.java",
                r#"
package com.example.demo;

public class WidgetApi {
    private final ApiClient apiClient = new ApiClient();
    public Object delete() {
        String localVarPath = "/widgets/3";
        return apiClient.buildCall("", localVarPath, "DELETE");
    }
}
"#,
            ),
        ],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    let (payload, _) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(
        routes,
        vec![("DELETE".to_string(), "/widgets/3".to_string())]
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn plain_request_line_interface_is_a_client() {
    let root = fixture(
        "feign-request-line",
        &[(
            "src/main/java/com/example/demo/WidgetClient.java",
            r#"
package com.example.demo;
import feign.RequestLine;

public interface WidgetClient {
    @RequestLine("GET /widgets")
    String list();
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(extractor.has_client_interfaces());
    let (payload, _) = extractor.extract_client_payload("demo", "backend");
    let routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    assert_eq!(routes, vec![("GET".to_string(), "/widgets".to_string())]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn unrecognized_generated_wrapper_is_a_named_blocker() {
    let root = fixture(
        "sdk-unrecognized",
        &[(
            "src/main/java/com/example/demo/ApiClient.java",
            r#"
package com.example.demo;
import okhttp3.OkHttpClient;

public class ApiClient {
    private OkHttpClient httpClient;

    public void prepareRequest(String path) {
        this.prepareRequest(path);
    }
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert!(payload.client_contracts.is_empty());
    assert!(
        completeness
            .blockers
            .iter()
            .any(|blocker| blocker.code == "JAVA_HTTP_CLIENT_UNRECOGNIZED"),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn imperative_only_repositories_report_client_evidence() {
    let root = fixture(
        "imperative",
        &[(
            "src/main/java/com/example/demo/ApiCaller.java",
            r#"
package com.example.demo;
import org.springframework.web.client.RestTemplate;

public class ApiCaller {
    private final RestTemplate restTemplate = new RestTemplate();

    public String fetch() {
        return restTemplate.getForObject("/things", String.class);
    }
}
"#,
        )],
    );
    let scope = root.join("src/main/java");
    let extractor = JavaRouteExtractor::new(root.clone(), &scope).expect("extractor");
    assert!(!extractor.has_client_interfaces());
    assert!(extractor.has_client_evidence());
    let (payload, completeness) = extractor.extract_client_payload("demo", "backend");
    assert_eq!(payload.client_contracts.len(), 1);
    assert_eq!(payload.client_contracts[0].http_method, "GET");
    assert_eq!(payload.client_contracts[0].normalized_route, "/things");
    assert!(
        completeness.blockers.is_empty(),
        "{:?}",
        completeness.blockers
    );
    let _ = std::fs::remove_dir_all(&root);
}
