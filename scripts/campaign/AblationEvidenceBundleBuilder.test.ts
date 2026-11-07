import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAblationEvidenceBundle } from './AblationEvidenceBundleBuilder';

test('bundle builder binds every artifact to its content digest', () => {
  const manifest: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1', namespace: {}, projects: [] };
  const closure: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1', reachedVertices: [] };
  const admission: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1' };
  const obligation: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1', id: 'o1' };
  const proof: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1', id: 'p1' };
  const coverage: any = { schemaVersion: 'SAJIMORA_CERTIFIED_EVIDENCE_V1' };
  const bundle = buildAblationEvidenceBundle({ repositoryId: 'fixture', parentManifest: manifest, candidateManifest: manifest, parentClosure: closure, candidateClosure: closure, parentAdmission: admission, candidateAdmission: admission, obligations: [obligation], proofs: [proof], coverage, correspondenceDigest: 'a'.repeat(64) });
  assert.equal(bundle.identityEvidenceRef.digest, 'a'.repeat(64));
  assert.equal(bundle.semanticObligationRefs.size, 1);
  assert.equal(bundle.semanticProofRefs.size, 1);
  assert.equal(bundle.dependencyClosureRefs.size, 2);
  assert.throws(() => buildAblationEvidenceBundle({ repositoryId: 'fixture', parentManifest: manifest, candidateManifest: manifest, parentClosure: closure, candidateClosure: closure, parentAdmission: admission, candidateAdmission: admission, obligations: [obligation], proofs: [], coverage, correspondenceDigest: 'a'.repeat(64) }));
});
