/**
 * validate_case_a_bridge.ts
 *
 * Targeted validation for the Case-A ID-bridge fix in PipelineB.ts.
 * Runs Q3, Q5, Q7, Q9, Q11, Q17 only.
 *
 * For each query logs:
 *   [BRIDGE] obligationId, normFile, localName, matchedDeclCount, resolvedId, mappingCount
 *   finalVerdict, authorityGate, authorityReason
 *
 * Does NOT run Q22/Q26 (Case-B) or the full 28-query campaign.
 */

// Enable bridge debug logging BEFORE any module load.
process.env['SAJIMORA_BRIDGE_DEBUG'] = '1';

import * as path from 'node:path';
import { evaluateCommitPair } from './campaign_runner';

interface QuerySpec {
  label: string;
  repoName: string;
  repoPath: string;
  dependencyRoot: string;
  parentSha: string;
  candidateSha: string;
  subject: string;
}

const REPO_ROOT = path.resolve('scripts/campaign/repos');

const targets: QuerySpec[] = [
  {
    label: 'Q3 ($ZodEnum / $ZodLiteral)',
    repoName: 'zod',
    repoPath: path.join(REPO_ROOT, 'zod'),
    dependencyRoot: path.join(REPO_ROOT, 'zod', 'node_modules'),
    parentSha: 'f83ab51129038a2f868ee11dda906ed78ae2e478',
    candidateSha: '84dd3b0fc6cb5a24f773cb6db66bc934338b44ea',
    subject: 'perf: build literal and enum pattern regexes lazily (#6531)',
  },
  {
    label: 'Q5 (toZod)',
    repoName: 'zod',
    repoPath: path.join(REPO_ROOT, 'zod'),
    dependencyRoot: path.join(REPO_ROOT, 'zod', 'node_modules'),
    parentSha: '319f47f44f40755773a9aa83b6fdaaad1ff01d77',
    candidateSha: 'a2a019a57e4444f61bf677ca79c1352823e2b7c8',
    subject: 'Accept enum-typed targets in z.toZod (#6528)',
  }
];

const PASS = '\u2705';
const FAIL = '\u274c';
const WARN = '\u26a0\ufe0f';

async function main(): Promise<void> {
  console.log('='.repeat(70));
  console.log('Case-A ID-Bridge Targeted Validation  (Q3 Q5 Q7 Q9 Q11 Q17)');
  console.log('='.repeat(70));

  let totalEvals = 0;
  let identityUnblocked = 0;
  let newPositives = 0;

  for (const spec of targets) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[${spec.label}]`);
    console.log(`  ${spec.repoName}  ${spec.parentSha.slice(0, 8)}..${spec.candidateSha.slice(0, 8)}`);
    console.log(`  ${spec.subject}`);
    console.log('');

    let result: ReturnType<typeof evaluateCommitPair>;
    try {
      result = evaluateCommitPair(
        spec.repoName,
        spec.repoPath,
        spec.parentSha,
        spec.candidateSha,
        spec.subject,
        spec.dependencyRoot,
        { enableProgramReuse: false }
      );
    } catch (err: any) {
      console.error(`  ${FAIL} EXCEPTION: ${err?.message ?? err}`);
      continue;
    }

    if (!result.analyzable) {
      console.log(`  ${WARN} Not analyzable: ${result.nonAnalyzableReason}`);
      continue;
    }

    for (const ev of result.evaluations) {
      totalEvals++;
      const identityBlocked =
        ev.authorityGate === 'IDENTITY' && ev.authorityReason === 'UNCERTAIN_IDENTITY';
      if (!identityBlocked) identityUnblocked++;
      if (ev.isUnsafePositive) newPositives++;

      const statusIcon = identityBlocked ? FAIL : (ev.verdict === 'PRESERVED' || ev.verdict === 'VIOLATED' ? PASS : WARN);
      console.log(`  ${statusIcon} ${ev.targetSymbol} (${ev.targetKind})`);
      console.log(`       file:    ${ev.targetFile}`);
      console.log(`       verdict: ${ev.verdict}`);
      console.log(`       gate:    ${ev.authorityGate ?? '—'}  reason: ${ev.authorityReason ?? '—'}`);
      console.log(`       consumers evaluated: ${ev.evaluatedConsumerCount ?? 0}`);
      if (ev.isUnsafePositive) console.log(`       ${FAIL} UNSAFE POSITIVE`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('RESULTS');
  console.log(`  Evaluations run:           ${totalEvals}`);
  console.log(`  No longer IDENTITY-blocked: ${identityUnblocked} / ${totalEvals}`);
  console.log(`  Still IDENTITY-blocked:     ${totalEvals - identityUnblocked} / ${totalEvals}`);
  console.log(`  Unsafe positives:           ${newPositives}`);
  console.log('');

  const clean = newPositives === 0;
  const improved = identityUnblocked > 0;
  console.log(clean && improved ? `${PASS} Acceptance: PASS` : `${FAIL} Acceptance: FAIL`);
  if (!clean) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
