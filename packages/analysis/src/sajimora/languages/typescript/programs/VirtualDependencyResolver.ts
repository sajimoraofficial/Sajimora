import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { DependencyLookupRecorder } from '../../../indexed/DependencyLookupReceipt';

export interface VirtualDependencyResolverOptions {
  snapshotRoot: string;
  libRoot: string;
  dependencyRoot?: string;
  dependencyLookupRecorder?: DependencyLookupRecorder;
}

const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * Universal VirtualDependencyResolver for TypeScript Program Construction.
 * 
 * Provides unified, repository-agnostic dependency virtualization for both compilerHost and parseHost.
 * - Virtualizes workspace and root node_modules from temporary snapshots to the physical repository.
 * - Allows internal workspace package symlinks while enforcing a strict realpath sandbox boundary.
 * - Prevents malicious or accidental symlinks from escaping the physical repository root.
 */
export class VirtualDependencyResolver {
  readonly snapshotRoot: string;
  readonly libRoot: string;
  readonly dependencyRoot?: string;
  readonly realRepoRoot?: string;
  private readonly dependencyLookupRecorder?: DependencyLookupRecorder;

  private readonly isWindows = process.platform === 'win32';

  constructor(options: VirtualDependencyResolverOptions) {
    this.snapshotRoot = path.resolve(options.snapshotRoot);
    this.libRoot = path.resolve(options.libRoot);
    this.dependencyRoot = options.dependencyRoot ? path.resolve(options.dependencyRoot) : undefined;
    this.dependencyLookupRecorder = options.dependencyLookupRecorder;

    if (this.dependencyRoot) {
      this.realRepoRoot = path.basename(this.dependencyRoot) === 'node_modules'
        ? path.dirname(this.dependencyRoot)
        : this.dependencyRoot;
    }
  }

  /**
   * Checks whether a target file or directory is inside the given base directory.
   */
  inside(target: string, base: string): boolean {
    const resolvedTarget = path.resolve(target);
    const resolvedBase = path.resolve(base);

    if (this.isWindows) {
      const t = resolvedTarget.toLowerCase();
      const b = resolvedBase.toLowerCase();
      return t === b || t.startsWith(b + path.sep);
    }
    return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
  }

  private readonly mappedPathCache = new Map<string, string>();
  private readonly allowedCache = new Map<string, boolean>();
  private readonly fileExistsCache = new Map<string, boolean>();
  private readonly directoryExistsCache = new Map<string, boolean>();

  /**
   * Maps a virtual path within the snapshot to its physical location.
   * If the path queries `node_modules` (at the root or nested in subpackages),
   * it maps to the corresponding relative path in the real repository.
   */
  mapPath(filePath: string): string {
    const cached = this.mappedPathCache.get(filePath);
    if (cached !== undefined) return cached;

    const resolved = path.resolve(filePath);
    let mapped = resolved;

    if (this.realRepoRoot && this.inside(resolved, this.snapshotRoot)) {
      const rel = path.relative(this.snapshotRoot, resolved);
      const segments = rel.split(/[\\/]/);
      if (segments.includes('node_modules')) {
        mapped = path.join(this.realRepoRoot, rel);
      }
    }

    if (this.dependencyLookupRecorder) mapped = this.dependencyLookupRecorder.map(mapped);
    this.mappedPathCache.set(filePath, mapped);
    return mapped;
  }

  /**
   * Enforces strict sandbox boundaries.
   * A path is allowed if:
   * 1. It is inside snapshotRoot, libRoot, or realRepoRoot.
   * 2. CRITICAL SAFETY INVARIANT: If it resolves via symlink, the physical realpath
   *    MUST ALSO reside strictly inside realRepoRoot, libRoot, or snapshotRoot.
   *    Symlinks escaping realRepoRoot are strictly blocked.
   */
  isAllowed(filePath: string): boolean {
    const cached = this.allowedCache.get(filePath);
    if (cached !== undefined) return cached;

    const allowed = this.computeIsAllowed(filePath);
    this.allowedCache.set(filePath, allowed);
    return allowed;
  }

  private computeIsAllowed(filePath: string): boolean {
    const mapped = this.mapPath(filePath);

    const mappedInside =
      this.inside(mapped, this.snapshotRoot) ||
      this.inside(mapped, this.libRoot) ||
      Boolean(this.realRepoRoot && this.inside(mapped, this.realRepoRoot));

    if (!mappedInside) {
      return false;
    }

    // Hard Safety Boundary: Inspect realpath to prevent symlink sandbox escapes
    try {
      if (fs.existsSync(mapped)) {
        const real = fs.realpathSync(mapped);
        const realInside =
          this.inside(real, this.snapshotRoot) ||
          this.inside(real, this.libRoot) ||
          Boolean(this.realRepoRoot && this.inside(real, this.realRepoRoot));

        if (!realInside) {
          // Blocked: symlink points outside allowable repository and toolchain boundaries
          return false;
        }
      }
    } catch {
      // If realpath resolution fails (e.g. broken symlink or missing path), fall through
    }

    return true;
  }

  /**
   * Determines provenance for external declarations and standard libraries.
   */
  recordProvenance(filePath: string, provenance: Map<string, string>): void {
    const mapped = this.mapPath(filePath);

    if (this.inside(mapped, this.libRoot)) {
      provenance.set(`<typescript-lib>/${slash(path.relative(this.libRoot, mapped))}`, 'TYPESCRIPT_BUNDLED_LIB');
    } else if (this.dependencyRoot && this.inside(mapped, this.dependencyRoot)) {
      provenance.set(`<dependency-store>/${slash(path.relative(this.dependencyRoot, mapped))}`, 'EXTERNAL_DECLARATION');
    } else if (this.realRepoRoot && this.inside(mapped, this.realRepoRoot)) {
      const nodeModules = path.join(this.realRepoRoot, 'node_modules');
      const base = this.inside(mapped, nodeModules) ? nodeModules : this.realRepoRoot;
      provenance.set(`<dependency-store>/${slash(path.relative(base, mapped))}`, 'EXTERNAL_DECLARATION');
    }
  }

  // Compiler and parse host delegation methods

  fileExists(filePath: string): boolean {
    const cached = this.fileExistsCache.get(filePath);
    if (cached !== undefined) return cached;

    if (!this.isAllowed(filePath)) {
      this.fileExistsCache.set(filePath, false);
      return false;
    }
    const physical = this.mapPath(filePath);
    const raw = this.rawDependencyPath(filePath);
    const exists = this.dependencyLookupRecorder
      ? this.dependencyLookupRecorder.observe('FILE_EXISTS', raw, [], mapped => ts.sys.fileExists(mapped))
      : ts.sys.fileExists(physical);
    this.fileExistsCache.set(filePath, exists);
    return exists;
  }

  readFile(filePath: string): string | undefined {
    if (!this.isAllowed(filePath)) return undefined;
    const physical = this.mapPath(filePath);
    return this.dependencyLookupRecorder
      ? this.dependencyLookupRecorder.observe('READ_FILE', this.rawDependencyPath(filePath), [], mapped => ts.sys.readFile(mapped))
      : ts.sys.readFile(physical);
  }

  directoryExists(dirPath: string): boolean {
    const cached = this.directoryExistsCache.get(dirPath);
    if (cached !== undefined) return cached;

    if (!this.isAllowed(dirPath)) {
      this.directoryExistsCache.set(dirPath, false);
      return false;
    }
    const physical = this.mapPath(dirPath);
    const exists = this.dependencyLookupRecorder
      ? this.dependencyLookupRecorder.observe('DIRECTORY_EXISTS', this.rawDependencyPath(dirPath), [],
        mapped => Boolean(ts.sys.directoryExists(mapped)))
      : Boolean(ts.sys.directoryExists(physical));
    this.directoryExistsCache.set(dirPath, exists);
    return exists;
  }

  getDirectories(dirPath: string): string[] {
    if (!this.isAllowed(dirPath)) return [];
    const physical = this.mapPath(dirPath);
    return this.dependencyLookupRecorder
      ? this.dependencyLookupRecorder.observe('GET_DIRECTORIES', this.rawDependencyPath(dirPath), [],
        mapped => ts.sys.getDirectories(mapped))
      : ts.sys.getDirectories(physical);
  }

  readDirectory(
    dirPath: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number
  ): string[] {
    if (!this.isAllowed(dirPath)) return [];
    const physical = this.mapPath(dirPath);
    return this.dependencyLookupRecorder
      ? this.dependencyLookupRecorder.observe('READ_DIRECTORY', this.rawDependencyPath(dirPath),
        [extensions ?? null, exclude ?? null, include ?? null, depth ?? null],
        mapped => ts.sys.readDirectory(mapped, extensions, exclude, include, depth))
      : ts.sys.readDirectory(physical, extensions, exclude, include, depth);
  }

  private rawDependencyPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (this.realRepoRoot && this.inside(resolved, this.snapshotRoot)) {
      const rel = path.relative(this.snapshotRoot, resolved);
      if (rel.split(/[\\/]/).includes('node_modules')) return path.join(this.realRepoRoot, rel);
    }
    return resolved;
  }

  /**
   * Creates a ts.ParseConfigHost for tsconfig parsing that consumes this resolver.
   */
  createParseConfigHost(): ts.ParseConfigHost {
    return {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: f => this.fileExists(f),
      readFile: f => this.readFile(f),
      readDirectory: (dir, ext, exclude, include, depth) => this.readDirectory(dir, ext, exclude, include, depth)
    };
  }
}
