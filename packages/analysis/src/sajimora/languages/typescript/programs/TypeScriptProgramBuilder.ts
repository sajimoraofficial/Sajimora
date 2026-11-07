import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { binaryCompare, ProjectIdentity, ProgramDiagnosticEvidence, ProofObligation, RevisionIdentity, SnapshotAnalysisUniverse, ToolchainIdentity } from '@sajimora/core';
import { SharedImmutableLibCache } from './SharedImmutableLibCache';
import { TypeScriptProjectSelector, ProjectSelectionResult } from './TypeScriptProjectSelector';
import { VirtualDependencyResolver } from './VirtualDependencyResolver';
import { DependencyLookupRecorder } from '../../../indexed/DependencyLookupReceipt';

export interface TypeScriptSnapshotInput {
  root: string;
  trackedFiles: readonly string[];
  revision: RevisionIdentity;
  toolchain: ToolchainIdentity;
  adapterId: string;
  adapterVersion: string;
  dependencyRoot?: string;
  dependencyLookupRecorder?: DependencyLookupRecorder;
  dependencyStoreEvidence?: { lockfile: string; lockfileHash: string; status: 'LOCKFILE_MATCHED_READ_ONLY' };
  changedFiles?: readonly string[];
  obligations?: readonly ProofObligation[];
  readTextFile?: (file: string) => string | undefined;
  /** Consume each project before the next Program is constructed. Only valid
   * for full-snapshot ingestion, where no seed-dependent Program graph is needed. */
  onProject?: (project: TypeScriptProjectProgram, diagnostics: readonly ProgramDiagnosticEvidence[]) => void;
  retainPrograms?: boolean;
  onProjectStart?: (configFile: string | null, rootFileCount: number) => void;
  /** Optional experiment-only observer. It has no effect on program semantics. */
  memoryProfile?: {
    world: 'parent' | 'candidate';
    eagerDiagnosticRelease?: boolean;
    onStage: (event: {
      stage: 'program' | 'diagnostics';
      world: 'parent' | 'candidate';
      durationMs: number;
      sourceFileCount: number;
      projectCount: number;
    }) => void;
  };
}

export interface TypeScriptProjectProgram {
  identity: ProjectIdentity;
  program: ts.Program;
  options: ts.CompilerOptions;
}

export interface TypeScriptProgramBuildResult {
  status: 'BUILT' | 'PARTIAL' | 'FAILED';
  projects: TypeScriptProjectProgram[];
  universe: SnapshotAnalysisUniverse;
  program?: ts.Program;
  selection?: ProjectSelectionResult;
}

const slash = (value: string) => value.replace(/\\/g, '/');
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
};

export function normalizeToTrackedRelative(file: string, root: string, trackedFiles?: readonly string[]): string | null {
  const norm = slash(file);

  if (trackedFiles && trackedFiles.includes(norm)) {
    return norm;
  }

  const snapMatch = norm.match(/sajimora-snapshot-[^/]+\/(.*)$/);
  if (snapMatch) {
    const snapRel = snapMatch[1];
    if (!trackedFiles || trackedFiles.includes(snapRel)) return snapRel;
  }

  try {
    const rootPath = path.resolve(root);
    const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(rootPath, file);
    const rel = slash(path.relative(rootPath, resolved));
    if (!path.isAbsolute(rel) && !rel.startsWith('../')) {
      if (!trackedFiles || trackedFiles.includes(rel)) return rel;
    }
  } catch {}

  if (trackedFiles && trackedFiles.length > 0) {
    let bestMatch: string | null = null;
    for (const tf of trackedFiles) {
      if (norm === tf || norm.endsWith('/' + tf)) {
        if (!bestMatch || tf.length > bestMatch.length) {
          bestMatch = tf;
        }
      }
    }
    if (bestMatch) return bestMatch;
  }

  if (!path.isAbsolute(norm) && !norm.startsWith('../')) {
    return norm.replace(/^\.\//, '');
  }

  return null;
}

export class TypeScriptProgramBuilder {
  constructor(private readonly selector = new TypeScriptProjectSelector()) {}

  build(
    input: TypeScriptSnapshotInput,
    reuseOptions?: { oldPrograms?: Map<string, ts.Program> }
  ): TypeScriptProgramBuildResult {
    const root = path.resolve(input.root);
    const rootPrefix = root + path.sep;
    const relative = (file: string): string | null => {
      const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
      const rel = slash(path.relative(root, resolved));
      if (resolved === root) return '';
      if (!rel.startsWith('../') && !path.isAbsolute(rel)) return rel;
      return normalizeToTrackedRelative(file, root, input.trackedFiles);
    };

    // Obligation/diff-directed project selection, consumer closure validation, and subsumption
    const effectiveChangedFiles: readonly string[] | undefined = (
      input.changedFiles && input.changedFiles.length > 0
        ? [...new Set(input.changedFiles.map(f => normalizeToTrackedRelative(f, root, input.trackedFiles)).filter((f): f is string => f !== null))]
        : (
            input.obligations && input.obligations.length > 0
              ? [...new Set(
                  input.obligations
                    .map(o => (o.mutatedSymbol as any)?.declarationLocation?.filePath ?? (o.mutatedSymbol as any)?.declarationLocation?.file)
                    .filter((f): f is string => typeof f === 'string')
                    .map(relative)
                    .filter((f): f is string => f !== null)
                )]
              : undefined
          )
    );

    const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));
    const resolver = new VirtualDependencyResolver({
      snapshotRoot: root,
      libRoot,
      dependencyRoot: input.dependencyRoot,
      dependencyLookupRecorder: input.dependencyLookupRecorder
    });
    const parseHost = resolver.createParseConfigHost();

    const selection = this.selector.selectProjects(
      root,
      input.trackedFiles,
      effectiveChangedFiles,
      input.readTextFile,
      resolver
    );

    const projects: TypeScriptProjectProgram[] = [];
    const projectIdentities: ProjectIdentity[] = [];
    const retainPrograms = input.retainPrograms !== false;
    if (!retainPrograms && (effectiveChangedFiles?.length || input.obligations?.length)) {
      throw new Error('STREAMING_PROJECT_BUILD_REQUIRES_FULL_SNAPSHOT');
    }
    const failures: ProgramDiagnosticEvidence[] = [];
    const included = new Set<string>();
    const excluded = new Map<string, string>();
    const unreadable = new Set<string>();
    const provenance = new Map<string, 'REPOSITORY_SOURCE' | 'TYPESCRIPT_BUNDLED_LIB' | 'EXTERNAL_DECLARATION'>();

    // If consumer closure was unproven, register diagnostic evidence to fail closed
    for (const blocker of selection.closureBlockers) {
      failures.push({
        category: 'ERROR',
        code: 9999,
        file: null,
        line: null,
        character: null,
        message: `Project consumer closure unproven: ${blocker}`
      });
    }

    // Discover workspace packages for cross-package module resolution
    const workspacePackages = new Map<string, { pkgDir: string; mainSource?: string; subpathSources: Map<string, string> }>();
    const packageFiles = input.trackedFiles.filter(f => /(^|\/)package\.json$/.test(slash(f)));
    for (const pkgRel of packageFiles) {
      const pkgPath = path.join(root, ...slash(pkgRel).split('/'));
      try {
        const text = resolver.readFile(pkgPath);
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.name === 'string') {
            const pkgDir = slash(path.dirname(pkgRel));
            const candidateSources: string[] = [];

            if (typeof parsed.source === 'string') {
              candidateSources.push(slash(path.normalize(pkgDir === '.' ? parsed.source : `${pkgDir}/${parsed.source}`)));
            }
            if (typeof parsed.main === 'string') {
              const srcMain = parsed.main.replace(/^(?:\.\/)?(?:dist|lib|build)\//, 'src/').replace(/\.[cm]?[jt]sx?$/, '.ts');
              candidateSources.push(slash(path.normalize(pkgDir === '.' ? srcMain : `${pkgDir}/${srcMain}`)));
            }
            if (typeof parsed.types === 'string') {
              const srcTypes = parsed.types.replace(/^(?:\.\/)?(?:dist|lib|build)\//, 'src/').replace(/\.d\.[cm]?ts$/, '.ts');
              candidateSources.push(slash(path.normalize(pkgDir === '.' ? srcTypes : `${pkgDir}/${srcTypes}`)));
            }

            const prefix = pkgDir === '.' ? '' : `${pkgDir}/`;
            candidateSources.push(
              `${prefix}src/index.ts`,
              `${prefix}src/index.tsx`,
              `${prefix}src/src/index.ts`,
              `${prefix}src/index.d.ts`,
              `${prefix}index.ts`,
              `${prefix}index.tsx`,
              `${prefix}index.d.ts`
            );

            let mainSource: string | undefined;
            for (const cand of candidateSources) {
              const fullCand = path.join(root, ...cand.split('/'));
              if (resolver.fileExists(fullCand)) {
                mainSource = fullCand;
                break;
              }
            }

            workspacePackages.set(parsed.name, {
              pkgDir,
              mainSource,
              subpathSources: new Map<string, string>()
            });
          }
        }
      } catch {
        // Ignore unreadable package.json
      }
    }

    const configsToBuild = selection.selectedConfigs;
    const hasConfigsInRepo = selection.allConfigs.length > 0;
    const configPaths = configsToBuild.length
      ? configsToBuild.map(f => path.join(root, ...slash(f).split('/')))
      : (hasConfigsInRepo ? [] : [null]);

    let programDurationMs = 0;
    let diagnosticsDurationMs = 0;
    let observedSourceFiles = 0;

    for (const configPath of configPaths) {
      const projectFailureStart = failures.length;
      let fileNames: string[];
      let options: ts.CompilerOptions;
      let references: readonly ts.ProjectReference[] | undefined;
      const configRel = configPath ? relative(configPath)! : null;

      if (configPath) {
        const read = ts.readConfigFile(configPath, ts.sys.readFile);
        if (read.error) {
          failures.push(this.diagnostic(read.error, root));
          unreadable.add(configRel!);
          continue;
        }

        // Normalize wildcard types: ["*"] so ts does not treat "*" literally and default type inclusion activates
        if (read.config?.compilerOptions && Array.isArray(read.config.compilerOptions.types)) {
          const typesArr: string[] = read.config.compilerOptions.types;
          if (typesArr.includes('*')) {
            if (typesArr.length === 1) {
              delete read.config.compilerOptions.types;
            } else {
              read.config.compilerOptions.types = typesArr.filter(t => t !== '*');
            }
          }
        }

        const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, path.dirname(configPath), undefined, configPath);
        const cleanErrors = parsed.errors.filter(d => !(d.code === 2688 && typeof d.messageText === 'string' && d.messageText.includes("'*'")));
        failures.push(...cleanErrors.map(d => this.diagnostic(d, root)));
        fileNames = parsed.fileNames;
        options = parsed.options;
        if (options.types && options.types.includes('*')) {
          if (options.types.length === 1) {
            delete options.types;
          } else {
            options.types = options.types.filter(t => t !== '*');
          }
        }
        references = parsed.projectReferences;
      } else {
        fileNames = input.trackedFiles.filter(f => /\.tsx?$/.test(f)).map(f => path.join(root, ...slash(f).split('/')));
        options = { noEmit: true };
      }

      const host = this.compilerHost(options, root, rootPrefix, provenance, resolver, workspacePackages);
      const oldProg = reuseOptions?.oldPrograms?.get(configRel ?? '<implicit>');
      input.onProjectStart?.(configRel, fileNames.length);
      const programStarted = performance.now();
      const program = ts.createProgram({
        rootNames: fileNames,
        options: { ...options, noEmit: true },
        projectReferences: references,
        host,
        oldProgram: oldProg
      });
      programDurationMs += performance.now() - programStarted;
      observedSourceFiles += program.getSourceFiles().length;
      input.memoryProfile?.onStage({
        stage: 'program',
        world: input.memoryProfile.world,
        durationMs: programDurationMs,
        sourceFileCount: observedSourceFiles,
        projectCount: projectIdentities.length + 1
      });

      const identity: ProjectIdentity = {
        projectId: configRel ?? '<implicit>',
        configFile: configRel,
        rootFiles: fileNames.map(f => relative(f)).filter((f): f is string => f !== null).sort(),
        references: (references ?? []).map(r => slash(path.relative(root, ts.resolveProjectReferencePath(r)))).sort()
      };

      const diagnosticsStarted = performance.now();
      const programDiagnostics: ts.Diagnostic[] = [];
      const appendDiagnostics = (diagnostics: readonly ts.Diagnostic[]) => {
        if (input.memoryProfile?.eagerDiagnosticRelease) {
          for (const diagnostic of diagnostics) {
            failures.push(this.diagnostic(diagnostic, root, identity.configFile));
          }
        } else {
          programDiagnostics.push(...diagnostics);
        }
      };
      appendDiagnostics(program.getOptionsDiagnostics());
      appendDiagnostics(program.getGlobalDiagnostics());

      const shouldCheckSemantic = (rel: string | null) => {
        if (!effectiveChangedFiles || effectiveChangedFiles.length === 0) return true;
        if (!rel) return true;
        return effectiveChangedFiles.some(cf => rel === cf || rel.endsWith('/' + cf) || cf.endsWith('/' + rel));
      };

      for (const source of program.getSourceFiles()) {
        const rel = relative(source.fileName);
        if (rel !== null) {
          included.add(rel);
          provenance.set(rel, 'REPOSITORY_SOURCE');
          appendDiagnostics(program.getSyntacticDiagnostics(source));
          if (shouldCheckSemantic(rel)) {
            appendDiagnostics(program.getSemanticDiagnostics(source));
          }
        }
      }

      if (!input.memoryProfile?.eagerDiagnosticRelease) {
        failures.push(...programDiagnostics.map(d => this.diagnostic(d, root, identity.configFile)));
      }
      programDiagnostics.length = 0;
      diagnosticsDurationMs += performance.now() - diagnosticsStarted;
      const builtProject = { identity, program, options };
      input.onProject?.(builtProject, failures.slice(projectFailureStart));
      projectIdentities.push(identity);
      if (retainPrograms) projects.push(builtProject);
      input.memoryProfile?.onStage({
        stage: 'diagnostics',
        world: input.memoryProfile.world,
        durationMs: diagnosticsDurationMs,
        sourceFileCount: observedSourceFiles,
        projectCount: projectIdentities.length
      });
    }

    for (const file of input.trackedFiles.map(slash).sort()) {
      if (/\.tsx?$/.test(file) && !included.has(file)) {
        excluded.set(file, 'NOT_INCLUDED_BY_PROJECT_CONFIGURATION');
      }
    }

    const uniqueFailures = [...new Map(failures.map(f => [JSON.stringify(f), f])).values()].sort((a, b) => { const ja = JSON.stringify(a); const jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0; });
    const missingInputCodes = new Set([2307, 2688, 6053, 6307]);

    const seedFiles = new Set<string>();
    if (input.changedFiles) {
      for (const cf of input.changedFiles) {
        const cfn = slash(cf);
        const sm = cfn.match(/sajimora-snapshot-[^/]+\/(.*)$/);
        seedFiles.add(sm ? sm[1] : cfn);
      }
    }
    if (input.obligations) {
      for (const ob of input.obligations) {
        const fp = (ob.mutatedSymbol as any)?.declarationLocation?.filePath ?? (ob.mutatedSymbol as any)?.declarationLocation?.file;
        if (fp) {
          const rel = relative(fp);
          if (rel && !rel.startsWith('../')) {
            seedFiles.add(rel);
          } else {
            const sm = fp.replace(/\\/g, '/').match(/sajimora-snapshot-[^/]+\/(.*)$/);
            if (sm) seedFiles.add(sm[1]);
          }
        }
      }
    }

    const semanticClosure = new Set<string>(seedFiles);
    if (seedFiles.size > 0) {
      const sourceFilesByRel = new Map<string, ts.SourceFile>();
      const projectByFile = new Map<string, TypeScriptProjectProgram>();

      for (const proj of projects) {
        for (const sf of proj.program.getSourceFiles()) {
          const rel = relative(sf.fileName);
          if (rel) {
            sourceFilesByRel.set(rel, sf);
            projectByFile.set(rel, proj);
          }
        }
      }

      const probeExts = [
        '',
        '.ts',
        '.tsx',
        '.d.ts',
        '.js',
        '.jsx',
        '.mts',
        '.cts',
        '/index.ts',
        '/index.tsx',
        '/index.d.ts',
        '/index.js',
        '/index.jsx',
        '/index.mts',
        '/index.cts'
      ];

      const resolveImport = (fromRel: string, spec: string): string | null => {
        if (!spec) return null;
        const proj = projectByFile.get(fromRel);
        const options = proj?.options ?? {};

        // 1. Path mappings in tsconfig
        if (options.paths && !spec.startsWith('.')) {
          const projectDir = path.dirname(proj?.identity.configFile ?? '');
          const baseDir = options.baseUrl
            ? (path.isAbsolute(options.baseUrl) ? slash(path.relative(root, options.baseUrl)) : slash(path.normalize(path.join(projectDir, options.baseUrl))))
            : projectDir;
          for (const [alias, targets] of Object.entries(options.paths)) {
            const prefix = alias.replace(/\*$/, '');
            if (spec.startsWith(prefix)) {
              const suffix = spec.slice(prefix.length);
              for (const target of targets) {
                const candidatePath = slash(path.normalize(path.join(baseDir, target.replace(/\*$/, suffix))));
                for (const ext of probeExts) {
                  const probe = candidatePath + ext;
                  if (sourceFilesByRel.has(probe)) return probe;
                }
              }
            }
          }
        }

        // 2. Relative import
        if (spec.startsWith('.')) {
          const fromDir = path.dirname(fromRel);
          const candidateBase = slash(path.normalize(path.join(fromDir, spec)));
          for (const ext of probeExts) {
            const probe = candidateBase + ext;
            if (sourceFilesByRel.has(probe)) return probe;
          }
        }

        return null;
      };

      const getImports = (rel: string): string[] => {
        const sf = sourceFilesByRel.get(rel);
        if (!sf) return [];
        const imports: string[] = [];
        const pre = ts.preProcessFile(sf.text);
        for (const imp of pre.importedFiles) {
          const resolved = resolveImport(rel, imp.fileName);
          if (resolved) imports.push(resolved);
        }
        return imports;
      };

      // 1. Transitive upstream dependencies: files that seedFiles depend on
      const upQueue = [...seedFiles];
      while (upQueue.length > 0) {
        const curr = upQueue.shift()!;
        for (const imported of getImports(curr)) {
          if (!semanticClosure.has(imported)) {
            semanticClosure.add(imported);
            upQueue.push(imported);
          }
        }
      }

      // 2. Transitive downstream consumers: files that depend on seedFiles
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const [file] of sourceFilesByRel) {
          if (semanticClosure.has(file)) continue;
          const imports = getImports(file);
          if (imports.some(imp => semanticClosure.has(imp))) {
            semanticClosure.add(file);
            expanded = true;
          }
        }
      }
    }

    const isRelevantMissingInput = (d: ProgramDiagnosticEvidence) => {
      if (!missingInputCodes.has(d.code)) return false;
      // Project-level configuration error without specific file applies globally
      if (!d.file) return true;
      // In full-workspace mode (no seed files), all files are relevant
      if (seedFiles.size === 0) return true;
      // Otherwise, only missing input diagnostics within the semantic dependency/consumer closure make discovery incomplete
      return semanticClosure.has(d.file);
    };

    const incomplete = unreadable.size > 0 ||
      projectIdentities.length === 0 ||
      selection.closureStatus === 'UNPROVEN' ||
      uniqueFailures.some(isRelevantMissingInput);

    const universe: SnapshotAnalysisUniverse = {
      revision: input.revision,
      languageId: 'typescript',
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      toolchain: input.toolchain,
      projects: projectIdentities.sort((a, b) => binaryCompare(a.projectId, b.projectId)),
      includedFiles: [...included].sort(),
      excludedFiles: [...excluded].map(([file, reason]) => ({ file, reason })).sort((a, b) => binaryCompare(a.file, b.file)),
      parseFailures: uniqueFailures,
      unreadableFiles: [...unreadable].sort(),
      dependencyProvenance: [...provenance].map(([file, origin]) => ({ file, origin })).sort((a, b) => binaryCompare(a.file, b.file)),
      discoveryStatus: incomplete ? 'DISCOVERY_INCOMPLETE' : 'DISCOVERY_COMPLETE',
      ...(input.dependencyStoreEvidence ? { dependencyStore: input.dependencyStoreEvidence } : {})
    };

    return {
      status: projectIdentities.length === 0 ? 'FAILED' : (incomplete ? 'PARTIAL' : 'BUILT'),
      projects,
      universe,
      program: projects[0]?.program,
      selection
    };
  }

  private compilerHost(
    options: ts.CompilerOptions,
    root: string,
    rootPrefix: string,
    provenance: Map<string, 'REPOSITORY_SOURCE' | 'TYPESCRIPT_BUNDLED_LIB' | 'EXTERNAL_DECLARATION'>,
    resolver: VirtualDependencyResolver,
    workspacePackages?: Map<string, { pkgDir: string; mainSource?: string; subpathSources: Map<string, string> }>,
    trackedFiles?: readonly string[]
  ): ts.CompilerHost {
    const base = ts.createCompilerHost(options);
    const libCache = SharedImmutableLibCache.getInstance();

    const nodeBuiltins = new Set([
      'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
      'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
      'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
      'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path',
      'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring',
      'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers',
      'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises',
      'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm',
      'wasi', 'worker_threads', 'zlib'
    ]);

    const findNodeBuiltin = (moduleName: string): ts.ResolvedModuleFull | undefined => {
      const clean = moduleName.replace(/^node:/, '');
      const candidatesDirs: string[] = [];
      const rootTypesNode = path.join(root, 'node_modules/@types/node');
      candidatesDirs.push(rootTypesNode);
      if (resolver.dependencyRoot) {
        candidatesDirs.push(
          path.join(resolver.dependencyRoot, '@types/node'),
          path.join(resolver.dependencyRoot, 'node_modules/@types/node')
        );
      }
      if (resolver.realRepoRoot) {
        candidatesDirs.push(path.join(resolver.realRepoRoot, 'node_modules/@types/node'));
      }

      for (const dir of candidatesDirs) {
        const fileNames = [
          path.join(dir, `${clean}.d.ts`),
          path.join(dir, `${clean.split('/')[0]}.d.ts`),
          path.join(dir, 'index.d.ts')
        ];
        for (const fn of fileNames) {
          if (resolver.fileExists(fn)) {
            return {
              resolvedFileName: fn,
              isExternalLibraryImport: true,
              extension: ts.Extension.Dts
            };
          }
        }
      }
      return undefined;
    };

    const getExtension = (fileName: string): ts.Extension => {
      if (fileName.endsWith('.d.ts')) return ts.Extension.Dts;
      if (fileName.endsWith('.tsx')) return ts.Extension.Tsx;
      if (fileName.endsWith('.ts')) return ts.Extension.Ts;
      if (fileName.endsWith('.jsx')) return ts.Extension.Jsx;
      if (fileName.endsWith('.js')) return ts.Extension.Js;
      return ts.Extension.Ts;
    };

    const findWorkspaceModule = (moduleName: string): ts.ResolvedModuleFull | undefined => {
      if (!workspacePackages || workspacePackages.size === 0) return undefined;

      // Exact match for package name
      const exact = workspacePackages.get(moduleName);
      if (exact?.mainSource && resolver.fileExists(exact.mainSource)) {
        if (normalizeToTrackedRelative(exact.mainSource, root, trackedFiles) !== null) {
          return {
            resolvedFileName: exact.mainSource,
            isExternalLibraryImport: true,
            extension: getExtension(exact.mainSource)
          };
        }
      }

      // Subpath import, e.g. @pkg/foo/bar
      for (const [pkgName, pkgInfo] of workspacePackages) {
        if (moduleName.startsWith(pkgName + '/')) {
          const sub = moduleName.slice(pkgName.length + 1);

          const cached = pkgInfo.subpathSources.get(sub);
          if (cached && resolver.fileExists(cached)) {
            if (normalizeToTrackedRelative(cached, root, trackedFiles) !== null) {
              return {
                resolvedFileName: cached,
                isExternalLibraryImport: true,
                extension: getExtension(cached)
              };
            }
          }

          const pkgDirAbs = path.normalize(path.join(root, ...pkgInfo.pkgDir.split('/')));

          const resolveSubpath = (relPath: string): string | undefined => {
            const hasExt = /\.[cm]?[jt]sx?$/.test(relPath);
            const extensions = hasExt
              ? ['']
              : ['.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts', '.mts', '.cts'];

            const matched: string[] = [];
            for (const ext of extensions) {
              const candAbs = path.normalize(path.join(pkgDirAbs, relPath + ext));
              if (!resolver.inside(candAbs, pkgDirAbs)) continue;
              if (resolver.fileExists(candAbs)) {
                const trackedRel = normalizeToTrackedRelative(candAbs, root, trackedFiles);
                if (trackedRel !== null) {
                  matched.push(candAbs);
                  if (!hasExt) break;
                }
              }
            }
            if (matched.length === 1) return matched[0];
            return undefined;
          };

          // Step A: Check exact requested subpath relative to pkgDirAbs (standard TS resolution first)
          const exactTargetRel = sub.replace(/^\.\//, '');
          const exactResolved = resolveSubpath(exactTargetRel);
          if (exactResolved) {
            pkgInfo.subpathSources.set(sub, exactResolved);
            return {
              resolvedFileName: exactResolved,
              isExternalLibraryImport: true,
              extension: getExtension(exactResolved)
            };
          }

          // Step B: If exact subpath starts with dist/ or lib/ (unbuilt artifact), map to src/
          if (/^(?:\.\/)?(?:dist|lib)\//.test(sub)) {
            const srcTargetRel = sub.replace(/^(?:\.\/)?(?:dist|lib)\//, 'src/');
            const srcResolved = resolveSubpath(srcTargetRel);
            if (srcResolved) {
              pkgInfo.subpathSources.set(sub, srcResolved);
              return {
                resolvedFileName: srcResolved,
                isExternalLibraryImport: true,
                extension: getExtension(srcResolved)
              };
            }
          }
        }
      }

      return undefined;
    };

    const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames ? (f: string) => f : (f: string) => f.toLowerCase();
    const moduleResolutionCache = ts.createModuleResolutionCache(root, getCanonicalFileName, options);

    const resolutionHost: ts.ModuleResolutionHost = {
      fileExists: f => resolver.fileExists(f),
      readFile: f => resolver.readFile(f),
      directoryExists: d => resolver.directoryExists(d),
      getDirectories: d => resolver.getDirectories(d),
      realpath: f => resolver.isAllowed(f) ? f : f,
      getCurrentDirectory: () => root,
      trace: () => {}
    };

    const resolveModule = (moduleName: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
      const standard = ts.resolveModuleName(moduleName, containingFile, options, resolutionHost, moduleResolutionCache);
      if (standard.resolvedModule) {
        return standard.resolvedModule;
      }

      if (moduleName.startsWith('node:') || nodeBuiltins.has(moduleName)) {
        const nodeResolved = findNodeBuiltin(moduleName);
        if (nodeResolved) return nodeResolved;
      }

      const wsResolved = findWorkspaceModule(moduleName);
      if (wsResolved) return wsResolved;

      return undefined;
    };

    return {
      ...base,
      fileExists: f => resolver.fileExists(f),
      readFile: f => {
        if (!resolver.isAllowed(f)) return undefined;
        resolver.recordProvenance(f, provenance);
        return resolver.readFile(f);
      },
      directoryExists: d => resolver.directoryExists(d),
      getDirectories: d => resolver.getDirectories(d),
      readDirectory: (d, e, x, i, depth) => resolver.readDirectory(d, e, x, i, depth),
      resolveModuleNameLiterals: (
        moduleLiterals,
        containingFile
      ) => {
        return moduleLiterals.map(lit => {
          const resolved = resolveModule(lit.text, containingFile);
          return { resolvedModule: resolved };
        });
      },
      resolveModuleNames: (
        moduleNames,
        containingFile
      ) => {
        return moduleNames.map(name => resolveModule(name, containingFile));
      },
      getSourceFile: (f, languageVersion, onError, shouldCreate) => {
        if (!resolver.isAllowed(f)) {
          onError?.(`Path outside snapshot: ${f}`);
          return undefined;
        }
        resolver.recordProvenance(f, provenance);
        const physical = resolver.mapPath(f);

        // Check shared immutable cache strictly for qualifying bundled TS standard library files
        if (SharedImmutableLibCache.isQualifyingLibFile(physical, resolver.libRoot)) {
          const cached = libCache.get(physical, languageVersion);
          if (cached) return cached;
          const text = ts.sys.readFile(physical);
          if (text === undefined) return undefined;
          const sf = ts.createSourceFile(f, text, languageVersion, true);
          libCache.set(physical, languageVersion, sf);
          return sf;
        }

        const text = resolver.readFile(f);
        return text === undefined ? undefined : ts.createSourceFile(f, text, languageVersion, true);
      },
      writeFile: () => {},
      trace: () => {},
      getCurrentDirectory: () => root,
      realpath: f => resolver.isAllowed(f) ? f : f,
      getModuleResolutionCache: () => moduleResolutionCache
    };
  }

  private inside(file: string, root: string, prefix: string): boolean {
    const resolved = path.resolve(file);
    return resolved === root || resolved.startsWith(prefix);
  }

  private diagnostic(d: ts.Diagnostic, root: string, projectConfigFile?: string | null): ProgramDiagnosticEvidence {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    let rel = d.file ? slash(path.relative(root, d.file.fileName)) : null;
    if (!rel && projectConfigFile) {
      rel = projectConfigFile;
    }
    return {
      category: ts.DiagnosticCategory[d.category].toUpperCase() as ProgramDiagnosticEvidence['category'],
      code: d.code,
      file: rel && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel : null,
      line: pos ? pos.line + 1 : null,
      character: pos ? pos.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n')
    };
  }
}

export function canonicalCompilerOptions(options: ts.CompilerOptions): Record<string, unknown> {
  return canonical(options) as Record<string, unknown>;
}
