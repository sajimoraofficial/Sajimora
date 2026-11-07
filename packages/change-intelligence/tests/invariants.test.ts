/**
 * Test Suite 8: Security & Pipeline Invariants
 * Verifies Test Requirements 10, 11, 12, 13.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChangeEvidenceLedgerService,
  EcmBuilder,
  EvidenceEntry,
} from '../src';

console.log('--- Running Security & Pipeline Invariants Tests ---');

const ws = 'ws-invariants';
const baseSha = 'base-inv-sha';
const candSha = 'cand-inv-sha';

const builder = new EcmBuilder(ws, baseSha, candSha);
builder.expectFile({
  filePath: 'src/core.ts',
  changeType: 'MODIFIED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
builder.expectInvariantTransition({
  invariantDescription: 'Tenant boundaries are strictly preserved',
  expectedState: 'PRESERVED',
  provenance: 'DEVELOPER_DECLARED',
  confidence: 1.0,
});
const ecm = builder.build();

const ledgerService = new ChangeEvidenceLedgerService();
const ledger = ledgerService.initializeLedger(ecm);

// 1. Test Requirement 10: Prohibition of INVARIANT_TRANSITION and RUNTIME evidence
assert.throws(
  () => {
    ledgerService.appendEvidence(ledger, {
      evidenceId: 'ev-prohibited-1',
      changeId: ecm.changeId,
      workspaceId: ws,
      entityId: 'tenant-boundary',
      entityType: 'FILE',
      observation: 'Attemped invariant discovery',
      sourceType: 'INVARIANT_TRANSITION' as any, // Prohibited in Phase 1
      derivationMethod: 'GRAPH_TRAVERSAL',
      observedAt: new Date(),
      observationWindow: { kind: 'POINT_IN_TIME', from: 'now', to: 'now' },
      confidence: 1.0,
      relatedExpectationIds: [ledger.expectations[0].expectationId],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    });
  },
  /PROHIBITED_SOURCE_TYPE/,
  'Ingesting sourceType = INVARIANT_TRANSITION must throw and fail closed'
);

assert.throws(
  () => {
    ledgerService.appendEvidence(ledger, {
      evidenceId: 'ev-prohibited-2',
      changeId: ecm.changeId,
      workspaceId: ws,
      entityId: 'runtime-shadow',
      entityType: 'FILE',
      observation: 'Attempted runtime shadowing',
      sourceType: 'RUNTIME' as any, // Prohibited in Phase 1
      derivationMethod: 'GRAPH_TRAVERSAL',
      observedAt: new Date(),
      observationWindow: { kind: 'POINT_IN_TIME', from: 'now', to: 'now' },
      confidence: 1.0,
      relatedExpectationIds: [ledger.expectations[0].expectationId],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    });
  },
  /PROHIBITED_SOURCE_TYPE/,
  'Ingesting sourceType = RUNTIME must throw and fail closed'
);

// 2. Test Requirement 11: Invariant declarations are schema data only (no active discovery)
assert.strictEqual(ecm.expectedInvariantTransitions.length, 1);
assert.strictEqual(
  ecm.expectedInvariantTransitions[0].invariantDescription,
  'Tenant boundaries are strictly preserved'
);

// 3. Test Requirement 13: Zero LLM / ML / Fuzzy Matcher references in @sajimora/change-intelligence
const srcDir = path.resolve(__dirname, '../src');
function scanDirForProhibitedTerms(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirForProhibitedTerms(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(full, 'utf8');
      assert.strictEqual(
        content.includes('VertexAIClient'),
        false,
        `Prohibited VertexAIClient found in ${full}`
      );
      assert.strictEqual(
        content.includes('@google-cloud'),
        false,
        `Prohibited @google-cloud found in ${full}`
      );
      assert.strictEqual(
        content.includes('openai'),
        false,
        `Prohibited openai found in ${full}`
      );
      assert.strictEqual(
        content.includes('anthropic'),
        false,
        `Prohibited anthropic found in ${full}`
      );
    }
  }
}
scanDirForProhibitedTerms(srcDir);

console.log('✓ Security & Pipeline Invariants Tests Passed.');
