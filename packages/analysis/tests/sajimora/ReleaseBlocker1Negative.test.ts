import * as assert from 'assert';
import {
  RepositoryAnalysisUniverse,
  ProofObligation
} from '@sajimora/core';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';

export async function runReleaseBlocker1NegativeTest() {
  console.log('--- Release Blocker #1 Negative Fixture ---');

  // Architecture-native excluded target-relevant file test:
  // provider.ts exports targetFunc whose signature references TargetType from types.ts.
  // consumer.ts imports targetFunc and calls it with a TargetType argument.
  // types.ts is a target-relevant source file that is excluded from discovery (placed in excludedFiles).
  const files = {
    'provider.ts': 'import { TargetType } from "./types"; export function targetFunc(arg: TargetType): void {}',
    'consumer.ts': 'import { targetFunc } from "./provider"; targetFunc({ id: "123" });',
    'types.ts': 'export interface TargetType { id: string; }'
  };

  const { universe, context } = createVirtualEnvironment(files);

  const typesPath = 'E:/virtual-workspace/types.ts';
  universe.excludedFiles.set(typesPath, 'TSCONFIG_ERROR: Target-relevant type definition file excluded from discovery');

  // Remove types.ts from discoveredFiles so it is truly excluded from the analysis universe
  const idx = universe.discoveredFiles.indexOf(typesPath);
  if (idx !== -1) {
    universe.discoveredFiles.splice(idx, 1);
  }
  universe.discoveredFileSet.delete(typesPath);

  // Assert 1: excludedFiles.size > 0 and contains the target-relevant excluded file
  assert.ok(universe.excludedFiles.size > 0, 'excludedFiles must be non-empty');
  assert.ok(universe.excludedFiles.has(typesPath), 'target-relevant types.ts must be in excludedFiles');

  // Assert 2: parseFailures MUST NOT be manually injected (must be zero)
  assert.strictEqual(universe.parseFailures.size, 0, 'parseFailures must be zero; UNKNOWN must be driven by target-relevant excluded file');

  const target = createMockSymbolRef('targetFunc', 'FUNCTION', 'E:/virtual-workspace/provider.ts');
  const obligation = createMockObligation(target, 'STRUCTURAL_CO_EVOLUTION', {
    before: { parameters: [{ name: 'arg', type: 'TargetType', isRequired: true }] },
    after: { parameters: [{ name: 'arg', type: 'TargetType', isRequired: true }] }
  });

  const pipeline = new PipelineB();
  const result = pipeline.execute(obligation, { universe, context });

  // Assert 3: Target cannot be proven complete because the excluded target-relevant file leaves an unresolved evidence obligation
  assert.strictEqual(result.verdict, 'UNKNOWN', 'Target with excluded target-relevant type definition file must fail-closed to UNKNOWN');
  assert.notStrictEqual(result.verdict, 'PRESERVED', 'Must never emit PRESERVED when target-relevant file is excluded');
  console.log('  ✅ PASS: ReleaseBlocker1Negative — Target-relevant excluded file drives UNKNOWN without parseFailure injection');
}

if (require.main === module) {
  runReleaseBlocker1NegativeTest().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
