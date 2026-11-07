/**
 * Test Suite 11: VCS Score Persistence & Metric Distinction
 * Verifies Test Requirement 17.
 */

import * as assert from 'assert';
import {
  ChangeIntelligenceRepository,
  ChangeEvidenceLedgerRecord,
} from '../../database/src/repositories/ChangeIntelligenceRepository';

console.log('--- Running VCS Score Persistence Tests ---');

// Mock Prisma client for testing repository adapter
const inMemoryLedgers = new Map<string, any>();
const mockPrisma: any = {
  changeEvidenceLedger: {
    findFirst: async ({ where }: any) => {
      const row = inMemoryLedgers.get(where.id);
      if (row && row.workspaceId === where.workspaceId) {
        return row;
      }
      return null;
    },
    create: async ({ data }: any) => {
      inMemoryLedgers.set(data.id, { ...data });
      return { ...data };
    },
    update: async ({ where, data }: any) => {
      const existing = inMemoryLedgers.get(where.id);
      const updated = { ...existing, ...data };
      inMemoryLedgers.set(where.id, updated);
      return updated;
    },
  },
};

const repo = new ChangeIntelligenceRepository(mockPrisma);

async function runTest() {
  const ws = 'ws-metrics-test';
  const changeId = 'change-metrics-123';

  // Distinct metrics
  const ecmConfidence = 0.8500;
  const vcsScore = 0.9250;
  const individualEvidenceConfidence = 0.9500;

  // Verify numerical distinction
  assert.notStrictEqual(
    vcsScore,
    ecmConfidence,
    'vcsScore must be distinct from ecmConfidence'
  );
  assert.notStrictEqual(
    vcsScore,
    individualEvidenceConfidence,
    'vcsScore must be distinct from individual evidence confidence'
  );

  const record: ChangeEvidenceLedgerRecord = {
    id: changeId,
    workspaceId: ws,
    baseCommitSha: 'base-sha',
    candidateCommitSha: 'cand-sha',
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
    status: 'CLOSED',
    ecmSource: 'STRUCTURED_INPUT',
    ecmConfidence,
    vcsScore,
    verdict: 'ALLOW',
    verdictReason: 'Passed all verification checks',
    verdictComputedAt: new Date(),
  };

  // Save
  const saved = await repo.saveLedger(record);
  assert.strictEqual(saved.id, changeId);
  assert.strictEqual(saved.vcsScore, 0.9250, 'vcsScore must be persisted exactly');
  assert.strictEqual(saved.ecmConfidence, 0.8500, 'ecmConfidence must be persisted exactly');

  // Retrieve
  const retrieved = await repo.getLedger(ws, changeId);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.vcsScore, 0.9250);
  assert.strictEqual(retrieved.ecmConfidence, 0.8500);

  // Cross-tenant access must fail
  const crossTenant = await repo.getLedger('other-workspace', changeId);
  assert.strictEqual(crossTenant, null);

  // Immutability test: attempting to save again when CLOSED must throw
  await assert.rejects(
    async () => {
      await repo.saveLedger({
        ...record,
        verdict: 'BLOCK', // Mutate
      });
    },
    /already CLOSED and cannot be modified/,
    'Saving to an already CLOSED ledger must be rejected by the repository'
  );

  console.log('✓ VCS Score Persistence Tests Passed.');
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
