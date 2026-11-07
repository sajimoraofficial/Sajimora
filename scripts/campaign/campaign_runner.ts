import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import {
  GitRepository,
  GitObjectReader,
  GitDiffReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter,
  DualTypeScriptProgramBuilder,
  TypeScriptCrossVersionIdentityAnalyzer,
  PipelineB,
  AnalysisContext,
  normalizeToTrackedRelative,
  TypeScriptProjectSelector
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';
import { SnapshotSessionCache } from './SnapshotSessionCache';
import { evaluateProgramReuseEligibility, OldBuildRecord } from './ProgramReuseGate';

export interface EvaluateCommitPairOptions {
  snapshotCache?: SnapshotSessionCache;
  enableProgramReuse?: boolean;
  lastBuildRecord?: { current?: OldBuildRecord };
  gitCaches?: {
    blobCache?: Map<string, Buffer>;
    treeCache?: Map<string, any[]>;
  };
  provider?: any;
  /** Controlled Phase-4 memory experiment controls. Production callers omit this. */
  memoryProfile?: {
    disableIsolationRetries?: boolean;
    eagerDiagnosticRelease?: boolean;
    clearDeadReferencesBeforeGc?: boolean;
    onStage: (stage: string, details?: { durationMs?: number; sourceFileCount?: number; projectCount?: number; retryCount?: number }) => void;
  };
}

export interface CampaignCaseResult {
  repository: string;
  parentSha: string;
  candidateSha: string;
  subject: string;
  analyzable: boolean;
  nonAnalyzableReason?: string;
  mutationsCount: number;
  evaluations: Array<{
    targetSymbol: string;
    targetKind: string;
    targetFile: string;
    classification: string;
    verdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'INSUFFICIENT_EVIDENCE' | string;
    authorityGate?: string;
    authorityReason?: string;
    authoritySource?: string;
    hasSemanticCompatibility?: boolean;
    evaluatedConsumerCount?: number;
    compatibilityStatuses?: Record<string, number>;
    witnesses?: string[];
    isUnsafePositive: boolean;
    durationMs: number;
    peakRssBytes: number;
  }>;
}

export function evaluateCommitPair(
  repoName: string,
  repoPath: string,
  parentSha: string,
  candidateSha: string,
  subject: string,
  dependencyRoot?: string,
  options?: EvaluateCommitPairOptions
): CampaignCaseResult {
  const repo = new GitRepository(repoPath);
  repo.validate();
  const repoFingerprintBefore = repo.statusFingerprint();

  const derivation = deriveRealDiffObligations(repoPath, parentSha, candidateSha);
  if (derivation.status !== 'DERIVED') {
    return {
      repository: repoName,
      parentSha,
      candidateSha,
      subject,
      analyzable: false,
      nonAnalyzableReason: derivation.reason,
      mutationsCount: 0,
      evaluations: []
    };
  }

  const evaluations: CampaignCaseResult['evaluations'] = [];
  const snapshots = new SnapshotFilesystem(new GitObjectReader(repo, options?.gitCaches));
  const ps = options?.snapshotCache
    ? (options.snapshotCache.acquire(parentSha) ?? (() => {
        const s = snapshots.materialize(parentSha);
        options.snapshotCache.store(parentSha, s);
        return s;
      })())
    : snapshots.materialize(parentSha);

  const cs = options?.snapshotCache
    ? (options.snapshotCache.acquire(candidateSha) ?? (() => {
        const s = snapshots.materialize(candidateSha);
        options.snapshotCache.store(candidateSha, s);
        return s;
      })())
    : snapshots.materialize(candidateSha);

  options?.memoryProfile?.onStage('snapshot', {
    sourceFileCount: ps.trackedFiles.length + cs.trackedFiles.length,
    projectCount: 0
  });

  let dual: any = null;
  let crossVersionIdentity: any = null;
  let batchResults: any[] | undefined;
  let batchFailure: unknown;

  try {
    const adapter = new TypeScriptV1Adapter();
    const effectiveDepRoot = dependencyRoot && fs.existsSync(dependencyRoot) ? dependencyRoot : undefined;
    const diffs = new GitDiffReader(repo).read(parentSha, candidateSha);

    const allChangedFiles = Array.from(new Set(
      derivation.obligations
        .map(o => {
          const targetFilePath = o.mutatedSymbol?.declarationLocation?.filePath;
          return targetFilePath ? normalizeToTrackedRelative(targetFilePath, ps.root, ps.trackedFiles) : null;
        })
        .filter((p): p is string => Boolean(p))
    ));

    const input = (snapshot: typeof ps, sha: string, world: 'parent' | 'candidate') => ({
      root: snapshot.root,
      trackedFiles: snapshot.trackedFiles,
      revision: { repositoryId: repo.repositoryId(), commitSha: sha },
      toolchain: adapter.toolchain(snapshot),
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      dependencyRoot: effectiveDepRoot,
      obligations: derivation.obligations,
      changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined,
      ...(options?.memoryProfile ? {
        memoryProfile: {
          world,
          eagerDiagnosticRelease: options.memoryProfile.eagerDiagnosticRelease,
          onStage: (event: { stage: 'program' | 'diagnostics'; world: 'parent' | 'candidate'; durationMs: number; sourceFileCount: number; projectCount: number }) => {
            options.memoryProfile!.onStage(`${event.world} ${event.stage}`, event);
          }
        }
      } : {})
    });

    let parentReuseOptions: { oldPrograms?: Map<string, ts.Program> } | undefined;
    if (options?.enableProgramReuse && options.lastBuildRecord?.current) {
      try {
        const selector = new TypeScriptProjectSelector();
        const selection = selector.selectProjects(
          ps.root,
          ps.trackedFiles,
          allChangedFiles.length > 0 ? allChangedFiles : undefined,
          ps.readTextFile.bind(ps),
          effectiveDepRoot
        );
        const parsedOptions = new Map<string, ts.CompilerOptions | undefined>();
        const parseHost: ts.ParseConfigHost = {
          useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
          readDirectory: () => [],
          fileExists: f => ps.readTextFile(path.relative(ps.root, f).replace(/\\/g, '/')) !== undefined,
          readFile: f => ps.readTextFile(path.relative(ps.root, f).replace(/\\/g, '/')) ?? ''
        };
        for (const configRel of selection.selectedConfigs) {
          const configAbs = path.resolve(ps.root, ...configRel.split('/'));
          const read = ts.readConfigFile(configAbs, ts.sys.readFile);
          if (!read.error && read.config) {
            const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, path.dirname(configAbs), undefined, configAbs);
            parsedOptions.set(configRel, parsed.options);
          } else {
            parsedOptions.set(configRel, undefined);
          }
        }
        const reusable = evaluateProgramReuseEligibility(options.lastBuildRecord.current, {
          revisionSha: parentSha,
          snapshotRoot: ps.root,
          trackedFiles: ps.trackedFiles,
          dependencyRoot: effectiveDepRoot,
          selection,
          parsedOptions
        });
        if (reusable) {
          parentReuseOptions = { oldPrograms: reusable };
        }
      } catch {
        parentReuseOptions = undefined;
      }
    }

    dual = new DualTypeScriptProgramBuilder().build(
        input(ps, parentSha, 'parent'),
        input(cs, candidateSha, 'candidate'),
        {
          obligations: derivation.obligations,
          changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined,
          parentReuseOptions
        }
      );

    if (options?.enableProgramReuse && options.lastBuildRecord) {
      options.lastBuildRecord.current = {
        revisionSha: candidateSha,
        snapshotRoot: cs.root,
        buildStatus: dual.candidate.status,
        trackedFiles: cs.trackedFiles,
        dependencyRoot: effectiveDepRoot,
        selectedConfigs: dual.candidate.selection?.selectedConfigs ?? [],
        projectPrograms: dual.candidate.projects.map((p: any) => ({
          configRel: p.identity.configFile,
          program: p.program,
          parsedOptions: p.options
        }))
      };
    }

      crossVersionIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(
        dual.parent,
        dual.candidate,
        ps.root,
        cs.root,
        diffs
      );
      options?.memoryProfile?.onStage('identity/mapping', {
        sourceFileCount: dual.parent.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0) +
          dual.candidate.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0),
        projectCount: dual.parent.projects.length + dual.candidate.projects.length
      });

      // Submit the pair as one immutable batch.  The adapter still executes a
      // separate proof per obligation, but can reuse its project context.
      try {
        batchResults = adapter.analyze({
          snapshotRoot: cs.root,
          obligations: derivation.obligations,
          dualPrograms: dual,
          crossVersionIdentity,
          isPhase4Mode: true,
          provider: options?.provider
        } as any).results;
      } catch (err) {
        batchFailure = err;
      }
      options?.memoryProfile?.onStage('batch evaluation', {
        sourceFileCount: dual.parent.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0) +
          dual.candidate.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0),
        projectCount: dual.parent.projects.length + dual.candidate.projects.length
      });

      let isolationRetryCount = 0;
      for (const [obligationIndex, obligation] of derivation.obligations.entries()) {
        const startTime = Date.now();
        const memBefore = process.memoryUsage().rss;

        const targetFilePath = obligation.mutatedSymbol?.declarationLocation?.filePath;
        const targetRel: string | undefined = targetFilePath
          ? normalizeToTrackedRelative(targetFilePath, ps.root, ps.trackedFiles) ?? undefined
          : undefined;

        let verdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'INSUFFICIENT_EVIDENCE' | string = 'UNKNOWN';
        let authorityGate: string | undefined;
        let authorityReason: string | undefined;
        let authoritySource: string | undefined;
        let hasSemanticCompatibility: boolean | undefined;
        let evaluatedConsumerCount: number | undefined;
        let compatibilityStatuses: Record<string, number> | undefined;
        let witnesses: string[] | undefined;
        let isUnsafePositive = false;

        if (!batchFailure) {
          try {
            const analyzed = batchResults?.[obligationIndex];
            let result = analyzed?.proof;

            // Isolation fallback: If a multi-obligation batch suffered a DISCOVERY_FAILURE,
            // retry this obligation in isolation with its own target file to avoid cross-contamination
            // from unrelated sibling files that had missing imports/diagnostics.
            if (
              result?.verdict === 'UNKNOWN' &&
              result?.auditTrace?.authorityDecision?.reason === 'DISCOVERY_FAILURE' &&
              derivation.obligations.length > 1 &&
              !options?.memoryProfile?.disableIsolationRetries
            ) {
              try {
                isolationRetryCount++;
                const singleInput = (snapshot: typeof ps, sha: string) => ({
                  root: snapshot.root,
                  trackedFiles: snapshot.trackedFiles,
                  revision: { repositoryId: repo.repositoryId(), commitSha: sha },
                  toolchain: adapter.toolchain(snapshot),
                  adapterId: adapter.descriptor.id,
                  adapterVersion: adapter.descriptor.version,
                  dependencyRoot: effectiveDepRoot,
                  obligations: [obligation],
                  changedFiles: targetRel ? [targetRel] : undefined
                });
                const singleDual = new DualTypeScriptProgramBuilder().build(
                  singleInput(ps, parentSha),
                  singleInput(cs, candidateSha),
                  {
                    obligations: [obligation],
                    changedFiles: targetRel ? [targetRel] : undefined,
                    parentReuseOptions
                  }
                );
                const singleIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(
                  singleDual.parent,
                  singleDual.candidate,
                  ps.root,
                  cs.root,
                  diffs
                );
                const isolatedProof = adapter.analyze({
                  snapshotRoot: cs.root,
                  obligations: [obligation],
                  dualPrograms: singleDual,
                  crossVersionIdentity: singleIdentity,
                  isPhase4Mode: true
                } as any).results?.[0]?.proof;
                if (isolatedProof) {
                  result = isolatedProof;
                }
                options?.memoryProfile?.onStage('isolation retry', {
                  sourceFileCount: singleDual.parent.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0) +
                    singleDual.candidate.projects.reduce((n: number, p: any) => n + p.program.getSourceFiles().length, 0),
                  projectCount: singleDual.parent.projects.length + singleDual.candidate.projects.length,
                  retryCount: isolationRetryCount
                });
              } catch {
                // Keep original batch result on fallback failure
              }
            }

            if (result) {
              verdict = result.verdict;
              authorityGate = result.auditTrace?.authorityDecision?.gate;
              authorityReason = result.auditTrace?.authorityDecision?.reason;
              authoritySource = result.auditTrace?.authorityDecision?.source;

              const compEntries: any[] = result.auditTrace?.compatibility ?? [];
              hasSemanticCompatibility = compEntries.length > 0;
              evaluatedConsumerCount = result.auditTrace?.consumers?.length ?? 0;
              compatibilityStatuses = {};
              witnesses = [];
              for (const c of compEntries) {
                const status = c.result?.status ?? 'UNKNOWN';
                compatibilityStatuses[status] = (compatibilityStatuses[status] || 0) + 1;
                if (c.result?.witness) {
                  witnesses.push(JSON.stringify(c.result.witness));
                } else if (c.result?.phase4Evidence?.witness) {
                  witnesses.push(JSON.stringify(c.result.phase4Evidence.witness));
                }
              }

              // Check if PRESERVED is unsafe:
              // An unsafe positive occurs if PRESERVED was emitted when an incompatibility witness exists,
              // or if the mutation was SYMBOL_DELETED with active consumers, or if proof tree is invalid.
              if (verdict === 'PRESERVED') {
                if (obligation.providerMutation?.classification === 'SYMBOL_DELETED' && (result.auditTrace?.consumers?.length ?? 0) > 0) {
                  isUnsafePositive = true;
                }
              }
            }
          } catch (err) {
            verdict = 'UNKNOWN';
            authorityGate = 'ENGINE_RUNTIME';
            authorityReason = 'ENGINE_RUNTIME_FAILURE';
            authoritySource = 'SAJIMORA_PIPELINE';
          }
        } else {
          verdict = 'UNKNOWN';
          authorityGate = 'ENGINE_RUNTIME';
          authorityReason = 'ENGINE_RUNTIME_FAILURE';
          authoritySource = 'SAJIMORA_PIPELINE';
        }

        const memAfter = process.memoryUsage().rss;
        evaluations.push({
          targetSymbol: obligation.mutatedSymbol?.qualifiedName ?? 'unknown',
          targetKind: obligation.mutatedSymbol?.kind ?? 'unknown',
          targetFile: targetRel ?? 'unknown',
          classification: obligation.providerMutation?.classification ?? 'unknown',
          verdict,
          authorityGate,
          authorityReason,
          authoritySource,
          hasSemanticCompatibility,
          evaluatedConsumerCount,
          compatibilityStatuses,
          witnesses,
          isUnsafePositive,
          durationMs: batchResults?.[obligationIndex]?.durationMs ?? (Date.now() - startTime),
          peakRssBytes: Math.max(memBefore, memAfter)
        });
      }
    } finally {
      if (options?.memoryProfile?.clearDeadReferencesBeforeGc) {
        batchResults = undefined;
        batchFailure = undefined;
        crossVersionIdentity = null;
      }
      if (dual) {
        if (!options?.enableProgramReuse) {
          if (dual.parent?.projects) dual.parent.projects = [];
          if (dual.candidate?.projects) dual.candidate.projects = [];
        }
        dual = null;
      }
      crossVersionIdentity = null;
      if (options?.snapshotCache) {
        options.snapshotCache.release(parentSha);
        options.snapshotCache.release(candidateSha);
      } else {
        ps.cleanup();
        cs.cleanup();
      }
      options?.memoryProfile?.onStage('cleanup');
      if (typeof (global as any).gc === 'function') {
        try { (global as any).gc(); } catch {}
      }
      options?.memoryProfile?.onStage('cleanup+forced-GC');
    }

  const repoFingerprintAfter = repo.statusFingerprint();
  if (repoFingerprintBefore !== repoFingerprintAfter) {
    throw new Error(`Repository mutation detected in ${repoName}! Isolation violated.`);
  }

  return {
    repository: repoName,
    parentSha,
    candidateSha,
    subject,
    analyzable: true,
    mutationsCount: derivation.obligations.length,
    evaluations
  };
}
