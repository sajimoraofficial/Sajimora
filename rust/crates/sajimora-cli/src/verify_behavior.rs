//! sajimora verify-behavior — Bounded Differential Regression Gate (Bisimulation).
//!
//! Catches calculation logic regressions across dual Git/file revisions.
//! Solves path conditions to produce formal equivalence proofs or cryptographic SHA-256 counterexample witnesses.

use clap::Args;
use std::fs;
use std::path::Path;
use verifier::bisim::{verify_method_behavior, BehaviorVerdict};

fn get_git_head_content(rel_path: &str) -> Option<String> {
    let norm = rel_path.replace('\\', "/");
    let output = std::process::Command::new("git")
        .args(["show", &format!("HEAD:{}", norm)])
        .output()
        .ok();
    if let Some(out) = output {
        if out.status.success() {
            if let Ok(content) = String::from_utf8(out.stdout) {
                return Some(content);
            }
        }
    }
    // SVN fallback: svn cat -r BASE <rel_path> or svn cat <rel_path>
    let svn_out = std::process::Command::new("svn")
        .args(["cat", "-r", "BASE", &norm])
        .output()
        .ok();
    if let Some(out) = svn_out {
        if out.status.success() {
            if let Ok(content) = String::from_utf8(out.stdout) {
                return Some(content);
            }
        }
    }
    let svn_out2 = std::process::Command::new("svn")
        .args(["cat", &norm])
        .output()
        .ok();
    if let Some(out) = svn_out2 {
        if out.status.success() {
            return String::from_utf8(out.stdout).ok();
        }
    }
    None
}

#[derive(Args, Debug, Clone)]
pub struct VerifyBehaviorArgs {
    /// Positional shorthand for candidate file (e.g. `sajimora diff Calculator.java`)
    #[arg(value_name = "TARGET_FILE")]
    pub target_file: Option<String>,

    /// Base revision file path (e.g. "src/main/java/FeeCalculator.java.orig" or defaults to Git HEAD)
    #[arg(long, short)]
    pub base: Option<String>,

    /// Candidate revision file path (e.g. "src/main/java/FeeCalculator.java")
    #[arg(long, short)]
    pub candidate: Option<String>,

    /// Target method name to verify for behavioral equivalence (verifies all methods if omitted)
    #[arg(long, short)]
    pub method: Option<String>,

    /// Wall-clock solver budget per method in milliseconds (default: 50)
    #[arg(long, default_value = "50")]
    pub budget_ms: u64,

    /// Strict mode: require sound mathematical proof of equivalence (fail on bounded advisory or unknown)
    #[arg(long, short = 's')]
    pub strict: bool,

    /// Emit structured JSON report to stdout
    #[arg(long)]
    pub json: bool,

    /// Verbose logging
    #[arg(long, short = 'v')]
    pub verbose: bool,
}

pub fn run(args: VerifyBehaviorArgs) -> i32 {
    let cand_file = match args.candidate.as_deref().or(args.target_file.as_deref()) {
        Some(f) => f,
        None => {
            eprintln!("Error: Candidate file required (e.g. `sajimora diff Calculator.java` or `--candidate <file>`)");
            return 1;
        }
    };
    let cand_path = Path::new(cand_file);
    if !cand_path.exists() {
        eprintln!("Error: Candidate file not found: {}", cand_file);
        return 1;
    }

    if cand_path.extension().and_then(|e| e.to_str()) != Some("java") {
        if args.json {
            println!(
                "{}",
                serde_json::json!({
                    "status": "UNSUPPORTED_LANGUAGE",
                    "file": cand_file,
                    "message": "Behavioral bisimulation is currently active for Java (.java). TypeScript equivalence verification is in preview.",
                    "available_commands": ["sajimora check", "sajimora impact", "sajimora ask"]
                })
            );
            return 1;
        }
        eprintln!(
            "\n[sajimora] Formal behavioral equivalence (bisimulation) is currently specialized for Java (.java).\n\
             TypeScript behavioral equivalence is previewing in the upcoming release with Sajimora-Coder-32B!\n\n\
             Tip: You can detect interface regressions and breaking changes right now with:\n  \
             • sajimora check      (Full cross-language contract verification)\n  \
             • sajimora impact     (Call-graph and endpoint blast radius)\n"
        );
        return 1;
    }

    let cand_src = match fs::read_to_string(cand_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "Error: Failed to read candidate file {}: {:#}",
                cand_file, e
            );
            return 1;
        }
    };

    let base_label: String;
    let base_src = if let Some(ref base_file) = args.base {
        let base_path = Path::new(base_file);
        if !base_path.exists() {
            eprintln!("Error: Base file not found: {}", base_file);
            return 1;
        }
        base_label = base_file.clone();
        match fs::read_to_string(base_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Error: Failed to read base file {}: {:#}", base_file, e);
                return 1;
            }
        }
    } else {
        base_label = format!("HEAD:{}", cand_file);
        match get_git_head_content(cand_file) {
            Some(s) => s,
            None => {
                eprintln!("Error: Base file not specified and could not be retrieved from Git HEAD or SVN BASE. Use --base <path>.");
                return 1;
            }
        }
    };

    let target_methods: Vec<String> = match args.method.as_deref() {
        Some(m) => vec![m.to_string()],
        None => {
            if let Ok(sigs) =
                source_index::signature_diff::extract_java_method_signatures(&cand_src)
            {
                let mut list = Vec::new();
                for s in sigs {
                    if !list.contains(&s.method_name) {
                        list.push(s.method_name);
                    }
                }
                if list.is_empty() {
                    eprintln!(
                        "Error: No methods found in candidate file. Specify --method <name>."
                    );
                    return 1;
                }
                list
            } else {
                eprintln!("Error: Method name required. Specify --method <name>.");
                return 1;
            }
        }
    };

    let mut verdicts = Vec::new();
    let mut any_failure = false;

    for target_method in &target_methods {
        let verdict = verify_method_behavior(
            cand_file,
            target_method,
            &base_src,
            &cand_src,
            &base_label,
            cand_file,
            args.budget_ms,
        );

        let is_fail = match &verdict {
            BehaviorVerdict::Counterexample(_) => true,
            BehaviorVerdict::SignatureMismatch { .. } => true,
            BehaviorVerdict::Unknown { .. } => args.strict,
            BehaviorVerdict::LikelyEquivalentBounded { .. } => args.strict,
            BehaviorVerdict::SoundProofOfEquivalence { .. } => false,
        };

        if is_fail {
            any_failure = true;
        }

        verdicts.push((target_method.clone(), verdict));
    }

    if args.json {
        let json_val = if target_methods.len() == 1 {
            serde_json::to_string_pretty(&verdicts[0].1).unwrap_or_default()
        } else {
            serde_json::to_string_pretty(&verdicts).unwrap_or_default()
        };
        println!("{}", json_val);
    } else {
        println!("============================================================");
        println!("  Sajimora Bounded Differential Behavior Gate (Bisimulation)");
        println!("============================================================");
        println!("Base: {}", base_label);
        println!("Candidate: {}", cand_file);
        println!("Methods Analyzed: {}", verdicts.len());
        println!("------------------------------------------------------------");

        for (method_name, verdict) in &verdicts {
            println!("\n[Method: {}]", method_name);
            match verdict {
                BehaviorVerdict::SoundProofOfEquivalence {
                    paths_evaluated,
                    proof_axioms,
                    ..
                } => {
                    println!("  ✅ SOUND PROOF OF EQUIVALENCE");
                    println!(
                        "     Mathematically identical across all {} evaluated paths.",
                        paths_evaluated
                    );
                    println!("     Proof Axiom: {}", proof_axioms);
                }
                BehaviorVerdict::Counterexample(witness) => {
                    println!("  ❌ BEHAVIORAL REGRESSION DETECTED (COUNTEREXAMPLE)");
                    println!("     Produces diverging outputs on identical input!");
                    println!("     Inputs: {:?}", witness.inputs);
                    println!("     Base Output (R-1):      {}", witness.base_output);
                    println!("     Candidate Output (R):  {}", witness.candidate_output);
                    println!(
                        "     Base Path Condition:    {}",
                        witness.base_path_condition
                    );
                    println!(
                        "     Candidate Condition:    {}",
                        witness.candidate_path_condition
                    );
                    println!("     Cryptographic Witness:  {}", witness.witness_sha256);
                }
                BehaviorVerdict::LikelyEquivalentBounded {
                    paths_evaluated,
                    reason,
                    ..
                } => {
                    println!("  ⚠️ LIKELY EQUIVALENT (BOUNDED ADVISORY)");
                    println!(
                        "     No diverging paths found across {} paths within budget.",
                        paths_evaluated
                    );
                    println!("     Reason: {}", reason);
                }
                BehaviorVerdict::SignatureMismatch { reason, .. } => {
                    println!("  ⚠️ SIGNATURE MISMATCH");
                    println!("     {}", reason);
                }
                BehaviorVerdict::Unknown { reason, .. } => {
                    println!("  ⚠️ VERIFICATION INCONCLUSIVE (UNKNOWN)");
                    println!("     {}", reason);
                }
            }
        }
    }

    if any_failure {
        1
    } else {
        0
    }
}
