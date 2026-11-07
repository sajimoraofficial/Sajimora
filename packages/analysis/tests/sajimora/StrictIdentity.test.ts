import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommitProjectIndexer, GenerationIndexDatabase, IndexedPairDeriver } from '../../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-strict-id-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

try {
  git('init'); git('config', 'user.email', 't@t.invalid'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));

  // Parent commit setup
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 
`export function compute() { return 1; }
export function reorderA() { return 'A'; }
export function reorderB() { return 'B'; }
export function toBeMoved() { return 'move'; }
export function toBeRenamed() { return 'rename'; }
export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: any) { return x; }
`);
  git('add', '.'); git('commit', '-m', 'parent');
  const parentSha = git('rev-parse', 'HEAD');

  // Case 1: Delete+Add Same Code
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 
`// Unrelated change to mutate file hash
export function compute() { return 1; } // structurally identical
export function reorderA() { return 'A'; }
export function reorderB() { return 'B'; }
export function toBeMoved() { return 'move'; }
export function toBeRenamed() { return 'rename'; }
export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: any) { return x; }
`);
  git('commit', '-am', 'case1'); const case1Sha = git('rev-parse', 'HEAD');

  // Case 2: Reorder
  git('checkout', parentSha);
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 
`export function compute() { return 1; }
export function reorderB() { return 'B'; } // reordered
export function reorderA() { return 'A'; } // reordered
export function toBeMoved() { return 'move'; }
export function toBeRenamed() { return 'rename'; }
export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: any) { return x; }
`);
  git('commit', '-am', 'case2'); const case2Sha = git('rev-parse', 'HEAD');

  // Case 3 & 4: Rename/Move & Alias Preservation
  git('checkout', parentSha);
  fs.writeFileSync(path.join(root, 'src', 'moved.ts'), `export function toBeMoved() { return 'move'; }\nexport function renamedFunc() { return 'rename'; }`);
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 
`export function compute() { return 1; }
export function reorderA() { return 'A'; }
export function reorderB() { return 'B'; }
export { toBeMoved } from './moved'; // Alias preservation
// toBeRenamed is now in moved.ts
export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: any) { return x; }
`);
  git('add', '.'); git('commit', '-am', 'case34'); const case34Sha = git('rev-parse', 'HEAD');

  // Case 5: Overload Mutation
  git('checkout', parentSha);
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 
`export function compute() { return 1; }
export function reorderA() { return 'A'; }
export function reorderB() { return 'B'; }
export function toBeMoved() { return 'move'; }
export function toBeRenamed() { return 'rename'; }
export function overload(x: boolean): boolean; // mutated
export function overload(x: number): number;
export function overload(x: any) { return x; }
`);
  git('commit', '-am', 'case5'); const case5Sha = git('rev-parse', 'HEAD');

  // Case 6: Unmodified Blob (Control Case)
  git('checkout', parentSha);
  fs.writeFileSync(path.join(root, 'src', 'other.ts'), `export const something = 1;`);
  git('add', '.'); git('commit', '-am', 'case6'); const case6Sha = git('rev-parse', 'HEAD');

  const db = new GenerationIndexDatabase();
  const indexer = new CommitProjectIndexer();
  const indexed = new Map<string, NonNullable<ReturnType<GenerationIndexDatabase['getPublishedManifest']>>>();
  const index = (sha: string) => {
    const prior = indexed.get(sha);
    if (prior) return prior;
    const res = indexer.indexCommit({ repositoryPath: root, commitSha: sha, database: db });
    assert.equal(res.status, 'PUBLISHED', 'Indexing failed for ' + sha + ': ' + ('blockers' in res ? res.blockers.join(', ') : ''));
    const manifest = db.getPublishedManifest(res.repositoryId, sha, 'SAJIMORA_INDEX_V2')!;
    indexed.set(sha, manifest);
    return manifest;
  };

  const parentMan = index(parentSha)!;
  const deriver = new IndexedPairDeriver();
  
  const assertStatus = (candSha: string, targetName: string, expectedStatus: string) => {
    const candMan = index(candSha)!;
    const derived = deriver.derive(db, parentMan, candMan);
    const ob = derived.find(d => d.parentDeclaration.localName === targetName);
    assert.ok(ob, `Obligation for ${targetName} not found`);
    assert.equal(ob.mapping.status, expectedStatus, `Expected ${expectedStatus} for ${targetName}, got ${ob.mapping.status}`);
  };

  // 1. Delete+Add Same Code (Candidate-Only Replacement)
  assertStatus(case1Sha, 'compute', 'IDENTITY_UNPROVEN');
  
  // 2. Reorder
  assertStatus(case2Sha, 'reorderA', 'IDENTITY_UNPROVEN');
  assertStatus(case2Sha, 'reorderB', 'IDENTITY_UNPROVEN');

  // 3. Rename/Move
  assertStatus(case34Sha, 'toBeRenamed', 'IDENTITY_UNPROVEN');
  
  // 4. Alias Preservation
  assertStatus(case34Sha, 'toBeMoved', 'IDENTITY_UNPROVEN');
  
  // 5. Overload Mutation
  assertStatus(case5Sha, 'overload', 'IDENTITY_UNPROVEN');

  // 6. An unmodified export needs no mutation obligation.
  const unchanged = deriver.derive(db, parentMan, index(case6Sha)!);
  assert.equal(unchanged.find(item => item.parentDeclaration.localName === 'compute'), undefined);

  console.log('StrictIdentity.test.ts PASSED: All structural rules downgraded correctly.');
  db.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
