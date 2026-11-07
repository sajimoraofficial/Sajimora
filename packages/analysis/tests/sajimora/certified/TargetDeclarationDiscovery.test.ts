import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { discoverUniqueExportedFunction } from '../../../src/sajimora/certified/fragment/ModuleBindingDiscovery';

test('target discovery is unique and export-bound', () => {
  const vertex = { projectId: 'p0', fileId: 'provider.ts' };
  const valid = ts.createSourceFile('provider.ts', 'export function target(x: string): string { return x; }', ts.ScriptTarget.Latest, true);
  const privateTarget = ts.createSourceFile('provider.ts', 'function target(x: string): string { return x; }', ts.ScriptTarget.Latest, true);
  const ambiguous = ts.createSourceFile('provider.ts', 'export function target(x: string): string { return x; } export function target(x: number): string { return String(x); }', ts.ScriptTarget.Latest, true);
  assert.equal(discoverUniqueExportedFunction(vertex, valid, 'target')?.name, 'target');
  assert.equal(discoverUniqueExportedFunction(vertex, privateTarget, 'target'), undefined);
  assert.equal(discoverUniqueExportedFunction(vertex, ambiguous, 'target'), undefined);
});
