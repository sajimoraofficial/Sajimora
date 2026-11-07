/**
 * SAJIMORA — UNIVERSAL REPOSITORY IGNORE RESOLVER
 *
 * VCS-agnostic ignore definitions supporting polyglot defaults.
 */

export const UNIVERSAL_POLYGLOT_SKIP_DIRS: ReadonlySet<string> = new Set([
  // JavaScript / TypeScript / Node
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'out',
  'coverage',

  // Python
  '.venv',
  'venv',
  'env',
  '.env_venv',
  '__pycache__',
  '.pytest_cache',
  'site-packages',

  // Go / PHP
  'vendor',

  // Java / Kotlin / Gradle / Maven
  'target',
  '.gradle',
  '.mvn',

  // Version Control Metadata
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'CVS',

  // IDE & OS Metadata
  '.idea',
  '.vscode',
  '.DS_Store',
  'Thumbs.db',

  // Archives & Temporary
  'archive',
  '.archive'
]);

export const SKIP_DIRS: Set<string> = new Set(UNIVERSAL_POLYGLOT_SKIP_DIRS);

export class IgnoreResolver {
  private static instance: IgnoreResolver;

  public static getInstance(): IgnoreResolver {
    if (!IgnoreResolver.instance) {
      IgnoreResolver.instance = new IgnoreResolver();
    }
    return IgnoreResolver.instance;
  }

  public isDirectorySkipped(dirName: string): boolean {
    const lower = dirName.toLowerCase();
    return UNIVERSAL_POLYGLOT_SKIP_DIRS.has(dirName) || UNIVERSAL_POLYGLOT_SKIP_DIRS.has(lower);
  }
}
