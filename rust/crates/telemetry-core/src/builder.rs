//! builder.rs — Telemetry artifact builder.
//!
//! Assembles parsed coverage and span summaries into a sealed TelemetryArtifactEnvelope.

use crate::jacoco::parse_jacoco_xml;
use crate::otel::reduce_otel_spans;
use crate::types::{
    compute_telemetry_digest, TelemetryArtifactEnvelope, TelemetryIntegrity,
    TELEMETRY_ARTIFACT_VERSION_V1,
};
use anyhow::Result;
use std::collections::BTreeMap;
use std::io::BufRead;

pub struct TelemetryBuilder {
    service_id: String,
    api_version: Option<String>,
    created_at: Option<String>,
}

impl TelemetryBuilder {
    pub fn new(service_id: &str) -> Self {
        Self {
            service_id: service_id.to_string(),
            api_version: None,
            created_at: None,
        }
    }

    pub fn with_api_version(mut self, api_version: Option<&str>) -> Self {
        self.api_version = api_version.map(|v| v.to_string());
        self
    }

    pub fn with_timestamp(mut self, timestamp: &str) -> Self {
        self.created_at = Some(timestamp.to_string());
        self
    }

    pub fn build<R1: BufRead, R2: BufRead>(
        self,
        jacoco_reader: Option<R1>,
        otel_reader: Option<R2>,
    ) -> Result<TelemetryArtifactEnvelope> {
        let coverage = match jacoco_reader {
            Some(r) => parse_jacoco_xml(r)?,
            None => BTreeMap::new(),
        };

        let span_summaries = match otel_reader {
            Some(r) => reduce_otel_spans(r)?,
            None => Vec::new(),
        };

        let created_at = self.created_at.unwrap_or_else(|| {
            // ISO 8601 UTC timestamp or deterministic fallback
            "2026-10-19T00:00:00Z".to_string()
        });

        let mut envelope = TelemetryArtifactEnvelope {
            envelope_version: TELEMETRY_ARTIFACT_VERSION_V1.to_string(),
            service_id: self.service_id,
            api_version: self.api_version,
            created_at,
            coverage,
            span_summaries,
            integrity: None,
        };

        let digest = compute_telemetry_digest(&envelope)?;
        envelope.integrity = Some(TelemetryIntegrity { sha256: digest });

        Ok(envelope)
    }
}
