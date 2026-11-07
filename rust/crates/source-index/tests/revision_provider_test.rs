use contract_core::envelope::ArtifactPayload;
use source_index::revision::{
    blob_oid, extract_listing, extract_working_tree, BackendScope, ListingSource,
};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_repo(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "sajimora-revision-{name}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_file(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn listing(root: &Path, rels: &[&str]) -> Vec<(String, String, Option<u64>)> {
    rels.iter()
        .map(|rel| {
            let bytes = fs::read(root.join(rel)).unwrap();
            (
                (*rel).to_string(),
                blob_oid(&bytes),
                Some(bytes.len() as u64),
            )
        })
        .collect()
}

fn route_of(env: &contract_core::envelope::ContractArtifactEnvelope) -> Option<String> {
    match &env.payload {
        ArtifactPayload::Backend(payload) => payload
            .endpoints
            .iter()
            .find(|endpoint| {
                endpoint.identity.direction == contract_core::ir::ContractDirection::Response
            })
            .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone()),
        _ => None,
    }
}

#[test]
fn revision_extracts_express_routes() {
    let root = temp_repo("express");
    write_file(
        &root,
        "package.json",
        r#"{"dependencies":{"express":"^4.18.2"}}"#,
    );
    write_file(
        &root,
        "src/index.ts",
        r#"
import express, { Request, Response } from 'express';
interface HealthDto { status: string; }
const app = express();
app.get('/api/health', (req: Request, res: Response<HealthDto>) => {
    res.json({ status: 'ok' });
});
"#,
    );

    let backend = BackendScope::new(&root, "");
    let tree = extract_working_tree(&root, &backend, "health-service").unwrap();
    assert_eq!(tree.profile.framework_profile.as_deref(), Some("EXPRESS"));
    assert_eq!(route_of(&tree).as_deref(), Some("/api/health"));

    let env = extract_listing(
        &root,
        &backend,
        "health-service",
        listing(&root, &["package.json", "src/index.ts"]),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();
    assert_eq!(env.profile.framework_profile.as_deref(), Some("EXPRESS"));
    assert_eq!(route_of(&env).as_deref(), Some("/api/health"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_extracts_nextjs_routes() {
    let root = temp_repo("next");
    write_file(
        &root,
        "package.json",
        r#"{"dependencies":{"next":"^14.0.0","react":"^18.0.0"}}"#,
    );
    write_file(
        &root,
        "src/app/api/orders/route.ts",
        r#"
interface OrderDto { id: string; total: number; }
export async function GET(): Promise<NextResponse<OrderDto>> {
    return NextResponse.json({ id: '1', total: 9.5 });
}
"#,
    );

    let backend = BackendScope::new(&root, "");
    let tree = extract_working_tree(&root, &backend, "order-service").unwrap();
    assert_eq!(tree.profile.framework_profile.as_deref(), Some("NEXTJS"));
    assert_eq!(route_of(&tree).as_deref(), Some("/api/orders"));

    let env = extract_listing(
        &root,
        &backend,
        "order-service",
        listing(&root, &["package.json", "src/app/api/orders/route.ts"]),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();
    assert_eq!(env.profile.framework_profile.as_deref(), Some("NEXTJS"));
    assert_eq!(route_of(&env).as_deref(), Some("/api/orders"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_names_unsupported_ts_backend_instead_of_empty_complete() {
    let root = temp_repo("h3");
    write_file(&root, "package.json", r#"{"dependencies":{"h3":"^1.0.0"}}"#);
    write_file(
        &root,
        "src/index.ts",
        "import { createApp } from 'h3';\nconst app = createApp();\napp.use('/api', () => ({ ok: true }));\n",
    );

    let backend = BackendScope::new(&root, "");
    for env in [
        extract_working_tree(&root, &backend, "koa-service").unwrap(),
        extract_listing(
            &root,
            &backend,
            "koa-service",
            listing(&root, &["package.json", "src/index.ts"]),
            ListingSource::WorkingTree,
            "HEAD",
            "HEAD",
        )
        .unwrap(),
    ] {
        assert!(
            !env.completeness.complete,
            "unsupported TS must not be complete"
        );
        let blocker = env
            .completeness
            .blockers
            .iter()
            .find(|blocker| blocker.code == "TS_MAPPING_FRAMEWORK_UNPARSED")
            .expect("unsupported TS framework must be named");
        assert!(blocker.message.contains("H3"), "{}", blocker.message);
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_extracts_jax_rs_routes() {
    let root = temp_repo("jaxrs");
    write_file(
        &root,
        "src/main/java/com/demo/ItemResource.java",
        r#"
package com.demo;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
@Path("/api/items")
public class ItemResource {
    @GET
    public String list() { return "items"; }
}
"#,
    );

    let backend = BackendScope::new(&root, "");
    let tree = extract_working_tree(&root, &backend, "item-service").unwrap();
    assert_eq!(tree.profile.framework_profile.as_deref(), Some("JAX_RS"));
    assert_eq!(route_of(&tree).as_deref(), Some("/api/items"));

    let env = extract_listing(
        &root,
        &backend,
        "item-service",
        listing(&root, &["src/main/java/com/demo/ItemResource.java"]),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();
    assert_eq!(env.profile.framework_profile.as_deref(), Some("JAX_RS"));
    assert_eq!(route_of(&env).as_deref(), Some("/api/items"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_marks_kotlin_sources_unparsed() {
    let root = temp_repo("kotlin");
    write_file(
        &root,
        "pom.xml",
        r#"<project><artifactId>kotlin-service</artifactId></project>"#,
    );
    write_file(
        &root,
        "src/main/kotlin/com/demo/KotlinController.kt",
        r#"
package com.demo
import org.springframework.web.bind.annotation.*
@RestController
class KotlinController {
    @GetMapping("/api/kotlin")
    fun get(): String = "ok"
}
"#,
    );

    let backend = BackendScope::new(&root, "");
    let env = extract_listing(
        &root,
        &backend,
        "kotlin-service",
        listing(
            &root,
            &["pom.xml", "src/main/kotlin/com/demo/KotlinController.kt"],
        ),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();

    assert_eq!(env.profile.framework_profile.as_deref(), Some("SPRING_MVC"));
    assert!(!env.completeness.complete);
    assert!(
        env.completeness
            .blockers
            .iter()
            .any(|b| b.code == "JAVA_SOURCE_NOT_PARSED"),
        "a Kotlin-only revision must carry the Kotlin blocker, got {:?}",
        env.completeness.blockers
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_extracts_sveltekit_routes() {
    let root = temp_repo("sveltekit");
    write_file(
        &root,
        "package.json",
        r#"{"dependencies":{"@sveltejs/kit":"^2.0.0"}}"#,
    );
    write_file(
        &root,
        "src/routes/api/health/+server.ts",
        "import { json } from '@sveltejs/kit';\nexport const GET = async () => json({ ok: true });\n",
    );

    let backend = BackendScope::new(&root, "");
    let env = extract_listing(
        &root,
        &backend,
        "svelte-service",
        listing(&root, &["package.json", "src/routes/api/health/+server.ts"]),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();
    assert_eq!(env.profile.framework_profile.as_deref(), Some("SVELTEKIT"));
    assert_eq!(route_of(&env).as_deref(), Some("/api/health"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn revision_marks_scala_and_groovy_sources_unparsed() {
    let root = temp_repo("jvm-families");
    write_file(
        &root,
        "pom.xml",
        r#"<project><artifactId>jvm-service</artifactId></project>"#,
    );
    write_file(
        &root,
        "src/main/java/com/demo/DemoController.java",
        "package com.demo;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class DemoController {\n    @GetMapping(\"/api/demo\")\n    public String demo() { return \"ok\"; }\n}\n",
    );
    write_file(
        &root,
        "src/main/scala/com/demo/ScalaController.scala",
        "package com.demo\n@RestController\nclass ScalaController\n",
    );
    write_file(
        &root,
        "src/main/groovy/com/demo/GroovyController.groovy",
        "package com.demo\nclass GroovyController {}\n",
    );

    let backend = BackendScope::new(&root, "");
    let env = extract_listing(
        &root,
        &backend,
        "jvm-service",
        listing(
            &root,
            &[
                "pom.xml",
                "src/main/java/com/demo/DemoController.java",
                "src/main/scala/com/demo/ScalaController.scala",
                "src/main/groovy/com/demo/GroovyController.groovy",
            ],
        ),
        ListingSource::WorkingTree,
        "HEAD",
        "HEAD",
    )
    .unwrap();

    let messages: Vec<&str> = env
        .completeness
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

#[test]
fn revision_names_graphql_server_instead_of_empty_complete() {
    let root = temp_repo("graphql");
    write_file(
        &root,
        "package.json",
        r#"{"dependencies":{"@apollo/server":"^4.0.0","graphql":"^16.0.0"}}"#,
    );
    write_file(
        &root,
        "src/index.ts",
        "import { ApolloServer } from '@apollo/server';\nconst server = new ApolloServer({ typeDefs: 'type Query { ok: Boolean }' });\nexport default server;\n",
    );

    let backend = BackendScope::new(&root, "");
    for env in [
        extract_working_tree(&root, &backend, "graphql-service").unwrap(),
        extract_listing(
            &root,
            &backend,
            "graphql-service",
            listing(&root, &["package.json", "src/index.ts"]),
            ListingSource::WorkingTree,
            "HEAD",
            "HEAD",
        )
        .unwrap(),
    ] {
        assert!(
            !env.completeness.complete,
            "a GraphQL server must not be complete"
        );
        let blocker = env
            .completeness
            .blockers
            .iter()
            .find(|blocker| blocker.code == "TS_MAPPING_FRAMEWORK_UNPARSED")
            .expect("GraphQL server must be named");
        assert!(blocker.message.contains("GraphQL"), "{}", blocker.message);
    }

    let _ = fs::remove_dir_all(root);
}
