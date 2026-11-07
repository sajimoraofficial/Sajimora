import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { RepositoryAnalysisUniverseBuilder } from '../../packages/analysis/src/sajimora/universe/RepositoryAnalysisUniverse';
import { AnalysisContext } from '../../packages/analysis/src/sajimora/context/AnalysisContext';
import { PipelineB } from '../../packages/analysis/src/sajimora/pipelines/PipelineB';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';

interface LabelCase {
  commitSha: string;
  parentSha: string;
  targetSymbol: string;
  targetFile: string;
  expectedVerdict: string;
  rationale: string;
}

function parseArgs(): { repo: string; caseIndex: number; labelsFile: string } {
  const args = process.argv.slice(2);
  let repo = '';
  let caseIndex = -1;
  let labelsFile = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[i + 1];
      i++;
    } else if (args[i] === '--case-index' && i + 1 < args.length) {
      caseIndex = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--labels' && i + 1 < args.length) {
      labelsFile = args[i + 1];
      i++;
    }
  }
  if (!repo || caseIndex < 0 || !labelsFile) {
    console.error('Usage: npx tsx runner_single_case.ts --repo <name> --case-index <idx> --labels <labels.json>');
    process.exit(1);
  }
  return { repo, caseIndex, labelsFile };
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

async function runSingleCase() {
  const { repo, caseIndex, labelsFile } = parseArgs();
  const labelsPath = path.resolve(labelsFile);
  const repoDir = path.resolve(process.cwd(), 'scripts/campaign/repos', repo);

  const labels: LabelCase[] = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const item = labels[caseIndex];

  if (!item) {
    console.error(`Case index ${caseIndex} out of bounds for ${repo}`);
    process.exit(1);
  }

  const startTime = Date.now();
  let actualVerdict = 'HARNESS_ERROR';
  let failureCause: string | null = null;
  let completeness = 'COMPLETE';
  let occurrenceCount: number | null = null;
  let derivation: any;
  let auditTrace: any;

  try {
    derivation = deriveRealDiffObligations(repoDir, item.parentSha, item.commitSha);
    if (derivation.status !== 'DERIVED') {
      actualVerdict = 'INVALID_CASE_INPUT';
      failureCause = derivation.reason;
    } else {
      const matching = derivation.obligations.filter((obligation: any) =>
        obligation.mutatedSymbol?.qualifiedName === item.targetSymbol &&
        obligation.mutatedSymbol?.declarationLocation.filePath.endsWith(`/${item.targetFile}`)
      );
      if (matching.length !== 1) {
        actualVerdict = 'LEGACY_CASE_REQUIRES_REAL_TARGET_DERIVATION';
        failureCause = `Frozen label did not identify exactly one real diff obligation (matches: ${matching.length}).`;
      } else {
        // Candidate state is used only after parent→candidate evidence has produced the obligation.
    execSync(`git -C "${repoDir}" checkout -f -q ${item.commitSha}`, { env: process.env, shell: process.env.ComSpec ?? 'cmd.exe', stdio: 'pipe' });
    const universe = RepositoryAnalysisUniverseBuilder.build({ workspaceRoot: repoDir });
    if (universe.discoveryStatus === 'DISCOVERY_FAILED') {
      actualVerdict = 'HARNESS_ERROR';
      completeness = 'DISCOVERY_FAILED';
      failureCause = 'Campaign could not initialize a candidate analysis universe.';
    } else {
      const context = new AnalysisContext(universe);
      const pipeline = new PipelineB();
      const proofResult = pipeline.execute(matching[0], { universe, context });

      actualVerdict = proofResult.verdict;
      completeness = (universe.discoveryStatus as string) ?? 'COMPLETE';
      auditTrace = proofResult.auditTrace;
      occurrenceCount = auditTrace?.consumers?.length ?? null;
      context.dispose();
    }
      }
    }
  } catch (err: any) {
    actualVerdict = 'CRASH';
    completeness = 'FAILED';
    failureCause = err?.message || String(err);
  }

  const durationMs = Date.now() - startTime;
  const match = actualVerdict === item.expectedVerdict;

  const resultRow = {
    repo,
    caseId: `${repo}:${item.commitSha.slice(0, 7)}`,
    commitSha: item.commitSha,
    parentSha: item.parentSha,
    targetSymbol: item.targetSymbol,
    targetFile: item.targetFile,
    campaignSchemaVersion: 'V32.9-TS-real-diff-audit-v1',
    runnerCommit: execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    expectedVerdict: item.expectedVerdict,
    actualVerdict,
    match,
    completeness,
    failureCause,
    occurrenceCount,
    derivation: derivation ? canonicalize(derivation) : null,
    sajimoraAuditTrace: auditTrace ? canonicalize(auditTrace) : null,
    durationMs
  };

  console.log(JSON.stringify(canonicalize(resultRow)));
}

runSingleCase().catch(err => {
  console.error('Fatal single case runner error:', err);
  process.exit(1);
});
