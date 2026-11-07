/**
 * @file JavaBenchmarkJ6.test.ts
 * Validation Benchmark Test Suite for Java Phase J-6 (casebgoal.md §Phase 9).
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JAVA_STANDARD_BENCHMARK_CASES,
  runStandardJavaBenchmark,
  getStandardBenchmarkCasesByCategory,
  renderJavaBenchmarkSummary,
  assessJavaPromotionReadiness
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Phase J-6 Benchmark Test Suite ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// ---------------------------------------------------------------------------
// Test 1: Verify All 7 Required Change Types Are Present in Benchmark Catalog
// ---------------------------------------------------------------------------
{
  const requiredCategories = [
    'class-rename',
    'method-removal',
    'parameter-type-change',
    'visibility-narrowing',
    'field-removal',
    'annotation-change',
    'inner-class'
  ] as const;

  for (const cat of requiredCategories) {
    const cases = getStandardBenchmarkCasesByCategory(cat);
    assert.ok(cases.length > 0, `Benchmark suite must contain cases for category '${cat}'`);
    console.log(`✓ Required category '${cat}' has ${cases.length} benchmark case(s)`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: Execute Complete 24-Case Benchmark Suite & Verify Metrics
// ---------------------------------------------------------------------------
{
  const report = runStandardJavaBenchmark(analyzer);

  console.log('\n' + renderJavaBenchmarkSummary(report) + '\n');

  assert.equal(report.schemaVersion, 'ADVISORY_JAVA_BENCHMARK_V1');
  assert.equal(report.cases.length, 24, 'Benchmark suite must contain exactly 24 standard cases');

  // Verify zero failures across all cases
  for (const c of report.cases) {
    assert.equal(
      c.actualVerdict,
      c.expectedVerdict,
      `Case '${c.name}' verdict mismatch: expected ${c.expectedVerdict}, got ${c.actualVerdict}`
    );
    if (c.expectedConsumerCount !== null) {
      assert.ok(
        c.actualConsumerCount >= c.expectedConsumerCount,
        `Case '${c.name}' consumer discovery mismatch: expected >= ${c.expectedConsumerCount}, got ${c.actualConsumerCount}`
      );
    }
    assert.equal(c.deterministic, true, `Case '${c.name}' must be deterministic`);
  }

  // Dual-oracle precision & recall metrics
  const m = report.metrics;
  assert.equal(m.deterministicRepeatability, 1.0, 'Deterministic repeatability must be 100%');
  assert.equal(m.falsePositiveRate, 0.0, 'False positive rate must be 0%');
  assert.equal(m.falseNegativeRate, 0.0, 'False negative rate must be 0%');
  assert.equal(m.truePositiveRate, 1.0, 'True positive rate must be 100%');
  assert.ok(m.consumerDiscoveryRecall !== null && m.consumerDiscoveryRecall >= 0.95, 'Consumer discovery recall must be >= 95%');
  assert.ok(m.runtimeMs < 5000, `Execution runtime (${m.runtimeMs}ms) exceeded 5000ms budget`);
  assert.ok(m.peakRssDeltaBytes < 250 * 1024 * 1024, `Peak RSS delta (${(m.peakRssDeltaBytes / (1024 * 1024)).toFixed(1)}MB) exceeded 250MB`);

  console.log('✓ Test 2: Standard 24-Case Benchmark execution and metrics passed cleanly');
}

// ---------------------------------------------------------------------------
// Test 3: Deep Verification of Class Rename Scenarios (Case-B identity)
// ---------------------------------------------------------------------------
{
  const renameCases = getStandardBenchmarkCasesByCategory('class-rename');
  assert.equal(renameCases.length, 2);

  const unmigrated = renameCases.find(c => c.name === 'class-rename-unmigrated-breaking')!;
  const unmigratedRes = analyzer.analyze(unmigrated.input);
  assert.equal(unmigratedRes.verdict, 'LIKELY_VIOLATED');
  assert.ok(unmigratedRes.providers.some(p => p.change === 'CLASS_REMOVED' && p.identity === 'CASE_B'));
  assert.ok(unmigratedRes.providers.some(p => p.change === 'CLASS_ADDED' && p.identity === 'CASE_B'));

  const migrated = renameCases.find(c => c.name === 'class-rename-migrated-preserved')!;
  const migratedRes = analyzer.analyze(migrated.input);
  assert.equal(migratedRes.verdict, 'LIKELY_PRESERVED');
  assert.ok(migratedRes.providers.some(p => p.change === 'CLASS_ADDED' && p.identity === 'CASE_B'));

  console.log('✓ Test 3: Class rename Case-B scenarios verified');
}

// ---------------------------------------------------------------------------
// Test 4: Deep Verification of Inner Class Scenarios
// ---------------------------------------------------------------------------
{
  const innerCases = getStandardBenchmarkCasesByCategory('inner-class');
  assert.equal(innerCases.length, 3);

  // 1. Method removal in static inner class
  const methodRem = innerCases.find(c => c.name === 'inner-class-method-removal-breaking')!;
  const methodRemRes = analyzer.analyze(methodRem.input);
  assert.equal(methodRemRes.verdict, 'LIKELY_VIOLATED');
  const removedProvider = methodRemRes.providers.find(p => p.memberName === 'build');
  assert.ok(removedProvider, 'build method removal on inner class must be detected');
  assert.ok(removedProvider.id.includes('Widget.Builder'));

  // 2. Inner class removal
  const classRem = innerCases.find(c => c.name === 'inner-class-removal-breaking')!;
  const classRemRes = analyzer.analyze(classRem.input);
  assert.equal(classRemRes.verdict, 'LIKELY_VIOLATED');
  assert.ok(classRemRes.providers.some(p => p.fqcn === 'com.acme.Server.Config' && p.change === 'CLASS_REMOVED'));

  // 3. Additive inner method
  const additive = innerCases.find(c => c.name === 'inner-class-additive-preserved')!;
  const additiveRes = analyzer.analyze(additive.input);
  assert.equal(additiveRes.verdict, 'LIKELY_PRESERVED');
  assert.ok(additiveRes.providers.some(p => p.memberName === 'withTimeout' && p.change === 'METHOD_ADDED'));

  console.log('✓ Test 4: Inner class scenarios verified');
}

// ---------------------------------------------------------------------------
// Test 5: Promotion Readiness Assessment (Phase J-7 Gate)
// ---------------------------------------------------------------------------
{
  const report = runStandardJavaBenchmark(analyzer);

  // Evidence without proof rules -> NOT_READY
  const incompleteEvidence = {
    capabilityId: 'java.advisory.impact',
    sealedEvidence: true,
    deterministicReplay: true,
    independentlyVerifiableResolution: true,
    completeConsumerCoverage: true,
    explicitProofRules: false, // Missing formal proof rules
    adversarialTests: true,
    stableBenchmark: true,
    benchmark: report
  };

  const readiness1 = assessJavaPromotionReadiness(incompleteEvidence);
  assert.equal(readiness1.currentStatus, 'ADVISORY_ONLY');
  assert.equal(readiness1.readiness, 'NOT_READY');
  assert.ok(readiness1.missingRequirements.includes('formal explicit proof rules for nominal type relations'));

  // Evidence with all 7 criteria satisfied -> ELIGIBLE_FOR_REVIEW
  const fullEvidence = {
    ...incompleteEvidence,
    explicitProofRules: true
  };

  const readiness2 = assessJavaPromotionReadiness(fullEvidence);
  assert.equal(readiness2.currentStatus, 'ADVISORY_ONLY');
  assert.equal(readiness2.readiness, 'ELIGIBLE_FOR_REVIEW');
  assert.equal(readiness2.missingRequirements.length, 0);
  assert.equal(readiness2.benchmarkSummary?.deterministicRepeatability, 1.0);
  assert.equal(readiness2.benchmarkSummary?.falsePositiveRate, 0.0);
  assert.equal(readiness2.benchmarkSummary?.falseNegativeRate, 0.0);

  console.log('✓ Test 5: Promotion readiness evaluation verified');
}

console.log('--- ALL JAVA PHASE J-6 BENCHMARK TESTS PASSED ---');
