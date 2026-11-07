/**
 * SAJIMORA V32 — Change Intelligence Public API
 * Subordinate to sajimora_v32_foundation_spec.md (Frozen Contract Candidate).
 */

export * from './types';

// ECM
export * from './ecm/schema';
export * from './ecm/validator';
export * from './ecm/builder';
export * from './ecm/commitExtractor';
export * from './ecm/fileConfigLoader';

// Diff Engine
export * from './diff/RepositoryStateProvider';
export * from './diff/GitChangeSetFilter';
export * from './diff/LazyBeforeStateProvider';
export * from './diff/AstStructuralDiffEngine';

// Evidence Ledger & Reconciliation
export * from './ledger/VcsCalculator';
export * from './ledger/VerdictCalculator';
export * from './ledger/GapDetector';
export * from './ledger/ReconciliationEngine';
export * from './ledger/ChangeEvidenceLedgerService';

// Persistence
export * from './persistence/ChangeIntelligenceStorage';
