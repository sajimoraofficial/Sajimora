import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  GitRepository,
  GitObjectReader,
  GitDiffReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter,
  DualTypeScriptProgramBuilder,
  TypeScriptCrossVersionIdentityAnalyzer,
  normalizeToTrackedRelative
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';
import { RepoBlobPrefetcher } from './RepoBlobPrefetcher';
import { SnapshotSessionCache } from './SnapshotSessionCache';

interface StageMetric {
  stage: string;
  durationMs: number;
  pctOfTotal: string;
  details?: string;
}

export function profileFullPipeline(repoName: string, repoPath: string, parentSha: string, candidateSha: string, subject: string, dependencyRoot?: string) {
  console.log('================================================================');
  console.log(`FULL PIPELINE STAGE-BY-STAGE PROFILING: ${repoName.toUpperCase()}`);
  console.log(`Pair: ${candidateSha.slice(0, 8)} vs parent ${parentSha.slice(0, 8)}`);
  console.log(`Subject: ${subject}`);
  console.log('================================================================\n');

  const totalStart = Date.now();
  const stages: Array<{ stage: string; start: number; end: number; details?: string }> = [];

  // Stage 0: Repository Validation & Fingerprinting
  let sStart = Date.now();
  const repo = new GitRepository(repoPath);
  repo.validate();
  const fpBefore = repo.statusFingerprint();
  stages.push({ stage: 'Stage 0: Git Repo Validation & Fingerprint', start: sStart, end: Date.now() });

  // Stage 1: Obligation & AST Diff Derivation
  sStart = Date.now();
  const derivation = deriveRealDiffObligations(repoPath, parentSha, candidateSha);
  if (derivation.status !== 'DERIVED') {
    console.log(`Not analyzable: ${derivation.reason}`);
    return;
  }
  stages.push({
    stage: 'Stage 1: Real Diff & Obligation Derivation',
    start: sStart,
    end: Date.now(),
    details: `${derivation.obligations.length} mutations derived`
  });

  // Stage 2: Git Blob & Tree Pre-fetching (Layer 1)
  sStart = Date.now();
  const gitCaches = RepoBlobPrefetcher.prefetch(repoPath, [parentSha, candidateSha]);
  stages.push({
    stage: 'Stage 2: Layer 1 Git Blob/Tree Pre-Fetch',
    start: sStart,
    end: Date.now(),
    details: `${gitCaches.blobCache.size} blobs cached`
  });

  // Stage 3: Snapshot Materialization (Layer 2A)
  sStart = Date.now();
  const snapshots = new SnapshotFilesystem(new GitObjectReader(repo, gitCaches));
  const ps = snapshots.materialize(parentSha);
  const cs = snapshots.materialize(candidateSha);
  stages.push({
    stage: 'Stage 3: Layer 2A Snapshot Disk Materialization',
    start: sStart,
    end: Date.now(),
    details: `Parent: ${ps.trackedFiles.length} files | Candidate: ${cs.trackedFiles.length} files`
  });

  try {
    // Stage 4: Input Assembly & Toolchain Setup
    sStart = Date.now();
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

    const input = (snapshot: typeof ps, sha: string) => ({
      root: snapshot.root,
      trackedFiles: snapshot.trackedFiles,
      revision: { repositoryId: repo.repositoryId(), commitSha: sha },
      toolchain: adapter.toolchain(snapshot),
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      dependencyRoot: effectiveDepRoot,
      obligations: derivation.obligations,
      changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined
    });
    stages.push({ stage: 'Stage 4: Toolchain & Input Assembly', start: sStart, end: Date.now() });

    // Stage 5: Dual TypeScript Program Builder (ts.createProgram, tsconfig, AST walk, diagnostics)
    sStart = Date.now();
    const dual = new DualTypeScriptProgramBuilder().build(
      input(ps, parentSha),
      input(cs, candidateSha),
      {
        obligations: derivation.obligations,
        changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined
      }
    );
    stages.push({
      stage: 'Stage 5: Dual TS Program Construction & Semantic Closure',
      start: sStart,
      end: Date.now(),
      details: `Parent projects: ${dual.parent.projects.length}, Candidate projects: ${dual.candidate.projects.length}`
    });

    // Stage 6: Cross-Version Identity Analysis
    sStart = Date.now();
    const crossVersionIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(
      dual.parent,
      dual.candidate,
      ps.root,
      cs.root,
      diffs
    );
    stages.push({ stage: 'Stage 6: Cross-Version Identity Analysis', start: sStart, end: Date.now() });

    // Stage 7: PipelineB / Adapter Semantic Proof Engine
    sStart = Date.now();
    const batchResults = adapter.analyze({
      snapshotRoot: cs.root,
      obligations: derivation.obligations,
      dualPrograms: dual,
      crossVersionIdentity,
      isPhase4Mode: true
    } as any).results;
    stages.push({
      stage: 'Stage 7: PipelineB Proof Tree & Witness Engine',
      start: sStart,
      end: Date.now(),
      details: `${batchResults?.length ?? 0} proof results`
    });

    // Stage 8: Verdict Authority & Audit Reconciliation
    sStart = Date.now();
    const finalEvaluations: any[] = [];
    for (const [idx, obl] of derivation.obligations.entries()) {
      const proof = batchResults?.[idx]?.proof;
      finalEvaluations.push({
        symbol: obl.mutatedSymbol?.qualifiedName,
        verdict: proof?.verdict ?? 'UNKNOWN',
        gate: proof?.auditTrace?.authorityDecision?.gate,
        reason: proof?.auditTrace?.authorityDecision?.reason
      });
    }
    stages.push({ stage: 'Stage 8: Verdict Authority Decision & Audit', start: sStart, end: Date.now() });

    const totalEnd = Date.now();
    const totalDuration = totalEnd - totalStart;

    console.log('----------------------------------------------------------------');
    console.log('STAGE DURATION BREAKDOWN (WALL-CLOCK TIME)');
    console.log('----------------------------------------------------------------');
    for (const s of stages) {
      const dur = s.end - s.start;
      const pct = ((dur / totalDuration) * 100).toFixed(1);
      const detailStr = s.details ? ` (${s.details})` : '';
      console.log(`  ${s.stage.padEnd(52)} : ${dur.toString().padStart(6)} ms [${pct.padStart(5)}%]${detailStr}`);
    }
    console.log('----------------------------------------------------------------');
    console.log(`  TOTAL ENTIRE PIPELINE DURATION                       : ${totalDuration.toString().padStart(6)} ms [100.0%]`);
    console.log('----------------------------------------------------------------\n');

    console.log('VERDICTS PRODUCED:');
    for (const ev of finalEvaluations) {
      console.log(`  • ${ev.symbol}: ${ev.verdict} (${ev.gate} :: ${ev.reason})`);
    }
    console.log('');
  } finally {
    ps.cleanup();
    cs.cleanup();
  }
}

// Profile Express
profileFullPipeline(
  'express',
  path.resolve('scripts/campaign/repos/express'),
  'cb19f04170fc815321d40dcd3bc620ae03c828cd',
  '90ec6206d3275fdf2787f2028c6f48a2d92e8042',
  'Improve error logging by logging full error object (#6464)',
  path.resolve('scripts/campaign/repos/express/node_modules')
);

// Profile Zod
profileFullPipeline(
  'zod',
  path.resolve('scripts/campaign/repos/zod'),
  '68a609ac9b9516e6fe84e3558f17ce16b1032bef',
  '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f',
  "refactor: collapse toZod's enum leaf normalizer to a dummy union (#6533)",
  path.resolve('scripts/campaign/repos/zod/node_modules')
);
