import assert from 'node:assert/strict';
import { GenericRepositorySnapshot } from '@sajimora/core';
import { buildSealedWorkspacePackageIndex } from '../../src/sajimora/languages/typescript/production/SealedWorkspacePackages';
import { sealedImportConditions } from '../../src/sajimora/languages/typescript/production/SealedImportConditions';
import * as ts from 'typescript';

const make = (files: Record<string, string>): GenericRepositorySnapshot => ({
  snapshotId: 'packages', rootIdentifier: '/',
  files: Object.entries(files).map(([path, text]) => ({ path, byteLength: text.length, hash: text })),
  readTextFile: path => files[path], readBinaryFile: path => Buffer.from(files[path] ?? '')
});
const index = buildSealedWorkspacePackageIndex(make({
  'packages/alpha/package.json': '{"name":"@example/alpha","exports":{".":{"types":"./src/index.ts","import":"./dist/index.js"},"./sub/*":"./src/*.ts"}}',
  'packages/alpha/src/index.ts': 'export const value = 1;',
  'packages/alpha/src/tool.ts': 'export const tool = 1;',
  'packages/beta/package.json': '{"name":"beta"}',
  'packages/beta/src/index.ts': 'export const value = 2;'
}));
assert.equal(index.resolve('@example/alpha/subpath')?.manifestPath, 'packages/alpha/package.json');
assert.deepEqual(index.resolveEntry('@example/alpha').files, ['packages/alpha/src/index.ts']);
assert.ok(index.resolveEntry('@example/alpha').blockers.includes(
  'MISSING_WORKSPACE_EXPORT_SOURCE:@example/alpha:./dist/index.js'));
assert.deepEqual(index.resolveEntry('@example/alpha', ['types', 'import']).blockers, []);
assert.deepEqual(index.resolveEntry('@example/alpha', ['types', 'import']).files,
  ['packages/alpha/src/index.ts']);
assert.deepEqual(index.resolveEntry('@example/alpha/sub/tool').files, ['packages/alpha/src/tool.ts']);
assert.ok(index.resolveEntry('@example/alpha/subpath').blockers.includes(
  'UNEXPORTED_WORKSPACE_SUBPATH:@example/alpha/subpath'));
assert.deepEqual(index.resolve('beta')?.sourceFiles, ['packages/beta/src/index.ts']);
assert.equal(index.resolve('betamax'), undefined);
assert.equal(index.resolve('external-library'), undefined);
assert.deepEqual(index.blockers, []);
const duplicate = buildSealedWorkspacePackageIndex(make({
  'a/package.json': '{"name":"same"}', 'b/package.json': '{"name":"same"}'
}));
assert.ok(duplicate.blockers.includes('DUPLICATE_PACKAGE_NAME:same'));
const ambiguous = buildSealedWorkspacePackageIndex(make({
  'p/package.json': '{"name":"p","exports":{"./sub/*":"./src/*.ts","./sub/tool*":"./src/tool*.ts"}}',
  'p/src/tool.ts': 'export const tool = 1;'
}));
assert.ok(ambiguous.resolveEntry('p/sub/tool').blockers.includes(
  'AMBIGUOUS_WORKSPACE_EXPORT_PATTERN:p/sub/tool'));
const conditions = sealedImportConditions('consumer/use.mts', { graphId: 'g', edges: [], projects: [
  { projectId: 'consumer', rootDirectory: 'consumer', sourceFiles: ['consumer/use.mts'], projectReferences: [],
    options: { moduleResolution: ts.ModuleResolutionKind.NodeNext, customConditions: ['source'] } }
] }, ['consumer']);
assert.ok(conditions?.[0].includes('import'));
assert.ok(conditions?.[0].includes('source'));
assert.equal(sealedImportConditions('consumer/use.ts', { graphId: 'g', edges: [], projects: [] }, ['consumer']), undefined);
const conditional = buildSealedWorkspacePackageIndex(make({
  'p/package.json': '{"name":"p","exports":{".":{"source":"./src/index.ts","import":"./dist/index.js"}}}',
  'p/src/index.ts': 'export const value = 1;'
}));
assert.deepEqual(conditional.resolveEntry('p', conditions![0]).blockers, []);
assert.ok(conditional.resolveEntry('p').blockers.includes('MISSING_WORKSPACE_EXPORT_SOURCE:p:./dist/index.js'));
const versioned = buildSealedWorkspacePackageIndex(make({
  'p/package.json': '{"name":"p","exports":{".":{"types@>=5.0":"./src/index.ts","default":"./src/index.ts"}}}',
  'p/src/index.ts': 'export const value = 1;'
}));
assert.ok(versioned.resolveEntry('p', ['types', 'import']).blockers.includes(
  'VERSIONED_WORKSPACE_EXPORT_CONDITION:p'));
const esm = make({ 'consumer/package.json': '{"type":"module"}',
  'consumer/use.ts': 'import { value } from "p";' });
const esmGraph = { graphId: 'esm', edges: [], projects: [
  { projectId: 'esm', rootDirectory: 'consumer', sourceFiles: ['consumer/use.ts'], projectReferences: [],
    options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      customConditions: ['source'] } }
] };
const esmConditions = sealedImportConditions('consumer/use.ts', esmGraph, ['esm'], esm);
assert.ok(esmConditions?.[0].includes('import'));
assert.ok(esmConditions?.[0].includes('source'));
console.log('SealedWorkspacePackages tests passed');
