//! extract_backend.rs — Native Rust backend contract extractor CLI command.
//!
//! Extracts Spring MVC / Java routes and DTOs, or NestJS / TypeScript
//! controllers and DTOs, into a canonical V2 contract artifact.

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::envelope::{
    compute_envelope_digest, ArtifactBlocker, ArtifactCompleteness, ArtifactIntegrity,
    ArtifactKind, ArtifactPayload, ArtifactSnapshotRef, BackendContractPayload,
    ContractArtifactEnvelope, ExtractionProfile, ARTIFACT_ENVELOPE_VERSION_V2,
};
use contract_core::report::SCHEMA_VERSION;
use source_index::express_routes::ExpressRouteExtractor;
use source_index::java_routes::JavaRouteExtractor;
use source_index::nestjs_routes::NestJsRouteExtractor;
use source_index::nextjs_routes::NextJsRouteExtractor;
use source_index::provider::{detect_unsupported_ts_framework, has_java_source, ProviderKind};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn build_unsupported_ts_envelope(
    service_id: &str,
    api_version: Option<&str>,
    candidate_snapshot: &str,
    framework: &str,
    file_path: &str,
) -> Result<ContractArtifactEnvelope> {
    let blocker = ArtifactBlocker {
        code: "TS_MAPPING_FRAMEWORK_UNPARSED".to_string(),
        message: format!(
            "Repository declares {framework} backend routes (detected in {file_path}). This framework is not extracted into route contracts; emptiness is not evidence of absence."
        ),
        file: Some(file_path.to_string()),
    };
    let completeness = ArtifactCompleteness {
        complete: false,
        unresolved_endpoints: Vec::new(),
        blockers: vec![blocker],
    };
    let payload = BackendContractPayload {
        serialization_assumptions: None,
        base_urls: vec![],
        proxy_prefixes: vec![],
        endpoints: vec![],
        type_pool: None,
        path_pool: None,
    };
    let mut env = ContractArtifactEnvelope {
        envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
        report_schema_version: SCHEMA_VERSION.to_string(),
        kind: ArtifactKind::BackendContract,
        snapshot: ArtifactSnapshotRef {
            repository_id: "git-root:native".to_string(),
            service_id: service_id.to_string(),
            api_version: api_version.map(|v| v.to_string()),
            parent_commit: "HEAD".to_string(),
            candidate_snapshot: candidate_snapshot.to_string(),
            deployment_id: None,
            environment: None,
        },
        profile: ExtractionProfile {
            tool_version: "0.1.0".to_string(),
            framework_profile: Some(framework.to_ascii_uppercase().replace('.', "")),
            codec_profile: Some("JSON_STRINGIFY_V1".to_string()),
            client_profile: None,
            config_fingerprint: None,
        },
        completeness,
        payload: ArtifactPayload::Backend(payload),
        integrity: None,
        signature: None,
        issued_at_unix: None,
        raw_value: None,
    };
    let digest = compute_envelope_digest(&env)
        .map_err(|e| anyhow!("Failed to compute envelope digest: {}", e))?;
    env.integrity = Some(ArtifactIntegrity { sha256: digest });
    Ok(env)
}

/// Build the backend contract envelope from an already-resolved provider source
/// root.
///
/// `init` and `verify` call this so every entry point applies the same provider
/// dispatch and produces the same artifact as `extract-backend`. The source root
/// is resolved by the caller because each entry point knows a different thing:
/// the CLI takes `--java-root`/`--ts-root`, `init` reads the detected backend
/// path from its plan.
pub fn build_backend_envelope(
    repo_root: &Path,
    source_root: &Path,
    provider: ProviderKind,
    service_id: &str,
    api_version: Option<&str>,
    candidate_snapshot: &str,
) -> Result<ContractArtifactEnvelope> {
    match provider {
        ProviderKind::Spring => {
            if !has_java_source(source_root) && !has_java_source(repo_root) {
                if let Some((fw, file_path)) = detect_unsupported_ts_framework(source_root)
                    .or_else(|| detect_unsupported_ts_framework(repo_root))
                {
                    return build_unsupported_ts_envelope(
                        service_id,
                        api_version,
                        candidate_snapshot,
                        fw,
                        &file_path,
                    );
                }
            }
            let extractor = JavaRouteExtractor::new(repo_root.to_path_buf(), source_root)
                .map_err(|e| anyhow!("Failed to initialize Java route extractor: {}", e))?;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
        ProviderKind::JaxRs => {
            let mut extractor = JavaRouteExtractor::new(repo_root.to_path_buf(), source_root)
                .map_err(|e| anyhow!("Failed to initialize JAX-RS route extractor: {}", e))?;
            extractor.enable_jax_rs = true;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
        ProviderKind::NestJs => {
            let extractor = NestJsRouteExtractor::new(repo_root.to_path_buf(), source_root)
                .map_err(|e| anyhow!("Failed to initialize NestJS route extractor: {}", e))?;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
        ProviderKind::NextJs => {
            let extractor = NextJsRouteExtractor::new(repo_root.to_path_buf(), source_root)
                .map_err(|e| anyhow!("Failed to initialize Next.js route extractor: {}", e))?;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
        ProviderKind::FileRouter => {
            let extractor = source_index::file_system_routes::FileSystemRouteExtractor::new(
                repo_root.to_path_buf(),
                source_root,
            )
            .map_err(|e| anyhow!("Failed to initialize file-system route extractor: {}", e))?;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
        ProviderKind::Express => {
            let extractor = ExpressRouteExtractor::new(repo_root.to_path_buf(), source_root)
                .map_err(|e| anyhow!("Failed to initialize Express route extractor: {}", e))?;
            extractor
                .build_envelope(service_id, api_version, candidate_snapshot)
                .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))
        }
    }
}

#[derive(Args, Debug)]
pub struct ExtractBackendArgs {
    /// Path to the repository root.
    #[arg(long)]
    pub repo: PathBuf,

    /// Output path for the generated contract artifact JSON.
    #[arg(long)]
    pub out: PathBuf,

    /// Service identifier for the contract (defaults to directory name).
    #[arg(long)]
    pub service_id: Option<String>,

    /// API version string (e.g. "v1").
    #[arg(long)]
    pub api_version: Option<String>,

    /// Subdirectory containing Java sources (defaults to src/main/java or repo root).
    #[arg(long)]
    pub java_root: Option<PathBuf>,

    /// Backend provider lane: auto, spring, or nestjs (default auto-detect).
    #[arg(long, default_value = "auto")]
    pub provider: String,

    /// Subdirectory containing TypeScript sources for the nestjs provider
    /// (defaults to src or the repo root).
    #[arg(long)]
    pub ts_root: Option<PathBuf>,

    /// Candidate snapshot identifier (defaults to "HEAD").
    #[arg(long, default_value = "HEAD")]
    pub candidate_snapshot: String,
}

pub fn run(args: ExtractBackendArgs) -> i32 {
    match run_inner(args) {
        Ok(dest) => {
            eprintln!("Contract written to {:?}", dest);
            0
        }
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn run_inner(args: ExtractBackendArgs) -> Result<PathBuf> {
    let repo_root = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo
    };

    if !repo_root.exists() {
        return Err(anyhow!(
            "Repository directory does not exist: {:?}",
            repo_root
        ));
    }

    // A monorepo may contain several server frameworks. Detection must inspect the
    // directory that extraction is scoped to; reading the repository root would let a
    // sibling package's framework select the lane and then extract zero routes here.
    let detection_root = match args.ts_root.as_ref() {
        Some(root) if root.is_relative() => repo_root.join(root),
        Some(root) => root.clone(),
        None => repo_root.clone(),
    };
    let detection_root = if detection_root.is_dir() {
        detection_root
    } else {
        repo_root.clone()
    };

    let (provider, unsupported_ts) = if args.provider.eq_ignore_ascii_case("auto") {
        if !has_java_source(&detection_root) {
            let detected = ProviderKind::detect_on_disk(&detection_root);
            if matches!(
                detected,
                ProviderKind::NextJs
                    | ProviderKind::NestJs
                    | ProviderKind::Express
                    | ProviderKind::FileRouter
            ) {
                (detected, None)
            } else if let Some((fw, file)) = detect_unsupported_ts_framework(&detection_root) {
                (ProviderKind::Spring, Some((fw, file)))
            } else {
                (detected, None)
            }
        } else {
            (ProviderKind::detect_on_disk(&detection_root), None)
        }
    } else {
        (ProviderKind::parse(&args.provider)?, None)
    };
    let service_id = args.service_id.unwrap_or_else(|| {
        repo_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("backend")
            .to_string()
    });

    let envelope = if let Some((fw, file)) = unsupported_ts {
        eprintln!(
            "Provider: {} (unsupported TypeScript/JavaScript framework; incomplete artifact)",
            fw
        );
        build_unsupported_ts_envelope(
            &service_id,
            args.api_version.as_deref(),
            &args.candidate_snapshot,
            fw,
            &file,
        )?
    } else {
        match provider {
            ProviderKind::Spring => {
                let java_dir = if let Some(jroot) = args.java_root {
                    let path = if jroot.is_relative() {
                        repo_root.join(jroot)
                    } else {
                        jroot
                    };
                    let src_main = path.join("src/main/java");
                    if src_main.is_dir() {
                        src_main
                    } else {
                        path
                    }
                } else {
                    let default_src = repo_root.join("src/main/java");
                    if default_src.is_dir() {
                        default_src
                    } else {
                        repo_root.clone()
                    }
                };

                let extractor = JavaRouteExtractor::new(repo_root.clone(), &java_dir)
                    .map_err(|e| anyhow!("Failed to initialize Java route extractor: {}", e))?;

                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
            ProviderKind::JaxRs => {
                let java_dir = if let Some(jroot) = args.java_root {
                    let path = if jroot.is_relative() {
                        repo_root.join(jroot)
                    } else {
                        jroot
                    };
                    let src_main = path.join("src/main/java");
                    if src_main.is_dir() {
                        src_main
                    } else {
                        path
                    }
                } else {
                    let default_src = repo_root.join("src/main/java");
                    if default_src.is_dir() {
                        default_src
                    } else {
                        repo_root.clone()
                    }
                };

                let mut extractor = JavaRouteExtractor::new(repo_root.clone(), &java_dir)
                    .map_err(|e| anyhow!("Failed to initialize JAX-RS route extractor: {}", e))?;
                extractor.enable_jax_rs = true;
                eprintln!("Provider: JAX_RS");

                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
            ProviderKind::NestJs => {
                let ts_dir = match args.ts_root {
                    Some(root) => {
                        if root.is_relative() {
                            repo_root.join(root)
                        } else {
                            root
                        }
                    }
                    None => {
                        let default_src = repo_root.join("src");
                        if default_src.is_dir() {
                            default_src
                        } else {
                            repo_root.clone()
                        }
                    }
                };
                if !ts_dir.is_dir() {
                    return Err(anyhow!(
                        "TypeScript source directory does not exist: {:?}",
                        ts_dir
                    ));
                }

                let extractor = NestJsRouteExtractor::new(repo_root.clone(), &ts_dir)
                    .map_err(|e| anyhow!("Failed to initialize NestJS route extractor: {}", e))?;
                eprintln!(
                    "Provider: NESTJS ({} controller(s), global prefix {})",
                    extractor.controller_count(),
                    extractor
                        .global_prefix()
                        .map(|prefix| format!("/{prefix}"))
                        .unwrap_or_else(|| "none".to_string())
                );

                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
            ProviderKind::NextJs => {
                let ts_dir = match args.ts_root {
                    Some(root) => {
                        if root.is_relative() {
                            repo_root.join(root)
                        } else {
                            root
                        }
                    }
                    None => repo_root.clone(),
                };
                let extractor = NextJsRouteExtractor::new(repo_root.clone(), &ts_dir)
                    .map_err(|e| anyhow!("Failed to initialize Next.js route extractor: {}", e))?;
                eprintln!(
                    "Provider: NEXTJS ({} endpoint(s))",
                    extractor.endpoints_count()
                );

                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
            ProviderKind::FileRouter => {
                let ts_dir = match args.ts_root {
                    Some(root) => {
                        if root.is_relative() {
                            repo_root.join(root)
                        } else {
                            root
                        }
                    }
                    None => repo_root.clone(),
                };
                let extractor = source_index::file_system_routes::FileSystemRouteExtractor::new(
                    repo_root.clone(),
                    &ts_dir,
                )
                .map_err(|e| anyhow!("Failed to initialize file-system route extractor: {}", e))?;
                eprintln!(
                    "Provider: {:?} ({} file-system route file(s))",
                    extractor.framework(),
                    extractor.sources().len()
                );
                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
            ProviderKind::Express => {
                let ts_dir = match args.ts_root {
                    Some(root) => {
                        if root.is_relative() {
                            repo_root.join(root)
                        } else {
                            root
                        }
                    }
                    None => repo_root.clone(),
                };
                let extractor = ExpressRouteExtractor::new(repo_root.clone(), &ts_dir)
                    .map_err(|e| anyhow!("Failed to initialize Express route extractor: {}", e))?;
                eprintln!(
                    "Provider: EXPRESS ({} endpoint(s))",
                    extractor.endpoints_count()
                );

                extractor
                    .build_envelope(
                        &service_id,
                        args.api_version.as_deref(),
                        &args.candidate_snapshot,
                    )
                    .map_err(|e| anyhow!("Failed to build contract envelope: {}", e))?
            }
        }
    };

    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| anyhow!("Failed to serialize contract envelope: {}", e))?;

    write_atomic(&args.out, &json)?;
    Ok(args.out)
}

fn write_atomic(dest: &Path, content: &str) -> Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(".sajimora_tmp_{}_{}.tmp", std::process::id(), nanos);
    let temp_path = parent.join(temp_name);

    fs::write(&temp_path, content)?;

    if let Err(e) = replace_output(&temp_path, dest) {
        let _ = fs::remove_file(&temp_path);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(source, dest)
}

#[cfg(windows)]
fn replace_output(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    // 1 = MOVEFILE_REPLACE_EXISTING, 8 = MOVEFILE_WRITE_THROUGH
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
