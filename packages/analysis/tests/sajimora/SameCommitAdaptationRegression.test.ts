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
import { LiveProgramSemanticProvider } from '../../src/sajimora/compatibility/LiveProgramSemanticProvider';
import { ConsumerDiscoveryCoordinator } from '../../src/sajimora/closures/ConsumerDiscoveryCoordinator';
import { TypeScriptCrossVersionIdentityAnalyzer } from '../../src/sajimora/languages/typescript/identity/TypeScriptCrossVersionIdentity';

console.log('================================================================');
console.log('Sajimora — Same-Commit Adaptation Regression Suite');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      res.then(() => {
        console.log(`  ✅ PASS: ${name}`);
        passed++;
      }).catch(err => {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(err);
        failed++;
      });
    } else {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Incompatible same-commit consumer call MUST emit VIOLATED
// -----------------------------------------------------------------------------
test('Same-commit consumer modified with incompatible argument emits VIOLATED', () => {
  const root = 'E:/vroot-same-commit-incompat';
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: string): string { return x; }',
    'src/consumer.ts': 'import { f } from "./provider"; export const r = f("valid");'
  }, root);

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): string { return String(x); }',
    'src/consumer.ts': 'import { f } from "./provider"; export const r = f("still string");'
  }, root);

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const target = createMockSymbolRef('f', 'FUNCTION', `${root}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(parentEnv.context, target, parentEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map(o => o.occurrenceId);
  assert.ok(discoveredIds.length > 0, 'Parent consumer call site must be discovered');

  const pipeline = new PipelineB();
  const res = pipeline.execute(obligation, {
    context: parentEnv.context,
    universe: parentEnv.universe,
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation }),
    parentProgram: parentProg,
    candidateProgram: candProg,
    discoveredHistoricalConsumerIds: discoveredIds
  });

  assert.strictEqual(
    res.verdict,
    'VIOLATED',
    `Same-commit consumer calling f with incompatible type ("still string" to number) must emit VIOLATED, got ${res.verdict}`
  );
  assert.ok(
    res.auditTrace?.authorityDecision?.reason === 'INCOMPATIBLE_CONSUMER' || res.auditTrace?.authorityDecision?.gate === 'VIOLATED_CHECK',
    'Audit trace must indicate violation at Gate 1'
  );
});

// -----------------------------------------------------------------------------
// Test 2: Compatible same-commit consumer call emits PRESERVED
// -----------------------------------------------------------------------------
test('Same-commit consumer with parameter widening preserves compatibility and emits PRESERVED', () => {
  const root = 'E:/vroot-same-commit-compat';
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number): number { return x; }',
    'src/consumer.ts': 'import { f } from "./provider"; export const r = f(42);'
  }, root);

  const candEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function f(x: number | string): number { return 0; }',
    'src/consumer.ts': 'import { f } from "./provider"; export const r = f(42);'
  }, root);

  const parentProg = parentEnv.context.getProgram();
  const candProg = candEnv.context.getProgram();

  const target = createMockSymbolRef('f', 'FUNCTION', `${root}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(parentEnv.context, target, parentEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map(o => o.occurrenceId);
  assert.ok(discoveredIds.length > 0, 'Parent consumer call site must be discovered');

  const pipeline = new PipelineB();
  const res = pipeline.execute(obligation, {
    context: parentEnv.context,
    universe: parentEnv.universe,
    isPhase4Mode: true,
    provider: new LiveProgramSemanticProvider({ parentProgram: parentProg, candidateProgram: candProg, obligation }),
    parentProgram: parentProg,
    candidateProgram: candProg,
    discoveredHistoricalConsumerIds: discoveredIds
  });

  assert.strictEqual(
    res.verdict,
    'PRESERVED',
    `Widened parameter with compatible same-commit caller must emit PRESERVED, got ${res.verdict}`
  );
});

// -----------------------------------------------------------------------------
// Test 3: Uncertain target identity in modified file strictly emits UNKNOWN
// -----------------------------------------------------------------------------
test('Uncertain target identity strictly emits UNKNOWN and halts at Gate 5', () => {
  const root = 'E:/vroot-same-commit-uncertain';
  const parentEnv = createVirtualEnvironment({
    'src/provider.ts': 'export function target(x: string): string { return x; }',
    'src/consumer.ts': 'import { target } from "./provider"; export const r = target("valid");'
  }, root);

  const target = createMockSymbolRef('target', 'FUNCTION', `${root}/src/provider.ts`);
  const obligation = createMockObligation(target, 'INTERFACE_PRESERVATION');

  const discovery = new ConsumerDiscoveryCoordinator().discover(parentEnv.context, target, parentEnv.universe);
  const discoveredIds = discovery.rollup.occurrences.map(o => o.occurrenceId);

  const pipeline = new PipelineB();

  const res = pipeline.execute(obligation, {
    context: parentEnv.context,
    universe: parentEnv.universe,
    isPhase4Mode: true,
    discoveredHistoricalConsumerIds: discoveredIds,
    crossVersionIdentity: {
      targetMappings: [{
        parent: {
          identityId: obligation.mutatedSymbol!.persistentSymbolId!,
          projectId: 'p0',
          moduleIdentity: 'src/provider.ts',
          ownerChain: [],
          localName: 'target',
          declarationKind: 'FunctionDeclaration',
          declarationOrdinal: 0,
          sourceSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 10 },
          exportPaths: ['target'],
          parameterShape: '()',
          astFingerprint: 'fp'
        },
        status: 'UNRESOLVED',
        evidence: [],
        plausibleCandidateIds: []
      }],
      consumerMappings: [{
        mappingId: 'cm1',
        lifecycle: 'STABLE_UNCHANGED',
        targetIdentity: 'UNCERTAIN',
        evidence: []
      }],
      status: 'INCOMPLETE',
      blockers: ['UNRESOLVED:target'],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    }
  });

  assert.strictEqual(
    res.verdict,
    'UNKNOWN',
    `Target identity UNCERTAIN must produce UNKNOWN, got ${res.verdict}`
  );
  assert.strictEqual(
    res.auditTrace?.authorityDecision?.gate,
    'IDENTITY',
    'Must halt at Gate 5 (IDENTITY)'
  );
});

console.log('\nResults summary:');
setTimeout(() => {
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}, 100);
