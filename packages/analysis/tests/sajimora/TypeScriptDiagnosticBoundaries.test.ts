import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepositorySnapshot } from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { ProgramSetManager } from '../../src/sajimora/languages/typescript/production/ProgramSetManager';
import { TypeCheckerSemanticAnalyzer } from '../../src/sajimora/languages/typescript/production/TypeCheckerSemanticAnalyzer';
import { ScopeIsolationEngine } from '../../src/sajimora/languages/typescript/production/ScopeIsolationEngine';

function snapshot(id: string, texts: Record<string, string>): GenericRepositorySnapshot {
  return {
    snapshotId: id, rootIdentifier: '/',
    files: Object.entries(texts).map(([path, text]) => ({
      path, byteLength: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex')
    })),
    readTextFile: path => texts[path],
    readBinaryFile: path => texts[path] === undefined ? undefined : Buffer.from(texts[path])
  };
}

async function run() {
  // Two errors at identical positions must remain two references, even when
  // their compiler diagnostic codes and project IDs are identical.
  for (const moduleResolution of ['node', 'classic']) {
    const snap = snapshot(moduleResolution, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution, module: 'esnext' } }),
      'a.ts': 'import { missing } from "unavailable-package"; export const a = missing;',
      'b.ts': 'import { missing } from "unavailable-package"; export const b = missing;'
    });
    const graph = await new TypeScriptProductionAdapter().discoverProjectGraph(snap);
    const instance = new ProgramSetManager(snap, graph).getAllInstances()[0];
    const expectedCode = moduleResolution === 'classic' ? 2792 : 2307;
    assert.ok(instance.program.getSemanticDiagnostics().some(d => d.code === expectedCode));
    const boundaries = TypeCheckerSemanticAnalyzer.discoverReferences(instance, []).unresolvedBoundaries
      .filter(ref => ref.boundaryTaxonomyReason === 'DEPENDENCY_CLOSURE_UNAVAILABLE');
    assert.deepEqual(new Set(boundaries.map(ref => ref.location.filePath)), new Set(['a.ts', 'b.ts']));
    assert.equal(new Set(boundaries.map(ref => ref.referenceId)).size, boundaries.length);
  }

  const texts = {
    'tsconfig.json': '{}',
    'a.ts': 'export function broken( {',
    'b.ts': 'export function broken( {'
  };
  const parent = snapshot('parent', texts);
  const candidate = snapshot('candidate', texts);
  const adapter = new TypeScriptProductionAdapter();
  const parentGraph = await adapter.discoverProjectGraph(parent);
  const candidateGraph = await adapter.discoverProjectGraph(candidate);
  const instance = new ProgramSetManager(parent, parentGraph).getAllInstances()[0];
  const parseBoundaries = TypeCheckerSemanticAnalyzer.discoverReferences(instance, []).unresolvedBoundaries
    .filter(ref => ref.boundaryTaxonomyReason === 'PARSE_FAILED_POTENTIAL_CONSUMER');
  assert.deepEqual(new Set(parseBoundaries.map(ref => ref.location.filePath)), new Set(['a.ts', 'b.ts']));
  assert.equal(new Set(parseBoundaries.map(ref => ref.referenceId)).size, parseBoundaries.length);

  const scopeBoundaries = [
    ...ScopeIsolationEngine.computeTargetScope(parent, parentGraph, ['a.ts', 'b.ts']).dynamicBoundaries,
    ...ScopeIsolationEngine.computeTargetScope(candidate, candidateGraph, ['a.ts', 'b.ts']).dynamicBoundaries
  ].filter(ref => ref.boundaryTaxonomyReason === 'PARSE_FAILED_POTENTIAL_CONSUMER');
  assert.equal(scopeBoundaries.length, 4);
  assert.equal(new Set(scopeBoundaries.map(ref => ref.referenceId)).size, 4);
  console.log('TypeScript diagnostic boundaries PASSED (module resolution, file identity, snapshot identity).');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
