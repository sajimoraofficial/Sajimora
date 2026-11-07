/**
 * @file JavaCampaignJ10B.test.ts
 * Test suite for Phase J-10B (Scale Evaluation Campaign across 1,000 Repositories).
 *
 * Evaluates real-world style repositories across Guava, Jackson, and Spring ecosystems.
 * Enforces empirical acceptance gates:
 * 1. 1,000 test cases evaluated across 3 major architectural families.
 * 2. Certified False-Positive Rate: Strictly 0.0% (Zero unsound proofs).
 * 3. Certified Precision: Strictly 100.0%.
 * 4. Consumer Discovery Recall: >= 95.0%.
 * 5. Latency: p50 < 200 ms, p95 < 1000 ms.
 * 6. Memory: RSS Delta p50 < 30 MB, p95 < 100 MB.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';

console.log('--- Starting Java Phase J-10B Test Suite (Scale Campaign 1,000 Repositories) ---');

const manifestPath = path.resolve(__dirname, '../../../../scripts/campaign/fixtures/java_scale_manifest_1000.json');
assert.ok(fs.existsSync(manifestPath), `Scale manifest must exist at ${manifestPath}`);

const cases: any[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(cases.length, 1000, 'Manifest must contain exactly 1,000 scale test cases');

let qualifiedCount = 0;
let disqualifiedCount = 0;

let certifiedTruePositives = 0;
let certifiedFalsePositives = 0;
let certifiedTrueNegatives = 0;
let certifiedFalseNegatives = 0;

let goldConsumerCount = 0;
let discoveredConsumerCount = 0;

const runtimes: number[] = [];
const rssDeltas: number[] = [];

const familyStats: Record<string, { total: number; qualified: number; compatible: number; breaking: number; advisory: number }> = {
  GUAVA: { total: 0, qualified: 0, compatible: 0, breaking: 0, advisory: 0 },
  JACKSON: { total: 0, qualified: 0, compatible: 0, breaking: 0, advisory: 0 },
  SPRING: { total: 0, qualified: 0, compatible: 0, breaking: 0, advisory: 0 }
};

const suiteStartTime = Date.now();

for (let idx = 0; idx < cases.length; idx++) {
  const tc = cases[idx];
  const memBefore = process.memoryUsage().rss;
  const start = Date.now();

  const result = runJavaAnalysis({
    repoId: tc.id,
    historicalFiles: tc.historicalFiles,
    candidateFiles: tc.candidateFiles,
    format: 'json'
  });

  const duration = Date.now() - start;
  const rssDeltaMb = Math.max(0, (process.memoryUsage().rss - memBefore) / (1024 * 1024));

  runtimes.push(duration);
  rssDeltas.push(rssDeltaMb);

  const familyKey = tc.id.startsWith('guava') ? 'GUAVA' : tc.id.startsWith('jackson') ? 'JACKSON' : 'SPRING';
  familyStats[familyKey].total++;

  const isQualified = result.qualification.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0';
  const expectedQual = tc.goldSet.expectedQualification;
  const expectedVerdict = tc.goldSet.expectedVerdict;
  const effectiveVerdict = result.effectiveVerdict;

  assert.strictEqual(
    result.qualification.qualificationStatus,
    expectedQual,
    `[${tc.id}] Qualification mismatch: expected ${expectedQual}, got ${result.qualification.qualificationStatus}`
  );

  if (isQualified) {
    qualifiedCount++;
    familyStats[familyKey].qualified++;

    const certVerdict = result.reportJson.certifiedPanel.verifiedConclusion;

    if (expectedVerdict === 'COMPATIBLE') {
      familyStats[familyKey].compatible++;
      if (certVerdict === 'COMPATIBLE') {
        certifiedTruePositives++;
      } else {
        certifiedFalseNegatives++;
      }
    } else if (expectedVerdict === 'INCOMPATIBLE') {
      familyStats[familyKey].breaking++;
      if (certVerdict === 'COMPATIBLE') {
        certifiedFalsePositives++;
        assert.fail(`[${tc.id}] Unsound certified proof: Breaking change verified as COMPATIBLE`);
      } else {
        certifiedTrueNegatives++;
      }
    }

    assert.strictEqual(
      effectiveVerdict,
      expectedVerdict,
      `[${tc.id}] Verdict mismatch: expected ${expectedVerdict}, got ${effectiveVerdict}`
    );
  } else {
    disqualifiedCount++;
    familyStats[familyKey].advisory++;

    assert.strictEqual(
      result.qualification.admittedProfile,
      null,
      `[${tc.id}] Disqualified repository must have null admitted profile`
    );
    assert.notStrictEqual(
      effectiveVerdict,
      'COMPATIBLE',
      `[${tc.id}] Disqualified repository must never yield certified COMPATIBLE`
    );
  }

  // Consumer discovery check
  const goldCons: string[] = tc.goldSet.goldConsumers ?? [];
  const discoveredCons: string[] = result.advisoryResult?.consumers.map(c => c.consumerFile) ?? [];

  for (const gc of goldCons) {
    goldConsumerCount++;
    if (discoveredCons.includes(gc)) {
      discoveredConsumerCount++;
    }
  }

  if ((idx + 1) % 250 === 0) {
    console.log(`Evaluated ${idx + 1}/1000 scale cases... (elapsed: ${Date.now() - suiteStartTime} ms)`);
  }
}

const totalDurationMs = Date.now() - suiteStartTime;
console.log(`Completed 1,000 cases in ${totalDurationMs} ms (${(totalDurationMs / cases.length).toFixed(2)} ms/case)`);

// Sort percentiles
runtimes.sort((a, b) => a - b);
rssDeltas.sort((a, b) => a - b);

const p50Runtime = runtimes[Math.floor(runtimes.length * 0.50)];
const p95Runtime = runtimes[Math.floor(runtimes.length * 0.95)];
const p50Rss = rssDeltas[Math.floor(rssDeltas.length * 0.50)];
const p95Rss = rssDeltas[Math.floor(rssDeltas.length * 0.95)];

// --------------------------------------------------------------------------
// GATE 1: Certified False-Positive Rate Strictly 0.0%
// --------------------------------------------------------------------------
console.log('Verifying Gate 1: Certified False-Positive Rate...');
const certifiedFP = certifiedFalsePositives / (certifiedFalsePositives + certifiedTrueNegatives || 1);
assert.strictEqual(
  certifiedFalsePositives,
  0,
  `Certified false positives must be 0, observed ${certifiedFalsePositives}`
);
assert.strictEqual(
  certifiedFP,
  0,
  `Certified false-positive rate must be 0.0%, observed ${(certifiedFP * 100).toFixed(1)}%`
);
console.log(`✓ Gate 1 PASS: Certified False-Positive Rate is 0.0% (0 FP across ${qualifiedCount} qualified repos)`);

// --------------------------------------------------------------------------
// GATE 2: Certified Precision Strictly 100.0%
// --------------------------------------------------------------------------
console.log('Verifying Gate 2: Certified Precision...');
const precision = certifiedTruePositives / (certifiedTruePositives + certifiedFalsePositives || 1);
assert.strictEqual(
  precision,
  1.0,
  `Certified precision must be 100.0%, observed ${(precision * 100).toFixed(1)}%`
);
console.log(`✓ Gate 2 PASS: Certified Precision is 100.0% (${certifiedTruePositives} TP / ${certifiedTruePositives + certifiedFalsePositives} positive claims)`);

// --------------------------------------------------------------------------
// GATE 3: Consumer Discovery Recall >= 95.0%
// --------------------------------------------------------------------------
console.log('Verifying Gate 3: Consumer Discovery Recall...');
const recall = discoveredConsumerCount / (goldConsumerCount || 1);
assert.ok(
  recall >= 0.95,
  `Consumer discovery recall must be >= 95.0%, observed ${(recall * 100).toFixed(1)}% (${discoveredConsumerCount}/${goldConsumerCount})`
);
console.log(`✓ Gate 3 PASS: Consumer Discovery Recall is ${(recall * 100).toFixed(1)}% (${discoveredConsumerCount}/${goldConsumerCount})`);

// --------------------------------------------------------------------------
// GATE 4: Performance Latency (p50 < 200 ms, p95 < 1000 ms)
// --------------------------------------------------------------------------
console.log('Verifying Gate 4: Latency Percentiles...');
assert.ok(p50Runtime < 200, `p50 runtime must be < 200 ms, observed ${p50Runtime} ms`);
assert.ok(p95Runtime < 1000, `p95 runtime must be < 1000 ms, observed ${p95Runtime} ms`);
console.log(`✓ Gate 4 PASS: Runtime p50 = ${p50Runtime} ms, p95 = ${p95Runtime} ms`);

// --------------------------------------------------------------------------
// GATE 5: Peak RSS Delta (p50 < 30 MB, p95 < 100 MB)
// --------------------------------------------------------------------------
console.log('Verifying Gate 5: Memory Percentiles...');
assert.ok(p50Rss < 30, `p50 RSS delta must be < 30 MB, observed ${p50Rss.toFixed(2)} MB`);
assert.ok(p95Rss < 100, `p95 RSS delta must be < 100 MB, observed ${p95Rss.toFixed(2)} MB`);
console.log(`✓ Gate 5 PASS: RSS Delta p50 = ${p50Rss.toFixed(2)} MB, p95 = ${p95Rss.toFixed(2)} MB`);

// --------------------------------------------------------------------------
// Characterization Baselines
// --------------------------------------------------------------------------
const qualRate = (qualifiedCount / cases.length) * 100;
console.log(`\n--- Empirical Characterization Breakdown ---`);
console.log(`Total Cases: 1,000`);
console.log(`F0 Qualified: ${qualifiedCount} (${qualRate.toFixed(1)}%) | Retained in Advisory: ${disqualifiedCount} (${(100 - qualRate).toFixed(1)}%)`);
for (const [fam, stats] of Object.entries(familyStats)) {
  console.log(`  • ${fam}: ${stats.total} total (${stats.qualified} qualified: ${stats.compatible} comp, ${stats.breaking} break | ${stats.advisory} advisory)`);
}

console.log('\n--- Java Phase J-10B Test Suite: ALL GATES PASSED (1000/1000) ---');
