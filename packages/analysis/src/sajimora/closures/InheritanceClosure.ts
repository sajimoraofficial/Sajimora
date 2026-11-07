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

export class InheritanceClosure {
  /**
   * Evaluates all inheritance relationships (`extends`) to the target symbol.
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
    // knownDescendantsOfTarget: the set of class/interface symbols that are known to
    // transitively inherit from targetSymbol. On each fixpoint iteration, newly-discovered
    // descendants are added so the next pass can find their own descendants.
    const knownDescendantsOfTarget = new Set<ts.Symbol>();
    const seenOccurrenceKeys = new Set<string>();

    let newDescendantAdded = true;
    let iterationCount = 0;
    const maxIterations = 100;

    while (newDescendantAdded && iterationCount < maxIterations) {
      newDescendantAdded = false;
      iterationCount++;
      // console.log(`[DEBUG] InheritanceClosure pass ${iterationCount}`);

      for (const sf of sourceFiles) {
        const checker = context.getTypeChecker(sf);
        const visit = (node: ts.Node) => {
          try {
            if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) {
              for (const typeNode of node.types) {
                const sym = checker.getSymbolAtLocation(typeNode.expression);
                const isDirectTarget = this.symbolMatchesTarget(sym, targetSymbol, extractor);
                const isDerivedDescendant = sym ? this.matchesAnyKnownDescendant(sym, knownDescendantsOfTarget, checker) : false;

                if (isDirectTarget || isDerivedDescendant) {
                  if (sym && !knownDescendantsOfTarget.has(sym)) {
                    knownDescendantsOfTarget.add(sym);
                  }

                  const parentDecl = node.parent;
                  let childSym: ts.Symbol | undefined;
                  if ((ts.isClassDeclaration(parentDecl) || ts.isInterfaceDeclaration(parentDecl)) && parentDecl.name) {
                    childSym = checker.getSymbolAtLocation(parentDecl.name);
                  }
                  if (childSym && !knownDescendantsOfTarget.has(childSym)) {
                    knownDescendantsOfTarget.add(childSym);
                    newDescendantAdded = true;
                  }

                  const sfNorm = sf.fileName.replace(/\\/g, '/');
                  const start = typeNode.getStart(sf);
                  const end = typeNode.getEnd();
                  const lc = sf.getLineAndCharacterOfPosition(start);
                  const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);
                  const occKey = `${modId}:${lc.line + 1}:${lc.character + 1}:INHERITANCE`;

                  if (!seenOccurrenceKeys.has(occKey)) {
                    seenOccurrenceKeys.add(occKey);
                    occurrences.push({
                      occurrenceId: occKey,
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
                      usageRole: 'INHERITANCE',
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
                          symbolName: sym ? sym.name : targetSymbolName
                        }
                      ]
                    });
                  }
                }
              }
            }
          } catch (err: any) {
            completeness = 'INCOMPLETE';
            failures.push({ file: sf.fileName, cause: `INHERITANCE_TRAVERSAL_ERROR: ${err.message}` });
          }

          ts.forEachChild(node, visit);
        };

        visit(sf);
      }
    }

    // Safety-limit breach: the fixpoint did not converge within maxIterations.
    // This can only occur in pathological inheritance graphs with > 100 transitive
    // levels. The result is provably incomplete — surface it explicitly rather than
    // silently returning a truncated (and therefore potentially wrong) closure.
    if (iterationCount >= maxIterations && newDescendantAdded) {
      completeness = 'INCOMPLETE';
      failures.push({
        file: 'INHERITANCE_FIXPOINT',
        cause: 'FIXPOINT_ITERATION_LIMIT_EXCEEDED'
      });
    }

    occurrences.sort((a, b) => {
      if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
      return a.sourceSpan.start - b.sourceSpan.start || a.sourceSpan.end - b.sourceSpan.end;
    });

    const evidence: ClosureEvidence = {
      closureName: 'InheritanceClosure',
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

  private matchesAnyKnownDescendant(
    sym: ts.Symbol,
    knownDescendants: Set<ts.Symbol>,
    checker: ts.TypeChecker
  ): boolean {
    if (knownDescendants.has(sym)) return true;
    let curr: ts.Symbol | undefined = sym;
    if (curr.flags & ts.SymbolFlags.Alias) {
      try {
        const aliased = checker.getAliasedSymbol(curr);
        if (aliased && knownDescendants.has(aliased)) return true;
      } catch {}
    }
    return false;
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
