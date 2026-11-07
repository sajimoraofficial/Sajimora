import path from 'node:path';
import ts from 'typescript';
import { DiscoveryCoverageChecker, Reference } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptDirectCallCoverageChecker } from './TypeScriptDirectCallCoverageChecker';

/** Closed snapshot domain for the finite Boolean vertical profile: every
 * direct named import and every direct call must occur in the route ledger. */
export class TypeScriptBooleanClosedCoverageChecker implements DiscoveryCoverageChecker {
  public readonly profileId = 'TS_BOOLEAN_IMPORT_AND_CALL_COVERAGE_V1';
  private readonly calls = new TypeScriptDirectCallCoverageChecker();

  public check(input: Parameters<DiscoveryCoverageChecker['check']>[0]): boolean {
    try {
      const omittedCode = (paths: readonly string[] | undefined) => paths?.some(file =>
        /\.(?:ts|tsx|js|jsx|json)$/i.test(file));
      if (omittedCode(input.repository.parentSnapshot.omittedBinaryPaths) ||
          omittedCode(input.repository.candidateSnapshot.omittedBinaryPaths) ||
          input.repository.parentSnapshot.files.some(file => file.isSymlink) ||
          input.repository.candidateSnapshot.files.some(file => file.isSymlink)) return false;
      const callReferences = input.references.filter(reference => reference.kind === 'STATIC_CALL');
      const importReferences = input.references.filter(reference => reference.kind === 'STATIC_IMPORT');
      if (callReferences.length + importReferences.length !== input.references.length ||
          !this.calls.check({ ...input, references: callReferences })) return false;
      const expected: Array<Pick<Reference, 'projectId' | 'targetEntityId' | 'kind' | 'location'>> = [];
      for (const file of input.repository.parentSnapshot.files.filter(entry =>
        entry.path.endsWith('.ts') && !entry.path.endsWith('.d.ts'))) {
        const source = input.repository.parentSnapshot.readTextFile(file.path);
        if (source === undefined) return false;
        const sf = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
        for (const statement of sf.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
              !statement.importClause?.namedBindings ||
              !ts.isNamedImports(statement.importClause.namedBindings)) continue;
          const specifier = statement.moduleSpecifier.text;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path),
            specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
          for (const element of statement.importClause.namedBindings.elements) {
            const name = element.propertyName?.text ?? element.name.text;
            const matches = input.targetEntities.filter(target => target.filePath === resolved && target.name === name);
            if (matches.length !== 1) return false;
            const loc = sf.getLineAndCharacterOfPosition(element.getStart(sf));
            expected.push({ projectId: input.parentGraph.projects[0].projectId,
              targetEntityId: matches[0].entityId, kind: 'STATIC_IMPORT',
              location: { filePath: file.path, line: loc.line + 1, character: loc.character + 1,
                length: element.getWidth(sf) } });
          }
        }
      }
      if (expected.length !== importReferences.length) return false;
      const key = (reference: typeof expected[number]): string => JSON.stringify([
        reference.projectId, reference.targetEntityId, reference.kind,
        reference.location.filePath, reference.location.line,
        reference.location.character, reference.location.length]);
      const left = expected.map(key).sort();
      const right = importReferences.map(key).sort();
      return left.every((value, index) => value === right[index]);
    } catch { return false; }
  }
}
