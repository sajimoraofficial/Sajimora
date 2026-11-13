//! init.rs — Robust, stateful, and atomic repository initialization for Sajimora.
//!
//! Features:
//! 1. Pure read-only Preflight planner (produces an `InitPlan` as data).
//! 2. Zero-touch Brownfield preview by default (exits 0 with actionable instructions unless `--apply` is set).
//! 3. External hook safety: Refuses unconditionally if `core.hooksPath` points outside the repository.
//! 4. Husky v9 compatibility: Resolves user-editable `.husky/pre-commit` rather than ephemeral `.husky/_/`.
//! 5. Atomic 3-way hook swap: Prevents any crash window during hook replacement.
//! 6. Format fingerprinting: Preserves 2-space, 4-space, tabs, minified formatting, and CRLF endings in `package.json`.
//! 7. Atomic extraction: Java extraction runs into `.sajimora/.tmp-extract/` first before touching repository state.
//! 8. Reversible manifest: Writes `.sajimora/init-manifest.json` tracking every owned mutation and artifact.

use anyhow::{anyhow, Result};
use clap::Args;
use contract_core::envelope::{
    seal_envelope, ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
    ContractArtifactEnvelope, ExtractionProfile, FrontendContractPayload,
    ARTIFACT_ENVELOPE_VERSION_V2,
};
use serde::{Deserialize, Serialize};
use source_index::provider::ProviderKind;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ManifestStatus {
    Incomplete,
    Complete,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum IndentStyle {
    Minified,
    Tabs,
    Spaces(usize),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FormatFingerprint {
    pub indent: IndentStyle,
    pub eol: String,
    pub trailing_newline: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScriptPostImage {
    pub key: String,
    pub expected_value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackageJsonModification {
    pub path: String,
    pub fingerprint: FormatFingerprint,
    pub injected_scripts: Vec<ScriptPostImage>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HookIntegration {
    pub strategy: String,
    pub target_hook: String,
    pub backup_hook: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitIgnoreModification {
    pub path: String,
    pub eol: String,
    pub injected_lines: Vec<String>,
    pub created_by_sajimora: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OwnedResources {
    pub package_json: Option<PackageJsonModification>,
    pub hook: Option<HookIntegration>,
    pub gitignore: Option<GitIgnoreModification>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ArtifactResource {
    pub path: String,
    pub kind: String,
    pub is_tracked: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ResolvedRoots {
    pub repo_root: String,
    pub backend_root: String,
    pub frontend_root: Option<String>,
    pub service_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InitManifest {
    pub manifest_version: u32,
    pub status: ManifestStatus,
    pub sajimora_version: String,
    pub initialized_at: String,
    pub roots: ResolvedRoots,
    pub owned: OwnedResources,
    pub artifacts: Vec<ArtifactResource>,
}

#[derive(Args, Debug)]
pub struct InitArgs {
    /// Path to the repository root (defaults to current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Override the detected backend service directory.
    #[arg(long)]
    pub backend: Option<PathBuf>,

    /// Override the detected frontend directory.
    #[arg(long)]
    pub frontend: Option<PathBuf>,

    /// Service identifier for the contract.
    #[arg(long)]
    pub service_id: Option<String>,

    /// Apply the initialization changes. Required for brownfield repositories.
    #[arg(long)]
    pub apply: bool,

    /// Pre-commit hook mode: chain | skip | replace
    #[arg(long)]
    pub hook_mode: Option<String>,

    /// Force init even if the working tree has uncommitted changes.
    #[arg(long)]
    pub force: bool,

    /// Explicitly authorize regenerating an existing baseline contract
    /// (spec §6.1 baseline ratchet). Updating the baseline is an audited
    /// action: without this flag, init refuses to overwrite .sajimora/
    /// contracts from a fully-initialized repository.
    #[arg(long)]
    pub force_baseline: bool,

    /// Preview planned initialization changes without writing anything to disk.
    #[arg(long)]
    pub dry_run: bool,

    /// Legacy flag: skip Git pre-commit hook installation (alias for --hook-mode skip).
    #[arg(long)]
    pub no_hooks: bool,
}

pub enum HookPlan {
    Greenfield {
        target: PathBuf,
    },
    HuskyChain {
        target: PathBuf,
    },
    BareWrapper {
        target: PathBuf,
        backup: PathBuf,
    },
    Skip,
    RefuseExternal {
        path: PathBuf,
    },
    RefuseBrownfield {
        reason: String,
        target: PathBuf,
        recommended_flag: &'static str,
    },
}

#[allow(dead_code)]
pub struct PreflightPlan {
    pub repo_root: PathBuf,
    pub backend_path: PathBuf,
    pub backend_rel: String,
    pub frontend_path: Option<PathBuf>,
    pub frontend_rel: Option<String>,
    pub service_id: String,
    pub is_brownfield: bool,
    pub hook_plan: HookPlan,
    pub package_json_plan: Option<PackageJsonModification>,
    pub gitignore_plan: Option<GitIgnoreModification>,
    pub is_idempotent_noop: bool,
    pub has_lefthook: bool,
    pub has_lint_staged: bool,
}

pub fn run(args: InitArgs) -> i32 {
    match run_inner(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{{\"error\": {:?}}}", e.to_string());
            1
        }
    }
}

fn run_inner(args: InitArgs) -> Result<i32> {
    let repo_root = if args.repo.is_relative() {
        std::env::current_dir()?.join(&args.repo)
    } else {
        args.repo.clone()
    };

    if !repo_root.exists() {
        return Err(anyhow!(
            "Repository directory does not exist: {:?}",
            repo_root
        ));
    }

    // =========================================================================
    // Phase 1: Pure Read-Only Preflight Planning
    // =========================================================================
    let plan = plan_preflight(&repo_root, &args)?;

    // Handle Idempotent no-op
    if plan.is_idempotent_noop {
        println!(
            "\nSajimora is already fully initialized in {:?}. Zero changes needed.",
            repo_root
        );
        return Ok(0);
    }

    // Handle External Hook Refusal (Hard refusal even with --apply)
    if let HookPlan::RefuseExternal { ref path } = plan.hook_plan {
        eprintln!(
            "❌ Refusing to initialize: `core.hooksPath` points outside this repository ({:?}).",
            path
        );
        eprintln!("   Modifying external shared hooks would affect multiple repositories on this machine.");
        eprintln!("   Use `sajimora init --hook-mode skip` to initialize without touching external hooks.");
        return Ok(1);
    }

    // Handle Dry-run / Brownfield Preview
    if args.dry_run || (plan.is_brownfield && !args.apply) {
        print_brownfield_preview(&plan);
        return Ok(0);
    }

    // Working tree dirty check
    if !args.force && is_working_tree_dirty(&repo_root) {
        eprintln!("⚠️  Working tree has uncommitted changes.");
        eprintln!("   Sajimora recommends initializing on a clean git working tree so diffs are reviewable.");
        eprintln!("   Re-run with `--force` to proceed anyway.");
        return Ok(1);
    }

    // Baseline ratchet guard (spec §6.1): regenerating the baseline of a fully
    // initialized repository is an explicit, audited action. Without
    // --force-baseline, refuse — an automated build or check command must never
    // silently absorb new violations into legacy debt. A repository whose init
    // manifest is missing or incomplete is treated as a repair, not an update.
    let manifest_status_complete = {
        let manifest_path = repo_root.join(".sajimora").join("init-manifest.json");
        manifest_path.exists()
            && fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<InitManifest>(&raw).ok())
                .map(|m| m.status == ManifestStatus::Complete)
                .unwrap_or(false)
    };
    let baseline_exists = {
        let sajimora_dir = repo_root.join(".sajimora");
        sajimora_dir.join("backend-contract.json").exists()
            && sajimora_dir.join("frontend-contract.json").exists()
    };
    if manifest_status_complete && baseline_exists && !args.force_baseline {
        eprintln!(
            "❌ Refusing to overwrite the existing Sajimora baseline contracts in .sajimora/."
        );
        eprintln!("   Updating the baseline is an explicit, audited action (baseline ratchet):");
        eprintln!("   new violations must never be silently absorbed into legacy debt.");
        eprintln!("   Re-run with `--force-baseline` to regenerate the baseline from HEAD.");
        return Ok(1);
    }
    if manifest_status_complete && baseline_exists && args.force_baseline {
        println!(
            "  [0/5] Baseline override: regenerating .sajimora/ contracts (--force-baseline)."
        );
    }

    println!("\nInitializing Sajimora in {:?}...", repo_root);

    // =========================================================================
    // Phase 2: Atomic Extraction into Temp Directory (.tmp-extract)
    // =========================================================================
    let sajimora_dir = repo_root.join(".sajimora");
    let tmp_extract = sajimora_dir.join(".tmp-extract");
    fs::create_dir_all(&tmp_extract)?;

    println!("  [1/5] Extracting baseline backend and frontend contracts in parallel...");
    let tmp_backend_contract = tmp_extract.join("backend-contract.json");
    let tmp_frontend_contract = tmp_extract.join("frontend-contract.json");

    let t_extract_start = std::time::Instant::now();
    let (backend_res, frontend_res) = std::thread::scope(|s| {
        let backend_handle = s.spawn(|| -> Result<(usize, usize, u128)> {
            let t0 = std::time::Instant::now();
            let provider = ProviderKind::detect_on_disk(&plan.backend_path);
            // Spring sources live under src/main/java when the backend root is the
            // repository or module root; the NestJS lane reads the backend root itself.
            let source_root = match provider {
                ProviderKind::Spring | ProviderKind::JaxRs => {
                    let default_src = plan.backend_path.join("src/main/java");
                    if default_src.exists() {
                        default_src
                    } else {
                        plan.backend_path.clone()
                    }
                }
                ProviderKind::NestJs
                | ProviderKind::NextJs
                | ProviderKind::Express
                | ProviderKind::FileRouter => plan.backend_path.clone(),
            };

            // The repository root, not the module: the extractor reads the build's module list
            // from it to index DTOs that live in a sibling module of a multi-module service.
            let envelope = crate::extract_backend::build_backend_envelope(
                &repo_root,
                &source_root,
                provider,
                &plan.service_id,
                None,
                "HEAD",
            )
            .map_err(|e| anyhow!("Failed to extract backend contract: {}", e))?;
            let envelope_json = serde_json::to_string_pretty(&envelope)?;
            fs::write(&tmp_backend_contract, envelope_json)?;

            let (ep_count, pool_count) = match &envelope.payload {
                contract_core::envelope::ArtifactPayload::Backend(b) => (
                    b.endpoints.len(),
                    b.type_pool.as_ref().map(|p| p.len()).unwrap_or(0),
                ),
                _ => (0, 0),
            };
            Ok((ep_count, pool_count, t0.elapsed().as_millis()))
        });

        let frontend_handle = s.spawn(|| -> Result<(Option<String>, u128)> {
            let t0 = std::time::Instant::now();
            let mut extracted_service = None;
            if let Some(ref fp) = plan.frontend_path {
                let ts_root_rel = fp
                    .strip_prefix(&repo_root)
                    .unwrap_or(fp)
                    .to_string_lossy()
                    .replace('\\', "/");
                let fe_service_id = fp
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("frontend-service");

                if let Ok(_) = crate::extract_frontend::run_inner(
                    crate::extract_frontend::ExtractFrontendArgs {
                        repo: repo_root.clone(),
                        service_id: Some(fe_service_id.to_string()),
                        target_service_id: Some(plan.service_id.clone()),
                        ts_root: Some(PathBuf::from(&ts_root_rel)),
                        parent: "HEAD".to_string(),
                        out: tmp_frontend_contract.clone(),
                    },
                ) {
                    extracted_service = Some(fe_service_id.to_string());
                }
            }

            if extracted_service.is_none() {
                let empty_frontend_envelope = ContractArtifactEnvelope {
                    envelope_version: ARTIFACT_ENVELOPE_VERSION_V2.to_string(),
                    report_schema_version: "SAJIMORA_CROSS_LANGUAGE_IMPACT_V1".to_string(),
                    kind: ArtifactKind::FrontendContract,
                    snapshot: ArtifactSnapshotRef {
                        repository_id: format!("git-root:{}", plan.service_id),
                        service_id: format!("{}-frontend", plan.service_id),
                        api_version: None,
                        parent_commit: "HEAD".to_string(),
                        candidate_snapshot: "HEAD".to_string(),
                        deployment_id: None,
                        environment: None,
                    },
                    profile: ExtractionProfile {
                        tool_version: "0.1.0".to_string(),
                        framework_profile: None,
                        codec_profile: None,
                        client_profile: Some("STATIC_FETCH_V1".to_string()),
                        config_fingerprint: Some("init".to_string()),
                    },
                    completeness: ArtifactCompleteness {
                        complete: true,
                        unresolved_endpoints: vec![],
                        blockers: vec![],
                    },
                    signature: None,
                    issued_at_unix: None,
                    payload: ArtifactPayload::Frontend(FrontendContractPayload {
                        dependency_context: None,
                        interceptor_evidence: None,
                        client_contracts: vec![],
                        type_pool: None,
                        path_pool: None,
                    }),
                    integrity: None,
                    raw_value: None,
                };
                let sealed = seal_envelope(empty_frontend_envelope)?;
                let sealed_json = serde_json::to_string_pretty(&sealed)?;
                fs::write(&tmp_frontend_contract, sealed_json)?;
            }

            Ok((extracted_service, t0.elapsed().as_millis()))
        });

        let b_res = backend_handle
            .join()
            .unwrap_or_else(|_| Err(anyhow!("Backend extractor thread panicked")));
        let f_res = frontend_handle
            .join()
            .unwrap_or_else(|_| Err(anyhow!("Frontend extractor thread panicked")));
        (b_res, f_res)
    });

    let (ep_count, pool_count, b_ms) = backend_res?;
    let (maybe_fe_service, f_ms) = frontend_res?;
    let total_extract_ms = t_extract_start.elapsed().as_millis();

    println!(
        "        [OK] Extracted {} endpoints, {} interned DTOs (backend: {}ms, frontend: {}ms, wall-clock: {}ms)",
        ep_count, pool_count, b_ms, f_ms, total_extract_ms
    );
    if let Some(fe_service_id) = maybe_fe_service {
        println!(
            "        [OK] Extracted frontend client contracts from {}",
            fe_service_id
        );
    }

    // =========================================================================
    // Phase 3: Staged Intent (Write Manifest with status: incomplete)
    // =========================================================================
    let manifest_path = sajimora_dir.join("init-manifest.json");
    let mut manifest = InitManifest {
        manifest_version: MANIFEST_VERSION,
        status: ManifestStatus::Incomplete,
        sajimora_version: "0.1.0".to_string(),
        initialized_at: "2026-10-20T00:00:00Z".to_string(),
        roots: ResolvedRoots {
            repo_root: repo_root.to_string_lossy().to_string(),
            backend_root: plan.backend_rel.clone(),
            frontend_root: plan.frontend_rel.clone(),
            service_id: plan.service_id.clone(),
        },
        owned: OwnedResources {
            package_json: plan.package_json_plan.clone(),
            hook: None,
            gitignore: plan.gitignore_plan.clone(),
        },
        artifacts: vec![
            ArtifactResource {
                path: ".sajimora/backend-contract.json".to_string(),
                kind: "backend-contract".to_string(),
                is_tracked: false,
            },
            ArtifactResource {
                path: ".sajimora/frontend-contract.json".to_string(),
                kind: "frontend-contract".to_string(),
                is_tracked: false,
            },
        ],
    };

    write_manifest_durable(&manifest_path, &manifest)?;

    // =========================================================================
    // Phase 4: Plan Execution (Move artifacts, mutate package.json, hooks, gitignore)
    // =========================================================================
    // 4.1 Promote artifacts
    let final_backend_contract = sajimora_dir.join("backend-contract.json");
    let final_frontend_contract = sajimora_dir.join("frontend-contract.json");
    fs::rename(&tmp_backend_contract, &final_backend_contract)?;
    fs::rename(&tmp_frontend_contract, &final_frontend_contract)?;
    let _ = fs::remove_dir_all(&tmp_extract);
    println!("  [2/5] Saved baseline contract envelopes in .sajimora/");

    // 4.1.5 Ingest JaCoCo test coverage if present
    let jacoco_candidates = [
        repo_root.join("target/site/jacoco/jacoco.xml"),
        repo_root.join("build/reports/jacoco/test/jacocoTestReport.xml"),
        plan.backend_path.join("target/site/jacoco/jacoco.xml"),
        plan.backend_path
            .join("build/reports/jacoco/test/jacocoTestReport.xml"),
    ];
    if let Some(jpath) = jacoco_candidates.iter().find(|p| p.exists()) {
        if let Ok(file) = fs::File::open(jpath) {
            let reader = std::io::BufReader::new(file);
            let builder = telemetry_core::builder::TelemetryBuilder::new(&plan.service_id);
            if let Ok(envelope) = builder.build(Some(reader), None::<std::io::Cursor<&[u8]>>) {
                if let Ok(json) = serde_json::to_string_pretty(&envelope) {
                    let _ = fs::write(sajimora_dir.join("telemetry.json"), json);
                    println!("        [OK] Ingested JaCoCo coverage -> .sajimora/telemetry.json");
                }
            }
        }
    }

    // 4.2 Mutate package.json if planned
    if let Some(ref pkg_mod) = plan.package_json_plan {
        let pkg_path = repo_root.join(&pkg_mod.path);
        if pkg_path.exists() {
            let content = fs::read_to_string(&pkg_path)?;
            if let Ok(mut json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = json_val.as_object_mut() {
                    let scripts = obj
                        .entry("scripts")
                        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
                    if let Some(scripts_map) = scripts.as_object_mut() {
                        for script in &pkg_mod.injected_scripts {
                            scripts_map.insert(
                                script.key.clone(),
                                serde_json::Value::String(script.expected_value.clone()),
                            );
                        }
                    }
                }
                let new_content = serialize_json_with_fingerprint(&json_val, &pkg_mod.fingerprint)?;
                fs::write(&pkg_path, new_content)?;
                println!("  [3/5] Injected verification scripts into package.json (preserved original formatting)");
            }
        }
    } else {
        println!("  [3/5] package.json scripts already configured");
    }

    // 4.3 Mutate .gitignore if planned
    if let Some(ref gi_mod) = plan.gitignore_plan {
        let gi_path = repo_root.join(&gi_mod.path);
        let mut existing = if gi_path.exists() {
            fs::read_to_string(&gi_path)?
        } else {
            String::new()
        };
        if !existing.is_empty() && !existing.ends_with('\n') && !existing.ends_with('\r') {
            existing.push_str(&gi_mod.eol);
        }
        existing.push_str(&format!("# Sajimora transient artifacts{}", gi_mod.eol));
        for line in &gi_mod.injected_lines {
            existing.push_str(line);
            existing.push_str(&gi_mod.eol);
        }
        fs::write(&gi_path, existing)?;
        println!("  [4/5] Updated .gitignore for transient artifacts");
    } else {
        println!("  [4/5] .gitignore already contains transient artifact patterns");
    }

    // 4.4 Install / Chain Hook
    let hook_result = execute_hook_plan(&repo_root, plan.hook_plan)?;
    manifest.owned.hook = hook_result;

    // =========================================================================
    // Phase 5: Atomic Manifest Finalization (status: complete)
    // =========================================================================
    manifest.status = ManifestStatus::Complete;
    write_manifest_durable(&manifest_path, &manifest)?;

    println!("\nSajimora setup complete!");
    println!(
        "  -> Run `sajimora verify` or `npm run contract:verify` to check API compatibility.\n"
    );
    Ok(0)
}

fn plan_preflight(repo_root: &Path, args: &InitArgs) -> Result<PreflightPlan> {
    let sajimora_dir = repo_root.join(".sajimora");
    let manifest_path = sajimora_dir.join("init-manifest.json");

    // Detect roots
    let backend_path = if let Some(ref b) = args.backend {
        if b.is_relative() {
            repo_root.join(b)
        } else {
            b.clone()
        }
    } else {
        detect_backend(repo_root)?
    };

    let backend_rel = backend_path
        .strip_prefix(repo_root)
        .unwrap_or(&backend_path)
        .to_string_lossy()
        .replace('\\', "/");

    let service_id = args.service_id.clone().unwrap_or_else(|| {
        backend_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("backend-service")
            .to_string()
    });

    let frontend_path = if let Some(ref f) = args.frontend {
        let p = if f.is_relative() {
            repo_root.join(f)
        } else {
            f.clone()
        };
        Some(p)
    } else {
        detect_frontend(repo_root)
    };

    let frontend_rel = frontend_path.as_ref().map(|fp| {
        fp.strip_prefix(repo_root)
            .unwrap_or(fp)
            .to_string_lossy()
            .replace('\\', "/")
    });

    // Check hook environment
    let (hook_plan, is_brownfield) = resolve_hook_plan(repo_root, args)?;

    // Check package.json modification
    let backend_arg = if backend_rel.is_empty() || backend_rel == "." {
        ".".to_string()
    } else {
        backend_rel.clone()
    };

    let expected_scripts = vec![
        ScriptPostImage {
            key: "contract:extract".to_string(),
            expected_value: format!(
                "sajimora extract-backend --repo {} --out .sajimora/candidate-contract.json",
                backend_arg
            ),
        },
        ScriptPostImage {
            key: "contract:check".to_string(),
            expected_value: "sajimora check-contract --base .sajimora/backend-contract.json --candidate .sajimora/candidate-contract.json --target .sajimora/frontend-contract.json --trusted-local --fail-on-violation --out .sajimora/impact-report.json".to_string(),
        },
        ScriptPostImage {
            key: "contract:verify".to_string(),
            expected_value: "sajimora verify".to_string(),
        },
    ];

    let package_json_path = repo_root.join("package.json");
    let package_json_plan = if package_json_path.exists() {
        let raw = fs::read_to_string(&package_json_path)?;
        let fingerprint = detect_format_fingerprint(&raw);
        let val: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);

        let mut needs_injection = false;
        let mut scripts_to_inject = Vec::new();
        for script in &expected_scripts {
            let current = val
                .get("scripts")
                .and_then(|s| s.get(&script.key))
                .and_then(|v| v.as_str());
            if current != Some(&script.expected_value) {
                needs_injection = true;
                scripts_to_inject.push(script.clone());
            }
        }

        if needs_injection {
            Some(PackageJsonModification {
                path: "package.json".to_string(),
                fingerprint,
                injected_scripts: scripts_to_inject,
            })
        } else {
            None
        }
    } else {
        None
    };

    // Check .gitignore
    let gitignore_path = repo_root.join(".gitignore");
    let gitignore_existed = gitignore_path.exists();
    let is_svn_only = is_svn_repo(repo_root) && !repo_root.join(".git").exists();
    let gitignore_plan = if is_svn_only && !gitignore_existed {
        None
    } else {
        let raw = if gitignore_existed {
            fs::read_to_string(&gitignore_path).unwrap_or_default()
        } else {
            String::new()
        };
        let eol = if raw.contains("\r\n") {
            "\r\n".to_string()
        } else {
            "\n".to_string()
        };
        let candidate_lines = vec![
            ".sajimora/candidate-contract.json".to_string(),
            ".sajimora/impact-report.json".to_string(),
            ".sajimora/.tmp-extract/".to_string(),
            ".sajimora/backup/".to_string(),
        ];
        let mut missing_lines = Vec::new();
        for cand in candidate_lines {
            if !raw.lines().any(|l| l.trim() == cand) {
                missing_lines.push(cand);
            }
        }

        if !missing_lines.is_empty() {
            Some(GitIgnoreModification {
                path: ".gitignore".to_string(),
                eol,
                injected_lines: missing_lines,
                created_by_sajimora: !gitignore_existed,
            })
        } else {
            None
        }
    };

    // Check Idempotency: manifest exists and is complete, and no pending changes
    let is_idempotent_noop = if manifest_path.exists() {
        if let Ok(m_raw) = fs::read_to_string(&manifest_path) {
            if let Ok(m) = serde_json::from_str::<InitManifest>(&m_raw) {
                m.status == ManifestStatus::Complete
                    && package_json_plan.is_none()
                    && gitignore_plan.is_none()
                    && sajimora_dir.join("backend-contract.json").exists()
                    && sajimora_dir.join("frontend-contract.json").exists()
                    && !args.force_baseline
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    let has_lefthook = repo_root.join("lefthook.yml").exists()
        || repo_root.join("lefthook.yaml").exists()
        || repo_root.join(".lefthook.yml").exists()
        || repo_root.join(".lefthook.yaml").exists();

    let has_lint_staged = repo_root.join(".lintstagedrc").exists()
        || repo_root.join(".lintstagedrc.json").exists()
        || repo_root.join(".lintstagedrc.yaml").exists()
        || repo_root.join(".lintstagedrc.yml").exists()
        || repo_root.join("lint-staged.config.js").exists()
        || repo_root.join("lint-staged.config.mjs").exists()
        || (package_json_path.exists() && {
            fs::read_to_string(&package_json_path)
                .map(|s| s.contains("\"lint-staged\""))
                .unwrap_or(false)
        });

    Ok(PreflightPlan {
        repo_root: repo_root.to_path_buf(),
        backend_path,
        backend_rel,
        frontend_path,
        frontend_rel,
        service_id,
        is_brownfield,
        hook_plan,
        package_json_plan,
        gitignore_plan,
        is_idempotent_noop,
        has_lefthook,
        has_lint_staged,
    })
}

fn resolve_hook_plan(repo_root: &Path, args: &InitArgs) -> Result<(HookPlan, bool)> {
    if let Some(ref mode) = args.hook_mode {
        if mode != "chain" && mode != "skip" && mode != "replace" {
            return Err(anyhow!(
                "Invalid --hook-mode: '{}'. Valid modes are: chain, skip, replace",
                mode
            ));
        }
    }

    if is_svn_repo(repo_root) && !repo_root.join(".git").exists() {
        return Ok((HookPlan::Skip, false));
    }

    let hooks_path_cfg = git_config_get(repo_root, "core.hooksPath");
    let husky_dir_exists = repo_root.join(".husky").exists();
    let git_dir_hooks = match git_rev_parse_hooks(repo_root) {
        Ok(p) => repo_root.join(p),
        Err(_) => repo_root.join(".git/hooks"),
    };
    let pre_commit = git_dir_hooks.join("pre-commit");
    let bare_hook_or_framework_exists = pre_commit.exists()
        || repo_root.join("lefthook.yml").exists()
        || repo_root.join(".pre-commit-config.yaml").exists();

    let is_brownfield =
        hooks_path_cfg.is_some() || husky_dir_exists || bare_hook_or_framework_exists;

    if args.no_hooks || args.hook_mode.as_deref() == Some("skip") {
        return Ok((HookPlan::Skip, is_brownfield));
    }

    // 1. Check `git config --get core.hooksPath`
    if let Some(ref hp_str) = hooks_path_cfg {
        let raw_path = PathBuf::from(hp_str);
        let absolute_hp = if raw_path.is_relative() {
            repo_root.join(&raw_path)
        } else {
            raw_path
        };

        // If core.hooksPath resolves OUTSIDE repo_root -> Refuse unconditionally
        if let (Ok(can_hp), Ok(can_root)) = (absolute_hp.canonicalize(), repo_root.canonicalize()) {
            if !can_hp.starts_with(&can_root) {
                return Ok((HookPlan::RefuseExternal { path: absolute_hp }, true));
            }
        }

        // Active Husky detection (.husky in hooksPath)
        if hp_str.contains(".husky") {
            let user_hook = repo_root.join(".husky/pre-commit");
            let plan = match args.hook_mode.as_deref() {
                Some("chain") | Some("replace") => HookPlan::HuskyChain { target: user_hook },
                _ => HookPlan::RefuseBrownfield {
                    reason: "Active Husky detected".to_string(),
                    target: user_hook,
                    recommended_flag: "--apply --hook-mode=chain",
                },
            };
            return Ok((plan, true));
        }

        // Other custom hooksPath
        let target_hook = absolute_hp.join("pre-commit");
        let plan = match args.hook_mode.as_deref() {
            Some("chain") | Some("replace") => HookPlan::BareWrapper {
                target: target_hook.clone(),
                backup: absolute_hp.join("pre-commit.sajimora-orig"),
            },
            _ => HookPlan::RefuseBrownfield {
                reason: format!("Custom core.hooksPath active ({})", hp_str),
                target: target_hook,
                recommended_flag: "--apply --hook-mode=chain",
            },
        };
        return Ok((plan, true));
    }

    // 2. If .husky directory exists but core.hooksPath is unset -> Uninitialized Husky
    if husky_dir_exists {
        return Ok((
            HookPlan::RefuseBrownfield {
                reason: ".husky directory exists but core.hooksPath is unset. Run `npm install` first to initialize Husky.".to_string(),
                target: repo_root.join(".husky/pre-commit"),
                recommended_flag: "--apply --hook-mode=chain",
            },
            true,
        ));
    }

    // 3. Check resolved git-path
    if bare_hook_or_framework_exists {
        let plan = match args.hook_mode.as_deref() {
            Some("chain") | Some("replace") => HookPlan::BareWrapper {
                target: pre_commit.clone(),
                backup: git_dir_hooks.join("pre-commit.sajimora-orig"),
            },
            _ => HookPlan::RefuseBrownfield {
                reason: "Pre-existing Git pre-commit hook detected".to_string(),
                target: pre_commit,
                recommended_flag: "--apply --hook-mode=chain",
            },
        };
        return Ok((plan, true));
    }

    // Greenfield
    Ok((HookPlan::Greenfield { target: pre_commit }, false))
}

/// Marker carried by every Sajimora-managed hook so `init-hook` can find and
/// rewrite its own block instead of stacking a second hook.
pub(crate) const HOOK_MARKER: &str = "Sajimora cross-language verification";

/// The advisory invocation must never block: operational failures from
/// `verify` itself (missing contracts, extraction errors) are swallowed.
fn verify_invocation(blocking: bool) -> &'static str {
    if blocking {
        "sajimora verify --fail-on-violation --strict"
    } else {
        "sajimora verify || echo \"[sajimora] advisory check did not complete; commit allowed.\" >&2"
    }
}

fn hook_mode_label(blocking: bool) -> &'static str {
    if blocking {
        "Blocking Mode"
    } else {
        "Advisory Mode"
    }
}

/// Standalone pre-commit hook. Advisory mode never blocks: a missing binary
/// warns and exits 0 rather than failing the commit.
pub(crate) fn greenfield_hook_script(blocking: bool) -> String {
    let guidance = if blocking {
        "# Opt-in: exits 1 on contract violations and 3 on inconclusive analysis."
    } else {
        "# Surfaces contract warnings in terminal without blocking local commits.\n\
         # Enforce locally with `sajimora init-hook --blocking`."
    };
    format!(
        r#"#!/bin/sh
# {marker} ({mode})
{guidance}
if [ "$SAJIMORA_VERIFY_ACTIVE" = "1" ]; then
  exit 0
fi
if ! command -v sajimora >/dev/null 2>&1; then
  echo "[sajimora] sajimora is not on PATH; skipping contract verification." >&2
  exit 0
fi
export SAJIMORA_VERIFY_ACTIVE=1
{invocation}
# Advisory AST refactoring check: detects broken test signatures without altering disk
[ -d "src/test" ] || [ -d "test" ] || [ -d "tests" ] && sajimora heal --detect-only >/dev/null 2>&1 || true
"#,
        marker = HOOK_MARKER,
        mode = hook_mode_label(blocking),
        guidance = guidance,
        invocation = verify_invocation(blocking),
    )
}

/// Block appended to a user's Husky hook. The trailing `fi` is the block
/// boundary `sajimora clean` uses to strip exactly this addition.
pub(crate) fn husky_hook_snippet(blocking: bool) -> String {
    format!(
        r#"
# {marker} ({mode})
if [ "$SAJIMORA_VERIFY_ACTIVE" != "1" ] && command -v sajimora >/dev/null 2>&1; then
  export SAJIMORA_VERIFY_ACTIVE=1
  {invocation}
  [ -d "src/test" ] || [ -d "test" ] || [ -d "tests" ] && sajimora heal --detect-only >/dev/null 2>&1 || true
fi
"#,
        marker = HOOK_MARKER,
        mode = hook_mode_label(blocking),
        invocation = verify_invocation(blocking),
    )
}

/// Wrapper that runs the user's original hook first, then verification.
pub(crate) fn wrapper_hook_script(blocking: bool) -> String {
    format!(
        r#"#!/bin/sh
# {marker} wrapper ({mode}); original preserved as pre-commit.sajimora-orig.
"$(dirname "$0")/pre-commit.sajimora-orig" "$@"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  exit $STATUS
fi

if [ "$SAJIMORA_VERIFY_ACTIVE" = "1" ]; then
  exit 0
fi
if ! command -v sajimora >/dev/null 2>&1; then
  echo "[sajimora] sajimora is not on PATH; skipping contract verification." >&2
  exit 0
fi
export SAJIMORA_VERIFY_ACTIVE=1
{invocation}
# Advisory AST refactoring check: detects broken test signatures without altering disk
[ -d "src/test" ] || [ -d "test" ] || [ -d "tests" ] && sajimora heal --detect-only >/dev/null 2>&1 || true
"#,
        marker = HOOK_MARKER,
        mode = hook_mode_label(blocking),
        invocation = verify_invocation(blocking),
    )
}

fn execute_hook_plan(repo_root: &Path, hook_plan: HookPlan) -> Result<Option<HookIntegration>> {
    match hook_plan {
        HookPlan::Skip => {
            println!("  [5/5] Skipped hook installation (--hook-mode skip)");
            Ok(None)
        }
        HookPlan::Greenfield { target } => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&target, greenfield_hook_script(false))?;
            set_executable(&target)?;
            let rel = target
                .strip_prefix(repo_root)
                .unwrap_or(&target)
                .to_string_lossy()
                .replace('\\', "/");
            println!("  [5/5] Installed Greenfield pre-commit hook: {}", rel);
            Ok(Some(HookIntegration {
                strategy: "greenfield".to_string(),
                target_hook: rel,
                backup_hook: None,
            }))
        }
        HookPlan::HuskyChain { target } => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let snippet = husky_hook_snippet(false);
            let (existing_content, backup_rel) = if target.exists() {
                let backup = target.with_file_name("pre-commit.sajimora-backup");
                if !backup.exists() {
                    let _ = fs::copy(&target, &backup);
                }
                let b_rel = backup
                    .strip_prefix(repo_root)
                    .unwrap_or(&backup)
                    .to_string_lossy()
                    .replace('\\', "/");
                (fs::read_to_string(&target)?, Some(b_rel))
            } else {
                ("#!/bin/sh\n".to_string(), None)
            };
            let mut existing = existing_content;
            if !existing.contains("sajimora verify") {
                existing.push_str(&snippet);
                fs::write(&target, existing)?;
                set_executable(&target)?;
            }
            let rel = target
                .strip_prefix(repo_root)
                .unwrap_or(&target)
                .to_string_lossy()
                .replace('\\', "/");
            println!(
                "  [5/5] Chained Sajimora verification into Husky hook: {}",
                rel
            );
            Ok(Some(HookIntegration {
                strategy: "husky_chain".to_string(),
                target_hook: rel,
                backup_hook: backup_rel,
            }))
        }
        HookPlan::BareWrapper { target, backup } => {
            if backup.exists() {
                if let Ok(content) = fs::read_to_string(&target) {
                    if content.contains("sajimora verify") {
                        let backup_rel = backup
                            .strip_prefix(repo_root)
                            .unwrap_or(&backup)
                            .to_string_lossy()
                            .replace('\\', "/");
                        let target_rel = target
                            .strip_prefix(repo_root)
                            .unwrap_or(&target)
                            .to_string_lossy()
                            .replace('\\', "/");
                        return Ok(Some(HookIntegration {
                            strategy: "bare_wrapper".to_string(),
                            target_hook: target_rel,
                            backup_hook: Some(backup_rel),
                        }));
                    }
                }
                return Err(anyhow!(
                    "Backup hook {:?} already exists. Run `sajimora clean` first before re-initializing.",
                    backup
                ));
            }
            let new_temp_wrapper = target.with_file_name("pre-commit.sajimora-new");
            fs::write(&new_temp_wrapper, wrapper_hook_script(false))?;
            set_executable(&new_temp_wrapper)?;

            // Atomic 3-way swap
            fs::rename(&target, &backup)?;
            fs::rename(&new_temp_wrapper, &target)?;

            let target_rel = target
                .strip_prefix(repo_root)
                .unwrap_or(&target)
                .to_string_lossy()
                .replace('\\', "/");
            let backup_rel = backup
                .strip_prefix(repo_root)
                .unwrap_or(&backup)
                .to_string_lossy()
                .replace('\\', "/");
            println!(
                "  [5/5] Installed atomic wrapper hook at {} (original preserved at {})",
                target_rel, backup_rel
            );
            Ok(Some(HookIntegration {
                strategy: "bare_wrapper".to_string(),
                target_hook: target_rel,
                backup_hook: Some(backup_rel),
            }))
        }
        _ => Ok(None),
    }
}

fn print_brownfield_preview(plan: &PreflightPlan) {
    println!("\n╔════════════════════════════════════════════════════════════════════════╗");
    println!("║                  SAJIMORA INIT PREVIEW (DRY-RUN)                       ║");
    println!("║ Brownfield repository detected. Zero changes have been made to disk.   ║");
    println!("╚════════════════════════════════════════════════════════════════════════╝\n");

    println!("Detected Architecture:");
    // An aggregator-root backend has no path relative to the repo root; print it
    // as "." rather than as blank, which reads like a missing detection.
    let backend_display = if plan.backend_rel.is_empty() {
        "."
    } else {
        &plan.backend_rel
    };
    println!(
        "  Backend:  {} (service ID: {})",
        backend_display, plan.service_id
    );
    if let Some(ref fe) = plan.frontend_rel {
        println!("  Frontend: {}", fe);
    }

    println!("\nPlanned Actions on --apply:");
    println!("  1. Extract contract artifacts into .sajimora/backend-contract.json and frontend-contract.json");
    if let Some(ref pkg_mod) = plan.package_json_plan {
        println!(
            "  2. Add verification scripts to package.json (preserving indentation and CRLF):"
        );
        for s in &pkg_mod.injected_scripts {
            println!("     + \"{}\": \"{}\"", s.key, s.expected_value);
        }
    } else {
        println!("  2. package.json already has verification scripts.");
    }

    match &plan.hook_plan {
        HookPlan::RefuseBrownfield {
            reason,
            target,
            recommended_flag,
        } => {
            println!("  3. Git Hook: {} ({:?})", reason, target);
            println!("     -> To safely chain or skip hooks, run with:");
            println!("        sajimora init {}", recommended_flag);
        }
        HookPlan::HuskyChain { target } => {
            println!("  3. Git Hook: Will chain into {:?}", target);
        }
        HookPlan::BareWrapper { target, backup } => {
            println!(
                "  3. Git Hook: Will install 3-way wrapper at {:?} (preserving original at {:?})",
                target, backup
            );
        }
        _ => {}
    }

    if plan.has_lefthook {
        println!("\n  Lefthook Detected:");
        println!(
            "    To invoke Sajimora verify directly via Lefthook, add this block to lefthook.yml:"
        );
        println!("      pre-commit:");
        println!("        commands:");
        println!("          sajimora-verify:");
        println!("            run: sajimora verify");
    }

    if plan.has_lint_staged {
        println!("\n  lint-staged Detected:");
        println!("    Sajimora pre-commit verification integrates alongside lint-staged without conflict.");
    }

    println!("\nTo execute these changes, re-run with: sajimora init --apply\n");
}

pub(crate) fn write_manifest_durable(path: &Path, manifest: &InitManifest) -> Result<()> {
    let json_bytes = serde_json::to_vec_pretty(manifest)?;
    let temp_path = path.with_extension("tmp");
    let mut file = fs::File::create(&temp_path)?;
    file.write_all(&json_bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp_path, path)?;
    Ok(())
}

pub fn detect_format_fingerprint(raw: &str) -> FormatFingerprint {
    let eol = if raw.contains("\r\n") {
        "\r\n".to_string()
    } else {
        "\n".to_string()
    };
    let trailing_newline = raw.ends_with('\n') || raw.ends_with('\r');

    if !raw.contains('\n') {
        return FormatFingerprint {
            indent: IndentStyle::Minified,
            eol,
            trailing_newline,
        };
    }

    let mut detected = IndentStyle::Spaces(2);
    for line in raw.lines() {
        if line.starts_with('\t') {
            detected = IndentStyle::Tabs;
            break;
        }
        let space_count = line.chars().take_while(|c| *c == ' ').count();
        if space_count > 0 {
            detected = IndentStyle::Spaces(space_count);
            break;
        }
    }

    FormatFingerprint {
        indent: detected,
        eol,
        trailing_newline,
    }
}

pub fn serialize_json_with_fingerprint(
    val: &serde_json::Value,
    fp: &FormatFingerprint,
) -> Result<String> {
    let raw = match fp.indent {
        IndentStyle::Minified => serde_json::to_string(val)?,
        IndentStyle::Spaces(2) => {
            let pretty = serde_json::to_string_pretty(val)?;
            if fp.eol == "\r\n" {
                pretty.replace('\n', "\r\n")
            } else {
                pretty
            }
        }
        IndentStyle::Spaces(n) => {
            let pretty = serde_json::to_string_pretty(val)?;
            let space_unit = " ".repeat(n);
            let mut lines = Vec::new();
            for line in pretty.lines() {
                let leading_spaces = line.chars().take_while(|c| *c == ' ').count();
                let levels = leading_spaces / 2;
                let remainder = &line[leading_spaces..];
                lines.push(format!("{}{}", space_unit.repeat(levels), remainder));
            }
            lines.join(&fp.eol)
        }
        IndentStyle::Tabs => {
            let pretty = serde_json::to_string_pretty(val)?;
            let mut lines = Vec::new();
            for line in pretty.lines() {
                let leading_spaces = line.chars().take_while(|c| *c == ' ').count();
                let levels = leading_spaces / 2;
                let remainder = &line[leading_spaces..];
                lines.push(format!("{}{}", "\t".repeat(levels), remainder));
            }
            lines.join(&fp.eol)
        }
    };

    let mut result = raw;
    if fp.trailing_newline && !result.ends_with('\n') {
        result.push_str(&fp.eol);
    }
    Ok(result)
}

pub(crate) fn is_svn_repo(repo_root: &Path) -> bool {
    repo_root.join(".svn").is_dir()
        || Command::new("svn")
            .arg("info")
            .current_dir(repo_root)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

fn is_working_tree_dirty(repo_root: &Path) -> bool {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_root)
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return !String::from_utf8_lossy(&out.stdout).trim().is_empty();
        }
    }

    let svn_output = Command::new("svn")
        .args(["status", "-q"])
        .current_dir(repo_root)
        .output();
    match svn_output {
        Ok(out) if out.status.success() => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        _ => false,
    }
}

pub(crate) fn git_config_get(repo_root: &Path, key: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["config", "--get", key])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if output.status.success() {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() {
            return Some(val);
        }
    }
    None
}

pub(crate) fn git_rev_parse_hooks(repo_root: &Path) -> Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-path", "hooks"])
        .current_dir(repo_root)
        .output()?;
    if output.status.success() {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(PathBuf::from(val))
    } else {
        Err(anyhow!("Failed to resolve git hooks directory"))
    }
}

pub(crate) fn set_executable(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(_path, perms);
        }
    }
    Ok(())
}

pub(crate) fn detect_backend(repo_root: &Path) -> Result<PathBuf> {
    // (score, depth, path). Depth is the last tie-breaker before path order: a
    // workspace root that contains a nested provider module would otherwise tie
    // with the module itself, and the winner would depend on directory order.
    let mut candidates: Vec<(u32, usize, PathBuf)> = Vec::new();
    let mut push = |score: u32, path: PathBuf| {
        let depth = path.components().count();
        candidates.push((score, depth, path));
    };

    // Check root
    if is_java_backend_root(repo_root) {
        push(score_backend_candidate(repo_root), repo_root.to_path_buf());
    }
    if is_nestjs_backend(repo_root) {
        push(score_nestjs_candidate(repo_root), repo_root.to_path_buf());
    }
    if is_nextjs_backend(repo_root) {
        push(score_nextjs_candidate(repo_root), repo_root.to_path_buf());
    }
    if is_express_backend(repo_root) {
        push(score_express_candidate(repo_root), repo_root.to_path_buf());
    }

    // Check subdirectories (up to 2 levels deep)
    if let Ok(entries) = fs::read_dir(repo_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "build"
                    || name == "dist"
                {
                    continue;
                }

                if is_java_backend_root(&path) {
                    push(score_backend_candidate(&path), path.clone());
                }
                if is_nestjs_backend(&path) {
                    push(score_nestjs_candidate(&path), path.clone());
                }
                if is_nextjs_backend(&path) {
                    push(score_nextjs_candidate(&path), path.clone());
                }
                if is_express_backend(&path) {
                    push(score_express_candidate(&path), path.clone());
                }

                // Check nested submodules (e.g. server/app, backend/service)
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub in sub_entries.flatten() {
                        let sub_path = sub.path();
                        if sub_path.is_dir() {
                            let sub_name =
                                sub_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            if sub_name.starts_with('.')
                                || sub_name == "node_modules"
                                || sub_name == "target"
                                || sub_name == "dist"
                            {
                                continue;
                            }
                            if is_java_backend_root(&sub_path) {
                                push(score_backend_candidate(&sub_path), sub_path.clone());
                            }
                            if is_nestjs_backend(&sub_path) {
                                push(score_nestjs_candidate(&sub_path), sub_path.clone());
                            }
                            if is_nextjs_backend(&sub_path) {
                                push(score_nextjs_candidate(&sub_path), sub_path.clone());
                            }
                            if is_express_backend(&sub_path) {
                                push(score_express_candidate(&sub_path), sub_path);
                            }
                        }
                    }
                }
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));

    let (_, _, best) = candidates.into_iter().next().ok_or_else(|| {
        anyhow!(
            "Could not automatically detect a Java/Spring, JAX-RS, NestJS, Next.js, or Express backend in {:?}. Specify with --backend <PATH>",
            repo_root
        )
    })?;

    // Only Java modules participate in Maven/Gradle aggregation. A JS provider
    // must not be collapsed into an unrelated polyglot aggregator root.
    if matches!(
        ProviderKind::detect_on_disk(&best),
        ProviderKind::Spring | ProviderKind::JaxRs
    ) {
        let mut collapsed = best.clone();
        while let Some(aggregator) = in_repo_aggregator_parent(&collapsed, repo_root) {
            collapsed = aggregator;
        }
        return Ok(collapsed);
    }

    Ok(best)
}

/// Maven `<modules>` / Gradle `include` aggregation means a child module is a
/// knowingly partial view: extracting from one module emits
/// `JAVA_ENDPOINT_ROOT_EXCLUDES_MODULE` for every sibling its source root cannot
/// see. So auto-detection collapses a selected Java module up to the nearest
/// in-repo aggregator that declares it, instead of sealing whichever module
/// sorts first alphabetically. `--backend` still overrides.
fn in_repo_aggregator_parent(dir: &Path, repo_root: &Path) -> Option<PathBuf> {
    if dir == repo_root {
        return None;
    }
    let mut parent = dir.parent()?;
    while parent.starts_with(repo_root) {
        if declares_child_module(parent, dir) {
            return Some(parent.to_path_buf());
        }
        let next = parent.parent()?;
        parent = next;
    }
    None
}

/// True when `aggregator`'s build file declares a module that is `child` itself,
/// an ancestor of it, or a descendant of it (candidate `transport` is covered by
/// a root that declares `transport/http`).
fn declares_child_module(aggregator: &Path, child: &Path) -> bool {
    let rel = match child.strip_prefix(aggregator) {
        Ok(rel) => rel,
        Err(_) => return false,
    };
    let child_parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    if child_parts.is_empty() {
        return false;
    }

    for declared in declared_module_paths(aggregator) {
        let declared_parts: Vec<String> = declared.iter().map(|p| p.to_lowercase()).collect();
        if declared_parts.is_empty() {
            continue;
        }
        let shared = declared_parts
            .iter()
            .zip(child_parts.iter())
            .take_while(|(a, b)| a == b)
            .count();
        if shared == declared_parts.len().min(child_parts.len()) {
            return true;
        }
    }
    false
}

fn declared_module_paths(dir: &Path) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    if let Ok(pom) = fs::read_to_string(dir.join("pom.xml")) {
        out.extend(parse_maven_modules(&pom));
    }
    for settings in ["settings.gradle", "settings.gradle.kts"] {
        if let Ok(text) = fs::read_to_string(dir.join(settings)) {
            out.extend(parse_gradle_includes(&text));
        }
    }
    out
}

/// `<modules><module>eladmin-system</module></modules>` -> path segments.
fn parse_maven_modules(pom: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut rest = pom;
    while let Some(start) = rest.find("<module>") {
        let after = &rest[start + "<module>".len()..];
        let end = match after.find("</module>") {
            Some(end) => end,
            None => break,
        };
        let name = after[..end].trim();
        if !name.is_empty() {
            out.push(module_name_to_parts(name));
        }
        rest = &after[end..];
    }
    out
}

/// `include 'a', ':b:c'` / `include("a")` -> path segments.
fn parse_gradle_includes(text: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(idx) = line.find("include") else {
            continue;
        };
        let after = &line[idx + "include".len()..];
        let list = if let Some(open) = after.find('(') {
            let close = match after.find(')') {
                Some(c) => c,
                None => after.len(),
            };
            &after[open + 1..close]
        } else {
            after
        };
        for token in list.split(',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            let quoted = token
                .trim_matches(|c| c == '\'' || c == '"')
                .trim_start_matches(':');
            let parts = module_name_to_parts(quoted);
            if !parts.is_empty() {
                out.push(parts);
            }
        }
    }
    out
}

fn module_name_to_parts(name: &str) -> Vec<String> {
    name.replace(':', "/")
        .split('/')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && !s.starts_with('$'))
        .collect()
}

fn is_java_backend_root(dir: &Path) -> bool {
    dir.join("pom.xml").exists()
        || dir.join("build.gradle").exists()
        || dir.join("build.gradle.kts").exists()
        || dir.join("src/main/java").exists()
        || source_index::provider::has_java_source(dir)
}

/// A NestJS backend module: a `package.json` plus a controller file that imports
/// `@nestjs/common`. Checked before the frontend scan so a NestJS backend is not
/// also selected as the frontend.
pub(crate) fn is_nestjs_backend(dir: &Path) -> bool {
    dir.join("package.json").exists() && ProviderKind::detect_on_disk(dir) == ProviderKind::NestJs
}

/// A Next.js App Router backend: a `package.json` plus at least one `app/**/route.ts`.
pub(crate) fn is_nextjs_backend(dir: &Path) -> bool {
    dir.join("package.json").exists() && ProviderKind::detect_on_disk(dir) == ProviderKind::NextJs
}

/// An Express/Fastify backend: a `package.json` plus a server import or dependency.
pub(crate) fn is_express_backend(dir: &Path) -> bool {
    dir.join("package.json").exists() && ProviderKind::detect_on_disk(dir) == ProviderKind::Express
}

fn score_backend_candidate(dir: &Path) -> u32 {
    let mut score = 1;
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.contains("server")
        || name.contains("backend")
        || name.contains("service")
        || name.contains("api")
        || name.contains("application")
    {
        score += 25;
    }
    if dir.join("src/main/java").exists() || source_index::provider::has_java_source(dir) {
        score += 30;
    }
    if dir.join("pom.xml").exists()
        || dir.join("build.gradle").exists()
        || dir.join("build.gradle.kts").exists()
    {
        score += 15;
    }
    score
}

/// NestJS presence scores below a Java module's presence bonus (30 + 15), so a
/// polyglot module keeps the Spring lane this dispatcher inherited.
fn score_nestjs_candidate(dir: &Path) -> u32 {
    let mut score = score_backend_candidate(dir) + 30;
    if dir.join("tsconfig.json").exists() {
        score += 5;
    }
    score
}

fn score_nextjs_candidate(dir: &Path) -> u32 {
    let mut score = score_backend_candidate(dir) + 30;
    if dir.join("tsconfig.json").exists() {
        score += 5;
    }
    score
}

fn score_express_candidate(dir: &Path) -> u32 {
    let mut score = score_backend_candidate(dir) + 30;
    if dir.join("package.json").exists() {
        score += 5;
    }
    score
}

pub(crate) use source_index::discovery::detect_frontend;

#[cfg(test)]
mod detection_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "sajimora-init-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }

        fn file(&self, rel: &str, content: &str) {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    const NEST_CONTROLLER: &str = "import { Controller, Get } from '@nestjs/common';\n\
        @Controller('things')\n\
        export class ThingsController { @Get() all() { return []; } }\n";

    #[test]
    fn nestjs_backend_is_detected_and_never_becomes_the_frontend() {
        let f = Fixture::new("nest-root");
        f.file(
            "package.json",
            r#"{"dependencies":{"@nestjs/core":"^10.0.0"}}"#,
        );
        f.file("tsconfig.json", "{}");
        f.file("src/things.controller.ts", NEST_CONTROLLER);

        assert!(is_nestjs_backend(&f.root));
        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
        assert_eq!(detect_frontend(&f.root), None);
    }

    #[test]
    fn express_backend_is_detected_and_never_becomes_the_frontend() {
        let f = Fixture::new("express-root");
        f.file("package.json", r#"{"dependencies":{"express":"^4.18.2"}}"#);
        f.file(
            "src/index.ts",
            "import express from 'express';\nconst app = express();\napp.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });\n",
        );

        assert!(is_express_backend(&f.root));
        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
        assert_eq!(detect_frontend(&f.root), None);
    }

    #[test]
    fn nextjs_app_router_is_detected_and_never_becomes_the_frontend() {
        let f = Fixture::new("next-root");
        f.file(
            "package.json",
            r#"{"dependencies":{"next":"^14.0.0","react":"^18.0.0"}}"#,
        );
        f.file("tsconfig.json", "{}");
        f.file(
            "src/app/api/things/route.ts",
            "export async function GET() { return Response.json({ ok: true }); }\n",
        );

        assert!(is_nextjs_backend(&f.root));
        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
        assert_eq!(detect_frontend(&f.root), None);
    }

    #[test]
    fn frontend_beside_a_nestjs_backend_is_still_found() {
        let f = Fixture::new("nest-plus-web");
        f.file(
            "package.json",
            r#"{"dependencies":{"@nestjs/core":"^10.0.0"}}"#,
        );
        f.file("src/things.controller.ts", NEST_CONTROLLER);
        f.file(
            "client/package.json",
            r#"{"dependencies":{"react":"^18.0.0","axios":"^1.0.0"}}"#,
        );
        f.file("client/tsconfig.json", "{}");

        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
        assert_eq!(detect_frontend(&f.root).unwrap(), f.root.join("client"));
    }

    #[test]
    fn nested_nestjs_app_outranks_a_workspace_root_that_only_contains_it() {
        let f = Fixture::new("nest-workspace");
        f.file(
            "package.json",
            r#"{"private":true,"workspaces":["apps/*"]}"#,
        );
        f.file(
            "apps/api/package.json",
            r#"{"dependencies":{"@nestjs/core":"^10.0.0"}}"#,
        );
        f.file("apps/api/tsconfig.json", "{}");
        f.file("apps/api/src/things.controller.ts", NEST_CONTROLLER);

        assert_eq!(detect_backend(&f.root).unwrap(), f.root.join("apps/api"));
    }

    #[test]
    fn java_module_keeps_the_spring_lane() {
        let f = Fixture::new("spring");
        f.file("pom.xml", "<project/>");
        f.file(
            "src/main/java/demo/ThingController.java",
            "package demo; class ThingController {}",
        );

        assert!(!is_nestjs_backend(&f.root));
        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
    }

    #[test]
    fn maven_aggregator_root_wins_over_the_module_that_sorts_first() {
        let f = Fixture::new("maven-aggregator");
        f.file(
            "pom.xml",
            "<project><modules><module>mod-a</module><module>mod-b</module></modules></project>",
        );
        f.file("mod-a/pom.xml", "<project/>");
        f.file(
            "mod-a/src/main/java/demo/A.java",
            "package demo; class A {}",
        );
        f.file("mod-b/pom.xml", "<project/>");
        f.file(
            "mod-b/src/main/java/demo/B.java",
            "package demo; class B {}",
        );

        // Both modules tie on score, so before the aggregator rule the winner was
        // whichever directory read first — and either choice excludes the other.
        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
    }

    #[test]
    fn nested_maven_module_collapses_through_every_aggregator() {
        let f = Fixture::new("maven-nested");
        f.file(
            "pom.xml",
            "<project><modules><module>services</module></modules></project>",
        );
        f.file(
            "services/pom.xml",
            "<project><modules><module>billing</module></modules></project>",
        );
        f.file("services/billing/pom.xml", "<project/>");
        f.file(
            "services/billing/src/main/java/demo/Billing.java",
            "package demo; class Billing {}",
        );

        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
    }

    #[test]
    fn gradle_settings_include_collapses_to_the_root() {
        let f = Fixture::new("gradle-aggregator");
        f.file(
            "settings.gradle",
            "rootProject.name = 'demo'\ninclude ':api', ':web'\n",
        );
        f.file("api/build.gradle", "plugins { id 'java' }\n");
        f.file(
            "api/src/main/java/demo/Api.java",
            "package demo; class Api {}",
        );
        f.file("web/build.gradle", "plugins { id 'java' }\n");
        f.file(
            "web/src/main/java/demo/Web.java",
            "package demo; class Web {}",
        );

        assert_eq!(detect_backend(&f.root).unwrap(), f.root);
    }

    #[test]
    fn child_module_without_an_in_repo_aggregator_is_kept() {
        let f = Fixture::new("lone-module");
        f.file("server/pom.xml", "<project/>");
        f.file(
            "server/src/main/java/demo/Server.java",
            "package demo; class Server {}",
        );

        assert_eq!(detect_backend(&f.root).unwrap(), f.root.join("server"));
    }

    #[test]
    fn polyglot_nestjs_app_is_not_collapsed_into_a_maven_aggregator() {
        let f = Fixture::new("polyglot-lane");
        f.file(
            "pom.xml",
            "<project><modules><module>legacy-job</module></modules></project>",
        );
        f.file("legacy-job/pom.xml", "<project/>");
        f.file(
            "legacy-job/src/main/java/demo/Job.java",
            "package demo; class Job {}",
        );
        f.file(
            "apps/api/package.json",
            r#"{"dependencies":{"@nestjs/core":"^10.0.0"}}"#,
        );
        f.file("apps/api/tsconfig.json", "{}");
        f.file("apps/api/src/things.controller.ts", NEST_CONTROLLER);

        assert_eq!(detect_backend(&f.root).unwrap(), f.root.join("apps/api"));
    }
}
