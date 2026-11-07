import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import {
  LanguageAdapter,
  LanguageContractIR,
  SpecializedUsageContract,
  ExtractionOptions,
  ExtractionResult,
  SpecializationResult,
  canonicalJson
} from '@sajimora/core';
import { TypeScriptTypeIR } from './ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from './ir/TypeScriptTypeIRExtractor';
import {
  TypeScriptPolicy,
  TypeScriptSemanticRuleSet
} from './compatibility/TypeScriptSemanticRules';
import { DualProgramContext } from './specialization/TypeScriptUsageSpecializer';

export class TypeScriptLanguageAdapter
  implements LanguageAdapter<TypeScriptTypeIR, TypeScriptPolicy, DualProgramContext, ts.Node>
{
  public readonly languageId = 'typescript';
  public readonly schemaVersion = '1.0.0';
  public readonly semanticRules = new TypeScriptSemanticRuleSet();

  public extractTypeIR(
    node: ts.Node,
    snapshot: DualProgramContext,
    options?: ExtractionOptions
  ): ExtractionResult<TypeScriptTypeIR> {
    const checker = snapshot.parentProgram.getTypeChecker();
    const typeIR = TypeScriptTypeIRExtractor.extractFromNode(node, checker, 'PARENT', {
      ...options,
      snapshotRoot: snapshot.parentProgram.getCurrentDirectory(),
      program: snapshot.parentProgram
    });
    if (typeIR.kind === 'UNSUPPORTED') {
      return {
        success: false,
        typeIR,
        blockerId: typeIR.blockerId,
        errorDetail: typeIR.rawSyntaxSnippet
      };
    }
    return {
      success: true,
      typeIR
    };
  }

  public extractContract(
    declarationNode: ts.Node,
    snapshot: DualProgramContext
  ): LanguageContractIR<TypeScriptTypeIR> {
    const program = snapshot.candidateProgram ?? snapshot.parentProgram;
    const checker = program.getTypeChecker();
    const sf = declarationNode.getSourceFile();
    const snapshotName = snapshot.candidateProgram ? 'CANDIDATE' : 'PARENT';

    let symbol: ts.Symbol | undefined;
    if ((declarationNode as any).name) {
      symbol = checker.getSymbolAtLocation((declarationNode as any).name);
    }
    if (!symbol && (declarationNode as any).symbol) {
      symbol = (declarationNode as any).symbol;
    }

    let declKind: LanguageContractIR<TypeScriptTypeIR>['declarationKind'] = 'VARIABLE';
    if (ts.isFunctionDeclaration(declarationNode)) declKind = 'FUNCTION';
    else if (ts.isMethodDeclaration(declarationNode)) declKind = 'METHOD';
    else if (ts.isClassDeclaration(declarationNode)) declKind = 'CLASS';
    else if (ts.isInterfaceDeclaration(declarationNode)) declKind = 'INTERFACE';
    else if (ts.isTypeAliasDeclaration(declarationNode)) declKind = 'TYPE_ALIAS';
    else if (ts.isEnumDeclaration(declarationNode)) declKind = 'ENUM';
    else if (ts.isModuleDeclaration(declarationNode)) declKind = 'MODULE';

    const normFile = sf ? TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, program) : 'unknown';
    const symbolName = symbol ? symbol.getName() : ((declarationNode as any).name?.text ?? 'anonymous');

    let ordinal = 0;
    if (sf) {
      let count = 0;
      const findOrdinal = (n: ts.Node) => {
        if (n === declarationNode) {
          ordinal = count;
          return;
        }
        if ((n as any).name && (n as any).name.text === symbolName) {
          count++;
        }
        ts.forEachChild(n, findOrdinal);
      };
      findOrdinal(sf);
    }

    const qualifiedName = `${normFile}#${symbolName}`;
    const symbolId = `${normFile}.${declKind}:${symbolName}@${ordinal}`;

    const contractType = TypeScriptTypeIRExtractor.extractFromNode(
      declarationNode,
      checker,
      snapshotName,
      {
        snapshotRoot: program.getCurrentDirectory(),
        program
      }
    );

    const contractHash = crypto
      .createHash('sha256')
      .update(`CONTRACT_IR\0${this.languageId}\0${symbolId}\0${contractType.irContentHash}`, 'utf8')
      .digest('hex');

    return {
      schemaVersion: 'SAJIMORA_LANGUAGE_CONTRACT_V1',
      languageId: this.languageId,
      symbolId,
      qualifiedName,
      declarationKind: declKind,
      contractType,
      contractHash
    };
  }

  public extractUsageContract(
    usageNode: ts.Node,
    snapshot: DualProgramContext
  ): SpecializedUsageContract<TypeScriptTypeIR> {
    const checker = snapshot.parentProgram.getTypeChecker();
    const expectedType = TypeScriptTypeIRExtractor.extractFromNode(usageNode, checker, 'PARENT');

    return {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: this.languageId,
      usageRole: 'CALL_SITE',
      expectedType,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      usageHash: expectedType.irContentHash
    };
  }

  public specializeUsage(
    historicalUsage: SpecializedUsageContract<TypeScriptTypeIR>,
    candidateDeclaration: LanguageContractIR<TypeScriptTypeIR>,
    _policy: TypeScriptPolicy
  ): SpecializationResult<TypeScriptTypeIR> {
    if (!historicalUsage.hasCompleteSpecializationEvidence) {
      return {
        success: false,
        blockerId: 'HISTORICAL_USAGE_SPECIALIZATION_INCOMPLETE',
        errorDetail: 'Historical usage contract lacks complete specialization evidence'
      };
    }

    return {
      success: true,
      specializedContract: historicalUsage
    };
  }

  public hashTypeIR(typeIR: TypeScriptTypeIR): string {
    return typeIR.irContentHash;
  }

  public hashPolicy(policy: TypeScriptPolicy): string {
    const sortedTypedFlags: ReadonlyArray<[string, 'boolean' | 'string' | 'number', boolean | string | number]> = [
      ['strictFunctionTypes', 'boolean', policy.strictFunctionTypes],
      ['strictNullChecks', 'boolean', policy.strictNullChecks]
    ];
    const canonical = canonicalJson(sortedTypedFlags);
    return crypto
      .createHash('sha256')
      .update(`SAJIMORA_POLICY_V1\0${this.languageId}\0${canonical}`, 'utf8')
      .digest('hex');
  }
}
