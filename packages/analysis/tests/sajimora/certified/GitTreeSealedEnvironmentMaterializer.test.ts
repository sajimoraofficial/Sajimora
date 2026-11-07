import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitRepository, GitObjectReader } from '@sajimora/analysis';
import { GitTreeSealedEnvironmentMaterializer } from '../../../../../scripts/campaign/GitTreeSealedEnvironmentMaterializer';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { INITIAL_RESOURCE_PROFILE } from '../../../../core/src/sajimora/certified/protocol';
import { ArtifactDomain, RootPolicyId, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet, hashContract } from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { ASTAnchorExtractor } from '../../../src/sajimora/certified/closure/ASTExtractor';
import { F0RestrictedResolver } from '../../../src/sajimora/certified/closure/F0RestrictedResolver';
import { DependencyClosureProducer } from '../../../src/sajimora/certified/closure/DependencyClosureProducer';
import { CertifiedCampaignAdapter } from '../../../../../scripts/campaign/CertifiedCampaignAdapter';

function revisionRepo(): { dir: string; parent: string; candidate: string } {
  const dir = path.resolve('test/fixtures/git_tree_materializer_repo');
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'fixture@test'], { cwd: dir });
  }
  fs.writeFileSync(path.join(dir, 'src', 'provider.ts'), 'export const value: string = "v";\n');
  fs.writeFileSync(path.join(dir, 'src', 'nested', 'index.ts'), 'export { value } from "../provider";\n');
  fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), 'import { value } from "./nested";\nexport const result: string = value;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","types":"src/provider.ts"}\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  const parentTree = execFileSync('git', ['write-tree'], { cwd: dir }).toString().trim();
  const parent = execFileSync('git', ['commit-tree', parentTree, '-m', 'parent'], { cwd: dir }).toString().trim();
  fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), 'import { value } from "./nested";\nexport const result: string = value;\n// candidate\n');
  execFileSync('git', ['add', 'src/consumer.ts'], { cwd: dir });
  const candidateTree = execFileSync('git', ['write-tree'], { cwd: dir }).toString().trim();
  const candidate = execFileSync('git', ['commit-tree', candidateTree, '-p', parent, '-m', 'candidate'], { cwd: dir }).toString().trim();
  return { dir, parent, candidate };
}

test('Git-tree materializer is complete, revision-isolated, and deterministic', () => {
  const fixture = revisionRepo();
  const repo = new GitRepository(fixture.dir);
  const materializer = new GitTreeSealedEnvironmentMaterializer(repo, new GitObjectReader(repo));
  const parent = materializer.materialize(fixture.parent);
  const candidate = materializer.materialize(fixture.candidate);
  assert.deepEqual(parent.logicalPaths, ['package.json', 'src/consumer.ts', 'src/nested/index.ts', 'src/provider.ts']);
  assert.deepEqual(materializer.materialize(fixture.parent).logicalPaths, parent.logicalPaths);
  assert.notEqual(parent.treeId, candidate.treeId);
  assert.notEqual(parent.files.find(f => f.path === 'src/consumer.ts')!.content, candidate.files.find(f => f.path === 'src/consumer.ts')!.content);
  assert.equal(parent.files.find(f => f.path === 'src/provider.ts')!.content, candidate.files.find(f => f.path === 'src/provider.ts')!.content);
  const environment = CertifiedCampaignAdapter.createVirtualEnvironment(parent.files, fixture.parent, 'fixture', ['src/consumer.ts'], parent.treeId);
  const envRef = { domain: ArtifactDomain.MANIFEST, digest: hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, environment.manifest) };
  const closure = new DependencyClosureProducer(environment.sealedFs, new ASTAnchorExtractor(), new F0RestrictedResolver(environment.sealedFs))
    .produceClosure(envRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet([{ projectId: 'p0', fileId: 'src/consumer.ts' }]));
  assert.deepEqual(Array.from(closure.reachedVertices).map(v => v.fileId).sort(), ['src/consumer.ts', 'src/nested/index.ts', 'src/provider.ts']);
  const repeatEnvironment = CertifiedCampaignAdapter.createVirtualEnvironment(materializer.materialize(fixture.parent).files, fixture.parent, 'fixture', ['src/consumer.ts'], parent.treeId);
  const repeatEnvRef = { domain: ArtifactDomain.MANIFEST, digest: hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, repeatEnvironment.manifest) };
  const repeatClosure = new DependencyClosureProducer(repeatEnvironment.sealedFs, new ASTAnchorExtractor(), new F0RestrictedResolver(repeatEnvironment.sealedFs))
    .produceClosure(repeatEnvRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet([{ projectId: 'p0', fileId: 'src/consumer.ts' }]));
  assert.equal(envRef.digest, repeatEnvRef.digest);
  assert.equal(hashContract(ArtifactDomain.CLOSURE, SAJIMORA_CERTIFIED_EVIDENCE_V1, closure), hashContract(ArtifactDomain.CLOSURE, SAJIMORA_CERTIFIED_EVIDENCE_V1, repeatClosure));
});

test('Git-tree materializer fails closed on missing blob and exhausted budget', () => {
  const fixture = revisionRepo();
  const repo = new GitRepository(fixture.dir);
  const reader = new GitObjectReader(repo);
  const materializer = new GitTreeSealedEnvironmentMaterializer(repo, reader);
  const original = reader.batchBlobs.bind(reader);
  (reader as any).batchBlobs = () => new Map();
  assert.throws(() => materializer.materialize(fixture.parent), /Missing Git blob/);
  (reader as any).batchBlobs = original;
  const profile = { ...INITIAL_RESOURCE_PROFILE, maxVertices: 1 };
  assert.throws(() => materializer.materialize(fixture.parent, new VerificationBudget(profile)), /Resource exhausted/);
});
