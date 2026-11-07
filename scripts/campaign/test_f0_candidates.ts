import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import * as path from 'path';

async function testQuery(qId: string, repoName: string, parentSha: string, candidateSha: string, symbol: string, file: string) {
  const repoPath = path.resolve('scripts/campaign/repos', repoName);
  console.log(`\nEvaluating ${qId} (${repoName} - ${symbol})...`);
  const t0 = Date.now();
  const res = CertifiedCampaignAdapter.evaluateRealCaseB({
    repoPath,
    parentSha,
    candidateSha,
    targetSymbol: symbol,
    targetFile: file
  });
  const dur = Date.now() - t0;
  console.log(`${qId} Result (${dur}ms):`, {
    verdict: res.verdictResult.verdict,
    passedGates: res.passedGates,
    failedGate: res.failedGate,
    blockerCode: res.blockerCode,
    detail: res.detailMessage
  });
}

async function main() {
  await testQuery('Q30', 'turborepo', '8ef6aaf286ec874ab1637c8bdc191e86a095a458', '77e975c94fea84e4056394b085de3cf2edb370ca', 'WorkspaceRecord', 'apps/factory/agent/lib/workspace.ts');
}

main().catch(console.error);
