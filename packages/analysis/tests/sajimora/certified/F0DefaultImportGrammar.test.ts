import { test } from 'node:test';
import * as assert from 'node:assert';
import ts from 'typescript';
import { F0Grammar } from '../../../src/sajimora/certified/fragment/F0Grammar';

function clause(source: string): ts.ImportClause {
  const statement = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true).statements[0];
  return (statement as ts.ImportDeclaration).importClause!;
}

test('F0 admits only the sole static default import clause', () => {
  assert.equal(F0Grammar.classifyNode(clause(`import x from "./provider";`)).admitted, true);
  assert.equal(F0Grammar.classifyNode(clause(`import { default as x } from "./provider";`)).admitted, true);
  assert.equal(F0Grammar.classifyNode(clause(`import x, { y } from "./provider";`)).admitted, false);
  assert.equal(F0Grammar.classifyNode(clause(`import x, * as ns from "./provider";`)).admitted, false);
});

test('F0 admits only a sole namespace import clause', () => {
  const source = ts.createSourceFile('consumer.ts', `import * as ns from './provider';`, ts.ScriptTarget.Latest, true);
  let namespaceNode: ts.NamespaceImport | undefined;
  let clause: ts.ImportClause | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isNamespaceImport(node)) namespaceNode = node;
    if (ts.isImportClause(node)) clause = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(F0Grammar.classifyNode(clause!).admitted, true);
  assert.equal(F0Grammar.classifyNode(namespaceNode!).admitted, true);
});
