import {
  DualTypeScriptProgramBuilder,
  TypeScriptV1Adapter,
  SnapshotFilesystem,
  GitObjectReader,
  GitRepository,
  normalizeToTrackedRelative,
  TypeScriptCrossVersionIdentityAnalyzer
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';
import * as path from 'node:path';

interface CaseDef {
  repoName: string;
  repoPath: string;
  parentSha: string;
  candidateSha: string;
  targetSymbol: string;
  targetFile: string;
}

const cases: CaseDef[] = [
  {
    repoName: 'zod',
    repoPath: path.resolve('scripts/campaign/repos/zod'),
    parentSha: '68a609ac9b9516e6fe84e3558f17ce16b1032bef',
    candidateSha: '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f',
    targetSymbol: 'ToZodNormalizeEnum',
    targetFile: 'packages/zod/src/v4/core/util.ts'
  },
  {
    repoName: 'TypeScript-Website',
    repoPath: path.resolve('scripts/campaign/repos/TypeScript-Website'),
    parentSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
    candidateSha: '673b339a77d87f0e8187040c25c30801af802ab9',
    targetSymbol: 'okToSkip',
    targetFile: 'packages/tsconfig-reference/scripts/schema/generateJSON.ts'
  },
  {
    repoName: 'TypeScript-Website',
    repoPath: path.resolve('scripts/campaign/repos/TypeScript-Website'),
    parentSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
    candidateSha: '673b339a77d87f0e8187040c25c30801af802ab9',
    targetSymbol: 'compilerOptions',
    targetFile: 'packages/tsconfig-reference/scripts/tsconfig/generateMarkdown.ts'
  },
  {
    repoName: 'TypeScript-Website',
    repoPath: path.resolve('scripts/campaign/repos/TypeScript-Website'),
    parentSha: '32433bc2c7528771aa4c63b2d22d7172b0dd376c',
    candidateSha: 'd21b31543d87c3b190e034694c955d2192b06a4d',
    targetSymbol: 'createConfigDropdown',
    targetFile: 'packages/playground/src/createConfigDropdown.ts'
  },
  {
    repoName: 'turborepo',
    repoPath: path.resolve('scripts/campaign/repos/turborepo'),
    parentSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b',
    candidateSha: '06f59004ba50fabd4c582230ed076ee909fb85fc',
    targetSymbol: 'create',
    targetFile: 'packages/create-turbo/src/commands/create/index.ts'
  },
  {
    repoName: 'turborepo',
    repoPath: path.resolve('scripts/campaign/repos/turborepo'),
    parentSha: '4db9ca09bdac8cc0f8ece533cc480c10947f7bc1',
    candidateSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b',
    targetSymbol: 'calculateDepths',
    targetFile: 'apps/docs/app/[lang]/devtools/devtools-client.tsx'
  }
];

async function diagnose() {
  for (const c of cases) {
    console.log(`\n======================================================`);
    console.log(`DIAGNOSING: ${c.repoName} - ${c.targetSymbol} (${c.targetFile})`);
    console.log(`======================================================`);
    const repo = new GitRepository(c.repoPath);
    const snapshots = new SnapshotFilesystem(new GitObjectReader(repo));
    const ps = snapshots.materialize(c.parentSha);
    const cs = snapshots.materialize(c.candidateSha);
    const depRoot = path.resolve(c.repoPath, 'node_modules');

    try {
      const derivation = deriveRealDiffObligations(c.repoPath, c.parentSha, c.candidateSha);
      if (derivation.status !== 'DERIVED') {
        console.log('Derivation status:', derivation.status, derivation.reason);
        continue;
      }

      const obligation = derivation.obligations.find(o => {
        const sym = o.mutatedSymbol?.qualifiedName ?? o.mutatedSymbol?.symbolId;
        const fp = o.mutatedSymbol?.declarationLocation?.filePath;
        const rel = fp ? normalizeToTrackedRelative(fp, ps.root, ps.trackedFiles) : null;
        return (sym === c.targetSymbol || o.mutatedSymbol?.symbolId === c.targetSymbol) && rel === c.targetFile;
      }) ?? derivation.obligations[0];

      console.log(`Obligation found:`, {
        symbol: obligation?.mutatedSymbol?.symbolId,
        kind: obligation?.mutatedSymbol?.kind,
        file: obligation?.mutatedSymbol?.declarationLocation?.filePath,
        classification: obligation?.providerMutation?.classification
      });

      const adapter = new TypeScriptV1Adapter();
      const targetFilePath = obligation?.mutatedSymbol?.declarationLocation?.filePath;
      const targetRel = targetFilePath ? normalizeToTrackedRelative(targetFilePath, ps.root, ps.trackedFiles) : undefined;

      const input = (s: any, sha: string) => ({
        root: s.root,
        trackedFiles: s.trackedFiles,
        revision: { repositoryId: repo.repositoryId(), commitSha: sha },
        toolchain: adapter.toolchain(s),
        adapterId: adapter.descriptor.id,
        adapterVersion: adapter.descriptor.version,
        dependencyRoot: depRoot,
        obligations: [obligation],
        changedFiles: targetRel ? [targetRel] : undefined
      });

      const dual = new DualTypeScriptProgramBuilder().build(
        input(ps, c.parentSha),
        input(cs, c.candidateSha),
        {
          obligations: [obligation],
          changedFiles: targetRel ? [targetRel] : undefined
        }
      );

      console.log('Parent status:', dual.parent.status);
      console.log('Parent selection selectedConfigs:', dual.parent.selection?.selectedConfigs);
      console.log('Parent selection subsumedConfigs:', dual.parent.selection?.subsumedConfigs);
      console.log('Parent selection closureStatus:', dual.parent.selection?.closureStatus);
      console.log('Parent selection closureBlockers:', dual.parent.selection?.closureBlockers);
      console.log('Parent universe discoveryStatus:', dual.parent.universe.discoveryStatus);
      console.log('Parent parseFailures:', dual.parent.universe.parseFailures);
      console.log('Parent unreadableFiles:', dual.parent.universe.unreadableFiles);

      console.log('Candidate status:', dual.candidate.status);
      console.log('Candidate selection selectedConfigs:', dual.candidate.selection?.selectedConfigs);
      console.log('Candidate selection closureStatus:', dual.candidate.selection?.closureStatus);
      console.log('Candidate selection closureBlockers:', dual.candidate.selection?.closureBlockers);
      console.log('Candidate universe discoveryStatus:', dual.candidate.universe.discoveryStatus);
      console.log('Candidate parseFailures:', dual.candidate.universe.parseFailures);

      const diffs = new (require('@sajimora/analysis').GitDiffReader)(repo).read(c.parentSha, c.candidateSha);
      const crossVersionIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(
        dual.parent,
        dual.candidate,
        ps.root,
        cs.root,
        diffs
      );
      console.log('Identity status:', crossVersionIdentity.status);
      console.log('Identity blockers:', crossVersionIdentity.blockers);
      console.log('Identity targetMappings:', crossVersionIdentity.targetMappings?.map((tm: any) => ({
        parent: tm.parent?.identityId,
        candidate: tm.candidate?.identityId,
        status: tm.status
      })));

      const analyzed = adapter.analyze({
        snapshotRoot: cs.root,
        obligations: [obligation],
        dualPrograms: dual,
        crossVersionIdentity,
        isPhase4Mode: true
      } as any).results?.[0]?.proof;

      console.log('PipelineB Result:');
      console.log('  verdict:', analyzed?.verdict);
      console.log('  gate:', analyzed?.auditTrace?.authorityDecision?.gate);
      console.log('  reason:', analyzed?.auditTrace?.authorityDecision?.reason);
      console.log('  source:', analyzed?.auditTrace?.authorityDecision?.source);
      console.log('  consumers count:', analyzed?.auditTrace?.consumers?.length);
      console.log('  compatibility:', analyzed?.auditTrace?.compatibility?.map((entry: any) => ({
        status: entry.result?.status,
        reason: entry.result?.reason,
        witness: entry.result?.witness?.failedRelation
      })));
      console.log('  proof diagnostics:', JSON.stringify(analyzed?.auditTrace?.proofDiagnostics, null, 2));
    } finally {
      ps.cleanup();
      cs.cleanup();
    }
  }
}

diagnose().catch(console.error);
