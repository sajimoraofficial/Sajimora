import * as crypto from 'node:crypto';
import {
  IncompatibilityWitness,
  WitnessLocation,
  WitnessPosition,
  TypeDisplay,
  RelationKind,
  canonicalJson
} from '@sajimora/core';

export interface WitnessGenerationParams {
  readonly consumerOccurrenceId?: string;
  readonly targetSymbolId?: string;
  readonly consumerLocation: WitnessLocation;
  readonly targetDeclaration: WitnessLocation;
  readonly semanticRelation: RelationKind;
  readonly position: WitnessPosition;
  readonly parentType: TypeDisplay;
  readonly candidateType: TypeDisplay;
  readonly failedRelation: string;
  readonly evidenceChain?: ReadonlyArray<string>;
  readonly ruleId?: string;
  readonly effectivePolicy?: Record<string, unknown>;
}

export class WitnessGenerator {
  public static createWitness(params: WitnessGenerationParams): IncompatibilityWitness {
    const policyStr = params.effectivePolicy ? canonicalJson(params.effectivePolicy) : '';
    const posStr = canonicalJson(params.position);
    const sourceHash = params.parentType.irContentHash ?? params.parentType.display;
    const targetHash = params.candidateType.irContentHash ?? params.candidateType.display;

    // Deterministic SHA-256 witness ID over the canonical proposition
    const hashInput = [
      params.consumerOccurrenceId ?? '',
      params.targetSymbolId ?? '',
      params.semanticRelation,
      posStr,
      sourceHash,
      targetHash,
      policyStr
    ].join('|');

    const witnessId = crypto.createHash('sha256').update(hashInput, 'utf8').digest('hex');

    return {
      witnessId,
      consumerLocation: params.consumerLocation,
      targetDeclaration: params.targetDeclaration,
      semanticRelation: params.semanticRelation,
      position: params.position,
      parentType: params.parentType,
      candidateType: params.candidateType,
      failedRelation: params.failedRelation,
      evidenceChain: params.evidenceChain ?? [witnessId],
      ruleId: params.ruleId
    };
  }
}
