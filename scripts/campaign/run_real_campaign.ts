import * as path from 'node:path';
import * as fs from 'node:fs';
import { evaluateCommitPair, CampaignCaseResult } from './campaign_runner';
import { SnapshotSessionCache } from './SnapshotSessionCache';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';
import { OldBuildRecord } from './ProgramReuseGate';

interface RepoConfig {
  name: string;
  repoPath: string;
  dependencyRoot?: string;
  pairs: Array<{ parentSha: string; candidateSha: string; subject: string }>;
}

const campaignConfig: RepoConfig[] = [
  {
    name: 'zod',
    repoPath: path.resolve('scripts/campaign/repos/zod'),
    dependencyRoot: path.resolve('scripts/campaign/repos/zod/node_modules'),
    pairs: [
      {
        parentSha: '68a609ac9b9516e6fe84e3558f17ce16b1032bef',
        candidateSha: '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f',
        subject: "refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)"
      },
      {
        parentSha: '0227e53d03b5652be75422b6d10e0dd9bf340f0b',
        candidateSha: '68a609ac9b9516e6fe84e3558f17ce16b1032bef',
        subject: 'Widen literal inputs in property check types (#6520)'
      },
      {
        parentSha: 'f83ab51129038a2f868ee11dda906ed78ae2e478',
        candidateSha: '84dd3b0fc6cb5a24f773cb6db66bc934338b44ea',
        subject: 'perf: build literal and enum pattern regexes lazily (#6531)'
      },
      {
        parentSha: '74f9a6d3f2818f24e6df5394b8b6e60acb176463',
        candidateSha: 'f83ab51129038a2f868ee11dda906ed78ae2e478',
        subject: 'fix(v4): reject component-only strings from z.emoji() (#6532)'
      },
      {
        parentSha: '319f47f44f40755773a9aa83b6fdaaad1ff01d77',
        candidateSha: 'a2a019a57e4444f61bf677ca79c1352823e2b7c8',
        subject: 'Accept enum-typed targets in z.toZod (#6528)'
      },
      {
        parentSha: '08ba069e29d67b2f7b13b98dc9e70b1d99aeab5d',
        candidateSha: '319f47f44f40755773a9aa83b6fdaaad1ff01d77',
        subject: 'Emit a length-aware base64url pattern in toJSONSchema (#6527)'
      },
      {
        parentSha: '1ec6b7c5ec58d0e58f6b582c96e7cabfc5cb2f95',
        candidateSha: '08ba069e29d67b2f7b13b98dc9e70b1d99aeab5d',
        subject: 'perf(v4): read Luhn digits with charCodeAt instead of string indexing (#6529)'
      },
      {
        parentSha: '84dd3b0fc6cb5a24f773cb6db66bc934338b44ea',
        candidateSha: '0227e53d03b5652be75422b6d10e0dd9bf340f0b',
        subject: "docs: bump the star pill's GitHub mark to 20px"
      },
      {
        parentSha: 'a2a019a57e4444f61bf677ca79c1352823e2b7c8',
        candidateSha: '74f9a6d3f2818f24e6df5394b8b6e60acb176463',
        subject: 'docs: drop the toZod enum block from basics and pin curation rule'
      }
    ]
  },
  {
    name: 'TypeScript-Website',
    repoPath: path.resolve('scripts/campaign/repos/TypeScript-Website'),
    dependencyRoot: path.resolve('scripts/campaign/repos/TypeScript-Website/node_modules'),
    pairs: [
      {
        parentSha: '673b339a77d87f0e8187040c25c30801af802ab9',
        candidateSha: '5d0a1d07010d3053f3859f6f0a0d0b1d954a93ca',
        subject: 'Accessibility bug fix 2737380 (#3530)'
      },
      {
        parentSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
        candidateSha: '673b339a77d87f0e8187040c25c30801af802ab9',
        subject: 'Update for TS 6.0 (#3534)'
      },
      {
        parentSha: '32433bc2c7528771aa4c63b2d22d7172b0dd376c',
        candidateSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
        subject: 'Accessibility bug fix 2737338 (#3529)'
      },
      {
        parentSha: '57e19fd99f8128f9abd3810a89b9856f1b36b32b',
        candidateSha: '9953d5bf9168335e3ddad7b1752b3213f3f9a636',
        subject: 'fix(sandbox): getInitialCode should not use URL hash without full prefix (#3523)'
      },
      {
        parentSha: '49d7c6bae9c5e6f9d9c2b2acc1ef6b1de248704c',
        candidateSha: '32433bc2c7528771aa4c63b2d22d7172b0dd376c',
        subject: 'Bump the github-actions group with 2 updates (#3525)'
      }
    ]
  },
  {
    name: 'turborepo',
    repoPath: path.resolve('scripts/campaign/repos/turborepo'),
    dependencyRoot: path.resolve('scripts/campaign/repos/turborepo/node_modules'),
    pairs: [
      {
        parentSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b',
        candidateSha: '06f59004ba50fabd4c582230ed076ee909fb85fc',
        subject: 'perf: Reuse package manager detection during create startup (#14006)'
      },
      {
        parentSha: '4db9ca09bdac8cc0f8ece533cc480c10947f7bc1',
        candidateSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b',
        subject: 'perf: Compute Devtools graph depths without rescanning every edge (#14001)'
      },
      {
        parentSha: '6a95c81b161f7509a622de54dca44041bfd550cb',
        candidateSha: '4db9ca09bdac8cc0f8ece533cc480c10947f7bc1',
        subject: 'perf: Fetch only npm dist tags in the binary version endpoint (#14007)'
      },
      {
        parentSha: '58974208b6fdd5eda5d4a40d2ab00bcd5c25d31d',
        candidateSha: '6a95c81b161f7509a622de54dca44041bfd550cb',
        subject: 'perf: Binary search boundaries comments before each import (#14003)'
      }
    ]
  },
  {
    name: 'express',
    repoPath: path.resolve('scripts/campaign/repos/express'),
    dependencyRoot: path.resolve('scripts/campaign/repos/express/node_modules'),
    pairs: [
      {
        parentSha: 'cb19f04170fc815321d40dcd3bc620ae03c828cd',
        candidateSha: '90ec6206d3275fdf2787f2028c6f48a2d92e8042',
        subject: 'Improve error logging by logging full error object (#6464)'
      },
      {
        parentSha: 'a08da78e64a7fdc610d453fb7771754091d8ed3b',
        candidateSha: 'cb19f04170fc815321d40dcd3bc620ae03c828cd',
        subject: 'Upgrade content-type (#7234)'
      },
      {
        parentSha: 'dae209ae6559c29cfca2a1f4414c51d89ea643d5',
        candidateSha: 'a08da78e64a7fdc610d453fb7771754091d8ed3b',
        subject: 'deps: bump qs minimum to 6.15.2 (#7305)'
      }
    ]
  }
];

async function evaluateRepo(repo: RepoConfig, enableProgramReuse: boolean): Promise<CampaignCaseResult[]> {
  const repoResults: CampaignCaseResult[] = [];
  console.log(`\n>>> [REPOSITORY FAMILY: ${repo.name.toUpperCase()}] <<<`);
  console.log(`Repository Path: ${repo.repoPath}`);
  console.log(`Commit Pairs to Test: ${repo.pairs.length}\n`);

  // Layer 1: prefetch git blobs and trees for all pairs in this repo
  const revisions = repo.pairs.flatMap(p => [p.parentSha, p.candidateSha]);
  const gitCaches = RepoBlobPrefetcher.prefetch(repo.repoPath, revisions);

  // Layer 2A: session cache for materialized snapshots
  const snapshotCache = new SnapshotSessionCache(3);

  // Layer 2B: last candidate build record for program reuse
  const lastBuildRecord = { current: undefined as OldBuildRecord | undefined };

  try {
    for (let i = 0; i < repo.pairs.length; i++) {
      const pair = repo.pairs[i];
      console.log(`--- [${repo.name} ${i + 1}/${repo.pairs.length}] ---`);
      console.log(`  Candidate: ${pair.candidateSha.slice(0, 8)}`);
      console.log(`  Parent:    ${pair.parentSha.slice(0, 8)}`);
      console.log(`  Subject:   ${pair.subject}`);

      try {
        const result = evaluateCommitPair(
          repo.name,
          repo.repoPath,
          pair.parentSha,
          pair.candidateSha,
          pair.subject,
          repo.dependencyRoot,
          {
            snapshotCache,
            enableProgramReuse,
            lastBuildRecord,
            gitCaches
          }
        );

        repoResults.push(result);

        if (!result.analyzable) {
          console.log(`  Analyzable: NO (${result.nonAnalyzableReason})`);
        } else {
          console.log(`  Analyzable: YES (${result.mutationsCount} mutations derived)`);
          for (const ev of result.evaluations) {
            console.log(`    - ${ev.targetSymbol} (${ev.targetKind}) [${ev.classification}]`);
            console.log(`      File:     ${ev.targetFile}`);
            console.log(`      Verdict:  ${ev.verdict}`);
            if (ev.authorityGate) console.log(`      Gate:     ${ev.authorityGate}`);
            if (ev.authorityReason) console.log(`      Reason:   ${ev.authorityReason}`);
            console.log(`      Time:     ${ev.durationMs}ms | Peak RSS: ${(ev.peakRssBytes / 1024 / 1024).toFixed(1)}MB`);
            if (ev.isUnsafePositive) {
              console.log(`      CRITICAL ALERT: UNSAFE POSITIVE DETECTED!`);
            }
          }
        }
      } catch (err: any) {
        console.error(`  ERROR evaluating ${pair.candidateSha}:`, err.message);
      }
      if (typeof (global as any).gc === 'function') {
        (global as any).gc();
      }
      console.log('');
    }
  } finally {
    snapshotCache.releaseAll();
    lastBuildRecord.current = undefined;
    gitCaches.blobCache.clear();
    gitCaches.treeCache.clear();
  }

  return repoResults;
}

async function runCampaign() {
  const args = process.argv.slice(2);
  const enableProgramReuse = args.includes('--enable-program-reuse');
  const isCI = args.includes('--ci');
  const concurrencyArgIdx = args.indexOf('--concurrency');
  const customConcurrency = concurrencyArgIdx !== -1 && args[concurrencyArgIdx + 1]
    ? parseInt(args[concurrencyArgIdx + 1], 10)
    : undefined;

  const concurrency = isCI ? 1 : (customConcurrency ?? Math.min(campaignConfig.length, 2));

  console.log('================================================================');
  console.log('STARTING SAJIMORA REAL-REPOSITORY CAMPAIGN');
  console.log('Phase 0-4 Frozen Contract Verification & Useful Coverage Measurement');
  console.log('================================================================');
  console.log(`Execution Mode:`);
  console.log(`  - Layer 1 (Git Blob Pre-Fetch): Enabled`);
  console.log(`  - Layer 2A (Snapshot Cache):     Enabled (capacity=3)`);
  console.log(`  - Layer 2B (Program Reuse):      ${enableProgramReuse ? 'Enabled' : 'Disabled (default)'}`);
  console.log(`  - Layer 3 (Concurrency):         ${concurrency} worker(s)\n`);

  const startTime = Date.now();

  const taskPool = campaignConfig.map(repo => () => evaluateRepo(repo, enableProgramReuse));
  const perRepoResults: CampaignCaseResult[][] = new Array(campaignConfig.length);

  let nextIdx = 0;
  async function worker() {
    while (nextIdx < taskPool.length) {
      const idx = nextIdx++;
      perRepoResults[idx] = await taskPool[idx]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, taskPool.length) }, () => worker())
  );

  const allResults: CampaignCaseResult[] = perRepoResults.flat();

  // Summary Metrics Computation
  const totalPairs = allResults.length;
  const analyzablePairs = allResults.filter(r => r.analyzable);
  const nonAnalyzablePairs = allResults.filter(r => !r.analyzable);
  const allEvaluations = allResults.flatMap(r => r.evaluations);

  const preservedCount = allEvaluations.filter(e => e.verdict === 'PRESERVED').length;
  const violatedCount = allEvaluations.filter(e => e.verdict === 'VIOLATED').length;
  const unknownCount = allEvaluations.filter(e => e.verdict === 'UNKNOWN').length;
  const notApplicableCount = allEvaluations.filter(e => e.verdict === 'NOT_APPLICABLE').length;
  const unsafePositiveCount = allEvaluations.filter(e => e.isUnsafePositive).length;

  const usefulVerdicts = preservedCount + violatedCount;
  const totalAnalyzableEvaluations = allEvaluations.length;
  const coveragePercent = totalAnalyzableEvaluations > 0
    ? ((usefulVerdicts / totalAnalyzableEvaluations) * 100).toFixed(1)
    : '0.0';

  // UNKNOWN Taxonomy Breakdown
  const taxonomy: Record<string, number> = {};
  for (const e of allEvaluations) {
    if (e.verdict === 'UNKNOWN') {
      const key = `${e.authorityGate ?? 'UNKNOWN_GATE'} :: ${e.authorityReason ?? 'UNKNOWN_REASON'}`;
      taxonomy[key] = (taxonomy[key] || 0) + 1;
    }
  }

  const summary = {
    totalCommitPairs: totalPairs,
    analyzablePairs: analyzablePairs.length,
    nonAnalyzablePairs: nonAnalyzablePairs.length,
    totalMutationsDerived: totalAnalyzableEvaluations,
    verdicts: {
      PRESERVED: preservedCount,
      VIOLATED: violatedCount,
      UNKNOWN: unknownCount,
      NOT_APPLICABLE: notApplicableCount
    },
    usefulVerdictCoverage: `${coveragePercent}% (${usefulVerdicts}/${totalAnalyzableEvaluations})`,
    unsafePositives: unsafePositiveCount,
    unknownTaxonomy: taxonomy,
    campaignDurationMs: Date.now() - startTime
  };

  const outputPath = path.resolve('scripts/campaign/real_campaign_results.json');
  fs.writeFileSync(outputPath, JSON.stringify({ summary, details: allResults }, null, 2), 'utf8');

  console.log('\n================================================================');
  console.log('CAMPAIGN SUMMARY ROLLUP');
  console.log('================================================================');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDetailed results saved to: ${outputPath}`);
}

runCampaign().catch(err => {
  console.error('Fatal campaign execution error:', err);
  process.exit(1);
});
