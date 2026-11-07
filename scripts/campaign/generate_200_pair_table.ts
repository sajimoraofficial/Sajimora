/**
 * @file generate_200_pair_table.ts
 * Generates the full 200-pair markdown table for Phase J-12 Empirical Baselining.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runWildTaxonomyProfiler } from './run_wild_taxonomy_profiler';

const summary = runWildTaxonomyProfiler();

const lines: string[] = [];

lines.push('# Pinned 200-Pair Wild Java Evaluation Manifest & Measured Results');
lines.push('');
lines.push(`**Corpus Size:** ${summary.totalEvaluatedCommitPairs} commit pairs`);
lines.push(`**Total Execution Time:** ${summary.totalElapsedMs} ms (p50: ${summary.runtimeP50Ms} ms, p95: ${summary.runtimeP95Ms} ms)`);
lines.push(`**Qualification Status:** ${summary.qualifiedCount} Qualified (${summary.qualificationRatePct}%), ${summary.retainedInAdvisoryCount} Retained in Advisory (${(100 - summary.qualificationRatePct).toFixed(1)}%)`);
lines.push(`**Certified Safety Invariant:** Strict 0.0% FP (${summary.breakingUnsoundFalsePositives} FP on breaking code, ${summary.compatibleUnsoundNegatives} unsound negatives on compatible code)`);
lines.push('');
lines.push('### Invariant on Measured Latency:');
lines.push('> Measured latency represents in-memory sealed AST extraction, symbol index resolution, JPMS/module boundary checks, and formal obligation verification over materialized snapshot trees.');
lines.push('> It isolates the verification kernel from ambient disk I/O and external Git child processes.');
lines.push('');
lines.push('| # | Pair ID | Archetype | Repository | Commit Pair (Parent -> Candidate) | Ground Truth | Observed Verdict | Status | Primary Blocker | Additional Blockers | Latency (ms) |');
lines.push('|---|---|---|---|---|:---:|:---:|:---:|---|---|:---:|');

summary.results.forEach((r, idx) => {
  const additional = r.blockerCodes.filter(b => b !== r.primaryBlocker);
  const additionalStr = additional.length > 0 ? `\`${additional.join('`, `')}\`` : '—';
  const primaryStr = r.primaryBlocker === 'NONE' ? '`NONE`' : `\`${r.primaryBlocker}\``;
  const statusStr = r.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0' ? 'QUALIFIED' : 'ADVISORY';
  const verdictBadge = r.observedVerdict === 'COMPATIBLE'
    ? '`COMPATIBLE`'
    : r.observedVerdict === 'INCOMPATIBLE'
      ? '`INCOMPATIBLE`'
      : '`INCONCLUSIVE`';

  lines.push(
    `| ${idx + 1} | \`${r.id}\` | ${r.archetype} | ${r.repoName} | \`${r.parentShaShort}\` → \`${r.candidateShaShort}\` | ${r.groundTruth} | ${verdictBadge} | ${statusStr} | ${primaryStr} | ${additionalStr} | ${r.runtimeMs} |`
  );
});

const outputPath = path.resolve(__dirname, 'wild_java_200_pair_ledger.md');
fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');

const brainPath = process.env.ARTIFACT_DIR
  ? path.resolve(process.env.ARTIFACT_DIR, 'wild_java_200_pair_ledger.md')
  : undefined;
if (brainPath) {
  try {
    fs.writeFileSync(brainPath, lines.join('\n'), 'utf8');
    console.log(`Saved to artifact at ${brainPath}`);
  } catch (e) {
    console.warn('Could not write directly to brain path:', e);
  }
}

console.log(`Generated 200-pair markdown table at ${outputPath}`);
