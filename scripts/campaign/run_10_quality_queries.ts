import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateCommitPair, CampaignCaseResult } from './campaign_runner';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';
import { SnapshotSessionCache } from './SnapshotSessionCache';

type Pair = { parentSha: string; candidateSha: string; subject: string };
type Repo = { name: string; repoPath: string; dependencyRoot: string; pairs: Pair[] };

const sample: Repo[] = [
  {
    name: 'zod',
    repoPath: path.resolve('scripts/campaign/repos/zod'),
    dependencyRoot: path.resolve('scripts/campaign/repos/zod/node_modules'),
    pairs: [
      ['68a609ac9b9516e6fe84e3558f17ce16b1032bef', '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f', "refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)"],
      ['0227e53d03b5652be75422b6d10e0dd9bf340f0b', '68a609ac9b9516e6fe84e3558f17ce16b1032bef', 'Widen literal inputs in property check types (#6520)'],
      ['f83ab51129038a2f868ee11dda906ed78ae2e478', '84dd3b0fc6cb5a24f773cb6db66bc934338b44ea', 'perf: build literal and enum pattern regexes lazily (#6531)']
    ].map(([parentSha, candidateSha, subject]) => ({ parentSha, candidateSha, subject }))
  },
  {
    name: 'TypeScript-Website',
    repoPath: path.resolve('scripts/campaign/repos/TypeScript-Website'),
    dependencyRoot: path.resolve('scripts/campaign/repos/TypeScript-Website/node_modules'),
    pairs: [
      ['673b339a77d87f0e8187040c25c30801af802ab9', '5d0a1d07010d3053f3859f6f0a0d0b1d954a93ca', 'Accessibility bug fix 2737380 (#3530)'],
      ['d21b31543d87c3b190e034694c955d2192b06a4d', '673b339a77d87f0e8187040c25c30801af802ab9', 'Update for TS 6.0 (#3534)'],
      ['32433bc2c7528771aa4c63b2d22d7172b0dd376c', 'd21b31543d87c3b190e034694c955d2192b06a4d', 'Accessibility bug fix 2737338 (#3529)']
    ].map(([parentSha, candidateSha, subject]) => ({ parentSha, candidateSha, subject }))
  },
  {
    name: 'turborepo',
    repoPath: path.resolve('scripts/campaign/repos/turborepo'),
    dependencyRoot: path.resolve('scripts/campaign/repos/turborepo/node_modules'),
    pairs: [
      ['ef4677219f6d31911aff5a0c5aa953c53e12c40b', '06f59004ba50fabd4c582230ed076ee909fb85fc', 'perf: Reuse package manager detection during create startup (#14006)'],
      ['4db9ca09bdac8cc0f8ece533cc480c10947f7bc1', 'ef4677219f6d31911aff5a0c5aa953c53e12c40b', 'perf: Compute Devtools graph depths without rescanning every edge (#14001)']
    ].map(([parentSha, candidateSha, subject]) => ({ parentSha, candidateSha, subject }))
  },
  {
    name: 'express',
    repoPath: path.resolve('scripts/campaign/repos/express'),
    dependencyRoot: path.resolve('scripts/campaign/repos/express/node_modules'),
    pairs: [
      ['cb19f04170fc815321d40dcd3bc620ae03c828cd', '90ec6206d3275fdf2787f2028c6f48a2d92e8042', 'Improve error logging by logging full error object (#6464)'],
      ['a08da78e64a7fdc610d453fb7771754091d8ed3b', 'cb19f04170fc815321d40dcd3bc620ae03c828cd', 'Upgrade content-type (#7234)']
    ].map(([parentSha, candidateSha, subject]) => ({ parentSha, candidateSha, subject }))
  }
];

function semantic(result: CampaignCaseResult) {
  return {
    repository: result.repository,
    parentSha: result.parentSha,
    candidateSha: result.candidateSha,
    subject: result.subject,
    analyzable: result.analyzable,
    nonAnalyzableReason: result.nonAnalyzableReason,
    mutationsCount: result.mutationsCount,
    evaluations: result.evaluations.map(({ durationMs, peakRssBytes, ...rest }) => rest)
  };
}

function semanticComparison(result: CampaignCaseResult) {
  const sem = semantic(result);
  return {
    ...sem,
    evaluations: sem.evaluations.map(({ witnesses, ...rest }: any) => rest)
  };
}

async function runRepo(repo: Repo): Promise<CampaignCaseResult[]> {
  const revisions = repo.pairs.flatMap(pair => [pair.parentSha, pair.candidateSha]);
  const gitCaches = RepoBlobPrefetcher.prefetch(repo.repoPath, revisions);
  const snapshotCache = new SnapshotSessionCache(3);
  const results: CampaignCaseResult[] = [];
  try {
    for (const pair of repo.pairs) {
      const number = sample.slice(0, sample.indexOf(repo)).reduce((n, r) => n + r.pairs.length, 0) + repo.pairs.indexOf(pair) + 1;
      const started = Date.now();
      console.log(`[${number}/10] START ${repo.name} ${pair.candidateSha.slice(0, 8)} — ${pair.subject}`);
      const result = evaluateCommitPair(repo.name, repo.repoPath, pair.parentSha, pair.candidateSha, pair.subject, repo.dependencyRoot, { snapshotCache, gitCaches });
      results.push(result);
      console.log(`[${number}/10] DONE  ${(Date.now() - started) / 1000}s analyzable=${result.analyzable} verdicts=${result.evaluations.map(e => e.verdict).join(',') || 'none'}`);
    }
  } finally {
    snapshotCache.releaseAll();
    gitCaches.blobCache.clear();
    gitCaches.treeCache.clear();
  }
  return results;
}

async function main() {
  const started = Date.now();
  const results: CampaignCaseResult[] = [];
  // Two repo workers matches the established campaign execution policy.
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < sample.length) {
      const repo = sample[next++];
      results.push(...await runRepo(repo));
    }
  }));
  results.sort((a, b) => sample.flatMap(r => r.pairs).findIndex(p => p.candidateSha === a.candidateSha) - sample.flatMap(r => r.pairs).findIndex(p => p.candidateSha === b.candidateSha));

  const golden = JSON.parse(fs.readFileSync(path.resolve('scripts/campaign/real_campaign_results.golden.json'), 'utf8'));
  const goldenByCandidate = new Map<string, unknown>(golden.details.map((r: CampaignCaseResult) => [r.candidateSha, semanticComparison(r)]));
  const regressions = results.filter(r => JSON.stringify(semanticComparison(r)) !== JSON.stringify(goldenByCandidate.get(r.candidateSha))).map(r => r.candidateSha);
  const evaluations = results.flatMap(r => r.evaluations);
  const useful = evaluations.filter(e => e.verdict === 'PRESERVED' || e.verdict === 'VIOLATED');
  const summary = {
    pairs: results.length,
    analyzablePairs: results.filter(r => r.analyzable).length,
    nonAnalyzablePairs: results.filter(r => !r.analyzable).length,
    mutations: evaluations.length,
    verdicts: Object.fromEntries(['PRESERVED', 'VIOLATED', 'UNKNOWN', 'NOT_APPLICABLE'].map(v => [v, evaluations.filter(e => e.verdict === v).length])),
    usefulVerdictCoverage: evaluations.length ? useful.length / evaluations.length : 0,
    unsafePositives: evaluations.filter(e => e.isUnsafePositive).length,
    goldenSemanticMatches: results.length - regressions.length,
    goldenSemanticRegressions: regressions,
    elapsedSeconds: (Date.now() - started) / 1000,
    maxReportedRssMiB: Math.max(0, ...evaluations.map(e => e.peakRssBytes)) / 1048576
  };
  const output = path.join(os.tmpdir(), 'sajimora-quality-10.json');
  fs.writeFileSync(output, JSON.stringify({ summary, results: results.map(semantic) }, null, 2));
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  console.log(`RESULTS ${output}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
