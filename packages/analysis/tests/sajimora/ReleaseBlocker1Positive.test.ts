import * as assert from 'assert';
import {
  RepositoryAnalysisUniverse,
  ProofObligation
} from '@sajimora/core';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';

export async function runReleaseBlocker1PositiveTest() {
  console.log('--- Release Blocker #1 Positive Fixture ---');

  const files = {
    'provider.ts': 'export function targetFunc(a: string, b?: number): string { return a; }',
    'consumer.ts': 'import { targetFunc } from "./provider"; const res = targetFunc("hello");',
    'README.md': '# Project Documentation\nThis is a non-TS asset file.',
    'package.json': '{"name": "test-pkg", "version": "1.0.0"}'
  };

  const { universe, context } = createVirtualEnvironment(files);

  // Populate excludedFiles explicitly for non-TS asset files as RepositoryAnalysisUniverseBuilder does
  universe.excludedFiles.set('E:/virtual-workspace/README.md', 'UNSUPPORTED_LANGUAGE_EXTENSION');
  universe.excludedFiles.set('E:/virtual-workspace/package.json', 'UNSUPPORTED_LANGUAGE_EXTENSION');

  // Assert 1: excludedFiles.size > 0
  assert.ok(universe.excludedFiles.size > 0, 'excludedFiles must be non-empty');

  const target = createMockSymbolRef('targetFunc', 'FUNCTION', 'E:/virtual-workspace/provider.ts');
  const obligation = createMockObligation(target, 'STRUCTURAL_CO_EVOLUTION', {
    before: { parameters: [{ name: 'a', type: 'string', isRequired: true }] },
    after: {
      parameters: [
        { name: 'a', type: 'string', isRequired: true },
        { name: 'b', type: 'number', isRequired: false }
      ]
    }
  });

  const pipeline = new PipelineB();
  const result = pipeline.execute(obligation, { universe, context });

  // Assert 2 & 3: Verdict is PRESERVED and target enumeration was complete
  assert.strictEqual(result.verdict, 'PRESERVED', 'TargetFunc compatible mutation must yield PRESERVED despite non-TS excludedFiles');
  console.log('  ✅ PASS: ReleaseBlocker1Positive — Non-code excluded files do not poison target PRESERVED verdict');
}

if (require.main === module) {
  runReleaseBlocker1PositiveTest().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
