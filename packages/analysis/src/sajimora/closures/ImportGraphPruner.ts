import * as path from 'node:path';
import * as ts from 'typescript';
import { RepositoryAnalysisUniverse } from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';

const slash = (p: string) => p.replace(/\\/g, '/');

const normalizeRel = (file: string): string => {
  const norm = slash(file);
  const snapMatch = norm.match(/sajimora-snapshot-[^/]+\/(.*)$/);
  if (snapMatch) return snapMatch[1];
  return norm;
};

export class ImportGraphPruner {
  /**
   * Computes a conservative set of SourceFiles that could potentially reference
   * or contribute to the closure of symbols declared in targetModulePath.
   *
   * Fallback Invariant:
   * If any file contains ambient global augmentations (`declare global`), wildcard re-exports (`export *`),
   * unresolvable imports, or if graph construction fails for any reason,
   * those files are unprunable and retained.
   */
  static getCandidateSourceFiles(
    context: AnalysisContext,
    targetModulePath: string,
    universe: RepositoryAnalysisUniverse
  ): ts.SourceFile[] {
    const allFiles = context.getUniverseSourceFiles();
    try {
      const normTarget = normalizeRel(targetModulePath);
      const fileMap = new Map<string, ts.SourceFile>();
      const importersMap = new Map<string, Set<string>>(); // imported -> set of files that import it
      const unprunableFiles = new Set<string>();

      for (const sf of allFiles) {
        const sfNorm = normalizeRel(sf.fileName);
        fileMap.set(sfNorm, sf);

        let hasAmbientOrWildcard = false;

        // Check AST for ambient declarations or wildcard exports
        for (const stmt of sf.statements) {
          if (ts.isExportDeclaration(stmt) && !stmt.exportClause && stmt.moduleSpecifier) {
            // export * from ... -> wildcard re-export cannot be safely pruned
            hasAmbientOrWildcard = true;
            break;
          }
          if (ts.isModuleDeclaration(stmt) && ((stmt.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(stmt.name))) {
            // declare global or declare module -> ambient scope cannot be safely pruned
            hasAmbientOrWildcard = true;
            break;
          }
        }

        if (hasAmbientOrWildcard) {
          unprunableFiles.add(sfNorm);
        }

        // Fast import pre-processing via ts.preProcessFile
        try {
          const pre = ts.preProcessFile(sf.text, true, true);
          const sfDir = path.dirname(sf.fileName);

          for (const imp of [...pre.importedFiles, ...pre.referencedFiles]) {
            const spec = imp.fileName;
            if (!spec) continue;

            let resolved: string | null = null;
            if (spec.startsWith('.')) {
              const abs = normalizeRel(path.normalize(path.join(sfDir, spec)));
              for (const ext of ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts']) {
                const probe = abs + ext;
                if (fileMap.has(probe)) {
                  resolved = probe;
                  break;
                }
              }
            }

            if (resolved) {
              if (!importersMap.has(resolved)) {
                importersMap.set(resolved, new Set());
              }
              importersMap.get(resolved)!.add(sfNorm);
            } else if (!spec.startsWith('.')) {
              // Package import or tsconfig path alias — cannot prove exclusion, retain file conservatively
              unprunableFiles.add(sfNorm);
            }
          }
        } catch {
          unprunableFiles.add(sfNorm);
        }
      }

      // Compute transitive closure of importers for targetModulePath
      const candidateNorms = new Set<string>();

      // Target declaration file itself is always included
      candidateNorms.add(normTarget);
      for (const unprunable of unprunableFiles) {
        candidateNorms.add(unprunable);
      }

      const queue = [normTarget];
      const visited = new Set<string>([normTarget]);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const importers = importersMap.get(curr);
        if (importers) {
          for (const importer of importers) {
            candidateNorms.add(importer);
            if (!visited.has(importer)) {
              visited.add(importer);
              queue.push(importer);
            }
          }
        }
      }

      const result: ts.SourceFile[] = [];
      for (const sf of allFiles) {
        const norm = normalizeRel(sf.fileName);
        if (candidateNorms.has(norm) || unprunableFiles.has(norm)) {
          result.push(sf);
        }
      }

      return result.length > 0 ? result : allFiles;
    } catch {
      // Conservative fallback: return full source files list on any error
      return allFiles;
    }
  }
}
