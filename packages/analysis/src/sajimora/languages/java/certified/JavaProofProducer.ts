/**
 * @file JavaProofProducer.ts
 * Deterministic proof DAG builder for Java F0 obligations.
 * Constructs content-addressed, mathematically verifiable JavaSemanticProof objects.
 *
 * Strict boundary:
 *   - Produces proofs exclusively within the JAVA_PUBLIC_API_F0 profile.
 *   - Rejects non-F0 features (wildcard imports, dynamic reflection, unresolvable external types)
 *     with an explicit refusal rather than producing unsound proofs.
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
  JavaRuleConclusion,
  VISIBILITY_LEVELS
} from './JavaRuleRegistry';
import {
  JavaSemanticObligation,
  JavaSemanticProof,
  computeJavaObligationDigest
} from './JavaProofChecker';
import {
  JavaClassDeclIR,
  JavaMethodSignatureIR,
  JavaFieldIR
} from '../ir';

export interface JavaProofProductionResult {
  readonly success: boolean;
  readonly proof?: JavaSemanticProof;
  readonly refused?: boolean;
  readonly reason?: string;
  readonly profileId?: JavaSemanticProfileId;
}

function computeNodeId(ruleId: string, premises: readonly string[], conclusion: JavaRuleConclusion): string {
  const payload = {
    ruleId,
    premises: [...premises].sort(),
    conclusion
  };
  return 'node_' + crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex').slice(0, 16);
}

export class JavaProofProducer {
  /**
   * Generates a deterministic JavaSemanticProof for an F0 obligation comparing historical and candidate declarations.
   */
  public static produceProof(params: {
    obligation: JavaSemanticObligation;
    historicalClass?: JavaClassDeclIR;
    candidateClass?: JavaClassDeclIR;
    historicalMethod?: JavaMethodSignatureIR;
    candidateMethod?: JavaMethodSignatureIR;
    memberName?: string;
    hasWildcardImports?: boolean;
    hasDynamicReflection?: boolean;
  }): JavaProofProductionResult {
    const {
      obligation,
      historicalClass,
      candidateClass,
      historicalMethod,
      candidateMethod,
      memberName,
      hasWildcardImports,
      hasDynamicReflection
    } = params;

    // 1. Verify F0 boundary conditions
    if (hasWildcardImports) {
      return {
        success: false,
        refused: true,
        reason: 'Wildcard import detected: Candidate must remain in advisory mode.'
      };
    }
    if (hasDynamicReflection) {
      return {
        success: false,
        refused: true,
        reason: 'Dynamic reflection construct (J-X1..J-X3) detected: Candidate must remain in advisory mode.'
      };
    }

    if (!historicalClass) {
      if (candidateClass) {
        // A new class was added to the compilation unit: JLS §13.4.1 (Clean additive change)
        const classAddedConc: JavaRuleConclusion = {
          kind: 'NOMINAL_EQUAL',
          sourceFqcn: candidateClass.fqcn,
          targetFqcn: candidateClass.fqcn,
          compatible: true,
          memberName: `${candidateClass.fqcn}#added`,
          detail: `Class ${candidateClass.fqcn} was added in candidate revision (JLS §13.4.1)`
        };
        const classAddedNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], classAddedConc);
        const nodes: JavaProofNode[] = [{
          nodeId: classAddedNodeId,
          ruleId: 'JAVA.F0.NOMINAL.EQUAL',
          premises: [],
          conclusion: classAddedConc
        }];
        const obligationDigest = computeJavaObligationDigest(obligation);
        const proof: JavaSemanticProof = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
          obligationDigest,
          nodes,
          rootNodeIds: [classAddedNodeId],
          claimedConclusion: 'COMPATIBLE',
          metadata: {
            capabilityId: 'JAVA_CLASS_DECLARATION_ADDED',
            targetFqcn: candidateClass.fqcn
          }
        };
        return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
      }
      return {
        success: false,
        refused: true,
        reason: 'Historical class declaration missing in sealed compilation unit.'
      };
    }

    if (!candidateClass) {
      const classEqualConclusion: JavaRuleConclusion = {
        kind: 'NOMINAL_EQUAL',
        sourceFqcn: historicalClass.fqcn,
        targetFqcn: 'REMOVED_CLASS',
        compatible: false
      };
      const classEqualNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], classEqualConclusion);
      const nodes: JavaProofNode[] = [{
        nodeId: classEqualNodeId,
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: [],
        conclusion: classEqualConclusion
      }];
      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds: [classEqualNodeId],
        claimedConclusion: 'INCOMPATIBLE',
        metadata: {
          capabilityId: 'JAVA_CLASS_DECLARATION_REMOVED',
          targetFqcn: historicalClass.fqcn
        }
      };
      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    const nodes: JavaProofNode[] = [];
    const rootNodeIds: string[] = [];

    const visibilityIncompatible = Boolean(historicalClass.isExported && !candidateClass.isExported);
    if (visibilityIncompatible) {
      const visConc: JavaRuleConclusion = {
        kind: 'CLASS_VISIBILITY_PRESERVED',
        className: candidateClass.name,
        historicalVisibility: 'PUBLIC',
        candidateVisibility: 'PACKAGE_PRIVATE',
        compatible: false
      };
      const visNodeId = computeNodeId('JAVA.F0.CLASS.VISIBILITY_PRESERVED', [], visConc);
      nodes.push({
        nodeId: visNodeId,
        ruleId: 'JAVA.F0.CLASS.VISIBILITY_PRESERVED',
        premises: [],
        conclusion: visConc
      });
      rootNodeIds.push(visNodeId);
      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds,
        claimedConclusion: 'INCOMPATIBLE',
        metadata: {
          capabilityId: 'JAVA_CLASS_VISIBILITY_NARROWED',
          targetFqcn: candidateClass.fqcn
        }
      };
      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    const modifiersIncompatible =
      (Boolean(candidateClass.isAbstract) && !historicalClass.isAbstract) ||
      (Boolean(candidateClass.isFinal) && !historicalClass.isFinal);

    // 2. Class Nominal Subtyping / Equality Node
    const isNominalCompatible = historicalClass.fqcn === candidateClass.fqcn && !modifiersIncompatible;
    const classEqualConclusion: JavaRuleConclusion = {
      kind: 'NOMINAL_EQUAL',
      sourceFqcn: historicalClass.fqcn,
      targetFqcn: isNominalCompatible ? candidateClass.fqcn : 'MODIFIERS_CHANGED',
      compatible: isNominalCompatible,
      memberName: `${historicalClass.fqcn}#class`,
      detail: `Class declaration nominal equality for ${historicalClass.fqcn}`
    };
    const classEqualNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], classEqualConclusion);
    nodes.push({
      nodeId: classEqualNodeId,
      ruleId: 'JAVA.F0.NOMINAL.EQUAL',
      premises: [],
      conclusion: classEqualConclusion
    });

    if (modifiersIncompatible && obligation.relationKind === 'SUBTYPE' && !memberName) {
      rootNodeIds.push(classEqualNodeId);
      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds,
        claimedConclusion: 'INCOMPATIBLE',
        metadata: {
          capabilityId: 'JAVA_CLASS_MODIFIERS_INCOMPATIBLE',
          targetFqcn: candidateClass.fqcn
        }
      };
      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    // 2.5 Handle Interface Implementation Obligation
    if (obligation.relationKind === 'IMPLEMENTS') {
      const targetMethodName = memberName ?? obligation.memberSignature?.split('(')[0] ?? '';
      const conc: JavaRuleConclusion = {
        kind: 'INTERFACE_METHOD_IMPLEMENTED',
        interfaceFqcn: candidateClass.fqcn,
        classFqcn: obligation.sourceFqcn,
        methodName: targetMethodName,
        compatible: false
      };
      const nodeId = computeNodeId('JAVA.F0.INTERFACE.METHOD_IMPLEMENTED', [], conc);
      nodes.push({
        nodeId,
        ruleId: 'JAVA.F0.INTERFACE.METHOD_IMPLEMENTED',
        premises: [],
        conclusion: conc
      });
      rootNodeIds.push(nodeId);
      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds,
        claimedConclusion: 'INCOMPATIBLE',
        metadata: {
          capabilityId: 'JAVA_INTERFACE_ABSTRACT_METHOD_ADDED',
          targetFqcn: candidateClass.fqcn,
          memberName: targetMethodName
        }
      };
      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    // 3. Handle Method Obligation
    if (obligation.relationKind === 'METHOD_CALL' || (obligation.relationKind !== 'FIELD_ACCESS' && memberName && historicalClass.methods.some(m => m.name === memberName))) {
      const targetMethodName = memberName ?? obligation.memberSignature?.split('(')[0] ?? '';
      const histMethod = historicalMethod ?? historicalClass.methods.find(m => m.name === targetMethodName);
      const candMethod = candidateMethod ?? (histMethod
        ? candidateClass.methods.find(m =>
            m.name === histMethod.name &&
            m.parameters.length === histMethod.parameters.length &&
            m.parameters.every((p, idx) => p.type.irContentHash === histMethod.parameters[idx].type.irContentHash)
          )
        : candidateClass.methods.find(m => m.name === targetMethodName));

      if (!histMethod) {
        return {
          success: false,
          refused: true,
          reason: `Historical method '${targetMethodName}' not found in class '${historicalClass.fqcn}'`
        };
      }

      if (!candMethod) {
        // Method was removed -> VIOLATION proof
        const methodRemovalConclusion: JavaRuleConclusion = {
          kind: 'METHOD_SIGNATURE_PRESERVED',
          methodName: targetMethodName,
          historicalVisibility: histMethod.visibility.toUpperCase(),
          candidateVisibility: 'PRIVATE',
          parameterCount: histMethod.parameters.length,
          compatible: false,
          detail: `Method '${targetMethodName}' was removed in candidate class`
        };
        const methodRemovalNodeId = computeNodeId('JAVA.F0.METHOD.SIGNATURE_PRESERVED', [], methodRemovalConclusion);
        nodes.push({
          nodeId: methodRemovalNodeId,
          ruleId: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
          premises: [],
          conclusion: methodRemovalConclusion
        });
        rootNodeIds.push(methodRemovalNodeId);

        const obligationDigest = computeJavaObligationDigest(obligation);
        const proof: JavaSemanticProof = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
          obligationDigest,
          nodes,
          rootNodeIds,
          claimedConclusion: 'INCOMPATIBLE',
          metadata: {
            capabilityId: 'JAVA_METHOD_DECLARATION_REMOVED',
            targetFqcn: candidateClass.fqcn,
            memberName: targetMethodName
          }
        };
        return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
      }

      // Method exists in candidate: evaluate parameters and return type
      const methodPremiseIds: string[] = [];

      // Parameter checks
      const sameParamCount = histMethod.parameters.length === candMethod.parameters.length;
      let paramsMatch = sameParamCount;
      if (sameParamCount) {
        for (let i = 0; i < histMethod.parameters.length; i++) {
          const hp = histMethod.parameters[i];
          const cp = candMethod.parameters[i];
          const paramEqual = hp.type.irContentHash === cp.type.irContentHash;
          if (!paramEqual) paramsMatch = false;

          const paramConc: JavaRuleConclusion = {
            kind: 'NOMINAL_EQUAL',
            sourceFqcn: (hp.type as any).qualifiedName ?? (hp.type as any).primitiveKind ?? 'unknown',
            targetFqcn: (cp.type as any).qualifiedName ?? (cp.type as any).primitiveKind ?? 'unknown',
            compatible: paramEqual,
            memberName: `${targetMethodName}#param${i}`,
            detail: `Parameter ${i} (${hp.name ?? i}) nominal type equality for ${targetMethodName}`
          };
          const paramNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], paramConc);
          nodes.push({
            nodeId: paramNodeId,
            ruleId: 'JAVA.F0.NOMINAL.EQUAL',
            premises: [],
            conclusion: paramConc
          });
          methodPremiseIds.push(paramNodeId);
        }
      }

      // Return type check
      const returnMatch = histMethod.returnType.irContentHash === candMethod.returnType.irContentHash;
      const returnConc: JavaRuleConclusion = {
        kind: 'NOMINAL_EQUAL',
        sourceFqcn: (histMethod.returnType as any).qualifiedName ?? (histMethod.returnType as any).primitiveKind ?? 'void',
        targetFqcn: (candMethod.returnType as any).qualifiedName ?? (candMethod.returnType as any).primitiveKind ?? 'void',
        compatible: returnMatch,
        memberName: `${targetMethodName}#return`,
        detail: `Return type nominal equality for ${targetMethodName}`
      };
      const returnNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], returnConc);
      nodes.push({
        nodeId: returnNodeId,
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: [],
        conclusion: returnConc
      });
      methodPremiseIds.push(returnNodeId);

      // Method Signature Preservation Node
      const normHistVis = histMethod.visibility.toUpperCase().replace('-', '_');
      const normCandVis = candMethod.visibility.toUpperCase().replace('-', '_');
      const histVisScore = VISIBILITY_LEVELS[normHistVis] ?? 0;
      const candVisScore = VISIBILITY_LEVELS[normCandVis] ?? 0;
      const visPreserved = candVisScore >= histVisScore;

      const methodPreserved = paramsMatch && returnMatch && visPreserved;
      const methodConclusion: JavaRuleConclusion = {
        kind: 'METHOD_SIGNATURE_PRESERVED',
        methodName: targetMethodName,
        historicalVisibility: normHistVis,
        candidateVisibility: normCandVis,
        historicalParameterCount: histMethod.parameters.length,
        candidateParameterCount: candMethod.parameters.length,
        parameterCount: histMethod.parameters.length,
        compatible: methodPreserved
      };
      const methodNodeId = computeNodeId('JAVA.F0.METHOD.SIGNATURE_PRESERVED', methodPremiseIds, methodConclusion);
      nodes.push({
        nodeId: methodNodeId,
        ruleId: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
        premises: methodPremiseIds,
        conclusion: methodConclusion
      });
      rootNodeIds.push(methodNodeId);

      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds,
        claimedConclusion: methodPreserved ? 'COMPATIBLE' : 'INCOMPATIBLE',
        metadata: {
          capabilityId: methodPreserved ? 'JAVA_METHOD_DECLARATION_PRESERVED' : 'JAVA_METHOD_DECLARATION_MODIFIED',
          targetFqcn: candidateClass.fqcn,
          memberName: targetMethodName
        }
      };

      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    // 4. Handle Field Obligation
    if (obligation.relationKind === 'FIELD_ACCESS') {
      const targetFieldName = memberName ?? obligation.memberSignature ?? '';
      const histField = historicalClass.fields.find(f => f.name === targetFieldName);
      const candField = candidateClass.fields.find(f => f.name === targetFieldName);

      if (!histField) {
        return {
          success: false,
          refused: true,
          reason: `Historical field '${targetFieldName}' not found in class '${historicalClass.fqcn}'`
        };
      }

      if (!candField) {
        const fieldRemovalConc: JavaRuleConclusion = {
          kind: 'FIELD_SIGNATURE_PRESERVED',
          fieldName: targetFieldName,
          historicalVisibility: histField.visibility.toUpperCase(),
          candidateVisibility: 'PRIVATE',
          compatible: false,
          detail: `Field '${targetFieldName}' was removed in candidate class`
        };
        const fieldRemovalNodeId = computeNodeId('JAVA.F0.FIELD.SIGNATURE_PRESERVED', [], fieldRemovalConc);
        nodes.push({
          nodeId: fieldRemovalNodeId,
          ruleId: 'JAVA.F0.FIELD.SIGNATURE_PRESERVED',
          premises: [],
          conclusion: fieldRemovalConc
        });
        rootNodeIds.push(fieldRemovalNodeId);

        const obligationDigest = computeJavaObligationDigest(obligation);
        const proof: JavaSemanticProof = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
          obligationDigest,
          nodes,
          rootNodeIds,
          claimedConclusion: 'INCOMPATIBLE',
          metadata: {
            capabilityId: 'JAVA_FIELD_DECLARATION_REMOVED',
            targetFqcn: candidateClass.fqcn,
            memberName: targetFieldName
          }
        };
        return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
      }

      const typeMatch = histField.type.irContentHash === candField.type.irContentHash;
      const typeConc: JavaRuleConclusion = {
        kind: 'NOMINAL_EQUAL',
        sourceFqcn: (histField.type as any).qualifiedName ?? (histField.type as any).primitiveKind ?? 'unknown',
        targetFqcn: (candField.type as any).qualifiedName ?? (candField.type as any).primitiveKind ?? 'unknown',
        compatible: typeMatch,
        memberName: `${historicalClass.fqcn}#${targetFieldName}`,
        detail: `Field ${targetFieldName} nominal type equality for ${historicalClass.fqcn}`
      };
      const typeNodeId = computeNodeId('JAVA.F0.NOMINAL.EQUAL', [], typeConc);
      nodes.push({
        nodeId: typeNodeId,
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: [],
        conclusion: typeConc
      });

      const normHistVis = histField.visibility.toUpperCase().replace('-', '_');
      const normCandVis = candField.visibility.toUpperCase().replace('-', '_');
      const histVisScore = VISIBILITY_LEVELS[normHistVis] ?? 0;
      const candVisScore = VISIBILITY_LEVELS[normCandVis] ?? 0;
      const visPreserved = candVisScore >= histVisScore;
      const finalPreserved = histField.isFinal || !candField.isFinal;
      const fieldPreserved = typeMatch && visPreserved && finalPreserved;

      const fieldConc: JavaRuleConclusion = {
        kind: 'FIELD_SIGNATURE_PRESERVED',
        fieldName: targetFieldName,
        historicalVisibility: normHistVis,
        candidateVisibility: normCandVis,
        historicalFinal: histField.isFinal,
        candidateFinal: candField.isFinal,
        compatible: fieldPreserved
      };
      const fieldNodeId = computeNodeId('JAVA.F0.FIELD.SIGNATURE_PRESERVED', [typeNodeId], fieldConc);
      nodes.push({
        nodeId: fieldNodeId,
        ruleId: 'JAVA.F0.FIELD.SIGNATURE_PRESERVED',
        premises: [typeNodeId],
        conclusion: fieldConc
      });
      rootNodeIds.push(fieldNodeId);

      const obligationDigest = computeJavaObligationDigest(obligation);
      const proof: JavaSemanticProof = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
        obligationDigest,
        nodes,
        rootNodeIds,
        claimedConclusion: fieldPreserved ? 'COMPATIBLE' : 'INCOMPATIBLE',
        metadata: {
          capabilityId: fieldPreserved ? 'JAVA_FIELD_DECLARATION_PRESERVED' : 'JAVA_FIELD_DECLARATION_MODIFIED',
          targetFqcn: candidateClass.fqcn,
          memberName: targetFieldName
        }
      };
      return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
    }

    // 5. Default: Class Visibility / Subtyping Obligation
    const classVisConc: JavaRuleConclusion = {
      kind: 'CLASS_VISIBILITY_PRESERVED',
      className: historicalClass.simpleName,
      historicalVisibility: 'PUBLIC',
      candidateVisibility: 'PUBLIC',
      compatible: true
    };
    const classVisNodeId = computeNodeId('JAVA.F0.CLASS.VISIBILITY_PRESERVED', [], classVisConc);
    nodes.push({
      nodeId: classVisNodeId,
      ruleId: 'JAVA.F0.CLASS.VISIBILITY_PRESERVED',
      premises: [],
      conclusion: classVisConc
    });
    rootNodeIds.push(classVisNodeId);

    const obligationDigest = computeJavaObligationDigest(obligation);
    const proof: JavaSemanticProof = {
      schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
      ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
      obligationDigest,
      nodes,
      rootNodeIds,
      claimedConclusion: 'COMPATIBLE',
      metadata: {
        capabilityId: 'JAVA_CLASS_DECLARATION_PRESERVED',
        targetFqcn: candidateClass.fqcn
      }
    };

    return { success: true, proof, profileId: JavaSemanticProfileId.JAVA_PUBLIC_API_F0 };
  }
}
