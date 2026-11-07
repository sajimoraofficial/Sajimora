import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  GitRepository,
  RevisionResolver,
  GitObjectReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter,
  DualTypeScriptProgramBuilder,
  GitDiffReader,
  TypeScriptCrossVersionIdentityAnalyzer
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from '../campaign/realDiffObligationAdapter';
import { resolveDependencyStore } from './command';

async function diagnose() {
  const repoPath = path.resolve('scripts/campaign/repos/zod');
  const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
  const candidateSha = '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
  const depRoot = repoPath;

  const repository = new GitRepository(repoPath);
  repository.validate();
  const revisions = new RevisionResolver(repository).resolve(parentSha, candidateSha);
  const snapshots = new SnapshotFilesystem(new GitObjectReader(repository));
  const parentSnapshot = snapshots.materialize(revisions.parentSha);
  const candidateSnapshot = snapshots.materialize(revisions.candidateSha);

  try {
    const detection = { trackedFiles: candidateSnapshot.trackedFiles, readTextFile: (file: string) => candidateSnapshot.readTextFile(file) };
    const adapter = new TypeScriptV1Adapter();
    const derivation = deriveRealDiffObligations(repository.root, revisions.parentSha, revisions.candidateSha, candidateSnapshot.root);
    if (derivation.status !== 'DERIVED') throw new Error(`Derivation failed: ${(derivation as any).reason}`);

    console.log('Derivation obligations:', derivation.obligations.length);

    const repositoryId = repository.repositoryId();
    const parentDetection = { trackedFiles: parentSnapshot.trackedFiles, readTextFile: (file: string) => parentSnapshot.readTextFile(file) };
    const parentToolchain = adapter.toolchain(parentDetection);
    const candidateToolchain = adapter.toolchain(detection);
    const parentDependencies = resolveDependencyStore(depRoot, parentSnapshot);
    const candidateDependencies = resolveDependencyStore(depRoot, candidateSnapshot);

    const dualBuilder = new DualTypeScriptProgramBuilder();
    const dual = dualBuilder.build({
      root: parentSnapshot.root,
      trackedFiles: parentSnapshot.trackedFiles,
      revision: { repositoryId, commitSha: revisions.parentSha },
      toolchain: parentToolchain,
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      dependencyRoot: parentDependencies?.root,
      dependencyStoreEvidence: parentDependencies?.evidence,
      changedFiles: derivation.changedFiles,
      obligations: derivation.obligations,
      readTextFile: (f: string) => parentSnapshot.readTextFile(f)
    }, {
      root: candidateSnapshot.root,
      trackedFiles: candidateSnapshot.trackedFiles,
      revision: { repositoryId, commitSha: revisions.candidateSha },
      toolchain: candidateToolchain,
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      dependencyRoot: candidateDependencies?.root,
      dependencyStoreEvidence: candidateDependencies?.evidence,
      changedFiles: derivation.changedFiles,
      obligations: derivation.obligations,
      readTextFile: (f: string) => candidateSnapshot.readTextFile(f)
    });

    console.log('\n=== PARENT PROGRAM DIAGNOSTICS ===');
    console.log('Parent status:', dual.parent.status);
    console.log('Parent discoveryStatus:', dual.parent.universe.discoveryStatus);
    console.log('Parent selection closureStatus:', (dual.parent as any).selection?.closureStatus);
    console.log('Parent selection closureBlockers:', (dual.parent as any).selection?.closureBlockers);
    console.log('Parent parseFailures count:', dual.parent.universe.parseFailures.length);
    for (const f of dual.parent.universe.parseFailures) {
      console.log(`  [code ${f.code}] ${f.file}:${f.line}:${f.character} - ${f.message}`);
    }

    console.log('\n=== CANDIDATE PROGRAM DIAGNOSTICS ===');
    console.log('Candidate status:', dual.candidate.status);
    console.log('Candidate discoveryStatus:', dual.candidate.universe.discoveryStatus);
    console.log('Candidate selection closureStatus:', (dual.candidate as any).selection?.closureStatus);
    console.log('Candidate parseFailures count:', dual.candidate.universe.parseFailures.length);
    for (const f of dual.candidate.universe.parseFailures) {
      console.log(`  [code ${f.code}] ${f.file}:${f.line}:${f.character} - ${f.message}`);
    }

    const diffs = new GitDiffReader(repository).read(parentSha, candidateSha);
    const analyzer = new TypeScriptCrossVersionIdentityAnalyzer();
    const bundle = analyzer.analyze(dual.parent, dual.candidate, parentSnapshot.root, candidateSnapshot.root, diffs);

    console.log('\n=== IDENTITY BUNDLE DIAGNOSTICS ===');
    console.log('Identity status:', bundle.status);
    console.log('Blockers:', bundle.blockers);
    console.log('Target mappings:');
    for (const tm of bundle.targetMappings) {
      console.log(`  - target: ${tm.parent?.localName ?? tm.candidate?.localName} status: ${tm.status} parentId: ${tm.parent?.identityId} candidateId: ${tm.candidate?.identityId}`);
    }
    console.log('Consumer mappings count:', bundle.consumerMappings.length);
    for (const cm of bundle.consumerMappings) {
      console.log(`  - consumer: ${cm.parentOccurrenceId} -> ${cm.candidateOccurrenceId} lifecycle: ${cm.lifecycle} targetIdentity: ${cm.targetIdentity}`);
    }

  } finally {
    parentSnapshot.cleanup();
    candidateSnapshot.cleanup();
  }
}

diagnose().catch(err => {
  console.error(err);
  process.exit(1);
});
