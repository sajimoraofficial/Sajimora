//! otel.rs — OpenTelemetry span reducer.
//!
//! Ingests OpenTelemetry trace JSON or NDJSON spans, extracting:
//! - http.route / http.target
//! - http.request.method / http.method
//! - http.response.status_code / http.status_code
//!
//! Produces deterministic observation counts and status code frequencies without
//! non-deterministic p99 or quantile estimators.

use crate::types::EndpointTelemetrySummary;
use anyhow::Result;
use contract_core::routes::normalize_route_segments;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::BufRead;

pub fn reduce_otel_spans<R: BufRead>(mut reader: R) -> Result<Vec<EndpointTelemetrySummary>> {
    let mut aggregates: BTreeMap<(String, String), (u64, BTreeMap<u16, u64>)> = BTreeMap::new();

    let mut content = String::new();
    reader.read_to_string(&mut content)?;

    if let Ok(val) = serde_json::from_str::<Value>(&content) {
        process_json_node(&val, &mut aggregates);
    } else {
        // Fallback to NDJSON
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                process_json_node(&val, &mut aggregates);
            }
        }
    }

    let mut summaries = Vec::with_capacity(aggregates.len());
    for ((http_method, normalized_route), (count, status_codes)) in aggregates {
        summaries.push(EndpointTelemetrySummary {
            http_method,
            normalized_route,
            observation_count: count,
            status_codes,
        });
    }

    Ok(summaries)
}

fn process_json_node(
    val: &Value,
    aggregates: &mut BTreeMap<(String, String), (u64, BTreeMap<u16, u64>)>,
) {
    if let Some(arr) = val.as_array() {
        for item in arr {
            process_json_node(item, aggregates);
        }
    } else if let Some(obj) = val.as_object() {
        // If this is a standard OTLP resourceSpans container
        if let Some(resource_spans) = obj.get("resourceSpans").and_then(|v| v.as_array()) {
            for rs in resource_spans {
                if let Some(scope_spans) = rs.get("scopeSpans").and_then(|v| v.as_array()) {
                    for ss in scope_spans {
                        if let Some(spans) = ss.get("spans").and_then(|v| v.as_array()) {
                            for span in spans {
                                process_span(span, aggregates);
                            }
                        }
                    }
                }
            }
        } else if obj.contains_key("attributes") || obj.contains_key("name") {
            // Direct Span object
            process_span(val, aggregates);
        }
    }
}

fn process_span(
    span: &Value,
    aggregates: &mut BTreeMap<(String, String), (u64, BTreeMap<u16, u64>)>,
) {
    let mut http_method = None;
    let mut http_route = None;
    let mut status_code: u16 = 200;

    // 1. Inspect attributes (either array of {key, value} or JSON object)
    if let Some(attrs_val) = span.get("attributes") {
        if let Some(arr) = attrs_val.as_array() {
            for attr in arr {
                let key = attr.get("key").and_then(|k| k.as_str()).unwrap_or("");
                let val_str = extract_attr_value(attr.get("value"));
                match key {
                    "http.method" | "http.request.method" => http_method = val_str,
                    "http.route" | "http.target" | "url.path" => http_route = val_str,
                    "http.status_code" | "http.response.status_code" => {
                        if let Some(code_val) = extract_attr_int(attr.get("value")) {
                            status_code = code_val as u16;
                        }
                    }
                    _ => {}
                }
            }
        } else if let Some(map) = attrs_val.as_object() {
            for (k, v) in map {
                match k.as_str() {
                    "http.method" | "http.request.method" => {
                        http_method = v.as_str().map(|s| s.to_string());
                    }
                    "http.route" | "http.target" | "url.path" => {
                        http_route = v.as_str().map(|s| s.to_string());
                    }
                    "http.status_code" | "http.response.status_code" => {
                        if let Some(num) = v.as_u64() {
                            status_code = num as u16;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if let (Some(method), Some(route)) = (http_method, http_route) {
        let norm_route = normalize_route_segments(&route).raw_path;
        let entry = aggregates
            .entry((method.to_uppercase(), norm_route))
            .or_insert_with(|| (0, BTreeMap::new()));
        entry.0 += 1;
        *entry.1.entry(status_code).or_insert(0) += 1;
    }
}

fn extract_attr_value(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("stringValue").and_then(|s| s.as_str()) {
        return Some(s.to_string());
    }
    None
}

fn extract_attr_int(val: Option<&Value>) -> Option<u64> {
    let v = val?;
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(n) = v.get("intValue").and_then(|s| {
        if let Some(num) = s.as_u64() {
            Some(num)
        } else if let Some(str_val) = s.as_str() {
            str_val.parse::<u64>().ok()
        } else {
            None
        }
    }) {
        return Some(n);
    }
    None
}
