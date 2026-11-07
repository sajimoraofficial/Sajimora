import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DiscoveryCoverageChecker, EvidenceChecker, GenericLanguageAdapter,
  GenericRepository, GenericRepositorySnapshot, ProductionVerificationCore,
  Reference, SemanticChange, SemanticEntity, VerificationObligation,
  VerificationVerdict } from '../../src/sajimora/verification';

const text = 'export function foo() {}\nfoo();\n';
const file = { path: 'one.ts', byteLength: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex') };
const snapshot = (id: string): GenericRepositorySnapshot => ({ snapshotId: id, rootIdentifier: '/', files: [file],
  readTextFile: path => path === file.path ? text : undefined,
  readBinaryFile: path => path === file.path ? Buffer.from(text) : undefined });
const repository: GenericRepository = { repositoryId: 'repo', parentSnapshot: snapshot('parent'),
  candidateSnapshot: snapshot('candidate') };
const entity: SemanticEntity = { entityId: 'target', projectId: 'project', kind: 'FUNCTION', name: 'foo',
  qualifiedName: 'foo', filePath: file.path, signatureFingerprint: '()', isExported: true };
const change: SemanticChange = { changeId: 'change', changeKind: 'BODY_MUTATED', description: 'body',
  identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
    parentEntity: entity, candidateEntity: entity } };
const reference: Reference = { referenceId: 'reference', projectId: 'project', targetEntityId: entity.entityId,
  kind: 'STATIC_CALL', location: { filePath: file.path, line: 2, character: 1, length: 5 },
  isUnresolvedBoundary: false };
class Adapter implements GenericLanguageAdapter {
  readonly languageId = 'test';
  readonly adapterVersion = '1';
  canHandle(): boolean { return true; }
  async discoverProjectGraph() { return { graphId: 'graph', projects: [{ projectId: 'project',
    rootDirectory: '/', sourceFiles: [file.path], projectReferences: [] }], edges: [] }; }
  async mapProjectGraphs() { return { matched: [{ parentProjectId: 'project', candidateProjectId: 'project' }],
    added: [], deleted: [] }; }
  async identifyEntitiesAndChanges() { return { entities: [entity], changes: [change] }; }
  async discoverReferences() { return { staticReferences: [reference], unresolvedBoundaries: [] }; }
  async generateObligations(): Promise<VerificationObligation[]> { return [{ obligationId: 'obligation',
    projectId: 'project', question: 'CONSUMER_COMPATIBILITY', change, reference,
    scope: 'CONSUMER', createdAt: '' }]; }
  async evaluateObligation(obligation: VerificationObligation): Promise<VerificationVerdict> {
    return { verdictId: 'verdict', obligationId: obligation.obligationId, targetEntityId: entity.entityId,
      outcome: 'PRESERVED', assurance: 'F0_FORMAL', property: 'CONSUMER_TYPE', scope: 'CONSUMER',
      provenance: { repositoryId: 'repo', projectId: 'project', identityId: 'identity',
        referenceId: 'reference', obligationId: 'obligation', evidenceId: 'evidence', verdictId: 'verdict' },
      evidence: { evidenceId: 'evidence', assurance: 'F0_FORMAL', property: 'CONSUMER_TYPE',
        f0Formal: { proofTrace: [] }, metadata: { verificationProfile: 'TEST_SOURCE_PROOF' } }, timestamp: '' };
  }
}
const evidence: EvidenceChecker = { profileId: 'TEST_SOURCE_PROOF',
  check: (_obligation, repo) => repo.parentSnapshot.readTextFile(file.path) === text };
const run = async (coverage?: DiscoveryCoverageChecker) => {
  const core = new ProductionVerificationCore([evidence], coverage);
  core.registerAdapter(new Adapter());
  return core.verifyRepository(repository);
};
async function runTests(): Promise<void> {
  const absent = await run();
  assert.equal(absent.ledger.certificationStatus, 'UNCERTIFIED_UNKNOWN');
  assert.equal(absent.authoritativeVerdict.verdict, 'UNKNOWN');
  const rejecting = await run({ profileId: 'TEST_COVERAGE', check: () => false });
  assert.equal(rejecting.authoritativeVerdict.verdict, 'UNKNOWN');
  const accepted = await run({ profileId: 'TEST_COVERAGE', check: input =>
    input.repository.parentSnapshot.readTextFile(file.path) === text &&
    input.targetEntities.length === 1 && input.references.length === 1 &&
    input.references[0].location.line === 2 });
  assert.equal(accepted.ledger.discoveryAccounting?.coverageProfileId, 'TEST_COVERAGE');
  assert.equal(accepted.ledger.certificationStatus, 'CERTIFIED_PRESERVED');
  assert.equal(accepted.authoritativeVerdict.verdict, 'PRESERVED');
  const mutating = await run({ profileId: 'TEST_COVERAGE_MUTATOR', check: input => {
    (input.references[0].location as { line: number }).line = 3;
    return true;
  } });
  assert.equal(mutating.authoritativeVerdict.verdict, 'UNKNOWN', 'checker mutation must invalidate receipt');
  console.log('Discovery coverage receipt and aggregate promotion PASSED.');
}
runTests().catch(error => { console.error(error); process.exitCode = 1; });
