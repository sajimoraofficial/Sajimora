import { createHash } from 'node:crypto';
import { TypeScriptNumericWitnessChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';
/**
 * @file TypeScriptProductionVerification.test.ts
 * Verifies the production TypeScript language adapter running on top of
 * the generic language-agnostic production verification core.
 */

import {
  GenericRepository,
  ProductionVerificationCore
} from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';

function createTypeScriptPriceRepository(): GenericRepository {
  const parentLib = `
export function price(x: number): number {
    return x * 2;
}
`;

  const candLib = `
export function price(x: number): number {
    return x * 200;
}
`;

  const appConsumer = `
import { price } from "./lib";
const total = price(10);
// Dynamic call
const dynObj: any = { price };
const key = "price";
dynObj[key]();
`;

  return {
    repositoryId: 'ts-price-repo',
    parentSnapshot: {
      snapshotId: 'commit-parent-price',
      rootIdentifier: '/',
      files: [
        { path: 'src/lib.ts', byteLength: parentLib.length, hash: createHash('sha256').update(parentLib).digest('hex') },
        { path: 'src/app.ts', byteLength: appConsumer.length, hash: createHash('sha256').update(appConsumer).digest('hex') }
      ],
      readTextFile: (p) => p === 'src/lib.ts' ? parentLib : p === 'src/app.ts' ? appConsumer : undefined,
      readBinaryFile: () => undefined
    },
    candidateSnapshot: {
      snapshotId: 'commit-cand-price',
      rootIdentifier: '/',
      files: [
        { path: 'src/lib.ts', byteLength: candLib.length, hash: createHash('sha256').update(candLib).digest('hex') },
        { path: 'src/app.ts', byteLength: appConsumer.length, hash: createHash('sha256').update(appConsumer).digest('hex') }
      ],
      readTextFile: (p) => p === 'src/lib.ts' ? candLib : p === 'src/app.ts' ? appConsumer : undefined,
      readBinaryFile: () => undefined
    }
  };
}

async function runTypeScriptProductionTests() {
  console.log('--- Running TypeScript Production Adapter & Core Integration Tests ---');

  const repo = createTypeScriptPriceRepository();
  const adapter = new TypeScriptProductionAdapter();
  const core = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
  core.registerAdapter(adapter);

  const { ledger, authoritativeVerdict } = await core.verifyRepository(repo);

  console.log(`Repository Verification Complete:`);
  console.log(`- Ledger ID: ${ledger.ledgerId}`);
  console.log(`- Total Obligations: ${ledger.summary.total}`);
  console.log(`- Preserved: ${ledger.summary.preserved}`);
  console.log(`- Violated: ${ledger.summary.violated}`);
  console.log(`- Unknown: ${ledger.summary.unknown}`);
  console.log(`- Silent Drops: ${ledger.conservationReport.silentDropsCount}`);
  console.log(`- Conservation Satisfied: ${ledger.conservationReport.conservationSatisfied}`);
  console.log(`- Authoritative Verdict: ${authoritativeVerdict.verdict}`);

  // Invariant Verification 1: Zero Silent Drops
  if (ledger.conservationReport.silentDropsCount !== 0) {
    throw new Error(`Conservation failed! Silent drops: ${ledger.conservationReport.silentDropsCount}`);
  }
  if (!ledger.conservationReport.conservationSatisfied) {
    throw new Error('Conservation was not satisfied');
  }
  console.log('✓ Invariant 1 verified: Zero silent drops across all static references and dynamic boundaries.');

  // Invariant Verification 2: Behavioral Divergence Correctly Caught (Never BEHAVIOR_PRESERVED on x * 2 vs x * 200)
  const behaviorVerdict = ledger.verdicts.find(v => v.property === 'BEHAVIOR');
  if (!behaviorVerdict) {
    throw new Error('Expected BEHAVIOR obligation to be generated!');
  }
  if (behaviorVerdict.outcome !== 'VIOLATED') {
    throw new Error(`Expected BEHAVIOR obligation to be VIOLATED due to operational divergence, got ${behaviorVerdict.outcome}`);
  }
  if (behaviorVerdict.assurance !== 'WITNESS' && behaviorVerdict.assurance !== 'F0_FORMAL') {
    throw new Error(`Expected WITNESS/F0_FORMAL assurance, got ${behaviorVerdict.assurance}`);
  }
  console.log('✓ Invariant 2 verified: price(x) mutation from x * 2 to x * 200 was certified VIOLATED via operational witness, NOT falsely marked PRESERVED.');

  // Invariant Verification 3: Consumer Type Compatibility is TYPE_PRESERVED
  const consumerTypeVerdict = ledger.verdicts.find(v =>
    v.property === 'CONSUMER_TYPE' && v.provenance.referenceId?.startsWith('ref_STATIC_CALL_')
  );
  if (!consumerTypeVerdict) {
    throw new Error('Expected CONSUMER_TYPE obligation to be generated!');
  }
  if (consumerTypeVerdict.outcome !== 'PRESERVED' || consumerTypeVerdict.assurance !== 'COMPILER_STATIC') {
    throw new Error(`Expected CONSUMER_TYPE to be COMPILER_STATIC PRESERVED, got ${consumerTypeVerdict.outcome}`);
  }
  console.log('✓ Invariant 3 verified: Consumer call site price(10) compiles cleanly and is certified TYPE_PRESERVED (not behavior).');

  const importBindingVerdict = ledger.verdicts.find(v =>
    v.provenance.referenceId?.startsWith('ref_STATIC_IMPORT_')
  );
  if (!importBindingVerdict || importBindingVerdict.outcome !== 'PRESERVED' || importBindingVerdict.assurance !== 'COMPILER_STATIC') {
    throw new Error('Expected the named import binding to be specialized as COMPILER_STATIC PRESERVED.');
  }
  console.log('✓ Invariant 3b verified: named import binding is evaluated independently from call compatibility.');

  // Invariant Verification 4: Dynamic Reference Boundary
  const dynamicVerdict = ledger.verdicts.find(v => v.property === 'RESOLUTION');
  if (!dynamicVerdict) {
    throw new Error('Expected RESOLUTION obligation for dynamic index access!');
  }
  if (dynamicVerdict.outcome !== 'UNKNOWN' || dynamicVerdict.assurance !== 'UNRESOLVED') {
    throw new Error(`Expected UNRESOLVED UNKNOWN for dynObj[key](), got ${dynamicVerdict.outcome}`);
  }
  if (!dynamicVerdict.evidence.unresolvedBoundary?.remediation) {
    throw new Error('Expected remediation advice for unresolved dynamic boundary!');
  }
  console.log(`✓ Invariant 4 verified: dynObj[key]() captured as explicit UNKNOWN with remediation: "${dynamicVerdict.evidence.unresolvedBoundary.remediation.suggestion}"`);

  // Invariant Verification 5: Authoritative Verdict Gate
  if (authoritativeVerdict.verdict !== 'VIOLATED') {
    throw new Error(`Expected Authoritative verdict to be VIOLATED due to behavioral divergence, got ${authoritativeVerdict.verdict}`);
  }
  console.log('✓ Invariant 5 verified: Production certification issued VIOLATED from the routed behavioral witness.');

  console.log('\nAll TypeScript Production Adapter & Core Integration Tests PASSED!');
}

runTypeScriptProductionTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

