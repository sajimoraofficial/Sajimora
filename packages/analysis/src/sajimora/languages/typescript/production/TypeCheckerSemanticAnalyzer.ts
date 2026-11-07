/**
 * @file TypeCheckerSemanticAnalyzer.ts
 * Real TypeScript TypeChecker-backed semantic analyzer for sealed Program Sets.
 * 
 * Features:
 * - Uses ts.TypeChecker for symbol resolution, aliasing, and export tables.
 * - Handles declaration merging (merged interfaces, namespaces).
 * - Handles function overloads with signature set extraction.
 * - Handles lexical shadowing (local variables never confused with imported targets).
 * - Follows re-exports, barrel files, aliases, and project references.
 * - Detects explicit dynamic boundaries and unresolved module diagnostics.
 * - Distinguishes required parameters from optional/defaulted parameters.
 */

import * as ts from 'typescript';
import { COMPILER_LIBRARY_ROOT } from './TypeScriptCompilerLibraries';
import {
  SemanticEntity,
  SemanticChange,
  Reference,
  SourceLocation,
  ResolutionFact
} from '../../../../../../core/src/sajimora/verification';
import { ProjectProgramInstance } from './ProgramSetManager';

export class TypeCheckerSemanticAnalyzer {
  public static extractEntities(instance: ProjectProgramInstance,
    onlyFiles?: ReadonlySet<string>): SemanticEntity[] {
    const { program, typeChecker, project } = instance;
    const entities: SemanticEntity[] = [];
    const dependencyHashCache = new Map<ts.Symbol, string>();
    const normalize = (file: string) => file.replace(/\\/g, '/').replace(/^\/+/, '');
    const rootFiles = new Set(project.sourceFiles.map(normalize));

    for (const sourceFile of program.getSourceFiles()) {
      // Exclude synthetic or external lib files
      if (sourceFile.fileName.startsWith(COMPILER_LIBRARY_ROOT + '/') || program.isSourceFileDefaultLibrary(sourceFile)) {
        continue;
      }
      if (!rootFiles.has(normalize(sourceFile.fileName))) {
        continue;
      }
      if (onlyFiles && !onlyFiles.has(normalize(sourceFile.fileName))) continue;

      const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) {
        // Fall back to visiting top-level declarations
        this.extractTopLevelDeclarations(sourceFile, project.projectId, typeChecker, program, entities, dependencyHashCache);
        continue;
      }

      const exports = typeChecker.getExportsOfModule(moduleSymbol);
      for (const exp of exports) {
        let actualSymbol = exp;
        let aliasFailure: string | undefined;
        if (exp.flags & ts.SymbolFlags.Alias) {
          try {
            actualSymbol = typeChecker.getAliasedSymbol(exp);
          } catch (error) {
            aliasFailure = error instanceof Error ? error.message : String(error);
          }
        }

        const declarations = actualSymbol.declarations ?? [];
        if (aliasFailure || declarations.length === 0) {
          entities.push(this.extractionBoundaryEntity(project.projectId, sourceFile.fileName, exp.name,
            aliasFailure ? 'TYPE_RESOLUTION_FAILURE' : 'DECLARATION_UNAVAILABLE',
            aliasFailure ? 'getAliasedSymbol' : 'readSymbolDeclarations', aliasFailure));
          continue;
        }

        const decl = declarations[0];
        if (decl.pos < 0) {
          entities.push(this.extractionBoundaryEntity(project.projectId, sourceFile.fileName, exp.name,
            'SYNTHETIC_NODE', 'extractExportedDeclaration'));
          continue;
        }
        if (!decl.parent) {
          entities.push(this.extractionBoundaryEntity(project.projectId, sourceFile.fileName, exp.name,
            'DETACHED_NODE', 'extractExportedDeclaration'));
          continue;
        }
        // getExportsOfModule includes aliases introduced by barrels and named
        // re-exports.  The semantic entity is owned by its declaration module;
        // materializing it again in every exporting module duplicates one
        // provider mutation into a chain of counterfeit changed entities.
        const declarationFile = decl.getSourceFile();
        if (declarationFile !== sourceFile && declarationFile.fileName !== sourceFile.fileName) {
          continue;
        }
        const kind = this.mapDeclarationKind(decl);
        const name = actualSymbol.name;
        const qualifiedName = `${project.projectId}::${sourceFile.fileName}::${name}`;

        // Handle overloads & declaration merging
        const {
          fingerprint, overloadsCount, bodySnippet, bodyHash, paramsCount, requiredParamsCount,
          paramNames, paramTypes, hasRest, restType, returnType, typePredicate, thisType, typeParameters
        } = this.analyzeSymbolSignatures(actualSymbol, typeChecker, sourceFile);
        const dependencyHash = this.computeDependencyHash(actualSymbol, typeChecker, program, dependencyHashCache);

        entities.push({
          entityId: qualifiedName,
          projectId: project.projectId,
          name,
          kind,
          qualifiedName,
          filePath: sourceFile.fileName,
          signatureFingerprint: fingerprint,
          isExported: true,
          metadata: {
            declarationLine: decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1,
            declarationsCount: declarations.length,
            overloadsCount,
            paramsCount,
            requiredParamsCount,
            paramNames,
            paramTypes,
            hasRest,
            restType,
            returnType,
            typePredicate,
            thisType,
            typeParameters,
            bodySnippet,
            bodyHash,
            dependencyHash
          }
        });
      }
      // Non-exported top-level declarations can be the actual changed provider
      // for exported callers. They belong in change detection; their callers
      // belong in the impact envelope, not in the changed-provider set.
      this.extractTopLevelDeclarations(sourceFile, project.projectId, typeChecker, program, entities, dependencyHashCache);
    }

    return entities;
  }

  public static discoverReferences(
    instance: ProjectProgramInstance,
    targetEntities: readonly SemanticEntity[]
  ): {
    staticReferences: Reference[];
    unresolvedBoundaries: Reference[];
    resolutionFacts: readonly ResolutionFact[];
  } {
    const { program, typeChecker, project, host } = instance;
    const staticReferences: Reference[] = [];
    const unresolvedBoundaries: Reference[] = [];

    // Resolve consumers by the checker binding's declaration, never by spelling.
    // This prevents same-name exports and aliases from being conflated.
    const targetKey = (filePath: string, kind: SemanticEntity['kind'], name: string) =>
      `${filePath.replace(/^\/+/, '')}::${kind}::${name}`;
    const targetEntityMap = new Map<string, SemanticEntity>();
    const targetsByName = new Map<string, SemanticEntity[]>();
    for (const t of targetEntities) {
      targetEntityMap.set(targetKey(t.filePath, t.kind, t.name), t);
      const entries = targetsByName.get(t.name) ?? [];
      entries.push(t);
      targetsByName.set(t.name, entries);
    }
    const targetForSymbol = (symbol: ts.Symbol | undefined): SemanticEntity | undefined => {
      if (!symbol) return undefined;
      let actual = symbol;
      if (actual.flags & ts.SymbolFlags.Alias) {
        try { actual = typeChecker.getAliasedSymbol(actual); } catch { return undefined; }
      }
      for (const declaration of actual.declarations ?? []) {
        const key = targetKey(declaration.getSourceFile().fileName, this.mapDeclarationKind(declaration), actual.name);
        const target = targetEntityMap.get(key);
        if (target) return target;
      }
      // A final fallback is safe only when the repository has exactly one
      // changed exported entity with this spelling; otherwise discovery must
      // remain unresolved rather than guess.
      // Member uses belong to their exported owning declaration, not a global
      // same-spelling export. Follow declaration ancestry to that owner.
      for (const declaration of actual.declarations ?? []) {
        let node: ts.Node | undefined = declaration.parent;
        while (node && !ts.isSourceFile(node)) {
          const name = (node as ts.NamedDeclaration).name;
          if (name && ts.isIdentifier(name)) {
            const target = targetEntityMap.get(targetKey(node.getSourceFile().fileName, this.mapDeclarationKind(node as ts.Declaration), name.text));
            if (target) return target;
          }
          node = node.parent;
        }
      }
      return undefined;
    };
    const emitted = new Set<string>();
    const emitStaticReference = (
      node: ts.Node,
      kind: Reference['kind'],
      symbol: ts.Symbol | undefined,
      consumerContext?: Reference['consumerContext'],
      fallbackName?: string
    ) => {
      const target = targetForSymbol(symbol);
      if (!target) return;
      const ownerSource = node.getSourceFile();
      const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normPath(ownerSource.fileName) === normPath(target.filePath)) {
        let enclosingDecl: ts.Node | undefined = node;
        while (enclosingDecl && enclosingDecl.parent && !ts.isSourceFile(enclosingDecl.parent)) {
          enclosingDecl = enclosingDecl.parent;
        }
        const enclosingName = (enclosingDecl as ts.NamedDeclaration)?.name;
        if (enclosingName && ts.isIdentifier(enclosingName) && enclosingName.text === target.name) {
          return;
        }
      }
      const loc = ownerSource.getLineAndCharacterOfPosition(node.getStart());
      const referenceId = `ref_${kind}_${project.projectId}_${ownerSource.fileName}_${loc.line}_${loc.character}`;
      if (emitted.has(referenceId)) return;
      emitted.add(referenceId);
      staticReferences.push({
        referenceId, projectId: project.projectId, kind, targetEntityId: target.entityId,
        location: { filePath: ownerSource.fileName, line: loc.line + 1, character: loc.character + 1, length: node.getWidth() },
        consumerContext, isUnresolvedBoundary: false
      });
    };

    // 1. Convert compiler environment failures into explicit reconstruction
    // boundaries. They are not semantic verdicts and must not be hidden behind
    // a generic UNKNOWN reason.
    const diagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics()
    ];
    for (const diag of diagnostics) {
      if ([2307, 2688, 2732, 2792, 6053, 6305, 7016].includes(diag.code)) {
        const diagnosticFile = diag.file?.fileName ?? project.configFile ?? 'tsconfig.json';
        const loc = diag.file && diag.start !== undefined
          ? diag.file.getLineAndCharacterOfPosition(diag.start)
          : { line: 0, character: 0 };
        const sourceSlice = diag.file && diag.start !== undefined
          ? diag.file.text.slice(diag.start, diag.start + (diag.length || 0)) : '';
        const reason = diag.code === 2688 ? 'AMBIENT_TYPE_UNAVAILABLE'
          : diag.code === 6305 ? 'GENERATED_DECLARATION_UNAVAILABLE'
            : diag.code === 6053 ? 'PROJECT_REFERENCE_UNAVAILABLE'
              : diag.code === 7016 ? 'DEPENDENCY_DECLARATION_UNAVAILABLE'
                : sourceSlice.includes("'.") || sourceSlice.includes('"./') || sourceSlice.includes('"../')
                  ? 'PROJECT_REFERENCE_UNAVAILABLE' : 'DEPENDENCY_CLOSURE_UNAVAILABLE';
        unresolvedBoundaries.push({
          referenceId: `ref_environment_${JSON.stringify([project.projectId, diagnosticFile, diag.code, diag.start, diag.length])}`,
          projectId: project.projectId,
          kind: 'UNRESOLVED_BOUNDARY',
          targetEntityId: targetEntities[0]?.entityId ?? 'ENVIRONMENT',
          location: {
            filePath: diagnosticFile,
            line: loc.line + 1,
            character: loc.character + 1,
            length: diag.length
          },
          isUnresolvedBoundary: true,
          boundaryTaxonomyReason: reason
        });
      }
    }

    // 1b. Check for syntactic parse diagnostics (TS1005, TS1109, etc.)
    const syntacticDiagnostics = program.getSyntacticDiagnostics();
    for (const diag of syntacticDiagnostics) {
      if (diag.file && diag.start !== undefined) {
        const loc = diag.file.getLineAndCharacterOfPosition(diag.start);
        unresolvedBoundaries.push({
          referenceId: `ref_parse_failed_${JSON.stringify([project.projectId, diag.file.fileName, diag.code, diag.start, diag.length])}`,
          projectId: project.projectId,
          kind: 'UNRESOLVED_BOUNDARY',
          targetEntityId: targetEntities[0]?.entityId ?? 'UNKNOWN_PARSE_FAILED_TARGET',
          location: {
            filePath: diag.file.fileName,
            line: loc.line + 1,
            character: loc.character + 1,
            length: diag.length
          },
          isUnresolvedBoundary: true,
          boundaryTaxonomyReason: 'PARSE_FAILED_POTENTIAL_CONSUMER'
        });
      }
    }

    // 2. Traverse AST for all project files
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.startsWith(COMPILER_LIBRARY_ROOT + '/') || program.isSourceFileDefaultLibrary(sourceFile)) {
        continue;
      }

      const visit = (node: ts.Node) => {
        // Passing a changed callable as an argument is a callback contract,
        // distinct from invoking it at this site.
        if (ts.isIdentifier(node) && ts.isCallExpression(node.parent) &&
            node.parent.arguments.some(argument => argument === node)) {
          emitStaticReference(node, 'STATIC_CALLBACK_REFERENCE', typeChecker.getSymbolAtLocation(node), undefined, node.text);
        }
        // JSX tags and expression containers are separate consumer contexts;
        // props/children specialization happens after discovery.
        if (ts.isJsxOpeningLikeElement(node) && ts.isIdentifier(node.tagName)) {
          emitStaticReference(node.tagName, 'STATIC_JSX_REFERENCE', typeChecker.getSymbolAtLocation(node.tagName), undefined, node.tagName.text);
        }
        if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
          emitStaticReference(node.expression, 'STATIC_JSX_REFERENCE', typeChecker.getSymbolAtLocation(node.expression), undefined, node.expression.text);
        }
        // Detect export * from './provider'
        if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const modSym = typeChecker.getSymbolAtLocation(node.moduleSpecifier);
          if (modSym) {
            const modExports = typeChecker.getExportsOfModule(modSym);
            for (const exp of modExports) {
              let actual = exp;
              if (actual.flags & ts.SymbolFlags.Alias) {
                try { actual = typeChecker.getAliasedSymbol(actual); } catch { /* ignore */ }
              }
              emitStaticReference(node.moduleSpecifier, 'STATIC_IMPORT', actual, undefined, exp.name);
            }
          }
        }
        if (ts.isImportSpecifier(node)) {
          const isTypeOnly = node.isTypeOnly || Boolean(node.parent?.parent?.isTypeOnly);
          const kind: Reference['kind'] = isTypeOnly ? 'STATIC_TYPE_REFERENCE' : 'STATIC_IMPORT';
          emitStaticReference(node, kind, typeChecker.getSymbolAtLocation(node.name), undefined, node.name.text);
        } else if (ts.isNamespaceImport(node)) {
          emitStaticReference(node, 'STATIC_IMPORT', typeChecker.getSymbolAtLocation(node.name), undefined, node.name.text);
        }
        if (ts.isImportClause(node) && node.name) {
          const isTypeOnly = Boolean(node.isTypeOnly);
          const kind: Reference['kind'] = isTypeOnly ? 'STATIC_TYPE_REFERENCE' : 'STATIC_IMPORT';
          emitStaticReference(node, kind, typeChecker.getSymbolAtLocation(node.name), undefined, node.name.text);
        }
        if (ts.isExportSpecifier(node)) {
          const isTypeOnly = node.isTypeOnly || Boolean(node.parent?.parent?.isTypeOnly);
          const kind: Reference['kind'] = isTypeOnly ? 'STATIC_TYPE_REFERENCE' : 'STATIC_IMPORT';
          emitStaticReference(node, kind, typeChecker.getSymbolAtLocation(node.name), undefined, node.name.text);
        }
        if (ts.isTypeReferenceNode(node)) {
          emitStaticReference(node, 'STATIC_TYPE_REFERENCE', typeChecker.getSymbolAtLocation(node.typeName));
        }
        if (ts.isExpressionWithTypeArguments(node) && node.parent && ts.isHeritageClause(node.parent)) {
          const isExtends = node.parent.token === ts.SyntaxKind.ExtendsKeyword;
          const refKind: Reference['kind'] = isExtends ? 'STATIC_INHERITANCE' : 'STATIC_IMPLEMENTATION';
          const parentClass = ts.isClassDeclaration(node.parent.parent) || ts.isInterfaceDeclaration(node.parent.parent) ? node.parent.parent : undefined;
          const declaringName = parentClass && parentClass.name ? parentClass.name.text : 'DerivedClass';
          const implementedMembers: string[] = [];
          if (parentClass && ts.isClassDeclaration(parentClass)) {
            for (const member of parentClass.members) {
              if (member.name && ts.isIdentifier(member.name)) {
                implementedMembers.push(member.name.text);
              }
            }
          }
          emitStaticReference(node, refKind, typeChecker.getSymbolAtLocation(node.expression), {
            contextDetails: {
              clauseKind: isExtends ? 'extends' : 'implements',
              declaringName,
              implementedMembers
            }
          });
        }
        // Detect dynamic element access calls: obj[variable]()
        if (ts.isElementAccessExpression(node) && node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          if (!ts.isStringLiteral(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
            const loc = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            unresolvedBoundaries.push({
              referenceId: `ref_dynamic_${project.projectId}_${loc.line}_${loc.character}`,
              projectId: project.projectId,
              kind: 'DYNAMIC_PROPERTY_ACCESS',
              targetEntityId: 'UNKNOWN_DYNAMIC_TARGET',
              location: {
                filePath: sourceFile.fileName,
                line: loc.line + 1,
                character: loc.character + 1,
                length: node.getWidth()
              },
              isUnresolvedBoundary: true,
              boundaryTaxonomyReason: 'DYNAMIC_PROPERTY_INDEX'
            });
          }
        }

        // Detect eval calls
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
          const loc = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          unresolvedBoundaries.push({
            referenceId: `ref_eval_${project.projectId}_${loc.line}_${loc.character}`,
            projectId: project.projectId,
            kind: 'REFLECTION_OR_METAPROGRAMMING',
            targetEntityId: 'GLOBAL_EVAL',
            location: {
              filePath: sourceFile.fileName,
              line: loc.line + 1,
              character: loc.character + 1,
              length: node.getWidth()
            },
            isUnresolvedBoundary: true,
            boundaryTaxonomyReason: 'EVAL_EXECUTION'
          });
        }

        // Detect dynamic import: import(variable)
        if (node.kind === ts.SyntaxKind.ImportKeyword && node.parent && ts.isCallExpression(node.parent)) {
          const callExpr = node.parent;
          const arg = callExpr.arguments[0];
          if (arg && !ts.isStringLiteral(arg)) {
            const loc = sourceFile.getLineAndCharacterOfPosition(callExpr.getStart());
            unresolvedBoundaries.push({
              referenceId: `ref_dyn_import_${project.projectId}_${loc.line}_${loc.character}`,
              projectId: project.projectId,
              kind: 'DYNAMIC_MODULE_LOAD',
              targetEntityId: 'DYNAMIC_IMPORT_SPECIFIER',
              location: {
                filePath: sourceFile.fileName,
                line: loc.line + 1,
                character: loc.character + 1,
                length: callExpr.getWidth()
              },
              isUnresolvedBoundary: true,
              boundaryTaxonomyReason: 'DYNAMIC_MODULE_SPECIFIER'
            });
          }
        }

        // Detect static consumer calls via TypeChecker
        if (ts.isCallExpression(node)) {
          let callTargetSymbol: ts.Symbol | undefined;
          let invokedName: string | undefined;
          if (ts.isIdentifier(node.expression)) {
            invokedName = node.expression.text;
            callTargetSymbol = typeChecker.getSymbolAtLocation(node.expression);
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            invokedName = node.expression.name.text;
            callTargetSymbol = typeChecker.getSymbolAtLocation(node.expression.name);
          }
          const target = targetForSymbol(callTargetSymbol) ??
            (invokedName && targetsByName.get(invokedName)?.length === 1 ? targetsByName.get(invokedName)![0] : undefined);
          if (target) {
              const isLocalShadow = callTargetSymbol && callTargetSymbol.declarations?.some(d =>
                ts.isParameter(d) ||
                (ts.isVariableDeclaration(d) && d.getSourceFile().fileName === sourceFile.fileName && !ts.isSourceFile(d.parent.parent.parent))
              );

              if (!isLocalShadow) {
                const argsCount = node.arguments.length;
                const argTypes = node.arguments.map(arg => {
                  try {
                    const t = typeChecker.getTypeAtLocation(arg);
                    return typeChecker.typeToString(t);
                  } catch {
                    return 'any';
                  }
                });

                const hasSpread = node.arguments.some(arg => ts.isSpreadElement(arg));
                let tupleSpreadTypes: string[] | undefined;
                if (hasSpread) {
                  for (const arg of node.arguments) {
                    if (ts.isSpreadElement(arg)) {
                      try {
                        const t = typeChecker.getTypeAtLocation(arg.expression);
                        const str = typeChecker.typeToString(t);
                        if (str.startsWith('[')) {
                          tupleSpreadTypes = str.slice(1, -1).split(',').map(s => s.trim());
                        }
                      } catch { /* ignore */ }
                    }
                  }
                }

                let receiverType: string | undefined;
                let isDetached = false;
                if (ts.isPropertyAccessExpression(node.expression)) {
                  try {
                    const recvT = typeChecker.getTypeAtLocation(node.expression.expression);
                    receiverType = typeChecker.typeToString(recvT);
                  } catch { /* ignore */ }
                } else if (ts.isIdentifier(node.expression)) {
                  isDetached = true;
                }

                const isPredicateNarrowingConsumed = Boolean(
                  (ts.isIfStatement(node.parent) && node.parent.expression === node) ||
                  (ts.isConditionalExpression(node.parent) && node.parent.condition === node)
                );

                emitStaticReference(node, 'STATIC_CALL', callTargetSymbol, {
                  argumentsCount: argsCount,
                  argumentTypes: argTypes,
                  returnConsumed: !ts.isExpressionStatement(node.parent),
                  contextDetails: {
                    hasSpreadArgument: hasSpread,
                    tupleSpreadTypes,
                    receiverType,
                    isDetachedCall: isDetached,
                    isPredicateNarrowingConsumed,
                    hasAnyArgument: argTypes.some(t => t.trim() === 'any')
                  }
                }, invokedName);
              }
          }
        }

        if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent)) {
          let accessMode: 'READ' | 'WRITE' | 'READ_WRITE' = 'READ';
          let assignedValueType: string | undefined;
          let expectedReadType: string | undefined;
          let receiverType: string | undefined;

          try {
            const rType = typeChecker.getTypeAtLocation(node.expression);
            receiverType = typeChecker.typeToString(rType);
          } catch { /* ignore */ }

          if (ts.isBinaryExpression(node.parent) && node.parent.left === node) {
            if (node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              accessMode = 'WRITE';
            } else {
              accessMode = 'READ_WRITE';
            }
            try {
              const valT = typeChecker.getTypeAtLocation(node.parent.right);
              assignedValueType = typeChecker.typeToString(valT);
            } catch { /* ignore */ }
          } else if (
            (ts.isPrefixUnaryExpression(node.parent) && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
            (ts.isPostfixUnaryExpression(node.parent) && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken))
          ) {
            accessMode = 'READ_WRITE';
          } else {
            accessMode = 'READ';
            try {
              const readT = typeChecker.getTypeAtLocation(node);
              expectedReadType = typeChecker.typeToString(readT);
            } catch { /* ignore */ }
          }

          emitStaticReference(node, 'STATIC_PROPERTY_ACCESS', typeChecker.getSymbolAtLocation(node.name), {
            contextDetails: {
              propertyName: node.name.text,
              accessMode,
              assignedValueType,
              expectedReadType,
              receiverType
            }
          });
        }

        // Detect ambient module or global augmentation
        if (ts.isModuleDeclaration(node)) {
          if ((node.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(node.name)) {
            const loc = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const augName = ts.isStringLiteral(node.name) ? node.name.text : 'global';
            const matchedTarget = targetEntities.find(t => t.filePath.includes(augName));
            const referenceId = `ref_ambient_${project.projectId}_${sourceFile.fileName}_${loc.line}_${loc.character}`;
            if (!emitted.has(referenceId)) {
              emitted.add(referenceId);
              staticReferences.push({
                referenceId,
                projectId: project.projectId,
                kind: 'AMBIENT_OR_GLOBAL_ACCESS',
                targetEntityId: matchedTarget ? matchedTarget.entityId : (targetEntities[0]?.entityId ?? 'GLOBAL_AUGMENTATION'),
                location: {
                  filePath: sourceFile.fileName,
                  line: loc.line + 1,
                  character: loc.character + 1,
                  length: node.getWidth()
                },
                isUnresolvedBoundary: false
              });
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    return {
      staticReferences,
      unresolvedBoundaries,
      resolutionFacts: host.getResolutionFacts()
    };
  }

  private static analyzeSymbolSignatures(
    symbol: ts.Symbol,
    typeChecker: ts.TypeChecker,
    sourceFile: ts.SourceFile
  ): {
    fingerprint: string;
    overloadsCount: number;
    bodySnippet: string;
    bodyHash: string;
    paramsCount: number;
    requiredParamsCount: number;
    paramNames: string[];
    paramTypes: string[];
    hasRest: boolean;
    restType?: string;
    returnType: string;
    typePredicate?: string;
    thisType?: string;
    typeParameters?: Array<{ name: string; constraint?: string; default?: string }>;
  } {
    const declarations = symbol.declarations ?? [];
    let overloadsCount = 0;
    let bodySnippet = '';
    let lastBodyNode: ts.Block | ts.Expression | undefined;
    let lastParams: readonly ts.ParameterDeclaration[] | undefined;
    let maxParams = 0;
    let maxReqParams = 0;
    let paramNames: string[] = [];
    let paramTypes: string[] = [];
    let hasRest = false;
    let restType: string | undefined;
    let returnType = 'any';
    let typePredicate: string | undefined;
    let thisType: string | undefined;
    let typeParameters: Array<{ name: string; constraint?: string; default?: string }> | undefined;
    const signaturesText: string[] = [];

    for (const decl of declarations) {
      if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
        overloadsCount++;
        const thisParam = decl.parameters.find(p => p.name.getText() === 'this');
        if (thisParam && thisParam.type) {
          thisType = thisParam.type.getText();
        }

        const regularParams = decl.parameters.filter(p => p !== thisParam);
        const pCount = regularParams.length;
        const reqCount = regularParams.filter(p => !p.questionToken && !p.initializer && !p.dotDotDotToken).length;
        if (pCount > maxParams) maxParams = pCount;
        if (reqCount > maxReqParams) maxReqParams = reqCount;
        paramNames = regularParams.map(p => p.name.getText());
        paramTypes = regularParams.map(p => p.type ? p.type.getText() : 'any');

        const restParam = regularParams.find(p => p.dotDotDotToken);
        if (restParam) {
          hasRest = true;
          if (restParam.type) {
            const raw = restParam.type.getText();
            restType = raw.endsWith('[]') ? raw.slice(0, -2) : raw;
          }
        }

        let retStr = decl.type ? decl.type.getText() : undefined;
        if (!retStr) {
          try {
            const sig = typeChecker.getSignatureFromDeclaration(decl);
            if (sig) {
              const ret = typeChecker.getReturnTypeOfSignature(sig);
              retStr = typeChecker.typeToString(ret, decl, ts.TypeFormatFlags.NoTruncation);
            }
          } catch { /* ignore */ }
        }
        if (!retStr) retStr = 'any';

        if (decl.type) {
          returnType = decl.type.getText();
          if (ts.isTypePredicateNode(decl.type)) {
            typePredicate = decl.type.getText();
          }
        } else {
          returnType = retStr;
        }

        if (decl.typeParameters && decl.typeParameters.length > 0) {
          typeParameters = decl.typeParameters.map(tp => ({
            name: tp.name.text,
            constraint: tp.constraint?.getText(),
            default: tp.default?.getText()
          }));
        }

        const paramsStr = regularParams
          .map(p => `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${p.questionToken || p.initializer ? '?' : ''}${p.type ? ': ' + p.type.getText() : ''}`)
          .join(', ');
        const typeParams = decl.typeParameters?.length
          ? `<${decl.typeParameters.map(tp => `${tp.name.text}${tp.constraint ? ` extends ${tp.constraint.getText()}` : ''}${tp.default ? ` = ${tp.default.getText()}` : ''}`).join(', ')}>`
          : '';
        signaturesText.push(`${typeParams}(${paramsStr}) => ${retStr}`);

        if (decl.body) {
          bodySnippet = decl.body.getText();
          lastBodyNode = decl.body;
          lastParams = regularParams;
        }
      } else if (ts.isInterfaceDeclaration(decl)) {
        signaturesText.push(decl.getText());
      } else if (ts.isTypeAliasDeclaration(decl)) {
        signaturesText.push(decl.getText());
      } else if (ts.isClassDeclaration(decl)) {
        signaturesText.push(decl.getText());
      } else {
        // Variables, enums and exported arrow functions must not all fingerprint
        // as 'any'. Include syntax and the compiler-resolved declaration type.
        signaturesText.push(decl.getText());
        signaturesText.push(typeChecker.typeToString(typeChecker.getTypeAtLocation(decl), decl, ts.TypeFormatFlags.NoTruncation));
      }
    }

    const fingerprint = signaturesText.join(' & ') || 'any';
    const bodyHash = this.computeHash(lastBodyNode ? this.computeCanonicalBody(lastBodyNode, lastParams) : bodySnippet);

    return {
      fingerprint,
      overloadsCount,
      bodySnippet,
      bodyHash,
      paramsCount: maxParams,
      requiredParamsCount: maxReqParams,
      paramNames,
      paramTypes,
      hasRest,
      restType,
      returnType,
      typePredicate,
      thisType,
      typeParameters
    };
  }

  private static extractTopLevelDeclarations(
    sourceFile: ts.SourceFile,
    projectId: string,
    typeChecker: ts.TypeChecker,
    program: ts.Program,
    entities: SemanticEntity[],
    dependencyHashCache: Map<ts.Symbol, string>
  ): void {
    ts.forEachChild(sourceFile, node => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const entityId = `${projectId}::${sourceFile.fileName}::${name}`;
        if (entities.some(entity => entity.entityId === entityId)) return;
        const isExported = Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
        const typeParamsFingerprint = node.typeParameters?.length
          ? `<${node.typeParameters.map(tp => `${tp.name.text}${tp.constraint ? ` extends ${tp.constraint.getText()}` : ''}${tp.default ? ` = ${tp.default.getText()}` : ''}`).join(', ')}>`
          : '';
        const sig = `${typeParamsFingerprint}(${node.parameters.map(p => p.type ? p.type.getText() : 'any').join(', ')}) => ${node.type ? node.type.getText() : 'any'}`;
        const bodySnippet = node.body ? node.body.getText() : '';
        const thisParam = node.parameters.find(p => p.name.getText() === 'this');
        const regularParams = node.parameters.filter(p => p !== thisParam);
        const reqCount = regularParams.filter(p => !p.questionToken && !p.initializer && !p.dotDotDotToken).length;
        const paramNames = regularParams.map(p => p.name.getText());
        const paramTypes = regularParams.map(p => p.type ? p.type.getText() : 'any');
        const restParam = regularParams.find(p => p.dotDotDotToken);
        const hasRest = Boolean(restParam);
        const restType = restParam?.type ? (restParam.type.getText().endsWith('[]') ? restParam.type.getText().slice(0, -2) : restParam.type.getText()) : undefined;
        const returnType = node.type ? node.type.getText() : 'any';
        const typePredicate = node.type && ts.isTypePredicateNode(node.type) ? node.type.getText() : undefined;
        const thisType = thisParam?.type ? thisParam.type.getText() : undefined;
        const typeParameters = node.typeParameters?.map(tp => ({
          name: tp.name.text,
          constraint: tp.constraint?.getText(),
          default: tp.default?.getText()
        }));
        const symbol = typeChecker.getSymbolAtLocation(node.name);
        const dependencyHash = symbol ? this.computeDependencyHash(symbol, typeChecker, program, dependencyHashCache) : this.computeHash('');

        entities.push({
          entityId,
          projectId,
          name,
          kind: 'FUNCTION',
          qualifiedName: `${projectId}::${sourceFile.fileName}::${name}`,
          filePath: sourceFile.fileName,
          signatureFingerprint: sig,
          isExported,
          metadata: {
            paramsCount: regularParams.length,
            requiredParamsCount: reqCount,
            paramNames,
            paramTypes,
            hasRest,
            restType,
            returnType,
            typePredicate,
            thisType,
            typeParameters,
            bodySnippet,
            bodyHash: this.computeHash(node.body ? this.computeCanonicalBody(node.body, regularParams) : bodySnippet),
            dependencyHash
          }
        });
      }
    });
  }

  private static mapDeclarationKind(decl: ts.Declaration): SemanticEntity['kind'] {
    if (ts.isFunctionDeclaration(decl)) return 'FUNCTION';
    if (ts.isMethodDeclaration(decl)) return 'METHOD';
    if (ts.isConstructorDeclaration(decl)) return 'CONSTRUCTOR';
    if (ts.isClassDeclaration(decl)) return 'CLASS';
    if (ts.isInterfaceDeclaration(decl)) return 'INTERFACE';
    if (ts.isTypeAliasDeclaration(decl)) return 'TYPE_ALIAS';
    if (ts.isVariableDeclaration(decl)) return 'VARIABLE';
    if (ts.isEnumDeclaration(decl)) return 'ENUM';
    return 'CUSTOM';
  }

  private static extractionBoundaryEntity(
    projectId: string,
    filePath: string,
    name: string,
    taxonomy: 'UNSUPPORTED_AST_NODE' | 'SYNTHETIC_NODE' | 'DETACHED_NODE' | 'TYPE_RESOLUTION_FAILURE' | 'DECLARATION_UNAVAILABLE' | 'COMPILER_INTERNAL_FAILURE',
    operation: string,
    compilerError?: string
  ): SemanticEntity {
    return { entityId: `${projectId}::${filePath}::boundary::${name}`, projectId, name, kind: 'CUSTOM',
      qualifiedName: `${projectId}::${filePath}::${name}`, filePath,
      signatureFingerprint: `UNRESOLVED_AST_BOUNDARY:${taxonomy}`, isExported: true,
      metadata: { extractionBoundary: taxonomy, astKind: 'Unknown', file: filePath,
        operation, compilerError, provenance: 'TYPESCRIPT_COMPILER_EXPORT_TABLE' } };
  }

  /** Fingerprints compiler-proven declaration dependencies, including local
   * helpers, captured module state, imports, inheritance and inferred types.
   * The walk is symbol-based and cycle-safe; textual proximity is never used
   * as evidence of dependency. */
  private static computeDependencyHash(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    program: ts.Program | undefined,
    cache: Map<ts.Symbol, string>,
    active = new Set<ts.Symbol>()
  ): string {
    if (!program) return this.computeHash('DEPENDENCY_PROGRAM_UNAVAILABLE');
    let root = symbol;
    if (root.flags & ts.SymbolFlags.Alias) {
      try { root = checker.getAliasedSymbol(root); } catch { return this.computeHash('TYPE_RESOLUTION_FAILURE'); }
    }
    const cached = cache.get(root);
    if (cached !== undefined) return cached;
    if (active.has(root)) return this.computeHash(`CYCLE:${root.name}`);
    active.add(root);
    const rootDeclarations = new Set(root.declarations ?? []);
    const rootFiles = new Set([...rootDeclarations].map(declaration => declaration.getSourceFile().fileName));
    const facts = new Set<string>();
    const libraries = new Set(program.getSourceFiles().filter(file => program.isSourceFileDefaultLibrary(file)));

    const canonical = (candidate: ts.Symbol): ts.Symbol | undefined => {
      if (candidate.flags & ts.SymbolFlags.Alias) {
        try { return checker.getAliasedSymbol(candidate); } catch { return undefined; }
      }
      return candidate;
    };
    const addSymbol = (candidate: ts.Symbol) => {
      const actual = canonical(candidate);
      if (!actual || actual === root) return;
      for (const declaration of actual.declarations ?? []) {
        const source = declaration.getSourceFile?.();
        // Cross-module dependencies are impact-envelope edges, not intrinsic
        // mutations of the consuming entity. Local helpers and captured module
        // state contribute to entity metadata because they share its module.
        if (!source || !rootFiles.has(source.fileName) || libraries.has(source) || source.fileName.startsWith(COMPILER_LIBRARY_ROOT + '/')) continue;
        let text: string;
        try { text = declaration.getText(source); } catch { continue; }
        const transitive = this.computeDependencyHash(actual, checker, program, cache, active);
        facts.add(`${source.fileName}:${declaration.pos}:${declaration.end}:${text}:${transitive}`);
      }
    };

    for (const declaration of rootDeclarations) {
      const visitRoot = (node: ts.Node) => {
        if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
          let referenced: ts.Symbol | undefined;
          try { referenced = checker.getSymbolAtLocation(node); } catch { referenced = undefined; }
          const actual = referenced && canonical(referenced);
          if (actual && actual !== root) addSymbol(actual);
        }
        ts.forEachChild(node, visitRoot);
      };
      ts.forEachChild(declaration, visitRoot);
    }
    const result = this.computeHash([...facts].sort().join('\n'));
    active.delete(root);
    cache.set(root, result);
    return result;
  }

  private static computeCanonicalBody(
    body: ts.Block | ts.Expression | undefined,
    parameters?: readonly ts.ParameterDeclaration[]
  ): string {
    if (!body) return '';
    const localScope = new Map<string, string>();
    let paramCount = 0;
    if (parameters) {
      for (const p of parameters) {
        if (ts.isIdentifier(p.name)) {
          localScope.set(p.name.text, `_p${paramCount++}`);
        }
      }
    }
    let varCount = 0;
    const collectLocals = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (!localScope.has(node.name.text)) {
          localScope.set(node.name.text, `_v${varCount++}`);
        }
      }
      ts.forEachChild(node, collectLocals);
    };
    collectLocals(body);

    const serialize = (node: ts.Node): string => {
      if (ts.isShorthandPropertyAssignment(node)) {
        return `ShorthandPropertyAssignment:${node.name.text}:${localScope.get(node.name.text) || node.name.text}`;
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
          return `PropAccess:${node.text}`;
        }
        if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
          return `PropAssignKey:${node.text}`;
        }
        if (localScope.has(node.text)) {
          return localScope.get(node.text)!;
        }
        return `Id:${node.text}`;
      }
      if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return `${ts.SyntaxKind[node.kind]}:${node.getText()}`;
      }
      const parts: string[] = [ts.SyntaxKind[node.kind]];
      node.forEachChild(child => {
        parts.push(serialize(child));
      });
      return parts.join(':');
    };
    return serialize(body);
  }

  private static computeHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }
}
