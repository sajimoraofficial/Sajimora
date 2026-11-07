import { execFileSync } from 'node:child_process';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import { ensureCaseAProofPathFixture } from './caseAProofPathFixture';

function execute() {
  const fixture = ensureCaseAProofPathFixture();
  const providerParent = execFileSync('git', ['show', `${fixture.parentSha}:${fixture.targetFile}`], { cwd: fixture.repoPath });
  const providerCandidate = execFileSync('git', ['show', `${fixture.candidateSha}:${fixture.targetFile}`], { cwd: fixture.repoPath });
  const consumerParent = execFileSync('git', ['show', `${fixture.parentSha}:${fixture.consumerFile}`], { cwd: fixture.repoPath });
  const consumerCandidate = execFileSync('git', ['show', `${fixture.candidateSha}:${fixture.consumerFile}`], { cwd: fixture.repoPath });
  const started = process.hrtime.bigint();
  const result = CertifiedCampaignAdapter.evaluateRealCaseA({
    repoPath: fixture.repoPath,
    repoId: 'case-a-proof-path-fixture',
    parentSha: fixture.parentSha,
    candidateSha: fixture.candidateSha,
    targetSymbol: fixture.targetSymbol,
    targetFile: fixture.targetFile,
    consumerFile: fixture.consumerFile
  });
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    fixture,
    providerByteIdentical: providerParent.equals(providerCandidate),
    consumerChanged: !consumerParent.equals(consumerCandidate),
    result,
    runtimeMs,
    rssBytes: process.memoryUsage().rss
  };
}

const first = execute();
const second = execute();
console.log(JSON.stringify({
  first,
  second: {
    result: second.result,
    runtimeMs: second.runtimeMs,
    rssBytes: second.rssBytes,
    deterministic: JSON.stringify(first.result) === JSON.stringify(second.result)
  }
}, null, 2));
