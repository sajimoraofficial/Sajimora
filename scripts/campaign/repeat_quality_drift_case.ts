import * as path from 'node:path';
import { evaluateCommitPair } from './campaign_runner';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';
import { SnapshotSessionCache } from './SnapshotSessionCache';

type Case = {
  repository: string;
  repoPath: string;
  dependencyRoot: string;
  parentSha: string;
  candidateSha: string;
  subject: string;
};

const root = path.resolve('scripts/campaign/repos');
const cases: Case[] = [
  {
    repository: 'zod', repoPath: path.join(root, 'zod'), dependencyRoot: path.join(root, 'zod/node_modules'),
    parentSha: '68a609ac9b9516e6fe84e3558f17ce16b1032bef', candidateSha: '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f',
    subject: "refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)"
  },
  {
    repository: 'TypeScript-Website', repoPath: path.join(root, 'TypeScript-Website'), dependencyRoot: path.join(root, 'TypeScript-Website/node_modules'),
    parentSha: 'd21b31543d87c3b190e034694c955d2192b06a4d', candidateSha: '673b339a77d87f0e8187040c25c30801af802ab9',
    subject: 'Update for TS 6.0 (#3534)'
  },
  {
    repository: 'TypeScript-Website', repoPath: path.join(root, 'TypeScript-Website'), dependencyRoot: path.join(root, 'TypeScript-Website/node_modules'),
    parentSha: '32433bc2c7528771aa4c63b2d22d7172b0dd376c', candidateSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
    subject: 'Accessibility bug fix 2737338 (#3529)'
  },
  {
    repository: 'turborepo', repoPath: path.join(root, 'turborepo'), dependencyRoot: path.join(root, 'turborepo/node_modules'),
    parentSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b', candidateSha: '06f59004ba50fabd4c582230ed076ee909fb85fc',
    subject: 'perf: Reuse package manager detection during create startup (#14006)'
  },
  {
    repository: 'turborepo', repoPath: path.join(root, 'turborepo'), dependencyRoot: path.join(root, 'turborepo/node_modules'),
    parentSha: '4db9ca09bdac8cc0f8ece533cc480c10947f7bc1', candidateSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b',
    subject: 'perf: Compute Devtools graph depths without rescanning every edge (#14001)'
  }
];

const index = Number(process.env.QUALITY_DRIFT_CASE_INDEX);
if (!Number.isInteger(index) || !cases[index]) throw new Error(`Set QUALITY_DRIFT_CASE_INDEX to 0-${cases.length - 1}.`);

const item = cases[index];
const gitCaches = RepoBlobPrefetcher.prefetch(item.repoPath, [item.parentSha, item.candidateSha]);
const snapshotCache = new SnapshotSessionCache(3);
try {
  const result = evaluateCommitPair(item.repository, item.repoPath, item.parentSha, item.candidateSha, item.subject, item.dependencyRoot, { gitCaches, snapshotCache });
  console.log(JSON.stringify({
    candidateSha: result.candidateSha,
    analyzable: result.analyzable,
    nonAnalyzableReason: result.nonAnalyzableReason,
    evaluations: result.evaluations.map(({ durationMs, peakRssBytes, witnesses, ...evaluation }) => evaluation)
  }));
} finally {
  snapshotCache.releaseAll();
  gitCaches.blobCache.clear();
  gitCaches.treeCache.clear();
}
