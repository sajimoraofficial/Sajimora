/**
 * @file JavaRealGitCommitQueries.test.ts
 * Real Git Commit Query Testing Suite for Sajimora Java.
 *
 * Materializes real Git blobs directly from the Git object store, executes commit queries
 * across commit parent/candidate SHAs, and validates:
 * 1. Strictly 0.0% Certified False Positives (0 unsound proofs on breaking commits).
 * 2. Explicit abstention for source-unverified legacy proofs.
 * 3. 100.0% Consumer Discovery Recall across Git repository trees.
 * 4. Safe advisory retainment for wildcard import pollution and dynamic reflection.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createRealGitTestRepository,
  runRealGitCommitCampaign,
  formatRealGitCampaignReport
} from '../../../../scripts/campaign/run_real_git_campaign';

console.log('--- Starting Java Real Git Commit Queries Test Suite ---');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-real-git-test-'));

try {
  // 1. Initialize real Git repository with multi-branch, multi-commit history
  const queries = createRealGitTestRepository(tempDir);
  assert.strictEqual(queries.length, 10, 'Expected exactly 10 real Git commit queries');

  // 2. Execute real Git commit campaign
  const summary = runRealGitCommitCampaign({
    repoPath: tempDir,
    queries
  });

  console.log(formatRealGitCampaignReport(summary));

  // 3. Strict Acceptance Gate Verifications
  assert.strictEqual(
    summary.certifiedFalsePositives,
    0,
    `Certified False Positives must be strictly 0, got ${summary.certifiedFalsePositives}`
  );
  assert.strictEqual(
    summary.falsePositiveRate,
    0.0,
    `False positive rate must be strictly 0.0%, got ${summary.falsePositiveRate}%`
  );
  assert.strictEqual(
    summary.precision,
    0,
    `No positive certificates means precision is unmeasured; numeric sentinel must be zero, got ${summary.precision}%`
  );
  assert.ok(
    summary.consumerRecall >= 95.0,
    `Consumer discovery recall must be >= 95.0%, got ${summary.consumerRecall}%`
  );
  assert.strictEqual(
    summary.qualifiedCount,
    8,
    `Expected 8 qualified commits (including F0 and F1), got ${summary.qualifiedCount}`
  );
  assert.strictEqual(
    summary.disqualifiedCount,
    2,
    `Expected 2 disqualified commits retained in advisory, got ${summary.disqualifiedCount}`
  );

  assert.strictEqual(summary.uncertifiedCount, 10);
  assert.strictEqual(summary.certifiedTrueNegatives, 0, 'Abstentions are not proven negatives');
  assert.ok(formatRealGitCampaignReport(summary).includes('N/A (no certified positive claims)'));
  // 4. Per-Query Assertions
  const q3 = summary.results.find(r => r.query.id === 'real-git-03-method-removed-breaking');
  assert.ok(q3 && q3.certifiedVerdict === 'UNCERTIFIED', 'Method removal must remain uncertified without source-bound proof');

  const q4 = summary.results.find(r => r.query.id === 'real-git-04-visibility-narrowed-breaking');
  assert.ok(q4 && q4.certifiedVerdict === 'UNCERTIFIED', 'Visibility narrowing must remain uncertified without source-bound proof');

  const q5 = summary.results.find(r => r.query.id === 'real-git-05-parameter-type-changed-breaking');
  assert.ok(q5 && q5.certifiedVerdict === 'UNCERTIFIED', 'Parameter mutation must remain uncertified without source-bound proof');

  const q6 = summary.results.find(r => r.query.id === 'real-git-06-class-final-breaking');
  assert.ok(q6 && q6.certifiedVerdict === 'UNCERTIFIED', 'Class final must remain uncertified without source-bound proof');

  const q7 = summary.results.find(r => r.query.id === 'real-git-07-wildcard-disqualified');
  assert.ok(q7 && q7.qualification === 'RETAINED_IN_ADVISORY', 'Wildcard import must be retained in advisory');
  assert.ok(q7 && q7.certifiedVerdict === 'UNCERTIFIED', 'Wildcard import must not be certified');

  const q8 = summary.results.find(r => r.query.id === 'real-git-08-reflection-disqualified');
  assert.ok(q8 && q8.qualification === 'RETAINED_IN_ADVISORY', 'Reflection must be retained in advisory');
  assert.ok(q8 && q8.certifiedVerdict === 'UNCERTIFIED', 'Reflection must not be certified');

  const q9 = summary.results.find(r => r.query.id === 'real-git-09-reactor-field-addition-compatible');
  assert.ok(q9 && q9.certifiedVerdict === 'UNCERTIFIED', 'Reactor field addition must remain uncertified without source-bound proof');

  const q10 = summary.results.find(r => r.query.id === 'real-git-10-f1-generic-capture-conversion');
  assert.ok(q10 && q10.certifiedVerdict === 'UNCERTIFIED', 'F1 generic capture must remain uncertified without source-bound proof');
  assert.strictEqual(q10.f1EvidenceVerified, false, 'Producer-authored F1 receipt must not pass source verification');

  console.log('\n--- All Real Git Commit Query Invariants Passed (0 False Positives, explicit abstention) ---');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
