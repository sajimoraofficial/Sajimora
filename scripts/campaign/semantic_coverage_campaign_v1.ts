import { TypeScriptNumericWitnessChecker } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';
/**
 * @file semantic_coverage_campaign_v1.ts
 * Sajimora TypeScript Semantic Coverage Campaign v1
 * 
 * Master execution harness for the 911 queries specified in
 * Semantic Coverage Specification v1.
 * 
 * Usage:
 *   # Validate all 911 queries (dry run)
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/semantic_coverage_campaign_v1.ts --dry-run
 * 
 *   # Export all 911 queries to JSON
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/semantic_coverage_campaign_v1.ts --export-json
 * 
 *   # Run specific tier or limit
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/semantic_coverage_campaign_v1.ts --tier=1 --limit=10
 * 
 *   # Run single query by ID
 *   node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/semantic_coverage_campaign_v1.ts --query=T1-SIG-001
 * 
 * Output: ./semantic_coverage_results_v1.json
 */

import { ProductionVerificationCore } from '../../packages/core/src/sajimora/verification';
import { TypeScriptProductionAdapter } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import {
  CoverageQuery,
  CoverageResult,
  getAllCoverageQueries,
  getCoverageStats
} from './coverage_query_registry_v1';
import { buildRepository, exactVerdictMatch, safeTimestamp, validateQueries } from './semantic_coverage_campaign_support';

// ─── Query Retrieval ────────────────────────────────────────────────────────

function generateAllQueries(): CoverageQuery[] {
  return getAllCoverageQueries();
}

// ─── Campaign Runner ─────────────────────────────────────────────────────────

async function runCampaign() {
  const args = process.argv.slice(2);
  const tierArg = args.find(a => a.startsWith('--tier='));
  const levelArg = args.find(a => a.startsWith('--level='));
  const familyArg = args.find(a => a.startsWith('--family='));
  const limitArg = args.find(a => a.startsWith('--limit='));
  const offsetArg = args.find(a => a.startsWith('--offset='));
  const queryArg = args.find(a => a.startsWith('--query='));
  const dryRun = args.includes('--dry-run');
  const exportJson = args.includes('--export-json');
  const outputArg = args.find(a => a.startsWith('--output='));
  const overwrite = args.includes('--overwrite');
  const concurrencyArg = args.find(a => a.startsWith('--concurrency=') || a.startsWith('-j='));
  const concurrency = concurrencyArg ? Math.max(1, parseInt(concurrencyArg.split('=')[1], 10)) : 1;

  let queries = generateAllQueries();

  if (tierArg) {
    const tier = parseInt(tierArg.split('=')[1], 10);
    queries = queries.filter(q => q.tier === tier);
  }
  if (levelArg) {
    const level = levelArg.split('=')[1];
    queries = queries.filter(q => q.level === level);
  }
  if (familyArg) {
    const family = familyArg.split('=')[1];
    queries = queries.filter(q => q.family === family);
  }
  if (queryArg) {
    const qid = queryArg.split('=')[1];
    queries = queries.filter(q => q.id === qid);
  }
  if (offsetArg) {
    const offset = parseInt(offsetArg.split('=')[1], 10);
    queries = queries.slice(offset);
  }
  if (limitArg) {
    const limit = parseInt(limitArg.split('=')[1], 10);
    queries = queries.slice(0, limit);
  }

  const stats = getCoverageStats();
  const allQueries = generateAllQueries();
  const allValidation = validateQueries(allQueries, 911);
  const selectionValidation = queries === allQueries ? allValidation : validateQueries(queries);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  Sajimora TypeScript Semantic Coverage Campaign v1`);
  console.log(`  Total available queries in registry: ${stats.total}`);
  console.log(`  Queries selected for execution:     ${queries.length}`);
  console.log(`  Tier Breakdown: T1:${stats.tierCounts[1] || 0} T2:${stats.tierCounts[2] || 0} T3:${stats.tierCounts[3] || 0} T4:${stats.tierCounts[4] || 0} T5:${stats.tierCounts[5] || 0} T6:${stats.tierCounts[6] || 0}`);
  console.log(`  Level Breakdown: L1:${stats.levelCounts['L1_SINGLE'] || 0} L2:${stats.levelCounts['L2_PAIRWISE'] || 0} L3:${stats.levelCounts['L3_THREE_WAY'] || 0} L4:${stats.levelCounts['L4_FOUR_WAY'] || 0} L5:${stats.levelCounts['L5_HIGH_RISK'] || 0}`);
  console.log(`${'═'.repeat(72)}\n`);

  if (queries.length === 0) {
    console.error('  VALIDATION FAILED: query selection is empty.');
    process.exitCode = 2;
    return;
  }
  if (!allValidation.valid || !selectionValidation.valid) {
    const failures = [...new Set([...allValidation.errors, ...selectionValidation.errors])];
    console.error(`  VALIDATION FAILED (${failures.length} errors)`);
    failures.slice(0, 50).forEach(error => console.error(`    - ${error}`));
    if (failures.length > 50) console.error(`    ... ${failures.length - 50} more`);
    process.exitCode = 2;
    return;
  }

  if (exportJson) {
    const fs = await import('fs');
    fs.writeFileSync('semantic_coverage_queries_911.json', JSON.stringify({
      version: '1.0.0',
      total: queries.length,
      queries
    }, null, 2));
    console.log(`  Exported ${queries.length} queries to semantic_coverage_queries_911.json\n`);
    return;
  }

  if (dryRun) {
    console.log(`  [DRY-RUN] Structurally and syntactically validated ${queries.length} queries.`);
    console.log(`  Unique IDs: ${selectionValidation.uniqueIds}`);
    console.log(`  Query-set SHA-256: ${selectionValidation.querySetDigest}`);
    selectionValidation.warnings.forEach(warning => console.log(`  WARNING: ${warning}`));
    console.log(`  Dry-run does not execute compiler semantics or validate expected verdict oracles.\n`);
    return;
  }

  const results: CoverageResult[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  if (concurrency > 1 && queries.length > 1) {
    const { Worker } = await import('node:worker_threads');
    const path = await import('node:path');
    const workerScript = path.resolve(__dirname, 'semantic_coverage_worker.cjs');

    let nextIndex = 0;
    let completedCount = 0;
    const workerCount = Math.min(concurrency, queries.length);
    console.log(`  Spawning ${workerCount} parallel worker threads for execution...`);

    results.length = queries.length;

    await new Promise<void>((resolve, reject) => {
      let activeWorkers = workerCount;

      for (let w = 0; w < workerCount; w++) {
        const worker = new Worker(workerScript);

        const dispatchNext = () => {
          if (nextIndex < queries.length) {
            const idx = nextIndex++;
            worker.postMessage({ type: 'RUN', index: idx, query: queries[idx] });
          } else {
            worker.postMessage({ type: 'EXIT' });
          }
        };

        worker.on('message', (msg: any) => {
          if (msg.type === 'READY') {
            dispatchNext();
          } else if (msg.type === 'RESULT') {
            const { index, result } = msg;
            results[index] = result;
            if (result.match) passed++; else if (result.actualVerdict === 'ERROR') errors++; else failed++;
            completedCount++;
            const icon = result.match ? '✓' : (result.actualVerdict === 'ERROR' ? '!' : '✗');
            console.log(`  ${icon} [${String(completedCount).padStart(3)}/${queries.length}] ${result.id}: expected=${result.expectedVerdict} actual=${result.actualVerdict} (${result.durationMs}ms)`);
            dispatchNext();
          }
        });

        worker.on('error', (err) => {
          console.error(`Worker error:`, err);
          reject(err);
        });

        worker.on('exit', () => {
          activeWorkers--;
          if (activeWorkers === 0) {
            resolve();
          }
        });
      }
    });
  } else {
    const adapter = new TypeScriptProductionAdapter();
    const core = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
    core.registerAdapter(adapter);

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const startTime = Date.now();

      try {
        const repo = buildRepository(query.id, query.parentFiles, query.candidateFiles);
        const { ledger, authoritativeVerdict } = await core.verifyRepository(repo);

        const actualVerdict = authoritativeVerdict.verdict !== 'UNKNOWN'
          ? authoritativeVerdict.verdict
          : ledger.summary.violated > 0
            ? 'VIOLATED'
            : ledger.summary.unknown > 0
              ? 'UNKNOWN'
              : ledger.summary.preserved > 0
                ? 'PRESERVED'
                : ledger.summary.notApplicable > 0
                  ? 'NOT_APPLICABLE'
                  : 'UNKNOWN';
        const certStatus = ledger.certificationStatus;

        const match = exactVerdictMatch(query.expectedVerdict, actualVerdict);

        if (match) passed++; else failed++;

        const duration = Date.now() - startTime;
        const icon = match ? '✓' : '✗';
        console.log(`  ${icon} [${String(i + 1).padStart(3)}/${queries.length}] ${query.id}: expected=${query.expectedVerdict} actual=${actualVerdict} (${duration}ms)`);

        results.push({
          id: query.id,
          tier: query.tier,
          level: query.level,
          family: query.family,
          features: query.features,
          expectedVerdict: query.expectedVerdict,
          actualVerdict,
          certificationStatus: certStatus,
          match,
          verdictDetails: {
            totalObligations: ledger.summary.total,
            preserved: ledger.summary.preserved,
            violated: ledger.summary.violated,
            unknown: ledger.summary.unknown,
            notApplicable: ledger.summary.notApplicable
          },
          conservation: {
            generatedObligations: ledger.conservationReport.generatedObligationsCount,
            accountedObligations: ledger.conservationReport.accountedObligationsCount,
            unaccountedObligations: ledger.conservationReport.unaccountedObligationIds.length,
            silentDrops: ledger.conservationReport.silentDropsCount,
            satisfied: ledger.conservationReport.conservationSatisfied
          },
          discovery: {
            candidateReferences: ledger.discoveryAccounting?.candidateReferencesDiscovered ?? 0,
            confirmedConsumers: ledger.discoveryAccounting?.confirmedConsumers ?? 0,
            unresolvedPotentialConsumers: ledger.discoveryAccounting?.unresolvedPotentialConsumers ?? 0
          },
          environmentFailures: Object.fromEntries((ledger.environmentFailures || []).reduce((counts, failure) => {
            counts.set(failure.taxonomyCode, (counts.get(failure.taxonomyCode) || 0) + 1);
            return counts;
          }, new Map<string, number>())),
          durationMs: duration
        });
      } catch (err: any) {
        errors++;
        const duration = Date.now() - startTime;
        console.error(`  ! [${String(i + 1).padStart(3)}/${queries.length}] ${query.id}: ERROR — ${err.message} (${duration}ms)`);
        results.push({
          id: query.id,
          tier: query.tier,
          level: query.level,
          family: query.family,
          features: query.features,
          expectedVerdict: query.expectedVerdict,
          actualVerdict: 'ERROR',
          match: false,
          verdictDetails: { totalObligations: 0, preserved: 0, violated: 0, unknown: 0, notApplicable: 0 },
          error: err.message,
          durationMs: duration
        });
      }
    }
  }

  // ─── Summary Report ────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  CAMPAIGN RESULTS SUMMARY`);
  console.log(`${'═'.repeat(72)}`);
  console.log(`  Total Queries:  ${queries.length}`);
  console.log(`  Passed:         ${passed} (${((passed / queries.length) * 100).toFixed(1)}%)`);
  console.log(`  Failed:         ${failed} (${((failed / queries.length) * 100).toFixed(1)}%)`);
  console.log(`  Errors:         ${errors} (${((errors / queries.length) * 100).toFixed(1)}%)`);

  // Per-tier breakdown
  const tiers = [1, 2, 3, 4, 5, 6];
  console.log(`\n  Per-Tier Breakdown:`);
  for (const tier of tiers) {
    const tierResults = results.filter(r => r.tier === tier);
    if (tierResults.length === 0) continue;
    const tierPassed = tierResults.filter(r => r.match).length;
    console.log(`    Tier ${tier}: ${tierPassed}/${tierResults.length} passed (${((tierPassed / tierResults.length) * 100).toFixed(1)}%)`);
  }

  // Per-family breakdown
  const families = [...new Set(results.map(r => r.family))];
  console.log(`\n  Per-Family Breakdown:`);
  for (const family of families) {
    const famResults = results.filter(r => r.family === family);
    const famPassed = famResults.filter(r => r.match).length;
    console.log(`    ${family}: ${famPassed}/${famResults.length} passed`);
  }

  // Failed queries detail
  const failedQueries = results.filter(r => !r.match);
  if (failedQueries.length > 0) {
    console.log(`\n  FAILED QUERIES (first 20):`);
    for (const fq of failedQueries.slice(0, 20)) {
      console.log(`    ${fq.id}: expected=${fq.expectedVerdict} actual=${fq.actualVerdict} features=[${fq.features.join(',')}]${fq.error ? ` error=${fq.error.slice(0, 80)}` : ''}`);
    }
  }

  // Write results
  const scope = queryArg ? queryArg.split('=')[1] : tierArg ? `tier-${tierArg.split('=')[1]}` : queries.length === 911 ? 'all-911' : `subset-${queries.length}`;
  const outputPath = outputArg?.slice('--output='.length) || `semantic_coverage_results_v1.${scope}.${safeTimestamp()}.json`;
  const verdicts = ['PRESERVED', 'VIOLATED', 'UNKNOWN', 'NOT_APPLICABLE', 'ERROR'];
  const actualVerdictCounts = Object.fromEntries(verdicts.map(verdict => [verdict, results.filter(result => result.actualVerdict === verdict).length]));
  const expectedVerdictCounts = Object.fromEntries(verdicts.slice(0, 4).map(verdict => [verdict, results.filter(result => result.expectedVerdict === verdict).length]));
  const confusionMatrix = Object.fromEntries(verdicts.slice(0, 4).map(expected => [expected, Object.fromEntries(verdicts.map(actual => [actual, results.filter(result => result.expectedVerdict === expected && result.actualVerdict === actual).length]))]));
  const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] : 0;
  const output = {
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    querySetDigest: selectionValidation.querySetDigest,
    selection: { tier: tierArg?.split('=')[1] ?? null, level: levelArg?.split('=')[1] ?? null, family: familyArg?.split('=')[1] ?? null, query: queryArg?.split('=')[1] ?? null, offset: offsetArg?.split('=')[1] ?? null, limit: limitArg?.split('=')[1] ?? null },
    validation: { warnings: selectionValidation.warnings, duplicatePayloadGroups: selectionValidation.duplicatePayloadGroups, unchangedSnapshotIds: selectionValidation.unchangedSnapshotIds },
    summary: {
      total: queries.length,
      passed,
      failed,
      errors,
      passRate: queries.length ? ((passed / queries.length) * 100).toFixed(1) + '%' : '0.0%',
      exactVerdictMatching: true,
      expectedVerdictCounts,
      actualVerdictCounts,
      confusionMatrix,
      latencyMs: { total: durations.reduce((sum, duration) => sum + duration, 0), mean: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : 0, p50: percentile(0.5), p95: percentile(0.95), max: durations.at(-1) ?? 0 },
      conservation: {
        generatedObligations: results.reduce((sum, result) => sum + (result.conservation?.generatedObligations || 0), 0),
        accountedObligations: results.reduce((sum, result) => sum + (result.conservation?.accountedObligations || 0), 0),
        unaccountedObligations: results.reduce((sum, result) => sum + (result.conservation?.unaccountedObligations || 0), 0),
        silentDrops: results.reduce((sum, result) => sum + (result.conservation?.silentDrops || 0), 0),
        failedQueries: results.filter(result => result.conservation && !result.conservation.satisfied).length
      },
      discovery: {
        candidateReferences: results.reduce((sum, result) => sum + (result.discovery?.candidateReferences || 0), 0),
        confirmedConsumers: results.reduce((sum, result) => sum + (result.discovery?.confirmedConsumers || 0), 0),
        unresolvedPotentialConsumers: results.reduce((sum, result) => sum + (result.discovery?.unresolvedPotentialConsumers || 0), 0)
      }
    },
    tierBreakdown: Object.fromEntries(tiers.filter(t => results.some(r => r.tier === t)).map(t => {
      const tr = results.filter(r => r.tier === t);
      return [t, { total: tr.length, passed: tr.filter(r => r.match).length }];
    })),
    results
  };

  const fs = await import('fs');
  if (fs.existsSync(outputPath) && !overwrite) {
    console.error(`Refusing to overwrite existing result file: ${outputPath}. Use --overwrite or choose --output=<path>.`);
    process.exitCode = 2;
    return;
  }
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n  Results written to: ${outputPath}`);
  console.log(`${'═'.repeat(72)}\n`);

  if (failed > 0 || errors > 0) {
    process.exit(1);
  }
}

runCampaign().catch(err => {
  console.error('Campaign failed:', err);
  process.exit(1);
});
