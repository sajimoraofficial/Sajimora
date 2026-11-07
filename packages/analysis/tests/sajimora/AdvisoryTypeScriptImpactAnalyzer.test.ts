import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AdvisoryTypeScriptImpactAnalyzer, assessAdvisoryPromotionReadiness, createAdvisoryReport, reconcileAdvisoryResult, renderAdvisoryMarkdown, RepositoryRevisionAnalyzer, runAdvisoryBenchmark } from '../../src/sajimora/advisory';

const analyzer = new AdvisoryTypeScriptImpactAnalyzer();
const started = performance.now();
const startRss = process.memoryUsage().rss;
const parent = { commitSha: 'parent', files: {
  'api.ts': 'export function getUser(id: string): User { return { name: id }; } export interface User { name: string; }',
  'consumer.ts': "import { getUser, User } from './api'; export const user: User = getUser('a');"
} };
const candidate = { commitSha: 'candidate', files: {
  'api.ts': 'export function getUser(id: string): User | undefined { return undefined; } export interface User { name: string; }',
  'consumer.ts': "import { getUser, User } from './api'; export const user: User = getUser('a');"
} };

const result = analyzer.analyze({ parent, candidate });
assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
assert.equal(result.verdict, 'LIKELY_VIOLATED');
assert.equal(result.completeness.status, 'COMPLETE');
assert.equal(result.providers.length, 1);
assert.equal(result.providers[0].id, 'api.ts#getUser');
assert.equal(result.impacts.length, 1);
assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2322));
assert.equal(result.impacts[0].parentDiagnostics.length, 0);
assert.ok(result.impacts[0].candidateDiagnostics.some(d => d.code === 2322));
assert.ok(result.impacts[0].parentInferredType);
assert.ok(result.impacts[0].candidateInferredType);
assert.equal(result.traces.length, 1);
assert.deepEqual(result.traces[0].steps.map(step => step.kind), ['PROVIDER', 'IMPORT', 'CONSUMER', 'USAGE', 'DIAGNOSTIC']);
assert.equal(result.traces[0].completeness, 'COMPLETE');
assert.equal(result.completeness.consumersAnalyzed, 2);
assert.equal(result.consumers.filter(c => c.providerId === 'api.ts#getUser').length, 2);
assert.ok(result.consumers.some(c => c.referenceKind === 'IMPORT' && c.directness === 'DIRECT'));
assert.ok(result.consumers.some(c => c.referenceKind === 'CALL' && c.resolutionStatus === 'COMPLETE'));
assert.deepEqual(analyzer.analyze({ parent, candidate }), result, 'sealed analysis must be deterministic');
// Reconciliation is display-only: an advisory violation must never upgrade UNKNOWN.
const unknownReconciled = reconcileAdvisoryResult({ verdict: 'UNKNOWN', reason: 'F0 unsupported construct' }, result);
assert.equal(unknownReconciled.final.verdict, 'UNKNOWN');
assert.equal(unknownReconciled.final.advisoryFinding, 'LIKELY_VIOLATED');
assert.equal(unknownReconciled.final.conflict, null);
const report = createAdvisoryReport(unknownReconciled);
assert.equal(report.certifiedPanel.verdict, 'UNKNOWN');
assert.equal(report.broaderImpactPanel.verdict, 'LIKELY_VIOLATED');
assert.equal(report.broaderImpactPanel.consumersAffected, 1);
assert.equal(report.broaderImpactPanel.consumersAnalyzed, 2);
assert.equal(report.evidence.traces.length, 1);
const markdown = renderAdvisoryMarkdown(report);
assert.ok(markdown.includes('## Certified result'));
assert.ok(markdown.includes('Advisory result: LIKELY_VIOLATED'));
assert.equal(renderAdvisoryMarkdown(report), markdown, 'report rendering must be deterministic');
const preservedConflict = reconcileAdvisoryResult({ verdict: 'PRESERVED', reason: 'certified proof' }, result);
assert.equal(preservedConflict.final.verdict, 'UNKNOWN');
assert.equal(preservedConflict.final.conflict?.certifiedVerdict, 'PRESERVED');
const certifiedViolation = reconcileAdvisoryResult({ verdict: 'VIOLATED', reason: 'certified counterexample' }, { ...result, verdict: 'LIKELY_VIOLATED' });
assert.equal(certifiedViolation.final.verdict, 'VIOLATED');
const notApplicable = reconcileAdvisoryResult({ verdict: 'NOT_APPLICABLE', reason: 'out of scope' }, result);
assert.equal(notApplicable.final.verdict, 'NOT_APPLICABLE');

const providerMatrix = (before: string, after: string) => analyzer.analyze({ parent: { commitSha: 'p', files: { 'api.ts': before } }, candidate: { commitSha: 'c', files: { 'api.ts': after } } }).providers[0];
assert.equal(providerMatrix('export function f(a: string, b: number): string { return a; }', 'export function f(a: string): string { return a; }').change, 'PARAMETER_REMOVED');
assert.equal(providerMatrix('export function f(): string { return ""; }', 'export function f(): string | undefined { return undefined; }').change, 'RETURN_TYPE_CHANGED');
assert.equal(providerMatrix('export interface User { name: string; age: number; }', 'export interface User { name: string; }').change, 'PROPERTY_REMOVED');
assert.equal(providerMatrix('export interface User { name: string; }', 'export interface User { name?: string; }').change, 'PROPERTY_MADE_OPTIONAL');
assert.equal(providerMatrix('export function f(a: string): string; export function f(a: string) { return a; }', 'export function f(a: string): string; export function f(a: number): string; export function f(a: string | number) { return String(a); }').change, 'OVERLOAD_CHANGED');
assert.equal(providerMatrix('export const f = 1;', '').change, 'EXPORT_REMOVED');
const reexport = analyzer.analyze({ parent: { commitSha: 'p', files: { 'api.ts': 'export const value = 1;', 'barrel.ts': "export { value } from './api';" } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const value = 1;', 'barrel.ts': 'export {};' } } });
assert.equal(reexport.providers.find(p => p.id === 'barrel.ts#value')?.change, 'EXPORT_REMOVED');
assert.equal(reexport.providers.find(p => p.id === 'barrel.ts#value')?.identity, 'CASE_B');

const incomplete = analyzer.analyze({ parent, candidate: { commitSha: 'candidate-2', files: { ...candidate.files, 'consumer.ts': "import { getUser } from './missing'; getUser('a');" } } });
assert.equal(incomplete.verdict, 'INCONCLUSIVE');
assert.equal(incomplete.completeness.status, 'INCOMPLETE');
assert.ok(incomplete.completeness.resolutionTraces.some(t => t.includes('UNRESOLVED')));

// A sealed tsconfig, package-style dependency, and transitive local closure are all
// resolved from the revision byte map in lexical order—never node_modules on the host.
const repositoryParent = { commitSha: 'repo-parent', tsconfigPath: 'tsconfig.json', files: {
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@repo/*': ['packages/*/src'] }, strict: true }, include: ['apps/**/*.ts', 'packages/**/*.ts'] }),
  'packages/api/src/index.ts': 'export const getValue = (): string => "ok";',
  'packages/middle/src/index.ts': "export { getValue } from '@repo/api';",
  'apps/web/main.ts': "import { getValue } from '@repo/middle'; export const value: string = getValue();"
} };
const repositoryCandidate = { ...repositoryParent, commitSha: 'repo-candidate', files: { ...repositoryParent.files, 'packages/api/src/index.ts': 'export const getValue = (): string | undefined => undefined;' } };
const repositoryResult = analyzer.analyze({ parent: repositoryParent, candidate: repositoryCandidate });
assert.equal(repositoryResult.verdict, 'LIKELY_VIOLATED');
assert.equal(repositoryResult.completeness.status, 'COMPLETE');
assert.equal(repositoryResult.impacts.length, 1);
assert.ok(repositoryResult.completeness.resolutionTraces.some(t => t.includes('@repo/middle')));
assert.equal(repositoryResult.compilerOptions.baseUrl, '/sealed');
const transitiveCall = repositoryResult.consumers.find(c => c.referenceKind === 'CALL');
assert.deepEqual(transitiveCall?.dependencyPath, ['packages/api/src/index.ts', 'packages/middle/src/index.ts', 'apps/web/main.ts']);
assert.equal(transitiveCall?.directness, 'TRANSITIVE');
assert.ok(repositoryResult.consumers.some(c => c.referenceKind === 'RE_EXPORT'));
const transitiveTrace = repositoryResult.traces.find(trace => trace.dependencyPath.length === 3);
assert.deepEqual(transitiveTrace?.steps.map(step => step.kind), ['PROVIDER', 'RE_EXPORT', 'IMPORT', 'CONSUMER', 'USAGE', 'DIAGNOSTIC']);
assert.equal(repositoryResult.completeness.unresolvedDependencyCount, 0);

const widened = analyzer.analyze({ parent: { commitSha: 'p', files: { 'api.ts': 'export const value: string = "x";', 'use.ts': "import { value } from './api'; export const observed = value;" } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const value: string | undefined = undefined;', 'use.ts': "import { value } from './api'; export const observed = value;" } } });
assert.equal(widened.impacts.find(i => i.consumer.file === 'use.ts')?.classification, 'NEWLY_WIDENED_SAFE');
const narrowed = analyzer.analyze({ parent: { commitSha: 'p', files: { 'api.ts': 'export const value: string | undefined = undefined;', 'use.ts': "import { value } from './api'; export const observed = value;" } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const value: string = "x";', 'use.ts': "import { value } from './api'; export const observed = value;" } } });
assert.equal(narrowed.impacts.find(i => i.consumer.file === 'use.ts')?.classification, 'NEWLY_NARROWED');
const configDependent = analyzer.analyze({ parent: { commitSha: 'p', files: { 'tsconfig.json': '{"compilerOptions":{"strict":false}}', 'api.ts': 'export const value: string = "x";', 'use.ts': "import { value } from './api'; export const observed = value;" } }, candidate: { commitSha: 'c', files: { 'tsconfig.json': '{"compilerOptions":{"strict":true}}', 'api.ts': 'export const value: string | undefined = undefined;', 'use.ts': "import { value } from './api'; export const observed = value;" } } });
assert.equal(configDependent.impacts.find(i => i.consumer.file === 'use.ts')?.classification, 'CONFIGURATION_DEPENDENT');

const benchmark = runAdvisoryBenchmark([
  { name: 'preserved', input: { parent, candidate: parent }, expectedVerdict: 'LIKELY_PRESERVED', expectedConsumerCount: 0, tags: ['preserved'] },
  { name: 'breaking-return', input: { parent, candidate }, expectedVerdict: 'LIKELY_VIOLATED', expectedConsumerCount: 2, tags: ['breaking', 'return-type'] },
  { name: 'deletion', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export const oldValue = 1;' } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export {};' } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['deletion'] },
  { name: 'widening', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export const value: string = "x";', 'use.ts': "import { value } from './api'; export const observed = value;" } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const value: string | undefined = undefined;', 'use.ts': "import { value } from './api'; export const observed = value;" } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['widening'] },
  { name: 'narrowing', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export const value: string | undefined = undefined;', 'use.ts': "import { value } from './api'; export const observed = value;" } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const value: string = "x";', 'use.ts': "import { value } from './api'; export const observed = value;" } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['narrowing'] },
  { name: 'overload', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export function f(a: string): string; export function f(a: string) { return a; }' } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export function f(a: string): string; export function f(a: number): string; export function f(a: string | number) { return String(a); }' } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['overload'] },
  { name: 'jsx', input: { parent: { commitSha: 'p', files: { 'api.tsx': 'export const View = (): string => "x";', 'use.tsx': "import { View } from './api'; export const node = <View />;" } }, candidate: { commitSha: 'c', files: { 'api.tsx': 'export const View = (): string => "x";', 'use.tsx': "import { View } from './api'; export const node = <View />;" } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['jsx'] },
  { name: 'generics', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export const id = <T>(v: T): T => v;' } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const id = <T>(v: T): T => v;' } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['generics'] },
  { name: 'package-subpath', input: { parent: { commitSha: 'p', files: { 'node_modules/pkg/sub/index.ts': 'export const value = 1;', 'use.ts': "import { value } from 'pkg/sub'; export const seen = value;" } }, candidate: { commitSha: 'c', files: { 'node_modules/pkg/sub/index.ts': 'export const value = 1;', 'use.ts': "import { value } from 'pkg/sub'; export const seen = value;" } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['package-subpath'] },
  { name: 'unresolved', input: { parent: { commitSha: 'p', files: { 'use.ts': "import { missing } from './missing'; missing();" } }, candidate: { commitSha: 'c', files: { 'use.ts': "import { missing } from './missing'; missing();" } } }, expectedVerdict: 'INCONCLUSIVE', tags: ['unresolved'] },
  { name: 'case-b', input: { parent: { commitSha: 'p', files: { 'api.ts': 'export const oldName = 1;' } }, candidate: { commitSha: 'c', files: { 'api.ts': 'export const newName = 1;' } } }, expectedVerdict: 'LIKELY_PRESERVED', tags: ['case-b'] }
]);
assert.equal(benchmark.cases.length, 11);
assert.equal(benchmark.metrics.deterministicRepeatability, 1);
assert.equal(benchmark.metrics.consumerDiscoveryRecall, 1);
assert.ok(benchmark.metrics.runtimeMs >= 0);
const readiness = assessAdvisoryPromotionReadiness({ capabilityId: 'sealed-ts-impact-v1', sealedEvidence: true, deterministicReplay: true, independentlyVerifiableResolution: true, completeConsumerCoverage: false, explicitProofRules: false, adversarialTests: false, stableBenchmark: false, benchmark });
assert.equal(readiness.currentStatus, 'ADVISORY_ONLY');
assert.equal(readiness.readiness, 'NOT_READY');
assert.deepEqual(readiness.missingRequirements, ['complete consumer coverage', 'explicit proof rules', 'adversarial tests', 'stable benchmark results']);
const reviewReady = assessAdvisoryPromotionReadiness({ capabilityId: 'future-f1', sealedEvidence: true, deterministicReplay: true, independentlyVerifiableResolution: true, completeConsumerCoverage: true, explicitProofRules: true, adversarialTests: true, stableBenchmark: true, benchmark });
assert.equal(reviewReady.readiness, 'ELIGIBLE_FOR_REVIEW');
assert.equal(reviewReady.currentStatus, 'ADVISORY_ONLY', 'readiness must not promote a certified verdict');

// Production bridge: generic Git commits become sealed in-memory worlds. No query ID,
// repository identity, or construct-specific branch participates in this path.
const gitRoot = mkdtempSync(join(tmpdir(), 'sajimora-advisory-git-'));
try {
  const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(gitRoot, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(gitRoot, 'api.ts'), 'export const getValue = (): string => "x";');
  writeFileSync(join(gitRoot, 'use.ts'), "import { getValue } from './api'; export const value: string = getValue();");
  mkdirSync(join(gitRoot, 'unrelated')); for (let i = 0; i < 64; i++) writeFileSync(join(gitRoot, 'unrelated', `file-${i}.ts`), `export const unrelated${i} = ${i};`);
  git('add', '.'); git('commit', '-m', 'parent'); const parentSha = git('rev-parse', 'HEAD');
  writeFileSync(join(gitRoot, 'api.ts'), 'export const getValue = (): string | undefined => undefined;');
  git('add', '.'); git('commit', '-m', 'candidate'); const candidateSha = git('rev-parse', 'HEAD');
  const bridgeResult = new RepositoryRevisionAnalyzer().analyze({ repositoryPath: gitRoot, parentSha, candidateSha, target: { file: 'api.ts', symbol: 'getValue' } });
  assert.equal(bridgeResult.parentCommitSha, parentSha);
  assert.equal(bridgeResult.candidateCommitSha, candidateSha);
  assert.equal(bridgeResult.verdict, 'LIKELY_VIOLATED');
  assert.equal(bridgeResult.providers.length, 1);
  assert.equal(bridgeResult.impacts[0].classification, 'NEWLY_FAILING');
  assert.equal(bridgeResult.completeness.selection?.parent?.selectedFiles, 3);
  assert.ok((bridgeResult.completeness.selection?.parent.excludedFiles ?? 0) >= 64);
  const materialized = new RepositoryRevisionAnalyzer().materialize({ repositoryPath: gitRoot, parentSha, candidateSha, target: { file: 'api.ts', symbol: 'getValue' } });
  assert.equal(Object.keys(materialized.parent.files).some(file => file.startsWith('unrelated/')), false, 'unrelated files must not enter the advisory Program input');
  const exhausted = new RepositoryRevisionAnalyzer().analyze({ repositoryPath: gitRoot, parentSha, candidateSha, target: { file: 'api.ts', symbol: 'getValue' }, resourceLimits: { maxSelectedFiles: 1 } });
  assert.equal(exhausted.verdict, 'INCONCLUSIVE');
  assert.ok(exhausted.completeness.unresolvedFiles.some(reason => reason.includes('BUDGET')));
  writeFileSync(join(gitRoot, 'use.ts'), "import { getValue } from './api'; import { missing } from './missing'; export const value: string = getValue(); missing();");
  git('add', '.'); git('commit', '-m', 'missing dependency'); const missingCandidateSha = git('rev-parse', 'HEAD');
  const incompleteClosure = new RepositoryRevisionAnalyzer().analyze({ repositoryPath: gitRoot, parentSha, candidateSha: missingCandidateSha, target: { file: 'api.ts', symbol: 'getValue' } });
  assert.equal(incompleteClosure.verdict, 'INCONCLUSIVE');
  assert.ok(incompleteClosure.completeness.unresolvedFiles.some(reason => reason.includes('missing')));
} finally { rmSync(gitRoot, { recursive: true, force: true }); }

// Real repository end-to-end: collect the entire core package once, then the analyzer
// receives only the resulting sealed bytes (and performs no filesystem reads itself).
const coreRoot = 'packages/core/src'; const coreFiles: Record<string, string> = {};
const collect = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? collect(join(dir, entry.name)) : entry.name.endsWith('.ts') && (coreFiles[relative('.', join(dir, entry.name)).replace(/\\/g, '/')] = readFileSync(join(dir, entry.name), 'utf8')); };
collect(coreRoot);
const realRepoResult = analyzer.analyze({ parent: { commitSha: 'workspace-head', files: coreFiles }, candidate: { commitSha: 'workspace-head', files: coreFiles } });
assert.equal(realRepoResult.verdict, 'INCONCLUSIVE');
assert.equal(realRepoResult.completeness.status, 'INCOMPLETE');
assert.deepEqual(realRepoResult.completeness.unresolvedFiles, [
  'packages/core/src/sajimora/certified/canonicalEncoding.ts -> crypto',
  'packages/core/src/sajimora/certified/schemas.ts -> zod',
  'packages/core/src/sajimora/types/closure.ts -> path'
]);
console.log(JSON.stringify({ benchmark: benchmark.metrics, realRepoResult: { verdict: realRepoResult.verdict, impacts: realRepoResult.impacts.length, unresolved: realRepoResult.completeness.unresolvedFiles, compiler: realRepoResult.compilerVersion }, telemetry: { elapsedMs: Math.round(performance.now() - started), rssDeltaBytes: process.memoryUsage().rss - startRss } }));
