/**
 * Test Suite 6: Change Boundary Enforcement & Unconditional BLOCK
 * Verifies Test Requirement 8.
 */

import * as assert from 'assert';
import {
  EcmBuilder,
  ChangeEvidenceLedgerService,
  ChangeSetDelta,
  isPathBoundaryViolated,
} from '../src';

console.log('--- Running Change Boundary Tests ---');

const ws = 'ws-boundary-test';
const baseSha = 'base-boundary-sha';
const candSha = 'cand-boundary-sha';

// 1. Path prefix matching unit test
assert.strictEqual(isPathBoundaryViolated('packages/core/src/auth.ts', 'packages/core'), true);
assert.strictEqual(isPathBoundaryViolated('packages/core', 'packages/core'), true);
assert.strictEqual(isPathBoundaryViolated('packages/core_other/file.ts', 'packages/core'), false);
assert.strictEqual(isPathBoundaryViolated('src/index.ts', 'packages/core'), false);

// 2. Full pipeline boundary violation test
const builder = new EcmBuilder(ws, baseSha, candSha);
builder.expectFile({
  filePath: 'src/app.ts',
  changeType: 'MODIFIED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
builder.setBoundary({
  forbiddenPaths: ['packages/core', 'config/prod'],
  reason: 'Protected core infrastructure',
  provenance: 'DEVELOPER_DECLARED',
});
const ecm = builder.build();

const ledgerService = new ChangeEvidenceLedgerService();
const ledger = ledgerService.initializeLedger(ecm);

// Simulate change that touches a forbidden path
const syntheticDiff: ChangeSetDelta = {
  changeId: ecm.changeId,
  workspaceId: ws,
  baseCommitSha: baseSha,
  candidateCommitSha: candSha,
  computedAt: new Date(),
  fileDeltas: [
    {
      filePath: 'src/app.ts',
      fileChangeType: 'MODIFIED',
      symbolDeltas: [],
      importDeltas: [],
      exportDeltas: [],
      diffConfidence: 'DETERMINISTIC',
      confidenceReasons: [],
    },
    {
      filePath: 'packages/core/secret.ts', // FORBIDDEN!
      fileChangeType: 'MODIFIED',
      symbolDeltas: [],
      importDeltas: [],
      exportDeltas: [],
      diffConfidence: 'DETERMINISTIC',
      confidenceReasons: [],
    },
  ],
  summary: {
    totalFilesChanged: 2,
    filesAdded: 0,
    filesModified: 2,
    filesDeleted: 0,
    filesRenamed: 0,
    symbolsAdded: 0,
    symbolsRemoved: 0,
    symbolsRenamed: 0,
    symbolsSignatureChanged: 0,
    importsAdded: 0,
    importsRemoved: 0,
    exportsAdded: 0,
    exportsRemoved: 0,
    deterministicFileCount: 2,
    partialFileCount: 0,
    unparseableFileCount: 0,
  },
  overallConfidence: 'DETERMINISTIC',
};

ledgerService.ingestAstDiffAndBoundary(ledger, ecm, syntheticDiff);

// Check that boundary violation evidence was appended
const boundaryEv = ledger.evidence.find((e) => e.sourceType === 'BOUNDARY_VIOLATION');
assert.ok(boundaryEv, 'BOUNDARY_VIOLATION evidence must be present');
assert.strictEqual(boundaryEv.confidence, 1.0);

// Close and reconcile
const closed = ledgerService.reconcileAndClose(ledger);

// Enforce rule: Must be BOUNDARY_VIOLATED and BLOCK (unconditionally, never WARN)
assert.ok(closed.counts.boundaryViolations > 0, 'Must record at least one boundary violation');
assert.strictEqual(
  closed.verdict,
  'BLOCK',
  'Boundary violation MUST unconditionally produce ChangeVerdict = BLOCK'
);
assert.notStrictEqual(closed.verdict, 'WARN', 'Boundary violation must NEVER produce WARN');
assert.ok(closed.verdictReason.includes('violates'), 'Verdict reason must explain boundary violation');

console.log('✓ Change Boundary Tests Passed.');
