import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import {
  RepositoryAnalysisUniverse,
  UniverseDiscoveryStatus,
  isSourceInUniverse,
  normalizePath,
  normalizeModuleIdentity
} from '@sajimora/core';

export interface UniverseBuildOptions {
  workspaceRoot: string;
  configPath?: string;
  compilerHost?: ts.CompilerHost;
  fileContents?: Map<string, string>; // In-memory virtual filesystem for testing
}

export class RepositoryAnalysisUniverseBuilder {
  /**
   * Constructs an authoritative RepositoryAnalysisUniverse.
   * Delegates config resolution to TypeScript's native parser (ts.readConfigFile, ts.parseJsonConfigFileContent)
   * and recursively resolves all projectReferences.
   */
  public static build(options: UniverseBuildOptions): RepositoryAnalysisUniverse {
    const rawRoot = path.resolve(options.workspaceRoot);
    const rootPath = normalizePath(rawRoot);
    const excludedFiles = new Map<string, string>();
    const unsupportedFiles: string[] = [];
    const unreadableFiles: string[] = [];
    const parseFailures = new Map<string, string>();

    let discoveredFiles: string[] = [];
    let discoveryStatus: UniverseDiscoveryStatus = 'DISCOVERY_COMPLETE';
    let discoveryEvidence = `Scanned workspace at ${rootPath}`;
    let resolvedCompilerOptions: Record<string, unknown> | undefined;

    // If in-memory file contents are provided (for virtual adversarial fixtures)
    if (options.fileContents) {
      for (const filePath of options.fileContents.keys()) {
        const norm = normalizePath(filePath);
        if (norm.endsWith('.ts') || norm.endsWith('.tsx') || norm.endsWith('.d.ts')) {
          discoveredFiles.push(norm);
        } else {
          unsupportedFiles.push(norm);
          excludedFiles.set(norm, 'UNSUPPORTED_LANGUAGE_EXTENSION');
        }
      }
      discoveredFiles = Array.from(new Set(discoveredFiles)).sort();
      return {
        rootPath,
        discoveredFiles,
        discoveredFileSet: new Set(discoveredFiles),
        excludedFiles,
        unsupportedFiles,
        unreadableFiles,
        parseFailures,
        discoveryStatus,
        discoveryEvidence: `Discovered ${discoveredFiles.length} files from in-memory host`
      };
    }

    const host = options.compilerHost ?? ts.sys;
    const configFileName = options.configPath
      ? path.resolve(options.configPath)
      : ts.findConfigFile(rawRoot, host.fileExists.bind(host), 'tsconfig.json');

    if (!configFileName || !host.fileExists(configFileName)) {
      // Fallback to recursive directory scan if tsconfig is absent
      try {
        discoveredFiles = this.scanDirectoryRecursive(rawRoot, excludedFiles, unsupportedFiles);
        discoveryEvidence += `; No tsconfig found, directory walk enumerated ${discoveredFiles.length} files`;
      } catch (err: any) {
        unreadableFiles.push(rawRoot);
        discoveryStatus = 'DISCOVERY_FAILED';
        discoveryEvidence += `; Directory walk failed: ${err.message}`;
      }
    } else {
      try {
        const parseHost: ts.ParseConfigHost = {
          useCaseSensitiveFileNames: typeof host.useCaseSensitiveFileNames === 'function'
            ? host.useCaseSensitiveFileNames()
            : Boolean((host as any).useCaseSensitiveFileNames),
          readDirectory: 'readDirectory' in host && typeof host.readDirectory === 'function'
            ? host.readDirectory.bind(host)
            : ts.sys.readDirectory.bind(ts.sys),
          fileExists: host.fileExists.bind(host),
          readFile: host.readFile.bind(host),
          trace: 'trace' in host && typeof (host as any).trace === 'function' ? (host as any).trace.bind(host) : undefined
        };

        const visitedConfigs = new Set<string>();
        const resolution = this.resolveConfigFileRecursive(
          configFileName,
          host,
          parseHost,
          visitedConfigs,
          excludedFiles,
          unsupportedFiles,
          unreadableFiles
        );
        discoveredFiles = resolution.files;
        resolvedCompilerOptions = resolution.compilerOptions;

        if (unreadableFiles.length > 0) {
          discoveryStatus = 'DISCOVERY_INCOMPLETE';
          discoveryEvidence += `; Warnings: ${unreadableFiles.length} config/project files unreadable`;
        } else {
          discoveryEvidence += `; Native ts.parseJsonConfigFileContent & projectReferences resolved ${discoveredFiles.length} files across ${visitedConfigs.size} config(s)`;
        }
      } catch (err: any) {
        discoveryStatus = 'DISCOVERY_FAILED';
        unreadableFiles.push(configFileName);
        discoveryEvidence += `; Fatal config resolution failure: ${err.message}`;
      }
    }

    // Deduplicate and sort discovered files deterministically
    discoveredFiles = Array.from(new Set(discoveredFiles)).sort();

    return {
      rootPath,
      discoveredFiles,
      discoveredFileSet: new Set(discoveredFiles),
      excludedFiles,
      unsupportedFiles,
      unreadableFiles,
      parseFailures,
      discoveryStatus,
      discoveryEvidence
      , compilerOptions: resolvedCompilerOptions
    };
  }

  private static resolveConfigFileRecursive(
    configFileName: string,
    host: ts.CompilerHost | ts.System,
    parseHost: ts.ParseConfigHost,
    visitedConfigs: Set<string>,
    excludedFiles: Map<string, string>,
    unsupportedFiles: string[],
    unreadableFiles: string[]
  ): { files: string[]; compilerOptions?: Record<string, unknown> } {
    const normalizedConfigPath = normalizePath(configFileName);
    if (visitedConfigs.has(normalizedConfigPath)) {
      return { files: [] };
    }
    visitedConfigs.add(normalizedConfigPath);

    if (!host.fileExists(configFileName)) {
      unreadableFiles.push(configFileName);
      return { files: [] };
    }

    try {
      const configFile = ts.readConfigFile(configFileName, host.readFile.bind(host));
      if (configFile.error) {
        unreadableFiles.push(configFileName);
        return { files: [] };
      }

      const configDir = path.dirname(configFileName);
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        parseHost,
        configDir,
        undefined,
        configFileName
      );

      for (const diagnostic of parsedConfig.errors) {
        const file = diagnostic.file?.fileName ?? configFileName;
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        unreadableFiles.push(file);
        excludedFiles.set(normalizePath(file), `TSCONFIG_ERROR:${message}`);
      }

      const allFiles: string[] = parsedConfig.fileNames.map(f => normalizePath(f));

      // Follow project references recursively
      if (parsedConfig.projectReferences && parsedConfig.projectReferences.length > 0) {
        for (const ref of parsedConfig.projectReferences) {
          const refConfigPath = ts.resolveProjectReferencePath(ref);
          if (refConfigPath) {
            const subResolution = this.resolveConfigFileRecursive(
              refConfigPath,
              host,
              parseHost,
              visitedConfigs,
              excludedFiles,
              unsupportedFiles,
              unreadableFiles
            );
            allFiles.push(...subResolution.files);
          }
        }
      }

      return { files: allFiles, compilerOptions: parsedConfig.options as Record<string, unknown> };
    } catch (err: unknown) {
      unreadableFiles.push(configFileName);
      excludedFiles.set(normalizePath(configFileName), `TSCONFIG_READ_ERROR:${err instanceof Error ? err.message : String(err)}`);
      return { files: [] };
    }
  }

  private static scanDirectoryRecursive(
    dir: string,
    excludedFiles: Map<string, string>,
    unsupportedFiles: string[]
  ): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          excludedFiles.set(fullPath, `IGNORED_SYSTEM_DIRECTORY:${entry.name}`);
          continue;
        }
        results.push(...this.scanDirectoryRecursive(fullPath, excludedFiles, unsupportedFiles));
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.d.ts')) {
          results.push(fullPath);
        } else {
          unsupportedFiles.push(fullPath);
          excludedFiles.set(fullPath, 'NON_TYPESCRIPT_FILE');
        }
      }
    }
    return results;
  }
}
