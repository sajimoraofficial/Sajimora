//! sajimora gen-unit — Bounded Symbolic Unit Test Synthesizer.
//!
//! Autonomous branch test generation for internal business calculation logic.
//! Solves path conditions via Tier 1 SMT solver and enforces strict 2-hop mock budget.

use anyhow::{Context, Result};
use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use verifier::symbolic::synthesize_unit_tests_for_java;

#[derive(Args, Debug, Clone)]
pub struct GenUnitArgs {
    /// Positional shorthand for target file (e.g. `sajimora unit Calculator.java`)
    #[arg(value_name = "TARGET_FILE")]
    pub target_file: Option<String>,

    /// Target Java source file containing business methods (e.g. "src/main/java/com/example/DiscountService.java")
    #[arg(long, short)]
    pub file: Option<String>,

    /// Optional specific method name to synthesize tests for
    #[arg(long, short)]
    pub method: Option<String>,

    /// Destination file for synthesized JUnit 5 test class (auto-derived if omitted)
    #[arg(long, short)]
    pub out: Option<String>,

    /// Solver wall-clock budget per method in milliseconds (default: 50)
    #[arg(long, default_value = "50")]
    pub budget_ms: u64,

    /// Emit structured JSON diagnostics to stdout
    #[arg(long)]
    pub json: bool,

    /// Verbose progress logging
    #[arg(long, short)]
    pub verbose: bool,
}

pub fn run(args: GenUnitArgs) -> i32 {
    let start = Instant::now();
    let file_str = match args.file.as_deref().or(args.target_file.as_deref()) {
        Some(f) => f,
        None => {
            eprintln!("Error: Target file required (e.g. `sajimora unit Calculator.java` or `--file <path>`)");
            return 1;
        }
    };
    let source_path = Path::new(file_str);

    if !source_path.exists() {
        eprintln!("Error: Target file not found: {}", file_str);
        return 1;
    }

    if source_path.extension().and_then(|e| e.to_str()) != Some("java") {
        if args.json {
            println!(
                "{}",
                serde_json::json!({
                    "status": "UNSUPPORTED_LANGUAGE",
                    "file": file_str,
                    "message": "Symbolic unit test synthesis is currently active for Java (.java). TypeScript synthesis is in preview.",
                    "available_commands": ["sajimora check", "sajimora impact", "sajimora ask"]
                })
            );
            return 1;
        }
        eprintln!(
            "\n[sajimora] Formal symbolic unit test synthesis is currently specialized for Java (.java).\n\
             TypeScript/Python test synthesis is previewing in the upcoming release with Sajimora-Coder-32B!\n\n\
             Tip: You can verify and inspect your TypeScript code right now with:\n  \
             • sajimora check      (Full cross-language contract verification)\n  \
             • sajimora impact     (Call-graph blast radius)\n  \
             • sajimora ask        (Architectural insights and code queries)\n"
        );
        return 1;
    }

    let source = match fs::read_to_string(source_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error: Failed to read file {}: {:#}", file_str, e);
            return 1;
        }
    };

    let mut suite =
        match synthesize_unit_tests_for_java(&source, args.method.as_deref(), args.budget_ms) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Error during symbolic test synthesis: {:#}", e);
                return 1;
            }
        };

    // Determine output file destination (explicit --out or auto-derived from input file)
    let destination_path = if let Some(out_path_str) = &args.out {
        Some(PathBuf::from(out_path_str))
    } else if !args.json {
        let parent = source_path.parent().unwrap_or(Path::new(""));
        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Generated");
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("java");
        let parent_str = parent.to_string_lossy();
        let derived =
            if parent_str.contains("src/main/java") || parent_str.contains("src\\main\\java") {
                let test_parent_str = parent_str
                    .replace("src/main/java", "src/test/java")
                    .replace("src\\main\\java", "src/test/java");
                PathBuf::from(test_parent_str).join(format!("{}Test.{}", stem, ext))
            } else {
                parent.join(format!("{}Test.{}", stem, ext))
            };
        Some(derived)
    } else {
        None
    };

    if let Some(ref out_path) = destination_path {
        // javac requires the public class name to match the file name; a caller-chosen `--out`
        // therefore renames the generated class rather than producing an uncompilable file.
        if let Some(stem) = out_path.file_stem().and_then(|stem| stem.to_str()) {
            if !stem.is_empty() && stem != suite.test_class_name {
                suite.test_source_code = suite.test_source_code.replace(
                    &format!("public class {}", suite.test_class_name),
                    &format!("public class {stem}"),
                );
                suite.test_class_name = stem.to_string();
            }
        }
        if let Err(e) = write_atomic(out_path, &suite.test_source_code) {
            eprintln!("Error: Failed to write test file {:?}: {:#}", out_path, e);
            return 1;
        }
    }

    if args.json {
        let json_output = serde_json::to_string_pretty(&suite).unwrap_or_default();
        println!("{}", json_output);
    } else {
        println!("============================================================");
        println!("  Sajimora Bounded Symbolic Test Synthesizer (Tier 1 SMT)   ");
        println!("============================================================");
        println!("Target Class: {}", suite.class_name);
        println!("Generated Test Suite: {}", suite.test_class_name);
        println!(
            "Branches Synthesized: {} (elapsed: {}ms)",
            suite.branches_synthesized.len(),
            start.elapsed().as_millis()
        );

        for branch in &suite.branches_synthesized {
            let inputs_str = branch
                .inputs
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join(", ");
            println!(
                "  ✓ [{}] {} -> inputs: [{}]",
                branch.branch_type, branch.condition_expr, inputs_str
            );
        }

        if !suite.abstentions.is_empty() {
            println!("\nAbstentions ({}):", suite.abstentions.len());
            for a in &suite.abstentions {
                println!(
                    "  ⚠️ [{}] Method `{}` (branch #{}): {}",
                    a.code, a.method_name, a.branch_id, a.reason
                );
            }
        }

        if let Some(out_path) = &args.out {
            println!(
                "\nSuccessfully wrote synthesized unit tests to: {}",
                out_path
            );
        }
    }

    // An empty/diagnostic-only artifact is not successful unit test generation.
    if suite.branches_synthesized.is_empty() {
        1
    } else {
        0
    }
}

/// Atomically writes content to a file via a temporary peer file and MoveFileExW/rename.
fn write_atomic(dest: &Path, content: &str) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create parent directory for {:?}", dest))?;
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_file = dest.with_file_name(format!(
        ".sajimora_unit_{}_{}.tmp",
        std::process::id(),
        nanos
    ));

    fs::write(&temp_file, content)
        .with_context(|| format!("Failed to write temporary file {:?}", temp_file))?;

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut from_wide: Vec<u16> = temp_file.as_os_str().encode_wide().collect();
        from_wide.push(0);
        let mut to_wide: Vec<u16> = dest.as_os_str().encode_wide().collect();
        to_wide.push(0);

        const MOVEFILE_REPLACE_EXISTING: u32 = 0x00000001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x00000008;

        extern "system" {
            fn MoveFileExW(
                lpExistingFileName: *const u16,
                lpNewFileName: *const u16,
                dwFlags: u32,
            ) -> i32;
        }

        let ret = unsafe {
            MoveFileExW(
                from_wide.as_ptr(),
                to_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };

        if ret == 0 {
            let err = std::io::Error::last_os_error();
            let _ = fs::remove_file(&temp_file);
            return Err(err).context("MoveFileExW failed during atomic test generation write");
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(&temp_file, dest)
            .with_context(|| format!("Failed to rename {:?} to {:?}", temp_file, dest))?;
    }

    Ok(())
}
