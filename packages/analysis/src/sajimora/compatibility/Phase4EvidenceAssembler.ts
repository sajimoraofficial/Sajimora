import {
  CompatibilityResult,
  TypeRelationResult,
  IncompatibilityWitness,
  RelationBlocker,
  binaryCompare
} from '@sajimora/core';
import { Phase4CompatibilityBundle } from './AuthorityIntegrationLayer';

export class Phase4EvidenceAssembler {
  public static assembleBundle(
    consumerResults: Map<string, CompatibilityResult>,
    engineVersion = '33.0.0'
  ): Phase4CompatibilityBundle {
    const proofTrees = new Map<string, TypeRelationResult>();
    const witnesses: IncompatibilityWitness[] = [];
    const blockers: RelationBlocker[] = [];

    let compatibleCount = 0;
    let incompatibleCount = 0;
    let undecidableCount = 0;
    let anyDependencyUndecidableCount = 0;

    for (const [consumerId, res] of consumerResults.entries()) {
      if (res.status === 'COMPATIBLE') {
        compatibleCount++;
        if (res.phase4Evidence?.proofTree) {
          proofTrees.set(consumerId, res.phase4Evidence.proofTree);
        }
      } else if (res.status === 'INCOMPATIBLE') {
        incompatibleCount++;
        if (res.phase4Evidence?.proofTree) {
          proofTrees.set(consumerId, res.phase4Evidence.proofTree);
        }
        if (res.phase4Evidence?.witness) {
          witnesses.push(res.phase4Evidence.witness);
        }
      } else if (res.status === 'UNDECIDABLE') {
        undecidableCount++;
        if (res.phase4Evidence?.partialProofTree) {
          proofTrees.set(consumerId, res.phase4Evidence.partialProofTree);
        }
        if (res.phase4Evidence?.blockers) {
          blockers.push(...res.phase4Evidence.blockers);
          if (res.phase4Evidence.blockers.some(b => b.blockerId.startsWith('ANY_DEPENDENCY'))) {
            anyDependencyUndecidableCount++;
          }
        }
      }
    }

    // Sort witnesses and blockers deterministically in binary order
    witnesses.sort((a, b) => binaryCompare(a.witnessId, b.witnessId));
    blockers.sort((a, b) => binaryCompare(a.blockerId, b.blockerId));

    return {
      schemaVersion: 'SAJIMORA_COMPATIBILITY_EVIDENCE_V1',
      engineVersion,
      consumerResults,
      proofTrees,
      witnesses,
      blockerSummary: blockers,
      typeIRStats: {
        totalNodesExtracted: proofTrees.size,
        unsupportedNodes: blockers.filter(b => b.blockerId === 'TYPE_IR_EXTRACTION_UNSUPPORTED').length,
        cycleBackreferencesUsed: 0,
        maxDepthReached: 1
      },
      proofStats: {
        compatibleCount,
        incompatibleCount,
        undecidableCount,
        anyDependencyUndecidableCount
      },
      phase4Outcome: {
        allConsumersEvaluated: undecidableCount === 0,
        coverageGaps: []
      }
    };
  }
}
