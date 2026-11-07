const { parentPort, workerData } = require('node:worker_threads');
require('tsx/cjs');
const { ProductionVerificationCore } = require('../../packages/core/src/sajimora/verification/ProductionVerificationCore.ts');
const { TypeScriptProductionAdapter } = require('../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProductionAdapter.ts');
const { TypeScriptNumericWitnessChecker } = require('../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker.ts');
const { TypeScriptFiniteBooleanChecker } = require('../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptFiniteBooleanProof.ts');
const { TypeScriptFiniteBooleanTypeChecker } = require('../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptFiniteBooleanTypeProof.ts');
const { TypeScriptBooleanClosedCoverageChecker } = require('../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptBooleanClosedCoverageChecker.ts');
function snapshot(data) {
  const contents = new Map(data.contents);
  const norm = p => p.replace(/\\/g, '/').replace(/^\/+/, '');
  return { ...data, readTextFile: p => contents.get(norm(p)), readBinaryFile: p => {
    const text = contents.get(norm(p)); return text === undefined ? undefined : Buffer.from(text);
  } };
}
(async () => {
  const core = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker(),
    new TypeScriptFiniteBooleanChecker(), new TypeScriptFiniteBooleanTypeChecker()],
    new TypeScriptBooleanClosedCoverageChecker(),
    phase => parentPort.postMessage({ kind: 'PROGRESS', phase }));
  core.registerAdapter(new TypeScriptProductionAdapter());
  const result = await core.verifyRepository({ repositoryId: workerData.repositoryId,
    parentSnapshot: snapshot(workerData.parentSnapshot), candidateSnapshot: snapshot(workerData.candidateSnapshot) });
  parentPort.postMessage({ ...result, resources: { workerHeapUsedBytes: process.memoryUsage().heapUsed } });
})().catch(error => { throw error; });
