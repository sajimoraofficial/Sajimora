import * as path from 'node:path';
import * as ts from 'typescript';
import { GenericProjectGraph, GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';
import { SealedProjectClosure } from './SealedProjectClosure';
import { buildSealedWorkspacePackageIndex } from './SealedWorkspacePackages';
import { createSealedImportConditionCache, sealedImportConditions } from './SealedImportConditions';
import { SealedCompilerHost } from './SealedCompilerHost';

export interface ProjectClosureVerification {
  readonly status: 'PROVEN' | 'UNPROVEN';
  readonly blockers: readonly string[];
  readonly selectedProjectIds: readonly string[];
}

const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
const source = (value: string) => /\.(?:[cm]?[jt]sx?)$/i.test(value);
const suffixes = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx', '/index.d.ts'];
const candidates = (base: string): string[] => {
  if (/\.mjs$/i.test(base)) return [base.replace(/\.mjs$/i, '.mts'), base.replace(/\.mjs$/i, '.d.mts'), base];
  if (/\.cjs$/i.test(base)) return [base.replace(/\.cjs$/i, '.cts'), base.replace(/\.cjs$/i, '.d.cts'), base];
  if (/\.jsx?$/i.test(base)) return [base.replace(/\.jsx?$/i, '.ts'),
    base.replace(/\.jsx?$/i, '.tsx'), base.replace(/\.jsx?$/i, '.d.ts'), base];
  return suffixes.map(suffix => base + suffix);
};

/** Re-reads the sealed inventory using TypeScript's reference preprocessor.
 * It checks the producer's proposed exclusion rather than trusting its graph. */
export function verifySealedProjectClosure(snapshot: GenericRepositorySnapshot,
  graph: GenericProjectGraph, changedSources: readonly string[],
  proposal: SealedProjectClosure): ProjectClosureVerification {
  const blockers = new Set<string>(proposal.blockers);
  const selected = new Set(proposal.selectedProjectIds);
  const projects = new Map(graph.projects.map(project => [project.projectId, project]));
  for (const id of selected) if (!projects.has(id)) blockers.add(`UNKNOWN_SELECTED_PROJECT:${id}`);
  const inventory = new Set(snapshot.files.map(file => norm(file.path)));
  const workspace = buildSealedWorkspacePackageIndex(snapshot);
  const conditionCache = createSealedImportConditionCache();
  workspace.blockers.forEach(blocker => blockers.add(blocker));
  const selectedFiles = new Set<string>();
  for (const project of graph.projects) if (selected.has(project.projectId)) {
    for (const file of project.sourceFiles) selectedFiles.add(norm(file));
  }
  for (const file of changedSources.map(norm)) {
    if (!selectedFiles.has(file)) blockers.add(`CHANGED_SOURCE_NOT_SELECTED:${file}`);
  }
  for (const edge of graph.edges) {
    if (selected.has(edge.toProjectId) && !selected.has(edge.fromProjectId)) {
      blockers.add(`EXCLUDED_PROJECT_REFERENCE:${edge.fromProjectId}:${edge.toProjectId}`);
    }
  }
  for (const project of graph.projects) {
    if (selected.has(project.projectId)) continue;
    const options = project.options ?? {};
    const compilerOptions = options as ts.CompilerOptions;
    const compilerHost = new SealedCompilerHost(snapshot, project.projectId, compilerOptions);
    for (const key of ['paths', 'baseUrl', 'rootDirs', 'moduleSuffixes', 'typeRoots', 'types',
      'jsxImportSource', 'customConditions']) {
      if (options[key] !== undefined) blockers.add(`EXCLUDED_PROJECT_RESOLUTION_OPTION:${project.projectId}:${key}`);
    }
    for (const rawFile of project.sourceFiles) {
      const file = norm(rawFile);
      if (!source(file)) continue;
      if (!inventory.has(file)) { blockers.add(`EXCLUDED_PROJECT_MISSING_SOURCE:${project.projectId}:${file}`); continue; }
      const content = snapshot.readTextFile(file);
      if (content === undefined) { blockers.add(`EXCLUDED_PROJECT_UNREADABLE_SOURCE:${file}`); continue; }
      const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false);
      if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
        blockers.add(`EXCLUDED_PROJECT_PARSE_FAILURE:${file}`);
      }
      if (/\.(?:tsx|jsx|jsx?|mjs|cjs)$/i.test(file)) blockers.add(`EXCLUDED_PROJECT_SCRIPT_KIND:${file}`);
      if (!ts.isExternalModule(ast)) blockers.add(`EXCLUDED_PROJECT_GLOBAL_SCRIPT:${file}`);
      // These constructs can introduce dependencies beyond static imports.
      const visit = (node: ts.Node): void => {
        if (ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) ||
          (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text))))) {
          blockers.add(`EXCLUDED_PROJECT_DYNAMIC_OR_AMBIENT:${file}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      const references = ts.preProcessFile(content, true, true);
      if (references.referencedFiles.length || references.typeReferenceDirectives.length ||
        references.libReferenceDirectives.length) {
        blockers.add(`EXCLUDED_PROJECT_TRIPLE_SLASH_REFERENCE:${file}`);
      }
      for (const imported of references.importedFiles) {
        const specifier = imported.fileName;
        if (!specifier.startsWith('.')) {
          const localPackage = workspace.resolve(specifier);
          if (localPackage) {
            const contexts = sealedImportConditions(file, graph, [project.projectId], snapshot, conditionCache);
            const entryFiles = new Set<string>();
            for (const conditions of contexts ?? [undefined]) {
              const entry = workspace.resolveEntry(specifier, conditions);
              entry.blockers.forEach(blocker => blockers.add(blocker));
              for (const target of entry.files) {
                entryFiles.add(target);
                if (selectedFiles.has(target)) {
                  blockers.add(`EXCLUDED_PROJECT_CONSUMES_SELECTED_PACKAGE:${file}:${specifier}:${target}`);
                }
              }
            }
            const compilerTarget = ts.resolveModuleName(specifier, `/${file}`, compilerOptions,
              compilerHost).resolvedModule?.resolvedFileName;
            if (compilerTarget && !entryFiles.has(norm(compilerTarget))) {
              blockers.add(`EXCLUDED_PROJECT_PACKAGE_RESOLUTION_MISMATCH:${file}:${specifier}:${norm(compilerTarget)}`);
            }
          } else blockers.add(`EXCLUDED_PROJECT_EXTERNAL_IMPORT:${file}:${specifier}`);
          continue;
        }
        const base = norm(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
        if (inventory.has(`${base}/package.json`)) {
          blockers.add(`EXCLUDED_PROJECT_PACKAGE_RESOLUTION:${file}:${specifier}`);
        }
        const resolved = candidates(base).filter(candidate => inventory.has(candidate));
        if (!resolved.length) { blockers.add(`EXCLUDED_PROJECT_UNRESOLVED_IMPORT:${file}:${specifier}`); continue; }
        // A suffix probe is only a candidate. Confirm the actual target using
        // the pinned compiler against the same sealed snapshot before exclusion.
        const compilerTarget = ts.resolveModuleName(specifier, `/${file}`, compilerOptions,
          compilerHost).resolvedModule?.resolvedFileName;
        if (!compilerTarget || !resolved.includes(norm(compilerTarget))) {
          blockers.add(`EXCLUDED_PROJECT_COMPILER_RESOLUTION_MISMATCH:${file}:${specifier}`);
          continue;
        }
        for (const target of resolved) if (selectedFiles.has(target)) {
          blockers.add(`EXCLUDED_PROJECT_CONSUMES_SELECTED:${file}:${target}`);
        }
      }
    }
  }
  return { status: blockers.size ? 'UNPROVEN' : 'PROVEN',
    blockers: [...blockers].sort(), selectedProjectIds: [...selected].sort() };
}
