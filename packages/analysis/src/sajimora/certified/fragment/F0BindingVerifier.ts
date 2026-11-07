import ts from 'typescript';
import { Anchor, BlockerCode } from '../../../../../core/src/sajimora/certified/blockers';
import { Vertex } from '../../../../../core/src/sajimora/certified/contracts';
import { TargetScopedEnvelope, isTargetImportDeclaration } from './TargetScopedEnvelope';
import { discoverStaticImports, discoverUniqueExportedFunction } from './ModuleBindingDiscovery';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0RestrictedResolver } from '../closure/F0RestrictedResolver';

export type F0SymbolKind = 'CONST' | 'FUNCTION' | 'TYPE_ALIAS' | 'INTERFACE' | 'IMPORT';

export interface F0DeclaredSymbol {
  name: string;
  kind: F0SymbolKind;
  isExported: boolean;
  exportedName?: string;
  anchor: Anchor;
  node: ts.Node;
}

export interface F0ModuleBindings {
  vertex: Vertex;
  symbols: Map<string, F0DeclaredSymbol>; // localName -> symbol
  exportedSymbols: Map<string, F0DeclaredSymbol>; // exportedName -> symbol
  reexports: Map<string, { specifier: string; targetExportName: string }>;
  imports: Map<string, { moduleSpecifier: string; sourceExportName: string; anchor: Anchor }>;
  namespaceImports: Map<string, { moduleSpecifier: string; anchor: Anchor }>;
  namespaceMemberAccesses: Array<{ namespaceLocalName: string; memberName: string; anchor: Anchor }>;
}

export interface F0ImportDiscovery {
  moduleSpecifier: string;
  declaration: ts.ImportDeclaration;
  namedBindings?: ts.NamedImports | ts.NamespaceImport;
  defaultBinding?: string;
}

export interface BindingVerificationResult {
  valid: boolean;
  blockerCode?: BlockerCode;
  reason?: string;
  anchor?: Anchor;
}

function makeBindingAnchor(vertex: Vertex, sourceFile: ts.SourceFile, node: ts.Node): Anchor {
  return {
    projectId: vertex.projectId,
    fileId: vertex.fileId,
    utf16Start: node.getStart(sourceFile),
    utf16End: node.getEnd(),
    syntaxKind: node.kind
  };
}

function staticImportSpecifier(statement: ts.Statement): string | undefined {
  return ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : undefined;
}

function findCallAtAnchor(sourceFile: ts.SourceFile, anchor: Anchor): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getStart(sourceFile) === anchor.utf16Start && node.getEnd() === anchor.utf16End) {
      found = node;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export class F0BindingVerifier {
  public static discoverImports(sourceFile: ts.SourceFile): F0ImportDiscovery[] {
    return discoverStaticImports(sourceFile);
  }

  /** Discovery-compatible entry point. Kept as a wrapper until validation is
   * split into a separate pass; behavior is intentionally identical today. */
  public static discoverModuleBindings(vertex: Vertex, sourceFile: ts.SourceFile): {
    bindings?: F0ModuleBindings;
    result: BindingVerificationResult;
  } {
    return this.extractModuleBindings(vertex, sourceFile);
  }

  /**
   * Validates only the target import for an authenticated scoped envelope.
   * Legacy callers continue to use extractModuleBindings(), which remains
   * exhaustive and fail-closed for the complete file.
   */
  public static verifyTargetScopedImport(
    vertex: Vertex,
    sourceFile: ts.SourceFile,
    envelope: TargetScopedEnvelope,
    sealedFs?: SealedFilesystem,
    closureVertices?: Iterable<Vertex>
  ): BindingVerificationResult {
    const matches = this.discoverImports(sourceFile).filter(importInfo => isTargetImportDeclaration(importInfo.declaration, envelope));
    if (matches.length !== 1) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target scoped import is missing or ambiguous' };
    }
    const statement = matches[0].declaration;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target scoped import must be relative' };
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target scoped import must be a named import' };
    }
    const callAnchor = Array.from(envelope.consumerCallSiteAnchors)
      .find(anchor => anchor.fileId === vertex.fileId);
    const call = callAnchor && findCallAtAnchor(sourceFile, callAnchor);
    const callExpression = call && ts.isIdentifier(call.expression) ? call.expression : undefined;
    const target = callExpression
      ? bindings.elements.find(element => element.name.text === callExpression.text)
      : undefined;
    if (!target || !callExpression || callExpression.text !== target.name.text) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target scoped import does not bind the anchored call to the target export' };
    }
    if (!sealedFs && (target.propertyName?.text ?? target.name.text) !== envelope.targetLocalName) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target import source name cannot be verified without sealed module resolution' };
    }
    if (sealedFs && closureVertices && !this.importResolvesToEnvelopeTarget(
      vertex, specifier, target.propertyName?.text ?? target.name.text, envelope, sealedFs, closureVertices
    )) {
      return { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Target import does not resolve through a unique named export chain to the anchored declaration' };
    }
    return { valid: true };
  }

  private static importResolvesToEnvelopeTarget(
    importer: Vertex,
    specifier: string,
    exportName: string,
    envelope: TargetScopedEnvelope,
    sealedFs: SealedFilesystem,
    closureVertices: Iterable<Vertex>
  ): boolean {
    const allowedFiles = new Set(Array.from(closureVertices, item => item.fileId));
    const resolver = new F0RestrictedResolver(sealedFs);
    const visit = (from: Vertex, moduleSpecifier: string, name: string, seen: Set<string>, depth: number): boolean => {
      if (depth > 32) return false;
      const result = resolver.resolve(moduleSpecifier, from.fileId);
      if (result.outcome !== 'RESOLVED' || !result.selectedTargetOrNull || !allowedFiles.has(result.selectedTargetOrNull)) return false;
      const fileId = result.selectedTargetOrNull;
      const key = `${fileId}#${name}`;
      if (seen.has(key) || !sealedFs.exists(fileId)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      const targetVertex: Vertex = { projectId: from.projectId, fileId };
      const text = sealedFs.readBytes(fileId).toString('utf8');
      const targetSource = ts.createSourceFile(fileId, text, ts.ScriptTarget.Latest, true);
      const parseDiagnostics = (targetSource as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
      if (parseDiagnostics?.length) return false;
      if (fileId === envelope.targetDeclaration.fileId) {
        const declaration = discoverUniqueExportedFunction(targetVertex, targetSource, envelope.targetLocalName);
        return !!declaration && name === envelope.targetLocalName &&
          declaration.anchor.utf16Start === envelope.targetDeclaration.utf16Start &&
          declaration.anchor.utf16End === envelope.targetDeclaration.utf16End;
      }
      const matches: Array<{ specifier: string; sourceName: string }> = [];
      for (const statement of targetSource.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          if (element.name.text === name) matches.push({
            specifier: statement.moduleSpecifier.text,
            sourceName: element.propertyName?.text ?? element.name.text
          });
        }
      }
      return matches.length === 1 && visit(targetVertex, matches[0].specifier, matches[0].sourceName, nextSeen, depth + 1);
    };
    return visit(importer, specifier, exportName, new Set(), 0);
  }

  /**
   * Extracts and validates all declarations, scopes, and exports within a single SourceFile.
   * Enforces:
   * - No duplicate declarations / declaration merging (AMBIGUOUS_DECLARATION_GROUP)
   * - No duplicate exports (AMBIGUOUS_DECLARATION_GROUP)
   * - No wildcard exports (UNSUPPORTED_SYNTAX)
   */
  public static extractModuleBindings(vertex: Vertex, sourceFile: ts.SourceFile): {
    bindings?: F0ModuleBindings;
    result: BindingVerificationResult;
  } {
    const symbols = new Map<string, F0DeclaredSymbol>();
    const exportedSymbols = new Map<string, F0DeclaredSymbol>();
    const reexports = new Map<string, { specifier: string; targetExportName: string }>();
    const imports = new Map<string, { moduleSpecifier: string; sourceExportName: string; anchor: Anchor }>();
    const namespaceImports = new Map<string, { moduleSpecifier: string; anchor: Anchor }>();
    const namespaceMemberAccesses: Array<{ namespaceLocalName: string; memberName: string; anchor: Anchor }> = [];

    const makeAnchor = (node: ts.Node): Anchor => makeBindingAnchor(vertex, sourceFile, node);

    for (const stmt of sourceFile.statements) {
      // 1. ImportDeclaration
      if (ts.isImportDeclaration(stmt)) {
        const specifier = staticImportSpecifier(stmt);
        if (specifier === undefined) {
          return { result: { valid: false, blockerCode: BlockerCode.UNSUPPORTED_BINDING, reason: 'Import specifier must be static' } };
        }
        const clause = stmt.importClause;
        // F0's sole default-import form is semantically the same binding as
        // `import { default as local }`: localName -> sourceExportName default.
        // Keep mixed default/named and default/namespace forms fail-closed even
        // when this verifier is called independently of grammar admission.
        if (clause?.name) {
          if (clause.namedBindings) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.UNSUPPORTED_BINDING,
                reason: 'Default imports combined with named or namespace imports are unsupported in F0',
                anchor: makeAnchor(clause)
              }
            };
          }
          const localName = clause.name.text;
          const anchor = makeAnchor(clause.name);
          if (symbols.has(localName)) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
                reason: `Duplicate declaration for symbol '${localName}'`,
                anchor
              }
            };
          }
          const sym: F0DeclaredSymbol = {
            name: localName,
            kind: 'IMPORT',
            isExported: false,
            anchor,
            node: clause.name
          };
          symbols.set(localName, sym);
          imports.set(localName, { moduleSpecifier: specifier, sourceExportName: 'default', anchor });
        }
        if (stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
          for (const elem of stmt.importClause.namedBindings.elements) {
            const localName = elem.name.text;
            const sourceExportName = elem.propertyName ? elem.propertyName.text : elem.name.text;
            const anchor = makeAnchor(elem);

            if (symbols.has(localName)) {
              return {
                result: {
                  valid: false,
                  blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
                  reason: `Duplicate declaration for symbol '${localName}'`,
                  anchor
                }
              };
            }

            const sym: F0DeclaredSymbol = {
              name: localName,
              kind: 'IMPORT',
              isExported: false,
              anchor,
              node: elem
            };
            symbols.set(localName, sym);
            imports.set(localName, { moduleSpecifier: specifier, sourceExportName, anchor });
          }
        }
        if (stmt.importClause?.namedBindings && ts.isNamespaceImport(stmt.importClause.namedBindings)) {
          const localName = stmt.importClause.namedBindings.name.text;
          const anchor = makeAnchor(stmt.importClause.namedBindings);
          if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.UNSUPPORTED_BINDING,
                reason: 'Namespace imports are supported only for static relative specifiers in F0',
                anchor
              }
            };
          }
          if (stmt.importClause.name || symbols.has(localName)) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
                reason: `Duplicate or mixed namespace import for symbol '${localName}'`,
                anchor
              }
            };
          }
          const sym: F0DeclaredSymbol = {
            name: localName,
            kind: 'IMPORT',
            isExported: false,
            anchor,
            node: stmt.importClause.namedBindings
          };
          symbols.set(localName, sym);
          namespaceImports.set(localName, { moduleSpecifier: specifier, anchor });
        }
        continue;
      }

      // 2. ExportDeclaration (re-export or export clause)
      if (ts.isExportDeclaration(stmt)) {
        if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) {
          return {
            result: {
              valid: false,
              blockerCode: BlockerCode.UNSUPPORTED_SYNTAX,
              reason: 'Wildcard export declarations are unsupported in F0',
              anchor: makeAnchor(stmt)
            }
          };
        }

        const specifier = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined;

        for (const elem of stmt.exportClause.elements) {
          const localOrTargetName = elem.propertyName ? elem.propertyName.text : elem.name.text;
          const exportedName = elem.name.text;
          const anchor = makeAnchor(elem);

          if (exportedSymbols.has(exportedName)) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
                reason: `Duplicate export for name '${exportedName}'`,
                anchor
              }
            };
          }

          if (specifier) {
            reexports.set(exportedName, { specifier, targetExportName: localOrTargetName });
          } else {
            // Re-export of local declaration
            const localSym = symbols.get(localOrTargetName);
            if (!localSym) {
              return {
                result: {
                  valid: false,
                  blockerCode: BlockerCode.UNSUPPORTED_BINDING,
                  reason: `Export of undeclared local symbol '${localOrTargetName}'`,
                  anchor
                }
              };
            }
            localSym.isExported = true;
            localSym.exportedName = exportedName;
            exportedSymbols.set(exportedName, localSym);
          }
        }
        continue;
      }

      // 3. VariableStatement
      if (ts.isVariableStatement(stmt)) {
        const isExported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          const anchor = makeAnchor(decl);

          if (symbols.has(name)) {
            return {
              result: {
                valid: false,
                blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
                reason: `Duplicate declaration for symbol '${name}'`,
                anchor
              }
            };
          }

          const sym: F0DeclaredSymbol = {
            name,
            kind: 'CONST',
            isExported,
            exportedName: isExported ? name : undefined,
            anchor,
            node: decl
          };
          symbols.set(name, sym);
          if (isExported) exportedSymbols.set(name, sym);
        }
        continue;
      }

      // 4. FunctionDeclaration
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        const anchor = makeAnchor(stmt);
        const isExported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

        if (symbols.has(name)) {
          return {
            result: {
              valid: false,
              blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
              reason: `Duplicate declaration / declaration merging for function '${name}'`,
              anchor
            }
          };
        }

        const sym: F0DeclaredSymbol = {
          name,
          kind: 'FUNCTION',
          isExported,
          exportedName: isExported ? name : undefined,
          anchor,
          node: stmt
        };
        symbols.set(name, sym);
        if (isExported) {
          exportedSymbols.set(name, sym);
          // A named `export default function f()` is addressable both by its
          // declaration name for identity and by `default` for import binding.
          if (stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) exportedSymbols.set('default', sym);
        }
        continue;
      }

      // 5. TypeAliasDeclaration
      if (ts.isTypeAliasDeclaration(stmt)) {
        const name = stmt.name.text;
        const anchor = makeAnchor(stmt);
        const isExported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

        if (symbols.has(name)) {
          return {
            result: {
              valid: false,
              blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
              reason: `Duplicate declaration / declaration merging for type alias '${name}'`,
              anchor
            }
          };
        }

        const sym: F0DeclaredSymbol = {
          name,
          kind: 'TYPE_ALIAS',
          isExported,
          exportedName: isExported ? name : undefined,
          anchor,
          node: stmt
        };
        symbols.set(name, sym);
        if (isExported) exportedSymbols.set(name, sym);
        continue;
      }

      // 6. InterfaceDeclaration
      if (ts.isInterfaceDeclaration(stmt)) {
        const name = stmt.name.text;
        const anchor = makeAnchor(stmt);
        const isExported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

        if (symbols.has(name)) {
          return {
            result: {
              valid: false,
              blockerCode: BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
              reason: `Duplicate declaration / declaration merging for interface '${name}'`,
              anchor
            }
          };
        }

        const sym: F0DeclaredSymbol = {
          name,
          kind: 'INTERFACE',
          isExported,
          exportedName: isExported ? name : undefined,
          anchor,
          node: stmt
        };
        symbols.set(name, sym);
        if (isExported) exportedSymbols.set(name, sym);
        continue;
      }
    }

    const isShadowed = (use: ts.PropertyAccessExpression, localName: string): boolean => {
      let current: ts.Node | undefined = use.parent;
      while (current && !ts.isSourceFile(current)) {
        if (ts.isFunctionLike(current)) {
          if (current.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === localName)) return true;
          if (ts.isFunctionDeclaration(current) && current.name?.text === localName) return true;
        }
        if (ts.isBlock(current)) {
          for (const statement of current.statements) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === localName)) return true;
            if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName) return true;
          }
        }
        current = current.parent;
      }
      return false;
    };

    const visitNamespaceMembers = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const namespaceLocalName = node.expression.text;
        if (namespaceImports.has(namespaceLocalName)) {
          if (isShadowed(node, namespaceLocalName)) {
            throw {
              blockerCode: BlockerCode.UNSUPPORTED_BINDING,
              reason: `Namespace member '${namespaceLocalName}.${node.name.text}' is shadowed in its lexical scope`,
              anchor: makeAnchor(node)
            };
          }
          namespaceMemberAccesses.push({
            namespaceLocalName,
            memberName: node.name.text,
            anchor: makeAnchor(node)
          });
        }
      }
      ts.forEachChild(node, visitNamespaceMembers);
    };
    try {
      visitNamespaceMembers(sourceFile);
    } catch (err: any) {
      if (err?.blockerCode) {
        return {
          result: {
            valid: false,
            blockerCode: err.blockerCode,
            reason: err.reason,
            anchor: err.anchor
          }
        };
      }
      throw err;
    }

    return {
      bindings: {
        vertex,
        symbols,
        exportedSymbols,
        reexports,
        imports,
        namespaceImports,
        namespaceMemberAccesses
      },
      result: { valid: true }
    };
  }

  /**
   * Verifies that all cross-module imports and re-exports resolve unambiguously
   * across the collection of modules in the closure.
   */
  public static verifyCrossModuleBindings(
    moduleBindings: Map<string, F0ModuleBindings>, // fileId -> F0ModuleBindings
    resolveModule: (fromFileId: string, specifier: string) => string | null
  ): BindingVerificationResult {
    for (const [fileId, bindings] of moduleBindings.entries()) {
      // 1. Verify imports
      for (const [localName, imp] of bindings.imports.entries()) {
        const resolvedTargetFile = resolveModule(fileId, imp.moduleSpecifier);
        if (!resolvedTargetFile) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Import specifier '${imp.moduleSpecifier}' could not be resolved from '${fileId}'`,
            anchor: imp.anchor
          };
        }

        const targetModule = moduleBindings.get(resolvedTargetFile);
        if (!targetModule) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Target module '${resolvedTargetFile}' for import '${imp.moduleSpecifier}' is missing from closure bindings`,
            anchor: imp.anchor
          };
        }

        // Check if exported
        const exportedSym = targetModule.exportedSymbols.get(imp.sourceExportName);
        const reexported = targetModule.reexports.get(imp.sourceExportName);

        if (!exportedSym && !reexported) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Module '${resolvedTargetFile}' does not export '${imp.sourceExportName}'`,
            anchor: imp.anchor
          };
        }
      }

      // 1b. Namespace imports. The namespace itself is not an export binding;
      // every member use must replay to one direct explicit sealed export.
      for (const access of bindings.namespaceMemberAccesses) {
        const replay = this.resolveNamespaceMember(
          moduleBindings,
          fileId,
          access.namespaceLocalName,
          access.memberName,
          resolveModule
        );
        if (!replay.result.valid) return { ...replay.result, anchor: access.anchor };
      }

      // 2. Verify re-exports
      for (const [exportedName, reexp] of bindings.reexports.entries()) {
        const resolvedTargetFile = resolveModule(fileId, reexp.specifier);
        if (!resolvedTargetFile) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Re-export specifier '${reexp.specifier}' could not be resolved from '${fileId}'`
          };
        }

        const targetModule = moduleBindings.get(resolvedTargetFile);
        if (!targetModule) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Target module '${resolvedTargetFile}' for re-export '${reexp.specifier}' is missing from closure bindings`
          };
        }

        const targetExport = targetModule.exportedSymbols.get(reexp.targetExportName);
        const transitiveReexport = targetModule.reexports.get(reexp.targetExportName);

        if (!targetExport && !transitiveReexport) {
          return {
            valid: false,
            blockerCode: BlockerCode.UNSUPPORTED_BINDING,
            reason: `Module '${resolvedTargetFile}' does not export '${reexp.targetExportName}' for re-export`
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Replays one namespace member selection against the same sealed module
   * binding table used during fragment admission. Only direct explicit exports
   * are accepted; re-export chains deliberately do not participate.
   */
  public static resolveNamespaceMember(
    moduleBindings: Map<string, F0ModuleBindings>,
    fromFileId: string,
    namespaceLocalName: string,
    memberName: string,
    resolveModule: (fromFileId: string, specifier: string) => string | null
  ): { symbol?: F0DeclaredSymbol; result: BindingVerificationResult } {
    const fromModule = moduleBindings.get(fromFileId);
    const namespaceImport = fromModule?.namespaceImports.get(namespaceLocalName);
    if (!namespaceImport) {
      return {
        result: {
          valid: false,
          blockerCode: BlockerCode.UNSUPPORTED_BINDING,
          reason: `Namespace '${namespaceLocalName}' is not an F0 namespace import`
        }
      };
    }
    const resolvedTargetFile = resolveModule(fromFileId, namespaceImport.moduleSpecifier);
    if (!resolvedTargetFile) {
      return {
        result: {
          valid: false,
          blockerCode: BlockerCode.UNSUPPORTED_BINDING,
          reason: `Namespace import '${namespaceImport.moduleSpecifier}' could not be resolved from '${fromFileId}'`,
          anchor: namespaceImport.anchor
        }
      };
    }
    const targetModule = moduleBindings.get(resolvedTargetFile);
    const symbol = targetModule?.exportedSymbols.get(memberName);
    if (!symbol) {
      return {
        result: {
          valid: false,
          blockerCode: BlockerCode.UNSUPPORTED_BINDING,
          reason: `Module '${resolvedTargetFile}' does not directly export namespace member '${memberName}'`,
          anchor: namespaceImport.anchor
        }
      };
    }
    return { symbol, result: { valid: true } };
  }

  public static namespaceLocalsForTarget(
    moduleBindings: Map<string, F0ModuleBindings>,
    fromFileId: string,
    targetExportName: string,
    resolveModule: (fromFileId: string, specifier: string) => string | null
  ): string[] {
    const fromModule = moduleBindings.get(fromFileId);
    if (!fromModule) return [];
    const locals: string[] = [];
    for (const localName of fromModule.namespaceImports.keys()) {
      const replay = this.resolveNamespaceMember(
        moduleBindings,
        fromFileId,
        localName,
        targetExportName,
        resolveModule
      );
      if (replay.result.valid) locals.push(localName);
    }
    return locals.sort();
  }
}
