import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepositorySnapshot } from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';

const config = JSON.stringify({ compilerOptions: { strict: true }, include: ['**/*.ts'] });
const files: Record<string, string> = {};
for (let index = 0; index < 6; index++) {
  const name = index === 0 ? 'provider' : `unrelated${index}`;
  files[`${name}/tsconfig.json`] = config;
  files[`${name}/index.ts`] = index === 0
    ? 'export function api(value: number): number { return value + 1; }'
    : index === 1 ? "import 'unresolved-external'; export const unrelated = 1;"
      : `export const unrelated${index} = ${index};`;
}
const snapshot = (id: string, contents: Record<string, string>): GenericRepositorySnapshot => ({
  snapshotId: id, rootIdentifier: '/',
  files: Object.entries(contents).map(([path, content]) => ({ path,
    byteLength: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') })),
  readTextFile: path => contents[path],
  readBinaryFile: path => contents[path] === undefined ? undefined : Buffer.from(contents[path])
});

void (async () => {
  const parent = snapshot('parent', files);
  const candidate = snapshot('candidate', { ...files,
    'provider/index.ts': 'export function api(value: number): number { return value + 2; }' });
  const repository = { repositoryId: 'bounded-selection', parentSnapshot: parent, candidateSnapshot: candidate };
  const adapter = new TypeScriptProductionAdapter();
  const parentGraph = await adapter.discoverProjectGraph(parent);
  const candidateGraph = await adapter.discoverProjectGraph(candidate);
  const mapping = await adapter.mapProjectGraphs(parentGraph, candidateGraph);
  const identified = await adapter.identifyEntitiesAndChanges(repository, mapping);
  const internals = adapter as unknown as {
    selectedProjects: WeakMap<GenericRepositorySnapshot, ReadonlySet<string>>;
    programSets: WeakMap<GenericRepositorySnapshot, unknown>;
  };
  assert.deepEqual([...internals.selectedProjects.get(parent) ?? []], ['parent::provider/tsconfig.json']);
  assert.equal(internals.programSets.get(parent), undefined, 'bounded mode must release project Programs');
  const references = await adapter.discoverReferences(parent, parentGraph,
    identified.entities.filter(entity => entity.name === 'api'));
  assert.ok(references.unresolvedBoundaries.some(reference =>
    reference.boundaryTaxonomyReason === 'PROJECT_CONSUMER_CLOSURE_UNPROVEN'));
  const obligations = await adapter.generateObligations(identified.changes,
    [...references.staticReferences, ...references.unresolvedBoundaries]);
  assert.ok(obligations.some(obligation => obligation.reference?.isUnresolvedBoundary));
  const api = obligations.find(obligation => obligation.question === 'API_COMPATIBILITY');
  assert.ok(api);
  assert.equal((await adapter.evaluateObligation(api, repository)).outcome, 'UNKNOWN');

  const connected: Record<string, string> = {
    'provider/tsconfig.json': config,
    'provider/index.ts': 'export function api(value: number): number { return value + 1; }'
  };
  for (let index = 1; index <= 5; index++) {
    connected[`consumer${index}/tsconfig.json`] = config;
    connected[`consumer${index}/index.ts`] =
      `import { api } from '../provider/index'; export const result${index} = api(${index});`;
  }
  const connectedParent = snapshot('connected-parent', connected);
  const connectedCandidate = snapshot('connected-candidate', { ...connected,
    'provider/index.ts': 'export function api(value: number): number { return value + 2; }' });
  const connectedAdapter = new TypeScriptProductionAdapter();
  const connectedParentGraph = await connectedAdapter.discoverProjectGraph(connectedParent);
  const connectedCandidateGraph = await connectedAdapter.discoverProjectGraph(connectedCandidate);
  const connectedMapping = await connectedAdapter.mapProjectGraphs(connectedParentGraph, connectedCandidateGraph);
  const connectedResult = await connectedAdapter.identifyEntitiesAndChanges({ repositoryId: 'connected',
    parentSnapshot: connectedParent, candidateSnapshot: connectedCandidate }, connectedMapping);
  const connectedInternals = connectedAdapter as unknown as {
    selectedProjects: WeakMap<GenericRepositorySnapshot, ReadonlySet<string>>;
    programSets: WeakMap<GenericRepositorySnapshot, unknown>;
    boundedSnapshots: WeakSet<GenericRepositorySnapshot>;
  };
  assert.equal(connectedInternals.selectedProjects.get(connectedParent)?.size, 6);
  assert.equal(connectedInternals.boundedSnapshots.has(connectedParent), true);
  assert.equal(connectedInternals.programSets.get(connectedParent), undefined,
    'proven multi-project extraction must release Programs between projects');
  assert.ok(connectedResult.entities.some(entity => entity.name === 'api'));
  console.log('TypeScript bounded project selection: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
