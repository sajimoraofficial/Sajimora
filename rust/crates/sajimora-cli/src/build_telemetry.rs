//! build_telemetry.rs — Native Rust telemetry artifact builder CLI command.
//!
//! Ingests JaCoCo XML and/or OpenTelemetry trace spans to produce a sealed
//! SAJIMORA_TELEMETRY_ARTIFACT_V1 artifact envelope.

use anyhow::{anyhow, Result};
use clap::Args;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use telemetry_core::builder::TelemetryBuilder;

#[derive(Args, Debug)]
pub struct BuildTelemetryArgs {
    /// Service identifier for the telemetry artifact. Defaults to auto-detecting from .sajimora.
    #[arg(long)]
    pub service_id: Option<String>,

    /// API version string (e.g. "v1").
    #[arg(long)]
    pub api_version: Option<String>,

    /// Path to JaCoCo XML report file. Defaults to auto-detecting target/... or sample-jacoco.xml.
    #[arg(long)]
    pub jacoco: Option<PathBuf>,

    /// Path to OpenTelemetry JSON or NDJSON span trace file. Defaults to auto-detecting sample-otel.json.
    #[arg(long)]
    pub otel: Option<PathBuf>,

    /// Output path for the sealed telemetry artifact JSON. Defaults to .sajimora/telemetry.json.
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Path to production hit counts JSON or CSV (e.g. prod-counts.json or prod-counts.csv).
    #[arg(long)]
    pub hits: Option<PathBuf>,

    /// Path to caller-supplied trust policy JSON for signature verification.
    #[arg(long)]
    pub trust_policy: Option<PathBuf>,
}

pub fn run(args: BuildTelemetryArgs) -> i32 {
    match run_inner(args) {
        Ok(dest) => {
            println!("\n✅ Sealed telemetry artifact written to {:?}", dest);
            0
        }
        Err(e) => {
            eprintln!("\n❌ Build telemetry failed: {}\n", e);
            1
        }
    }
}

fn run_inner(args: BuildTelemetryArgs) -> Result<PathBuf> {
    let current_dir = std::env::current_dir()?;
    let sajimora_dir = find_sajimora_dir(&current_dir).map(|(_, s)| s);

    // 1. Resolve service_id
    let service_id = if let Some(s) = args.service_id {
        s
    } else if let Some(ref sdir) = sajimora_dir {
        let base_file = sdir.join("backend-contract.json");
        let manifest_file = sdir.join("init-manifest.json");
        if let Ok(bytes) = fs::read(&base_file) {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                val.get("snapshot")
                    .and_then(|s| s.get("serviceId"))
                    .and_then(|id| id.as_str())
                    .unwrap_or("backend-service")
                    .to_string()
            } else {
                "backend-service".to_string()
            }
        } else if let Ok(bytes) = fs::read(&manifest_file) {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                val.get("roots")
                    .and_then(|r| r.get("service_id"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("backend-service")
                    .to_string()
            } else {
                "backend-service".to_string()
            }
        } else {
            current_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("backend-service")
                .to_string()
        }
    } else {
        current_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("backend-service")
            .to_string()
    };

    // 2. Resolve out path
    let out_path = if let Some(ref o) = args.out {
        o.clone()
    } else if let Some(ref sdir) = sajimora_dir {
        sdir.join("telemetry.json")
    } else {
        PathBuf::from("telemetry.json")
    };

    // 3. Resolve JaCoCo file
    let jacoco_path = if let Some(j) = args.jacoco {
        if !j.exists() {
            return Err(anyhow!("JaCoCo file does not exist: {:?}", j));
        }
        Some(j)
    } else {
        let candidates = [
            current_dir.join("target/site/jacoco/jacoco.xml"),
            current_dir.join("build/reports/jacoco/test/jacocoTestReport.xml"),
            current_dir.join("sample-jacoco.xml"),
            current_dir.join("jacoco.xml"),
        ];
        candidates.into_iter().find(|p| p.exists())
    };

    // 4. Resolve OTel trace file
    let otel_path = if let Some(o) = args.otel {
        if !o.exists() {
            return Err(anyhow!("OTel trace file does not exist: {:?}", o));
        }
        Some(o)
    } else {
        let candidates = [
            current_dir.join("sample-otel.json"),
            current_dir.join("otel.json"),
            current_dir.join("traces.json"),
        ];
        candidates.into_iter().find(|p| p.exists())
    };

    if let Some(ref hits_path) = args.hits {
        if !hits_path.exists() {
            return Err(anyhow!("Hits file does not exist: {:?}", hits_path));
        }
        let trust_policy: Option<contract_core::admission::ArtifactTrustPolicy> = args
            .trust_policy
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok());

        println!(
            "\n📡 Ingesting production hit count telemetry from: {:?}",
            hits_path
        );
        let hits_env = telemetry_core::ingest_hit_counts(hits_path, trust_policy.as_ref(), 90, 30)?;
        let hits_json = serde_json::to_string_pretty(&hits_env)?;
        let hits_out = if args.out.is_some() {
            out_path.clone()
        } else if let Some(ref sdir) = sajimora_dir {
            sdir.join("telemetry-hits.json")
        } else {
            PathBuf::from("telemetry-hits.json")
        };
        write_atomic(&hits_out, &hits_json)?;
        println!(
            "  [OK] Telemetry hit counts verified and written to: {:?}",
            hits_out
        );

        if jacoco_path.is_none() && otel_path.is_none() {
            return Ok(hits_out);
        }
    }

    if jacoco_path.is_none() && otel_path.is_none() {
        return Err(anyhow!(
            "No telemetry or coverage sources found.\n\
             Provide explicit paths: sajimora build-telemetry --jacoco <path> --otel <path> --hits <path>\n\
             or place `sample-jacoco.xml` / `sample-otel.json` in the project."
        ));
    }

    println!(
        "\n📡 Building sealed telemetry envelope for service: {}",
        service_id
    );

    let jacoco_reader = if let Some(ref jpath) = jacoco_path {
        println!("  [OK] Ingesting JaCoCo coverage from: {:?}", jpath);
        Some(BufReader::new(File::open(jpath)?))
    } else {
        None
    };

    let otel_reader = if let Some(ref opath) = otel_path {
        println!("  [OK] Ingesting OpenTelemetry spans from: {:?}", opath);
        Some(BufReader::new(File::open(opath)?))
    } else {
        None
    };

    let builder = TelemetryBuilder::new(&service_id).with_api_version(args.api_version.as_deref());

    let envelope = builder.build(jacoco_reader, otel_reader)?;

    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| anyhow!("Failed to serialize telemetry envelope: {}", e))?;

    write_atomic(&out_path, &json)?;
    Ok(out_path)
}

fn find_sajimora_dir(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut curr = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        let sajimora = curr.join(".sajimora");
        if sajimora.is_dir() {
            return Some((curr, sajimora));
        }
        if !curr.pop() {
            break;
        }
    }

    None
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
    let result = unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
