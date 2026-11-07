/** Overload dispatch checked against sealed historical consumer sources. */
import * as assert from 'node:assert/strict';
import { fixture } from './TypeScriptSealedContextTestHelpers';
import { TypeScriptOverloadDispatcher } from '../../src/sajimora/languages/typescript/production/TypeScriptOverloadDispatcher';
function check(name: string, before: string, after: string, consumer: string, expected: 'PRESERVED' | 'VIOLATED', code?: number) {
  const { repository, obligation } = fixture(before, after, `import { fn } from './target';\n${consumer}`);
  const verdict = TypeScriptOverloadDispatcher.evaluateOverloadDispatch(obligation, repository);
  assert.equal(verdict.outcome, expected, `${name}: ${JSON.stringify(verdict.evidence)}`);
  assert.equal(verdict.assurance, 'COMPILER_STATIC');
  if (code) assert.ok(verdict.evidence.compilerStatic?.introducedDiagnostics.some(d => d.code === code), name);
  console.log(`Passed: ${name}`);
}
const overloads = 'export declare function fn(x: number): number; export declare function fn(x: string): string;';
check('safe insertion', overloads, 'export declare function fn(x: boolean): boolean; ' + overloads, 'const result: number = fn(1);', 'PRESERVED');
check('unsafe overlapping hijack', 'export declare function fn(x: { id: string }): number;', 'export declare function fn(x: { id: string }): string; export declare function fn(x: { id: string }): number;', 'const result: number = fn({ id: "x" });', 'VIOLATED', 2322);
check('disjoint reorder', overloads, 'export declare function fn(x: string): string; export declare function fn(x: number): number;', 'const result: number = fn(1);', 'PRESERVED');
check('acceptable narrowed return', 'export declare function fn(x: number): number | string;', 'export declare function fn(x: number): number;', 'const result: number | string = fn(1);', 'PRESERVED');
check('broken downstream return', 'export declare function fn(x: number): number;', 'export declare function fn(x: number): string;', 'const result: number = fn(1);', 'VIOLATED', 2322);
check('literal specialization removal', 'export declare function fn(x: "special"): number; export declare function fn(x: string): string;', 'export declare function fn(x: string): string;', 'const result: number = fn("special");', 'VIOLATED', 2322);
check('union no matching overload', 'export declare function fn(x: number | string): number | string;', overloads, 'declare const input: number | string; fn(input);', 'VIOLATED', 2769);
check('generic constraint', 'export declare function fn<T extends { id: string }>(x: T): T;', 'export declare function fn<T extends { id: string; version: number }>(x: T): T;', 'fn({ id: "x" });', 'VIOLATED', 2345);
check('implementation-only change', 'export function fn(x: number): number; export function fn(x: number): number { return x; }', 'export function fn(x: number): number; export function fn(x: number): number { return x + 1; }', 'const result: number = fn(1);', 'PRESERVED');
{
  const { repository, obligation } = fixture(overloads, overloads, 'import { fn } from "./target"; fn(1);');
  obligation.reference!.isUnresolvedBoundary = true;
  obligation.reference!.boundaryTaxonomyReason = 'AMBIGUOUS_OVERLOAD_CORRESPONDENCE';
  const result = TypeScriptOverloadDispatcher.evaluateOverloadDispatch(obligation, repository);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.evidence.unresolvedBoundary?.taxonomyCode, 'AMBIGUOUS_OVERLOAD_CORRESPONDENCE');
}
console.log('Phase 4 sealed overload dispatch passed.');
