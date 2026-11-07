import * as path from 'node:path';
import * as ts from 'typescript';
import { GenericProjectGraph, GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';
import { buildSealedWorkspacePackageIndex } from './SealedWorkspacePackages';
import { createSealedImportConditionCache, sealedImportConditions } from './SealedImportConditions';

export interface SealedProjectClosure {
  readonly selectedProjectIds: readonly string[];
  readonly reachedFiles: readonly string[];
  readonly blockers: readonly string[];
  readonly status: 'PROVEN' | 'UNPROVEN';
}

const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
const source = (value: string) => /\.(?:[cm]?[jt]sx?)$/i.test(value);
const probes = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx', '/index.d.ts'];
const candidates = (base: string): string[] => {
  const substitutions = /\.mjs$/i.test(base) ? [base.replace(/\.mjs$/i, '.mts'), base.replace(/\.mjs$/i, '.d.mts')]
    : /\.cjs$/i.test(base) ? [base.replace(/\.cjs$/i, '.cts'), base.replace(/\.cjs$/i, '.d.cts')]
      : /\.jsx?$/i.test(base) ? [base.replace(/\.jsx?$/i, '.ts'),
        base.replace(/\.jsx?$/i, '.tsx'), base.replace(/\.jsx?$/i, '.d.ts')] : [];
  return [...substitutions, ...probes.map(suffix => base + suffix)];
};

/** Conservative, sealed reverse-consumer closure. A PROVEN result requires
 * every project source and every relevant import edge to be accounted for. */
export function buildSealedProjectClosure(snapshot: GenericRepositorySnapshot,
  graph: GenericProjectGraph, changedSourcePaths: readonly string[]): SealedProjectClosure {
  const blockers = new Set<string>();
  const inventory = new Set(snapshot.files.map(file => norm(file.path)));
  const workspace = buildSealedWorkspacePackageIndex(snapshot);
  const conditionCache = createSealedImportConditionCache();
  workspace.blockers.forEach(blocker => blockers.add(blocker));
  const owners = new Map<string, Set<string>>();
  for (const project of graph.projects) {
    const options = project.options ?? {};
    if (options['paths'] || options['baseUrl'] || options['rootDirs'] || options['moduleSuffixes']) {
      blockers.add(`UNSUPPORTED_RESOLUTION_OPTIONS:${project.projectId}`);
    }
    for (const file of project.sourceFiles) {
      const key = norm(file);
      if (!source(key)) continue;
      if (!inventory.has(key)) blockers.add(`MISSING_PROJECT_SOURCE:${project.projectId}:${key}`);
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(project.projectId);
      owners.set(key, ids);
    }
  }
  const imports = new Map<string, Set<string>>();
  for (const file of [...owners.keys()].sort()) {
    const text = snapshot.readTextFile(file);
    if (text === undefined) { blockers.add(`UNREADABLE_PROJECT_SOURCE:${file}`); continue; }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false,
      /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      blockers.add(`PARSE_FAILED_PROJECT_SOURCE:${file}`);
    }
    const edges = new Set<string>();
    const record = (specifier: string): void => {
      if (!specifier.startsWith('.')) {
        const localPackage = workspace.resolve(specifier);
        if (localPackage) {
          const contexts = sealedImportConditions(file, graph, [...(owners.get(file) ?? [])], snapshot, conditionCache);
          for (const conditions of contexts ?? [undefined]) {
            const entry = workspace.resolveEntry(specifier, conditions);
            entry.files.forEach(sourceFile => edges.add(sourceFile));
            entry.blockers.forEach(blocker => blockers.add(blocker));
          }
        }
        else blockers.add(`EXTERNAL_MODULE_EDGE:${file}:${specifier}`);
        return;
      }
      const base = norm(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
      const resolved = candidates(base).find(candidate => inventory.has(candidate));
      if (!resolved) { blockers.add(`UNRESOLVED_MODULE_EDGE:${file}:${specifier}`); return; }
      edges.add(resolved);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)) record(node.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(node)) blockers.add(`IMPORT_EQUALS_EDGE:${file}`);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        blockers.add(`DYNAMIC_MODULE_EDGE:${file}`);
      }
      if (ts.isModuleDeclaration(node)) blockers.add(`AMBIENT_MODULE_DECLARATION:${file}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    imports.set(file, edges);
  }
  const reverse = new Map<string, Set<string>>();
  for (const [importer, targets] of imports) for (const target of targets) {
    const importers = reverse.get(target) ?? new Set<string>();
    importers.add(importer); reverse.set(target, importers);
  }
  const reached = new Set(changedSourcePaths.map(norm));
  const queue = [...reached];
  while (queue.length) for (const importer of reverse.get(queue.shift()!) ?? []) {
    if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
  }
  const selected = new Set<string>();
  for (const file of reached) {
    const ids = owners.get(file);
    if (!ids?.size) blockers.add(`CHANGED_SOURCE_OUTSIDE_PROJECTS:${file}`);
    ids?.forEach(id => selected.add(id));
  }
  // Project references propagate impact to projects that consume a selected
  // project, even when no direct source import was observed.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of graph.edges) if (selected.has(edge.toProjectId) && !selected.has(edge.fromProjectId)) {
      selected.add(edge.fromProjectId); expanded = true;
    }
  }
  return { selectedProjectIds: [...selected].sort(), reachedFiles: [...reached].sort(),
    blockers: [...blockers].sort(), status: blockers.size ? 'UNPROVEN' : 'PROVEN' };
}
