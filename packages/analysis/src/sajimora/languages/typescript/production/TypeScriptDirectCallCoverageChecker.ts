import path from 'node:path';
import ts from 'typescript';
import { DiscoveryCoverageChecker, Reference } from '../../../../../../core/src/sajimora/verification';

/** Deliberately small closed-world profile. It checks that all direct calls to
 * the changed top-level functions in the admitted .ts snapshot were reported.
 * Other imports, dynamic access, re-exports and external consumers
 * are outside this profile. This is discovery evidence, not a type proof. */
export class TypeScriptDirectCallCoverageChecker implements DiscoveryCoverageChecker {
  public readonly profileId = 'TS_DIRECT_CALL_CLOSED_SNAPSHOT_COVERAGE_V3';

  public check(input: Parameters<DiscoveryCoverageChecker['check']>[0]): boolean {
    try {
      const { repository, parentGraph, changes, targetEntities, references } = input;
      const activeChanges = changes.filter(change => change.changeKind !== 'UNCHANGED');
      if (targetEntities.length === 0 || targetEntities.length > 64 ||
          activeChanges.length !== targetEntities.length || parentGraph.projects.length !== 1 ||
          references.some(reference => reference.isUnresolvedBoundary || reference.kind !== 'STATIC_CALL')) return false;
      const targetsById = new Map(targetEntities.map(target => [target.entityId, target]));
      if (targetsById.size !== targetEntities.length ||
          new Set(targetEntities.map(target => `${target.filePath}\0${target.name}`)).size !== targetEntities.length ||
          targetEntities.some(target => target.kind !== 'FUNCTION' || !target.isExported ||
            target.projectId !== parentGraph.projects[0].projectId) ||
          new Set(activeChanges.map(change => change.identity.parentEntity?.entityId)).size !== activeChanges.length ||
          activeChanges.some(change => change.identity.status !== 'CONFIRMED_IDENTITY' ||
            !change.identity.candidateEntity || !targetsById.has(change.identity.parentEntity?.entityId ?? ''))) return false;
      const targetNames = new Set(targetEntities.map(target => target.name));
      const inventory = repository.parentSnapshot.files;
      const sourceFiles = inventory.filter(file => file.path.endsWith('.ts') && !file.path.endsWith('.d.ts'));
      if (sourceFiles.length === 0 || inventory.some(file =>
          !sourceFiles.includes(file) && !/(^|\/)(?:tsconfig(?:\.[^/]+)?\.json|package\.json)$/.test(file.path))) return false;
      const projectFiles = parentGraph.projects[0].sourceFiles;
      if (projectFiles.length !== sourceFiles.length ||
          new Set(projectFiles).size !== sourceFiles.length ||
          sourceFiles.some(file => !projectFiles.includes(file.path))) return false;
      for (const file of inventory) {
        if (sourceFiles.includes(file)) continue;
        const config = repository.parentSnapshot.readTextFile(file.path);
        if (config === undefined) return false;
        if (/(^|\/)package\.json$/.test(file.path)) {
          const parsed: unknown = JSON.parse(config);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
              ['workspaces', 'imports', 'exports'].some(key => Object.hasOwn(parsed, key))) return false;
        } else {
          const parsed = ts.parseConfigFileTextToJson(file.path, config);
          if (parsed.error || !parsed.config || typeof parsed.config !== 'object' ||
              Object.keys(parsed.config).some(key => !['compilerOptions', 'files', 'include', 'exclude'].includes(key)) ||
              Object.keys(parsed.config.compilerOptions ?? {}).some(key => !['strict', 'noEmit'].includes(key))) return false;
        }
      }
      const found: Array<Pick<Reference, 'projectId' | 'targetEntityId' | 'kind' | 'location'>> = [];
      const declarationCounts = new Map(targetEntities.map(target => [target.entityId, 0]));
      for (const file of sourceFiles) {
        const source = repository.parentSnapshot.readTextFile(file.path);
        if (source === undefined) return false;
        const sf = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
        const bindings = new Map<string, typeof targetEntities[number]>();
        for (const target of targetEntities.filter(item => item.filePath === file.path)) {
          if (bindings.has(target.name)) return false;
          bindings.set(target.name, target);
        }
        const importTokens = new Set<ts.Identifier>();
        for (const statement of sf.statements) {
          if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) ||
              ts.isImportEqualsDeclaration(statement)) return false;
          if (!ts.isImportDeclaration(statement)) continue;
          if (!ts.isStringLiteral(statement.moduleSpecifier) ||
              !/^\.\.?\//.test(statement.moduleSpecifier.text)) return false;
          const specifier = statement.moduleSpecifier.text;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path),
            specifier.endsWith('.ts') ? specifier : specifier + '.ts'));
          if (resolved.startsWith('../') || resolved === '..' || path.posix.isAbsolute(resolved)) return false;
          if (!statement.importClause?.namedBindings ||
              !ts.isNamedImports(statement.importClause.namedBindings) ||
              statement.importClause.name || statement.importClause.namedBindings.elements.length === 0 ||
              statement.importClause.isTypeOnly) return false;
          for (const element of statement.importClause.namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            const matches = targetEntities.filter(target => target.filePath === resolved && target.name === importedName);
            if (matches.length !== 1 || element.isTypeOnly || bindings.has(element.name.text) ||
                (element.propertyName && !ts.isIdentifier(element.propertyName))) return false;
            bindings.set(element.name.text, matches[0]);
            importTokens.add(element.name);
            if (element.propertyName) importTokens.add(element.propertyName);
          }
        }
        let valid = true;
        const visit = (node: ts.Node): void => {
          if (!valid) return;
          if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node) ||
              ts.isImportTypeNode(node) || ts.isExportDeclaration(node)) { valid = false; return; }
          if (ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text)))) { valid = false; return; }
          if (ts.isIdentifier(node) && (bindings.has(node.text) || targetNames.has(node.text))) {
            if (importTokens.has(node)) return;
            const bound = bindings.get(node.text);
            if (bound && ts.isFunctionDeclaration(node.parent) && node.parent.name === node &&
                bound.filePath === file.path && node.parent.parent === sf &&
                node.parent.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
              declarationCounts.set(bound.entityId, (declarationCounts.get(bound.entityId) ?? 0) + 1);
              return;
            }
            if (!ts.isCallExpression(node.parent) || node.parent.expression !== node ||
                node.parent.questionDotToken ||
                !bound) { valid = false; return; }
            const call = node.parent;
            const loc = sf.getLineAndCharacterOfPosition(call.getStart(sf));
            found.push({ projectId: bound.projectId, targetEntityId: bound.entityId, kind: 'STATIC_CALL',
              location: { filePath: file.path, line: loc.line + 1, character: loc.character + 1,
                length: call.getWidth(sf) } });
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
        if (!valid) return false;
      }
      if ([...declarationCounts.values()].some(count => count !== 1) || found.length !== references.length) return false;
      const key = (reference: typeof found[number]): string => JSON.stringify([
        reference.projectId, reference.targetEntityId, reference.kind, reference.location.filePath,
        reference.location.line, reference.location.character, reference.location.length]);
      const expected = found.map(key).sort();
      const reported = references.map(key).sort();
      return expected.every((value, index) => value === reported[index]);
    } catch { return false; }
  }
}
