import * as path from 'node:path';
import * as ts from 'typescript';
import { VirtualDependencyResolver } from './VirtualDependencyResolver';

const slash = (value: string) => value.replace(/\\/g, '/');

export interface ProjectMetadata {
  configRel: string;
  configPath: string;
  projectDir: string;
  fileNames: string[];
  fileSet: Set<string>;
  references: string[];
  options: ts.CompilerOptions;
  packageName?: string;
  packageDir?: string;
  dependencies: Set<string>;
  entrypoints: Set<string>;
}

export interface ProjectSelectionResult {
  selectedConfigs: string[];
  subsumedConfigs: string[];
  allConfigs: string[];
  closureStatus: 'PROVEN' | 'UNPROVEN';
  closureBlockers: string[];
}

export class TypeScriptProjectSelector {
  /**
   * Selects projects required by changed files and their relevant downstream consumers,
   * proves consumer closure within the declared analysis universe, and eliminates
   * redundant root project materializations through safe subsumption.
   */
  selectProjects(
    root: string,
    trackedFiles: readonly string[],
    changedFiles?: readonly string[],
    readTextFile?: (relPath: string) => string | undefined,
    resolverOrDependencyRoot?: VirtualDependencyResolver | string
  ): ProjectSelectionResult {
    const rootPath = path.resolve(root);
    const rootPrefix = rootPath + path.sep;
    const configs = trackedFiles.filter(f => /(^|\/)tsconfig\.json$/.test(slash(f))).sort();

    if (configs.length === 0) {
      return {
        selectedConfigs: [],
        subsumedConfigs: [],
        allConfigs: [],
        closureStatus: 'PROVEN',
        closureBlockers: []
      };
    }

    // 1. If no changed files were provided, retain all projects (full backward compatibility).
    if (!changedFiles || changedFiles.length === 0) {
      return {
        selectedConfigs: [...configs],
        subsumedConfigs: [],
        allConfigs: [...configs],
        closureStatus: 'PROVEN',
        closureBlockers: []
      };
    }

    const relative = (file: string): string => {
      const resolved = path.resolve(file);
      return slash(path.relative(rootPath, resolved));
    };

    const getFileContent = (relPath: string): string | undefined => {
      try {
        if (readTextFile) return readTextFile(relPath);
        const full = path.join(rootPath, ...slash(relPath).split('/'));
        return ts.sys.readFile(full);
      } catch {
        return undefined;
      }
    };

    const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));
    const resolver = resolverOrDependencyRoot instanceof VirtualDependencyResolver
      ? resolverOrDependencyRoot
      : new VirtualDependencyResolver({
          snapshotRoot: rootPath,
          libRoot,
          dependencyRoot: typeof resolverOrDependencyRoot === 'string' ? resolverOrDependencyRoot : undefined
        });

    const vHost = resolver.createParseConfigHost();
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: vHost.useCaseSensitiveFileNames,
      fileExists: (f: string) => {
        if (readTextFile) {
          const rel = relative(f);
          if (rel && readTextFile(rel) !== undefined) return true;
        }
        return vHost.fileExists(f);
      },
      readFile: (f: string) => {
        if (readTextFile) {
          const rel = relative(f);
          if (rel) {
            const content = readTextFile(rel);
            if (content !== undefined) return content;
          }
        }
        return vHost.readFile(f);
      },
      readDirectory: (dir, ext, exclude, include, depth) => vHost.readDirectory(dir, ext, exclude, include, depth)
    };

    // 2. Discover package.json manifests across tracked files for workspace package dependency resolution
    const packageFiles = trackedFiles.filter(f => /(^|\/)package\.json$/.test(slash(f)));
    const packageByDir = new Map<string, { name: string; dependencies: Set<string>; entrypoints: Set<string> }>();

    const extractPathsFromExports = (val: any, out: Set<string>) => {
      if (typeof val === 'string') {
        out.add(val);
      } else if (Array.isArray(val)) {
        for (const item of val) extractPathsFromExports(item, out);
      } else if (val && typeof val === 'object') {
        for (const k of Object.keys(val)) {
          extractPathsFromExports(val[k], out);
        }
      }
    };

    for (const pkgRel of packageFiles) {
      const pkgDir = slash(path.dirname(pkgRel));
      try {
        const text = getFileContent(pkgRel);
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.name === 'string') {
            const deps = new Set<string>();
            const addDeps = (obj: any) => {
              if (obj && typeof obj === 'object') {
                for (const key of Object.keys(obj)) deps.add(key);
              }
            };
            addDeps(parsed.dependencies);
            addDeps(parsed.devDependencies);
            addDeps(parsed.peerDependencies);
            addDeps(parsed.optionalDependencies);

            const rawEntrypoints = new Set<string>();
            if (typeof parsed.main === 'string') rawEntrypoints.add(parsed.main);
            if (typeof parsed.module === 'string') rawEntrypoints.add(parsed.module);
            if (typeof parsed.types === 'string') rawEntrypoints.add(parsed.types);
            if (typeof parsed.typings === 'string') rawEntrypoints.add(parsed.typings);
            if (parsed.exports) extractPathsFromExports(parsed.exports, rawEntrypoints);

            const entrypoints = new Set<string>();
            for (const ep of rawEntrypoints) {
              const clean = ep.replace(/^\.\//, '');
              const full = pkgDir === '.' ? clean : `${pkgDir}/${clean}`;
              entrypoints.add(slash(path.normalize(full)));
            }

            packageByDir.set(pkgDir, { name: parsed.name, dependencies: deps, entrypoints });
          }
        }
      } catch {
        // Malformed package.json is ignored
      }
    }

    // 3. Parse all tsconfig.json files in a fast pre-pass (metadata only, no ASTs created)
    const projectList: ProjectMetadata[] = [];
    const projectByConfig = new Map<string, ProjectMetadata>();

    for (const configRel of configs) {
      const configPath = path.join(rootPath, ...slash(configRel).split('/'));
      const read = ts.readConfigFile(configPath, f => parseHost.readFile(f));
      if (read.error) {
        return {
          selectedConfigs: [...configs],
          subsumedConfigs: [],
          allConfigs: [...configs],
          closureStatus: 'UNPROVEN',
          closureBlockers: [`CONFIG_READ_ERROR:${configRel}`]
        };
      }

      const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, path.dirname(configPath), undefined, configPath);
      const projectDir = slash(path.dirname(configRel));
      const fileNames = parsed.fileNames.map(relative).sort();
      const fileSet = new Set(fileNames);

      const references = (parsed.projectReferences ?? []).map(r => {
        const refPath = ts.resolveProjectReferencePath(r);
        return slash(path.relative(rootPath, refPath));
      }).sort();

      // Locate nearest package.json for this project directory
      let curDir = projectDir;
      let matchedPkg: { name: string; dependencies: Set<string>; entrypoints: Set<string> } | undefined;
      let matchedPkgDir: string | undefined;
      while (curDir !== '.') {
        matchedPkg = packageByDir.get(curDir);
        if (matchedPkg) {
          matchedPkgDir = curDir;
          break;
        }
        const parent = slash(path.dirname(curDir));
        if (parent === curDir) break;
        curDir = parent;
      }
      if (!matchedPkg && packageByDir.has('.')) {
        matchedPkg = packageByDir.get('.');
        matchedPkgDir = '.';
      }

      const meta: ProjectMetadata = {
        configRel,
        configPath,
        projectDir,
        fileNames,
        fileSet,
        references,
        options: parsed.options,
        packageName: matchedPkg?.name,
        packageDir: matchedPkgDir,
        dependencies: matchedPkg?.dependencies ?? new Set(),
        entrypoints: matchedPkg?.entrypoints ?? new Set()
      };

      projectList.push(meta);
      projectByConfig.set(configRel, meta);
    }

    const changedSet = new Set(changedFiles.map(slash));

    // 4. Identify directly affected projects (projects containing the changed files)
    const directlyAffected = new Set<ProjectMetadata>();
    for (const p of projectList) {
      const hasDirectFile = p.fileNames.some(f => changedSet.has(f));
      const hasChangedFileInDir = [...changedSet].some(f => {
        if (f === p.projectDir || f.startsWith(p.projectDir + '/')) {
          return /\.[cm]?[jt]sx?$/.test(f);
        }
        if (p.projectDir === '.') {
          const hasChildOwner = projectList.some(other => other !== p && other.projectDir !== '.' && (f === other.projectDir || f.startsWith(other.projectDir + '/')));
          return !hasChildOwner && /\.[cm]?[jt]sx?$/.test(f);
        }
        return false;
      });

      if (hasDirectFile || hasChangedFileInDir) {
        directlyAffected.add(p);
      }
    }

    if (directlyAffected.size === 0) {
      return {
        selectedConfigs: [...configs],
        subsumedConfigs: [],
        allConfigs: [...configs],
        closureStatus: 'UNPROVEN',
        closureBlockers: ['CHANGED_FILES_OUTSIDE_ALL_PROJECTS']
      };
    }

    const probeExtensions = [
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

    const matchesReExportChain = (targetBase: string, chains: Set<string>): boolean => {
      const normTarget = slash(targetBase);
      for (const ext of probeExtensions) {
        const probe = normTarget + ext;
        if (chains.has(probe)) return true;
      }
      const targetStem = normTarget.replace(/\.[cm]?[jt]sx?$/, '');
      for (const ch of chains) {
        if (ch === normTarget || ch.startsWith(normTarget + '.')) return true;
        const chStem = ch.replace(/\.[cm]?[jt]sx?$/, '');
        if (chStem === targetStem) return true;
      }
      return false;
    };

    const resolveProjectBaseDir = (options: ts.CompilerOptions, projectDir: string): string => {
      if (!options.baseUrl) return projectDir;
      if (path.isAbsolute(options.baseUrl)) {
        return slash(path.relative(rootPath, options.baseUrl));
      }
      return slash(path.relative(rootPath, path.resolve(rootPath, projectDir, options.baseUrl)));
    };

    // 5. Trace export / re-export chains of changed files within the directly affected projects
    // To know which modules can expose declarations from the changed files to external consumers
    const reExportChains = new Set<string>(changedSet);
    const exposedPackageNames = new Set<string>();

    for (const p of directlyAffected) {
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const f of p.fileNames) {
          if (reExportChains.has(f)) continue;
          const content = getFileContent(f);
          if (!content) continue;

          // Check if file f re-exports from any file in reExportChains
          const exportRegex = /export\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
          let m: RegExpExecArray | null;
          while ((m = exportRegex.exec(content)) !== null) {
            const target = m[1];
            if (!target) continue;

            const candidateTargets: string[] = [];

            // (1) Relative re-export: export * from './submodule'
            if (target.startsWith('.')) {
              candidateTargets.push(slash(path.normalize(path.join(path.dirname(f), target))));
            }

            // (2) Aliased re-export: export * from '@/submodule'
            if (p.options.paths) {
              const baseDir = resolveProjectBaseDir(p.options, p.projectDir);
              for (const [alias, targets] of Object.entries(p.options.paths)) {
                const aliasPrefix = alias.replace(/\*$/, '');
                if (target.startsWith(aliasPrefix)) {
                  const suffix = target.slice(aliasPrefix.length);
                  for (const t of targets) {
                    candidateTargets.push(slash(path.normalize(path.join(baseDir, t.replace(/\*$/, suffix)))));
                  }
                }
              }
            }

            // (3) Workspace package re-export: export * from '@workspace/pkg'
            for (const [, pkgInfo] of packageByDir) {
              if (target === pkgInfo.name || target.startsWith(pkgInfo.name + '/')) {
                for (const ep of pkgInfo.entrypoints) {
                  candidateTargets.push(ep);
                }
              }
            }

            const isReExport = candidateTargets.some(ct => matchesReExportChain(ct, reExportChains));

            if (isReExport) {
              reExportChains.add(f);
              expanded = true;
              break;
            }
          }
        }
      }

      // Check if any declared package entrypoint of p re-exports from the chain
      if (p.packageName) {
        const entrypoints = p.entrypoints;
        const isExposedByEntrypoint = [...reExportChains].some(ch => {
          if (entrypoints.has(ch)) return true;
          const chStem = ch.replace(/\.[cm]?[jt]sx?$/, '');
          for (const ep of entrypoints) {
            if (ep === ch) return true;
            const epStem = ep.replace(/\.[cm]?[jt]sx?$/, '');
            if (epStem === chStem) return true;
          }
          // If no explicit entrypoint was declared, fallback to index in project or package directory
          if (entrypoints.size === 0) {
            const base = path.basename(ch);
            return (base.startsWith('index.') || ch === p.projectDir + '/index.ts' || ch === (p.packageDir ?? p.projectDir) + '/index.ts');
          }
          return false;
        });
        if (isExposedByEntrypoint) {
          exposedPackageNames.add(p.packageName);
        }
      }
    }

    // 6. Identify downstream consumer projects (transitive fixed-point closure)
    const requiredProjects = new Set<ProjectMetadata>(directlyAffected);
    const closureBlockers: string[] = [];

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidate of projectList) {
        if (requiredProjects.has(candidate)) continue;

        let isConsumer = false;

        // (a) Project reference: candidate explicitly references any required project
        if (candidate.references.some(ref => [...requiredProjects].some(req => req.configRel === ref))) {
          isConsumer = true;
        }

        // (b) Source files in candidate import directly from the changed re-export chain
        if (!isConsumer) {
          for (const f of candidate.fileNames) {
            const content = getFileContent(f);
            if (!content) continue;

            const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            let m: RegExpExecArray | null;
            while ((m = importRegex.exec(content)) !== null) {
              const specifier = m[1] ?? m[2];
              if (!specifier) continue;

              // Matches exposed package name
              if (exposedPackageNames.has(specifier) || [...exposedPackageNames].some(pkg => specifier.startsWith(pkg + '/'))) {
                isConsumer = true;
                break;
              }

              // Matches relative path reaching into re-export chain
              if (specifier.startsWith('.')) {
                const resolvedImport = slash(path.normalize(path.join(path.dirname(f), specifier)));
                if (matchesReExportChain(resolvedImport, reExportChains)) {
                  isConsumer = true;
                  break;
                }
              }

              // Matches candidate's compilerOptions paths pointing to re-export chain
              if (candidate.options.paths) {
                const baseDir = resolveProjectBaseDir(candidate.options, candidate.projectDir);
                for (const [alias, targets] of Object.entries(candidate.options.paths)) {
                  const aliasPrefix = alias.replace(/\*$/, '');
                  if (specifier.startsWith(aliasPrefix)) {
                    const suffix = specifier.slice(aliasPrefix.length);
                    for (const target of targets) {
                      const resolvedTarget = slash(path.normalize(path.join(baseDir, target.replace(/\*$/, suffix))));
                      if (matchesReExportChain(resolvedTarget, reExportChains)) {
                        isConsumer = true;
                        break;
                      }
                    }
                  }
                  if (isConsumer) break;
                }
              }
            }
            if (isConsumer) break;
          }
        }

        if (isConsumer) {
          requiredProjects.add(candidate);
          expanded = true;
        }
      }
    }

    // 7. Validate closure against remaining unselected projects (Consumer Closure Proof)
    const trackedSet = new Set(trackedFiles.map(slash));
    const unselectedProjects = projectList.filter(p => !requiredProjects.has(p));
    for (const u of unselectedProjects) {
      for (const f of u.fileNames) {
        const content = getFileContent(f);
        if (content === undefined) {
          const normF = slash(f);
          const fullPath = path.join(rootPath, ...normF.split('/'));
          const existsOnDisk = ts.sys.fileExists(fullPath);
          const existsInTracked = trackedSet.has(normF);
          // If the file exists in the repository or snapshot but cannot be read, it is an unreadable source blocker.
          // If confirmed absent from git repository, snapshot, and disk, it is proven non-existent, NOT unreadable.
          if (existsInTracked || existsOnDisk) {
            closureBlockers.push(`UNREADABLE_SOURCE_IN_UNSELECTED_PROJECT:${f}`);
            break;
          }
          continue;
        }

        // Check for wildcard re-export from dynamic/unresolved targets
        if (/export\s+\*\s+from\s+['"][^'"]*[*?][^'"]*['"]/.test(content)) {
          closureBlockers.push(`UNRESOLVABLE_WILDCARD_EXPORT_IN_PROJECT:${u.configRel}:${f}`);
        }
      }
    }

    // 8. Project Subsumption / Deduplication
    // Avoid independently building root / ancestor projects that duplicate the source universe of leaf projects
    const subsumed = new Set<ProjectMetadata>();
    for (const r of requiredProjects) {
      const subprojects = [...requiredProjects].filter(l =>
        l !== r &&
        l.projectDir !== '.' &&
        (r.projectDir === '.' || l.projectDir.startsWith(r.projectDir + '/'))
      );

      if (subprojects.length > 0) {
        const leafFileSet = new Set<string>();
        for (const sub of subprojects) {
          for (const lf of sub.fileNames) leafFileSet.add(lf);
        }

        // Check if all changed files in r are covered by leaf subprojects
        const uniqueChangedFiles = [...changedSet].filter(f => r.fileSet.has(f) && !leafFileSet.has(f));
        const hasLeafCoveringChanges = subprojects.some(s => s.fileNames.some(f => changedSet.has(f)));

        if (uniqueChangedFiles.length === 0 && hasLeafCoveringChanges) {
          subsumed.add(r);
        }
      }
    }

    const selected = [...requiredProjects]
      .filter(p => !subsumed.has(p))
      .map(p => p.configRel)
      .sort();

    const finalSelected = selected.length > 0
      ? selected
      : [...requiredProjects].map(p => p.configRel).sort();

    return {
      selectedConfigs: finalSelected,
      subsumedConfigs: [...subsumed].map(p => p.configRel).sort(),
      allConfigs: [...configs],
      closureStatus: closureBlockers.length > 0 ? 'UNPROVEN' : 'PROVEN',
      closureBlockers
    };
  }
}
