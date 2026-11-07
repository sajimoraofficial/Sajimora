import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { F0BindingVerifier } from '../../../src/sajimora/certified/fragment/F0BindingVerifier';

test('binding discovery wrapper preserves exhaustive verifier behavior during refactor', () => {
  const vertex = { projectId: 'p0', fileId: 'consumer.ts' };
  const source = ts.createSourceFile('consumer.ts', 'import { target } from "./provider"; const value = target("ok");', ts.ScriptTarget.Latest, true);
  const discovered = F0BindingVerifier.discoverModuleBindings(vertex, source);
  const validated = F0BindingVerifier.extractModuleBindings(vertex, source);
  assert.deepEqual(discovered.result, validated.result);
  assert.deepEqual([...discovered.bindings!.imports.keys()], [...validated.bindings!.imports.keys()]);
});
