/**
 * Test Suite 7: VCS & ChangeVerdict Priority Rules
 * Verifies Test Requirement 9.
 */

import * as assert from 'assert';
import {
  computeVcsScore,
  computeChangeVerdict,
  ExpectationRecord,
  ChangeVerdict,
} from '../src';

console.log('--- Running VCS & ChangeVerdict Priority Tests ---');

const allowedVerdicts: ChangeVerdict[] = [
  'ALLOW',
  'WARN',
  'CLARIFY',
  'BLOCK',
  'INSUFFICIENT_EVIDENCE',
];

// Helper to create expectation
function createExp(verdict: any, ecmConfidence = 0.9): ExpectationRecord {
  return {
    expectationId: 'e-1',
    changeId: 'c-1',
    workspaceId: 'w-1',
    expectationType: 'FILE_CHANGE',
    description: 'test',
    ecmConfidence,
    ecmProvenance: 'DEVELOPER_DECLARED',
    collectedEvidenceIds: [],
    reconciliationState: verdict === 'SATISFIED' ? 'CONSISTENT' : 'UNRESOLVED',
    verdict,
    verdictReason: '',
  };
}

// 1. VCS Calculation Formula Tests
// Full satisfaction, high deterministic ratio
const vcsHigh = computeVcsScore({
  totalExpectations: 5,
  satisfiedCount: 5,
  complementarySatisfiedCount: 0,
  unsatisfiedCount: 0,
  boundaryViolatedCount: 0,
  contradictoryCount: 0,
  totalEvidenceEntries: 5,
  deterministicEvidenceEntries: 5, // 100% -> weight 1.00
});
assert.strictEqual(vcsHigh, 1.0);

// Sub-threshold VCS (< 0.40)
const vcsLow = computeVcsScore({
  totalExpectations: 5,
  satisfiedCount: 1,
  complementarySatisfiedCount: 0,
  unsatisfiedCount: 4,
  boundaryViolatedCount: 0,
  contradictoryCount: 2,
  totalEvidenceEntries: 5,
  deterministicEvidenceEntries: 1, // weight 0.70
});
assert.ok(vcsLow < 0.40, `Low VCS must be < 0.40, got ${vcsLow}`);

// 2. ChangeVerdict Priority Rules

// Rule 1: Boundary Violated -> BLOCK
const resRule1 = computeChangeVerdict({
  vcs: 0.95, // Even with high VCS!
  expectations: [createExp('BOUNDARY_VIOLATED')],
  boundaryViolations: 1,
  contradictions: 0,
  ecmConfidence: 1.0,
});
assert.strictEqual(resRule1.verdict, 'BLOCK');
assert.ok(allowedVerdicts.includes(resRule1.verdict));

// Rule 2: High-confidence unsatisfied -> BLOCK
const resRule2 = computeChangeVerdict({
  vcs: 0.70,
  expectations: [createExp('UNSATISFIED', 0.85)],
  boundaryViolations: 0,
  contradictions: 0,
  ecmConfidence: 0.85,
});
assert.strictEqual(resRule2.verdict, 'BLOCK');

// Rule 3: VCS >= 0.80 and contradictions == 0 -> ALLOW
const resRule3 = computeChangeVerdict({
  vcs: 0.85,
  expectations: [createExp('SATISFIED')],
  boundaryViolations: 0,
  contradictions: 0,
  ecmConfidence: 0.9,
});
assert.strictEqual(resRule3.verdict, 'ALLOW');

// Rule 4: VCS >= 0.55 and contradictions == 0 -> WARN
const resRule4 = computeChangeVerdict({
  vcs: 0.65,
  expectations: [createExp('SATISFIED')],
  boundaryViolations: 0,
  contradictions: 0,
  ecmConfidence: 0.7,
});
assert.strictEqual(resRule4.verdict, 'WARN');

// Rule 5: contradictions > 0 and no boundary -> CLARIFY
const resRule5 = computeChangeVerdict({
  vcs: 0.60,
  expectations: [createExp('UNSATISFIED', 0.5)],
  boundaryViolations: 0,
  contradictions: 1,
  ecmConfidence: 0.5,
});
assert.strictEqual(resRule5.verdict, 'CLARIFY');

// Rule 6: VCS < 0.40 -> INSUFFICIENT_EVIDENCE
const resRule6 = computeChangeVerdict({
  vcs: 0.25,
  expectations: [createExp('INSUFFICIENT_EVIDENCE', 0.5)],
  boundaryViolations: 0,
  contradictions: 0,
  ecmConfidence: 0.5,
});
assert.strictEqual(resRule6.verdict, 'INSUFFICIENT_EVIDENCE');

console.log('✓ VCS & ChangeVerdict Priority Tests Passed.');
