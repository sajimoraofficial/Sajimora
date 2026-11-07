/**
 * @file JavaBuildModelExtractor.ts
 * Deterministic build model and reactor graph extractor for Maven and Gradle repositories.
 *
 * Supported subset:
 * - Declarative Maven <modules> and <parent> tags.
 * - Declarative Maven inter-module <dependency> coordinate matching.
 * - Static Gradle include(":subproject") and include 'subproject' in settings.gradle(.kts).
 * - Static Gradle project(':subproject') dependencies in build.gradle(.kts).
 * - JPMS module-info.java declarations (module name, exports, requires, opens).
 *
 * Fail-closed boundary:
 * - Dynamic project inclusion, computed paths, or custom plugin-generated modules
 *   are flagged as UNSUPPORTED_DYNAMIC and fail closed to advisory mode.
 */

import { SealedJavaSnapshotInput } from './JavaSealedCompilerHost';

export interface JavaModuleCoordinate {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
}

export interface JavaJPMSDeclaration {
  readonly moduleName: string;
  readonly exports: readonly string[];
  readonly requires: readonly string[];
  readonly requiresTransitive: readonly string[];
  readonly opens: readonly string[];
}

export interface JavaModuleInfo {
  readonly moduleId: string;
  readonly relativePath: string; // Directory containing pom.xml or build.gradle
  readonly coordinate?: JavaModuleCoordinate;
  readonly sourceRoots: readonly string[];
  readonly jpms?: JavaJPMSDeclaration;
  readonly directDependencies: readonly string[]; // Other moduleIds
}

export interface JavaReactorBuildGraph {
  readonly buildSystem: 'MAVEN' | 'GRADLE' | 'STANDALONE';
  readonly isMultiModule: boolean;
  readonly qualificationStatus: 'SUPPORTED_DECLARATIVE' | 'UNSUPPORTED_DYNAMIC' | 'INCOMPLETE';
  readonly rootPath: string;
  readonly modules: ReadonlyMap<string, JavaModuleInfo>;
  readonly interModuleEdges: ReadonlyArray<{
    readonly fromModuleId: string;
    readonly toModuleId: string;
    readonly kind: 'COMPILE' | 'RUNTIME' | 'TEST';
  }>;
  readonly disqualificationReasons: readonly string[];
  readonly rawFiles: readonly string[];
}

export class JavaBuildModelExtractor {
  /**
   * Extracts the reactor build model from a sealed repository snapshot.
   */
  public static extractBuildModel(snapshot: SealedJavaSnapshotInput): JavaReactorBuildGraph {
    const trackedFiles = snapshot.trackedFiles;

    const hasRootPom = trackedFiles.includes('pom.xml');
    const hasSettingsGradle = trackedFiles.includes('settings.gradle') || trackedFiles.includes('settings.gradle.kts');
    const hasRootGradle = trackedFiles.includes('build.gradle') || trackedFiles.includes('build.gradle.kts');

    if (!hasRootPom && !hasSettingsGradle && !hasRootGradle) {
      // Standalone single-module Java repository
      return this.buildStandaloneModel(snapshot);
    }

    if (hasRootPom) {
      return this.extractMavenModel(snapshot);
    }

    if (hasSettingsGradle || hasRootGradle) {
      return this.extractGradleModel(snapshot);
    }

    return this.buildStandaloneModel(snapshot);
  }

  private static buildStandaloneModel(snapshot: SealedJavaSnapshotInput): JavaReactorBuildGraph {
    const defaultModule: JavaModuleInfo = {
      moduleId: 'root',
      relativePath: '',
      sourceRoots: ['src/main/java', 'src'],
      directDependencies: []
    };

    return {
      buildSystem: 'STANDALONE',
      isMultiModule: false,
      qualificationStatus: 'SUPPORTED_DECLARATIVE',
      rootPath: '',
      modules: new Map([['root', defaultModule]]),
      interModuleEdges: [],
      disqualificationReasons: [],
      rawFiles: snapshot.trackedFiles.filter(f => f.endsWith('.java'))
    };
  }

  /**
   * Extracts Maven reactor graph from root and submodule pom.xml files.
   */
  private static extractMavenModel(snapshot: SealedJavaSnapshotInput): JavaReactorBuildGraph {
    const rootPomContent = snapshot.readTextFile('pom.xml');
    if (!rootPomContent) {
      return this.buildStandaloneModel(snapshot);
    }

    const disqualificationReasons: string[] = [];
    const rootCoord = this.parseMavenCoordinate(rootPomContent);

    // Parse <modules> in root pom.xml
    const moduleNames = this.parseMavenModules(rootPomContent);
    if (moduleNames.length === 0) {
      // Single-module Maven project
      const rootModule: JavaModuleInfo = {
        moduleId: rootCoord.artifactId || 'root',
        relativePath: '',
        coordinate: rootCoord,
        sourceRoots: ['src/main/java', 'src'],
        directDependencies: []
      };
      return {
        buildSystem: 'MAVEN',
        isMultiModule: false,
        qualificationStatus: 'SUPPORTED_DECLARATIVE',
        rootPath: '',
        modules: new Map([[rootModule.moduleId, rootModule]]),
        interModuleEdges: [],
        disqualificationReasons: [],
        rawFiles: ['pom.xml']
      };
    }

    // Multi-module Maven reactor
    const modules = new Map<string, JavaModuleInfo>();
    const coordinateToModuleId = new Map<string, string>();
    const moduleDepsRaw = new Map<string, Array<{ groupId: string; artifactId: string }>>();

    // Record root module if it also contains code
    const rootModuleId = rootCoord.artifactId || 'root';

    for (const modRelPath of moduleNames) {
      const normalizedModPath = modRelPath.replace(/^\.\//, '').replace(/\/$/, '');
      const subPomPath = `${normalizedModPath}/pom.xml`;
      const subPomContent = snapshot.readTextFile(subPomPath);

      if (!subPomContent) {
        disqualificationReasons.push(`Missing submodule pom.xml at declared path '${subPomPath}'`);
        continue;
      }

      const subCoord = this.parseMavenCoordinate(subPomContent, rootCoord);
      const moduleId = subCoord.artifactId || normalizedModPath;

      // Extract JPMS module-info.java if present in submodule
      const jpms = this.extractJPMS(snapshot, normalizedModPath);

      // Extract dependencies
      const deps = this.parseMavenDependencies(subPomContent);
      moduleDepsRaw.set(moduleId, deps);

      const modInfo: JavaModuleInfo = {
        moduleId,
        relativePath: normalizedModPath,
        coordinate: subCoord,
        sourceRoots: [
          `${normalizedModPath}/src/main/java`,
          `${normalizedModPath}/src`
        ],
        jpms,
        directDependencies: []
      };

      modules.set(moduleId, modInfo);
      if (subCoord.groupId && subCoord.artifactId) {
        coordinateToModuleId.set(`${subCoord.groupId}:${subCoord.artifactId}`, moduleId);
        coordinateToModuleId.set(subCoord.artifactId, moduleId); // simple artifactId alias
      }
    }

    // Wire inter-module dependency edges
    const interModuleEdges: Array<{ fromModuleId: string; toModuleId: string; kind: 'COMPILE' | 'RUNTIME' | 'TEST' }> = [];
    const updatedModules = new Map<string, JavaModuleInfo>();

    for (const [modId, modInfo] of modules) {
      const rawDeps = moduleDepsRaw.get(modId) ?? [];
      const resolvedDependencies: string[] = [];

      for (const dep of rawDeps) {
        const fullKey = `${dep.groupId}:${dep.artifactId}`;
        const targetModId = coordinateToModuleId.get(fullKey) ?? coordinateToModuleId.get(dep.artifactId);
        if (targetModId && targetModId !== modId) {
          resolvedDependencies.push(targetModId);
          interModuleEdges.push({
            fromModuleId: modId,
            toModuleId: targetModId,
            kind: 'COMPILE'
          });
        }
      }

      updatedModules.set(modId, {
        ...modInfo,
        directDependencies: Object.freeze(resolvedDependencies.sort())
      });
    }

    const isSupported = disqualificationReasons.length === 0;

    return {
      buildSystem: 'MAVEN',
      isMultiModule: true,
      qualificationStatus: isSupported ? 'SUPPORTED_DECLARATIVE' : 'INCOMPLETE',
      rootPath: '',
      modules: updatedModules,
      interModuleEdges: Object.freeze(interModuleEdges),
      disqualificationReasons: Object.freeze(disqualificationReasons),
      rawFiles: ['pom.xml', ...moduleNames.map(m => `${m}/pom.xml`)]
    };
  }

  /**
   * Extracts Gradle reactor graph from settings.gradle and build.gradle files.
   */
  private static extractGradleModel(snapshot: SealedJavaSnapshotInput): JavaReactorBuildGraph {
    const settingsContent =
      snapshot.readTextFile('settings.gradle') ??
      snapshot.readTextFile('settings.gradle.kts') ??
      '';

    const disqualificationReasons: string[] = [];

    // Check for unsupported dynamic Gradle scripting across all Gradle build files
    const dynamicPatterns = [
      /rootDir\.listFiles/,
      /fileTree\s*\(/,
      /new\s+File\s*\(/,
      /\.each\s*\{[^}]*include/,
      /includeFlat\s*\(/,
      /subprojects\s*\.\s*(?:findAll|each)/
    ];

    const allGradleFiles = snapshot.trackedFiles.filter(f =>
      f === 'settings.gradle' ||
      f === 'settings.gradle.kts' ||
      f.endsWith('build.gradle') ||
      f.endsWith('build.gradle.kts')
    );

    for (const gf of allGradleFiles) {
      const content = snapshot.readTextFile(gf) ?? '';
      for (const pat of dynamicPatterns) {
        if (pat.test(content)) {
          disqualificationReasons.push(
            `Dynamic Gradle script logic detected matching ${pat.source} in ${gf}: Disqualified from Certified F0.`
          );
          break;
        }
      }
    }

    // Extract static include calls: include(":core", ":api") or include 'core', 'api'
    const includedModules = this.parseGradleIncludes(settingsContent);

    if (includedModules.length === 0) {
      // Single-module Gradle project
      const rootModule: JavaModuleInfo = {
        moduleId: 'root',
        relativePath: '',
        sourceRoots: ['src/main/java', 'src'],
        directDependencies: []
      };
      return {
        buildSystem: 'GRADLE',
        isMultiModule: false,
        qualificationStatus: disqualificationReasons.length === 0 ? 'SUPPORTED_DECLARATIVE' : 'UNSUPPORTED_DYNAMIC',
        rootPath: '',
        modules: new Map([['root', rootModule]]),
        interModuleEdges: [],
        disqualificationReasons: Object.freeze(disqualificationReasons),
        rawFiles: ['settings.gradle']
      };
    }

    const modules = new Map<string, JavaModuleInfo>();
    const moduleDepsRaw = new Map<string, string[]>();

    for (const rawMod of includedModules) {
      const cleanMod = rawMod.replace(/^:/, '');
      const relPath = cleanMod.replace(/:/g, '/');
      const moduleId = cleanMod.split(':').pop() ?? cleanMod;

      // Locate build.gradle(.kts) in module path
      const buildGradle =
        snapshot.readTextFile(`${relPath}/build.gradle`) ??
        snapshot.readTextFile(`${relPath}/build.gradle.kts`) ??
        '';

      const deps = this.parseGradleProjectDependencies(buildGradle);
      moduleDepsRaw.set(moduleId, deps);

      const jpms = this.extractJPMS(snapshot, relPath);

      modules.set(moduleId, {
        moduleId,
        relativePath: relPath,
        sourceRoots: [`${relPath}/src/main/java`, `${relPath}/src`],
        jpms,
        directDependencies: []
      });
    }

    // Wire inter-module edges
    const interModuleEdges: Array<{ fromModuleId: string; toModuleId: string; kind: 'COMPILE' | 'RUNTIME' | 'TEST' }> = [];
    const updatedModules = new Map<string, JavaModuleInfo>();

    for (const [modId, modInfo] of modules) {
      const rawDeps = moduleDepsRaw.get(modId) ?? [];
      const resolved: string[] = [];

      for (const targetName of rawDeps) {
        const cleanTarget = targetName.replace(/^:/, '').split(':').pop() ?? targetName;
        if (modules.has(cleanTarget) && cleanTarget !== modId) {
          resolved.push(cleanTarget);
          interModuleEdges.push({
            fromModuleId: modId,
            toModuleId: cleanTarget,
            kind: 'COMPILE'
          });
        }
      }

      updatedModules.set(modId, {
        ...modInfo,
        directDependencies: Object.freeze(resolved.sort())
      });
    }

    const isSupported = disqualificationReasons.length === 0;

    return {
      buildSystem: 'GRADLE',
      isMultiModule: true,
      qualificationStatus: isSupported ? 'SUPPORTED_DECLARATIVE' : 'UNSUPPORTED_DYNAMIC',
      rootPath: '',
      modules: updatedModules,
      interModuleEdges: Object.freeze(interModuleEdges),
      disqualificationReasons: Object.freeze(disqualificationReasons),
      rawFiles: ['settings.gradle', ...includedModules.map(m => `${m.replace(/^:/, '')}/build.gradle`)]
    };
  }

  // --- XML & Gradle Text Parsing Helpers ---

  private static parseMavenCoordinate(xml: string, parentCoord?: JavaModuleCoordinate): JavaModuleCoordinate {
    const getTag = (tag: string): string => {
      // Avoid matching inside <parent>...</parent> first
      const bodyWithoutParent = xml.replace(/<parent>[\s\S]*?<\/parent>/, '');
      const match = bodyWithoutParent.match(new RegExp(`<${tag}>\\s*([^<]+)\\s*<\\/${tag}>`));
      if (match) return match[1].trim();

      // Fallback to parent
      const parentMatch = xml.match(new RegExp(`<parent>[\\s\\S]*?<${tag}>\\s*([^<]+)\\s*<\\/${tag}>[\\s\\S]*?<\\/parent>`));
      return parentMatch ? parentMatch[1].trim() : '';
    };

    const groupId = getTag('groupId') || (parentCoord?.groupId ?? '');
    const artifactId = getTag('artifactId');
    const version = getTag('version') || (parentCoord?.version ?? '1.0.0');

    return { groupId, artifactId, version };
  }

  private static parseMavenModules(xml: string): string[] {
    const modulesBlockMatch = xml.match(/<modules>([\s\S]*?)<\/modules>/);
    if (!modulesBlockMatch) return [];

    const modules: string[] = [];
    const moduleTagRegex = /<module>\s*([^<]+)\s*<\/module>/g;
    let match: RegExpExecArray | null;

    while ((match = moduleTagRegex.exec(modulesBlockMatch[1])) !== null) {
      modules.push(match[1].trim());
    }

    return modules;
  }

  private static parseMavenDependencies(xml: string): Array<{ groupId: string; artifactId: string }> {
    const deps: Array<{ groupId: string; artifactId: string }> = [];
    const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match: RegExpExecArray | null;

    while ((match = depRegex.exec(xml)) !== null) {
      const depBlock = match[1];
      const gMatch = depBlock.match(/<groupId>\s*([^<]+)\s*<\/groupId>/);
      const aMatch = depBlock.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/);
      if (aMatch) {
        deps.push({
          groupId: gMatch ? gMatch[1].trim() : '',
          artifactId: aMatch[1].trim()
        });
      }
    }

    return deps;
  }

  private static parseGradleIncludes(settingsText: string): string[] {
    const includes: string[] = [];
    // Match include(":core", ":api") or include 'core', 'api'
    const includeCalls = settingsText.match(/include\s*\(?([^)\r\n;]+)\)?/g);
    if (!includeCalls) return [];

    for (const call of includeCalls) {
      const stringMatches = call.match(/['"]([^'"]+)['"]/g);
      if (stringMatches) {
        for (const s of stringMatches) {
          const mod = s.replace(/['"]/g, '').trim();
          if (mod) includes.push(mod);
        }
      }
    }

    return includes;
  }

  private static parseGradleProjectDependencies(buildText: string): string[] {
    const deps: string[] = [];
    // Match project(':core') or project(":api")
    const projDepRegex = /project\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = projDepRegex.exec(buildText)) !== null) {
      deps.push(match[1].trim());
    }

    return deps;
  }

  private static extractJPMS(snapshot: SealedJavaSnapshotInput, moduleRelPath: string): JavaJPMSDeclaration | undefined {
    const moduleInfoPath = moduleRelPath ? `${moduleRelPath}/src/main/java/module-info.java` : 'src/main/java/module-info.java';
    const content = snapshot.readTextFile(moduleInfoPath);
    if (!content) return undefined;

    const modNameMatch = content.match(/module\s+([a-zA-Z0-9_.]+)\s*\{/);
    if (!modNameMatch) return undefined;

    const moduleName = modNameMatch[1].trim();
    const exports: string[] = [];
    const requires: string[] = [];
    const requiresTransitive: string[] = [];
    const opens: string[] = [];

    const exportRegex = /exports\s+([a-zA-Z0-9_.]+)(?:\s+to\s+[^;]+)?\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = exportRegex.exec(content)) !== null) {
      exports.push(m[1].trim());
    }

    const reqTransRegex = /requires\s+transitive\s+([a-zA-Z0-9_.]+)\s*;/g;
    while ((m = reqTransRegex.exec(content)) !== null) {
      requiresTransitive.push(m[1].trim());
    }

    const reqRegex = /requires\s+(?!transitive\s+)([a-zA-Z0-9_.]+)\s*;/g;
    while ((m = reqRegex.exec(content)) !== null) {
      requires.push(m[1].trim());
    }

    const openRegex = /opens\s+([a-zA-Z0-9_.]+)(?:\s+to\s+[^;]+)?\s*;/g;
    while ((m = openRegex.exec(content)) !== null) {
      opens.push(m[1].trim());
    }

    return {
      moduleName,
      exports: Object.freeze(exports.sort()),
      requires: Object.freeze(requires.sort()),
      requiresTransitive: Object.freeze(requiresTransitive.sort()),
      opens: Object.freeze(opens.sort())
    };
  }
}
