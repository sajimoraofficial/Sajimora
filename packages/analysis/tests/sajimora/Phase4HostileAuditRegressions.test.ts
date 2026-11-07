import * as assert from 'node:assert';
import * as ts from 'typescript';
import {
  ProofObligation,
  UsageSite,
  VerdictAuthority,
  CompleteProofEvidence
} from '@sajimora/core';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { ConsumerDiscoveryCoordinator } from '../../src/sajimora/closures/ConsumerDiscoveryCoordinator';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';
import {  TypeScriptCompatibility } from '../../src/sajimora/compatibility/TypeScriptCompatibility';
import { LiveProgramSemanticProvider } from '../../src/sajimora/compatibility/LiveProgramSemanticProvider';
import { TypeScriptLanguageAdapter } from '../../src/sajimora/languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptTypeIRExtractor } from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIRExtractor';
import { GenericRelationEngine } from '../../src/sajimora/compatibility/GenericRelationEngine';
import {
  TypeScriptPolicy,
  TSR12ObjectStructuralRule,
  TSR13CallableSubtypingRule,
  TSR15RecursionBackreferenceRule
} from '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules';
import { AuthorityIntegrationLayer } from '../../src/sajimora/compatibility/AuthorityIntegrationLayer';
import {
  ObjectTypeIR,
  CallableTypeIR,
  PrimitiveTypeIR,
  TypeScriptTypeIR
} from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR';

console.log('================================================================');
console.log('Sajimora Phase 4 — Hostile Audit 13 P1 Regressions Suite');
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

function makeObligation(id: string, name: string): ProofObligation {
  return {
    invariantId: id,
    relation: 'INTERFACE_PRESERVATION',
    mutatedSymbol: {
      persistentSymbolId: `decl:src/provider.ts#${name}`,
      fingerprint: {
        value: `fp-${name}`,
        components: {
          globallyQualifiedOwner: `src/provider.ts::${name}`,
          symbolLocalName: name,
          kind: 'FUNCTION',
          parameterTypeFingerprint: '()'
        }
      },
      qualifiedName: `src/provider.ts#${name}`,
      kind: 'FUNCTION',
      ownerId: null,
      declarationLocation: { filePath: 'src/provider.ts', line: 1 }
    },
    providerMutation: {
      targetSymbolId: `decl:src/provider.ts#${name}`,
      beforeExists: true,
      afterExists: true,
      classification: 'EXPORTED_SIGNATURE_MUTATED',
      isAstDiffDerived: true,
      beforeParsed: true,
      afterParsed: true
    }
  };
}

// -----------------------------------------------------------------------------
// Finding 1: Non-callable candidates receive successful call proofs
// -----------------------------------------------------------------------------
test('P1 #1: Non-callable candidates reject historical call sites with CALLABILITY_CHECK witness', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export declare function f(): void;',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-p1');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export const f = 42;',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-p1');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const obligation = makeObligation('obl-1', 'f');

  const compat = new TypeScriptCompatibility(parentEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation })
  });

  const consumerSf = parentProg.getSourceFile('E:/vroot-p1/src/consumer.ts')!;
  let callNode: ts.Node | undefined;
  const findCall = (n: ts.Node) => {
    if (ts.isCallExpression(n)) { callNode = n; return; }
    ts.forEachChild(n, findCall);
  };
  findCall(consumerSf);
  assert.ok(callNode, 'callNode must exist');

  const site: UsageSite = {
    usageSiteId: 'occ-call-1',
    canonicalOccurrence: {
      occurrenceId: 'occ-call-1',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: callNode.getStart(), end: callNode.getEnd(), line: 1, column: 33 },
      syntaxKind: callNode.kind,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/provider.ts#f',
      declarationSymbol: 'decl:src/provider.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
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
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'CALLABILITY_CHECK', 'Witness must be CALLABILITY_CHECK');
});

// -----------------------------------------------------------------------------
// Finding 2: The wrong overload proves compatibility
// -----------------------------------------------------------------------------
test('P1 #2: Overload resolution selects the candidate overload matching historical arguments', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: string): number { return 1; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r: number = f("a");'
  }, 'E:/vroot-p2');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: "a"): string; export function f(x: string): number; export function f(x: any): any { return "a"; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r: number = f("a");'
  }, 'E:/vroot-p2');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const obligation = makeObligation('obl-2', 'f');

  const compat = new TypeScriptCompatibility(parentEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation })
  });

  const consumerSf = parentProg.getSourceFile('E:/vroot-p2/src/consumer.ts')!;
  let callNode: ts.Node | undefined;
  const findCall = (n: ts.Node) => {
    if (ts.isCallExpression(n)) { callNode = n; return; }
    ts.forEachChild(n, findCall);
  };
  findCall(consumerSf);

  const site: UsageSite = {
    usageSiteId: 'occ-call-2',
    canonicalOccurrence: {
      occurrenceId: 'occ-call-2',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: callNode!.getStart(), end: callNode!.getEnd(), line: 1, column: 50 },
      syntaxKind: callNode!.kind,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/provider.ts#f',
      declarationSymbol: 'decl:src/provider.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
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
  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Selected overload returns string which is incompatible with number context');
});

// -----------------------------------------------------------------------------
// Finding 3: Excess arguments are silently accepted
// -----------------------------------------------------------------------------
test('P1 #3: Excess arguments without rest parameter are rejected as INCOMPATIBLE', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number, y: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(1, 2);'
  }, 'E:/vroot-p3');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(1, 2);'
  }, 'E:/vroot-p3');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const obligation = makeObligation('obl-3', 'f');

  const compat = new TypeScriptCompatibility(parentEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation })
  });

  const consumerSf = parentProg.getSourceFile('E:/vroot-p3/src/consumer.ts')!;
  let callNode: ts.Node | undefined;
  const findCall = (n: ts.Node) => {
    if (ts.isCallExpression(n)) { callNode = n; return; }
    ts.forEachChild(n, findCall);
  };
  findCall(consumerSf);

  const site: UsageSite = {
    usageSiteId: 'occ-call-3',
    canonicalOccurrence: {
      occurrenceId: 'occ-call-3',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: callNode!.getStart(), end: callNode!.getEnd(), line: 1, column: 33 },
      syntaxKind: callNode!.kind,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/provider.ts#f',
      declarationSymbol: 'decl:src/provider.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
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
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'EXCESS_ARGUMENTS_CHECK', 'Must have EXCESS_ARGUMENTS_CHECK witness');
});

// -----------------------------------------------------------------------------
// Finding 4: Invalid explicit generic constraints are accepted
// -----------------------------------------------------------------------------
test('P1 #4: Explicit generic argument violating candidate constraint is rejected', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f<T>(x: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f<string>(1);'
  }, 'E:/vroot-p4');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f<T extends number>(x: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f<string>(1);'
  }, 'E:/vroot-p4');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const obligation = makeObligation('obl-4', 'f');

  const compat = new TypeScriptCompatibility(parentEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation })
  });

  const consumerSf = parentProg.getSourceFile('E:/vroot-p4/src/consumer.ts')!;
  let callNode: ts.Node | undefined;
  const findCall = (n: ts.Node) => {
    if (ts.isCallExpression(n)) { callNode = n; return; }
    ts.forEachChild(n, findCall);
  };
  findCall(consumerSf);

  const site: UsageSite = {
    usageSiteId: 'occ-call-4',
    canonicalOccurrence: {
      occurrenceId: 'occ-call-4',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: callNode!.getStart(), end: callNode!.getEnd(), line: 1, column: 33 },
      syntaxKind: callNode!.kind,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/provider.ts#f',
      declarationSymbol: 'decl:src/provider.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
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
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'GENERIC_CONSTRAINT_CHECK', 'Must have GENERIC_CONSTRAINT_CHECK witness');
});

// -----------------------------------------------------------------------------
// Finding 5: Unsafe inferred-result writes pass
// -----------------------------------------------------------------------------
test('P1 #5: Inferred return variable with downstream write fails candidate narrowing', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { x: string | number } { return { x: "a" }; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); r.x = 1;'
  }, 'E:/vroot-p5');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { x: string } { return { x: "a" }; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); r.x = 1;'
  }, 'E:/vroot-p5');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const obligation = makeObligation('obl-5', 'f');

  const compat = new TypeScriptCompatibility(parentEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation })
  });

  const consumerSf = parentProg.getSourceFile('E:/vroot-p5/src/consumer.ts')!;
  let callNode: ts.Node | undefined;
  const findCall = (n: ts.Node) => {
    if (ts.isCallExpression(n)) { callNode = n; return; }
    ts.forEachChild(n, findCall);
  };
  findCall(consumerSf);

  const site: UsageSite = {
    usageSiteId: 'occ-call-5',
    canonicalOccurrence: {
      occurrenceId: 'occ-call-5',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: callNode!.getStart(), end: callNode!.getEnd(), line: 1, column: 43 },
      syntaxKind: callNode!.kind,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/provider.ts#f',
      declarationSymbol: 'decl:src/provider.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
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
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'DOWNSTREAM_RETURN_WRITE_CHECK', 'Must have DOWNSTREAM_RETURN_WRITE_CHECK witness');
});

// -----------------------------------------------------------------------------
// Finding 6: Required structural capabilities (index, construct, call)
// -----------------------------------------------------------------------------
test('P1 #6: Structural rule decomposes and enforces index, construct, and call signatures', () => {
  const rule = new TSR12ObjectStructuralRule();

  // 6a: Target requires index signature {[k: string]: number}, source { x: string } has incompatible property value
  const srcObjWithStr: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{ x: string }',
    irContentHash: 'hash-str',
    properties: [['x', { type: prim('string'), isReadonly: false, isOptional: false, visibility: 'public' }]],
    origin: { snapshot: 'PARENT', file: '' }
  };
  const tgtObjWithIndex: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{ [k: string]: number }',
    irContentHash: 'hash-idx',
    properties: [],
    indexSignatures: [{ keyType: 'string', valueType: prim('number'), isReadonly: false }],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };
  const idxResult = engine.evaluate(srcObjWithStr, tgtObjWithIndex, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(idxResult.status, 'INCOMPATIBLE', 'Index signature must reject string property against number index');

  // 6b: Target requires construct signature { new(): { x: number } }, source {} has no construct signatures
  const emptyObj: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{}',
    irContentHash: 'hash-empty',
    properties: [],
    origin: { snapshot: 'PARENT', file: '' }
  };
  const tgtWithCtor: ObjectTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    display: '{ new(): { x: number } }',
    irContentHash: 'hash-ctor',
    properties: [],
    constructSignatures: [{
      declarationOrdinal: 0,
      parameters: [],
      returnType: srcObjWithStr
    }],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };
  const ctorResult = engine.evaluate(emptyObj, tgtWithCtor, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(ctorResult.status, 'INCOMPATIBLE', 'Construct signature missing in source must be rejected');
});

// -----------------------------------------------------------------------------
// Finding 7: Callbacks requiring missing arguments accepted
// -----------------------------------------------------------------------------
test('P1 #7: Callable subtyping rule enforces parameter arity requirements', () => {
  const rule = new TSR13CallableSubtypingRule();

  // Source: (x: number, y: number) => void (requires 2 args)
  // Target: (x: number) => void (consumer supplies only 1 arg)
  const srcCallable: CallableTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'CALLABLE',
    display: '(x: number, y: number) => void',
    irContentHash: 'hash-call-2',
    signatures: [{
      declarationOrdinal: 0,
      parameters: [
        { name: 'x', type: prim('number'), isRequired: true, isRest: false, isOptional: false },
        { name: 'y', type: prim('number'), isRequired: true, isRest: false, isOptional: false }
      ],
      returnType: prim('void')
    }],
    origin: { snapshot: 'PARENT', file: '' }
  };

  const tgtCallable: CallableTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'CALLABLE',
    display: '(x: number) => void',
    irContentHash: 'hash-call-1',
    signatures: [{
      declarationOrdinal: 0,
      parameters: [
        { name: 'x', type: prim('number'), isRequired: true, isRest: false, isOptional: false }
      ],
      returnType: prim('void')
    }],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };

  const res = rule.evaluate(srcCallable, tgtCallable, 'ASSIGNABLE_TO', strictPolicy, engine as any, {} as any);
  assert.strictEqual(res.status, 'INCOMPATIBLE', 'Callback requiring 2 parameters cannot be assigned to target providing only 1');
  assert.ok(
    (res.witness as any)?.failedRelation?.includes('requires 2 arguments') ||
    (res.witness as any)?.failedRelation?.includes('requires 2 parameters'),
    'Witness must specify parameter count mismatch'
  );
});

// -----------------------------------------------------------------------------
// Finding 8: Recursive generic changes disappear from proof
// -----------------------------------------------------------------------------
test('P1 #8: Recursive type cycle matching includes instantiated type arguments', () => {
  const env1 = createVirtualEnvironment({
    'src/types.ts': 'export type Box<T> = { value: T; next: Box<T>; }; export const b: Box<string> = { value: "a", next: null as any };'
  }, 'E:/vroot-p8a');

  const env2 = createVirtualEnvironment({
    'src/types.ts': 'export type Box<T> = { value: T; next: Box<number>; }; export const b: Box<string> = { value: "a", next: null as any };'
  }, 'E:/vroot-p8b');

  const prog1 = env1.context.getProgram();
  const prog2 = env2.context.getProgram();

  const checker1 = prog1.getTypeChecker();
  const checker2 = prog2.getTypeChecker();

  const sf1 = prog1.getSourceFile('E:/vroot-p8a/src/types.ts')!;
  const sf2 = prog2.getSourceFile('E:/vroot-p8b/src/types.ts')!;

  let bNode1: ts.Node | undefined;
  let bNode2: ts.Node | undefined;

  const findB1 = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && (n.name as any).text === 'b') { bNode1 = n; return; }
    ts.forEachChild(n, findB1);
  };
  const findB2 = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && (n.name as any).text === 'b') { bNode2 = n; return; }
    ts.forEachChild(n, findB2);
  };
  findB1(sf1);
  findB2(sf2);

  const ir1 = TypeScriptTypeIRExtractor.extractFromNode(bNode1!, checker1, 'PARENT');
  const ir2 = TypeScriptTypeIRExtractor.extractFromNode(bNode2!, checker2, 'CANDIDATE');

  assert.notStrictEqual(ir1.irContentHash, ir2.irContentHash, 'Box<string> with next: Box<string> must NOT have identical IR hash to next: Box<number>');

  // Also test TSR15RecursionBackreferenceRule directly
  const rule15 = new TSR15RecursionBackreferenceRule();
  const backref1: TypeScriptTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'RECURSION_BACKREFERENCE',
    display: 'recursive(Box)',
    irContentHash: 'hash-r1',
    scopeBindingId: 'decl:types.ts#Box',
    ancestorDepth: 1,
    instantiatedTypeArgumentHashes: ['hash-string'],
    origin: { snapshot: 'PARENT', file: '' }
  };
  const backref2: TypeScriptTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'RECURSION_BACKREFERENCE',
    display: 'recursive(Box)',
    irContentHash: 'hash-r2',
    scopeBindingId: 'decl:types.ts#Box',
    ancestorDepth: 1,
    instantiatedTypeArgumentHashes: ['hash-number'],
    origin: { snapshot: 'CANDIDATE', file: '' }
  };

  const r15Res = rule15.evaluate(backref1, backref2);
  assert.strictEqual(r15Res.status, 'UNDECIDABLE', 'Backreferences with different instantiated arguments must return UNDECIDABLE');
});

// -----------------------------------------------------------------------------
// Finding 9: Distinct private-member origins collapse
// -----------------------------------------------------------------------------
test('P1 #9: Two classes in the same file with private x:number have distinct nominal origins and fail compatibility', () => {
  const env = createVirtualEnvironment({
    'src/classes.ts': `
      export class ClassA { private x: number = 1; }
      export class ClassB { private x: number = 2; }
    `
  }, 'E:/vroot-p9');

  const prog = env.context.getProgram();
  const checker = prog.getTypeChecker();
  const sf = prog.getSourceFile('E:/vroot-p9/src/classes.ts')!;

  let nodeA: ts.Node | undefined;
  let nodeB: ts.Node | undefined;

  const findClasses = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === 'ClassA') nodeA = n;
    if (ts.isClassDeclaration(n) && n.name?.text === 'ClassB') nodeB = n;
    ts.forEachChild(n, findClasses);
  };
  findClasses(sf);

  const irA = TypeScriptTypeIRExtractor.extractFromNode(nodeA!, checker, 'PARENT') as ObjectTypeIR;
  const irB = TypeScriptTypeIRExtractor.extractFromNode(nodeB!, checker, 'CANDIDATE') as ObjectTypeIR;

  assert.ok(irA.nominalOrigins?.some(o => o.includes('ClassA')), 'irA nominalOrigins must include ClassA');
  assert.ok(irB.nominalOrigins?.some(o => o.includes('ClassB')), 'irB nominalOrigins must include ClassB');
  assert.notStrictEqual(irA.nominalOrigins?.[0], irB.nominalOrigins?.[0], 'ClassA and ClassB must have distinct nominal origins');

  const evalRes = engine.evaluate(irA, irB, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(evalRes.status, 'INCOMPATIBLE', 'Unrelated classes with private members in same file must be INCOMPATIBLE');
});

// -----------------------------------------------------------------------------
// Finding 10: Supplying reconciliation options disables mandatory proof validation
// -----------------------------------------------------------------------------
test('P1 #10: Supplying empty phase4ReconcileOptions propagates isPhase4Mode and validates proof trees', () => {
  const obligation = makeObligation('obl-10', 'f');

  const site: UsageSite = {
    usageSiteId: 'occ-10',
    canonicalOccurrence: {
      occurrenceId: 'occ-10',
      sourceFile: 'src/f.ts',
      sourceSpan: { start: 0, end: 5, line: 1, column: 1 },
      syntaxKind: 1,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'decl:src/f.ts#f',
      declarationSymbol: 'decl:src/f.ts#f',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EVALUABLE',
    identityResult: 'SAME',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };

  // Caller provides a status-only COMPATIBLE result without a phase4 proof tree
  const statusOnlyCompatible = () => ({
    status: 'COMPATIBLE' as const,
    reason: null
  });

  const pipeline = new PipelineB();
  // Pass isPhase4Mode: true and empty phase4ReconcileOptions: {}
  const res = pipeline.execute(obligation, {
    isPhase4Mode: true,
    phase4ReconcileOptions: {},
    discoveredHistoricalConsumerIds: ['occ-10'],
    evaluateCompatibility: statusOnlyCompatible
  });

  // Proof tree validation MUST NOT be bypassed; missing proof tree must demote to UNDECIDABLE -> UNKNOWN verdict!
  assert.strictEqual(res.verdict, 'UNKNOWN', 'Status-only result without valid proof tree must NOT reach PRESERVED');
});

// -----------------------------------------------------------------------------
// Finding 11: Historical coverage is not established
// -----------------------------------------------------------------------------
test('P1 #11: Missing historical coverage forces UNKNOWN; omitted historical consumer is injected and blocks PRESERVED', () => {
  const obligation = makeObligation('obl-11', 'f');
  const pipeline = new PipelineB();

  // Case A: isPhase4Mode: true without historical coverage evidence => forces UNKNOWN
  const resNoCoverage = pipeline.execute(obligation, {
    isPhase4Mode: true
    // no discoveredHistoricalConsumerIds and no crossVersionIdentity!
  });
  assert.strictEqual(resNoCoverage.verdict, 'UNKNOWN', 'Missing historical coverage evidence must force UNKNOWN');

  // Case B: Disappeared historical consumer (present in historical IDs but omitted in single-context discovery)
  const resOmitted = pipeline.execute(obligation, {
    isPhase4Mode: true,
    discoveredHistoricalConsumerIds: ['omitted-consumer-123'],
    evaluateCompatibility: () => ({ status: 'COMPATIBLE', reason: null })
  });
  assert.strictEqual(resOmitted.verdict, 'UNKNOWN', 'Omitted historical consumer must be injected and prevent PRESERVED');
});

// -----------------------------------------------------------------------------
// Finding 12: Production Phase 4 evaluator cannot evaluate consumers
// -----------------------------------------------------------------------------
test('P1 #12: Production PipelineB wires dual-program dependencies and evaluates consumers', () => {
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): number { return x; }',
    'src/consumer.ts': 'import { f } from "./provider"; f(42);'
  }, 'E:/vroot-p12');

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number | string): number { return 0; }',
    'src/consumer.ts': 'import { f } from "./provider"; f(42);'
  }, 'E:/vroot-p12');

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const target = createMockSymbolRef('f', 'FUNCTION', `${parentEnv.rootDir}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(parentEnv.context, target, parentEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map(o => o.occurrenceId);
  assert.ok(discoveredIds.length > 0, 'Consumer call site must be discovered');

  const pipeline = new PipelineB();
  const res = pipeline.execute(obligation, {
    context: parentEnv.context,
    universe: parentEnv.universe,
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation }),
    discoveredHistoricalConsumerIds: discoveredIds
  });

  // Verify that evaluable sites did NOT fail with PHASE4_PREREQUISITES_UNAVAILABLE
  assert.notStrictEqual(res.verdict, 'UNKNOWN', 'Wired programs must allow evaluation without prerequisites failure');
  assert.strictEqual(res.verdict, 'PRESERVED', 'Widened parameter without breaking callers must reach PRESERVED');
});

// -----------------------------------------------------------------------------
// Finding 13: Canonical hashes depend on process identity and checkout location
// -----------------------------------------------------------------------------
test('P1 #13: Contract and IR hashes are deterministic across independent compiler programs and checkout paths', () => {
  // Program A at workspace 1
  const envA = createVirtualEnvironment({
    'src/f.ts': 'export function f(x: number): string { return String(x); }'
  }, 'E:/location-a');

  // Program B at workspace 2 (different root path)
  const envB = createVirtualEnvironment({
    'src/f.ts': 'export function f(x: number): string { return String(x); }'
  }, 'C:/different-location-b');

  const progA = envA.context.getProgram();
  const progB = envB.context.getProgram();

  const sfA = progA.getSourceFile('E:/location-a/src/f.ts')!;
  const sfB = progB.getSourceFile('C:/different-location-b/src/f.ts')!;

  let declA: ts.Node | undefined;
  let declB: ts.Node | undefined;

  const findF1 = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'f') { declA = n; return; }
    ts.forEachChild(n, findF1);
  };
  const findF2 = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'f') { declB = n; return; }
    ts.forEachChild(n, findF2);
  };
  findF1(sfA);
  findF2(sfB);

  const contractA = adapter.extractContract(declA!, { parentProgram: progA, candidateProgram: progA });
  const contractB = adapter.extractContract(declB!, { parentProgram: progB, candidateProgram: progB });

  assert.strictEqual(contractA.symbolId, contractB.symbolId, 'symbolId must be deterministic and repo-relative without (symbol as any).id');
  assert.strictEqual(contractA.contractType.irContentHash, contractB.contractType.irContentHash, 'irContentHash must be identical across independent programs');
  assert.strictEqual(contractA.contractHash, contractB.contractHash, 'contractHash must be 100% identical across independent programs and checkout roots');
});

console.log('\n================================================================');
console.log(`Phase 4 Hostile Audit Regressions: ${passed} passed, ${failed} failed`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
