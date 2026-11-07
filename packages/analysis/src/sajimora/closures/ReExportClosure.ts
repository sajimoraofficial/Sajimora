import * as ts from 'typescript';
import {
  SymbolRef,
  getSymbolName,
  getSymbolPersistentId,
  ClosureEvidence,
  CanonicalReferenceOccurrence,
  ProvenanceHop,
  RepositoryAnalysisUniverse,
  isSourceInUniverse,
  normalizeModuleIdentity,
  enforceAmbiguityPoisoning
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { CanonicalExtractor } from '../extractor/CanonicalExtractor';
import { ProvenanceTracer } from './ProvenanceTracer';

export class ReExportClosure {
  /**
   * Evaluates all re-export relationships across modules.
   * Tracks static re-exports, export *, colliding ambiguities, and cycles.
   */
  public execute(
    contextOrProgram: AnalysisContext | ts.Program,
    targetSymbol: SymbolRef,
    universeOrFiles: RepositoryAnalysisUniverse | string[]
  ): ClosureEvidence {
    const { context, universe } = this.resolveContextAndUniverse(contextOrProgram, universeOrFiles);
    const checker = context.getTypeChecker();
    const extractor = new CanonicalExtractor(context, universe);
    const tracer = new ProvenanceTracer(context, universe);

    const targetSymbolName = getSymbolName(targetSymbol);
    const targetSymbolId = getSymbolPersistentId(targetSymbol);

    const occurrences: CanonicalReferenceOccurrence[] = [];
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    let completeness: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';

    const sourceFiles = context.getUniverseSourceFiles();
    const wildcardExportMap = new Map<string, string[]>(); // module -> list of files exporting * from it
    const matchingWildcardModules = new Map<string, Set<string>>(); // module -> set of specifiers exporting target

    // Module re-export graph for cycle detection.
    // Key = source file path (normalised), value = list of source files it re-exports FROM.
    // Built during the flat scan; consumed by detectReExportCycle() post-scan.
    const moduleReExportGraph = new Map<string, string[]>();


    for (const sf of sourceFiles) {
      const sfNorm = sf.fileName.replace(/\\/g, '/');
      const checker = context.getTypeChecker(sf);

      const visit = (node: ts.Node) => {
        try {
          // 1. Static Named Re-Export: export { X } from './a' or export { X as Y } from './a'
          if (ts.isExportDeclaration(node) && node.exportClause && node.moduleSpecifier) {
            if (ts.isNamedExports(node.exportClause)) {
              for (const element of node.exportClause.elements) {
                const exportedName = element.name.text;
                const origName = element.propertyName ? element.propertyName.text : element.name.text;

                const sym = checker.getSymbolAtLocation(element.propertyName ?? element.name);
                // A spelling match is not identity evidence. Retain it only as an
                // explicit unresolved boundary, never as a resolved re-export.
                const isTarget = this.symbolMatchesTarget(sym, targetSymbol, extractor);
                const isNameMatch = origName === targetSymbolName || exportedName === targetSymbolName;
                if (isTarget || isNameMatch) {
                  const start = element.getStart(sf);
                  const end = element.getEnd();
                  const lc = sf.getLineAndCharacterOfPosition(start);
                  const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);

                  let resStatus: 'RESOLVED' | 'UNDECIDABLE' = isTarget ? 'RESOLVED' : 'UNDECIDABLE';
                  if (!isTarget) {
                    resStatus = 'UNDECIDABLE';
                    completeness = 'INCOMPLETE';
                    failures.push({ file: sfNorm, cause: 'PROJECT_REFERENCE_UNRESOLVED_TO_SOURCE' });
                  }

                  occurrences.push({
                    occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:RE_EXPORTER`,
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
                    syntaxKind: element.kind,
                    semanticRole: 'VALUE',
                    usageRole: 'RE_EXPORTER',
                    referencedSymbol: targetSymbolId,
                    declarationSymbol: sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                    resolutionStatus: resStatus,
                    enumerationStatus: 'COMPLETE',
                    provenance: sym ? tracer.traceProvenance(element.name, sym, targetSymbolId, sf) : [
                      {
                        hopKind: 'RE_EXPORT',
                        fromModuleIdentity: modId,
                        fromSpan: { line: lc.line + 1, column: lc.character + 1 },
                        toModuleIdentity: modId,
                        toSpan: { line: lc.line + 1, column: lc.character + 1 },
                        symbolName: exportedName
                      }
                    ]
                  });

                  // Build module graph edge for cycle detection.
                  // Track which source file this module re-exports FROM.
                  if (isTarget || isNameMatch) {
                    const parentModSym = checker.getSymbolAtLocation(node.moduleSpecifier!);
                    if (parentModSym?.declarations) {
                      for (const decl of parentModSym.declarations) {
                        if (ts.isSourceFile(decl)) {
                          const edgeTarget = decl.fileName.replace(/\\/g, '/');
                          const edges = moduleReExportGraph.get(sfNorm) ?? [];
                          edges.push(edgeTarget);
                          moduleReExportGraph.set(sfNorm, edges);
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // 2. Wildcard Re-Export: export * from './a'
          if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
            const specifierText = (node.moduleSpecifier as ts.StringLiteral).text;
            const targetList = wildcardExportMap.get(sfNorm) ?? [];
            targetList.push(specifierText);
            wildcardExportMap.set(sfNorm, targetList);

            const modSym = checker.getSymbolAtLocation(node.moduleSpecifier);
            if (!modSym || !modSym.exports) {
              const isRelated = this.isSourceFileRelatedToTarget(sf, targetSymbolName, targetSymbol, extractor, universe);
              if (isRelated) {
                completeness = 'INCOMPLETE';
                failures.push({ file: sfNorm, cause: 'UNRESOLVED_WILDCARD_EXPORT' });
                const wStart = node.getStart(sf);
                const wEnd = node.getEnd();
                const wLc = sf.getLineAndCharacterOfPosition(wStart);
                const wModId = normalizeModuleIdentity(sf.fileName, universe.rootPath);
                occurrences.push({
                  occurrenceId: `${wModId}:${wLc.line + 1}:${wLc.character + 1}:RE_EXPORTER_STAR_UNRESOLVED`,
                  sourceFile: sfNorm,
                  consumerFile: sfNorm,
                  sourceSpan: { start: wStart, end: wEnd, line: wLc.line + 1, column: wLc.character + 1 },
                  location: { line: wLc.line + 1, column: wLc.character + 1 },
                  syntaxKind: node.kind,
                  semanticRole: 'VALUE',
                  usageRole: 'RE_EXPORTER',
                  referencedSymbol: targetSymbolId,
                  declarationSymbol: targetSymbolId,
                  resolutionStatus: 'UNDECIDABLE',
                  enumerationStatus: 'INCOMPLETE',
                  provenance: []
                });
              }
              return;
            }
            const exported = modSym.exports.get(targetSymbolName as any);

            if (exported) {
              // Any export matching the name contributes to wildcard collisions
              const exporters = matchingWildcardModules.get(sfNorm) ?? new Set<string>();
              exporters.add(specifierText);
              matchingWildcardModules.set(sfNorm, exporters);

              if (this.symbolMatchesTarget(exported, targetSymbol, extractor)) {
                const start = node.getStart(sf);
                const end = node.getEnd();
                const lc = sf.getLineAndCharacterOfPosition(start);
                const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);

                occurrences.push({
                  occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:RE_EXPORTER_STAR`,
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
                  usageRole: 'RE_EXPORTER',
                  referencedSymbol: targetSymbolId,
                  declarationSymbol: targetSymbolId,
                  resolutionStatus: 'RESOLVED',
                  enumerationStatus: 'COMPLETE',
                  provenance: tracer.traceProvenance(node.moduleSpecifier, exported, targetSymbolId, sf)
                });
              }
            }
          }
        } catch (err: unknown) {
          completeness = 'INCOMPLETE';
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ file: sf.fileName, cause: `RE_EXPORT_TRAVERSAL_ERROR: ${message}` });
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    // Detect Colliding Wildcard Exports (Ambiguity Invariant)
    // Only flag collision if 2 or more distinct wildcard re-export sources export the target symbol
    for (const [exporterFile, exportingSpecifiers] of matchingWildcardModules.entries()) {
      if (exportingSpecifiers.size > 1) {
        completeness = 'INCOMPLETE';
        for (const occ of occurrences) {
          if (occ.sourceFile === exporterFile) {
            occ.resolutionStatus = 'AMBIGUOUS';
          }
        }
        ambiguities.push({
          location: exporterFile,
          description: `COLLISION: Colliding wildcard re-exports for symbol '${targetSymbolName}' from [${Array.from(exportingSpecifiers).join(', ')}]`
        });
      }
    }

    // BLOCKER 4 FIX: Cycle detection in the module re-export graph.
    //
    // Invariant: every traversal has a deterministic visited state,
    // cycle encounters are recorded with CYCLIC_REEXPORT evidence,
    // and completeness is downgraded to INCOMPLETE on any cycle.
    //
    // Algorithm: standard DFS with a "recursion stack" (inStack) set.
    // - visited: all modules whose DFS subtree is fully processed (prevents re-processing)
    // - inStack: modules on the current DFS path (detects back-edges = cycles)
    // When inStack.has(current) fires, a cycle is confirmed and recorded.
    {
      const visited = new Set<string>();
      const inStack = new Set<string>();
      for (const startModule of moduleReExportGraph.keys()) {
        if (!visited.has(startModule)) {
          if (this.detectReExportCycle(startModule, moduleReExportGraph, visited, inStack, ambiguities)) {
            completeness = 'INCOMPLETE';
          }
        }
      }
    }

    const evidence: ClosureEvidence = {
      closureName: 'ReExportClosure',
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

  /**
   * DFS cycle detection over the module re-export graph.
   *
   * @param current     Current module being visited
   * @param graph       Adjacency list: module → [modules it re-exports from]
   * @param visited     All modules fully processed (avoids redundant DFS subtrees)
   * @param inStack     Modules on the current DFS path (back-edge = cycle indicator)
   * @param ambiguities Mutable list to which cycle evidence is appended
   * @returns true if a cycle was detected in this DFS subtree
   *
   * Termination: each module is added to `visited` exactly once and removed from
   * `inStack` at end of its recursive frame. The visited guard prevents re-entering
   * any module's subtree, bounding total work to O(|V| + |E|).
   */
  private detectReExportCycle(
    current: string,
    graph: Map<string, string[]>,
    visited: Set<string>,
    inStack: Set<string>,
    ambiguities: { location: string; description: string }[]
  ): boolean {
    // Back-edge detected: current module is already on the DFS path → cycle
    if (inStack.has(current)) {
      ambiguities.push({
        location: current,
        description: `CYCLIC_REEXPORT: re-export cycle detected at module ${current}`
      });
      return true;
    }

    // Already fully processed — no cycle found from this node
    if (visited.has(current)) return false;

    visited.add(current);
    inStack.add(current);

    let hasCycle = false;
    for (const neighbor of (graph.get(current) ?? [])) {
      if (this.detectReExportCycle(neighbor, graph, visited, inStack, ambiguities)) {
        hasCycle = true;
        // Continue traversal to record all cycle evidence, not just the first
      }
    }

    // Remove from recursion stack when backtracking — must not affect sibling paths
    inStack.delete(current);
    return hasCycle;
  }

  private symbolMatchesTarget(
    sym: ts.Symbol | undefined,
    target: SymbolRef,
    extractor: CanonicalExtractor
  ): boolean {
    return extractor.matchSymbolWithTarget(sym, target);
  }

  private isSourceFileRelatedToTarget(
    sf: ts.SourceFile,
    targetName: string,
    targetSymbol: SymbolRef,
    extractor: CanonicalExtractor,
    universe: RepositoryAnalysisUniverse
  ): boolean {
    // 1. Syntactic mention: does sf contain targetName identifier?
    if (extractor.isNodeRelevantToTarget(sf, targetName)) {
      return true;
    }

    const sfNorm = sf.fileName.replace(/\\/g, '/').toLowerCase();
    const targetDeclFile = targetSymbol.declarationLocation?.filePath
      ? targetSymbol.declarationLocation.filePath.replace(/\\/g, '/').toLowerCase()
      : undefined;

    if (!targetDeclFile) return true;

    // 2. Directory/Package proximity: is sf in the same directory or parent/child directory tree as target?
    const sfDir = sfNorm.substring(0, sfNorm.lastIndexOf('/'));
    const targetDir = targetDeclFile.substring(0, targetDeclFile.lastIndexOf('/'));

    if (sfDir === targetDir || sfDir.startsWith(targetDir + '/') || targetDir.startsWith(sfDir + '/')) {
      return true;
    }

    // Otherwise, sf has no syntactic mention and is in a completely disjoint directory/package
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
