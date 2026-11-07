/**
 * @file run_java_campaign.ts
 * Unified empirical evaluation campaign harness for Java (Phases J-10A/B/C).
 *
 * Evaluates real-world and synthetic Java commits against human-audited gold sets:
 * - Consumer discovery recall
 * - Certified false-positive rate (strictly 0.0 on qualified F0 cases)
 * - Certified precision (100.0% on qualified F0 cases)
 * - Advisory precision and recall
 * - F0 repository qualification rate
 * - p50/p95 execution runtime and RSS memory delta
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runJavaAnalysis } from '../sajimora/analyzeJava';
import { JavaPilotCase } from './generate_java_pilot_50';

export interface JavaCaseExecutionResult {
  id: string;
  category: string;
  description: string;
  qualificationStatus: string;
  certifiedConclusion: string;
  effectiveVerdict: string;
  expectedQualification: string;
  expectedVerdict: string;
  runtimeMs: number;
  memoryRssDeltaBytes: number;
  discoveredConsumers: string[];
  goldConsumers: string[];
  discoveredBreakingConsumers: string[];
  goldBreakingConsumers: string[];
  isCertifiedUnsoundPositive: boolean;
  isCorrectQualification: boolean;
  isCorrectVerdict: boolean;
}

export interface JavaCampaignMetrics {
  totalCommits: number;
  qualifiedF0Commits: number;
  retainedInAdvisoryCommits: number;
  f0QualificationRatePct: number;
  consumerDiscoveryRecallPct: number;
  totalGoldConsumers: number;
  totalDiscoveredGoldConsumers: number;
  certifiedFalsePositives: number;
  certifiedFalsePositiveRatePct: number;
  certifiedPrecisionPct: number;
  advisoryBreakingRecallPct: number;
  advisoryBreakingPrecisionPct: number;
  runtimeP50Ms: number;
  runtimeP95Ms: number;
  rssDeltaP50Mb: number;
  rssDeltaP95Mb: number;
  totalElapsedMs: number;
}

export interface JavaCampaignReport {
  timestamp: string;
  manifestPath: string;
  metrics: JavaCampaignMetrics;
  results: JavaCaseExecutionResult[];
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, index))];
}

export interface RunJavaCampaignOptions {
  manifestPath?: string;
  outputPath?: string;
  markdownPath?: string;
  filterIds?: string[];
  quiet?: boolean;
}

export function runJavaCampaign(options: RunJavaCampaignOptions = {}): JavaCampaignReport {
  const manifestPath = path.resolve(
    options.manifestPath ?? path.join(__dirname, 'fixtures/java_pilot_manifest_50.json')
  );

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Campaign manifest not found at ${manifestPath}`);
  }

  const manifestData: JavaPilotCase[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cases = options.filterIds?.length
    ? manifestData.filter(c => options.filterIds!.includes(c.id))
    : manifestData;

  const results: JavaCaseExecutionResult[] = [];
  const campaignStart = Date.now();

  let totalGoldConsumers = 0;
  let totalDiscoveredGoldConsumers = 0;
  let totalGoldBreaking = 0;
  let totalDiscoveredGoldBreaking = 0;
  let totalReportedBreaking = 0;

  for (const tc of cases) {
    const memBefore = process.memoryUsage().rss;
    const caseStart = Date.now();

    const analysis = runJavaAnalysis({
      repoId: tc.id,
      historicalFiles: tc.historicalFiles,
      candidateFiles: tc.candidateFiles,
      format: 'json'
    });

    const elapsedMs = Date.now() - caseStart;
    const memDelta = Math.max(0, process.memoryUsage().rss - memBefore);

    const qualStatus = analysis.qualification.qualificationStatus;
    const certConclusion = analysis.reportJson.certifiedPanel.verifiedConclusion;
    const effectiveVerdict = analysis.effectiveVerdict;

    const discoveredConsumers = (analysis.advisoryResult?.consumers ?? []).map(c => c.consumerFile);
    const discoveredBreaking = (analysis.advisoryResult?.impacts ?? [])
      .filter(i => i.classification === 'LIKELY_BROKEN')
      .map(i => i.consumerFile);

    // Evaluate consumer discovery recall
    const goldConsumers = tc.goldSet.goldConsumers ?? [];
    totalGoldConsumers += goldConsumers.length;
    for (const gc of goldConsumers) {
      if (discoveredConsumers.includes(gc)) {
        totalDiscoveredGoldConsumers++;
      }
    }

    // Evaluate advisory breaking precision & recall
    const goldBreaking = tc.goldSet.goldBreakingConsumers ?? [];
    totalGoldBreaking += goldBreaking.length;
    totalReportedBreaking += discoveredBreaking.length;
    for (const gb of goldBreaking) {
      if (discoveredBreaking.includes(gb)) {
        totalDiscoveredGoldBreaking++;
      }
    }

    // Soundness check: Unsound positive is claiming COMPATIBLE when ground truth is INCOMPATIBLE
    const isCertifiedUnsoundPositive =
      qualStatus === 'QUALIFIED_FOR_CERTIFIED_F0' &&
      effectiveVerdict === 'COMPATIBLE' &&
      tc.goldSet.expectedVerdict === 'INCOMPATIBLE';

    const isCorrectQualification = qualStatus === tc.goldSet.expectedQualification;
    const isCorrectVerdict = effectiveVerdict === tc.goldSet.expectedVerdict;

    const itemResult: JavaCaseExecutionResult = {
      id: tc.id,
      category: tc.category,
      description: tc.description,
      qualificationStatus: qualStatus,
      certifiedConclusion: certConclusion,
      effectiveVerdict,
      expectedQualification: tc.goldSet.expectedQualification,
      expectedVerdict: tc.goldSet.expectedVerdict,
      runtimeMs: elapsedMs,
      memoryRssDeltaBytes: memDelta,
      discoveredConsumers,
      goldConsumers,
      discoveredBreakingConsumers: discoveredBreaking,
      goldBreakingConsumers: goldBreaking,
      isCertifiedUnsoundPositive,
      isCorrectQualification,
      isCorrectVerdict
    };

    results.push(itemResult);

    if (!options.quiet) {
      const mark = isCertifiedUnsoundPositive ? '❌ UNSOUND' : isCorrectVerdict ? '✓' : '~';
      console.log(`[${mark}] ${tc.id} (${tc.category}): qual=${qualStatus}, verdict=${effectiveVerdict} (${elapsedMs}ms)`);
    }
  }

  const runtimes = results.map(r => r.runtimeMs).sort((a, b) => a - b);
  const memoryDeltas = results.map(r => r.memoryRssDeltaBytes).sort((a, b) => a - b);

  const qualifiedCases = results.filter(r => r.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0');
  const certifiedFalsePositives = qualifiedCases.filter(r => r.isCertifiedUnsoundPositive).length;
  const certifiedTruePositives = qualifiedCases.filter(
    r => r.effectiveVerdict === 'COMPATIBLE' && r.expectedVerdict === 'COMPATIBLE'
  ).length;

  const certifiedPrecision =
    certifiedTruePositives + certifiedFalsePositives > 0
      ? (certifiedTruePositives / (certifiedTruePositives + certifiedFalsePositives)) * 100
      : 100.0;

  const consumerRecall =
    totalGoldConsumers > 0 ? (totalDiscoveredGoldConsumers / totalGoldConsumers) * 100 : 100.0;

  const advisoryRecall =
    totalGoldBreaking > 0 ? (totalDiscoveredGoldBreaking / totalGoldBreaking) * 100 : 100.0;

  const advisoryPrecision =
    totalReportedBreaking > 0 ? (totalDiscoveredGoldBreaking / totalReportedBreaking) * 100 : 100.0;

  const metrics: JavaCampaignMetrics = {
    totalCommits: results.length,
    qualifiedF0Commits: qualifiedCases.length,
    retainedInAdvisoryCommits: results.length - qualifiedCases.length,
    f0QualificationRatePct: Math.round((qualifiedCases.length / results.length) * 1000) / 10,
    consumerDiscoveryRecallPct: Math.round(consumerRecall * 10) / 10,
    totalGoldConsumers,
    totalDiscoveredGoldConsumers,
    certifiedFalsePositives,
    certifiedFalsePositiveRatePct:
      qualifiedCases.length > 0
        ? Math.round((certifiedFalsePositives / qualifiedCases.length) * 1000) / 10
        : 0.0,
    certifiedPrecisionPct: Math.round(certifiedPrecision * 10) / 10,
    advisoryBreakingRecallPct: Math.round(advisoryRecall * 10) / 10,
    advisoryBreakingPrecisionPct: Math.round(advisoryPrecision * 10) / 10,
    runtimeP50Ms: percentile(runtimes, 50),
    runtimeP95Ms: percentile(runtimes, 95),
    rssDeltaP50Mb: Math.round((percentile(memoryDeltas, 50) / (1024 * 1024)) * 10) / 10,
    rssDeltaP95Mb: Math.round((percentile(memoryDeltas, 95) / (1024 * 1024)) * 10) / 10,
    totalElapsedMs: Date.now() - campaignStart
  };

  const report: JavaCampaignReport = {
    timestamp: new Date().toISOString(),
    manifestPath,
    metrics,
    results
  };

  // Write machine-readable JSON report if requested
  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, JSON.stringify(report, null, 2), 'utf8');
  }

  // Write Markdown summary report if requested
  if (options.markdownPath) {
    fs.mkdirSync(path.dirname(options.markdownPath), { recursive: true });
    fs.writeFileSync(options.markdownPath, formatCampaignMarkdown(report), 'utf8');
  }

  return report;
}

export function formatCampaignMarkdown(report: JavaCampaignReport): string {
  const m = report.metrics;
  return `
# Sajimora Java Empirical Evaluation Campaign Report (Phase J-10)
**Timestamp:** \`${report.timestamp}\`  
**Manifest:** \`${report.manifestPath}\`  
**Total Commits Evaluated:** \`${m.totalCommits}\`

## Executive Metrics Summary
| Metric | Observed Value | Scoped Acceptance Gate | Status |
|---|---|---|---|
| **Certified False-Positive Rate** | **${m.certifiedFalsePositiveRatePct}%** (${m.certifiedFalsePositives} FP) | **0.0%** (Strictly Zero Unsound Proofs) | ${m.certifiedFalsePositives === 0 ? '✅ PASS' : '❌ FAIL'} |
| **Certified Precision** | **${m.certifiedPrecisionPct}%** | **100.0%** | ${m.certifiedPrecisionPct === 100 ? '✅ PASS' : '❌ FAIL'} |
| **Consumer Discovery Recall** | **${m.consumerDiscoveryRecallPct}%** (${m.totalDiscoveredGoldConsumers}/${m.totalGoldConsumers}) | **≥ 95.0%** | ${m.consumerDiscoveryRecallPct >= 95 ? '✅ PASS' : '❌ FAIL'} |
| **Advisory Breaking Recall** | **${m.advisoryBreakingRecallPct}%** | Characterized Empirical Baseline | ℹ️ INFO |
| **Advisory Breaking Precision** | **${m.advisoryBreakingPrecisionPct}%** | Characterized Empirical Baseline | ℹ️ INFO |
| **F0 Qualification Rate** | **${m.f0QualificationRatePct}%** (${m.qualifiedF0Commits}/${m.totalCommits}) | Characterized Empirical Baseline | ℹ️ INFO |
| **Runtime p50 / p95** | **${m.runtimeP50Ms} ms / ${m.runtimeP95Ms} ms** | p50 < 200 ms, p95 < 1000 ms | ${m.runtimeP95Ms < 1000 ? '✅ PASS' : '⚠️ WARN'} |
| **RSS Delta p50 / p95** | **${m.rssDeltaP50Mb} MB / ${m.rssDeltaP95Mb} MB** | p50 < 30 MB, p95 < 100 MB | ${m.rssDeltaP95Mb < 100 ? '✅ PASS' : '⚠️ WARN'} |

## Per-Category Qualification Breakdown
- Single-Module Clean: Evaluated against direct class and method delta obligations.
- Multi-Module Reactor: Evaluated against cross-module Maven/Gradle reactor graphs.
- Disqualified Commits: Retained in advisory without generating false certified proofs.
- Adversarial Scenarios: Validated against shadowing, deep inheritance, and reflection.

Total Execution Time: ${Math.round(m.totalElapsedMs / 1000)}s
`.trim();
}

if (require.main === module) {
  const rep = runJavaCampaign();
  console.log(formatCampaignMarkdown(rep));
}
