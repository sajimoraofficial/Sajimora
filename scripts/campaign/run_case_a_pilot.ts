import * as path from 'node:path';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';

async function runCaseAPilot() {
  console.log('================================================================');
  console.log('STARTING STAGE 2: REAL CASE-A PILOT');
  console.log('================================================================\n');

  const qStart = Date.now();
  const repoPath = path.resolve('scripts/campaign/repos/TypeScript-Website');

  const res = CertifiedCampaignAdapter.evaluateRealCaseA({
    repoPath,
    repoId: 'TypeScript-Website',
    parentSha: '21ee08f7e769751be723508e94f453fdcb43940e',
    candidateSha: '3253346b917106e7a94faa1cdec9158fc4f328e9',
    targetSymbol: 'parsePrimitive',
    targetFile: 'packages/ts-twoslasher/src/utils.ts',
    consumerFile: 'packages/ts-twoslasher/src/index.ts'
  });

  const runtimeMs = Date.now() - qStart;
  const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
  const verdict = res.verdictResult?.verdict || 'UNKNOWN';
  const failedGate = res.failedGate || (reachedEvaluateProof ? 'NONE' : 'UNKNOWN');
  const blockerCode = res.blockerCode || res.verdictResult?.auditTrace?.authorityDecision?.reason || 'NONE';

  console.log('--- FORENSIC EVIDENCE ---');
  console.log(`Verdict: ${verdict}`);
  console.log(`Passed Gates: ${res.passedGates.join(', ')}`);
  console.log(`Failed Gate: ${failedGate}`);
  console.log(`Blocker Code: ${blockerCode}`);
  if (res.detailMessage) {
    console.log(`Detail: ${res.detailMessage}`);
  }
  if (res.verdictResult?.auditTrace?.runtimeFailure) {
    console.log(`Runtime Failure: ${res.verdictResult.auditTrace.runtimeFailure.message}`);

  }
  
  console.log(`\nRuntime: ${runtimeMs}ms`);
}

runCaseAPilot().catch(err => {
  console.error('Fatal pilot error:', err);
  process.exit(1);
});
