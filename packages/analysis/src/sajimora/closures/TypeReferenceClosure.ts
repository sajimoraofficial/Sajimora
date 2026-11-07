import * as ts from 'typescript';
import {
  SymbolRef,
  getSymbolName,
  getSymbolPersistentId,
  ClosureEvidence,
  CanonicalReferenceOccurrence,
  RepositoryAnalysisUniverse,
  UnrecognizedBindingForm,
  normalizeModuleIdentity,
  enforceAmbiguityPoisoning
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { CanonicalExtractor } from '../extractor/CanonicalExtractor';

export class TypeReferenceClosure {
  /**
   * Evaluates all type-position references to the target symbol.
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
    const unrecognizedForms: UnrecognizedBindingForm[] = [];
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    let completeness: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';

    const sourceFiles = context.getUniverseSourceFiles();

    for (const sf of sourceFiles) {
      const sfNorm = sf.fileName.replace(/\\/g, '/');

      const visit = (node: ts.Node) => {
        try {
          // 1. TypeReferenceNode: const x: Target
          if (ts.isTypeReferenceNode(node)) {
            const sym = checker.getSymbolAtLocation(node.typeName);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  node.typeName,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'TYPE_ANNOTATION',
                  universe
                )
              );
            }
          }

          // 2. TypeQueryNode: typeof Target
          if (ts.isTypeQueryNode(node)) {
            const sym = checker.getSymbolAtLocation(node.exprName);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  node.exprName,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'TYPE_ANNOTATION',
                  universe
                )
              );
            }
          }

          // 3. SatisfiesExpression: x satisfies Target
          if ((ts as any).isSatisfiesExpression && (ts as any).isSatisfiesExpression(node)) {
            const typeNode = (node as any).type;
            const sym = checker.getSymbolAtLocation(typeNode);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  typeNode,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'TYPE_ANNOTATION',
                  universe
                )
              );
            }
          }

          // 4. AsExpression / TypeAssertion: x as Target
          if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
            const typeNode = node.type;
            const sym = checker.getSymbolAtLocation(typeNode);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  typeNode,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'TYPE_ANNOTATION',
                  universe
                )
              );
            }
          }

          // 5. TypeParameterDeclaration constraint: <T extends Target>
          if (ts.isTypeParameterDeclaration(node) && node.constraint) {
            const sym = checker.getSymbolAtLocation(node.constraint);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  node.constraint,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'GENERIC_ARGUMENT',
                  universe
                )
              );
            }
          }

          // 6. Union / Intersection / Composite type traversal with Consumer Predicate
          if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
            for (const constituent of node.types) {
              const sym = checker.getSymbolAtLocation(constituent);
              if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
                occurrences.push(
                  this.createOccurrence(
                    sf,
                    constituent,
                    targetSymbolId,
                    sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                    'TYPE_ANNOTATION',
                    universe
                  )
                );
              }
            }
          }

          // The TypeScript type grammar contains many nested forms (mapped,
          // conditional, indexed access, keyof, infer, import types, tuples).
          // Classify identifiers in any type-position by checker identity rather
          // than maintaining a lossy allow-list of parent SyntaxKinds.
          if (ts.isIdentifier(node) && this.isTypePosition(node)) {
            const sym = checker.getSymbolAtLocation(node);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor) && !occurrences.some(o =>
              o.sourceFile === sfNorm && o.sourceSpan.start === node.getStart(sf)
            )) {
              occurrences.push(this.createOccurrence(
                sf, node, targetSymbolId,
                extractor.getDeclarationSymbol(sym!), 'TYPE_ANNOTATION', universe
              ));
            }
          }
        } catch (err: any) {
          if (extractor.isNodeRelevantToTarget(node, targetSymbolName)) {
            completeness = 'INCOMPLETE';
            unrecognizedForms.push({
              sourceFile: sfNorm,
              sourceSpan: {
                start: node.pos,
                end: node.end,
                line: sf.getLineAndCharacterOfPosition(node.pos).line + 1,
                column: sf.getLineAndCharacterOfPosition(node.pos).character + 1
              },
              syntaxKind: node.kind,
              attemptedClassification: 'TYPE_REFERENCE',
              cause: 'UNSUPPORTED_AST_FORM',
              encounteredInClosures: ['TypeReferenceClosure'],
              isTargetRelevant: true
            });
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const evidence: ClosureEvidence = {
      closureName: 'TypeReferenceClosure',
      occurrences,
      completeness,
      failures,
      ambiguities,
      unrecognizedForms,
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

  private createOccurrence(
    sf: ts.SourceFile,
    node: ts.Node,
    targetSymbolId: string,
    declarationSymbol: string,
    usageRole: any,
    universe: RepositoryAnalysisUniverse
  ): CanonicalReferenceOccurrence {
    const sfNorm = sf.fileName.replace(/\\/g, '/');
    const start = node.getStart(sf);
    const end = node.getEnd();
    const lc = sf.getLineAndCharacterOfPosition(start);
    const modId = normalizeModuleIdentity(sf.fileName, universe.rootPath);

    return {
      occurrenceId: `${modId}:${lc.line + 1}:${lc.character + 1}:${usageRole}`,
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
      semanticRole: 'TYPE',
      usageRole,
      referencedSymbol: targetSymbolId,
      declarationSymbol,
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: [
        {
          hopKind: 'DIRECT_IMPORT',
          fromModuleIdentity: modId,
          fromSpan: { line: lc.line + 1, column: lc.character + 1 },
          toModuleIdentity: modId,
          toSpan: { line: lc.line + 1, column: lc.character + 1 },
          symbolName: targetSymbolId
        }
      ]
    };
  }

  private isTypePosition(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isTypeNode(current) || ts.isTypeParameterDeclaration(current)) return true;
      if (ts.isSourceFile(current) || ts.isStatement(current)) return false;
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
