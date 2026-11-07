import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommitProjectIndexer, GenerationIndexDatabase, INDEX_SCHEMA_VERSION, IndexedQueryEngineV2,
  VerifiedDependencyEnvironment } from '../../src';
import { TypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder';
import { SnapshotFilesystem } from '../../src/sajimora/snapshots/SnapshotFilesystem';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-index-v2-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
try {
  git('init'); git('config', 'user.email', 'index@example.invalid'); git('config', 'user.name', 'Index Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export function api(value: string): string { return value; }\n');
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { api } from './api'; export const result = api('x');\n");
  git('add', '.'); git('commit', '-m', 'indexed commit');
  const commitSha = git('rev-parse', 'HEAD');
  let streamedProjects = 0;
  const streamed = new TypeScriptProgramBuilder().build({
    root, trackedFiles: ['tsconfig.json', 'src/api.ts', 'src/consumer.ts'],
    revision: { repositoryId: 'fixture', commitSha }, toolchain: {} as any,
    adapterId: 'fixture', adapterVersion: '1', retainPrograms: false,
    readTextFile: file => fs.readFileSync(path.join(root, file), 'utf8'),
    onProject: () => { streamedProjects++; }
  });
  assert.equal(streamedProjects, 1);
  assert.equal(streamed.projects.length, 0);
  assert.equal(streamed.universe.projects.length, 1);
  const db = new GenerationIndexDatabase();
  const indexer = new CommitProjectIndexer();
  const result = indexer.indexCommit({ repositoryPath: root, commitSha, database: db });
  assert.equal(result.status, 'PUBLISHED', 'blockers' in result ? result.blockers.join('\n') : undefined);
  if (result.status === 'PUBLISHED') {
    const originalMaterialize = SnapshotFilesystem.prototype.materialize;
    SnapshotFilesystem.prototype.materialize = () => { throw new Error('WARM_REUSE_MATERIALIZED_SNAPSHOT'); };
    let reused: ReturnType<CommitProjectIndexer['indexCommit']>;
    try { reused = indexer.indexCommit({ repositoryPath: root, commitSha, database: db }); }
    finally { SnapshotFilesystem.prototype.materialize = originalMaterialize; }
    assert.deepEqual(reused, { status: 'REUSED', repositoryId: result.repositoryId,
      commitSha, generationId: result.generationId, manifestHash: result.manifestHash });
    const explicitlyEmptyDependencies = indexer.indexCommit({ repositoryPath: root, commitSha, database: db, dependencyRoot: root });
    assert.equal(explicitlyEmptyDependencies.status, 'PUBLISHED',
      'blockers' in explicitlyEmptyDependencies ? explicitlyEmptyDependencies.blockers.join('\n') : undefined);
    const manifest = db.getPublishedManifest(result.repositoryId, commitSha, INDEX_SCHEMA_VERSION);
    assert.ok(manifest);
    const declarations = db.getArtifacts<any>(result.generationId, 'tsconfig.json', 'DECLARATION');
    const consumers = db.getArtifacts<any>(result.generationId, 'tsconfig.json', 'CONSUMER');
    assert.ok(declarations.some(record => record.payload.localName === 'api'));
    assert.ok(consumers.some(record => record.payload.usageRole === 'CALL_SITE'));
  }
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'),
    "import { api } from './api'; import missing from 'missing-package'; export const result = api(missing);\n");
  git('add', '.'); git('commit', '-m', 'unresolved dependency');
  const incompleteSha = git('rev-parse', 'HEAD');
  const incompleteFirst = indexer.indexCommit({ repositoryPath: root, commitSha: incompleteSha, database: db });
  const incompleteRetry = indexer.indexCommit({ repositoryPath: root, commitSha: incompleteSha, database: db });
  assert.equal(incompleteFirst.status, 'PARTIAL');
  assert.equal(incompleteRetry.status, 'PARTIAL');
  const externalPackage = path.join(root, 'node_modules', 'extpkg');
  fs.mkdirSync(externalPackage, { recursive: true });
  fs.writeFileSync(path.join(externalPackage, 'package.json'), JSON.stringify({ name: 'extpkg', types: 'index.d.ts' }));
  fs.writeFileSync(path.join(externalPackage, 'index.d.ts'), 'export interface Widget { value: string }\n');
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'),
    "import { Widget } from 'extpkg'; export const result: Widget = { value: 'x' };\n");
  git('add', 'src/consumer.ts'); git('commit', '-m', 'external declaration consumer');
  const externalSha = git('rev-parse', 'HEAD');
  const external = indexer.indexCommit({ repositoryPath: root, commitSha: externalSha, database: db,
    dependencyRoot: root });
  assert.equal(external.status, 'PUBLISHED', 'blockers' in external ? external.blockers.join('\n') : undefined);
  if (external.status === 'PUBLISHED') {
    const query = new IndexedQueryEngineV2();
    assert.equal(query.evaluate(db, external.repositoryId, externalSha, externalSha).status, 'INDEX_INCOMPATIBLE');
    const externalManifest = db.getPublishedManifest(external.repositoryId, externalSha, INDEX_SCHEMA_VERSION)!;
    const witness = VerifiedDependencyEnvironment.verify(root, root, externalManifest, externalManifest);
    assert.equal(query.evaluate(db, external.repositoryId, externalSha, externalSha, witness).status, 'COMPLETED');
    assert.equal(query.evaluate(db, external.repositoryId, externalSha, externalSha, witness).status, 'INDEX_INCOMPATIBLE');
    assert.equal(indexer.indexCommit({ repositoryPath: root, commitSha: externalSha, database: db,
      dependencyRoot: root }).status, 'REUSED');
    fs.writeFileSync(path.join(externalPackage, 'index.d.ts'), 'export interface Widget { value: number }\n');
    assert.throws(() => VerifiedDependencyEnvironment.verify(root, root, externalManifest, externalManifest),
      /DEPENDENCY_LOOKUP_STALE/);
    assert.notEqual(indexer.indexCommit({ repositoryPath: root, commitSha: externalSha, database: db,
      dependencyRoot: root }).status, 'REUSED');
  }
  db.close();
  console.log('Complete commit/project indexer: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
