import * as assert from 'node:assert/strict';
import {
  GenerationIndexDatabase, INDEX_SCHEMA_VERSION, createGenerationIdentity,
  calculateCertificateHash, calculateProjectManifestHash, calculateCommitManifestHash,
  calculateGenerationContentHash, IndexedQueryEngineV2,
  type CommitIndexIdentity, type ProjectManifest, type BoundCompletenessCertificate, type CommitManifest
} from '../../src';

const identity: CommitIndexIdentity = {
  schemaVersion: INDEX_SCHEMA_VERSION, extractorVersion: 'extractor', proofRulesVersion: 'rules',
  repositoryId: 'repo', commitSha: 'a'.repeat(40), toolchainFingerprint: 'tool',
  configFingerprint: 'config', dependencyFingerprint: 'deps', externalDependencyFingerprint: 'NONE'
};
const generation = createGenerationIdentity(identity, 'one');
const db = new GenerationIndexDatabase();
db.beginGeneration(generation);
const artifactHash = db.putArtifact(generation.generationId, 'root', 'src/a.ts#api', 'DECLARATION', { name: 'api' });
const projectBaseWithoutCertificate = {
  identity: { ...identity, projectId: 'root', projectContextFingerprint: 'context' },
  generationId: generation.generationId, rootFilesHash: 'roots', includedFilesHash: 'files', projectReferencesHash: 'refs',
  moduleGraphHash: 'modules', declarationRootHash: 'decls', consumerRootHash: 'consumers', typeIRRootHash: 'types',
  diagnosticRootHash: 'diags', certificateHash: '', artifactHashes: [artifactHash], artifactCounts: { DECLARATION: 1 }
};
const generationContentHash = calculateGenerationContentHash(identity, [artifactHash]);
const certBase = {
  generationId: generation.generationId, generationContentHash, repositoryId: identity.repositoryId,
  commitSha: identity.commitSha, projectId: 'root', includedFilesHash: 'files', projectReferencesHash: 'refs',
  moduleGraphHash: 'modules', declarationRootHash: 'decls', consumerRootHash: 'consumers', diagnosticRootHash: 'diags',
  supportedRelationshipClasses: ['VALUE_REFERENCE'], unsupportedRelationshipClasses: [], blockers: [], isComplete: true
};
const certificate: BoundCompletenessCertificate = { ...certBase, certificateHash: calculateCertificateHash(certBase as any) };
db.putCertificate(certificate);
const projectBase = { ...projectBaseWithoutCertificate, certificateHash: certificate.certificateHash };
const project: ProjectManifest = { ...projectBase, projectManifestHash: calculateProjectManifestHash(projectBase as any) };
db.putProjectManifest(project);
const commitBase = {
  identity, generationId: generation.generationId, generationContentHash,
  projectManifestHashes: [project.projectManifestHash],
  artifactHashes: [artifactHash], certificateHashes: [certificate.certificateHash]
};
const commit: CommitManifest = { ...commitBase, manifestHash: calculateCommitManifestHash(commitBase as any) };
db.publish(commit);
assert.equal(db.getPublishedManifest('repo', identity.commitSha, INDEX_SCHEMA_VERSION)?.manifestHash, commit.manifestHash);
assert.throws(() => db.putArtifact(generation.generationId, 'root', 'src/b.ts#api', 'DECLARATION', { name: 'api' }), /INDEX_GENERATION_IMMUTABLE/);
assert.equal(new IndexedQueryEngineV2().evaluate(db, 'repo', identity.commitSha, identity.commitSha).status,
  'INDEX_INCOMPATIBLE');

const replacement = createGenerationIdentity(identity, 'two');
db.beginGeneration(replacement);
const replacementArtifact = db.putArtifact(replacement.generationId, 'root', 'src/a.ts#api',
  'DECLARATION', { name: 'api' });
assert.equal(replacementArtifact, artifactHash);
const replacementContentHash = calculateGenerationContentHash(identity, [replacementArtifact]);
const replacementCertBase = { ...certBase, generationId: replacement.generationId,
  generationContentHash: replacementContentHash };
const replacementCert: BoundCompletenessCertificate = { ...replacementCertBase,
  certificateHash: calculateCertificateHash(replacementCertBase) };
db.putCertificate(replacementCert);
const replacementProjectBase = { ...projectBase, generationId: replacement.generationId,
  certificateHash: replacementCert.certificateHash };
const replacementProject: ProjectManifest = { ...replacementProjectBase,
  projectManifestHash: calculateProjectManifestHash(replacementProjectBase) };
db.putProjectManifest(replacementProject);
const replacementCommitBase = { identity, generationId: replacement.generationId,
  generationContentHash: replacementContentHash, projectManifestHashes: [replacementProject.projectManifestHash],
  artifactHashes: [replacementArtifact], certificateHashes: [replacementCert.certificateHash] };
const replacementCommit: CommitManifest = { ...replacementCommitBase,
  manifestHash: calculateCommitManifestHash(replacementCommitBase) };
assert.equal(replacementCert.certificateHash, certificate.certificateHash);
assert.equal(replacementProject.projectManifestHash, project.projectManifestHash);
assert.equal(replacementCommit.manifestHash, commit.manifestHash);
db.publish(replacementCommit);
assert.equal(db.getPublishedManifest('repo', identity.commitSha, INDEX_SCHEMA_VERSION)?.manifestHash,
  replacementCommit.manifestHash);
const raw = (db as unknown as { db: { prepare: (sql: string) => { run: (...values: string[]) => void } } }).db;
raw.prepare('INSERT INTO v2_generation_artifacts VALUES (?, ?, ?, ?, ?)').run(
  replacement.generationId, 'root', 'unclaimed-extra', artifactHash, 'DECLARATION');
assert.throws(() => db.getPublishedManifest('repo', identity.commitSha, INDEX_SCHEMA_VERSION),
  /INDEX_PROJECT_ARTIFACT_COUNTS_INVALID/);
db.close();
console.log('Generation index database: PASS');
