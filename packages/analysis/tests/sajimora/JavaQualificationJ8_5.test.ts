/**
 * @file JavaQualificationJ8_5.test.ts
 * Test suite for Phase J-8.5 (Java Repository Qualification Gate).
 *
 * Verifies that:
 * 1. Clean declarative multi-module repository qualifies for Certified F0.
 * 2. Dynamic Gradle build script is disqualified to advisory with UNSUPPORTED_DYNAMIC_BUILD_SCRIPT.
 * 3. Circular reactor dependencies are caught with CIRCULAR_REACTOR_DEPENDENCY.
 * 4. JPMS unexported package access is caught with JPMS_UNEXPORTED_PACKAGE_REFERENCE.
 * 5. Lombok / unmaterialized code generation is caught with UNMATERIALIZED_CODE_GENERATION.
 * 6. Wildcard imports are caught with WILDCARD_IMPORT_POLLUTION.
 * 7. Dynamic reflection is caught with DYNAMIC_REFLECTION_CONSTRUCT.
 * 8. Markdown summary report renders correctly.
 */

import * as assert from 'node:assert';
import {
  JavaRepositoryQualifier,
  SealedJavaSnapshotInput,
  JavaSemanticProfileId
} from '../../src/sajimora/languages/java';

console.log('--- Starting Java Phase J-8.5 Test Suite (Repository Qualification Gate) ---');

function createSnapshot(files: Record<string, string>): SealedJavaSnapshotInput {
  const trackedFiles = Object.keys(files).sort();
  return {
    root: 'e:/mock-repo',
    trackedFiles,
    readTextFile: (relPath: string) => files[relPath]
  };
}

// --------------------------------------------------------------------------
// TEST 1: Clean Declarative Repository Qualifies for Certified F0
// --------------------------------------------------------------------------
console.log('Running Test 1: Clean Declarative Repository Qualifies...');
{
  const files: Record<string, string> = {
    'pom.xml': `
      <project>
        <groupId>com.acme</groupId>
        <artifactId>parent</artifactId>
        <version>1.0.0</version>
        <modules>
          <module>core</module>
          <module>api</module>
        </modules>
      </project>
    `,
    'core/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
        <artifactId>core</artifactId>
      </project>
    `,
    'api/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
        <artifactId>api</artifactId>
        <dependencies>
          <dependency><groupId>com.acme</groupId><artifactId>core</artifactId></dependency>
        </dependencies>
      </project>
    `,
    'core/src/main/java/com/acme/core/Service.java': `
      package com.acme.core;
      public class Service {
        public String execute() { return "ok"; }
      }
    `,
    'api/src/main/java/com/acme/api/Controller.java': `
      package com.acme.api;
      import com.acme.core.Service;
      public class Controller {
        private Service service;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-clean');

  assert.strictEqual(report.qualificationStatus, 'QUALIFIED_FOR_CERTIFIED_F0');
  assert.strictEqual(report.admittedProfile, JavaSemanticProfileId.JAVA_PUBLIC_API_F0);
  assert.strictEqual(report.stages.buildModel.status, 'PASS');
  assert.strictEqual(report.stages.reactorGraph.status, 'PASS');
  assert.strictEqual(report.stages.jpmsConsistency.status, 'PASS');
  assert.strictEqual(report.stages.sourceSetPurity.status, 'PASS');
  assert.strictEqual(report.stages.languageSubset.status, 'PASS');
  assert.strictEqual(report.blockers.length, 0);

  console.log('✓ Test 1 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 2: Dynamic Build Script Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 2: Dynamic Build Script Disqualification...');
{
  const files: Record<string, string> = {
    'settings.gradle': `
      rootDir.listFiles().each { f -> include f.name }
    `,
    'src/main/java/App.java': 'public class App {}'
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-dynamic');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.admittedProfile, null);
  assert.strictEqual(report.stages.buildModel.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT'));

  console.log('✓ Test 2 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 3: Circular Reactor Dependency Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 3: Circular Reactor Dependency Disqualification...');
{
  const files: Record<string, string> = {
    'settings.gradle': "include ':modA', ':modB'",
    'modA/build.gradle': "dependencies { implementation project(':modB') }",
    'modB/build.gradle': "dependencies { implementation project(':modA') }",
    'modA/src/main/java/A.java': 'public class A {}',
    'modB/src/main/java/B.java': 'public class B {}'
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-circular');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.stages.reactorGraph.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'CIRCULAR_REACTOR_DEPENDENCY'));

  console.log('✓ Test 3 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 4: JPMS Unexported Package Reference Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 4: JPMS Unexported Package Disqualification...');
{
  const files: Record<string, string> = {
    'settings.gradle': "include ':core', ':api'",
    'core/build.gradle': "plugins { id 'java' }",
    'api/build.gradle': "dependencies { implementation project(':core') }",
    'core/src/main/java/module-info.java': `
      module com.acme.core {
        exports com.acme.core.pub;
      }
    `,
    'core/src/main/java/com/acme/core/internal/Hidden.java': `
      package com.acme.core.internal;
      public class Hidden {}
    `,
    'api/src/main/java/com/acme/api/Client.java': `
      package com.acme.api;
      import com.acme.core.internal.Hidden;
      public class Client { Hidden h; }
    `
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-jpms');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.stages.jpmsConsistency.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'JPMS_UNEXPORTED_PACKAGE_REFERENCE'));

  console.log('✓ Test 4 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 5: Lombok / Code-Gen Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 5: Lombok Code-Gen Disqualification...');
{
  const files: Record<string, string> = {
    'src/main/java/com/acme/User.java': `
      package com.acme;
      import lombok.Data;
      @Data
      public class User {
        private String id;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-lombok');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.stages.sourceSetPurity.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'UNMATERIALIZED_CODE_GENERATION'));

  console.log('✓ Test 5 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 6: Wildcard Import Pollution Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 6: Wildcard Import Pollution Disqualification...');
{
  const files: Record<string, string> = {
    'src/main/java/com/acme/Consumer.java': `
      package com.acme;
      import java.util.*;
      public class Consumer {
        List<String> items;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-wildcard');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.stages.languageSubset.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'WILDCARD_IMPORT_POLLUTION'));

  console.log('✓ Test 6 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 7: Dynamic Reflection Disqualification
// --------------------------------------------------------------------------
console.log('Running Test 7: Dynamic Reflection Disqualification...');
{
  const files: Record<string, string> = {
    'src/main/java/com/acme/PluginLoader.java': `
      package com.acme;
      public class PluginLoader {
        public void load() throws Exception {
          Class.forName("com.acme.DynamicImpl");
        }
      }
    `
  };

  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-reflection');

  assert.strictEqual(report.qualificationStatus, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(report.stages.languageSubset.status, 'FAIL');
  assert.ok(report.blockers.some(b => b.code === 'DYNAMIC_REFLECTION_CONSTRUCT'));

  console.log('✓ Test 7 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 8: Markdown Summary Report Rendering
// --------------------------------------------------------------------------
console.log('Running Test 8: Markdown Summary Report Rendering...');
{
  const files: Record<string, string> = {
    'src/main/java/com/acme/App.java': 'package com.acme; public class App {}'
  };
  const snapshot = createSnapshot(files);
  const report = JavaRepositoryQualifier.qualify(snapshot, 'acme-report-test');
  const md = JavaRepositoryQualifier.renderMarkdownSummary(report);

  assert.ok(md.includes('# Sajimora Java Repository Qualification Report (Phase J-8.5)'));
  assert.ok(md.includes('Build Model Extraction'));
  assert.ok(md.includes('Reactor Graph Completeness'));
  assert.ok(md.includes('JPMS & Module Boundaries'));
  assert.ok(md.includes('Source-Set Purity'));
  assert.ok(md.includes('F0 Language Subset'));

  console.log('✓ Test 8 passed cleanly');
}

console.log('--- ALL JAVA PHASE J-8.5 QUALIFICATION TESTS PASSED ---');
