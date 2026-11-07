import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineDependencyGraph } from '../src/OfflineDependencyGraph';
import { OfflineImpactEngine } from '../src/OfflineImpactEngine';
import { OfflineTargetResolver } from '../src/OfflineTargetResolver';

function runImpactEngineTests() {
  console.log('=== RUNNING OFFLINE IMPACT ENGINE TESTS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-impact-test-'));

  try {
    // Fixture setup:
    // leaf.ts (target) <- direct1.ts <- trans1.ts
    //                  <- direct2.ts
    //                  <- test1.test.ts
    //                  <- route1.controller.ts
    //                  <- schema1.model.ts
    // unrelated.ts
    fs.writeFileSync(path.join(tempDir, 'leaf.ts'), 'export const LEAF_VAL = 42;');
    fs.writeFileSync(path.join(tempDir, 'direct1.ts'), 'import { LEAF_VAL } from "./leaf"; export const d1 = LEAF_VAL + 1;');
    fs.writeFileSync(path.join(tempDir, 'trans1.ts'), 'import { d1 } from "./direct1"; export const t1 = d1 + 1;');
    fs.writeFileSync(path.join(tempDir, 'direct2.ts'), 'import { LEAF_VAL } from "./leaf"; export const d2 = LEAF_VAL * 2;');
    fs.writeFileSync(path.join(tempDir, 'test1.test.ts'), 'import { LEAF_VAL } from "./leaf";');
    fs.writeFileSync(path.join(tempDir, 'route1.controller.ts'), 'import { LEAF_VAL } from "./leaf";');
    fs.writeFileSync(path.join(tempDir, 'schema1.model.ts'), 'import { LEAF_VAL } from "./leaf";');
    fs.writeFileSync(path.join(tempDir, 'unrelated.ts'), 'export const unrelated = true;');

    const files = [
      'leaf.ts',
      'direct1.ts',
      'trans1.ts',
      'direct2.ts',
      'test1.test.ts',
      'route1.controller.ts',
      'schema1.model.ts',
      'unrelated.ts'
    ];

    const graph = new OfflineDependencyGraph({ repoRoot: tempDir, files });
    const resolver = new OfflineTargetResolver({ repoRoot: tempDir });
    const resolution = resolver.resolveTarget('leaf.ts');

    assert.strictEqual(resolution.status, 'RESOLVED');

    // 1. FULL traversal mode test
    const engineFull = new OfflineImpactEngine({ traversalMode: 'FULL' });
    const resFull = engineFull.analyze(resolution, graph);

    console.log('[PASS] Status:', resFull.resolutionStatus);
    assert.strictEqual(resFull.resolutionStatus, 'RESOLVED');
    assert.strictEqual(resFull.blastRadius, 6, `Expected blastRadius 6, got ${resFull.blastRadius}`);
    assert.strictEqual(resFull.directDependents.length, 5);
    assert.strictEqual(resFull.transitiveDependents.length, 1);
    assert.ok(resFull.directDependents.includes('direct1.ts'));
    assert.ok(resFull.directDependents.includes('direct2.ts'));
    assert.ok(resFull.directDependents.includes('test1.test.ts'));
    assert.ok(resFull.directDependents.includes('route1.controller.ts'));
    assert.ok(resFull.directDependents.includes('schema1.model.ts'));
    assert.ok(resFull.transitiveDependents.includes('trans1.ts'));
    assert.strictEqual(resFull.directDependents.includes('unrelated.ts'), false);
    assert.strictEqual(resFull.transitiveDependents.includes('unrelated.ts'), false);
    console.log('[PASS] Full traversal correctly identifies direct and transitive dependents');

    // 2. Role classifications
    assert.ok(resFull.affectedTests.includes('test1.test.ts'));
    assert.ok(resFull.affectedRoutes.includes('route1.controller.ts'));
    assert.ok(resFull.affectedSchemas.includes('schema1.model.ts'));
    console.log('[PASS] Role classification correctly tags tests, routes, and schemas');

    // 3. BOUNDED traversal mode test (depth 1)
    const engineBounded = new OfflineImpactEngine({ traversalMode: 'BOUNDED', maxBoundedDepth: 1 });
    const resBounded = engineBounded.analyze(resolution, graph);
    assert.strictEqual(resBounded.transitiveDependents.length, 0);
    assert.strictEqual(resBounded.blastRadius, 5);
    console.log('[PASS] Bounded traversal strictly respects maxBoundedDepth');

    // 4. Zero LLM invariant
    assert.strictEqual(resFull.llmCalls, 0);
    assert.strictEqual(resFull.tokenCost, 0);
    console.log('[PASS] Strictly 0 LLM calls and 0 tokens used');

    console.log('\nImpact Engine Tests: ALL PASSED\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runImpactEngineTests();
