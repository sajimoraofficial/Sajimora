import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  ContractArtifactEnvelope,
  verifyEnvelopeIntegrity,
  parseEnvelope,
  expandTypePool,
} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import { ArtifactComparisonEngine } from '../../packages/analysis/src/sajimora/cross-language/ArtifactComparisonEngine';
import { serializeReport } from '../../packages/analysis/src/sajimora/cross-language/AgentImpactJson';
import { makeErrorReport } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts';
import { admitArtifact, ArtifactTrustPolicy } from '../../packages/analysis/src/sajimora/cross-language/ArtifactAdmission';
import {ScopedEvidenceStore} from '../../packages/analysis/src/sajimora/cross-language/ScopedEvidenceStore';
import {renderCustomerScopedReport} from '../../packages/analysis/src/sajimora/cross-language/CustomerScopedReport';

interface CheckContractArgs {
  basePath: string;
  candidatePath: string;
  targetPaths: string[];
  outPath?: string;
  trustPolicyPath?: string;
  trustedLocal: boolean;
  evidenceDbPath?:string;
  format:'json'|'customer';
  assessUnchanged?:boolean;
  failOnViolation?: boolean;
  strict?: boolean;
}

function parseArgs(argv: string[]): CheckContractArgs | { error: string } {
  const args = argv.slice(2);
  let basePath: string | undefined;
  let candidatePath: string | undefined;
  const targetPaths: string[] = [];
  let outPath: string | undefined;
  let trustPolicyPath: string | undefined;
  let trustedLocal = false;
  let evidenceDbPath:string|undefined;
  let format:'json'|'customer'='json';
  let assessUnchanged=false;
  let failOnViolation = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--base':      basePath = args[++i]; break;
      case '--candidate': candidatePath = args[++i]; break;
      case '--target':    targetPaths.push(args[++i]); break;
      case '--out':       outPath = args[++i]; break;
      case '--trust-policy': trustPolicyPath = args[++i]; break;
      case '--trusted-local': trustedLocal = true; break;
      case '--assess-unchanged':assessUnchanged=true;break;
      case '--evidence-db': evidenceDbPath=args[++i];if(!evidenceDbPath||evidenceDbPath.startsWith('--'))return {error:'Missing --evidence-db path'};break;
      case '--format': {const value=args[++i];if(value!=='json'&&value!=='customer')return {error:'--format must be json or customer'};format=value;break;}
      case '--fail-on-violation': failOnViolation = true; break;
      case '--strict': strict = true; failOnViolation = true; break;
      default: return { error: `Unknown argument: ${flag}` };
    }
  }

  if (!basePath) return { error: 'Missing --base' };
  if (!candidatePath) return { error: 'Missing --candidate' };
  if (targetPaths.length === 0) return { error: 'Missing at least one --target' };

  if (trustedLocal && trustPolicyPath) return {error:'Choose --trust-policy or --trusted-local, not both.'};
  if (!trustedLocal && !trustPolicyPath) return {error:'Artifact admission requires --trust-policy <json> or explicit --trusted-local for local fixtures.'};
  return { basePath, candidatePath, targetPaths, outPath, trustPolicyPath, trustedLocal,evidenceDbPath,format,assessUnchanged, failOnViolation, strict };
}

function loadEnvelope(filePath: string): ContractArtifactEnvelope {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (stat.size > 20 * 1024 * 1024) throw new Error('Artifact exceeds 20 MiB admission limit.');
  const content = fs.readFileSync(resolved, 'utf8');
  if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error('Artifact exceeds 20 MiB admission limit.');
  // Finding 9: Call parseEnvelope and deeply validate the payload, verify signatures/trusted provenance
  const env = parseEnvelope(content);
  if (!verifyEnvelopeIntegrity(env)) {
    throw new Error(`Integrity verification failed for ${filePath}`);
  }
  if (env.kind === 'BACKEND_CONTRACT' && (env.profile.frameworkProfile !== 'SPRING_MVC' || (env.profile.codecProfile !== 'JACKSON_DEFAULT_V1' && env.profile.codecProfile !== 'JACKSON_NAMING_V2'))) throw new Error('Unsupported backend extraction profile.');
  if (env.kind === 'FRONTEND_CONTRACT' && env.profile.clientProfile !== 'MULTI_CLIENT_V1') throw new Error('Unsupported frontend extraction profile.');
  return env;
}

export async function runCheckContractCommand(
  args: string[],
  io: { stdout: (t: string) => void; stderr: (t: string) => void } = {
    stdout: t => process.stdout.write(t),
    stderr: t => process.stderr.write(t),
  }
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(`sajimora check-contract — Cross-language contract verification

USAGE:
  sajimora check-contract --base <file> --candidate <file> --target <file> [options]

OPTIONS:
  --base <file>            Base contract artifact JSON file
  --candidate <file>       Candidate contract artifact JSON file
  --target <file>          Target contract artifact JSON file (can be specified multiple times)
  --trust-policy <file>    Trust policy JSON file
  --trusted-local          Enable trusted-local mode (waives signature/digest check for matched producers)
  --out <file>             Write report to file instead of stdout
  --format <fmt>           Output format: json | customer (default: json)
  --evidence-db <file>     Path to scoped evidence database
  --assess-unchanged       Assess unchanged endpoints
  --fail-on-violation      Exit 1 if verdict is LIKELY_VIOLATED
  --strict                 Strict mode: exit 1 on LIKELY_VIOLATED, exit 3 on INCONCLUSIVE
  --help, -h               Show this help message
`);
    return 0;
  }

  // Prepend dummy argv[0], argv[1] so parseArgs works with raw args
  const parsed = parseArgs(['node', 'checkContract', ...args]);
  if ('error' in parsed) {
    io.stderr(`[checkContract] Argument error: ${parsed.error}\n`);
    return 2;
  }

  try {
    const baseEnv = loadEnvelope(parsed.basePath);
    const candEnv = loadEnvelope(parsed.candidatePath);
    const targetEnvs = parsed.targetPaths.map(loadEnvelope);
    if (parsed.trustPolicyPath) {
      const policy: ArtifactTrustPolicy = JSON.parse(fs.readFileSync(path.resolve(parsed.trustPolicyPath), 'utf8'));
      for (const e of [baseEnv, candEnv, ...targetEnvs]) admitArtifact(e, policy, parsed.trustedLocal);
    } else if (parsed.trustedLocal) {
      const policy: ArtifactTrustPolicy = {
        producers: [
          { repositoryId: baseEnv.snapshot.repositoryId, serviceId: baseEnv.snapshot.serviceId },
          ...targetEnvs.map(t => ({ repositoryId: t.snapshot.repositoryId, serviceId: t.snapshot.serviceId }))
        ],
        requireSignatures: false
      };
      for (const e of [baseEnv, candEnv, ...targetEnvs]) admitArtifact(e, policy, parsed.trustedLocal);
    }

    const expandIfPooled = (e: ContractArtifactEnvelope): ContractArtifactEnvelope => {
      if (e.payload.type_pool) {
        return { ...e, payload: expandTypePool(e.payload) };
      }
      return e;
    };
    const finalBaseEnv = expandIfPooled(baseEnv);
    const finalCandEnv = expandIfPooled(candEnv);
    const finalTargetEnvs = targetEnvs.map(expandIfPooled);

    if (finalBaseEnv.kind !== finalCandEnv.kind) {
      throw new Error('Base and candidate artifact kinds must match.');
    }

    const engine = new ArtifactComparisonEngine({ requireServiceMapping: true, assessUnchanged: parsed.assessUnchanged });

    // Run candidate comparison
    const candResult = engine.compare(finalBaseEnv, finalCandEnv, finalTargetEnvs);
    
    // Run base comparison to filter out pre-existing legacy issues
    const baseResult = engine.compare(finalBaseEnv, finalBaseEnv, finalTargetEnvs);

    const baseFindingIds = new Set(baseResult.findings.map(f => f.id));
    const newFindings = candResult.findings.filter(f => !baseFindingIds.has(f.id));

    const candidateIds = new Set(candResult.findings.map(f => f.id));

    const report = {
      schemaVersion: candResult.schemaVersion,
      assurance: candResult.assurance,
      verdict: candResult.verdict,
      property: candResult.property,
      repository: candResult.repository,
      scope: candResult.scope,
      findings: candResult.findings,
      delta: {
        newFindings,
        existingFindings: candResult.findings.filter(f => baseFindingIds.has(f.id)),
        resolvedFindings: baseResult.findings.filter(f => !candidateIds.has(f.id)),
      },
      artifacts: candResult.artifacts,
      scopedChanges: candResult.scopedChanges,
      blockers: candResult.blockers,
      completeness: candResult.completeness ?? {
        endpointResolved: false,
        javaWireResolved: false,
        tsContractResolved: false,
        requestResolved: false,
        responseResolved: false,
        consumerTraversalComplete: false,
        unresolvedEvidence: []
      },
      counts: candResult.counts
    };

    const outJson = serializeReport(report);
    if (parsed.evidenceDbPath) {
      const store = new ScopedEvidenceStore(path.resolve(parsed.evidenceDbPath));
      try { store.publish(JSON.parse(outJson).scopedChanges); } finally { store.close(); }
    }
    const output = parsed.format === 'customer' ? renderCustomerScopedReport(report) : outJson;
    
    if (parsed.outPath) {
      fs.writeFileSync(path.resolve(parsed.outPath), output, 'utf8');
      io.stderr(`[checkContract] Report written to ${parsed.outPath}\n`);
    } else {
      io.stdout(output + '\n');
    }

    if (parsed.failOnViolation || parsed.strict) {
      if (candResult.verdict === 'LIKELY_VIOLATED') {
        io.stderr(`[checkContract] Contract check failed with verdict: ${candResult.verdict}\n`);
        return 1;
      }
      if (parsed.strict && candResult.verdict === 'INCONCLUSIVE') {
        io.stderr(`[checkContract] Contract check inconclusive in strict mode\n`);
        return 3;
      }
    }

    return 0;

  } catch (err) {
    io.stderr(`[checkContract] Fatal error: ${(err as Error).message}\n`);
    const report = makeErrorReport({
      repository: { repositoryId: 'unknown', parentCommit: 'unknown', candidateSnapshot: 'unknown' },
      blockerCode: 'TOOL_FAILURE',
      message: (err as Error).message
    });
    const json = serializeReport(report);
    if (parsed.outPath) fs.writeFileSync(path.resolve(parsed.outPath), json, 'utf8');
    else io.stdout(json + '\n');
    return 1;
  }
}

if (process.argv[1] && (process.argv[1].endsWith('checkContract.ts') || process.argv[1].endsWith('checkContract.js') || (typeof require !== 'undefined' && require.main === module))) {
  runCheckContractCommand(process.argv.slice(2)).then(code => process.exit(code));
}
