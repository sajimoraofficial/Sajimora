/**
 * @file JavaWildBaselineJ12.test.ts
 * Phase J-12 Empirical Baseline Evaluation Suite (200 Wild Java Commit Pairs).
 *
 * Enforces empirical acceptance gates on wild, diverse production repositories:
 * 1. Exactly 200 commit pairs evaluated across 4 archetypes.
 * 2. Certified Breaking False-Positive Rate: Strictly 0.0% (Zero unsound proofs on breaking code).
 * 3. Certified Unsound Negative Error Rate: Strictly 0.0% (Zero unsound proofs on compatible code).
 * 4. Total Soundness Errors: Exactly 0.
 * 5. Three-Outcome Matrix reporting (COMPATIBLE, INCOMPATIBLE, INCONCLUSIVE).
 * 6. Disqualification / UNKNOWN Taxonomy distribution quantification.
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import { JavaTypeIRExtractor } from '../../src/sajimora/languages/java/ir';
import {
  runWildTaxonomyProfiler,
  formatTaxonomyMarkdownReport
} from '../../../../scripts/campaign/run_wild_taxonomy_profiler';

console.log('--- Starting Java Phase J-12 Empirical Baseline Test Suite (200 Commit Pairs) ---');

const manifestPath = path.resolve(
  __dirname,
  '../../../../scripts/campaign/fixtures/wild_java_commit_pairs_200.json'
);

const summary = runWildTaxonomyProfiler(manifestPath);

console.log(formatTaxonomyMarkdownReport(summary));

// Verification of Acceptance Gates
assert.strictEqual(summary.totalEvaluatedCommitPairs, 200, 'Must evaluate exactly 200 commit pairs');
assert.strictEqual(summary.totalSoundnessErrors, 0, 'Must have zero soundness errors');
assert.strictEqual(summary.breakingUnsoundFalsePositives, 0, 'False positives on breaking code must be strictly 0');
assert.strictEqual(summary.compatibleUnsoundNegatives, 0, 'Unsound negative errors on compatible code must be strictly 0');
assert.strictEqual(summary.certifiedBreakingErrorRatePct, 0.0, 'Breaking error rate must be strictly 0.0%');
assert.strictEqual(summary.certifiedCompatibleErrorRatePct, 0.0, 'Compatible error rate must be strictly 0.0%');

// Qualification & Abstention Invariants
assert.strictEqual(summary.qualifiedCount, 110, 'Baseline qualification yield must be 110/200 (55.0%)');
assert.strictEqual(summary.retainedInAdvisoryCount, 90, 'Safe abstentions must be 90/200 (45.0%)');

// Taxonomy Invariants (Mutually exclusive categories reconciling exactly: 110 qualified + 90 abstained = 200)
assert.strictEqual(summary.taxonomyDistribution['NONE']?.count, 110, 'Directly qualified in F0 must be exactly 110');
assert.strictEqual(summary.taxonomyDistribution['DYNAMIC_GRADLE_BUILD_SCRIPT']?.count, 20, 'Expected 20 dynamic gradle blockers');
assert.strictEqual(summary.taxonomyDistribution['ANNOTATION_PROCESSOR_SYNTHETIC']?.count, 10, 'Expected 10 annotation processor blockers');
assert.strictEqual(summary.taxonomyDistribution['WILDCARD_IMPORT_AMBIGUITY']?.count, 10, 'Expected 10 wildcard ambiguity blockers');
assert.strictEqual(summary.taxonomyDistribution['DYNAMIC_REFLECTION_CONSTRUCT']?.count, 10, 'Expected 10 dynamic reflection blockers');
assert.strictEqual(summary.taxonomyDistribution['MODERN_JAVA_CONSTRUCT']?.count, 10, 'Expected 10 modern Java sealed blockers');
assert.strictEqual(summary.taxonomyDistribution['INCOMPLETE_MODULE_DESCRIPTOR']?.count, 10, 'Expected 10 incomplete module descriptor blockers');
assert.strictEqual(summary.taxonomyDistribution['EXTERNAL_CLASSPATH_MISSING']?.count, 20, 'Expected 20 external classpath missing blockers');

const totalTaxonomyCount = Object.values(summary.taxonomyDistribution).reduce((acc, v) => acc + v.count, 0);
assert.strictEqual(totalTaxonomyCount, 200, 'All taxonomy counts must sum to exactly 200');

// Regression Test: Private Interface Method Invariant (JLS §9.4)
// An interface method declaration with 'private' is NOT implicitly abstract.
// Adding a private method to an interface is fully backwards-compatible with existing consumers.
const { runJavaAnalysis } = require('../../../../scripts/sajimora/analyzeJava');
const interfacePrivateMethodResult = runJavaAnalysis({
  repoId: 'interface-private-method-test',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>test</artifactId></project>',
    'src/com/acme/Service.java': `package com.acme;
public interface Service {
  void execute();
}`
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>test</artifactId></project>',
    'src/com/acme/Service.java': `package com.acme;
public interface Service {
  void execute();
  private void internalHelper() {
    // helper logic
  }
}`
  },
  format: 'json'
});

assert.strictEqual(
  interfacePrivateMethodResult.qualification.qualificationStatus,
  'QUALIFIED_FOR_CERTIFIED_F0',
  'Private interface method must qualify for certified analysis'
);
assert.strictEqual(
  interfacePrivateMethodResult.reportJson.certifiedPanel.verifiedConclusion,
  'UNCERTIFIED',
  'Qualification cannot promote a legacy proof without independently checked source evidence'
);
assert.strictEqual(interfacePrivateMethodResult.reportJson.advisoryPanel.brokenCount, 0,
  'A private interface helper must not create an abstract implementation obligation (JLS §9.4)');
const parsedInterface = JavaTypeIRExtractor.parseJavaSource('Service.java',
  `package com.acme;
public interface Service {
  void execute();
  private void internalHelper() {}
}`);
const privateHelper = parsedInterface.classes[0].methods.find(method => method.name === 'internalHelper');
assert.ok(privateHelper, 'Private interface helper must remain in parsed evidence');
assert.strictEqual(privateHelper.visibility, 'private');
assert.strictEqual(privateHelper.isAbstract, false, 'Private interface helpers are not implicitly abstract');

console.log('\n--- Java Phase J-12 Empirical Baseline Test Suite: ALL GATES PASSED (200/200 + REGRESSIONS) ---');
