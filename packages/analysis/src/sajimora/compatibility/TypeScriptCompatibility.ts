import * as ts from 'typescript';
import {
  ProofObligation,
  CanonicalReferenceOccurrence,
  ReferenceExpressionContext,
  CompatibilityResult,
  CompatibilityEvaluator,
  ContractSignature,
  UsageSite,
  CompatibilityReason,
  RelationKind,
  Phase4BlockerId,
  RelationBlocker,
  getSymbolName
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { TypeScriptLanguageAdapter } from '../languages/typescript/TypeScriptLanguageAdapter';
import { GenericRelationEngine } from './GenericRelationEngine';
import { ProofTreeBuilder } from './ProofTreeBuilder';
import { TypeScriptUsageSpecializer } from '../languages/typescript/specialization/TypeScriptUsageSpecializer';
import { TypeScriptPolicy } from '../languages/typescript/compatibility/TypeScriptSemanticRules';
import { TypeScriptTypeIR, TypeScriptSignatureIR } from '../languages/typescript/ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from '../languages/typescript/ir/TypeScriptTypeIRExtractor';
import { WitnessGenerator } from './WitnessGenerator';

/**
 * SUPPORTED COMPATIBILITY RULES
 *
 * TypeScriptCompatibility is a CONSERVATIVE evaluator in legacy mode.
 * In Phase 4 mode, it executes the complete polyglot GenericRelationEngine
 * with snapshot isolation and dual-program evidence.
 */

const SUPPORTED_PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'undefined', 'null', 'void', 'never', 'object'
]);

const KNOWN_SAFE_TYPES = new Set([
  ...SUPPORTED_PRIMITIVES,
  'any', 'unknown', 'true', 'false'
]);

function isUnsupportedTypeExpression(typeStr: string): boolean {
  const t = typeStr.trim();

  if (KNOWN_SAFE_TYPES.has(t)) return false;
  if (/^\d+(\.\d+)?$/.test(t)) return false;
  if (/^"[^"]*"$/.test(t) || /^'[^']*'$/.test(t)) return false;

  if (t.includes(' | ')) return true;
  if (t.includes(' & ')) return true;
  if (t.includes('<')) return true;
  if (t.includes('{')) return true;
  if (t.includes('=>')) return true;
  if (t.startsWith('[')) return true;
  if (t.startsWith('`')) return true;

  return true;
}

function evaluateParamTypeCompatibility(
  argTypeStr: string,
  paramTypeStr: string
): 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNDECIDABLE' {
  const argT = argTypeStr.trim();
  const paramT = paramTypeStr.trim();

  if (argT === 'any') return 'COMPATIBLE';
  if (paramT === 'any') return 'COMPATIBLE';
  if (paramT === 'unknown') return 'COMPATIBLE';

  if (isUnsupportedTypeExpression(argT) || isUnsupportedTypeExpression(paramT)) {
    return 'UNDECIDABLE';
  }

  if (/^\d+(\.\d+)?$/.test(argT) && paramT === 'number') return 'COMPATIBLE';
  if ((/^"[^"]*"$/.test(argT) || /^'[^']*'$/.test(argT)) && paramT === 'string') {
    return 'COMPATIBLE';
  }
  if ((argT === 'true' || argT === 'false') && paramT === 'boolean') return 'COMPATIBLE';

  if (argT === paramT && SUPPORTED_PRIMITIVES.has(argT)) return 'COMPATIBLE';

  if (SUPPORTED_PRIMITIVES.has(argT) && SUPPORTED_PRIMITIVES.has(paramT)) {
    return 'INCOMPATIBLE';
  }

  return 'UNDECIDABLE';
}

function isDeeplyImmutable(typeIR: TypeScriptTypeIR, visited: Set<string> = new Set()): boolean {
  if (visited.has(typeIR.irContentHash)) return true;
  visited.add(typeIR.irContentHash);

  if (typeIR.kind === 'PRIMITIVE' || typeIR.kind === 'LITERAL') return true;
  if (typeIR.kind === 'OBJECT') {
    const obj = typeIR as import('../languages/typescript/ir/TypeScriptTypeIR').ObjectTypeIR;
    if (obj.indexSignatures && obj.indexSignatures.length > 0) {
      if (!obj.indexSignatures.every(idx => Boolean(idx.isReadonly) && isDeeplyImmutable(idx.valueType, visited))) {
        return false;
      }
    }
    if (!obj.properties || obj.properties.length === 0) {
      return !obj.indexSignatures || obj.indexSignatures.length === 0;
    }
    return obj.properties.every(([_, desc]) => desc.isReadonly && isDeeplyImmutable(desc.type, visited));
  }
  if (typeIR.kind === 'ARRAY') {
    const arr = typeIR as import('../languages/typescript/ir/TypeScriptTypeIR').ArrayTypeIR;
    return Boolean(arr.isReadonly) && isDeeplyImmutable(arr.elementType, visited);
  }
  if (typeIR.kind === 'TUPLE') {
    const tup = typeIR as import('../languages/typescript/ir/TypeScriptTypeIR').TupleTypeIR;
    return Boolean(tup.isReadonly) && tup.elements.every(el => isDeeplyImmutable(el.type, visited));
  }
  return false;
}

import { Phase4SemanticProvider } from './Phase4SemanticProvider';

export interface TypeScriptCompatibilityPhase4Options {
  readonly isPhase4Mode?: boolean;
  readonly provider?: Phase4SemanticProvider;
  readonly policy?: TypeScriptPolicy;
}

export class TypeScriptCompatibility implements CompatibilityEvaluator {
  private phase4Options?: TypeScriptCompatibilityPhase4Options;

  constructor(
    private context?: AnalysisContext,
    private obligation?: ProofObligation,
    options?: TypeScriptCompatibilityPhase4Options
  ) {
    this.phase4Options = options;
  }

  public evaluate(
    obligation: ProofObligation,
    usageRole: CanonicalReferenceOccurrence['usageRole'],
    expressionContext: ReferenceExpressionContext | null,
    oldContract: ContractSignature,
    newContract: ContractSignature,
    consumerEvidence: any
  ): CompatibilityResult {
    if (consumerEvidence && typeof consumerEvidence.usageSiteId === 'string') {
      return this.evaluateSite(consumerEvidence);
    }
    return { status: 'UNDECIDABLE', reason: null };
  }

  public evaluateSite(site: UsageSite): CompatibilityResult {
    // STRICT Phase 4 execution path
    if (this.phase4Options?.isPhase4Mode) {
      return this.evaluatePhase4Site(site);
    }

    const obligation = this.obligation;
    const classification = obligation?.providerMutation?.classification;

    if (classification === 'TYPE_DEF_MUTATED') {
      return { status: 'UNDECIDABLE', reason: null };
    }

    if (classification === 'PUBLIC_SYMBOL_EXPORTED') {
      return { status: 'UNDECIDABLE', reason: null };
    }

    if (classification === 'SYMBOL_DELETED') {
      if (site.canonicalOccurrence.resolutionStatus === 'RESOLVED' &&
          site.deletionProof?.status === 'PROVEN_ABSENT' && site.deletionProof.parentBinding) {
        return { status: 'INCOMPATIBLE', reason: 'SYMBOL_DELETED' };
      }
      return { status: 'UNDECIDABLE', reason: null };
    }

    if (classification === 'EXPORTED_SIGNATURE_MUTATED') {
      return this.evaluateSignatureMutation(site);
    }

    return { status: 'UNDECIDABLE', reason: null };
  }

  private evaluatePhase4Site(site: UsageSite): CompatibilityResult {
    const isCallSite = site.canonicalOccurrence.usageRole === 'CALL_SITE';
    const provider = this.phase4Options?.provider;

    if (!provider) {
      // STRICT NO-FALLBACK RULE: evaluator receives provider, does not construct one
      return {
        status: 'UNDECIDABLE',
        reason: 'PHASE4_PREREQUISITES_UNAVAILABLE'
      };
    }

      const histResult = provider.getHistoricalObligation(site);
      if (!histResult.specializedContract) {
        const blockerId = (histResult.blockerId ?? 'HISTORICAL_EXPECTATION_UNRECOVERABLE') as Phase4BlockerId;
        const blocker: RelationBlocker = {
          blockerId,
          snapshot: 'PARENT' as const,
          detail: histResult.errorDetail ?? 'Historical usage specialization failed'
        };
        const undecidableEv = ProofTreeBuilder.buildUndecidableEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          site.canonicalOccurrence.usageRole,
          [blocker],
          undefined,
          undefined,
          site.canonicalOccurrence.occurrenceId
        );
        return {
          status: 'UNDECIDABLE',
          reason: blockerId,
          phase4Evidence: undecidableEv
        };
      }

      const usageContract = histResult.specializedContract;
      const targetSymbol = this.obligation?.mutatedSymbol;
      const targetName = targetSymbol ? getSymbolName(targetSymbol) : '';
      const targetLoc = (targetSymbol as any)?.declarationLocation?.filePath
        ?? (targetSymbol as any)?.declarationLocation?.file
        ?? (targetSymbol as any)?.moduleIdentity;

      const candContractResult = provider.getCandidateContract(
        targetSymbol?.persistentSymbolId ?? targetSymbol?.symbolId ?? 'target',
        targetName,
        targetLoc
      );

      const adapter = new TypeScriptLanguageAdapter();
      const policy: TypeScriptPolicy = this.phase4Options?.policy ?? {
        strictFunctionTypes: true,
        strictNullChecks: true
      };
      const engine = new GenericRelationEngine<TypeScriptTypeIR, TypeScriptPolicy>(adapter);

      if (isCallSite) {
        return this.evaluatePhase4CallSite(
          site,
          usageContract,
          candContractResult.contractIR,
          engine,
          policy,
          histResult.selectedSignatureIndex,
          candContractResult.isDeleted === true && !candContractResult.blockerId
        );
      }

      // TYPE_REFERENCE evaluation branch (pure provider path)
      const candidateContractIR = candContractResult.contractIR;
      if (!candidateContractIR || !candidateContractIR.contractType) {
        if (
          this.obligation?.providerMutation?.classification === 'SYMBOL_DELETED' &&
          site.canonicalOccurrence.resolutionStatus === 'RESOLVED' &&
          site.deletionProof?.status === 'PROVEN_ABSENT' && Boolean(site.deletionProof.parentBinding) &&
          candContractResult.isDeleted === true && !candContractResult.blockerId
        ) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: {
              file: site.canonicalOccurrence.sourceFile,
              line: site.canonicalOccurrence.sourceSpan.line,
              column: site.canonicalOccurrence.sourceSpan.column
            },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: 'ASSIGNABLE_TO',
            position: { kind: 'ROOT' },
            parentType: {
              display: usageContract.expectedType.display,
              irContentHash: usageContract.expectedType.irContentHash
            },
            candidateType: { display: 'never (deleted)' },
            failedRelation: `Target symbol was deleted in candidate`,
            evidenceChain: [site.deletionProof!.evidenceId],
            ruleId: 'SYMBOL_DELETED'
          });
          const incompTree = ProofTreeBuilder.createIncompatibleNode({
            relation: 'ASSIGNABLE_TO',
            rule: 'SYMBOL_DELETED',
            adapterId: 'typescript',
            adapterVersion: '1.0.0',
            ruleNamespace: 'typescript-compatibility-v1',
            source: { kind: 'PRIMITIVE', primitive: 'never', display: 'never', irContentHash: 'deleted' } as any,
            target: usageContract.expectedType,
            sourceHash: 'deleted',
            targetHash: usageContract.expectedType.irContentHash,
            effectivePolicy: policy as any,
            witness
          });
          const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
            site.usageSiteId,
            site.canonicalOccurrence.occurrenceId,
            this.obligation?.mutatedSymbol?.symbolId ?? 'target',
            usageContract.usageRole,
            incompTree,
            witness,
            usageContract,
            site.canonicalOccurrence.occurrenceId,
            undefined,
            undefined
          );
          return {
            status: 'INCOMPATIBLE',
            reason: 'SYMBOL_DELETED',
            phase4Evidence: incompEv
          };
        }

        const blocker: RelationBlocker = {
          blockerId: 'CANDIDATE_DECLARATION_MISSING',
          snapshot: 'CANDIDATE',
          detail: 'Candidate declaration could not be resolved'
        };
        const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          usageContract.usageRole,
          [blocker],
          undefined,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          undefined
        );
        return {
          status: 'UNDECIDABLE',
          reason: 'CANDIDATE_DECLARATION_MISSING',
          phase4Evidence: undecEv
        };
      }

      const relationResult = engine.evaluate(
        candidateContractIR.contractType,
        usageContract.expectedType,
        'ASSIGNABLE_TO',
        policy
      );

      return this.buildResultFromProof(site, usageContract, candidateContractIR, relationResult, policy);


  }

  private evaluatePhase4CallSite(
    site: UsageSite,
    usageContract: import('@sajimora/core').SpecializedUsageContract<TypeScriptTypeIR>,
    candidateContractIR: import('@sajimora/core').LanguageContractIR<TypeScriptTypeIR> | undefined,
    engine: GenericRelationEngine<TypeScriptTypeIR, TypeScriptPolicy>,
    policy: TypeScriptPolicy,
    selectedSignatureIndex?: number,
    candidateDeletionVerified = false
  ): CompatibilityResult {
    const candTypeIR: TypeScriptTypeIR | undefined = candidateContractIR?.contractType;

    if (!candTypeIR) {
      if (
        this.obligation?.providerMutation?.classification === 'SYMBOL_DELETED' &&
        site.canonicalOccurrence.resolutionStatus === 'RESOLVED' &&
        site.deletionProof?.status === 'PROVEN_ABSENT' && Boolean(site.deletionProof.parentBinding) &&
        candidateDeletionVerified
      ) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: {
            file: site.canonicalOccurrence.sourceFile,
            line: site.canonicalOccurrence.sourceSpan.line,
            column: site.canonicalOccurrence.sourceSpan.column
          },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'ASSIGNABLE_TO',
          position: { kind: 'ROOT' },
          parentType: {
            display: usageContract.expectedType.display,
            irContentHash: usageContract.expectedType.irContentHash
          },
          candidateType: { display: 'never (deleted)' },
          failedRelation: `Target symbol was deleted in candidate`,
          evidenceChain: [site.deletionProof!.evidenceId],
          ruleId: 'SYMBOL_DELETED'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'ASSIGNABLE_TO',
          rule: 'SYMBOL_DELETED',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: { kind: 'PRIMITIVE', primitive: 'never', display: 'never', irContentHash: 'deleted' } as any,
          target: usageContract.expectedType,
          sourceHash: 'deleted',
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          undefined
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'SYMBOL_DELETED',
          phase4Evidence: incompEv
        };
      }

      const blocker: RelationBlocker = {
        blockerId: 'CANDIDATE_DECLARATION_MISSING',
        snapshot: 'CANDIDATE',
        detail: 'Candidate declaration could not be resolved'
      };
      const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        [blocker],
        undefined,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        undefined
      );
      return {
        status: 'UNDECIDABLE',
        reason: 'CANDIDATE_DECLARATION_MISSING',
        phase4Evidence: undecEv
      };
    }

    const args = usageContract.arguments ?? [];
    const childProofs: import('@sajimora/core').TypeRelationResult[] = [];

    const isCallable = candTypeIR.kind === 'CALLABLE' ||
      (candTypeIR.kind === 'OBJECT' && Array.isArray((candTypeIR as any).callSignatures) && (candTypeIR as any).callSignatures.length > 0);

    if (!isCallable) {
      if (
        candTypeIR.kind === 'UNSUPPORTED' ||
        (candTypeIR.kind === 'PRIMITIVE' && ((candTypeIR as any).primitiveKind === 'any' || (candTypeIR as any).primitiveKind === 'unknown'))
      ) {
        const blockerId = candTypeIR.kind === 'PRIMITIVE' ? 'ANY_DEPENDENCY_TARGET' : 'UNSUPPORTED_CALLABILITY';
        const blocker: RelationBlocker = {
          blockerId: blockerId as any,
          snapshot: 'CANDIDATE',
          detail: `Candidate declaration has type '${candTypeIR.display}' with uncertain callability`,
          targetIRContentHash: candTypeIR.irContentHash
        };
        const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          [blocker],
          undefined,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'UNDECIDABLE',
          reason: blockerId,
          phase4Evidence: undecEv
        };
      }

      const witness = WitnessGenerator.createWitness({
        consumerLocation: {
          file: site.canonicalOccurrence.sourceFile,
          line: site.canonicalOccurrence.sourceSpan.line,
          column: site.canonicalOccurrence.sourceSpan.column
        },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
        position: { kind: 'ROOT' },
        parentType: { display: usageContract.expectedType.display, irContentHash: usageContract.expectedType.irContentHash },
        candidateType: { display: candTypeIR.display, irContentHash: candTypeIR.irContentHash },
        failedRelation: `Candidate type '${candTypeIR.display}' is not callable at call site`,
        ruleId: 'CALLABILITY_CHECK'
      });
      const incompTree = ProofTreeBuilder.createIncompatibleNode({
        relation: 'PARAMETER_ACCEPTS_ARGUMENT',
        rule: 'CALLABILITY_CHECK',
        adapterId: 'typescript',
        adapterVersion: '1.0.0',
        ruleNamespace: 'typescript-compatibility-v1',
        source: candTypeIR,
        target: usageContract.expectedType,
        sourceHash: candTypeIR.irContentHash,
        targetHash: usageContract.expectedType.irContentHash,
        effectivePolicy: policy as any,
        witness
      });
      const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        incompTree,
        witness,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'INCOMPATIBLE',
        reason: 'NOT_CALLABLE',
        phase4Evidence: incompEv
      };
    }

    const sigs: ReadonlyArray<import('../languages/typescript/ir/TypeScriptTypeIR').TypeScriptSignatureIR> = candTypeIR.kind === 'CALLABLE'
      ? (candTypeIR as import('../languages/typescript/ir/TypeScriptTypeIR').CallableTypeIR).signatures
      : (candTypeIR as import('../languages/typescript/ir/TypeScriptTypeIR').ObjectTypeIR).callSignatures!;

    // Overload resolution:
    let targetSig: import('../languages/typescript/ir/TypeScriptTypeIR').TypeScriptSignatureIR | undefined;
    if (sigs.length === 1) {
      targetSig = sigs[0];
    } else {
      if (selectedSignatureIndex !== undefined && selectedSignatureIndex >= 0 && selectedSignatureIndex < sigs.length) {
        targetSig = sigs[selectedSignatureIndex];
      }

      if (!targetSig) {
        // Evaluate in declaration order:
        let firstMatchingSig: import('../languages/typescript/ir/TypeScriptTypeIR').TypeScriptSignatureIR | undefined;
        let hasLaterSpecializedConflict = false;

        for (let sIdx = 0; sIdx < sigs.length; sIdx++) {
          const sig = sigs[sIdx];
          const req = sig.parameters.filter(p => p.isRequired).length;
          const hasRest = sig.parameters.some(p => p.isRest);
          if (args.length < req) continue;
          if (!hasRest && args.length > sig.parameters.length) continue;

          let allAccepted = true;
          let branchUndecidable = false;

          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            const param = i < sig.parameters.length ? sig.parameters[i] : sig.parameters[sig.parameters.length - 1];
            let paramType = param.type;
            if (param.isRest && paramType.kind === 'ARRAY') {
              paramType = (paramType as any).elementType;
            }
            const pProof = engine.evaluate(arg.type, paramType, 'PARAMETER_ACCEPTS_ARGUMENT', policy);
            if (pProof.status === 'INCOMPATIBLE') {
              allAccepted = false;
              break;
            } else if (pProof.status === 'UNDECIDABLE') {
              allAccepted = false;
              branchUndecidable = true;
              break;
            }
          }

          if (branchUndecidable) {
            // An earlier candidate signature encountered undecidable arguments; cannot skip it to accept a later overload
            const blocker: RelationBlocker = {
              blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE',
              snapshot: 'CANDIDATE',
              detail: 'Overload resolution encountered undecidable argument relation on earlier candidate signature',
              targetIRContentHash: candTypeIR.irContentHash
            };
            const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
              site.usageSiteId,
              site.canonicalOccurrence.occurrenceId,
              this.obligation?.mutatedSymbol?.symbolId ?? 'target',
              'CALL_SITE',
              [blocker],
              undefined,
              usageContract,
              site.canonicalOccurrence.occurrenceId,
              undefined,
              candidateContractIR
            );
            return {
              status: 'UNDECIDABLE',
              reason: 'OVERLOAD_SELECTION_UNAVAILABLE',
              phase4Evidence: undecEv
            };
          }

          if (allAccepted) {
            if (!firstMatchingSig) {
              firstMatchingSig = sig;
            } else {
              // A later signature also matched: check if first signature was non-specialized but later is specialized
              const firstIsSpecialized = firstMatchingSig.parameters.some(p => p.type.kind === 'LITERAL');
              const laterIsSpecialized = sig.parameters.some(p => p.type.kind === 'LITERAL');
              if (!firstIsSpecialized && laterIsSpecialized) {
                hasLaterSpecializedConflict = true;
                break;
              }
            }
          }
        }

        if (hasLaterSpecializedConflict) {
          const blocker: RelationBlocker = {
            blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE',
            snapshot: 'CANDIDATE',
            detail: 'Candidate declaration order conflicts with TypeScript specialized overload resolution; selection cannot be deterministically established',
            targetIRContentHash: candTypeIR.irContentHash
          };
          const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
            site.usageSiteId,
            site.canonicalOccurrence.occurrenceId,
            this.obligation?.mutatedSymbol?.symbolId ?? 'target',
            'CALL_SITE',
            [blocker],
            undefined,
            usageContract,
            site.canonicalOccurrence.occurrenceId,
            undefined,
            candidateContractIR
          );
          return {
            status: 'UNDECIDABLE',
            reason: 'OVERLOAD_SELECTION_UNAVAILABLE',
            phase4Evidence: undecEv
          };
        }

        if (firstMatchingSig) {
          targetSig = firstMatchingSig;
        } else {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
            position: { kind: 'ROOT' },
            parentType: { display: `${args.length} arguments: ${args.map(a => a.type.display).join(', ')}` },
            candidateType: { display: candTypeIR.display },
            failedRelation: `No candidate overload matches call site argument types`,
            ruleId: 'OVERLOAD_RESOLUTION'
          });
          const incompTree = ProofTreeBuilder.createIncompatibleNode({
            relation: 'PARAMETER_ACCEPTS_ARGUMENT',
            rule: 'OVERLOAD_RESOLUTION',
            adapterId: 'typescript',
            adapterVersion: '1.0.0',
            ruleNamespace: 'typescript-compatibility-v1',
            source: candTypeIR,
            target: usageContract.expectedType,
            sourceHash: candTypeIR.irContentHash,
            targetHash: usageContract.expectedType.irContentHash,
            effectivePolicy: policy as any,
            witness
          });
          const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
            site.usageSiteId,
            site.canonicalOccurrence.occurrenceId,
            this.obligation?.mutatedSymbol?.symbolId ?? 'target',
            'CALL_SITE',
            incompTree,
            witness,
            usageContract,
            site.canonicalOccurrence.occurrenceId,
            undefined,
            candidateContractIR
          );
          return {
            status: 'INCOMPATIBLE',
            reason: 'NO_OVERLOAD_MATCHES',
            phase4Evidence: incompEv
          };
        }
      }
    }

    // Finding 4: Explicit this parameter obligation
    if (targetSig.thisParameter) {
      const thisType = targetSig.thisParameter.type;
      const isVoidOrAny = thisType.kind === 'PRIMITIVE' && (
        thisType.primitiveKind === 'void' ||
        thisType.primitiveKind === 'any' ||
        thisType.primitiveKind === 'unknown'
      );
      if (!isVoidOrAny) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
          position: { kind: 'PARAMETER', index: -1, name: 'this' },
          parentType: { display: 'void', irContentHash: '' },
          candidateType: { display: thisType.display, irContentHash: thisType.irContentHash },
          failedRelation: `Candidate signature requires explicit 'this' parameter of type '${thisType.display}', but call site provides no compatible receiver`,
          ruleId: 'RECEIVER_OBLIGATION_VIOLATED'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'PARAMETER_ACCEPTS_ARGUMENT',
          rule: 'RECEIVER_OBLIGATION_VIOLATED',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: { kind: 'PRIMITIVE', primitiveKind: 'void', display: 'void', schemaVersion: 'SAJIMORA_TYPE_IR_V1', irContentHash: '' },
          target: thisType,
          sourceHash: '',
          targetHash: thisType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'RECEIVER_OBLIGATION_VIOLATED',
          phase4Evidence: incompEv
        };
      }
    }

    // Finding 5: Type predicate and assertion effects
    const parentPred = (usageContract as any).parentPredicate;
    if (parentPred) {
      const candPred = targetSig.typePredicate;
      if (!candPred) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'RETURN_SATISFIES_CONTEXT',
          position: { kind: 'RETURN' },
          parentType: { display: `${parentPred.kind}:${parentPred.targetType?.display ?? 'target'}` },
          candidateType: { display: targetSig.returnType.display },
          failedRelation: `Candidate signature dropped the type predicate / assertion effect present on parent signature`,
          ruleId: 'PREDICATE_EFFECT_DROPPED'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'RETURN_SATISFIES_CONTEXT',
          rule: 'PREDICATE_EFFECT_DROPPED',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: targetSig.returnType,
          target: usageContract.expectedType,
          sourceHash: targetSig.returnType.irContentHash,
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'PREDICATE_EFFECT_DROPPED',
          phase4Evidence: incompEv
        };
      }

      if (candPred.kind !== parentPred.kind) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'RETURN_SATISFIES_CONTEXT',
          position: { kind: 'RETURN' },
          parentType: { display: parentPred.kind },
          candidateType: { display: candPred.kind },
          failedRelation: `Candidate predicate effect kind '${candPred.kind}' does not match parent kind '${parentPred.kind}'`,
          ruleId: 'PREDICATE_EFFECT_KIND_MISMATCH'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'RETURN_SATISFIES_CONTEXT',
          rule: 'PREDICATE_EFFECT_KIND_MISMATCH',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: targetSig.returnType,
          target: usageContract.expectedType,
          sourceHash: targetSig.returnType.irContentHash,
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'PREDICATE_EFFECT_KIND_MISMATCH',
          phase4Evidence: incompEv
        };
      }

      if (parentPred.targetType && candPred.targetType) {
        const predProof = engine.evaluate(
          candPred.targetType,
          parentPred.targetType,
          'ASSIGNABLE_TO',
          policy
        );
        childProofs.push(predProof);
      }
    }

    if (!targetSig) {
      return {
        status: 'UNDECIDABLE',
        reason: 'OVERLOAD_SELECTION_UNAVAILABLE'
      };
    }

    // Arity check
    const requiredParams = targetSig.parameters.filter((p: any) => p.isRequired).length;
    const hasRest = targetSig.parameters.some((p: any) => p.isRest);

    if (args.length < requiredParams) {
      const witness = {
        witnessId: 'ARITY_MISMATCH',
        consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: 'ARITY_SATISFIED' as RelationKind,
        position: { kind: 'ROOT' as const },
        parentType: { display: `${args.length} arguments` },
        candidateType: { display: `${requiredParams} required parameters` },
        failedRelation: `Call site provides ${args.length} arguments but candidate requires ${requiredParams}`,
        evidenceChain: ['REQUIRED_PARAMETER_ADDED']
      };
      const incompTree = ProofTreeBuilder.createIncompatibleNode({
        relation: 'ARITY_SATISFIED',
        rule: 'ARITY_CHECK',
        adapterId: 'typescript',
        adapterVersion: '1.0.0',
        ruleNamespace: 'typescript-compatibility-v1',
        source: candTypeIR,
        target: candTypeIR,
        sourceHash: candTypeIR.irContentHash,
        targetHash: candTypeIR.irContentHash,
        effectivePolicy: policy as any,
        witness
      });
      const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        incompTree,
        witness,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'INCOMPATIBLE',
        reason: 'REQUIRED_PARAMETER_ADDED',
        phase4Evidence: incompEv
      };
    }

    // Excess arguments check
    if (!hasRest && args.length > targetSig.parameters.length) {
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: 'ARITY_SATISFIED',
        position: { kind: 'ROOT' },
        parentType: { display: `${args.length} arguments` },
        candidateType: { display: `at most ${targetSig.parameters.length} parameters` },
        failedRelation: `Call site provides ${args.length} arguments but candidate accepts at most ${targetSig.parameters.length}`,
        ruleId: 'EXCESS_ARGUMENTS_CHECK'
      });
      const incompTree = ProofTreeBuilder.createIncompatibleNode({
        relation: 'ARITY_SATISFIED',
        rule: 'EXCESS_ARGUMENTS_CHECK',
        adapterId: 'typescript',
        adapterVersion: '1.0.0',
        ruleNamespace: 'typescript-compatibility-v1',
        source: candTypeIR,
        target: candTypeIR,
        sourceHash: candTypeIR.irContentHash,
        targetHash: candTypeIR.irContentHash,
        effectivePolicy: policy as any,
        witness
      });
      const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        incompTree,
        witness,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'INCOMPATIBLE',
        reason: 'EXCESS_ARGUMENTS_REJECTED',
        phase4Evidence: incompEv
      };
    }

    // Complete argument checking
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let paramType: TypeScriptTypeIR;
      if (i < targetSig.parameters.length) {
        const p = targetSig.parameters[i];
        if (p.isRest && p.type.kind === 'ARRAY') {
          paramType = (p.type as any).elementType;
        } else {
          paramType = p.type;
        }
      } else {
        const restP = targetSig.parameters[targetSig.parameters.length - 1];
        if (restP && restP.isRest && restP.type.kind === 'ARRAY') {
          paramType = (restP.type as any).elementType;
        } else {
          paramType = restP.type;
        }
      }

      const argProof = engine.evaluate(
        arg.type,
        paramType,
        'PARAMETER_ACCEPTS_ARGUMENT',
        policy,
        {
          varianceStack: [
            {
              level: 0,
              position: 'PARAMETER',
              localVariance: 'CONTRAVARIANT',
              composedVariance: 'CONTRAVARIANT',
              declarationSyntax: 'FUNCTION_TYPE',
              isActualCallSiteArgument: true
            }
          ]
        }
      );
      childProofs.push(argProof);
    }

    // Generic type arguments & constraint validation
    const candTypeParams = targetSig.typeParameters ?? [];
    const callGenericArgs = usageContract.genericTypeArguments ?? [];

    if (callGenericArgs.length > 0) {
      if (candTypeParams.length === 0) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
          position: { kind: 'ROOT' },
          parentType: { display: `${callGenericArgs.length} type arguments` },
          candidateType: { display: candTypeIR.display },
          failedRelation: `Expected 0 type arguments, but got ${callGenericArgs.length}`,
          ruleId: 'GENERIC_ARITY_CHECK'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'PARAMETER_ACCEPTS_ARGUMENT',
          rule: 'GENERIC_ARITY_CHECK',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: candTypeIR,
          target: usageContract.expectedType,
          sourceHash: candTypeIR.irContentHash,
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'GENERIC_ARITY_MISMATCH',
          phase4Evidence: incompEv
        };
      }

      if (callGenericArgs.length > candTypeParams.length) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
          position: { kind: 'ROOT' },
          parentType: { display: `${callGenericArgs.length} type arguments` },
          candidateType: { display: `${candTypeParams.length} type parameters` },
          failedRelation: `Expected ${candTypeParams.length} type arguments, but got ${callGenericArgs.length}`,
          ruleId: 'GENERIC_ARITY_CHECK'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'PARAMETER_ACCEPTS_ARGUMENT',
          rule: 'GENERIC_ARITY_CHECK',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: candTypeIR,
          target: usageContract.expectedType,
          sourceHash: candTypeIR.irContentHash,
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'GENERIC_ARITY_MISMATCH',
          phase4Evidence: incompEv
        };
      }

      const minRequired = candTypeParams.filter(tp => !tp.defaultType).length;
      if (callGenericArgs.length < minRequired) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: 'PARAMETER_ACCEPTS_ARGUMENT',
          position: { kind: 'ROOT' },
          parentType: { display: `${callGenericArgs.length} type arguments` },
          candidateType: { display: `at least ${minRequired} type parameters required` },
          failedRelation: `Expected at least ${minRequired} type arguments, but got ${callGenericArgs.length}`,
          ruleId: 'GENERIC_ARITY_CHECK'
        });
        const incompTree = ProofTreeBuilder.createIncompatibleNode({
          relation: 'PARAMETER_ACCEPTS_ARGUMENT',
          rule: 'GENERIC_ARITY_CHECK',
          adapterId: 'typescript',
          adapterVersion: '1.0.0',
          ruleNamespace: 'typescript-compatibility-v1',
          source: candTypeIR,
          target: usageContract.expectedType,
          sourceHash: candTypeIR.irContentHash,
          targetHash: usageContract.expectedType.irContentHash,
          effectivePolicy: policy as any,
          witness
        });
        const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
          site.usageSiteId,
          site.canonicalOccurrence.occurrenceId,
          this.obligation?.mutatedSymbol?.symbolId ?? 'target',
          'CALL_SITE',
          incompTree,
          witness,
          usageContract,
          site.canonicalOccurrence.occurrenceId,
          undefined,
          candidateContractIR
        );
        return {
          status: 'INCOMPATIBLE',
          reason: 'GENERIC_ARITY_MISMATCH',
          phase4Evidence: incompEv
        };
      }

      for (let j = 0; j < callGenericArgs.length; j++) {
        const tp = candTypeParams[j];
        const gArg = callGenericArgs[j];
        if (gArg && tp.constraint) {
          const cProof = engine.evaluate(
            gArg.type,
            tp.constraint,
            'ASSIGNABLE_TO',
            policy
          );
          if (cProof.status === 'INCOMPATIBLE') {
            const witness = WitnessGenerator.createWitness({
              consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
              targetDeclaration: { file: '', line: 1, column: 1 },
              semanticRelation: 'ASSIGNABLE_TO',
              position: { kind: 'TYPE_ARGUMENT', index: j, name: tp.name },
              parentType: { display: gArg.type.display, irContentHash: gArg.type.irContentHash },
              candidateType: { display: tp.constraint.display, irContentHash: tp.constraint.irContentHash },
              failedRelation: `Explicit generic type argument '${gArg.type.display}' does not satisfy constraint '${tp.constraint.display}' for type parameter '${tp.name}'`,
              ruleId: 'GENERIC_CONSTRAINT_CHECK'
            });
            (cProof as any).witness = witness;
          }
          childProofs.push(cProof);
        }
      }
    }

    // Return obligation check
    if (!usageContract.isDiscardedReturn) {
      if (usageContract.hasDownstreamInferredUses) {
        const isImmutable = isDeeplyImmutable(targetSig.returnType);
        if (usageContract.hasDownstreamWrites) {
          // 1. Return covariance: candidate return must still satisfy expectedType
          const readProof = engine.evaluate(
            targetSig.returnType,
            usageContract.expectedType,
            'RETURN_SATISFIES_CONTEXT',
            policy
          );
          childProofs.push(readProof);

          // 2. Writability: candidate return properties written downstream must not be readonly
          const writtenProps = (usageContract as any).downstreamWrittenProperties as string[] | undefined;
          let rejectingPropName: string | undefined;

          if (writtenProps && writtenProps.length > 0) {
            // Check ONLY the properties that were actually written downstream
            if (targetSig.returnType.kind === 'OBJECT') {
              const objProps = new Map((targetSig.returnType as any).properties as [string, any][]);
              for (const wp of writtenProps) {
                if (wp === '*') {
                  if ((targetSig.returnType as any).indexSignatures?.some((idx: any) => idx.isReadonly)) {
                    rejectingPropName = 'index signature';
                    break;
                  }
                } else {
                  const desc = objProps.get(wp);
                  if (desc && desc.isReadonly) {
                    rejectingPropName = wp;
                    break;
                  }
                }
              }
            } else if (targetSig.returnType.kind === 'TUPLE' && Boolean((targetSig.returnType as any).isReadonly)) {
              rejectingPropName = writtenProps[0];
            }
          } else {
            const hasReadonlyProp = (
              targetSig.returnType.kind === 'OBJECT' &&
              Array.isArray((targetSig.returnType as any).properties) &&
              (targetSig.returnType as any).properties.some(([_, desc]: any) => desc.isReadonly)
            ) || (
              targetSig.returnType.kind === 'TUPLE' &&
              Boolean((targetSig.returnType as any).isReadonly)
            );
            if (hasReadonlyProp) rejectingPropName = 'unspecified property';
          }

          if (rejectingPropName) {
            const witness = WitnessGenerator.createWitness({
              consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
              targetDeclaration: { file: '', line: 1, column: 1 },
              semanticRelation: 'RETURN_SATISFIES_CONTEXT',
              position: { kind: 'RETURN' },
              parentType: { display: usageContract.expectedType.display, irContentHash: usageContract.expectedType.irContentHash },
              candidateType: { display: targetSig.returnType.display, irContentHash: targetSig.returnType.irContentHash },
              failedRelation: `Candidate return type '${targetSig.returnType.display}' has readonly property '${rejectingPropName}' which rejects downstream writes`,
              ruleId: 'DOWNSTREAM_RETURN_WRITE_CHECK'
            });
            const incompTree = ProofTreeBuilder.createIncompatibleNode({
              relation: 'RETURN_SATISFIES_CONTEXT',
              rule: 'DOWNSTREAM_RETURN_WRITE_CHECK',
              adapterId: 'typescript',
              adapterVersion: '1.0.0',
              ruleNamespace: 'typescript-compatibility-v1',
              source: targetSig.returnType,
              target: usageContract.expectedType,
              sourceHash: targetSig.returnType.irContentHash,
              targetHash: usageContract.expectedType.irContentHash,
              effectivePolicy: policy as any,
              witness
            });
            const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
              site.usageSiteId,
              site.canonicalOccurrence.occurrenceId,
              this.obligation?.mutatedSymbol?.symbolId ?? 'target',
              'CALL_SITE',
              incompTree,
              witness,
              usageContract,
              site.canonicalOccurrence.occurrenceId,
              undefined,
              candidateContractIR
            );
            return {
              status: 'INCOMPATIBLE',
              reason: 'DOWNSTREAM_RETURN_READONLY_REJECTS_WRITE',
              phase4Evidence: incompEv
            };
          }

          // 3. Write assignability
          const writeProof = engine.evaluate(
            usageContract.expectedType,
            targetSig.returnType,
            'ASSIGNABLE_TO',
            policy
          );
          if (writeProof.status === 'INCOMPATIBLE') {
            const witness = WitnessGenerator.createWitness({
              consumerLocation: { file: site.canonicalOccurrence.sourceFile, line: site.canonicalOccurrence.sourceSpan.line, column: site.canonicalOccurrence.sourceSpan.column },
              targetDeclaration: { file: '', line: 1, column: 1 },
              semanticRelation: 'RETURN_SATISFIES_CONTEXT',
              position: { kind: 'RETURN' },
              parentType: { display: usageContract.expectedType.display, irContentHash: usageContract.expectedType.irContentHash },
              candidateType: { display: targetSig.returnType.display, irContentHash: targetSig.returnType.irContentHash },
              failedRelation: `Candidate return type '${targetSig.returnType.display}' rejects downstream write on inferred variable`,
              ruleId: 'DOWNSTREAM_RETURN_WRITE_CHECK'
            });
            (writeProof as any).witness = witness;
          }
          childProofs.push(writeProof);
        } else if (!isImmutable) {
          const invProof1 = engine.evaluate(targetSig.returnType, usageContract.expectedType, 'RETURN_SATISFIES_CONTEXT', policy);
          const invProof2 = engine.evaluate(usageContract.expectedType, targetSig.returnType, 'ASSIGNABLE_TO', policy);
          if (invProof1.status === 'COMPATIBLE' && invProof2.status === 'COMPATIBLE') {
            childProofs.push(invProof1);
          } else {
            const blocker: RelationBlocker = {
              blockerId: 'DOWNSTREAM_RETURN_OBLIGATION_UNPROVEN',
              snapshot: 'PARENT',
              detail: 'Inferred return has downstream uses but lacks deep immutability evidence'
            };
            const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
              site.usageSiteId,
              site.canonicalOccurrence.occurrenceId,
              this.obligation?.mutatedSymbol?.symbolId ?? 'target',
              'CALL_SITE',
              [blocker],
              undefined,
              usageContract,
              site.canonicalOccurrence.occurrenceId,
              undefined,
              candidateContractIR
            );
            return {
              status: 'UNDECIDABLE',
              reason: 'DOWNSTREAM_RETURN_OBLIGATION_UNPROVEN',
              phase4Evidence: undecEv
            };
          }
        } else {
          const retProof = engine.evaluate(
            targetSig.returnType,
            usageContract.expectedType,
            'RETURN_SATISFIES_CONTEXT',
            policy,
            {
              varianceStack: [
                {
                  level: 0,
                  position: 'RETURN',
                  localVariance: 'COVARIANT',
                  composedVariance: 'COVARIANT',
                  declarationSyntax: 'FUNCTION_TYPE',
                  isActualCallSiteArgument: false
                }
              ]
            }
          );
          childProofs.push(retProof);
        }
      } else {
        const retProof = engine.evaluate(
          targetSig.returnType,
          usageContract.expectedType,
          'RETURN_SATISFIES_CONTEXT',
          policy,
          {
            varianceStack: [
              {
                level: 0,
                position: 'RETURN',
                localVariance: 'COVARIANT',
                composedVariance: 'COVARIANT',
                declarationSyntax: 'FUNCTION_TYPE',
                isActualCallSiteArgument: false
              }
            ]
          }
        );
        childProofs.push(retProof);
      }
    }

    // Aggregate child proofs
    const firstIncomp = childProofs.find(p => p.status === 'INCOMPATIBLE');
    if (firstIncomp) {
      const rootTree = ProofTreeBuilder.createIncompatibleNode({
        relation: 'PARAMETER_ACCEPTS_ARGUMENT',
        rule: 'CALL_SITE_OBLIGATION_CONJUNCTION',
        adapterId: 'typescript',
        adapterVersion: '1.0.0',
        ruleNamespace: 'typescript-compatibility-v1',
        source: candTypeIR,
        target: usageContract.expectedType,
        sourceHash: candTypeIR.irContentHash,
        targetHash: usageContract.expectedType.irContentHash,
        effectivePolicy: policy as any,
        children: childProofs,
        witness: firstIncomp.witness,
        aggregationMode: 'UNIVERSAL_CONJUNCTION'
      });
      const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        rootTree,
        firstIncomp.witness!,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'INCOMPATIBLE',
        reason: 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE',
        phase4Evidence: incompEv
      };
    }

    const firstUndec = childProofs.find(p => p.status === 'UNDECIDABLE');
    if (firstUndec) {
      const rootTree = ProofTreeBuilder.createUndecidableNode({
        relation: 'PARAMETER_ACCEPTS_ARGUMENT',
        rule: 'CALL_SITE_OBLIGATION_CONJUNCTION',
        adapterId: 'typescript',
        adapterVersion: '1.0.0',
        ruleNamespace: 'typescript-compatibility-v1',
        source: candTypeIR,
        target: usageContract.expectedType,
        sourceHash: candTypeIR.irContentHash,
        targetHash: usageContract.expectedType.irContentHash,
        effectivePolicy: policy as any,
        children: childProofs,
        blockers: firstUndec.blockers,
        aggregationMode: 'UNIVERSAL_CONJUNCTION'
      });
      const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        'CALL_SITE',
        firstUndec.blockers,
        rootTree,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'UNDECIDABLE',
        reason: firstUndec.blockers[0]?.blockerId ?? null,
        phase4Evidence: undecEv
      };
    }

    // All compatible
    const rootTree = ProofTreeBuilder.createCompatibleNode({
      relation: 'PARAMETER_ACCEPTS_ARGUMENT',
      rule: 'CALL_SITE_OBLIGATION_CONJUNCTION',
      rulePremises: [
        {
          premiseId: 'ALL_ARGUMENTS_ACCEPTED',
          description: 'All call arguments accepted and return obligation satisfied',
          verified: true
        }
      ],
      dischargedObligations: ['CALL_SITE_COMPATIBILITY'],
      adapterId: 'typescript',
      adapterVersion: '1.0.0',
      ruleNamespace: 'typescript-compatibility-v1',
      source: candTypeIR,
      target: usageContract.expectedType,
      sourceHash: candTypeIR.irContentHash,
      targetHash: usageContract.expectedType.irContentHash,
      effectivePolicy: policy as any,
      children: childProofs,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    });

    const compEv = ProofTreeBuilder.buildProofEvidence(
      site.usageSiteId,
      site.canonicalOccurrence.occurrenceId,
      this.obligation?.mutatedSymbol?.symbolId ?? 'target',
      'CALL_SITE',
      usageContract,
      rootTree,
      policy as any,
      site.canonicalOccurrence.occurrenceId,
      undefined,
      candidateContractIR
    );

    return {
      status: 'COMPATIBLE',
      reason: null,
      phase4Evidence: compEv
    };
  }

  private buildResultFromProof(
    site: UsageSite,
    usageContract: import('@sajimora/core').SpecializedUsageContract<TypeScriptTypeIR>,
    candidateContractIR: import('@sajimora/core').LanguageContractIR<TypeScriptTypeIR> | undefined,
    proof: import('@sajimora/core').TypeRelationResult,
    policy: TypeScriptPolicy
  ): CompatibilityResult {
    if (proof.status === 'COMPATIBLE') {
      const compEv = ProofTreeBuilder.buildProofEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        usageContract.usageRole,
        usageContract,
        proof,
        policy as any,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'COMPATIBLE',
        reason: null,
        phase4Evidence: compEv
      };
    }

    if (proof.status === 'INCOMPATIBLE') {
      const incompEv = ProofTreeBuilder.buildIncompatibleEvidence(
        site.usageSiteId,
        site.canonicalOccurrence.occurrenceId,
        this.obligation?.mutatedSymbol?.symbolId ?? 'target',
        usageContract.usageRole,
        proof,
        proof.witness!,
        usageContract,
        site.canonicalOccurrence.occurrenceId,
        undefined,
        candidateContractIR
      );
      return {
        status: 'INCOMPATIBLE',
        reason: 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE',
        phase4Evidence: incompEv
      };
    }

    const undecEv = ProofTreeBuilder.buildUndecidableEvidence(
      site.usageSiteId,
      site.canonicalOccurrence.occurrenceId,
      this.obligation?.mutatedSymbol?.symbolId ?? 'target',
      usageContract.usageRole,
      proof.blockers,
      proof,
      usageContract,
      site.canonicalOccurrence.occurrenceId,
      undefined,
      candidateContractIR
    );
    return {
      status: 'UNDECIDABLE',
      reason: proof.blockers[0]?.blockerId ?? null,
      phase4Evidence: undecEv
    };
  }

  private evaluateSignatureMutation(site: UsageSite): CompatibilityResult {
    const { usageRole, sourceFile, sourceSpan } = site.canonicalOccurrence;
    const obligation = this.obligation!;

    if (usageRole !== 'CALL_SITE') {
      return { status: 'UNDECIDABLE', reason: null };
    }

    if (!obligation.providerContracts) {
      return { status: 'UNDECIDABLE', reason: null };
    }

    if (!this.context) {
      return { status: 'UNDECIDABLE', reason: null };
    }

    const sf = this.context.getSourceFile(sourceFile);
    if (!sf) {
      return { status: 'UNDECIDABLE', reason: null };
    }

    const call = this.findEnclosingCall(sf, sourceSpan.start, sourceSpan.end);
    if (!call) {
      return { status: 'UNDECIDABLE', reason: null };
    }

    const after = obligation.providerContracts.after;
    const afterParams = after.parameters ?? [];
    const afterRequired = afterParams.filter((p) => p.isRequired).length;
    const argsCount = call.arguments.length;

    if (argsCount < afterRequired) {
      return { status: 'INCOMPATIBLE', reason: 'REQUIRED_PARAMETER_ADDED' };
    }

    const checker = this.context.getTypeChecker();
    for (let i = 0; i < Math.min(argsCount, afterParams.length); i++) {
      let argTypeStr: string;
      try {
        const argType = checker.getTypeAtLocation(call.arguments[i]);
        argTypeStr = checker.typeToString(argType);
      } catch {
        return { status: 'UNDECIDABLE', reason: null };
      }

      const paramTypeStr = afterParams[i].type;
      const compat = evaluateParamTypeCompatibility(argTypeStr, paramTypeStr);

      if (compat === 'UNDECIDABLE') {
        return { status: 'UNDECIDABLE', reason: null };
      }
      if (compat === 'INCOMPATIBLE') {
        return { status: 'INCOMPATIBLE', reason: 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE' };
      }
    }

    return { status: 'COMPATIBLE', reason: null };
  }

  private findEnclosingCall(sf: ts.SourceFile, start: number, end: number): ts.CallExpression | undefined {
    let match: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (start < node.getFullStart() || end > node.getEnd()) return;
      if (ts.isCallExpression(node)) match = node;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return match;
  }
}
