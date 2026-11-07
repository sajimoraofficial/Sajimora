import * as ts from 'typescript';
import {
  CanonicalReferenceOccurrence,
  SemanticRole,
  UsageRole,
  ResolutionStatus,
  ProvenanceHop,
  DeclarationAnchor,
  UnrecognizedBindingForm,
  ClosureName,
  RepositoryAnalysisUniverse,
  isSourceInUniverse,
  normalizeModuleIdentity,
  computeDeclarationSetIdentity,
  SymbolRef,
  getSymbolName,
  normalizePath
} from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';

export interface ExtractorResult {
  occurrences: CanonicalReferenceOccurrence[];
  unrecognizedForms: UnrecognizedBindingForm[];
}

export class CanonicalExtractor {
  constructor(
    private context: AnalysisContext,
    private universe: RepositoryAnalysisUniverse
  ) {}

  /**
   * Computes the deterministic 0-indexed declaration ordinal for a declaration node within its source file.
   * Sorts all declarations in the file by (pos, end, kind).
   */
  public static computeDeclarationOrdinal(sourceFile: ts.SourceFile, targetNode: ts.Declaration): number {
    const declarations: ts.Declaration[] = [];

    function visit(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        declarations.push(node as ts.Declaration);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    declarations.sort((a, b) => {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.end !== b.end) return a.end - b.end;
      return a.kind - b.kind;
    });

    const index = declarations.indexOf(targetNode);
    return index >= 0 ? index : 0;
  }

  /**
   * Extracts the deterministic DeclarationAnchor set for a TypeScript Symbol.
   */
  public extractDeclarationAnchors(symbol: ts.Symbol): DeclarationAnchor[] {
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) {
      return [
        {
          moduleIdentity: 'unknown',
          symbolLocalName: symbol.name,
          kind: 'unknown',
          parameterTypeFingerprint: '',
          declarationOrdinal: 0,
          syntaxKind: 0
        }
      ];
    }

    return declarations.map(decl => {
      const sf = decl.getSourceFile();
      const moduleIdentity = normalizeModuleIdentity(sf.fileName, this.universe.rootPath);
      const declarationOrdinal = CanonicalExtractor.computeDeclarationOrdinal(sf, decl);
      const kind = ts.SyntaxKind[decl.kind]?.toLowerCase() ?? 'unknown';

      let parameterTypeFingerprint = '';
      if (ts.isFunctionLike(decl)) {
        const checker = this.context.getTypeChecker();
        parameterTypeFingerprint = decl.parameters.map(p => {
          const type = p.type ? checker.getTypeFromTypeNode(p.type) : checker.getTypeAtLocation(p);
          return `${p.dotDotDotToken ? '...' : ''}${checker.typeToString(type)}`;
        }).join(',');
      }

      return {
        moduleIdentity,
        symbolLocalName: symbol.name,
        kind,
        parameterTypeFingerprint,
        declarationOrdinal,
        syntaxKind: decl.kind
      };
    });
  }

  /**
   * Derives the deterministic declarationSymbol for a resolved symbol.
   */
  public getDeclarationSymbol(symbol: ts.Symbol): string {
    const anchors = this.extractDeclarationAnchors(symbol);
    return computeDeclarationSetIdentity(anchors);
  }

  /**
   * Resolves an overload signature for a call site.
   * Rejects declarations[0] shortcuts and bounds external targets.
   */
  public resolveOverloadSignature(
    callNode: ts.CallLikeExpression
  ): { signatureAnchor: string; resolutionStatus: ResolutionStatus; reason?: string } {
    const checker = this.context.getTypeChecker();
    const signature = checker.getResolvedSignature(callNode);

    if (!signature || !signature.declaration) {
      return {
        signatureAnchor: 'UNKNOWN_SIGNATURE',
        resolutionStatus: 'UNDECIDABLE',
        reason: 'CHECKER_NO_RESOLVED_SIGNATURE'
      };
    }

    const declFile = signature.declaration.getSourceFile().fileName.replace(/\\/g, '/');
    if (!isSourceInUniverse(this.universe, declFile)) {
      const sf = signature.declaration.getSourceFile();
      const isDefaultLib =
        this.context.getProgram().isSourceFileDefaultLibrary(sf) ||
        /\/lib\.[^/]+\.d\.ts$/i.test(declFile) ||
        /\/typescript\/lib\//i.test(declFile);

      if (isDefaultLib) {
        return {
          signatureAnchor: 'BUILTIN_LIBRARY_DECLARATION',
          resolutionStatus: 'RESOLVED'
        };
      }

      return {
        signatureAnchor: 'EXTERNAL_DECLARATION',
        resolutionStatus: 'UNDECIDABLE',
        reason: 'PROJECT_REFERENCE_UNRESOLVED_TO_SOURCE'
      };
    }

    const sf = signature.declaration.getSourceFile();
    const ordinal = CanonicalExtractor.computeDeclarationOrdinal(sf, signature.declaration);
    const modId = normalizeModuleIdentity(sf.fileName, this.universe.rootPath);
    return {
      signatureAnchor: `${modId}:${ordinal}:${signature.declaration.kind}`,
      resolutionStatus: 'RESOLVED'
    };
  }

  /**
   * Evaluates whether an unclassified AST node is relevant to a target symbol.
   */
  public isNodeRelevantToTarget(node: ts.Node, targetSymbolName: string): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === targetSymbolName) {
        found = true;
      }
      if (!found) {
        ts.forEachChild(n, visit);
      }
    };
    try {
      visit(node);
    } catch {
      // Ignored
    }
    return found;
  }

  /**
   * NON-AUTHORITATIVE / DEAD HELPER (QUARANTINED / REMOVED):
   * Per Sajimora V32.9 V3 audit and specification §11.4:
   * `matchesCompositeConsumerPredicate` is NOT part of the production semantic path.
   * Reference discovery in Sajimora V32.9 is strictly reference-first AST traversal via
   * `ValueReferenceClosure` and `TypeReferenceClosure` using `checker.getSymbolAtLocation()`
   * and canonical symbol identity matching (`matchSymbolWithTarget`).
   *
   * This method has been deprecated and quarantined/removed to prevent misleading references.
   */
  public matchesCompositeConsumerPredicate(
    _compositeType: ts.Type,
    _targetSymbol: ts.Symbol,
    _memberAccessed?: string
  ): boolean {
    // Non-authoritative dead code path - always returns false.
    // Production discovery uses AST Reference Closures (ValueReferenceClosure & TypeReferenceClosure).
    return false;
  }

  private matchesTargetOwner(declFile: string, targetOwner: string): boolean {
    const dNorm = normalizePath(declFile).toLowerCase();
    const tNorm = normalizePath(targetOwner).toLowerCase();
    if (dNorm === tNorm) return true;

    if (this.universe?.rootPath) {
      const relDecl = normalizeModuleIdentity(declFile, this.universe.rootPath).toLowerCase();
      if (tNorm.endsWith('/' + relDecl) || tNorm === relDecl) return true;
    }

    const dParts = dNorm.split('/').filter(Boolean);
    const tParts = tNorm.split('/').filter(Boolean);
    if (dParts.length === 0 || tParts.length === 0) return false;
    if (dParts[dParts.length - 1] !== tParts[tParts.length - 1]) return false;

    let matchCount = 0;
    while (
      matchCount < dParts.length &&
      matchCount < tParts.length &&
      dParts[dParts.length - 1 - matchCount] === tParts[tParts.length - 1 - matchCount]
    ) {
      matchCount++;
    }

    return matchCount >= 2;
  }

  /**
   * Matches a candidate TypeScript Symbol against a target SymbolRef canonically.
   * Compares declaration provenance and file identity, rejecting naive name-only collisions.
   */
  public matchSymbolWithTarget(
    sym: ts.Symbol | undefined,
    target: SymbolRef
  ): boolean {
    if (!sym) return false;
    const checker = this.context.getTypeChecker();
    const targetName = getSymbolName(target);

    let candidate: ts.Symbol | undefined = sym;
    const visited = new Set<ts.Symbol>();

    while (candidate) {
      if (visited.has(candidate)) break;
      visited.add(candidate);

      if (candidate.name === targetName) {
        const decls = candidate.declarations ?? [];
        const targetOwner = target.fingerprint?.components?.globallyQualifiedOwner
          ? normalizePath(target.fingerprint.components.globallyQualifiedOwner.split('::', 1)[0]).toLowerCase()
          : undefined;

        if (!targetOwner || decls.some(d => this.matchesTargetOwner(d.getSourceFile().fileName, targetOwner))) {
          return true;
        }
      }

      let next: ts.Symbol | undefined;
      if (candidate.flags & ts.SymbolFlags.Alias) {
        try {
          const aliased = checker.getAliasedSymbol(candidate);
          if (aliased && aliased !== candidate) {
            next = aliased;
          }
        } catch {
          // ignore alias error
        }
      }

      if (!next) {
        const decl = candidate.declarations?.[0];
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
          next = checker.getSymbolAtLocation(decl.initializer);
        }
      }

      if (!next || next === candidate) break;
      candidate = next;
    }

    if (!candidate || candidate.name !== targetName) {
      return false;
    }

    const targetOwner = target.fingerprint?.components?.globallyQualifiedOwner
      ? normalizePath(target.fingerprint.components.globallyQualifiedOwner.split('::', 1)[0]).toLowerCase()
      : undefined;

    if (targetOwner) {
      const decls = candidate.declarations ?? [];
      if (decls.length === 0) return false;
      return decls.some(d => this.matchesTargetOwner(d.getSourceFile().fileName, targetOwner));
    }

    return true;
  }
}
