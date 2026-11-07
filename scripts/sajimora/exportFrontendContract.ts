/**
 * exportFrontendContract.ts
 *
 * [PROPOSED CAPABILITY] sajimora export-frontend-contract
 *
 * Exports a sealed frontend ContractArtifactEnvelope from a TypeScript/React
 * repository snapshot. Produces a single JSON file suitable for ingestion
 * by a backend CI pipeline or local check-contract invocation.
 *
 * The envelope captures:
 *   - HTTP client call contracts (fetch, Axios, TanStack, SWR)
 *   - Request body wire shapes
 *   - Expected response wire types
 *   - Decoder behavior (strict Zod, passthrough, type assertion, etc.)
 *   - Consumer file locations
 *   - Unresolved evidence (dynamic URLs, unresolvable types)
 *   - Frontend revision (parent + candidate snapshot identities)
 *
 * Usage (via tsx / node run-tsx-command.cjs):
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/sajimora/exportFrontendContract.ts \
 *     --repo         <path-to-git-root>          \
 *     --parent       <parent-commit-sha>         \
 *     [--candidate   <candidate-commit-sha>]      \
 *     [--working-tree]                            \
 *     --service-id   <service-name>              \
 *     --api-version  <v1|2026-10|...>            \
 *     [--ts-root     <src>]                      \
 *     [--out         <path/to/frontend-contract.json>]
 *
 * Exactly one of --candidate or --working-tree must be supplied.
 *
 * Output contract:
 *   - stdout receives exactly ONE sealed JSON envelope (ContractArtifactEnvelope).
 *   - stderr receives progress / diagnostic messages.
 *   - completeness.complete === false when any extraction blockers are present.
 *   - Missing/dynamic URLs → unresolvedEvidence; never silently dropped.
 *   - Process exits 0 for advisory errors (incomplete); 1 only for tool failures
 *     that prevent any envelope from being emitted.
 *
 * Architecture: POLYREPO_CONTRACT_EXCHANGE_ARCHITECTURE.md
 * Prerequisites: TypeScriptContractParser correctness fixes must land before
 *   this command's output is distributed across repositories.
 */

import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {ConsumerImpactGraph} from '../../packages/analysis/src/sajimora/cross-language/ConsumerImpactGraph';
import * as ts from 'typescript';
import { coldCheckpoint, coldSourceCounts } from './coldExtractionTelemetry';

import { GitRepository } from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import { captureSnapshotPair } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
import { TypeScriptContractParser } from '../../packages/analysis/src/sajimora/cross-language/TypeScriptContractParser';
import { UrlConstantResolver } from '../../packages/analysis/src/sajimora/cross-language/UrlConstantResolver';
import {DependencyDeclarationContext} from '../../packages/analysis/src/sajimora/cross-language/DependencyDeclarationContext';
import {AngularInterceptorSummary,InterceptorEvidence} from '../../packages/analysis/src/sajimora/cross-language/AngularInterceptorSummary';
import { MultiClientAdapter } from '../../packages/analysis/src/sajimora/cross-language/HttpClientAdapters';
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
  FrontendContractPayload,
  FrontendClientContract,
  ConsumerLocation,
  DecoderKind,
  ExtractionProfile,
  ArtifactSnapshotRef,
  ArtifactCompleteness,
} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import type { ClientRequestContract } from '../../packages/analysis/src/sajimora/cross-language/HttpClientAdapters';
import type { WireType } from '../../packages/analysis/src/sajimora/cross-language/CanonicalContractIR';

// ---------------------------------------------------------------------------
// Package version
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

interface ExportFrontendArgs {
  dependencyCache?: string;
  repo: string;
  parent: string;
  candidateCommit?: string;
  workingTree: boolean;
  serviceId: string;
  apiVersion: string | null;
  targetServiceId?: string;
  targetApiVersion?: string;
  tsRoot?: string;
  out?: string;
}

function parseArgs(argv: string[]): ExportFrontendArgs | { error: string } {
  const args = argv.slice(2);
  let repo: string | undefined;
  let parent: string | undefined;
  let candidateCommit: string | undefined;
  let workingTree = false;
  let serviceId: string | undefined;
  let apiVersion: string | null = null;
  let targetServiceId: string | undefined;
  let targetApiVersion: string | undefined;
  let tsRoot: string | undefined;
  let out: string | undefined;
  let dependencyCache:string|undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--repo':         repo = args[++i]; break;
      case '--parent':       parent = args[++i]; break;
      case '--candidate':    candidateCommit = args[++i]; break;
      case '--working-tree': workingTree = true; break;
      case '--service-id':   serviceId = args[++i]; break;
      case '--api-version':  apiVersion = args[++i] ?? null; break;
      case '--target-service-id': targetServiceId = args[++i]; break;
      case '--target-api-version': targetApiVersion = args[++i]; break;
      case '--ts-root':      tsRoot = args[++i]; break;
      case '--out':          out = args[++i]; break;
      case '--dependency-cache': dependencyCache=args[++i];break;
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

  return { repo, parent, candidateCommit, workingTree, serviceId, apiVersion, targetServiceId, targetApiVersion, tsRoot, out,dependencyCache };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[exportFrontendContract] ${msg}\n`);
}

function emitEnvelope(envelope: ContractArtifactEnvelope, outPath: string | undefined): void {
  const json = serializeEnvelope(envelope);
  if (outPath) {
    const resolved = path.resolve(outPath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.sajimora-frontend-tmp-${createHash('sha256').update(json).digest('hex').slice(0, 8)}.json`
    );
    fs.writeFileSync(tmp, json, { encoding: 'utf8' });
    fs.renameSync(tmp, resolved);
    log(`Envelope written to: ${resolved}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

/**
 * Map the client kind and expected type to a DecoderKind.
 * Strict Zod is detected by inspecting whether the extracted WireType
 * has `strict: true` on the object root.
 */
function resolveDecoderKind(contract: ClientRequestContract): DecoderKind {
  if (contract.expectationKind === 'TYPE_ASSERTION') return 'TYPE_ASSERTION';
  if (contract.expectationKind === 'UNKNOWN') return 'UNKNOWN';

  const resp = contract.expectedResponseType;
  if (resp && resp.kind === 'OBJECT') {
    if (resp.strict === true) return 'ZOD_STRICT';
    // Distinguish Zod from pure TypeScript inference by checking expectationKind
    if (contract.expectationKind === 'ZOD_DECODER') return 'ZOD_DEFAULT';
  }

  return 'INFERRED_TYPE';
}

/**
 * Find all consumer locations for a given HTTP client call.
 * Currently uses the source file and call site line as the primary consumer.
 * Full consumer graph traversal (ConsumerImpactGraph) requires knowing the
 * response type name, which we preserve in unresolvedEvidence when unknown.
 */
function buildConsumerLocations(
  contract: ClientRequestContract,
  sf: ts.SourceFile,
  graph: ConsumerImpactGraph
): { consumers: ConsumerLocation[]; unresolved: string[]; complete:boolean } {
  const consumers: ConsumerLocation[] = [];
  const unresolved: string[] = [];

  // The call site itself is always the primary consumer
  consumers.push({
    file: contract.provenance.file,
    line: contract.provenance.line,
    usage: contract.provenance.astIdentity ?? `${contract.method} ${contract.rawUrl}`,
  });

  // If the response type is unknown, record as unresolved evidence
  if (!contract.expectedResponseType || contract.expectedResponseType.kind === 'UNKNOWN') {
    unresolved.push(
      `Unresolved response type for ${contract.method} ${contract.rawUrl} at ` +
      `${contract.provenance.file}:${contract.provenance.line}`
    );
  }

  const traversal=graph.analyzeCallConsumers(contract.provenance.file,contract.provenance.line,undefined,contract.provenance.column,contract.provenance.callIdentity,{observe:contract.httpOptionsEvidence?.observe});
  consumers.push(...traversal.consumers);
  unresolved.push(...traversal.unresolved);
  return { consumers, unresolved,complete:traversal.complete };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Redirect console.log to stderr so only the JSON envelope reaches stdout.
  console.log = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

  const parsed = parseArgs(process.argv);
  if ('error' in parsed) {
    process.stderr.write(`[exportFrontendContract] Argument error: ${parsed.error}\n`);
    printUsage();
    process.exit(1);
  }

  const {
    repo, parent: parentCommit, candidateCommit, workingTree,
    serviceId, apiVersion, tsRoot, out,
  } = parsed;

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
    process.stderr.write(`[exportFrontendContract] Repository validation failed: ${(err as Error).message}\n`);
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
      includeExtensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.html', '.json', '.lock', '.config'],
    });
    log(`Snapshot captured in ${Date.now() - t0}ms — candidate files: ${snapshotPair.candidateFiles.size}`);
  } catch (err) {
    process.stderr.write(`[exportFrontendContract] Snapshot capture failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  coldCheckpoint('snapshot-end');
  coldSourceCounts(snapshotPair.candidateFiles);
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
  // 3. Filter client source files
  // -------------------------------------------------------------------------
  const isTs = (p: string): boolean =>
    (/\.(?:[jt]sx?|[mc][jt]s)$/.test(p)) &&
    !/\.d\.[cm]?ts$/.test(p) &&
    (!tsRoot || p === tsRoot || p.startsWith(tsRoot.replace(/\/$/, '') + '/'));

  const candidateSourceFiles = new Map<string, string>();
  for (const [p, f] of snapshotPair.candidateFiles) {
    if (isTs(p as string)) {
      candidateSourceFiles.set(p as string, f.bytes.toString('utf8'));
    }
  }

  log(`Client source files found: ${candidateSourceFiles.size}`);

  if (candidateSourceFiles.size === 0) {
    captureBlockers.push({
      code: 'UNRESOLVED_TS_PROJECT',
      message: `No client source files found in snapshot${tsRoot ? ` under '${tsRoot}'` : ''}.`,
    });
  }

  let tsConfigFingerprint: string | null = null;
  const configKeys = ['tsconfig.json', 'package.json','package-lock.json','yarn.lock','pnpm-lock.yaml'];
  const parts: string[] = [];
  for (const [p, f] of snapshotPair.candidateFiles) {
    const base = p.split('/').pop() ?? '';
    if (configKeys.includes(base)||/^tsconfig\..*\.json$/.test(base)) {
      parts.push(`${p}:${f.sha256}`);
    }
  }
  if (parts.length > 0) {
     const crypto = require('node:crypto');
     tsConfigFingerprint = crypto.createHash('sha256').update(parts.sort().join('\n')).digest('hex').slice(0, 32);
  }

  const profile: ExtractionProfile = {
    toolVersion,
    clientProfile: 'MULTI_CLIENT_V1',
    configFingerprint: tsConfigFingerprint,
  };

  // -------------------------------------------------------------------------
  // 4. Build parsers and extract HTTP client contracts
  // -------------------------------------------------------------------------
  const clientContracts: FrontendClientContract[] = [];
  const extractionBlockers: ArtifactBlocker[] = [];
  const unresolvedEndpoints: string[] = [];
  let dependencyContext:ReturnType<DependencyDeclarationContext['manifest']>|undefined;
  let interceptorEvidence:InterceptorEvidence|undefined;

  if (candidateSourceFiles.size > 0) {
    let extractT0 = Date.now();
    try {
      const defaultCache=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'npm-cache'):undefined;
      const resolutionFiles = new DependencyDeclarationContext(new Map([...snapshotPair.candidateFiles].map(([p, f]) => [p as string, f.bytes.toString('utf8')])),parsed.dependencyCache??defaultCache);
      coldCheckpoint('type-parser-start');
      const typeParser = new TypeScriptContractParser(resolutionFiles);
      coldCheckpoint('type-parser-end');
      const urlResolver = new UrlConstantResolver(resolutionFiles);
      coldCheckpoint('url-index-end');
      const adapter = new MultiClientAdapter();
      const interceptors=new AngularInterceptorSummary(resolutionFiles,urlResolver);
      const extractedFiles:{sf:ts.SourceFile;filePath:string;content:string;requests:readonly ClientRequestContract[]}[]=[];

      for (const [filePath, content] of candidateSourceFiles) {
        const sf = urlResolver.getSourceFile(filePath) ?? ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

        let fileResult: { requests: readonly ClientRequestContract[]; blockers: readonly import('../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts').AnalysisBlocker[] };
        try {
          fileResult = adapter.extractRequests(sf, urlResolver, typeParser);
        } catch (err) {
          const msg = `Adapter extraction failed for ${filePath}: ${(err as Error).message}`;
          log(`ERROR: ${msg}`);
          extractionBlockers.push({ code: 'TOOL_FAILURE', message: msg, file: filePath });
          unresolvedEndpoints.push(filePath);
          continue;
        }

        // Map adapter blockers
        for (const b of fileResult.blockers) {
          extractionBlockers.push({ code: b.code, message: b.message, file: b.file });
          if (b.code === 'DYNAMIC_URL') {
            unresolvedEndpoints.push(`${filePath}: ${b.message}`);
          }
        }

        extractedFiles.push({sf,filePath,content,requests:fileResult.requests});
      }
      const consumerGraph=new ConsumerImpactGraph(resolutionFiles,{roots:[...new Set(extractedFiles.flatMap(file=>file.requests.map(request=>request.provenance.file)))]});
      coldCheckpoint('consumer-inventory-end',{callFiles:extractedFiles.filter(file=>file.requests.length).length});
      for(const {sf,filePath,content,requests}of extractedFiles){
        // Map each extracted request to a FrontendClientContract
        for (const req of requests) {
          if(req.clientKind==='ANGULAR')interceptorEvidence=interceptors.analyzeForRequest({url:req.rawUrl,bodyAbsent:req.requestTransport?.kind==='ABSENT'&&req.httpOptionsEvidence?.requestBodyAbsent===true});
          const decoderKind = resolveDecoderKind(req);
          const { consumers, unresolved,complete:consumerTraversalComplete } = buildConsumerLocations(req, sf,consumerGraph);
          if(req.clientKind==='ANGULAR')unresolved.push(...(interceptorEvidence?.missingEvidence??[]));
          if(unresolved.some(reason=>reason.startsWith('INTERNAL_CALL_IDENTITY_DEFECT')))extractionBlockers.push({code:'TOOL_FAILURE',file:req.provenance.file,message:unresolved.find(reason=>reason.startsWith('INTERNAL_CALL_IDENTITY_DEFECT'))!});

          const requestBody: WireType | null = req.requestBodyType ?? null;
          const expectedResponse: WireType = req.expectedResponseType ?? {
            kind: 'UNKNOWN',
            reason: 'Response type could not be resolved from call context',
          };

          if (expectedResponse.kind === 'UNKNOWN') {
             unresolvedEndpoints.push(`Unresolved response type for ${req.method} ${req.route.rawPath} at ${req.provenance.file}:${req.provenance.line}`);
          }
          if (unresolved.length > 0) {
             unresolvedEndpoints.push(...unresolved);
          }

          clientContracts.push({
            targetServiceId: parsed.targetServiceId,
            targetApiVersion: parsed.targetApiVersion,
            consumerTraversalComplete,
            callIdentity: req.provenance.callIdentity ? {...req.provenance.callIdentity,snapshot:snapshotRef.candidateSnapshot} : undefined,
            responseUsage: consumers.filter(c => c.propertyPath?.startsWith('$')),
            responseEffectsQualified: req.responseEffectsQualified===true && (req.clientKind!=='ANGULAR'||interceptorEvidence?.responseQualified===true),
            responseEffectAssumptions:req.clientKind==='ANGULAR'?interceptorEvidence?.assumptions:undefined,
            httpOptionsEvidence:req.httpOptionsEvidence?{...req.httpOptionsEvidence,sourceEvidence:[...(req.httpOptionsEvidence.sourceEvidence??[]),...(interceptorEvidence?.sourceEvidence??[])]}:undefined,
            routeDomain:req.routeDomain,
            requestTransport:req.requestTransport,
            requestEffectsQualified:req.requestEffectsQualified,
            absentRequestBodyQualified:req.clientKind==='ANGULAR'&&req.requestTransport?.kind==='ABSENT'&&req.httpOptionsEvidence?.requestBodyAbsent===true&&interceptorEvidence?.responseQualified===true,
            queryParametersPreserved:req.clientKind==='ANGULAR'&&req.httpOptionsEvidence?.queryParametersAbsent===true&&interceptorEvidence?.responseQualified===true&&!(interceptorEvidence.responseProjections?.length),
            responseProjections:req.clientKind==='ANGULAR'?interceptorEvidence?.responseProjections:undefined,
            sourceSha256: req.provenance.callIdentity?.sourceSha256 ?? createHash('sha256').update(content).digest('hex'),
            httpMethod: req.method,
            normalizedRoute: req.route.rawPath,
            requestBody,
            expectedResponse,
            decoderKind,
            consumers,
            unresolvedEvidence: unresolved,
            sourceFile: req.provenance.file,
            sourceLine: req.provenance.line,
          });
        }
      }

      coldCheckpoint('contract-extraction-end', {contracts: clientContracts.length});
      dependencyContext=resolutionFiles.manifest();
      for(const request of dependencyContext.requests)extractionBlockers.push({code:'UNRESOLVED_TS_TYPE',file:request.importer,message:`Dependency ${request.package}${request.version?'@'+request.version:''}: ${request.reason}`});
      log(`Extraction complete in ${Date.now() - extractT0}ms — contracts: ${clientContracts.length}`);
    } catch (err) {
      const msg = `Frontend extraction failed: ${(err as Error).message}`;
      log(`FATAL: ${msg}`);
      extractionBlockers.push({ code: 'TOOL_FAILURE', message: msg });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Assemble and deduplicate frontend payload (Envelope V2 Type Pool)
  // -------------------------------------------------------------------------
  const pathPool = new Set<string>();
  for (const cc of clientContracts) {
    if (cc.sourceFile) pathPool.add(cc.sourceFile);
    for (const c of cc.consumers) {
      if (c.file) pathPool.add(c.file);
      if (c.propertyPath) pathPool.add(c.propertyPath);
    }
  }
  const rawPayload: FrontendContractPayload = {
    dependencyContext,
    interceptorEvidence,
    clientContracts,
    path_pool: [...pathPool].sort(),
  };
  const payload = internTypePool(rawPayload);

  const allBlockers = [...captureBlockers, ...extractionBlockers];
  const isComplete = allBlockers.length === 0 && unresolvedEndpoints.length === 0;

  const completeness: ArtifactCompleteness = {
    complete: isComplete,
    unresolvedEndpoints,
    blockers: allBlockers,
  };

  // -------------------------------------------------------------------------
  // 6. Seal and emit envelope
  // -------------------------------------------------------------------------
  coldCheckpoint('seal-start');
  const sealed = sealEnvelope({
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
    reportSchemaVersion: SCHEMA_VERSION,
    kind: 'FRONTEND_CONTRACT',
    snapshot: snapshotRef,
    profile,
    completeness,
    payload,
  });

  log(`Envelope sealed (V2 deduplicated). complete=${isComplete} contracts=${clientContracts.length} type_pool=${Object.keys(payload.type_pool ?? {}).length} blockers=${allBlockers.length}`);
  log(`Integrity digest: ${sealed.integrity?.sha256.slice(0, 16)}...`);

  coldCheckpoint('seal-end');
  emitEnvelope(sealed, out);
  coldCheckpoint('write-end');
  process.exit(0);
}

function printUsage(): void {
  process.stderr.write(`
Usage: exportFrontendContract [options]

Required:
  --repo <path>          Path to the git repository root
  --parent <sha>         Parent (base) commit SHA
  --service-id <name>    Stable service identifier (e.g. "web-portal")

Candidate (exactly one required):
  --candidate <sha>      Candidate commit SHA to export
  --working-tree         Use current working-tree state as candidate

Optional:
  --api-version <v>      API version label (e.g. "v1", "2026-10")
  --target-service-id <id> Backend service for relative URLs
  --target-api-version <v> Backend API version
  --ts-root <path>       Filter TypeScript files to this POSIX prefix (e.g. "src")
  --out <path>           Write envelope JSON to this file (default: stdout)

Output:
  stdout                 Sealed ContractArtifactEnvelope JSON (frontend-contract.json)
  stderr                 Progress and diagnostic messages

Captured contract fields per HTTP client call:
  httpMethod             GET | POST | PUT | PATCH | DELETE
  normalizedRoute        Normalized route string (e.g. "/api/orders/{id}")
  requestBody            Wire type of request payload (null if none)
  expectedResponse       Expected response wire type (UNKNOWN if unresolvable)
  decoderKind            ZOD_STRICT | ZOD_DEFAULT | ZOD_PASSTHROUGH | TYPE_ASSERTION | INFERRED_TYPE | UNKNOWN
  consumers              Source file and line for each consumer site
  unresolvedEvidence     List of dynamic URLs and unresolvable types

Notes:
  - This is a PROPOSED capability; it is not yet part of the stable CLI.
  - completeness.complete=false indicates unresolved extraction; treat missing
    calls as UNRESOLVED, not deleted.
  - Dynamic URLs produce DYNAMIC_URL blockers in unresolvedEvidence.
  - Distribute artifacts only after TypeScriptContractParser correctness
    fixes are complete (see unified audit).
`);
}

main().catch(err => {
  process.stderr.write(`[exportFrontendContract] Unexpected error: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  process.exit(1);
});
