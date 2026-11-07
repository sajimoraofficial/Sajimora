import { AdvisoryInput, AdvisoryTypeScriptImpactAnalyzer, AdvisoryVerdict } from './TypeScriptImpactAnalyzer';

export interface AdvisoryBenchmarkCase { name: string; input: AdvisoryInput; expectedVerdict: AdvisoryVerdict; expectedConsumerCount?: number; tags: readonly string[]; }
export interface AdvisoryBenchmarkCaseResult { name: string; tags: readonly string[]; expectedVerdict: AdvisoryVerdict; actualVerdict: AdvisoryVerdict; expectedConsumerCount: number | null; actualConsumerCount: number; deterministic: boolean; elapsedMs: number; rssDeltaBytes: number; }
export interface AdvisoryBenchmarkReport { schemaVersion: 'ADVISORY_BENCHMARK_V1'; cases: readonly AdvisoryBenchmarkCaseResult[]; metrics: { consumerDiscoveryRecall: number | null; truePositiveRate: number | null; falsePositiveRate: number | null; falseNegativeRate: number | null; unresolvedRate: number; deterministicRepeatability: number; runtimeMs: number; peakRssDeltaBytes: number; }; }

/** Executes only supplied sealed fixtures. Expected labels make calibration gaps visible. */
export function runAdvisoryBenchmark(cases: readonly AdvisoryBenchmarkCase[], analyzer = new AdvisoryTypeScriptImpactAnalyzer()): AdvisoryBenchmarkReport {
  const results = cases.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(testCase => {
    const rss = process.memoryUsage().rss; const started = performance.now(); const first = analyzer.analyze(testCase.input); const elapsedMs = performance.now() - started;
    const second = analyzer.analyze(testCase.input); const deterministic = JSON.stringify(first) === JSON.stringify(second);
    return { name: testCase.name, tags: [...testCase.tags].sort(), expectedVerdict: testCase.expectedVerdict, actualVerdict: first.verdict, expectedConsumerCount: testCase.expectedConsumerCount ?? null, actualConsumerCount: first.consumers.length, deterministic, elapsedMs, rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rss) };
  });
  const expectedConsumers = results.filter(r => r.expectedConsumerCount !== null).reduce((n, r) => n + r.expectedConsumerCount!, 0);
  const discoveredConsumers = results.filter(r => r.expectedConsumerCount !== null).reduce((n, r) => n + Math.min(r.actualConsumerCount, r.expectedConsumerCount!), 0);
  const positives = results.filter(r => r.expectedVerdict === 'LIKELY_VIOLATED'); const actualPositives = results.filter(r => r.actualVerdict === 'LIKELY_VIOLATED');
  const tp = positives.filter(r => r.actualVerdict === 'LIKELY_VIOLATED').length; const fp = actualPositives.filter(r => r.expectedVerdict !== 'LIKELY_VIOLATED').length;
  return { schemaVersion: 'ADVISORY_BENCHMARK_V1', cases: results, metrics: { consumerDiscoveryRecall: expectedConsumers ? discoveredConsumers / expectedConsumers : null, truePositiveRate: positives.length ? tp / positives.length : null, falsePositiveRate: actualPositives.length ? fp / actualPositives.length : null, falseNegativeRate: positives.length ? (positives.length - tp) / positives.length : null, unresolvedRate: results.length ? results.filter(r => r.actualVerdict === 'INCONCLUSIVE').length / results.length : 0, deterministicRepeatability: results.length ? results.filter(r => r.deterministic).length / results.length : 1, runtimeMs: results.reduce((n, r) => n + r.elapsedMs, 0), peakRssDeltaBytes: Math.max(0, ...results.map(r => r.rssDeltaBytes)) } };
}
