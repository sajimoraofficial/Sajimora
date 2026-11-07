import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import { ensureCaseAProofPathFixture } from './caseAProofPathFixture';
import { ensureCaseAProofPathVariant } from './caseAProofPathVariants';

const fixtures = [
  { name: 'preserved', fixture: ensureCaseAProofPathFixture(), isCompatibleProof: true },
  { name: 'violated', fixture: ensureCaseAProofPathVariant('violated'), isCompatibleProof: false },
  { name: 'not-applicable', fixture: ensureCaseAProofPathVariant('not-applicable'), isCompatibleProof: true }
];

const outcomes = fixtures.map(({ name, fixture, isCompatibleProof }) => {
  const run = () => CertifiedCampaignAdapter.evaluateRealCaseA({
    ...fixture,
    repoId: `case-a-${name}-proof-path-fixture`,
    isCompatibleProof
  });
  const started = process.hrtime.bigint();
  const first = run();
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const second = run();
  return {
    name,
    fixture,
    verdict: first.verdictResult.verdict,
    passedGates: first.passedGates,
    evaluateProofReached: first.passedGates.includes('VERDICT_AUTHORITY'),
    deterministic: JSON.stringify(first) === JSON.stringify(second),
    runtimeMs,
    rssBytes: process.memoryUsage().rss
  };
});
console.log(JSON.stringify(outcomes, null, 2));
