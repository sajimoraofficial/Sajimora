import * as path from 'node:path';
import * as assert from 'node:assert';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import { BlockerCode } from '../../packages/core/src/sajimora/certified/blockers';

interface PilotResult {
  pilotId: string;
  name: string;
  expectedVerdict: string;
  actualVerdict: string;
  passedGates: string[];
  failedGate?: string;
  blockerCode?: string;
  authorityGate?: string;
  reachedEvaluateProof: boolean;
  isUnsafePositive: boolean;
  success: boolean;
}

export function runCertifiedPilot(): PilotResult[] {
  console.log('================================================================');
  console.log('RUNNING CERTIFIED PR0-PR5 5-CASE PILOT');
  console.log('================================================================\n');

  const results: PilotResult[] = [];

  // -------------------------------------------------------------
  // Pilot 1 — Case-A Compatible
  // -------------------------------------------------------------
  console.log('>>> [Pilot 1] Case-A Compatible (Expected: PRESERVED) <<<');
  {
    const providerCode = `export function greet(name: string): string { return name; }`;
    const consumerCode = `
      import { greet } from './provider';
      export const msg: string = greet("world");
    `;

    const res = CertifiedCampaignAdapter.evaluateCaseA({
      parentFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      candidateFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      targetSymbol: 'greet',
      isCompatibleProof: true
    });

    const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
    const decision = res.verdictResult.auditTrace?.authorityDecision;
    const internalReason = res.verdictResult.internalReason;
    const isSuccess =
      res.verdictResult.verdict === 'PRESERVED' &&
      decision?.reason === 'ALL_EVALUABLE_COMPATIBLE' &&
      reachedEvaluateProof;

    results.push({
      pilotId: 'P1',
      name: 'Case-A Compatible',
      expectedVerdict: 'PRESERVED',
      actualVerdict: res.verdictResult.verdict,
      passedGates: res.passedGates,
      failedGate: res.failedGate,
      blockerCode: res.blockerCode,
      authorityGate: decision?.gate,
      reachedEvaluateProof,
      isUnsafePositive: false,
      success: isSuccess
    });

    console.log(`  Verdict: ${res.verdictResult.verdict} (gate: ${decision?.gate}, reason: ${decision?.reason})`);
    console.log(`  Passed Gates (${res.passedGates.length}): ${res.passedGates.join(' -> ')}`);
    console.log(`  evaluateProof() reached: ${reachedEvaluateProof}`);
    console.log(`  Pilot 1 Status: ${isSuccess ? 'PASS' : 'FAIL'}\n`);
    assert.strictEqual(res.verdictResult.verdict, 'PRESERVED');
    assert.strictEqual(decision?.reason, 'ALL_EVALUABLE_COMPATIBLE');
    assert.ok(reachedEvaluateProof);
  }

  // -------------------------------------------------------------
  // Pilot 2 — Case-A Incompatible
  // -------------------------------------------------------------
  console.log('>>> [Pilot 2] Case-A Incompatible (Expected: VIOLATED) <<<');
  {
    const providerCode = `export function greet(name: string): string { return "hello"; }`;
    const consumerCode = `
      import { greet } from './provider';
      export const msg: string = greet("world");
    `;

    const res = CertifiedCampaignAdapter.evaluateCaseA({
      parentFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      candidateFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      targetSymbol: 'greet',
      isCompatibleProof: false // Genuinely incompatible refutation witness
    });

    const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
    const decision = res.verdictResult.auditTrace?.authorityDecision;
    const isSuccess =
      res.verdictResult.verdict === 'VIOLATED' &&
      decision?.reason === 'INCOMPATIBLE_CONSUMER' &&
      reachedEvaluateProof;

    results.push({
      pilotId: 'P2',
      name: 'Case-A Incompatible',
      expectedVerdict: 'VIOLATED',
      actualVerdict: res.verdictResult.verdict,
      passedGates: res.passedGates,
      failedGate: res.failedGate,
      blockerCode: res.blockerCode,
      authorityGate: decision?.gate,
      reachedEvaluateProof,
      isUnsafePositive: false,
      success: isSuccess
    });

    console.log(`  Verdict: ${res.verdictResult.verdict} (gate: ${decision?.gate}, reason: ${decision?.reason})`);
    console.log(`  Passed Gates (${res.passedGates.length}): ${res.passedGates.join(' -> ')}`);
    console.log(`  evaluateProof() reached: ${reachedEvaluateProof}`);
    console.log(`  Pilot 2 Status: ${isSuccess ? 'PASS' : 'FAIL'}\n`);
    assert.strictEqual(res.verdictResult.verdict, 'VIOLATED');
    assert.strictEqual(decision?.reason, 'INCOMPATIBLE_CONSUMER');
    assert.ok(reachedEvaluateProof);
  }

  // -------------------------------------------------------------
  // Pilot 3 — Case-A Empty Closure
  // -------------------------------------------------------------
  console.log('>>> [Pilot 3] Case-A Empty Closure (Expected: NOT_APPLICABLE) <<<');
  {
    const providerCode = `export function unused(): string { return "unused"; }`;
    const consumerCode = `export const other: number = 42;`; // Zero historical consumers

    const res = CertifiedCampaignAdapter.evaluateCaseA({
      parentFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      candidateFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      targetSymbol: 'unused',
      isCompatibleProof: true
    });

    const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
    const decision = res.verdictResult.auditTrace?.authorityDecision;
    const internalReason = res.verdictResult.internalReason;
    const isSuccess =
      res.verdictResult.verdict === 'NOT_APPLICABLE' &&
      (decision?.reason === 'STRUCTURAL_TRIGGER_NO_CONSUMERS' || internalReason === 'STRUCTURAL_TRIGGER_NO_CONSUMERS') &&
      reachedEvaluateProof;

    results.push({
      pilotId: 'P3',
      name: 'Case-A Empty Closure',
      expectedVerdict: 'NOT_APPLICABLE',
      actualVerdict: res.verdictResult.verdict,
      passedGates: res.passedGates,
      failedGate: res.failedGate,
      blockerCode: res.blockerCode,
      authorityGate: decision?.gate,
      reachedEvaluateProof,
      isUnsafePositive: false,
      success: isSuccess
    });

    console.log(`  Verdict: ${res.verdictResult.verdict} (gate: ${decision?.gate}, reason: ${decision?.reason}, internalReason: ${internalReason})`);
    console.log(`  Passed Gates (${res.passedGates.length}): ${res.passedGates.join(' -> ')}`);
    console.log(`  evaluateProof() reached: ${reachedEvaluateProof}`);
    console.log(`  Pilot 3 Status: ${isSuccess ? 'PASS' : 'FAIL'}\n`);
    assert.strictEqual(res.verdictResult.verdict, 'NOT_APPLICABLE');
    assert.strictEqual(decision?.reason, 'STRUCTURAL_TRIGGER_NO_CONSUMERS');
    assert.strictEqual(internalReason, 'STRUCTURAL_TRIGGER_NO_CONSUMERS');
    assert.ok(reachedEvaluateProof);
  }

  // -------------------------------------------------------------
  // Pilot 4 — Case-B Fail Closed
  // -------------------------------------------------------------
  console.log('>>> [Pilot 4] Case-B Fail Closed (Expected: UNKNOWN / UNCERTAIN_IDENTITY) <<<');
  {
    // Minimal synthetic Git repository/commit fixture created with Git plumbing objects
    // Provider file is F0-valid and modified between parent and candidate (genuine Case-B)
    const { ensureCaseBGitFixture } = require('./caseBFixture');
    const fixture = ensureCaseBGitFixture();

    const res = CertifiedCampaignAdapter.evaluateRealCaseB({
      repoPath: fixture.repoPath,
      parentSha: fixture.parentSha,
      candidateSha: fixture.candidateSha,
      targetSymbol: fixture.targetSymbol,
      targetFile: fixture.targetFile
    });

    const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
    const stoppedAtGate5 =
      res.failedGate === 'IDENTITY' &&
      res.blockerCode === BlockerCode.IDENTITY_MISMATCH &&
      !res.passedGates.includes('OBLIGATION_VERIFICATION') &&
      !res.passedGates.includes('PROOF_VERIFICATION') &&
      !res.passedGates.includes('COVERAGE_VERIFICATION') &&
      !res.passedGates.includes('NORMALIZATION') &&
      !reachedEvaluateProof;

    const decision = res.verdictResult.auditTrace?.authorityDecision;
    const isSuccess =
      res.verdictResult.verdict === 'UNKNOWN' &&
      decision?.gate === 'IDENTITY' &&
      decision?.reason === 'UNCERTAIN_IDENTITY' &&
      stoppedAtGate5;

    results.push({
      pilotId: 'P4',
      name: 'Case-B Fail Closed',
      expectedVerdict: 'UNKNOWN',
      actualVerdict: res.verdictResult.verdict,
      passedGates: res.passedGates,
      failedGate: res.failedGate,
      blockerCode: res.blockerCode,
      authorityGate: decision?.gate,
      reachedEvaluateProof,
      isUnsafePositive: false,
      success: isSuccess
    });

    console.log(`  Verdict: ${res.verdictResult.verdict} (gate: ${decision?.gate}, reason: ${decision?.reason})`);
    console.log(`  Passed Gates (${res.passedGates.length}): ${res.passedGates.join(' -> ')}`);
    console.log(`  Stopped at Gate 5: ${stoppedAtGate5}`);
    console.log(`  Obligations/Proofs/evaluateProof NOT reached: ${!reachedEvaluateProof}`);
    console.log(`  Pilot 4 Status: ${isSuccess ? 'PASS' : 'FAIL'}\n`);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'IDENTITY');
    assert.strictEqual(decision?.reason, 'UNCERTAIN_IDENTITY');
    assert.ok(stoppedAtGate5);
  }

  // -------------------------------------------------------------
  // Pilot 5 — Coverage Omission
  // -------------------------------------------------------------
  console.log('>>> [Pilot 5] Coverage Omission (Expected: UNKNOWN / MISSING_EVIDENCE) <<<');
  {
    const providerCode = `export function greet(name: string): string { return name; }`;
    const consumerCode = `
      import { greet } from './provider';
      export const msg: string = greet("world");
    `;

    const res = CertifiedCampaignAdapter.evaluateCaseA({
      parentFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      candidateFiles: [
        { path: 'provider.ts', content: providerCode },
        { path: 'consumer.ts', content: consumerCode }
      ],
      targetSymbol: 'greet',
      isCompatibleProof: true,
      omitCoverage: true // Deliberately omit coverage entry from ledger
    });

    const reachedEvaluateProof = res.passedGates.includes('VERDICT_AUTHORITY');
    const stoppedAtGate8 =
      res.failedGate === 'COVERAGE' &&
      res.blockerCode === BlockerCode.MISSING_EVIDENCE &&
      res.passedGates.includes('PROOF_VERIFICATION') &&
      !res.passedGates.includes('COVERAGE_VERIFICATION') &&
      !res.passedGates.includes('NORMALIZATION') &&
      !reachedEvaluateProof;

    const decision = res.verdictResult.auditTrace?.authorityDecision;
    const isSuccess =
      res.verdictResult.verdict === 'UNKNOWN' &&
      decision?.gate === 'COVERAGE' &&
      stoppedAtGate8;

    results.push({
      pilotId: 'P5',
      name: 'Coverage Omission',
      expectedVerdict: 'UNKNOWN',
      actualVerdict: res.verdictResult.verdict,
      passedGates: res.passedGates,
      failedGate: res.failedGate,
      blockerCode: res.blockerCode,
      authorityGate: decision?.gate,
      reachedEvaluateProof,
      isUnsafePositive: false,
      success: isSuccess
    });

    console.log(`  Verdict: ${res.verdictResult.verdict} (gate: ${decision?.gate}, blockerCode: ${res.blockerCode})`);
    console.log(`  Passed Gates (${res.passedGates.length}): ${res.passedGates.join(' -> ')}`);
    console.log(`  Stopped at Gate 8 (COVERAGE): ${stoppedAtGate8}`);
    console.log(`  Pilot 5 Status: ${isSuccess ? 'PASS' : 'FAIL'}\n`);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'COVERAGE');
    assert.strictEqual(res.blockerCode, BlockerCode.MISSING_EVIDENCE);
    assert.ok(stoppedAtGate8);
  }

  return results;
}

if (require.main === module) {
  const results = runCertifiedPilot();
  const allPass = results.every(r => r.success);
  console.log(`================================================================`);
  console.log(`PILOT SUMMARY: ${results.filter(r => r.success).length}/${results.length} PASSED`);
  console.log(`================================================================`);
  if (!allPass) {
    process.exit(1);
  }
}
