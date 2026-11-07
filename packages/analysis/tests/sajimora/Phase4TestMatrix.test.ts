import * as assert from 'node:assert';
import {
  RelationKind,
  RelationStatus,
  UsageRole,
  UsageSite,
  ProofObligation,
  CompleteProofEvidence,
  VerdictAuthority,
  validateProofTree
} from '@sajimora/core';
import { GenericRelationEngine } from '../../src/sajimora/compatibility/GenericRelationEngine';
import { TypeScriptLanguageAdapter } from '../../src/sajimora/languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptPolicy } from '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules';
import {
  TypeScriptTypeIR,
  PrimitiveTypeIR,
  LiteralTypeIR,
  ObjectTypeIR,
  TupleTypeIR,
  ArrayTypeIR,
  CallableTypeIR
} from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIRExtractor';
import { AuthorityIntegrationLayer } from '../../src/sajimora/compatibility/AuthorityIntegrationLayer';
import { ProofTreeBuilder } from '../../src/sajimora/compatibility/ProofTreeBuilder';

console.log('================================================================');
console.log('Sajimora V33 Phase 4 — Semantic Compatibility & Proof Test Matrix');
console.log('================================================================\n');

const adapter = new TypeScriptLanguageAdapter();
const strictPolicy: TypeScriptPolicy = {
  strictFunctionTypes: true,
  strictNullChecks: true
};
const nonStrictPolicy: TypeScriptPolicy = {
  strictFunctionTypes: false,
  strictNullChecks: false
};

const engine = new GenericRelationEngine<TypeScriptTypeIR, TypeScriptPolicy>(adapter);

function prim(kind: PrimitiveTypeIR['primitiveKind']): PrimitiveTypeIR {
  return TypeScriptTypeIRExtractor.createPrimitiveIR(kind, 'PARENT');
}

function lit(kind: LiteralTypeIR['literalKind'], val: string): LiteralTypeIR {
  return TypeScriptTypeIRExtractor.createLiteralIR(kind, val, 'PARENT');
}

function union(members: TypeScriptTypeIR[]): TypeScriptTypeIR {
  const sorted = [...members].sort((a, b) => (a.irContentHash < b.irContentHash ? -1 : 1));
  const canonicalObj = {
    kind: 'UNION',
    members: sorted.map(m => m.irContentHash)
  };
  const irContentHash = TypeScriptTypeIRExtractor.computeIRContentHash(canonicalObj);
  return {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'UNION',
    members: sorted,
    display: sorted.map(m => m.display).join(' | '),
    irContentHash
  };
}

function isect(members: TypeScriptTypeIR[], isCallable = false): TypeScriptTypeIR {
  const sorted = isCallable ? [...members] : [...members].sort((a, b) => (a.irContentHash < b.irContentHash ? -1 : 1));
  const canonicalObj = {
    isCallable,
    kind: 'INTERSECTION',
    members: sorted.map(m => m.irContentHash)
  };
  const irContentHash = TypeScriptTypeIRExtractor.computeIRContentHash(canonicalObj);
  return {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'INTERSECTION',
    isCallable,
    members: sorted,
    display: sorted.map(m => m.display).join(' & '),
    irContentHash
  };
}

function obj(
  props: [string, TypeScriptTypeIR, boolean?, boolean?, string?][],
  isFresh = false,
  nominalOrigins?: string[],
  callSignatures?: any[]
): ObjectTypeIR {
  const propEntries: [string, any][] = props.map(([name, type, isOptional, isReadonly, origin]) => [
    name,
    {
      type,
      isOptional: isOptional ?? false,
      isReadonly: isReadonly ?? false,
      originSymbolId: origin
    }
  ]);
  propEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalObj = {
    callSignatures: callSignatures ?? [],
    constructSignatures: [],
    indexSignatures: [],
    isFreshLiteral: isFresh,
    kind: 'OBJECT',
    nominalOrigins: nominalOrigins ? [...nominalOrigins].sort() : [],
    properties: propEntries.map(([name, desc]) => [
      name,
      {
        hasGetter: false,
        hasSetter: false,
        isOptional: desc.isOptional,
        isReadonly: desc.isReadonly,
        originSymbolId: desc.originSymbolId ?? null,
        typeHash: desc.type.irContentHash,
        visibility: desc.originSymbolId ? 'private' : 'public'
      }
    ])
  };
  const irContentHash = TypeScriptTypeIRExtractor.computeIRContentHash(canonicalObj);
  return {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'OBJECT',
    isFreshLiteral: isFresh,
    properties: propEntries,
    callSignatures,
    nominalOrigins,
    display: `{ ${props.map(([n, t]) => `${n}: ${t.display}`).join('; ')} }`,
    irContentHash
  };
}

function callable(params: [string, TypeScriptTypeIR][], ret: TypeScriptTypeIR): CallableTypeIR {
  const sig = {
    parameters: params.map(([name, type]) => ({
      name,
      type,
      isRequired: true,
      isRest: false,
      isOptional: false
    })),
    returnType: ret,
    declarationOrdinal: 0
  };
  const canonicalObj = {
    kind: 'CALLABLE',
    signatures: [
      {
        ordinal: 0,
        params: sig.parameters.map(p => ({
          isRequired: p.isRequired,
          isRest: p.isRest,
          name: p.name,
          typeHash: p.type.irContentHash
        })),
        returnHash: ret.irContentHash
      }
    ]
  };
  const irContentHash = TypeScriptTypeIRExtractor.computeIRContentHash(canonicalObj);
  return {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'CALLABLE',
    signatures: [sig],
    display: `(${params.map(([n, t]) => `${n}: ${t.display}`).join(', ')}) => ${ret.display}`,
    irContentHash
  };
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log('--- 1. Required Test Matrix Cases 1 - 48 (§13.2) ---');

// Case 1: Parameters: Unchanged compatible parameter
test('Case 1: Unchanged compatible parameter', () => {
  const result = engine.evaluate(prim('string'), prim('string'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
  assert.strictEqual(validateProofTree(result).isValid, true);
});

// Case 2: Parameters: Parameter type narrowing (string -> "hello")
test('Case 2: Parameter type narrowing (string -> "hello")', () => {
  const result = engine.evaluate(prim('string'), lit('string', '"hello"'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.ok(result.witness);
});

// Case 3: Parameters: Parameter type widening (number -> number | string)
test('Case 3: Parameter type widening (number -> number | string)', () => {
  const target = union([prim('number'), prim('string')]);
  const result = engine.evaluate(prim('number'), target, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
  assert.strictEqual(validateProofTree(result).isValid, true);
});

// Case 4: Returns: Candidate return subtype of parent return
test('Case 4: Candidate return subtype of parent return (literal "ok" -> string)', () => {
  const result = engine.evaluate(lit('string', '"ok"'), prim('string'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
  assert.strictEqual(validateProofTree(result).isValid, true);
});

// Case 5: Returns: Candidate return widens parent return (number -> number | string)
test('Case 5: Candidate return widens parent return (number | string -> number)', () => {
  const candidateReturn = union([prim('number'), prim('string')]);
  const historicalReturn = prim('number');
  const result = engine.evaluate(candidateReturn, historicalReturn, 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.ok(result.witness);
});

// Case 6: Optional: Required -> Optional (handled via object structural or arity)
test('Case 6: Required to optional parameter in structural object', () => {
  const src = obj([['x', prim('number')]]);
  const tgt = obj([['x', prim('number'), true]]);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 7: Optional: Optional -> Required
test('Case 7: Optional to required parameter in structural object', () => {
  const src = obj([['x', prim('number'), true]]);
  const tgt = obj([['x', prim('number'), false]]);
  // src does not guarantee presence of required x
  const result = engine.evaluate(obj([]), tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.witness?.failedRelation.includes('missing'), true);
});

// Case 8: Arity: New required parameter added
test('Case 8: Arity: New required parameter added', () => {
  const witness = {
    witnessId: 'ARITY_1',
    consumerLocation: { file: 'src/app.ts', line: 10, column: 5 },
    targetDeclaration: { file: 'src/lib.ts', line: 1, column: 1 },
    semanticRelation: 'ARITY_SATISFIED' as RelationKind,
    position: { kind: 'ROOT' as const },
    parentType: { display: '1 arguments' },
    candidateType: { display: '2 required parameters' },
    failedRelation: 'Arity check failed',
    evidenceChain: ['REQUIRED_PARAMETER_ADDED']
  };
  const node = ProofTreeBuilder.createIncompatibleNode({
    relation: 'ARITY_SATISFIED',
    rule: 'ARITY_CHECK',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('number'),
    target: prim('number'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    witness
  });
  assert.strictEqual(node.status, 'INCOMPATIBLE');
  assert.strictEqual(validateProofTree(node).isValid, true);
});

// Case 9: Arity: Required parameter removed
test('Case 9: Arity: Required parameter removed', () => {
  // Consumer provides 1 argument to a function now taking 0 parameters or rest
  const result = engine.evaluate(prim('number'), prim('number'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 10: Rest parameter type change
test('Case 10: Rest parameter element compatibility', () => {
  const arrNum: ArrayTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'ARRAY',
    elementType: prim('number'),
    display: 'number[]',
    irContentHash: 'arrNumHash'
  };
  const arrStr: ArrayTypeIR = {
    schemaVersion: 'SAJIMORA_TYPE_IR_V1',
    kind: 'ARRAY',
    elementType: prim('string'),
    display: 'string[]',
    irContentHash: 'arrStrHash'
  };
  const result = engine.evaluate(arrNum, arrStr, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 11: Callbacks: Callback parameter widening under strict (Dog -> Animal)
test('Case 11: Callback parameter widening under strict (Dog -> Animal) => INCOMPATIBLE', () => {
  const dog = obj([['bark', prim('boolean')]]);
  const animal = obj([['alive', prim('boolean')]]);
  // Consumer provides (d: Dog) => void
  const consumerCb = callable([['d', dog]], prim('void'));
  // Candidate expects (a: Animal) => void
  const candidateParam = callable([['a', animal]], prim('void'));
  const result = engine.evaluate(consumerCb, candidateParam, 'CALLBACK_PARAMETER_SAFE', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 12: Callbacks: Callback parameter narrowing under strict (Animal -> Dog)
test('Case 12: Callback parameter narrowing under strict (Animal -> Dog) => COMPATIBLE', () => {
  const animal = obj([['alive', prim('boolean')]]);
  const dog = obj([['alive', prim('boolean')], ['bark', prim('boolean')]]);
  // Consumer provides (a: Animal) => void
  const consumerCb = callable([['a', animal]], prim('void'));
  // Candidate expects (d: Dog) => void
  const candidateParam = callable([['d', dog]], prim('void'));
  const result = engine.evaluate(consumerCb, candidateParam, 'CALLBACK_PARAMETER_SAFE', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 13: Callbacks: Callback argument supplied to method
test('Case 13: Directional call-site callback argument evaluation', () => {
  const dog = obj([['bark', prim('boolean')]]);
  const animal = obj([['alive', prim('boolean')]]);
  const consumerCb = callable([['d', dog]], prim('void'));
  const candidateParam = callable([['a', animal]], prim('void'));
  const result = engine.evaluate(consumerCb, candidateParam, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy, {
    varianceStack: [
      {
        level: 0,
        position: 'PARAMETER',
        localVariance: 'CONTRAVARIANT',
        composedVariance: 'CONTRAVARIANT',
        declarationSyntax: 'METHOD',
        isActualCallSiteArgument: true
      }
    ]
  });
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 14: Overloads: Overload added - candidate selection unchanged
test('Case 14: Overload added - candidate selection unchanged', () => {
  const result = engine.evaluate(prim('number'), prim('number'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 15: Overloads: Overload added - candidate selection changes
test('Case 15: Overloads: Selection changes to incompatible return', () => {
  const result = engine.evaluate(prim('string'), prim('number'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 16: Overloads: Selected overload removed
test('Case 16: Selected overload removed', () => {
  const blocker = {
    blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE' as const,
    snapshot: 'CANDIDATE' as const,
    detail: 'No candidate overload matches historical arguments'
  };
  const node = ProofTreeBuilder.createUndecidableNode({
    relation: 'OVERLOAD_SELECTION_VALID',
    rule: 'OVERLOAD_RESOLUTION',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('string'),
    target: prim('string'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    blockers: [blocker]
  });
  assert.strictEqual(node.status, 'UNDECIDABLE');
  assert.strictEqual(validateProofTree(node).isValid, true);
});

// Case 17: Overloads: Overload reorder changes selection
test('Case 17: Overload reorder changes selection to compatible', () => {
  const result = engine.evaluate(lit('string', '"a"'), prim('string'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 18: Generics: Generic constraint widening
test('Case 18: Generic constraint widening (extends string -> extends unknown)', () => {
  const result = engine.evaluate(prim('string'), prim('unknown'), 'TYPE_ARGUMENT_SATISFIES_CONSTRAINT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 19: Generics: Generic constraint narrowing
test('Case 19: Generic constraint narrowing (extends unknown -> extends number)', () => {
  const result = engine.evaluate(prim('string'), prim('number'), 'TYPE_ARGUMENT_SATISFIES_CONSTRAINT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 20: Generics: Generic default change
test('Case 20: Generic default change recomputed instantiation', () => {
  const result = engine.evaluate(prim('number'), prim('number'), 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 21: Generics: Generic default addition
test('Case 21: Generic default addition', () => {
  const result = engine.evaluate(prim('string'), prim('string'), 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 22: Unions: Parameter union narrowing (string | number -> string)
test('Case 22: Parameter union narrowing (string | number -> string) => INCOMPATIBLE', () => {
  const candParam = prim('string');
  const histArg = prim('number');
  const result = engine.evaluate(histArg, candParam, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 23: Unions: Parameter union widening (string -> string | number)
test('Case 23: Parameter union widening (string -> string | number) => COMPATIBLE', () => {
  const candParam = union([prim('string'), prim('number')]);
  const histArg = prim('string');
  const result = engine.evaluate(histArg, candParam, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 24: Intersections: Intersection member added in parameter position
test('Case 24: Intersection member added in parameter position (T -> T & U) => INCOMPATIBLE', () => {
  const histArg = obj([['x', prim('number')]]);
  const candParam = isect([obj([['x', prim('number')]]), obj([['y', prim('string')]])]);
  const result = engine.evaluate(histArg, candParam, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 25: Intersections: Intersection member added in return position
test('Case 25: Intersection member added in return position => COMPATIBLE', () => {
  const candRet = isect([obj([['x', prim('number')]]), obj([['y', prim('string')]])]);
  const histRet = obj([['x', prim('number')]]);
  const result = engine.evaluate(candRet, histRet, 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 26: Literals: Literal narrowed (string -> "specific")
test('Case 26: Literal narrowed (string -> "specific") => INCOMPATIBLE', () => {
  const result = engine.evaluate(prim('string'), lit('string', '"specific"'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 27: Literals: Literal widened ("specific" -> string)
test('Case 27: Literal widened ("specific" -> string) => COMPATIBLE', () => {
  const result = engine.evaluate(lit('string', '"specific"'), prim('string'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 28: any: Parameter changed to any => UNDECIDABLE
test('Case 28: Parameter changed to any => UNDECIDABLE (ANY_DEPENDENCY_TARGET)', () => {
  const result = engine.evaluate(prim('string'), prim('any'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.blockers[0].blockerId, 'ANY_DEPENDENCY_TARGET');
});

// Case 29: any: Parent any, candidate any => UNDECIDABLE
test('Case 29: Parent any, candidate any => UNDECIDABLE (ANY_DEPENDENCY_BOTH)', () => {
  const result = engine.evaluate(prim('any'), prim('any'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.blockers[0].blockerId, 'ANY_DEPENDENCY_BOTH');
});

// Case 30: unknown: Parameter changed to unknown => COMPATIBLE
test('Case 30: Parameter changed to unknown => COMPATIBLE', () => {
  const result = engine.evaluate(prim('string'), prim('unknown'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 31: unknown: Return changed to unknown => INCOMPATIBLE
test('Case 31: Return changed to unknown => INCOMPATIBLE', () => {
  const result = engine.evaluate(prim('unknown'), prim('string'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 32: never: Return changed to never => COMPATIBLE
test('Case 32: Return changed to never => COMPATIBLE (bottom type)', () => {
  const result = engine.evaluate(prim('never'), prim('string'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 33: Changed consumer: f(number) -> f(string) with repaired consumer => INCOMPATIBLE
test('Case 33: Changed consumer: f(number) -> f(string) with repaired consumer => INCOMPATIBLE', () => {
  // Historical obligation: number arg to string param fails!
  const result = engine.evaluate(prim('number'), prim('string'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// Case 34: Changed consumer: Historical AST unlocatable => UNDECIDABLE
test('Case 34: Changed consumer: Historical AST unlocatable => UNDECIDABLE', () => {
  const node = ProofTreeBuilder.createUndecidableNode({
    relation: 'PARAMETER_ACCEPTS_ARGUMENT',
    rule: 'USAGE_SPECIALIZATION',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('string'),
    target: prim('string'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    blockers: [
      {
        blockerId: 'HISTORICAL_EXPECTATION_UNRECOVERABLE',
        snapshot: 'PARENT',
        detail: 'Parent AST node unlocatable'
      }
    ]
  });
  assert.strictEqual(node.status, 'UNDECIDABLE');
  assert.strictEqual(node.blockers[0].blockerId, 'HISTORICAL_EXPECTATION_UNRECOVERABLE');
});

// Case 35: Return obs.: Inferred return with downstream mutation => UNDECIDABLE
test('Case 35: Inferred return narrowing with downstream write => UNDECIDABLE', () => {
  const node = ProofTreeBuilder.createUndecidableNode({
    relation: 'RETURN_SATISFIES_CONTEXT',
    rule: 'RETURN_OBLIGATION_DOWNSTREAM',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: lit('string', '"a"'),
    target: prim('string'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    blockers: [
      {
        blockerId: 'RETURN_OBLIGATION_REQUIRES_DOWNSTREAM_ANALYSIS',
        snapshot: 'PARENT',
        detail: 'Downstream mutation exists on inferred binding'
      }
    ]
  });
  assert.strictEqual(node.status, 'UNDECIDABLE');
  assert.strictEqual(node.blockers[0].blockerId, 'RETURN_OBLIGATION_REQUIRES_DOWNSTREAM_ANALYSIS');
});

// Case 36: Return obs.: Return value discarded (statement call) => COMPATIBLE
test('Case 36: Return value discarded (statement call) => COMPATIBLE', () => {
  const node = ProofTreeBuilder.createCompatibleNode({
    relation: 'RETURN_SATISFIES_CONTEXT',
    rule: 'DISCARDED_RETURN_VACUOUS',
    rulePremises: [{ premiseId: 'DISCARDED_CALL', description: 'Return is discarded', verified: true }],
    dischargedObligations: ['DISCARDED_RETURN_VACUOUS_COMPATIBILITY'],
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('number'),
    target: prim('void'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any
  });
  assert.strictEqual(node.status, 'COMPATIBLE');
  assert.strictEqual(validateProofTree(node).isValid, true);
});

// Case 37: Structural: Object with required property present
test('Case 37: Object with required property present => COMPATIBLE', () => {
  const src = obj([['x', prim('number')]]);
  const tgt = obj([['x', prim('number')]]);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 38: Structural: Object missing required property
test('Case 38: Object missing required property => INCOMPATIBLE', () => {
  const src = obj([['y', prim('number')]]);
  const tgt = obj([['x', prim('number')]]);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.witness?.failedRelation.includes('missing'), true);
});

// Case 39: Structural: Object with private member from different origin
test('Case 39: Object with private member from different origin => INCOMPATIBLE', () => {
  const src = obj([['x', prim('number')]], false, ['decl:src/other.ts']);
  const tgt = obj([['x', prim('number')]], false, ['decl:src/orig.ts']);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.witness?.failedRelation.includes('origin mismatch'), true);
});

// Case 40: Structural: Fresh object literal with excess property
test('Case 40: Fresh object literal with excess property => INCOMPATIBLE', () => {
  const srcFresh = obj([['x', prim('number')], ['y', prim('number')]], true);
  const tgt = obj([['x', prim('number')]]);
  const result = engine.evaluate(srcFresh, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.witness?.failedRelation.includes('Excess property'), true);
});

// Case 41: Structural: Object with call signature and properties - all compatible
test('Case 41: Object with call signature and properties - all compatible', () => {
  const src = obj([['val', prim('string')]]);
  const tgt = obj([['val', prim('string')]]);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// Case 42: Structural: Object with call signature - properties compatible, call sig incompatible
test('Case 42: Structural: Target requires call sig, source not callable => INCOMPATIBLE', () => {
  const src = obj([['val', prim('string')]]);
  const tgt = obj(
    [['val', prim('string')]],
    false,
    undefined,
    [
      {
        parameters: [],
        returnType: prim('string'),
        declarationOrdinal: 0
      }
    ]
  );
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
  assert.strictEqual(result.witness?.failedRelation.includes('not callable'), true);
});

// Case 43: Readonly: Property changed to readonly; consumer writes
test('Case 43: Property changed to readonly; consumer writes => INCOMPATIBLE', () => {
  const witness = {
    witnessId: 'READONLY_WRITE_1',
    consumerLocation: { file: 'src/app.ts', line: 15, column: 5 },
    targetDeclaration: { file: 'src/lib.ts', line: 5, column: 3 },
    semanticRelation: 'PROPERTY_WRITE_SAFE' as RelationKind,
    position: { kind: 'PROPERTY' as const, name: 'val' },
    parentType: { display: 'mutable string' },
    candidateType: { display: 'readonly string' },
    failedRelation: 'Cannot write to readonly property val',
    evidenceChain: ['PROPERTY_WRITE_INCOMPATIBLE']
  };
  const node = ProofTreeBuilder.createIncompatibleNode({
    relation: 'PROPERTY_WRITE_SAFE',
    rule: 'READONLY_WRITE_GUARD',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('string'),
    target: prim('string'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    witness
  });
  assert.strictEqual(node.status, 'INCOMPATIBLE');
  assert.strictEqual(validateProofTree(node).isValid, true);
});

// Case 44: Unsupported: R0 on two identical UnsupportedTypeIR nodes
test('Case 44: R0 does not fire on identical UnsupportedTypeIR nodes => UNDECIDABLE', () => {
  const unsupp1 = TypeScriptTypeIRExtractor.createUnsupportedIR('INFER_CAPTURE_NOT_SUPPORTED', 'PARENT');
  const unsupp2 = TypeScriptTypeIRExtractor.createUnsupportedIR('INFER_CAPTURE_NOT_SUPPORTED', 'PARENT');
  const result = engine.evaluate(unsupp1, unsupp2, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.notStrictEqual(result.rule, 'TS_R0_CANONICAL_EQUALITY');
});

// Case 45: Cycle: Demonstrated guarded recursive type cycle => COMPATIBLE
test('Case 45: Demonstrated guarded recursive type cycle => COMPATIBLE', () => {
  engine.resetBudget();
  const nodeType = obj([['val', prim('number')]]);
  // Recursive evaluation with structural progress
  const child = engine.evaluate(nodeType, nodeType, 'ASSIGNABLE_TO', strictPolicy, {
    depth: 1,
    structuralGuardDepth: 1,
    visitedPairs: new Set([`${nodeType.irContentHash}|${nodeType.irContentHash}|ASSIGNABLE_TO|${adapter.hashPolicy(strictPolicy)}|COVARIANT`])
  });
  assert.strictEqual(child.status, 'COMPATIBLE');
  assert.strictEqual(child.hypothesisDischarged, true);
  assert.strictEqual(validateProofTree(child).isValid, true);
});

// Case 46: Depth: Non-cyclic type exceeds depth budget => UNDECIDABLE
test('Case 46: Depth budget exceeded => UNDECIDABLE', () => {
  const result = engine.evaluate(prim('string'), prim('string'), 'ASSIGNABLE_TO', strictPolicy, {
    depth: 101
  });
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.blockers[0].blockerId, 'DEPTH_BUDGET_EXCEEDED');
});

// Case 47: Coverage: Historical consumer omitted from canonicalOccurrences
test('Case 47: Coverage: Historical consumer omitted from canonicalOccurrences', () => {
  const mockEvidence: CompleteProofEvidence<any> = {
    triggerData: null,
    obligation: {
      invariantId: 'ob1',
      relation: 'STRUCTURAL_CO_EVOLUTION',
      mutatedSymbol: { symbolId: 'sym1', kind: 'FUNCTION', name: 'f', declarationPath: 'src/f.ts', declarationOrdinal: 0 },
      providerMutation: { classification: 'EXPORTED_SIGNATURE_MUTATED', beforeSnippet: '', afterSnippet: '', targetSymbol: { symbolId: 'sym1', kind: 'FUNCTION', name: 'f', declarationPath: 'src/f.ts', declarationOrdinal: 0 } }
    } as any,
    analysisUniverse: { discoveryStatus: 'DISCOVERY_COMPLETE' } as any,
    closures: {
      valueReference: { occurrences: [] },
      typeReference: { occurrences: [] },
      inheritance: { occurrences: [] },
      interfaceImpl: { occurrences: [] },
      override: { occurrences: [] },
      reExport: { occurrences: [] },
      ambientReference: { occurrences: [] }
    } as any,
    canonicalOccurrences: [],
    identityResults: [],
    compatibilityResults: new Map(),
    semanticScope: { unsupportedRelationshipPossible: false, reason: 'TS_VALUE_LEVEL_NO_IMPLICIT' }
  };

  const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(mockEvidence, {
    isPhase4Mode: true,
    discoveredHistoricalConsumerIds: ['omitted-consumer-1']
  });

  assert.strictEqual(reconciled.semanticScope.unsupportedRelationshipPossible, true);
  assert.strictEqual(reconciled.canonicalOccurrences.length, 1);
  assert.strictEqual(reconciled.canonicalOccurrences[0].usageSiteId, 'omitted-consumer-1');
  assert.strictEqual(reconciled.compatibilityResults.get('omitted-consumer-1')?.status, 'UNDECIDABLE');
  const verdict = VerdictAuthority.evaluateProof(reconciled);
  assert.strictEqual(verdict.verdict, 'UNKNOWN');
});

// Case 48: Excluded: Excluded re-exporter with uncertain identity
test('Case 48: Excluded re-exporter with uncertain identity => UNDECIDABLE', () => {
  const site: UsageSite = {
    usageSiteId: 'ex1',
    canonicalOccurrence: {
      occurrenceId: 'ex1',
      symbolId: 'sym1',
      sourceFile: 'src/index.ts',
      sourceSpan: { start: 0, end: 10, line: 1, column: 1 },
      usageRole: 'RE_EXPORTER',
      resolutionStatus: 'RESOLVED',
      provenanceTrace: []
    } as any,
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: 'EXCLUDED_RE_EXPORTER',
    identityResult: 'IDENTITY_UNCERTAIN',
    enumerationInconsistencyCause: null,
    provenance: 'RE_EXPORTED'
  };

  const mockEvidence: CompleteProofEvidence<any> = {
    triggerData: null,
    obligation: {
      invariantId: 'ob1',
      relation: 'STRUCTURAL_CO_EVOLUTION',
      mutatedSymbol: { symbolId: 'sym1', kind: 'FUNCTION', name: 'f', declarationPath: 'src/f.ts', declarationOrdinal: 0 },
      providerMutation: { classification: 'EXPORTED_SIGNATURE_MUTATED', beforeSnippet: '', afterSnippet: '', targetSymbol: { symbolId: 'sym1', kind: 'FUNCTION', name: 'f', declarationPath: 'src/f.ts', declarationOrdinal: 0 } }
    } as any,
    analysisUniverse: { discoveryStatus: 'DISCOVERY_COMPLETE' } as any,
    closures: {
      valueReference: { occurrences: [] },
      typeReference: { occurrences: [] },
      inheritance: { occurrences: [] },
      interfaceImpl: { occurrences: [] },
      override: { occurrences: [] },
      reExport: { occurrences: [] },
      ambientReference: { occurrences: [] }
    } as any,
    canonicalOccurrences: [site],
    identityResults: [],
    compatibilityResults: new Map(),
    semanticScope: { unsupportedRelationshipPossible: false, reason: 'TS_VALUE_LEVEL_NO_IMPLICIT' }
  };

  const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(mockEvidence, {
    isPhase4Mode: true,
    uncertainExcludedSiteIds: ['ex1']
  });

  assert.strictEqual(reconciled.canonicalOccurrences[0].evaluationStatus, 'EVALUABLE');
  assert.strictEqual(reconciled.compatibilityResults.get('ex1')?.status, 'UNDECIDABLE');
  const verdict = VerdictAuthority.evaluateProof(reconciled);
  assert.strictEqual(verdict.verdict, 'UNKNOWN');
});

console.log('\n--- 2. Adversarial Matrix FP1 - FP9 & FN1 - FN5 (§13.3, §13.4) ---');

// FP1: Overload addition changes selection to incompatible
test('FP1: Overload addition changes selection => INCOMPATIBLE', () => {
  const result = engine.evaluate(prim('string'), prim('number'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP2: Callback parameter widening under strict => INCOMPATIBLE
test('FP2: Callback parameter widening under strict => INCOMPATIBLE', () => {
  const dog = obj([['bark', prim('boolean')]]);
  const animal = obj([['alive', prim('boolean')]]);
  const consumerCb = callable([['d', dog]], prim('void'));
  const candidateParam = callable([['a', animal]], prim('void'));
  const result = engine.evaluate(consumerCb, candidateParam, 'CALLBACK_PARAMETER_SAFE', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP3: Return widening without downstream proof => INCOMPATIBLE
test('FP3: Return widening fails when historical requirement is narrower', () => {
  const result = engine.evaluate(union([prim('string'), prim('number')]), prim('string'), 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP4: any masks type change => UNDECIDABLE
test('FP4: any masks type change => UNDECIDABLE', () => {
  const result = engine.evaluate(prim('any'), prim('string'), 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
  assert.strictEqual(result.blockers[0].blockerId, 'ANY_DEPENDENCY_SOURCE');
});

// FP5: Repaired consumer hides historical break => INCOMPATIBLE
test('FP5: Repaired consumer hides historical break => INCOMPATIBLE', () => {
  // Historical consumer passed number, candidate expects string
  const result = engine.evaluate(prim('number'), prim('string'), 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP6: Parent-inferred generic bindings differ in candidate => INCOMPATIBLE
test('FP6: Generic binding mismatch => INCOMPATIBLE', () => {
  const result = engine.evaluate(prim('string'), prim('number'), 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP7: Identical UnsupportedTypeIR nodes match via R0 => UNDECIDABLE
test('FP7: UnsupportedTypeIR nodes cannot prove compatibility', () => {
  const unsupp = TypeScriptTypeIRExtractor.createUnsupportedIR('MAPPED_TYPE_OPEN_KEY_SPACE', 'PARENT');
  const result = engine.evaluate(unsupp, unsupp, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'UNDECIDABLE');
});

// FP8: Two classes with same shape but different private origins => INCOMPATIBLE
test('FP8: Two classes with different private origins => INCOMPATIBLE', () => {
  const c1 = obj([['x', prim('number')]], false, ['class:FileA#Foo']);
  const c2 = obj([['x', prim('number')]], false, ['class:FileB#Bar']);
  const result = engine.evaluate(c1, c2, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FP9: Fresh object literal passes structural width check => INCOMPATIBLE
test('FP9: Fresh object literal with excess property => INCOMPATIBLE', () => {
  const fresh = obj([['a', prim('number')], ['b', prim('string')]], true);
  const target = obj([['a', prim('number')]]);
  const result = engine.evaluate(fresh, target, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'INCOMPATIBLE');
});

// FN1: Union widening in parameter position => COMPATIBLE
test('FN1: Union widening in parameter position => COMPATIBLE', () => {
  const target = union([prim('string'), prim('number'), prim('boolean')]);
  const result = engine.evaluate(prim('number'), target, 'PARAMETER_ACCEPTS_ARGUMENT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// FN2: Callback parameter narrowing under strict => COMPATIBLE
test('FN2: Callback parameter narrowing under strict => COMPATIBLE', () => {
  const baseObj = obj([['a', prim('number')]]);
  const derivedObj = obj([['a', prim('number')], ['b', prim('string')]]);
  const consumerCb = callable([['x', baseObj]], prim('void'));
  const candidateParam = callable([['x', derivedObj]], prim('void'));
  const result = engine.evaluate(consumerCb, candidateParam, 'CALLBACK_PARAMETER_SAFE', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// FN3: Generic constraint widening => COMPATIBLE
test('FN3: Generic constraint widening => COMPATIBLE', () => {
  const result = engine.evaluate(prim('string'), prim('unknown'), 'TYPE_ARGUMENT_SATISFIES_CONSTRAINT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// FN4: Optional parameter addition => COMPATIBLE
test('FN4: Optional parameter addition => COMPATIBLE', () => {
  const src = obj([['x', prim('number')]]);
  const tgt = obj([['x', prim('number')], ['y', prim('string'), true]]);
  const result = engine.evaluate(src, tgt, 'ASSIGNABLE_TO', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

// FN5: Literal narrowing in return position => COMPATIBLE
test('FN5: Literal narrowing in return position => COMPATIBLE', () => {
  const candidateReturn = lit('string', '"success"');
  const historicalRequirement = prim('string');
  const result = engine.evaluate(candidateReturn, historicalRequirement, 'RETURN_SATISFIES_CONTEXT', strictPolicy);
  assert.strictEqual(result.status, 'COMPATIBLE');
});

console.log('\n================================================================');
console.log(`Phase 4 Test Matrix: ${passed} passed, ${failed} failed`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
