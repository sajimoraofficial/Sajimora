/**
 * @file JavaPilotJ10A.test.ts
 * Test suite for Phase J-10A (Pilot Evaluation Campaign on 50 Repositories).
 *
 * Enforces empirical acceptance gates:
 * 1. 50 curated pilot cases evaluated across single-module, reactor, disqualified, and adversarial.
 * 2. Certified False-Positive Rate: Strictly 0.0% (Zero unsound proofs produced).
 * 3. Legacy proof abstention without fabricated precision.
 * 4. Consumer Discovery Recall: >= 95.0% across all consumer test cases.
 * 5. Deterministic Disqualification: Disqualified cases remain retained in advisory without certified bypass.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';

console.log('--- Starting Java Phase J-10A Test Suite (Pilot Campaign 50 Repositories) ---');

const manifestPath = path.resolve(__dirname, '../../../../scripts/campaign/fixtures/java_pilot_manifest_50.json');
assert.ok(fs.existsSync(manifestPath), `Manifest must exist at ${manifestPath}`);

const cases: any[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.strictEqual(cases.length, 50, 'Manifest must contain exactly 50 curated test cases');

let qualifiedCount = 0;
let certifiedTruePositives = 0;
let certifiedFalsePositives = 0;
let certifiedTrueNegatives = 0;
let certifiedFalseNegatives = 0;

let goldConsumerCount = 0;
let discoveredConsumerCount = 0;

const startTime = Date.now();

for (const tc of cases) {
  const result = runJavaAnalysis({
    repoId: tc.id,
    historicalFiles: tc.historicalFiles,
    candidateFiles: tc.candidateFiles,
    format: 'json'
  });

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
    const certVerdict = result.reportJson.certifiedPanel.verifiedConclusion;

    if (expectedVerdict === 'COMPATIBLE') {
      if (certVerdict === 'COMPATIBLE') {
        certifiedTruePositives++;
      } else {
        certifiedFalseNegatives++;
      }
    } else if (expectedVerdict === 'INCOMPATIBLE') {
      if (certVerdict === 'COMPATIBLE') {
        certifiedFalsePositives++;
        assert.fail(`[${tc.id}] Unsound certified proof: Breaking change verified as COMPATIBLE`);
      } else if (certVerdict === 'INCOMPATIBLE') {
        certifiedTrueNegatives++;
      }
    }

    assert.strictEqual(
      certVerdict,
      'UNCERTIFIED',
      `[${tc.id}] Legacy proof must remain uncertified; ground truth ${expectedVerdict}, got ${effectiveVerdict}`
    );
  } else {
    // Disqualified must remain advisory only
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
}

const totalDurationMs = Date.now() - startTime;
console.log(`Evaluated ${cases.length} cases in ${totalDurationMs} ms (${(totalDurationMs / cases.length).toFixed(1)} ms/case)`);

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
console.log('✓ Gate 1 PASS: Certified False-Positive Rate is 0.0% (0 FP)');

// --------------------------------------------------------------------------
// GATE 2: Source-unverified proofs must abstain
// --------------------------------------------------------------------------
console.log('Verifying Gate 2: Certified Precision...');
assert.strictEqual(certifiedTruePositives, 0);
assert.strictEqual(certifiedTrueNegatives, 0);
const precision = certifiedTruePositives / (certifiedTruePositives + certifiedFalsePositives || 1);
assert.strictEqual(
  precision,
  0,
  `With no certified positive claims the numeric sentinel must be zero, observed ${(precision * 100).toFixed(1)}%`
);
console.log('✓ Gate 2 PASS: Legacy source-unverified proofs abstain; precision is unmeasured');

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
// GATE 4: Performance Latency
// --------------------------------------------------------------------------
console.log('Verifying Gate 4: Performance Latency...');
const avgMs = totalDurationMs / cases.length;
assert.ok(avgMs < 200, `Average case latency must be < 200 ms, observed ${avgMs.toFixed(1)} ms`);
console.log(`✓ Gate 4 PASS: Average latency is ${avgMs.toFixed(1)} ms (< 200 ms)`);

console.log('--- Java Phase J-10A Test Suite: ALL GATES PASSED (50/50) ---');
