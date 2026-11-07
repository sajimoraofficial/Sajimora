use std::path::PathBuf;

#[tokio::test]
async fn test_query_and_what_if_on_thingsboard() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    if !tb_path.exists() {
        return;
    }
    let allowed_roots = vec![tb_path.clone()];

    // Test 1: Stats query
    let mut stats_args = serde_json::Map::new();
    stats_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
    stats_args.insert("queryType".to_string(), serde_json::json!("stats"));

    let stats_res = sajimora_mcp::query::run_query(&allowed_roots, &stats_args)
        .expect("Stats query should succeed");
    println!("Stats response: {}", stats_res);
    assert!(stats_res.contains("backendEndpoints"));
    assert!(stats_res.contains("consumerContracts"));

    // Test 2: consumers_by_route
    let mut route_args = serde_json::Map::new();
    route_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
    route_args.insert(
        "queryType".to_string(),
        serde_json::json!("consumers_by_route"),
    );
    route_args.insert("target".to_string(), serde_json::json!("/api/user/{id}"));

    let route_res = sajimora_mcp::query::run_query(&allowed_roots, &route_args)
        .expect("Route query should succeed");
    println!("Route query response: {}", route_res);
    assert!(route_res.contains("matchCount"));

    // Test 3: what_if symbolic mutation (unretained firstName -> givenName)
    let mut what_if_args = serde_json::Map::new();
    what_if_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
    what_if_args.insert(
        "mutation".to_string(),
        serde_json::json!({
            "action": "RENAME_FIELD",
            "targetDto": "User",
            "field": "firstName",
            "renameTo": "givenName",
            "jsonPropertyRetained": false
        }),
    );

    let what_if_res = sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_args)
        .expect("What if should succeed");
    println!("What if response: {}", what_if_res);
    assert!(what_if_res.contains("BREAKING_CHANGE"));
    assert!(what_if_res.contains("@JsonProperty"));

    // Test 4: what_if with jsonPropertyRetained: true
    let mut what_if_safe_args = serde_json::Map::new();
    what_if_safe_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
    what_if_safe_args.insert(
        "mutation".to_string(),
        serde_json::json!({
            "action": "RENAME_FIELD",
            "targetDto": "User",
            "field": "firstName",
            "renameTo": "givenName",
            "jsonPropertyRetained": true
        }),
    );

    let what_if_safe_res = sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_safe_args)
        .expect("What if safe should succeed");
    println!("What if safe response: {}", what_if_safe_res);
    assert!(what_if_safe_res.contains("NON_BREAKING_PRESERVED"));
}
