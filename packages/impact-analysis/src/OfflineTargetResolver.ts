/**
 * SAJIMORA — OFFLINE TARGET RESOLVER
 *
 * Deterministically resolves extracted targets into FILE, SYMBOL, or PACKAGE targets.
 * Strict Zero-Trust contract: Surfaces AMBIGUOUS if multiple definitions or files match;
 * never silently resolves ambiguous symbols or paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TargetResolution, TargetKind } from './types';
import { getCanonicalRepoRoot, resolveCanonicalRepositoryPath } from './pathResolver';
import { IgnoreResolver, SKIP_DIRS } from './ignoreResolver';

export interface TargetResolverOptions {
  repoRoot: string;
}

export class OfflineTargetResolver {
  private repoRoot: string;
  private allRepoFiles: string[] = [];
  private symbolDeclarationCache: Map<string, string[]> = new Map();

  constructor(options: TargetResolverOptions) {
    this.repoRoot = getCanonicalRepoRoot(options.repoRoot);
    this.indexRepositoryFiles();
  }

  /**
   * Scans scope directories and indexes all candidate source files.
   */
  private indexRepositoryFiles(): void {
    const visitedDirs = new Set<string>();
    const files: string[] = [];

    const walk = (currentDir: string) => {
      const canonical = path.resolve(currentDir);
      if (visitedDirs.has(canonical)) return;
      visitedDirs.add(canonical);

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          const base = ent.name;
          if (IgnoreResolver.getInstance().isDirectorySkipped(base) || SKIP_DIRS.has(base.toLowerCase())) {
            continue;
          }
          walk(full);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (['.ts', '.tsx', '.js', '.jsx', '.prisma', '.json', '.java', '.go', '.rs', '.py'].includes(ext)) {
            const rel = path.relative(this.repoRoot, full).replace(/\\/g, '/');
            files.push(rel);
          }
        }
      }
    };

    walk(this.repoRoot);
    this.allRepoFiles = files.sort();
  }

  /**
   * Scans for a declared symbol across repository source files.
   * Recognizes TypeScript, Java, Go, Rust, and Python declaration syntax.
   */
  public readonly unreadableFiles: string[] = [];

  private findFilesDeclaringSymbol(symbolName: string): { matches: string[]; hadReadErrors: boolean } {
    if (this.symbolDeclarationCache.has(symbolName)) {
      return { matches: this.symbolDeclarationCache.get(symbolName)!, hadReadErrors: false };
    }

    const matches: string[] = [];
    let hadReadErrors = false;
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const tsRegex = new RegExp(`\\bexport\\s+(?:(?:default\\s+)?(?:class|function|interface|type|enum|const|let|var)|abstract\\s+class)\\s+${escaped}\\b`);
    const javaRegex = new RegExp(`(?:public|protected|private|abstract|final|static|\\s)*\\b(class|interface|enum|record)\\s+${escaped}\\b`);
    const goRegex = new RegExp(`(?:type\\s+${escaped}\\s+(?:struct|interface)|func\\s+(?:\\([^)]*\\)\\s+)?${escaped}\\b)`);
    const rustRegex = new RegExp(`(?:pub\\s+)?(?:struct|trait|enum|fn)\\s+${escaped}\\b`);
    const pyRegex = new RegExp(`(?:class|def)\\s+${escaped}\\b`);

    for (const relPath of this.allRepoFiles) {
      const fullPath = path.join(this.repoRoot, relPath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        hadReadErrors = true;
        if (!this.unreadableFiles.includes(relPath)) {
          this.unreadableFiles.push(relPath);
        }
        continue;
      }
      const ext = path.extname(relPath).toLowerCase();

      let isMatch = false;
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        isMatch = tsRegex.test(content);
      } else if (ext === '.java') {
        isMatch = javaRegex.test(content);
      } else if (ext === '.go') {
        isMatch = goRegex.test(content);
      } else if (ext === '.rs') {
        isMatch = rustRegex.test(content);
      } else if (ext === '.py') {
        isMatch = pyRegex.test(content);
      }

      if (isMatch) {
        matches.push(relPath);
      }
    }

    if (!hadReadErrors) {
      this.symbolDeclarationCache.set(symbolName, matches);
    }
    return { matches, hadReadErrors };
  }

  /**
   * Resolves a raw candidate query token against the repository.
   */
  public resolveTarget(candidate?: string): TargetResolution {
    if (!candidate || candidate.trim().length === 0) {
      return {
        status: 'NOT_FOUND',
        query: '',
        closestMatches: this.allRepoFiles.slice(0, 5)
      };
    }

    const cleaned = candidate.trim().replace(/^['"]|['"]$/g, '');

    // 1. Direct File Path Resolution
    const directRes = resolveCanonicalRepositoryPath(cleaned, this.repoRoot);
    if (directRes.accepted && fs.existsSync(directRes.resolvedPath)) {
      return {
        status: 'RESOLVED',
        targetKind: 'FILE',
        node: directRes.normalizedRelativePath,
        definingFile: directRes.normalizedRelativePath
      };
    }

    // 2. Basename matching
    const cleanBase = path.basename(cleaned).toLowerCase();
    const cleanExt = path.extname(cleaned).toLowerCase();

    // Prefer exact filename (with extension) matches first when extension is provided
    let baseNameMatches: string[] = [];
    if (cleanExt) {
      baseNameMatches = this.allRepoFiles.filter(f => path.basename(f).toLowerCase() === cleanBase);
    }
    // If no exact matches or no extension specified, match across extensions by stem
    if (baseNameMatches.length === 0) {
      const cleanStem = path.basename(cleaned, cleanExt).toLowerCase();
      baseNameMatches = this.allRepoFiles.filter(f =>
        path.basename(f, path.extname(f)).toLowerCase() === cleanStem
      );
    }

    if (baseNameMatches.length === 1) {
      return {
        status: 'RESOLVED',
        targetKind: 'FILE',
        node: baseNameMatches[0],
        definingFile: baseNameMatches[0]
      };
    } else if (baseNameMatches.length > 1) {
      return {
        status: 'AMBIGUOUS',
        targetKind: 'FILE',
        query: cleaned,
        candidates: baseNameMatches.map(p => ({
          path: p,
          reason: `Basename match '${path.basename(p)}'`
        }))
      };
    }

    // 3. Package Identifier Resolution (e.g. "@sajimora/core" or "packages/core")
    if (cleaned.startsWith('@') || cleaned.startsWith('packages/')) {
      const pkgSub = cleaned.startsWith('@') ? cleaned.split('/')[1] : cleaned.replace(/^packages\//, '');
      const packageFiles = this.allRepoFiles.filter(f => f.startsWith(`packages/${pkgSub}`));
      if (packageFiles.length > 0) {
        // Find package entry point
        const entry = packageFiles.find(f => f.endsWith('src/index.ts') || f.endsWith('index.ts')) || packageFiles[0];
        return {
          status: 'RESOLVED',
          targetKind: 'PACKAGE',
          node: entry,
          packageName: cleaned,
          definingFile: entry
        };
      }
    }

    // 4. Symbol Resolution (Classes, Interfaces, Functions, Enums, Types)
    const { matches: symbolMatches, hadReadErrors } = this.findFilesDeclaringSymbol(cleaned);
    if (symbolMatches.length === 1 && !hadReadErrors) {
      return {
        status: 'RESOLVED',
        targetKind: 'SYMBOL',
        node: symbolMatches[0],
        symbol: cleaned,
        definingFile: symbolMatches[0]
      };
    } else if (symbolMatches.length > 1 || (symbolMatches.length === 1 && hadReadErrors)) {
      return {
        status: 'AMBIGUOUS',
        targetKind: 'SYMBOL',
        query: cleaned,
        candidates: symbolMatches.map(p => ({
          path: p,
          symbol: cleaned,
          reason: `Exported declaration of '${cleaned}' found in ${p}`
        })),
        ...(hadReadErrors ? {
          blockers: [{
            code: 'UNREADABLE_FILES_DURING_RESOLUTION',
            message: `Declaration match found, but ${this.unreadableFiles.length} file(s) were unreadable; ambiguity cannot be disproven.`,
            files: [...this.unreadableFiles]
          }]
        } : {})
      };
    }

    // 5. Partial / Closest Fallback Search
    const partials = this.allRepoFiles.filter(f => f.toLowerCase().includes(cleaned.toLowerCase())).slice(0, 5);
    return {
      status: 'NOT_FOUND',
      query: cleaned,
      closestMatches: partials,
      ...(hadReadErrors ? {
        blockers: [{
          code: 'UNREADABLE_FILES_DURING_RESOLUTION',
          message: `Cannot determine if symbol '${cleaned}' exists because ${this.unreadableFiles.length} file(s) could not be read.`,
          files: [...this.unreadableFiles]
        }]
      } : {})
    };
  }

  public getAllFiles(): string[] {
    return [...this.allRepoFiles];
  }
}
