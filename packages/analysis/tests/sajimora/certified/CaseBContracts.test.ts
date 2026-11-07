import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { CertifiedCorrespondence } from '../../../src/sajimora/certified/identity/CertifiedCorrespondence';
import { FrozenIdentityGate } from '../../../src/sajimora/certified/identity/FrozenIdentityGate';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ProofProducer } from '../../../src/sajimora/certified/proof/ProofProducer';
import { ProofChecker } from '../../../src/sajimora/certified/proof/ProofChecker';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1, INITIAL_RESOURCE_PROFILE,
  ParserProfileId, SemanticProfileId, RootPolicyId, BoundaryPolicyId } from '../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet, computeDomainSeparatedHash, hashContract } from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import { EnvironmentManifest, FileEntry, SemanticObligation, Vertex } from '../../../../core/src/sajimora/certified/contracts';
import { CrossVersionIdentityBundle } from '../../../../core/src/sajimora/types/identity';

const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function sealed(source: string, commitId: string) {
  const data = Buffer.from(source);
  const digest = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, data);
  const file: FileEntry = { fileId: 'provider.ts', logicalPath: 'provider.ts', byteLength: data.length,
    bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest }, mode: 0o644, kind: 'SOURCE',
    origin: 'GIT_OBJECT', provenanceRefs: [] };
  const fs = new SealedFilesystem([file], [{ digest, data }], 'CASE_SENSITIVE');
  const root: Vertex = { projectId: 'p0', fileId: 'provider.ts' };
  const manifest: EnvironmentManifest = {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1, repositoryId: 'case-b-contract',
    revision: { commitId, treeId: h(source), parentSelection: 'p1' }, environmentBasis: 'RECORDED_BUILD',
    historicalBindingEvidenceRefs: [], namespace: { pathPolicyId: 'POLICY_V1', caseSensitivity: 'CASE_SENSITIVE',
      unicodePolicy: 'NFC', files: [file], symlinks: [], directoryInventory: [],
      completenessEvidenceRefs: new CanonicalSet<ArtifactRef>() },
    compiler: { packageVersion: '5.9.3', distributionDigest: 'dist-hash',
      parserProfileId: ParserProfileId.TS_5_9_3_STRICT, semanticProfileId: SemanticProfileId.TS_FINITE_CONTRACTS_F0 },
    projects: [{ projectId: 'p0', configFileIds: ['tsconfig.json'], effectiveOptions: {} as any,
      optionsDerivationRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: '1'.repeat(64) },
      roots: [root], references: [], referenceMode: 'SOURCE' }], packages: [],
    rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
    admittedRoots: new CanonicalSet<Vertex>([root]), ambientRoots: new CanonicalSet<any>(),
    generatedArtifacts: new CanonicalSet<any>(), boundaryPolicyId: BoundaryPolicyId.F0_STRICT_BOUNDARY_V1,
    inputEvidenceRefs: new CanonicalSet<ArtifactRef>()
  };
  return { manifest, fs };
}

test('certified Case B correspondence rejects forged or detached mappings', () => {
  const parent = sealed('export function calc(): number { return 1; }', 'parent');
  const candidate = sealed('export function calc(): number { return 2; }', 'candidate');
  const targetId = h('p0|provider.ts||FunctionDeclaration|calc|0');
  const record = CertifiedCorrespondence.produce(parent.manifest, candidate.manifest,
    parent.fs, candidate.fs, 'provider.ts', targetId);
  assert.ok(record);
  const bundle = (changes: Record<string, any> = {}): CrossVersionIdentityBundle => ({
    targetMappings: [{ parent: record.parent, candidate: record.candidate, status: 'UNRESOLVED',
      evidence: [], plausibleCandidateIds: [record.candidate.identityId], ...(changes.mapping ?? {}) }],
    certifiedCorrespondences: changes.records ?? [record], consumerMappings: [], status: 'INCOMPLETE',
    blockers: [], phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
    boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
  });
  const evaluate = (b: CrossVersionIdentityBundle, c = candidate) => FrozenIdentityGate.evaluateTarget(
    parent.manifest, c.manifest, targetId, b, parent.fs, c.fs);
  assert.equal(evaluate(bundle()).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ mapping: { status: 'SAME_DECLARATION' }, records: [] })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ records: [] })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ mapping: { status: 'AMBIGUOUS' } })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ mapping: { parent: { ...record.parent, sourceSpan: { ...record.parent.sourceSpan, start: 1 } } } })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ mapping: { candidate: { ...record.candidate, localName: 'other' } } })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ records: [{ ...record, candidateEnvironmentDigest: 'f'.repeat(64) }] })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ records: [{ ...record, digest: '0'.repeat(64) }] })).status, 'PROVEN');
  assert.notEqual(evaluate(bundle({ records: [record, record] })).status, 'PROVEN');
  const duplicated = bundle();
  duplicated.targetMappings.push(duplicated.targetMappings[0]);
  assert.notEqual(evaluate(duplicated).status, 'PROVEN');
  const unrelated = sealed('export function other(): number { return 2; }', 'candidate');
  assert.notEqual(evaluate(bundle(), unrelated).status, 'PROVEN');

  const changedSignature = sealed('export function calc(x: string): string { return x; }', 'signature');
  const changedRecord = CertifiedCorrespondence.produce(parent.manifest, changedSignature.manifest,
    parent.fs, changedSignature.fs, 'provider.ts', targetId);
  assert.ok(changedRecord);
  assert.equal(FrozenIdentityGate.evaluateTarget(parent.manifest, changedSignature.manifest, targetId,
    bundle({ records: [changedRecord], mapping: { candidate: changedRecord.candidate } }),
    parent.fs, changedSignature.fs).status, 'PROVEN');
});

const ref = (digest: string): ArtifactRef => ({ domain: ArtifactDomain.MANIFEST, digest });
function obligation(overrides: Record<string, any> = {}): SemanticObligation {
  const arg = overrides.argCount ?? 0;
  const requiredParam = overrides.requiredParamCount ?? 0;
  const src = overrides.source ?? { kind: 'primitive', name: 'number' };
  const tgt = overrides.target ?? { kind: 'primitive', name: 'number' };
  const relations = [
    { relationId: 'ARITY_CHECK', kind: overrides.arityKind ?? 'ARITY', position: '0',
      sourceTermValueOrNull: { argCount: arg }, targetTermValueOrNull: { requiredParamCount: requiredParam },
      sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef({ argCount: arg }),
      targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef({ requiredParamCount: requiredParam }),
      contextFactRefs: new CanonicalSet<any>() },
    { relationId: 'RETURN_CHECK', kind: overrides.kind ?? 'RETURN_SATISFIES_CONTEXT', position: 'return',
      sourceTermValueOrNull: src, targetTermValueOrNull: tgt,
      sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(src),
      targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(tgt),
      contextFactRefs: new CanonicalSet<any>() }
  ];
  const anchor = { projectId: 'p0', fileId: overrides.consumer ?? 'consumer.ts',
    utf16Start: overrides.start ?? 60, utf16End: 66, syntaxKind: 213 };
  return { schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    parentEnvironmentRef: ref(overrides.parentRevision ?? 'a'.repeat(64)),
    candidateEnvironmentRef: ref(overrides.candidateRevision ?? 'b'.repeat(64)),
    targetIdentityEvidenceRef: { domain: ArtifactDomain.IDENTITY, digest: overrides.targetId ?? 'c'.repeat(64) },
    historicalOccurrenceAnchor: anchor, lifecycleEvidenceRef: ref('d'.repeat(64)),
    relevanceEvidenceRef: ref('e'.repeat(64)), contextKind: 'CALL_SITE',
    historicalEvidenceRefs: new CanonicalSet<any>(), candidateEvidenceRefs: new CanonicalSet<any>(),
    parentValidityProofRef: ref('f'.repeat(64)), requiredRelations: new CanonicalSet<any>(relations) };
}

test('proof branches bind exact obligation witness and context', () => {
  const genuine = obligation();
  const proof = ProofProducer.produceProof(genuine);
  const verify = (p: ReturnType<typeof ProofProducer.produceProof>) => ProofChecker.verify(genuine, p,
    new VerificationBudget(INITIAL_RESOURCE_PROFILE)).valid;
  const retag = (o: SemanticObligation) => ({ ...ProofProducer.produceProof(o),
    obligationRef: { domain: ArtifactDomain.OBLIGATION,
      digest: hashContract(ArtifactDomain.OBLIGATION, genuine.schemaVersion, genuine) } });
  assert.equal(verify(proof), true);
  assert.deepEqual(Array.from(proof.nodes).find(n => n.ruleId === 'F0.OBL.ARITY')?.conclusion,
    { argCount: 0, requiredParamCount: 0, status: 'COMPATIBLE', reason: null });
  assert.equal(verify(retag(obligation({ argCount: 1, requiredParamCount: 1 }))), false);
  assert.equal(verify(retag(obligation({ source: { kind: 'primitive', name: 'string' } }))), false);
  assert.equal(verify(retag(obligation({ target: { kind: 'primitive', name: 'string' } }))), false);
  assert.equal(verify(retag(obligation({ kind: 'PARAMETER_ACCEPTS_ARGUMENT' }))), false);
  const direction = obligation({ source: { kind: 'literal', value: 1 }, target: { kind: 'primitive', name: 'number' } });
  const directionProof = ProofProducer.produceProof(direction);
  const reversed = obligation({ source: { kind: 'primitive', name: 'number' }, target: { kind: 'literal', value: 1 } });
  assert.equal(ProofChecker.verify(direction, { ...ProofProducer.produceProof(reversed), obligationRef: directionProof.obligationRef },
    new VerificationBudget(INITIAL_RESOURCE_PROFILE)).valid, false);
  assert.equal(verify(retag(obligation({ start: 61 }))), false);
  assert.equal(verify(retag(obligation({ consumer: 'other.ts' }))), false);
  assert.equal(verify(retag(obligation({ targetId: '1'.repeat(64) }))), false);
  assert.equal(verify(retag(obligation({ parentRevision: '2'.repeat(64) }))), false);
  assert.equal(verify(retag(obligation({ candidateRevision: '3'.repeat(64) }))), false);
  assert.equal(verify(ProofProducer.produceProof(obligation({ start: 62 }))), false);
  assert.equal(verify({ ...proof, relationBindings: proof.relationBindings!.slice(0, 1) }), false);
  assert.equal(verify({ ...proof, relationBindings: [...proof.relationBindings!, proof.relationBindings![0]] }), false);
});
