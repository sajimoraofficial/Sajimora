/**
 * @file JavaAdversarialJ6.test.ts
 * Hostile & Adversarial Verification Suite for Java Phase J-6 (casebgoal.md §Phase 9).
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JAVA_ADVERSARIAL_SCENARIOS,
  runJavaAdversarialMatrix
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Phase J-6 Adversarial Matrix Suite ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

async function main() {
  console.log(`Executing ${JAVA_ADVERSARIAL_SCENARIOS.length} hostile scenarios...\n`);

  const report = await runJavaAdversarialMatrix(analyzer);

  console.log('================================================================');
  console.log(`Java Adversarial Matrix Results: ${report.passedScenarios}/${report.totalScenarios} Passed`);
  console.log('================================================================\n');

  for (const r of report.results) {
    if (r.passed) {
      console.log(`  ✅ PASS [${r.id}] ${r.name} (${r.durationMs.toFixed(1)}ms)`);
    } else {
      console.error(`  ❌ FAIL [${r.id}] ${r.name}`);
      console.error(`     Error: ${r.error}`);
    }
  }

  assert.equal(report.failedScenarios, 0, `${report.failedScenarios} adversarial scenarios failed`);
  assert.equal(report.passedScenarios, report.totalScenarios, 'All adversarial scenarios must pass');

  console.log('\n--- ALL JAVA PHASE J-6 ADVERSARIAL MATRIX TESTS PASSED ---');
}

main().catch(err => {
  console.error('Fatal error in adversarial matrix:', err);
  process.exit(1);
});
