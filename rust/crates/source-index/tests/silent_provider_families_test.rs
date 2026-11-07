use source_index::java_routes::JavaRouteExtractor;
use source_index::nestjs_routes::NestJsRouteExtractor;
use source_index::provider;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn write(repo: &Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn java_codes(repo: &Path) -> (Vec<String>, usize, bool) {
    let java_root = repo.join("src/main/java");
    let extractor = JavaRouteExtractor::new(repo.to_path_buf(), &java_root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("probe");
    let mut codes: Vec<String> = completeness
        .blockers
        .iter()
        .map(|b| b.code.clone())
        .collect();
    codes.sort();
    codes.dedup();
    (codes, payload.endpoints.len(), completeness.complete)
}

fn servlet_class() -> String {
    r#"
package com.legacy;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

public class ReportServlet extends HttpServlet {
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.getWriter().write("report");
    }
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.getWriter().write("created");
    }
}
"#
    .to_string()
}

#[test]
fn every_unsupported_provider_family_names_itself_instead_of_sealing_clean() {
    let cases: Vec<(&str, Vec<(&str, String)>)> = vec![
        (
            "servlet-api",
            vec![("src/main/java/com/legacy/ReportServlet.java", servlet_class())],
        ),
        (
            "servlet-annotated",
            vec![(
                "src/main/java/com/legacy/StatusServlet.java",
                r#"
package com.legacy;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

@WebServlet("/status")
public class StatusServlet extends HttpServlet {
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) { }
}
"#
                .to_string(),
            )],
        ),
        (
            "javalin",
            vec![(
                "src/main/java/com/app/Main.java",
                r#"
package com.app;
import io.javalin.Javalin;

public class Main {
    public static void main(String[] args) {
        Javalin.create().get("/things", ctx -> ctx.json("[]")).start(8080);
    }
}
"#
                .to_string(),
            )],
        ),
        (
            "struts1",
            vec![(
                "src/main/java/com/app/ListAction.java",
                r#"
package com.app;
import org.apache.struts.action.Action;
import org.apache.struts.action.ActionForm;
import org.apache.struts.action.ActionMapping;

public class ListAction extends Action {
    public Action execute(ActionMapping mapping, ActionForm form) { return mapping; }
}
"#
                .to_string(),
            )],
        ),
        (
            "undertow",
            vec![(
                "src/main/java/com/app/Server.java",
                r#"
package com.app;
import io.undertow.Undertow;

public class Server {
    public void start() {
        Undertow.builder().addHttpListener(8080, "localhost").build().start();
    }
}
"#
                .to_string(),
            )],
        ),
        (
            "dgs-graphql",
            vec![(
                "src/main/java/com/app/BookDataFetcher.java",
                r#"
package com.app;
import com.netflix.graphql.dgs.DgsComponent;
import com.netflix.graphql.dgs.DgsQuery;

@DgsComponent
public class BookDataFetcher {
    @DgsQuery
    public String books() { return "[]"; }
}
"#
                .to_string(),
            )],
        ),
        (
            "no-framework-at-all",
            vec![(
                "src/main/java/com/app/Calculator.java",
                "package com.app;\npublic class Calculator {\n    public int add(int a, int b) { return a + b; }\n}\n".to_string(),
            )],
        ),
    ];

    for (name, files) in cases {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        for (rel, content) in files {
            write(repo, rel, &content);
        }
        let (codes, endpoints, complete) = java_codes(repo);
        assert_eq!(
            endpoints, 0,
            "{name}: this probe declares no supported route"
        );
        assert!(
            !complete,
            "{name}: an empty artifact must never seal complete; blockers were {codes:?}"
        );
        assert!(
            !codes.is_empty(),
            "{name}: emptiness must carry at least one named reason"
        );
        let expected = if name == "no-framework-at-all" {
            "JAVA_NO_PROVIDER_EVIDENCE"
        } else if name == "servlet-annotated" || name == "servlet-api" {
            "JAVA_MAPPING_FRAMEWORK_UNPARSED"
        } else {
            "JAVA_MAPPING_FRAMEWORK_UNPARSED"
        };
        assert!(
            codes.iter().any(|code| code == expected),
            "{name}: expected {expected} in {codes:?}"
        );
    }
}

#[test]
fn servlet_descriptor_is_named_when_it_maps_urls() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/main/webapp/WEB-INF/web.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<web-app version="3.0">
  <servlet>
    <servlet-name>report</servlet-name>
    <servlet-class>com.legacy.ReportServlet</servlet-class>
  </servlet>
  <servlet-mapping>
    <servlet-name>report</servlet-name>
    <url-pattern>/report</url-pattern>
  </servlet-mapping>
</web-app>
"#,
    );
    write(
        repo,
        "src/main/java/com/legacy/Holder.java",
        "package com.legacy;\npublic class Holder { }\n",
    );
    let (codes, endpoints, complete) = java_codes(repo);
    assert_eq!(endpoints, 0);
    assert!(!complete, "{codes:?}");
    assert!(
        codes
            .iter()
            .any(|code| code == "JAVA_FRAMEWORK_CONFIG_UNPARSED"),
        "{codes:?}"
    );
}

#[test]
fn a_spring_app_that_declares_the_servlet_api_dependency_stays_clean() {
    // WAR-packaged Spring applications depend on the Servlet API without declaring any
    // Servlet route in it, so the build manifest must not be read as a provider claim.
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "pom.xml",
        "<project><dependencies><dependency><groupId>jakarta.servlet</groupId><artifactId>jakarta.servlet-api</artifactId></dependency></dependencies></project>",
    );
    write(
        repo,
        "src/main/java/com/app/ThingsController.java",
        r#"
package com.app;
import org.springframework.web.bind.annotation.*;

@RestController
public class ThingsController {
    @GetMapping("/things")
    public String things() { return "[]"; }
}
"#,
    );
    let (codes, endpoints, complete) = java_codes(repo);
    assert!(endpoints > 0);
    assert!(complete, "{codes:?}");
}

#[test]
fn supported_lanes_stay_clean_after_the_silent_guards() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write(
        repo,
        "src/main/java/com/demo/ThingsController.java",
        r#"
package com.demo;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/things")
public class ThingsController {
    @GetMapping("/{id}")
    public String one(@PathVariable String id) { return id; }
}
"#,
    );
    // A Spring configuration class touching the Servlet API must not read as a
    // Servlet provider (this is the shape that exists in JHipster's WebConfigurer).
    write(
        repo,
        "src/main/java/com/demo/WebConfigurer.java",
        r#"
package com.demo;
import jakarta.servlet.ServletContext;
import org.springframework.boot.web.servlet.ServletContextInitializer;

public class WebConfigurer implements ServletContextInitializer {
    public void onStartup(ServletContext servletContext) { }
}
"#,
    );
    // Spring Boot's own web.xml carries only mime mappings.
    write(
        repo,
        "src/main/webapp/WEB-INF/web.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<web-app version="3.0">
  <mime-mapping><extension>html</extension><mime-type>text/html</mime-type></mime-mapping>
</web-app>
"#,
    );

    let java_root = repo.join("src/main/java");
    let extractor = JavaRouteExtractor::new(repo.to_path_buf(), &java_root).expect("extractor");
    let (payload, completeness) = extractor.extract_payload("demo");
    assert!(
        !payload.endpoints.is_empty(),
        "Spring route must still be extracted"
    );
    assert!(
        completeness.complete,
        "a supported lane must not gain silent-completeness noise: {:?}",
        completeness.blockers
    );
}

#[test]
fn procedure_and_dsl_only_node_servers_are_named_not_sealed_empty() {
    for (package, name) in [
        ("@trpc/server", "tRPC"),
        ("@adonisjs/core", "AdonisJS"),
        ("@feathersjs/feathers", "Feathers"),
        ("@loopback/rest", "LoopBack"),
    ] {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        write(
            repo,
            "package.json",
            &format!("{{\"dependencies\":{{\"{}\":\"1.0.0\"}}}}", package),
        );
        write(
            repo,
            "src/server.ts",
            "export const server = createServer();\n",
        );
        let detected = provider::detect_unsupported_ts_framework(repo)
            .unwrap_or_else(|| panic!("{package} must be named as unsupported"));
        assert_eq!(detected.0, name, "{package}");
    }
}

#[test]
fn nest_graphql_resolvers_are_named_alongside_rest_controllers() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    let src = repo.join("src");
    write(
        &src,
        "articles.controller.ts",
        r#"
import { Controller, Get } from '@nestjs/common';
@Controller('articles')
export class ArticlesController {
    @Get()
    list(): string[] { return []; }
}
"#,
    );
    write(
        &src,
        "articles.resolver.ts",
        r#"
import { Resolver, Query } from '@nestjs/graphql';
@Resolver()
export class ArticlesResolver {
    @Query(() => String)
    hello(): string { return 'hi'; }
}
"#,
    );

    let extractor = NestJsRouteExtractor::new(repo.to_path_buf(), &src).expect("extractor");
    let envelope = extractor
        .build_envelope("nest-svc", None, "HEAD")
        .expect("envelope");
    let codes: Vec<String> = envelope
        .completeness
        .blockers
        .iter()
        .map(|b| b.code.clone())
        .collect();
    assert!(
        codes.iter().any(|code| code == "NESTJS_GRAPHQL_UNMODELED"),
        "{codes:?}"
    );
    assert!(!envelope.completeness.complete);
    let contract_core::envelope::ArtifactPayload::Backend(payload) = &envelope.payload else {
        panic!("backend payload");
    };
    assert!(
        payload
            .endpoints
            .iter()
            .any(|endpoint| endpoint.identity.normalized_route.raw_path == "/articles"),
        "the REST controller must still be extracted: {:?}",
        payload
            .endpoints
            .iter()
            .map(|endpoint| endpoint.identity.normalized_route.raw_path.clone())
            .collect::<Vec<_>>()
    );
}
