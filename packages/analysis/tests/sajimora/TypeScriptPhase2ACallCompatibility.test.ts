import * as assert from 'node:assert/strict';
import { fixture, snapshot, check } from './TypeScriptSealedContextTestHelpers';
import { TypeScriptCallCompatibilityEvaluator } from '../../src/sajimora/languages/typescript/production/TypeScriptCallCompatibilityEvaluator';
check('same arity incompatible argument', 'export function fn(x: number): void {}', 'export function fn(x: string): void {}', 'fn(10);', 'VIOLATED', 2345);
check('parameter widening', 'export function fn(x: number): void {}', 'export function fn(x: number | string): void {}', 'fn(10);', 'PRESERVED');
check('return narrowing', 'export declare function fn(): number | string;', 'export declare function fn(): number;', 'const result: number | string = fn();', 'PRESERVED');
check('consumed return change', 'export declare function fn(): number;', 'export declare function fn(): string;', 'const value: number = fn(); value.toFixed(2);', 'VIOLATED', 2322);
check('discarded return', 'export declare function fn(): number;', 'export declare function fn(): void;', 'fn();', 'PRESERVED');
check('required argument added', 'export function fn(msg: string): void {}', 'export function fn(msg: string, timeout: number): void {}', 'fn("hello");', 'VIOLATED', 2554);
const tuple = 'const args: [number, string] = [1, "x"]; fn(...args);';
check('tuple spread required', 'export function fn(x: number, y: string): void {}', 'export function fn(x: number, y: string, z: boolean): void {}', tuple, 'VIOLATED', 2554);
check('tuple spread optional', 'export function fn(x: number, y: string): void {}', 'export function fn(x: number, y: string, z?: boolean): void {}', tuple, 'PRESERVED');
check('optional to rest', 'export function fn(pattern: string, arg?: string): void {}', 'export function fn(pattern: string, ...args: string[]): void {}', 'fn("%s");', 'PRESERVED');
check('detached receiver', 'export function fn(): void {}', 'interface AdminContext { admin: boolean }; export function fn(this: AdminContext): void {}', 'const detached = fn; detached();', 'VIOLATED', 2684);
check('callback variance', 'export declare function fn(cb: (e: { mouse: number }) => void): void;', 'export declare function fn(cb: (e: { custom: string }) => void): void;', 'fn((e: { mouse: number }) => {});', 'VIOLATED', 2345);
check('predicate removal', 'export declare function fn(val: unknown): val is string;', 'export declare function fn(val: unknown): boolean;', 'let x: unknown; if (fn(x)) { x.toUpperCase(); }', 'VIOLATED', 18046);
check('inferred bounded generic', 'export declare function fn<T extends { id: string }>(value: T): T;', 'export declare function fn<T extends { id: string; version: number }>(value: T): T;', 'fn({ id: "x" });', 'VIOLATED', 2345);
check('explicit bounded generic', 'export declare function fn<T extends { id: string }>(value: T): T;', 'export declare function fn<T extends { id: string; version: number }>(value: T): T;', 'fn<{ id: string }>({ id: "x" });', 'VIOLATED', 2344);
// Evaluator must retain an upstream unresolved boundary, even when the compiler accepts any.
{
  const { repository, obligation } = fixture('export declare function fn(x: string): void;', 'export declare function fn(x: string): void;', 'import { fn } from "./target"; declare const x: any; fn(x);');
  obligation.reference!.isUnresolvedBoundary = true;
  obligation.reference!.boundaryTaxonomyReason = 'ANY_CALL_ARGUMENT_BOUNDARY';
  const verdict = TypeScriptCallCompatibilityEvaluator.evaluateCall(obligation, repository);
  assert.equal(verdict.outcome, 'UNKNOWN');
  assert.equal(verdict.evidence.unresolvedBoundary?.taxonomyCode, 'ANY_CALL_ARGUMENT_BOUNDARY');
}
{
  const { repository, obligation } = fixture('export declare function fn(): void;', 'export declare function fn(): void;', '');
  const empty = snapshot('empty', {});
  const verdict = TypeScriptCallCompatibilityEvaluator.evaluateCall(obligation, { ...repository, parentSnapshot: empty });
  assert.equal(verdict.outcome, 'UNKNOWN');
  assert.equal(verdict.evidence.unresolvedBoundary?.taxonomyCode, 'MISSING_SEALED_CONSUMER_SOURCE');
}
console.log('Phase 2A sealed call compatibility and evidence boundaries passed.');
