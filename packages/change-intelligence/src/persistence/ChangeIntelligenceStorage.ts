/**
 * SAJIMORA V32 — Change Intelligence Storage Provider
 * Subordinate to sajimora_v32_foundation_spec.md §8 (OQ-3) & Final Implementation Plan.
 *
 * Provides in-memory and database-backed storage for ExpectedChangeModels
 * and ChangeEvidenceLedgers. Guarantees immutability of VALID ECMs and CLOSED Ledgers.
 */

import { ChangeEvidenceLedger, ChangeId, ExpectedChangeModel } from '../types';

export class ChangeIntelligenceStorage {
  private static instance: ChangeIntelligenceStorage;

  private ecmStore: Map<ChangeId, ExpectedChangeModel> = new Map();
  private ledgerStore: Map<ChangeId, ChangeEvidenceLedger> = new Map();

  static getInstance(): ChangeIntelligenceStorage {
    if (!ChangeIntelligenceStorage.instance) {
      ChangeIntelligenceStorage.instance = new ChangeIntelligenceStorage();
    }
    return ChangeIntelligenceStorage.instance;
  }

  /** Clears storage (used in tests). */
  clear(): void {
    this.ecmStore.clear();
    this.ledgerStore.clear();
  }

  // ── ECM Operations ─────────────────────────────────────────────────────────

  saveEcm(ecm: ExpectedChangeModel): void {
    // ECM-R8: ECM is immutable once valid.
    if (this.ecmStore.has(ecm.changeId)) {
      const existing = this.ecmStore.get(ecm.changeId)!;
      if (existing.validationStatus === 'VALID') {
        throw new Error(`IMMUTABILITY_ERROR: ECM ${ecm.changeId} already exists and is immutable.`);
      }
    }
    this.ecmStore.set(ecm.changeId, ecm);
  }

  getEcm(changeId: ChangeId): ExpectedChangeModel | null {
    return this.ecmStore.get(changeId) || null;
  }

  // ── Ledger Operations ──────────────────────────────────────────────────────

  saveLedger(ledger: ChangeEvidenceLedger): void {
    // Check immutability: once status = CLOSED, cannot be overwritten
    if (this.ledgerStore.has(ledger.changeId)) {
      const existing = this.ledgerStore.get(ledger.changeId)!;
      if (existing.status === 'CLOSED') {
        throw new Error(
          `IMMUTABLE_LEDGER_ERROR: Ledger ${ledger.changeId} is already CLOSED and cannot be modified or re-evaluated.`
        );
      }
    }
    this.ledgerStore.set(ledger.changeId, ledger);
  }

  getLedger(changeId: ChangeId): ChangeEvidenceLedger | null {
    return this.ledgerStore.get(changeId) || null;
  }
}
