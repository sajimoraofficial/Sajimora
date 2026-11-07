import * as ts from 'typescript';
import {
  SymbolRef,
  getSymbolName,
  ClosureEvidence,
  CanonicalReferenceOccurrence,
  RepositoryAnalysisUniverse,
  normalizeModuleIdentity,
  enforceAmbiguityPoisoning
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { CanonicalExtractor } from '../extractor/CanonicalExtractor';

export class AmbientReferenceClosure {
  /**
   * Evaluates all ambient and global augmentation relationships to the target symbol.
   * Scans parsed `.d.ts` files and project sources for `declare global` and ambient module augmentations.
   */
  public execute(
    contextOrProgram: AnalysisContext | ts.Program,
    targetSymbol: SymbolRef,
    universeOrFiles: RepositoryAnalysisUniverse | string[]
  ): ClosureEvidence {
    const { context, universe } = this.resolveContextAndUniverse(contextOrProgram, universeOrFiles);
    const checker = context.getTypeChecker();
    const extractor = new CanonicalExtractor(context, universe);

    const occurrences: CanonicalReferenceOccurrence[] = [];
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    let completeness: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';

    const sourceFiles = context.getUniverseSourceFiles();

    for (const sf of sourceFiles) {
      const sfNorm = sf.fileName.replace(/\\/g, '/');
      const checker = context.getTypeChecker(sf);

      const visit = (node: ts.Node) => {
        try {
          // Detect declare global { ... } or declare module "..." { ... }
          if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation || ts.isStringLiteral(node.name))) {
            if (node.body && ts.isModuleBlock(node.body)) {
              for (const statement of node.body.statements) {
                const targetId = getSymbolName(targetSymbol);
                if (
                  (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) &&
                  statement.name &&
                  statement.name.getText(sf) === targetId
                ) {
                  const start = statement.getStart(sf);
                  const end = statement.getEnd();
                  const lc = sf.getLineAndCharacterOfPosition(start);
                  const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);
                  const sym = checker.getSymbolAtLocation(statement.name);

                  occurrences.push({
                    occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:AMBIENT_AUGMENTATION`,
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
                    syntaxKind: statement.kind,
                    semanticRole: 'TYPE',
                    usageRole: 'AMBIENT_AUGMENTATION',
                    referencedSymbol: targetId,
                    declarationSymbol: (sym ? extractor.getDeclarationSymbol(sym) : targetId) || targetId,
                    resolutionStatus: 'RESOLVED',
                    enumerationStatus: 'COMPLETE',
                    provenance: [
                      {
                        hopKind: 'DIRECT_IMPORT',
                        fromModuleIdentity: modId,
                        fromSpan: { line: lc.line + 1, column: lc.character + 1 },
                        toModuleIdentity: modId,
                        toSpan: { line: lc.line + 1, column: lc.character + 1 },
                        symbolName: targetId
                      }
                    ]
                  });
                }

                if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) {
                  for (const member of statement.members) {
                    if (member.name && member.name.getText(sf) === targetId) {
                      const start = member.getStart(sf);
                      const end = member.getEnd();
                      const lc = sf.getLineAndCharacterOfPosition(start);
                      const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);
                      const sym = checker.getSymbolAtLocation(member.name);

                      occurrences.push({
                        occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:AMBIENT_AUGMENTATION`,
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
                        syntaxKind: member.kind,
                        semanticRole: 'TYPE',
                        usageRole: 'AMBIENT_AUGMENTATION',
                        referencedSymbol: targetId,
                        declarationSymbol: (sym ? extractor.getDeclarationSymbol(sym) : targetId) || targetId,
                        resolutionStatus: 'RESOLVED',
                        enumerationStatus: 'COMPLETE',
                        provenance: [
                          {
                            hopKind: 'DIRECT_IMPORT',
                            fromModuleIdentity: modId,
                            fromSpan: { line: lc.line + 1, column: lc.character + 1 },
                            toModuleIdentity: modId,
                            toSpan: { line: lc.line + 1, column: lc.character + 1 },
                            symbolName: targetId
                          }
                        ]
                      });
                    }
                  }
                } else if (ts.isVariableStatement(statement)) {
                  for (const decl of statement.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name) && decl.name.getText(sf) === targetId) {
                      const start = decl.getStart(sf);
                      const end = decl.getEnd();
                      const lc = sf.getLineAndCharacterOfPosition(start);
                      const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);
                      const sym = checker.getSymbolAtLocation(decl.name);

                      occurrences.push({
                        occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:AMBIENT_AUGMENTATION`,
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
                        syntaxKind: statement.kind,
                        semanticRole: 'TYPE',
                        usageRole: 'AMBIENT_AUGMENTATION',
                        referencedSymbol: targetId,
                        declarationSymbol: (sym ? extractor.getDeclarationSymbol(sym) : targetId) || targetId,
                        resolutionStatus: 'RESOLVED',
                        enumerationStatus: 'COMPLETE',
                        provenance: [
                          {
                            hopKind: 'DIRECT_IMPORT',
                            fromModuleIdentity: modId,
                            fromSpan: { line: lc.line + 1, column: lc.character + 1 },
                            toModuleIdentity: modId,
                            toSpan: { line: lc.line + 1, column: lc.character + 1 },
                            symbolName: targetId
                          }
                        ]
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (err: unknown) {
          completeness = 'INCOMPLETE';
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ file: sf.fileName, cause: `AMBIENT_TRAVERSAL_ERROR: ${message}` });
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const evidence: ClosureEvidence = {
      closureName: 'AmbientReferenceClosure',
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
