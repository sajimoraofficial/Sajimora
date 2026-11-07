import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SnapshotFilesystem, type GitObjectReader } from '@sajimora/analysis';
import { validateRepositoryBudget } from '../../packages/core/src/sajimora/verification/ExecutionLimits';
import { toGenericSnapshot } from './productionCommand';

const source = Buffer.from('export function gate(x: boolean): boolean { return x; }\n');
const link = Buffer.from('../src');
const binary = Buffer.from([0, 0xff, 0xfe, 0x89]);
const objects = {
  entries: () => [
    { mode: '100644', type: 'blob', objectId: 'source', path: 'src/gate.ts' },
    { mode: '120000', type: 'blob', objectId: 'link', path: '.codex/skills' },
    { mode: '100644', type: 'blob', objectId: 'binary', path: 'image.png' }
  ],
  batchBlobs: () => new Map([['source', source], ['link', link], ['binary', binary]])
} as unknown as GitObjectReader;
const snapshot = toGenericSnapshot(objects, 'commit');
assert.equal(snapshot.readTextFile('.codex/skills'), '../src');
assert.equal(snapshot.files.find(file => file.path === '.codex/skills')?.isSymlink, true);
assert.equal(snapshot.files.find(file => file.path === 'src/gate.ts')?.hash,
  createHash('sha256').update(source).digest('hex'));
assert.deepEqual(snapshot.omittedBinaryPaths, ['image.png']);
assert.equal(snapshot.files.some(file => file.path === 'image.png'), false);
assert.doesNotThrow(() => validateRepositoryBudget({ repositoryId: 'repo',
  parentSnapshot: snapshot, candidateSnapshot: snapshot }));
const materialized = new SnapshotFilesystem(objects).materialize('commit');
try {
  assert.equal(materialized.readTextFile('.codex/skills'), '../src');
} finally { materialized.cleanup(); }
console.log('Production Git snapshot bytes, symlink and binary boundary PASSED.');
