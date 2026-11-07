//! Separate release pilot binary preserves the existing artifact checker executable.
mod index_source;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "sajimora-source-pilot", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(hide = true)]
    JavaWorker(index_source::JavaWorkerArgs),
    /// Bounded immutable source capture and optional isolated Java structural indexing.
    IndexSource(index_source::IndexSourceArgs),
}

fn main() {
    let code = match Cli::parse().command {
        Commands::JavaWorker(args) => index_source::worker(args),
        Commands::IndexSource(args) => index_source::run(args),
    };
    std::process::exit(code);
}
