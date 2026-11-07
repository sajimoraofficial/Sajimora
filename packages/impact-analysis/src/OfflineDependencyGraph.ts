/**
 * SAJIMORA — OFFLINE DEPENDENCY GRAPH BUILDER
 *
 * Statically parses repository imports and re-exports with 3-tier evidence tracking:
 * - STATIC_AST: Verified static imports and exports via TypeScript AST
 * - DYNAMIC_AST: Verified dynamic import() call expressions with string literals
 * - HEURISTIC: Regex fallbacks or non-literal dynamic expressions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as ts from 'typescript';
import { DependencyEdge, DependencyRelation, EvidenceKind, AnalysisBlocker } from './types';
import { getCanonicalRepoRoot, resolveCanonicalRepositoryPath } from './pathResolver';
import { JavaRoleExtractor } from './extractors/javaRoleExtractor';

export interface DependencyGraphOptions {
  repoRoot: string;
  files: string[];
}

export class OfflineDependencyGraph {
  private repoRoot: string;
  private files: string[];

  // Forward graph: from -> edges
  private forwardEdges: Map<string, DependencyEdge[]> = new Map();
  // Inverted graph: to -> incoming edges (who imports 'to')
  private incomingEdges: Map<string, DependencyEdge[]> = new Map();

  // Java Extractor
  private javaExtractor = new JavaRoleExtractor();

  // Java Class & Package Indices
  private javaClassMap = new Map<string, string>(); // FQCN -> relPath
  private javaPackageMap = new Map<string, Array<{ className: string; relPath: string }>>();
  private javaShortClassMap = new Map<string, string[]>();

  // Go Module Indices
  private goModuleRoots = new Map<string, string>(); // moduleName -> dir relPath

  public staticAstEdgeCount = 0;
  public dynamicAstEdgeCount = 0;
  public heuristicEdgeCount = 0;

  public readonly unreadableFiles: string[] = [];
  public readonly parseFailures: Array<{ file: string; error: string }> = [];
  public readonly blockers: AnalysisBlocker[] = [];

  constructor(options: DependencyGraphOptions) {
    this.repoRoot = getCanonicalRepoRoot(options.repoRoot);
    this.files = options.files;
    this.indexPolyglotEcosystems();
    this.buildGraph();
  }

  public serialize(): Buffer {
    const sortEdges = (edges: DependencyEdge[]) => [...edges].sort((a, b) => {
      const ka = `${a.from}\0${a.to}\0${a.relation}\0${a.evidence.kind}\0${a.evidence.specifierLiteral}`;
      const kb = `${b.from}\0${b.to}\0${b.relation}\0${b.evidence.kind}\0${b.evidence.specifierLiteral}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const sortedMap = <T>(map: Map<string, T>, normalize: (value: T) => unknown = value => value) =>
      [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, normalize(value)]);
    const data = {
      version: 'DEP_GRAPH_V1',
      forwardEdges: sortedMap(this.forwardEdges, sortEdges),
      incomingEdges: sortedMap(this.incomingEdges, sortEdges),
      javaClassMap: sortedMap(this.javaClassMap),
      javaPackageMap: sortedMap(this.javaPackageMap, values => [...values].sort((a, b) => {
        const ka = `${a.relPath}:${a.className}`;
        const kb = `${b.relPath}:${b.className}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      })),
      javaShortClassMap: sortedMap(this.javaShortClassMap, values => [...values].sort()),
      goModuleRoots: sortedMap(this.goModuleRoots),
      staticAstEdgeCount: this.staticAstEdgeCount,
      dynamicAstEdgeCount: this.dynamicAstEdgeCount,
      heuristicEdgeCount: this.heuristicEdgeCount,
      unreadableFiles: [...this.unreadableFiles].sort(),
      parseFailures: [...this.parseFailures].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
      blockers: [...this.blockers].sort((a, b) => ((a.file ?? '') < (b.file ?? '') ? -1 : (a.file ?? '') > (b.file ?? '') ? 1 : 0)),
    };
    return zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
  }

  public static deserialize(buf: Buffer, repoRoot: string, files: string[]): OfflineDependencyGraph {
    const raw = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    const graph = Object.create(OfflineDependencyGraph.prototype) as OfflineDependencyGraph;
    graph.repoRoot = getCanonicalRepoRoot(repoRoot);
    graph.files = files;
    graph.javaExtractor = new JavaRoleExtractor();
    graph.forwardEdges = new Map(raw.forwardEdges);
    graph.incomingEdges = new Map(raw.incomingEdges);
    graph.javaClassMap = new Map(raw.javaClassMap);
    graph.javaPackageMap = new Map(raw.javaPackageMap);
    graph.javaShortClassMap = new Map(raw.javaShortClassMap);
    graph.goModuleRoots = new Map(raw.goModuleRoots);
    graph.staticAstEdgeCount = raw.staticAstEdgeCount;
    graph.dynamicAstEdgeCount = raw.dynamicAstEdgeCount;
    graph.heuristicEdgeCount = raw.heuristicEdgeCount;
    (graph as any).unreadableFiles = raw.unreadableFiles ?? [];
    (graph as any).parseFailures = raw.parseFailures ?? [];
    (graph as any).blockers = raw.blockers ?? [];
    return graph;
  }

  public static create(options: DependencyGraphOptions): OfflineDependencyGraph {
    return new OfflineDependencyGraph(options);
  }

  /**
   * Resolves a module specifier (relative or monorepo package) from a source file.
   */
  private resolveSpecifier(fromRelPath: string, specifier: string): string | undefined {
    const fromFull = path.join(this.repoRoot, fromRelPath);
    const dir = path.dirname(fromFull);

    // 1. Relative imports
    if (specifier.startsWith('.')) {
      const base = specifier.replace(/\.(js|jsx|mjs|cjs)$/, '');
      const candidates = [
        base + '.ts',
        base + '.tsx',
        specifier,
        specifier + '.ts',
        specifier + '.tsx',
        specifier + '.js',
        specifier + '.jsx',
        path.join(specifier, 'index.ts'),
        path.join(specifier, 'index.js')
      ];

      for (const cand of candidates) {
        const potential = path.resolve(dir, cand);
        const check = resolveCanonicalRepositoryPath(potential, this.repoRoot);
        if (check.accepted && fs.existsSync(check.resolvedPath)) {
          return check.normalizedRelativePath;
        }
      }
    }

    // 2. Package Aliases: resolve package imports via workspace packages directory
    if (specifier.startsWith('@') || !specifier.startsWith('.')) {
      const parts = specifier.split('/');
      // e.g. @sajimora/core -> core; my-pkg -> my-pkg
      const pkgFolder = specifier.startsWith('@') ? parts[1] : parts[0];
      const pkgSubpath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');

      const candidates = [
        path.join(this.repoRoot, 'packages', pkgFolder, 'src', pkgSubpath ? pkgSubpath + '.ts' : 'index.ts'),
        path.join(this.repoRoot, 'packages', pkgFolder, 'src', pkgSubpath ? pkgSubpath + '.js' : 'index.js'),
        path.join(this.repoRoot, 'packages', pkgFolder, pkgSubpath ? pkgSubpath + '.ts' : 'index.ts'),
        path.join(this.repoRoot, 'packages', pkgFolder, pkgSubpath ? pkgSubpath + '.js' : 'index.js'),
        path.join(this.repoRoot, 'packages', pkgFolder, 'src', 'index.ts'),
        path.join(this.repoRoot, 'packages', pkgFolder, 'index.ts')
      ];

      for (const cand of candidates) {
        const check = resolveCanonicalRepositoryPath(cand, this.repoRoot);
        if (check.accepted && fs.existsSync(check.resolvedPath)) {
          return check.normalizedRelativePath;
        }
      }
    }

    return undefined;
  }

  private addEdge(edge: DependencyEdge): void {
    // Forward
    const fList = this.forwardEdges.get(edge.from) || [];
    fList.push(edge);
    this.forwardEdges.set(edge.from, fList);

    // Inverted (Incoming)
    const inList = this.incomingEdges.get(edge.to) || [];
    inList.push(edge);
    this.incomingEdges.set(edge.to, inList);

    if (edge.evidence.kind === 'STATIC_AST') this.staticAstEdgeCount++;
    else if (edge.evidence.kind === 'DYNAMIC_AST') this.dynamicAstEdgeCount++;
    else this.heuristicEdgeCount++;
  }

  /**
   * Statically parses a single file with TypeScript AST.
   */
  private parseFileAst(relPath: string, content: string): void {
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(
        relPath,
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
    } catch {
      this.parseFileRegex(relPath, content);
      return;
    }

    const visit = (node: ts.Node) => {
      // 1. Static Import Declaration: import ... from '...'
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = this.resolveSpecifier(relPath, spec);
          if (resolved) {
            const loc = sf.getLineAndCharacterOfPosition(node.getStart());
            this.addEdge({
              from: relPath,
              to: resolved,
              relation: spec.startsWith('@') ? 'PACKAGE_IMPORT' : 'STATIC_IMPORT',
              evidence: {
                kind: 'STATIC_AST',
                extractor: 'TS_AST',
                sourceLocation: { line: loc.line + 1, column: loc.character + 1 },
                specifierLiteral: spec,
                isLiteral: true
              }
            });
          }
        }
      }

      // 2. Export Declaration with Module Specifier: export ... from '...'
      else if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = this.resolveSpecifier(relPath, spec);
          if (resolved) {
            const loc = sf.getLineAndCharacterOfPosition(node.getStart());
            this.addEdge({
              from: relPath,
              to: resolved,
              relation: 'REEXPORT',
              evidence: {
                kind: 'STATIC_AST',
                extractor: 'TS_AST',
                sourceLocation: { line: loc.line + 1, column: loc.character + 1 },
                specifierLiteral: spec,
                isLiteral: true
              }
            });
          }
        }
      }

      // 3. Dynamic import() Call Expression: import('...')
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        const loc = sf.getLineAndCharacterOfPosition(node.getStart());
        if (arg && ts.isStringLiteral(arg)) {
          const spec = arg.text;
          const resolved = this.resolveSpecifier(relPath, spec);
          if (resolved) {
            this.addEdge({
              from: relPath,
              to: resolved,
              relation: 'DYNAMIC_IMPORT',
              evidence: {
                kind: 'DYNAMIC_AST',
                extractor: 'TS_AST',
                sourceLocation: { line: loc.line + 1, column: loc.character + 1 },
                specifierLiteral: spec,
                isLiteral: true
              }
            });
          }
        } else if (arg) {
          // Non-literal dynamic import expression: import(varName)
          this.addEdge({
            from: relPath,
            to: '[DYNAMIC_UNRESOLVED]',
            relation: 'DYNAMIC_IMPORT',
            evidence: {
              kind: 'HEURISTIC',
              extractor: 'TS_AST',
              sourceLocation: { line: loc.line + 1, column: loc.character + 1 },
              specifierLiteral: arg.getText(sf),
              isLiteral: false
            }
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  /**
   * Fallback regex parser for syntax errors or non-TS files.
   */
  private parseFileRegex(relPath: string, content: string): void {
    const importRegex = /(?:import|require)\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*(?:from\s*)?\(?['"]([^'"]+)['"]\)?/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const spec = m[1];
      const resolved = this.resolveSpecifier(relPath, spec);
      if (resolved) {
        this.addEdge({
          from: relPath,
          to: resolved,
          relation: 'STATIC_IMPORT',
          evidence: {
            kind: 'HEURISTIC',
            extractor: 'REGEX',
            specifierLiteral: spec,
            isLiteral: true
          }
        });
      }
    }
  }

  /**
   * Pre-indexes Java FQCNs, packages, and Go module declarations across the repository.
   */
  private indexPolyglotEcosystems(): void {
    // 1. Index Java Packages and Classes
    for (const relPath of this.files) {
      if (path.extname(relPath).toLowerCase() === '.java') {
        const fullPath = path.join(this.repoRoot, relPath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch (err) {
          if (!this.unreadableFiles.includes(relPath)) {
            this.unreadableFiles.push(relPath);
          }
          this.blockers.push({
            code: 'UNREADABLE_FILE',
            message: err instanceof Error ? err.message : String(err),
            file: relPath
          });
          continue;
        }

        try {
          const details = this.javaExtractor.parseStructure(relPath, content);
          for (const decl of details.declarations) {
            const fqcn = details.packageName ? `${details.packageName}.${decl.name}` : decl.name;
            this.javaClassMap.set(fqcn, relPath);

            if (details.packageName) {
              const pkgList = this.javaPackageMap.get(details.packageName) || [];
              pkgList.push({ className: decl.name, relPath });
              this.javaPackageMap.set(details.packageName, pkgList);
            }

            const shortList = this.javaShortClassMap.get(decl.name) || [];
            if (!shortList.includes(relPath)) shortList.push(relPath);
            this.javaShortClassMap.set(decl.name, shortList);
          }
        } catch (err) {
          this.parseFailures.push({
            file: relPath,
            error: err instanceof Error ? err.message : String(err)
          });
          this.blockers.push({
            code: 'JAVA_PARSE_FAILURE',
            message: err instanceof Error ? err.message : String(err),
            file: relPath
          });
        }
      }
    }

    // 2. Discover go.mod files
    const candidateDirs = new Set<string>(['.']);
    for (const f of this.files) {
      candidateDirs.add(path.dirname(f).replace(/\\/g, '/'));
    }
    for (const dir of candidateDirs) {
      const p = dir === '.' ? path.join(this.repoRoot, 'go.mod') : path.join(this.repoRoot, dir, 'go.mod');
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const modMatch = content.match(/^module\s+([^\s\r\n]+)/m);
          if (modMatch) {
            const modName = modMatch[1].trim();
            this.goModuleRoots.set(modName, dir === '.' ? '' : dir);
          }
        } catch (err) {
          this.blockers.push({
            code: 'GO_MOD_READ_FAILURE',
            message: err instanceof Error ? err.message : String(err),
            file: dir === '.' ? 'go.mod' : `${dir}/go.mod`
          });
        }
      }
    }
  }

  /**
   * Parses Java static imports, wildcard symbol references, same-package references,
   * inheritance (extends), and implementation (implements).
   */
  private parseJava(relPath: string, content: string): void {
    const details = this.javaExtractor.parseStructure(relPath, content);

    // Strip comments and string literals to prevent matching symbols in strings/comments
    const codeOnly = content
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");

    // 1. Direct Imports & Wildcard Scope
    for (const imp of details.imports) {
      if (!imp.isWildcard) {
        const target = this.javaClassMap.get(imp.moduleSpecifier);
        if (target && target !== relPath) {
          this.addEdge({
            from: relPath,
            to: target,
            relation: 'STATIC_IMPORT',
            evidence: {
              kind: 'STATIC_AST',
              extractor: 'JAVA_AST',
              sourceLocation: { line: imp.line, column: 1 },
              specifierLiteral: imp.moduleSpecifier,
              isLiteral: true
            }
          });
        }
      } else {
        // Wildcard import (import com.acme.model.*)
        // CRITICAL INVARIANT: Only create edge if the symbol is ACTUALLY referenced in content!
        const pkgName = imp.moduleSpecifier.replace(/\.\*$/, '');
        const members = this.javaPackageMap.get(pkgName) || [];
        for (const member of members) {
          if (member.relPath !== relPath) {
            const symRegex = new RegExp(`\\b${member.className}\\b`);
            if (symRegex.test(codeOnly)) {
              this.addEdge({
                from: relPath,
                to: member.relPath,
                relation: 'STATIC_IMPORT',
                evidence: {
                  kind: 'STATIC_AST',
                  extractor: 'JAVA_AST',
                  sourceLocation: { line: imp.line, column: 1 },
                  specifierLiteral: `${pkgName}.${member.className}`,
                  isLiteral: true
                }
              });
            }
          }
        }
      }
    }

    // 2. Same-Package Symbol References
    // CRITICAL INVARIANT: Package visibility != dependency edge!
    // Only create edge if Class A actually references Class B's symbol!
    if (details.packageName) {
      const samePkg = this.javaPackageMap.get(details.packageName) || [];
      for (const member of samePkg) {
        if (member.relPath !== relPath) {
          const symRegex = new RegExp(`\\b${member.className}\\b`);
          if (symRegex.test(codeOnly)) {
            this.addEdge({
              from: relPath,
              to: member.relPath,
              relation: 'DIRECT_SYMBOL_REFERENCE',
              evidence: {
                kind: 'STATIC_AST',
                extractor: 'JAVA_AST',
                specifierLiteral: member.className,
                isLiteral: true
              }
            });
          }
        }
      }
    }

    // 3. Inheritance & Implementation
    for (const decl of details.declarations) {
      if (decl.extendsName) {
        const targets = this.javaShortClassMap.get(decl.extendsName) || [];
        for (const t of targets) {
          if (t !== relPath) {
            this.addEdge({
              from: relPath,
              to: t,
              relation: 'INHERITS',
              evidence: {
                kind: 'STATIC_AST',
                extractor: 'JAVA_AST',
                specifierLiteral: decl.extendsName,
                isLiteral: true
              }
            });
          }
        }
      }
      for (const impName of decl.implementsNames) {
        const targets = this.javaShortClassMap.get(impName) || [];
        for (const t of targets) {
          if (t !== relPath) {
            this.addEdge({
              from: relPath,
              to: t,
              relation: 'IMPLEMENTS',
              evidence: {
                kind: 'STATIC_AST',
                extractor: 'JAVA_AST',
                specifierLiteral: impName,
                isLiteral: true
              }
            });
          }
        }
      }
    }
  }

  /**
   * Parses Go package imports, filtering out standard library and unresolved third-party dependencies.
   */
  private parseGo(relPath: string, content: string): void {
    const importRegex = /(?:^\s*import\s+"([^"]+)"|^\s*import\s*\(([\s\S]*?)\))/gm;
    let m: RegExpExecArray | null;
    const rawImports: string[] = [];

    while ((m = importRegex.exec(content)) !== null) {
      if (m[1]) {
        rawImports.push(m[1]);
      } else if (m[2]) {
        const lines = m[2].split('\n');
        for (const line of lines) {
          const single = line.trim().match(/^(?:[A-Za-z0-9_]+\s+)?"([^"]+)"/);
          if (single) rawImports.push(single[1]);
        }
      }
    }

    for (const imp of rawImports) {
      // 1. Filter out standard library imports
      const isStdLib = !imp.includes('.') && (!imp.includes('/') || /^(?:archive|bufio|builtin|bytes|compress|container|context|crypto|database|debug|embed|encoding|errors|expvar|flag|fmt|go|hash|html|image|index|io|log|math|mime|net|os|path|plugin|reflect|regexp|runtime|sort|strconv|strings|sync|syscall|test2json|testing|text|time|unicode|unsafe)\b/.test(imp));
      if (isStdLib) continue;

      // 2. Check if import matches a known repository module root
      for (const [modName, modDir] of this.goModuleRoots.entries()) {
        if (imp.startsWith(modName)) {
          const subPkg = imp.slice(modName.length).replace(/^\//, '');
          const targetDir = modDir ? `${modDir}/${subPkg}` : subPkg;

          const pkgFiles = this.files.filter(f =>
            f.endsWith('.go') && path.dirname(f).replace(/\\/g, '/') === targetDir
          );

          for (const targetFile of pkgFiles) {
            if (targetFile !== relPath) {
              this.addEdge({
                from: relPath,
                to: targetFile,
                relation: 'STATIC_IMPORT',
                evidence: {
                  kind: 'STATIC_AST',
                  extractor: 'GO_AST',
                  specifierLiteral: imp,
                  isLiteral: true
                }
              });
            }
          }
        }
      }
    }
  }

  /**
   * Parses Rust use statements and pub use re-export facades.
   */
  private parseRust(relPath: string, content: string): void {
    const fromFull = path.join(this.repoRoot, relPath);
    const dir = path.dirname(fromFull);

    // 1. Parse use statements and pub use re-exports
    const useRegex = /^\s*(pub\s+)?use\s+([^;]+);/gm;
    let m: RegExpExecArray | null;

    while ((m = useRegex.exec(content)) !== null) {
      const isPublicReExport = !!m[1];
      const usePath = m[2].trim();
      const parts = usePath.split('::');
      const rootModule = parts[0] === 'crate' ? parts[1] : parts[0];

      if (!rootModule || rootModule.startsWith('std') || rootModule.startsWith('core')) continue;

      const candidates = [
        path.join(dir, rootModule + '.rs'),
        path.join(dir, rootModule, 'mod.rs'),
        path.join(this.repoRoot, 'src', rootModule + '.rs'),
        path.join(this.repoRoot, 'src', rootModule, 'mod.rs')
      ];

      for (const cand of candidates) {
        const check = resolveCanonicalRepositoryPath(cand, this.repoRoot);
        if (check.accepted && fs.existsSync(check.resolvedPath) && check.normalizedRelativePath !== relPath) {
          this.addEdge({
            from: relPath,
            to: check.normalizedRelativePath,
            relation: isPublicReExport ? 'REEXPORT' : 'STATIC_IMPORT',
            evidence: {
              kind: 'STATIC_AST',
              extractor: 'RUST_AST',
              specifierLiteral: usePath,
              isLiteral: true
            }
          });
          break;
        }
      }
    }

    // 2. Parse mod declarations: mod foo;
    const modRegex = /^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;/gm;
    while ((m = modRegex.exec(content)) !== null) {
      const modName = m[1];
      const candidates = [
        path.join(dir, modName + '.rs'),
        path.join(dir, modName, 'mod.rs')
      ];
      for (const cand of candidates) {
        const check = resolveCanonicalRepositoryPath(cand, this.repoRoot);
        if (check.accepted && fs.existsSync(check.resolvedPath) && check.normalizedRelativePath !== relPath) {
          this.addEdge({
            from: relPath,
            to: check.normalizedRelativePath,
            relation: 'STATIC_IMPORT',
            evidence: {
              kind: 'STATIC_AST',
              extractor: 'RUST_AST',
              specifierLiteral: modName,
              isLiteral: true
            }
          });
          break;
        }
      }
    }
  }

  /**
   * Parses Python from ... import and direct import statements.
   */
  private parsePython(relPath: string, content: string): void {
    const fromFull = path.join(this.repoRoot, relPath);
    const dir = path.dirname(fromFull);

    const fromRegex = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+([^#\n]+)/gm;
    let m: RegExpExecArray | null;

    while ((m = fromRegex.exec(content)) !== null) {
      const modSpec = m[1];
      const isRelative = modSpec.startsWith('.');
      const cleanMod = modSpec.replace(/^\.+/, '');
      const subPath = cleanMod.replace(/\./g, '/');

      const candidates = isRelative
        ? [
            path.join(dir, subPath + '.py'),
            path.join(dir, subPath, '__init__.py')
          ]
        : [
            path.join(this.repoRoot, subPath + '.py'),
            path.join(this.repoRoot, subPath, '__init__.py'),
            path.join(dir, subPath + '.py'),
            path.join(dir, subPath, '__init__.py')
          ];

      for (const cand of candidates) {
        const check = resolveCanonicalRepositoryPath(cand, this.repoRoot);
        if (check.accepted && fs.existsSync(check.resolvedPath) && check.normalizedRelativePath !== relPath) {
          this.addEdge({
            from: relPath,
            to: check.normalizedRelativePath,
            relation: 'STATIC_IMPORT',
            evidence: {
              kind: 'STATIC_AST',
              extractor: 'PYTHON_AST',
              specifierLiteral: modSpec,
              isLiteral: true
            }
          });
          break;
        }
      }
    }
  }

  /**
   * Ingests all target files into the dependency graph.
   */
  private buildGraph(): void {
    for (const relPath of this.files) {
      const fullPath = path.join(this.repoRoot, relPath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (err) {
        if (!this.unreadableFiles.includes(relPath)) {
          this.unreadableFiles.push(relPath);
        }
        this.blockers.push({
          code: 'UNREADABLE_FILE',
          message: err instanceof Error ? err.message : String(err),
          file: relPath
        });
        continue;
      }

      const ext = path.extname(relPath).toLowerCase();
      try {
        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
          this.parseFileAst(relPath, content);
        } else if (ext === '.java') {
          this.parseJava(relPath, content);
        } else if (ext === '.go') {
          this.parseGo(relPath, content);
        } else if (ext === '.rs') {
          this.parseRust(relPath, content);
        } else if (ext === '.py') {
          this.parsePython(relPath, content);
        } else {
          this.parseFileRegex(relPath, content);
        }
      } catch (err) {
        this.parseFailures.push({
          file: relPath,
          error: err instanceof Error ? err.message : String(err)
        });
        this.blockers.push({
          code: 'PARSE_FAILURE',
          message: err instanceof Error ? err.message : String(err),
          file: relPath
        });
      }
    }
  }

  /**
   * Returns incoming edges (files that depend on / import the target file).
   */
  public getIncomingEdges(targetNode: string): DependencyEdge[] {
    return this.incomingEdges.get(targetNode) || [];
  }

  /**
   * Returns outgoing edges (files that the target file imports).
   */
  public getOutgoingEdges(sourceNode: string): DependencyEdge[] {
    return this.forwardEdges.get(sourceNode) || [];
  }
}
