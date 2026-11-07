import * as ts from 'typescript';
import {
  SymbolRef,
  getSymbolName,
  getSymbolPersistentId,
  ClosureEvidence,
  CanonicalReferenceOccurrence,
  RepositoryAnalysisUniverse,
  normalizeModuleIdentity,
  enforceAmbiguityPoisoning
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { CanonicalExtractor } from '../extractor/CanonicalExtractor';

export class InterfaceImplClosure {
  /**
   * Evaluates all declared `implements` relationships to the target symbol.
   * ABSOLUTE INVARIANT: Only syntactically and semantically declared `implements` relationships enter.
   * Structural assignability must NEVER create an implementation edge.
   */
  public execute(
    contextOrProgram: AnalysisContext | ts.Program,
    targetSymbol: SymbolRef,
    universeOrFiles: RepositoryAnalysisUniverse | string[]
  ): ClosureEvidence {
    const { context, universe } = this.resolveContextAndUniverse(contextOrProgram, universeOrFiles);
    const checker = context.getTypeChecker();
    const extractor = new CanonicalExtractor(context, universe);

    const targetSymbolName = getSymbolName(targetSymbol);
    const targetSymbolId = getSymbolPersistentId(targetSymbol);

    const occurrences: CanonicalReferenceOccurrence[] = [];
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    let completeness: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';

    const sourceFiles = context.getUniverseSourceFiles();

    for (const sf of sourceFiles) {
      const checker = context.getTypeChecker(sf);
      const visit = (node: ts.Node) => {
        try {
          if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) {
            for (const typeNode of node.types) {
              const sym = checker.getSymbolAtLocation(typeNode.expression);
              if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
                const sfNorm = sf.fileName.replace(/\\/g, '/');
                const start = typeNode.getStart(sf);
                const end = typeNode.getEnd();
                const lc = sf.getLineAndCharacterOfPosition(start);
                const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);

                occurrences.push({
                  occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:INTERFACE_IMPLEMENTATION`,
                  sourceFile: sfNorm,
                  consumerFile: sfNorm,
                  sourceSpan: {
                    start,
                    end,
                    line: lc.line + 1,
                    column: lc.character + 1
                  },
                  location: {
                    line: lc.line + 1,
                    column: lc.character + 1
                  },
                  syntaxKind: typeNode.kind,
                  semanticRole: 'TYPE',
                  usageRole: 'INTERFACE_IMPLEMENTATION',
                  referencedSymbol: targetSymbolId,
                  declarationSymbol: sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  resolutionStatus: 'RESOLVED',
                  enumerationStatus: 'COMPLETE',
                  provenance: [
                    {
                      hopKind: 'INHERITANCE',
                      fromModuleIdentity: modId,
                      fromSpan: { line: lc.line + 1, column: lc.character + 1 },
                      toModuleIdentity: modId,
                      toSpan: { line: lc.line + 1, column: lc.character + 1 },
                      symbolName: targetSymbolName
                    }
                  ]
                });
              }
            }
          }
        } catch (err: any) {
          completeness = 'INCOMPLETE';
          failures.push({ file: sf.fileName, cause: `INTERFACE_IMPL_ERROR: ${err.message}` });
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const evidence: ClosureEvidence = {
      closureName: 'InterfaceImplClosure',
      occurrences,
      completeness,
      failures,
      ambiguities,
      unrecognizedForms: [],
      provenance: [],
      status: completeness === 'COMPLETE' ? 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE' : 'INCOMPLETE'
    };

    return enforceAmbiguityPoisoning(evidence);
  }

  private symbolMatchesTarget(
    sym: ts.Symbol | undefined,
    target: SymbolRef,
    extractor: CanonicalExtractor
  ): boolean {
    return extractor.matchSymbolWithTarget(sym, target);
  }

  private resolveContextAndUniverse(
    contextOrProgram: AnalysisContext | ts.Program,
    universeOrFiles: RepositoryAnalysisUniverse | string[]
  ): { context: AnalysisContext; universe: RepositoryAnalysisUniverse } {
    if (contextOrProgram instanceof AnalysisContext) {
      const universe = Array.isArray(universeOrFiles)
        ? {
            rootPath: process.cwd().replace(/\\/g, '/'),
            discoveredFiles: universeOrFiles,
            discoveredFileSet: new Set(universeOrFiles),
            excludedFiles: new Map(),
            unsupportedFiles: [],
            unreadableFiles: [],
            parseFailures: new Map(),
            discoveryStatus: 'DISCOVERY_COMPLETE' as const,
            discoveryEvidence: 'Direct universe input'
          }
        : universeOrFiles;
      return { context: contextOrProgram, universe };
    }

    const program = contextOrProgram as ts.Program;
    const files = Array.isArray(universeOrFiles) ? universeOrFiles : universeOrFiles.discoveredFiles;
    const universe: RepositoryAnalysisUniverse = {
      rootPath: process.cwd().replace(/\\/g, '/'),
      discoveredFiles: files,
      discoveredFileSet: new Set(files),
      excludedFiles: new Map(),
      unsupportedFiles: [],
      unreadableFiles: [],
      parseFailures: new Map(),
      discoveryStatus: 'DISCOVERY_COMPLETE',
      discoveryEvidence: 'Program wrapper'
    };
    const context = new AnalysisContext(universe, {
      compilerHost: {
        getSourceFile: (f, l) => program.getSourceFile(f),
        getDefaultLibFileName: o => ts.getDefaultLibFileName(o),
        writeFile: () => {},
        getCurrentDirectory: () => process.cwd(),
        getDirectories: () => [],
        getCanonicalFileName: f => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: f => program.getSourceFile(f) !== undefined,
        readFile: f => program.getSourceFile(f)?.text ?? ''
      }
    });

    return { context, universe };
  }
}
