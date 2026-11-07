import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, GenericRepositorySnapshot } from '@sajimora/core';
import { JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1, JavaPrimitiveInterfaceMethodProof,
  JavaPrimitiveMethodObligation, JavaPrimitiveMethodProof } from '../../src/sajimora/languages/java/certified/JavaPrimitiveInterfaceMethodProof';

const path = 'src/Api.java';
const parentSource = 'package demo; public interface Api { int calculate(int value); void reset(); }';
const snapshot = (snapshotId: string, source: string): GenericRepositorySnapshot => ({
  snapshotId, rootIdentifier: '/', files: [{ path, byteLength: Buffer.byteLength(source),
    hash: createHash('sha256').update(source).digest('hex') }],
  readTextFile: file => file === path ? source : undefined,
  readBinaryFile: file => file === path ? Buffer.from(source) : undefined
});
const repository = (candidateSource: string): GenericRepository => ({ repositoryId: 'repo',
  parentSnapshot: snapshot('parent', parentSource), candidateSnapshot: snapshot('candidate', candidateSource) });
const obligation: JavaPrimitiveMethodObligation = {
  profileId: JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1, repositoryId: 'repo',
  parentSnapshotId: 'parent', candidateSnapshotId: 'candidate', parentPath: path, candidatePath: path,
  interfaceFqcn: 'demo.Api', methodName: 'calculate', property: 'DECLARED_METHOD_SIGNATURE_PRESERVATION'
};
function checked(candidate: string) {
  const repo = repository(candidate);
  const proof = JavaPrimitiveInterfaceMethodProof.propose(obligation, repo);
  assert.ok(proof);
  return { repo, proof, result: JavaPrimitiveInterfaceMethodProof.check(obligation, repo, proof) };
}

const equal = checked(parentSource);
assert.deepEqual(equal.result.status, 'VERIFIED_SOURCE_PROPOSITION');
assert.equal(equal.result.status === 'VERIFIED_SOURCE_PROPOSITION' && equal.result.outcome, 'DECLARATION_PRESERVED');
for (const changed of [
  'package demo; public interface Api { long calculate(int value); void reset(); }',
  'package demo; public interface Api { int calculate(long value); void reset(); }',
  'package demo; public interface Api { void reset(); }'
]) {
  const result = checked(changed).result;
  assert.equal(result.status, 'VERIFIED_SOURCE_PROPOSITION');
  if (result.status === 'VERIFIED_SOURCE_PROPOSITION') assert.equal(result.outcome, 'DECLARATION_CHANGED');
}
const added = checked(parentSource.replace('void reset();', 'void reset(); byte extra();'));
assert.equal(added.result.status === 'VERIFIED_SOURCE_PROPOSITION' && added.result.outcome, 'DECLARATION_PRESERVED');
const unrelated = { ...obligation, methodName: 'reset' };
assert.equal(JavaPrimitiveInterfaceMethodProof.check(unrelated, equal.repo, equal.proof).status, 'UNVERIFIED');
for (const mutate of [
  (proof: any) => { proof.root.outcome = 'DECLARATION_CHANGED'; },
  (proof: any) => { proof.root.interfaceFqcn = 'other.Api'; },
  (proof: any) => { proof.root.methodName = 'reset'; },
  (proof: any) => { proof.root.parentMethod.result = 'long'; },
  (proof: any) => { proof.root.candidateMethod = null; },
  (proof: any) => { proof.parentFacts.methods.pop(); },
  (proof: any) => { proof.candidateFacts.sha256 = '0'.repeat(64); },
  (proof: any) => { proof.obligationDigest = '0'.repeat(64); },
  (proof: any) => { proof.ruleId = 'JAVA.F0.NOMINAL.EQUAL'; },
  (proof: any) => { proof.extraRule = 'accept'; }
]) {
  const proof = structuredClone(equal.proof);
  mutate(proof);
  assert.equal(JavaPrimitiveInterfaceMethodProof.check(obligation, equal.repo, proof).status, 'UNVERIFIED');
}
const wrongRepository = { ...equal.repo, repositoryId: 'other' };
assert.equal(JavaPrimitiveInterfaceMethodProof.check(obligation, wrongRepository, equal.proof).status, 'UNVERIFIED');
const wrongRevision = { ...equal.repo, candidateSnapshot: snapshot('different', parentSource) };
assert.equal(JavaPrimitiveInterfaceMethodProof.check(obligation, wrongRevision, equal.proof).status, 'UNVERIFIED');
const staleBytes = { ...equal.repo, candidateSnapshot: snapshot('candidate', parentSource.replace('int calculate', 'long calculate')) };
assert.equal(JavaPrimitiveInterfaceMethodProof.check(obligation, staleBytes, equal.proof).status, 'UNVERIFIED');
const unsupported = repository('package demo; public interface Api extends Other { int calculate(int value); }');
assert.equal(JavaPrimitiveInterfaceMethodProof.propose(obligation, unsupported), undefined);
assert.equal(JavaPrimitiveInterfaceMethodProof.check(obligation, unsupported, equal.proof).status, 'UNVERIFIED');
assert.equal(JavaPrimitiveInterfaceMethodProof.propose({ ...obligation, methodName: 'absent' }, equal.repo), undefined);
console.log('Java primitive method source proposition PASSED; no Java F0 compatibility verdict issued.');
