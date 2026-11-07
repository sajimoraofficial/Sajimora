//! sajimora-mcp — MCP stdio adapter binary for Sajimora contract checks.

use clap::Parser;
use rmcp::ServiceExt;
use sajimora_mcp::server::{McpServerConfig, SajimoraMcpServer};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "sajimora-mcp",
    version,
    about = "Sajimora MCP stdio server — exposes sajimora_check_contract and sajimora_verify tools"
)]
struct Args {
    /// Allowed filesystem roots for artifact path resolution (repeated).
    #[arg(long = "allowed-root")]
    allowed_roots: Vec<PathBuf>,

    /// Path to trust policy JSON file.
    #[arg(long, conflicts_with = "trusted_local")]
    trust_policy: Option<PathBuf>,

    /// Enable trusted-local mode (server startup decision).
    #[arg(long, conflicts_with = "trust_policy")]
    trusted_local: bool,

    /// Maximum concurrent check-contract jobs (default: 4).
    #[arg(long, default_value = "4")]
    max_concurrent_jobs: usize,

    /// Require service mapping for relative routes (default: true).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    require_service_mapping: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Diagnostics must always go to stderr to preserve stdio MCP protocol framing on stdout!
    eprintln!(
        "sajimora-mcp: starting stdio server (trusted_local={}, allowed_roots={})",
        args.trusted_local,
        args.allowed_roots.len()
    );

    let config = McpServerConfig {
        allowed_roots: args.allowed_roots,
        trust_policy_path: args.trust_policy,
        trusted_local: args.trusted_local,
        max_concurrent_jobs: args.max_concurrent_jobs,
        require_service_mapping: args.require_service_mapping,
    };

    let server_handler = SajimoraMcpServer::new(config);
    let server = server_handler.serve(rmcp::transport::stdio()).await?;

    // Wait until client disconnects (stdin EOF) or server closes
    if let Err(e) = server.waiting().await {
        eprintln!("sajimora-mcp: session ended: {}", e);
    }

    eprintln!("sajimora-mcp: server exited cleanly");
    Ok(())
}
