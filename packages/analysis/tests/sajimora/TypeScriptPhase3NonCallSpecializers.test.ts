/** Source-backed contextual compatibility. Diagnostics cover the historical consumer file. */
import * as assert from 'node:assert/strict';
import { fixture } from './TypeScriptSealedContextTestHelpers';
import { TypeScriptContextualSpecializer } from '../../src/sajimora/languages/typescript/production/TypeScriptContextualSpecializer';
function check(name: string, before: string, after: string, consumer: string, expected: 'PRESERVED' | 'VIOLATED', code?: number) {
  const { repository, obligation } = fixture(before, after, consumer);
  obligation.reference!.kind = 'STATIC_PROPERTY_ACCESS';
  const verdict = TypeScriptContextualSpecializer.evaluateContextualSpecialization(obligation, repository);
  assert.equal(verdict.outcome, expected, `${name}: ${JSON.stringify(verdict.evidence)}`);
  assert.equal(verdict.assurance, 'COMPILER_STATIC');
  if (code) assert.ok(verdict.evidence.compilerStatic?.introducedDiagnostics.some(d => d.code === code), name);
  console.log(`Passed: ${name}`);
}
const wide = 'export interface Target { prop: number | string }; export declare const value: Target;';
const narrow = 'export interface Target { prop: number }; export declare const value: Target;';
check('narrowed read', wide, narrow, 'import { value } from "./target"; const result: number | string = value.prop;', 'PRESERVED');
check('unsafe write', wide, narrow, 'import { value } from "./target"; value.prop = "x";', 'VIOLATED', 2322);
check('readonly mutation', 'export declare const value: { prop: number };', 'export declare const value: { readonly prop: number };', 'import { value } from "./target"; value.prop = 1;', 'VIOLATED', 2540);
check('removed setter', 'export declare class Target { get prop(): number; set prop(value: number); }', 'export declare class Target { get prop(): number; }', 'import { Target } from "./target"; const value = new Target(); value.prop = 1;', 'VIOLATED', 2540);
check('removed property', narrow, 'export declare const value: {};', 'import { value } from "./target"; value.prop;', 'VIOLATED', 2339);
check('receiver narrowing', 'export declare const value: { run(): void };', 'export declare const value: { stop(): void };', 'import { value } from "./target"; value.run();', 'VIOLATED', 2339);
check('safe sibling addition', narrow, 'export interface Target { prop: number; sibling?: string }; export declare const value: Target;', 'import { value } from "./target"; const result: number = value.prop;', 'PRESERVED');
check('required interface addition', 'export interface Target { prop: number };', 'export interface Target { prop: number; added: string };', 'import { Target } from "./target"; class Consumer implements Target { prop = 1; }', 'VIOLATED', 2420);
check('private origin mismatch', 'export declare class Target { prop: number; }', 'export declare class Target { prop: number; private secret: string; }', 'import { Target } from "./target"; class Consumer implements Target { prop = 1; private secret = "x"; }', 'VIOLATED', 2720);
check('callback variance', 'export declare function register(cb: (event: { mouse: number }) => void): void;', 'export declare function register(cb: (event: { custom: string }) => void): void;', 'import { register } from "./target"; register((e: { mouse: number }) => {});', 'VIOLATED', 2345);
check('destructuring alias', narrow, narrow, 'import { value } from "./target"; const { prop: alias } = value; const result: number = alias;', 'PRESERVED');
check('destructuring missing property', narrow, 'export declare const value: {};', 'import { value } from "./target"; const { prop: alias } = value;', 'VIOLATED', 2339);
check('surviving import cannot discharge broken call', 'export declare function fn(x: number): void;', 'export declare function fn(x: string): void;', 'import { fn } from "./target"; fn(1);', 'VIOLATED', 2345);
{
  const { repository, obligation } = fixture(narrow, narrow, 'import { value } from "./target"; const key: string = "prop";');
  obligation.reference!.isUnresolvedBoundary = true;
  obligation.reference!.boundaryTaxonomyReason = 'DYNAMIC_DESTRUCTURING';
  const result = TypeScriptContextualSpecializer.evaluateContextualSpecialization(obligation, repository);
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.evidence.unresolvedBoundary?.taxonomyCode, 'DYNAMIC_DESTRUCTURING');
}
console.log('Phase 3 sealed contextual compatibility passed.');
