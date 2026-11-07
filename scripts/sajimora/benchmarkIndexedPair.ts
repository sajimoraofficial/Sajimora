import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

const [repositoryPath, parentSha, candidateSha, dependencyRoot] = process.argv.slice(2);
if (!repositoryPath || !parentSha || !candidateSha) {
  throw new Error('USAGE: benchmarkIndexedPair.ts <repository> <parent-sha> <candidate-sha> [dependency-root]');
}
const maxDurationMs = 30_000;
const maxProcessRssBytes = 1024 * 1024 * 1024;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-index-benchmark-'));
const databasePath = path.join(temporaryDirectory, 'generation.sqlite');
const worker = new Worker(path.join(__dirname, 'indexedBenchmarkWorker.cjs'), {
  workerData: { repositoryPath, parentSha, candidateSha, dependencyRoot, databasePath },
  resourceLimits: { maxOldGenerationSizeMb: 832, maxYoungGenerationSizeMb: 48 }
});
const started = performance.now();
const stages: unknown[] = [];
const progress: unknown[] = [];
let sampledPeakProcessRssBytes = process.memoryUsage().rss;
let finished = false;
const cleanup = async () => {
  await worker.terminate();
  for (const name of fs.readdirSync(temporaryDirectory)) fs.unlinkSync(path.join(temporaryDirectory, name));
  fs.rmdirSync(temporaryDirectory);
};
const finish = async (status: string, details: Record<string, unknown> = {}) => {
  if (finished) return;
  finished = true;
  clearInterval(sampler);
  sampledPeakProcessRssBytes = Math.max(sampledPeakProcessRssBytes, process.memoryUsage().rss);
  await cleanup();
  process.stdout.write(JSON.stringify({ status, durationMs: Math.round(performance.now() - started),
    sampledPeakProcessRssBytes, stages, progress, ...details }, null, 2) + '\n');
  if (status !== 'COMPLETED') process.exitCode = 1;
};
const sampler = setInterval(() => {
  sampledPeakProcessRssBytes = Math.max(sampledPeakProcessRssBytes, process.memoryUsage().rss);
  if (sampledPeakProcessRssBytes > maxProcessRssBytes) void finish('RESOURCE_LIMIT_PROCESS_RSS');
  else if (performance.now() - started > maxDurationMs) void finish('TIMEOUT');
}, 50);
worker.on('message', message => {
  if (message?.kind === 'STAGE') stages.push(message);
  else if (message?.kind === 'PROGRESS') progress.push(message);
  else if (message?.kind === 'DONE') void finish(message.status, { queryStatus: message.queryStatus,
    proofVerdicts: message.proofVerdicts });
  else if (message?.kind === 'FAILED') void finish('FAILED', { error: message.error });
});
worker.once('error', error => { void finish('WORKER_ERROR', { error: error.message }); });
worker.once('exit', code => { if (!finished) void finish('WORKER_EXIT', { code }); });
