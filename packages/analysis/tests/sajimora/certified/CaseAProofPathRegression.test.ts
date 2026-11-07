import { test } from 'node:test';
import * as assert from 'node:assert';
import { CertifiedCampaignAdapter } from '../../../../../scripts/campaign/CertifiedCampaignAdapter';
import { ensureCaseAProofPathFixture } from '../../../../../scripts/campaign/caseAProofPathFixture';
import { ensureCaseAProofPathVariant } from '../../../../../scripts/campaign/caseAProofPathVariants';

for (const scenario of [
  { name: 'changed consumer requires lifecycle proof', fixture: ensureCaseAProofPathFixture, compatible: true, expected: 'UNKNOWN' },
  // The legacy "violated" fixture contains compatible string calls. A caller's
  // false flag cannot manufacture a source-backed incompatibility proof.
  { name: 'producer flag cannot fabricate violation', fixture: () => ensureCaseAProofPathVariant('violated'), compatible: false, expected: 'UNKNOWN' },
  { name: 'not-applicable', fixture: () => ensureCaseAProofPathVariant('not-applicable'), compatible: true, expected: 'NOT_APPLICABLE' }
]) {
  test(`Git-backed Case-A proof path: ${scenario.name}`, () => {
    const fixture = scenario.fixture();
    const evaluate = () => CertifiedCampaignAdapter.evaluateRealCaseA({
      ...fixture,
      repoId: `case-a-${scenario.name}-proof-path-fixture`,
      isCompatibleProof: scenario.compatible
    });
    const first = evaluate();
    const second = evaluate();
    assert.deepStrictEqual(second, first);
    assert.equal(first.verdictResult.verdict, scenario.expected, JSON.stringify(first));
    if (scenario.expected === 'UNKNOWN') {
      assert.equal(first.blockerCode, 'LIFECYCLE_RULE_VIOLATION');
      assert.ok(!first.passedGates.includes('VERDICT_AUTHORITY'));
    } else {
      assert.ok(first.passedGates.includes('VERDICT_AUTHORITY'));
      assert.equal(first.passedGates.length, 10);
    }
  });
}

test('Case-A unchanged sealed consumer is preserved regardless of caller proof flag', () => {
  const fixture = ensureCaseAProofPathFixture();
  for (const isCompatibleProof of [true, false]) {
    const result = CertifiedCampaignAdapter.evaluateRealCaseA({ ...fixture,
      candidateSha: fixture.parentSha, repoId: 'unchanged-case-a', isCompatibleProof });
    assert.equal(result.verdictResult.verdict, 'PRESERVED', JSON.stringify(result));
    assert.ok(result.passedGates.includes('VERDICT_AUTHORITY'));
  }
});
