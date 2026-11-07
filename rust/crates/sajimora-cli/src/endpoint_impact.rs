//! endpoint_impact.rs — native CLI command for advisory endpoint impact.

use anyhow::{bail, Context, Result};
use clap::Args;
use source_index::endpoint_impact::{
    analyze, render_report, resolve_output_path, resolve_repo_root, summary_line, write_report,
    ImpactMode, ImpactRequest,
};
use std::path::{Path, PathBuf};

#[derive(Args, Debug)]
pub struct EndpointImpactArgs {
    /// Repository root that contains .sajimora/init-manifest.json.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// workingTreeVsHead (default), stagedVsHead, or commitRange.
    #[arg(long, default_value = "workingTreeVsHead")]
    pub mode: String,

    /// <base>..<candidate> for --mode commitRange.
    #[arg(long)]
    pub commit_range: Option<String>,

    /// Base revision for --mode commitRange; alternative to --commit-range.
    #[arg(long, conflicts_with = "commit_range")]
    pub base: Option<String>,

    /// Candidate revision for --mode commitRange; used together with --base.
    #[arg(long, conflicts_with = "commit_range")]
    pub candidate: Option<String>,

    /// Generated test file to scan for synthesis markers. Repeatable; relative
    /// paths resolve against the current directory.
    #[arg(long = "generated-tests", action = clap::ArgAction::Append)]
    pub generated_tests: Vec<PathBuf>,

    /// Report destination. Defaults to .sajimora/endpoint-impact.json; relative
    /// paths resolve against the current directory.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Exit 0 whenever a report was produced. Exit 2 means no report could be
/// produced (usage, configuration, or Git failure); findings never fail.
pub fn run(args: EndpointImpactArgs) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("endpoint-impact: {error:#}");
            2
        }
    }
}

fn run_inner(args: EndpointImpactArgs) -> Result<()> {
    let mode = ImpactMode::parse(&args.mode)?;
    let commit_range = match (args.commit_range, args.base, args.candidate) {
        (Some(range), None, None) => Some(range),
        (None, Some(base), Some(candidate)) => Some(format!("{base}..{candidate}")),
        (None, None, None) => None,
        (None, Some(_), None) => bail!("--base requires --candidate"),
        (None, None, Some(_)) => bail!("--candidate requires --base"),
        (Some(_), _, _) => unreachable!("clap rejects --commit-range with --base/--candidate"),
    };
    if mode != ImpactMode::CommitRange && commit_range.is_some() {
        bail!("--commit-range, --base, and --candidate are only accepted with --mode commitRange");
    }
    let repo_root = resolve_repo_root(&absolute(&args.repo)?, &[])?;
    let out = resolve_output_path(
        &repo_root,
        args.out.as_deref().map(absolute).transpose()?.as_deref(),
        &[],
    )?;
    let generated_tests = args
        .generated_tests
        .iter()
        .map(|path| absolute(path))
        .collect::<Result<Vec<_>>>()?;
    let request = ImpactRequest {
        repo_root: repo_root.clone(),
        mode,
        commit_range,
        generated_tests,
    };
    let report = analyze(&[], &request).context("Endpoint impact analysis failed")?;
    write_report(&out, &render_report(&report))?;
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
