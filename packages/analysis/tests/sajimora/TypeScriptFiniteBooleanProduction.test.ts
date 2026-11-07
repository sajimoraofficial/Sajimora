import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EvidenceAcceptanceSession, GenericRepository, GenericRepositorySnapshot,
  ProductionVerificationCore, VerificationObligation } from '../../../core/src/sajimora/verification';
import { TypeScriptFiniteBooleanChecker, TypeScriptFiniteBooleanProof } from '../../src/sajimora/languages/typescript/production/TypeScriptFiniteBooleanProof';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { TypeScriptFiniteBooleanTypeChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptFiniteBooleanTypeProof';
import { TypeScriptBooleanClosedCoverageChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptBooleanClosedCoverageChecker';
import { verifyProductionInWorker } from '../../../../scripts/sajimora/productionExecution';

const source = (body: string) => `export function gate(x: boolean, y: boolean): boolean { return ${body}; }\n`;
const snapshot = (id: string, content: string): GenericRepositorySnapshot => ({ snapshotId: id, rootIdentifier: '/',
  files: [{ path: 'gate.ts', byteLength: Buffer.byteLength(content),
    hash: createHash('sha256').update(content).digest('hex') }],
  readTextFile: path => path === 'gate.ts' ? content : undefined,
  readBinaryFile: path => path === 'gate.ts' ? Buffer.from(content) : undefined });
const repository = (body: string): GenericRepository => ({ repositoryId: 'finite-repo',
  parentSnapshot: snapshot('parent', source('x && y')), candidateSnapshot: snapshot('candidate', source(body)) });
const entity = { entityId: 'gate-id', projectId: 'project', name: 'gate', kind: 'FUNCTION' as const,
  qualifiedName: 'gate', filePath: 'gate.ts', signatureFingerprint: '(boolean, boolean) => boolean', isExported: true };
const obligation: VerificationObligation = { obligationId: 'behavior', projectId: 'project',
  question: 'BEHAVIORAL_COMPATIBILITY', scope: 'PROVIDER', createdAt: '',
  change: { changeId: 'changed', changeKind: 'BODY_MUTATED', description: 'changed',
    identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
      parentEntity: entity, candidateEntity: entity } } };
const checker = new TypeScriptFiniteBooleanChecker();
const preservedRepo = repository('y && x');
const preserved = TypeScriptFiniteBooleanProof.propose(obligation, preservedRepo)!;
assert.equal(preserved.outcome, 'PRESERVED');
assert.equal(preserved.evidence.f0Formal?.proofTrace.length, 4);
assert.equal(preserved.evidence.metadata?.inputDomain, 'ALL_BOOLEAN_TUPLES_ONLY');
assert.equal(new EvidenceAcceptanceSession(preservedRepo, [checker]).verifyAndAccept(obligation, preserved), true);
const violatedRepo = repository('x || y');
const violated = TypeScriptFiniteBooleanProof.propose(obligation, violatedRepo)!;
assert.equal(violated.outcome, 'VIOLATED');
assert.equal(new EvidenceAcceptanceSession(violatedRepo, [checker]).verifyAndAccept(obligation, violated), true);
assert.equal(violated.evidence.f0Formal?.operationalWitness?.parentOutcome, 'false');
assert.equal(violated.evidence.f0Formal?.operationalWitness?.candidateOutcome, 'true');
for (const mutate of [
  (v: typeof preserved) => { v.outcome = 'VIOLATED'; },
  (v: typeof preserved) => { (v.evidence.f0Formal!.proofTrace as unknown[]).pop(); },
  (v: typeof preserved) => { (v.evidence.metadata as Record<string, unknown>).parentHash = '0'.repeat(64); },
  (v: typeof preserved) => { (v.evidence.metadata as Record<string, unknown>).domainSize = 1; }
]) {
  const forged = structuredClone(preserved);
  mutate(forged);
  assert.equal(new EvidenceAcceptanceSession(preservedRepo, [checker]).verifyAndAccept(obligation, forged), false);
}
assert.equal(TypeScriptFiniteBooleanProof.propose(obligation, repository('Boolean(x)')), undefined);
assert.equal(TypeScriptFiniteBooleanProof.propose(obligation, repository('true || eval("bad")')), undefined,
  'unsupported dead branch must not be admitted');
assert.equal(TypeScriptFiniteBooleanProof.propose(obligation, { ...preservedRepo,
  candidateSnapshot: snapshot('candidate', 'export function gate(x: boolean, y: boolean): boolean { console.log(x); return y; }') }), undefined);
const stale = repository('y && x');
stale.candidateSnapshot.readTextFile = () => source('x || y');
assert.equal(TypeScriptFiniteBooleanProof.propose(obligation, stale), undefined);

async function integration(): Promise<void> {
  const core = new ProductionVerificationCore([checker, new TypeScriptFiniteBooleanTypeChecker()],
    new TypeScriptBooleanClosedCoverageChecker());
  core.registerAdapter(new TypeScriptProductionAdapter());
  const unextracted = await core.verifyRepository({ repositoryId: 'unextracted-source',
    parentSnapshot: snapshot('empty-parent', '// before\n'),
    candidateSnapshot: snapshot('empty-candidate', '// after\n') });
  assert.ok(unextracted.ledger.verdicts.some(verdict =>
    verdict.evidence.unresolvedBoundary?.taxonomyCode === 'CHANGED_SOURCE_NOT_EXTRACTED'));
  assert.equal(unextracted.authoritativeVerdict.verdict, 'UNKNOWN');
  const positive = await core.verifyRepository(preservedRepo);
  assert.ok(positive.ledger.verdicts.some(verdict => verdict.property === 'BEHAVIOR' &&
    verdict.assurance === 'F0_FORMAL' && verdict.outcome === 'PRESERVED'));
  assert.equal(positive.authoritativeVerdict.verdict, 'UNKNOWN',
    'local behavioral preservation cannot certify every API/consumer route');
  const negative = await core.verifyRepository(violatedRepo);
  assert.ok(negative.ledger.verdicts.some(verdict => verdict.property === 'BEHAVIOR' &&
    verdict.assurance === 'F0_FORMAL' && verdict.outcome === 'VIOLATED'));
  assert.equal(negative.authoritativeVerdict.verdict, 'VIOLATED');
  const withoutChecker = new ProductionVerificationCore();
  withoutChecker.registerAdapter(new TypeScriptProductionAdapter());
  const unaccepted = await withoutChecker.verifyRepository(violatedRepo);
  assert.equal(unaccepted.authoritativeVerdict.verdict, 'UNKNOWN',
    'producer truth table cannot certify without independently registered acceptance');
  const workerPositive = await verifyProductionInWorker(preservedRepo);
  assert.ok(workerPositive.resources && workerPositive.resources.durationMs > 0 &&
    workerPositive.resources.sampledPeakProcessRssBytes > 0 &&
    workerPositive.resources.workerHeapUsedBytes > 0);
  await assert.rejects(verifyProductionInWorker(preservedRepo, { maxProcessRssBytes: 1 }),
    /RESOURCE_LIMIT_PROCESS_RSS/);
  assert.ok(workerPositive.ledger.verdicts.some(verdict => verdict.property === 'BEHAVIOR' &&
    verdict.assurance === 'F0_FORMAL' && verdict.outcome === 'PRESERVED'));
  const workerNegative = await verifyProductionInWorker(violatedRepo);
  assert.ok(workerNegative.ledger.verdicts.some(verdict => verdict.property === 'BEHAVIOR' &&
    verdict.assurance === 'F0_FORMAL' && verdict.outcome === 'VIOLATED'));
  assert.equal(workerNegative.authoritativeVerdict.verdict, 'VIOLATED');
  const withConsumer = (body: string): GenericRepository => {
    const consumer = "import { gate } from './gate';\nexport const answer = gate(true, false);\n";
    const make = (id: string, gateSource: string): GenericRepositorySnapshot => {
      const texts = new Map([['gate.ts', gateSource], ['use.ts', consumer]]);
      return { snapshotId: id, rootIdentifier: '/',
        files: [...texts].map(([path, value]) => ({ path, byteLength: Buffer.byteLength(value),
          hash: createHash('sha256').update(value).digest('hex') })),
        readTextFile: path => texts.get(path),
        readBinaryFile: path => { const value = texts.get(path); return value === undefined ? undefined : Buffer.from(value); } };
    };
    return { repositoryId: 'finite-repo', parentSnapshot: make('parent', source('x && y')),
      candidateSnapshot: make('candidate', source(body)) };
  };
  const consumerRun = await core.verifyRepository(withConsumer('y && x'));
  assert.equal(consumerRun.ledger.certificationStatus, 'CERTIFIED_PRESERVED');
  assert.equal(consumerRun.authoritativeVerdict.verdict, 'PRESERVED');
  const workerConsumer = await verifyProductionInWorker(withConsumer('y && x'));
  assert.equal(workerConsumer.ledger.certificationStatus, 'CERTIFIED_PRESERVED');
  assert.equal(workerConsumer.authoritativeVerdict.verdict, 'PRESERVED');
  console.log('Finite Boolean source proof and production adapter integration PASSED.');
}
integration().catch(error => { console.error(error); process.exitCode = 1; });
