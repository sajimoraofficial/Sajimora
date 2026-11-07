const { parentPort, workerData } = require('node:worker_threads');
require('tsx/cjs');
const { CommitProjectIndexer } = require('../../packages/analysis/src/sajimora/indexed/CommitProjectIndexer.ts');
const { GenerationIndexDatabase } = require('../../packages/analysis/src/sajimora/indexed/GenerationIndexDatabase.ts');
const { IndexedQueryEngineV2 } = require('../../packages/analysis/src/sajimora/indexed/IndexedQueryEngineV2.ts');
const { VerifiedDependencyEnvironment } = require('../../packages/analysis/src/sajimora/indexed/VerifiedDependencyEnvironment.ts');

const database = new GenerationIndexDatabase(workerData.databasePath);
try {
  const indexer = new CommitProjectIndexer();
  const run = (stage, action) => {
    const started = performance.now();
    const result = action();
    parentPort.postMessage({ kind: 'STAGE', stage, durationMs: Math.round(performance.now() - started),
      status: result.status, blockers: result.blockers ?? [], workerHeapUsedBytes: process.memoryUsage().heapUsed });
    return result;
  };
  const request = commitSha => ({ repositoryPath: workerData.repositoryPath, commitSha, database,
    dependencyRoot: workerData.dependencyRoot,
    onProgress: event => parentPort.postMessage({ kind: 'PROGRESS', commitSha, ...event }) });
  const parent = run('COLD_PARENT', () => indexer.indexCommit(request(workerData.parentSha)));
  if (parent.status !== 'PUBLISHED') {
    parentPort.postMessage({ kind: 'DONE', status: 'INDEX_PARTIAL', queryStatus: 'NOT_RUN', proofVerdicts: [] });
    return;
  }
  const candidate = run('COLD_CANDIDATE', () => indexer.indexCommit(request(workerData.candidateSha)));
  if (candidate.status !== 'PUBLISHED') {
    parentPort.postMessage({ kind: 'DONE', status: 'INDEX_PARTIAL', queryStatus: 'NOT_RUN', proofVerdicts: [] });
    return;
  }
  const warm = run('WARM_PARENT', () => indexer.indexCommit(request(workerData.parentSha)));
  if (parent.status === 'PUBLISHED' && candidate.status === 'PUBLISHED' && warm.status === 'REUSED') {
    const query = run('WARM_QUERY', () => {
      const environment = workerData.dependencyRoot
        ? VerifiedDependencyEnvironment.verify(workerData.repositoryPath, workerData.dependencyRoot,
          database.getPublishedManifest(parent.repositoryId, workerData.parentSha, 'SAJIMORA_INDEX_V2'),
          database.getPublishedManifest(parent.repositoryId, workerData.candidateSha, 'SAJIMORA_INDEX_V2')) : undefined;
      return new IndexedQueryEngineV2().evaluate(database,
        parent.repositoryId, workerData.parentSha, workerData.candidateSha, environment);
    });
    parentPort.postMessage({ kind: 'DONE', status: query.status === 'COMPLETED' ? 'COMPLETED' : 'QUERY_INCOMPATIBLE',
      queryStatus: query.status,
      proofVerdicts: query.status === 'COMPLETED' ? query.results.map(item => item.proof.verdict) : [] });
  } else parentPort.postMessage({ kind: 'DONE', status: 'INDEX_INCOMPLETE', queryStatus: 'NOT_RUN', proofVerdicts: [] });
} catch (error) {
  parentPort.postMessage({ kind: 'FAILED', error: error instanceof Error ? error.message : String(error) });
} finally {
  database.close();
}
