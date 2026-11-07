import * as path from 'node:path';
import { evaluateCommitPair, CampaignCaseResult } from './campaign_runner';
import { SnapshotSessionCache } from './SnapshotSessionCache';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';
import { OldBuildRecord } from './ProgramReuseGate';

function assertDeepEqual(actual: any, expected: any, msg: string) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\nExpected: ${expectedStr}\nActual:   ${actualStr}`);
  }
}

function normalizeResultForComparison(result: CampaignCaseResult) {
  return {
    repository: result.repository,
    parentSha: result.parentSha,
    candidateSha: result.candidateSha,
    subject: result.subject,
    analyzable: result.analyzable,
    nonAnalyzableReason: result.nonAnalyzableReason,
    mutationsCount: result.mutationsCount,
    evaluations: result.evaluations.map(e => ({
      targetSymbol: e.targetSymbol,
      targetKind: e.targetKind,
      targetFile: e.targetFile,
      classification: e.classification,
      verdict: e.verdict,
      authorityGate: e.authorityGate,
      authorityReason: e.authorityReason,
      authoritySource: e.authoritySource,
      hasSemanticCompatibility: e.hasSemanticCompatibility,
      evaluatedConsumerCount: e.evaluatedConsumerCount,
      compatibilityStatuses: e.compatibilityStatuses,
      witnesses: e.witnesses,
      isUnsafePositive: e.isUnsafePositive
    }))
  };
}

async function runEquivalenceTests() {
  console.log('================================================================');
  console.log('RUNNING SNAPSHOT & PROGRAM REUSE CACHE EQUIVALENCE TESTS');
  console.log('================================================================\n');

  const repoName = 'express';
  const repoPath = path.resolve('scripts/campaign/repos/express');
  const dependencyRoot = path.resolve('scripts/campaign/repos/express/node_modules');

  // Express pair 0:
  // parentSha: cb19f04170fc815321d40dcd3bc620ae03c828cd
  // candidateSha: 90ec6206d3275fdf2787f2028c6f48a2d92e8042
  const pair0 = {
    parentSha: 'cb19f04170fc815321d40dcd3bc620ae03c828cd',
    candidateSha: '90ec6206d3275fdf2787f2028c6f48a2d92e8042',
    subject: 'Improve error logging by logging full error object (#6464)'
  };

  // Express pair 1:
  // parentSha: a08da78e64a7fdc610d453fb7771754091d8ed3b
  // candidateSha: cb19f04170fc815321d40dcd3bc620ae03c828cd
  const pair1 = {
    parentSha: 'a08da78e64a7fdc610d453fb7771754091d8ed3b',
    candidateSha: 'cb19f04170fc815321d40dcd3bc620ae03c828cd',
    subject: 'Upgrade content-type (#7234)'
  };

  // 1. Run baseline (uncached) for pair 0
  console.log('[Test 1] Running baseline uncached evaluation for pair 0...');
  const baselineResult0 = evaluateCommitPair(
    repoName,
    repoPath,
    pair0.parentSha,
    pair0.candidateSha,
    pair0.subject,
    dependencyRoot
  );
  console.log(`  Baseline: ${baselineResult0.evaluations.length} evaluation(s), verdicts: ${baselineResult0.evaluations.map(e => e.verdict).join(', ')}`);

  // 2. Run with Layer 1 (git prefetched) + Layer 2A (SnapshotSessionCache) for pair 0
  console.log('[Test 2] Running Layer 1 + Layer 2A evaluation for pair 0...');
  const gitCaches = RepoBlobPrefetcher.prefetch(repoPath, [pair0.parentSha, pair0.candidateSha]);
  const snapshotCache = new SnapshotSessionCache(3);

  const cachedResult0 = evaluateCommitPair(
    repoName,
    repoPath,
    pair0.parentSha,
    pair0.candidateSha,
    pair0.subject,
    dependencyRoot,
    {
      snapshotCache,
      gitCaches
    }
  );
  console.log(`  Layer 1+2A: ${cachedResult0.evaluations.length} evaluation(s), verdicts: ${cachedResult0.evaluations.map(e => e.verdict).join(', ')}`);

  assertDeepEqual(
    normalizeResultForComparison(cachedResult0),
    normalizeResultForComparison(baselineResult0),
    'Layer 1 + Layer 2A cached result diverges from baseline uncached result!'
  );
  console.log('  ✅ Layer 1 + 2A produces bit-identical verdicts and evidence to baseline!\n');

  // 3. Test Layer 2A reuse: run second time with populated cache
  console.log('[Test 3] Re-running pair 0 with populated snapshotCache (cache HIT test)...');
  const cacheHitResult0 = evaluateCommitPair(
    repoName,
    repoPath,
    pair0.parentSha,
    pair0.candidateSha,
    pair0.subject,
    dependencyRoot,
    {
      snapshotCache,
      gitCaches
    }
  );
  assertDeepEqual(
    normalizeResultForComparison(cacheHitResult0),
    normalizeResultForComparison(baselineResult0),
    'Layer 2A cache-hit result diverges from baseline uncached result!'
  );
  console.log('  ✅ Cache-hit evaluation is bit-identical to baseline!\n');

  // 4. Test Layer 2B (ProgramReuseGate)
  console.log('[Test 4] Testing Layer 2B (ProgramReuseGate with --enable-program-reuse)...');
  const lastBuildRecord: { current?: OldBuildRecord } = {};
  const cache2B = new SnapshotSessionCache(3);

  const runWith2B_0 = evaluateCommitPair(
    repoName,
    repoPath,
    pair0.parentSha,
    pair0.candidateSha,
    pair0.subject,
    dependencyRoot,
    {
      snapshotCache: cache2B,
      gitCaches,
      enableProgramReuse: true,
      lastBuildRecord
    }
  );
  assertDeepEqual(
    normalizeResultForComparison(runWith2B_0),
    normalizeResultForComparison(baselineResult0),
    'Layer 2B initial pair diverges from baseline!'
  );
  console.log('  ✅ Layer 2B initial evaluation matches baseline!');

  // Now run pair 1 uncached vs pair 1 with 2B
  console.log('  Running pair 1 uncached baseline...');
  const baselineResult1 = evaluateCommitPair(
    repoName,
    repoPath,
    pair1.parentSha,
    pair1.candidateSha,
    pair1.subject,
    dependencyRoot
  );

  console.log('  Running pair 1 with Layer 2A + 2B program reuse...');
  const runWith2B_1 = evaluateCommitPair(
    repoName,
    repoPath,
    pair1.parentSha,
    pair1.candidateSha,
    pair1.subject,
    dependencyRoot,
    {
      snapshotCache: cache2B,
      gitCaches,
      enableProgramReuse: true,
      lastBuildRecord
    }
  );

  assertDeepEqual(
    normalizeResultForComparison(runWith2B_1),
    normalizeResultForComparison(baselineResult1),
    'Layer 2B chained pair diverges from baseline!'
  );
  console.log('  ✅ Layer 2B chained evaluation matches baseline bit-for-bit!\n');

  snapshotCache.releaseAll();
  cache2B.releaseAll();

  console.log('================================================================');
  console.log('✅ ALL CACHE EQUIVALENCE TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runEquivalenceTests().catch(err => {
  console.error('Equivalence test failed:', err);
  process.exit(1);
});
