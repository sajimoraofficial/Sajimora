import * as ts from 'typescript';
import {
  SymbolRef,
  getSymbolName,
  getSymbolPersistentId,
  ClosureEvidence,
  CanonicalReferenceOccurrence,
  ProvenanceHop,
  RepositoryAnalysisUniverse,
  UnrecognizedBindingForm,
  normalizeModuleIdentity,
  enforceAmbiguityPoisoning
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { CanonicalExtractor } from '../extractor/CanonicalExtractor';
import { ProvenanceTracer } from './ProvenanceTracer';

export class ValueReferenceClosure {
  /**
   * Evaluates all value-position references to the target symbol across the declared universe.
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
    const unrecognizedForms: UnrecognizedBindingForm[] = [];
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    let completeness: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';

    const sourceFiles = context.getUniverseSourceFiles();

    for (const sf of sourceFiles) {
      const sfNorm = sf.fileName.replace(/\\/g, '/');

      const visit = (node: ts.Node) => {
        try {
          // Check for JSX Elements: <Target /> or <Target.Member />
          if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
            const tagNode = node.tagName;
            const sym = checker.getSymbolAtLocation(tagNode);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  tagNode,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'VALUE',
                  'JSX_ELEMENT',
                  universe,
                  tracer,
                  sym
                )
              );
            }
          }

          // Check for Call Expressions: target(...)
          if (ts.isCallExpression(node)) {
            const expr = node.expression;
            const sym = checker.getSymbolAtLocation(expr);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              const overloadRes = extractor.resolveOverloadSignature(node);
              const resStatus = overloadRes.resolutionStatus;
              if (resStatus === 'UNDECIDABLE') {
                completeness = 'INCOMPLETE';
                failures.push({ file: sfNorm, cause: overloadRes.reason ?? 'UNDECIDABLE_OVERLOAD' });
              }

              occurrences.push(
                this.createOccurrence(
                  sf,
                  expr,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'VALUE',
                  'CALL_SITE',
                  universe,
                  tracer,
                  sym,
                  resStatus,
                  overloadRes.signatureAnchor
                )
              );
            }
          }

          // Check for JSX Elements
          if (ts.isJsxOpeningLikeElement(node)) {
            const tagName = node.tagName;
            const sym = checker.getSymbolAtLocation(tagName);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              const overloadRes = extractor.resolveOverloadSignature(node);
              const resStatus = overloadRes.resolutionStatus;
              if (resStatus === 'UNDECIDABLE') {
                completeness = 'INCOMPLETE';
                failures.push({ file: sfNorm, cause: overloadRes.reason ?? 'UNDECIDABLE_OVERLOAD' });
              }

              occurrences.push(
                this.createOccurrence(
                  sf,
                  tagName,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'VALUE',
                  'JSX_ELEMENT',
                  universe,
                  tracer,
                  sym,
                  resStatus,
                  overloadRes.signatureAnchor
                )
              );
            }
          }

          // Check for Value Assignments / Variable Declarations (including `using x = target`)
          if (ts.isVariableDeclaration(node) && node.initializer) {
            const init = node.initializer;
            const sym = checker.getSymbolAtLocation(init);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              occurrences.push(
                this.createOccurrence(
                  sf,
                  init,
                  targetSymbolId,
                  sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                  'VALUE',
                  'VALUE_ASSIGNMENT',
                  universe,
                  tracer,
                  sym
                )
              );
            }
          }

          // Check for Property Access Expressions: receiver.target
          if (ts.isPropertyAccessExpression(node)) {
            const propName = node.name;
            const sym = checker.getSymbolAtLocation(propName);
            if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
              if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
                occurrences.push(
                  this.createOccurrence(
                    sf,
                    propName,
                    targetSymbolId,
                    sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                    'VALUE',
                    'METHOD_REFERENCE',
                    universe,
                    tracer,
                    sym
                  )
                );
              }
            }
          }

          // Check for General Identifiers in Value Position
          if (ts.isIdentifier(node)) {
            if (!this.isDeclarationIdentifier(node) && !this.isTypePositionNode(node)) {
              const sym = checker.getSymbolAtLocation(node);
              if (this.symbolMatchesTarget(sym, targetSymbol, extractor)) {
                const alreadyCaptured = occurrences.some(
                  o => o.sourceFile === sfNorm && o.sourceSpan.start === node.getStart(sf)
                );
                if (!alreadyCaptured) {
                  occurrences.push(
                    this.createOccurrence(
                      sf,
                      node,
                      targetSymbolId,
                      sym ? extractor.getDeclarationSymbol(sym) : targetSymbolId,
                      'VALUE',
                      'REFERENCE_OCCURRENCE',
                      universe,
                      tracer,
                      sym
                    )
                  );
                }
              }
            }
          }
        } catch (err: any) {
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
            attemptedClassification: 'VALUE_REFERENCE',
            cause: 'UNSUPPORTED_AST_FORM',
            encounteredInClosures: ['ValueReferenceClosure'],
            isTargetRelevant: true
          });
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const evidence: ClosureEvidence = {
      closureName: 'ValueReferenceClosure',
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

  private isDeclarationIdentifier(id: ts.Identifier): boolean {
    const p = id.parent;
    if (ts.isVariableDeclaration(p) && p.name === id) return true;
    if (ts.isFunctionDeclaration(p) && p.name === id) return true;
    if (ts.isClassDeclaration(p) && p.name === id) return true;
    if (ts.isInterfaceDeclaration(p) && p.name === id) return true;
    if (ts.isTypeAliasDeclaration(p) && p.name === id) return true;
    if (ts.isParameter(p) && p.name === id) return true;
    if (ts.isImportSpecifier(p) && p.name === id) return true;
    if (ts.isImportClause(p) && p.name === id) return true;
    return false;
  }

  private isTypePositionNode(node: ts.Node): boolean {
    let curr: ts.Node | undefined = node;
    while (curr && curr.parent) {
      if (
        ts.isTypeNode(curr) ||
        ts.isTypeReferenceNode(curr) ||
        ts.isTypeQueryNode(curr) ||
        ts.isInterfaceDeclaration(curr) ||
        ts.isTypeAliasDeclaration(curr) ||
        ts.isHeritageClause(curr)
      ) {
        return true;
      }
      curr = curr.parent;
    }
    return false;
  }

  private createOccurrence(
    sf: ts.SourceFile,
    node: ts.Node,
    targetSymbolId: string,
    declarationSymbol: string,
    semanticRole: 'VALUE' | 'TYPE' | 'UNDECIDABLE',
    usageRole: any,
    universe: RepositoryAnalysisUniverse,
    tracer: ProvenanceTracer,
    resolvedSym: ts.Symbol | undefined,
    resolutionStatus: any = 'RESOLVED',
    signatureAnchor?: string
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
      semanticRole,
      usageRole,
      referencedSymbol: targetSymbolId,
      declarationSymbol,
      signatureAnchor,
      resolutionStatus,
      enumerationStatus: 'COMPLETE',
      provenance: resolvedSym ? tracer.traceProvenance(node, resolvedSym, targetSymbolId, sf) : [
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
