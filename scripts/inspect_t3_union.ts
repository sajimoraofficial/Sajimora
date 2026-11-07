import { TypeScriptProductionAdapter } from '../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { ProductionVerificationCore } from '../packages/core/src/sajimora/verification';
import { TypeScriptNumericWitnessChecker } from '../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';
import { getAllCoverageQueries } from './campaign/coverage_query_registry_v1';
import { buildRepository } from './campaign/semantic_coverage_campaign_support';

async function main() {
  const queries = getAllCoverageQueries();
  const query = queries.find(q => q.id === 'T3-UNION-002')!;
  console.log('Query:', query.id);

  const adapter = new TypeScriptProductionAdapter();
  const core = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
  core.registerAdapter(adapter);

  const repo = buildRepository(query.id, query.parentFiles, query.candidateFiles);
  const { ledger, authoritativeVerdict } = await core.verifyRepository(repo);

  const actualVerdict = authoritativeVerdict.verdict !== 'UNKNOWN'
    ? authoritativeVerdict.verdict
    : ledger.summary.unknown > 0
      ? 'UNKNOWN'
      : ledger.summary.violated > 0
        ? 'VIOLATED'
        : ledger.summary.preserved > 0
          ? 'PRESERVED'
          : ledger.summary.notApplicable > 0
            ? 'NOT_APPLICABLE'
            : 'UNKNOWN';

  console.log('Authoritative Verdict:', authoritativeVerdict.verdict);
  console.log('Resolved Actual Verdict:', actualVerdict);
  console.log('Expected Verdict:', query.expectedVerdict);
  console.log('MATCH:', actualVerdict === query.expectedVerdict);
  console.log('Ledger summary:', ledger.summary);
  for (const verdict of ledger.verdicts) {
    console.log('--- Verdict ---');
    console.log('obligationId:', verdict.obligationId);
    console.log('scope:', verdict.scope);
    console.log('outcome:', verdict.outcome);
    console.log('property:', verdict.property);
    console.log('evidence:', JSON.stringify(verdict.evidence, null, 2));
  }
}

main().catch(console.error);
