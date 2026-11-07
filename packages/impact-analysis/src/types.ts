/**
 * SAJIMORA — OFFLINE IMPACT ANALYSIS & BLAST RADIUS TYPES
 *
 * Deterministic offline graph types for candidate discovery and blast radius calculation.
 * Zero LLM dependencies.
 */

export type TargetKind = 'FILE' | 'SYMBOL' | 'PACKAGE';
export type ResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface TargetCandidate {
  path: string;
  symbol?: string;
  reason: string;
}

export interface AnalysisBlocker {
  code: string;
  message: string;
  file?: string;
  files?: string[];
}

export interface TargetResolution {
  status: ResolutionStatus;
  targetKind?: TargetKind;
  node?: string;
  symbol?: string;
  packageName?: string;
  query?: string;
  definingFile?: string;
  candidates?: TargetCandidate[];
  closestMatches?: string[];
  blockers?: AnalysisBlocker[];
}

export type DependencyRelation =
  | 'STATIC_IMPORT'
  | 'DYNAMIC_IMPORT'
  | 'REEXPORT'
  | 'PACKAGE_IMPORT'
  | 'DIRECT_SYMBOL_REFERENCE'
  | 'INHERITS'
  | 'IMPLEMENTS';

export type EvidenceKind = 'STATIC_AST' | 'DYNAMIC_AST' | 'HEURISTIC';

export interface DependencyEvidence {
  kind: EvidenceKind;
  extractor: string;
  sourceLocation?: {
    line: number;
    column: number;
  };
  specifierLiteral: string;
  isLiteral: boolean;
}

export interface DependencyEdge {
  from: string;
  to: string;
  relation: DependencyRelation;
  evidence: DependencyEvidence;
}

export interface GraphStats {
  nodesVisited: number;
  edgesTraversed: number;
  staticAstEdges: number;
  dynamicAstEdges: number;
  heuristicEdges: number;
}

export interface ImpactAnalysisResult {
  archetype: 'IMPACT_ANALYSIS';
  targetNode: string;
  targetKind?: TargetKind;
  targetSymbol?: string;
  targetPackage?: string;
  resolutionStatus: ResolutionStatus;
  blastRadius: number;
  directDependents: string[];
  transitiveDependents: string[];
  affectedTests: string[];
  affectedRoutes: string[];
  affectedSchemas: string[];
  traversalDepth: number;
  traversalMode: 'BOUNDED' | 'FULL';
  graphStats: GraphStats;
  llmCalls: 0;
  tokenCost: 0;
  blockers?: AnalysisBlocker[];
}
