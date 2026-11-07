import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Shared immutable cache for reusable TypeScript bundled library SourceFiles.
 *
 * TypeScript default lib files (e.g. lib.es5.d.ts, lib.dom.d.ts) are read-only
 * bundled files shipped with the TypeScript compiler. They depend strictly on the
 * canonical lib path and the target ScriptTarget.
 *
 * Caching them process-wide / adapter-wide across programs and snapshots eliminates
 * thousands of redundant AST allocations while strictly preserving parent/candidate
 * semantic isolation (only immutable bundled compiler libs are cached).
 */
export class SharedImmutableLibCache {
  private static instance: SharedImmutableLibCache | null = null;
  private readonly cache = new Map<string, ts.SourceFile>();

  static getInstance(): SharedImmutableLibCache {
    if (!SharedImmutableLibCache.instance) {
      SharedImmutableLibCache.instance = new SharedImmutableLibCache();
    }
    return SharedImmutableLibCache.instance;
  }

  static clear(): void {
    SharedImmutableLibCache.instance?.cache.clear();
  }

  static isQualifyingLibFile(filePath: string, libRoot: string): boolean {
    const canonicalPath = path.resolve(filePath).toLowerCase().replace(/\\/g, '/');
    const canonicalLibRoot = path.resolve(libRoot).toLowerCase().replace(/\\/g, '/');

    // Must be strictly inside the compiler's bundled libRoot directory
    if (!canonicalPath.startsWith(canonicalLibRoot + '/') && canonicalPath !== canonicalLibRoot) {
      return false;
    }

    // Must strictly be a standard bundled TypeScript lib definition file
    const fileName = path.basename(canonicalPath);
    return /^lib(\.[a-z0-9_\-]+)*\.d\.ts$/i.test(fileName);
  }

  private cacheKey(filePath: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
    const canonical = path.resolve(filePath).toLowerCase().replace(/\\/g, '/');
    if (typeof languageVersionOrOptions === 'object' && languageVersionOrOptions !== null) {
      const target = languageVersionOrOptions.languageVersion ?? ts.ScriptTarget.Latest;
      const jsDoc = (languageVersionOrOptions as any).jsDocParsingMode ?? 'default';
      const setParentNodes = Boolean((languageVersionOrOptions as any).setParentNodes);
      const impliedNodeFormat = (languageVersionOrOptions as any).impliedNodeFormat ?? 'default';
      return `${canonical}|target:${target}|jsdoc:${jsDoc}|parentNodes:${setParentNodes}|format:${impliedNodeFormat}`;
    }
    return `${canonical}|target:${languageVersionOrOptions}`;
  }

  get(filePath: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile | undefined {
    return this.cache.get(this.cacheKey(filePath, languageVersionOrOptions));
  }

  set(filePath: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions, sourceFile: ts.SourceFile): void {
    this.cache.set(this.cacheKey(filePath, languageVersionOrOptions), sourceFile);
  }

  has(filePath: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): boolean {
    return this.cache.has(this.cacheKey(filePath, languageVersionOrOptions));
  }

  get size(): number {
    return this.cache.size;
  }
}
