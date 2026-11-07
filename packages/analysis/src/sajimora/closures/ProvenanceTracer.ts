import * as ts from 'typescript';
import { ProvenanceHop, RepositoryAnalysisUniverse, normalizeModuleIdentity } from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';

export class ProvenanceTracer {
  constructor(
    private context: AnalysisContext,
    private universe: RepositoryAnalysisUniverse
  ) {}

  /**
   * Traces the provenance of a symbol from its usage site back to its original declaration,
   * yielding a chain of ProvenanceHops representing the exact path traversed through aliases/exports.
   */
  public traceProvenance(
    usageNode: ts.Node,
    resolvedSymbol: ts.Symbol,
    targetSymbolId: string,
    usageFile: ts.SourceFile
  ): ProvenanceHop[] {
    const checker = this.context.getTypeChecker();
    const hops: ProvenanceHop[] = [];

    // The start of the chain: the usage file
    const startModId = normalizeModuleIdentity(usageFile.fileName, this.universe.rootPath);
    const startLc = usageFile.getLineAndCharacterOfPosition(usageNode.getStart(usageFile));

    // Fast-path: if the symbol is not an alias, it's a direct import or local definition.
    // If it's a direct import, we will still extract the single hop.
    const initialSym = checker.getSymbolAtLocation(usageNode);
    if (!initialSym) {
      return [{
        hopKind: 'DIRECT_IMPORT',
        fromModuleIdentity: startModId,
        fromSpan: { line: startLc.line + 1, column: startLc.character + 1 },
        toModuleIdentity: startModId, // unknown without a symbol
        toSpan: { line: startLc.line + 1, column: startLc.character + 1 },
        symbolName: targetSymbolId
      }];
    }

    let currentSym = initialSym;
    let currentFile = usageFile;
    let currentSpan = { line: startLc.line + 1, column: startLc.character + 1 };
    let currentModId = startModId;

    const visitedSymbols = new Set<ts.Symbol>();

    // Iteratively walk backwards through aliases or variable assignments
    while ((currentSym.flags & ts.SymbolFlags.Alias) || (currentSym.flags & ts.SymbolFlags.Variable)) {
      if (visitedSymbols.has(currentSym)) {
        break; // Prevent infinite loops in cyclic aliases
      }
      visitedSymbols.add(currentSym);

      let decl = currentSym.declarations && currentSym.declarations[0];
      if (!decl) {
        break;
      }

      let nextSym: ts.Symbol | undefined;
      if (currentSym.flags & ts.SymbolFlags.Alias) {
        try {
          const getImmediate = (checker as any).getImmediateAliasedSymbol;
          if (typeof getImmediate === 'function') {
            nextSym = getImmediate.call(checker, currentSym);
          } else {
            nextSym = checker.getAliasedSymbol(currentSym);
          }
        } catch {
          // ignore
        }
      }

      // If it's a variable declaration like `const TokenA = ServiceToken;`
      // getAliasedSymbol returns undefined. We must follow the initializer.
      if (!nextSym && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
        nextSym = checker.getSymbolAtLocation(decl.initializer);
      }

      if (!nextSym) {
        break;
      }

      const nextDecl = nextSym.declarations && nextSym.declarations[0];
      if (!nextDecl) {
        break; // Can't trace further if there's no declaration
      }

      const nextFile = nextDecl.getSourceFile();
      const nextModId = normalizeModuleIdentity(nextFile.fileName, this.universe.rootPath);
      const nextLc = nextFile.getLineAndCharacterOfPosition(nextDecl.getStart(nextFile));
      const nextSpan = { line: nextLc.line + 1, column: nextLc.character + 1 };

      // Determine hop kind
      let hopKind: ProvenanceHop['hopKind'] = 'DIRECT_IMPORT';
      if (ts.isExportSpecifier(decl)) {
        hopKind = 'RE_EXPORT';
      } else if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
        hopKind = 'DIRECT_IMPORT';
      } else if (ts.isTypeAliasDeclaration(decl) || ts.isVariableDeclaration(decl)) {
        hopKind = 'ALIAS_RESOLUTION';
      }

      if (nextModId !== currentModId) {
        hops.push({
          hopKind,
          fromModuleIdentity: currentModId,
          fromSpan: { ...currentSpan },
          toModuleIdentity: nextModId,
          toSpan: { ...nextSpan },
          symbolName: currentSym.name
        });
      }

      // Advance
      currentSym = nextSym;
      currentFile = nextFile;
      currentModId = nextModId;
      currentSpan = nextSpan;
    }

    // If no hops were added (e.g. it wasn't an alias but a local reference), ensure at least 1 hop is returned
    if (hops.length === 0) {
      // Find where it was actually declared
      const targetDecl = resolvedSymbol.declarations && resolvedSymbol.declarations[0];
      let toModId = startModId;
      let toSpan = currentSpan;

      if (targetDecl) {
        const tf = targetDecl.getSourceFile();
        toModId = normalizeModuleIdentity(tf.fileName, this.universe.rootPath);
        const tLc = tf.getLineAndCharacterOfPosition(targetDecl.getStart(tf));
        toSpan = { line: tLc.line + 1, column: tLc.character + 1 };
      }

      hops.push({
        hopKind: 'DIRECT_IMPORT',
        fromModuleIdentity: startModId,
        fromSpan: currentSpan,
        toModuleIdentity: toModId,
        toSpan: toSpan,
        symbolName: resolvedSymbol.name
      });
    }

    return hops;
  }
}
