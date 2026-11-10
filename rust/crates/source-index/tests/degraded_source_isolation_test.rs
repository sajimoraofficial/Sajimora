//! degraded_source_isolation_test.rs
//!
//! Enterprise QA test for degraded source code resilience:
//! In real enterprise repositories, developers frequently have scratch files, WIP branches,
//! or draft files with syntax errors (unclosed braces, random characters).
//!
//! Invariant:
//! Malformed source files MUST NOT crash or abort the extraction pass.
//! The extractor must isolate the error to that file, and successfully extract
//! all valid endpoints, clients, and contracts from the rest of the codebase.

use source_index::java_routes::JavaRouteExtractor;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write_file(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn test_typescript_extractor_isolates_malformed_syntax_file() {
    let dir = tempdir().unwrap();
    let repo = dir.path();

    // 1. Valid production client
    write_file(
        repo,
        "src/validClient.ts",
        r#"
import axios from 'axios';

interface UserDto {
    id: string;
    name: string;
}

export function getUser(id: string) {
    return axios.get<UserDto>(`/api/users/${id}`);
}

export function listUsers() {
    return axios.get<UserDto[]>('/api/users');
}
"#,
    );

    // 2. Scratch / WIP file with broken, unparseable syntax
    write_file(
        repo,
        "src/scratch_broken.ts",
        r#"
// Incomplete scratch work with wild syntax errors
const broken = {{{;
function ???() {
    let x = 
"#,
    );

    // 3. Another scratch file with truncated template literals and unclosed parens
    write_file(
        repo,
        "src/wip/unclosed.ts",
        r#"
export const draft = (
`unterminated template literal
"#,
    );

    // Run extractor
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src"))
        .expect("Extractor initialization must succeed");

    let (payload, _) = extractor.extract_payload("ui-service", "backend-service");

    // The valid endpoints must be successfully extracted despite the broken sibling files!
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();

    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/users".to_string()),
            ("GET".to_string(), "/api/users/:param".to_string()),
        ],
        "Valid routes must be fully extracted despite unparseable files in source tree"
    );
}

#[test]
fn test_java_extractor_isolates_malformed_syntax_file() {
    let dir = tempdir().unwrap();
    let repo = dir.path();

    // 1. Valid Spring Boot controller
    write_file(
        repo,
        "src/main/java/com/example/OrderController.java",
        r#"package com.example;

import org.springframework.web.bind.annotation.*;

class OrderDto {
    public String id;
    public double amount;
}

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping("/{id}")
    public OrderDto getOrder(@PathVariable String id) {
        return new OrderDto();
    }

    @PostMapping
    public OrderDto createOrder(@RequestBody OrderDto order) {
        return order;
    }
}
"#,
    );

    // 2. Broken Java scratch file with invalid tokens
    write_file(
        repo,
        "src/main/java/com/example/BrokenDraft.java",
        r#"package com.example;

public class BrokenDraft {
    {{{ invalid syntax @@@ !!!
    void brokenMethod(
"#,
    );

    // Run Java extractor
    let extractor = JavaRouteExtractor::new(repo.to_path_buf(), &repo.join("src/main/java"))
        .expect("Java extractor must initialize");

    let (payload, _) = extractor.extract_payload("backend-service");

    let mut routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|e| (e.identity.http_method.clone(), e.identity.normalized_route.raw_path.clone()))
        .collect();
    routes.sort();
    routes.dedup();

    assert!(
        routes.contains(&("GET".to_string(), "/api/orders/{id}".to_string())),
        "GET /api/orders/{{id}} must be extracted: {:?}",
        routes
    );
    assert!(
        routes.contains(&("POST".to_string(), "/api/orders".to_string())),
        "POST /api/orders must be extracted: {:?}",
        routes
    );
}
