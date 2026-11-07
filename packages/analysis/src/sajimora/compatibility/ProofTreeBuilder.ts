import * as crypto from 'node:crypto';
import {
  TypeRelationResult,
  RulePremise,
  RelationKind,
  RelationStatus,
  IncompatibilityWitness,
  RelationBlocker,
  VarianceFrame,
  canonicalJson,
  SpecializedUsageContract,
  CompatibilityProofEvidence,
  IncompatibleEvidence,
  UndecidableEvidence,
  UsageRole,
  LanguageContractIR
} from '@sajimora/core';

export interface NodeBuilderParams {
  readonly relation: RelationKind;
  readonly rule: string;
  readonly rulePremises?: ReadonlyArray<RulePremise>;
  readonly dischargedObligations?: ReadonlyArray<string>;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly ruleNamespace: string;
  readonly source: unknown;
  readonly target: unknown;
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly effectivePolicy: Record<string, unknown>;
  readonly children?: ReadonlyArray<TypeRelationResult>;
  readonly varianceStack?: ReadonlyArray<VarianceFrame>;
  readonly witness?: IncompatibilityWitness;
  readonly blockers?: ReadonlyArray<RelationBlocker>;
  readonly anyDependency?: boolean;
  readonly hypothesisDischarged?: boolean;
  readonly structuralGuardDepth?: number;
  readonly workConsumed?: number;
  readonly depth?: number;
  readonly aggregationMode?: 'UNIVERSAL_CONJUNCTION' | 'EXISTENTIAL_DISJUNCTION';
}

export class ProofTreeBuilder {
  public static createNode(status: RelationStatus, params: NodeBuilderParams): TypeRelationResult {
    return {
      status,
      relation: params.relation,
      rule: params.rule,
      rulePremises: params.rulePremises ?? [],
      dischargedObligations: params.dischargedObligations ?? [],
      adapterId: params.adapterId,
      adapterVersion: params.adapterVersion,
      ruleNamespace: params.ruleNamespace,
      source: params.source,
      target: params.target,
      sourceHash: params.sourceHash,
      targetHash: params.targetHash,
      effectivePolicy: params.effectivePolicy,
      children: params.children ?? [],
      varianceStack: params.varianceStack,
      witness: params.witness,
      blockers: params.blockers ?? [],
      anyDependency: params.anyDependency ?? false,
      hypothesisDischarged: params.hypothesisDischarged,
      structuralGuardDepth: params.structuralGuardDepth,
      workConsumed: params.workConsumed,
      depth: params.depth,
      aggregationMode: params.aggregationMode
    };
  }

  public static createCompatibleNode(params: NodeBuilderParams): TypeRelationResult {
    return this.createNode('COMPATIBLE', params);
  }

  public static createIncompatibleNode(params: NodeBuilderParams): TypeRelationResult {
    return this.createNode('INCOMPATIBLE', params);
  }

  public static createUndecidableNode(params: NodeBuilderParams): TypeRelationResult {
    return this.createNode('UNDECIDABLE', params);
  }

  public static computeEvidenceId(
    consumerMappingId: string,
    parentOccurrenceId: string,
    targetMappingId: string,
    sourceHash: string,
    targetHash: string,
    relation: RelationKind,
    effectivePolicy: Record<string, unknown>,
    ruleChain: ReadonlyArray<string>
  ): string {
    const policyStr = canonicalJson(effectivePolicy);
    const hashInput = [
      consumerMappingId,
      parentOccurrenceId,
      targetMappingId,
      sourceHash,
      targetHash,
      relation,
      policyStr,
      ruleChain.join(',')
    ].join('|');

    return crypto.createHash('sha256').update(hashInput, 'utf8').digest('hex');
  }

  public static extractRuleChain(tree: TypeRelationResult): string[] {
    const rules: string[] = [];
    const visit = (node: TypeRelationResult) => {
      if (node.rule && !rules.includes(node.rule)) {
        rules.push(node.rule);
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
    };
    visit(tree);
    return rules;
  }

  public static countAnyDependencies(tree: TypeRelationResult): number {
    let count = tree.anyDependency ? 1 : 0;
    for (const child of tree.children ?? []) {
      count += this.countAnyDependencies(child);
    }
    return count;
  }

  public static buildProofEvidence(
    consumerMappingId: string,
    parentOccurrenceId: string,
    targetMappingId: string,
    usageRole: UsageRole,
    specialization: SpecializedUsageContract<unknown>,
    proofTree: TypeRelationResult,
    effectivePolicy: Record<string, unknown>,
    candidateOccurrenceId?: string,
    parentContractIR?: LanguageContractIR<unknown>,
    candidateContractIR?: LanguageContractIR<unknown>
  ): CompatibilityProofEvidence {
    const ruleChain = this.extractRuleChain(proofTree);
    const anyDependencyCount = this.countAnyDependencies(proofTree);
    const evidenceId = this.computeEvidenceId(
      consumerMappingId,
      parentOccurrenceId,
      targetMappingId,
      proofTree.sourceHash,
      proofTree.targetHash,
      proofTree.relation,
      effectivePolicy,
      ruleChain
    );

    return {
      evidenceId,
      consumerMappingId,
      parentOccurrenceId,
      candidateOccurrenceId,
      targetMappingId,
      usageRole,
      specialization,
      proofTree,
      ruleChain,
      anyDependencyCount,
      effectivePolicy,
      parentContractIR,
      candidateContractIR
    };
  }

  public static buildIncompatibleEvidence(
    consumerMappingId: string,
    parentOccurrenceId: string,
    targetMappingId: string,
    usageRole: UsageRole,
    proofTree: TypeRelationResult,
    witness: IncompatibilityWitness,
    specialization?: SpecializedUsageContract<unknown>,
    candidateOccurrenceId?: string,
    parentContractIR?: LanguageContractIR<unknown>,
    candidateContractIR?: LanguageContractIR<unknown>
  ): IncompatibleEvidence {
    return {
      status: 'INCOMPATIBLE',
      consumerMappingId,
      parentOccurrenceId,
      candidateOccurrenceId,
      targetMappingId,
      usageRole,
      specialization,
      proofTree,
      witness,
      parentContractIR,
      candidateContractIR
    };
  }

  public static buildUndecidableEvidence(
    consumerMappingId: string,
    parentOccurrenceId: string,
    targetMappingId: string,
    usageRole: UsageRole,
    blockers: ReadonlyArray<RelationBlocker>,
    partialProofTree?: TypeRelationResult,
    specialization?: SpecializedUsageContract<unknown>,
    candidateOccurrenceId?: string,
    parentContractIR?: LanguageContractIR<unknown>,
    candidateContractIR?: LanguageContractIR<unknown>
  ): UndecidableEvidence {
    return {
      status: 'UNDECIDABLE',
      consumerMappingId,
      parentOccurrenceId,
      candidateOccurrenceId,
      targetMappingId,
      usageRole,
      specialization,
      partialProofTree,
      blockers,
      parentContractIR,
      candidateContractIR
    };
  }
}
