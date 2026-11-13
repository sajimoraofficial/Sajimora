//! sajimora-cli — Native Rust CLI entry point.
//!
//! Provides:
//!   sajimora check-contract --base <path> --candidate <path> --target <path>...
//!                           (--trust-policy <path> | --trusted-local) [--out <path>]
//!   sajimora --help
//!   sajimora --version
//!
//! Phase R1: admission validation and placeholder comparison output.
//! Phase R3: full CLI with subprocess tests.

mod ask;
mod apply;
mod build_telemetry;
mod change_evaluate;
mod check_contract;
mod clean;
mod dashboard;
mod doctor;
mod endpoint_impact;
mod extract_backend;
mod extract_frontend;
mod gen_unit;
mod generate_tests;
mod heal;
mod index_source;
mod init;
mod init_hook;
mod invariants;
mod keygen;
mod query;
pub mod remote;
mod run;
mod sign;
mod verify;
mod verify_behavior;
mod verify_envelope;
mod what_if;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "sajimora",
    version,
    about = "Sajimora — Deterministic Cross-Language Contract Verification & Autonomous Test Synthesis",
    after_help = "⚡ DEVELOPER QUICKSTART ALIASES:\n  sajimora run                  Run full end-to-end verification pipeline in 1 command\n  sajimora check                 Verify API contracts (Spring Boot <-> TypeScript)\n  sajimora fix [file|method]     Auto-heal broken test call sites after refactoring\n  sajimora patch                 Apply consumer-side patches for a DTO mutation\n  sajimora unit <file>           Synthesize branch unit tests for a service\n  sajimora props <file>          Synthesize metamorphic property tests\n  sajimora diff [file]           Verify behavioral equivalence across revisions\n  sajimora doctor                Health check & configuration diagnostics\n"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(hide = true)]
    JavaWorker(index_source::JavaWorkerArgs),
    /// Experimental streamed Git source capture; Java syntax parsing is pending.
    IndexSource(index_source::IndexSourceArgs),
    /// Check contract compatibility between base, candidate, and target artifacts.
    CheckContract(check_contract::CheckContractArgs),
    /// Extract backend contract artifact from Java/Spring sources.
    ExtractBackend(extract_backend::ExtractBackendArgs),
    /// Extract frontend contract artifact from TypeScript/JavaScript client applications.
    ExtractFrontend(extract_frontend::ExtractFrontendArgs),
    /// Build sealed telemetry artifact from JaCoCo XML and OpenTelemetry spans.
    BuildTelemetry(build_telemetry::BuildTelemetryArgs),
    /// Synthesize property tests (jqwik or fast-check) from contract artifact schemas.
    GenerateTests(generate_tests::GenerateTestsArgs),
    /// Automatically initialize Sajimora in a repository, extract contracts, update package.json, and install git hooks.
    Init(init::InitArgs),
    /// Safely revert Sajimora initialization, restoring original hooks and cleaning package.json.
    Clean(clean::CleanArgs),
    /// Install the Sajimora pre-commit hook (advisory by default, --blocking to enforce).
    InitHook(init_hook::InitHookArgs),
    /// Verify repository setup health, manifest status, and contract artifact integrity.
    Doctor(doctor::DoctorArgs),
    /// Run one-command contract verification against frontend client contracts (pure native, zero npm/Node).
    #[command(alias = "analyze", alias = "check", alias = "ci")]
    Verify(verify::VerifyArgs),
    /// Display interactive terminal contract health dashboard or open web dashboard.
    #[command(alias = "status")]
    Dashboard(dashboard::DashboardArgs),
    /// Generate an Ed25519 keypair and a matching artifact trust policy.
    Keygen(keygen::KeygenArgs),
    /// Cryptographically sign a contract artifact envelope using an Ed25519 private key.
    Sign(sign::SignArgs),
    /// Verify the integrity and Ed25519 signature of a contract artifact envelope.
    VerifyEnvelope(verify_envelope::VerifyEnvelopeArgs),
    /// Automatically heal broken test call-sites after method signature refactoring.
    #[command(alias = "fix", alias = "repair")]
    Heal(heal::HealArgs),
    /// Synthesize property-based metamorphic invariant tests (jqwik or fast-check) for internal services.
    #[command(alias = "invariants", alias = "props")]
    GenInvariants(invariants::GenInvariantsArgs),
    /// Autonomous bounded symbolic branch test synthesizer with Tier 1 SMT solver and 2-hop mock budget.
    #[command(alias = "unit", alias = "gen")]
    GenUnit(gen_unit::GenUnitArgs),
    /// Bounded differential behavioral equivalence regression gate across dual revisions.
    #[command(alias = "diff", alias = "bisim")]
    VerifyBehavior(verify_behavior::VerifyBehaviorArgs),
    /// Advisory endpoint impact: map a Git change set to provider endpoints, sealed frontend call sites, and synthesis markers. Writes .sajimora/endpoint-impact.json; never selects tests or blocks a merge.
    EndpointImpact(endpoint_impact::EndpointImpactArgs),
    /// Evaluate a declared Expected Change Model against the structural Git change set between two revisions. Writes .sajimora/change-evaluation.json; never selects tests or blocks a merge.
    ChangeEvaluate(change_evaluate::ChangeEvaluateArgs),
    /// Ask natural language questions about contracts, pagination, and performance (100% offline, zero LLM).
    #[command(alias = "question", alias = "explain")]
    Ask(ask::AskArgs),
    /// Sub-second query engine for consumer contracts, routes, and DTO catalog statistics.
    #[command(alias = "find", alias = "lookup")]
    Query(query::QueryArgs),
    /// Sub-second 'what-if' simulation for in-memory DTO mutations and breaking-change detection.
    #[command(alias = "simulate", alias = "mutate")]
    WhatIf(what_if::WhatIfArgs),
    /// Deterministically apply consumer-side patches (TypeScript client-models, Angular templates) for a DTO mutation.
    #[command(alias = "patch", alias = "apply-patches")]
    Apply(apply::ApplyArgs),
    /// Run the full unified end-to-end Sajimora verification pipeline in one command.
    #[command(alias = "all", alias = "pipeline")]
    Run(run::RunArgs),
}

fn main() {
    let cli = Cli::parse();
    let exit_code = match cli.command {
        Commands::JavaWorker(args) => index_source::worker(args),
        Commands::IndexSource(args) => index_source::run(args),
        Commands::CheckContract(args) => check_contract::run(args),
        Commands::ExtractBackend(args) => extract_backend::run(args),
        Commands::ExtractFrontend(args) => extract_frontend::run(args),
        Commands::BuildTelemetry(args) => build_telemetry::run(args),
        Commands::GenerateTests(args) => generate_tests::run(args),
        Commands::Init(args) => init::run(args),
        Commands::Clean(args) => clean::run(args),
        Commands::InitHook(args) => init_hook::run(args),
        Commands::Doctor(args) => doctor::run(args),
        Commands::Verify(args) => verify::run(args),
        Commands::Dashboard(args) => dashboard::run(args),
        Commands::Keygen(args) => keygen::run(args),
        Commands::Sign(args) => sign::run(args),
        Commands::VerifyEnvelope(args) => verify_envelope::run(args),
        Commands::Heal(args) => heal::run(args),
        Commands::GenInvariants(args) => invariants::run(args),
        Commands::GenUnit(args) => gen_unit::run(args),
        Commands::VerifyBehavior(args) => verify_behavior::run(args),
        Commands::EndpointImpact(args) => endpoint_impact::run(args),
        Commands::ChangeEvaluate(args) => change_evaluate::run(args),
        Commands::Ask(args) => ask::run(args),
        Commands::Query(args) => query::run(args),
        Commands::WhatIf(args) => what_if::run(args),
        Commands::Apply(args) => apply::run(args),
        Commands::Run(args) => run::run(args),
    };
    std::process::exit(exit_code);
}
