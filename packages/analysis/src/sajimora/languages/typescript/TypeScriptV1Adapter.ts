import * as ts from 'typescript';
import * as path from 'path';
import {
  AdapterAnalysisInput, AdapterAnalysisOutput, AdapterDetectionInput, AdapterSupport,
  LanguageAnalysisAdapter, LanguageAdapterDescriptor, ToolchainIdentity,
  RepositoryAnalysisUniverse, normalizePath
} from '@sajimora/core';
import { PipelineB } from '../../pipelines/PipelineB';
import { AnalysisContext } from '../../context/AnalysisContext';

import { LiveProgramSemanticProvider } from '../../compatibility/LiveProgramSemanticProvider';
import { TypeScriptTypeIRExtractor } from './ir/TypeScriptTypeIRExtractor';

export class TypeScriptV1Adapter implements LanguageAnalysisAdapter {
  readonly descriptor: LanguageAdapterDescriptor = {
    id: 'typescript-v1', version: '1.0.0',
    capabilities: [
      'DECLARATION_DIFF', 'VALUE_REFERENCE_DISCOVERY', 'TYPE_REFERENCE_DISCOVERY',
      'RE_EXPORT_DISCOVERY', 'INHERITANCE_DISCOVERY', 'OVERRIDE_DISCOVERY',
      'IMPLEMENTATION_DISCOVERY', 'SOURCE_COMPATIBILITY'
    ]
  };

  canAnalyze(input: AdapterDetectionInput): AdapterSupport {
    const evidence = [] as AdapterSupport['evidence'];
    if (input.trackedFiles.includes('tsconfig.json')) evidence.push({ kind: 'CONFIGURATION', value: 'tsconfig.json' });
    const tsCount = input.trackedFiles.filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts')).length;
    if (tsCount) evidence.push({ kind: 'SOURCE_EXTENSION', value: `${tsCount} tracked TypeScript source file(s)` });
    const packageText = input.readTextFile('package.json');
    if (packageText) {
      try {
        const pkg = JSON.parse(packageText);
        const declared = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
        if (typeof declared === 'string') evidence.push({ kind: 'PACKAGE_METADATA', value: `typescript:${declared}` });
      } catch { /* malformed package metadata is not selection evidence */ }
    }
    if (!evidence.length) return { status: 'UNSUPPORTED', evidence, unsupportedBoundary: 'No tracked TypeScript configuration or source files.' };
    return { status: 'SUPPORTED', evidence };
  }

  analyze(input: AdapterAnalysisInput & { dualPrograms?: any; crossVersionIdentity?: any; isPhase4Mode?: boolean }): AdapterAnalysisOutput {
    const pipeline = new PipelineB();
    const dual = (input as any).dualPrograms;
    const isPhase4Mode = (input as any).isPhase4Mode ?? (dual !== undefined || (input as any).crossVersionIdentity !== undefined);

    const findProgram = (build: any, targetFilePath?: string) => {
      if (!build) return undefined;
      if (targetFilePath && Array.isArray(build.projects) && build.projects.length > 0) {
        let bestProgram: any = undefined;
        let bestScore = 0;
        for (const p of build.projects) {
          for (const sf of p.program.getSourceFiles()) {
            const score = TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, targetFilePath);
            if (score > bestScore) {
              bestScore = score;
              bestProgram = p.program;
            }
          }
        }
        if (bestProgram && bestScore > 0) {
          return bestProgram;
        }
      }
      return build.program ?? build.projects?.[0]?.program;
    };

    const buildRepositoryUniverse = (build: any, prog: any): RepositoryAnalysisUniverse | undefined => {
      if (!build && !prog) return undefined;
      const snapUniverse = build?.universe;
      if (snapUniverse?.discoveredFileSet instanceof Set && snapUniverse?.rootPath) {
        return snapUniverse as RepositoryAnalysisUniverse;
      }

      const sourceFiles = prog ? prog.getSourceFiles().filter((sf: any) => !prog.isSourceFileDefaultLibrary(sf)) : [];
      const discoveredFiles: string[] = [];
      const discoveredFileSet = new Set<string>();

      for (const sf of sourceFiles) {
        const raw = sf.fileName.replace(/\\/g, '/');
        const norm = normalizePath(sf.fileName);
        discoveredFiles.push(raw);
        discoveredFileSet.add(raw);
        discoveredFileSet.add(norm);
        discoveredFileSet.add(norm.toLowerCase());
      }

      if (Array.isArray(snapUniverse?.includedFiles)) {
        for (const inc of snapUniverse.includedFiles) {
          discoveredFiles.push(inc);
          discoveredFileSet.add(inc);
          discoveredFileSet.add(normalizePath(inc));
          discoveredFileSet.add(normalizePath(inc).toLowerCase());
        }
      }

      let rootPath = '';
      if (Array.isArray(snapUniverse?.includedFiles) && snapUniverse.includedFiles.length > 0) {
        for (const sf of sourceFiles) {
          const sNorm = sf.fileName.replace(/\\/g, '/');
          for (const rel of snapUniverse.includedFiles) {
            if (sNorm.endsWith('/' + rel)) {
              rootPath = sNorm.slice(0, -(rel.length + 1));
              break;
            }
          }
          if (rootPath) break;
        }
      }
      if (!rootPath && input.snapshotRoot) {
        rootPath = input.snapshotRoot.replace(/\\/g, '/');
      }
      if (!rootPath && build?.projects?.[0]?.identity?.configFile) {
        const cfg = build.projects[0].identity.configFile.replace(/\\/g, '/');
        if (path.isAbsolute(cfg)) {
          rootPath = path.dirname(cfg).replace(/\\/g, '/');
        }
      }
      if (!rootPath && discoveredFiles.length > 0) {
        rootPath = path.dirname(discoveredFiles[0]).replace(/\\/g, '/');
      }

      const parseFailures = new Map<string, string>();

      const excludedFiles = new Map<string, string>();
      if (Array.isArray(snapUniverse?.excludedFiles)) {
        for (const ef of snapUniverse.excludedFiles) {
          if (ef.file) {
            excludedFiles.set(ef.file.replace(/\\/g, '/'), ef.reason ?? 'EXCLUDED');
          }
        }
      }

      return {
        rootPath,
        discoveredFiles,
        discoveredFileSet,
        excludedFiles,
        unsupportedFiles: [],
        unreadableFiles: snapUniverse?.unreadableFiles ?? [],
        parseFailures,
        discoveryStatus: snapUniverse?.discoveryStatus ?? 'DISCOVERY_COMPLETE',
        discoveryEvidence: 'Snapshot universe adapted for AST closures',
        compilerOptions: build?.projects?.[0]?.options ?? {}
      };
    };

    // A campaign commonly submits several mutations from the same commit pair.
    // They must retain independent PipelineB executions, but they do not need
    // independent immutable AST/checker contexts.  Grouping by the selected
    // parent project preserves the exact universe selection used for each
    // obligation while avoiding repeated context construction and teardown.
    const indexedObligations = input.obligations.map((obligation, index) => ({ obligation, index }));
    const groups = new Map<ts.Program | undefined, Array<{ obligation: any; index: number }>>();
    for (const entry of indexedObligations) {
      const targetFilePath = entry.obligation.mutatedSymbol?.declarationLocation?.filePath;
      const parentProg = findProgram(dual?.parent, targetFilePath);
      const existing = groups.get(parentProg);
      if (existing) existing.push(entry);
      else groups.set(parentProg, [entry]);
    }

    const results: any[] = new Array(input.obligations.length);
    for (const [parentProg, entries] of groups) {
      const representativeTarget = entries[0].obligation.mutatedSymbol?.declarationLocation?.filePath;
      const pUniverse = buildRepositoryUniverse(dual?.parent, parentProg);
      const allParentPrograms: ts.Program[] = dual?.parent?.projects?.map((p: any) => p.program) ?? (parentProg ? [parentProg] : []);
      const pContext = pUniverse && parentProg
        ? new AnalysisContext(pUniverse, {
            program: parentProg,
            programs: allParentPrograms,
            compilerOptions: dual?.parent?.projects?.[0]?.options ?? {}
          })
        : undefined;

      try {
        for (const { obligation, index } of entries) {
          const targetFilePath = obligation.mutatedSymbol?.declarationLocation?.filePath ?? representativeTarget;
          const candidateProg = findProgram(dual?.candidate, targetFilePath);
          const allCandidatePrograms: ts.Program[] = dual?.candidate?.projects?.map((p: any) => p.program) ?? (candidateProg ? [candidateProg] : []);
          const provider = (input as any).provider ?? ((isPhase4Mode && parentProg && candidateProg)
            ? new LiveProgramSemanticProvider({
                parentProgram: parentProg,
                candidateProgram: candidateProg,
                candidatePrograms: allCandidatePrograms,
                obligation,
                candidateDeclarationNode: (input as any).candidateDeclarationNode
              })
            : undefined);
          const startedAt = Date.now();
          results[index] = {
            obligation,
            proof: pipeline.execute(obligation, {
              context: pContext,
              universe: pUniverse,
              workspaceRoot: input.snapshotRoot,
              parentProgram: parentProg,
              candidateProgram: candidateProg,
              parentPrograms: allParentPrograms,
              candidatePrograms: allCandidatePrograms,
              crossVersionIdentity: (input as any).crossVersionIdentity,
              isPhase4Mode,
              provider
            }),
            durationMs: Date.now() - startedAt
          };
        }
      } finally {
        pContext?.dispose();
      }
    }

    return { results };
  }

  toolchain(input: AdapterDetectionInput): ToolchainIdentity {
    let declared: string | null = null;
    const packageText = input.readTextFile('package.json');
    if (packageText) {
      try {
        const pkg = JSON.parse(packageText);
        declared = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript ?? null;
      } catch { /* selection evidence remains valid; malformed metadata is not invented */ }
    }
    return {
      compiler: { name: 'typescript', version: ts.version },
      repositoryDeclaredVersion: declared,
      mismatch: declared === null ? 'UNDETERMINED' : (declared === ts.version ? 'MATCH' : 'MISMATCH')
    };
  }
}
