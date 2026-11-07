import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EvidenceAcceptanceSession, GenericRepository, GenericRepositorySnapshot, VerificationObligation, VerificationVerdict, ConservationGate } from '../../../core/src/sajimora/verification';
import { TypeScriptOperationalEvaluator } from '../../src/sajimora/languages/typescript/production/TypeScriptOperationalEvaluator';
import { TypeScriptNumericWitnessChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';

function snapshot(snapshotId: string, source: string): GenericRepositorySnapshot {
  return { snapshotId, rootIdentifier: '/', files: [{ path: 'compute.ts', byteLength: Buffer.byteLength(source), hash: createHash('sha256').update(source).digest('hex') }],
    readTextFile: file => file === 'compute.ts' ? source : undefined,
    readBinaryFile: file => file === 'compute.ts' ? Buffer.from(source) : undefined };
}
const repository = (before = 'x * 2', after = 'x * 200'): GenericRepository => ({ repositoryId: 'arbitrary-repository',
  parentSnapshot: snapshot('parent', `export function compute(x: number) { return ${before}; }`),
  candidateSnapshot: snapshot('candidate', `export function compute(x: number) { return ${after}; }`) });
const entity = (entityId: string) => ({ entityId, projectId: 'project', name: 'compute', qualifiedName: 'compute', kind: 'FUNCTION' as const,
  filePath: 'compute.ts', signatureFingerprint: '(number)=>number', isExported: true });
const obligation = (): VerificationObligation => ({ obligationId: 'ob', projectId: 'project', question: 'BEHAVIORAL_COMPATIBILITY',
  scope: 'PROVIDER', createdAt: '', change: { changeId: 'change', changeKind: 'BODY_MUTATED', description: '',
    identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN', parentEntity: entity('parent-fn'), candidateEntity: entity('candidate-fn') } } });
const checker = new TypeScriptNumericWitnessChecker();
const repo = repository(), ob = obligation();
const produce = () => TypeScriptOperationalEvaluator.evaluateOperationalBehavior(ob, repo);
const session = () => new EvidenceAcceptanceSession(repo, [checker]);
const verdict = produce(), accepted = session();
assert.equal(verdict.outcome, 'VIOLATED');
assert.equal(accepted.hasVerifiedAttestation(verdict), false, 'A producer cannot mint acceptance');
assert.equal(accepted.verifyAndAccept(ob, verdict), true);
assert.equal(accepted.hasVerifiedAttestation(verdict, ob), true);
assert.equal(session().hasVerifiedAttestation(verdict), false, 'Acceptance cannot cross executions');
assert.equal(accepted.hasVerifiedAttestation(structuredClone(verdict)), false, 'Serialized receipts must replay');
assert.throws(() => ConservationGate.reconcileAndEnforce([], [ob], [verdict]), /Unverified evidence/);
assert.equal(ConservationGate.reconcileAndEnforce([], [ob], [verdict], accepted).conservationSatisfied, true);
assert.equal(accepted.hasVerifiedAttestation(verdict, { ...ob, question: 'API_COMPATIBILITY' }), false);
assert.equal(new EvidenceAcceptanceSession(repo).verifyAndAccept(ob, verdict), false, 'Missing checker fails closed');
assert.throws(() => new EvidenceAcceptanceSession(repo, [checker, checker]), /DUPLICATE/);

const mutations: Array<(v: VerificationVerdict) => void> = [
  v => { v.outcome = 'PRESERVED'; },
  v => { v.assurance = 'F0_FORMAL'; v.evidence.assurance = 'F0_FORMAL'; },
  v => { v.provenance.repositoryId = 'other'; },
  v => { v.provenance.identityId = 'other'; },
  v => { v.targetEntityId = 'other'; },
  v => { v.scope = 'CONSUMER'; },
  v => { v.property = 'API_TYPE'; },
  v => { v.evidence.metadata = { ...v.evidence.metadata, candidateSnapshot: 'other' }; },
  v => { v.evidence.metadata = { ...v.evidence.metadata, candidateFile: 'other.ts' }; },
  v => { v.evidence.f0Formal!.operationalWitness!.candidateOutcome = '999'; },
  v => { v.evidence.f0Formal!.operationalWitness!.inputDomainWitness = [0]; },
  v => { v.evidence.metadata = { ...v.evidence.metadata, verificationProfile: 'UNREGISTERED' }; }
];
for (const mutate of mutations) {
  const forged = produce(); mutate(forged);
  assert.equal(session().verifyAndAccept(ob, forged), false);
}
const wrongSource = repository();
wrongSource.candidateSnapshot.readTextFile = () => 'export function compute(x: number) { return x * 2; }';
assert.equal(new EvidenceAcceptanceSession(wrongSource, [checker]).verifyAndAccept(ob, produce()), false, 'Hash mismatch rejects stale source');
const duplicate = repository();
duplicate.parentSnapshot.files = [...duplicate.parentSnapshot.files, ...duplicate.parentSnapshot.files];
assert.equal(new EvidenceAcceptanceSession(duplicate, [checker]).verifyAndAccept(ob, produce()), false);
const tampered = produce(), tamperSession = session();
assert.equal(tamperSession.verifyAndAccept(ob, tampered), true);
tampered.evidence.f0Formal!.operationalWitness!.candidateOutcome = 'wrong';
assert.equal(tamperSession.hasVerifiedAttestation(tampered), false);
const roundingRepo = repository('(x + 1) + 2', 'x + 3');
const rounding = TypeScriptOperationalEvaluator.evaluateOperationalBehavior(ob, roundingRepo);
assert.equal(rounding.outcome, 'VIOLATED');
assert.equal(new EvidenceAcceptanceSession(roundingRepo, [checker]).verifyAndAccept(ob, rounding), true);
const sameRepo = repository('x * 2', 'x * 2');
assert.equal(TypeScriptOperationalEvaluator.evaluateOperationalBehavior(ob, sameRepo).outcome, 'UNKNOWN');
// Signed zero must survive the acceptance fingerprint.
const zeroRepo = repository('x', '-x');
const zero = TypeScriptOperationalEvaluator.evaluateOperationalBehavior(ob, zeroRepo);
const zeroSession = new EvidenceAcceptanceSession(zeroRepo, [checker]);
assert.equal(zeroSession.verifyAndAccept(ob, zero), true);
zero.evidence.f0Formal!.operationalWitness!.inputDomainWitness = [-0];
assert.equal(zeroSession.hasVerifiedAttestation(zero), false);
assert.equal(zeroSession.verifyAndAccept(ob, zero), false);
console.log('Evidence acceptance boundary: valid replay, forged evidence, exact binding, mutation, cross-session isolation and IEEE-754 regressions passed.');
const mutableObligation = obligation(), mutableVerdict = TypeScriptOperationalEvaluator.evaluateOperationalBehavior(mutableObligation, repo);
const mutationSession = session();
assert.equal(mutationSession.verifyAndAccept(mutableObligation, mutableVerdict), true);
mutableObligation.question = 'API_COMPATIBILITY';
assert.equal(mutationSession.hasVerifiedAttestation(mutableVerdict), false, 'Aggregation must detect mutated obligations too');
const effectRepo = repository();
effectRepo.candidateSnapshot = snapshot('candidate', 'export function compute(x: number) { return x * 200; } compute = (x: number) => x * 2;');
const effectWitness = TypeScriptOperationalEvaluator.evaluateOperationalBehavior(ob, effectRepo);
assert.equal(effectWitness.outcome, 'VIOLATED');
assert.equal(new EvidenceAcceptanceSession(effectRepo, [checker]).verifyAndAccept(ob, effectWitness), false, 'Reject target rebinding');
const reference = { referenceId: 'ref', projectId: 'project', kind: 'STATIC_CALL' as const, targetEntityId: 'parent-fn', location: { filePath: 'use.ts', line: 1, character: 1 }, isUnresolvedBoundary: false };
assert.throws(() => ConservationGate.reconcileAndEnforce([reference, reference], [], []), /Duplicate discovered reference/);
assert.throws(() => ConservationGate.reconcileAndEnforce([reference], [{ ...ob, reference: { ...reference, targetEntityId: 'other' } }], []), /altered consumer/);
assert.throws(() => ConservationGate.reconcileAndEnforce([], [{ ...ob, reference }], []), /undiscovered/);
