/**
 * Sajimora V32.9-TS — Controlled Multi-Project Workspace Validation
 *
 * Exercises the production pipeline across a realistic 3-package monorepo workspace:
 *   packages/core/   — core domain interfaces/functions
 *   packages/utils/  — helper functions & re-exports
 *   packages/app/    — application consuming core and utils
 *
 * Scenarios:
 *   Scenario A — Internal dependency discovery across package boundaries
 *   Scenario B — Cross-package mutation tracking (breaking change propagation)
 *   Scenario C — Unrelated uncertainty in package C does not poison target A in package B
 *   Scenario D — Cross-package path alias and re-export chain identity tracking
 */

import * as assert from 'assert';
import * as ts from 'typescript';
import {
  SymbolRef,
  ProofObligation,
  isSourceInUniverse,
  normalizeModuleIdentity,
  normalizePath
} from '@sajimora/core';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { ValueReferenceClosure } from '../../src/sajimora/closures/ValueReferenceClosure';
import { TypeReferenceClosure } from '../../src/sajimora/closures/TypeReferenceClosure';
import { ReExportClosure } from '../../src/sajimora/closures/ReExportClosure';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     → ${err && err.stack ? err.stack : err}`);
    failed++;
  }
}

async function runMultiProjectSuite() {
  console.log('\n================================================================');
  console.log('Sajimora V32.9-TS — Controlled Multi-Project Workspace Suite');
  console.log('================================================================\n');

  const workspaceRoot = 'E:/monorepo-workspace';

  // 1. Scenario A — Internal Dependency Discovery Across Package Boundaries
  await test('Scenario A — Internal dependency discovery across package boundaries', () => {
    const files = {
      'packages/core/src/service.ts': 'export function coreService(id: string): string { return id; }',
      'packages/utils/src/helper.ts': 'import { coreService } from "../../core/src/service"; export function callService(id: string) { return coreService(id); }',
      'packages/app/src/main.ts': 'import { callService } from "../../utils/src/helper"; callService("123");'
    };

    const { universe, context } = createVirtualEnvironment(files, workspaceRoot);

    // Verify all 3 files are in discovered universe
    assert.strictEqual(universe.discoveredFiles.length, 3, 'All 3 multi-package files discovered');
    assert.ok(universe.discoveredFiles.some(f => f.includes('packages/core/src/service.ts')), 'core service discovered');
    assert.ok(universe.discoveredFiles.some(f => f.includes('packages/utils/src/helper.ts')), 'utils helper discovered');
    assert.ok(universe.discoveredFiles.some(f => f.includes('packages/app/src/main.ts')), 'app main discovered');

    // Execute ValueReferenceClosure for coreService
    const target = createMockSymbolRef('coreService', 'FUNCTION', `${workspaceRoot}/packages/core/src/service.ts`);
    const closure = new ValueReferenceClosure();
    const evidence = closure.execute(context, target, universe);

    assert.strictEqual(evidence.completeness, 'COMPLETE', 'Multi-package closure enumeration complete');
    assert.ok(evidence.occurrences.some(o => o.sourceFile.includes('packages/utils/src/helper.ts')), 'Found occurrence in packages/utils');
  });

  // 2. Scenario B — Cross-Package Mutation Tracking (Breaking Change Propagation)
  await test('Scenario B — Cross-package breaking mutation yields VIOLATED', () => {
    const files = {
      'packages/core/src/api.ts': 'export function fetchData(url: string): string { return url; }',
      'packages/app/src/consumer.ts': 'import { fetchData } from "../../core/src/api"; const d = fetchData("http://api");'
    };

    const { universe, context } = createVirtualEnvironment(files, workspaceRoot);
    const target = createMockSymbolRef('fetchData', 'FUNCTION', `${workspaceRoot}/packages/core/src/api.ts`);

    // Incompatible mutation: required param added
    const obligation = createMockObligation(target, 'STRUCTURAL_CO_EVOLUTION', {
      before: { parameters: [{ name: 'url', type: 'string', isRequired: true }] },
      after: {
        parameters: [
          { name: 'url', type: 'string', isRequired: true },
          { name: 'apiKey', type: 'string', isRequired: true }
        ]
      }
    });

    const pipeline = new PipelineB();
    const result = pipeline.execute(obligation, { universe, context });

    assert.strictEqual(
      result.verdict,
      'VIOLATED',
      'Scenario B: Breaking mutation in core package MUST yield VIOLATED for consumer in app package'
    );
  });

  // 3. Scenario C — Unrelated Uncertainty in Package C does not poison Target in Package B
  await test('Scenario C — Unrelated package uncertainty does not poison target proof', () => {
    const files = {
      // Core package: target symbol
      'packages/core/src/target.ts': 'export function targetFn(x: string): string { return x; }',
      // App package: valid clean consumer of target
      'packages/app/src/main.ts': 'import { targetFn } from "../../core/src/target"; targetFn("hello");',
      // Unrelated package C: has an unresolvable wildcard export
      'packages/unrelated/src/barrel.ts': 'export * from "./non-existent-module";'
    };

    const { universe, context } = createVirtualEnvironment(files, workspaceRoot);
    const target = createMockSymbolRef('targetFn', 'FUNCTION', `${workspaceRoot}/packages/core/src/target.ts`);

    // Execute ValueReferenceClosure for targetFn
    const valueClosure = new ValueReferenceClosure();
    const evidence = valueClosure.execute(context, target, universe);

    assert.strictEqual(
      evidence.completeness,
      'COMPLETE',
      'Scenario C: Target closure for targetFn MUST remain COMPLETE despite unrelated wildcard in packages/unrelated'
    );

    // Run full pipeline with compatible mutation
    const obligation = createMockObligation(target, 'STRUCTURAL_CO_EVOLUTION', {
      before: { parameters: [{ name: 'x', type: 'string', isRequired: true }] },
      after: { parameters: [{ name: 'x', type: 'string', isRequired: true }] }
    });

    const pipeline = new PipelineB();
    const result = pipeline.execute(obligation, { universe, context });

    assert.strictEqual(
      result.verdict,
      'PRESERVED',
      'Scenario C: Target proof MUST be PRESERVED — target-scoped uncertainty isolation invariant'
    );
  });

  // 4. Scenario D — Re-Export / Alias Path Identity Across Packages
  await test('Scenario D — Cross-package re-export chain identity tracking', () => {
    const files = {
      'packages/core/src/auth.ts': 'export function login(): void {}',
      'packages/utils/src/index.ts': 'export { login as doLogin } from "../../core/src/auth";',
      'packages/app/src/client.ts': 'import { doLogin } from "../../utils/src/index"; doLogin();'
    };

    const { universe, context } = createVirtualEnvironment(files, workspaceRoot);
    const target = createMockSymbolRef('login', 'FUNCTION', `${workspaceRoot}/packages/core/src/auth.ts`);

    const reExportClosure = new ReExportClosure();
    const reEvidence = reExportClosure.execute(context, target, universe);

    assert.ok(
      reEvidence.occurrences.some(o => o.sourceFile.includes('packages/utils/src/index.ts')),
      'Scenario D: ReExportClosure discovers re-exporter in packages/utils'
    );

    const valClosure = new ValueReferenceClosure();
    const valEvidence = valClosure.execute(context, target, universe);

    assert.ok(
      valEvidence.occurrences.some(o => o.sourceFile.includes('packages/app/src/client.ts')),
      'Scenario D: ValueReferenceClosure discovers downstream consumer in packages/app via re-export'
    );
  });

  console.log('\n================================================================');
  console.log(`Multi-Project Workspace Suite: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runMultiProjectSuite().catch(err => {
  console.error('MultiProjectSuite error:', err);
  process.exit(1);
});
