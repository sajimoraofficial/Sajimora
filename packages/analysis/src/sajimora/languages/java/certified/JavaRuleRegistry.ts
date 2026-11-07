/**
 * @file JavaRuleRegistry.ts
 * Closed rule registry for JavaRuleSetId.JAVA_F0_RULES_V1.
 * Defines deterministic premise checking and independent conclusion recomputation
 * for Java nominal type semantics.
 *
 * Strict boundary:
 *   - Language-specific to Java nominal typing.
 *   - No structural typing rules.
 *   - Zero trust: conclusions are recomputed from first principles.
 */

import { JavaRuleSetId } from './JavaCertifiedProfile';

export interface JavaRuleConclusion {
  readonly kind: string;
  readonly compatible: boolean;
  readonly sourceFqcn?: string;
  readonly targetFqcn?: string;
  readonly memberName?: string;
  readonly detail?: string;
  readonly [key: string]: any;
}

export interface JavaProofNode {
  readonly nodeId: string;
  readonly ruleId: string;
  readonly premises: readonly string[];
  readonly conclusion: JavaRuleConclusion;
}

export interface JavaRuleValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly computedConclusion?: JavaRuleConclusion;
}

export type JavaRuleEvaluator = (
  node: JavaProofNode,
  premiseNodes: Map<string, JavaProofNode>
) => JavaRuleValidationResult;

const PRIMITIVE_WIDENING_LATTICE: Record<string, readonly string[]> = {
  byte: ['byte', 'short', 'int', 'long', 'float', 'double'],
  short: ['short', 'int', 'long', 'float', 'double'],
  char: ['char', 'int', 'long', 'float', 'double'],
  int: ['int', 'long', 'float', 'double'],
  long: ['long', 'float', 'double'],
  float: ['float', 'double'],
  double: ['double'],
  boolean: ['boolean'],
  void: ['void']
};

export const VISIBILITY_LEVELS: Record<string, number> = {
  PRIVATE: 0,
  PACKAGE: 1,
  PACKAGE_PRIVATE: 1,
  'PACKAGE-PRIVATE': 1,
  PROTECTED: 2,
  PUBLIC: 3
};

export class JavaRuleRegistry {
  public static readonly ruleSetId = JavaRuleSetId.JAVA_F0_RULES_V1;

  private static readonly evaluators = new Map<string, JavaRuleEvaluator>([
    // 1. Exact nominal identity: T1 == T2 iff fqcn1 == fqcn2
    [
      'JAVA.F0.NOMINAL.EQUAL',
      (node) => {
        const { sourceFqcn, targetFqcn, compatible } = node.conclusion;
        if (!sourceFqcn || !targetFqcn || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.NOMINAL.EQUAL requires { sourceFqcn, targetFqcn, compatible }'
          };
        }
        const isEqual = sourceFqcn === targetFqcn;
        if (isEqual !== compatible) {
          return {
            valid: false,
            reason: `JAVA.F0.NOMINAL.EQUAL recomputed equality (${isEqual}) does not match claimed (${compatible})`
          };
        }
        return {
          valid: true,
          computedConclusion: {
            kind: 'NOMINAL_EQUAL',
            sourceFqcn,
            targetFqcn,
            compatible: isEqual,
            ...(node.conclusion.memberName !== undefined ? { memberName: node.conclusion.memberName } : {}),
            ...(node.conclusion.detail !== undefined ? { detail: node.conclusion.detail } : {})
          }
        };
      }
    ],

    // 2. Primitive widening: byte -> int, char -> int, etc.
    [
      'JAVA.F0.NOMINAL.PRIMITIVE_WIDENING',
      (node) => {
        const { fromPrimitive, toPrimitive, compatible } = node.conclusion;
        if (!fromPrimitive || !toPrimitive || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.NOMINAL.PRIMITIVE_WIDENING requires { fromPrimitive, toPrimitive, compatible }'
          };
        }
        const allowedTargets = PRIMITIVE_WIDENING_LATTICE[fromPrimitive] ?? [];
        const isWidening = allowedTargets.includes(toPrimitive);
        if (isWidening !== compatible) {
          return {
            valid: false,
            reason: `JAVA.F0.NOMINAL.PRIMITIVE_WIDENING recomputed widening (${isWidening}) does not match claimed (${compatible})`
          };
        }
        return {
          valid: true,
          computedConclusion: {
            kind: 'PRIMITIVE_WIDENING',
            fromPrimitive,
            toPrimitive,
            compatible: isWidening
          }
        };
      }
    ],

    // 3. Direct Subtype: C extends SuperC or C implements Interf
    [
      'JAVA.F0.NOMINAL.SUBTYPE',
      (node) => {
        const { subFqcn, superFqcn, compatible } = node.conclusion;
        if (!subFqcn || !superFqcn || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.NOMINAL.SUBTYPE requires { subFqcn, superFqcn, compatible }'
          };
        }
        return {
          valid: false,
          reason: 'Direct subtyping requires a source-verified inheritance edge; producer assertions are not premises.'
        };
      }
    ],

    // 4. Transitive Subtyping: A extends B and B extends C => A extends C
    [
      'JAVA.F0.REL.EXTENDS_TRANSITIVE',
      (node, premises) => {
        if (node.premises.length !== 2) {
          return {
            valid: false,
            reason: 'JAVA.F0.REL.EXTENDS_TRANSITIVE requires exactly 2 premises [A extends B, B extends C]'
          };
        }
        const p1 = premises.get(node.premises[0]);
        const p2 = premises.get(node.premises[1]);
        if (!p1 || !p2) {
          return {
            valid: false,
            reason: `Missing premise for JAVA.F0.REL.EXTENDS_TRANSITIVE: [${node.premises.join(', ')}]`
          };
        }
        const { subFqcn: a, superFqcn: b } = p1.conclusion;
        const { subFqcn: b2, superFqcn: c } = p2.conclusion;
        if (b !== b2) {
          return {
            valid: false,
            reason: `Transitive chain broken: premise 1 superFqcn (${b}) !== premise 2 subFqcn (${b2})`
          };
        }
        const { subFqcn, superFqcn, compatible } = node.conclusion;
        if (subFqcn !== a || superFqcn !== c) {
          return {
            valid: false,
            reason: `Claimed conclusion ${subFqcn} extends ${superFqcn} does not match derived ${a} extends ${c}`
          };
        }
        const transCompatible = Boolean(p1.conclusion.compatible && p2.conclusion.compatible);
        if (transCompatible !== compatible) {
          return {
            valid: false,
            reason: `Claimed compatibility ${compatible} does not match derived ${transCompatible}`
          };
        }
        return {
          valid: true,
          computedConclusion: {
            kind: 'NOMINAL_SUBTYPE',
            subFqcn: a,
            superFqcn: c,
            compatible: transCompatible
          }
        };
      }
    ],

    // 5. Method signature preservation
    [
      'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
      (node, premises) => {
        const {
          methodName,
          historicalVisibility,
          candidateVisibility,
          parameterCount,
          compatible
        } = node.conclusion;

        if (!methodName || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED requires methodName and compatible'
          };
        }

        // Check visibility non-narrowing
        const histVisScore = VISIBILITY_LEVELS[historicalVisibility ?? 'PUBLIC'] ?? 0;
        const candVisScore = VISIBILITY_LEVELS[candidateVisibility ?? 'PUBLIC'] ?? 0;
        if (candVisScore < histVisScore) {
          if (compatible) {
            return {
              valid: false,
              reason: `Visibility narrowing from ${historicalVisibility} to ${candidateVisibility} cannot be COMPATIBLE`
            };
          }
          return {
            valid: true,
            computedConclusion: {
              kind: 'METHOD_SIGNATURE_PRESERVED',
              methodName,
              compatible: false,
              detail: `Visibility narrowed from ${historicalVisibility} to ${candidateVisibility}`
            }
          };
        }

        // Check premises (param checks and return type check)
        let allPremisesValid = true;
        for (const premiseId of node.premises) {
          const prem = premises.get(premiseId);
          if (!prem || !prem.conclusion.compatible) {
            allPremisesValid = false;
            break;
          }
        }

        const histParamCount = node.conclusion.historicalParameterCount ?? node.conclusion.parameterCount;
        const candParamCount = node.conclusion.candidateParameterCount ?? node.conclusion.parameterCount;
        const paramCountMatch = histParamCount === candParamCount;

        const derivedCompatible = allPremisesValid && candVisScore >= histVisScore && paramCountMatch;
        if (derivedCompatible !== compatible) {
          return {
            valid: false,
            reason: `Recomputed method compatibility (${derivedCompatible}) does not match claimed (${compatible})`
          };
        }

        return {
          valid: true,
          computedConclusion: {
            kind: 'METHOD_SIGNATURE_PRESERVED',
            methodName,
            historicalVisibility,
            candidateVisibility,
            parameterCount,
            compatible: derivedCompatible
          }
        };
      }
    ],

    // 6. Field signature preservation
    [
      'JAVA.F0.FIELD.SIGNATURE_PRESERVED',
      (node, premises) => {
        const {
          fieldName,
          historicalVisibility,
          candidateVisibility,
          historicalFinal,
          candidateFinal,
          compatible
        } = node.conclusion;

        if (!fieldName || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.FIELD.SIGNATURE_PRESERVED requires fieldName and compatible'
          };
        }

        const histVisScore = VISIBILITY_LEVELS[historicalVisibility ?? 'PUBLIC'] ?? 0;
        const candVisScore = VISIBILITY_LEVELS[candidateVisibility ?? 'PUBLIC'] ?? 0;
        if (candVisScore < histVisScore) {
          if (compatible) {
            return {
              valid: false,
              reason: `Field visibility narrowed from ${historicalVisibility} to ${candidateVisibility}`
            };
          }
          return {
            valid: true,
            computedConclusion: {
              kind: 'FIELD_SIGNATURE_PRESERVED',
              fieldName,
              compatible: false,
              detail: 'Field visibility narrowed'
            }
          };
        }

        // Mutability invariant: non-final cannot become final
        if (!historicalFinal && candidateFinal) {
          if (compatible) {
            return {
              valid: false,
              reason: `Field became final (mutability restriction)`
            };
          }
          return {
            valid: true,
            computedConclusion: {
              kind: 'FIELD_SIGNATURE_PRESERVED',
              fieldName,
              compatible: false,
              detail: 'Field mutated from non-final to final'
            }
          };
        }

        // Type premise check
        let typePremiseSatisfied = node.premises.length === 0;
        for (const pId of node.premises) {
          const prem = premises.get(pId);
          if (prem && prem.conclusion.compatible) {
            typePremiseSatisfied = true;
          } else {
            typePremiseSatisfied = false;
            break;
          }
        }

        const derivedCompatible = typePremiseSatisfied && candVisScore >= histVisScore;
        if (derivedCompatible !== compatible) {
          return {
            valid: false,
            reason: `Recomputed field compatibility (${derivedCompatible}) does not match claimed (${compatible})`
          };
        }

        return {
          valid: true,
          computedConclusion: {
            kind: 'FIELD_SIGNATURE_PRESERVED',
            fieldName,
            compatible: derivedCompatible
          }
        };
      }
    ],

    // 7. Class visibility preservation
    [
      'JAVA.F0.CLASS.VISIBILITY_PRESERVED',
      (node) => {
        const { className, historicalVisibility, candidateVisibility, compatible } = node.conclusion;
        if (!className || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.CLASS.VISIBILITY_PRESERVED requires className and compatible'
          };
        }
        const histScore = VISIBILITY_LEVELS[historicalVisibility ?? 'PUBLIC'] ?? 0;
        const candScore = VISIBILITY_LEVELS[candidateVisibility ?? 'PUBLIC'] ?? 0;
        const isPreserved = candScore >= histScore;
        if (isPreserved !== compatible) {
          return {
            valid: false,
            reason: `Class visibility recomputed (${isPreserved}) does not match claimed (${compatible})`
          };
        }
        return {
          valid: true,
          computedConclusion: {
            kind: 'CLASS_VISIBILITY_PRESERVED',
            className,
            historicalVisibility,
            candidateVisibility,
            compatible: isPreserved
          }
        };
      }
    ],

    // 8. Interface Implementation Satisfaction
    [
      'JAVA.F0.INTERFACE.METHOD_IMPLEMENTED',
      (node, premises) => {
        const { interfaceFqcn, classFqcn, methodName, compatible } = node.conclusion;
        if (!interfaceFqcn || !classFqcn || !methodName || typeof compatible !== 'boolean') {
          return {
            valid: false,
            reason: 'JAVA.F0.INTERFACE.METHOD_IMPLEMENTED requires { interfaceFqcn, classFqcn, methodName, compatible }'
          };
        }
        // Must have premise demonstrating method presence and compatibility in class
        let hasMethodPremise = false;
        for (const pId of node.premises) {
          const prem = premises.get(pId);
          if (prem && prem.conclusion.kind === 'METHOD_SIGNATURE_PRESERVED' && prem.conclusion.compatible) {
            hasMethodPremise = true;
            break;
          }
        }
        if (hasMethodPremise !== compatible) {
          return {
            valid: false,
            reason: `Interface method implementation satisfaction (${hasMethodPremise}) !== claimed (${compatible})`
          };
        }
        return {
          valid: true,
          computedConclusion: {
            kind: 'INTERFACE_METHOD_IMPLEMENTED',
            interfaceFqcn,
            classFqcn,
            methodName,
            compatible: hasMethodPremise
          }
        };
      }
    ]
  ]);

  public static isRuleRegistered(ruleId: string): boolean {
    return this.evaluators.has(ruleId);
  }

  public static evaluate(
    node: JavaProofNode,
    premiseNodes: Map<string, JavaProofNode>
  ): JavaRuleValidationResult {
    const evaluator = this.evaluators.get(node.ruleId);
    if (!evaluator) {
      return {
        valid: false,
        reason: `Rule '${node.ruleId}' is not registered in closed ruleset '${this.ruleSetId}'`
      };
    }
    return evaluator(node, premiseNodes);
  }

  public static registeredRules(): readonly string[] {
    return Array.from(this.evaluators.keys());
  }
}
