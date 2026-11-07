import * as path from 'node:path';
import { evaluateCommitPair } from './campaign_runner';
import { SnapshotSessionCache } from './SnapshotSessionCache';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';

function benchmarkSingleQuery() {
  console.log('================================================================');
  console.log('BENCHMARKING 1 QUERY (COMMIT PAIR EVALUATION)');
  console.log('================================================================\n');

  const repoName = 'zod';
  const repoPath = path.resolve('scripts/campaign/repos/zod');
  const dependencyRoot = path.resolve('scripts/campaign/repos/zod/node_modules');

  // Pair 1 from Zod:
  // parent: 68a609ac9b9516e6fe84e3558f17ce16b1032bef
  // candidate: 2ec972ecc5a8af8135ed072d2d5b5363c27bb46f
  // subject: refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)
  const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
  const candidateSha = '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
  const subject = "refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)";

  console.log(`Repository: ${repoName}`);
  console.log(`Candidate:  ${candidateSha.slice(0, 8)}`);
  console.log(`Parent:     ${parentSha.slice(0, 8)}`);
  console.log(`Subject:    ${subject}\n`);

  const t0 = Date.now();
  console.log('1. Pre-fetching git blobs and trees (Layer 1)...');
  const gitCaches = RepoBlobPrefetcher.prefetch(repoPath, [parentSha, candidateSha]);
  const t1 = Date.now();
  console.log(`   Git prefetch took: ${t1 - t0}ms (cached ${gitCaches.blobCache.size} blobs)`);

  const snapshotCache = new SnapshotSessionCache(3);

  console.log('\n2. Executing 1 query (evaluateCommitPair with Layer 1 + Layer 2A)...');
  const queryStart = Date.now();
  const queryCpuStart = process.cpuUsage();
  const result = evaluateCommitPair(
    repoName,
    repoPath,
    parentSha,
    candidateSha,
    subject,
    dependencyRoot,
    {
      snapshotCache,
      gitCaches
    }
  );
  const queryEnd = Date.now();
  const queryCpu = process.cpuUsage(queryCpuStart);
  const queryDuration = queryEnd - queryStart;
  const totalDuration = queryEnd - t0;

  console.log(`\n================================================================`);
  console.log(`QUERY RESULTS & TIMING`);
  console.log(`================================================================`);
  console.log(`Analyzable:        ${result.analyzable}`);
  console.log(`Mutations Derived: ${result.mutationsCount}`);
  for (const ev of result.evaluations) {
    console.log(`  - Target:   ${ev.targetSymbol} (${ev.targetKind})`);
    console.log(`    File:     ${ev.targetFile}`);
    console.log(`    Verdict:  ${ev.verdict} (Gate: ${ev.authorityGate} | Reason: ${ev.authorityReason})`);
    console.log(`    Time:     ${ev.durationMs}ms`);
  }
  console.log(`----------------------------------------------------------------`);
  console.log(`Query Execution Time: ${queryDuration}ms (${(queryDuration / 1000).toFixed(2)}s)`);
  console.log(`Query CPU Time:       ${((queryCpu.user + queryCpu.system) / 1_000_000).toFixed(2)}s`);
  console.log(`RSS after query:      ${(process.memoryUsage().rss / 1_048_576).toFixed(1)} MiB`);
  console.log(`Total Elapsed Time:   ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
  console.log(`================================================================\n`);

  snapshotCache.releaseAll();
}

benchmarkSingleQuery();
