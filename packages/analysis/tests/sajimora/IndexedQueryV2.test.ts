import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CommitProjectIndexer, GenerationIndexDatabase, IndexedPairDeriver, IndexedQueryEngineV2
} from '../../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-query-v2-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
try {
  git('init'); git('config', 'user.email', 'query@example.invalid'); git('config', 'user.name', 'Query Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
  const write = (parameter: string) => {
    fs.writeFileSync(path.join(root, 'src', 'api.ts'), `export function api(value: ${parameter}): string { return String(value); }\n`);
    fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { api } from './api'; export const result = api('x');\n");
  };
  write('string'); git('add', '.'); git('commit', '-m', 'parent'); const parentSha = git('rev-parse', 'HEAD');
  write('string | number'); git('add', '.'); git('commit', '-m', 'candidate one'); const candidateOne = git('rev-parse', 'HEAD');
  write('unknown'); git('add', '.'); git('commit', '-m', 'candidate two'); const candidateTwo = git('rev-parse', 'HEAD');

  const db = new GenerationIndexDatabase();
  const indexer = new CommitProjectIndexer();
  const parent = indexer.indexCommit({ repositoryPath: root, commitSha: parentSha, database: db });
  const first = indexer.indexCommit({ repositoryPath: root, commitSha: candidateOne, database: db });
  const second = indexer.indexCommit({ repositoryPath: root, commitSha: candidateTwo, database: db });
  assert.equal(parent.status, 'PUBLISHED'); assert.equal(first.status, 'PUBLISHED'); assert.equal(second.status, 'PUBLISHED');
  if (parent.status === 'PUBLISHED' && first.status === 'PUBLISHED' && second.status === 'PUBLISHED') {
    const parentManifest = db.getPublishedManifest(parent.repositoryId, parentSha, 'SAJIMORA_INDEX_V2')!;
    const firstManifest = db.getPublishedManifest(parent.repositoryId, candidateOne, 'SAJIMORA_INDEX_V2')!;
    const derived = new IndexedPairDeriver().derive(db, parentManifest, firstManifest);
    assert.ok(derived.some(item => item.parentDeclaration.localName === 'api'));
    const engine = new IndexedQueryEngineV2();
    const firstQuery = engine.evaluate(db, parent.repositoryId, parentSha, candidateOne);
    assert.equal(firstQuery.status, 'COMPLETED');
    if (firstQuery.status === 'COMPLETED') {
      assert.ok(firstQuery.results.some(result => result.proof.verdict === 'UNKNOWN'),
        'Changed provider identity must not become a positive certificate without lineage proof');
    }
    assert.equal(engine.evaluate(db, parent.repositoryId, parentSha, candidateTwo).status, 'COMPLETED');
    assert.equal(engine.evaluate(db, 'different-repository', parentSha, candidateOne).status, 'INDEXING_PENDING');
  }
  db.close();
  const querySource = fs.readFileSync(path.resolve('packages/analysis/src/sajimora/indexed/IndexedQueryEngineV2.ts'), 'utf8');
  for (const forbidden of ["from 'typescript'", 'GitRepository', 'SnapshotFilesystem', 'TypeScriptProgramBuilder', 'LiveProgramSemanticProvider']) {
    assert.equal(querySource.includes(forbidden), false, `warm query source contains ${forbidden}`);
  }
  console.log('Indexed query V2 derivation and reuse: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
