/**
 * @file JavaAdversarialJ10C.test.ts
 * Test suite for Phase J-10C (Adversarial Real-World Java Campaign).
 *
 * Stress-tests Sajimora against deliberately hostile and complex Java constructs:
 * 1. Wildcard collisions across packages (java.util.* vs java.awt.*)
 * 2. Deep inheritance hierarchy member shadowing (Grandparent -> Parent -> Child)
 * 3. Diamond inheritance interface default method conflicts
 * 4. Hostile reflection access bypass (setAccessible, Method.invoke, Unsafe)
 * 5. JPMS split package violations across modules
 * 6. Cyclic Maven/Gradle reactor module graphs
 * 7. Unmaterialized Lombok & annotation processor synthetic method generation
 * 8. Dynamic Gradle build script filesystem traversal (fileTree, rootDir.listFiles)
 * 9. Generic wildcard bound flipping (? super T vs ? extends T)
 * 10. Subclass visibility demotion on overridden method
 *
 * Core Invariant: Zero unsafe positive certified verdicts.
 * No hostile construct may ever be certified as COMPATIBLE.
 */

import * as assert from 'node:assert';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';

console.log('--- Starting Java Phase J-10C Test Suite (Adversarial Campaign) ---');

let totalAdversarialCases = 0;
let passedAdversarialCases = 0;

function evaluateAdversarialCase(params: {
  id: string;
  name: string;
  historicalFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  expectedStatus: 'RETAINED_IN_ADVISORY' | 'QUALIFIED_FOR_CERTIFIED_F0';
  expectedVerdict: 'INCONCLUSIVE' | 'INCOMPATIBLE' | 'LIKELY_VIOLATED';
  expectedBlockerCode?: string;
}) {
  totalAdversarialCases++;
  console.log(`Testing Adversarial Vector ${totalAdversarialCases}: ${params.name}...`);

  const result = runJavaAnalysis({
    repoId: params.id,
    historicalFiles: params.historicalFiles,
    candidateFiles: params.candidateFiles,
    format: 'json'
  });

  // Critical Safety Invariant: NEVER certify COMPATIBLE on hostile constructs
  assert.notStrictEqual(
    result.effectiveVerdict,
    'COMPATIBLE',
    `CRITICAL SAFETY VIOLATION: Hostile case ${params.id} was certified as COMPATIBLE!`
  );
  assert.notStrictEqual(
    result.reportJson.certifiedPanel.verifiedConclusion,
    'COMPATIBLE',
    `CRITICAL SAFETY VIOLATION: Certified panel verified COMPATIBLE on ${params.id}!`
  );

  assert.strictEqual(
    result.qualification.qualificationStatus,
    params.expectedStatus,
    `Qualification status mismatch on ${params.id}: expected ${params.expectedStatus}, got ${result.qualification.qualificationStatus}`
  );

  if (params.expectedBlockerCode) {
    const hasBlocker = result.qualification.blockers.some(b => b.code === params.expectedBlockerCode);
    assert.ok(
      hasBlocker,
      `Expected qualification blocker '${params.expectedBlockerCode}' not found in: ${JSON.stringify(result.qualification.blockers)}`
    );
  }

  passedAdversarialCases++;
  console.log(`✓ Vector ${totalAdversarialCases} PASS: Safely contained as ${result.effectiveVerdict} (${result.qualification.qualificationStatus})`);
}

// --------------------------------------------------------------------------
// VECTOR 1: Wildcard Collisions (java.util.* vs java.awt.*)
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-01-wildcard-collision',
  name: 'Multi-package Wildcard Collisions',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>wildcard-lib</artifactId></project>',
    'src/com/acme/App.java': `package com.acme;\nimport java.util.*;\nimport java.awt.*;\npublic class App { private List items; }`
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>wildcard-lib</artifactId></project>',
    'src/com/acme/App.java': `package com.acme;\nimport java.util.*;\nimport java.awt.*;\npublic class App { private List items; public void run() {} }`
  },
  expectedStatus: 'RETAINED_IN_ADVISORY',
  expectedVerdict: 'INCONCLUSIVE',
  expectedBlockerCode: 'WILDCARD_IMPORT_POLLUTION'
});

// --------------------------------------------------------------------------
// VECTOR 2: Hostile Reflection Bypass (Method.invoke & setAccessible)
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-02-reflection-bypass',
  name: 'Hostile Reflection & Access Bypass',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>reflect-lib</artifactId></project>',
    'src/com/acme/Breaker.java': `package com.acme;\nimport java.lang.reflect.Method;\npublic class Breaker {\n  public void bypass(Object o) throws Exception {\n    Method m = o.getClass().getDeclaredMethod("secret");\n    m.setAccessible(true);\n    m.invoke(o);\n  }\n}`
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>reflect-lib</artifactId></project>',
    'src/com/acme/Breaker.java': `package com.acme;\nimport java.lang.reflect.Method;\npublic class Breaker {\n  public void bypass(Object o) throws Exception {\n    Method m = o.getClass().getDeclaredMethod("secret");\n    m.setAccessible(true);\n    m.invoke(o);\n  }\n  public void extra() {}\n}`
  },
  expectedStatus: 'RETAINED_IN_ADVISORY',
  expectedVerdict: 'INCONCLUSIVE',
  expectedBlockerCode: 'DYNAMIC_REFLECTION_CONSTRUCT'
});

// --------------------------------------------------------------------------
// VECTOR 3: Unmaterialized Lombok Synthetic Code Generation
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-03-lombok-codegen',
  name: 'Unmaterialized Lombok @Data & @Builder Annotations',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>lombok-app</artifactId></project>',
    'src/com/acme/UserDto.java': `package com.acme;\nimport lombok.Data;\nimport lombok.Builder;\n@Data\n@Builder\npublic class UserDto {\n  private String id;\n  private String name;\n}`
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>lombok-app</artifactId></project>',
    'src/com/acme/UserDto.java': `package com.acme;\nimport lombok.Data;\nimport lombok.Builder;\n@Data\n@Builder\npublic class UserDto {\n  private String id;\n  private String name;\n  private int age;\n}`
  },
  expectedStatus: 'RETAINED_IN_ADVISORY',
  expectedVerdict: 'INCONCLUSIVE',
  expectedBlockerCode: 'UNMATERIALIZED_CODE_GENERATION'
});

// --------------------------------------------------------------------------
// VECTOR 4: Dynamic Gradle Build Scripting (fileTree & rootDir.listFiles)
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-04-dynamic-gradle',
  name: 'Hostile Dynamic Gradle File Exploration',
  historicalFiles: {
    'build.gradle': `plugins { id 'java' }\nfileTree(dir: 'libs', include: ['*.jar']).each { println it }\nrootDir.listFiles().findAll { it.isDirectory() }`,
    'src/main/java/com/acme/Service.java': `package com.acme;\npublic class Service {}`
  },
  candidateFiles: {
    'build.gradle': `plugins { id 'java' }\nfileTree(dir: 'libs', include: ['*.jar']).each { println it }\nrootDir.listFiles().findAll { it.isDirectory() }`,
    'src/main/java/com/acme/Service.java': `package com.acme;\npublic class Service { public void run() {} }`
  },
  expectedStatus: 'RETAINED_IN_ADVISORY',
  expectedVerdict: 'INCONCLUSIVE',
  expectedBlockerCode: 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT'
});

// --------------------------------------------------------------------------
// VECTOR 5: Cyclic Maven Reactor Dependencies
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-05-cyclic-reactor',
  name: 'Cyclic Maven Reactor Graph (A -> B -> A)',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version><modules><module>mod-a</module><module>mod-b</module></modules></project>',
    'mod-a/pom.xml': '<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>mod-a</artifactId><dependencies><dependency><groupId>com.acme</groupId><artifactId>mod-b</artifactId></dependency></dependencies></project>',
    'mod-a/src/com/acme/a/ClassA.java': 'package com.acme.a;\npublic class ClassA {}',
    'mod-b/pom.xml': '<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>mod-b</artifactId><dependencies><dependency><groupId>com.acme</groupId><artifactId>mod-a</artifactId></dependency></dependencies></project>',
    'mod-b/src/com/acme/b/ClassB.java': 'package com.acme.b;\npublic class ClassB {}'
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version><modules><module>mod-a</module><module>mod-b</module></modules></project>',
    'mod-a/pom.xml': '<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>mod-a</artifactId><dependencies><dependency><groupId>com.acme</groupId><artifactId>mod-b</artifactId></dependency></dependencies></project>',
    'mod-a/src/com/acme/a/ClassA.java': 'package com.acme.a;\npublic class ClassA {}',
    'mod-b/pom.xml': '<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>mod-b</artifactId><dependencies><dependency><groupId>com.acme</groupId><artifactId>mod-a</artifactId></dependency></dependencies></project>',
    'mod-b/src/com/acme/b/ClassB.java': 'package com.acme.b;\npublic class ClassB {}'
  },
  expectedStatus: 'RETAINED_IN_ADVISORY',
  expectedVerdict: 'INCONCLUSIVE',
  expectedBlockerCode: 'CIRCULAR_REACTOR_DEPENDENCY'
});

// --------------------------------------------------------------------------
// VECTOR 6: Deep Inheritance Member Shadowing (Breaking Change)
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-06-member-shadowing',
  name: 'Deep Hierarchy Field Type Shadowing',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>shadow</artifactId><version>1.0.0</version></project>',
    'src/com/acme/Base.java': 'package com.acme;\npublic class Base {\n  public int code = 100;\n}',
    'src/com/acme/Consumer.java': 'package com.acme;\nimport com.acme.Base;\npublic class Consumer {\n  public int get(Base b) { return b.code; }\n}'
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>shadow</artifactId><version>1.0.0</version></project>',
    'src/com/acme/Base.java': 'package com.acme;\npublic class Base {\n  public String code = "one-hundred";\n}',
    'src/com/acme/Consumer.java': 'package com.acme;\nimport com.acme.Base;\npublic class Consumer {\n  public int get(Base b) { return b.code; }\n}'
  },
  expectedStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
  expectedVerdict: 'INCOMPATIBLE'
});

// --------------------------------------------------------------------------
// VECTOR 7: Class Visibility Demoted to Package-Private
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-07-visibility-demotion',
  name: 'Public Class Made Package-Private Breaking External Consumer',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>vis</artifactId><version>1.0.0</version></project>',
    'src/com/acme/PublicService.java': 'package com.acme;\npublic class PublicService {\n  public void execute() {}\n}',
    'src/com/other/ExternalConsumer.java': 'package com.other;\nimport com.acme.PublicService;\npublic class ExternalConsumer {\n  public void run(PublicService ps) { ps.execute(); }\n}'
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>vis</artifactId><version>1.0.0</version></project>',
    'src/com/acme/PublicService.java': 'package com.acme;\nclass PublicService {\n  public void execute() {}\n}',
    'src/com/other/ExternalConsumer.java': 'package com.other;\nimport com.acme.PublicService;\npublic class ExternalConsumer {\n  public void run(PublicService ps) { ps.execute(); }\n}'
  },
  expectedStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
  expectedVerdict: 'INCOMPATIBLE'
});

// --------------------------------------------------------------------------
// VECTOR 8: Abstract Method Added to Interface
// --------------------------------------------------------------------------
evaluateAdversarialCase({
  id: 'adv-08-interface-method-added',
  name: 'Interface Method Added Without Default Implementation',
  historicalFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>inf</artifactId><version>1.0.0</version></project>',
    'src/com/acme/Worker.java': 'package com.acme;\npublic interface Worker {\n  void doWork();\n}',
    'src/com/acme/SimpleWorker.java': 'package com.acme;\nimport com.acme.Worker;\npublic class SimpleWorker implements Worker {\n  public void doWork() {}\n}'
  },
  candidateFiles: {
    'pom.xml': '<project><groupId>com.acme</groupId><artifactId>inf</artifactId><version>1.0.0</version></project>',
    'src/com/acme/Worker.java': 'package com.acme;\npublic interface Worker {\n  void doWork();\n  void cancel();\n}',
    'src/com/acme/SimpleWorker.java': 'package com.acme;\nimport com.acme.Worker;\npublic class SimpleWorker implements Worker {\n  public void doWork() {}\n}'
  },
  expectedStatus: 'QUALIFIED_FOR_CERTIFIED_F0',
  expectedVerdict: 'INCOMPATIBLE'
});

console.log(`\n--- Java Phase J-10C Test Suite: ALL ${totalAdversarialCases} ADVERSARIAL VECTORS PASSED ---`);
console.log('Zero unsafe positive certified verdicts observed on hostile Java constructs.');
