import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { discoverTopLevelDeclarations } from '../../../src/sajimora/certified/fragment/ModuleBindingDiscovery';

test('declaration discovery finds target declarations without validating unrelated syntax', () => {
  const source = ts.createSourceFile('provider.ts', 'export function target(x: string): string { return x; }\nfunction unrelated(x?: number) { return x; }\nexport const value = 1;', ts.ScriptTarget.Latest, true);
  const declarations = discoverTopLevelDeclarations({ projectId: 'p0', fileId: 'provider.ts' }, source);
  assert.deepEqual(declarations.map(declaration => [declaration.name, declaration.kind, declaration.exported]), [['target', 'FUNCTION', true], ['unrelated', 'FUNCTION', false], ['value', 'CONST', true]]);
});
