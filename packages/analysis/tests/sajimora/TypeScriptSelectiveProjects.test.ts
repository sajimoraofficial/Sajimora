import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepositorySnapshot } from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';

const config = JSON.stringify({ compilerOptions: { strict: true }, include: ['**/*.ts'] });
const original = {
  'provider/tsconfig.json': config,
  'provider/api.ts': 'export function api(x: number): number { return x + 1; }',
  'consumer/tsconfig.json': config,
  'consumer/use.ts': 'import { api } from "../provider/api"; export const result = api(1);',
  'unrelated/tsconfig.json': config,
  'unrelated/other.ts': 'export const other = 2;'
};
const snapshot = (id: string, source: Record<string, string>): GenericRepositorySnapshot => ({
  snapshotId: id, rootIdentifier: '/',
  files: Object.entries(source).map(([path, content]) => ({ path,
    byteLength: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') })),
  readTextFile: path => source[path], readBinaryFile: path => Buffer.from(source[path] ?? '')
});
async function selected(extra: Record<string, string> = {}): Promise<string[]> {
  const parent = snapshot('parent', { ...original, ...extra });
  const candidate = snapshot('candidate', { ...original, ...extra,
    'provider/api.ts': 'export function api(x: number): number { return x + 2; }' });
  const adapter = new TypeScriptProductionAdapter();
  const parentGraph = await adapter.discoverProjectGraph(parent);
  const candidateGraph = await adapter.discoverProjectGraph(candidate);
  const mapping = await adapter.mapProjectGraphs(parentGraph, candidateGraph);
  await adapter.identifyEntitiesAndChanges({ repositoryId: 'selective', parentSnapshot: parent,
    candidateSnapshot: candidate }, mapping);
  const manager = (adapter as unknown as { programSets: WeakMap<GenericRepositorySnapshot,
    { getAllInstances(): readonly { project: { projectId: string } }[] }> }).programSets.get(parent);
  assert.ok(manager);
  return manager.getAllInstances().map(instance => instance.project.projectId).sort();
}
void (async () => {
  assert.deepEqual(await selected(), ['parent::consumer/tsconfig.json', 'parent::provider/tsconfig.json']);
  assert.deepEqual(await selected({ 'unrelated/other.ts': 'import "external-package"; export const other = 2;' }),
    ['parent::consumer/tsconfig.json', 'parent::provider/tsconfig.json', 'parent::unrelated/tsconfig.json'],
    'an unresolved excluded import must force the full compiler path');
  console.log('TypeScript selective project tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
