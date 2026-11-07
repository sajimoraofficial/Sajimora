import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { GenericRepository, GenericRepositorySnapshot } from '../../packages/core/src/sajimora/verification/contracts';
import { VerificationExecutionResult } from '../../packages/core/src/sajimora/verification/ProductionVerificationCore';
import { PRODUCTION_LIMITS, validateRepositoryBudget } from '../../packages/core/src/sajimora/verification/ExecutionLimits';

/** A worker is necessary: an AbortSignal cannot interrupt synchronous compiler work. */
export async function verifyProductionInWorker(repository: GenericRepository,
  options: { signal?: AbortSignal; timeoutMs?: number; maxProcessRssBytes?: number } = {}): Promise<VerificationExecutionResult> {
  if (options.signal?.aborted) throw new Error('VERIFICATION_CANCELLED');
  validateRepositoryBudget(repository);
  const serialize = (snapshot: GenericRepositorySnapshot) => ({ snapshotId: snapshot.snapshotId,
    rootIdentifier: '/', files: snapshot.files, omittedBinaryPaths: snapshot.omittedBinaryPaths,
    contents: snapshot.files.map(f => [f.path.replace(/\\/g, '/').replace(/^\/+/, ''), snapshot.readTextFile(f.path)]) });
  const worker = new Worker(path.join(__dirname, 'productionWorker.cjs'), {
    workerData: { repositoryId: repository.repositoryId, parentSnapshot: serialize(repository.parentSnapshot),
      candidateSnapshot: serialize(repository.candidateSnapshot) },
    resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 128 }
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const maxProcessRssBytes = Math.min(options.maxProcessRssBytes ?? PRODUCTION_LIMITS.maxProcessRssBytes,
      PRODUCTION_LIMITS.maxProcessRssBytes);
    let sampledPeakProcessRssBytes = process.memoryUsage().rss;
    let lastPhase = 'PROJECT_GRAPH';
    const sampleRss = () => {
      sampledPeakProcessRssBytes = Math.max(sampledPeakProcessRssBytes, process.memoryUsage().rss);
      if (sampledPeakProcessRssBytes > maxProcessRssBytes) finish(new Error('RESOURCE_LIMIT_PROCESS_RSS'));
    };
    let settled = false;
    const finish = (error?: Error, result?: VerificationExecutionResult) => {
      if (settled) return;
      settled = true;
      sampledPeakProcessRssBytes = Math.max(sampledPeakProcessRssBytes, process.memoryUsage().rss);
      clearInterval(memorySampler);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      worker.removeAllListeners();
      void worker.terminate().then(() => error ? reject(error) : resolve({ ...result!, resources: {
        durationMs: Date.now() - started, sampledPeakProcessRssBytes,
        workerHeapUsedBytes: result?.resources?.workerHeapUsedBytes ?? 0
      } }), reject);
    };
    const memorySampler = setInterval(sampleRss, 50);
    memorySampler.unref();
    const abort = () => finish(new Error('VERIFICATION_CANCELLED'));
    const timer = setTimeout(() => finish(new Error(`VERIFICATION_TIMEOUT:${lastPhase}`)),
      Math.min(options.timeoutMs ?? PRODUCTION_LIMITS.timeoutMs, PRODUCTION_LIMITS.timeoutMs));
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (message?.kind === 'PROGRESS') lastPhase = String(message.phase);
      else finish(undefined, message);
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`VERIFICATION_WORKER_EXIT_${code}`)));
    sampleRss();
    if (options.signal?.aborted) abort();
  });
}
