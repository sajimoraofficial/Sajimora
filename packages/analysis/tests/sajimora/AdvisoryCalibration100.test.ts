import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdvisoryTypeScriptImpactAnalyzer, AdvisoryVerdict } from '../../src/sajimora/advisory';
import { Slice100Manifest } from '../../../../scripts/campaign/materialize_readiness_slice_100';

const analyzer = new AdvisoryTypeScriptImpactAnalyzer();
const manifestPath = path.resolve('scripts/campaign/fixtures/typescript_readiness_100_slice.json');
const manifest: Slice100Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log(`\n================================================================`);
console.log(`Sajimora Stage 3 — 100-Case Advisory Calibration Suite`);
console.log(`================================================================`);
console.log(`Total Cases: ${manifest.cases.length}`);
console.log(`Ground Truth: ${JSON.stringify(manifest.distribution)}\n`);

interface CaseMetric {
  caseId: string;
  category: string;
  expected: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
  actual: AdvisoryVerdict;
  passed: boolean;
  notes?: string;
}

const metrics: CaseMetric[] = [];

for (const c of manifest.cases) {
  const result = analyzer.analyze({
    parent: c.parent,
    candidate: c.candidate,
    target: c.target
  });

  let mappedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
  if (result.verdict === 'LIKELY_PRESERVED') mappedVerdict = 'PRESERVED';
  else if (result.verdict === 'LIKELY_VIOLATED') mappedVerdict = 'VIOLATED';
  else mappedVerdict = 'UNKNOWN'; // INCONCLUSIVE or ANALYSIS_ERROR

  const passed = mappedVerdict === c.expectedVerdict;
  metrics.push({
    caseId: c.caseId,
    category: c.category,
    expected: c.expectedVerdict,
    actual: result.verdict,
    passed,
    notes: passed ? undefined : `Expected ${c.expectedVerdict}, got ${result.verdict} (unresolved: ${result.completeness.unresolvedFiles.join(', ')})`
  });

  if (!passed) {
    console.error(`  ❌ FAIL [${c.caseId}] ${c.category}: ${c.description}`);
    console.error(`     Expected: ${c.expectedVerdict} | Actual: ${result.verdict}`);
    if (result.completeness.unresolvedFiles.length) {
      console.error(`     Unresolved: ${result.completeness.unresolvedFiles.join('; ')}`);
    }
  }
}

const passedCount = metrics.filter(m => m.passed).length;
const failedCount = metrics.filter(m => !m.passed).length;

// Dual-oracle evaluation metrics
const expectedViolations = metrics.filter(m => m.expected === 'VIOLATED');
const actualViolations = metrics.filter(m => m.actual === 'LIKELY_VIOLATED');
const truePositives = expectedViolations.filter(m => m.actual === 'LIKELY_VIOLATED').length;
const falsePositives = actualViolations.filter(m => m.expected !== 'VIOLATED').length;
const falseNegatives = expectedViolations.filter(m => m.actual !== 'LIKELY_VIOLATED').length;

const unknownCases = metrics.filter(m => m.expected === 'UNKNOWN');
const failClosedCount = unknownCases.filter(m => m.actual === 'INCONCLUSIVE' || m.actual === 'ANALYSIS_ERROR').length;

const falsePositiveRate = actualViolations.length ? falsePositives / actualViolations.length : 0;
const falseNegativeRate = expectedViolations.length ? falseNegatives / expectedViolations.length : 0;
const failClosedRate = unknownCases.length ? failClosedCount / unknownCases.length : 1;

console.log(`\n================================================================`);
console.log(`Results: ${passedCount} passed, ${failedCount} failed (${manifest.cases.length} total)`);
console.log(`True Positives: ${truePositives} / ${expectedViolations.length}`);
console.log(`False Positives: ${falsePositives} (FPR: ${(falsePositiveRate * 100).toFixed(1)}%)`);
console.log(`False Negatives: ${falseNegatives} (FNR: ${(falseNegativeRate * 100).toFixed(1)}%)`);
console.log(`Fail-Closed Rate: ${failClosedCount} / ${unknownCases.length} (${(failClosedRate * 100).toFixed(1)}%)`);
console.log(`================================================================\n`);

assert.equal(failedCount, 0, `${failedCount} cases failed calibration`);
assert.equal(falsePositiveRate, 0, 'False positive rate must be 0%');
assert.equal(falseNegativeRate, 0, 'False negative rate must be 0%');
assert.equal(failClosedRate, 1, 'Fail closed rate must be 100%');

console.log('✅ Stage 3 Verification Gate PASSED: 100/100 calibrated cleanly!\n');
