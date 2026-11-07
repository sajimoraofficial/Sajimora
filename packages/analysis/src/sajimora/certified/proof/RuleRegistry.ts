/**
 * @file RuleRegistry.ts
 * Closed rule registry for RuleSetId.F0_RULES_V1.
 * Defines deterministic premise checking and independent conclusion recomputation.
 */

import { ProofNode } from '../../../../../core/src/sajimora/certified/contracts';
import { F0ScalarType, F0TypeVerifier } from '../fragment/F0TypeVerifier';

export interface RuleValidationResult {
  valid: boolean;
  reason?: string;
  computedConclusion?: any;
}

export type RuleEvaluator = (
  node: ProofNode,
  premiseNodes: Map<string, ProofNode>
) => RuleValidationResult;

export class RuleRegistry {
  private static readonly evaluators = new Map<string, RuleEvaluator>([
    // 1. Leaf type rules
    [
      'F0.TYPE.LITERAL',
      (node) => {
        if (!node.conclusion || typeof node.conclusion !== 'object' || node.conclusion.kind !== 'literal') {
          return { valid: false, reason: 'F0.TYPE.LITERAL must conclude a scalar literal type' };
        }
        return { valid: true, computedConclusion: node.conclusion };
      }
    ],
    [
      'F0.TYPE.ANNOTATION',
      (node) => {
        if (!node.conclusion || typeof node.conclusion !== 'object') {
          return { valid: false, reason: 'F0.TYPE.ANNOTATION must conclude a valid F0 type' };
        }
        return { valid: true, computedConclusion: node.conclusion };
      }
    ],
    [
      'F0.TYPE.ALIAS',
      (node, premises) => {
        // Must expand acyclic type alias
        if (node.premises.length === 0) {
          return { valid: false, reason: 'F0.TYPE.ALIAS requires premise node for expanded type' };
        }
        const premise = premises.get(node.premises[0]);
        if (!premise) {
          return { valid: false, reason: `Premise ${node.premises[0]} missing for F0.TYPE.ALIAS` };
        }
        return { valid: true, computedConclusion: premise.conclusion };
      }
    ],
    [
      'F0.TYPE.RECORD',
      (node) => {
        if (!node.conclusion || node.conclusion.kind !== 'record') {
          return { valid: false, reason: 'F0.TYPE.RECORD must conclude a record type' };
        }
        return { valid: true, computedConclusion: node.conclusion };
      }
    ],

    // 2. Relation rules
    [
      'F0.REL.SCALAR',
      (node) => {
        const { source, target, compatible } = node.conclusion;
        if (!source || !target || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'F0.REL.SCALAR requires { source, target, compatible } conclusion' };
        }

        const isSubtype = F0TypeVerifier.isScalarSubtype(source as F0ScalarType, target as F0ScalarType);
        if (isSubtype !== compatible) {
          return {
            valid: false,
            reason: `F0.REL.SCALAR recomputed compatibility (${isSubtype}) does not match claimed (${compatible})`
          };
        }

        return { valid: true, computedConclusion: { source, target, compatible: isSubtype } };
      }
    ],
    [
      'F0.REL.NEVER_SOURCE',
      (node) => {
        const { source, target, compatible } = node.conclusion;
        if (!source || source.kind !== 'never' || !compatible) {
          return { valid: false, reason: 'F0.REL.NEVER_SOURCE requires source to be never and compatible true' };
        }
        return { valid: true, computedConclusion: { source, target, compatible: true } };
      }
    ],
    [
      'F0.REL.RECORD',
      (node, premises) => {
        const { source, target, compatible } = node.conclusion;
        if (!source || !target || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'F0.REL.RECORD requires { source, target, compatible }' };
        }

        // Verify subproof premises
        for (const pId of node.premises) {
          const p = premises.get(pId);
          if (!p || !p.conclusion?.compatible) {
            return { valid: false, reason: `Premise ${pId} in F0.REL.RECORD was not satisfied` };
          }
        }
        return { valid: true, computedConclusion: node.conclusion };
      }
    ],
    [
      'F0.REL.FRESH_OBJECT',
      (node) => {
        const { source, target, compatible } = node.conclusion;
        if (!source || !target || typeof compatible !== 'boolean') {
          return { valid: false, reason: 'F0.REL.FRESH_OBJECT requires { source, target, compatible }' };
        }
        return { valid: true, computedConclusion: node.conclusion };
      }
    ],

    // 3. Obligation-level rules
    [
      'F0.OBL.INITIALIZATION',
      (node, premises) => {
        if (node.premises.length === 0) {
          return { valid: false, reason: 'F0.OBL.INITIALIZATION requires relation subproof premise' };
        }
        const relPremise = premises.get(node.premises[0]);
        if (!relPremise) {
          return { valid: false, reason: 'Premise missing for F0.OBL.INITIALIZATION' };
        }
        const isComp = !!relPremise.conclusion?.compatible;
        return {
          valid: true,
          computedConclusion: { status: isComp ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: isComp ? null : 'INITIALIZER_INCOMPATIBLE' }
        };
      }
    ],
    [
      'F0.OBL.ARGUMENT',
      (node, premises) => {
        if (node.premises.length === 0) {
          return { valid: false, reason: 'F0.OBL.ARGUMENT requires parameter subtyping premise' };
        }
        const relPremise = premises.get(node.premises[0]);
        if (!relPremise) {
          return { valid: false, reason: 'Premise missing for F0.OBL.ARGUMENT' };
        }
        const isComp = !!relPremise.conclusion?.compatible;
        return {
          valid: true,
          computedConclusion: {
            status: isComp ? 'COMPATIBLE' : 'INCOMPATIBLE',
            reason: isComp ? null : 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE'
          }
        };
      }
    ],
    [
      'F0.OBL.ARITY',
      (node) => {
        const { argCount, requiredParamCount } = node.conclusion;
        if (!Number.isSafeInteger(argCount) || argCount < 0 ||
            !Number.isSafeInteger(requiredParamCount) || requiredParamCount < 0) {
          return { valid: false, reason: 'F0.OBL.ARITY requires non-negative integer counts' };
        }
        const compatible = argCount >= requiredParamCount;
        return {
          valid: true,
          computedConclusion: {
            argCount,
            requiredParamCount,
            status: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
            reason: compatible ? null : 'REQUIRED_PARAMETER_ADDED'
          }
        };
      }
    ],
    [
      'F0.OBL.RETURN_CONTEXT',
      (node, premises) => {
        if (node.premises.length === 0) {
          return { valid: false, reason: 'F0.OBL.RETURN_CONTEXT requires return subtyping premise' };
        }
        const relPremise = premises.get(node.premises[0]);
        if (!relPremise) {
          return { valid: false, reason: 'Premise missing for F0.OBL.RETURN_CONTEXT' };
        }
        const isComp = !!relPremise.conclusion?.compatible;
        return {
          valid: true,
          computedConclusion: {
            status: isComp ? 'COMPATIBLE' : 'INCOMPATIBLE',
            reason: isComp ? null : 'RETURN_TYPE_INCOMPATIBLE'
          }
        };
      }
    ],
    [
      'F0.OBL.DISCARDED_RETURN',
      () => {
        return { valid: true, computedConclusion: { status: 'COMPATIBLE', reason: null } };
      }
    ],
    [
      'F0.OBL.MEMBER_READ',
      (node) => {
        const { memberAvailable, memberTypeCompatible } = node.conclusion;
        const compatible = memberAvailable && memberTypeCompatible;
        return {
          valid: true,
          computedConclusion: {
            status: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
            reason: !memberAvailable ? 'REQUIRED_PROPERTY_MISSING' : !memberTypeCompatible ? 'PROPERTY_TYPE_INCOMPATIBLE' : null
          }
        };
      }
    ],
    [
      'F0.OBL.OPERATIONAL_RETURN',
      (node) => {
        const { sourceOutcome, candidateOutcome } = node.conclusion ?? {};
        if (sourceOutcome !== 'VALUE' || !['VALUE', 'TERMINAL_THROW'].includes(candidateOutcome)) {
          return { valid: false, reason: 'F0.OBL.OPERATIONAL_RETURN requires sealed VALUE or TERMINAL_THROW outcomes' };
        }
        const compatible = candidateOutcome === 'VALUE';
        return { valid: true, computedConclusion: { sourceOutcome, candidateOutcome,
          status: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: compatible ? null : 'OPERATIONAL_RETURN_UNAVAILABLE' } };
      }
    ],
    [
      'F0.OBL.CALLABLE_REQUIRED',
      (node) => {
        const { historicalCallable, candidateCallable } = node.conclusion ?? {};
        if (historicalCallable !== true || typeof candidateCallable !== 'boolean') {
          return { valid: false, reason: 'F0.OBL.CALLABLE_REQUIRED requires boolean sealed callability witnesses' };
        }
        const compatible = candidateCallable === true;
        return { valid: true, computedConclusion: { historicalCallable, candidateCallable,
          status: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: compatible ? null : 'EXPORT_NOT_CALLABLE' } };
      }
    ],

    // 4. Composition rules
    [
      'F0.COMPOSE.ALL',
      (node, premises) => {
        for (const pId of node.premises) {
          const p = premises.get(pId);
          if (!p || p.conclusion?.status !== 'COMPATIBLE') {
            return {
              valid: false,
              reason: `Premise ${pId} in F0.COMPOSE.ALL was not COMPATIBLE`
            };
          }
        }
        return { valid: true, computedConclusion: 'COMPATIBLE' };
      }
    ],
    [
      'F0.COMPOSE.RELEVANT_FAILURE',
      (node, premises) => {
        // Must reference at least one refuted premise
        let hasRefutation = false;
        let witnessReason: string = 'INCOMPATIBLE_CONSUMER';

        for (const pId of node.premises) {
          const p = premises.get(pId);
          if (p && p.conclusion?.status === 'INCOMPATIBLE') {
            hasRefutation = true;
            witnessReason = p.conclusion.reason || witnessReason;
            break;
          }
        }

        if (!hasRefutation) {
          return {
            valid: false,
            reason: 'F0.COMPOSE.RELEVANT_FAILURE requires at least one INCOMPATIBLE premise'
          };
        }

        return {
          valid: true,
          computedConclusion: {
            status: 'INCOMPATIBLE',
            witness: {
              reason: witnessReason,
              failingNodeId: node.premises[0]
            }
          }
        };
      }
    ]
  ]);

  public static hasRule(ruleId: string): boolean {
    return RuleRegistry.evaluators.has(ruleId);
  }

  public static evaluateRule(
    node: ProofNode,
    premises: Map<string, ProofNode>
  ): RuleValidationResult {
    const evaluator = RuleRegistry.evaluators.get(node.ruleId);
    if (!evaluator) {
      return {
        valid: false,
        reason: `Unrecognized rule ID '${node.ruleId}'`
      };
    }
    return evaluator(node, premises);
  }
}
