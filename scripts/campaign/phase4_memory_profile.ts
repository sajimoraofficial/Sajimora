import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitRepository,
  GitObjectReader,
  SnapshotFilesystem,
  TypeScriptProgramBuilder,
  TypeScriptV1Adapter,
  normalizeToTrackedRelative
} from '@sajimora/analysis';
import { evaluateCommitPair, CampaignCaseResult } from './campaign_runner';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';

export type Variant = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface StageTelemetry {
  stage: string;
  samples: number;
  elapsedMs: number;
  durationMs?: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  sourceFileCount: number;
  projectCount: number;
  retryCount: number;
}

export interface RunResult {
  variant: Variant;
  verdictProducing: boolean;
  normalizedResultHash: string | null;
  normalizedResult?: unknown;
  telemetry: StageTelemetry[];
  latencyMs: number;
  peakRss: number;
  postGcHeap: number | null;
  postGcRss: number | null;
  retryCount: number;
}

export interface Config {
  repoName: string;
  repoPath: string;
  parentSha: string;
  candidateSha: string;
  subject: string;
  dependencyRoot?: string;
}

const stageOrder = [
  'snapshot',
  'parent program',
  'parent diagnostics',
  'candidate program',
  'candidate diagnostics',
  'identity/mapping',
  'batch evaluation',
  'isolation retry',
  'cleanup',
  'cleanup+forced-GC'
];

class TelemetryRecorder {
  private readonly started = performance.now();
  private readonly stages = new Map<string, StageTelemetry>();

  record(stage: string, details?: { durationMs?: number; sourceFileCount?: number; projectCount?: number; retryCount?: number }): void {
    const memory = process.memoryUsage();
    const previous = this.stages.get(stage);
    this.stages.set(stage, {
      stage,
      samples: (previous?.samples ?? 0) + 1,
      elapsedMs: performance.now() - this.started,
      durationMs: details?.durationMs ?? previous?.durationMs,
      rss: Math.max(previous?.rss ?? 0, memory.rss),
      heapUsed: Math.max(previous?.heapUsed ?? 0, memory.heapUsed),
      heapTotal: Math.max(previous?.heapTotal ?? 0, memory.heapTotal),
      external: Math.max(previous?.external ?? 0, memory.external),
      arrayBuffers: Math.max(previous?.arrayBuffers ?? 0, memory.arrayBuffers ?? 0),
      sourceFileCount: details?.sourceFileCount ?? previous?.sourceFileCount ?? 0,
      projectCount: details?.projectCount ?? previous?.projectCount ?? 0,
      retryCount: Math.max(previous?.retryCount ?? 0, details?.retryCount ?? 0)
    });
  }

  result(): StageTelemetry[] {
    return stageOrder.map(stage => this.stages.get(stage) ?? {
      stage,
      samples: 0,
      elapsedMs: 0,
      rss: 0,
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
      sourceFileCount: 0,
      projectCount: 0,
      retryCount: 0
    });
  }
}

function stripSnapshotRoot(str: string): string {
  return str.replace(/(?:[A-Za-z]:[/\\][^\s"']*?|[^\s"']*?)[/\\]?sajimora-snapshot-[^/\\"\s']+[/\\]?/gi, 'snapshot/');
}

function canonical(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripSnapshotRoot(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'durationMs' && key !== 'peakRssBytes')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function normalizeResult(result: CampaignCaseResult): unknown {
  return canonical(result);
}

function hashNormalized(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function configFromArgs(): Config {
  const repoName = arg('--repo-name') ?? 'zod';
  const repoPath = path.resolve(arg('--repo-path') ?? `scripts/campaign/repos/${repoName}`);
  return {
    repoName,
    repoPath,
    parentSha: arg('--parent') ?? '68a609ac9b9516e6fe84e3558f17ce16b1032bef',
    candidateSha: arg('--candidate') ?? '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f',
    subject: arg('--subject') ?? 'Phase-4 controlled memory profile',
    dependencyRoot: path.resolve(arg('--dependency-root') ?? path.join(repoPath, 'node_modules'))
  };
}

function measureSingleWorld(config: Config, world: 'parent' | 'candidate', recorder: TelemetryRecorder): void {
  const repo = new GitRepository(config.repoPath);
  repo.validate();
  const derivation = deriveRealDiffObligations(config.repoPath, config.parentSha, config.candidateSha);
  if (derivation.status !== 'DERIVED') throw new Error(`Obligation derivation failed: ${derivation.reason}`);
  const sha = world === 'parent' ? config.parentSha : config.candidateSha;
  const snapshots = new SnapshotFilesystem(new GitObjectReader(repo));
  const snapshot = snapshots.materialize(sha);
  recorder.record('snapshot', { sourceFileCount: snapshot.trackedFiles.length, projectCount: 0 });

  try {
    const adapter = new TypeScriptV1Adapter();
    const changedFiles = [...new Set(derivation.obligations.map(obligation => {
      const file = obligation.mutatedSymbol?.declarationLocation?.filePath;
      return file ? normalizeToTrackedRelative(file, snapshot.root, snapshot.trackedFiles) : null;
    }).filter((file): file is string => Boolean(file)))];

    const result = new TypeScriptProgramBuilder().build({
      root: snapshot.root,
      trackedFiles: snapshot.trackedFiles,
      revision: { repositoryId: repo.repositoryId(), commitSha: sha },
      toolchain: adapter.toolchain(snapshot),
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      dependencyRoot: config.dependencyRoot && fs.existsSync(config.dependencyRoot) ? config.dependencyRoot : undefined,
      obligations: derivation.obligations,
      changedFiles: changedFiles.length ? changedFiles : undefined,
      memoryProfile: {
        world,
        onStage: event => recorder.record(`${event.world} ${event.stage}`, event)
      }
    });
    result.projects.length = 0;
  } finally {
    snapshot.cleanup();
    recorder.record('cleanup');
    if (typeof global.gc === 'function') global.gc();
    recorder.record('cleanup+forced-GC');
  }
}

function runChild(variant: Variant, config: Config): RunResult {
  const recorder = new TelemetryRecorder();
  const started = performance.now();
  let normalizedResult: unknown | undefined;

  if (variant === 'E' || variant === 'F') {
    measureSingleWorld(config, variant === 'E' ? 'parent' : 'candidate', recorder);
  } else {
    const result = evaluateCommitPair(
      config.repoName,
      config.repoPath,
      config.parentSha,
      config.candidateSha,
      config.subject,
      config.dependencyRoot,
      {
        memoryProfile: {
          disableIsolationRetries: variant === 'B',
          eagerDiagnosticRelease: variant === 'C',
          clearDeadReferencesBeforeGc: variant === 'D',
          onStage: (stage, details) => recorder.record(stage, details)
        }
      }
    );
    normalizedResult = normalizeResult(result);
  }

  const telemetry = recorder.result();
  const postGc = telemetry.find(stage => stage.stage === 'cleanup+forced-GC' && stage.samples > 0);
  const isolationStage = telemetry.find(stage => stage.stage === 'isolation retry');
  return {
    variant,
    verdictProducing: variant !== 'E' && variant !== 'F',
    normalizedResultHash: normalizedResult === undefined ? null : hashNormalized(normalizedResult),
    ...(normalizedResult === undefined ? {} : { normalizedResult }),
    telemetry,
    latencyMs: performance.now() - started,
    peakRss: Math.max(...telemetry.map(stage => stage.rss)),
    postGcHeap: postGc?.heapUsed ?? null,
    postGcRss: postGc?.rss ?? null,
    retryCount: isolationStage?.retryCount ?? 0
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = 0.95 * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, val) => sum + (val - avg) ** 2, 0) / (values.length - 1);
}

function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return average === 0 ? 0 : stddev(values) / average;
}

function firstDifference(expected: unknown, actual: unknown, at = '$'): { path: string; expected: unknown; actual: unknown } | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return { path: `${at}.length`, expected: expected.length, actual: actual.length };
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${at}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
    for (const key of keys) {
      if (!(key in expectedRecord)) return { path: `${at}.${key}`, expected: undefined, actual: actualRecord[key] };
      if (!(key in actualRecord)) return { path: `${at}.${key}`, expected: expectedRecord[key], actual: undefined };
      const difference = firstDifference(expectedRecord[key], actualRecord[key], `${at}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return { path: at, expected, actual };
}

function generateInterpretation(summaryMap: Map<Variant, any>): string {
  const a = summaryMap.get('A');
  const b = summaryMap.get('B');
  const d = summaryMap.get('D');

  const parts: string[] = [];

  if (a && b) {
    const timeDiffMs = a.latencyMsMedian - b.latencyMsMedian;
    const timeDiffPct = (timeDiffMs / a.latencyMsMedian) * 100;
    const retryCountA = a.retryCountMax ?? 0;
    if (retryCountA > 0 || Math.abs(timeDiffPct) > 5) {
      parts.push(`Isolation retries: Active (${retryCountA} retries). Disabling retries changed latency by ${timeDiffPct.toFixed(1)}% (${(timeDiffMs / 1000).toFixed(1)}s).`);
    } else {
      parts.push(`Isolation retries: 0 retries executed for this Zod pair (A vs B latency delta is ${timeDiffPct.toFixed(1)}%). Latency/RSS overhead is NOT caused by isolation-retry reconstruction.`);
    }
  }

  if (b && d) {
    const postGcHeapDiff = b.postGcHeapMedian - d.postGcHeapMedian;
    const postGcRssDiff = b.postGcRssMedian - d.postGcRssMedian;
    parts.push(`Application references: Clearing dead references in D shifted post-GC heap by ${(postGcHeapDiff / (1024 * 1024)).toFixed(1)} MiB and post-GC RSS by ${(postGcRssDiff / (1024 * 1024)).toFixed(1)} MiB.`);
    if (d.postGcHeapMedian > 500 * 1024 * 1024) {
      parts.push(`Working-set cost: Peak RSS (~${(d.peakRssMedian / (1024 * 1024 * 1024)).toFixed(2)} GiB) and Post-GC Heap (~${(d.postGcHeapMedian / (1024 * 1024)).toFixed(1)} MiB) remain high even after clearing dead references and forced GC. The measured latency and peak RSS is INTRINSIC TypeScript working-set cost of loading and type-checking dual compiler Programs.`);
    } else {
      parts.push(`Working-set cost: Clearing dead references significantly freed memory, indicating retained application references contributed substantially.`);
    }
  }

  return parts.join(' ');
}

function runParent(): void {
  const config = configFromArgs();
  const repetitions = Number(arg('--repetitions') ?? '5');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer');
  const output = path.resolve(arg('--output') ?? 'artifacts/phase4-memory-profile.json');

  const rawVariantsArg = arg('--variants');
  const variants: Variant[] = rawVariantsArg
    ? (rawVariantsArg.split(',').map(v => v.trim()) as Variant[])
    : ['A', 'B', 'D'];

  const results: RunResult[] = [];
  let baselineHash: string | undefined;
  let baselineResult: unknown | undefined;

  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`Starting Phase 0 memory profile: ${config.repoName} (${config.parentSha.slice(0, 7)}..${config.candidateSha.slice(0, 7)})`);
  console.log(`Variants: ${variants.join(', ')} (${repetitions} fresh Node runs each)`);

  for (const variant of variants) {
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      const childOutput = path.join(os.tmpdir(), `sajimora-phase4-memory-${process.pid}-${variant}-${iteration}.json`);
      const childArgs = [
        '--expose-gc',
        path.resolve('scripts/test-runtime/run-tsx-command.cjs'),
        __filename,
        '--child', variant,
        '--child-output', childOutput,
        '--repo-name', config.repoName,
        '--repo-path', config.repoPath,
        '--parent', config.parentSha,
        '--candidate', config.candidateSha,
        '--subject', config.subject,
        '--dependency-root', config.dependencyRoot ?? ''
      ];
      const child = spawnSync(process.execPath, childArgs, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.status !== 0) {
        throw new Error(`Variant ${variant} run ${iteration} failed (${child.status}):\n${child.stdout}\n${child.stderr}`);
      }
      const result = JSON.parse(fs.readFileSync(childOutput, 'utf8')) as RunResult;
      fs.rmSync(childOutput, { force: true });
      if (result.verdictProducing) {
        if (baselineHash === undefined) {
          baselineHash = result.normalizedResultHash ?? undefined;
          baselineResult = result.normalizedResult;
        }
        if (result.normalizedResultHash !== baselineHash) {
          const stoppedReport = {
            generatedAt: new Date().toISOString(),
            status: 'STOPPED_HASH_MISMATCH',
            config,
            repetitions,
            baselineHash,
            actualHash: result.normalizedResultHash,
            failedVariant: variant,
            failedIteration: iteration,
            firstDifference: firstDifference(baselineResult, result.normalizedResult),
            completedRuns: [...results, result]
          };
          fs.writeFileSync(output, JSON.stringify(stoppedReport, null, 2));
          throw new Error(`STOP: normalized evidence hash changed for variant ${variant} run ${iteration}: expected ${baselineHash}, got ${result.normalizedResultHash}. Partial report written to ${output}`);
        }
      }
      results.push(result);
      console.log(`[Variant ${variant} Run ${iteration}/${repetitions}] Latency: ${(result.latencyMs / 1000).toFixed(2)}s | Peak RSS: ${(result.peakRss / (1024 * 1024 * 1024)).toFixed(2)} GiB | Hash: ${result.normalizedResultHash?.slice(0, 16) ?? 'N/A'}`);
    }
  }

  const summaryMap = new Map<Variant, any>();

  const summary = variants.map(variant => {
    const runs = results.filter(result => result.variant === variant);
    const latencies = runs.map(r => r.latencyMs);
    const peakRsss = runs.map(r => r.peakRss);
    const postGcHeaps = runs.map(r => r.postGcHeap ?? 0);
    const postGcRsss = runs.map(r => r.postGcRss ?? 0);
    const retryCounts = runs.map(r => r.retryCount);

    const s = {
      variant,
      runs: runs.length,
      verdictProducing: runs[0].verdictProducing,
      normalizedResultHash: runs[0].normalizedResultHash,
      latencyMsMean: mean(latencies),
      latencyMsMedian: median(latencies),
      latencyMsP95: p95(latencies),
      latencyMsVariance: variance(latencies),
      latencyMsStdDev: stddev(latencies),
      latencyCoefficientOfVariation: coefficientOfVariation(latencies),
      peakRssMean: mean(peakRsss),
      peakRssMedian: median(peakRsss),
      peakRssP95: p95(peakRsss),
      peakRssVariance: variance(peakRsss),
      peakRssStdDev: stddev(peakRsss),
      peakRssCoefficientOfVariation: coefficientOfVariation(peakRsss),
      postGcHeapMean: mean(postGcHeaps),
      postGcHeapMedian: median(postGcHeaps),
      postGcHeapP95: p95(postGcHeaps),
      postGcRssMean: mean(postGcRsss),
      postGcRssMedian: median(postGcRsss),
      postGcRssP95: p95(postGcRsss),
      retryCountMax: Math.max(...retryCounts)
    };
    summaryMap.set(variant, s);
    return s;
  });

  const retentionReconstructionInterpretation = generateInterpretation(summaryMap);

  const reportPayload = {
    generatedAt: new Date().toISOString(),
    config,
    repetitions,
    baselineHash,
    parity: 'EXACT_PARITY_PASS',
    summary,
    retentionReconstructionInterpretation,
    runs: results
  };

  fs.writeFileSync(output, JSON.stringify(reportPayload, null, 2));
  console.log(`\n================================================================`);
  console.log(`PHASE 0 BENCHMARK SUMMARY (${config.repoName})`);
  console.log(`================================================================`);
  console.log(`Evidence SHA-256 Parity: EXACT MATCH (${baselineHash})`);
  for (const s of summary) {
    console.log(`Variant ${s.variant}:`);
    console.log(`  Latency:  median ${(s.latencyMsMedian / 1000).toFixed(2)}s | p95 ${(s.latencyMsP95 / 1000).toFixed(2)}s | stddev ${(s.latencyMsStdDev / 1000).toFixed(2)}s (CV: ${(s.latencyCoefficientOfVariation * 100).toFixed(1)}%)`);
    console.log(`  Peak RSS: median ${(s.peakRssMedian / (1024 * 1024 * 1024)).toFixed(2)} GiB | p95 ${(s.peakRssP95 / (1024 * 1024 * 1024)).toFixed(2)} GiB`);
    console.log(`  Post-GC Heap: median ${(s.postGcHeapMedian / (1024 * 1024)).toFixed(1)} MiB | Post-GC RSS: median ${(s.postGcRssMedian / (1024 * 1024)).toFixed(1)} MiB`);
  }
  console.log(`\nINTERPRETATION:`);
  console.log(retentionReconstructionInterpretation);
  console.log(`\nWrote full report to ${output}`);
}

const childVariant = arg('--child') as Variant | undefined;
if (childVariant) {
  const output = arg('--child-output');
  if (!output) throw new Error('Missing --child-output');
  fs.writeFileSync(output, JSON.stringify(runChild(childVariant, configFromArgs())));
} else {
  runParent();
}
