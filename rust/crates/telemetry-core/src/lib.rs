//! telemetry-core — Sajimora Native Telemetry Ingestion and Reduction.
//!
//! Provides deterministic streaming reduction of JaCoCo XML reports and OpenTelemetry traces.
//! Also provides zero-code production hit-count ingestion (SAJIMORA_HIT_TELEMETRY_V1)
//! with two-tier trust model (Advisory Local / Certified Production).

pub mod builder;
pub mod hits;
pub mod jacoco;
pub mod otel;
pub mod types;

pub use builder::TelemetryBuilder;
pub use hits::{ingest_hit_counts, HitIngestError};
pub use jacoco::parse_jacoco_xml;
pub use otel::reduce_otel_spans;
pub use types::{
    compute_telemetry_digest, verify_telemetry_integrity, EndpointTelemetrySummary, FileCoverage,
    HitCountEnvelope, ObservationWindow, RouteHitSummary, TelemetryArtifactEnvelope,
    TelemetryIntegrity, TelemetrySignature, TelemetryTrustLevel, TrafficTier, TrafficTierUntracked,
    HIT_TELEMETRY_SCHEMA_V1, TELEMETRY_ARTIFACT_VERSION_V1,
};
