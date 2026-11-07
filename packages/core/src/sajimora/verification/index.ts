/**
 * @file index.ts
 * Public exports for the generic production verification core.
 */

export * from './contracts';
export * from './GenericLanguageAdapter';
export * from './ConservationGate';
export * from './VerdictAuthorityBridge';
export * from './ProductionVerificationCore';
export { EvidenceAcceptanceSession, EvidenceChecker } from './AcceptedEvidence';
export { DiscoveryCoverageSession, DiscoveryCoverageChecker } from './DiscoveryCoverage';
