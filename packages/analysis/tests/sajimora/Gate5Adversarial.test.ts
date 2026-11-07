import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommitProjectIndexer, GenerationIndexDatabase, IndexedPairDeriver } from '../../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-gate5-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

try {
  git('init'); git('config', 'user.email', 't@t.invalid'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));

  // Parent
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "export function compute() { return 1; }\n");
  git('add', '.'); git('commit', '-m', 'parent');
  const parentSha = git('rev-parse', 'HEAD');

  // Candidate: insert an unrelated local parameter named 'compute' before the exported function
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "function unrelated(compute: string) {}\nexport function compute() { return 1; }\n");
  git('add', '.'); git('commit', '-m', 'candidate');
  const candidateSha = git('rev-parse', 'HEAD');

  const db = new GenerationIndexDatabase();
  const indexer = new CommitProjectIndexer();
  
  const parentResult = indexer.indexCommit({ repositoryPath: root, commitSha: parentSha, database: db });
  const candidateResult = indexer.indexCommit({ repositoryPath: root, commitSha: candidateSha, database: db });
  
  if (parentResult.status === 'PUBLISHED' && candidateResult.status === 'PUBLISHED') {
    const parentManifest = db.getPublishedManifest(parentResult.repositoryId, parentSha, 'SAJIMORA_INDEX_V2')!;
    const candidateManifest = db.getPublishedManifest(candidateResult.repositoryId, candidateSha, 'SAJIMORA_INDEX_V2')!;
    
    const derived = new IndexedPairDeriver().derive(db, parentManifest, candidateManifest);
    
    console.log("Derived obligations:", derived.map(o => ({
        parent: o.parentDeclaration.localName,
        candidate: o.obligation.providerMutation?.classification
    })));

    const computeObligation = derived.find(o => o.parentDeclaration.localName === 'compute');
    if (!computeObligation || computeObligation.obligation.providerMutation?.classification === 'SYMBOL_DELETED') {
        console.log("GATE 5 FAIL: Identity broken by unrelated local parameter insertion!");
    } else {
        console.log("GATE 5 PASS: Identity stable.");
    }
  } else {
    console.log("Indexing failed");
  }
  db.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
