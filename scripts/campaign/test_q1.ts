import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import * as path from 'path';

const repoPath = path.resolve('scripts/campaign/repos/zod');
console.log('Testing Q01 with evaluateRealCaseB...');
try {
  const res1 = CertifiedCampaignAdapter.evaluateRealCaseB({
    repoPath,
    parentSha: 'f3e7c72e8ce66bb1d5113aeb5e1c0c658981d2f7',
    candidateSha: 'f412178defd4348872fa581db952f6713677502a',
    targetSymbol: 'releases',
    targetFile: 'scripts/check-lockstep.ts'
  });
  console.log('Q01 result:', {
    verdict: res1.verdictResult.verdict,
    passedGates: res1.passedGates,
    failedGate: res1.failedGate,
    blockerCode: res1.blockerCode,
    detail: res1.detailMessage
  });
} catch (e: any) {
  console.error('Error running Q01:', e);
}
