import assert from 'node:assert/strict';
import { GenericProjectGraph, GenericRepositorySnapshot } from '@sajimora/core';
import { buildSealedChangeInventory } from '../../src/sajimora/languages/typescript/production/SealedChangeInventory';

const snapshot = (id: string, files: Record<string, string>, symlink = false): GenericRepositorySnapshot => ({
  snapshotId: id, rootIdentifier: '/',
  files: Object.entries(files).map(([path, hash]) => ({ path, hash, byteLength: 1,
    ...(path === 'src/link.ts' ? { isSymlink: symlink } : {}) })),
  readTextFile: path => files[path], readBinaryFile: path => Buffer.from(files[path] ?? '')
});
const graph = (id: string): GenericProjectGraph => ({ graphId: id, edges: [], projects: [
  { projectId: `${id}:a`, rootDirectory: 'a', configFile: 'a/tsconfig.json',
    sourceFiles: ['a/provider.ts', 'a/consumer.ts'], projectReferences: [] },
  { projectId: `${id}:b`, rootDirectory: 'b', configFile: 'b/tsconfig.json',
    sourceFiles: ['b/unrelated.ts'], projectReferences: [] }
] });

const before = snapshot('before', { 'a/tsconfig.json': '1', 'a/provider.ts': '1',
  'a/consumer.ts': '1', 'b/tsconfig.json': '1', 'b/unrelated.ts': '1' });
const after = snapshot('after', { 'a/tsconfig.json': '2', 'a/provider.ts': '2',
  'a/consumer.ts': '1', 'b/tsconfig.json': '1', 'b/unrelated.ts': '1' });
const inventory = buildSealedChangeInventory({ repositoryId: 'r', parentSnapshot: before,
  candidateSnapshot: after }, graph('before'), graph('after'));
assert.deepEqual(inventory.changedFiles.map(file => file.path), ['a/provider.ts', 'a/tsconfig.json']);
assert.deepEqual(inventory.changedSourcePaths, ['a/provider.ts']);
assert.deepEqual(inventory.changedEnvironmentPaths, ['a/tsconfig.json']);
assert.deepEqual(inventory.directlyAffectedParentProjects, ['before:a']);
assert.deepEqual(inventory.directlyAffectedCandidateProjects, ['after:a']);
assert.equal(inventory.consumerClosure, 'UNVERIFIED');
assert.deepEqual(inventory.blockers, []);

const orphan = buildSealedChangeInventory({ repositoryId: 'r', parentSnapshot: before,
  candidateSnapshot: snapshot('orphan', { 'a/tsconfig.json': '1', 'a/provider.ts': '1',
    'a/consumer.ts': '1', 'b/tsconfig.json': '1', 'b/unrelated.ts': '1', 'outside.ts': 'x' }) },
  graph('before'), graph('orphan'));
assert.ok(orphan.blockers.includes('CHANGED_SOURCE_OUTSIDE_PROJECTS:outside.ts'));

const link = buildSealedChangeInventory({ repositoryId: 'r',
  parentSnapshot: snapshot('p', { 'src/link.ts': 'same' }, false),
  candidateSnapshot: snapshot('c', { 'src/link.ts': 'same' }, true) },
  { graphId: 'p', edges: [], projects: [] }, { graphId: 'c', edges: [], projects: [] });
assert.deepEqual(link.changedSourcePaths, ['src/link.ts'], 'Git mode changes belong in the inventory');
console.log('SealedChangeInventory tests passed');
