import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import { LanguageAdapterRegistry } from '@sajimora/core';
import {
  GitRepository,
  RevisionResolver,
  GitObjectReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter,
  DualTypeScriptProgramBuilder,
  GitDiffReader,
  TypeScriptCrossVersionIdentityAnalyzer,
  TypeScriptDeclarationIndexer,
  TypeScriptTargetIdentityMapper,
  TypeScriptClosureReferenceIndexer,
  TypeScriptConsumerIdentityMapper,
  TypeScriptProgramBuilder
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from '../campaign/realDiffObligationAdapter';
import { resolveDependencyStore } from './command';

function memStr(label: string) {
  if (global.gc) {
    try { global.gc(); } catch {}
  }
  const m = process.memoryUsage();
  const mb = (b: number) => (b / (1024 * 1024)).toFixed(2) + ' MB';
  console.log(`[MEM] [${label.padEnd(35)}] heapUsed: ${mb(m.heapUsed).padStart(10)} | heapTotal: ${mb(m.heapTotal).padStart(10)} | rss: ${mb(m.rss).padStart(10)} | external: ${mb(m.external).padStart(10)}`);
}

async function runProfile() {
  console.log('=== Starting Real Zod Production Path Memory Profiler ===\n');
  memStr('INITIAL');

  const repoPath = path.resolve('scripts/campaign/repos/zod');
  const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
  const candidateSha = '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
  const depRoot = repoPath;

  // STAGE 1: Git Repo & Diff derivation
  console.log('\n--- STAGE 1: Git Repository & Snapshots ---');
  const repository = new GitRepository(repoPath);
  repository.validate();
  const revisions = new RevisionResolver(repository).resolve(parentSha, candidateSha);
  memStr('POST_REVISION_RESOLVE');

  const snapshots = new SnapshotFilesystem(new GitObjectReader(repository));
  const parentSnapshot = snapshots.materialize(revisions.parentSha);
  memStr('POST_PARENT_SNAPSHOT');
  const candidateSnapshot = snapshots.materialize(revisions.candidateSha);
  memStr('POST_CANDIDATE_SNAPSHOT');

  try {
    const detection = { trackedFiles: candidateSnapshot.trackedFiles, readTextFile: (file: string) => candidateSnapshot.readTextFile(file) };
    const registry = new LanguageAdapterRegistry();
    registry.register(new TypeScriptV1Adapter());
    const selection = registry.select('typescript', detection);

    console.log('\n--- Deriving Real Diff Obligations ---');
    const derivation = deriveRealDiffObligations(repository.root, revisions.parentSha, revisions.candidateSha, candidateSnapshot.root);
    if (derivation.status !== 'DERIVED') throw new Error(`Derivation failed: ${derivation.reason}`);
    console.log(`Diff status: ${derivation.status}, changed files: ${derivation.changedFiles.length}, obligations: ${derivation.obligations.length}`);
    memStr('POST_DIFF_DERIVATION');

    const repositoryId = repository.repositoryId();
    const toolchain = selection.adapter.toolchain(detection);
    const parentDetection = { trackedFiles: parentSnapshot.trackedFiles, readTextFile: (file: string) => parentSnapshot.readTextFile(file) };
    const parentToolchain = selection.adapter.toolchain(parentDetection);
    const parentDependencies = resolveDependencyStore(depRoot, parentSnapshot);
    const candidateDependencies = resolveDependencyStore(depRoot, candidateSnapshot);

    // STAGE 2: Dual TS Programs
    console.log('\n--- STAGE 2: Dual TS Programs Construction ---');
    console.log('Inspecting tsconfig files in repository...');
    const parentConfigs = parentSnapshot.trackedFiles.filter(f => /(^|\/)tsconfig\.json$/.test(f.replace(/\\/g, '/')));
    console.log(`Discovered ${parentConfigs.length} tsconfig.json files in parent:`);
    parentConfigs.forEach(c => console.log(`  - ${c}`));

    console.log('\nBuilding Parent Program incrementally per project...');
    const programBuilder = new TypeScriptProgramBuilder();
    const parentProgramInput = {
      root: parentSnapshot.root,
      trackedFiles: parentSnapshot.trackedFiles,
      revision: { repositoryId, commitSha: revisions.parentSha },
      toolchain: parentToolchain,
      adapterId: selection.adapter.descriptor.id,
      adapterVersion: selection.adapter.descriptor.version,
      dependencyRoot: parentDependencies?.root,
      dependencyStoreEvidence: parentDependencies?.evidence,
      changedFiles: derivation.changedFiles,
      readTextFile: (f: string) => parentSnapshot.readTextFile(f)
    };

    const t0 = Date.now();
    const parentBuild = programBuilder.build(parentProgramInput);
    console.log(`Parent Program build finished in ${Date.now() - t0}ms. Projects: ${parentBuild.projects.length}, Status: ${parentBuild.status}`);
    memStr('POST_PARENT_PROGRAMS');

    for (const proj of parentBuild.projects) {
      console.log(`  Project [${proj.identity.projectId}]: ${proj.program.getSourceFiles().length} source files`);
    }

    console.log('\nBuilding Candidate Program...');
    const candidateProgramInput = {
      root: candidateSnapshot.root,
      trackedFiles: candidateSnapshot.trackedFiles,
      revision: { repositoryId, commitSha: revisions.candidateSha, parentSelection: revisions.parentSelection },
      toolchain,
      adapterId: selection.adapter.descriptor.id,
      adapterVersion: selection.adapter.descriptor.version,
      dependencyRoot: candidateDependencies?.root,
      dependencyStoreEvidence: candidateDependencies?.evidence,
      changedFiles: derivation.changedFiles,
      readTextFile: (f: string) => candidateSnapshot.readTextFile(f)
    };
    const t1 = Date.now();
    const candidateBuild = programBuilder.build(candidateProgramInput);
    console.log(`Candidate Program build finished in ${Date.now() - t1}ms. Projects: ${candidateBuild.projects.length}, Status: ${candidateBuild.status}`);
    memStr('POST_CANDIDATE_PROGRAMS');

    const dual = {
      parent: parentBuild,
      candidate: candidateBuild,
      universe: {
        parent: parentBuild.universe,
        candidate: candidateBuild.universe,
        configurationRelation: { status: 'EQUIVALENT' as const, changes: [] }
      }
    };

    // STAGE 3: Cross-Version Identity
    console.log('\n--- STAGE 3: Cross-Version Identity (Declarations & Mappings) ---');
    const diffs = new GitDiffReader(repository).read(revisions.parentSha, revisions.candidateSha);
    console.log(`Git diff entries: ${diffs.length}`);
    for (const d of diffs) {
      console.log(`  Diff: ${d.status} ${d.parentPath} -> ${d.candidatePath} (${d.hunks.length} hunks)`);
    }

    console.log('Indexing parent declarations...');
    const declIndexer = new TypeScriptDeclarationIndexer();
    const pDecls = declIndexer.index(parentBuild, parentSnapshot.root);
    console.log(`Indexed ${pDecls.length} parent declarations.`);
    memStr('POST_PARENT_DECLARATIONS');

    console.log('Indexing candidate declarations...');
    const cDecls = declIndexer.index(candidateBuild, candidateSnapshot.root);
    console.log(`Indexed ${cDecls.length} candidate declarations.`);
    memStr('POST_CANDIDATE_DECLARATIONS');

    console.log('Mapping target identities...');
    const targetMapper = new TypeScriptTargetIdentityMapper();
    const bundle = targetMapper.map(pDecls, cDecls, diffs);
    console.log(`Target mappings count: ${bundle.targetMappings.length}`);
    for (const tm of bundle.targetMappings) {
      console.log(`  Target: ${tm.parent?.localName ?? tm.candidate?.localName} (${tm.status}) parentLoc: ${tm.parent?.moduleIdentity}:${tm.parent?.sourceSpan.line} candidateLoc: ${tm.candidate?.moduleIdentity}:${tm.candidate?.sourceSpan.line}`);
    }
    memStr('POST_TARGET_MAPPINGS');

    // STAGE 4: Discovery (Consumer Reference Indexing)
    console.log('\n--- STAGE 4: Discovery (Consumer Reference Indexing) ---');
    const refIndexer = new TypeScriptClosureReferenceIndexer();
    const consumerMapper = new TypeScriptConsumerIdentityMapper();

    let targetIdx = 0;
    for (const mapping of bundle.targetMappings) {
      targetIdx++;
      console.log(`\nProcessing target mapping ${targetIdx}/${bundle.targetMappings.length}: ${mapping.parent?.localName} (${mapping.status})...`);
      if (mapping.parent && mapping.candidate && !['AMBIGUOUS', 'UNRESOLVED'].includes(mapping.status)) {
        const tStart = Date.now();
        console.log(`  Running references.index(parent)...`);
        const pRefs = refIndexer.index(parentBuild, parentSnapshot.root, mapping.parent);
        memStr(`POST_P_REFS_T${targetIdx}`);
        console.log(`  Parent refs: ${pRefs.length}`);

        console.log(`  Running references.index(candidate)...`);
        const cRefs = refIndexer.index(candidateBuild, candidateSnapshot.root, mapping.candidate);
        memStr(`POST_C_REFS_T${targetIdx}`);
        console.log(`  Candidate refs: ${cRefs.length}`);

        const mappedConsumers = consumerMapper.map(pRefs, cRefs);
        bundle.consumerMappings.push(...mappedConsumers);
        console.log(`  Mapped consumers: ${mappedConsumers.length} (elapsed: ${Date.now() - tStart}ms)`);
        memStr(`POST_CONSUMERS_T${targetIdx}`);
      }
    }

    console.log(`Total consumer mappings: ${bundle.consumerMappings.length}`);
    memStr('POST_ALL_CONSUMER_MAPPINGS');

    // STAGE 5: IR Extraction & Pipeline Execution
    console.log('\n--- STAGE 5: Analysis / Pipeline B Execution ---');
    const analyzed = selection.adapter.analyze({
      snapshotRoot: candidateSnapshot.root,
      obligations: derivation.obligations,
      dualPrograms: dual,
      crossVersionIdentity: bundle,
      isPhase4Mode: true
    } as any);
    memStr('POST_ADAPTER_ANALYZE');
    console.log(`Analysis completed with ${analyzed.results.length} results.`);

    // STAGE 6: Artifact Serialization
    console.log('\n--- STAGE 6: Artifact Serialization ---');
    memStr('FINAL');
    console.log('SUCCESS! Finished without OOM.');

  } finally {
    candidateSnapshot?.cleanup();
    parentSnapshot?.cleanup();
  }
}

runProfile().catch(err => {
  console.error('\n!!! PROFILER CAUGHT FATAL ERROR !!!\n', err);
  memStr('FATAL_ERROR_STATE');
  process.exit(1);
});
