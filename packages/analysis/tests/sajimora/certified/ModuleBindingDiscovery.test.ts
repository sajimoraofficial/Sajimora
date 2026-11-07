import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { discoverStaticImports } from '../../../src/sajimora/certified/fragment/ModuleBindingDiscovery';

test('module binding discovery extracts only static imports in source order', () => {
  const source = ts.createSourceFile('consumer.ts', 'import { a } from "./a"; const x = 1; import * as b from "pkg";', ts.ScriptTarget.Latest, true);
  const imports = discoverStaticImports(source);
  assert.deepEqual(imports.map(item => item.moduleSpecifier), ['./a', 'pkg']);
  assert.equal(imports[0].declaration.getStart(source), 0);
  assert.equal(Boolean(imports[0].namedBindings && ts.isNamedImports(imports[0].namedBindings)), true);
  assert.equal(Boolean(imports[1].namedBindings && ts.isNamespaceImport(imports[1].namedBindings)), true);
});
