import { LanguageContractIR, SpecializedUsageContract, UsageRole } from '@sajimora/core';
import { TypeScriptTypeIR } from '../languages/typescript/ir/TypeScriptTypeIR';

export interface IndexedFileFact {
  readonly projectId: string;
  readonly normalizedPath: string;
  readonly sourceHash: string;
  readonly isDeclarationFile: boolean;
}

export interface IndexedDeclarationFact {
  readonly projectId: string;
  readonly declarationId: string;
  readonly persistentSymbolId: string;
  readonly localName: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly exported: boolean;
  readonly contract: LanguageContractIR<TypeScriptTypeIR>;
  readonly contractHash: string;
}

export interface IndexedConsumerFact {
  readonly projectId: string;
  readonly occurrenceId: string;
  readonly targetDeclarationId: string;
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly usageRole: UsageRole;
  readonly historicalUsage: SpecializedUsageContract<TypeScriptTypeIR>;
}

export interface IndexedModuleEdgeFact {
  readonly projectId: string;
  readonly sourceFile: string;
  readonly moduleSpecifier: string;
  readonly edgeKind: 'IMPORT' | 'EXPORT';
}

export interface IndexedDiagnosticFact {
  readonly projectId: string;
  readonly code: number;
  readonly category: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly character: number | null;
  readonly message: string;
}
