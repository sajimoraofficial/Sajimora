/**
 * @file JavaF1ProofChecker.ts
 * Zero-trust proof verifier for JAVA_F1_RULES_V1 and the F1 compiler profile per Phase J-11.
 *
 * Enforces the core architectural safety guarantee:
 * - F1 Monotonicity Invariant: F1 must be strictly monotonic with respect to F0 safety.
 *   F1 may convert an F0 INCONCLUSIVE result into a certified verdict only when additional
 *   compiler evidence establishes the required proof obligations; F1 must never override,
 *   weaken, or reinterpret an existing F0 contradiction.
 */

import * as crypto from 'node:crypto';
import { canonicalJson } from '@sajimora/core';
import {
  JAVA_CERTIFIED_EVIDENCE_V1,
  JavaRuleSetId,
  JavaSemanticProfileId
} from './JavaCertifiedProfile';
import {
  JavaProofNode,
  JavaRuleConclusion
} from './JavaRuleRegistry';
import {
  JavaProofChecker,
  JavaProofBudget,
  JavaProofVerificationResult,
  JavaSemanticObligation,
  JavaSemanticProof,
  computeJavaObligationDigest
} from './JavaProofChecker';
import {
  JavaHeadlessCompiler,
  JavaF1CompilerEvidence
} from './JavaHeadlessCompiler';

export interface JavaF1SemanticProof extends JavaSemanticProof {
  readonly profileId?: JavaSemanticProfileId.JAVA_COMPILER_BACKED_F1;
  readonly compilerEvidence?: readonly JavaF1CompilerEvidence[];
  readonly f0BaselineProof?: JavaSemanticProof;
}

export interface JavaF1VerificationResult extends JavaProofVerificationResult {
  readonly f0MonotonicityPreserved: boolean;
  readonly f1CapabilitiesVerified: readonly string[];
}

export class JavaF1ProofChecker {
  /**
   * Closed evaluators for JAVA_F1_RULES_V1.
   */
  private static readonly F1_RULE_EVALUATORS = new Map<string, (node: JavaProofNode, evidenceMap: Map<string, JavaF1CompilerEvidence>) => { valid: boolean; reason?: string; computedCompatible?: boolean }>([
    // 1. Generic Wildcard Capture Conversion Rule
    [
      'JAVA.F1.GENERIC.CAPTURE_CONVERSION',
      (node, evidenceMap) => {
        const { subType, superType, compatible, evidenceId } = node.conclusion;
        if (!subType || !superType || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'JAVA.F1.GENERIC.CAPTURE_CONVERSION requires { subType, superType, compatible }' };
        }
        if (!evidenceId || !evidenceMap.has(evidenceId)) {
          return { valid: false, reason: `Missing compiler evidence '${evidenceId}' for generic capture conversion` };
        }
        const ev = evidenceMap.get(evidenceId)!;
        if (ev.capabilityId !== 'GENERIC_CAPTURE_CONVERSION') {
          return { valid: false, reason: `Evidence '${evidenceId}' capability mismatch: expected GENERIC_CAPTURE_CONVERSION` };
        }
        const derived = JavaHeadlessCompiler.deriveGenericWildcardSubtype(subType, superType);
        if (derived.isSubtype !== compatible) {
          return {
            valid: false,
            reason: `Recomputed capture conversion subtyping (${derived.isSubtype}) does not match claimed (${compatible})`
          };
        }
        return { valid: true, computedCompatible: derived.isSubtype };
      }
    ],

    // 2. Most Specific Method Overload Disambiguation Rule
    [
      'JAVA.F1.METHOD.MOST_SPECIFIC_OVERLOAD',
      (node, evidenceMap) => {
        const { methodName, argumentTypes, selectedSignature, compatible, evidenceId } = node.conclusion;
        if (!methodName || !argumentTypes || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'JAVA.F1.METHOD.MOST_SPECIFIC_OVERLOAD requires { methodName, argumentTypes, compatible }' };
        }
        if (!evidenceId || !evidenceMap.has(evidenceId)) {
          return { valid: false, reason: `Missing compiler evidence '${evidenceId}' for overload disambiguation` };
        }
        const ev = evidenceMap.get(evidenceId)!;
        if (ev.capabilityId !== 'METHOD_OVERLOAD_DISAMBIGUATION') {
          return { valid: false, reason: `Evidence '${evidenceId}' capability mismatch: expected METHOD_OVERLOAD_DISAMBIGUATION` };
        }
        const candidateMethods = ev.details.candidateMethods ?? [];
        const res = JavaHeadlessCompiler.resolveMostSpecificOverload(methodName, argumentTypes, candidateMethods);
        const isResolved = res.status === 'RESOLVED';
        if (isResolved !== compatible) {
          return {
            valid: false,
            reason: `Recomputed overload resolution (${isResolved}) does not match claimed (${compatible})`
          };
        }
        return { valid: true, computedCompatible: isResolved };
      }
    ],

    // 3. Sealed Classpath Wildcard Resolution Rule
    [
      'JAVA.F1.CLASSPATH.SEALED_WILDCARD_RESOLVED',
      (node, evidenceMap) => {
        const { wildcardPackages, simpleName, resolvedFqcn, compatible, evidenceId } = node.conclusion;
        if (!wildcardPackages || !simpleName || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'JAVA.F1.CLASSPATH.SEALED_WILDCARD_RESOLVED requires { wildcardPackages, simpleName, compatible }' };
        }
        if (!evidenceId || !evidenceMap.has(evidenceId)) {
          return { valid: false, reason: `Missing compiler evidence '${evidenceId}' for sealed wildcard resolution` };
        }
        const ev = evidenceMap.get(evidenceId)!;
        if (ev.capabilityId !== 'SEALED_WILDCARD_RESOLUTION') {
          return { valid: false, reason: `Evidence '${evidenceId}' capability mismatch: expected SEALED_WILDCARD_RESOLUTION` };
        }
        const extraClasses = ev.details.extraSealedClasses ?? [];
        const res = JavaHeadlessCompiler.resolveSealedWildcard(wildcardPackages, simpleName, extraClasses);
        const isResolved = res.status === 'RESOLVED';
        if (isResolved !== compatible) {
          return {
            valid: false,
            reason: `Recomputed wildcard resolution status (${isResolved}) does not match claimed (${compatible})`
          };
        }
        if (isResolved && resolvedFqcn && res.fqcn !== resolvedFqcn) {
          return {
            valid: false,
            reason: `Resolved FQCN '${res.fqcn}' does not match claimed '${resolvedFqcn}'`
          };
        }
        return { valid: true, computedCompatible: isResolved };
      }
    ]
  ]);

  /**
   * Verifies an F1 compiler-backed proof DAG and validates F0 monotonicity.
   */
  public static verifyF1Proof(
    obligation: JavaSemanticObligation,
    f1Proof: JavaF1SemanticProof,
    budget?: JavaProofBudget
  ): JavaF1VerificationResult {
    // 1. Verify F0 Monotonicity Guarantee
    if (f1Proof.f0BaselineProof) {
      // Re-verify the historical F0 baseline proof to ensure baseline validity
      const f0Verif = JavaProofChecker.verify(obligation, f1Proof.f0BaselineProof, budget);

      if (!f0Verif.valid) {
        return { ...f0Verif, f0MonotonicityPreserved: false, f1CapabilitiesVerified: [] };
      }

      if (f0Verif.valid && f0Verif.verifiedConclusion === 'INCOMPATIBLE') {
        // Strict Monotonicity Invariant: F1 cannot overturn an F0 contradiction!
        if (f1Proof.claimedConclusion === 'COMPATIBLE') {
          return {
            valid: false,
            blockerCode: 'CONCLUSION_MISMATCH',
            reason: 'F1 Monotonicity Violation: F1 attempted to overturn an existing F0 INCOMPATIBLE proof to COMPATIBLE.',
            f0MonotonicityPreserved: false,
            f1CapabilitiesVerified: []
          };
        }
      }
    }

    // 2. Validate Proof Structure & Ruleset
    if (f1Proof.ruleSetId !== JavaRuleSetId.JAVA_F1_RULES_V1 && f1Proof.ruleSetId !== JavaRuleSetId.JAVA_F0_RULES_V1) {
      return {
        valid: false,
        blockerCode: 'INVALID_RULESET',
        reason: `Proof ruleset '${f1Proof.ruleSetId}' is not valid for F1 verification.`,
        f0MonotonicityPreserved: true,
        f1CapabilitiesVerified: []
      };
    }

    // 3. Digest check
    const expectedDigest = computeJavaObligationDigest(obligation);
    if (f1Proof.obligationDigest !== expectedDigest) {
      return {
        valid: false,
        blockerCode: 'HASH_MISMATCH',
        reason: `Proof obligation digest mismatch: expected '${expectedDigest}', got '${f1Proof.obligationDigest}'`,
        f0MonotonicityPreserved: true,
        f1CapabilitiesVerified: []
      };
    }

    // 4. Index Compiler Evidence
    const evidenceMap = new Map<string, JavaF1CompilerEvidence>();
    if (f1Proof.compilerEvidence) {
      for (const ev of f1Proof.compilerEvidence) {
        // Validate evidence fingerprint integrity
        const payload = {
          capabilityId: ev.capabilityId,
          conclusion: ev.conclusion,
          verified: ev.verified,
          details: ev.details,
          compilerVersion: ev.compilerVersion
        };
        const computedFp = crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
        if (computedFp !== ev.inputFingerprint) {
          return {
            valid: false,
            blockerCode: 'HASH_MISMATCH',
            reason: `Compiler evidence '${ev.evidenceId}' has tampered fingerprint!`,
            f0MonotonicityPreserved: true,
            f1CapabilitiesVerified: []
          };
        }
        evidenceMap.set(ev.evidenceId, ev);
      }
    }

    // 5. Node Validation
    const verifiedCapabilities: string[] = [];
    let rootCompatible = true;

    for (const node of f1Proof.nodes) {
      if (this.F1_RULE_EVALUATORS.has(node.ruleId)) {
        const evaluator = this.F1_RULE_EVALUATORS.get(node.ruleId)!;
        const evalRes = evaluator(node, evidenceMap);
        if (!evalRes.valid) {
          return {
            valid: false,
            blockerCode: 'INVALID_RULE_APPLICATION',
            reason: evalRes.reason,
            f0MonotonicityPreserved: true,
            f1CapabilitiesVerified: []
          };
        }
        verifiedCapabilities.push(node.ruleId);
        if (f1Proof.rootNodeIds.includes(node.nodeId) && evalRes.computedCompatible === false) {
          rootCompatible = false;
        }
      }
    }

    const verifiedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' = rootCompatible ? 'COMPATIBLE' : 'INCOMPATIBLE';
    if (verifiedConclusion !== f1Proof.claimedConclusion) {
      return {
        valid: false,
        blockerCode: 'ROOT_CONCLUSION_MISMATCH',
        reason: `Root conclusion mismatch: verified ${verifiedConclusion} !== claimed ${f1Proof.claimedConclusion}`,
        f0MonotonicityPreserved: true,
        f1CapabilitiesVerified: []
      };
    }

    // Recomputed hashes and compiler-like helper outputs are not sealed
    // compiler executions or source-bound proofs. F1 cannot bypass the V1
    // source-evidence quarantine (including empty and unknown-rule DAGs).
    return {
      valid: false,
      blockerCode: 'SOURCE_EVIDENCE_UNVERIFIED',
      reason: 'Legacy F1 evidence is not independently bound to source and the exact obligation.',
      validatedNodeCount: f1Proof.nodes.length,
      f0MonotonicityPreserved: true,
      f1CapabilitiesVerified: []
    };
  }
}
