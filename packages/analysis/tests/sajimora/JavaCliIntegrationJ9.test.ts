/**
 * @file JavaCliIntegrationJ9.test.ts
 * Test suite for Phase J-9 (CLI & Two-Panel Reporting Integration).
 *
 * Verifies that:
 * 1. Programmatic runJavaAnalysis generates formatted two-panel text reports.
 * 2. Markdown two-panel reports format correctly with table representations.
 * 3. Machine-readable JSON output conforms strictly to SAJIMORA_JAVA_ANALYSIS_V1 schema.
 * 4. Automatic profile selection (Certified F0 for clean repos vs Advisory fallback for wildcards/dynamic scripts).
 * 5. Safety Invariant: Advisory findings never upgrade uncertified results to PRESERVED.
 */

import * as assert from 'node:assert';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';
import { JavaTwoPanelReport } from '../../src/sajimora/advisory/JavaTwoPanelReport';

console.log('--- Starting Java Phase J-9 Test Suite (CLI & Two-Panel Reporting) ---');

// --------------------------------------------------------------------------
// TEST 1: Two-Panel Text Report Generation
// --------------------------------------------------------------------------
console.log('Running Test 1: Two-Panel Text Report Generation...');
{
  const historicalFiles = {
    'pom.xml': `
      <project>
        <groupId>com.acme</groupId>
        <artifactId>order-service</artifactId>
        <version>1.0.0</version>
      </project>
    `,
    'src/main/java/com/acme/OrderService.java': `
      package com.acme;
      public class OrderService {
        public void processOrder(String orderId) {}
      }
    `,
    'src/main/java/com/acme/OrderController.java': `
      package com.acme;
      import com.acme.OrderService;
      public class OrderController {
        private OrderService service;
        public void handle() {
          service.processOrder("123");
        }
      }
    `
  };

  // Candidate: method removed
  const candidateFiles = {
    'pom.xml': historicalFiles['pom.xml'],
    'src/main/java/com/acme/OrderService.java': `
      package com.acme;
      public class OrderService {}
    `,
    'src/main/java/com/acme/OrderController.java': historicalFiles['src/main/java/com/acme/OrderController.java']
  };

  const result = runJavaAnalysis({
    repoId: 'acme-order-system',
    historicalFiles,
    candidateFiles,
    format: 'two-panel'
  });

  assert.ok(result.reportText.includes('SAJIMORA JAVA TWO-PANEL REPORT'));
  assert.ok(result.reportText.includes('PANEL 1: JAVA PROOF VERIFICATION STATUS'));
  assert.ok(result.reportText.includes('PANEL 2: ADVISORY IMPACT ANALYSIS'));
  assert.ok(result.reportText.includes('Breaking Consumers'));
  assert.strictEqual(result.qualification.qualificationStatus, 'QUALIFIED_FOR_CERTIFIED_F0');

  console.log('✓ Test 1 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 2: Two-Panel Markdown Formatting
// --------------------------------------------------------------------------
console.log('Running Test 2: Two-Panel Markdown Formatting...');
{
  const historicalFiles = {
    'src/com/acme/Service.java': 'package com.acme; public class Service { public void run() {} }'
  };
  const candidateFiles = {
    'src/com/acme/Service.java': 'package com.acme; public class Service { public void run() {} }'
  };

  const result = runJavaAnalysis({
    repoId: 'acme-markdown-test',
    historicalFiles,
    candidateFiles,
    format: 'markdown'
  });

  assert.ok(result.reportMarkdown.includes('# Sajimora Java Two-Panel Analysis Report'));
  assert.ok(result.reportMarkdown.includes('### Panel 1: Java Proof Verification Status'));
  assert.ok(!result.reportMarkdown.includes('100% Mathematical Soundness'));
  assert.ok(result.reportMarkdown.includes('Proof Blocker'));
  assert.ok(result.reportMarkdown.includes('### Panel 2: Advisory Impact Analysis'));
  assert.ok(result.reportMarkdown.includes('Effective Verdict:'));

  console.log('✓ Test 2 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 3: Machine-Readable JSON Schema (SAJIMORA_JAVA_ANALYSIS_V1)
// --------------------------------------------------------------------------
console.log('Running Test 3: Machine-Readable JSON Schema Emission...');
{
  const historicalFiles = {
    'src/com/acme/Calc.java': 'package com.acme; public class Calc { public int add(int a, int b) { return a + b; } }'
  };
  const candidateFiles = {
    'src/com/acme/Calc.java': 'package com.acme; public class Calc { public int add(int a, int b) { return a + b; } }'
  };

  const result = runJavaAnalysis({
    repoId: 'acme-json-test',
    historicalFiles,
    candidateFiles,
    format: 'json'
  });

  const json = result.reportJson;
  assert.strictEqual(json.schemaVersion, 'SAJIMORA_JAVA_ANALYSIS_V1');
  assert.strictEqual(json.repositoryId, 'acme-json-test');
  assert.ok(typeof json.timestamp === 'string');
  assert.ok(json.qualification);
  assert.ok(json.certifiedPanel);
  assert.ok(json.advisoryPanel);
  assert.strictEqual(json.qualification.status, 'QUALIFIED_FOR_CERTIFIED_F0');

  console.log('✓ Test 3 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 4: Auto-Selection: Certified F0 vs Advisory Fallback
// --------------------------------------------------------------------------
console.log('Running Test 4: Auto-Selection (F0 vs Advisory Fallback)...');
{
  // 4a: Clean repo auto-selects Certified F0
  const cleanFiles = {
    'src/com/acme/Clean.java': 'package com.acme; public class Clean {}'
  };
  const cleanResult = runJavaAnalysis({
    repoId: 'clean-repo',
    candidateFiles: cleanFiles
  });
  assert.strictEqual(cleanResult.qualification.qualificationStatus, 'QUALIFIED_FOR_CERTIFIED_F0');
  assert.strictEqual(cleanResult.reportJson.certifiedPanel.admittedProfile, 'JAVA_PUBLIC_API_F0');

  // 4b: Wildcard-polluted repo auto-selects Advisory Fallback
  const wildcardFiles = {
    'src/com/acme/Polluted.java': 'package com.acme; import java.util.*; public class Polluted {}'
  };
  const wildcardResult = runJavaAnalysis({
    repoId: 'wildcard-repo',
    candidateFiles: wildcardFiles
  });
  assert.strictEqual(wildcardResult.qualification.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(wildcardResult.reportJson.certifiedPanel.admittedProfile, null);
  assert.ok(wildcardResult.reportText.includes('DISQUALIFIED (Advisory Fallback)'));

  console.log('✓ Test 4 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 5: Safety Invariant Verification
// --------------------------------------------------------------------------
console.log('Running Test 5: Safety Invariant Verification...');
{
  // When qualification fails (e.g. wildcard import), even if no consumers break,
  // effective verdict cannot be unconditionally promoted to certified PRESERVED.
  const files = {
    'src/com/acme/Foo.java': 'package com.acme; import java.util.*; public class Foo {}'
  };
  const res = runJavaAnalysis({
    repoId: 'safety-check',
    historicalFiles: files,
    candidateFiles: files
  });

  assert.notStrictEqual(res.reportJson.certifiedPanel.verifiedConclusion, 'COMPATIBLE');
  assert.strictEqual(res.reportJson.certifiedPanel.verifiedConclusion, 'UNCERTIFIED');

  console.log('✓ Test 5 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 6: Absent Proof Never Produces Certified COMPATIBLE
// --------------------------------------------------------------------------
console.log('Running Test 6: Absent Proof Never Produces Certified COMPATIBLE...');
{
  const qual: any = {
    qualificationStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
    admittedProfile: 'JAVA_PUBLIC_API_F0',
    buildSystem: 'MAVEN',
    isMultiModule: false,
    blockers: []
  };

  const reportInput = {
    repositoryId: 'acme-absent-proof',
    qualification: qual,
    certifiedProofResult: undefined, // Proof is absent
    advisoryResult: undefined
  };

  const json = JavaTwoPanelReport.toJSON(reportInput);
  assert.strictEqual(json.certifiedPanel.verifiedConclusion, 'UNCERTIFIED', 'Panel 1 must be UNCERTIFIED when proof is absent');
  assert.strictEqual(json.effectiveVerdict, 'INCONCLUSIVE', 'Effective verdict must fall back to INCONCLUSIVE when proof is absent');

  const text = JavaTwoPanelReport.formatText(reportInput);
  assert.ok(text.includes('Verified Conclusion:  UNCERTIFIED'));
  assert.ok(text.includes('FINAL RELEASE GATE VERDICT: INCONCLUSIVE (ADVISORY)'));

  const md = JavaTwoPanelReport.formatMarkdown(reportInput);
  assert.ok(md.includes('**Verified Conclusion** | **`UNCERTIFIED`**'));
  assert.ok(md.includes('**Effective Verdict:** **`INCONCLUSIVE (ADVISORY)`**'));

  console.log('✓ Test 6 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 7: Invalid Proof Never Produces Certified COMPATIBLE
// --------------------------------------------------------------------------
console.log('Running Test 7: Invalid Proof Never Produces Certified COMPATIBLE...');
{
  const qual: any = {
    qualificationStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
    admittedProfile: 'JAVA_PUBLIC_API_F0',
    buildSystem: 'MAVEN',
    isMultiModule: false,
    blockers: []
  };

  const reportInput = {
    repositoryId: 'acme-invalid-proof',
    qualification: qual,
    certifiedProofResult: {
      valid: false,
      blockerCode: 'INVALID_RULE_APPLICATION',
      reason: 'Duplicate node ID or cyclical dependency in proof DAG'
    } as any,
    advisoryResult: undefined
  };

  const json = JavaTwoPanelReport.toJSON(reportInput);
  assert.strictEqual(json.certifiedPanel.verifiedConclusion, 'UNCERTIFIED', 'Panel 1 must be UNCERTIFIED when proof is invalid');
  assert.strictEqual(json.effectiveVerdict, 'INCONCLUSIVE', 'Effective verdict must fall back to INCONCLUSIVE when proof is invalid');

  const text = JavaTwoPanelReport.formatText(reportInput);
  assert.ok(text.includes('Verified Conclusion:  UNCERTIFIED'));
  assert.ok(text.includes('FINAL RELEASE GATE VERDICT: INCONCLUSIVE (ADVISORY)'));

  const md = JavaTwoPanelReport.formatMarkdown(reportInput);
  assert.ok(md.includes('**Verified Conclusion** | **`UNCERTIFIED`**'));
  assert.ok(md.includes('**Effective Verdict:** **`INCONCLUSIVE (ADVISORY)`**'));

  console.log('✓ Test 7 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 8: Valid COMPATIBLE Proof Certified Correctly
// --------------------------------------------------------------------------
console.log('Running Test 8: Valid COMPATIBLE Proof Certified Correctly...');
{
  const qual: any = {
    qualificationStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
    admittedProfile: 'JAVA_PUBLIC_API_F0',
    buildSystem: 'MAVEN',
    isMultiModule: false,
    blockers: []
  };

  const reportInput = {
    repositoryId: 'acme-valid-compatible',
    qualification: qual,
    certifiedProofResult: {
      valid: true,
      verifiedConclusion: 'COMPATIBLE',
      obligationDigest: '0123456789abcdef0123456789abcdef',
      ruleDerivations: ['JAVA.F0.NOMINAL.EQUAL']
    } as any,
    advisoryResult: undefined
  };

  const json = JavaTwoPanelReport.toJSON(reportInput);
  assert.strictEqual(json.certifiedPanel.verifiedConclusion, 'COMPATIBLE');
  assert.strictEqual(json.effectiveVerdict, 'COMPATIBLE');

  const text = JavaTwoPanelReport.formatText(reportInput);
  assert.ok(text.includes('Verified Conclusion:  COMPATIBLE'));
  assert.ok(text.includes('FINAL RELEASE GATE VERDICT: COMPATIBLE'));

  const md = JavaTwoPanelReport.formatMarkdown(reportInput);
  assert.ok(md.includes('**Verified Conclusion** | **`COMPATIBLE`**'));
  assert.ok(md.includes('**Effective Verdict:** **`COMPATIBLE`**'));

  console.log('✓ Test 8 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 9: Valid INCOMPATIBLE Proof Certified Correctly
// --------------------------------------------------------------------------
console.log('Running Test 9: Valid INCOMPATIBLE Proof Certified Correctly...');
{
  const qual: any = {
    qualificationStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
    admittedProfile: 'JAVA_PUBLIC_API_F0',
    buildSystem: 'MAVEN',
    isMultiModule: false,
    blockers: []
  };

  const reportInput = {
    repositoryId: 'acme-valid-incompatible',
    qualification: qual,
    certifiedProofResult: {
      valid: true,
      verifiedConclusion: 'INCOMPATIBLE',
      obligationDigest: 'abcdef0123456789abcdef0123456789',
      ruleDerivations: ['JAVA.F0.METHOD.SIGNATURE_PRESERVED']
    } as any,
    advisoryResult: undefined
  };

  const json = JavaTwoPanelReport.toJSON(reportInput);
  assert.strictEqual(json.certifiedPanel.verifiedConclusion, 'INCOMPATIBLE');
  assert.strictEqual(json.effectiveVerdict, 'INCOMPATIBLE');

  const text = JavaTwoPanelReport.formatText(reportInput);
  assert.ok(text.includes('Verified Conclusion:  INCOMPATIBLE'));
  assert.ok(text.includes('FINAL RELEASE GATE VERDICT: INCOMPATIBLE'));

  const md = JavaTwoPanelReport.formatMarkdown(reportInput);
  assert.ok(md.includes('**Verified Conclusion** | **`INCOMPATIBLE`**'));
  assert.ok(md.includes('**Effective Verdict:** **`INCOMPATIBLE`**'));

  console.log('✓ Test 9 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 10: CLI End-to-End: Qualified Repo with No Derivable Proof Remains UNCERTIFIED
// --------------------------------------------------------------------------
console.log('Running Test 10: CLI End-to-End: Qualified Repo with No Derivable Proof...');
{
  // A repository with a pom.xml but no classes qualifies for F0,
  // but cannot produce a verified proof. It must remain UNCERTIFIED and INCONCLUSIVE.
  const emptyRepoFiles = {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>empty-lib</artifactId><version>1.0.0</version></project>'
  };

  const res = runJavaAnalysis({
    repoId: 'acme-empty-qualified-lib',
    historicalFiles: emptyRepoFiles,
    candidateFiles: emptyRepoFiles,
    format: 'json'
  });

  assert.strictEqual(res.qualification.qualificationStatus, 'QUALIFIED_FOR_CERTIFIED_F0');
  assert.strictEqual(res.reportJson.certifiedPanel.verifiedConclusion, 'UNCERTIFIED', 'Panel 1 must remain UNCERTIFIED without a valid proof');
  assert.strictEqual(res.reportJson.effectiveVerdict, 'INCONCLUSIVE', 'Effective verdict must be INCONCLUSIVE, never COMPATIBLE');

  console.log('✓ Test 10 passed cleanly');
}

console.log('--- ALL JAVA PHASE J-9 CLI & REPORTING TESTS PASSED ---');

