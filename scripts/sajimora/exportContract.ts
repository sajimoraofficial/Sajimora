/**
 * exportContract.ts
 *
 * [PROPOSED CAPABILITY] sajimora export-contract
 *
 * Exports a sealed backend ContractArtifactEnvelope from a Java/Spring
 * repository snapshot. Produces a single JSON file suitable for ingestion
 * by a frontend CI pipeline or local check-contract invocation.
 *
 * Usage (via tsx / node run-tsx-command.cjs):
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/sajimora/exportContract.ts \
 *     --repo         <path-to-git-root>          \
 *     --parent       <parent-commit-sha>         \
 *     [--candidate   <candidate-commit-sha>]      \
 *     [--working-tree]                            \
 *     --service-id   <service-name>              \
 *     --api-version  <v1|2026-10|...>            \
 *     [--base-url    <https://api.example.com>]  \
 *     [--java-root   <src/main/java>]            \
 *     [--spring-config-name <literal-source-profile>] \
 *     [--out         <path/to/backend-contract.json>]
 *
 * Exactly one of --candidate or --working-tree must be supplied.
 *
 * Output contract:
 *   - stdout receives exactly ONE sealed JSON envelope (ContractArtifactEnvelope).
 *   - stderr receives progress / diagnostic messages.
 *   - If any unrecoverable error occurs the envelope's completeness.complete is
 *     false and completeness.blockers is non-empty. The process exits 0 for
 *     advisory errors (INCONCLUSIVE / incomplete) and 1 only for tool failures
 *     that prevent any envelope from being emitted.
 *   - Missing facts are UNRESOLVED (never deletions). LIKELY_PRESERVED is
 *     prohibited when completeness.complete === false.
 *
 * Architecture: POLYREPO_CONTRACT_EXCHANGE_ARCHITECTURE.md
 * Prerequisites: CrossLanguageV1Correctness fixes must land before this
 *   command's output is distributed across repositories.
 */

import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { coldCheckpoint, coldSourceCounts } from './coldExtractionTelemetry';
import {qualifySpringJsonSourceProfile} from '../../packages/analysis/src/sajimora/cross-language/SpringJsonSourceProfile';

import { GitRepository } from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import { captureSnapshotPair } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
import { JavaSealedCompilerHost } from '../../packages/analysis/src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import { JavaWireModelEngine } from '../../packages/analysis/src/sajimora/cross-language/JavaWireModelEngine';
import {
  sealEnvelope,
  serializeEnvelope,
  ARTIFACT_ENVELOPE_VERSION_V2,
  internTypePool,
} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import { SCHEMA_VERSION } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts';
import type {
  ContractArtifactEnvelope,
  ArtifactBlocker,
  BackendContractPayload,
  ExtractionProfile,
  ArtifactSnapshotRef,
} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import type { EndpointContract } from '../../packages/analysis/src/sajimora/cross-language/CanonicalContractIR';

// ---------------------------------------------------------------------------
// Package version (best-effort; falls back to '0.0.0-dev' if unavailable)
// ---------------------------------------------------------------------------

function resolveToolVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../packages/analysis/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ExportContractArgs {
  repo: string;
  parent: string;
  candidateCommit?: string;
  workingTree: boolean;
  serviceId: string;
  apiVersion: string | null;
  baseUrls: string[];
  javaRoot?: string;
  springConfigName?:string;
  out?: string;
}

function parseArgs(argv: string[]): ExportContractArgs | { error: string } {
  const args = argv.slice(2);
  let repo: string | undefined;
  let parent: string | undefined;
  let candidateCommit: string | undefined;
  let workingTree = false;
  let serviceId: string | undefined;
  let apiVersion: string | null = null;
  const baseUrls: string[] = [];
  let javaRoot: string | undefined;
  let springConfigName:string|undefined;
  let out: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--repo':         repo = args[++i]; break;
      case '--parent':       parent = args[++i]; break;
      case '--candidate':    candidateCommit = args[++i]; break;
      case '--working-tree': workingTree = true; break;
      case '--service-id':   serviceId = args[++i]; break;
      case '--api-version':  apiVersion = args[++i] ?? null; break;
      case '--base-url':     { const u = args[++i]; if (u) baseUrls.push(u); break; }
      case '--java-root':    javaRoot = args[++i]; break;
      case '--spring-config-name': springConfigName=args[++i];if(!springConfigName||!/^[A-Za-z0-9_-]+$/.test(springConfigName))return {error:'--spring-config-name requires one literal configuration name'};break;
      case '--out':          out = args[++i]; break;
      default:
        return { error: `Unknown argument: ${flag}` };
    }
  }

  if (!repo)      return { error: 'Missing required argument: --repo' };
  if (!parent)    return { error: 'Missing required argument: --parent' };
  if (!serviceId) return { error: 'Missing required argument: --service-id' };
  if (!candidateCommit && !workingTree) {
    return { error: 'Must specify exactly one of --candidate <sha> or --working-tree' };
  }
  if (candidateCommit && workingTree) {
    return { error: 'Cannot specify both --candidate and --working-tree' };
  }

  return { repo, parent, candidateCommit, workingTree, serviceId, apiVersion, baseUrls, javaRoot, springConfigName, out };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[exportContract] ${msg}\n`);
}

function emitEnvelope(envelope: ContractArtifactEnvelope, outPath: string | undefined): void {
  const json = serializeEnvelope(envelope);
  if (outPath) {
    const resolved = path.resolve(outPath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.sajimora-export-tmp-${createHash('sha256').update(json).digest('hex').slice(0, 8)}.json`);
    fs.writeFileSync(tmp, json, { encoding: 'utf8' });
    fs.renameSync(tmp, resolved);
    log(`Envelope written to: ${resolved}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

/**
 * Build a configuration fingerprint from the effective Jackson settings
 * found in the snapshot's resource files. Returns null if no config files
 * are present (which becomes a blocker for full completeness).
 */
function extractConfigFingerprint(
  files: ReadonlyMap<string, { bytes: Buffer; sha256: string }>,
  javaRoot?: string
): { fingerprint: string | null; namingStrategy: 'SNAKE_CASE' | 'CAMEL_CASE' | null; blockers: ArtifactBlocker[] } {
  const configKeys = ['application.properties', 'application.yml', 'application.yaml'];
  const parts: string[] = [];
  let namingStrategy: 'SNAKE_CASE' | 'CAMEL_CASE' | null = null;
  const blockers: ArtifactBlocker[] = [];
  const strategies = new Set<string>();
  for (const [p, f] of files) {
    // Production source exports do not load the test classpath. Main-resource
    // profile files and programmatic mappers still require qualification.
    if (javaRoot && /(?:^|\/)src\/main\/java\/?$/.test(javaRoot) && /(?:^|\/)src\/test\//.test(p)) continue;
    const base = p.split('/').pop() ?? '';
    if (configKeys.includes(base) || /^application-.+\.(properties|ya?ml)$/.test(base) || (p.endsWith('.java') && /ObjectMapper|Jackson2ObjectMapperBuilder|JsonComponent|Jackson.*Customizer/.test(f.bytes.toString('utf8')))) {
      parts.push(`${p}:${f.sha256}`);
      const content = f.bytes.toString('utf8');
      if (!configKeys.includes(base)) blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',message:'Profile-specific or programmatic Jackson configuration requires qualification.',file:p});
      const text=content.split(/\r?\n/).filter(line=>!/^\s*[#!]/.test(line)).join('\n');
      const matches=[...text.matchAll(/(?:spring\.jackson\.)?property-naming-strategy\s*[:=]\s*["']?([^\s"'#]+)/g)];
      for (const match of matches) {
        if (!['SNAKE_CASE','LOWER_CAMEL_CASE','CAMEL_CASE'].includes(match[1])) blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',message:'Unsupported Jackson naming strategy: '+match[1],file:p});
        else strategies.add(match[1]==='SNAKE_CASE'?'SNAKE_CASE':'CAMEL_CASE');
      }
      if (/spring\.jackson\.(?!property-naming-strategy)|\b(?:visibility|default-property-inclusion|date-format|serialization|deserialization|modules)\s*[:=]/.test(text)) blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',message:'Additional Jackson settings require a qualified serialization profile.',file:p});
    }
  }
  if(strategies.size>1) blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',message:'Conflicting Jackson naming configurations.'});
  namingStrategy=strategies.has('SNAKE_CASE')?'SNAKE_CASE':'CAMEL_CASE';
  if (parts.length === 0) return { fingerprint: null, namingStrategy: null, blockers };
  return {
    fingerprint: createHash('sha256')
      .update(parts.sort().join('\n'))
      .digest('hex')
      .slice(0, 32),
    namingStrategy,
    blockers
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Redirect console.log to stderr so only the JSON envelope reaches stdout.
  console.log = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

  const parsed = parseArgs(process.argv);
  if ('error' in parsed) {
    process.stderr.write(`[exportContract] Argument error: ${parsed.error}\n`);
    printUsage();
    process.exit(1);
  }

  const { repo, parent: parentCommit, candidateCommit, workingTree, serviceId, apiVersion, baseUrls, javaRoot, out } = parsed;
  const repoPath = path.resolve(repo);
  const toolVersion = resolveToolVersion();

  log(`repo=${repoPath} parent=${parentCommit} service=${serviceId} workingTree=${workingTree}`);

  // -------------------------------------------------------------------------
  // 1. Validate git repository
  // -------------------------------------------------------------------------
  let repository: GitRepository;
  try {
    repository = new GitRepository(repoPath);
    repository.validate();
  } catch (err) {
    process.stderr.write(`[exportContract] Repository validation failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 2. Capture snapshot pair
  // -------------------------------------------------------------------------
  let snapshotPair: Awaited<ReturnType<typeof captureSnapshotPair>>;
  coldCheckpoint('snapshot-start');
  try {
    const t0 = Date.now();
    snapshotPair = await captureSnapshotPair({
      repository,
      parentCommit,
      candidate: workingTree
        ? { kind: 'working-tree' }
        : { kind: 'commit', sha: candidateCommit! },
    });
    log(`Snapshot captured in ${Date.now() - t0}ms — candidate files: ${snapshotPair.candidateFiles.size}`);
  } catch (err) {
    process.stderr.write(`[exportContract] Snapshot capture failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  coldCheckpoint('snapshot-end');
  const snapshotRef: ArtifactSnapshotRef = {
    repositoryId: snapshotPair.identity.repositoryId,
    serviceId,
    apiVersion,
    parentCommit: snapshotPair.identity.parentCommit,
    candidateSnapshot: snapshotPair.identity.candidateSnapshot,
  };

  const captureBlockers: ArtifactBlocker[] = snapshotPair.blockers.map(b => ({
    code: b.code,
    message: b.message,
    file: b.file,
  }));

  // -------------------------------------------------------------------------
  // 3. Filter Java source files
  // -------------------------------------------------------------------------
  const isJava = (p: string): boolean =>
    p.endsWith('.java') && (!javaRoot || p.startsWith(javaRoot.replace(/\/$/, '') + '/'));

  const candidateJavaFiles = new Map<string, { bytes: Buffer; sha256: string }>();
  for (const [p, f] of snapshotPair.candidateFiles) {
    if (isJava(p as string)&&!(parsed.springConfigName&&/(?:^|\/)src\/test\//.test(p as string))) candidateJavaFiles.set(p as string, f);
  }

  log(`Java files found: ${candidateJavaFiles.size}`);

  // -------------------------------------------------------------------------
  // 4. Extract configuration fingerprint
  // -------------------------------------------------------------------------
  const selectedConfig=parsed.springConfigName?qualifySpringJsonSourceProfile(snapshotPair.candidateFiles,parsed.springConfigName):undefined;
  const configInfo = selectedConfig??extractConfigFingerprint(snapshotPair.candidateFiles, javaRoot);
  captureBlockers.push(...configInfo.blockers);
  if (!configInfo.fingerprint) {
    log('WARNING: No application.properties/yml found in candidate snapshot — Jackson config is unresolved.');
    captureBlockers.push({
      code: 'UNRESOLVED_JACKSON_CONFIG',
      message: 'No application.properties or application.yml found in candidate snapshot. Jackson naming strategy is unresolved.',
    });
  }

  const profile: ExtractionProfile = {
    toolVersion,
    frameworkProfile: 'SPRING_MVC',
    codecProfile: 'JACKSON_DEFAULT_V1',
    configFingerprint: configInfo.fingerprint,
  };

  // -------------------------------------------------------------------------
  // 5. Extract endpoint contracts via JavaWireModelEngine
  // -------------------------------------------------------------------------
  const javaSnapshot = {
    trackedFiles: [...candidateJavaFiles.keys()],
    readTextFile: (filePath: string): string | undefined => {
      const f = candidateJavaFiles.get(filePath);
      return f ? f.bytes.toString('utf8') : undefined;
    },
  };

  coldSourceCounts(snapshotPair.candidateFiles);
  coldCheckpoint('java-host-start');
  const host = new JavaSealedCompilerHost(javaSnapshot);
  coldCheckpoint('java-host-end');
  const engine = new JavaWireModelEngine(host, configInfo.namingStrategy ?? 'CAMEL_CASE');

  const endpoints: EndpointContract[] = [];
  const engineBlockers: ArtifactBlocker[] = [];
  const unresolvedEndpoints: string[] = [];
  let allClasses: readonly any[] = [];

  let engineT0 = Date.now();
  try {
    // Collect all controller classes and extract their endpoints
    coldCheckpoint('java-class-index-start');
    allClasses = host.getAllClasses();
    coldCheckpoint('java-class-index-end', {classes: allClasses.length});
    log(`JavaWireModelEngine: processing ${allClasses.length} Java classes`);

    const jaxAnnotations = ['Path', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Produces', 'Consumes'];
    for (const cls of allClasses) {
      if(!isJava(cls.filePath))continue;
      // Only process Spring controllers (identified by annotation)
      const isController =
        cls.annotations.includes('RestController') ||
        cls.annotations.includes('Controller') ||
        cls.annotations.includes('RequestMapping');

      const isJax =
        cls.annotations.some((a: string) => jaxAnnotations.includes(a)) ||
        cls.methods.some((m: any) => m.annotations.some((a: string) => jaxAnnotations.includes(a)));

      if (isJax && !isController) {
        engineBlockers.push({
          code: 'UNSUPPORTED_FRAMEWORK',
          message: `JAX-RS / Jersey resource ${cls.fqcn} detected. Sajimora supports Spring MVC controllers (@RestController, @Controller).`,
          file: cls.filePath
        });
        unresolvedEndpoints.push(`${cls.fqcn} — blocker: UNSUPPORTED_FRAMEWORK`);
        continue;
      }

      if (!isController) continue;

      try {
        const result = engine.extractControllerEndpoints(cls);
        endpoints.push(...result.endpoints.map(ep=>({...ep,identity:{...ep.identity,service:serviceId},provenance:{...ep.provenance,sha256:candidateJavaFiles.get(ep.provenance.file)?.sha256}})));
        for (const b of result.blockers) {
          engineBlockers.push({ code: b.code, message: b.message, file: b.file });
          unresolvedEndpoints.push(`${cls.fqcn} — blocker: ${b.code}`);
        }
      } catch (err) {
        const msg = `Failed to extract endpoints from ${cls.fqcn}: ${(err as Error).message}`;
        log(`ERROR: ${msg}`);
        engineBlockers.push({ code: 'TOOL_FAILURE', message: msg, file: cls.filePath });
        unresolvedEndpoints.push(cls.fqcn);
      }
    }

    coldCheckpoint('contract-extraction-end', {endpoints: endpoints.length});
    log(`JavaWireModelEngine: extracted ${endpoints.length} endpoints in ${Date.now() - engineT0}ms`);
  } catch (err) {
    const msg = `JavaWireModelEngine failed: ${(err as Error).message}`;
    log(`FATAL: ${msg}`);
    engineBlockers.push({ code: 'TOOL_FAILURE', message: msg });
  }

  // -------------------------------------------------------------------------
  // 6. Assemble and deduplicate backend payload (Envelope V2 Type Pool)
  // -------------------------------------------------------------------------
  const rawPayload: BackendContractPayload = {
    ...(selectedConfig?{serializationAssumptions:selectedConfig.assumptions}:{}),
    baseUrls: baseUrls.length > 0 ? baseUrls : [],
    proxyPrefixes: [],   // not yet extracted from config; add as future enhancement
    endpoints,
  };
  const payload = internTypePool(rawPayload);

  if (allClasses.length > 0 && endpoints.length === 0 && engineBlockers.length === 0) {
    engineBlockers.push({
      code: 'UNRESOLVED_BACKEND_CONTRACT',
      message: 'Java classes discovered but 0 endpoint contracts resolved. Framework annotations may be unsupported or missing.',
      file: 'all'
    });
    unresolvedEndpoints.push('all — blocker: UNRESOLVED_BACKEND_CONTRACT');
  }

  const allBlockers = [...captureBlockers, ...engineBlockers];
  const isComplete = allBlockers.length === 0 && unresolvedEndpoints.length === 0;

  // -------------------------------------------------------------------------
  // 7. Seal and emit envelope
  // -------------------------------------------------------------------------
  coldCheckpoint('seal-start');
  const sealed = sealEnvelope({
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
    reportSchemaVersion: SCHEMA_VERSION,
    kind: 'BACKEND_CONTRACT',
    snapshot: snapshotRef,
    profile,
    completeness: {
      complete: isComplete,
      unresolvedEndpoints,
      blockers: allBlockers,
    },
    payload,
  });

  log(`Envelope sealed (V2 deduplicated). complete=${isComplete} endpoints=${endpoints.length} type_pool=${Object.keys(payload.type_pool ?? {}).length} blockers=${allBlockers.length}`);

  log(`Envelope sealed. complete=${isComplete} endpoints=${endpoints.length} blockers=${allBlockers.length}`);
  log(`Integrity digest: ${sealed.integrity?.sha256.slice(0, 16)}...`);

  coldCheckpoint('seal-end');
  emitEnvelope(sealed, out);
  coldCheckpoint('write-end');
  process.exit(0);
}

function printUsage(): void {
  process.stderr.write(`
Usage: exportContract [options]

Required:
  --repo <path>          Path to the git repository root
  --parent <sha>         Parent (base) commit SHA
  --service-id <name>    Stable service identifier (e.g. "order-service")

Candidate (exactly one required):
  --candidate <sha>      Candidate commit SHA to export
  --working-tree         Use current working-tree state as candidate

Optional:
  --api-version <v>      API version label (e.g. "v1", "2026-10")
  --base-url <url>       Base URL (may be repeated for multiple URLs)
  --java-root <path>     Filter Java files to this POSIX prefix (e.g. "src/main/java")
  --out <path>           Write envelope JSON to this file (default: stdout)

Output:
  stdout                 Sealed ContractArtifactEnvelope JSON (backend-contract.json)
  stderr                 Progress and diagnostic messages

Notes:
  - This is a PROPOSED capability; it is not yet part of the stable CLI.
  - completeness.complete=false indicates unresolved extraction; treat missing
    endpoints as UNRESOLVED, not deleted.
  - Distribute artifacts only after correctness regressions pass (see audit).
`);
}

main().catch(err => {
  process.stderr.write(`[exportContract] Unexpected error: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  process.exit(1);
});
