/**
 * @file ProofProducer.ts
 * Builds deterministic content-addressed SemanticProof DAGs from SemanticObligations.
 * Node IDs are content-derived from rule, premises, and conclusion.
 */

import {
  ProofNode,
  SemanticObligation,
  SemanticProof
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  RuleSetId,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  CanonicalSet,
  canonicalEncode,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { F0ScalarType, F0TypeVerifier } from '../fragment/F0TypeVerifier';

export class ProofProducer {
  public static computeNodeId(ruleId: string, premises: string[], conclusion: any): string {
    const payload = `${ruleId}:${premises.join(',')}:${canonicalEncode(conclusion)}`;
    return computeDomainSeparatedHash(
      ArtifactDomain.PROOF,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      Buffer.from(payload, 'utf8')
    ).substring(0, 32);
  }

  /**
   * Generates a SemanticProof from canonical obligation witnesses. The legacy
   * termData argument is ignored; caller-selected terms cannot alter a proof.
   */
  public static produceProof(
    obligation: SemanticObligation,
    termData?: {
      sourceScalar?: F0ScalarType;
      targetScalar?: F0ScalarType;
      isArityOk?: boolean;
      memberAvailable?: boolean;
    }
  ): SemanticProof {
    const nodes = new Map<string, ProofNode>();
    const obligationPremises: string[] = [];
    let isAllCompatible = true;
    let failingNodeId: string | null = null;
    let failingReason: string = 'INCOMPATIBLE_CONSUMER';
    const relationBindings: NonNullable<SemanticProof['relationBindings']> = [];

    const obligationRef = {
      domain: ArtifactDomain.OBLIGATION,
      digest: hashContract(ArtifactDomain.OBLIGATION, obligation.schemaVersion, obligation)
    };

    const addNode = (ruleId: string, premises: string[], conclusion: any): ProofNode => {
      const nodeId = ProofProducer.computeNodeId(ruleId, premises, conclusion);
      const node: ProofNode = { nodeId, ruleId, premises, conclusion };
      nodes.set(nodeId, node);
      return node;
    };

    // Evaluate each required relation
    for (const rel of obligation.requiredRelations) {
      if (rel.sourceTermValueOrNull === undefined || rel.targetTermValueOrNull === undefined) {
        throw new Error(`Missing canonical witness for relation ${rel.relationId}`);
      }
      const termMatches = (value: unknown | null, ref: typeof rel.sourceTermRefOrNull) =>
        value === null ? ref === null : !!ref && ref.domain === ArtifactDomain.SOURCE_BYTES &&
          computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1,
            Buffer.from(canonicalEncode(value), 'utf8')) === ref.digest;
      if (!termMatches(rel.sourceTermValueOrNull, rel.sourceTermRefOrNull) ||
          !termMatches(rel.targetTermValueOrNull, rel.targetTermRefOrNull)) {
        throw new Error(`Canonical witness hash mismatch for relation ${rel.relationId}`);
      }
      const previousPremises = obligationPremises.length;
      if (rel.kind === 'PARAMETER_ACCEPTS_ARGUMENT') {
        const src = rel.sourceTermValueOrNull as F0ScalarType;
        const tgt = rel.targetTermValueOrNull as F0ScalarType;

        const isSubtype = F0TypeVerifier.isScalarSubtype(src, tgt);

        // Relation node
        const relNode = addNode('F0.REL.SCALAR', [], {
          source: src,
          target: tgt,
          compatible: isSubtype
        });

        // Obligation node
        const oblNode = addNode('F0.OBL.ARGUMENT', [relNode.nodeId], {
          status: isSubtype ? 'COMPATIBLE' : 'INCOMPATIBLE',
          reason: isSubtype ? null : 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE'
        });

        obligationPremises.push(oblNode.nodeId);
        if (!isSubtype) {
          isAllCompatible = false;
          failingNodeId = oblNode.nodeId;
          failingReason = 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE';
        }
      } else if (rel.kind === 'ASSIGNMENT_ACCEPTS') {
        const src = rel.sourceTermValueOrNull as F0ScalarType;
        const tgt = rel.targetTermValueOrNull as F0ScalarType;

        const isSubtype = F0TypeVerifier.isScalarSubtype(src, tgt);

        const relNode = addNode('F0.REL.SCALAR', [], {
          source: src,
          target: tgt,
          compatible: isSubtype
        });

        const oblNode = addNode('F0.OBL.INITIALIZATION', [relNode.nodeId], {
          status: isSubtype ? 'COMPATIBLE' : 'INCOMPATIBLE',
          reason: isSubtype ? null : 'INITIALIZER_INCOMPATIBLE'
        });

        obligationPremises.push(oblNode.nodeId);
        if (!isSubtype) {
          isAllCompatible = false;
          failingNodeId = oblNode.nodeId;
          failingReason = 'INITIALIZER_INCOMPATIBLE';
        }
      } else if (rel.kind === 'ARITY') {
        const argCount = (rel.sourceTermValueOrNull as { argCount: number }).argCount;
        const requiredParamCount = (rel.targetTermValueOrNull as { requiredParamCount: number }).requiredParamCount;
        if (!Number.isSafeInteger(argCount) || argCount < 0 || !Number.isSafeInteger(requiredParamCount) || requiredParamCount < 0) {
          throw new Error('Invalid canonical arity witness');
        }
        const isOk = argCount >= requiredParamCount;
        const oblNode = addNode('F0.OBL.ARITY', [], {
          argCount,
          requiredParamCount,
          status: isOk ? 'COMPATIBLE' : 'INCOMPATIBLE',
          reason: isOk ? null : 'REQUIRED_PARAMETER_ADDED'
        });

        obligationPremises.push(oblNode.nodeId);
        if (!isOk) {
          isAllCompatible = false;
          failingNodeId = oblNode.nodeId;
          failingReason = 'REQUIRED_PARAMETER_ADDED';
        }
      } else if (rel.kind === 'RETURN_SATISFIES_CONTEXT') {
        if (!rel.sourceTermRefOrNull && !rel.targetTermRefOrNull) {
          const oblNode = addNode('F0.OBL.DISCARDED_RETURN', [], {
            status: 'COMPATIBLE',
            reason: null
          });
          obligationPremises.push(oblNode.nodeId);
        } else {
          const src = rel.sourceTermValueOrNull as F0ScalarType;
          const tgt = rel.targetTermValueOrNull as F0ScalarType;
          const isSubtype = F0TypeVerifier.isScalarSubtype(src, tgt);

          const relNode = addNode('F0.REL.SCALAR', [], {
            source: src,
            target: tgt,
            compatible: isSubtype
          });

          const oblNode = addNode('F0.OBL.RETURN_CONTEXT', [relNode.nodeId], {
            status: isSubtype ? 'COMPATIBLE' : 'INCOMPATIBLE',
            reason: isSubtype ? null : 'RETURN_TYPE_INCOMPATIBLE'
          });

          obligationPremises.push(oblNode.nodeId);
          if (!isSubtype) {
            isAllCompatible = false;
            failingNodeId = oblNode.nodeId;
            failingReason = 'RETURN_TYPE_INCOMPATIBLE';
          }
        }
      } else if (rel.kind === 'MEMBER_AVAILABLE') {
        const isAvail = (rel.targetTermValueOrNull as { available: boolean }).available;
        if (typeof isAvail !== 'boolean') throw new Error('Invalid canonical member witness');
        const oblNode = addNode('F0.OBL.MEMBER_READ', [], {
          memberAvailable: isAvail,
          memberTypeCompatible: isAvail,
          status: isAvail ? 'COMPATIBLE' : 'INCOMPATIBLE',
          reason: isAvail ? null : 'REQUIRED_PROPERTY_MISSING'
        });

        obligationPremises.push(oblNode.nodeId);
        if (!isAvail) {
          isAllCompatible = false;
          failingNodeId = oblNode.nodeId;
          failingReason = 'REQUIRED_PROPERTY_MISSING';
        }
      } else if (rel.kind === 'OPERATIONAL_RETURN_AVAILABLE') {
        const source = rel.sourceTermValueOrNull as { outcome?: string };
        const target = rel.targetTermValueOrNull as { outcome?: string };
        const available = source?.outcome === 'VALUE' && target?.outcome === 'VALUE';
        const oblNode = addNode('F0.OBL.OPERATIONAL_RETURN', [], {
          sourceOutcome: source?.outcome, candidateOutcome: target?.outcome,
          status: available ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: available ? null : 'OPERATIONAL_RETURN_UNAVAILABLE'
        });
        obligationPremises.push(oblNode.nodeId);
        if (!available) { isAllCompatible = false; failingNodeId = oblNode.nodeId; failingReason = 'OPERATIONAL_RETURN_UNAVAILABLE'; }
      } else if (rel.kind === 'CALLABLE_REQUIRED') {
        const source = rel.sourceTermValueOrNull as { callable?: boolean };
        const target = rel.targetTermValueOrNull as { callable?: boolean };
        const available = source?.callable === true && target?.callable === true;
        const oblNode = addNode('F0.OBL.CALLABLE_REQUIRED', [], {
          historicalCallable: source?.callable, candidateCallable: target?.callable,
          status: available ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: available ? null : 'EXPORT_NOT_CALLABLE'
        });
        obligationPremises.push(oblNode.nodeId);
        if (!available) { isAllCompatible = false; failingNodeId = oblNode.nodeId; failingReason = 'EXPORT_NOT_CALLABLE'; }
      } else {
        throw new Error(`Unsupported proof relation ${rel.kind}`);
      }
      if (obligationPremises.length !== previousPremises + 1) throw new Error(`Missing proof branch for ${rel.relationId}`);
      relationBindings.push({ relationId: rel.relationId, kind: rel.kind, position: rel.position,
        sourceTermValueOrNull: rel.sourceTermValueOrNull, targetTermValueOrNull: rel.targetTermValueOrNull,
        proofNodeId: obligationPremises[obligationPremises.length - 1] });
    }

    // Composition root node
    let rootNode: ProofNode;
    if (isAllCompatible) {
      rootNode = addNode('F0.COMPOSE.ALL', obligationPremises, 'COMPATIBLE');
    } else {
      rootNode = addNode(
        'F0.COMPOSE.RELEVANT_FAILURE',
        failingNodeId ? [failingNodeId] : obligationPremises,
        {
          status: 'INCOMPATIBLE',
          witness: {
            reason: failingReason,
            failingNodeId: failingNodeId || obligationPremises[0]
          }
        }
      );
    }

    return {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      obligationRef,
      ruleSetId: RuleSetId.F0_RULES_V1,
      nodes: new CanonicalSet<ProofNode>(Array.from(nodes.values())),
      rootNodeIds: new CanonicalSet<string>([rootNode.nodeId]),
      claimedConclusion: isAllCompatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
      witnessContext: {
        parentEnvironmentRef: obligation.parentEnvironmentRef,
        candidateEnvironmentRef: obligation.candidateEnvironmentRef,
        targetIdentityEvidenceRef: obligation.targetIdentityEvidenceRef,
        occurrenceAnchor: obligation.historicalOccurrenceAnchor,
        consumerFile: obligation.historicalOccurrenceAnchor.fileId
      },
      relationBindings
    };
  }
}
