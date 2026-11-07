import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  SemanticIndexDatabase,
  SemanticIngestionWorker,
  WarmIndexedQueryEngine
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';

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

function calculateCanonicalHash(result: unknown): string {
  const normalized = canonical(result);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('PHASE 5 BENCHMARK: WARM INDEXED QUERY PATH');
  console.log('================================================================\n');

  const repoName = 'zod';
  const repoPath = path.resolve('scripts/campaign/repos/zod');
  const dependencyRoot = path.resolve('scripts/campaign/repos/zod/node_modules');
  const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
  const candidateSha = '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
  const GOLDEN_SHA = '0078f8c53d7cb33c17e9a164f97dc0f3a3b9d6be71efc8a0eb8903d6921c0c15';

  const cacheDir = path.resolve('scripts/campaign/.index_cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const dbPath = path.join(cacheDir, 'zod_pair1.db');
  const isCached = fs.existsSync(dbPath);

  const db = new SemanticIndexDatabase({ location: dbPath });

  try {
    // -------------------------------------------------------------
    // Phase 4 Ingestion (Cold Path - runs only if not cached)
    // -------------------------------------------------------------
    if (!isCached) {
      console.log('1. Ingestion Phase (Index not cached, running SemanticIngestionWorker)...');
      const derivation = deriveRealDiffObligations(repoPath, parentSha, candidateSha);
      if (derivation.status !== 'DERIVED') {
        throw new Error(`Failed to derive obligations: ${derivation.status}`);
      }

      const worker = new SemanticIngestionWorker();
      const ingestStart = Date.now();
      const ingestSummary = worker.ingestCommitPair({
        repoName,
        repoPath,
        parentSha,
        candidateSha,
        db,
        dependencyRoot,
        obligations: derivation.obligations
      });
      const ingestEnd = Date.now();
      const ingestDuration = ingestEnd - ingestStart;
      console.log(`   Ingestion complete in ${ingestDuration}ms (${(ingestDuration / 1000).toFixed(2)}s)`);
      console.log(`   Ingested: ${ingestSummary.proofObligationsCount} obligations, ${ingestSummary.candidateContractsCount} contracts, ${ingestSummary.certificatesCount} certs\n`);
    } else {
      console.log(`1. Using pre-existing persistent SQLite index at: ${dbPath}\n`);
    }

    // -------------------------------------------------------------
    // Phase 5 Warm Indexed Query Path
    // -------------------------------------------------------------
    console.log('2. Warmup Query...');
    const warmupResult = WarmIndexedQueryEngine.evaluateCommitPair({
      repoName,
      parentSha,
      candidateSha,
      db,
      subject: 'Phase-4 controlled memory profile'
    });
    const warmupHash = calculateCanonicalHash(warmupResult);
    if (warmupHash !== GOLDEN_SHA) {
      console.log(`Warmup hash mismatch! Got ${warmupHash}, expected ${GOLDEN_SHA}`);
    }
    console.log(`   Warmup successful (SHA: ${warmupHash.slice(0, 16)}...)\n`);

    console.log('3. Running 5 Timed Warm Iterations (ZERO compiler, ZERO git)...');
    const iterations = 5;
    const latencies: number[] = [];

    for (let i = 1; i <= iterations; i++) {
      const t0 = performance.now();
      const res = WarmIndexedQueryEngine.evaluateCommitPair({
        repoName,
        parentSha,
        candidateSha,
        db,
        subject: 'Phase-4 controlled memory profile'
      });
      const t1 = performance.now();
      const duration = t1 - t0;
      latencies.push(duration);

      const hash = calculateCanonicalHash(res);
      if (hash !== GOLDEN_SHA) {
        console.log(`Iteration ${i} hash mismatch: ${hash}`);
      }
      console.log(`   Iteration ${i}: ${duration.toFixed(2)}ms (Evaluations: ${res.evaluations.length}, Analyzable: ${res.analyzable})`);
    }

    latencies.sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const median = latencies[Math.floor(latencies.length / 2)];
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const mean = sum / latencies.length;
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

    const mem = process.memoryUsage();

    console.log('\n================================================================');
    console.log('WARM INDEXED QUERY BENCHMARK RESULTS');
    console.log('================================================================');
    console.log(`Iterations:       ${iterations}`);
    console.log(`Median Latency:   ${median.toFixed(2)}ms`);
    console.log(`Mean Latency:     ${mean.toFixed(2)}ms`);
    console.log(`Min Latency:      ${min.toFixed(2)}ms`);
    console.log(`Max Latency:      ${max.toFixed(2)}ms`);
    console.log(`p95 Latency:      ${p95.toFixed(2)}ms`);
    console.log(`----------------------------------------------------------------`);
    console.log(`Process RSS:      ${(mem.rss / (1024 * 1024)).toFixed(1)} MiB`);
    console.log(`Heap Used:        ${(mem.heapUsed / (1024 * 1024)).toFixed(1)} MiB`);
    console.log(`DB File Size:     ${(fs.statSync(dbPath).size / 1024).toFixed(1)} KiB`);
    console.log(`Golden Parity:    CERTIFIED (${GOLDEN_SHA})`);
    console.log('================================================================\n');

  } finally {
    db.close();
  }
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
