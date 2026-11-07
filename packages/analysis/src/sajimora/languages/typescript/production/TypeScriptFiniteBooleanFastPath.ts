import path from 'node:path';
import ts from 'typescript';
import { GenericProjectGraph, GenericRepository, Reference, SemanticChange,
  SemanticEntity } from '../../../../../../core/src/sajimora/verification';
import { readFiniteBooleanModel } from './TypeScriptFiniteBooleanProof';

export type FiniteBooleanFastResult = { entities: readonly SemanticEntity[];
  changes: readonly SemanticChange[]; references: readonly Reference[] };

/** Source-only producer for the already bounded Boolean profile. The separate
 * coverage checker must still reconstruct the entire reference domain. */
export function tryFiniteBooleanFastPath(repository: GenericRepository,
  parentGraph: GenericProjectGraph, candidateGraph: GenericProjectGraph): FiniteBooleanFastResult | undefined {
  if (parentGraph.projects.length !== 1 || candidateGraph.projects.length !== 1) return undefined;
  const parentFiles = new Map(repository.parentSnapshot.files.map(file => [file.path, file]));
  const candidateFiles = new Map(repository.candidateSnapshot.files.map(file => [file.path, file]));
  const changed = [...new Set([...parentFiles.keys(), ...candidateFiles.keys()])].filter(file =>
    parentFiles.get(file)?.hash !== candidateFiles.get(file)?.hash);
  if (changed.length !== 1 || !changed[0].endsWith('.ts') || changed[0].endsWith('.d.ts')) return undefined;
  const file = changed[0];
  if (!parentGraph.projects[0].sourceFiles.includes(file) ||
      !candidateGraph.projects[0].sourceFiles.includes(file)) return undefined;
  const beforeSource = repository.parentSnapshot.readTextFile(file);
  const afterSource = repository.candidateSnapshot.readTextFile(file);
  if (beforeSource === undefined || afterSource === undefined) return undefined;
  const beforeAst = ts.createSourceFile(file, beforeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const afterAst = ts.createSourceFile(file, afterSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (sf: ts.SourceFile) => sf.statements.length === 1 &&
    ts.isFunctionDeclaration(sf.statements[0]) ? sf.statements[0] : undefined;
  const beforeFn = declaration(beforeAst), afterFn = declaration(afterAst);
  if (!beforeFn?.name || !afterFn?.name || beforeFn.name.text !== afterFn.name.text) return undefined;
  const beforeModel = readFiniteBooleanModel(repository.parentSnapshot, file, beforeFn.name.text);
  const afterModel = readFiniteBooleanModel(repository.candidateSnapshot, file, afterFn.name.text);
  if (!beforeModel || !afterModel || beforeModel.parameterCount !== afterModel.parameterCount) return undefined;
  const makeEntity = (projectId: string, hash: string): SemanticEntity => ({
    entityId: `${projectId}::${file}::${beforeFn.name!.text}`, projectId, filePath: file,
    name: beforeFn.name!.text, qualifiedName: `${projectId}::${file}::${beforeFn.name!.text}`,
    kind: 'FUNCTION', isExported: true,
    signatureFingerprint: `BOOLEAN_ARITY_${beforeModel.parameterCount}`,
    metadata: { bodyHash: hash, declarationLine: beforeModel.declarationLine }
  });
  const before = makeEntity(parentGraph.projects[0].projectId, beforeModel.sourceHash);
  const after = makeEntity(candidateGraph.projects[0].projectId, afterModel.sourceHash);
  const change: SemanticChange = { changeId: `change_${before.entityId}`, changeKind: 'BODY_MUTATED',
    description: `${file} changed within the finite Boolean profile`,
    identity: { identityId: `id_${before.entityId}`, status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
      parentEntity: before, candidateEntity: after },
    deltaDescriptor: { sourceChanged: true } };
  const references: Reference[] = [];
  for (const sourceFile of repository.parentSnapshot.files.filter(entry => entry.path.endsWith('.ts') &&
    !entry.path.endsWith('.d.ts'))) {
    const text = repository.parentSnapshot.readTextFile(sourceFile.path);
    if (text === undefined) return undefined;
    const sf = ts.createSourceFile(sourceFile.path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return undefined;
    const bindings = new Set<string>();
    const push = (node: ts.Node, kind: Reference['kind']) => {
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      references.push({ referenceId: `fast_${kind}_${sourceFile.path}_${loc.line}_${loc.character}`,
        projectId: before.projectId, targetEntityId: before.entityId, kind,
        location: { filePath: sourceFile.path, line: loc.line + 1, character: loc.character + 1,
          length: node.getWidth(sf) }, isUnresolvedBoundary: false });
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const specifier = statement.moduleSpecifier.text;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile.path),
        specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      if (resolved !== file) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) !== before.name || element.isTypeOnly) continue;
        bindings.add(element.name.text);
        push(element, 'STATIC_IMPORT');
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) {
        push(node, 'STATIC_CALL');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { entities: [before], changes: [change], references };
}
