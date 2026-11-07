/**
 * @file JavaMultiModuleCompilerHost.ts
 * Multi-module reactor-aware compiler host for Maven and Gradle repositories (Phase J-8).
 *
 * Capabilities:
 * - Maps Java source files to enclosing reactor modules based on sealed directory prefixes.
 * - Resolves cross-module symbol imports respecting reactor dependency edges.
 * - Enforces JPMS package export boundaries (module-info.java) when present.
 * - Fails closed on missing reactor dependencies or unexported packages.
 */

import {
  JavaSealedCompilerHost,
  SealedJavaSnapshotInput,
  JavaSymbolResolution
} from './JavaSealedCompilerHost';
import {
  JavaBuildModelExtractor,
  JavaReactorBuildGraph,
  JavaModuleInfo
} from './JavaBuildModelExtractor';
import { JavaClassDeclIR } from '../ir';

export type JavaCrossModuleResolution =
  | {
      readonly status: 'RESOLVED';
      readonly fqcn: string;
      readonly declaration?: JavaClassDeclIR;
      readonly providerModuleId: string;
      readonly isCrossModule: boolean;
    }
  | {
      readonly status: 'UNRESOLVED';
      readonly reason: string;
      readonly searchedName: string;
    }
  | {
      readonly status: 'RESTRICTED';
      readonly restrictionKind: 'MISSING_MODULE_DEPENDENCY' | 'JPMS_PACKAGE_NOT_EXPORTED';
      readonly reason: string;
      readonly searchedName: string;
      readonly providerModuleId: string;
      readonly consumerModuleId: string;
    };

export class JavaMultiModuleCompilerHost {
  private readonly baseHost: JavaSealedCompilerHost;
  private readonly reactorGraph: JavaReactorBuildGraph;
  private readonly fileToModuleMap = new Map<string, JavaModuleInfo>();
  private readonly moduleToFilesMap = new Map<string, string[]>();
  private readonly moduleToClassesMap = new Map<string, Map<string, JavaClassDeclIR>>();
  private readonly transitiveDepCache = new Map<string, Set<string>>();

  constructor(
    private readonly snapshot: SealedJavaSnapshotInput,
    precomputedGraph?: JavaReactorBuildGraph
  ) {
    this.baseHost = new JavaSealedCompilerHost(snapshot);
    this.reactorGraph = precomputedGraph ?? JavaBuildModelExtractor.extractBuildModel(snapshot);

    this.indexModules();
  }

  private indexModules(): void {
    const trackedJavaFiles = this.baseHost.getTrackedJavaFiles();
    const modules = Array.from(this.reactorGraph.modules.values()).sort(
      (a, b) => b.relativePath.length - a.relativePath.length // Longest path match first
    );

    for (const file of trackedJavaFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      let matchedModule: JavaModuleInfo | undefined;

      for (const mod of modules) {
        if (mod.relativePath === '') {
          // Root fallback
          matchedModule = mod;
          continue;
        }
        if (normalizedFile.startsWith(mod.relativePath + '/')) {
          matchedModule = mod;
          break;
        }
      }

      if (!matchedModule && modules.length > 0) {
        matchedModule = modules[0]; // fallback
      }

      if (matchedModule) {
        this.fileToModuleMap.set(normalizedFile, matchedModule);

        const modFiles = this.moduleToFilesMap.get(matchedModule.moduleId) ?? [];
        modFiles.push(normalizedFile);
        this.moduleToFilesMap.set(matchedModule.moduleId, modFiles);

        // Index classes in this module
        const classesInFile = this.baseHost.getFileClasses(normalizedFile);
        let classMap = this.moduleToClassesMap.get(matchedModule.moduleId);
        if (!classMap) {
          classMap = new Map<string, JavaClassDeclIR>();
          this.moduleToClassesMap.set(matchedModule.moduleId, classMap);
        }
        for (const cls of classesInFile) {
          classMap.set(cls.fqcn, cls);
          classMap.set(cls.name, cls);
        }
      }
    }

    // Build transitive dependency cache
    for (const mod of modules) {
      const visited = new Set<string>();
      const queue = [...mod.directDependencies];

      while (queue.length > 0) {
        const dep = queue.shift()!;
        if (!visited.has(dep)) {
          visited.add(dep);
          const depMod = this.reactorGraph.modules.get(dep);
          if (depMod) {
            queue.push(...depMod.directDependencies);
          }
        }
      }
      this.transitiveDepCache.set(mod.moduleId, visited);
    }
  }

  public getBaseHost(): JavaSealedCompilerHost {
    return this.baseHost;
  }

  public getReactorGraph(): JavaReactorBuildGraph {
    return this.reactorGraph;
  }

  public getModuleForFile(filePath: string): JavaModuleInfo | undefined {
    return this.fileToModuleMap.get(filePath.replace(/\\/g, '/'));
  }

  public getModuleFiles(moduleId: string): readonly string[] {
    return this.moduleToFilesMap.get(moduleId) ?? [];
  }

  public getModuleClasses(moduleId: string): readonly JavaClassDeclIR[] {
    const classMap = this.moduleToClassesMap.get(moduleId);
    if (!classMap) return [];
    return Array.from(new Set(classMap.values()));
  }

  public isDirectOrTransitiveDependency(consumerModuleId: string, providerModuleId: string): boolean {
    if (consumerModuleId === providerModuleId) return true;
    const deps = this.transitiveDepCache.get(consumerModuleId);
    return deps ? deps.has(providerModuleId) : false;
  }

  /**
   * Resolves a symbol across multi-module boundaries with reactor dependency and JPMS checks.
   */
  public resolveCrossModuleSymbol(searchedName: string, consumerFilePath: string): JavaCrossModuleResolution {
    const normalizedConsumer = consumerFilePath.replace(/\\/g, '/');
    const consumerModule = this.fileToModuleMap.get(normalizedConsumer);
    const consumerModuleId = consumerModule?.moduleId ?? 'root';

    // 1. First attempt base resolution within compilation unit
    const baseRes = this.baseHost.resolveClass(searchedName, consumerFilePath);
    if (baseRes.status === 'UNRESOLVED') {
      return {
        status: 'UNRESOLVED',
        reason: baseRes.reason,
        searchedName
      };
    }
    if (baseRes.status === 'AMBIGUOUS') {
      return {
        status: 'UNRESOLVED',
        reason: `Ambiguous candidate resolution across modules: [${baseRes.candidates.join(', ')}]`,
        searchedName
      };
    }

    const decl = baseRes.declaration;
    if (!decl) {
      return {
        status: 'RESOLVED',
        fqcn: baseRes.fqcn,
        providerModuleId: 'external',
        isCrossModule: false
      };
    }

    const declFile = decl.filePath.replace(/\\/g, '/');
    const providerModule = this.fileToModuleMap.get(declFile);
    const providerModuleId = providerModule?.moduleId ?? 'root';

    // If declaration is in the same module, no cross-module restrictions apply
    if (consumerModuleId === providerModuleId) {
      return {
        status: 'RESOLVED',
        fqcn: baseRes.fqcn,
        declaration: decl,
        providerModuleId,
        isCrossModule: false
      };
    }

    // 2. Validate reactor dependency: consumer must declare provider as dependency
    const hasReactorDep = this.isDirectOrTransitiveDependency(consumerModuleId, providerModuleId);
    if (!hasReactorDep && this.reactorGraph.isMultiModule) {
      return {
        status: 'RESTRICTED',
        restrictionKind: 'MISSING_MODULE_DEPENDENCY',
        reason: `Reactor dependency violation: Module '${consumerModuleId}' does not declare dependency on provider module '${providerModuleId}' (declaring '${baseRes.fqcn}')`,
        searchedName,
        consumerModuleId,
        providerModuleId
      };
    }

    // 3. Validate JPMS export restrictions if provider defines module-info.java
    if (providerModule?.jpms) {
      const pkg = decl.packageName;
      const isExported =
        providerModule.jpms.exports.includes(pkg) ||
        providerModule.jpms.opens.includes(pkg);

      if (!isExported) {
        return {
          status: 'RESTRICTED',
          restrictionKind: 'JPMS_PACKAGE_NOT_EXPORTED',
          reason: `JPMS boundary restriction: Package '${pkg}' in module '${providerModuleId}' is not exported in module-info.java`,
          searchedName,
          consumerModuleId,
          providerModuleId
        };
      }
    }

    return {
      status: 'RESOLVED',
      fqcn: baseRes.fqcn,
      declaration: decl,
      providerModuleId,
      isCrossModule: true
    };
  }

  /**
   * Evaluates if any circular dependencies exist between reactor modules.
   */
  public detectReactorCycles(): Array<readonly string[]> {
    const cycles: Array<readonly string[]> = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfs = (modId: string) => {
      visited.add(modId);
      recStack.add(modId);
      path.push(modId);

      const mod = this.reactorGraph.modules.get(modId);
      if (mod) {
        for (const dep of mod.directDependencies) {
          if (!visited.has(dep)) {
            dfs(dep);
          } else if (recStack.has(dep)) {
            const cycleStartIdx = path.indexOf(dep);
            if (cycleStartIdx !== -1) {
              cycles.push([...path.slice(cycleStartIdx), dep]);
            }
          }
        }
      }

      recStack.delete(modId);
      path.pop();
    };

    for (const modId of this.reactorGraph.modules.keys()) {
      if (!visited.has(modId)) {
        dfs(modId);
      }
    }

    return cycles;
  }
}
