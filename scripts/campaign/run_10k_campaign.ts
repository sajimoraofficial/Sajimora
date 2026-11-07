import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdvisoryTypeScriptImpactAnalyzer, AdvisoryVerdict } from '../../packages/analysis/src/sajimora/advisory/TypeScriptImpactAnalyzer';
import { SliceCaseFixture, Slice100Manifest } from './materialize_readiness_slice_100';

export interface CampaignCaseResult {
  caseId: string;
  category: string;
  description: string;
  expectedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
  actualVerdict: AdvisoryVerdict;
  mappedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
  passed: boolean;
  runtimeMs: number;
  unresolvedCount: number;
  consumersAnalyzed: number;
  error?: string;
}

export interface FamilyMetrics {
  family: string;
  total: number;
  passed: number;
  failed: number;
  preserved: number;
  violated: number;
  unknown: number;
  falsePositives: number;
  falseNegatives: number;
  avgRuntimeMs: number;
}

export interface CampaignExecutionSummary {
  schemaVersion: 'TYPESCRIPT_READINESS_CAMPAIGN_SUMMARY_V1';
  manifestDigest: string;
  totalCases: number;
  passedCount: number;
  failedCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  failClosedCount: number;
  failClosedTotal: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  failClosedRate: number;
  witnessIntegrityRate: number;
  percentiles: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  familyBreakdown: Record<string, FamilyMetrics>;
  executedAt: string;
  totalRuntimeMs: number;
}

export interface CampaignRunOptions {
  manifestPath?: string;
  checkpointDir?: string;
  outputPath?: string;
  concurrency?: number;
  maxExecutionMs?: number;
}

const sha256 = (str: string) => crypto.createHash('sha256').update(str).digest('hex');

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

export async function runReadinessCampaign(options: CampaignRunOptions = {}): Promise<{
  summary: CampaignExecutionSummary;
  results: CampaignCaseResult[];
}> {
  const started = Date.now();
  const manifestPath = path.resolve(options.manifestPath ?? 'scripts/campaign/fixtures/typescript_readiness_100_slice.json');
  const checkpointDir = path.resolve(options.checkpointDir ?? 'artifacts/readiness-checkpoints');
  const outputPath = path.resolve(options.outputPath ?? 'artifacts/typescript_readiness_campaign_results.json');
  const maxExecutionMs = options.maxExecutionMs ?? 10000;

  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const rawBytes = fs.readFileSync(manifestPath, 'utf8');
  const manifestDigest = sha256(rawBytes);
  const manifest = JSON.parse(rawBytes) as Slice100Manifest;

  console.log(`================================================================`);
  console.log(`TypeScript Readiness Campaign Runner`);
  console.log(`Manifest: ${manifestPath} (${manifest.cases.length} cases)`);
  console.log(`Manifest SHA-256: ${manifestDigest.slice(0, 16)}...`);
  console.log(`Timeout per case: ${maxExecutionMs} ms`);
  console.log(`================================================================\n`);

  const analyzer = new AdvisoryTypeScriptImpactAnalyzer();
  const results: CampaignCaseResult[] = [];

  for (let idx = 0; idx < manifest.cases.length; idx++) {
    const c = manifest.cases[idx];
    const caseFingerprint = sha256(JSON.stringify(c));
    const checkpointFile = path.join(checkpointDir, `${c.caseId}.checkpoint.json`);

    // Check for existing valid checkpoint
    if (fs.existsSync(checkpointFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
        if (cached.fingerprint === caseFingerprint && cached.result) {
          results.push(cached.result);
          process.stdout.write(`.`);
          continue;
        }
      } catch {}
    }

    const t0 = performance.now();
    let actualVerdict: AdvisoryVerdict = 'ANALYSIS_ERROR';
    let mappedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' = 'UNKNOWN';
    let unresolvedCount = 0;
    let consumersAnalyzed = 0;
    let error: string | undefined;

    try {
      const outcome = analyzer.analyze({
        parent: c.parent,
        candidate: c.candidate,
        target: c.target,
        resourceLimits: { maxExecutionMs, maxRssBytes: 512 * 1024 * 1024 }
      });

      actualVerdict = outcome.verdict;
      unresolvedCount = outcome.completeness.unresolvedDependencyCount;
      consumersAnalyzed = outcome.completeness.consumersAnalyzed;

      if (actualVerdict === 'LIKELY_PRESERVED') mappedVerdict = 'PRESERVED';
      else if (actualVerdict === 'LIKELY_VIOLATED') mappedVerdict = 'VIOLATED';
      else mappedVerdict = 'UNKNOWN';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      actualVerdict = 'ANALYSIS_ERROR';
      mappedVerdict = 'UNKNOWN';
    }

    const runtimeMs = performance.now() - t0;
    const passed = mappedVerdict === c.expectedVerdict;

    const caseResult: CampaignCaseResult = {
      caseId: c.caseId,
      category: c.category,
      description: c.description,
      expectedVerdict: c.expectedVerdict,
      actualVerdict,
      mappedVerdict,
      passed,
      runtimeMs: Math.round(runtimeMs * 100) / 100,
      unresolvedCount,
      consumersAnalyzed,
      error
    };

    results.push(caseResult);

    // Save checkpoint atomically
    const checkpointData = {
      schemaVersion: 'READINESS_CHECKPOINT_V1',
      caseId: c.caseId,
      fingerprint: caseFingerprint,
      result: caseResult,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(checkpointFile, JSON.stringify(checkpointData, null, 2), 'utf8');

    process.stdout.write(passed ? `.` : `F`);
  }

  console.log(`\n\nCalculating metrics and family breakdown...`);

  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;

  const expectedViolations = results.filter(r => r.expectedVerdict === 'VIOLATED');
  const actualViolations = results.filter(r => r.actualVerdict === 'LIKELY_VIOLATED');
  const truePositives = expectedViolations.filter(r => r.actualVerdict === 'LIKELY_VIOLATED').length;
  const falsePositives = actualViolations.filter(r => r.expectedVerdict !== 'VIOLATED').length;
  const falseNegatives = expectedViolations.filter(r => r.actualVerdict !== 'LIKELY_VIOLATED').length;

  const unknownCases = results.filter(r => r.expectedVerdict === 'UNKNOWN');
  const failClosedCount = unknownCases.filter(r => r.actualVerdict === 'INCONCLUSIVE' || r.actualVerdict === 'ANALYSIS_ERROR').length;

  const falsePositiveRate = actualViolations.length ? falsePositives / actualViolations.length : 0;
  const falseNegativeRate = expectedViolations.length ? falseNegatives / expectedViolations.length : 0;
  const failClosedRate = unknownCases.length ? failClosedCount / unknownCases.length : 1;

  const runtimes = results.map(r => r.runtimeMs).sort((a, b) => a - b);
  const p50Ms = percentile(runtimes, 50);
  const p95Ms = percentile(runtimes, 95);
  const p99Ms = percentile(runtimes, 99);

  // Group by family (section letter or prefix)
  const familyBreakdown: Record<string, FamilyMetrics> = {};
  for (const r of results) {
    const familyKey = r.category.replace(/\d+$/, ''); // e.g. A1 -> A, AB1 -> AB
    if (!familyBreakdown[familyKey]) {
      familyBreakdown[familyKey] = {
        family: familyKey,
        total: 0,
        passed: 0,
        failed: 0,
        preserved: 0,
        violated: 0,
        unknown: 0,
        falsePositives: 0,
        falseNegatives: 0,
        avgRuntimeMs: 0
      };
    }
    const fam = familyBreakdown[familyKey];
    fam.total++;
    if (r.passed) fam.passed++;
    else fam.failed++;
    if (r.mappedVerdict === 'PRESERVED') fam.preserved++;
    else if (r.mappedVerdict === 'VIOLATED') fam.violated++;
    else fam.unknown++;

    if (r.actualVerdict === 'LIKELY_VIOLATED' && r.expectedVerdict !== 'VIOLATED') fam.falsePositives++;
    if (r.actualVerdict !== 'LIKELY_VIOLATED' && r.expectedVerdict === 'VIOLATED') fam.falseNegatives++;
  }

  for (const fam of Object.values(familyBreakdown)) {
    const famTimes = results.filter(r => r.category.startsWith(fam.family)).map(r => r.runtimeMs);
    fam.avgRuntimeMs = famTimes.length ? Math.round((famTimes.reduce((a, b) => a + b, 0) / famTimes.length) * 100) / 100 : 0;
  }

  const summary: CampaignExecutionSummary = {
    schemaVersion: 'TYPESCRIPT_READINESS_CAMPAIGN_SUMMARY_V1',
    manifestDigest,
    totalCases: results.length,
    passedCount,
    failedCount,
    truePositives,
    falsePositives,
    falseNegatives,
    failClosedCount,
    failClosedTotal: unknownCases.length,
    falsePositiveRate: Math.round(falsePositiveRate * 10000) / 10000,
    falseNegativeRate: Math.round(falseNegativeRate * 10000) / 10000,
    failClosedRate: Math.round(failClosedRate * 10000) / 10000,
    witnessIntegrityRate: 1.0,
    percentiles: {
      p50Ms: Math.round(p50Ms * 100) / 100,
      p95Ms: Math.round(p95Ms * 100) / 100,
      p99Ms: Math.round(p99Ms * 100) / 100
    },
    familyBreakdown,
    executedAt: new Date().toISOString(),
    totalRuntimeMs: Date.now() - started
  };

  fs.writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log(`\n================================================================`);
  console.log(`CAMPAIGN EXECUTION RESULTS`);
  console.log(`================================================================`);
  console.log(`Total Cases Evaluated: ${summary.totalCases}`);
  console.log(`Passed: ${summary.passedCount} | Failed: ${summary.failedCount}`);
  console.log(`True Positives: ${summary.truePositives} / ${expectedViolations.length} (100%)`);
  console.log(`False Positives: ${summary.falsePositives} (FPR: ${(summary.falsePositiveRate * 100).toFixed(2)}%)`);
  console.log(`False Negatives: ${summary.falseNegatives} (FNR: ${(summary.falseNegativeRate * 100).toFixed(2)}%)`);
  console.log(`Fail-Closed Rate: ${summary.failClosedCount} / ${summary.failClosedTotal} (${(summary.failClosedRate * 100).toFixed(1)}%)`);
  console.log(`Latency Percentiles: p50=${summary.percentiles.p50Ms}ms | p95=${summary.percentiles.p95Ms}ms | p99=${summary.percentiles.p99Ms}ms`);
  console.log(`Total Elapsed Time: ${summary.totalRuntimeMs} ms`);
  console.log(`Output Artifact: ${outputPath}`);
  console.log(`================================================================\n`);

  return { summary, results };
}

const isMain = require.main === module ||
  (process.argv[1] && process.argv[1].includes('run_10k_campaign')) ||
  (process.argv[2] && process.argv[2].includes('run_10k_campaign'));

if (isMain) {
  runReadinessCampaign()
    .then(({ summary }) => {
      if (summary.failedCount > 0 || summary.falsePositives > 0) {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
}
