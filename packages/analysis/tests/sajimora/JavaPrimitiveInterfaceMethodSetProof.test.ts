import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, GenericRepositorySnapshot } from '@sajimora/core';
import { JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1, JavaPrimitiveInterfaceMethodSetProof,
  JavaPrimitiveInterfaceSetObligation } from '../../src/sajimora/languages/java/certified/JavaPrimitiveInterfaceMethodSetProof';

const source = 'package demo; public interface Api { int first(int x); long second(long y); void third(); }';
const path = 'src/Api.java';
const snapshot = (snapshotId: string, text: string): GenericRepositorySnapshot => ({ snapshotId, rootIdentifier: '/',
  files: [{ path, byteLength: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex') }],
  readTextFile: file => file === path ? text : undefined,
  readBinaryFile: file => file === path ? Buffer.from(text) : undefined
});
const repository = (candidate: string): GenericRepository => ({ repositoryId: 'repo',
  parentSnapshot: snapshot('parent', source), candidateSnapshot: snapshot('candidate', candidate) });
const obligation: JavaPrimitiveInterfaceSetObligation = { profileId: JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1,
  repositoryId: 'repo', parentSnapshotId: 'parent', candidateSnapshotId: 'candidate',
  parentPath: path, candidatePath: path, interfaceFqcn: 'demo.Api', property: 'OLD_DECLARED_METHOD_SET_INCLUSION' };
function run(candidate: string) {
  const repo = repository(candidate);
  const proof = JavaPrimitiveInterfaceMethodSetProof.propose(obligation, repo);
  assert.ok(proof);
  return { repo, proof, result: JavaPrimitiveInterfaceMethodSetProof.check(obligation, repo, proof) };
}
const preserved = run(source.replace('void third();', 'void third(); byte added(byte x);'));
assert.equal(preserved.result.status, 'VERIFIED_SOURCE_PROPOSITION');
if (preserved.result.status === 'VERIFIED_SOURCE_PROPOSITION') assert.equal(preserved.result.outcome, 'OLD_DECLARATIONS_INCLUDED');
for (const candidate of [
  source.replace('long second(long y);', ''),
  source.replace('long second(long y);', 'int second(long y);'),
  source.replace('long second(long y);', 'long second(int y);')
]) {
  const result = run(candidate).result;
  assert.equal(result.status, 'VERIFIED_SOURCE_PROPOSITION');
  if (result.status === 'VERIFIED_SOURCE_PROPOSITION') assert.equal(result.outcome, 'OLD_DECLARATIONS_NOT_INCLUDED');
}
for (const mutate of [
  (proof: any) => { proof.memberProofs.pop(); },
  (proof: any) => { proof.memberProofs[1] = structuredClone(proof.memberProofs[0]); },
  (proof: any) => { proof.memberProofs.reverse(); },
  (proof: any) => { proof.root.parentMethodNames.pop(); },
  (proof: any) => { proof.root.outcome = 'OLD_DECLARATIONS_NOT_INCLUDED'; },
  (proof: any) => { proof.root.interfaceFqcn = 'other.Api'; },
  (proof: any) => { proof.memberProofs[2].root.outcome = 'DECLARATION_CHANGED'; },
  (proof: any) => { proof.memberProofs[0].candidateFacts.methods.pop(); },
  (proof: any) => { proof.obligationDigest = '0'.repeat(64); },
  (proof: any) => { proof.uncheckedExtra = true; }
]) {
  const proof = structuredClone(preserved.proof);
  mutate(proof);
  assert.equal(JavaPrimitiveInterfaceMethodSetProof.check(obligation, preserved.repo, proof).status, 'UNVERIFIED');
}
assert.equal(JavaPrimitiveInterfaceMethodSetProof.check({ ...obligation, interfaceFqcn: 'other.Api' },
  preserved.repo, preserved.proof).status, 'UNVERIFIED');
assert.equal(JavaPrimitiveInterfaceMethodSetProof.check(obligation,
  { ...preserved.repo, candidateSnapshot: snapshot('candidate', source.replace('void third();', '')) },
  preserved.proof).status, 'UNVERIFIED');
assert.equal(JavaPrimitiveInterfaceMethodSetProof.propose(obligation,
  repository('package demo; public interface Api extends Other { int first(int x); }')), undefined);
console.log('Java finite declared-method set proposition PASSED; consumer and implementer certification remains separate.');
