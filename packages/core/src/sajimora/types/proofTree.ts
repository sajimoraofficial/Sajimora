import {
  RelationKind,
  RelationStatus,
  LanguageContractIR,
  SpecializedUsageContract,
  VarianceFrame
} from './relation';
import { IncompatibilityWitness, RelationBlocker, Phase4BlockerId } from './witness';
import { UsageRole } from './usage';

export interface RulePremise {
  readonly premiseId: string;
  readonly description: string;
  readonly verified: boolean;
}

export interface DischargedObligation {
  readonly obligationId: string;
  readonly description: string;
}

export interface TypeRelationResult {
  readonly status: RelationStatus;
  readonly relation: RelationKind;
  readonly rule: string;
  readonly rulePremises: ReadonlyArray<RulePremise>;
  readonly dischargedObligations: ReadonlyArray<string>;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly ruleNamespace: string;
  readonly source: unknown;
  readonly target: unknown;
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly effectivePolicy: Record<string, unknown>;
  readonly children: ReadonlyArray<TypeRelationResult>;
  readonly varianceStack?: ReadonlyArray<VarianceFrame>;
  readonly witness?: IncompatibilityWitness;
  readonly blockers: ReadonlyArray<RelationBlocker>;
  readonly anyDependency: boolean;
  readonly hypothesisDischarged?: boolean;
  readonly structuralGuardDepth?: number;
  readonly workConsumed?: number;
  readonly depth?: number;
  readonly aggregationMode?: 'UNIVERSAL_CONJUNCTION' | 'EXISTENTIAL_DISJUNCTION';
}

export interface CompatibilityProofEvidence {
  readonly evidenceId: string;
  readonly consumerMappingId: string;
  readonly parentOccurrenceId: string;
  readonly candidateOccurrenceId?: string;
  readonly targetMappingId: string;
  readonly usageRole: UsageRole;
  readonly specialization: SpecializedUsageContract<unknown>;
  readonly proofTree: TypeRelationResult;
  readonly ruleChain: ReadonlyArray<string>;
  readonly anyDependencyCount: number;
  readonly effectivePolicy: Record<string, unknown>;
  readonly parentContractIR?: LanguageContractIR<unknown>;
  readonly candidateContractIR?: LanguageContractIR<unknown>;
}

export interface IncompatibleEvidence {
  readonly status: 'INCOMPATIBLE';
  readonly consumerMappingId: string;
  readonly parentOccurrenceId: string;
  readonly candidateOccurrenceId?: string;
  readonly targetMappingId: string;
  readonly usageRole: UsageRole;
  readonly specialization?: SpecializedUsageContract<unknown>;
  readonly proofTree: TypeRelationResult;
  readonly witness: IncompatibilityWitness;
  readonly parentContractIR?: LanguageContractIR<unknown>;
  readonly candidateContractIR?: LanguageContractIR<unknown>;
}

export interface UndecidableEvidence {
  readonly status: 'UNDECIDABLE';
  readonly consumerMappingId: string;
  readonly parentOccurrenceId: string;
  readonly candidateOccurrenceId?: string;
  readonly targetMappingId: string;
  readonly usageRole: UsageRole;
  readonly specialization?: SpecializedUsageContract<unknown>;
  readonly partialProofTree?: TypeRelationResult;
  readonly blockers: ReadonlyArray<RelationBlocker>;
  readonly parentContractIR?: LanguageContractIR<unknown>;
  readonly candidateContractIR?: LanguageContractIR<unknown>;
}

export type Phase4Evidence =
  | CompatibilityProofEvidence
  | IncompatibleEvidence
  | UndecidableEvidence;

export interface ProofTreeValidationResult {
  readonly isValid: boolean;
  readonly failureReason?: string;
}

export function validateProofTree(result: TypeRelationResult): ProofTreeValidationResult {
  if (!result) {
    return { isValid: false, failureReason: 'Proof tree root is null or undefined' };
  }

  return validateSubTree(result, 0);
}

function validateSubTree(node: TypeRelationResult, currentDepth: number): ProofTreeValidationResult {
  if (currentDepth > 100) {
    return { isValid: false, failureReason: 'Proof tree exceeds maximum depth 100' };
  }

  if (node.workConsumed !== undefined && node.workConsumed > 500000) {
    return { isValid: false, failureReason: `Work budget exceeded: ${node.workConsumed} units` };
  }

  if (node.status === 'COMPATIBLE') {
    if (node.anyDependency) {
      return { isValid: false, failureReason: 'COMPATIBLE node depends on any' };
    }
    if (node.blockers && node.blockers.length > 0) {
      return { isValid: false, failureReason: 'COMPATIBLE node contains blockers' };
    }
    if (node.witness) {
      return { isValid: false, failureReason: 'COMPATIBLE node contains an incompatibility witness' };
    }
    if (node.hypothesisDischarged && (node.structuralGuardDepth ?? 0) < 1) {
      return {
        isValid: false,
        failureReason: 'Hypothesis discharged without guarded structural progress (guard depth < 1)'
      };
    }
    for (const premise of node.rulePremises ?? []) {
      if (!premise.verified) {
        return { isValid: false, failureReason: `Unverified rule premise: ${premise.premiseId}` };
      }
    }

    if (node.children && node.children.length > 0) {
      const mode = node.aggregationMode ?? 'UNIVERSAL_CONJUNCTION';
      if (mode === 'UNIVERSAL_CONJUNCTION') {
        const hasIncompatible = node.children.some(c => c.status === 'INCOMPATIBLE');
        if (hasIncompatible) {
          return { isValid: false, failureReason: 'Universal conjunction marked COMPATIBLE has INCOMPATIBLE child' };
        }
        const hasUndecidable = node.children.some(c => c.status === 'UNDECIDABLE');
        if (hasUndecidable) {
          return { isValid: false, failureReason: 'Universal conjunction marked COMPATIBLE has UNDECIDABLE child' };
        }
      } else if (mode === 'EXISTENTIAL_DISJUNCTION') {
        const hasCompatible = node.children.some(c => c.status === 'COMPATIBLE');
        if (!hasCompatible) {
          return { isValid: false, failureReason: 'Existential disjunction marked COMPATIBLE has no COMPATIBLE child' };
        }
      }

      for (const child of node.children) {
        const childVal = validateSubTree(child, currentDepth + 1);
        if (!childVal.isValid) {
          return childVal;
        }
      }
    }
    return { isValid: true };
  }

  if (node.status === 'INCOMPATIBLE') {
    const hasWitness = findWitness(node);
    if (!hasWitness) {
      return { isValid: false, failureReason: 'INCOMPATIBLE tree lacks an IncompatibilityWitness' };
    }
    return { isValid: true };
  }

  if (node.status === 'UNDECIDABLE') {
    const hasBlockers = findBlockers(node);
    if (!hasBlockers || hasBlockers.length === 0) {
      return { isValid: false, failureReason: 'UNDECIDABLE tree lacks a RelationBlocker' };
    }
    return { isValid: true };
  }

  return { isValid: false, failureReason: `Unknown relation status: ${node.status}` };
}

function findWitness(node: TypeRelationResult): IncompatibilityWitness | undefined {
  if (node.witness) return node.witness;
  for (const child of node.children ?? []) {
    const w = findWitness(child);
    if (w) return w;
  }
  return undefined;
}

function findBlockers(node: TypeRelationResult): ReadonlyArray<RelationBlocker> {
  if (node.blockers && node.blockers.length > 0) return node.blockers;
  for (const child of node.children ?? []) {
    const b = findBlockers(child);
    if (b.length > 0) return b;
  }
  return [];
}
