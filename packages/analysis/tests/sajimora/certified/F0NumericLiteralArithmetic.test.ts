import * as assert from 'node:assert';
import ts from 'typescript';
import { F0Grammar } from '../../../src/sajimora/certified/fragment/F0Grammar';

function expression(source: string): ts.Expression {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  assert.ok(statement && ts.isExpressionStatement(statement));
  return statement.expression;
}

assert.equal(F0Grammar.classifyNode(expression('1 + 2;')).admitted, true);
assert.equal(F0Grammar.classifyNode(expression('-6 * 7;')).admitted, true);
assert.equal(F0Grammar.classifyNode(expression('value + 2;')).admitted, false);
assert.equal(F0Grammar.classifyNode(expression('1 ** 2;')).admitted, false);
console.log('F0 numeric literal arithmetic passed');
