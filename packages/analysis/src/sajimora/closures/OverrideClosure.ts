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

export class OverrideClosure {
  /**
   * Evaluates all method/property override relationships across class hierarchies.
   * Disambiguates overloaded methods by signature identity rather than declaration index.
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
          if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
            const memberName = node.name.getText(sf);
            if (memberName === targetSymbolName) {
              const classDecl = node.parent;
              if (ts.isClassDeclaration(classDecl) && classDecl.heritageClauses) {
                // Check if class extends a base class containing this member
                for (const clause of classDecl.heritageClauses) {
                  if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                    for (const typeNode of clause.types) {
                      const baseType = checker.getTypeAtLocation(typeNode);
                      const baseMember = baseType.getProperty(memberName);
                      if (baseMember && extractor.matchSymbolWithTarget(baseMember, targetSymbol)) {
                        const sfNorm = sf.fileName.replace(/\\/g, '/');
                        const start = node.name.getStart(sf);
                        const end = node.name.getEnd();
                        const lc = sf.getLineAndCharacterOfPosition(start);
                        const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);

                        occurrences.push({
                          occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:METHOD_OVERRIDE`,
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
                          syntaxKind: node.kind,
                          semanticRole: 'VALUE',
                          usageRole: 'METHOD_OVERRIDE',
                          referencedSymbol: targetSymbolId,
                          declarationSymbol: extractor.getDeclarationSymbol(baseMember),
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
                }
              }
            }
          }
        } catch (err: any) {
          completeness = 'INCOMPLETE';
          failures.push({ file: sf.fileName, cause: `OVERRIDE_TRAVERSAL_ERROR: ${err.message}` });
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const evidence: ClosureEvidence = {
      closureName: 'OverrideClosure',
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
