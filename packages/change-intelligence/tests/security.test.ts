/**
 * Test Suite 9: Cross-Workspace Tenant Isolation
 * Verifies Test Requirement 14.
 */

import * as assert from 'assert';
import {
  ChangeEvidenceLedgerService,
  EcmBuilder,
} from '../src';
import { assertTenantScoped } from '../../database/src/repositories/ChangeIntelligenceRepository';

console.log('--- Running Cross-Workspace Isolation Tests ---');

// 1. assertTenantScoped throws ForbiddenError on mismatch
assert.throws(
  () => {
    assertTenantScoped('ws-alpha', 'ws-beta');
  },
  (err: any) => {
    return err.name === 'ForbiddenError' || /Cross-tenant operation rejected/.test(err.message);
  },
  'Tenant mismatch must throw ForbiddenError'
);

// 2. Ledger service rejects evidence with mismatched workspaceId
const ws1 = 'ws-tenant-1';
const ws2 = 'ws-tenant-2';

const builder = new EcmBuilder(ws1, 'base-sha', 'cand-sha');
builder.expectFile({
  filePath: 'src/index.ts',
  changeType: 'MODIFIED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
const ecm = builder.build();

const service = new ChangeEvidenceLedgerService();
const ledger = service.initializeLedger(ecm);

assert.throws(
  () => {
    service.appendEvidence(ledger, {
      evidenceId: 'ev-cross-tenant',
      changeId: ecm.changeId,
      workspaceId: ws2, // MISMATCH!
      entityId: 'src/index.ts',
      entityType: 'FILE',
      observation: 'File modified',
      sourceType: 'AST_STRUCTURAL',
      derivationMethod: 'AST_PARSE_DIFF',
      observedAt: new Date(),
      observationWindow: { kind: 'POINT_IN_TIME', from: 'now', to: 'now' },
      confidence: 0.95,
      relatedExpectationIds: [ledger.expectations[0].expectationId],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    });
  },
  /CROSS_TENANT_ERROR/,
  'Evidence with mismatched workspaceId must be rejected'
);

console.log('✓ Cross-Workspace Isolation Tests Passed.');
