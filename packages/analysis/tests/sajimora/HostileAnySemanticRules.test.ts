import * as assert from 'node:assert';
import * as ts from 'typescript';
import {
  RelationKind,
  RelationStatus,
  UsageRole,
  UsageSite,
  ProofObligation,
  CompleteProofEvidence,
  VerdictAuthority
} from '@sajimora/core';
import { GenericRelationEngine } from '../../src/sajimora/compatibility/GenericRelationEngine';
import { TypeScriptLanguageAdapter } from '../../src/sajimora/languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptPolicy } from '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules';
import {
  TypeScriptTypeIR,
  PrimitiveTypeIR,
  containsAny,
  containsUnsupported,
  containsUserAuthoredAny,
  containsGenericArgumentAny,
  containsDirectObservableAny,
  hasSemanticAnyDependency
} from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIRExtractor';

console.log('================================================================');
console.log('Sajimora Phase 4 — Hostile Any Semantic Rules & Provenance Suite');
console.log('================================================================\n');

const adapter = new TypeScriptLanguageAdapter();
const strictPolicy: TypeScriptPolicy = {
  strictFunctionTypes: true,
  strictNullChecks: true
};
const engine = new GenericRelationEngine<TypeScriptTypeIR, TypeScriptPolicy>(adapter);

function extractSnippet(code: string, symbolName: string, fileName = '/virtual/test.ts') {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, target) => {
    if (name === fileName) {
      return ts.createSourceFile(fileName, code, target, true);
    }
    return originalGetSourceFile(name, target);
  };
  const program = ts.createProgram([fileName], compilerOptions, host);
  const tc = program.getTypeChecker();
  const sf = program.getSourceFile(fileName)!;

  let targetNode: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.name.getText() === symbolName) targetNode = d;
      }
    } else if (ts.isFunctionDeclaration(node) && node.name?.getText() === symbolName) {
      targetNode = node;
    } else if (ts.isTypeAliasDeclaration(node) && node.name.getText() === symbolName) {
      targetNode = node;
    }
    if (!targetNode) ts.forEachChild(node, visit);
  }
  visit(sf);

  if (!targetNode) {
    throw new Error(`Symbol ${symbolName} not found in test snippet`);
  }

  const irParent = TypeScriptTypeIRExtractor.extractFromNode(targetNode, tc, 'PARENT', { program, maxNodes: 50000 });
  const irCandidate = TypeScriptTypeIRExtractor.extractFromNode(targetNode, tc, 'CANDIDATE', { program, maxNodes: 50000 });
  return { irParent, irCandidate, program, tc };
}

let passed = 0;
let failed = 0;

function runCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// Case 1: Unchanged ambient Set<string> -> COMPATIBLE
runCase('Case 1: Unchanged ambient Set<string> is proven COMPATIBLE under TSR0', () => {
  const { irParent, irCandidate } = extractSnippet('const s: Set<string> = new Set();', 's');
  assert.strictEqual(containsAny(irParent), true, 'Set<string> must contain ambient any');
  assert.strictEqual(containsUserAuthoredAny(irParent), false, 'Set<string> must not contain user-authored any');
  assert.strictEqual(containsGenericArgumentAny(irParent), false, 'Set<string> must not contain generic argument any');
  assert.strictEqual(containsDirectObservableAny(irParent), false, 'Set<string> must not contain direct observable any');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), false, 'Unchanged Set<string> must not have semantic any dependency');

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE', 'Set<string> must be COMPATIBLE');
  assert.strictEqual(result.rule, 'TS_R0_CANONICAL_EQUALITY', 'Must be discharged by TSR0');
});

// Case 2: Unchanged ambient RegExp -> COMPATIBLE
runCase('Case 2: Unchanged ambient RegExp is proven COMPATIBLE under TSR0', () => {
  const { irParent, irCandidate } = extractSnippet('const r: RegExp = /abc/;', 'r');
  assert.strictEqual(containsAny(irParent), true, 'RegExp must contain ambient any (from RegExpExecArray/Array iterators)');
  assert.strictEqual(containsUserAuthoredAny(irParent), false, 'RegExp must not contain user-authored any');

  assert.strictEqual(containsGenericArgumentAny(irParent), false, 'RegExp must not contain generic argument any');
  assert.strictEqual(containsDirectObservableAny(irParent), false, 'RegExp must not contain direct observable any');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), false, 'Unchanged RegExp must not have semantic any dependency');

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE', 'RegExp must be COMPATIBLE');
  assert.strictEqual(result.rule, 'TS_R0_CANONICAL_EQUALITY', 'Must be discharged by TSR0');
});

// Case 3: Set<any> generic argument -> UNDECIDABLE
runCase('Case 3: Set<any> with user-supplied generic argument any fails closed as UNDECIDABLE', () => {
  const { irParent, irCandidate } = extractSnippet('const s: Set<any> = new Set();', 's');
  assert.strictEqual(containsGenericArgumentAny(irParent), true, 'Set<any> must trigger containsGenericArgumentAny');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true, 'Set<any> must have semantic any dependency');

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE', 'Set<any> must be UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY', 'Must be caught by TSR3');
});

// Case 4: Return widening () => string -> () => any -> UNDECIDABLE
runCase('Case 4: Return widening () => string to () => any fails closed as UNDECIDABLE', () => {
  const { irParent } = extractSnippet('function f(): string { return "ok"; }', 'f');
  const { irCandidate } = extractSnippet('function f(): any { return "ok"; }', 'f');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 5: Parameter widening (x: string) => void -> (x: any) => void -> UNDECIDABLE
runCase('Case 5: Parameter widening (x: string) => void to (x: any) => void fails closed as UNDECIDABLE', () => {
  const { irParent } = extractSnippet('function f(x: string): void {}', 'f');
  const { irCandidate } = extractSnippet('function f(x: any): void {}', 'f');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 6: Object property { debug: string } -> { debug: any } -> UNDECIDABLE
runCase('Case 6: Object property { debug: string } to { debug: any } fails closed as UNDECIDABLE', () => {
  const { irParent } = extractSnippet('const obj: { debug: string } = { debug: "yes" };', 'obj');
  const { irCandidate } = extractSnippet('const obj: { debug: any } = { debug: 123 };', 'obj');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 7: Identical user-authored { debug: any } -> UNDECIDABLE (INVARIANT: MUST NOT BECOME PRESERVED)
runCase('Case 7: Identical user-authored { debug: any } remains fail-closed as UNDECIDABLE', () => {
  const { irParent, irCandidate } = extractSnippet('const obj: { debug: any } = { debug: 123 };', 'obj');
  assert.strictEqual(irParent.irContentHash, irCandidate.irContentHash, 'Hashes match identically');
  assert.strictEqual(containsUserAuthoredAny(irParent), true, 'Must detect user-authored any');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true, 'Must have semantic any dependency');

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE', 'User-authored any must NEVER evaluate to COMPATIBLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 8: User-authored function with optional thisArg?: any -> UNDECIDABLE
runCase('Case 8: User-authored function with optional thisArg?: any remains fail-closed as UNDECIDABLE', () => {
  const { irParent, irCandidate } = extractSnippet('function myFunc(cb: () => void, thisArg?: any): void {}', 'myFunc');
  assert.strictEqual(containsUserAuthoredAny(irParent), true, 'Must detect user-authored provenance on thisArg');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE', 'User-authored thisArg?: any must NOT be exempted');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 9: Ambient library function returning any -> UNDECIDABLE
runCase('Case 9: Ambient function returning any is directly observable and fails closed as UNDECIDABLE', () => {
  const { irParent, irCandidate } = extractSnippet('const parse: (text: string) => any = JSON.parse;', 'parse');
  assert.strictEqual(containsDirectObservableAny(irParent), true, 'Return any is directly observable');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

// Case 10: Ambient library function with primary parameter any -> UNDECIDABLE
runCase('Case 10: Ambient function with primary parameter any fails closed as UNDECIDABLE', () => {
  const { irParent, irCandidate } = extractSnippet('const log: (msg: any) => void = (m) => {};', 'log');
  assert.strictEqual(containsDirectObservableAny(irParent), true, 'Primary param any is directly observable');
  assert.strictEqual(hasSemanticAnyDependency(irParent, irCandidate), true);

  const result = engine.evaluate(irParent, irCandidate, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.rule, 'TS_R3_ANY_DEPENDENCY');
});

console.log('\n================================================================');
console.log(`Hostile Any Semantic Rules: ${passed} passed, ${failed} failed`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
