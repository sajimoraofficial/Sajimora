//! synthesis.rs — Contract-guided property test synthesizers.
//!
//! Generates:
//! - JUnit 5 integration tests for Java Spring Boot controllers (MockMvc)
//! - JUnit 4 vintage integration tests for Java Spring Boot controllers (MockMvc)
//! - jqwik property tests for Java Spring Boot controllers (MockMvc + Arbitrary generators)
//! - fast-check property tests for TypeScript HTTP clients
//!
//! Enforces strict abstention: if a type is WireType::Unknown, generation for that
//! endpoint abstains with an explicit comment rather than emitting invalid code.

use crate::envelope::{ArtifactPayload, ContractArtifactEnvelope};
use crate::ir::{ContractDirection, PrimitiveScalar, StatusCodeFamily, WireType};
use crate::report::ReasonCode;
use crate::request_synthesis::{
    synthesize_request, validate_fixtures, EndpointRequestFixture, RequestFixtures,
};
use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, HashSet};

/// Counts emitted checks, not annotations or claimed endpoint coverage. Partial and
/// status-only checks never imply full response-contract verification.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SynthesisSummary {
    pub framework: String,
    pub executable_contract_checks: usize,
    pub diagnostics: usize,
    pub abstentions: usize,
    pub partial_checks: usize,
    pub status_only_checks: usize,
    pub assertions_generated: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct SynthesisOutput {
    pub code: String,
    pub summary: SynthesisSummary,
}

impl SynthesisSummary {
    fn new(framework: TestSynthesisFramework) -> Self {
        Self {
            framework: framework.to_string(),
            assertions_generated: Some(0),
            ..Self::default()
        }
    }

    fn record_check(&mut self, assertions: usize, partial: bool) {
        if assertions == 0 {
            self.status_only_checks += 1;
        } else {
            self.executable_contract_checks += 1;
            self.partial_checks += usize::from(partial);
        }
        *self
            .assertions_generated
            .as_mut()
            .expect("initialized count") += assertions;
    }
}

/// Structured results from the same emission path as the legacy string wrappers.
/// Passing fixtures for non-JUnit5 frameworks remains explicitly unsupported.
pub fn synthesize_tests_with_summary(
    envelope: &ContractArtifactEnvelope,
    framework: TestSynthesisFramework,
    name: Option<&str>,
    package: Option<&str>,
    fixtures: Option<&RequestFixtures>,
    options: SynthesisOptions,
) -> Result<SynthesisOutput> {
    if fixtures.is_some()
        && !matches!(
            framework,
            TestSynthesisFramework::JUnit5
                | TestSynthesisFramework::FastCheck
                | TestSynthesisFramework::Supertest
        )
    {
        return Err(anyhow!(
            "Request fixtures currently require junit5 or fast-check"
        ));
    }
    match framework {
        TestSynthesisFramework::JUnit5 => synthesize_junit5_with_request_fixtures(
            envelope,
            name,
            package,
            fixtures.unwrap_or(&RequestFixtures::default()),
            options,
        ),
        TestSynthesisFramework::JUnit4 => synthesize_junit4_output(envelope, name, package),
        TestSynthesisFramework::Jqwik => synthesize_jqwik_output(envelope, name, package),
        TestSynthesisFramework::FastCheck => synthesize_fast_check_output(
            envelope,
            name,
            fixtures.unwrap_or(&RequestFixtures::default()),
        ),
        TestSynthesisFramework::Supertest => synthesize_supertest_output(
            envelope,
            name,
            fixtures.unwrap_or(&RequestFixtures::default()),
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestSynthesisFramework {
    JUnit5,
    JUnit4,
    Jqwik,
    FastCheck,
    Supertest,
}

impl std::str::FromStr for TestSynthesisFramework {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "junit5" | "junit" | "java" => Ok(TestSynthesisFramework::JUnit5),
            "junit4" | "vintage" => Ok(TestSynthesisFramework::JUnit4),
            "jqwik" => Ok(TestSynthesisFramework::Jqwik),
            "fast-check" | "fastcheck" | "ts" | "typescript" => Ok(TestSynthesisFramework::FastCheck),
            "supertest" | "jest" | "nestjs" => Ok(TestSynthesisFramework::Supertest),
            other => Err(anyhow!(
                "Unknown synthesis framework: '{}'. Expected 'junit5', 'junit4', 'jqwik', or 'fast-check'",
                other
            )),
        }
    }
}

impl std::fmt::Display for TestSynthesisFramework {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TestSynthesisFramework::JUnit5 => write!(f, "junit5"),
            TestSynthesisFramework::JUnit4 => write!(f, "junit4"),
            TestSynthesisFramework::Jqwik => write!(f, "jqwik"),
            TestSynthesisFramework::FastCheck => write!(f, "fast-check"),
            TestSynthesisFramework::Supertest => write!(f, "supertest"),
        }
    }
}

pub fn synthesize_tests(
    envelope: &ContractArtifactEnvelope,
    framework: TestSynthesisFramework,
    class_or_suite_name: Option<&str>,
) -> Result<String> {
    synthesize_tests_with_package(envelope, framework, class_or_suite_name, None)
}

pub fn synthesize_tests_with_package(
    envelope: &ContractArtifactEnvelope,
    framework: TestSynthesisFramework,
    class_or_suite_name: Option<&str>,
    package_name: Option<&str>,
) -> Result<String> {
    match framework {
        TestSynthesisFramework::JUnit5 => {
            synthesize_junit5(envelope, class_or_suite_name, package_name)
        }
        TestSynthesisFramework::JUnit4 => {
            synthesize_junit4(envelope, class_or_suite_name, package_name)
        }
        TestSynthesisFramework::Jqwik => {
            synthesize_jqwik_with_package(envelope, class_or_suite_name, package_name)
        }
        TestSynthesisFramework::FastCheck => synthesize_fast_check(envelope, class_or_suite_name),
        TestSynthesisFramework::Supertest => synthesize_supertest(envelope, class_or_suite_name),
    }
}

// ---------------------------------------------------------------------------
// JUnit 5 Synthesizer (Java Standard)
// ---------------------------------------------------------------------------

pub fn synthesize_junit5(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
) -> Result<String> {
    synthesize_junit5_with_request_fixtures(
        envelope,
        class_name_opt,
        package_name_opt,
        &RequestFixtures::default(),
        SynthesisOptions::default(),
    )
    .map(|output| output.code)
}

/// Facts about the project the generated suite will compile in.
#[derive(Debug, Clone, Copy)]
pub struct SynthesisOptions {
    /// Target Spring Boot major version. `@AutoConfigureMockMvc` moved from
    /// `org.springframework.boot.test.autoconfigure.web.servlet` to
    /// `org.springframework.boot.webmvc.test.autoconfigure` in Boot 4, so the import must match
    /// the project or the generated file cannot compile.
    pub spring_boot_major: u8,
}

impl Default for SynthesisOptions {
    fn default() -> Self {
        Self {
            spring_boot_major: 3,
        }
    }
}

fn mockmvc_autoconfigure_import(options: SynthesisOptions) -> &'static str {
    if options.spring_boot_major >= 4 {
        "org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc"
    } else {
        "org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc"
    }
}

pub fn synthesize_tests_with_options(
    envelope: &ContractArtifactEnvelope,
    framework: TestSynthesisFramework,
    class_name: Option<&str>,
    package_name: Option<&str>,
    fixtures: &RequestFixtures,
    options: SynthesisOptions,
) -> Result<String> {
    if framework != TestSynthesisFramework::JUnit5 {
        return Err(anyhow!(
            "Request fixtures currently require the junit5 framework"
        ));
    }
    synthesize_junit5_with_request_fixtures(envelope, class_name, package_name, fixtures, options)
        .map(|output| output.code)
}

pub fn synthesize_tests_with_request_fixtures(
    envelope: &ContractArtifactEnvelope,
    framework: TestSynthesisFramework,
    class_name: Option<&str>,
    package_name: Option<&str>,
    fixtures: &RequestFixtures,
) -> Result<String> {
    synthesize_tests_with_options(
        envelope,
        framework,
        class_name,
        package_name,
        fixtures,
        SynthesisOptions::default(),
    )
}

fn synthesize_junit5_with_request_fixtures(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
    fixtures: &RequestFixtures,
    options: SynthesisOptions,
) -> Result<SynthesisOutput> {
    let mut summary = SynthesisSummary::new(TestSynthesisFramework::JUnit5);
    let payload = match &envelope.payload {
        ArtifactPayload::Backend(p) => p,
        _ => {
            return Err(anyhow!(
                "JUnit 5 test synthesis requires a Backend contract artifact"
            ))
        }
    };
    validate_fixtures(fixtures, &payload.endpoints)?;
    let class_name = class_name_opt.unwrap_or("ContractTest");
    let type_pool = payload.type_pool.as_ref();
    let has_auth = fixtures.authentication.is_some()
        || fixtures
            .endpoints
            .values()
            .any(|fixture| fixture.authentication.is_some());
    let has_sql = !fixtures.setup_sql.is_empty()
        || !fixtures.cleanup_sql.is_empty()
        || fixtures
            .endpoints
            .values()
            .any(|fixture| !fixture.setup_sql.is_empty() || !fixture.cleanup_sql.is_empty());
    let mut out = String::new();
    if let Some(pkg) = package_name_opt.filter(|pkg| !pkg.trim().is_empty()) {
        out.push_str(&format!("package {};\n\n", pkg.trim()));
    }
    out.push_str("// Generated by Sajimora Native Synthesis (JUnit 5)\n");
    out.push_str("import org.junit.jupiter.api.Test;\n");
    out.push_str("import org.springframework.beans.factory.annotation.Autowired;\n");
    out.push_str(&format!(
        "import {};\n",
        mockmvc_autoconfigure_import(options)
    ));
    out.push_str("import org.springframework.boot.test.context.SpringBootTest;\n");
    out.push_str("import org.springframework.http.MediaType;\n");
    out.push_str("import org.springframework.test.context.ActiveProfiles;\n");
    out.push_str("import org.springframework.test.web.servlet.MockMvc;\n");
    out.push_str("import org.springframework.test.web.servlet.MvcResult;\n");
    out.push_str("import org.springframework.test.web.servlet.ResultActions;\n");
    out.push_str(
        "import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;\n",
    );
    if fixtures.transactional {
        out.push_str("import org.springframework.transaction.annotation.Transactional;\n");
    }
    if has_sql {
        out.push_str("import org.springframework.jdbc.core.JdbcTemplate;\n");
    }
    if has_auth {
        out.push_str("import org.springframework.security.core.userdetails.UserDetailsService;\n");
        out.push_str("import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;\n");
        out.push_str("import org.springframework.security.core.context.SecurityContextHolder;\n");
    }
    out.push_str(
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;\n",
    );
    out.push_str(
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;\n\n",
    );
    out.push_str(
        "@SpringBootTest\n@AutoConfigureMockMvc(addFilters = false)\n@ActiveProfiles(\"test\")\n",
    );
    out.push_str(&format!("public class {} {{\n\n", class_name));
    out.push_str("    @Autowired\n    private MockMvc mockMvc;\n\n");
    if has_sql {
        out.push_str("    @Autowired\n    private JdbcTemplate jdbcTemplate;\n\n");
    }
    if has_auth {
        out.push_str("    @Autowired\n    private UserDetailsService userDetailsService;\n\n");
    }
    let mut method_counter = 0;
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction != ContractDirection::Response {
            continue;
        }
        method_counter += 1;
        let route = &endpoint.identity.normalized_route.raw_path;
        let verb = endpoint.identity.http_method.to_uppercase();
        let slug = slugify_route(&verb, route, method_counter);
        let key = format!("{verb} {route}");
        let comment_key = key.replace(['\r', '\n'], " ");
        let fixture = fixtures.endpoints.get(&key);
        let expected = fixture
            .and_then(|fixture| fixture.expected_status)
            .unwrap_or(200);
        if let Some(reason) = endpoint.body.as_ref().and_then(|body| {
            unsupported_wire_reason(body, type_pool)
                .map(str::to_owned)
                .or_else(|| unsupported_response_shape(body, type_pool))
        }) {
            summary.diagnostics += 1;
            let message = java_string_literal(&format!("{reason}; an explicit request fixture cannot establish an unknown response contract"));
            out.push_str(&format!(
                "    @Test\n    void {slug}() throws Exception {{\n        String endpoint = {};\n",
                java_string_literal(&key)
            ));
            out.push_str(&format!("        recordResult(endpoint, null, {expected}, 0, 0, \"INSUFFICIENT_EVIDENCE_TO_ASSERT_RESPONSE_CONTRACT\", {message}, \"UNSUPPORTED_CONSTRUCT\");\n"));
            out.push_str(&format!("        throw new AssertionError(endpoint + \" [UNSUPPORTED_CONSTRUCT] \" + {message});\n    }}\n\n"));
            continue;
        }
        if endpoint
            .body
            .as_ref()
            .is_some_and(|body| has_unknown_wire_type(body, type_pool))
        {
            summary.abstentions += 1;
            out.push_str(&format!(
                "    // ABSTAIN: Endpoint {comment_key} contains unresolved WireType::Unknown\n\n"
            ));
            continue;
        }
        let assertions = endpoint
            .body
            .as_ref()
            .map(|body| contract_json_assertions(body, type_pool))
            .unwrap_or_default();
        let request = synthesize_request(endpoint, &payload.endpoints, type_pool, fixture);
        if request.is_err() {
            out.push_str(&format!("    // [DIAGNOSTIC] Endpoint {comment_key}; request synthesis lacks sufficient evidence\n"));
        } else if endpoint
            .body
            .as_ref()
            .is_some_and(|body| has_any_wire_type(body, type_pool))
        {
            out.push_str(&format!("    // [ADVISORY_FALLBACK_TEST] Endpoint {comment_key} contains dynamic/wildcard payload (Any); verifying route and status\n"));
        } else if assertions.is_empty() {
            out.push_str(&format!("    // [STATUS_ONLY_CHECK] Endpoint {comment_key}; no response contract assertion\n"));
        } else if endpoint
            .body
            .as_ref()
            .is_some_and(|body| partial_response_shape(body, type_pool))
        {
            out.push_str(&format!(
                "    // [PARTIAL_CONTRACT_CHECK] Endpoint {comment_key}; shape constraints only\n"
            ));
        } else {
            out.push_str(&format!(
                "    // [CONTRACT_TEST] Verified contract constraints for {comment_key}\n"
            ));
        }
        out.push_str("    @Test\n");
        if fixtures.transactional {
            out.push_str("    @Transactional\n");
        }
        out.push_str(&format!("    void {slug}() throws Exception {{\n"));
        out.push_str(&format!(
            "        String endpoint = {};\n",
            java_string_literal(&key)
        ));
        let request = match request {
            Ok(request) => request,
            Err(error) => {
                summary.diagnostics += 1;
                let detail = format!("{error:#}");
                let reason_code = ReasonCode::classify(&detail)
                    .map(|code| java_string_literal(code.as_str()))
                    .unwrap_or_else(|| "null".to_string());
                let message = java_string_literal(&detail);
                out.push_str(&format!("        recordResult(endpoint, null, {expected}, 0, 0, \"INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST\", {message}, {reason_code});\n"));
                out.push_str(&format!("        throw new AssertionError(endpoint + \" [INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST] \" + {message});\n    }}\n\n"));
                continue;
            }
        };
        let partial = endpoint
            .body
            .as_ref()
            .is_some_and(|body| partial_response_shape(body, type_pool));
        summary.record_check(assertions.len() + usize::from(expected == 204), partial);
        if partial {
            out.push_str("        // PARTIAL_CHECK: optional fields / container contents / dynamic values are not fully checked.\n");
        }
        out.push_str("        MvcResult response = null;\n        int attempted = 0;\n        int completed = 0;\n        Throwable failure = null;\n");
        out.push_str("        String category = \"MISSING_DATASET_OR_PREREQUISITE\";\n");
        out.push_str(&format!(
            "        String evidence = {};\n",
            java_string_literal(&request.evidence.join("; "))
        ));
        if has_auth {
            out.push_str("        org.springframework.security.core.context.SecurityContext previousContext = SecurityContextHolder.getContext();\n");
        }
        out.push_str("        try {\n");
        for sql in fixtures.setup_sql.iter().chain(
            fixture
                .into_iter()
                .flat_map(|fixture| fixture.setup_sql.iter()),
        ) {
            out.push_str(&format!(
                "            jdbcTemplate.execute({});\n",
                java_string_literal(sql)
            ));
        }
        let auth = fixture
            .and_then(|fixture| fixture.authentication.as_ref())
            .or(fixtures.authentication.as_ref());
        if let Some(auth) = auth {
            out.push_str(
                "            category = \"AUTHENTICATION_OR_AUTHORIZATION_REQUIREMENT\";\n",
            );
            out.push_str(&format!("            org.springframework.security.core.userdetails.UserDetails user = userDetailsService.loadUserByUsername({});\n", java_string_literal(&auth.username)));
            out.push_str("            UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities());\n");
            out.push_str("            org.springframework.security.core.context.SecurityContext context = SecurityContextHolder.createEmptyContext();\n            context.setAuthentication(authentication);\n            SecurityContextHolder.setContext(context);\n");
        }
        out.push_str(
            "            category = \"INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST\";\n",
        );
        out.push_str(&format!("            MockHttpServletRequestBuilder request = request(org.springframework.http.HttpMethod.valueOf({}), java.net.URI.create({}))\n                .accept(MediaType.APPLICATION_JSON);\n", java_string_literal(&verb), java_string_literal(&request.path)));
        if let Some(body) = request.body {
            if request.raw_text_body {
                let text = body
                    .as_str()
                    .ok_or_else(|| anyhow!("root-level String body must contain raw text"))?;
                out.push_str(&format!(
                    "            request.contentType(MediaType.TEXT_PLAIN).content({});\n",
                    java_string_literal(text)
                ));
            } else {
                let json = serde_json::to_string(&body)?;
                out.push_str(&format!(
                    "            request.contentType(MediaType.APPLICATION_JSON).content({});\n",
                    java_string_literal(&json)
                ));
            }
        }
        for (name, value) in &request.query_parameters {
            out.push_str(&format!(
                "            request.param({}, {});\n",
                java_string_literal(name),
                java_string_literal(value)
            ));
        }
        for (name, value) in &request.headers {
            out.push_str(&format!(
                "            request.header({}, {});\n",
                java_string_literal(name),
                java_string_literal(value)
            ));
        }
        for (name, env) in &request.headers_from_env {
            out.push_str(&format!(
                "            request.header({}, requiredHeader({}));\n",
                java_string_literal(name),
                java_string_literal(env)
            ));
        }
        if let Some(fixture) = fixture {
            for (name, value) in &fixture.session_attributes {
                let expression = match value {
                    serde_json::Value::Number(number) if number.is_i64() || number.is_u64() => {
                        format!("{}L", number)
                    }
                    _ => java_literal(value)
                        .ok_or_else(|| anyhow!("Unsupported session attribute {name}"))?,
                };
                out.push_str(&format!(
                    "            request.sessionAttr({}, {});\n",
                    java_string_literal(name),
                    expression
                ));
            }
        }
        if auth.is_some() {
            out.push_str("            request.principal(authentication);\n");
        }
        out.push_str("            category = \"APPLICATION_SERVER_FAILURE\";\n            ResultActions result = mockMvc.perform(request);\n            response = result.andReturn();\n");
        out.push_str(&format!("            category = response.getResponse().getStatus() == {expected} ? \"RESPONSE_CONTRACT_ASSERTION_FAILURE\" : classifyResponse(response);\n            result.andExpect(status().is({expected}));\n"));
        for matcher in &assertions {
            out.push_str(&format!("            attempted++;\n            result.andExpect({matcher});\n            completed++;\n"));
        }
        if expected == 204 {
            out.push_str("            result.andExpect(content().string(\"\"));\n");
        }
        let passed_category = if expected == 204 {
            "PASS_NO_CONTENT"
        } else if assertions.is_empty() {
            "PASS_STATUS_ONLY"
        } else if partial {
            "PASS_PARTIAL"
        } else {
            "PASS"
        };
        out.push_str(&format!("            category = \"{passed_category}\";\n"));
        out.push_str("        } catch (Exception | AssertionError error) {\n            category = classifyFailure(error, category);\n            failure = error;\n            throw new AssertionError(endpoint + \" [\" + category + \"] \" + responseEvidence(response) + \"; \" + evidence);\n        } finally {\n            try {\n");
        for sql in fixture
            .into_iter()
            .flat_map(|fixture| fixture.cleanup_sql.iter())
            .chain(fixtures.cleanup_sql.iter())
        {
            out.push_str(&format!(
                "                jdbcTemplate.execute({});\n",
                java_string_literal(sql)
            ));
        }
        out.push_str("            } catch (RuntimeException cleanupError) {\n                if (failure != null) {\n                    failure.addSuppressed(cleanupError);\n                } else {\n                    category = \"MISSING_DATASET_OR_PREREQUISITE\";\n                    failure = cleanupError;\n                    throw new AssertionError(endpoint + \" cleanup failed [REDACTED]\");\n                }\n            } finally {\n");
        if has_auth {
            out.push_str("                SecurityContextHolder.setContext(previousContext);\n");
        }
        out.push_str(&format!("                recordResult(endpoint, response, {expected}, attempted, completed, category, evidence + (failure == null ? \"\" : \"; \" + failure.getClass().getName()), null);\n            }}\n        }}\n    }}\n\n"));
    }
    out.push_str(JUNIT_REQUEST_DIAGNOSTICS);
    out.push_str("}\n");
    Ok(SynthesisOutput { code: out, summary })
}

const JUNIT_REQUEST_DIAGNOSTICS: &str = r#"
    private static String requiredHeader(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty() || value.contains("\r") || value.contains("\n")) {
            throw new AssertionError("Missing or invalid configured header environment variable: " + name);
        }
        return value;
    }

    private static String classifyFailure(Throwable error, String fallback) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            for (Class<?> type = cause.getClass(); type != null; type = type.getSuperclass()) {
                if (type.getName().equals("org.springframework.security.core.AuthenticationException")
                    || type.getName().equals("org.springframework.security.access.AccessDeniedException")) {
                    return "AUTHENTICATION_OR_AUTHORIZATION_REQUIREMENT";
                }
            }
        }
        return fallback;
    }

    private static String classifyResponse(MvcResult result) throws Exception {
        Exception exception = result.getResolvedException();
        String causeCategory = classifyFailure(exception, null);
        if (causeCategory != null) return causeCategory;
        String type = exception == null ? "" : exception.getClass().getSimpleName();
        String text = responseEvidence(result).toLowerCase(java.util.Locale.ROOT);
        if (type.contains("HttpMessageNotReadable") || type.contains("MethodArgumentNotValid")) {
            return "INVALID_OR_MISSING_REQUEST_BODY";
        }
        if (type.contains("MissingServletRequestParameter") || type.contains("TypeMismatch") || type.contains("NoResourceFound")) {
            return "INVALID_PATH_OR_QUERY_PARAMETERS";
        }
        if (type.contains("Authentication") || type.contains("AccessDenied") || text.contains("no active session")) {
            return "AUTHENTICATION_OR_AUTHORIZATION_REQUIREMENT";
        }
        if (exception != null && (text.contains("not found") || text.contains("cart is empty") || text.contains("out of stock"))) {
            return "MISSING_DATASET_OR_PREREQUISITE";
        }
        return result.getResponse().getStatus() >= 500 ? "APPLICATION_SERVER_FAILURE" : "INSUFFICIENT_EVIDENCE_TO_SYNTHESIZE_VALID_REQUEST";
    }

    private static com.fasterxml.jackson.databind.JsonNode redactNode(com.fasterxml.jackson.databind.JsonNode node) {
        if (node.isObject()) {
            com.fasterxml.jackson.databind.node.ObjectNode safe = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
            java.util.Iterator<java.util.Map.Entry<String, com.fasterxml.jackson.databind.JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                java.util.Map.Entry<String, com.fasterxml.jackson.databind.JsonNode> field = fields.next();
                String key = field.getKey().toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]", "");
                if (key.contains("token") || key.contains("password") || key.contains("secret") || key.contains("credential")
                    || key.contains("authorization") || key.contains("cookie") || key.contains("apikey")) {
                    safe.put(field.getKey(), "[REDACTED]");
                } else {
                    safe.set(field.getKey(), redactNode(field.getValue()));
                }
            }
            return safe;
        }
        if (node.isArray()) {
            com.fasterxml.jackson.databind.node.ArrayNode safe = new com.fasterxml.jackson.databind.ObjectMapper().createArrayNode();
            for (com.fasterxml.jackson.databind.JsonNode child : node) safe.add(redactNode(child));
            return safe;
        }
        // Opaque strings can carry credentials under an unrecognized field name.
        return node.isTextual() ? com.fasterxml.jackson.databind.node.TextNode.valueOf("[REDACTED]") : node;
    }

    private static String redactResponse(String body) {
        if (body == null || body.trim().isEmpty()) return "";
        try {
            return redactNode(new com.fasterxml.jackson.databind.ObjectMapper().readTree(body)).toString();
        } catch (Exception error) {
            return "[REDACTED]"; // malformed/non-JSON content is never emitted raw
        }
    }

    private static String responseEvidence(MvcResult result) throws Exception {
        if (result == null) return "request did not produce a response";
        Exception exception = result.getResolvedException();
        return "HTTP " + result.getResponse().getStatus() + "; exception=" + (exception == null ? "none" : exception.getClass().getName())
            + "; error=[REDACTED]; body=" + redactResponse(result.getResponse().getContentAsString());
    }

    private static void recordResult(String endpoint, MvcResult response, int expected, int attempted, int completed, String category, String evidence, String reasonCode) throws Exception {
        java.util.Map<String, Object> record = new java.util.LinkedHashMap<String, Object>();
        record.put("endpoint", endpoint);
        record.put("reasonCode", reasonCode);
        record.put("status", response == null ? null : response.getResponse().getStatus());
        record.put("expectedStatus", expected);
        record.put("assertionsAttempted", attempted);
        record.put("assertionsCompleted", completed);
        record.put("classification", category);
        record.put("response", responseEvidence(response));
        record.put("evidence", evidence);
        System.out.println("SAJIMORA_RESULT " + new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(record));
    }

"#;

// ---------------------------------------------------------------------------
// JUnit 4 Synthesizer (Java Vintage)
// ---------------------------------------------------------------------------

pub fn synthesize_junit4(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
) -> Result<String> {
    synthesize_junit4_output(envelope, class_name_opt, package_name_opt).map(|output| output.code)
}

fn synthesize_junit4_output(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
) -> Result<SynthesisOutput> {
    let mut summary = SynthesisSummary::new(TestSynthesisFramework::JUnit4);
    let payload = match &envelope.payload {
        ArtifactPayload::Backend(p) => p,
        _ => {
            return Err(anyhow!(
                "JUnit 4 test synthesis requires a Backend contract artifact"
            ))
        }
    };

    let class_name = class_name_opt.unwrap_or("ContractTest");
    let type_pool = payload.type_pool.as_ref();

    let mut out = String::new();
    if let Some(pkg) = package_name_opt {
        let trimmed = pkg.trim();
        if !trimmed.is_empty() {
            out.push_str(&format!("package {};\n\n", trimmed));
        }
    }

    out.push_str("// Generated by Sajimora Native Synthesis (JUnit 4 Vintage)\n");
    out.push_str("// Contract-guided integration tests for Spring MVC MockMvc\n\n");
    out.push_str("import org.junit.Test;\n");
    out.push_str("import org.junit.runner.RunWith;\n");
    out.push_str("import org.springframework.beans.factory.annotation.Autowired;\n");
    out.push_str(
        "import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;\n",
    );
    out.push_str("import org.springframework.boot.test.context.SpringBootTest;\n");
    out.push_str("import org.springframework.http.MediaType;\n");
    out.push_str("import org.springframework.test.context.ActiveProfiles;\n");
    out.push_str("import org.springframework.test.context.junit4.SpringRunner;\n");
    out.push_str("import org.springframework.test.web.servlet.MockMvc;\n");
    out.push_str(
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;\n",
    );
    out.push_str(
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;\n\n",
    );

    out.push_str("@RunWith(SpringRunner.class)\n");
    out.push_str("@SpringBootTest\n");
    out.push_str("@AutoConfigureMockMvc(addFilters = false)\n");
    out.push_str("@ActiveProfiles(\"test\")\n");
    out.push_str(&format!("public class {} {{\n\n", class_name));
    out.push_str("    @Autowired\n");
    out.push_str("    private MockMvc mockMvc;\n\n");

    let mut method_counter = 0;
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction != ContractDirection::Response {
            continue;
        }

        method_counter += 1;
        let route = &endpoint.identity.normalized_route.raw_path;
        let verb = endpoint.identity.http_method.to_uppercase();
        let slug = slugify_route(&verb, route, method_counter);

        if let Some(reason) = endpoint
            .body
            .as_ref()
            .and_then(|body| unsupported_response_shape(body, type_pool))
        {
            summary.abstentions += 1;
            out.push_str(&format!(
                "    // ABSTAIN: {} {} {}\n\n",
                verb,
                route.replace(['\r', '\n'], " "),
                reason
            ));
            continue;
        }
        if !matches!(
            verb.as_str(),
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE"
        ) {
            summary.abstentions += 1;
            out.push_str("    // ABSTAIN: unsupported HTTP method\n\n");
            continue;
        }
        // Check for WireType::Unknown in body
        if let Some(body) = &endpoint.body {
            if has_unknown_wire_type(body, type_pool) {
                summary.abstentions += 1;
                out.push_str(&format!(
                    "    // ABSTAIN: Endpoint {} {} contains unresolved WireType::Unknown\n\n",
                    verb,
                    route.replace(['\r', '\n'], " ")
                ));
                continue;
            }
        }

        let is_advisory = if let Some(body) = &endpoint.body {
            has_any_wire_type(body, type_pool)
        } else {
            false
        };

        if is_advisory {
            out.push_str(&format!(
                "    // [ADVISORY_FALLBACK_TEST] Endpoint {} {} contains dynamic/wildcard payload (Any); verifying route and status\n",
                verb, route.replace(['\r', '\n'], " ")
            ));
        } else {
            out.push_str(&format!(
                "    // [CONTRACT_TEST] Verified contract constraints for {} {}\n",
                verb,
                route.replace(['\r', '\n'], " ")
            ));
        }

        let endpoint_assertions = endpoint
            .body
            .as_ref()
            .map(|b| contract_json_assertions(b, type_pool))
            .unwrap_or_default();
        summary.record_check(
            endpoint_assertions.len(),
            endpoint
                .body
                .as_ref()
                .is_some_and(|body| partial_response_shape(body, type_pool)),
        );
        if endpoint_assertions.is_empty() {
            out.push_str(
                "    // NOTE: no required contract field resolved; this test asserts status only\n",
            );
        }

        out.push_str("    @Test\n");
        let spring_call = match verb.as_str() {
            "GET" => "get",
            "POST" => "post",
            "PUT" => "put",
            "DELETE" => "delete",
            "PATCH" => "patch",
            "HEAD" => "head",
            "OPTIONS" => "options",
            "TRACE" => "trace",
            _ => unreachable!("method validated"),
        };

        let formatted_path = format_path_mock(route);

        out.push_str(&format!("    public void {}() throws Exception {{\n", slug));
        out.push_str(&format!(
            "        mockMvc.perform({}({})\n",
            spring_call,
            java_string_literal(&formatted_path)
        ));
        push_mock_mvc_expectations(&mut out, &endpoint_assertions);
    }

    out.push_str("}\n");
    Ok(SynthesisOutput { code: out, summary })
}

// ---------------------------------------------------------------------------
// Jqwik Synthesizer (Java Property-Based Testing)
// ---------------------------------------------------------------------------

pub fn synthesize_jqwik(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
) -> Result<String> {
    synthesize_jqwik_with_package(envelope, class_name_opt, None)
}

pub fn synthesize_jqwik_with_package(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
) -> Result<String> {
    synthesize_jqwik_output(envelope, class_name_opt, package_name_opt).map(|output| output.code)
}

fn synthesize_jqwik_output(
    envelope: &ContractArtifactEnvelope,
    class_name_opt: Option<&str>,
    package_name_opt: Option<&str>,
) -> Result<SynthesisOutput> {
    let mut summary = SynthesisSummary::new(TestSynthesisFramework::Jqwik);
    let payload = match &envelope.payload {
        ArtifactPayload::Backend(p) => p,
        _ => {
            return Err(anyhow!(
                "Jqwik test synthesis requires a Backend contract artifact"
            ))
        }
    };

    let class_name = class_name_opt.unwrap_or("ContractPropertyTest");
    let type_pool = payload.type_pool.as_ref();

    let mut out = String::new();
    if let Some(pkg) = package_name_opt {
        let trimmed = pkg.trim();
        if !trimmed.is_empty() {
            out.push_str(&format!("package {};\n\n", trimmed));
        }
    }

    out.push_str("// Generated by Sajimora Native Synthesis (jqwik)\n");
    out.push_str("// Contract-guided property tests for Spring MVC\n\n");
    out.push_str("import net.jqwik.api.*;\n");
    out.push_str("import org.springframework.beans.factory.annotation.Autowired;\n");
    out.push_str(
        "import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;\n",
    );
    out.push_str("import org.springframework.boot.test.context.SpringBootTest;\n");
    out.push_str("import org.springframework.http.MediaType;\n");
    out.push_str("import org.springframework.test.context.ActiveProfiles;\n");
    out.push_str("import org.springframework.test.web.servlet.MockMvc;\n");
    out.push_str(
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;\n",
    );
    out.push_str(
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;\n\n",
    );

    out.push_str("@SpringBootTest\n");
    out.push_str("@AutoConfigureMockMvc(addFilters = false)\n");
    out.push_str("@ActiveProfiles(\"test\")\n");
    out.push_str(&format!("public class {} {{\n\n", class_name));
    out.push_str("    @Autowired\n");
    out.push_str("    private MockMvc mockMvc;\n\n");

    let mut method_counter = 0;
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction != ContractDirection::Response {
            continue;
        }

        method_counter += 1;
        let route = &endpoint.identity.normalized_route.raw_path;
        let verb = endpoint.identity.http_method.to_uppercase();
        let slug = slugify_route(&verb, route, method_counter);

        if let Some(reason) = endpoint
            .body
            .as_ref()
            .and_then(|body| unsupported_response_shape(body, type_pool))
        {
            summary.abstentions += 1;
            out.push_str(&format!(
                "    // ABSTAIN: {} {} {}\n\n",
                verb,
                route.replace(['\r', '\n'], " "),
                reason
            ));
            continue;
        }
        if !matches!(
            verb.as_str(),
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE"
        ) {
            summary.abstentions += 1;
            out.push_str("    // ABSTAIN: unsupported HTTP method\n\n");
            continue;
        }
        // Check for WireType::Unknown in body
        if let Some(body) = &endpoint.body {
            if has_unknown_wire_type(body, type_pool) {
                summary.abstentions += 1;
                out.push_str(&format!(
                    "    // ABSTAIN: Endpoint {} {} contains unresolved WireType::Unknown\n\n",
                    verb,
                    route.replace(['\r', '\n'], " ")
                ));
                continue;
            }
        }

        let is_advisory = if let Some(body) = &endpoint.body {
            has_any_wire_type(body, type_pool)
        } else {
            false
        };

        if is_advisory {
            out.push_str(&format!(
                "    // [ADVISORY_FALLBACK_TEST] Endpoint {} {} contains dynamic/wildcard payload (Any); verifying route and status\n",
                verb, route.replace(['\r', '\n'], " ")
            ));
        } else {
            out.push_str(&format!(
                "    // [CONTRACT_TEST] Verified contract constraints for {} {}\n",
                verb,
                route.replace(['\r', '\n'], " ")
            ));
        }

        let endpoint_assertions = endpoint
            .body
            .as_ref()
            .map(|b| contract_json_assertions(b, type_pool))
            .unwrap_or_default();
        summary.record_check(
            endpoint_assertions.len(),
            endpoint
                .body
                .as_ref()
                .is_some_and(|body| partial_response_shape(body, type_pool)),
        );
        if endpoint_assertions.is_empty() {
            out.push_str(
                "    // NOTE: no required contract field resolved; this test asserts status only\n",
            );
        }

        out.push_str("    @Property\n");
        let spring_call = match verb.as_str() {
            "GET" => "get",
            "POST" => "post",
            "PUT" => "put",
            "DELETE" => "delete",
            "PATCH" => "patch",
            "HEAD" => "head",
            "OPTIONS" => "options",
            "TRACE" => "trace",
            _ => unreachable!("method validated"),
        };

        // Construct mock path
        let formatted_path = format_path_mock(route);

        out.push_str(&format!("    void {}() throws Exception {{\n", slug));
        out.push_str(&format!(
            "        mockMvc.perform({}({})\n",
            spring_call,
            java_string_literal(&formatted_path)
        ));
        push_mock_mvc_expectations(&mut out, &endpoint_assertions);
    }

    out.push_str("}\n");
    Ok(SynthesisOutput { code: out, summary })
}

// ---------------------------------------------------------------------------
// Fast-Check Synthesizer (TypeScript)
// ---------------------------------------------------------------------------

pub fn synthesize_fast_check(
    envelope: &ContractArtifactEnvelope,
    suite_name_opt: Option<&str>,
) -> Result<String> {
    synthesize_fast_check_output(envelope, suite_name_opt, &RequestFixtures::default())
        .map(|output| output.code)
}

fn synthesize_fast_check_output(
    envelope: &ContractArtifactEnvelope,
    suite_name_opt: Option<&str>,
    fixtures: &RequestFixtures,
) -> Result<SynthesisOutput> {
    let mut summary = SynthesisSummary::new(TestSynthesisFramework::FastCheck);
    let payload = match &envelope.payload {
        ArtifactPayload::Backend(p) => p,
        _ => {
            return Err(anyhow!(
                "Fast-Check synthesis requires a Backend contract artifact"
            ))
        }
    };

    let suite_name = suite_name_opt.unwrap_or("Contract Property Tests");
    let type_pool = payload.type_pool.as_ref();

    let mut out = String::new();
    out.push_str("// Generated by Sajimora Native Synthesis (fast-check)\n");
    out.push_str("// Contract-guided property tests for TypeScript clients\n");
    out.push_str(
        "// The live case needs a running service; set SAJIMORA_BASE_URL to point at one.\n\n",
    );
    out.push_str("import { describe, it, expect } from 'vitest';\n");
    out.push_str("import fc from 'fast-check';\n\n");
    out.push_str("const BASE_URL = process.env.SAJIMORA_BASE_URL ?? 'http://localhost:8080';\n");
    out.push_str("const TOKEN = process.env.SAJIMORA_TOKEN;\n");
    out.push_str("const authHeaders: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};\n");
    out.push_str("const isRecord = (v: unknown): v is Record<string, unknown> =>\n");
    out.push_str("    typeof v === 'object' && v !== null && !Array.isArray(v);\n\n");

    out.push_str(&format!("describe('{}', () => {{\n", suite_name));

    let mut endpoint_counter = 0;
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction != ContractDirection::Response {
            continue;
        }

        endpoint_counter += 1;
        let idx = endpoint_counter;
        let route = &endpoint.identity.normalized_route.raw_path;
        let verb = endpoint.identity.http_method.to_uppercase();

        let fixture = fixtures.endpoints.get(&format!("{verb} {route}"));
        let expected_status = fixture.and_then(|f| f.expected_status).unwrap_or(200);

        let (path, fetch_options) = if verb == "GET" {
            let p = render_ts_path(route, fixture);
            let p = if let Some(f) = fixture {
                render_ts_path_with_query(&p, &f.query_parameters)
            } else {
                p
            };
            let headers = ts_headers_expr(fixture, None);
            (p, format!("{{ headers: {headers} }}"))
        } else {
            let Some(f) = fixture else {
                summary.abstentions += 1;
                out.push_str("    // ABSTAIN: nonGET request synthesis requires explicit fixture; deferred.\n\n");
                continue;
            };

            let req = match synthesize_request(endpoint, &payload.endpoints, type_pool, Some(f)) {
                Ok(r) => r,
                Err(e) => {
                    summary.abstentions += 1;
                    out.push_str(&format!(
                        "    // ABSTAIN: nonGET request synthesis failed: {e}\n\n"
                    ));
                    continue;
                }
            };

            let p = render_ts_path_with_query(&req.path, &req.query_parameters);
            let (body_expr, content_type) = if let Some(body_val) = &req.body {
                if req.raw_text_body {
                    let text = body_val.as_str().unwrap_or("");
                    (Some(ts_string_literal(text)), Some("text/plain"))
                } else {
                    let json_str =
                        serde_json::to_string(body_val).unwrap_or_else(|_| "{}".to_string());
                    (
                        Some(format!("JSON.stringify({json_str})")),
                        Some("application/json"),
                    )
                }
            } else {
                (None, None)
            };
            let headers = ts_headers_expr(Some(f), content_type);
            let mut opts = vec![format!("method: '{}'", verb), format!("headers: {headers}")];
            if let Some(b) = body_expr {
                opts.push(format!("body: {b}"));
            }
            (p, format!("{{ {} }}", opts.join(", ")))
        };

        let body_opt = endpoint.body.as_ref();
        if body_opt.is_none() {
            if fixture.is_none() {
                summary.abstentions += 1;
                out.push_str("    // ABSTAIN: no response schema\n\n");
                continue;
            }
        }

        let is_advisory = body_opt.is_some_and(|b| has_any_wire_type(b, type_pool));
        let test_tag = if is_advisory {
            "[ADVISORY_FALLBACK_TEST]"
        } else {
            "[CONTRACT_TEST]"
        };

        if body_opt.is_none() || expected_status == 204 {
            summary.record_check(0, false);
            out.push_str(&format!(
                "    it('{} {} {} responds', async () => {{\n",
                test_tag, verb, route
            ));
            out.push_str("        const response = await fetch(BASE_URL + ");
            out.push_str(&ts_string_literal(&path));
            out.push_str(", ");
            out.push_str(&fetch_options);
            out.push_str(");\n");
            out.push_str(&format!(
                "        expect(response.status).toBe({expected_status});\n"
            ));
            out.push_str("    });\n\n");
            continue;
        }

        let body = body_opt.unwrap();
        // Nullable and ref shapes are emitted with partial-coverage predicates below.
        if matches!(body, WireType::Enum(_))
            || unsupported_ts_response_shape(body, type_pool).is_some()
        {
            summary.abstentions += 1;
            out.push_str("    // ABSTAIN: UNSUPPORTED_CONSTRUCT in deferred TypeScript response synthesis\n\n");
            continue;
        }

        if has_unknown_wire_type(body, type_pool) {
            summary.abstentions += 1;
            out.push_str(&format!(
                "    // ABSTAIN: Endpoint {} {} contains unresolved WireType::Unknown\n\n",
                verb,
                route.replace(['\r', '\n'], " ")
            ));
            continue;
        }

        let arb_code = synthesize_fc_arbitrary(body, type_pool, 8);
        out.push_str(&format!(
            "    // Shape of the {} {} response\n",
            verb, route
        ));
        out.push_str(&format!("    const arbitrary_{idx} = {arb_code};\n"));

        match ts_shape_check(body, type_pool) {
            Some((predicate, required_keys)) => {
                summary.record_check(1, partial_response_shape(body, type_pool));
                out.push_str(&format!(
                    "    const shape_{idx} = (v: unknown): boolean => {predicate};\n\n"
                ));
                out.push_str(&format!(
                    "    it('{} {} {} returns a payload with the contract shape', async () => {{\n",
                    test_tag, verb, route
                ));
                out.push_str("        const response = await fetch(BASE_URL + ");
                out.push_str(&ts_string_literal(&path));
                out.push_str(", ");
                out.push_str(&fetch_options);
                out.push_str(");\n");
                out.push_str(&format!(
                    "        expect(response.status).toBe({expected_status});\n"
                ));
                out.push_str(&format!(
                    "        expect(shape_{idx}(await response.json())).toBe(true);\n"
                ));
                out.push_str("    });\n\n");

                if !required_keys.is_empty() {
                    out.push_str(&format!(
                        "    it('{} {} {} shape check is not vacuous', () => {{\n",
                        test_tag, verb, route
                    ));
                    out.push_str(&format!(
                        "        const required = [{}];\n",
                        joined_ts_literals(&required_keys)
                    ));
                    out.push_str("        fc.assert(\n");
                    out.push_str(&format!(
                        "            fc.property(arbitrary_{idx}, (data) => {{\n"
                    ));
                    out.push_str(&format!(
                        "                expect(shape_{idx}(data)).toBe(true);\n"
                    ));
                    out.push_str("                for (const key of required) {\n");
                    out.push_str("                    const mutated = { ...(data as Record<string, unknown>) };\n");
                    out.push_str("                    delete mutated[key];\n");
                    out.push_str(&format!(
                        "                    expect(shape_{idx}(mutated)).toBe(false);\n"
                    ));
                    out.push_str("                }\n");
                    out.push_str("            })\n");
                    out.push_str("        );\n");
                    out.push_str("    });\n\n");
                }
            }
            None => {
                summary.record_check(0, false);
                out.push_str("    // NOTE: contract resolves no checkable field for this endpoint; status only\n");
                out.push_str(&format!(
                    "    it('{} {} {} responds', async () => {{\n",
                    test_tag, verb, route
                ));
                out.push_str("        const response = await fetch(BASE_URL + ");
                out.push_str(&ts_string_literal(&path));
                out.push_str(", ");
                out.push_str(&fetch_options);
                out.push_str(");\n");
                out.push_str(&format!(
                    "        expect(response.status).toBe({expected_status});\n"
                ));
                out.push_str("    });\n\n");
            }
        }
    }

    out.push_str("});\n");
    summary.assertions_generated = None; // property iterations are runtime-dependent
    Ok(SynthesisOutput { code: out, summary })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// MockMvc matchers for every required field the contract resolves. A renamed or dropped
/// field then fails the generated test instead of passing on status alone.
///
/// Deliberately conservative so a conforming payload cannot fail: optional fields get no
/// assertion, nullable fields get a key-presence check (Spring's `exists()` rejects a JSON
/// null), and array elements are not descended into because an empty array is conforming.
fn contract_json_assertions(
    body: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    collect_json_assertions(body, "$", pool, &mut visited, 0, &mut out);
    out
}

fn collect_json_assertions(
    wire: &WireType,
    path: &str,
    pool: Option<&BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
    out: &mut Vec<String>,
) {
    if depth > 8 {
        return;
    }
    if let WireType::Ref(reference) = wire {
        if visited.insert(reference.r#ref.clone()) {
            if let Some(target) = pool.and_then(|pool| pool.get(&reference.r#ref)) {
                collect_json_assertions(target, path, pool, visited, depth + 1, out);
            }
            visited.remove(&reference.r#ref);
        }
        return;
    }
    let literal_path = java_string_literal(path);
    match wire {
        WireType::Object(obj) => {
            out.push(format!("jsonPath({literal_path}).isMap()"));
            for prop in &obj.properties {
                if prop.optional {
                    continue;
                }
                let child = match json_path_child(path, &prop.wire_name) {
                    Some(c) => c,
                    None => continue,
                };
                if prop.nullable || is_nullable_shape(&prop.r#type) {
                    out.push(format!(
                        "jsonPath({literal_path}, org.hamcrest.Matchers.hasKey({}))",
                        java_string_literal(&prop.wire_name)
                    ));
                    if let Some(matcher) = nullable_value_matcher(&prop.r#type, pool, 0, false) {
                        out.push(format!("jsonPath({}, org.hamcrest.Matchers.anyOf(org.hamcrest.Matchers.nullValue(), {matcher}))", java_string_literal(&child)));
                    }
                    continue;
                }
                collect_json_assertions(&prop.r#type, &child, pool, visited, depth + 1, out);
            }
        }
        WireType::Array(array) => {
            out.push(format!("jsonPath({literal_path}).isArray()"));
            let mut seen = HashSet::new();
            if let Some(element) =
                wire_value_matcher(&array.element_type, pool, 0, &mut seen, path == "$")
            {
                out.push(format!(
                    "jsonPath({literal_path}, org.hamcrest.Matchers.everyItem({element}))"
                ));
            }
        }
        WireType::Map(_) => out.push(format!("jsonPath({literal_path}).isMap()")),
        WireType::Primitive(p) => {
            let matcher = match p.scalar {
                PrimitiveScalar::String => Some("isString"),
                PrimitiveScalar::Number | PrimitiveScalar::BigInt => Some("isNumber"),
                PrimitiveScalar::Boolean => Some("isBoolean"),
                PrimitiveScalar::Any | PrimitiveScalar::Void => None,
            };
            if let Some(m) = matcher {
                out.push(format!("jsonPath({literal_path}).{m}()"));
            }
        }
        WireType::Enum(en) => {
            let members = en
                .values
                .iter()
                .filter_map(java_literal)
                .collect::<Vec<_>>();
            if !members.is_empty() && members.len() == en.values.len() {
                out.push(format!("jsonPath({literal_path}, org.hamcrest.Matchers.isIn(java.util.Arrays.asList({})))", members.join(", ")));
            }
        }
        WireType::Nullable(nullable) => {
            if let Some(matcher) =
                nullable_value_matcher(&nullable.inner_type, pool, 0, path == "$")
            {
                out.push(format!("jsonPath({literal_path}, org.hamcrest.Matchers.anyOf(org.hamcrest.Matchers.nullValue(), {matcher}))"));
            }
        }
        WireType::Literal(lit) => {
            if let Some(value) = java_literal(&lit.value) {
                out.push(format!("jsonPath({literal_path}).value({value})"));
            }
        }
        _ => {}
    }
}

fn is_nullable_shape(wire: &WireType) -> bool {
    matches!(wire, WireType::Nullable(_))
}

/// Jayway path for a child key, or `None` when the key cannot be written safely.
fn json_path_child(parent: &str, name: &str) -> Option<String> {
    let is_identifier = !name.is_empty()
        && name
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if is_identifier {
        return Some(format!("{parent}.{name}"));
    }
    // Escape the Jayway quoted key first; the caller separately escapes the Java literal.
    let escaped = name.replace('\\', "\\\\").replace('\'', "\\'");
    Some(format!("{parent}['{escaped}']"))
}

/// MockMvc expectation chain: route status plus every required field the contract resolves.
fn push_mock_mvc_expectations(out: &mut String, assertions: &[String]) {
    out.push_str("                .accept(MediaType.APPLICATION_JSON))\n");
    out.push_str("                .andExpect(status().isOk())");
    for matcher in assertions {
        out.push_str(&format!("\n                .andExpect({matcher})"));
    }
    out.push_str(";\n");
    out.push_str("    }\n\n");
}

fn java_string_literal(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A Java expression for a JSON literal usable as a `value(...)` expectation.
fn java_literal(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => {
            if let Some(value) = n.as_i64() {
                Some(if i32::try_from(value).is_ok() {
                    value.to_string()
                } else {
                    format!("{value}L")
                })
            } else if n.is_u64() {
                None // JSON unsigned values beyond Java long are not representable here
            } else {
                Some(n.to_string())
            }
        }
        serde_json::Value::String(s) => Some(java_string_literal(s)),
        _ => None,
    }
}

const MATCHER_DEPTH: usize = 3;

fn erased_matcher(expr: &str) -> String {
    format!("(org.hamcrest.Matcher) {expr}")
}

fn all_of_matchers(parts: Vec<String>) -> String {
    if parts.len() == 1 {
        parts[0].clone()
    } else {
        let parts = parts
            .iter()
            .map(|part| erased_matcher(part))
            .collect::<Vec<_>>();
        format!("org.hamcrest.Matchers.allOf({})", parts.join(", "))
    }
}

fn any_of_matchers(parts: Vec<String>) -> String {
    if parts.len() == 1 {
        parts[0].clone()
    } else {
        let parts = parts
            .iter()
            .map(|part| erased_matcher(part))
            .collect::<Vec<_>>();
        format!("org.hamcrest.Matchers.anyOf({})", parts.join(", "))
    }
}

fn base_value_matcher(wire: &WireType) -> Option<String> {
    match wire {
        WireType::Primitive(primitive) => match primitive.scalar {
            PrimitiveScalar::String => {
                Some("org.hamcrest.Matchers.instanceOf(String.class)".to_string())
            }
            PrimitiveScalar::Number | PrimitiveScalar::BigInt => {
                Some("org.hamcrest.Matchers.instanceOf(Number.class)".to_string())
            }
            PrimitiveScalar::Boolean => {
                Some("org.hamcrest.Matchers.instanceOf(Boolean.class)".to_string())
            }
            _ => None,
        },
        WireType::Enum(en) => {
            let members = en
                .values
                .iter()
                .map(java_literal)
                .collect::<Option<Vec<_>>>()?;
            if members.is_empty() {
                return None;
            }
            Some(format!(
                "org.hamcrest.Matchers.isIn(java.util.Arrays.asList({}))",
                members.join(", ")
            ))
        }
        WireType::Literal(literal) => java_literal(&literal.value)
            .map(|value| format!("org.hamcrest.Matchers.equalTo({value})")),
        _ => None,
    }
}

fn shallow_value_matcher(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    depth: usize,
) -> Option<String> {
    if depth > 16 {
        return None;
    }
    match wire {
        WireType::Ref(reference) => {
            shallow_value_matcher(pool?.get(&reference.r#ref)?, pool, depth + 1)
        }
        WireType::Nullable(nullable) => {
            shallow_value_matcher(&nullable.inner_type, pool, depth + 1)
        }
        WireType::Optional(optional) => {
            shallow_value_matcher(&optional.inner_type, pool, depth + 1)
        }
        WireType::Object(_) | WireType::Map(_) => {
            Some("org.hamcrest.Matchers.instanceOf(java.util.Map.class)".to_string())
        }
        WireType::Array(_) => {
            Some("org.hamcrest.Matchers.instanceOf(java.util.List.class)".to_string())
        }
        _ => base_value_matcher(wire),
    }
}

/// Bounded Hamcrest matcher for a JSON value. Depth and reference cycles stop at a
/// shallow container check so recursive DTOs do not produce unbounded Java source.
fn wire_value_matcher(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    depth: usize,
    seen: &mut HashSet<String>,
    strict: bool,
) -> Option<String> {
    if depth > MATCHER_DEPTH {
        return shallow_value_matcher(wire, pool, 0);
    }
    match wire {
        WireType::Ref(reference) => {
            if !seen.insert(reference.r#ref.clone()) {
                return shallow_value_matcher(wire, pool, 0);
            }
            let target = pool.and_then(|pool| pool.get(&reference.r#ref))?;
            let matcher = wire_value_matcher(target, pool, depth + 1, seen, strict);
            seen.remove(&reference.r#ref);
            matcher
        }
        WireType::Nullable(nullable) => {
            let inner = wire_value_matcher(&nullable.inner_type, pool, depth + 1, seen, strict)?;
            Some(any_of_matchers(vec![
                "org.hamcrest.Matchers.nullValue()".to_string(),
                inner,
            ]))
        }
        WireType::Object(object) => {
            let mut parts =
                vec!["org.hamcrest.Matchers.instanceOf(java.util.Map.class)".to_string()];
            for property in object
                .properties
                .iter()
                .filter(|property| !property.optional)
            {
                let key = java_string_literal(&property.wire_name);
                let child = wire_value_matcher(&property.r#type, pool, depth + 1, seen, false);
                let child = match child {
                    Some(child) => Some(if property.nullable {
                        any_of_matchers(vec![
                            "org.hamcrest.Matchers.nullValue()".to_string(),
                            child,
                        ])
                    } else {
                        child
                    }),
                    None if strict => return None,
                    None => None,
                };
                let entry = |child: String| {
                    format!(
                        "org.hamcrest.Matchers.hasEntry((org.hamcrest.Matcher) org.hamcrest.Matchers.equalTo({key}), {})",
                        erased_matcher(&child)
                    )
                };
                if let Some(child) = child {
                    if strict {
                        parts.push(entry(child));
                    } else {
                        parts.push(any_of_matchers(vec![
                            entry(child),
                            format!(
                                "org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasKey({key}))"
                            ),
                        ]));
                    }
                }
            }
            Some(all_of_matchers(parts))
        }
        WireType::Array(array) => {
            let element = wire_value_matcher(&array.element_type, pool, depth + 1, seen, strict);
            match element {
                Some(element) => Some(all_of_matchers(vec![
                    "org.hamcrest.Matchers.instanceOf(java.util.List.class)".to_string(),
                    format!(
                        "org.hamcrest.Matchers.everyItem({})",
                        erased_matcher(&element)
                    ),
                ])),
                None => Some("org.hamcrest.Matchers.instanceOf(java.util.List.class)".to_string()),
            }
        }
        WireType::Map(_) => {
            Some("org.hamcrest.Matchers.instanceOf(java.util.Map.class)".to_string())
        }
        WireType::Optional(_) | WireType::Union(_) | WireType::Unknown(_) => None,
        _ => base_value_matcher(wire),
    }
}

fn nullable_value_matcher(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    _depth: usize,
    strict: bool,
) -> Option<String> {
    wire_value_matcher(wire, pool, 0, &mut HashSet::new(), strict)
}

fn is_container_shape(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    depth: usize,
) -> bool {
    if depth > 8 {
        return false;
    }
    match wire {
        WireType::Object(_) | WireType::Array(_) | WireType::Map(_) => true,
        WireType::Ref(reference) => pool
            .and_then(|pool| pool.get(&reference.r#ref))
            .is_some_and(|target| is_container_shape(target, pool, depth + 1)),
        WireType::Nullable(nullable) => is_container_shape(&nullable.inner_type, pool, depth + 1),
        WireType::Optional(optional) => is_container_shape(&optional.inner_type, pool, depth + 1),
        _ => false,
    }
}

fn wire_is_partial(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    depth: usize,
    seen: &mut HashSet<String>,
    strict: bool,
) -> bool {
    if depth > MATCHER_DEPTH {
        return true;
    }
    match wire {
        WireType::Primitive(primitive) => matches!(primitive.scalar, PrimitiveScalar::Any),
        WireType::Enum(en) => {
            en.values.is_empty() || en.values.iter().any(|value| java_literal(value).is_none())
        }
        WireType::Literal(literal) => java_literal(&literal.value).is_none(),
        WireType::Object(object) => {
            if !strict {
                return true;
            }
            object.properties.iter().any(|property| {
                property.optional || wire_is_partial(&property.r#type, pool, depth + 1, seen, false)
            })
        }
        WireType::Array(array) => {
            if !strict {
                return true;
            }
            wire_is_partial(&array.element_type, pool, depth + 1, seen, true)
        }
        WireType::Map(_) => true,
        WireType::Nullable(nullable) => {
            if !strict && is_container_shape(&nullable.inner_type, pool, 0) {
                return true;
            }
            wire_is_partial(&nullable.inner_type, pool, depth + 1, seen, strict)
        }
        WireType::Ref(reference) => {
            if !seen.insert(reference.r#ref.clone()) {
                return true;
            }
            let target = pool.and_then(|pool| pool.get(&reference.r#ref));
            let partial = match target {
                Some(target) if !strict && is_container_shape(target, pool, 0) => true,
                Some(target) => wire_is_partial(target, pool, depth + 1, seen, strict),
                None => true,
            };
            seen.remove(&reference.r#ref);
            partial
        }
        WireType::Optional(_) | WireType::Union(_) | WireType::Unknown(_) => true,
    }
}

/// Reject only shapes that this Java emitter cannot meaningfully assert. Container
/// element and optional-field omissions are separately reported as partial coverage.
fn unsupported_ts_response_shape(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
) -> Option<String> {
    fn walk(
        wire: &WireType,
        pool: Option<&BTreeMap<String, WireType>>,
        seen: &mut HashSet<String>,
        depth: usize,
    ) -> Option<&'static str> {
        if depth > 8 {
            return Some("response assertion depth exceeded");
        }
        match wire {
            WireType::Union(_) => Some("union response assertions are unsupported"),
            WireType::Ref(reference) => {
                if !seen.insert(reference.r#ref.clone()) {
                    return Some("cyclic response reference is unsupported");
                }
                let reason = match pool.and_then(|pool| pool.get(&reference.r#ref)) {
                    Some(target) => walk(target, pool, seen, depth + 1),
                    None => Some("unresolved response reference is unsupported"),
                };
                seen.remove(&reference.r#ref);
                reason
            }
            WireType::Object(object) => object
                .properties
                .iter()
                .filter(|p| !p.optional)
                .find_map(|p| walk(&p.r#type, pool, seen, depth + 1)),
            WireType::Array(arr) => walk(&arr.element_type, pool, seen, depth + 1),
            WireType::Nullable(nullable) => walk(&nullable.inner_type, pool, seen, depth + 1),
            WireType::Optional(opt) => walk(&opt.inner_type, pool, seen, depth + 1),
            _ => None,
        }
    }
    walk(wire, pool, &mut HashSet::new(), 0)
        .map(|reason| format!("UNSUPPORTED_CONSTRUCT: {reason}"))
}

fn unsupported_response_shape(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
) -> Option<String> {
    fn walk(
        wire: &WireType,
        pool: Option<&BTreeMap<String, WireType>>,
        seen: &mut HashSet<String>,
        depth: usize,
    ) -> Option<&'static str> {
        if depth > 8 {
            return Some("response assertion depth exceeded");
        }
        match wire {
            WireType::Union(_) => Some("union response assertions are unsupported"),
            WireType::Ref(reference) => {
                if !seen.insert(reference.r#ref.clone()) {
                    // Recursive DTOs get a bounded shallow matcher; a cycle that
                    // cannot resolve to a container remains unsupported.
                    if shallow_value_matcher(wire, pool, 0).is_none() {
                        return Some("cyclic response reference is unsupported");
                    }
                    return None;
                }
                let reason = match pool.and_then(|pool| pool.get(&reference.r#ref)) {
                    Some(target) => walk(target, pool, seen, depth + 1),
                    None => Some("unresolved response reference is unsupported"),
                };
                seen.remove(&reference.r#ref);
                reason
            }
            WireType::Object(object) => {
                object
                    .properties
                    .iter()
                    .filter(|p| !p.optional)
                    .find_map(|p| {
                        if p.nullable || is_nullable_shape(&p.r#type) {
                            if nullable_value_matcher(&p.r#type, pool, 0, false).is_none() {
                                Some("nullable response assertion is unsupported")
                            } else {
                                None
                            }
                        } else {
                            walk(&p.r#type, pool, seen, depth + 1)
                        }
                    })
            }
            WireType::Nullable(nullable) => {
                if nullable_value_matcher(&nullable.inner_type, pool, 0, true).is_none() {
                    Some("nullable response assertion is unsupported")
                } else {
                    None
                }
            }
            WireType::Optional(_) => {
                Some("required optional-wrapper response assertion is unsupported")
            }
            WireType::Enum(en)
                if en.values.is_empty()
                    || en.values.iter().any(|value| java_literal(value).is_none()) =>
            {
                Some("empty or compound enum response assertion is unsupported")
            }
            WireType::Literal(literal) if java_literal(&literal.value).is_none() => {
                Some("null or compound literal response assertion is unsupported")
            }
            // Arrays and maps get bounded container or everyItem matchers; unsupported
            // element/value shapes fall back to a shallow partial check.
            WireType::Array(_) | WireType::Map(_) => None,
            _ => None,
        }
    }
    walk(wire, pool, &mut HashSet::new(), 0)
        .map(|reason| format!("UNSUPPORTED_CONSTRUCT: {reason}"))
}

fn partial_response_shape(wire: &WireType, pool: Option<&BTreeMap<String, WireType>>) -> bool {
    wire_is_partial(wire, pool, 0, &mut HashSet::new(), true)
}

fn unsupported_wire_reason<'a>(
    wire: &'a WireType,
    pool: Option<&'a BTreeMap<String, WireType>>,
) -> Option<&'a str> {
    let mut stack = vec![wire];
    let mut visited = HashSet::new();
    while let Some(wire) = stack.pop() {
        match wire {
            WireType::Unknown(unknown)
                if ReasonCode::classify(&unknown.reason)
                    == Some(ReasonCode::UnsupportedConstruct) =>
            {
                return Some(&unknown.reason)
            }
            WireType::Ref(reference) if visited.insert(&reference.r#ref) => {
                if let Some(target) = pool.and_then(|pool| pool.get(&reference.r#ref)) {
                    stack.push(target);
                }
            }
            WireType::Object(object) => {
                stack.extend(object.properties.iter().map(|property| &property.r#type))
            }
            WireType::Array(array) => stack.push(&array.element_type),
            WireType::Nullable(nullable) => stack.push(&nullable.inner_type),
            WireType::Optional(optional) => stack.push(&optional.inner_type),
            WireType::Union(union) => stack.extend(&union.types),
            WireType::Map(map) => {
                stack.push(&map.key_type);
                stack.push(&map.value_type);
            }
            _ => {}
        }
    }
    None
}

fn has_unknown_wire_type(wire: &WireType, pool: Option<&BTreeMap<String, WireType>>) -> bool {
    let mut visited = HashSet::new();
    has_unknown_wire_type_inner(wire, pool, &mut visited, 0)
}

fn has_unknown_wire_type_inner(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> bool {
    if depth > 32 {
        return true;
    }
    match wire {
        WireType::Unknown(_) => true,
        WireType::Primitive(_) => false,
        WireType::Enum(_) => false,
        WireType::Array(arr) => {
            has_unknown_wire_type_inner(&arr.element_type, pool, visited, depth + 1)
        }
        WireType::Nullable(null) => {
            has_unknown_wire_type_inner(&null.inner_type, pool, visited, depth + 1)
        }
        WireType::Optional(opt) => {
            has_unknown_wire_type_inner(&opt.inner_type, pool, visited, depth + 1)
        }
        WireType::Union(un) => un
            .types
            .iter()
            .any(|v| has_unknown_wire_type_inner(v, pool, visited, depth + 1)),
        WireType::Map(m) => {
            has_unknown_wire_type_inner(&m.key_type, pool, visited, depth + 1)
                || has_unknown_wire_type_inner(&m.value_type, pool, visited, depth + 1)
        }
        WireType::Literal(_) => false,
        WireType::Ref(r) => {
            if !visited.insert(r.r#ref.clone()) {
                // Cycle detected — breaking loop without error
                return false;
            }
            let res = if let Some(p) = pool {
                if let Some(target) = p.get(&r.r#ref) {
                    has_unknown_wire_type_inner(target, pool, visited, depth + 1)
                } else {
                    true
                }
            } else {
                true
            };
            visited.remove(&r.r#ref);
            res
        }
        WireType::Object(obj) => obj
            .properties
            .iter()
            .any(|prop| has_unknown_wire_type_inner(&prop.r#type, pool, visited, depth + 1)),
    }
}

fn has_any_wire_type(wire: &WireType, pool: Option<&BTreeMap<String, WireType>>) -> bool {
    let mut visited = HashSet::new();
    has_any_wire_type_inner(wire, pool, &mut visited, 0)
}

fn has_any_wire_type_inner(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> bool {
    if depth > 32 {
        return false;
    }
    match wire {
        WireType::Primitive(p) => matches!(p.scalar, PrimitiveScalar::Any),
        WireType::Array(arr) => {
            has_any_wire_type_inner(&arr.element_type, pool, visited, depth + 1)
        }
        WireType::Nullable(null) => {
            has_any_wire_type_inner(&null.inner_type, pool, visited, depth + 1)
        }
        WireType::Optional(opt) => {
            has_any_wire_type_inner(&opt.inner_type, pool, visited, depth + 1)
        }
        WireType::Union(un) => un
            .types
            .iter()
            .any(|v| has_any_wire_type_inner(v, pool, visited, depth + 1)),
        WireType::Map(m) => {
            has_any_wire_type_inner(&m.key_type, pool, visited, depth + 1)
                || has_any_wire_type_inner(&m.value_type, pool, visited, depth + 1)
        }
        WireType::Ref(r) => {
            if !visited.insert(r.r#ref.clone()) {
                return false;
            }
            let res = if let Some(p) = pool {
                if let Some(target) = p.get(&r.r#ref) {
                    has_any_wire_type_inner(target, pool, visited, depth + 1)
                } else {
                    false
                }
            } else {
                false
            };
            visited.remove(&r.r#ref);
            res
        }
        WireType::Object(obj) => obj
            .properties
            .iter()
            .any(|prop| has_any_wire_type_inner(&prop.r#type, pool, visited, depth + 1)),
        _ => false,
    }
}

fn synthesize_fc_arbitrary(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    indent: usize,
) -> String {
    let mut visited = HashSet::new();
    synthesize_fc_arbitrary_inner(wire, pool, indent, &mut visited, 0)
}

fn synthesize_fc_arbitrary_inner(
    wire: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
    indent: usize,
    visited: &mut HashSet<String>,
    depth: usize,
) -> String {
    if depth > 16 {
        return "fc.anything()".to_string();
    }
    let spaces = " ".repeat(indent);
    match wire {
        WireType::Primitive(p) => match p.scalar {
            PrimitiveScalar::String => "fc.string({ minLength: 1 })".to_string(),
            PrimitiveScalar::Number => "fc.integer({ min: 1, max: 100000 })".to_string(),
            PrimitiveScalar::Boolean => "fc.boolean()".to_string(),
            PrimitiveScalar::BigInt => "fc.bigInt()".to_string(),
            PrimitiveScalar::Void => "fc.constant(undefined)".to_string(),
            PrimitiveScalar::Any => "fc.anything()".to_string(),
        },
        WireType::Array(arr) => {
            let inner =
                synthesize_fc_arbitrary_inner(&arr.element_type, pool, indent, visited, depth + 1);
            format!("fc.array({})", inner)
        }
        WireType::Nullable(null) => {
            let inner =
                synthesize_fc_arbitrary_inner(&null.inner_type, pool, indent, visited, depth + 1);
            format!("fc.option({}, {{ nil: null }})", inner)
        }
        WireType::Optional(opt) => {
            let inner =
                synthesize_fc_arbitrary_inner(&opt.inner_type, pool, indent, visited, depth + 1);
            format!("fc.option({}, {{ nil: undefined }})", inner)
        }
        WireType::Map(m) => {
            let key = synthesize_fc_arbitrary_inner(&m.key_type, pool, indent, visited, depth + 1);
            let val =
                synthesize_fc_arbitrary_inner(&m.value_type, pool, indent, visited, depth + 1);
            format!("fc.dictionary({}, {})", key, val)
        }
        WireType::Literal(lit) => {
            let val_str = serde_json::to_string(&lit.value).unwrap_or_else(|_| "\"\"".to_string());
            format!("fc.constant({})", val_str)
        }
        WireType::Enum(en) => {
            let members: Vec<String> = en
                .values
                .iter()
                .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "\"\"".to_string()))
                .collect();
            format!("fc.constantFrom({})", members.join(", "))
        }
        WireType::Union(un) => {
            let variants: Vec<String> = un
                .types
                .iter()
                .map(|v| synthesize_fc_arbitrary_inner(v, pool, indent, visited, depth + 1))
                .collect();
            format!("fc.oneof({})", variants.join(", "))
        }
        WireType::Ref(r) => {
            if visited.contains(&r.r#ref) {
                return "fc.anything()".to_string();
            }
            visited.insert(r.r#ref.clone());
            let res = if let Some(p) = pool {
                if let Some(target) = p.get(&r.r#ref) {
                    synthesize_fc_arbitrary_inner(target, pool, indent, visited, depth + 1)
                } else {
                    "fc.anything()".to_string()
                }
            } else {
                "fc.anything()".to_string()
            };
            visited.remove(&r.r#ref);
            res
        }
        WireType::Object(obj) => {
            if obj.properties.is_empty() {
                return "fc.record({})".to_string();
            }
            let mut lines = Vec::new();
            lines.push("fc.record({".to_string());
            for prop in &obj.properties {
                let inner = synthesize_fc_arbitrary_inner(
                    &prop.r#type,
                    pool,
                    indent + 4,
                    visited,
                    depth + 1,
                );
                lines.push(format!("{}    {}: {},", spaces, prop.wire_name, inner));
            }
            lines.push(format!("{}}})", spaces));
            lines.join("\n")
        }
        WireType::Unknown(_) => "fc.anything()".to_string(),
    }
}

/// A TypeScript predicate over the contract's required fields, plus the top-level keys the
/// generated test deletes to prove the predicate is not vacuous.
fn ts_shape_check(
    body: &WireType,
    pool: Option<&BTreeMap<String, WireType>>,
) -> Option<(String, Vec<String>)> {
    let mut required_keys = Vec::new();
    let mut visited = HashSet::new();
    let predicate = ts_shape_expr(body, "v", pool, &mut visited, 0, &mut required_keys)?;
    if predicate == "true" {
        return None;
    }
    Some((predicate, required_keys))
}

fn ts_shape_expr(
    wire: &WireType,
    access: &str,
    pool: Option<&BTreeMap<String, WireType>>,
    visited: &mut HashSet<String>,
    depth: usize,
    required_keys: &mut Vec<String>,
) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if let WireType::Ref(r) = wire {
        if !visited.insert(r.r#ref.clone()) {
            // A recursive reference cannot be asserted by a finite predicate.
            // Refuse the shape instead of replacing the cycle with `true`.
            return None;
        }
        let res = if let Some(target) = pool.and_then(|p| p.get(&r.r#ref)) {
            ts_shape_expr(target, access, pool, visited, depth + 1, required_keys)
        } else {
            None
        };
        visited.remove(&r.r#ref);
        return res;
    }
    match wire {
        WireType::Object(obj) => {
            let mut conjuncts = vec![format!("isRecord({access})")];
            for prop in &obj.properties {
                if prop.optional {
                    continue;
                }
                let name = ts_string_literal(&prop.wire_name);
                if depth == 0 {
                    required_keys.push(prop.wire_name.clone());
                }
                let child = format!("{access}[{name}]");
                if prop.nullable || is_nullable_shape(&prop.r#type) {
                    let inner_type = match &prop.r#type {
                        WireType::Nullable(n) => &n.inner_type,
                        other => other,
                    };
                    let Some(expr) =
                        ts_shape_expr(inner_type, &child, pool, visited, depth + 1, required_keys)
                    else {
                        return None;
                    };
                    if expr == "true" || expr.is_empty() {
                        return None;
                    }
                    conjuncts.push(format!(
                        "({name} in {access} && ({child} === null || {expr}))"
                    ));
                    continue;
                }
                let Some(expr) = ts_shape_expr(
                    &prop.r#type,
                    &child,
                    pool,
                    visited,
                    depth + 1,
                    required_keys,
                ) else {
                    return None;
                };
                if expr == "true" {
                    return None;
                }
                conjuncts.push(expr);
            }
            Some(conjuncts.join(" && "))
        }
        WireType::Array(arr) => {
            let base_check = format!("Array.isArray({access})");
            let mut child_keys = Vec::new();
            if let Some(elem_expr) = ts_shape_expr(
                &arr.element_type,
                "e",
                pool,
                visited,
                depth + 1,
                &mut child_keys,
            ) {
                if elem_expr != "true" && !elem_expr.is_empty() {
                    return Some(format!(
                        "{base_check} && {access}.every((e: unknown) => {elem_expr})"
                    ));
                }
            }
            Some(base_check)
        }
        WireType::Map(map) => {
            let Some(value_expr) = ts_shape_expr(
                &map.value_type,
                "e",
                pool,
                visited,
                depth + 1,
                &mut Vec::new(),
            ) else {
                return None;
            };
            if value_expr == "true" {
                return None;
            }
            Some(format!(
                "isRecord({access}) && Object.values({access}).every((e: unknown) => {value_expr})"
            ))
        }
        WireType::Primitive(p) => match p.scalar {
            PrimitiveScalar::String => Some(format!("typeof {access} === 'string'")),
            PrimitiveScalar::Number | PrimitiveScalar::BigInt => {
                Some(format!("typeof {access} === 'number'"))
            }
            PrimitiveScalar::Boolean => Some(format!("typeof {access} === 'boolean'")),
            PrimitiveScalar::Void => Some("true".to_string()),
            PrimitiveScalar::Any => None,
        },
        WireType::Enum(en) => match en.values.first() {
            Some(serde_json::Value::String(_)) => Some(format!("typeof {access} === 'string'")),
            Some(serde_json::Value::Number(_)) => Some(format!("typeof {access} === 'number'")),
            _ => None,
        },
        WireType::Literal(lit) => match &lit.value {
            serde_json::Value::Null => Some(format!("{access} === null")),
            v => serde_json::to_string(v)
                .ok()
                .map(|s| format!("{access} === {s}")),
        },
        WireType::Nullable(n) => {
            let inner_expr = ts_shape_expr(
                &n.inner_type,
                access,
                pool,
                visited,
                depth + 1,
                required_keys,
            )?;
            if inner_expr == "true" || inner_expr.is_empty() {
                return None;
            }
            Some(format!("({access} === null || {inner_expr})"))
        }
        WireType::Optional(o) => ts_shape_expr(
            &o.inner_type,
            access,
            pool,
            visited,
            depth + 1,
            required_keys,
        ),
        WireType::Union(u) => {
            let mut alt_exprs = Vec::new();
            for alt in &u.types {
                let expr = ts_shape_expr(alt, access, pool, visited, depth + 1, required_keys)?;
                if expr == "true" {
                    return None;
                }
                alt_exprs.push(expr);
            }
            if alt_exprs.is_empty() {
                None
            } else {
                Some(format!("({})", alt_exprs.join(" || ")))
            }
        }
        WireType::Unknown(_) => None,
        // Handled by the early Ref branch above; the arm keeps the match total.
        WireType::Ref(_) => None,
    }
}

fn ts_string_literal(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "''".to_string())
}

fn joined_ts_literals(values: &[String]) -> String {
    values
        .iter()
        .map(|v| ts_string_literal(v))
        .collect::<Vec<String>>()
        .join(", ")
}

fn slugify_route(verb: &str, route: &str, id: usize) -> String {
    let mut slug = String::from(verb.to_lowercase());
    for part in route.split('/') {
        let clean: String = part.chars().filter(|c| c.is_alphanumeric()).collect();
        if !clean.is_empty() {
            slug.push('_');
            slug.push_str(&clean);
        }
    }
    format!("test_{}_{}", slug, id)
}

fn format_path_mock(route: &str) -> String {
    let mut out = String::new();
    for part in route.split('/') {
        if part.starts_with('{') && part.ends_with('}') {
            out.push_str("/1");
        } else if !part.is_empty() {
            out.push('/');
            out.push_str(part);
        }
    }
    if out.is_empty() {
        "/".to_string()
    } else {
        out
    }
}

fn render_ts_path(route: &str, fixture: Option<&EndpointRequestFixture>) -> String {
    let mut path = route.to_string();
    if let Some(fixture) = fixture {
        for (name, value) in &fixture.path_parameters {
            path = path.replace(&format!("{{{name}}}"), value);
        }
    }
    if path.contains('{') {
        format_path_mock(route)
    } else {
        path
    }
}

fn render_ts_path_with_query(path: &str, query_params: &BTreeMap<String, String>) -> String {
    if query_params.is_empty() {
        path.to_string()
    } else {
        let query = query_params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        if path.contains('?') {
            format!("{path}&{query}")
        } else {
            format!("{path}?{query}")
        }
    }
}

fn ts_headers_expr(fixture: Option<&EndpointRequestFixture>, content_type: Option<&str>) -> String {
    let mut parts = vec!["...authHeaders".to_string()];
    if let Some(ct) = content_type {
        parts.push(format!("'Content-Type': {}", ts_string_literal(ct)));
    }
    if let Some(fixture) = fixture {
        for (name, value) in &fixture.headers {
            parts.push(format!(
                "{}: {}",
                ts_string_literal(name),
                ts_string_literal(value)
            ));
        }
        for (name, env) in &fixture.headers_from_env {
            parts.push(format!(
                "{}: process.env[{}] ?? \"\"",
                ts_string_literal(name),
                ts_string_literal(env)
            ));
        }
    }
    format!("{{ {} }}", parts.join(", "))
}

fn supertest_status_check(exact: Option<u16>, family: StatusCodeFamily) -> String {
    if let Some(code) = exact {
        return format!("        expect(response.status).toBe({code});\n");
    }
    match family {
        StatusCodeFamily::Success2xx => {
            "        expect(response.status).toBeGreaterThanOrEqual(200);\n        expect(response.status).toBeLessThan(300);\n"
                .to_string()
        }
        StatusCodeFamily::Error4xx5xx => {
            "        expect(response.status).toBeGreaterThanOrEqual(400);\n        expect(response.status).toBeLessThan(600);\n"
                .to_string()
        }
    }
}

pub fn synthesize_supertest(
    envelope: &ContractArtifactEnvelope,
    suite_name: Option<&str>,
) -> Result<String> {
    synthesize_supertest_output(envelope, suite_name, &RequestFixtures::default()).map(|o| o.code)
}

fn synthesize_supertest_output(
    envelope: &ContractArtifactEnvelope,
    suite_name_opt: Option<&str>,
    fixtures: &RequestFixtures,
) -> Result<SynthesisOutput> {
    let mut summary = SynthesisSummary::new(TestSynthesisFramework::Supertest);
    let payload = match &envelope.payload {
        ArtifactPayload::Backend(p) => p,
        _ => {
            return Err(anyhow!(
                "Supertest synthesis requires a Backend contract artifact"
            ))
        }
    };

    let suite_name = suite_name_opt.unwrap_or("NestJS Contract E2E Tests");
    let type_pool = payload.type_pool.as_ref();

    let mut out = String::new();
    out.push_str("// Generated by Sajimora Native Synthesis (supertest / nestjs)\n");
    out.push_str("// Contract-guided E2E integration tests for NestJS controllers\n\n");
    out.push_str("import { Test, TestingModule } from '@nestjs/testing';\n");
    out.push_str("import { INestApplication } from '@nestjs/common';\n");
    out.push_str("import request from 'supertest';\n");
    out.push_str("// The suite must boot the real application module so the in-memory server\n");
    out.push_str("// registers the controllers the contract was extracted from.\n");
    out.push_str("import { AppModule } from '../src/app.module';\n\n");
    out.push_str("const isRecord = (v: unknown): v is Record<string, unknown> =>\n");
    out.push_str("    typeof v === 'object' && v !== null && !Array.isArray(v);\n\n");

    out.push_str(&format!("describe('{}', () => {{\n", suite_name));
    out.push_str("    let app: INestApplication;\n\n");
    out.push_str("    beforeAll(async () => {\n");
    out.push_str("        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();\n");
    out.push_str("        app = moduleRef.createNestApplication();\n");
    out.push_str("        await app.init();\n");
    out.push_str("    });\n\n");
    out.push_str("    afterAll(async () => {\n");
    out.push_str("        await app.close();\n");
    out.push_str("    });\n\n");

    let mut endpoint_counter = 0;
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction != ContractDirection::Response {
            continue;
        }

        endpoint_counter += 1;
        let idx = endpoint_counter;
        let route = &endpoint.identity.normalized_route.raw_path;
        let verb = endpoint.identity.http_method.to_uppercase();

        let fixture = fixtures.endpoints.get(&format!("{verb} {route}"));
        let exact_status = fixture.and_then(|f| f.expected_status);
        let status_family = endpoint
            .status_code_family
            .unwrap_or(StatusCodeFamily::Success2xx);
        let status_check = supertest_status_check(exact_status, status_family);

        let p = render_ts_path(route, fixture);
        let path = if let Some(f) = fixture {
            render_ts_path_with_query(&p, &f.query_parameters)
        } else {
            p
        };

        let body_opt = endpoint.body.as_ref();
        if body_opt.is_none() || exact_status == Some(204) {
            summary.record_check(0, false);
            out.push_str(&format!(
                "    it('{} {} responds with status', async () => {{\n",
                verb, route
            ));
            let method_lower = verb.to_lowercase();
            out.push_str(&format!(
                "        const response = await request(app.getHttpServer()).{}({});\n",
                method_lower,
                ts_string_literal(&path)
            ));
            out.push_str(&status_check);
            out.push_str("    });\n\n");
            continue;
        }

        let body = body_opt.unwrap();
        if matches!(body, WireType::Enum(_))
            || unsupported_ts_response_shape(body, type_pool).is_some()
        {
            summary.abstentions += 1;
            out.push_str("    // ABSTAIN: UNSUPPORTED_CONSTRUCT in NestJS response synthesis\n\n");
            continue;
        }

        if has_unknown_wire_type(body, type_pool) {
            summary.abstentions += 1;
            out.push_str(&format!(
                "    // ABSTAIN: Endpoint {} {} contains unresolved WireType::Unknown\n\n",
                verb,
                route.replace(['\r', '\n'], " ")
            ));
            continue;
        }

        match ts_shape_check(body, type_pool) {
            Some((predicate, _)) => {
                summary.record_check(1, partial_response_shape(body, type_pool));
                out.push_str(&format!(
                    "    const shape_{idx} = (v: unknown): boolean => {predicate};\n\n"
                ));
                out.push_str(&format!(
                    "    it('{} {} matches contract response shape', async () => {{\n",
                    verb, route
                ));
                let method_lower = verb.to_lowercase();
                out.push_str(&format!(
                    "        const response = await request(app.getHttpServer()).{}({});\n",
                    method_lower,
                    ts_string_literal(&path)
                ));
                out.push_str(&status_check);
                out.push_str(&format!(
                    "        expect(shape_{idx}(response.body)).toBe(true);\n"
                ));
                out.push_str("    });\n\n");
            }
            None => {
                summary.record_check(0, false);
                out.push_str(&format!(
                    "    it('{} {} responds with expected status', async () => {{\n",
                    verb, route
                ));
                let method_lower = verb.to_lowercase();
                out.push_str(&format!(
                    "        const response = await request(app.getHttpServer()).{}({});\n",
                    method_lower,
                    ts_string_literal(&path)
                ));
                out.push_str(&status_check);
                out.push_str("    });\n\n");
            }
        }
    }

    out.push_str("});\n");
    Ok(SynthesisOutput { code: out, summary })
}
