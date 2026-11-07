import * as assert from 'assert';
import { createVirtualEnvironment, createMockSymbolRef, createMockObligation } from './testHarness';
import { InheritanceClosure } from '../../src/sajimora/closures/InheritanceClosure';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';

async function runV1Test() {
  console.log('\n================================================================');
  console.log('Sajimora V32.9-TS — V1 Forced Iteration Limit Verification');
  console.log('================================================================\n');

  // Build a global script chain of 120 extending classes (no import statements):
  // c000.ts: class C000 extends C001 {}
  // c001.ts: class C001 extends C002 {}
  // ...
  // c119.ts: class C119 extends C120 {}
  // c120.ts: class C120 {}  (target)
  //
  // Without top-level module imports, TypeScript parses sourceFiles in file list order (c000 -> c120).
  // On each fixpoint iteration, pass i can only discover 1 new level (C(120-i)), because when c(120-i)
  // is scanned in pass i, its parent C(120-i+1) was added during pass i-1.
  // A chain of 120 global classes requires 120 fixpoint passes to converge, which exceeds maxIterations (100).
  const count = 120;
  const files: Record<string, string> = {};

  for (let i = 0; i < count; i++) {
    const curr = `c${i.toString().padStart(3, '0')}`;
    const currClass = `C${i.toString().padStart(3, '0')}`;
    const nextClass = `C${(i + 1).toString().padStart(3, '0')}`;
    files[`${curr}.ts`] = `class ${currClass} extends ${nextClass} {}`;
  }
  const targetName = `C${count.toString().padStart(3, '0')}`;
  const targetFile = `c${count.toString().padStart(3, '0')}.ts`;
  files[targetFile] = `class ${targetName} {}`;

  const { universe, context } = createVirtualEnvironment(files);
  const target = createMockSymbolRef(targetName, 'CLASS', `E:/virtual-workspace/${targetFile}`);

  // 1. Directly execute InheritanceClosure
  const closure = new InheritanceClosure();
  const evidence = closure.execute(context, target, universe);

  console.log(`Occurrences count: ${evidence.occurrences.length}`);
  console.log(`InheritanceClosure completeness: ${evidence.completeness}`);
  console.log(`Failures count: ${evidence.failures.length}`);
  if (evidence.failures.length > 0) {
    console.log(`Failure cause: ${evidence.failures[0].cause}`);
  }

  // Assertion (a): completeness === 'INCOMPLETE'
  assert.strictEqual(
    evidence.completeness,
    'INCOMPLETE',
    'V1 Assertion (a) failed: completeness MUST be INCOMPLETE when iteration limit is reached'
  );

  // Assertion (b): failure code === 'FIXPOINT_ITERATION_LIMIT_EXCEEDED'
  const hasLimitFailure = evidence.failures.some(f => f.cause === 'FIXPOINT_ITERATION_LIMIT_EXCEEDED');
  assert.ok(
    hasLimitFailure,
    'V1 Assertion (b) failed: failures MUST contain cause FIXPOINT_ITERATION_LIMIT_EXCEEDED'
  );

  // 2. Execute full PipelineB for target with a compatible mutation
  const obligation = createMockObligation(target, 'STRUCTURAL_CO_EVOLUTION', {
    before: { parameters: [] },
    after: { parameters: [] }
  });
  const pipeline = new PipelineB();
  const result = pipeline.execute(obligation, { universe, context });

  console.log(`Full pipeline verdict: ${result.verdict}`);

  // Assertion (c): full-pipeline verdict is UNKNOWN and NEVER PRESERVED
  assert.strictEqual(
    result.verdict,
    'UNKNOWN',
    'V1 Assertion (c) failed: full pipeline verdict MUST be UNKNOWN'
  );
  assert.notStrictEqual(
    result.verdict,
    'PRESERVED',
    'V1 Assertion (c) failed: full pipeline verdict MUST NEVER be PRESERVED'
  );

  console.log('\nV1 Verification Successful: All 3 assertions (a, b, c) verified simultaneously.');
}

runV1Test().catch(err => {
  console.error('V1 Test Failed:', err);
  process.exit(1);
});
