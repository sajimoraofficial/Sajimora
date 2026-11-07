import * as assert from 'node:assert';
import * as ts from 'typescript';
import {
  ProofObligation,
  UsageSite,
  VerdictAuthority,
  CompleteProofEvidence,
  CrossVersionIdentityBundle,
  CanonicalSymbolIdentity,
  CanonicalReferenceOccurrence
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
  TSR4PrimitiveIdentityRule,
  TSR5LiteralToPrimitiveRule,
  TSR13CallableSubtypingRule
} from '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules';
import { AuthorityIntegrationLayer } from '../../src/sajimora/compatibility/AuthorityIntegrationLayer';
import { ProofTreeBuilder } from '../../src/sajimora/compatibility/ProofTreeBuilder';
import { WitnessGenerator } from '../../src/sajimora/compatibility/WitnessGenerator';
import { ConsumerDiscoveryCoordinator } from '../../src/sajimora/closures/ConsumerDiscoveryCoordinator';
import {
  TypeScriptClosureReferenceIndexer,
  TypeScriptConsumerIdentityMapper
} from '../../src/sajimora/languages/typescript/identity/TypeScriptCrossVersionIdentity';
import { TypeScriptProgramBuildResult } from '../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder';
import {
  ObjectTypeIR,
  CallableTypeIR,
  PrimitiveTypeIR,
  LiteralTypeIR,
  TypeScriptTypeIR
} from '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR';

console.log('================================================================');
console.log('Sajimora Phase 4 — Hostile Audit 13 P1 Gaps Regression Suite');
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

function makeObligation(id: string, name: string, path = 'src/provider.ts'): ProofObligation {
  return {
    invariantId: id,
    relation: 'INTERFACE_PRESERVATION',
    mutatedSymbol: {
      persistentSymbolId: `decl:${path}#${name}`,
      fingerprint: {
        value: `fp-${name}`,
        components: {
          globallyQualifiedOwner: `${path}::${name}`,
          symbolLocalName: name,
          kind: 'FUNCTION',
          parameterTypeFingerprint: '()'
        }
      },
      qualifiedName: `${path}#${name}`,
      kind: 'FUNCTION',
      ownerId: null,
      declarationLocation: { filePath: path, line: 1 }
    },
    providerMutation: {
      targetSymbolId: `decl:${path}#${name}`,
      beforeExists: true,
      afterExists: true,
      classification: 'EXPORTED_SIGNATURE_MUTATED',
      isAstDiffDerived: true,
      beforeParsed: true,
      afterParsed: true
    }
  };
}

function createCallSite(callNode: ts.CallExpression, fileUri: string, occId = 'occ-call'): UsageSite {
  return {
    usageSiteId: occId,
    canonicalOccurrence: {
      occurrenceId: occId,
      sourceFile: fileUri,
      sourceSpan: { start: callNode.getStart(), end: callNode.getEnd(), line: 1, column: 1 },
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
}

function findFirstCall(root: ts.Node): ts.CallExpression | undefined {
  let callNode: ts.CallExpression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && !callNode) {
      callNode = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return callNode;
}

// -----------------------------------------------------------------------------
// Finding 1: Production verdicts bypass Phase 4
// -----------------------------------------------------------------------------
test('P1 #1: Production verdicts enforce return obligations and produce VIOLATED for f():number -> f():string', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): number { return 1; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r: number = f();'
  }, 'E:/vroot-g1');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): string { return "a"; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r: number = f();'
  }, 'E:/vroot-g1');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(pEnv.context, target, pEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map((o: any) => o.occurrenceId);
  assert.ok(discoveredIds.length > 0, 'Consumer call site must be discovered');

  const pipeline = new PipelineB();
  const res = pipeline.execute(obligation, {
    context: pEnv.context,
    universe: pEnv.universe,
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation }),
    discoveredHistoricalConsumerIds: discoveredIds
  });

  assert.strictEqual(res.verdict, 'VIOLATED', 'Changing return type from number to string must produce VIOLATED');
});

// -----------------------------------------------------------------------------
// Finding 2: Real identity evidence creates false coverage gaps
// -----------------------------------------------------------------------------
test('P1 #2: Closure reference indexer preserves discovery IDs but mismatched target identity fails closed', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number | string): number { return 0; }',
    'src/consumer.ts': 'import { f } from "./provider"; f(42);'
  }, 'E:/vroot-g2');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: string | number): number { return 0; }',
    'src/consumer.ts': 'import { f } from "./provider"; f(42);'
  }, 'E:/vroot-g2');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const target = createMockSymbolRef('f', 'FUNCTION', `${pEnv.rootDir}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(pEnv.context, target, pEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map((o: any) => o.occurrenceId);
  assert.ok(discoveredIds.length > 0, 'Consumer call site must be discovered');

  const pBuild: TypeScriptProgramBuildResult = {
    status: 'BUILT',
    projects: [{
      identity: { projectId: 'p1', rootDir: pEnv.rootDir, configPath: `${pEnv.rootDir}/tsconfig.json` } as any,
      program: pProg,
      options: {}
    }],
    universe: pEnv.universe as any
  };

  const cBuild: TypeScriptProgramBuildResult = {
    status: 'BUILT',
    projects: [{
      identity: { projectId: 'p1', rootDir: cEnv.rootDir, configPath: `${cEnv.rootDir}/tsconfig.json` } as any,
      program: cProg,
      options: {}
    }],
    universe: cEnv.universe as any
  };

  const targetId: CanonicalSymbolIdentity = {
    identityId: `decl:src/provider.ts#f`,
    projectId: 'p1',
    moduleIdentity: 'src/provider.ts',
    ownerChain: [],
    localName: 'f',
    declarationKind: 'FunctionDeclaration',
    declarationOrdinal: 0,
    sourceSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 10 },
    exportPaths: ['src/provider.ts#f'],
    parameterShape: '()',
    astFingerprint: 'fp-f'
  };

  const indexer = new TypeScriptClosureReferenceIndexer();
  const pOccs = indexer.index(pBuild, pEnv.rootDir, targetId);
  const cOccs = indexer.index(cBuild, cEnv.rootDir, targetId);

  // Assert that discovery occurrence IDs are preserved in indexer output
  assert.ok(pOccs.length > 0, 'Parent occurrences indexed');
  assert.ok(cOccs.length > 0, 'Candidate occurrences indexed');
  assert.strictEqual(pOccs[0].occurrenceId, discovery.rollup.occurrences[0].occurrenceId, 'Occurrence ID must match discovery ID');

  const mapper = new TypeScriptConsumerIdentityMapper();
  const consumerMappings = mapper.map(pOccs, cOccs);

  const bundle: CrossVersionIdentityBundle = {
    targetMappings: [{
      parent: targetId,
      candidate: targetId,
      status: 'SAME_DECLARATION',
      evidence: [],
      plausibleCandidateIds: []
    }],
    consumerMappings,
    status: 'COMPLETE',
    blockers: [],
    phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
    boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
  };

  const pipeline = new PipelineB();
  const res = pipeline.execute(obligation, {
    context: pEnv.context,
    universe: pEnv.universe,
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation }),
    crossVersionIdentity: bundle,
    discoveredHistoricalConsumerIds: discoveredIds
  });

  assert.strictEqual(res.verdict, 'UNKNOWN', 'A mapping for a different parent identity cannot prove this obligation');
  assert.ok((res.auditTrace?.proofDiagnostics as any)?.obligation?.blockers?.includes('TARGET_MAPPING_NOT_PROVEN'));
});

// -----------------------------------------------------------------------------
// Finding 3: Candidate offsets interpreted as historical offsets
// -----------------------------------------------------------------------------
test('P1 #3: Specialization uses parent occurrence offsets even when candidate moves call site', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): number { return x; }',
    'src/consumer.ts': 'import { f } from "./provider"; f(42);'
  }, 'E:/vroot-g3');

  // Candidate adds several comment lines moving f(42) to line 7
  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number | string): number { return 0; }',
    'src/consumer.ts': '// line 1\n// line 2\n// line 3\n// line 4\n// line 5\nimport { f } from "./provider"; f(42);'
  }, 'E:/vroot-g3');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const cSF = cProg.getSourceFile(`${cEnv.rootDir}/src/consumer.ts`)!;

  const pCall = findFirstCall(pSF)!;
  const cCall = findFirstCall(cSF)!;

  assert.notStrictEqual(pCall.getStart(), cCall.getStart(), 'Parent and candidate call sites must be at different spans');

  const obligation = makeObligation('obl-g3', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  // Candidate site with candidate span, but carrying parentCanonicalOccurrence with parent span
  const site: UsageSite = {
    usageSiteId: 'c-site-1',
    canonicalOccurrence: {
      occurrenceId: 'c-site-1',
      sourceFile: `${cEnv.rootDir}/src/consumer.ts`,
      sourceSpan: { start: cCall.getStart(), end: cCall.getEnd(), line: 7, column: 33 },
      syntaxKind: cCall.kind,
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

  (site as any).parentCanonicalOccurrence = {
    occurrenceId: 'p-site-1',
    sourceFile: `${pEnv.rootDir}/src/consumer.ts`,
    sourceSpan: { start: pCall.getStart(), end: pCall.getEnd(), line: 1, column: 33 },
    syntaxKind: pCall.kind,
    semanticRole: 'VALUE',
    usageRole: 'CALL_SITE',
    referencedSymbol: 'decl:src/provider.ts#f',
    declarationSymbol: 'decl:src/provider.ts#f',
    resolutionStatus: 'RESOLVED',
    enumerationStatus: 'COMPLETE',
    provenance: []
  };

  const result = compat.evaluateSite(site);
  assert.strictEqual(result.status, 'COMPATIBLE', 'Specialization must resolve parent node and succeed');
});

// -----------------------------------------------------------------------------
// Finding 4: Explicit this requirements disappear
// -----------------------------------------------------------------------------
test('P1 #4: Candidate signature requiring explicit this parameter rejects call without receiver', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(1);'
  }, 'E:/vroot-g4');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(this: { ready: true }, x: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(1);'
  }, 'E:/vroot-g4');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g4', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Missing receiver for explicit this must be INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'RECEIVER_OBLIGATION_VIOLATED');
});

// -----------------------------------------------------------------------------
// Finding 5: Predicate and assertion effects are erased
// -----------------------------------------------------------------------------
test('P1 #5: Replacing type predicate (x is string) with boolean produces INCOMPATIBLE/PREDICATE_EFFECT_DROPPED', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: any): x is string { return typeof x === "string"; }',
    'src/consumer.ts': 'import { f } from "./provider"; const x: any = "hi"; if (f(x)) { const s: string = x; }'
  }, 'E:/vroot-g5a');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: any): boolean { return typeof x === "string"; }',
    'src/consumer.ts': 'import { f } from "./provider"; const x: any = "hi"; if (f(x)) { const s: string = x; }'
  }, 'E:/vroot-g5a');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g5a', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Dropping type predicate effect must be INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'PREDICATE_EFFECT_DROPPED');
});

test('P1 #5b: Replacing assertion (asserts x is string) with void produces INCOMPATIBLE/PREDICATE_EFFECT_DROPPED', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: any): asserts x is string { if (typeof x !== "string") throw new Error(); }',
    'src/consumer.ts': 'import { f } from "./provider"; const x: any = "hi"; f(x); const s: string = x;'
  }, 'E:/vroot-g5b');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: any): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; const x: any = "hi"; f(x); const s: string = x;'
  }, 'E:/vroot-g5b');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g5b', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Dropping assertion effect must be INCOMPATIBLE');
  assert.strictEqual(result.phase4Evidence?.witness?.ruleId, 'PREDICATE_EFFECT_DROPPED');
});

// -----------------------------------------------------------------------------
// Finding 6: Declaration-order scanning still selects incorrect overloads
// -----------------------------------------------------------------------------
test('P1 #6: Candidate overload order conflicting with specialized selection returns UNDECIDABLE', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: string): number { return 1; }',
    'src/consumer.ts': 'import { f } from "./provider"; const a: number = f("a");'
  }, 'E:/vroot-g6');

  // Candidate puts non-specialized f(string):number before specialized f("a"):string
  // In TS, f("a") selects f("a"):string which returns string (incompatible with number)
  // But declaration-order scanning without safeguard would pick f(string):number and falsely say COMPATIBLE
  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: string): number; export function f(x: "a"): string; export function f(x: any): any { return "a"; }',
    'src/consumer.ts': 'import { f } from "./provider"; const a: number = f("a");'
  }, 'E:/vroot-g6');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g6', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  // Case 6a: Must NOT return COMPATIBLE; because candidate overload resolution selects f("a"):string, return is INCOMPATIBLE with number context
  assert.notStrictEqual(result.status, 'COMPATIBLE', 'Conflicting candidate overload order must NOT return COMPATIBLE');
  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Selected candidate overload returns string, which is INCOMPATIBLE with number context');

  // Case 6b: Earlier candidate signature has undecidable argument without candidate call site -> returns UNDECIDABLE
  const cEnvUndec = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: any): string; export function f(x: string): number; export function f(x: any): any { return "a"; }',
    'src/other.ts': 'export const dummy = 1;'
  }, 'E:/vroot-g6b');
  const compatUndec = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cEnvUndec.context.getProgram(), obligation })
  });
  const resUndec = compatUndec.evaluateSite(site);
  assert.strictEqual(resUndec.status, 'UNDECIDABLE', 'Earlier undecidable overload must block compatibility and return UNDECIDABLE');
});

// -----------------------------------------------------------------------------
// Finding 7: Distinct enum types collapse to equal literals
// -----------------------------------------------------------------------------
test('P1 #7: Distinct enums with same numeric value fail compatibility with LITERAL_VALUE_MISMATCH', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export enum A { X = 0 } export function f(x: A): void {}',
    'src/consumer.ts': 'import { A, f } from "./provider"; f(A.X);'
  }, 'E:/vroot-g7');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export enum B { X = 0 } export function f(x: B): void {}',
    'src/consumer.ts': 'import { B, f } from "./provider"; f(B.X);'
  }, 'E:/vroot-g7');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g7', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Passing enum A to enum B must be INCOMPATIBLE');
  assert.ok(
    result.phase4Evidence?.witness?.ruleId === 'LITERAL_VALUE_MISMATCH' ||
    result.phase4Evidence?.witness?.ruleId === 'TSR5_LITERAL_PRIMITIVE_MISMATCH' ||
    result.phase4Evidence?.witness?.ruleId === 'TS_R5_LITERAL_TO_PRIMITIVE',
    `Expected literal mismatch witness, got ${result.phase4Evidence?.witness?.ruleId}`
  );
});

// -----------------------------------------------------------------------------
// Finding 8: Optional, defaulted, and rest parameters become required
// -----------------------------------------------------------------------------
test('P1 #8: Adding optional, defaulted, or rest parameters does not reject zero-argument historical calls', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-g8');

  // Candidate 1: optional parameter
  const cEnvOpt = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x?: number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-g8');

  // Candidate 2: defaulted parameter
  const cEnvDef = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number = 1): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-g8');

  // Candidate 3: rest parameter
  const cEnvRest = createVirtualEnvironment({
    'src/provider.ts': 'export function f(...xs: number[]): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f();'
  }, 'E:/vroot-g8');

  const pProg = pEnv.context.getProgram();
  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;
  const obligation = makeObligation('obl-g8', 'f');
  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);

  for (const [name, cEnv] of [
    ['optional parameter', cEnvOpt],
    ['defaulted parameter', cEnvDef],
    ['rest parameter', cEnvRest]
  ] as const) {
    const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
      isPhase4Mode: true,
      provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cEnv.context.getProgram(), obligation })
    });
    const result = compat.evaluateSite(site);
    assert.strictEqual(result.status, 'COMPATIBLE', `Adding ${name} must keep f() COMPATIBLE`);
  }
});

// -----------------------------------------------------------------------------
// Finding 9: Mutable dictionaries qualify for the immutable-return exception
// -----------------------------------------------------------------------------
test('P1 #9: Narrowed mutable dictionary return with downstream write rejects covariance and returns INCOMPATIBLE', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { [k: string]: string | number } { return {}; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); const a = r; a.k = 1;'
  }, 'E:/vroot-g9');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { [k: string]: string } { return {}; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); const a = r; a.k = 1;'
  }, 'E:/vroot-g9');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g9', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'INCOMPATIBLE', 'Mutable dictionary return with downstream write must be INCOMPATIBLE');
});

// -----------------------------------------------------------------------------
// Finding 10: An unrelated readonly property causes a false violation
// -----------------------------------------------------------------------------
test('P1 #10: Writing to mutable property in an object with unrelated readonly property is COMPATIBLE', () => {
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { readonly id: number; name: string } { return { id: 1, name: "init" }; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); r.name = "a";'
  }, 'E:/vroot-g10');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(): { readonly id: number; name: string } { return { id: 2, name: "updated" }; }',
    'src/consumer.ts': 'import { f } from "./provider"; const r = f(); r.name = "a";'
  }, 'E:/vroot-g10');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g10', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'COMPATIBLE', 'Writing to mutable name must remain COMPATIBLE despite readonly id');
});

// -----------------------------------------------------------------------------
// Finding 11: Valid void compatibility is rejected
// -----------------------------------------------------------------------------
test('P1 #11: Widening callback return to void and passing undefined to void are COMPATIBLE', () => {
  // Case A: callback widening (() => number) -> (() => void)
  const pEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(cb: () => number): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(() => 1);'
  }, 'E:/vroot-g11');

  const cEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(cb: () => void): void {}',
    'src/consumer.ts': 'import { f } from "./provider"; f(() => 1);'
  }, 'E:/vroot-g11');

  const pProg = pEnv.context.getProgram();
  const cProg = cEnv.context.getProgram();

  const pSF = pProg.getSourceFile(`${pEnv.rootDir}/src/consumer.ts`)!;
  const callNode = findFirstCall(pSF)!;

  const obligation = makeObligation('obl-g11', 'f');
  const compat = new TypeScriptCompatibility(pEnv.context, obligation, {
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: pProg, candidateProgram: cProg, obligation })
  });

  const site = createCallSite(callNode, `${pEnv.rootDir}/src/consumer.ts`);
  const result = compat.evaluateSite(site);

  assert.strictEqual(result.status, 'COMPATIBLE', 'Widening callback parameter to () => void must be COMPATIBLE');

  // Case B: undefined to void in primitive identity rule
  const undefIR = TypeScriptTypeIRExtractor.createPrimitiveIR('undefined', 'PARENT');
  const voidIR = TypeScriptTypeIRExtractor.createPrimitiveIR('void', 'CANDIDATE');
  const ruleResult = new TSR4PrimitiveIdentityRule().evaluate(undefIR, voidIR, 'ASSIGNABLE_TO');

  assert.strictEqual(ruleResult.status, 'COMPATIBLE', 'undefined assigned to void must be COMPATIBLE');
});

// -----------------------------------------------------------------------------
// Finding 12: Compiler allocation IDs enter canonical hashes
// -----------------------------------------------------------------------------
test('P1 #12: Unique symbol properties produce identical IR hashes across independent programs', () => {
  const code = `
    export const key: unique symbol = Symbol("myKey");
    export interface I {
      [key]: number;
    }
  `;

  const env1 = createVirtualEnvironment({ 'src/index.ts': code }, 'E:/vroot-g12-1');
  const env2 = createVirtualEnvironment({ 'src/index.ts': code }, 'C:/other-path-g12-2');

  const prog1 = env1.context.getProgram();
  const prog2 = env2.context.getProgram();

  const sf1 = prog1.getSourceFile('E:/vroot-g12-1/src/index.ts')!;
  const sf2 = prog2.getSourceFile('C:/other-path-g12-2/src/index.ts')!;

  const iface1 = sf1.statements.find(ts.isInterfaceDeclaration)!;
  const iface2 = sf2.statements.find(ts.isInterfaceDeclaration)!;

  const type1 = prog1.getTypeChecker().getTypeAtLocation(iface1);
  const type2 = prog2.getTypeChecker().getTypeAtLocation(iface2);

  const ir1 = TypeScriptTypeIRExtractor.extractFromType(type1, prog1.getTypeChecker(), 'PARENT', sf1, {
    snapshotRoot: env1.rootDir
  }) as ObjectTypeIR;
  const ir2 = TypeScriptTypeIRExtractor.extractFromType(type2, prog2.getTypeChecker(), 'CANDIDATE', sf2, {
    snapshotRoot: env2.rootDir
  }) as ObjectTypeIR;

  assert.ok(ir1.properties.length > 0, 'Properties must exist');
  assert.ok(ir2.properties.length > 0, 'Properties must exist');

  const propName1 = ir1.properties[0][0];
  const propName2 = ir2.properties[0][0];

  assert.strictEqual(propName1, propName2, `Symbol property names must match exactly: ${propName1} vs ${propName2}`);
  assert.ok(!propName1.includes('@36'), 'Property name must not contain compiler allocation numbers');
  assert.strictEqual(ir1.irContentHash, ir2.irContentHash, 'IR content hashes must be identical across independent programs');
});

// -----------------------------------------------------------------------------
// Finding 13: Witnessless incompatibility reaches the final authority
// -----------------------------------------------------------------------------
test('P1 #13: Phase 4 demotes witnessless INCOMPATIBLE to UNDECIDABLE/MISSING_INCOMPATIBILITY_WITNESS', () => {
  const obligation = makeObligation('obl-g13', 'f');

  const site: UsageSite = {
    usageSiteId: 'occ-13',
    canonicalOccurrence: {
      occurrenceId: 'occ-13',
      sourceFile: 'src/consumer.ts',
      sourceSpan: { start: 1, end: 10, line: 1, column: 1 },
      syntaxKind: ts.SyntaxKind.CallExpression,
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

  const evidence: CompleteProofEvidence<any> = {
    triggerData: {} as any,
    obligation,
    analysisUniverse: {
      rootPath: 'E:/virtual-workspace',
      discoveredFiles: ['src/provider.ts', 'src/consumer.ts'],
      discoveredFileSet: new Set(['src/provider.ts', 'src/consumer.ts']),
      excludedFiles: new Map(),
      unsupportedFiles: [],
      unreadableFiles: [],
      parseFailures: new Map(),
      discoveryStatus: 'DISCOVERY_COMPLETE',
      discoveryEvidence: 'test'
    },
    closures: {
      valueReference: [] as any,
      typeReference: [] as any,
      inheritance: [] as any,
      interfaceImpl: [] as any,
      override: [] as any,
      reExport: [] as any,
      ambientReference: [] as any
    },
    canonicalOccurrences: [site],
    identityResults: [],
    compatibilityResults: new Map([
      ['occ-13', {
        status: 'INCOMPATIBLE',
        reason: null
      } as any]
    ]),
    semanticScope: {
      unsupportedRelationshipPossible: false
    } as any
  };

  // Case A: Witnessless INCOMPATIBLE (status INCOMPATIBLE, but no valid proof tree or witness)
  const reconciledA = AuthorityIntegrationLayer.reconcileAndIntegrate(evidence, { isPhase4Mode: true });
  const resultA = reconciledA.compatibilityResults.get('occ-13');
  assert.strictEqual(resultA?.status, 'UNDECIDABLE', 'Witnessless INCOMPATIBLE must be demoted to UNDECIDABLE');
  assert.strictEqual(resultA?.reason, 'MISSING_INCOMPATIBILITY_WITNESS');
  const verdictA = VerdictAuthority.evaluateProof(reconciledA);
  assert.strictEqual(verdictA.verdict, 'UNKNOWN', 'Demoted UNDECIDABLE must produce UNKNOWN');

  // Case B: Valid INCOMPATIBLE with proof tree and witness produces VIOLATED
  const validWitness = WitnessGenerator.createWitness({
    consumerLocation: { file: 'src/consumer.ts', line: 1, column: 1 },
    targetDeclaration: { file: 'src/provider.ts', line: 1, column: 1 },
    semanticRelation: 'RETURN_SATISFIES_CONTEXT',
    position: { kind: 'RETURN' },
    parentType: { display: 'number', irContentHash: 'h1' },
    candidateType: { display: 'string', irContentHash: 'h2' },
    failedRelation: 'TSR1_PRIMITIVE_MISMATCH',
    ruleId: 'TSR1_PRIMITIVE_MISMATCH'
  });
  const proofTree = ProofTreeBuilder.createIncompatibleNode({
    relation: 'RETURN_SATISFIES_CONTEXT',
    rule: 'TSR1_PRIMITIVE_MISMATCH',
    adapterId: 'typescript',
    adapterVersion: '1.0.0',
    ruleNamespace: 'typescript-compatibility-v1',
    source: prim('number'),
    target: prim('string'),
    sourceHash: 'h1',
    targetHash: 'h2',
    effectivePolicy: strictPolicy as any,
    witness: validWitness
  });

  const evidenceB: CompleteProofEvidence<any> = {
    ...evidence,
    compatibilityResults: new Map([
      ['occ-13', {
        status: 'INCOMPATIBLE',
        reason: 'Type mismatch',
        phase4Evidence: {
          schemaVersion: 'SAJIMORA_PROOF_TREE_V1',
          proofTree,
          witness: validWitness
        } as any
      }]
    ])
  };

  const reconciledB = AuthorityIntegrationLayer.reconcileAndIntegrate(evidenceB, { isPhase4Mode: true });
  const resultB = reconciledB.compatibilityResults.get('occ-13');
  assert.strictEqual(resultB?.status, 'INCOMPATIBLE', 'Valid INCOMPATIBLE with proof tree and witness must remain INCOMPATIBLE');
  const verdictB = VerdictAuthority.evaluateProof(reconciledB);
  assert.strictEqual(verdictB.verdict, 'VIOLATED', 'Valid INCOMPATIBLE must produce VIOLATED');
});

console.log('\n================================================================');
console.log(`Phase 4 Hostile Audit Gaps 13: ${passed} passed, ${failed} failed`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
