/**
 * Executable TypeScript matrix campaign.  This is intentionally a campaign
 * harness, not an adapter: it never changes proof gates or asks an advisory
 * API for a verdict.  All executions go through evaluateRealCaseB.
 *
 * Usage:
 *   npm run campaign:ts-caseb -- --stage pilot
 *   npm run campaign:ts-caseb -- --stage scale --shard 0/8
 *   npm run campaign:ts-caseb -- --stage interactions
 */
import * as child from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';

type LedgerRow = { id: string; label: string; family: string; overlaps?: string[]; subcase?: boolean };
type Oracle = 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
const ROOT = path.resolve('artifacts/typescript-caseb-coverage-v1');
const LEDGER = path.resolve('artifacts/typescript_matrix_full_ledger_v1.json');
const GENERATOR = 'TS_CASEB_COVERAGE_CAMPAIGN_V1';
const CONTRACT_PATH = path.join(ROOT, 'coverage-contract-v2.json');
const PILOT_IDS = ['A1.v01','A1.v02','A1.v04','A2.v01','A2.v03','A3.v01','A4.v01','B1','B2','B6.v01','C1','C2','C7','D1','D5','AF1','AF2','AF3','AG12','AG14'];
const sha = (x: string | Buffer) => crypto.createHash('sha256').update(x).digest('hex');
const json = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const command = (cwd: string, args: string[]) => child.execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Sajimora campaign', GIT_AUTHOR_EMAIL: 'campaign@example.invalid', GIT_COMMITTER_NAME: 'Sajimora campaign', GIT_COMMITTER_EMAIL: 'campaign@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } }).trim();

function readLedger(): LedgerRow[] {
  const rows = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).rows as LedgerRow[];
  if (rows.length !== 475) throw new Error(`ledger cardinality changed: expected 475, got ${rows.length}`);
  const ids = new Set<string>();
  for (const row of rows) {
    if (!/^[A-Z]{1,2}\d+(?:\.v\d{2})?$/.test(row.id) || ids.has(row.id)) throw new Error(`invalid or duplicate stable row ID: ${row.id}`);
    ids.add(row.id);
    for (const overlap of row.overlaps ?? []) if (!rows.some(r => r.id === overlap)) throw new Error(`${row.id} names missing overlap ${overlap}`);
  }
  return rows;
}

function profile(row: LedgerRow): 'DIRECT' | 'ALIAS' | 'BARREL' | 'FAIL_CLOSED' | 'EXCLUDED' {
  const s = `${row.id} ${row.label}`.toLowerCase();
  if (row.id === 'AG12' || row.id === 'AG14') return 'FAIL_CLOSED';
  if (s.includes('barrel')) return 'BARREL';
  if (s.includes('alias') || s.includes('paths') || s.includes('baseurl')) return 'ALIAS';
  if (row.family === 'A' || row.id === 'AF1') return 'DIRECT';
  return 'EXCLUDED';
}

function exclusion(row: LedgerRow): string {
  if (row.family === 'AG') return 'CERTIFIED_F0_NO_UNAMBIGUOUS_SEALABLE_CASE_B_INPUT';
  return 'CERTIFIED_F0_PROFILE_DOES_NOT_DEFINE_THIS_RESOLUTION_OR_CONSUMER_SEMANTICS';
}

function sourceFor(row: LedgerRow, kind: ReturnType<typeof profile>) {
  const violated = parseInt(sha(row.id).slice(0, 2), 16) % 2 === 0;
  const candidateProvider = violated ? 'export function calc(required: number): number { return required; }\n' : 'export function calc(): number { return 2; }\n';
  const config: any = { compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node', baseUrl: '.', paths: { '@lib/*': ['lib/*'] } }, include: ['**/*.ts'] };
  const parent: Record<string, string> = { 'tsconfig.json': JSON.stringify(config, null, 2) + '\n', 'provider.ts': 'export function calc(): number { return 1; }\n', 'consumer.ts': 'import { calc } from "./provider";\nexport const use: number = calc();\n' };
  let targetFile = 'provider.ts';
  if (kind === 'ALIAS') { delete parent['provider.ts']; parent['lib/provider.ts'] = 'export function calc(): number { return 1; }\n'; parent['consumer.ts'] = 'import { calc } from "@lib/provider";\nexport const use: number = calc();\n'; targetFile = 'lib/provider.ts'; }
  if (kind === 'BARREL') { delete parent['provider.ts']; parent['lib/provider.ts'] = 'export function calc(): number { return 1; }\n'; parent['lib/index.ts'] = 'export { calc } from "./provider";\n'; parent['consumer.ts'] = 'import { calc } from "./lib";\nexport const use: number = calc();\n'; targetFile = 'lib/provider.ts'; }
  if (kind === 'FAIL_CLOSED') parent['consumer.ts'] += 'declare const p: string; void import(p);\n';
  return { parent, candidate: { [targetFile]: candidateProvider }, targetFile, expected: kind === 'FAIL_CLOSED' ? 'UNKNOWN' as Oracle : violated ? 'VIOLATED' as Oracle : 'PRESERVED' as Oracle };
}

function writeFiles(root: string, files: Record<string, string>) { for (const [name, data] of Object.entries(files)) { const out = path.join(root, name); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, data); } }
function materialize(row: LedgerRow, kind: Exclude<ReturnType<typeof profile>, 'EXCLUDED'>) {
  const spec = sourceFor(row, kind); const repo = path.join(ROOT, 'fixtures', row.id.replace('.', '_'));
  const sealFile = path.join(repo, 'seal.json');
  if (fs.existsSync(sealFile)) return JSON.parse(fs.readFileSync(sealFile, 'utf8'));
  fs.mkdirSync(repo, { recursive: true }); writeFiles(repo, spec.parent);
  command(repo, ['git', 'init']); command(repo, ['git', 'add', '.']); command(repo, ['git', 'commit', '-m', `parent ${row.id}`]); const parentSha = command(repo, ['git', 'rev-parse', 'HEAD']);
  writeFiles(repo, spec.candidate); command(repo, ['git', 'add', '.']); command(repo, ['git', 'commit', '-m', `candidate ${row.id}`]); const candidateSha = command(repo, ['git', 'rev-parse', 'HEAD']);
  const seal = { rowId: row.id, generatorVersion: GENERATOR, fixtureKind: kind, parentSha, candidateSha, targetFile: spec.targetFile, targetSymbol: 'calc', consumerFile: 'consumer.ts', expected: spec.expected, parentSourceSha256: sha(JSON.stringify(spec.parent)), candidateOverlaySha256: sha(JSON.stringify(spec.candidate)), effectiveTsconfigSha256: sha(spec.parent['tsconfig.json']), typescriptVersion: ts.version, dependencyLockSha256: sha(fs.readFileSync('package-lock.json')), resourceBudget: { profile: 'INITIAL_RESOURCE_PROFILE', campaignTimeoutMs: 120000 }, sealedBeforeInvocation: true };
  json(sealFile, seal); return seal;
}

function compilerOracle(repo: string, expected: Oracle) {
  if (expected === 'UNKNOWN') return { status: 'ORACLE_RESOLVED', verdict: 'UNKNOWN', method: 'predeclared unsupported fail-closed condition; not derived from Sajimora' };
  const out = child.spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  if (out.error || out.status === null) return { status: 'ORACLE_UNRESOLVED', verdict: null, method: 'TypeScript compiler could not complete', detail: String(out.error ?? 'signal') };
  return { status: 'ORACLE_RESOLVED', verdict: out.status === 0 ? 'PRESERVED' : 'VIOLATED', method: 'pinned TypeScript compiler diagnostic on sealed candidate tree', compilerExit: out.status, diagnosticsSha256: sha(`${out.stdout}\n${out.stderr}`) };
}

function execute(row: LedgerRow) {
  const kind = profile(row);
  if (kind === 'EXCLUDED') return { rowId: row.id, label: row.label, family: row.family, status: 'UNEXECUTED', exclusion: exclusion(row), represented: false, executedPublicCaseB: false, oracleStatus: 'ORACLE_UNRESOLVED' };
  const seal = materialize(row, kind); const repo = path.join(ROOT, 'fixtures', row.id.replace('.', '_'));
  // The independent compiler oracle is evaluated and persisted before Case-B.
  const oracle = compilerOracle(repo, seal.expected); const pre = { seal, oracle, preExecutionSha256: sha(JSON.stringify({ seal, oracle })) }; json(path.join(repo, 'pre-execution.json'), pre);
  const started = Date.now(); let result: any;
  try { result = CertifiedCampaignAdapter.evaluateRealCaseB({ repoPath: repo, repoId: `TSCC-${row.id}`, parentSha: seal.parentSha, candidateSha: seal.candidateSha, targetFile: seal.targetFile, targetSymbol: 'calc', consumerFile: seal.consumerFile, targetDeclarationKind: 'FunctionDeclaration', targetOwnerChain: [], targetDeclarationOrdinal: 0 }); }
  catch (error) { result = { verdictResult: { verdict: 'UNKNOWN' }, failedGate: 'ENGINE_RUNTIME', blockerCode: 'ENGINE_RUNTIME', detailMessage: String(error), passedGates: [] }; }
  const actual = result.verdictResult?.verdict ?? 'UNKNOWN'; const certified = (result.passedGates ?? []).includes('VERDICT_AUTHORITY');
  return { rowId: row.id, label: row.label, family: row.family, status: 'EXECUTED', represented: true, executedPublicCaseB: true, fixtureKind: kind, seal, oracle, actualVerdict: actual, certified, proofPathValid: certified, firstFailingGate: result.failedGate ?? null, blocker: result.blockerCode ?? null, runtimeMs: Date.now() - started, resourceOutcome: result.failedGate === 'RESOURCE' ? 'RESOURCE_EXHAUSTION' : 'NONE', correctCertifiedVerdict: certified && oracle.status === 'ORACLE_RESOLVED' && actual === oracle.verdict };
}

function summary(results: any[], rows: LedgerRow[]) {
  const n = (p: (r: any) => boolean) => results.filter(p).length;
  const by = (key: 'family' | 'fixtureKind') => Object.fromEntries([...new Set(results.map(r => r[key]).filter(Boolean))].sort().map(v => [v, { total: n(r => r[key] === v), represented: n(r => r[key] === v && r.represented), executed: n(r => r[key] === v && r.executedPublicCaseB), correctCertified: n(r => r[key] === v && r.correctCertifiedVerdict) }]));
  return { denominator: 475, rowsRepresentedByValidSealedFixtures: n(r => r.represented), rowsActuallyExecutedThroughPublicCaseB: n(r => r.executedPublicCaseB), rowsWithIndependentOracle: n(r => r.oracle?.status === 'ORACLE_RESOLVED'), rowsWithCorrectCertifiedVerdicts: n(r => r.correctCertifiedVerdict), expectedUnknown: n(r => r.oracle?.verdict === 'UNKNOWN' && r.actualVerdict === 'UNKNOWN'), unexpectedUnknown: n(r => r.executedPublicCaseB && r.oracle?.verdict !== 'UNKNOWN' && r.actualVerdict === 'UNKNOWN'), verifiedFailClosedNegatives: n(r => r.fixtureKind === 'FAIL_CLOSED' && r.actualVerdict === 'UNKNOWN'), invalidInput: n(r => r.status === 'INVALID_INPUT'), resourceExhaustion: n(r => r.resourceOutcome === 'RESOURCE_EXHAUSTION'), certifiedOracleMismatches: n(r => r.certified && r.oracle?.status === 'ORACLE_RESOLVED' && r.actualVerdict !== r.oracle.verdict), proofPathViolations: n(r => r.executedPublicCaseB && !r.proofPathValid && r.actualVerdict !== 'UNKNOWN'), unexecutedIds: results.filter(r => r.status === 'UNEXECUTED').map(r => r.rowId), oracleUnresolvedIds: results.filter(r => r.oracleStatus === 'ORACLE_UNRESOLVED' || r.oracle?.status === 'ORACLE_UNRESOLVED').map(r => r.rowId), family: by('family'), composition: by('fixtureKind'), interactions: { required: 4, covered: 0, note: 'Selected interactions are frozen in the contract and are blocked until the individual-row scale report exists.' }, releaseBlocked: n(r => r.certified && r.oracle?.status === 'ORACLE_RESOLVED' && r.actualVerdict !== r.oracle.verdict) > 0 || n(r => r.executedPublicCaseB && !r.proofPathValid && r.actualVerdict !== 'UNKNOWN') > 0 };
}

function main() {
  const stage = (process.argv[process.argv.indexOf('--stage') + 1] ?? 'pilot'); const shard = process.argv.includes('--shard') ? process.argv[process.argv.indexOf('--shard') + 1] : '0/1';
  if (!['pilot', 'scale', 'interactions', 'validate'].includes(stage)) throw new Error('stage must be pilot, scale, interactions, or validate');
  const rows = readLedger(); const contract = { schemaVersion: 'TSCC_EXECUTABLE_CONTRACT_V2', ledgerSha256: sha(fs.readFileSync(LEDGER)), generatorVersion: GENERATOR, stableRowCount: rows.length, validation: { uniqueStableIds: true, overlapReferencesValid: true, fixtureReusePolicy: 'A sealed fixture is private to one row; reuse is prohibited unless source, oracle, revision pair, and consumer set hashes are identical.', scenarioDefinitionPolicy: 'Each represented row has fixtureKind plus a sealed source tree; exclusions retain their original row ID and reason.' }, requiredIndividuals: rows.map(r => r.id), requiredInteractions: [ { id: 'TSCC-I2-001', order: 2, rows: ['A2.v01', 'B1'] }, { id: 'TSCC-I2-002', order: 2, rows: ['C2', 'AG14'] }, { id: 'TSCC-I3-001', order: 3, rows: ['A2.v03', 'C7', 'B6.v01'] }, { id: 'TSCC-I4-001', order: 4, rows: ['A2.v03', 'B1', 'C2', 'AF3'] } ], createdBeforeExecution: true };
  fs.mkdirSync(ROOT, { recursive: true });
  if (fs.existsSync(CONTRACT_PATH) && sha(fs.readFileSync(CONTRACT_PATH)) !== sha(JSON.stringify(contract, null, 2) + '\n')) throw new Error('coverage contract is already frozen with different bytes; create a new version instead');
  if (!fs.existsSync(CONTRACT_PATH)) json(CONTRACT_PATH, contract);
  if (stage === 'validate') { console.log(JSON.stringify({ valid: true, rows: rows.length, contractSha256: sha(JSON.stringify(contract)) }, null, 2)); return; }
  if (stage === 'interactions') throw new Error('interaction stage is blocked: individual-row campaign is not complete');
  if (stage === 'scale' && !fs.existsSync(path.join(ROOT, 'pilot-results.json'))) throw new Error('scale is blocked until the sealed pilot has been run');
  let chosen = stage === 'pilot' ? rows.filter(r => PILOT_IDS.includes(r.id)) : rows;
  if (stage === 'pilot' && chosen.length !== 20) throw new Error(`pilot selection drifted: ${chosen.length}`);
  const [part, whole] = shard.split('/').map(Number); if (!Number.isInteger(part) || !Number.isInteger(whole) || part < 0 || part >= whole) throw new Error(`invalid shard ${shard}`);
  chosen = chosen.filter((_, i) => i % whole === part);
  const stem = `${stage}-results${whole === 1 ? '' : `-shard-${part}-of-${whole}`}`;
  const output = path.join(ROOT, `${stem}.json`); const checkpoint = path.join(ROOT, `${stem}.checkpoint.json`);
  const prior = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : { results: [] };
  const completed = new Map<string, any>(prior.results.map((r: any) => [r.rowId, r]));
  for (const row of chosen) {
    if (completed.has(row.id)) continue;
    const record = execute(row); completed.set(row.id, record);
    // Checkpoint after each row.  Resume never regenerates a seal and never
    // changes a recorded input pair.
    json(checkpoint, { schemaVersion: 'TSCC_EXECUTABLE_CHECKPOINT_V1', stage, shard, contractSha256: sha(JSON.stringify(contract)), results: [...completed.values()] });
  }
  const results = chosen.map(row => completed.get(row.id)); const report = { schemaVersion: 'TSCC_EXECUTABLE_RESULTS_V1', stage, shard, contractSha256: sha(JSON.stringify(contract)), createdAt: new Date().toISOString(), results, summary: summary(results, rows), reproduce: `node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/run_typescript_caseb_coverage_campaign.ts --stage ${stage} --shard ${shard}` };
  json(output, report); console.log(JSON.stringify(report.summary, null, 2));
}
main();
