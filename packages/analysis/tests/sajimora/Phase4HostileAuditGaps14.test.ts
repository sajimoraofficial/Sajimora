import * as assert from 'node:assert';
import * as ts from 'typescript';
import {
  ProofObligation,
  UsageSite,
  VerdictAuthority,
  CompleteProofEvidence,
  CrossVersionIdentityBundle,
  TypeRelationResult
} from '@sajimora/core';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';
import {  TypeScriptCompatibility } from '../../src/sajimora/compatibility/TypeScriptCompatibility';
import { LiveProgramSemanticProvider } from '../../src/sajimora/compatibility/LiveProgramSemanticProvider';
import { TypeScriptLanguageAdapter } from '../../src/sajimora/languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptTypeIRExtractor } from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIRExtractor';
import { GenericRelationEngine } from '../../src/sajimora/compatibility/GenericRelationEngine';
import {
  TypeScriptPolicy,
  TSR11TupleArrayRule,
  TSR12ObjectStructuralRule,
  TSR13CallableSubtypingRule
} from '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules';
import { AuthorityIntegrationLayer } from '../../src/sajimora/compatibility/AuthorityIntegrationLayer';
import { ProofTreeBuilder } from '../../src/sajimora/compatibility/ProofTreeBuilder';
import { WitnessGenerator } from '../../src/sajimora/compatibility/WitnessGenerator';
import {
  ObjectTypeIR,
  CallableTypeIR,
  PrimitiveTypeIR,
  TupleTypeIR,
  TypeScriptTypeIR
} from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR';

console.log('================================================================');
console.log('Sajimora Phase 4 — Hostile Audit 14 P1 Gaps Regression Suite');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

const strictPolicy: TypeScriptPolicy = {
  strictFunctionTypes: true,
  strictNullChecks: true
};

const adapter = new TypeScriptLanguageAdapter();
const engine = new GenericRelationEngine<TypeScriptTypeIR, TypeScriptPolicy>(adapter);

function prim(kind: PrimitiveTypeIR['primitiveKind']): PrimitiveTypeIR {
  return TypeScriptTypeIRExtractor.createPrimitiveIR(kind, 'PARENT');
}

// -----------------------------------------------------------------------------
// Finding 1: Anonymous recursion identity
// -----------------------------------------------------------------------------
test('P1 #1: Nested anonymous objects do not become false recursion backreferences', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(): { x: { y: string } } {
        return { x: { y: "hello" } };
      }
    `
  }, 'E:/vroot-p1-p');

  const cEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(): { x: { y: number } } {
        return { x: { y: 42 } };
      }
    `
  }, 'E:/vroot-p1-c');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const cSF = cProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;

  const pFunc = pSF.statements[0] as ts.FunctionDeclaration;
  const cFunc = cSF.statements[0] as ts.FunctionDeclaration;

  const pType = pProg.getTypeChecker().getTypeAtLocation(pFunc);
  const cType = cProg.getTypeChecker().getTypeAtLocation(cFunc);

  const pIR = TypeScriptTypeIRExtractor.extractFromType(pType, pProg.getTypeChecker(), 'PARENT', pSF);
  const cIR = TypeScriptTypeIRExtractor.extractFromType(cType, cProg.getTypeChecker(), 'CANDIDATE', cSF);

  // Return type must not be RECURSION_BACKREFERENCE
  const pRet = (pIR as CallableTypeIR).signatures[0].returnType as ObjectTypeIR;
  const cRet = (cIR as CallableTypeIR).signatures[0].returnType as ObjectTypeIR;

  assert.strictEqual(pRet.kind, 'OBJECT', 'Outer return type must be OBJECT');
  assert.strictEqual(cRet.kind, 'OBJECT', 'Outer return type must be OBJECT');

  const pXProp = pRet.properties.find(([k]) => k === 'x')?.[1];
  const cXProp = cRet.properties.find(([k]) => k === 'x')?.[1];

  assert.ok(pXProp, 'Property x must exist on parent');
  assert.ok(cXProp, 'Property x must exist on candidate');
  assert.strictEqual(pXProp!.type.kind, 'OBJECT', 'Inner property x must be an OBJECT, not RECURSION_BACKREFERENCE');
  assert.strictEqual(cXProp!.type.kind, 'OBJECT', 'Inner property x must be an OBJECT, not RECURSION_BACKREFERENCE');

  const pYProp = (pXProp!.type as ObjectTypeIR).properties.find(([k]) => k === 'y')?.[1];
  const cYProp = (cXProp!.type as ObjectTypeIR).properties.find(([k]) => k === 'y')?.[1];

  assert.ok(pYProp, 'Property y must be preserved on parent');
  assert.ok(cYProp, 'Property y must be preserved on candidate');
  assert.strictEqual((pYProp!.type as PrimitiveTypeIR).primitiveKind, 'string');
  assert.strictEqual((cYProp!.type as PrimitiveTypeIR).primitiveKind, 'number');

  // Evaluating candidate to parent return assignability must be INCOMPATIBLE
  const res = engine.evaluate(cRet, pRet, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(res.status, 'INCOMPATIBLE', 'Candidate {x:{y:number}} must not satisfy {x:{y:string}}');
});

// -----------------------------------------------------------------------------
// Finding 2: Overload resolution in declaration order
// -----------------------------------------------------------------------------
test('P1 #2: Overload resolution obeys TypeScript declaration order rather than heuristic scoring', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(x: "a", y: "b"): number { return 1; }
      export const r: number = f("a", "b");
    `
  }, 'E:/vroot-p2-p');

  const cEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(x: "a", y: string): string;
      export function f(x: "a", y: "b"): number;
      export function f(x: any, y: any): any { return null; }
    `
  }, 'E:/vroot-p2-c');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();
  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/index.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const compat = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const callExpr = (pSF.statements[1] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.CallExpression;

  const site: UsageSite = {
    usageSiteId: 'call-site-1',
    canonicalOccurrence: {
      occurrenceId: 'occ-1',
      referencedSymbol: 'f',
      declarationSymbol: 'f',
      sourceFile: `${pEnv.rootDir}/index.ts`,
      sourceSpan: { start: callExpr.getStart(), end: callExpr.getEnd(), line: 3, column: 32 },
      syntaxKind: ts.SyntaxKind.CallExpression,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  const result = compat.evaluateSite(site);
  // TypeScript declaration order chooses f(x:"a", y:string): string, returning string which cannot satisfy const r: number
  assert.strictEqual(result.status, 'INCOMPATIBLE', 'First matching overload f("a", string):string must be selected, causing return type incompatibility');
});

// -----------------------------------------------------------------------------
// Finding 3: Downstream read/write invariants & readonly enforcement
// -----------------------------------------------------------------------------
test('P1 #3: Downstream write branch requires return covariance and rejects readonly returns', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(): { x: string } { return { x: "a" }; }
      const r = f();
      const s: string = r.x;
      r.x = "b";
    `
  }, 'E:/vroot-p3-p');

  const cEnvWidened = createVirtualEnvironment({
    'index.ts': `
      export function f(): { x: string | number } { return { x: "a" }; }
    `
  }, 'E:/vroot-p3-cw');

  const cEnvReadonly = createVirtualEnvironment({
    'index.ts': `
      export function f(): { readonly x: string } { return { x: "a" }; }
    `
  }, 'E:/vroot-p3-cr');

  const pProg = pEnv.context.getProgram();
  const cProgWidened = cEnvWidened.context.getProgram();
  const cProgReadonly = cEnvReadonly.context.getProgram();

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const callExpr = (pSF.statements[1] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.CallExpression;

  const site: UsageSite = {
    usageSiteId: 'call-site-rw',
    canonicalOccurrence: {
      occurrenceId: 'occ-rw',
      referencedSymbol: 'f',
      declarationSymbol: 'f',
      sourceFile: `${pEnv.rootDir}/index.ts`,
      sourceSpan: { start: callExpr.getStart(), end: callExpr.getEnd(), line: 3, column: 17 },
      syntaxKind: ts.SyntaxKind.CallExpression,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/index.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  // Part A: Widened return { x: string | number } must fail return covariance
  const compatWidened = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProgWidened, obligation })
  });
  const resWidened = compatWidened.evaluateSite(site);
  assert.strictEqual(resWidened.status, 'INCOMPATIBLE', 'Widened return type {x: string|number} must fail return covariance when downstream read occurs');

  // Part B: Readonly return { readonly x: string } must reject downstream writes
  const compatReadonly = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProgReadonly, obligation })
  });
  const resReadonly = compatReadonly.evaluateSite(site);
  assert.strictEqual(resReadonly.status, 'INCOMPATIBLE', 'Readonly property in candidate return must be rejected for downstream write');
});

// -----------------------------------------------------------------------------
// Finding 4: Generic arity & specialization validation
// -----------------------------------------------------------------------------
test('P1 #4: Generic arity mismatch with explicit type arguments is rejected as INCOMPATIBLE', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f<T>(x: number): T { return null as any; }
      export const r = f<string>(1);
    `
  }, 'E:/vroot-p4-p');

  const cEnvNonGen = createVirtualEnvironment({
    'index.ts': `
      export function f(x: number): string { return ""; }
    `
  }, 'E:/vroot-p4-cn');

  const cEnvExtraGen = createVirtualEnvironment({
    'index.ts': `
      export function f<T, U>(x: number): T { return null as any; }
    `
  }, 'E:/vroot-p4-ce');

  const pProg = pEnv.context.getProgram();
  const cProgNonGen = cEnvNonGen.context.getProgram();
  const cProgExtraGen = cEnvExtraGen.context.getProgram();

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const callExpr = (pSF.statements[1] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.CallExpression;

  const site: UsageSite = {
    usageSiteId: 'call-site-gen',
    canonicalOccurrence: {
      occurrenceId: 'occ-gen',
      referencedSymbol: 'f',
      declarationSymbol: 'f',
      sourceFile: `${pEnv.rootDir}/index.ts`,
      sourceSpan: { start: callExpr.getStart(), end: callExpr.getEnd(), line: 3, column: 24 },
      syntaxKind: ts.SyntaxKind.CallExpression,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/index.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  // Part A: Calling non-generic candidate with explicit type argument
  const compatNonGen = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProgNonGen, obligation })
  });
  const resNonGen = compatNonGen.evaluateSite(site);
  assert.strictEqual(resNonGen.status, 'INCOMPATIBLE', 'Explicit type arguments to non-generic function must return INCOMPATIBLE (TS2558)');

  // Part B: Calling candidate requiring 2 type arguments with only 1
  const compatExtraGen = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProgExtraGen, obligation })
  });
  const resExtraGen = compatExtraGen.evaluateSite(site);
  assert.strictEqual(resExtraGen.status, 'INCOMPATIBLE', 'Too few explicit type arguments must return INCOMPATIBLE (TS2558)');
});

// -----------------------------------------------------------------------------
// Finding 5: Callback overload coverage
// -----------------------------------------------------------------------------
test('P1 #5: Callback subtyping discharges every required target overload', () => {
  // Source callback: (x: string) => number
  const srcCallable: CallableTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'CALLABLE',
    display: '(x: string) => number',
    irContentHash: 'hash-src-cb',
    signatures: [{
      declarationOrdinal: 0,
      parameters: [{ name: 'x', type: prim('string'), isRequired: true, isRest: false, isOptional: false }],
      returnType: prim('number')
    }],
    origin: { snapshot: 'PARENT', file: '' }
  };

  // Target callback requires overloads: {(x: string): number; (x: number): string}
  const tgtCallable: CallableTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'CALLABLE',
    display: '{(x: string): number; (x: number): string}',
    irContentHash: 'hash-tgt-cb',
    signatures: [
      {
        declarationOrdinal: 0,
        parameters: [{ name: 'x', type: prim('string'), isRequired: true, isRest: false, isOptional: false }],
        returnType: prim('number')
      },
      {
        declarationOrdinal: 1,
        parameters: [{ name: 'x', type: prim('number'), isRequired: true, isRest: false, isOptional: false }],
        returnType: prim('string')
      }
    ],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };

  const evalResult = engine.evaluate(srcCallable, tgtCallable, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(evalResult.status, 'INCOMPATIBLE', 'Callback failing second target overload must be rejected as INCOMPATIBLE');
});

// -----------------------------------------------------------------------------
// Finding 6: Optional properties satisfying required properties
// -----------------------------------------------------------------------------
test('P1 #6: Optional property in source does not satisfy required property in target', () => {
  const rule = new TSR12ObjectStructuralRule();

  // Source object: { x?: string }
  const srcObj: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{ x?: string }',
    irContentHash: 'hash-src-opt',
    properties: [
      ['x', { type: prim('string'), isOptional: true, isReadonly: false, visibility: 'public' }]
    ],
    origin: { snapshot: 'PARENT', file: '' }
  };

  // Target object requires x: { x: string | undefined }
  const tgtObj: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{ x: string | undefined }',
    irContentHash: 'hash-tgt-req',
    properties: [
      ['x', { type: prim('string'), isOptional: false, isReadonly: false, visibility: 'public' }]
    ],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };

  const res = rule.evaluate(srcObj, tgtObj, 'ASSIGNABLE_TO', strictPolicy, engine as any, {} as any);
  assert.strictEqual(res.status, 'INCOMPATIBLE', 'Optional property in source cannot satisfy required property in target (TS2345)');
  assert.ok((res.witness as any)?.failedRelation?.includes('optional in source'), 'Witness must specify optionality mismatch');
});

// -----------------------------------------------------------------------------
// Finding 7: Tuple shape and mutability
// -----------------------------------------------------------------------------
test('P1 #7: Tuple rule enforces cardinality and readonly mutability', () => {
  const rule = new TSR11TupleArrayRule();

  const numType = prim('number');
  const strType = prim('string');

  // Part A: Shape: [number, string] assigned to [number]
  const tuple2: TupleTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'TUPLE',
    display: '[number, string]',
    irContentHash: 'hash-tup-2',
    elements: [
      { type: numType, cardinality: 'REQUIRED' },
      { type: strType, cardinality: 'REQUIRED' }
    ],
    minLength: 2,
    hasRest: false,
    origin: { snapshot: 'PARENT', file: '' }
  };

  const tuple1: TupleTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'TUPLE',
    display: '[number]',
    irContentHash: 'hash-tup-1',
    elements: [
      { type: numType, cardinality: 'REQUIRED' }
    ],
    minLength: 1,
    hasRest: false,
    origin: { snapshot: 'CANDIDATE', file: '' }
  };

  const shapeRes = rule.evaluate(tuple2, tuple1, 'ASSIGNABLE_TO', strictPolicy, engine as any, {} as any);
  assert.strictEqual(shapeRes.status, 'INCOMPATIBLE', '[number, string] must not be assignable to [number]');

  // Part B: Mutability: readonly [number] assigned to mutable [number]
  const readonlyTuple: TupleTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'TUPLE',
    display: 'readonly [number]',
    irContentHash: 'hash-ro-tup',
    elements: [
      { type: numType, cardinality: 'REQUIRED' }
    ],
    minLength: 1,
    hasRest: false,
    isReadonly: true,
    origin: { snapshot: 'PARENT', file: '' }
  };

  const mutRes = rule.evaluate(readonlyTuple, tuple1, 'ASSIGNABLE_TO', strictPolicy, engine as any, {} as any);
  assert.strictEqual(mutRes.status, 'INCOMPATIBLE', 'readonly [number] cannot be assigned to mutable [number]');
});

// -----------------------------------------------------------------------------
// Finding 8: Nominal origins qualified enclosing scope
// -----------------------------------------------------------------------------
test('P1 #8: Same-named classes in different namespaces have distinct qualified nominal origins', () => {
  const env = createVirtualEnvironment({
    'scopes.ts': `
      export namespace A {
        export class X {
          private x: number = 1;
        }
      }
      export namespace B {
        export class X {
          private x: number = 2;
        }
      }
    `
  }, 'E:/vroot-p8');

  const prog = env.context.getProgram();
  const sf = prog.getSourceFiles().find(f => f.fileName.includes('scopes.ts'))!;
  const checker = prog.getTypeChecker();

  const nsA = sf.statements[0] as ts.ModuleDeclaration;
  const nsB = sf.statements[1] as ts.ModuleDeclaration;

  const classA = (nsA.body as ts.ModuleBlock).statements[0] as ts.ClassDeclaration;
  const classB = (nsB.body as ts.ModuleBlock).statements[0] as ts.ClassDeclaration;

  const typeA = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(classA.name!)!);
  const typeB = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(classB.name!)!);

  const irA = TypeScriptTypeIRExtractor.extractFromType(typeA, checker, 'PARENT', sf) as ObjectTypeIR;
  const irB = TypeScriptTypeIRExtractor.extractFromType(typeB, checker, 'CANDIDATE', sf) as ObjectTypeIR;

  assert.ok(irA.nominalOrigins, 'irA must have nominal origins');
  assert.ok(irB.nominalOrigins, 'irB must have nominal origins');

  assert.ok(irA.nominalOrigins.some(o => o.includes('#A.X')), `Origin A must include #A.X, got: ${irA.nominalOrigins}`);
  assert.ok(irB.nominalOrigins.some(o => o.includes('#B.X')), `Origin B must include #B.X, got: ${irB.nominalOrigins}`);
  assert.notStrictEqual(irA.nominalOrigins[0], irB.nominalOrigins[0], 'A.X and B.X must not share the same nominal origin');

  const compRes = engine.evaluate(irA, irB, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(compRes.status, 'INCOMPATIBLE', 'A.X and B.X with private members must be mutually incompatible');
});

// -----------------------------------------------------------------------------
// Finding 9: Callability & overload failure handling preserves UNDECIDABLE
// -----------------------------------------------------------------------------
test('P1 #9: Candidate with any type produces UNDECIDABLE rather than INCOMPATIBLE', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(): void {}
      f();
    `
  }, 'E:/vroot-p9-p');

  const cEnv = createVirtualEnvironment({
    'index.ts': `
      export declare const f: any;
    `
  }, 'E:/vroot-p9-c');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const callExpr = (pSF.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression;

  const site: UsageSite = {
    usageSiteId: 'call-site-any',
    canonicalOccurrence: {
      occurrenceId: 'occ-any',
      referencedSymbol: 'f',
      declarationSymbol: 'f',
      sourceFile: `${pEnv.rootDir}/index.ts`,
      sourceSpan: { start: callExpr.getStart(), end: callExpr.getEnd(), line: 3, column: 7 },
      syntaxKind: ts.SyntaxKind.CallExpression,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/index.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');
  const compat = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const res = compat.evaluateSite(site);
  assert.strictEqual(res.status, 'UNDECIDABLE', 'Candidate declaration with type any must yield UNDECIDABLE, not proven INCOMPATIBLE');
  assert.strictEqual(res.reason, 'ANY_DEPENDENCY_TARGET');
});

// -----------------------------------------------------------------------------
// Finding 10: PipelineB identity/coverage gate
// -----------------------------------------------------------------------------
test('P1 #10: PipelineB rejects incomplete identity bundle with UNKNOWN preflight', () => {
  const target = createMockSymbolRef('targetSymbol', 'FUNCTION', 'E:/vroot/index.ts');
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const incompleteBundle: CrossVersionIdentityBundle = {
    targetMappings: [],
    consumerMappings: [],
    status: 'INCOMPLETE',
    blockers: ['PARENT_DISCOVERY_FAILED'],
    phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
    boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
  };

  const pipeline = new PipelineB();
  const verdict = pipeline.execute(obligation, {
    isPhase4Mode: true,
    crossVersionIdentity: incompleteBundle
  });

  assert.strictEqual(verdict.verdict, 'UNKNOWN', 'Incomplete identity bundle must fail closed to UNKNOWN');
  assert.strictEqual(verdict.auditTrace?.authorityDecision?.gate, 'COVERAGE');
});

// -----------------------------------------------------------------------------
// Finding 11: PipelineB lifecycle reconciliation
// -----------------------------------------------------------------------------
test('P1 #11: Mapped consumer from old-u to u is reconciled and not double-counted as omitted', () => {
  const target = createMockSymbolRef('f', 'FUNCTION', 'E:/vroot/index.ts');
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const completeClosure = {
    closureName: 'ValueReferenceClosure' as const,
    completeness: 'COMPLETE' as const,
    occurrences: [],
    failures: [],
    ambiguities: [],
    unrecognizedForms: [],
    provenance: []
  };

  const evidence: CompleteProofEvidence<any> = {
    triggerData: null,
    obligation,
    analysisUniverse: {
      discoveryStatus: 'DISCOVERY_COMPLETE',
      parseFailures: new Map(),
      unreadableFiles: [],
      excludedFiles: new Map(),
      modules: []
    } as any,
    closures: {
      valueReference: completeClosure,
      typeReference: completeClosure,
      inheritance: completeClosure,
      interfaceImpl: completeClosure,
      override: completeClosure,
      reExport: completeClosure,
      ambientReference: completeClosure
    },
    canonicalOccurrences: [{
      usageSiteId: 'u',
      canonicalOccurrence: {
        occurrenceId: 'u',
        referencedSymbol: 'f',
        declarationSymbol: 'f',
        sourceFile: '/src/consumer.ts',
        sourceSpan: { start: 10, end: 20, line: 2, column: 5 },
        syntaxKind: ts.SyntaxKind.CallExpression,
        semanticRole: 'VALUE',
        usageRole: 'CALL_SITE',
        resolutionStatus: 'RESOLVED',
        provenanceTrace: []
      } as any,
      existenceAtParent: 'PRESENT',
      mutationStatus: 'CHANGED',
      bindingPresenceAtCandidate: 'PRESENT',
      bindingState: 'BOUND',
      evaluationStatus: 'EVALUABLE',
      identityResult: 'SAME',
      enumerationInconsistencyCause: null,
      provenance: 'UNCHANGED'
    }],
    identityResults: [],
    compatibilityResults: new Map([
      ['u', {
        status: 'COMPATIBLE',
        reason: null,
        phase4Evidence: {
          schemaVersion: 'SAJIMORA_PROOF_TREE_V1',
          proofTree: {
            nodeId: 'tree-u',
            relation: 'PARAMETER_ACCEPTS_ARGUMENT',
            rule: 'TEST_RULE',
            adapterId: 'typescript',
            adapterVersion: '1.0.0',
            status: 'COMPATIBLE',
            premises: [],
            dischargedObligations: [],
            children: [],
            source: prim('void'),
            target: prim('void'),
            effectivePolicy: strictPolicy as any,
            sourceTypeHash: 'h-v',
            targetTypeHash: 'h-v',
            contentHash: 'h-proof-u'
          }
        } as any
      }]
    ]),
    semanticScope: {
      unsupportedRelationshipPossible: false
    } as any
  };

  // Reconcile with mapping from old-u to u
  const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(evidence, {
    isPhase4Mode: true,
    discoveredHistoricalConsumerIds: ['old-u'],
    mappedHistoricalConsumerIds: new Map([['old-u', 'u']])
  });

  // Since old-u maps to u, no synthetic omitted historical consumer should be created
  assert.strictEqual(reconciled.canonicalOccurrences.length, 1, 'Mapped old-u must not be duplicated as an omitted consumer');
  assert.strictEqual(reconciled.canonicalOccurrences[0].usageSiteId, 'u');

  const verdict = VerdictAuthority.evaluateProof(reconciled);
  assert.strictEqual(verdict.verdict, 'PRESERVED', 'Reconciled consumer should authorize PRESERVED');
});

// -----------------------------------------------------------------------------
// Finding 12: Candidate declaration fallback
// -----------------------------------------------------------------------------
test('P1 #12: Candidate declaration fallback matches top-level only and ignores nested same-named symbols', () => {
  const pEnv = createVirtualEnvironment({
    'index.ts': `
      export function f(x: number): void {}
      f(1);
    `
  }, 'E:/vroot-p12-p');

  const cEnv = createVirtualEnvironment({
    'index.ts': `
      export namespace Other {
        export function f(x: number): void {}
      }
      export const f = 42;
    `
  }, 'E:/vroot-p12-c');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFiles().find(sf => sf.fileName.includes('index.ts'))!;
  const callExpr = (pSF.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression;

  const site: UsageSite = {
    usageSiteId: 'call-site-fallback',
    canonicalOccurrence: {
      occurrenceId: 'occ-fallback',
      referencedSymbol: 'f',
      declarationSymbol: 'f',
      sourceFile: `${pEnv.rootDir}/index.ts`,
      sourceSpan: { start: callExpr.getStart(), end: callExpr.getEnd(), line: 3, column: 7 },
      syntaxKind: ts.SyntaxKind.CallExpression,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/index.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');
  (obligation.mutatedSymbol as any).declarationLocation = { filePath: `${cEnv.rootDir}/index.ts` };

  const compat = new TypeScriptCompatibility({} as any, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const res = compat.evaluateSite(site);
  // Must NOT match Other.f! Candidate top-level f is 42 (non-callable)
  assert.strictEqual(res.status, 'INCOMPATIBLE', 'Fallback must match top-level const f = 42, rejecting call as non-callable');
});

// -----------------------------------------------------------------------------
// Finding 13: AuthorityIntegrationLayer rejects contradictory proof status
// -----------------------------------------------------------------------------
test('P1 #13: Outer COMPATIBLE with INCOMPATIBLE proof tree is rejected and demoted to UNDECIDABLE', () => {
  const target = createMockSymbolRef('f', 'FUNCTION', 'E:/vroot/index.ts');
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const incompProofTree: any = {
    nodeId: 'tree-incomp',
    relation: 'PARAMETER_ACCEPTS_ARGUMENT',
    rule: 'CALLABILITY_CHECK',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    status: 'INCOMPATIBLE',
    premises: [],
    dischargedObligations: [],
    children: [],
    source: prim('number'),
    target: prim('void'),
    effectivePolicy: strictPolicy as any,
    sourceTypeHash: 'h-num',
    targetTypeHash: 'h-void',
    contentHash: 'h-proof-incomp',
    witness: WitnessGenerator.createWitness({
      consumerLocation: { file: '', line: 1, column: 1 },
      targetDeclaration: { file: '', line: 1, column: 1 },
      semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
      position: { kind: 'ROOT' },
      parentType: { display: 'void' },
      candidateType: { display: 'number' },
      failedRelation: 'Not callable',
      ruleId: 'CALLABILITY_CHECK'
    })
  };

  const evidence: CompleteProofEvidence<any> = {
    triggerData: null,
    obligation,
    analysisUniverse: { discoveryStatus: 'COMPLETE', modules: [] } as any,
    closures: {
      valueReference: [] as any,
      typeReference: [] as any,
      inheritance: [] as any,
      interfaceImpl: [] as any,
      override: [] as any,
      reExport: [] as any,
      ambientReference: [] as any
    },
    canonicalOccurrences: [{
      usageSiteId: 'site-contra',
      canonicalOccurrence: {
        occurrenceId: 'occ-contra',
        referencedSymbol: 'f',
        declarationSymbol: 'f',
        sourceFile: '/src/index.ts',
        sourceSpan: { start: 0, end: 10, line: 1, column: 1 },
        syntaxKind: ts.SyntaxKind.CallExpression,
        semanticRole: 'VALUE',
        usageRole: 'CALL_SITE',
        resolutionStatus: 'RESOLVED',
        provenanceTrace: []
      } as any,
      existenceAtParent: 'PRESENT',
      mutationStatus: 'UNCHANGED',
      bindingPresenceAtCandidate: 'PRESENT',
      bindingState: 'BOUND',
      evaluationStatus: 'EVALUABLE',
      identityResult: 'SAME',
      enumerationInconsistencyCause: null,
      provenance: 'UNCHANGED'
    }],
    identityResults: [],
    compatibilityResults: new Map([
      // Contradictory: outer status COMPATIBLE but inner proof tree is INCOMPATIBLE
      ['site-contra', {
        status: 'COMPATIBLE',
        reason: null,
        phase4Evidence: {
          schemaVersion: 'SAJIMORA_PROOF_TREE_V1',
          proofTree: incompProofTree
        } as any
      }]
    ]),
    semanticScope: {
      unsupportedRelationshipPossible: false
    } as any
  };

  const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(evidence, {
    isPhase4Mode: true
  });

  const reconciledResult = reconciled.compatibilityResults.get('site-contra');
  assert.strictEqual(reconciledResult?.status, 'UNDECIDABLE', 'Contradictory proof must be demoted to UNDECIDABLE');
  assert.strictEqual(reconciledResult?.reason, 'CONTRADICTORY_PROOF_STATUS');

  const verdict = VerdictAuthority.evaluateProof(reconciled);
  assert.notStrictEqual(verdict.verdict, 'PRESERVED', 'Contradictory proof must never authorize PRESERVED');
});

// -----------------------------------------------------------------------------
// Finding 14: Snapshot-independent canonical hashing
// -----------------------------------------------------------------------------
test('P1 #14: Type IR content hashes and nominal origins are independent of checkout path', () => {
  const classCode = `
    export class A {
      private secret: number = 42;
      public name: string = "hello";
    }
  `;

  const env1 = createVirtualEnvironment({
    'src/a.ts': classCode
  }, 'E:/checkout-one');

  const env2 = createVirtualEnvironment({
    'src/a.ts': classCode
  }, 'E:/checkout-two');

  const prog1 = env1.context.getProgram();
  const prog2 = env2.context.getProgram();

  const sf1 = prog1.getSourceFiles().find(sf => sf.fileName.includes('src/a.ts'))!;
  const sf2 = prog2.getSourceFiles().find(sf => sf.fileName.includes('src/a.ts'))!;

  const classDecl1 = sf1.statements[0] as ts.ClassDeclaration;
  const classDecl2 = sf2.statements[0] as ts.ClassDeclaration;

  const ir1 = TypeScriptTypeIRExtractor.extractFromNode(classDecl1, prog1.getTypeChecker(), 'PARENT', {
    snapshotRoot: 'E:/checkout-one'
  }) as ObjectTypeIR;

  const ir2 = TypeScriptTypeIRExtractor.extractFromNode(classDecl2, prog2.getTypeChecker(), 'CANDIDATE', {
    snapshotRoot: 'E:/checkout-two'
  }) as ObjectTypeIR;

  assert.strictEqual(ir1.nominalOrigins?.[0], 'decl:src/a.ts#A', 'Nominal origin 1 must be repo-relative');
  assert.strictEqual(ir2.nominalOrigins?.[0], 'decl:src/a.ts#A', 'Nominal origin 2 must be repo-relative');
  assert.strictEqual(ir1.irContentHash, ir2.irContentHash, 'Type IR hashes must be strictly identical across different checkout locations');
});

console.log('\n================================================================');
console.log(`Phase 4 Hostile Audit 14 Gaps: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
