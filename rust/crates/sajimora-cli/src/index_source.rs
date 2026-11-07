use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct IndexSourceArgs {
    /// Hash-check all sealed cache sources before an incremental update.
    #[arg(long, requires = "incremental")]
    verify_cache: bool,
    /// Build a new commit in this database, reusing immutable source and syntax units.
    #[arg(long, conflicts_with = "resume")]
    incremental: bool,
    /// Aggregate private-commit hard cap on Windows, including supervisor and children.
    #[arg(long, default_value_t = 1024)]
    tree_memory_mib: usize,
    /// Revalidate and continue the same immutable build; never changes its identity.
    #[arg(long)]
    resume: bool,
    /// Also build isolated Java structural facts; full semantic analysis remains pending.
    #[arg(long)]
    parse_java: bool,
    #[arg(long, default_value_t = 30000)]
    java_timeout_ms: u64,
    #[arg(long, default_value_t = 192)]
    java_memory_mib: usize,
    #[arg(long)]
    repo: PathBuf,
    #[arg(long, default_value = "HEAD")]
    revision: String,
    /// New database, or existing database with --resume/--incremental.
    #[arg(long)]
    database: PathBuf,
    /// Source-capture admission limit; larger files remain explicit blockers.
    #[arg(long, default_value_t = 64 * 1024 * 1024)]
    max_blob_bytes: u64,
}

pub fn run(args: IndexSourceArgs) -> i32 {
    let _lease = match source_index::budget::BuildLease::acquire(&args.database) {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("index-source lease failed: {error:#}");
            return 1;
        }
    };
    let budget = match source_index::budget::ProcessBudget::enforce(args.tree_memory_mib) {
        Ok(budget) => budget,
        Err(error) => {
            eprintln!("index-source memory enforcement failed: {error:#}");
            return 1;
        }
    };
    if args.verify_cache {
        if let Err(error) = source_index::verify_cache(&args.database) {
            eprintln!("cache verification failed: {error:#}");
            return 1;
        }
    }
    let capture = if args.incremental {
        source_index::capture_incremental(
            &args.repo,
            &args.revision,
            &args.database,
            args.max_blob_bytes,
        )
    } else {
        source_index::capture_with_resume(
            &args.repo,
            &args.revision,
            &args.database,
            args.max_blob_bytes,
            args.resume,
        )
    };
    match capture {
        Ok(mut metrics) => {
            if args.parse_java {
                let result = std::env::current_exe()
                    .map_err(anyhow::Error::from)
                    .and_then(|executable| {
                        source_index::java::index_build(
                            &args.database,
                            &metrics.build_id,
                            &executable,
                            args.java_timeout_ms,
                            args.java_memory_mib,
                            args.max_blob_bytes,
                        )
                    });
                match result {
                    Ok(java) => {
                        if let Err(error) = source_index::incremental::publish(
                            &args.database,
                            &metrics.build_id,
                            true,
                        ) {
                            eprintln!("index publication failed: {error:#}");
                            return 1;
                        }
                        let changes = match source_index::incremental::changes(
                            &args.database,
                            &metrics.build_id,
                        ) {
                            Ok(changes) => changes,
                            Err(error) => {
                                eprintln!("incremental reporting failed: {error:#}");
                                return 1;
                            }
                        };
                        metrics.syntax_parsing_implemented = true;
                        let memory = match budget.report() {
                            Ok(report) => report,
                            Err(error) => {
                                eprintln!("memory reporting failed: {error:#}");
                                return 1;
                            }
                        };
                        println!(
                            "{}",
                            serde_json::json!({"capture":metrics,"java":java,"state":"INCOMPLETE","process_tree_memory":memory,"incremental":changes})
                        );
                        return 0;
                    }
                    Err(error) => {
                        eprintln!("Java indexing failed: {error:#}");
                        return 1;
                    }
                }
            }
            if let Err(error) =
                source_index::incremental::publish(&args.database, &metrics.build_id, false)
            {
                eprintln!("index publication failed: {error:#}");
                return 1;
            }
            println!(
                "{}",
                serde_json::to_string(&metrics).expect("serializable metrics")
            );
            0
        }
        Err(error) => {
            eprintln!("index-source failed: {error:#}");
            1
        }
    }
}

#[derive(Args)]
pub struct JavaWorkerArgs {
    #[arg(long)]
    database: PathBuf,
}
pub fn worker(args: JavaWorkerArgs) -> i32 {
    match source_index::java::worker(&args.database) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Java worker failed: {error:#}");
            1
        }
    }
}
