/**
 * Test Suite 5: Evidence Reconciliation Vocabulary & Rules
 * Verifies Test Requirement 7.
 */

import * as assert from 'assert';
import {
  ReconciliationEngine,
  ExpectationRecord,
  EvidenceEntry,
  ReconciliationState,
  ExpectationVerdict,
} from '../src';

console.log('--- Running Evidence Reconciliation Tests ---');

const engine = new ReconciliationEngine();
const ws = 'ws-test-rec';
const changeId = 'change-test-rec';

const allowedStates: ReconciliationState[] = [
  'CONSISTENT',
  'COMPLEMENTARY',
  'CONTRADICTORY',
  'INSUFFICIENT',
  'UNRESOLVED',
];

const allowedVerdicts: ExpectationVerdict[] = [
  'SATISFIED',
  'UNSATISFIED',
  'BOUNDARY_VIOLATED',
  'UNOBSERVED',
  'INSUFFICIENT_EVIDENCE',
];

function makeExp(id: string, desc: string): ExpectationRecord {
  return {
    expectationId: id,
    changeId,
    workspaceId: ws,
    expectationType: 'FILE_CHANGE',
    description: desc,
    ecmConfidence: 0.9,
    ecmProvenance: 'DEVELOPER_DECLARED',
    collectedEvidenceIds: [],
    reconciliationState: 'UNRESOLVED',
    verdict: 'UNOBSERVED',
    verdictReason: '',
  };
}

// Case 1: Exact Match -> CONSISTENT, SATISFIED
const exp1 = makeExp('exp-1', 'MODIFIED:src/index.ts');
const ev1: EvidenceEntry = {
  evidenceId: 'ev-1',
  changeId,
  workspaceId: ws,
  entityId: 'src/index.ts',
  entityType: 'FILE',
  observation: 'MATCH_EXACT: File src/index.ts was MODIFIED',
  sourceType: 'AST_STRUCTURAL',
  derivationMethod: 'AST_PARSE_DIFF',
  observedAt: new Date(),
  observationWindow: { kind: 'POINT_IN_TIME', from: 'now', to: 'now' },
  confidence: 0.95,
  structuralConfidence: 'DETERMINISTIC',
  relatedExpectationIds: ['exp-1'],
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
};
const res1 = engine.reconcileExpectation(changeId, ws, exp1, [ev1], null);
assert.ok(allowedStates.includes(res1.updatedState));
assert.ok(allowedVerdicts.includes(res1.updatedVerdict));
assert.strictEqual(res1.updatedState, 'CONSISTENT');
assert.strictEqual(res1.updatedVerdict, 'SATISFIED');

// Case 2: Contradicting evidence -> CONTRADICTORY, UNSATISFIED
const exp2 = makeExp('exp-2', 'ADDED:src/new.ts');
const ev2: EvidenceEntry = {
  ...ev1,
  evidenceId: 'ev-2',
  relatedExpectationIds: ['exp-2'],
  observation: 'MISMATCH: File src/new.ts was DELETED',
  contradictingEvidenceIds: ['ev-conflict'],
};
const res2 = engine.reconcileExpectation(changeId, ws, exp2, [ev2], null);
assert.strictEqual(res2.updatedState, 'CONTRADICTORY');
assert.strictEqual(res2.updatedVerdict, 'UNSATISFIED');

// Case 3: Low confidence evidence (< 0.3) -> INSUFFICIENT, INSUFFICIENT_EVIDENCE
const exp3 = makeExp('exp-3', 'MODIFIED:src/low.ts');
const ev3: EvidenceEntry = {
  ...ev1,
  evidenceId: 'ev-3',
  relatedExpectationIds: ['exp-3'],
  confidence: 0.2, // Below 0.3 threshold
};
const res3 = engine.reconcileExpectation(changeId, ws, exp3, [ev3], null);
assert.strictEqual(res3.updatedState, 'INSUFFICIENT');
assert.strictEqual(res3.updatedVerdict, 'INSUFFICIENT_EVIDENCE');

// Case 4: No evidence, no gap -> UNOBSERVED (honest absence)
const exp4 = makeExp('exp-4', 'MODIFIED:src/unobserved.ts');
const res4 = engine.reconcileExpectation(changeId, ws, exp4, [], null);
assert.strictEqual(res4.updatedState, 'UNRESOLVED');
assert.strictEqual(res4.updatedVerdict, 'UNOBSERVED');

// Case 5: Partial match -> COMPLEMENTARY, SATISFIED
const exp5 = makeExp('exp-5', 'MODIFIED:src/partial.ts');
const ev5: EvidenceEntry = {
  ...ev1,
  evidenceId: 'ev-5',
  relatedExpectationIds: ['exp-5'],
  observation: 'PARTIAL_MATCH: Partial AST delta observed',
  confidence: 0.65,
};
const res5 = engine.reconcileExpectation(changeId, ws, exp5, [ev5], null);
assert.strictEqual(res5.updatedState, 'COMPLEMENTARY');
// Case 6: High-confidence MISMATCH (confidence: 0.95) must be CONTRADICTORY, UNSATISFIED (never SATISFIED)
const exp6 = makeExp('exp-6', 'MODIFIED:src/diff.ts');
const ev6: EvidenceEntry = {
  ...ev1,
  evidenceId: 'ev-6',
  relatedExpectationIds: ['exp-6'],
  observation: 'MISMATCH: Expected MODIFIED but observed DELETED',
  confidence: 0.95,
  contradictingEvidenceIds: [],
};
const res6 = engine.reconcileExpectation(changeId, ws, exp6, [ev6], null);
assert.strictEqual(res6.updatedState, 'CONTRADICTORY');
assert.strictEqual(res6.updatedVerdict, 'UNSATISFIED');

console.log('✓ Evidence Reconciliation Tests Passed.');
