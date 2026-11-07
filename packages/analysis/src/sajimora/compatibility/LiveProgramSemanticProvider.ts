import * as ts from 'typescript';
import {
  ProofObligation,
  UsageSite,
  getSymbolName
} from '@sajimora/core';
import {
  Phase4SemanticProvider,
  ProviderCandidateContract,
  ProviderHistoricalObligation
} from './Phase4SemanticProvider';
import { TypeScriptLanguageAdapter } from '../languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptUsageSpecializer } from '../languages/typescript/specialization/TypeScriptUsageSpecializer';
import { TypeScriptTypeIRExtractor } from '../languages/typescript/ir/TypeScriptTypeIRExtractor';

export interface LiveProgramSemanticProviderInput {
  readonly parentProgram: ts.Program;
  readonly candidateProgram: ts.Program;
  readonly candidatePrograms?: readonly ts.Program[];
  readonly obligation?: ProofObligation;
  readonly candidateDeclarationNode?: ts.Node;
}

/**
 * Adapter that satisfies Phase4SemanticProvider using live compiler programs.
 * Constructed exclusively at the orchestration boundary (e.g. TypeScriptV1Adapter / PipelineB).
 * Never constructed inside TypeScriptCompatibility.
 */
export class LiveProgramSemanticProvider implements Phase4SemanticProvider {
  private readonly input: LiveProgramSemanticProviderInput;
  private readonly adapter = new TypeScriptLanguageAdapter();

  constructor(
    inputOrParent: LiveProgramSemanticProviderInput | ts.Program,
    candidateProgram?: ts.Program,
    obligation?: ProofObligation,
    candidateDeclarationNode?: ts.Node
  ) {
    if (inputOrParent && typeof (inputOrParent as any).getTypeChecker === 'function') {
      this.input = {
        parentProgram: inputOrParent as ts.Program,
        candidateProgram: candidateProgram!,
        obligation,
        candidateDeclarationNode
      };
    } else {
      this.input = inputOrParent as LiveProgramSemanticProviderInput;
    }
  }

  public getCandidateContract(
    targetSymbolId: string,
    targetName: string,
    targetLocation?: string
  ): ProviderCandidateContract {
    const parentProg = this.input.parentProgram;
    const candProg = this.input.candidateProgram;

    let candDeclNode = this.input.candidateDeclarationNode;
    let effectiveCandProg: ts.Program | undefined = candProg;

    const candProgsToSearch: ts.Program[] = [
      candProg,
      ...(this.input.candidatePrograms ?? []).filter(p => p && p !== candProg)
    ].filter(Boolean) as ts.Program[];

    if (!candDeclNode && (targetLocation || targetName)) {
      const targetLoc = targetLocation;
      if (targetLoc) {
        const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
        const normTargetParent = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, parentProg));
        const targetLocNorm = clean(targetLoc);
        const stripExt = (p: string) => p.replace(/\.[a-zA-Z0-9]+$/, '');

        for (const prog of candProgsToSearch) {
          const normTargetCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, prog));
          for (const sf of prog.getSourceFiles()) {
            const rel = clean(sf.fileName);
            const normCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, prog));
            const matchesFile = (
              normCand === normTargetCand ||
              normCand === normTargetParent ||
              (normTargetCand.length > 0 && stripExt(normTargetCand) === stripExt(normCand)) ||
              (normTargetParent.length > 0 && stripExt(normTargetParent) === stripExt(normCand)) ||
              rel.toLowerCase() === targetLocNorm.toLowerCase() ||
              (targetLocNorm.length > 0 && rel.toLowerCase().endsWith('/' + targetLocNorm.toLowerCase())) ||
              (rel.length > 0 && targetLocNorm.toLowerCase().endsWith('/' + rel.toLowerCase())) ||
              TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, targetLoc) >= 2
            );
            if (matchesFile) {
              for (const stmt of sf.statements) {
                if ((stmt as any).name && (stmt as any).name.text === targetName) {
                  candDeclNode = stmt;
                  effectiveCandProg = prog;
                  break;
                }
                if (ts.isVariableStatement(stmt)) {
                  for (const decl of stmt.declarationList.declarations) {
                    if ((decl.name as any).text === targetName) {
                      candDeclNode = decl;
                      effectiveCandProg = prog;
                      break;
                    }
                  }
                  if (candDeclNode) break;
                }
              }
              if (candDeclNode) break;
            }
          }
          if (candDeclNode) break;
        }
      }
      const isDeleted = this.input.obligation?.providerMutation?.classification === 'SYMBOL_DELETED';
      if (!candDeclNode && targetName && !targetLocation && !isDeleted) {
        for (const prog of candProgsToSearch) {
          for (const sf of prog.getSourceFiles()) {
            if (sf.isDeclarationFile) continue;
            for (const stmt of sf.statements) {
              if ((stmt as any).name && (stmt as any).name.text === targetName) {
                candDeclNode = stmt;
                effectiveCandProg = prog;
                break;
              }
              if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                  if ((decl.name as any).text === targetName) {
                    candDeclNode = decl;
                    effectiveCandProg = prog;
                    break;
                  }
                }
                if (candDeclNode) break;
              }
            }
            if (candDeclNode) break;
          }
          if (candDeclNode) break;
        }
      }
    }

    if (!candDeclNode) {
      const isDeleted = this.input.obligation?.providerMutation?.classification === 'SYMBOL_DELETED';
      return {
        targetSymbolId,
        targetName,
        isDeleted,
        blockerId: isDeleted ? undefined : 'CANDIDATE_DECLARATION_MISSING',
        errorDetail: isDeleted ? undefined : 'Candidate declaration could not be resolved in candidate program'
      };
    }

    const contractIR = this.adapter.extractContract(candDeclNode, {
      parentProgram: parentProg,
      candidateProgram: effectiveCandProg ?? candProg
    });

    return {
      targetSymbolId,
      targetName,
      contractIR
    };
  }

  public getHistoricalObligation(site: UsageSite): ProviderHistoricalObligation {
    const specResult = TypeScriptUsageSpecializer.specializeSite(site, {
      parentProgram: this.input.parentProgram,
      candidateProgram: this.input.candidateProgram
    });

    if (!specResult.success || !specResult.specializedContract) {
      return {
        usageSiteId: site.usageSiteId,
        occurrenceId: site.canonicalOccurrence.occurrenceId,
        blockerId: (specResult.blockerId ?? 'HISTORICAL_EXPECTATION_UNRECOVERABLE') as any,
        errorDetail: specResult.errorDetail ?? 'Historical usage specialization failed'
      };
    }

    let selectedSignatureIndex: number | undefined;
    const candProg = this.input.candidateProgram;
    if (candProg && site.canonicalOccurrence.usageRole === 'CALL_SITE') {
      const candSf = candProg.getSourceFile(site.canonicalOccurrence.sourceFile) ||
        candProg.getSourceFiles().find(sf =>
          sf.fileName.replace(/\\/g, '/').endsWith(site.canonicalOccurrence.sourceFile.replace(/\\/g, '/'))
        );
      if (candSf) {
        let candCallNode: ts.Node | undefined;
        const findCall = (n: ts.Node): void => {
          if (candCallNode) return;
          if (n.getStart(candSf) <= site.canonicalOccurrence.sourceSpan.start && n.getEnd() >= site.canonicalOccurrence.sourceSpan.end) {
            if (ts.isCallExpression(n)) {
              candCallNode = n;
            }
            ts.forEachChild(n, findCall);
          }
        };
        findCall(candSf);
        if (candCallNode && ts.isCallExpression(candCallNode)) {
          const compilerResolvedSig = candProg.getTypeChecker().getResolvedSignature(candCallNode);
          if (compilerResolvedSig) {
            let candDeclNode = this.input.candidateDeclarationNode;
            let candCallSigs: readonly ts.Signature[] | undefined;
            if (candDeclNode) {
              candCallSigs = candProg.getTypeChecker().getTypeAtLocation(candDeclNode).getCallSignatures();
            } else if (compilerResolvedSig.declaration) {
              const declNode = compilerResolvedSig.declaration;
              candCallSigs = candProg.getTypeChecker().getTypeAtLocation((declNode as any).name ?? declNode).getCallSignatures();
            }
            if (candCallSigs) {
              const idx = candCallSigs.indexOf(compilerResolvedSig);
              if (idx !== -1) {
                selectedSignatureIndex = idx;
              }
            }
          }
        }
      }
    }

    return {
      usageSiteId: site.usageSiteId,
      occurrenceId: site.canonicalOccurrence.occurrenceId,
      specializedContract: specResult.specializedContract,
      selectedSignatureIndex
    };
  }
}
