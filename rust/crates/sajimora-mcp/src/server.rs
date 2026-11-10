//! server.rs — MCP transport, tool definitions, and dispatch.

use std::path::PathBuf;
use std::sync::Arc;

use crate::verify::{self, RevisionMode, VerifyRequest};
use contract_core::serialization::serialize_report;
use contract_core::service::{run_check_contract_service, CheckContractServiceRequest};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    ErrorData as McpError, RoleServer, ServerHandler,
};
use tokio::sync::Semaphore;

/// MCP server configuration set at startup; not overridable via tool input.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    /// Filesystem roots that artifact paths must be under (after symlink resolution).
    pub allowed_roots: Vec<PathBuf>,
    /// Trust policy path. Loaded once or per request from trusted startup config.
    pub trust_policy_path: Option<PathBuf>,
    /// Whether --trusted-local mode is enabled for this server instance.
    pub trusted_local: bool,
    /// Maximum concurrent check-contract jobs.
    pub max_concurrent_jobs: usize,
    /// Require service mapping for relative routes.
    pub require_service_mapping: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        McpServerConfig {
            allowed_roots: vec![],
            trust_policy_path: None,
            trusted_local: false,
            max_concurrent_jobs: 4,
            require_service_mapping: true,
        }
    }
}

/// The Sajimora MCP Server Handler.
#[derive(Clone)]
pub struct SajimoraMcpServer {
    config: McpServerConfig,
    semaphore: Arc<Semaphore>,
}

impl SajimoraMcpServer {
    pub fn new(config: McpServerConfig) -> Self {
        let max_jobs = if config.max_concurrent_jobs == 0 {
            1
        } else {
            config.max_concurrent_jobs
        };
        let semaphore = Arc::new(Semaphore::new(max_jobs));
        Self { config, semaphore }
    }

    pub fn tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "base": {
                    "type": "string",
                    "description": "Path to base backend contract artifact JSON file"
                },
                "candidate": {
                    "type": "string",
                    "description": "Path to candidate backend contract artifact JSON file"
                },
                "targets": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "List of paths to target frontend contract artifact JSON files (at least 1 required)"
                },
                "detail": {
                    "type": "string",
                    "enum": ["summary", "full"],
                    "description": "Default summary omits blocker details but keeps coverage counts; full returns the complete advisory report"
                },
                "telemetry": {
                    "type": "string",
                    "description": "Optional path to a sealed telemetry artifact (SAJIMORA_TELEMETRY_ARTIFACT_V1). Attaches its integrity.sha256, serviceId and totalObservations to the report as evidence reference; it does not change the verdict and its signature is not verified here"
                }
            }),
        );
        schema_map.insert(
            "required".to_string(),
            serde_json::json!(["base", "candidate", "targets"]),
        );

        Tool::new(
            "sajimora_check_contract",
            "Check contract compatibility between base, candidate, and target frontend artifacts",
            Arc::new(schema_map),
        )
    }

    /// Repository-level gate: resolve a provider revision from Git, discover
    /// the consumer contracts available for cross-verification, and run the
    /// same comparison service as `sajimora_check_contract`.
    pub fn verify_tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "repoRoot": {
                    "type": "string",
                    "description": "Repository root containing .sajimora/; must be under a server --allowed-root"
                },
                "revisionMode": {
                    "type": "string",
                    "enum": ["workingTreeVsBaseline", "stagedVsBaseline", "commitRange"],
                    "description": "Default workingTreeVsBaseline. stagedVsBaseline reads only Git index blobs, so unstaged edits are not observable. commitRange compares two committed trees and requires commitRange"
                },
                "commitRange": {
                    "type": "string",
                    "description": "parent..candidate for revisionMode=commitRange. Both endpoints are resolved with rev-parse --verify and read from Git trees; three-dot symmetric ranges are rejected"
                },
                "targetServices": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional service id allow-list applied after discovery; empty or absent means every discovered consumer contract"
                },
                "strict": {
                    "type": "boolean",
                    "description": "Default false. When true an INCONCLUSIVE or ANALYSIS_ERROR report is returned as a tool error, mirroring sajimora verify --strict exit code 3"
                },
                "detail": {
                    "type": "string",
                    "enum": ["summary", "full"],
                    "description": "Default summary omits blocker details; full returns the complete advisory report"
                }
            }),
        );
        schema_map.insert("required".to_string(), serde_json::json!(["repoRoot"]));

        Tool::new(
            "sajimora_verify",
            "Verify a provider revision against the sealed baseline and every discoverable consumer contract; abstains (INCONCLUSIVE, NO_CONSUMER_CONTRACTS) when no consumer evidence exists",
            Arc::new(schema_map),
        )
    }

    pub fn heal_tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "testDir": {
                    "type": "string",
                    "description": "Directory or file path containing test suites to inspect and heal (default: 'src/test')"
                },
                "target": {
                    "type": "string",
                    "description": "Optional target file (e.g. OrderService.java) or method name (e.g. calculateTax)"
                },
                "method": {
                    "type": "string",
                    "description": "Optional method name to heal (e.g. 'calculateFinalPrice')"
                },
                "paramIndex": {
                    "type": "integer",
                    "description": "Target 0-indexed parameter position to inject (defaults to end)"
                },
                "defaultValue": {
                    "type": "string",
                    "description": "Default value expression to inject (e.g. 'false', '0', '0.0', '\"\"', 'Optional.empty()')"
                },
                "oldFile": {
                    "type": "string",
                    "description": "Path to old source file for signature diffing"
                },
                "newFile": {
                    "type": "string",
                    "description": "Path to refactored source file"
                },
                "detectOnly": {
                    "type": "boolean",
                    "description": "Advisory detection only; does not write any files to disk"
                }
            }),
        );

        Tool::new(
            "sajimora_heal",
            "Autonomous AST test call-site self-healing engine. Automatically updates broken test invocations when method signatures change, injecting safe default arguments while strictly preserving non-target AST nodes, whitespace, and comments verbatim. Enforces fail-closed safety abstentions on side-effecting arguments and unresolvable defaults.",
            Arc::new(schema_map),
        )
    }

    pub fn gen_invariants_tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "file": {
                    "type": "string",
                    "description": "Target Java source file to analyze"
                },
                "framework": {
                    "type": "string",
                    "enum": ["jqwik", "junit5"],
                    "description": "Test framework for synthesized property tests (default: 'jqwik')"
                },
                "outFile": {
                    "type": "string",
                    "description": "Optional destination file path to write generated property tests"
                },
                "name": {
                    "type": "string",
                    "description": "Optional class name for generated test suite"
                },
                "package": {
                    "type": "string",
                    "description": "Optional package name for generated test suite"
                }
            }),
        );
        schema_map.insert("required".to_string(), serde_json::json!(["file"]));

        Tool::new(
            "sajimora_gen_invariants",
            "Autonomous metamorphic invariant test synthesizer. Synthesizes mathematically sound property-based tests (idempotence f(f(x)) == f(x), null-safety contracts, boundary range proofs) in jqwik without LLM calls. Strictly abstains on side-effecting operations.",
            Arc::new(schema_map),
        )
    }

    pub fn gen_unit_tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "file": {
                    "type": "string",
                    "description": "Target Java source file containing business methods"
                },
                "method": {
                    "type": "string",
                    "description": "Optional specific method name to synthesize tests for"
                },
                "outFile": {
                    "type": "string",
                    "description": "Optional destination file path to write generated JUnit 5 tests"
                },
                "budgetMs": {
                    "type": "integer",
                    "description": "Solver wall-clock budget per method in milliseconds (default: 50)"
                }
            }),
        );
        schema_map.insert("required".to_string(), serde_json::json!(["file"]));

        Tool::new(
            "sajimora_gen_unit",
            "Bounded Symbolic Unit Test Synthesizer. Autonomous branch test generation for internal business calculation logic. Solves path conditions via Tier 1 SMT solver within a 50ms budget and enforces the 2-hop mock depth budget.",
            Arc::new(schema_map),
        )
    }

    pub fn verify_behavior_tool_definition() -> Tool {
        let mut schema_map = serde_json::Map::new();
        schema_map.insert("type".to_string(), serde_json::json!("object"));
        schema_map.insert(
            "properties".to_string(),
            serde_json::json!({
                "candidate": {
                    "type": "string",
                    "description": "Candidate revision source file path"
                },
                "base": {
                    "type": "string",
                    "description": "Optional base revision file path, defaults to git HEAD of candidate"
                },
                "method": {
                    "type": "string",
                    "description": "Optional target method name to verify (auto-discovered if omitted)"
                },
                "budgetMs": {
                    "type": "integer",
                    "description": "Wall-clock solver budget in milliseconds (default: 50)"
                },
                "strict": {
                    "type": "boolean",
                    "description": "Strict mode: requires formal mathematical proof of equivalence, rejecting bounded advisory or unknown"
                }
            }),
        );
        schema_map.insert("required".to_string(), serde_json::json!(["candidate"]));

        Tool::new(
            "sajimora_verify_behavior",
            "Bounded Differential Behavioral Equivalence Gate (Bisimulation). Verifies behavioral equivalence of calculation logic across dual revisions (file vs file or candidate vs Git HEAD). Distinguishes formal Presburger equivalence proofs, counterexample witnesses sealed with SHA-256 hashes, and bounded advisory signals.",
            Arc::new(schema_map),
        )
    }
}

impl ServerHandler for SajimoraMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("sajimora-mcp", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(vec![
            Self::tool_definition(),
            Self::verify_tool_definition(),
            Self::heal_tool_definition(),
            Self::gen_invariants_tool_definition(),
            Self::gen_unit_tool_definition(),
            Self::verify_behavior_tool_definition(),
            Self::endpoint_impact_tool_definition(),
            Self::change_evaluate_tool_definition(),
            Self::run_tool_definition(),
            Self::query_tool_definition(),
            Self::what_if_tool_definition(),
        ]))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        match name {
            "sajimora_check_contract" => Some(Self::tool_definition()),
            "sajimora_verify" => Some(Self::verify_tool_definition()),
            "sajimora_heal" => Some(Self::heal_tool_definition()),
            "sajimora_gen_invariants" => Some(Self::gen_invariants_tool_definition()),
            "sajimora_gen_unit" => Some(Self::gen_unit_tool_definition()),
            "sajimora_verify_behavior" => Some(Self::verify_behavior_tool_definition()),
            "sajimora_endpoint_impact" => Some(Self::endpoint_impact_tool_definition()),
            "sajimora_change_evaluate" => Some(Self::change_evaluate_tool_definition()),
            "sajimora_run" => Some(Self::run_tool_definition()),
            "sajimora_query" => Some(Self::query_tool_definition()),
            "sajimora_what_if" => Some(Self::what_if_tool_definition()),
            _ => None,
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        match request.name.as_ref() {
            "sajimora_check_contract" => self.call_check_contract(request.arguments).await,
            "sajimora_verify" => self.call_verify(request.arguments).await,
            "sajimora_heal" => self.call_heal(request.arguments).await,
            "sajimora_gen_invariants" => self.call_gen_invariants(request.arguments).await,
            "sajimora_gen_unit" => self.call_gen_unit(request.arguments).await,
            "sajimora_verify_behavior" => self.call_verify_behavior(request.arguments).await,
            "sajimora_endpoint_impact" => self.call_endpoint_impact(request.arguments).await,
            "sajimora_change_evaluate" => self.call_change_evaluate(request.arguments).await,
            "sajimora_run" => self.call_run(request.arguments).await,
            "sajimora_query" => self.call_query(request.arguments).await,
            "sajimora_what_if" => self.call_what_if(request.arguments).await,
            other => Err(McpError::invalid_params(
                format!("Unknown tool: {other}"),
                None,
            )),
        }
    }
}

impl SajimoraMcpServer {
    fn endpoint_impact_tool_definition() -> Tool {
        crate::endpoint_impact::tool_definition()
    }

    async fn call_endpoint_impact(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = arguments.unwrap_or_default();
        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let allowed_roots = self.config.allowed_roots.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::endpoint_impact::run_endpoint_impact(&allowed_roots, &args)
        })
        .await;
        match result {
            Ok(Ok(report)) => Ok(CallToolResult::success(vec![ContentBlock::text(report)]).into()),
            Ok(Err(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]).into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_endpoint_impact task failed: {error}"
            ))])
            .into()),
        }
    }

    fn change_evaluate_tool_definition() -> Tool {
        crate::change_evaluate::tool_definition()
    }

    async fn call_change_evaluate(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = arguments.unwrap_or_default();
        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let allowed_roots = self.config.allowed_roots.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::change_evaluate::run_change_evaluate(&allowed_roots, &args)
        })
        .await;
        match result {
            Ok(Ok(report)) => Ok(CallToolResult::success(vec![ContentBlock::text(report)]).into()),
            Ok(Err(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]).into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_change_evaluate task failed: {error}"
            ))])
            .into()),
        }
    }

    fn run_tool_definition() -> Tool {
        crate::run::tool_definition()
    }

    async fn call_run(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = arguments.unwrap_or_default();
        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let allowed_roots = self.config.allowed_roots.clone();
        let result =
            tokio::task::spawn_blocking(move || crate::run::run_pipeline(&allowed_roots, &args))
                .await;
        match result {
            Ok(Ok(report)) => Ok(CallToolResult::success(vec![ContentBlock::text(report)]).into()),
            Ok(Err(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]).into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_run task failed: {error}"
            ))])
            .into()),
        }
    }

    fn query_tool_definition() -> Tool {
        crate::query::tool_definition()
    }

    async fn call_query(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = arguments.unwrap_or_default();
        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let allowed_roots = self.config.allowed_roots.clone();
        let result =
            tokio::task::spawn_blocking(move || crate::query::run_query(&allowed_roots, &args))
                .await;
        match result {
            Ok(Ok(report)) => Ok(CallToolResult::success(vec![ContentBlock::text(report)]).into()),
            Ok(Err(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]).into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_query task failed: {error}"
            ))])
            .into()),
        }
    }

    fn what_if_tool_definition() -> Tool {
        crate::what_if::tool_definition()
    }

    async fn call_what_if(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = arguments.unwrap_or_default();
        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let allowed_roots = self.config.allowed_roots.clone();
        let result =
            tokio::task::spawn_blocking(move || crate::what_if::run_what_if(&allowed_roots, &args))
                .await;
        match result {
            Ok(Ok(report)) => Ok(CallToolResult::success(vec![ContentBlock::text(report)]).into()),
            Ok(Err(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]).into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_what_if task failed: {error}"
            ))])
            .into()),
        }
    }

    /// Parse `detail` once for both tools; anything else is a caller error.
    fn parse_detail(detail: Option<&serde_json::Value>) -> Result<&'static str, McpError> {
        match detail {
            None => Ok("summary"),
            Some(value) if value.as_str() == Some("summary") => Ok("summary"),
            Some(value) if value.as_str() == Some("full") => Ok("full"),
            _ => Err(McpError::invalid_params(
                "Invalid detail: expected summary or full".to_string(),
                None,
            )),
        }
    }

    async fn call_check_contract(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = match arguments {
            Some(args) => args,
            None => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing arguments for sajimora_check_contract",
                )])
                .into());
            }
        };

        let base = match args.get("base").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => PathBuf::from(s),
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing or invalid required argument: 'base'",
                )])
                .into());
            }
        };

        let candidate = match args.get("candidate").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => PathBuf::from(s),
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing or invalid required argument: 'candidate'",
                )])
                .into());
            }
        };

        let targets = match args.get("targets").and_then(|v| v.as_array()) {
            Some(arr) if !arr.is_empty() => {
                let mut list = Vec::new();
                for item in arr {
                    if let Some(s) = item.as_str() {
                        if !s.is_empty() {
                            list.push(PathBuf::from(s));
                        }
                    } else {
                        return Ok(CallToolResult::error(vec![ContentBlock::text(
                            "Elements of 'targets' array must be non-empty strings",
                        )])
                        .into());
                    }
                }
                list
            }
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing or empty required argument: 'targets'",
                )])
                .into());
            }
        };

        let base_targets = match args.get("baseTargets").and_then(|v| v.as_array()) {
            Some(arr) if !arr.is_empty() => {
                let mut list = Vec::new();
                for item in arr {
                    if let Some(s) = item.as_str() {
                        if !s.is_empty() {
                            list.push(PathBuf::from(s));
                        }
                    }
                }
                if list.is_empty() {
                    None
                } else {
                    Some(list)
                }
            }
            _ => None,
        };

        // An empty string means "no telemetry", matching the CLI default.
        let telemetry_path = match args.get("telemetry").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => Some(PathBuf::from(s)),
            _ => None,
        };

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => {
                return Err(McpError::internal_error("Server closing", None));
            }
        };

        let detail = Self::parse_detail(args.get("detail"))?;

        let service_req = CheckContractServiceRequest {
            base_path: base,
            candidate_path: candidate,
            target_paths: targets,
            base_target_paths: base_targets,
            trust_policy_path: self.config.trust_policy_path.clone(),
            trusted_local: self.config.trusted_local,
            require_service_mapping: self.config.require_service_mapping,
            allowed_roots: if self.config.allowed_roots.is_empty() {
                None
            } else {
                Some(self.config.allowed_roots.clone())
            },
            max_artifact_bytes: None,
            telemetry_path,
            evaluation_time_unix: None,
            deployment_liveness_verified: false,
        };

        let result =
            tokio::task::spawn_blocking(move || run_check_contract_service(service_req)).await;

        match result {
            Ok(Ok(report)) => {
                let has_admission_error = report
                    .blockers
                    .iter()
                    .any(|b| b.message.contains("admission failed"));
                let json = format_mcp_report(
                    &serialize_report(report),
                    detail == "full" || has_admission_error,
                );
                if has_admission_error {
                    Ok(CallToolResult::error(vec![ContentBlock::text(json)]).into())
                } else {
                    Ok(CallToolResult::success(vec![ContentBlock::text(json)]).into())
                }
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_check_contract failed: {:#}",
                e
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {}",
                join_err
            ))])
            .into()),
        }
    }

    async fn call_verify(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args = match arguments {
            Some(args) => args,
            None => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing arguments for sajimora_verify",
                )])
                .into());
            }
        };

        let repo_root = match args.get("repoRoot").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => PathBuf::from(s),
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "Missing or invalid required argument: 'repoRoot'",
                )])
                .into());
            }
        };
        let revision_mode = match args.get("revisionMode") {
            None => RevisionMode::WorkingTree,
            Some(value) => {
                let text = match value.as_str() {
                    Some(text) => text,
                    None => {
                        return Ok(CallToolResult::error(vec![ContentBlock::text(
                            "revisionMode must be a string",
                        )])
                        .into());
                    }
                };
                match RevisionMode::parse(text) {
                    Ok(mode) => mode,
                    Err(error) => {
                        return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                            "Invalid revisionMode: {error:#}"
                        ))])
                        .into());
                    }
                }
            }
        };
        let commit_range = match args.get("commitRange").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ => None,
        };
        let target_services = match args.get("targetServices") {
            None => None,
            Some(value) => match value.as_array() {
                Some(arr) => {
                    let mut names = Vec::with_capacity(arr.len());
                    for item in arr {
                        match item.as_str() {
                            Some(s) if !s.is_empty() => names.push(s.to_string()),
                            _ => {
                                return Ok(CallToolResult::error(vec![ContentBlock::text(
                                    "Elements of 'targetServices' must be non-empty strings",
                                )])
                                .into());
                            }
                        }
                    }
                    Some(names)
                }
                None => {
                    return Ok(CallToolResult::error(vec![ContentBlock::text(
                        "'targetServices' must be an array of service ids",
                    )])
                    .into());
                }
            },
        };
        let strict = args
            .get("strict")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };
        let detail = Self::parse_detail(args.get("detail"))?;

        let allowed_roots = self.config.allowed_roots.clone();
        let trust_policy_path = self.config.trust_policy_path.clone();
        let trusted_local = self.config.trusted_local;
        let require_service_mapping = self.config.require_service_mapping;
        let request = VerifyRequest {
            repo_root,
            target_services,
            revision_mode,
            commit_range,
            strict,
        };
        let resolution = tokio::task::spawn_blocking(move || {
            verify::run(
                &allowed_roots,
                trust_policy_path.as_deref(),
                trusted_local,
                require_service_mapping,
                request,
            )
        })
        .await;

        match resolution {
            Ok(Ok(resolution)) => {
                let blocking = verify::is_blocking(&resolution.report, strict);
                let report_json =
                    format_mcp_report(&serialize_report(resolution.report), detail == "full");
                let report: serde_json::Value =
                    serde_json::from_str(&report_json).expect("serialized report JSON");
                let response = serde_json::json!({
                    "report": report,
                    "verification": {
                        "revision": resolution.revision,
                        "consumers": resolution
                            .consumers
                            .iter()
                            .map(|entry| serde_json::json!({
                                "path": entry.path.to_string_lossy(),
                                "discoveryStep": entry.step,
                                "serviceId": entry.service_id,
                                "sha256": entry.sha256,
                            }))
                            .collect::<Vec<_>>(),
                        "rejectedConsumers": resolution.rejected,
                        "strict": strict,
                    },
                    "notice": verify::VERDICT_SCOPE_NOTICE,
                });
                let text = serde_json::to_string(&response)
                    .unwrap_or_else(|_| "{\"error\":\"report serialization failed\"}".to_string());
                let blocks = vec![ContentBlock::text(text)];
                Ok(if blocking {
                    CallToolResult::error(blocks).into()
                } else {
                    CallToolResult::success(blocks).into()
                })
            }
            Ok(Err(error)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_verify failed: {error:#}"
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {join_err}"
            ))])
            .into()),
        }
    }

    async fn call_heal(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args_val = serde_json::Value::Object(arguments.unwrap_or_default());
        let req: crate::heal::McpHealRequest = serde_json::from_value(args_val).map_err(|e| {
            McpError::invalid_params(format!("Invalid arguments for sajimora_heal: {e}"), None)
        })?;

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };

        let allowed_roots = self.config.allowed_roots.clone();
        let result =
            tokio::task::spawn_blocking(move || crate::heal::run_heal(req, &allowed_roots)).await;

        match result {
            Ok(Ok(summary)) => {
                let has_abstentions = !summary.abstentions.is_empty();
                let json = serde_json::to_string_pretty(&summary).unwrap_or_default();
                if has_abstentions {
                    Ok(CallToolResult::error(vec![ContentBlock::text(json)]).into())
                } else {
                    Ok(CallToolResult::success(vec![ContentBlock::text(json)]).into())
                }
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_heal failed: {:#}",
                e
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {}",
                join_err
            ))])
            .into()),
        }
    }

    async fn call_gen_invariants(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args_val = serde_json::Value::Object(arguments.unwrap_or_default());
        let req: crate::invariants::McpGenInvariantsRequest = serde_json::from_value(args_val)
            .map_err(|e| {
                McpError::invalid_params(
                    format!("Invalid arguments for sajimora_gen_invariants: {e}"),
                    None,
                )
            })?;

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };

        let allowed_roots = self.config.allowed_roots.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::invariants::run_gen_invariants(req, &allowed_roots)
        })
        .await;

        match result {
            Ok(Ok(report)) => {
                let json = serde_json::to_string_pretty(&report).unwrap_or_default();
                Ok(CallToolResult::success(vec![ContentBlock::text(json)]).into())
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_gen_invariants failed: {:#}",
                e
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {}",
                join_err
            ))])
            .into()),
        }
    }

    async fn call_gen_unit(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args_val = serde_json::Value::Object(arguments.unwrap_or_default());
        let req: crate::unit::McpGenUnitRequest =
            serde_json::from_value(args_val).map_err(|e| {
                McpError::invalid_params(
                    format!("Invalid arguments for sajimora_gen_unit: {e}"),
                    None,
                )
            })?;

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };

        let allowed_roots = self.config.allowed_roots.clone();
        let result =
            tokio::task::spawn_blocking(move || crate::unit::run_gen_unit(req, &allowed_roots))
                .await;

        match result {
            Ok(Ok(suite)) => {
                let json = serde_json::to_string_pretty(&suite).unwrap_or_default();
                Ok(CallToolResult::success(vec![ContentBlock::text(json)]).into())
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_gen_unit failed: {:#}",
                e
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {}",
                join_err
            ))])
            .into()),
        }
    }

    async fn call_verify_behavior(
        &self,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResponse, McpError> {
        let args_val = serde_json::Value::Object(arguments.unwrap_or_default());
        let req: crate::behavior::McpVerifyBehaviorRequest = serde_json::from_value(args_val)
            .map_err(|e| {
                McpError::invalid_params(
                    format!("Invalid arguments for sajimora_verify_behavior: {e}"),
                    None,
                )
            })?;

        let _permit = match self.semaphore.acquire().await {
            Ok(permit) => permit,
            Err(_) => return Err(McpError::internal_error("Server closing", None)),
        };

        let allowed_roots = self.config.allowed_roots.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::behavior::run_verify_behavior(req, &allowed_roots)
        })
        .await;

        match result {
            Ok(Ok(response)) => {
                let is_pass = response.is_advisory_pass;
                let json = serde_json::to_string_pretty(&response).unwrap_or_default();
                if is_pass {
                    Ok(CallToolResult::success(vec![ContentBlock::text(json)]).into())
                } else {
                    Ok(CallToolResult::error(vec![ContentBlock::text(json)]).into())
                }
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "sajimora_verify_behavior failed: {:#}",
                e
            ))])
            .into()),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Internal worker failure: {}",
                join_err
            ))])
            .into()),
        }
    }
}

/// Filters only presentation, preserving advisory assurance and unresolved counts.
/// This native engine has no per-finding BREAK_PROVED status; never relabel it.
fn format_mcp_report(serialized: &str, full: bool) -> String {
    if full {
        return serialized.to_string();
    }
    let report: serde_json::Value =
        serde_json::from_str(serialized).expect("serialized report JSON");
    let blockers = report["blockers"].as_array().map_or(0, Vec::len);
    let findings = if report["verdict"] == "LIKELY_VIOLATED" {
        report["findings"].clone()
    } else {
        serde_json::json!([])
    };
    let mut summary = serde_json::json!({
        "schemaVersion": report["schemaVersion"], "assurance": report["assurance"],
        "verdict": report["verdict"], "repository": report["repository"],
        "scope": report["scope"], "counts": report["counts"], "findings": findings,
        "delta": report.get("delta").cloned().unwrap_or(serde_json::Value::Null),
        "unresolvedBlockerCount": blockers, "detail": "summary",
        "notice": "Advisory findings, not scoped proofs. Omitted blockers are not compatibility; request detail=full for all details."
    });
    // Per-item reason codes stay in detail=full; the summary keeps the codes
    // and their counts so an INCONCLUSIVE verdict still names its causes.
    let mut reason_counts: std::collections::BTreeMap<&str, usize> =
        std::collections::BTreeMap::new();
    for record in report["reasonCodes"].as_array().into_iter().flatten() {
        if let Some(code) = record["code"].as_str() {
            *reason_counts.entry(code).or_default() += 1;
        }
    }
    if !reason_counts.is_empty() {
        summary["reasonCodeCounts"] = serde_json::json!(reason_counts);
    }
    summary.to_string()
}

#[cfg(test)]
mod summary_tests {
    use super::format_mcp_report;
    #[test]
    fn summary_preserves_unknown_and_full_is_exact() {
        let report = r#"{"schemaVersion":"test","assurance":"ADVISORY_ONLY","verdict":"INCONCLUSIVE","counts":{"unresolvedLinks":2},"findings":[],"blockers":[{"message":"unknown"}]}"#;
        let summary: serde_json::Value =
            serde_json::from_str(&format_mcp_report(report, false)).unwrap();
        assert_eq!(summary["verdict"], "INCONCLUSIVE");
        assert_eq!(summary["unresolvedBlockerCount"], 1);
        assert!(summary.get("blockers").is_none());
        assert_eq!(format_mcp_report(report, true), report);
    }

    #[test]
    fn summary_names_reason_codes_without_the_per_item_payload() {
        let report = serde_json::json!({
            "schemaVersion": "test",
            "assurance": "ADVISORY_ONLY",
            "verdict": "INCONCLUSIVE",
            "counts": {"unresolvedLinks": 3},
            "findings": [],
            "blockers": [],
            "reasonCodes": [
                {"code": "WIRE_SHAPE_UNRESOLVED", "detail": "a"},
                {"code": "UNRESOLVED_DEPENDENCY_IMPORT", "detail": "b"},
                {"code": "UNRESOLVED_DEPENDENCY_IMPORT", "detail": "c"}
            ]
        })
        .to_string();
        let summary: serde_json::Value =
            serde_json::from_str(&format_mcp_report(&report, false)).unwrap();
        assert_eq!(
            summary["reasonCodeCounts"]["UNRESOLVED_DEPENDENCY_IMPORT"],
            2
        );
        assert_eq!(summary["reasonCodeCounts"]["WIRE_SHAPE_UNRESOLVED"], 1);
        assert!(summary.get("reasonCodes").is_none());
        assert_eq!(format_mcp_report(&report, true), report);
    }
}
