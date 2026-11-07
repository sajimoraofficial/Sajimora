import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { F0BindingVerifier } from '../../../src/sajimora/certified/fragment/F0BindingVerifier';

test('import discovery is independent from exhaustive binding validation', () => {
  const source = ts.createSourceFile('consumer.ts', 'import { target } from "./provider"; import * as ns from "pkg"; const x = 1;', ts.ScriptTarget.Latest, true);
  const imports = F0BindingVerifier.discoverImports(source);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map(item => item.moduleSpecifier), ['./provider', 'pkg']);
  assert.equal(Boolean(imports[0].namedBindings && ts.isNamedImports(imports[0].namedBindings)), true);
  assert.equal(Boolean(imports[1].namedBindings && ts.isNamespaceImport(imports[1].namedBindings)), true);
});
