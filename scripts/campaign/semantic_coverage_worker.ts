/**
 * @file semantic_coverage_worker.ts
 * Worker thread execution for Sajimora TypeScript Semantic Coverage Campaign.
 */

import { parentPort } from 'node:worker_threads';
import { ProductionVerificationCore } from '../../packages/core/src/sajimora/verification';
import { TypeScriptProductionAdapter } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { TypeScriptNumericWitnessChecker } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';
import { CoverageQuery, CoverageResult } from './coverage_types';
import { buildRepository, exactVerdictMatch } from './semantic_coverage_campaign_support';

if (!parentPort) {
  throw new Error('semantic_coverage_worker must be spawned as a Worker');
}

const adapter = new TypeScriptProductionAdapter();
const core = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
core.registerAdapter(adapter);

async function runQuery(query: CoverageQuery): Promise<CoverageResult> {
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
    const duration = Date.now() - startTime;

    return {
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
    };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    return {
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
    };
  }
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'RUN') {
    const result = await runQuery(msg.query);
    parentPort!.postMessage({ type: 'RESULT', index: msg.index, result });
  } else if (msg.type === 'EXIT') {
    process.exit(0);
  }
});

parentPort.postMessage({ type: 'READY' });
