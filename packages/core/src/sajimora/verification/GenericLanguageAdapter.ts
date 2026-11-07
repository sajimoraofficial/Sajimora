/**
 * @file GenericLanguageAdapter.ts
 * Strictly language-agnostic interface for pluggable semantic language adapters.
 * 
 * Supports:
 * - Sealed repository snapshot discovery
 * - Project/configuration graph discovery (multi-project/monorepo)
 * - Asymmetric project graph mapping (project moves, adds, deletes)
 * - Multi-faceted symbol identity and delta characterization
 * - Native module resolution through sealed compiler hosts
 * - Complete static reference and dynamic boundary discovery
 * - Tiered evidence evaluation with stable provenance chains
 */

import {
  GenericRepository,
  GenericRepositorySnapshot,
  GenericProjectGraph,
  AsymmetricProjectMapping,
  SemanticEntity,
  SemanticChange,
  Reference,
  VerificationObligation,
  VerificationVerdict,
  ResolutionFact
} from './contracts';

export interface DiscoveredReferencesResult {
  staticReferences: readonly Reference[];
  unresolvedBoundaries: readonly Reference[];
  resolutionFacts?: readonly ResolutionFact[];
}

export interface GenericLanguageAdapter {
  readonly languageId: string;
  readonly adapterVersion: string;

  /**
   * Evaluates if this adapter can process the given repository snapshots.
   */
  canHandle(repository: GenericRepository): boolean;

  /**
   * Discovers the project graph (projects, references, configs) for a repository snapshot.
   */
  discoverProjectGraph(snapshot: GenericRepositorySnapshot): Promise<GenericProjectGraph>;

  /**
   * Maps asymmetric project graphs across parent and candidate snapshots.
   */
  mapProjectGraphs(
    parentGraph: GenericProjectGraph,
    candidateGraph: GenericProjectGraph
  ): Promise<AsymmetricProjectMapping>;

  /**
   * Extracts semantic entities across parent and candidate snapshots and computes
   * multi-faceted cross-version identity and change deltas across the mapped project graph.
   */
  identifyEntitiesAndChanges(
    repository: GenericRepository,
    projectMapping: AsymmetricProjectMapping
  ): Promise<{
    entities: readonly SemanticEntity[];
    changes: readonly SemanticChange[];
  }>;

  /**
   * Discovers all consumer call sites, imports, and references to target entities.
   * Statically resolvable references are resolved through the sealed compiler host;
   * unresolved dynamic boundaries are emitted as explicit UNKNOWN boundaries.
   */
  discoverReferences(
    snapshot: GenericRepositorySnapshot,
    projectGraph: GenericProjectGraph,
    targetEntities: readonly SemanticEntity[]
  ): Promise<DiscoveredReferencesResult>;

  /**
   * Generates discrete verification obligations separating:
   * 1. API compatibility
   * 2. Consumer type compatibility
   * 3. Behavioral equivalence
   * All obligations carry stable provenance.
   */
  generateObligations(
    changes: readonly SemanticChange[],
    references: readonly Reference[]
  ): Promise<readonly VerificationObligation[]>;

  /**
   * Evaluates an obligation and produces verifiable evidence.
   */
  evaluateObligation(
    obligation: VerificationObligation,
    repository: GenericRepository
  ): Promise<VerificationVerdict>;
}
