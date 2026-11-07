/**
 * Test Suite 2: Pipeline Evaluation Entry & Idempotency
 * Verifies Test Requirement 2.
 */

import * as assert from 'assert';
import {
  EcmBuilder,
  ChangeEvidenceLedgerService,
  ChangeIntelligenceStorage,
  ExpectedChangeModel,
} from '../src';

console.log('--- Running Pipeline Evaluation Entry & Idempotency Tests ---');

const storage = ChangeIntelligenceStorage.getInstance();
storage.clear();

const ws = 'ws-test-evaluation';
const baseSha = '1111111111111111111111111111111111111111';
const candSha = '2222222222222222222222222222222222222222';

// 1. Create and store immutable ECM
const builder = new EcmBuilder(ws, baseSha, candSha);
builder.expectFile({
  filePath: 'src/service.ts',
  changeType: 'MODIFIED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
builder.expectSymbol({
  filePath: 'src/service.ts',
  symbolName: 'runProcess',
  symbolKind: 'FUNCTION',
  changeType: 'ADDED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
const ecm: ExpectedChangeModel = builder.build();
storage.saveEcm(ecm);

// Verify ECM is stored
const retrievedEcm = storage.getEcm(ecm.changeId);
assert.ok(retrievedEcm, 'ECM must be stored');
const originalEcmJson = JSON.stringify(retrievedEcm);

// 2. First evaluation: execute pipeline and close ledger
const ledgerService = new ChangeEvidenceLedgerService();
const ledger = ledgerService.initializeLedger(ecm);

// Ingest synthetic evidence matching expectations
ledgerService.appendEvidence(ledger, {
  evidenceId: 'ev-1',
  changeId: ecm.changeId,
  workspaceId: ws,
  entityId: 'src/service.ts',
  entityType: 'FILE',
  observation: 'MATCH_EXACT: File src/service.ts was MODIFIED',
  sourceType: 'AST_STRUCTURAL',
  derivationMethod: 'AST_PARSE_DIFF',
  observedAt: new Date(),
  observationWindow: { kind: 'COMMIT_RANGE', from: baseSha, to: candSha },
  confidence: 0.95,
  structuralConfidence: 'DETERMINISTIC',
  relatedExpectationIds: [ledger.expectations[0].expectationId],
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
});

ledgerService.appendEvidence(ledger, {
  evidenceId: 'ev-2',
  changeId: ecm.changeId,
  workspaceId: ws,
  entityId: 'src/service.ts#runProcess',
  entityType: 'SYMBOL',
  observation: 'MATCH_EXACT: Symbol runProcess was ADDED',
  sourceType: 'AST_STRUCTURAL',
  derivationMethod: 'AST_PARSE_DIFF',
  observedAt: new Date(),
  observationWindow: { kind: 'COMMIT_RANGE', from: baseSha, to: candSha },
  confidence: 0.95,
  structuralConfidence: 'DETERMINISTIC',
  relatedExpectationIds: [ledger.expectations[1].expectationId],
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
});

const closedLedger = ledgerService.reconcileAndClose(ledger);
assert.strictEqual(closedLedger.status, 'CLOSED');
assert.strictEqual(closedLedger.verdict, 'ALLOW');
assert.strictEqual(closedLedger.counts.satisfied, 2);

storage.saveLedger(closedLedger);

// 3. Verify ECM remains completely unmutated
const ecmAfterEval = storage.getEcm(ecm.changeId);
assert.strictEqual(
  JSON.stringify(ecmAfterEval),
  originalEcmJson,
  'Evaluation must NOT mutate the ExpectedChangeModel'
);

// 4. Idempotency Check: Calling evaluate on an already CLOSED ledger must return existing result without re-evaluating
const existingLedger = storage.getLedger(ecm.changeId);
assert.ok(existingLedger);
assert.strictEqual(existingLedger.status, 'CLOSED');

// Verify storage rejects overwrite on CLOSED ledger
assert.throws(
  () => {
    storage.saveLedger({
      ...closedLedger,
      verdict: 'BLOCK', // attempt mutation
    });
  },
  /already CLOSED and cannot be modified/,
  'Overwriting or mutating a CLOSED ledger must be rejected'
);

console.log('✓ Pipeline Evaluation Entry & Idempotency Tests Passed.');
