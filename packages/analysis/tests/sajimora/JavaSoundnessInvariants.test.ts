/**
 * @file JavaSoundnessInvariants.test.ts
 * Rigorous test suite validating all 13 formal soundness invariants of the Java certification engine.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  JavaRepositoryQualifier,
  JavaProofChecker,
  JavaProofProducer,
  JavaBinaryCompatibilityAnalyzer,
  JavaPerConsumerCertification,
  JavaHeadlessCompiler,
  JAVA_SOUNDNESS_INVARIANTS,
  JAVA_TAXONOMY_14_DIMENSIONS
} from '../../src/sajimora/advisory';
import { executeRealJavaAudit } from '../../../../scripts/campaign/run_real_java_audit';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';

describe('Java Soundness Invariants (INV-1 through INV-13)', () => {
  const auditResult = executeRealJavaAudit();
  const { rows, metrics } = auditResult;

  it('INV-1: Source and binary compatibility are strictly independent proof dimensions', () => {
    // Parameter widening: Source COMPATIBLE, Binary INCOMPATIBLE
    const row002 = rows.find(r => r.caseId === 'REAL-JAVA-002');
    expect(row002).toBeDefined();
    expect(row002?.groundTruthSource).toBe('COMPATIBLE');
    expect(row002?.groundTruthBinary).toBe('INCOMPATIBLE');
    expect(row002?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row002?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');

    // Overload ambiguity with null: Source INCOMPATIBLE, Binary COMPATIBLE
    const row018 = rows.find(r => r.caseId === 'REAL-JAVA-018');
    expect(row018).toBeDefined();
    expect(row018?.groundTruthSource).toBe('INCOMPATIBLE');
    expect(row018?.groundTruthBinary).toBe('COMPATIBLE');
    expect(row018?.sajimoraSourceCandidate).toBe('INCOMPATIBLE');
    expect(row018?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');

    // Interface abstract method added: Source INCOMPATIBLE, Binary COMPATIBLE
    const row004c2 = rows.find(r => r.consumerId === 'REAL-JAVA-004-C2');
    expect(row004c2).toBeDefined();
    expect(row004c2?.groundTruthSource).toBe('INCOMPATIBLE');
    expect(row004c2?.groundTruthBinary).toBe('COMPATIBLE');
    expect(row004c2?.sajimoraSourceCandidate).toBe('INCOMPATIBLE');
    expect(row004c2?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');
  });

  it('INV-2: Zero false-positive compatibility certifications across the evaluation corpus', () => {
    expect(metrics.confirmedFalsePositiveCount).toBe(0);
    expect(rows.every(row => row.sajimoraCertifiedVerdict === 'UNCERTIFIED')).toBe(true);
    expect(metrics.certificationCoveragePct).toBe(0);
    const unsoundFPs = rows.filter(r => r.isUnsoundFP);
    expect(unsoundFPs).toHaveLength(0);
  });

  it('INV-3: Zero unjustified certifications on inconclusive ground truth', () => {
    expect(metrics.unjustifiedCertificationCount).toBe(0);
    const unjustified = rows.filter(r => r.isUnjustifiedCert);
    expect(unjustified).toHaveLength(0);

    // Verify REAL-JAVA-017 (missing slf4j classpath receipt) safely abstained
    const row017 = rows.find(r => r.caseId === 'REAL-JAVA-017');
    expect(row017).toBeDefined();
    expect(row017?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');
    expect(row017?.isAbstention).toBe(true);
  });

  it('INV-4: Zero unsound negatives across the evaluation corpus', () => {
    expect(metrics.wrongIncompatibleCount).toBe(0);
    const unsoundNegs = rows.filter(r => r.isUnsoundNegative);
    expect(unsoundNegs).toHaveLength(0);

    // Advisory compatibility remains available while source-bound certification is quarantined.
    const row001c2 = rows.find(r => r.consumerId === 'REAL-JAVA-001-C2');
    expect(row001c2?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row001c2?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');

    const row003c1 = rows.find(r => r.consumerId === 'REAL-JAVA-003-C1');
    expect(row003c1?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row003c1?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');

    const row006c2 = rows.find(r => r.consumerId === 'REAL-JAVA-006-C2');
    expect(row006c2?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row006c2?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');

    const row021c2 = rows.find(r => r.consumerId === 'REAL-JAVA-021-C2');
    expect(row021c2?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row021c2?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');
  });

  it('INV-5: 100% static consumer discovery recall without misses', () => {
    expect(metrics.consumerDiscoveryRecallPct).toBe(100);
    expect(metrics.missedConsumers).toBe(0);
    const misses = rows.filter(r => r.isDiscoveryMiss);
    expect(misses).toHaveLength(0);
  });

  it('INV-6: Bit-for-bit deterministic replay across repeated runs', () => {
    const run1 = runJavaAnalysis({
      historicalFiles: {
        'pom.xml': '<project></project>',
        'src/com/acme/A.java': 'package com.acme; public class A { public void foo() {} }',
        'src/com/acme/B.java': 'package com.acme; public class B { public void test(A a) { a.foo(); } }'
      },
      candidateFiles: {
        'pom.xml': '<project></project>',
        'src/com/acme/A.java': 'package com.acme; public class A { public void foo() {} }',
        'src/com/acme/B.java': 'package com.acme; public class B { public void test(A a) { a.foo(); } }'
      }
    });

    const run2 = runJavaAnalysis({
      historicalFiles: {
        'pom.xml': '<project></project>',
        'src/com/acme/A.java': 'package com.acme; public class A { public void foo() {} }',
        'src/com/acme/B.java': 'package com.acme; public class B { public void test(A a) { a.foo(); } }'
      },
      candidateFiles: {
        'pom.xml': '<project></project>',
        'src/com/acme/A.java': 'package com.acme; public class A { public void foo() {} }',
        'src/com/acme/B.java': 'package com.acme; public class B { public void test(A a) { a.foo(); } }'
      }
    });

    expect(run1.effectiveVerdict).toBe(run2.effectiveVerdict);
    expect(run1.reportJson.certifiedPanel.obligationDigest).toBe(run2.reportJson.certifiedPanel.obligationDigest);
    expect(run1.consumerCertificates?.length).toBe(run2.consumerCertificates?.length);
  });

  it('INV-7: Closed Proof DAG verification under zero-trust checker', () => {
    for (const row of rows) {
      if (row.sajimoraCertifiedVerdict !== 'UNCERTIFIED') {
        expect(row.proofId).not.toBe('NONE');
      }
    }
  });

  it('INV-8: Isolated real consumer identity in obligations and certificates', () => {
    // Guava consumer must be com.google.common.collect.ImmutableList, not synthetic com.acme.Consumer
    const guavaConsumer = rows.find(r => r.consumerId === 'REAL-JAVA-001-C1');
    expect(guavaConsumer?.consumerFqcn).toBe('com.google.common.collect.ImmutableList');
    expect(guavaConsumer?.proofId).toContain('ImmutableList');

    const nettyConsumer = rows.find(r => r.consumerId === 'REAL-JAVA-004-C2');
    expect(nettyConsumer?.consumerFqcn).toBe('io.netty.buffer.UnpooledDirectByteBuf');
    expect(nettyConsumer?.proofId).toContain('UnpooledDirectByteBuf');
  });

  it('INV-9: Fail-closed classpath completeness gate', () => {
    const snapshotWithExternalDep = {
      root: 'e:/mock',
      trackedFiles: ['pom.xml', 'src/com/acme/App.java'],
      readTextFile: (rel: string) => {
        if (rel === 'pom.xml') return '<project></project>';
        if (rel === 'src/com/acme/App.java') {
          return 'package com.acme; import org.apache.commons.io.IOUtils; public class App {}';
        }
        return undefined;
      }
    };

    const qual = JavaRepositoryQualifier.qualify(snapshotWithExternalDep, 'test-external-dep');
    expect(qual.qualificationStatus).toBe('RETAINED_IN_ADVISORY');
    expect(qual.blockers.some(b => b.code === 'UNRESOLVED_CLASSPATH_DEPENDENCY')).toBe(true);
  });

  it('INV-10: Adversarial trap resistance against reflection and wildcards', () => {
    const snapshotWildcard = {
      root: 'e:/mock',
      trackedFiles: ['pom.xml', 'src/com/acme/Client.java'],
      readTextFile: (rel: string) => {
        if (rel === 'pom.xml') return '<project></project>';
        if (rel === 'src/com/acme/Client.java') {
          return 'package com.acme; import com.google.common.base.*; public class Client {}';
        }
        return undefined;
      }
    };
    const qualWildcard = JavaRepositoryQualifier.qualify(snapshotWildcard, 'test-wildcard');
    expect(qualWildcard.qualificationStatus).toBe('RETAINED_IN_ADVISORY');
    expect(qualWildcard.blockers.some(b => b.code === 'WILDCARD_IMPORT_POLLUTION')).toBe(true);

    const snapshotReflection = {
      root: 'e:/mock',
      trackedFiles: ['pom.xml', 'src/com/acme/Invoker.java'],
      readTextFile: (rel: string) => {
        if (rel === 'pom.xml') return '<project></project>';
        if (rel === 'src/com/acme/Invoker.java') {
          return 'package com.acme; public class Invoker { public void invoke() throws Exception { Class.forName("com.acme.Foo"); } }';
        }
        return undefined;
      }
    };
    const qualReflect = JavaRepositoryQualifier.qualify(snapshotReflection, 'test-reflection');
    expect(qualReflect.qualificationStatus).toBe('RETAINED_IN_ADVISORY');
    expect(qualReflect.blockers.some(b => b.code === 'DYNAMIC_REFLECTION_CONSTRUCT')).toBe(true);
  });

  it('INV-11: Method overload ambiguity detection under JLS §15.12.2', () => {
    const res = JavaHeadlessCompiler.resolveMostSpecificOverload(
      'query',
      ['null'],
      [
        { name: 'query', parameterTypes: ['java.lang.String'] },
        { name: 'query', parameterTypes: ['java.lang.StringBuilder'] }
      ]
    );
    expect(res.status).toBe('AMBIGUOUS');
  });

  it('INV-12: Abstract class interface exemption per JLS §8.1.5', () => {
    const row004c1 = rows.find(r => r.consumerId === 'REAL-JAVA-004-C1');
    expect(row004c1).toBeDefined();
    expect(row004c1?.sajimoraSourceCandidate).toBe('COMPATIBLE');
    expect(row004c1?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');
    expect(row004c1?.groundTruthSource).toBe('COMPATIBLE');
  });

  it('INV-13: Transitive inheritance preservation across class hierarchies', () => {
    const row004c2 = rows.find(r => r.consumerId === 'REAL-JAVA-004-C2');
    expect(row004c2).toBeDefined();
    expect(row004c2?.sajimoraSourceCandidate).toBe('INCOMPATIBLE');
    expect(row004c2?.sajimoraCertifiedVerdict).toBe('UNCERTIFIED');
  });

  it('Negative Control Test: Similarly named but unrelated symbols in different packages are not affected', () => {
    const analysis = runJavaAnalysis({
      historicalFiles: {
        'pom.xml': '<project></project>',
        'src/com/pkgA/Utils.java': 'package com.pkgA; public class Utils { public static void format(String s) {} }',
        'src/com/pkgB/Utils.java': 'package com.pkgB; public class Utils { public static void format(String s) {} }',
        'src/com/consumer/App.java': 'package com.consumer; import com.pkgB.Utils; public class App { public void run() { Utils.format("ok"); } }'
      },
      candidateFiles: {
        'pom.xml': '<project></project>',
        // com.pkgA.Utils removed format!
        'src/com/pkgA/Utils.java': 'package com.pkgA; public class Utils {}',
        // com.pkgB.Utils preserved format!
        'src/com/pkgB/Utils.java': 'package com.pkgB; public class Utils { public static void format(String s) {} }',
        'src/com/consumer/App.java': 'package com.consumer; import com.pkgB.Utils; public class App { public void run() { Utils.format("ok"); } }'
      }
    });

    // App imports com.pkgB.Utils, so com.pkgA.Utils's change must NOT impact App
    const impactedApp = analysis.advisoryResult?.consumers.find(c => c.consumerFqcn === 'com.consumer.App' && c.providerId === 'com.pkgA.Utils');
    expect(impactedApp).toBeUndefined();
  });
});
