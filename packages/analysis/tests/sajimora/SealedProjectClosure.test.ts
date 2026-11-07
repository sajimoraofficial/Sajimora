import assert from 'node:assert/strict';
import { GenericProjectGraph, GenericRepositorySnapshot } from '@sajimora/core';
import { buildSealedProjectClosure } from '../../src/sajimora/languages/typescript/production/SealedProjectClosure';
import { verifySealedProjectClosure } from '../../src/sajimora/languages/typescript/production/SealedProjectClosureVerifier';
import * as ts from 'typescript';

const snapshot = (files: Record<string, string>): GenericRepositorySnapshot => ({
  snapshotId: 'sealed', rootIdentifier: '/',
  files: Object.entries(files).map(([path, text]) => ({ path, byteLength: text.length, hash: text })),
  readTextFile: path => files[path], readBinaryFile: path => Buffer.from(files[path] ?? '')
});
const graph: GenericProjectGraph = { graphId: 'g', edges: [], projects: [
  { projectId: 'provider', rootDirectory: 'provider', sourceFiles: ['provider/api.ts'], projectReferences: [] },
  { projectId: 'consumer', rootDirectory: 'consumer', sourceFiles: ['consumer/use.ts'], projectReferences: [] },
  { projectId: 'unrelated', rootDirectory: 'unrelated', sourceFiles: ['unrelated/other.ts'], projectReferences: [] }
] };
const files = { 'provider/api.ts': 'export const api = 1;',
  'consumer/use.ts': 'import { api } from "../provider/api"; export const value = api;',
  'unrelated/other.ts': 'export const other = 2;' };
const closure = buildSealedProjectClosure(snapshot(files), graph, ['provider/api.ts']);
assert.equal(closure.status, 'PROVEN');
assert.deepEqual(closure.selectedProjectIds, ['consumer', 'provider']);
assert.deepEqual(closure.reachedFiles, ['consumer/use.ts', 'provider/api.ts']);
assert.equal(verifySealedProjectClosure(snapshot(files), graph, ['provider/api.ts'], closure).status, 'PROVEN');
const forged = { ...closure, selectedProjectIds: ['provider'] };
const rejected = verifySealedProjectClosure(snapshot(files), graph, ['provider/api.ts'], forged);
assert.equal(rejected.status, 'UNPROVEN');
assert.ok(rejected.blockers.some(blocker => blocker.startsWith('EXCLUDED_PROJECT_CONSUMES_SELECTED:')));
const jsSpecifier = snapshot({ ...files,
  'consumer/use.ts': 'import { api } from "../provider/api.js"; export const value = api;' });
const jsClosure = buildSealedProjectClosure(jsSpecifier, graph, ['provider/api.ts']);
assert.deepEqual(jsClosure.selectedProjectIds, ['consumer', 'provider']);
assert.equal(verifySealedProjectClosure(jsSpecifier, graph, ['provider/api.ts'], jsClosure).status, 'PROVEN');
const hiddenDynamic = verifySealedProjectClosure(snapshot({ ...files,
  'unrelated/other.ts': 'export const other = require /* comment */ ("../provider/api");' }),
  graph, ['provider/api.ts'], closure);
assert.equal(hiddenDynamic.status, 'UNPROVEN');
assert.ok(hiddenDynamic.blockers.includes('EXCLUDED_PROJECT_DYNAMIC_OR_AMBIENT:unrelated/other.ts'));

const unresolved = buildSealedProjectClosure(snapshot({ ...files,
  'unrelated/other.ts': 'import { api } from "missing-alias"; export const other = api;' }), graph, ['provider/api.ts']);
assert.equal(unresolved.status, 'UNPROVEN');
assert.ok(unresolved.blockers.some(blocker => blocker.startsWith('EXTERNAL_MODULE_EDGE:')));
assert.equal(verifySealedProjectClosure(snapshot({ ...files,
  'unrelated/other.ts': 'import { api } from "missing-alias"; export const other = api;' }),
  graph, ['provider/api.ts'], unresolved).status, 'UNPROVEN');

const absent = buildSealedProjectClosure(snapshot(files), graph, ['outside.ts']);
assert.equal(absent.status, 'UNPROVEN');
assert.ok(absent.blockers.includes('CHANGED_SOURCE_OUTSIDE_PROJECTS:outside.ts'));
const workspace = snapshot({ ...files, 'provider/package.json': '{"name":"@acme/library","exports":{".":"./api.ts"}}',
  'consumer/use.ts': 'import { api } from "@acme/library"; export const value = api;' });
const workspaceClosure = buildSealedProjectClosure(workspace, graph, ['provider/api.ts']);
assert.equal(workspaceClosure.status, 'PROVEN');
assert.deepEqual(workspaceClosure.selectedProjectIds, ['consumer', 'provider']);
assert.equal(verifySealedProjectClosure(workspace, graph, ['provider/api.ts'], workspaceClosure).status, 'PROVEN');
const unsupportedJson = snapshot({ ...files, 'unrelated/data.json': '{"value":1}',
  'unrelated/other.ts': 'import data from "./data.json"; export const other = data;' });
const jsonProposal = buildSealedProjectClosure(unsupportedJson, graph, ['provider/api.ts']);
const jsonVerification = verifySealedProjectClosure(unsupportedJson, graph, ['provider/api.ts'], jsonProposal);
assert.equal(jsonVerification.status, 'UNPROVEN');
assert.ok(jsonVerification.blockers.includes(
  'EXCLUDED_PROJECT_COMPILER_RESOLUTION_MISMATCH:unrelated/other.ts:./data.json'));
const redirectedGraph: GenericProjectGraph = { ...graph, projects: graph.projects.map(project =>
  project.projectId === 'unrelated' ? { ...project,
    options: { moduleResolution: ts.ModuleResolutionKind.Node10, baseUrl: '/',
      paths: { '@acme/library': ['unrelated/decoy.ts'] } } } : project) };
const redirectedSnapshot = snapshot({ ...files,
  'provider/package.json': '{"name":"@acme/library","exports":{".":"./api.ts"}}',
  'unrelated/decoy.ts': 'export const api = 2;',
  'unrelated/other.ts': 'import { api } from "@acme/library"; export const other = api;' });
const redirectedProposal = buildSealedProjectClosure(redirectedSnapshot, redirectedGraph, ['provider/api.ts']);
const redirectedVerification = verifySealedProjectClosure(redirectedSnapshot, redirectedGraph,
  ['provider/api.ts'], { ...redirectedProposal, selectedProjectIds: ['provider'] });
assert.ok(redirectedVerification.blockers.includes(
  'EXCLUDED_PROJECT_PACKAGE_RESOLUTION_MISMATCH:unrelated/other.ts:@acme/library:unrelated/decoy.ts'));
console.log('SealedProjectClosure tests passed');
