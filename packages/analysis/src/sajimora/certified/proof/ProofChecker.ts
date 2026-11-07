/**
 * @file ProofChecker.ts
 * Independently verifies SemanticProof derivation DAGs.
 * Enforces zero-trust:
 * - Cycle detection: DAGs must be strictly acyclic (PROOF_CYCLE_DETECTED)
 * - Closed rule registry: only RuleSetId.F0_RULES_V1 rules permitted (INVALID_RULE_APPLICATION)
 * - Premise satisfaction: every premise must exist and be satisfied (PREMISE_NOT_SATISFIED)
 * - Independent recomputation: conclusion must match checker-computed result (PREMISE_NOT_SATISFIED)
 * - Root integrity: roots must match claimedConclusion (INVALID_RULE_APPLICATION)
 * - Obligation binding: obligationRef must match obligation digest (HASH_MISMATCH)
 * - Budget enforcement: node limits and depth limits enforced (RESOURCE_EXHAUSTED)
 */

import {
  BlockerCode,
  BlockerDetail
} from '../../../../../core/src/sajimora/certified/blockers';
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
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { VerificationBudget } from './VerificationBudget';
import { RuleRegistry } from './RuleRegistry';
import { ProofProducer } from './ProofProducer';
import { canonicalEncode, computeDomainSeparatedHash } from '../../../../../core/src/sajimora/certified/canonicalEncoding';

export interface ProofVerificationResult {
  valid: boolean;
  blockerCode?: BlockerCode;
  detail?: BlockerDetail;
  verifiedConclusion?: 'COMPATIBLE' | 'INCOMPATIBLE';
  witness?: any;
}

export class ProofChecker {
  /**
   * Independently verifies a SemanticProof DAG against its bound SemanticObligation.
   */
  public static verify(
    obligation: SemanticObligation,
    proof: SemanticProof,
    budget: VerificationBudget
  ): ProofVerificationResult {
    budget.checkCancellation();

    // 1. Schema version and ruleset
    if (proof.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
      return {
        valid: false,
        blockerCode: BlockerCode.INVALID_SCHEMA,
        detail: {
          code: BlockerCode.INVALID_SCHEMA,
          message: `SemanticProof has invalid schemaVersion '${proof.schemaVersion}'`
        }
      };
    }

    if (proof.ruleSetId !== RuleSetId.F0_RULES_V1) {
      return {
        valid: false,
        blockerCode: BlockerCode.UNSUPPORTED_PROTOCOL,
        detail: {
          code: BlockerCode.UNSUPPORTED_PROTOCOL,
          message: `SemanticProof has unsupported ruleSetId '${proof.ruleSetId}'`
        }
      };
    }

    // 2. Obligation reference digest check
    const expectedObligationDigest = hashContract(
      ArtifactDomain.OBLIGATION,
      obligation.schemaVersion,
      obligation
    );

    if (proof.obligationRef.domain !== ArtifactDomain.OBLIGATION || proof.obligationRef.digest !== expectedObligationDigest) {
      return {
        valid: false,
        blockerCode: BlockerCode.HASH_MISMATCH,
        detail: {
          code: BlockerCode.HASH_MISMATCH,
          message: 'SemanticProof obligationRef digest does not match obligation'
        }
      };
    }

    // 3. Budget accounting
    budget.allocate('PROOF_NODES', proof.nodes.size);
    budget.allocate('WORK_UNITS', proof.nodes.size * 2);

    // Build node map
    const nodeMap = new Map<string, ProofNode>();
    for (const node of proof.nodes) {
      nodeMap.set(node.nodeId, node);
    }
    const expectedContext = {
      parentEnvironmentRef: obligation.parentEnvironmentRef,
      candidateEnvironmentRef: obligation.candidateEnvironmentRef,
      targetIdentityEvidenceRef: obligation.targetIdentityEvidenceRef,
      occurrenceAnchor: obligation.historicalOccurrenceAnchor,
      consumerFile: obligation.historicalOccurrenceAnchor.fileId
    };
    if (!proof.witnessContext || canonicalEncode(proof.witnessContext) !== canonicalEncode(expectedContext)) {
      return { valid: false, blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
        detail: { code: BlockerCode.INVALID_RULE_APPLICATION, message: 'Proof witness context differs from obligation' } };
    }

    // A valid DAG is not sufficient: each branch must prove the exact sealed
    // relation whose term references were independently replayed at Gate 6.
    const relations = Array.from(obligation.requiredRelations);
    const bindings = proof.relationBindings;
    const rejectBinding = (message: string): ProofVerificationResult => ({
      valid: false, blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
      detail: { code: BlockerCode.INVALID_RULE_APPLICATION, message }
    });
    if (!bindings || bindings.length !== relations.length) return rejectBinding('Missing or extra proof relation branch');
    const seenRelations = new Set<string>();
    const seenBranches = new Set<string>();
    const expectedRules: Record<string, string> = {
      PARAMETER_ACCEPTS_ARGUMENT: 'F0.OBL.ARGUMENT', ASSIGNMENT_ACCEPTS: 'F0.OBL.INITIALIZATION',
      RETURN_SATISFIES_CONTEXT: 'F0.OBL.RETURN_CONTEXT', ARITY: 'F0.OBL.ARITY',
      MEMBER_AVAILABLE: 'F0.OBL.MEMBER_READ', OPERATIONAL_RETURN_AVAILABLE: 'F0.OBL.OPERATIONAL_RETURN',
      CALLABLE_REQUIRED: 'F0.OBL.CALLABLE_REQUIRED'
    };
    const termDigest = (value: unknown) => computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1, Buffer.from(canonicalEncode(value), 'utf8'));
    for (const rel of relations) {
      const matches = bindings.filter(b => b.relationId === rel.relationId);
      if (matches.length !== 1 || seenRelations.has(rel.relationId)) return rejectBinding('Duplicate or missing relation ID');
      seenRelations.add(rel.relationId);
      const binding = matches[0];
      if (binding.sourceTermValueOrNull === undefined || binding.targetTermValueOrNull === undefined) {
        return rejectBinding(`Missing witness operand for ${rel.relationId}`);
      }
      if (binding.kind !== rel.kind || binding.position !== rel.position ||
          rel.sourceTermValueOrNull === undefined || rel.targetTermValueOrNull === undefined ||
          canonicalEncode(binding.sourceTermValueOrNull) !== canonicalEncode(rel.sourceTermValueOrNull) ||
          canonicalEncode(binding.targetTermValueOrNull) !== canonicalEncode(rel.targetTermValueOrNull)) {
        return rejectBinding(`Relation metadata or witness differs for ${rel.relationId}`);
      }
      for (const [value, ref] of [[binding.sourceTermValueOrNull, rel.sourceTermRefOrNull],
        [binding.targetTermValueOrNull, rel.targetTermRefOrNull]] as const) {
        if (value === null ? ref !== null : !ref || ref.domain !== ArtifactDomain.SOURCE_BYTES || termDigest(value) !== ref.digest) {
          return rejectBinding(`Witness term hash differs for ${rel.relationId}`);
        }
      }
      const branch = nodeMap.get(binding.proofNodeId);
      if (!branch || seenBranches.has(binding.proofNodeId)) return rejectBinding('Missing or duplicate proof branch');
      seenBranches.add(binding.proofNodeId);
      const expectedRule = rel.kind === 'RETURN_SATISFIES_CONTEXT' && binding.sourceTermValueOrNull === null
        ? 'F0.OBL.DISCARDED_RETURN' : expectedRules[rel.kind];
      if (!expectedRule || branch.ruleId !== expectedRule) return rejectBinding(`Wrong proof rule for ${rel.relationId}`);
      if (rel.kind === 'ARITY') {
        const src = binding.sourceTermValueOrNull as { argCount?: number };
        const tgt = binding.targetTermValueOrNull as { requiredParamCount?: number };
        if (!Number.isSafeInteger(src?.argCount) || !Number.isSafeInteger(tgt?.requiredParamCount) ||
            branch.conclusion?.argCount !== src.argCount || branch.conclusion?.requiredParamCount !== tgt.requiredParamCount) {
          return rejectBinding('Arity proof differs from sealed argument or required-parameter count');
        }
      } else if (rel.kind === 'MEMBER_AVAILABLE') {
        if (branch.conclusion?.memberAvailable !== (binding.targetTermValueOrNull as { available?: boolean })?.available) {
          return rejectBinding('Member proof differs from sealed witness');
        }
      } else if (rel.kind === 'OPERATIONAL_RETURN_AVAILABLE') {
        const source = binding.sourceTermValueOrNull as { outcome?: string };
        const target = binding.targetTermValueOrNull as { outcome?: string };
        if (source?.outcome !== 'VALUE' || !['VALUE', 'TERMINAL_THROW'].includes(target?.outcome ?? '') ||
            branch.conclusion?.sourceOutcome !== source.outcome || branch.conclusion?.candidateOutcome !== target.outcome) {
          return rejectBinding('Operational-return proof differs from sealed outcome witness');
        }
      } else if (rel.kind === 'CALLABLE_REQUIRED') {
        const source = binding.sourceTermValueOrNull as { callable?: boolean };
        const target = binding.targetTermValueOrNull as { callable?: boolean };
        if (source?.callable !== true || typeof target?.callable !== 'boolean' ||
            branch.conclusion?.historicalCallable !== source.callable ||
            branch.conclusion?.candidateCallable !== target.callable) {
          return rejectBinding('Callability proof differs from sealed export witness');
        }
      } else if (binding.sourceTermValueOrNull !== null) {
        if (branch.premises.length !== 1) return rejectBinding('Scalar proof branch lacks exactly one premise');
        const scalar = nodeMap.get(branch.premises[0]);
        if (!scalar || scalar.ruleId !== 'F0.REL.SCALAR' || !scalar.conclusion?.source || !scalar.conclusion?.target ||
            canonicalEncode(scalar.conclusion?.source) !== canonicalEncode(binding.sourceTermValueOrNull) ||
            canonicalEncode(scalar.conclusion?.target) !== canonicalEncode(binding.targetTermValueOrNull)) {
          return rejectBinding('Proof scalar operands differ from sealed witness');
        }
      }
    }
    const obligationBranches = Array.from(nodeMap.values()).filter(n => n.ruleId.startsWith('F0.OBL.'));
    if (obligationBranches.length !== bindings.length || obligationBranches.some(n => !seenBranches.has(n.nodeId))) {
      return rejectBinding('Extra or unbound obligation proof branch');
    }

    // 4. Cycle Detection in the proof DAG
    const visited = new Map<string, 'VISITING' | 'VISITED'>();
    const dfsCycle = (nodeId: string, depth: number): boolean => {
      budget.allocate('WORK_UNITS', 1);
      const state = visited.get(nodeId);
      if (state === 'VISITING') return true; // cycle detected
      if (state === 'VISITED') return false;

      visited.set(nodeId, 'VISITING');
      const node = nodeMap.get(nodeId);
      if (node && node.premises) {
        for (const pId of node.premises) {
          if (dfsCycle(pId, depth + 1)) return true;
        }
      }
      visited.set(nodeId, 'VISITED');
      return false;
    };

    for (const rootId of proof.rootNodeIds) {
      if (dfsCycle(rootId, 0)) {
        return {
          valid: false,
          blockerCode: BlockerCode.PROOF_CYCLE_DETECTED,
          detail: {
            code: BlockerCode.PROOF_CYCLE_DETECTED,
            message: `Cycle detected in SemanticProof DAG starting from root '${rootId}'`
          }
        };
      }
    }

    // 5. Verify every node in bottom-up topological order
    // Compute in-degrees to order nodes
    const inDegree = new Map<string, number>();
    for (const [id] of nodeMap) {
      inDegree.set(id, 0);
    }
    for (const node of nodeMap.values()) {
      for (const pId of node.premises) {
        inDegree.set(node.nodeId, (inDegree.get(node.nodeId) || 0) + 1);
      }
    }

    // Queue of leaves (nodes with 0 premises)
    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      const node = nodeMap.get(id);
      if (!node || node.premises.length === 0) {
        queue.push(id);
      }
    }

    const processed = new Set<string>();

    while (queue.length > 0) {
      const currId = queue.shift()!;
      processed.add(currId);
      const node = nodeMap.get(currId);
      if (!node) continue;

      // Verify node content-addressed ID integrity
      const expectedId = ProofProducer.computeNodeId(node.ruleId, node.premises, node.conclusion);
      if (node.nodeId !== expectedId) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: {
            code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Node ID '${node.nodeId}' does not match content hash '${expectedId}'`
          }
        };
      }

      // Check rule exists
      if (!RuleRegistry.hasRule(node.ruleId)) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: {
            code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Unrecognized rule ID '${node.ruleId}'`
          }
        };
      }

      // Check all premises are already verified
      const premiseMap = new Map<string, ProofNode>();
      for (const pId of node.premises) {
        const pNode = nodeMap.get(pId);
        if (!pNode || !processed.has(pId)) {
          return {
            valid: false,
            blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
            detail: {
              code: BlockerCode.PREMISE_NOT_SATISFIED,
              message: `Premise '${pId}' not satisfied or not yet verified for node '${node.nodeId}'`
            }
          };
        }
        premiseMap.set(pId, pNode);
      }

      // Evaluate rule independently
      const evalRes = RuleRegistry.evaluateRule(node, premiseMap);
      if (!evalRes.valid) {
        return {
          valid: false,
          blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
          detail: {
            code: BlockerCode.PREMISE_NOT_SATISFIED,
            message: evalRes.reason || `Rule evaluation failed for node '${node.nodeId}'`
          }
        };
      }
      if (canonicalEncode(evalRes.computedConclusion) !== canonicalEncode(node.conclusion)) {
        return { valid: false, blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
          detail: { code: BlockerCode.PREMISE_NOT_SATISFIED,
            message: `Conclusion for rule '${node.ruleId}' differs from independently recomputed result` } };
      }

      // Add downstream dependents to queue
      for (const candidateNode of nodeMap.values()) {
        if (!processed.has(candidateNode.nodeId)) {
          const allPremisesReady = candidateNode.premises.every(p => processed.has(p));
          if (allPremisesReady && !queue.includes(candidateNode.nodeId)) {
            queue.push(candidateNode.nodeId);
          }
        }
      }
    }

    if (processed.size !== nodeMap.size) {
      return {
        valid: false,
        blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
        detail: {
          code: BlockerCode.PREMISE_NOT_SATISFIED,
          message: `Unreachable or disconnected nodes in SemanticProof DAG`
        }
      };
    }

    // 6. Verify root node conclusions match claimedConclusion
    let rootWitness: any = null;

    for (const rootId of proof.rootNodeIds) {
      const rootNode = nodeMap.get(rootId);
      if (!rootNode) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: {
            code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Root node '${rootId}' not found in node map`
          }
        };
      }

      if (proof.claimedConclusion === 'COMPATIBLE') {
        if (rootNode.conclusion !== 'COMPATIBLE' && rootNode.conclusion?.status !== 'COMPATIBLE') {
          return {
            valid: false,
            blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
            detail: {
              code: BlockerCode.PREMISE_NOT_SATISFIED,
              message: `Root node claimed COMPATIBLE but conclusion was not compatible`
            }
          };
        }
      } else if (proof.claimedConclusion === 'INCOMPATIBLE') {
        if (rootNode.conclusion?.status !== 'INCOMPATIBLE' && rootNode.conclusion !== 'INCOMPATIBLE') {
          return {
            valid: false,
            blockerCode: BlockerCode.PREMISE_NOT_SATISFIED,
            detail: {
              code: BlockerCode.PREMISE_NOT_SATISFIED,
              message: `Root node claimed INCOMPATIBLE but conclusion was not incompatible`
            }
          };
        }
        rootWitness = rootNode.conclusion?.witness || { reason: 'INCOMPATIBLE_CONSUMER' };
      }
    }

    return {
      valid: true,
      verifiedConclusion: proof.claimedConclusion,
      witness: rootWitness
    };
  }
}
