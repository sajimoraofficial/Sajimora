import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { F0BindingVerifier } from '../../packages/analysis/src/sajimora/certified/fragment/F0BindingVerifier';
import { HistoricalObligationGenerator } from '../../packages/analysis/src/sajimora/certified/obligations/HistoricalObligationGenerator';

test('call-site extractor produces obligations for a direct literal call', () => {
  const provider = ts.createSourceFile('provider.ts', 'export function target(data: string): boolean { return data.length > 0; }', ts.ScriptTarget.Latest, true);
  const consumer = ts.createSourceFile('consumer.ts', 'import { target } from "./provider.ts"; const result: boolean = target("ok");', ts.ScriptTarget.Latest, true);
  const providerBindings = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: 'provider.ts' }, provider);
  assert.equal(providerBindings.result.valid, true);
  const target = providerBindings.bindings?.exportedSymbols.get('target');
  assert.ok(target);
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) call = node;
    ts.forEachChild(node, visit);
  };
  visit(consumer);
  assert.ok(call);
  const extractor = (HistoricalObligationGenerator as any).extractCallObligations as Function;
  const occurrence = extractor({ projectId: 'p0', fileId: 'consumer.ts' }, consumer, call, 'target', target);
  assert.ok(occurrence, 'direct literal call should produce an occurrence');
  assert.equal(occurrence.requiredRelations.length, 3);
});

test('type-only alias initializer produces an assignment obligation', () => {
  const provider = ts.createSourceFile('provider.ts', 'export type Label = number;', ts.ScriptTarget.Latest, true);
  const consumer = ts.createSourceFile('consumer.ts', 'import type { Label } from "./provider.ts"; export const value: Label = "type-only";', ts.ScriptTarget.Latest, true);
  const providerBindings = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: 'provider.ts' }, provider);
  assert.equal(providerBindings.result.valid, true);
  const target = providerBindings.bindings?.exportedSymbols.get('Label');
  assert.ok(target);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(consumer);
  assert.ok(declaration);
  const extractor = (HistoricalObligationGenerator as any).extractInitializationObligation as Function;
  const occurrence = extractor({ projectId: 'p0', fileId: 'consumer.ts' }, consumer, declaration, 'Label', target);
  assert.ok(occurrence, 'typed initializer should produce an occurrence');
  assert.equal(occurrence.requiredRelations[0].kind, 'ASSIGNMENT_ACCEPTS');
});
