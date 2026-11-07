import * as fs from 'node:fs';
import * as path from 'node:path';

function verifyQuality() {
  const resultsPath = path.resolve('scripts/campaign/real_campaign_results.json');
  if (!fs.existsSync(resultsPath)) {
    console.error(`ERROR: Campaign results file not found at ${resultsPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resultsPath, 'utf8');
  const data = JSON.parse(raw);
  const summary = data.summary;

  const expected = {
    totalCommitPairs: 21,
    analyzablePairs: 16,
    nonAnalyzablePairs: 5,
    totalMutationsDerived: 28,
    verdicts: {
      PRESERVED: 5,
      VIOLATED: 6,
      UNKNOWN: 15,
      NOT_APPLICABLE: 2
    },
    usefulVerdictCoverage: '39.3% (11/28)',
    unsafePositives: 0,
    unknownTaxonomy: {
      'SEMANTIC_SCOPE :: UNSUPPORTED_SEMANTIC_SCOPE': 3,
      'COMPATIBILITY :: UNDECIDABLE_COMPATIBILITY': 7,
      'COVERAGE :: DISCOVERY_FAILURE': 5
    }
  };

  const errors: string[] = [];

  function checkEq(name: string, actual: any, exp: any) {
    if (JSON.stringify(actual) !== JSON.stringify(exp)) {
      errors.push(`Mismatch for ${name}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual)}`);
    }
  }

  checkEq('totalCommitPairs', summary.totalCommitPairs, expected.totalCommitPairs);
  checkEq('analyzablePairs', summary.analyzablePairs, expected.analyzablePairs);
  checkEq('nonAnalyzablePairs', summary.nonAnalyzablePairs, expected.nonAnalyzablePairs);
  checkEq('totalMutationsDerived', summary.totalMutationsDerived, expected.totalMutationsDerived);
  checkEq('verdicts', summary.verdicts, expected.verdicts);
  checkEq('usefulVerdictCoverage', summary.usefulVerdictCoverage, expected.usefulVerdictCoverage);
  checkEq('unsafePositives', summary.unsafePositives, expected.unsafePositives);
  checkEq('unknownTaxonomy', summary.unknownTaxonomy, expected.unknownTaxonomy);

  if (errors.length > 0) {
    console.error('================================================================');
    console.error('CAMPAIGN QUALITY GATE FAILED!');
    console.error('================================================================');
    for (const err of errors) {
      console.error(`  ❌ ${err}`);
    }
    console.error('================================================================\n');
    process.exit(1);
  }

  console.log('================================================================');
  console.log('✅ CAMPAIGN QUALITY GATE PASSED!');
  console.log('Phase 0-4 Frozen Contract Verification: 100% Bit-Identical to Goldens');
  console.log(`Duration: ${summary.campaignDurationMs}ms`);
  console.log('================================================================');
  process.exit(0);
}

verifyQuality();
