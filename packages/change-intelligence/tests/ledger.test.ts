/**
 * Test Suite 10: Change Evidence Ledger Lifecycle & Speculative State
 * Verifies Test Requirement 16.
 */

import * as assert from 'assert';
import {
  ChangeEvidenceLedgerService,
  EcmBuilder,
} from '../src';

console.log('--- Running Change Evidence Ledger Lifecycle Tests ---');

const ws = 'ws-speculative-test';
const baseSha = 'sha-base-state';
const candSha = 'sha-cand-state';

// 1. Ledger transitions: OPEN -> RECONCILING -> CLOSED
const builder = new EcmBuilder(ws, baseSha, candSha);
builder.expectFile({
  filePath: 'src/module.ts',
  changeType: 'MODIFIED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
const ecm = builder.build();

const service = new ChangeEvidenceLedgerService();
const ledger = service.initializeLedger(ecm);

assert.strictEqual(ledger.status, 'OPEN');
assert.strictEqual(ledger.verdict, null, 'Verdict must be null until ledger is CLOSED');
assert.strictEqual(ledger.vcs, 0.0, 'VCS must be 0.0 until ledger is CLOSED');

// Cannot append evidence after CLOSED
const closedLedger = service.reconcileAndClose(ledger);
assert.strictEqual(closedLedger.status, 'CLOSED');
assert.ok(closedLedger.verdict !== null);

assert.throws(
  () => {
    service.appendEvidence(closedLedger, {
      evidenceId: 'ev-late',
      changeId: ecm.changeId,
      workspaceId: ws,
      entityId: 'src/module.ts',
      entityType: 'FILE',
      observation: 'Late observation',
      sourceType: 'AST_STRUCTURAL',
      derivationMethod: 'AST_PARSE_DIFF',
      observedAt: new Date(),
      observationWindow: { kind: 'POINT_IN_TIME', from: 'now', to: 'now' },
      confidence: 0.9,
      relatedExpectationIds: [closedLedger.expectations[0].expectationId],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    });
  },
  /IMMUTABLE_LEDGER_ERROR/,
  'Appending evidence to a CLOSED ledger must throw'
);

// 2. Speculative Publication Authorization Check:
// Candidate state is ONLY authorizable when status is CLOSED and verdict is ALLOW
function isPublicationAuthorized(ledgerState: typeof closedLedger): boolean {
  return ledgerState.status === 'CLOSED' && ledgerState.verdict === 'ALLOW';
}

assert.strictEqual(
  isPublicationAuthorized({ ...closedLedger, verdict: 'WARN' }),
  false,
  'WARN verdict must not authorize publication'
);
assert.strictEqual(
  isPublicationAuthorized({ ...closedLedger, verdict: 'BLOCK' }),
  false,
  'BLOCK verdict must not authorize publication'
);
assert.strictEqual(
  isPublicationAuthorized({ ...closedLedger, status: 'OPEN', verdict: 'ALLOW' }),
  false,
  'OPEN ledger must not authorize publication'
);
assert.strictEqual(
  isPublicationAuthorized({ ...closedLedger, status: 'CLOSED', verdict: 'ALLOW' }),
  true,
  'CLOSED ledger with ALLOW verdict authorizes speculative publication'
);

console.log('✓ Change Evidence Ledger Lifecycle Tests Passed.');
