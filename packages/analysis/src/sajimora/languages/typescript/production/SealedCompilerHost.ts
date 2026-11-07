/**
 * @file SealedCompilerHost.ts
 * Sealed, in-memory TypeScript CompilerHost backed exclusively by GenericRepositorySnapshot.
 * 
 * Guarantees:
 * - Zero access to host filesystem (no fs leakage).
 * - Full TypeScript-native module resolution (paths, baseUrl, exports/imports, CJS/ESM).
 * - Records explicit ResolutionFact receipts for every resolved or unresolved module edge.
 */

import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import { GenericRepositorySnapshot, ResolutionFact } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptMonorepoResolver } from './TypeScriptMonorepoResolver';
import { compilerLibraries, COMPILER_LIBRARY_ROOT } from './TypeScriptCompilerLibraries';
import { canonicalRepositoryPath } from './CanonicalRepositoryPath';

interface SnapshotLookupIndex {
  readonly filesByPath: Map<string, string>;
  readonly directories: Set<string>;
}
const snapshotLookupIndexes = new WeakMap<GenericRepositorySnapshot, SnapshotLookupIndex>();

function snapshotLookupIndex(snapshot: GenericRepositorySnapshot): SnapshotLookupIndex {
  const existing = snapshotLookupIndexes.get(snapshot);
  if (existing) return existing;
  const filesByPath = new Map<string, string>();
  const directories = new Set<string>(['']);
  for (const file of snapshot.files) {
    const canonical = canonicalRepositoryPath(file.path, snapshot.rootIdentifier);
    if (!filesByPath.has(canonical)) filesByPath.set(canonical, file.path);
    const parts = canonical.split('/');
    for (let length = 1; length < parts.length; length++) {
      directories.add(parts.slice(0, length).join('/'));
    }
  }
  const index = { filesByPath, directories };
  snapshotLookupIndexes.set(snapshot, index);
  return index;
}

export class SealedCompilerHost implements ts.CompilerHost {
  private readonly filesByPath: Map<string, string>;
  private readonly directories: Set<string>;
  private readonly sourceFileCache = new Map<string, ts.SourceFile>();
  private readonly resolutionFacts: ResolutionFact[] = [];
  private resolutionCounter = 0;

  constructor(
    private readonly snapshot: GenericRepositorySnapshot,
    private readonly projectId: string,
    private readonly compilerOptions: ts.CompilerOptions
  ) {
    const index = snapshotLookupIndex(snapshot);
    this.filesByPath = index.filesByPath;
    this.directories = index.directories;
  }

  public getResolutionFacts(): readonly ResolutionFact[] {
    return this.resolutionFacts;
  }

  public getSourceFile(
    fileName: string,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
    onError?: (message: string) => void
  ): ts.SourceFile | undefined {
    const normalized = this.normalizePath(fileName);
    if (this.sourceFileCache.has(normalized)) {
      return this.sourceFileCache.get(normalized);
    }

    const content = this.readFile(normalized);
    if (content === undefined) {
      if (onError) onError(`File not found in sealed snapshot: ${fileName}`);
      return undefined;
    }

    const sourceFile = ts.createSourceFile(
      normalized,
      content,
      languageVersionOrOptions,
      true,
      this.getScriptKind(normalized)
    );

    this.sourceFileCache.set(normalized, sourceFile);
    return sourceFile;
  }

  public getDefaultLibFileName(options: ts.CompilerOptions): string {
    return `${COMPILER_LIBRARY_ROOT}/${ts.getDefaultLibFileName(options)}`;
  }

  public getDefaultLibLocation(): string { return COMPILER_LIBRARY_ROOT; }
  public getCompilerLibraryDigest(): string { return compilerLibraries().digest; }

  public writeFile(fileName: string, data: string): void {
    // In-memory sealed execution: output declarations or artifacts cached in memory
  }

  public getCurrentDirectory(): string {
    return '/';
  }

  public getDirectories(path: string): string[] {
    const normPath = this.normalizePath(path);
    const dirs = new Set<string>();
    const prefix = normPath ? `${normPath}/` : '';
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) continue;
      const remainder = directory.slice(prefix.length);
      if (remainder && !remainder.includes('/')) dirs.add(remainder);
    }
    return Array.from(dirs);
  }

  public directoryExists(directory: string): boolean {
    const root = this.normalizePath(directory);
    if (root === COMPILER_LIBRARY_ROOT) return true;
    return root !== '__ESCAPE_ROOT__' && this.directories.has(root);
  }

  /** Required by TypeScript when it replays referenced tsconfig files. */
  public readDirectory(
    rootDir: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number
  ): string[] {
    // Use the pinned compiler's glob semantics, including default exclusions.
    const matchFiles = (ts as unknown as { matchFiles: (
      root: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined,
      includes: readonly string[] | undefined, caseSensitive: boolean, cwd: string, depth: number | undefined,
      entries: (directory: string) => { files: string[]; directories: string[] }, realpath: (p: string) => string
    ) => string[] }).matchFiles;
    return matchFiles(rootDir, extensions, excludes, includes, true, '/', depth, directory => {
      const root = this.normalizePath(directory);
      const prefix = root ? `${root}/` : '';
      const files = new Set<string>(); const directories = new Set<string>();
      for (const file of this.snapshot.files) {
        const normalized = this.normalizePath(file.path);
        if (!normalized.startsWith(prefix)) continue;
        const rest = normalized.slice(prefix.length);
        if (rest.includes('/')) directories.add(rest.split('/')[0]); else files.add(rest);
      }
      return { files: [...files].sort(), directories: [...directories].sort() };
    }, p => p).map(p => this.normalizePath(p));
  }

  public getCanonicalFileName(fileName: string): string {
    return this.normalizePath(fileName);
  }

  public useCaseSensitiveFileNames(): boolean {
    return true;
  }

  public getNewLine(): string {
    return '\n';
  }

  public fileExists(fileName: string): boolean {
    const normalized = this.normalizePath(fileName);
    if (normalized === '__ESCAPE_ROOT__' || normalized.startsWith('__ESCAPE_ROOT__')) {
      return false;
    }
    if (normalized.startsWith(`${COMPILER_LIBRARY_ROOT}/`)) return compilerLibraries().files.has(normalized);
    // Strict case-sensitive matching against snapshot files
    return this.filesByPath.has(normalized);
  }

  public readFile(fileName: string): string | undefined {
    const normalized = this.normalizePath(fileName);
    if (normalized === '__ESCAPE_ROOT__' || normalized.startsWith('__ESCAPE_ROOT__')) {
      return undefined;
    }
    if (normalized.startsWith(`${COMPILER_LIBRARY_ROOT}/`)) return compilerLibraries().files.get(normalized);
    const original = this.filesByPath.get(normalized);
    return original === undefined ? undefined :
      this.snapshot.readTextFile(original) ?? this.snapshot.readTextFile(normalized);
  }

  public resolveModuleNameLiterals(
    moduleLiterals: readonly ts.StringLiteralLike[],
    containingFile: string,
    redirectedReference: ts.ResolvedProjectReference | undefined,
    options: ts.CompilerOptions,
    containingSourceFile: ts.SourceFile,
    reusedNames: readonly ts.StringLiteralLike[] | undefined
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    return moduleLiterals.map(literal => {
      const moduleName = literal.text;
      const resId = `res_${this.projectId}_${++this.resolutionCounter}`;

      // Check path traversal attempts (e.g. escaping snapshot root)
      const importerDirectory = containingFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const isPathTraversal = moduleName.startsWith('.') &&
        this.normalizePath(`${importerDirectory}/${moduleName}`) === '__ESCAPE_ROOT__';

      if (isPathTraversal) {
        this.resolutionFacts.push({
          resolutionId: resId,
          projectId: this.projectId,
          importerFile: containingFile,
          importSpecifier: moduleName,
          resolvedTargetFile: undefined,
          isExternal: false,
          isDynamic: false,
          resolutionChain: [containingFile],
          usageMode: 'value',
          resolverVersion: ts.version,
          failedLookupCandidates: [moduleName],
          consultedManifests: []
        });
        return { resolvedModule: undefined, failedLookupLocations: [moduleName] } as ts.ResolvedModuleWithFailedLookupLocations;
      }

      const resolution = ts.resolveModuleName(
        moduleName,
        containingFile,
        options,
        this,
        undefined,
        redirectedReference,
        ts.getModeForUsageLocation(containingSourceFile, literal, options)
      );

      const resolved = resolution.resolvedModule;
      const isExternal = !resolved || resolved.isExternalLibraryImport || false;
      const isDynamic = literal.text === '' || literal.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;

      // Determine usageMode: check if import is type-only
      let usageMode: 'type-only' | 'value' = 'value';
      const parent = literal.parent;
      if (parent) {
        if (ts.isImportDeclaration(parent) && parent.importClause?.isTypeOnly) {
          usageMode = 'type-only';
        } else if (ts.isExportDeclaration(parent) && parent.isTypeOnly) {
          usageMode = 'type-only';
        }
      }

      // Verify symlink safety (fail-closed if resolved file escapes sealed repository root)
      if (resolved?.resolvedFileName && !TypeScriptMonorepoResolver.verifySymlinkSafe(resolved.resolvedFileName, '/')) {
        this.resolutionFacts.push({
          resolutionId: resId,
          projectId: this.projectId,
          importerFile: containingFile,
          importSpecifier: moduleName,
          resolvedTargetFile: undefined,
          isExternal: false,
          isDynamic: false,
          resolutionChain: [containingFile],
          usageMode,
          resolverVersion: ts.version,
          failedLookupCandidates: [moduleName, resolved.resolvedFileName],
          consultedManifests: []
        });
        return { resolvedModule: undefined, failedLookupLocations: [moduleName] } as ts.ResolvedModuleWithFailedLookupLocations;
      }

      // Compute hash of resolved target file if present
      let selectedFileHash: string | undefined;
      if (resolved?.resolvedFileName) {
        const text = this.readFile(resolved.resolvedFileName);
        if (text !== undefined) {
          selectedFileHash = crypto.createHash('sha256').update(text).digest('hex');
        }
      }

      const failedLookupCandidates: string[] = (resolution as any).failedLookupLocations
        ? Array.from((resolution as any).failedLookupLocations)
        : [];

      const effectiveCompilerOptions = {
        strict: Boolean(options.strict),
        module: options.module !== undefined ? ts.ModuleKind[options.module] : undefined,
        moduleResolution: options.moduleResolution !== undefined ? ts.ModuleResolutionKind[options.moduleResolution] : undefined,
        target: options.target !== undefined ? ts.ScriptTarget[options.target] : undefined,
        baseUrl: options.baseUrl
      };

      const consultedManifests = this.snapshot.files
        .filter(f => f.path.endsWith('tsconfig.json') || f.path.endsWith('package.json'))
        .map(f => f.path);

      this.resolutionFacts.push({
        resolutionId: resId,
        projectId: this.projectId,
        importerFile: containingFile,
        importSpecifier: moduleName,
        resolvedTargetFile: resolved ? resolved.resolvedFileName : undefined,
        isExternal,
        isDynamic,
        resolutionChain: resolved ? [containingFile, resolved.resolvedFileName] : [containingFile],
        usageMode,
        resolverVersion: ts.version,
        effectiveCompilerOptions,
        failedLookupCandidates,
        successfulLookupCandidate: resolved?.resolvedFileName,
        selectedFileHash,
        consultedManifests
      });

      return resolution;
    });
  }

  private normalizePath(p: string): string {
    return canonicalRepositoryPath(p, this.snapshot.rootIdentifier);
  }

  private globMatches(path: string, pattern: string): boolean {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.?\//, '');
    const wildcard = normalizedPattern.indexOf('*');
    if (wildcard >= 0 && path.startsWith(normalizedPattern.slice(0, wildcard))) return true;
    const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(path);
  }

  private getScriptKind(fileName: string): ts.ScriptKind {
    if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
    if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (fileName.endsWith('.js')) return ts.ScriptKind.JS;
    if (fileName.endsWith('.json')) return ts.ScriptKind.JSON;
    return ts.ScriptKind.Unknown;
  }

}
