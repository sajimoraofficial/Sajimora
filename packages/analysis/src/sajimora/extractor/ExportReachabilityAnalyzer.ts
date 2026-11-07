import * as path from 'node:path';
import * as ts from 'typescript';
import { RepositoryAnalysisUniverse, SymbolRef, getSymbolName } from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';

const slash = (p: string) => p.replace(/\\/g, '/');

export class ExportReachabilityAnalyzer {
  /**
   * Evaluates whether a target symbol's declaration file is 100% self-contained with no other
   * source files in the project importing or referencing it.
   *
   * Authority Invariant:
   * This class NEVER emits verdicts (PRESERVED, VIOLATED, NOT_APPLICABLE, UNKNOWN).
   * It only returns a narrowed candidate SourceFile array when reachability is formally proven self-contained,
   * or undefined when fallback to full candidate scope is required.
   */
  static getSelfContainedCandidateScope(
    context: AnalysisContext,
    targetSymbol: SymbolRef,
    universe: RepositoryAnalysisUniverse
  ): ts.SourceFile[] | undefined {
    try {
      const targetFilePath = targetSymbol.declarationLocation?.filePath;
      if (!targetFilePath) return undefined;

      const normTargetFile = slash(targetFilePath);
      const allFiles = context.getUniverseSourceFiles();
      const targetSf = allFiles.find(sf => {
        const norm = slash(sf.fileName);
        return norm === normTargetFile || norm.endsWith('/' + normTargetFile) || normTargetFile.endsWith('/' + norm);
      });

      if (!targetSf) return undefined;

      const targetSfNorm = slash(targetSf.fileName);

      // Check if any OTHER source file in the project imports or references targetSf
      for (const sf of allFiles) {
        const sfNorm = slash(sf.fileName);
        if (sfNorm === targetSfNorm) continue;

        // Check if sf imports targetSf
        try {
          const pre = ts.preProcessFile(sf.text, true, true);
          const sfDir = path.dirname(sf.fileName);

          for (const imp of [...pre.importedFiles, ...pre.referencedFiles]) {
            if (!imp.fileName) continue;
            if (imp.fileName.startsWith('.')) {
              const abs = slash(path.normalize(path.join(sfDir, imp.fileName)));
              if (abs === targetSfNorm || abs.startsWith(targetSfNorm.replace(/\.tsx?$/, ''))) {
                // Another file imports target file -> NOT self-contained!
                return undefined;
              }
            } else if (imp.fileName.includes(path.basename(targetSfNorm, path.extname(targetSfNorm)))) {
              // Ambiguous package/path-alias import -> NOT self-contained!
              return undefined;
            }
          }

          // Check for ambient / wildcard exports in other files
          for (const stmt of sf.statements) {
            if (ts.isExportDeclaration(stmt) && !stmt.exportClause) {
              // export * -> CANNOT PROVE self-contained
              return undefined;
            }
            if (ts.isModuleDeclaration(stmt) && ((stmt.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(stmt.name))) {
              // declare global -> CANNOT PROVE self-contained
              return undefined;
            }
          }
        } catch {
          return undefined;
        }
      }

      // If no other source file in the project imports or references targetSf,
      // then targetSf is formally proven self-contained!
      return [targetSf];
    } catch {
      return undefined;
    }
  }
}
