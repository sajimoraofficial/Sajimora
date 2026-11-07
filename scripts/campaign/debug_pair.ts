import * as path from 'node:path';
import { evaluateCommitPair } from './campaign_runner';
import { SnapshotSessionCache } from './SnapshotSessionCache';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';

async function testPair() {
  const repoName = 'TypeScript-Website';
  const repoPath = path.resolve('scripts/campaign/repos/TypeScript-Website');
  const dependencyRoot = path.resolve('scripts/campaign/repos/TypeScript-Website/node_modules');
  const parentSha = 'd21b31543d87c3b190e034694c955d2192b06a4d';
  const candidateSha = '673b339a77d87f0e8187040c25c30801af802ab9';
  const subject = 'Update for TS 6.0 (#3534)';

  console.log('--- RUN 1: UNCACHED (BASELINE) ---');
  const rUncached = evaluateCommitPair(
    repoName,
    repoPath,
    parentSha,
    candidateSha,
    subject,
    dependencyRoot
  );
  console.log('Uncached evaluations:');
  for (const ev of rUncached.evaluations) {
    console.log(`  ${ev.targetSymbol}: ${ev.verdict} (${ev.authorityGate} :: ${ev.authorityReason})`);
  }

  console.log('\n--- RUN 2: CACHED (LAYER 1 + 2A) ---');
  const gitCaches = RepoBlobPrefetcher.prefetch(repoPath, [parentSha, candidateSha]);
  const snapshotCache = new SnapshotSessionCache(3);
  const rCached = evaluateCommitPair(
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
  console.log('Cached evaluations:');
  for (const ev of rCached.evaluations) {
    console.log(`  ${ev.targetSymbol}: ${ev.verdict} (${ev.authorityGate} :: ${ev.authorityReason})`);
  }
}

testPair().catch(console.error);
