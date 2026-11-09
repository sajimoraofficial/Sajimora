//! extract_frontend.rs — Native CLI bridge for frontend contract extraction.
//!
//! Uses high-performance native Tree-sitter + Rayon parallel TypeScript parsing
//! across all CPU cores with zero external runtime dependencies.

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ContractArtifactEnvelope, ExtractionProfile, FrontendContractPayload,
    ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::report::SCHEMA_VERSION;
use std::fs;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct ExtractFrontendArgs {
    /// Path to the git repository root.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Stable service identifier for this frontend client (e.g. "ui-ngx", "web-portal").
    #[arg(long)]
    pub service_id: Option<String>,

    /// Target backend service identifier (matches the backend contract serviceId).
    #[arg(long)]
    pub target_service_id: Option<String>,

    /// Subdirectory to filter TypeScript/JavaScript files (e.g. "src" or "frontend/src").
    #[arg(long)]
    pub ts_root: Option<PathBuf>,

    /// Parent commit SHA (defaults to "HEAD").
    #[arg(long, default_value = "HEAD")]
    pub parent: String,

    /// Output path for the generated contract artifact JSON.
    #[arg(long)]
    pub out: PathBuf,
}

pub fn run(args: ExtractFrontendArgs) -> i32 {
    match run_inner(args) {
        Ok(dest) => {
            eprintln!("Frontend contract written to {:?}", dest);
            0
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

pub fn run_inner(args: ExtractFrontendArgs) -> Result<PathBuf> {
    let repo_path = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo
    };

    let service_id = args
        .service_id
        .unwrap_or_else(|| "frontend-service".to_string());
    let target_service_id = args
        .target_service_id
        .unwrap_or_else(|| "backend-service".to_string());

    let scan_dir = if let Some(ref root) = args.ts_root {
        if root.is_relative() {
            repo_path.join(root)
        } else {
            root.clone()
        }
    } else {
        // Auto-detect frontend workspace if repo contains a dedicated client directory
        let ui_candidates = [
            "ui-ngx", "frontend", "client", "ui", "web", "app",
            "webapp", "portal", "dashboard", "admin", "client-app", "frontend-app", "web-app",
        ];
        let mut detected = None;
        for candidate in ui_candidates {
            let candidate_dir = repo_path.join(candidate);
            if candidate_dir.is_dir()
                && (candidate_dir.join("package.json").is_file()
                    || candidate_dir.join("tsconfig.json").is_file())
            {
                detected = Some(candidate_dir);
                break;
            }
        }
        detected.unwrap_or_else(|| repo_path.clone())
    };

    // An unreachable scan root yields zero calls rather than zero contracts, and the artifact
    // would then read as "this frontend makes no requests" with nothing to say why.
    for (label, dir) in [("Repository", &repo_path), ("Source root", &scan_dir)] {
        if !dir.is_dir() {
            return Err(anyhow!("{} directory does not exist: {:?}", label, dir));
        }
    }

    let envelope = if source_index::provider::has_java_source(&scan_dir) {
        if let Ok(java_extractor) =
            source_index::java_routes::JavaRouteExtractor::new(repo_path.clone(), &scan_dir)
        {
            if java_extractor.has_client_evidence() {
                eprintln!(
                    "Detected Java HTTP client evidence (declarative interfaces or imperative RestTemplate/WebClient/RestClient/OkHttp/java.net.http/Jersey calls); merging with TypeScript consumers"
                );
                let ts_extractor = source_index::ts_routes::TypeScriptRouteExtractor::new(
                    repo_path.clone(),
                    &scan_dir,
                )?;
                let (mut payload, ts_completeness) =
                    ts_extractor.extract_payload(&service_id, &target_service_id);
                let ts_contracts = payload.client_contracts.len();
                let java_config = java_extractor.config_fingerprint().to_string();
                let (java_payload, java_completeness) =
                    java_extractor.extract_client_payload(&service_id, &target_service_id);
                let java_contracts = java_payload.client_contracts.len();
                merge_frontend_payload(&mut payload, java_payload);
                let completeness = merge_completeness(ts_completeness, java_completeness);
                let (profile, fingerprint) = if java_contracts > 0 && ts_contracts == 0 {
                    ("JAVA_HTTP_CLIENT", Some(java_config))
                } else if java_contracts > 0 && ts_contracts > 0 {
                    (
                        "JAVA_AND_TYPESCRIPT",
                        Some("mixed:native-ts-fast".to_string()),
                    )
                } else {
                    ("STATIC_FETCH_V1", Some("native-ts-fast".to_string()))
                };
                build_merged_frontend_envelope(
                    payload,
                    completeness,
                    &service_id,
                    &args.parent,
                    profile,
                    fingerprint,
                )?
            } else {
                let extractor = source_index::ts_routes::TypeScriptRouteExtractor::new(
                    repo_path.clone(),
                    &scan_dir,
                )?;
                extractor.build_envelope(&service_id, &target_service_id, &args.parent)?
            }
        } else {
            let extractor = source_index::ts_routes::TypeScriptRouteExtractor::new(
                repo_path.clone(),
                &scan_dir,
            )?;
            extractor.build_envelope(&service_id, &target_service_id, &args.parent)?
        }
    } else {
        let extractor =
            source_index::ts_routes::TypeScriptRouteExtractor::new(repo_path.clone(), &scan_dir)?;
        extractor.build_envelope(&service_id, &target_service_id, &args.parent)?
    };
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&envelope)?;
    fs::write(&args.out, json)?;
    Ok(args.out)
}

fn merge_frontend_payload(into: &mut FrontendContractPayload, from: FrontendContractPayload) {
    into.client_contracts.extend(from.client_contracts);
    into.client_contracts.sort_by(|a, b| {
        a.target_service_id
            .cmp(&b.target_service_id)
            .then(a.normalized_route.cmp(&b.normalized_route))
            .then(a.http_method.cmp(&b.http_method))
            .then(a.source_file.cmp(&b.source_file))
            .then(a.source_line.cmp(&b.source_line))
    });

    if let Some(from_pool) = from.type_pool {
        let pool = into
            .type_pool
            .get_or_insert_with(std::collections::BTreeMap::new);
        for (name, wire) in from_pool {
            pool.entry(name).or_insert(wire);
        }
    }

    if let Some(from_paths) = from.path_pool {
        let paths = into.path_pool.get_or_insert_with(Vec::new);
        paths.extend(from_paths);
        paths.sort();
        paths.dedup();
    }
}

fn merge_completeness(
    mut left: ArtifactCompleteness,
    right: ArtifactCompleteness,
) -> ArtifactCompleteness {
    let complete = left.complete && right.complete;
    left.blockers.extend(right.blockers);
    left.blockers
        .sort_by(|a, b| (&a.file, &a.code, &a.message).cmp(&(&b.file, &b.code, &b.message)));
    left.blockers
        .dedup_by(|a, b| a.code == b.code && a.message == b.message && a.file == b.file);
    left.unresolved_endpoints.extend(right.unresolved_endpoints);
    left.unresolved_endpoints.sort();
    left.unresolved_endpoints.dedup();
    ArtifactCompleteness {
        complete: complete && left.blockers.is_empty() && left.unresolved_endpoints.is_empty(),
        unresolved_endpoints: left.unresolved_endpoints,
        blockers: left.blockers,
    }
}

fn build_merged_frontend_envelope(
    payload: FrontendContractPayload,
    completeness: ArtifactCompleteness,
    service_id: &str,
    revision: &str,
    client_profile: &str,
    config_fingerprint: Option<String>,
) -> Result<ContractArtifactEnvelope> {
    let envelope = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::FrontendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: format!("git-root:{service_id}"),
            service_id: service_id.to_string(),
            api_version: None,
            parent_commit: revision.to_string(),
            candidate_snapshot: revision.to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
            framework_profile: None,
            codec_profile: None,
            client_profile: Some(client_profile.to_string()),
            config_fingerprint,
        },
        completeness,
        signature: None,
        issued_at_unix: None,
        payload: ArtifactPayload::Frontend(payload),
        integrity: None,
        raw_value: None,
    };
    seal_envelope(envelope)
}
