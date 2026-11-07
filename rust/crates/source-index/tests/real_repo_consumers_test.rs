//! Opt-in checks against real checkouts under E:/sajimora_real_repos.
//! Each test skips when the repository is absent.

use source_index::java_routes::JavaRouteExtractor;
use std::path::Path;

fn clients(repo: &str, java_root: &str) -> Option<Vec<(String, String)>> {
    let root = Path::new(repo);
    if !root.exists() {
        return None;
    }
    let extractor =
        JavaRouteExtractor::new(root.to_path_buf(), &root.join(java_root)).expect("extractor");
    let (payload, _) = extractor.extract_client_payload("svc", "backend");
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
    Some(routes)
}

#[test]
fn jersey_managed_client_example_yields_injected_target_consumers() {
    let Some(routes) = clients(
        "E:/sajimora_real_repos/jersey/examples/managed-client-simple-webapp",
        "src/main/java",
    ) else {
        return;
    };
    for expected in ["/resource/dog", "/resource/cat", "/resource/elefant"] {
        assert!(
            routes
                .iter()
                .any(|(method, route)| method == "GET" && route == expected),
            "missing {expected} in {routes:?}"
        );
    }
    assert!(
        routes
            .iter()
            .any(|(_, route)| route == "http://glassfish.java.net/"),
        "absolute @Uri target missing: {routes:?}"
    );
}

#[test]
fn micronaut_guide_returns_wire_bodies_not_http_response_wrappers() {
    let repo = "E:/sajimora_real_repos/micronaut-guides/guides/building-a-rest-api-spring-boot-vs-micronaut-get-list/micronautframework/java";
    let root = Path::new(repo);
    if !root.exists() {
        return;
    }
    let extractor = JavaRouteExtractor::new(root.to_path_buf(), &root.join("src/main/java"))
        .expect("extractor");
    let (payload, _) = extractor.extract_payload("svc");
    let response = payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.normalized_route.raw_path == "/subscriptions/{id}"
                && endpoint.identity.direction == contract_core::ir::ContractDirection::Response
        })
        .expect("response endpoint");
    assert!(
        matches!(
            response.body.as_ref(),
            Some(contract_core::ir::WireType::Ref(reference))
                if reference.r#ref.ends_with("SaasSubscription")
        ),
        "{:?}",
        response.body
    );
}
