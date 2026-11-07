/**
 * Gate 1 Regression: VARIABLE kind indexing and query.
 *
 * Before fix: IndexedPairDeriver.toSymbolKind() did not include 'VARIABLE',
 * causing INDEX_UNSUPPORTED_DECLARATION_KIND for any changed exported const/let.
 *
 * After fix: 'VARIABLE' is both indexed and deriver-compatible.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CommitProjectIndexer,
  GenerationIndexDatabase,
  IndexedPairDeriver,
  IndexedQueryEngineV2
} from '../../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-variable-kind-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

try {
  git('init');
  git('config', 'user.email', 'var@example.invalid');
  git('config', 'user.name', 'Variable Test');

  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] })
  );

  // Parent: exported const with number type
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export const API_VERSION: number = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { API_VERSION } from './api'; export const v = API_VERSION;\n");
  git('add', '.');
  git('commit', '-m', 'parent');
  const parentSha = git('rev-parse', 'HEAD');

  // Candidate: changed to string type — breaking change for number-typed consumers
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export const API_VERSION: string = "2";\n');
  git('add', '.');
  git('commit', '-m', 'candidate');
  const candidateSha = git('rev-parse', 'HEAD');

  const db = new GenerationIndexDatabase();
  const indexer = new CommitProjectIndexer();
  const parentResult = indexer.indexCommit({ repositoryPath: root, commitSha: parentSha, database: db });
  const candidateResult = indexer.indexCommit({ repositoryPath: root, commitSha: candidateSha, database: db });

  if (parentResult.status !== 'PUBLISHED' || candidateResult.status !== 'PUBLISHED') {
    throw new Error('Indexing failed');
  }

  const parentManifest = db.getPublishedManifest(parentResult.repositoryId, parentSha, 'SAJIMORA_INDEX_V2')!;
  const candidateManifest = db.getPublishedManifest(candidateResult.repositoryId, candidateSha, 'SAJIMORA_INDEX_V2')!;

  const derived = new IndexedPairDeriver().derive(db, parentManifest, candidateManifest);
  assert.ok(derived.length > 0, 'At least one obligation derived for changed VARIABLE');
  const apiObligation = derived.find(item => item.parentDeclaration.localName === 'API_VERSION');
  assert.ok(apiObligation, 'API_VERSION obligation must be derived');
  assert.equal(apiObligation!.parentDeclaration.kind, 'VARIABLE', 'declaration kind must be VARIABLE');
  assert.equal(apiObligation!.obligation.providerMutation?.classification, 'EXPORTED_SIGNATURE_MUTATED');

  const result = new IndexedQueryEngineV2().evaluate(db, parentResult.repositoryId, parentSha, candidateSha);
  assert.equal(result.status, 'COMPLETED', 'Query must return COMPLETED for VARIABLE kind pair');

  db.close();
  console.log('Gate 1 regression — VARIABLE kind index/query: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
