/**
 * @file JavaProofChecker.ts
 * Zero-trust independent proof verifier for Java SemanticProof derivation DAGs.
 *
 * Enforces zero-trust:
 * - Cycle detection: DAGs must be strictly acyclic (PROOF_CYCLE_DETECTED).
 * - Closed rule registry: only JavaRuleSetId.JAVA_F0_RULES_V1 permitted (INVALID_RULE_APPLICATION).
 * - Premise satisfaction: every premise must exist and be satisfied (PREMISE_NOT_SATISFIED).
 * - Independent recomputation: conclusion must match checker-computed result (CONCLUSION_MISMATCH).
 * - Root integrity: roots must match claimedConclusion (ROOT_CONCLUSION_MISMATCH).
 * - Obligation binding: obligationDigest must match obligation content hash (HASH_MISMATCH).
 * - Resource budgets: node limits and depth limits enforced (RESOURCE_EXHAUSTED).
 */

import * as crypto from 'node:crypto';
import {
  JAVA_CERTIFIED_EVIDENCE_V1,
  JavaRuleSetId,
  JavaSchemaVersion
} from './JavaCertifiedProfile';
import {
  JavaProofNode,
  JavaRuleRegistry,
  JavaRuleConclusion
} from './JavaRuleRegistry';

export interface JavaSemanticObligation {
  readonly schemaVersion: JavaSchemaVersion;
  readonly obligationId: string;
  readonly sourceFqcn: string;
  readonly targetFqcn: string;
  readonly relationKind: 'SUBTYPE' | 'METHOD_CALL' | 'FIELD_ACCESS' | 'IMPLEMENTS' | 'EXTENDS';
  readonly memberSignature?: string;
  readonly evidenceSnapshotRef: string;
  readonly [key: string]: any;
}

export interface JavaSemanticProof {
  readonly schemaVersion: JavaSchemaVersion;
  readonly ruleSetId: JavaRuleSetId;
  readonly obligationDigest: string;
  readonly nodes: readonly JavaProofNode[];
  readonly rootNodeIds: readonly string[];
  readonly claimedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE';
  readonly metadata?: Record<string, any>;
}

export interface JavaProofBudget {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

export interface JavaProofVerificationResult {
  readonly valid: boolean;
  readonly blockerCode?:
    | 'INVALID_SCHEMA'
    | 'INVALID_RULESET'
    | 'HASH_MISMATCH'
    | 'PROOF_CYCLE_DETECTED'
    | 'PREMISE_NOT_SATISFIED'
    | 'INVALID_RULE_APPLICATION'
    | 'CONCLUSION_MISMATCH'
    | 'ROOT_CONCLUSION_MISMATCH'
    | 'SOURCE_EVIDENCE_UNVERIFIED'
    | 'RESOURCE_EXHAUSTED';
  readonly reason?: string;
  readonly verifiedConclusion?: 'COMPATIBLE' | 'INCOMPATIBLE';
  readonly validatedNodeCount?: number;
}

/**
 * Computes deterministic canonical SHA-256 digest of an obligation.
 */
export function computeJavaObligationDigest(obligation: JavaSemanticObligation): string {
  const normalized = {
    schemaVersion: obligation.schemaVersion,
    obligationId: obligation.obligationId,
    sourceFqcn: obligation.sourceFqcn,
    targetFqcn: obligation.targetFqcn,
    relationKind: obligation.relationKind,
    memberSignature: obligation.memberSignature ?? null,
    evidenceSnapshotRef: obligation.evidenceSnapshotRef
  };
  const json = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

export class JavaProofChecker {
  public static readonly DEFAULT_MAX_NODES = 5000;
  public static readonly DEFAULT_MAX_DEPTH = 32;

  /**
   * Independently verifies a JavaSemanticProof derivation DAG.
   */
  public static verify(
    obligation: JavaSemanticObligation,
    proof: JavaSemanticProof,
    budget?: JavaProofBudget
  ): JavaProofVerificationResult {
    const maxNodes = budget?.maxNodes ?? this.DEFAULT_MAX_NODES;
    const maxDepth = budget?.maxDepth ?? this.DEFAULT_MAX_DEPTH;

    // 1. Schema version and ruleset
    if (proof.schemaVersion !== JAVA_CERTIFIED_EVIDENCE_V1) {
      return {
        valid: false,
        blockerCode: 'INVALID_SCHEMA',
        reason: `Proof schema version '${proof.schemaVersion}' does not match expected '${JAVA_CERTIFIED_EVIDENCE_V1}'`
      };
    }

    if (proof.ruleSetId !== JavaRuleSetId.JAVA_F0_RULES_V1) {
      return {
        valid: false,
        blockerCode: 'INVALID_RULESET',
        reason: `Proof ruleset '${proof.ruleSetId}' does not match expected '${JavaRuleSetId.JAVA_F0_RULES_V1}'`
      };
    }

    // 2. Obligation digest integrity check
    const expectedDigest = computeJavaObligationDigest(obligation);
    if (proof.obligationDigest !== expectedDigest) {
      return {
        valid: false,
        blockerCode: 'HASH_MISMATCH',
        reason: `Proof obligation digest '${proof.obligationDigest}' does not match computed '${expectedDigest}'`
      };
    }

    // 3. Node count budget check
    if (proof.nodes.length > maxNodes) {
      return {
        valid: false,
        blockerCode: 'RESOURCE_EXHAUSTED',
        reason: `Proof node count (${proof.nodes.length}) exceeds budget (${maxNodes})`
      };
    }

    if (proof.nodes.length === 0 || proof.rootNodeIds.length === 0) {
      return {
        valid: false,
        blockerCode: 'PREMISE_NOT_SATISFIED',
        reason: 'Proof contains zero nodes or empty rootNodeIds'
      };
    }

    const nodeMap = new Map<string, JavaProofNode>();
    for (const node of proof.nodes) {
      if (nodeMap.has(node.nodeId)) {
        return {
          valid: false,
          blockerCode: 'INVALID_RULE_APPLICATION',
          reason: `Duplicate nodeId '${node.nodeId}' in proof DAG`
        };
      }
      nodeMap.set(node.nodeId, node);
    }

    // Verify rootNodeIds exist
    for (const rootId of proof.rootNodeIds) {
      if (!nodeMap.has(rootId)) {
        return {
          valid: false,
          blockerCode: 'ROOT_CONCLUSION_MISMATCH',
          reason: `Root node '${rootId}' not found in proof nodes`
        };
      }
    }

    // 4. Cycle Detection & Depth Verification (Tarjan / DFS color marking)
    // 0 = unvisited, 1 = visiting, 2 = visited
    const visitState = new Map<string, number>();
    const nodeDepths = new Map<string, number>();

    const checkCycleAndDepth = (nodeId: string, currentDepth: number): string | null => {
      if (currentDepth > maxDepth) {
        return 'RESOURCE_EXHAUSTED';
      }
      const state = visitState.get(nodeId) ?? 0;
      if (state === 1) {
        return 'PROOF_CYCLE_DETECTED';
      }
      if (state === 2) {
        return null;
      }

      visitState.set(nodeId, 1);
      const node = nodeMap.get(nodeId);
      if (!node) {
        return 'PREMISE_NOT_SATISFIED';
      }

      for (const premiseId of node.premises) {
        if (!nodeMap.has(premiseId)) {
          return 'PREMISE_NOT_SATISFIED';
        }
        const err = checkCycleAndDepth(premiseId, currentDepth + 1);
        if (err) return err;
      }

      visitState.set(nodeId, 2);
      nodeDepths.set(nodeId, currentDepth);
      return null;
    };

    for (const rootId of proof.rootNodeIds) {
      const cycleOrBudgetErr = checkCycleAndDepth(rootId, 1);
      if (cycleOrBudgetErr) {
        return {
          valid: false,
          blockerCode: cycleOrBudgetErr as any,
          reason: `Cycle, depth, or missing premise detected starting at root '${rootId}'`
        };
      }
    }

    // 5. Topological Sort for bottom-up verification
    const visited = new Set<string>();
    const sortedOrder: string[] = [];

    const topoSort = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = nodeMap.get(nodeId)!;
      for (const p of node.premises) {
        topoSort(p);
      }
      sortedOrder.push(nodeId);
    };

    for (const rootId of proof.rootNodeIds) {
      topoSort(rootId);
    }

    // 6. Zero-Trust Independent Evaluation & Recomputation
    const evaluatedConclusions = new Map<string, JavaRuleConclusion>();

    for (const nodeId of sortedOrder) {
      const node = nodeMap.get(nodeId)!;

      // Validate rule exists in registry
      if (!JavaRuleRegistry.isRuleRegistered(node.ruleId)) {
        return {
          valid: false,
          blockerCode: 'INVALID_RULE_APPLICATION',
          reason: `Unregistered rule '${node.ruleId}'`
        };
      }

      // Check all premises have been evaluated
      for (const pId of node.premises) {
        if (!evaluatedConclusions.has(pId)) {
          return {
            valid: false,
            blockerCode: 'PREMISE_NOT_SATISFIED',
            reason: `Premise '${pId}' not satisfied for node '${nodeId}'`
          };
        }
      }

      // Recompute conclusion from premises
      const evalResult = JavaRuleRegistry.evaluate(node, nodeMap);
      if (!evalResult.valid) {
        return {
          valid: false,
          blockerCode: 'CONCLUSION_MISMATCH',
          reason: evalResult.reason ?? `Evaluation failed for node '${nodeId}' with rule '${node.ruleId}'`
        };
      }

      // Check recomputed conclusion matches claimed conclusion
      if (evalResult.computedConclusion) {
        const claimed = node.conclusion;
        const computed = evalResult.computedConclusion;
        if (claimed.compatible !== computed.compatible) {
          return {
            valid: false,
            blockerCode: 'CONCLUSION_MISMATCH',
            reason: `Node '${nodeId}' claimed compatible=${claimed.compatible} but checker recomputed compatible=${computed.compatible}`
          };
        }
      }

      evaluatedConclusions.set(nodeId, node.conclusion);
    }

    // 7. Verify Root Conclusion Matches Claimed
    let rootCompatible = true;
    for (const rootId of proof.rootNodeIds) {
      const rootConc = evaluatedConclusions.get(rootId);
      if (!rootConc || !rootConc.compatible) {
        rootCompatible = false;
        break;
      }
    }

    const verifiedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' = rootCompatible ? 'COMPATIBLE' : 'INCOMPATIBLE';
    if (verifiedConclusion !== proof.claimedConclusion) {
      return {
        valid: false,
        blockerCode: 'ROOT_CONCLUSION_MISMATCH',
        reason: `Recomputed root conclusion (${verifiedConclusion}) does not match proof claimed conclusion (${proof.claimedConclusion})`
      };
    }

    // V1 proves relationships between producer-supplied strings/flags, not
    // between independently reconstructed source declarations. In particular,
    // a matching obligation hash does not bind its root proposition or leaf
    // facts to source. Do not promote either positive or negative DAG claims.
    // A future source-bound profile must use a new version and checker.
    return {
      valid: false,
      blockerCode: 'SOURCE_EVIDENCE_UNVERIFIED',
      reason: 'JAVA_F0_RULES_V1 has no independently checked source facts and exact root-obligation binding; retain the result as advisory.',
      validatedNodeCount: sortedOrder.length
    };
  }
}
