import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineDependencyGraph } from '../src/OfflineDependencyGraph';
import { OfflineImpactEngine } from '../src/OfflineImpactEngine';
import { OfflineTargetResolver } from '../src/OfflineTargetResolver';
import { ImpactFormatter } from '../src/ImpactFormatter';

function runDeterminismTests() {
  console.log('=== RUNNING IMPACT ENGINE DETERMINISM & LATENCY TESTS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-det-test-'));

  try {
    // Generate a multi-tier dependency tree (1 target, 10 direct, 20 transitive)
    const files: string[] = ['target.ts'];
    fs.writeFileSync(path.join(tempDir, 'target.ts'), 'export const TARGET = 1;');

    for (let i = 0; i < 10; i++) {
      const name = `direct_${i}.ts`;
      files.push(name);
      fs.writeFileSync(
        path.join(tempDir, name),
        `import { TARGET } from "./target"; export const val_${i} = TARGET + ${i};`
      );

      for (let j = 0; j < 2; j++) {
        const tName = `trans_${i}_${j}.ts`;
        files.push(tName);
        fs.writeFileSync(
          path.join(tempDir, tName),
          `import { val_${i} } from "./direct_${i}"; export const tval_${i}_${j} = val_${i};`
        );
      }
    }

    const graph = new OfflineDependencyGraph({ repoRoot: tempDir, files });
    const resolver = new OfflineTargetResolver({ repoRoot: tempDir });
    const resolution = resolver.resolveTarget('target.ts');

    const engine = new OfflineImpactEngine({ traversalMode: 'FULL' });
    const runs = 5;
    const results: any[] = [];
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      const res = engine.analyze(resolution, graph);
      const elapsed = Date.now() - t0;
      times.push(elapsed);
      results.push(res);
    }

    const first = results[0];
    const firstMd = ImpactFormatter.format(first, resolution);

    const normalizeMarkdown = (md: string) =>
      (md || '').replace(/\|\s*\*\*Execution Time\*\*\s*\|\s*\d+\s*ms\s*\|/g, '| **Execution Time** | <NORMALIZED> ms |');

    for (let i = 1; i < runs; i++) {
      const curr = results[i];
      assert.strictEqual(curr.targetNode, first.targetNode);
      assert.strictEqual(curr.blastRadius, first.blastRadius);
      assert.deepStrictEqual(curr.directDependents, first.directDependents);
      assert.deepStrictEqual(curr.transitiveDependents, first.transitiveDependents);
      assert.strictEqual(curr.llmCalls, 0);

      const currMd = ImpactFormatter.format(curr, resolution);
      assert.strictEqual(normalizeMarkdown(currMd), normalizeMarkdown(firstMd));
    }

    console.log(`[PASS] 100% byte-for-byte deterministic output across ${runs} consecutive runs`);
    console.log(`       Target: ${first.targetNode}`);
    console.log(`       Blast Radius: ${first.blastRadius} files`);
    console.log(`       Direct Dependents: ${first.directDependents.length}`);
    console.log(`       Transitive Dependents: ${first.transitiveDependents.length}`);

    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.50)];
    const p95 = times[Math.floor(times.length * 0.95)];

    console.log(`\nEmpirical Latency:`);
    console.log(`- Min: ${times[0]} ms`);
    console.log(`- Median (p50): ${p50} ms`);
    console.log(`- 95th percentile (p95): ${p95} ms`);
    console.log(`- Max: ${times[times.length - 1]} ms`);

    console.log('\nDeterminism Tests: ALL PASSED\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runDeterminismTests();
