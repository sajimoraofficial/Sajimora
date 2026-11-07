import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommitProjectIndexer, GenerationIndexDatabase, IndexedQueryEngineV2 } from '../../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-gate10-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

try {
  git('init'); git('config', 'user.email', 't@t.invalid'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));

  // Parent has compute1 and compute2, and a consumer that uses both
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "export function compute1() { return 1; }\nexport function compute2() { return 2; }\n");
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { compute1, compute2 } from './api'; compute1(); compute2();\n");
  git('add', '.'); git('commit', '-m', 'parent');
  const parentSha = git('rev-parse', 'HEAD');

  // Candidate 1 changes compute1
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "export function compute1() { return 11; }\nexport function compute2() { return 2; }\n");
  git('add', '.'); git('commit', '-m', 'candidate1');
  const candidate1Sha = git('rev-parse', 'HEAD');

  git('checkout', parentSha);

  // Candidate 2 changes compute2
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "export function compute1() { return 1; }\nexport function compute2() { return 22; }\n");
  git('add', '.'); git('commit', '-m', 'candidate2');
  const candidate2Sha = git('rev-parse', 'HEAD');

  const db = new GenerationIndexDatabase();
  
  // Instrument indexer to count parent extractions
  const indexer = new CommitProjectIndexer();
  let extractCount = 0;
  const originalExtract = (indexer as any).extractProject.bind(indexer);
  (indexer as any).extractProject = function() {
    extractCount++;
    return originalExtract.apply(this, arguments as any);
  };

  const parentResult = indexer.indexCommit({ repositoryPath: root, commitSha: parentSha, database: db });
  const candidate1Result = indexer.indexCommit({ repositoryPath: root, commitSha: candidate1Sha, database: db });
  const candidate2Result = indexer.indexCommit({ repositoryPath: root, commitSha: candidate2Sha, database: db });
  
  assert.equal(parentResult.status, 'PUBLISHED');
  assert.equal(candidate1Result.status, 'PUBLISHED');
  assert.equal(candidate2Result.status, 'PUBLISHED');
  if (parentResult.status === 'PUBLISHED' && candidate1Result.status === 'PUBLISHED' && candidate2Result.status === 'PUBLISHED') {
    
    // Evaluate 1
    const engine = new IndexedQueryEngineV2();
    const result1 = engine.evaluate(db, parentResult.repositoryId, parentSha, candidate1Sha);
    
    // Evaluate 2
    const result2 = engine.evaluate(db, parentResult.repositoryId, parentSha, candidate2Sha);
    
    assert.equal(result1.status, 'COMPLETED');
    assert.equal(result2.status, 'COMPLETED');
    assert.equal(extractCount, 3, 'One parent and two candidate projects should be extracted once each');
    const parentDeclarations = db.getArtifacts<{ localName: string }>(parentResult.generationId,
      'tsconfig.json', 'DECLARATION').map(row => row.payload.localName);
    assert.ok(parentDeclarations.includes('compute1'));
    assert.ok(parentDeclarations.includes('compute2'));
    assert.equal(indexer.indexCommit({ repositoryPath: root, commitSha: parentSha, database: db }).status, 'REUSED');
    assert.equal(extractCount, 3, 'Reusing the parent generation must construct no Program');
    console.log('GATE 10 PASS: One complete parent generation serves multiple candidates without re-extraction.');
  }
  db.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
