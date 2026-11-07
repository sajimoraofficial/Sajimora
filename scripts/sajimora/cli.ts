import { parseArguments } from './arguments';
import { runAnalyzeCommand, CommandIO } from './command';
import { runInitHookCommand } from './initHook';
import { parseKeygenArgs, runKeygenCommand } from './keygen';
import { runCheckContractCommand } from './checkContract';
import { SajimoraExecutionError } from './errors';

export async function executeCli(
  argv: string[],
  io: CommandIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) },
  run = runAnalyzeCommand
): Promise<number> {
  try {
    if (argv[0] === 'check-contract') {
      return runCheckContractCommand(argv.slice(1), io);
    }
    if (argv[0] === 'keygen') {
      return runKeygenCommand(parseKeygenArgs(argv.slice(1)), io);
    }
    if (argv[0] === 'init-hook') {
      let repo: string | undefined;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--repo' && argv[i + 1]) {
          repo = argv[i + 1];
          i++;
        }
      }
      runInitHookCommand({ repo }, io);
      return 0;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
      io.stdout('sajimora 0.1.0\n');
      return 0;
    }
    if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
      io.stdout(`Sajimora 0.1.0 — Mathematical API & Code Compatibility Intelligence

USAGE:
  sajimora [command] [options]

COMMANDS:
  analyze                  Run compatibility analysis (default)
  check-contract           Run contract verification and cross-language compatibility check
  keygen                   Generate Ed25519 keypair and ArtifactTrustPolicy JSON
  init-hook                Install pre-commit Git hook for automated checks

CORE ANALYSIS OPTIONS:
  --parent <ref>           Base commit to compare against (default: HEAD~1)
  --candidate <ref>        New commit to evaluate (default: HEAD)
  --repo <path>            Target Git repository path (default: .)
  --language <lang>        Target language: auto | typescript | java (default: auto)
  --engine <eng>           Engine: advisory | production | legacy | certification | f0 (default: advisory)
  --format <fmt>           Output format: json | text | markdown (default: json)
  --output <file>          Write analysis report to specified destination file
  --dependency-root <path> Root directory containing node_modules for dependency resolution
  --config <file>          Path to configuration file (default: sajimora.config.json)

CROSS-LANGUAGE & SECURITY OPTIONS:
  --frontend <path>        Path to frontend contract artifact (auto-discovered if present)
  --trust-policy <file>    Path to JSON trust policy for cryptographic signature verification
  --trusted-local          Explicitly bypass signature verification for trusted local development

CI & ENFORCEMENT OPTIONS:
  --fail-on-violation      Exit code 1 on LIKELY_VIOLATED (advisory exits 0 by default)
  --strict                 Strict mode: exit 1 on LIKELY_VIOLATED, exit 3 on INCONCLUSIVE

KEYGEN OPTIONS (for 'keygen' command):
  --out-dir, -o <dir>      Directory to write private/public PEM keys and trust-policy.json
  --repo-id <id>           Repository ID for generated trust policy (default: example-org/repo)
  --service-id <id>        Service ID for generated trust policy (default: frontend-service)

INFORMATIONAL:
  --help, -h               Show this help message
  --version, -v            Show version number

EXIT CODES:
  0   Success / Preserved (or non-blocking advisory)
  1   Contract Violated (when --fail-on-violation or --strict is set)
  2   CLI / Configuration Input Error
  3   Inconclusive / Unknown Proof (when --strict is set)
  4   Admission / Signature Verification Error
  5   Environmental / Tool Prerequisite Missing
  6   Engine Runtime Failure
`);
      return 0;
    }
    const cleanArgv = argv[0] === 'analyze' ? argv.slice(1) : argv;
    await run(parseArguments(cleanArgv), io);
    return 0;
  } catch (error) {
    const failure = error instanceof SajimoraExecutionError
      ? error
      : new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 6, 'ENGINE_RUNTIME_FAILURE', { cause: error });
    io.stderr(`${failure.category}: ${failure.message}\n`);
    return failure.exitCode;
  }
}
