/**
 * SAJIMORA V32 — Change Intelligence Repository
 * Subordinate to sajimora_v32_foundation_spec.md §8 (OQ-3) & Final Implementation Plan.
 *
 * Provides tenant-scoped persistence for V32 Change Evidence Ledgers,
 * Expectation Records, Evidence Entries, Reconciliation Records, and Gap Records.
 * Enforces fail-closed cross-tenant guards via assertTenantScoped.
 */

import { ForbiddenError, NotFoundError } from '../../../core/src/errors';

let Prisma: any = {
  JsonNull: null,
};

try {
  const prismaModule = require('@prisma/client');
  Prisma = prismaModule.Prisma;
} catch {
  // Prisma client not generated in this environment
}

export type PrismaDb = any;

export interface ChangeEvidenceLedgerRecord {
  id: string; // changeId
  workspaceId: string;
  baseCommitSha: string;
  candidateCommitSha: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  status: string;
  failureReason?: string | null;
  ecmSource: string;
  ecmConfidence: number;
  vcsScore: number;
  verdict?: string | null;
  verdictReason?: string | null;
  verdictComputedAt?: Date | null;
  ecmPayloadJson?: any;
  countsJson?: any;
}

export function assertTenantScoped(workspaceId: string, target: string): void {
  if (!workspaceId || workspaceId !== target) {
    throw new ForbiddenError(`Cross-tenant operation rejected: expected workspace ${workspaceId}, received ${target}`);
  }
}

export class ChangeIntelligenceRepository {
  constructor(private db: PrismaDb) {}

  /**
   * Retrieves a ledger by changeId, verifying tenant ownership.
   */
  async getLedger(workspaceId: string, changeId: string): Promise<ChangeEvidenceLedgerRecord | null> {
    if (!workspaceId || !changeId) return null;

    const row = await (this.db as any).changeEvidenceLedger.findFirst({
      where: { id: changeId, workspaceId },
    });

    if (!row) return null;
    assertTenantScoped(workspaceId, row.workspaceId);
    return row;
  }

  /**
   * Saves or updates a ledger. If the existing ledger is already CLOSED,
   * re-saving is rejected to protect immutability.
   */
  async saveLedger(ledger: ChangeEvidenceLedgerRecord): Promise<ChangeEvidenceLedgerRecord> {
    assertTenantScoped(ledger.workspaceId, ledger.workspaceId);

    const existing = await (this.db as any).changeEvidenceLedger.findFirst({
      where: { id: ledger.id, workspaceId: ledger.workspaceId },
    });

    if (existing && existing.status === 'CLOSED') {
      throw new Error(`IMMUTABLE_LEDGER_ERROR: Ledger ${ledger.id} is already CLOSED and cannot be modified.`);
    }

    const data = {
      workspaceId: ledger.workspaceId,
      baseCommitSha: ledger.baseCommitSha,
      candidateCommitSha: ledger.candidateCommitSha,
      lastUpdatedAt: new Date(),
      status: ledger.status,
      failureReason: ledger.failureReason ?? null,
      ecmSource: ledger.ecmSource,
      ecmConfidence: ledger.ecmConfidence,
      vcsScore: ledger.vcsScore,
      verdict: ledger.verdict ?? null,
      verdictReason: ledger.verdictReason ?? null,
      verdictComputedAt: ledger.verdictComputedAt ?? null,
      ecmPayloadJson: ledger.ecmPayloadJson ?? Prisma.JsonNull,
      countsJson: ledger.countsJson ?? Prisma.JsonNull,
    };

    if (existing) {
      return (this.db as any).changeEvidenceLedger.update({
        where: { id: ledger.id },
        data,
      });
    }

    return (this.db as any).changeEvidenceLedger.create({
      data: {
        id: ledger.id,
        createdAt: ledger.createdAt || new Date(),
        ...data,
      },
    });
  }

  /**
   * Persists an array of expectation records for a ledger.
   */
  async saveExpectations(workspaceId: string, ledgerId: string, expectations: any[]): Promise<void> {
    for (const exp of expectations) {
      assertTenantScoped(workspaceId, exp.workspaceId);
      await (this.db as any).expectationRecord.create({
        data: {
          id: exp.expectationId || undefined,
          ledgerId,
          workspaceId,
          expectationType: exp.expectationType,
          description: exp.description,
          ecmConfidence: exp.ecmConfidence,
          ecmProvenance: exp.ecmProvenance,
          collectedEvidence: exp.collectedEvidenceIds ? exp.collectedEvidenceIds : Prisma.JsonNull,
          reconciliationState: exp.reconciliationState,
          verdict: exp.verdict,
          verdictReason: exp.verdictReason,
        },
      });
    }
  }

  /**
   * Persists evidence entries for a ledger.
   */
  async saveEvidenceEntries(workspaceId: string, ledgerId: string, evidenceEntries: any[]): Promise<void> {
    for (const ev of evidenceEntries) {
      assertTenantScoped(workspaceId, ev.workspaceId);
      await (this.db as any).evidenceEntry.upsert({
        where: { id: ev.evidenceId },
        update: {
          observation: ev.observation,
          confidence: ev.confidence,
          structuralConfidence: ev.structuralConfidence ?? null,
        },
        create: {
          id: ev.evidenceId,
          ledgerId,
          workspaceId,
          entityId: ev.entityId,
          entityType: ev.entityType,
          observation: ev.observation,
          sourceType: ev.sourceType,
          derivationMethod: ev.derivationMethod,
          confidence: ev.confidence,
          structuralConfidence: ev.structuralConfidence ?? null,
          relatedExpectations: ev.relatedExpectationIds || [],
          supportingEvidence: ev.supportingEvidenceIds ? ev.supportingEvidenceIds : Prisma.JsonNull,
          contradictingEvidence: ev.contradictingEvidenceIds ? ev.contradictingEvidenceIds : Prisma.JsonNull,
        },
      });
    }
  }

  /**
   * Persists reconciliation records for a ledger.
   */
  async saveReconciliations(workspaceId: string, ledgerId: string, reconciliations: any[]): Promise<void> {
    for (const rec of reconciliations) {
      assertTenantScoped(workspaceId, rec.workspaceId);
      await (this.db as any).reconciliationRecord.create({
        data: {
          id: rec.reconciliationId || undefined,
          ledgerId,
          expectationId: rec.expectationId,
          workspaceId,
          state: rec.state,
          evidenceIds: rec.evidenceIds || [],
          conflictingEvidenceIds: rec.conflictingEvidenceIds || [],
          explanation: rec.explanation,
        },
      });
    }
  }

  /**
   * Persists gap records for a ledger.
   */
  async saveGaps(workspaceId: string, ledgerId: string, gaps: any[]): Promise<void> {
    for (const gap of gaps) {
      assertTenantScoped(workspaceId, gap.workspaceId);
      await (this.db as any).evidenceGapRecord.create({
        data: {
          id: gap.gapId || undefined,
          ledgerId,
          expectationId: gap.expectationId,
          workspaceId,
          missingEvidenceType: gap.missingEvidenceType,
          missingFact: gap.missingFact,
          bounded: gap.bounded ?? false,
          boundedExperiment: gap.boundedExperiment ? gap.boundedExperiment : Prisma.JsonNull,
        },
      });
    }
  }
}
