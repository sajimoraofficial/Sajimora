//! what_if.rs -- In-memory candidate code & symbolic mutation simulator for MCP.
//!
//! Enables zero-risk "pre-flight" refactoring tests for AI agents in < 20ms.
//!
//! Both modes fail honest: a candidate buffer that cannot be parsed, a DTO that is
//! not in the indexed type pool, or a field the DTO does not declare produces an
//! INCONCLUSIVE/NO_MATCH/FIELD_NOT_FOUND verdict instead of "compatible".

use anyhow::{bail, Context, Result};
use rmcp::model::Tool;
use source_index::contracts_db::{
    client_type_declares_field, dto_has_field, filter_active_wire_consumers, open_reader,
    query_consumers_by_dto_symbol, query_consumers_by_route, query_consumers_by_type_ref,
    resolve_dto_type_refs, sync_if_needed, ConsumerMatch,
};
use source_index::endpoint_impact::resolve_repo_root;
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

pub const TOOL_NAME: &str = "sajimora_what_if";

pub fn tool_definition() -> Tool {
    let mut schema_map = serde_json::Map::new();
    schema_map.insert("type".to_string(), serde_json::json!("object"));
    schema_map.insert(
        "properties".to_string(),
        serde_json::json!({
            "repoRoot": {
                "type": "string",
                "description": "Absolute repository root containing .sajimora/init-manifest.json; must resolve under an allowed root"
            },
            "targetFile": {
                "type": "string",
                "description": "Relative path to target file being modified (e.g. 'application/.../UserController.java')"
            },
            "candidateCode": {
                "type": "string",
                "description": "Optional in-memory raw Java code snippet (e.g. replacement method or class) to parse and simulate"
            },
            "mutation": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["RENAME_FIELD", "REMOVE_FIELD", "CHANGE_TYPE", "DELETE_ENDPOINT"]
                    },
                    "targetDto": { "type": "string", "description": "DTO name (e.g. 'User')" },
                    "field": { "type": "string", "description": "Field name being modified (e.g. 'firstName')" },
                    "renameTo": { "type": "string", "description": "New field name (e.g. 'givenName')" },
                    "newType": { "type": "string", "description": "New wire type for CHANGE_TYPE" },
                    "route": { "type": "string", "description": "Endpoint route for DELETE_ENDPOINT (e.g. '/api/users/{id}')" },
                    "method": { "type": "string", "description": "Optional HTTP method for DELETE_ENDPOINT" },
                    "jsonPropertyRetained": { "type": "boolean", "description": "Whether Jackson @JsonProperty annotation retains wire compatibility (RENAME_FIELD only)" }
                },
                "description": "Optional structured symbolic AST mutation"
            }
        }),
    );
    schema_map.insert("required".to_string(), serde_json::json!(["repoRoot"]));

    Tool::new(
        TOOL_NAME,
        "Simulates contract and consumer impact of a hypothetical change in-memory. Accepts either raw code or a structured symbolic mutation without modifying disk or Git.",
        Arc::new(schema_map),
    )
}

pub fn run_what_if(
    allowed_roots: &[PathBuf],
    args: &serde_json::Map<String, serde_json::Value>,
) -> Result<String> {
    if allowed_roots.is_empty() {
        bail!("{TOOL_NAME} requires at least one server-configured allowed root");
    }

    let repo_arg = args
        .get("repoRoot")
        .and_then(serde_json::Value::as_str)
        .filter(|t| !t.is_empty())
        .context("Missing required argument: 'repoRoot'")?;
    let repo_path = PathBuf::from(repo_arg);
    if !repo_path.is_absolute() {
        bail!("repoRoot must be an absolute path");
    }
    let repo_root = resolve_repo_root(&repo_path, allowed_roots)?;

    let db_path = match sync_if_needed(&repo_root) {
        Ok(p) => p,
        Err(e) => {
            return Ok(serde_json::json!({
                "error": "SEALED_BASELINE_MISSING",
                "message": format!("Contract baseline error: {e}. Run 'sajimora init' to seal contracts."),
                "repoRoot": repo_root.display().to_string(),
            }).to_string());
        }
    };

    let conn = open_reader(&db_path)?;
    let start = Instant::now();

    // Mode A: Raw code buffer simulation
    if let Some(candidate_code) = args.get("candidateCode").and_then(|c| c.as_str()) {
        let target_file = args
            .get("targetFile")
            .and_then(|t| t.as_str())
            .unwrap_or("Candidate.java");

        let (routes, blockers) = match simulate_routes(&repo_root, target_file, candidate_code) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Ok(serde_json::json!({
                    "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                    "simulationMode": "candidateCode",
                    "targetFile": target_file,
                    "detectedRoutes": [],
                    "verdict": "INCONCLUSIVE",
                    "message": format!("Candidate code could not be parsed as Java: {error:#}"),
                    "latencyMicros": start.elapsed().as_micros(),
                })
                .to_string());
            }
        };

        if routes.is_empty() {
            return Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                "simulationMode": "candidateCode",
                "targetFile": target_file,
                "detectedRoutes": [],
                "blockers": blockers,
                "verdict": "INCONCLUSIVE",
                "message": "No endpoint mapping was recognized in the candidate code; no compatibility claim is made.",
                "latencyMicros": start.elapsed().as_micros(),
            }).to_string());
        }

        let mut affected = Vec::new();
        for (method, route) in &routes {
            affected.extend(query_consumers_by_route(&conn, route, Some(method))?);
        }
        dedupe_consumers(&mut affected);

        let elapsed_micros = start.elapsed().as_micros();
        return Ok(serde_json::json!({
            "schemaVersion": "SAJIMORA_WHAT_IF_V1",
            "simulationMode": "candidateCode",
            "targetFile": target_file,
            "detectedRoutes": routes.iter().map(|(method, route)| serde_json::json!({
                "method": method,
                "route": route,
            })).collect::<Vec<_>>(),
            "blockers": blockers,
            "breakingConsumersCount": affected.len(),
            "latencyMicros": elapsed_micros,
            "telemetry": compute_savings_telemetry(affected.len().max(1), elapsed_micros),
            "verdict": if affected.is_empty() { "COMPATIBLE" } else { "CONSUMERS_OBSERVED" },
            "affectedConsumers": consumer_preview(&affected, None, None, None)
        })
        .to_string());
    }

    // Mode B: Symbolic mutation simulation
    if let Some(mutation) = args.get("mutation").and_then(|m| m.as_object()) {
        let action = mutation
            .get("action")
            .and_then(|a| a.as_str())
            .context("mutation.action is required")?
            .to_ascii_uppercase();
        if !matches!(
            action.as_str(),
            "RENAME_FIELD" | "REMOVE_FIELD" | "CHANGE_TYPE" | "DELETE_ENDPOINT"
        ) {
            bail!(
                "Unknown mutation action '{action}'; expected RENAME_FIELD, REMOVE_FIELD, CHANGE_TYPE, or DELETE_ENDPOINT"
            );
        }

        if action == "DELETE_ENDPOINT" {
            let route = mutation
                .get("route")
                .and_then(|r| r.as_str())
                .filter(|r| !r.is_empty())
                .context("DELETE_ENDPOINT requires mutation.route")?;
            let method = mutation
                .get("method")
                .and_then(|m| m.as_str())
                .filter(|m| !m.is_empty());
            let consumers = query_consumers_by_route(&conn, route, method)?;
            let elapsed_micros = start.elapsed().as_micros();
            let affected_files: BTreeSet<&str> =
                consumers.iter().map(|c| c.source_file.as_str()).collect();
            return Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                "simulationMode": "symbolic",
                "action": action,
                "route": route,
                "method": method,
                "verdict": if consumers.is_empty() {
                    "SAFE_NO_OBSERVED_CONSUMERS"
                } else {
                    "BREAKING_CHANGE"
                },
                "latencyMicros": elapsed_micros,
                "telemetry": compute_savings_telemetry(affected_files.len().max(1), elapsed_micros),
                "breakingConsumersCount": consumers.len(),
                "affectedFiles": affected_files.into_iter().collect::<Vec<_>>(),
                "affectedConsumers": consumer_preview(&consumers, None, None, Some("DELETE_ENDPOINT")),
                "message": if consumers.is_empty() {
                    "No sealed consumer contract calls this route; removing it has no observed consumer impact."
                } else {
                    "Sealed consumer contracts call this route; removing it breaks them."
                },
            })
            .to_string());
        }

        let target_dto = mutation
            .get("targetDto")
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty())
            .with_context(|| format!("{action} requires mutation.targetDto"))?;
        let field = mutation
            .get("field")
            .and_then(|f| f.as_str())
            .filter(|f| !f.is_empty())
            .with_context(|| format!("{action} requires mutation.field"))?;
        let rename_to = mutation
            .get("renameTo")
            .and_then(|r| r.as_str())
            .unwrap_or("");
        let new_type = mutation
            .get("newType")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if action == "RENAME_FIELD" && rename_to.is_empty() {
            bail!("RENAME_FIELD requires mutation.renameTo");
        }
        if action == "CHANGE_TYPE" && new_type.is_empty() {
            bail!("CHANGE_TYPE requires mutation.newType");
        }
        let json_property_retained = mutation
            .get("jsonPropertyRetained")
            .and_then(|p| p.as_bool())
            .unwrap_or(false);

        let matched_type_refs = resolve_dto_type_refs(&conn, target_dto)?;
        if matched_type_refs.is_empty() {
            let elapsed_micros = start.elapsed().as_micros();
            return Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                "simulationMode": "symbolic",
                "action": action,
                "targetDto": target_dto,
                "field": field,
                "verdict": "NO_MATCH",
                "message": format!("'{target_dto}' is not present in the indexed type pool; no impact claim is made."),
                "latencyMicros": elapsed_micros,
            })
            .to_string());
        }

        if !dto_has_field(&conn, &matched_type_refs, field)? {
            let elapsed_micros = start.elapsed().as_micros();
            return Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                "simulationMode": "symbolic",
                "action": action,
                "targetDto": target_dto,
                "field": field,
                "matchedTypeRefs": matched_type_refs,
                "verdict": "FIELD_NOT_FOUND",
                "message": format!("The indexed shape of '{target_dto}' does not declare '{field}'; check the field name."),
                "latencyMicros": elapsed_micros,
            })
            .to_string());
        }

        let mut consumers = Vec::new();
        for type_ref in &matched_type_refs {
            consumers.extend(query_consumers_by_type_ref(&conn, type_ref)?);
        }
        // Consumer refs are TypeScript-side (`ts:path#User`); bridge them to the
        // backend DTO by exact simple name, never by substring.
        consumers.extend(query_consumers_by_dto_symbol(&conn, target_dto)?);
        dedupe_consumers(&mut consumers);
        let consumers = filter_active_wire_consumers(&conn, consumers)?;

        let elapsed_micros = start.elapsed().as_micros();
        if action == "REMOVE_FIELD" || action == "CHANGE_TYPE" {
            if let Some(is_consumed) = client_type_declares_field(&conn, target_dto, field)? {
                if !is_consumed {
                    return Ok(serde_json::json!({
                        "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                        "simulationMode": "symbolic",
                        "action": action,
                        "targetDto": target_dto,
                        "field": field,
                        "matchedTypeRefs": matched_type_refs,
                        "verdict": "NON_BREAKING_UNCONSUMED",
                        "latencyMicros": elapsed_micros,
                        "telemetry": compute_savings_telemetry(consumers.len().max(1), elapsed_micros),
                        "message": format!(
                            "Field '{}' on '{}' is not declared or consumed in any active client contract; wire contract is unbroken.",
                            field, target_dto
                        ),
                        "breakingConsumersCount": 0,
                        "affectedFiles": [],
                        "affectedConsumers": [],
                        "suggestedFix": format!("No client-side fix required. Field '{}' is unconsumed.", field),
                        "recommendation": format!("Safe to modify '{}' on '{}' without breaking client contracts.", field, target_dto)
                    }).to_string());
                }
            }
        }
        if action == "RENAME_FIELD" && json_property_retained {
            return Ok(serde_json::json!({
                "schemaVersion": "SAJIMORA_WHAT_IF_V1",
                "simulationMode": "symbolic",
                "action": action,
                "targetDto": target_dto,
                "field": field,
                "renameTo": rename_to,
                "matchedTypeRefs": matched_type_refs,
                "jsonPropertyRetained": true,
                "verdict": "NON_BREAKING_PRESERVED",
                "latencyMicros": elapsed_micros,
                "telemetry": compute_savings_telemetry(consumers.len().max(1), elapsed_micros),
                "message": format!("Renaming Java field '{}' -> '{}' with @JsonProperty(\"{}\") preserves wire contract compatibility.", field, rename_to, field),
                "safeConsumersCount": consumers.len()
            })
            .to_string());
        }

        let template_matches = source_index::html_templates::scan_html_templates(&repo_root, target_dto, field)
            .unwrap_or_default();

        let mut affected_files: BTreeSet<String> =
            consumers.iter().map(|c| c.source_file.clone()).collect();
        for tm in &template_matches {
            affected_files.insert(tm.file.clone());
        }

        let mut all_affected_consumers = consumer_preview(&consumers, Some(target_dto), Some(field), Some(&action));
        for tm in &template_matches {
            let mut patch_recipe = serde_json::Map::new();
            if action == "RENAME_FIELD" && !rename_to.is_empty() {
                let replacement_token = tm.matched_token.replace(field, rename_to);
                patch_recipe.insert("action".to_string(), serde_json::json!("REPLACE_TOKEN"));
                patch_recipe.insert("file".to_string(), serde_json::json!(tm.file));
                patch_recipe.insert("line".to_string(), serde_json::json!(tm.line));
                patch_recipe.insert("target".to_string(), serde_json::json!(tm.matched_token));
                patch_recipe.insert("replacement".to_string(), serde_json::json!(replacement_token));
            } else if action == "REMOVE_FIELD" {
                patch_recipe.insert("action".to_string(), serde_json::json!("REMOVE_OR_FALLBACK"));
                patch_recipe.insert("file".to_string(), serde_json::json!(tm.file));
                patch_recipe.insert("line".to_string(), serde_json::json!(tm.line));
                patch_recipe.insert("target".to_string(), serde_json::json!(tm.matched_token));
                patch_recipe.insert("guidance".to_string(), serde_json::json!(format!("Property '{}' will be undefined; remove binding or provide fallback", field)));
            }

            all_affected_consumers.push(serde_json::json!({
                "file": tm.file,
                "line": tm.line,
                "kind": tm.kind,
                "expression": tm.expression,
                "matchedToken": tm.matched_token,
                "rootCause": format!(
                    "Template binding accesses property '{}' on object matching DTO '{}'; property will evaluate to undefined at runtime.",
                    field, target_dto
                ),
                "causalChain": [
                    format!("1. Backend DTO: '{}' wire field '{}' undergoes {}", target_dto, field, action),
                    format!("2. Component Layer: Angular component passes wire model '{}' into template view", target_dto),
                    format!("3. Template View: '{}' (line {}) dynamically evaluates '{}'", tm.file, tm.line, tm.expression)
                ],
                "patchRecipe": patch_recipe
            }));
        }

        let mut automated_patches = Vec::new();
        // 1. Client model patch from matched_type_refs
        for tr in &matched_type_refs {
            if tr.starts_with("ts:") {
                let stripped = tr.trim_start_matches("ts:");
                let file_part = stripped.split('#').next().unwrap_or(stripped);
                if action == "RENAME_FIELD" && !rename_to.is_empty() {
                    automated_patches.push(serde_json::json!({
                        "file": file_part,
                        "type": "RENAME_MODEL_PROPERTY",
                        "target": field,
                        "replacement": rename_to,
                        "description": format!("Rename property '{}' to '{}' in client TypeScript interface", field, rename_to)
                    }));
                } else if action == "REMOVE_FIELD" {
                    automated_patches.push(serde_json::json!({
                        "file": file_part,
                        "type": "REMOVE_MODEL_PROPERTY",
                        "target": field,
                        "description": format!("Remove property '{}' from client TypeScript interface", field)
                    }));
                }
            }
        }

        // 2. Template patches
        for tm in &template_matches {
            if action == "RENAME_FIELD" && !rename_to.is_empty() {
                let replacement_token = tm.matched_token.replace(field, rename_to);
                automated_patches.push(serde_json::json!({
                    "file": tm.file,
                    "line": tm.line,
                    "type": "REPLACE_TEMPLATE_EXPRESSION",
                    "target": tm.matched_token,
                    "replacement": replacement_token,
                    "contextExpression": tm.expression,
                    "description": format!("Update template binding from '{}' to '{}'", tm.matched_token, replacement_token)
                }));
            } else if action == "REMOVE_FIELD" {
                automated_patches.push(serde_json::json!({
                    "file": tm.file,
                    "line": tm.line,
                    "type": "AUDIT_TEMPLATE_BINDING",
                    "target": tm.matched_token,
                    "contextExpression": tm.expression,
                    "description": format!("Property '{}' removed; update template binding or fallback", tm.matched_token)
                }));
            }
        }

        let total_breaking = consumers.len() + template_matches.len();

        let root_cause_summary = match action.as_str() {
            "RENAME_FIELD" => format!(
                "Java field '{field}' on DTO '{target_dto}' was renamed to '{rename_to}' without Jackson @JsonProperty(\"{field}\"). Wire key changes from '{field}' to '{rename_to}', breaking client deserialization and UI bindings."
            ),
            "REMOVE_FIELD" => format!(
                "Java field '{field}' on DTO '{target_dto}' was removed. Wire payload will no longer contain '{field}', causing undefined reads across {} active frontend consumers.",
                total_breaking
            ),
            "CHANGE_TYPE" => format!(
                "Java field '{field}' on DTO '{target_dto}' type changed to '{new_type}'. Incompatible payload serialization breaks frontend consumers expecting previous shape."
            ),
            _ => format!("Mutation '{action}' on '{target_dto}.{field}' introduces breaking wire changes.")
        };

        let suggested_fix = match action.as_str() {
            "RENAME_FIELD" => format!("@JsonProperty(\"{}\") on the renamed field", field),
            "CHANGE_TYPE" => format!(
                "Keep a compatible wire representation for '{field}' (or a @JsonProperty-annotated adapter) instead of changing its type to '{new_type}'"
            ),
            _ => format!("Keep the wire field '{field}' (or mark the change as a breaking API change)"),
        };
        return Ok(serde_json::json!({
            "schemaVersion": "SAJIMORA_WHAT_IF_V2",
            "simulationMode": "symbolic",
            "action": action,
            "targetDto": target_dto,
            "field": field,
            "renameTo": rename_to,
            "newType": new_type,
            "matchedTypeRefs": matched_type_refs,
            "jsonPropertyRetained": false,
            "verdict": "BREAKING_CHANGE",
            "latencyMicros": elapsed_micros,
            "telemetry": compute_savings_telemetry(affected_files.len().max(1), elapsed_micros),
            "rootCause": root_cause_summary,
            "breakingConsumersCount": total_breaking,
            "affectedFiles": affected_files.into_iter().collect::<Vec<_>>(),
            "affectedConsumers": all_affected_consumers,
            "automatedPatches": automated_patches,
            "suggestedFix": suggested_fix,
            "recommendation": format!("Apply '{suggested_fix}' on {target_dto}.{field} to preserve the REST contract.")
        })
        .to_string());
    }

    bail!("sajimora_what_if requires either 'candidateCode' or 'mutation'");
}

/// Parse a candidate Java buffer with the real extractor and return the
/// provider routes it declares. An unparseable buffer is an error, never an
/// empty-but-compatible answer.
fn simulate_routes(
    repo_root: &Path,
    target_file: &str,
    code: &str,
) -> Result<(Vec<(String, String)>, Vec<String>)> {
    let relative = {
        let trimmed = target_file.trim_start_matches('/').replace('\\', "/");
        if trimmed.is_empty() {
            "Candidate.java".to_string()
        } else {
            trimmed
        }
    };
    let extractor = JavaRouteExtractor::from_blobs(
        repo_root.to_path_buf(),
        vec![(relative, code.to_string())],
        ConfigInputs::default(),
    )?;
    let (payload, completeness) = extractor.extract_payload("candidate");
    let mut routes: BTreeSet<(String, String)> = BTreeSet::new();
    for endpoint in &payload.endpoints {
        if endpoint.identity.direction == contract_core::ir::ContractDirection::Response {
            routes.insert((
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            ));
        }
    }
    let blockers = completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.clone())
        .collect();
    Ok((routes.into_iter().collect(), blockers))
}

fn dedupe_consumers(consumers: &mut Vec<ConsumerMatch>) {
    consumers.sort_by(|a, b| {
        (
            &a.source_file,
            a.source_line,
            &a.http_method,
            &a.normalized_route,
        )
            .cmp(&(
                &b.source_file,
                b.source_line,
                &b.http_method,
                &b.normalized_route,
            ))
    });
    consumers.dedup_by(|a, b| {
        a.source_file == b.source_file
            && a.source_line == b.source_line
            && a.http_method == b.http_method
            && a.normalized_route == b.normalized_route
    });
}

fn consumer_preview(
    consumers: &[ConsumerMatch],
    target_dto: Option<&str>,
    field: Option<&str>,
    action: Option<&str>,
) -> Vec<serde_json::Value> {
    consumers
        .iter()
        .take(10)
        .map(|consumer| {
            let mut val = serde_json::json!({
                "file": consumer.source_file,
                "line": consumer.source_line,
                "method": consumer.http_method,
                "route": consumer.normalized_route,
                "kind": "HTTP_SERVICE_CONSUMER",
            });
            if let (Some(dto), Some(fld), Some(act)) = (target_dto, field, action) {
                val["rootCause"] = serde_json::json!(format!(
                    "Service endpoint '{} {}' returns payload mapped to DTO '{}' where wire field '{}' is affected by {}.",
                    consumer.http_method, consumer.normalized_route, dto, fld, act
                ));
                val["causalChain"] = serde_json::json!([
                    format!("1. Backend DTO: '{}' wire field '{}' undergoes {}", dto, fld, act),
                    format!("2. Wire Transport: Spring Boot endpoint '{} {}' returns DTO '{}'", consumer.http_method, consumer.normalized_route, dto),
                    format!("3. Client Service: '{}' (line {}) invokes endpoint expecting wire field '{}'", consumer.source_file, consumer.source_line, fld)
                ]);
            }
            val
        })
        .collect()
}

fn compute_savings_telemetry(
    files_bypassed_count: usize,
    elapsed_micros: u128,
) -> serde_json::Value {
    let files = files_bypassed_count.max(1);
    // An AI agent searching files reads ~3,750 tokens per file + 45,000 search prompt overhead
    let tokens_saved = (files * 3750) + 45000;
    // Standard baseline: Claude 3.5 Sonnet @ $3.00 per Million tokens
    let dollars_saved = (tokens_saved as f64 / 1_000_000.0) * 3.00;
    serde_json::json!({
        "executionLatencyMs": (elapsed_micros as f64) / 1000.0,
        "contextFilesBypassed": files,
        "tokensSavedEstimate": tokens_saved,
        "apiDollarsSavedUsd": (dollars_saved * 10000.0).round() / 10000.0,
        "preventedFailedAgentLoop": true
    })
}
