//! change_evaluate.rs — native CLI command for Expected Change Model evaluation.

use anyhow::{Context, Result};
use clap::Args;
use source_index::change_eval::{
    evaluate, render_report, resolve_output_path, summary_line, write_report, EvaluationRequest,
};
use source_index::endpoint_impact::resolve_repo_root;
use std::path::{Path, PathBuf};

#[derive(Args, Debug)]
pub struct ChangeEvaluateArgs {
    /// Expected Change Model JSON document.
    #[arg(long)]
    pub ecm: PathBuf,

    /// Repository root; revisions resolve here.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Base revision override; defaults to the ECM's base revision.
    #[arg(long)]
    pub base: Option<String>,

    /// Candidate revision override; defaults to the ECM's candidate revision.
    #[arg(long)]
    pub candidate: Option<String>,

    /// Report destination. Defaults to .sajimora/change-evaluation.json; relative
    /// paths resolve against the current directory.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Exit 0 whenever a report was produced, including reports that classify
/// mutations as unintended regressions. Exit 2 means no report could be
/// produced (usage, ECM validation, configuration, or Git failure).
pub fn run(args: ChangeEvaluateArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("change-evaluate: {error:#}");
            2
        }
    }
}

fn run_inner(args: ChangeEvaluateArgs) -> Result<()> {
    let repo_root = resolve_repo_root(&absolute(&args.repo)?, &[])?;
    let ecm_path = absolute(&args.ecm)?;
    let out = resolve_output_path(
        &repo_root,
        args.out.as_deref().map(absolute).transpose()?.as_deref(),
        &[],
    )?;
    let request = EvaluationRequest {
        repo_root,
        ecm_path,
        base_override: args.base,
        candidate_override: args.candidate,
    };
    let report = evaluate(&[], &request).context("Change evaluation failed")?;
    write_report(&out, &render_report(&report)?)?;
    eprintln!("{}", summary_line(&report));
    eprintln!("Wrote {}", out.display());
    Ok(())
}

fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()
            .context("Cannot read the current directory")?
            .join(path))
    }
}
