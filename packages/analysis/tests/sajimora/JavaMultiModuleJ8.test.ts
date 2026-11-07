/**
 * @file JavaMultiModuleJ8.test.ts
 * Comprehensive test suite for Phase J-8 (Multi-Module Build Graph & Reactor Dependency Resolution).
 *
 * Verifies:
 * 1. Declarative Maven reactor model extraction (<modules>, <parent>, <dependency>).
 * 2. Static Gradle reactor model extraction (settings.gradle include, project(':mod') deps).
 * 3. Gradle dynamic scripting detection (fail-closed to advisory with UNSUPPORTED_DYNAMIC).
 * 4. Cross-module symbol resolution respecting reactor dependency edges.
 * 5. Missing reactor dependency restriction (fail-closed with MISSING_MODULE_DEPENDENCY).
 * 6. JPMS (module-info.java) package export boundary enforcement.
 * 7. Circular reactor dependency detection.
 * 8. Standalone single-module backward compatibility.
 */

import * as assert from 'node:assert';
import {
  JavaBuildModelExtractor,
  JavaMultiModuleCompilerHost,
  SealedJavaSnapshotInput
} from '../../src/sajimora/languages/java';

console.log('--- Starting Java Phase J-8 Test Suite (Multi-Module & Reactor Graphs) ---');

function createSnapshot(files: Record<string, string>): SealedJavaSnapshotInput {
  const trackedFiles = Object.keys(files).sort();
  return {
    root: 'e:/mock-repo',
    trackedFiles,
    readTextFile: (relPath: string) => files[relPath]
  };
}

// --------------------------------------------------------------------------
// TEST 1: Declarative Maven Multi-Module Reactor Extraction
// --------------------------------------------------------------------------
console.log('Running Test 1: Declarative Maven Multi-Module Reactor Extraction...');
{
  const files: Record<string, string> = {
    'pom.xml': `
      <project>
        <groupId>com.acme</groupId>
        <artifactId>acme-parent</artifactId>
        <version>1.0.0</version>
        <packaging>pom</packaging>
        <modules>
          <module>core</module>
          <module>api</module>
          <module>web</module>
        </modules>
      </project>
    `,
    'core/pom.xml': `
      <project>
        <parent>
          <groupId>com.acme</groupId>
          <artifactId>acme-parent</artifactId>
          <version>1.0.0</version>
        </parent>
        <artifactId>core</artifactId>
      </project>
    `,
    'api/pom.xml': `
      <project>
        <parent>
          <groupId>com.acme</groupId>
          <artifactId>acme-parent</artifactId>
          <version>1.0.0</version>
        </parent>
        <artifactId>api</artifactId>
        <dependencies>
          <dependency>
            <groupId>com.acme</groupId>
            <artifactId>core</artifactId>
          </dependency>
        </dependencies>
      </project>
    `,
    'web/pom.xml': `
      <project>
        <parent>
          <groupId>com.acme</groupId>
          <artifactId>acme-parent</artifactId>
          <version>1.0.0</version>
        </parent>
        <artifactId>web</artifactId>
        <dependencies>
          <dependency>
            <groupId>com.acme</groupId>
            <artifactId>api</artifactId>
          </dependency>
        </dependencies>
      </project>
    `
  };

  const snapshot = createSnapshot(files);
  const graph = JavaBuildModelExtractor.extractBuildModel(snapshot);

  assert.strictEqual(graph.buildSystem, 'MAVEN');
  assert.strictEqual(graph.isMultiModule, true);
  assert.strictEqual(graph.qualificationStatus, 'SUPPORTED_DECLARATIVE');
  assert.strictEqual(graph.modules.size, 3);
  assert.ok(graph.modules.has('core'));
  assert.ok(graph.modules.has('api'));
  assert.ok(graph.modules.has('web'));

  const apiMod = graph.modules.get('api')!;
  assert.deepStrictEqual(apiMod.directDependencies, ['core']);

  const webMod = graph.modules.get('web')!;
  assert.deepStrictEqual(webMod.directDependencies, ['api']);

  console.log('✓ Test 1 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 2: Static Gradle Multi-Module Reactor Extraction
// --------------------------------------------------------------------------
console.log('Running Test 2: Static Gradle Multi-Module Reactor Extraction...');
{
  const files: Record<string, string> = {
    'settings.gradle': `
      rootProject.name = 'acme-gradle'
      include ':core', ':api', ':web'
    `,
    'core/build.gradle': `
      plugins { id 'java' }
    `,
    'api/build.gradle': `
      plugins { id 'java' }
      dependencies {
        implementation project(':core')
      }
    `,
    'web/build.gradle': `
      plugins { id 'java' }
      dependencies {
        implementation project(':api')
      }
    `
  };

  const snapshot = createSnapshot(files);
  const graph = JavaBuildModelExtractor.extractBuildModel(snapshot);

  assert.strictEqual(graph.buildSystem, 'GRADLE');
  assert.strictEqual(graph.isMultiModule, true);
  assert.strictEqual(graph.qualificationStatus, 'SUPPORTED_DECLARATIVE');
  assert.strictEqual(graph.modules.size, 3);
  assert.ok(graph.modules.has('core'));
  assert.ok(graph.modules.has('api'));
  assert.ok(graph.modules.has('web'));

  const apiMod = graph.modules.get('api')!;
  assert.deepStrictEqual(apiMod.directDependencies, ['core']);

  console.log('✓ Test 2 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 3: Gradle Dynamic Scripting Detection (Fail-Closed)
// --------------------------------------------------------------------------
console.log('Running Test 3: Gradle Dynamic Scripting Detection...');
{
  const files: Record<string, string> = {
    'settings.gradle': `
      rootDir.listFiles().each { file ->
        if (file.isDirectory() && new File(file, 'build.gradle').exists()) {
          include file.name
        }
      }
    `
  };

  const snapshot = createSnapshot(files);
  const graph = JavaBuildModelExtractor.extractBuildModel(snapshot);

  assert.strictEqual(graph.buildSystem, 'GRADLE');
  assert.strictEqual(graph.qualificationStatus, 'UNSUPPORTED_DYNAMIC');
  assert.ok(graph.disqualificationReasons.length > 0);
  assert.ok(graph.disqualificationReasons[0].includes('Dynamic Gradle script logic detected'));

  console.log('✓ Test 3 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 4: Cross-Module Reactor Symbol Resolution
// --------------------------------------------------------------------------
console.log('Running Test 4: Cross-Module Reactor Symbol Resolution...');
{
  const files: Record<string, string> = {
    'pom.xml': `
      <project>
        <groupId>com.acme</groupId>
        <artifactId>acme-parent</artifactId>
        <version>1.0.0</version>
        <modules>
          <module>core</module>
          <module>api</module>
        </modules>
      </project>
    `,
    'core/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.0.0</version></parent>
        <artifactId>core</artifactId>
      </project>
    `,
    'api/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.0.0</version></parent>
        <artifactId>api</artifactId>
        <dependencies>
          <dependency><groupId>com.acme</groupId><artifactId>core</artifactId></dependency>
        </dependencies>
      </project>
    `,
    'core/src/main/java/com/acme/core/OrderService.java': `
      package com.acme.core;
      public class OrderService {
        public void process() {}
      }
    `,
    'api/src/main/java/com/acme/api/OrderApi.java': `
      package com.acme.api;
      import com.acme.core.OrderService;
      public class OrderApi {
        private OrderService service;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const host = new JavaMultiModuleCompilerHost(snapshot);

  assert.strictEqual(host.getReactorGraph().modules.size, 2);

  // Module assignment check
  const coreFile = 'core/src/main/java/com/acme/core/OrderService.java';
  const apiFile = 'api/src/main/java/com/acme/api/OrderApi.java';
  assert.strictEqual(host.getModuleForFile(coreFile)?.moduleId, 'core');
  assert.strictEqual(host.getModuleForFile(apiFile)?.moduleId, 'api');

  // Cross-module resolution: api -> OrderService in core
  const res = host.resolveCrossModuleSymbol('OrderService', apiFile);
  assert.strictEqual(res.status, 'RESOLVED');
  assert.strictEqual(res.fqcn, 'com.acme.core.OrderService');
  assert.strictEqual(res.providerModuleId, 'core');
  assert.strictEqual(res.isCrossModule, true);

  console.log('✓ Test 4 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 5: Missing Reactor Dependency Violation (Fail-Closed)
// --------------------------------------------------------------------------
console.log('Running Test 5: Missing Reactor Dependency Violation...');
{
  const files: Record<string, string> = {
    'pom.xml': `
      <project>
        <groupId>com.acme</groupId>
        <artifactId>acme-parent</artifactId>
        <version>1.0.0</version>
        <modules>
          <module>core</module>
          <module>web</module>
        </modules>
      </project>
    `,
    'core/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.0.0</version></parent>
        <artifactId>core</artifactId>
      </project>
    `,
    'web/pom.xml': `
      <project>
        <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.0.0</version></parent>
        <artifactId>web</artifactId>
        <!-- NOTICE: web does NOT declare core as a dependency! -->
      </project>
    `,
    'core/src/main/java/com/acme/core/OrderService.java': `
      package com.acme.core;
      public class OrderService {}
    `,
    'web/src/main/java/com/acme/web/OrderController.java': `
      package com.acme.web;
      import com.acme.core.OrderService;
      public class OrderController {
        private OrderService service;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const host = new JavaMultiModuleCompilerHost(snapshot);

  const webFile = 'web/src/main/java/com/acme/web/OrderController.java';
  const res = host.resolveCrossModuleSymbol('OrderService', webFile);

  assert.strictEqual(res.status, 'RESTRICTED');
  assert.strictEqual(res.restrictionKind, 'MISSING_MODULE_DEPENDENCY');
  assert.ok(res.reason.includes("Module 'web' does not declare dependency on provider module 'core'"));

  console.log('✓ Test 5 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 6: JPMS (module-info.java) Export Boundary Enforcement
// --------------------------------------------------------------------------
console.log('Running Test 6: JPMS Export Boundary Enforcement...');
{
  const files: Record<string, string> = {
    'settings.gradle': `include ':core', ':api'`,
    'core/build.gradle': `plugins { id 'java' }`,
    'api/build.gradle': `
      plugins { id 'java' }
      dependencies { implementation project(':core') }
    `,
    // core module-info exports com.acme.core.api, but HIDES com.acme.core.internal
    'core/src/main/java/module-info.java': `
      module com.acme.core {
        exports com.acme.core.api;
      }
    `,
    'core/src/main/java/com/acme/core/api/PublicService.java': `
      package com.acme.core.api;
      public class PublicService {}
    `,
    'core/src/main/java/com/acme/core/internal/SecretEngine.java': `
      package com.acme.core.internal;
      public class SecretEngine {}
    `,
    'api/src/main/java/com/acme/api/Consumer.java': `
      package com.acme.api;
      import com.acme.core.api.PublicService;
      import com.acme.core.internal.SecretEngine;
      public class Consumer {
        PublicService p;
        SecretEngine s;
      }
    `
  };

  const snapshot = createSnapshot(files);
  const host = new JavaMultiModuleCompilerHost(snapshot);

  const consumerFile = 'api/src/main/java/com/acme/api/Consumer.java';

  // PublicService is exported by core -> RESOLVED
  const publicRes = host.resolveCrossModuleSymbol('PublicService', consumerFile);
  assert.strictEqual(publicRes.status, 'RESOLVED');
  assert.strictEqual(publicRes.fqcn, 'com.acme.core.api.PublicService');

  // SecretEngine is NOT exported by core -> RESTRICTED
  const secretRes = host.resolveCrossModuleSymbol('SecretEngine', consumerFile);
  assert.strictEqual(secretRes.status, 'RESTRICTED');
  assert.strictEqual(secretRes.restrictionKind, 'JPMS_PACKAGE_NOT_EXPORTED');
  assert.ok(secretRes.reason.includes("Package 'com.acme.core.internal' in module 'core' is not exported"));

  console.log('✓ Test 6 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 7: Circular Reactor Dependency Detection
// --------------------------------------------------------------------------
console.log('Running Test 7: Circular Reactor Dependency Detection...');
{
  const files: Record<string, string> = {
    'settings.gradle': `include ':modA', ':modB'`,
    'modA/build.gradle': `dependencies { implementation project(':modB') }`,
    'modB/build.gradle': `dependencies { implementation project(':modA') }`
  };

  const snapshot = createSnapshot(files);
  const host = new JavaMultiModuleCompilerHost(snapshot);

  const cycles = host.detectReactorCycles();
  assert.ok(cycles.length > 0, 'Circular dependency between modA and modB must be detected');
  const cycle = cycles[0];
  assert.ok(cycle.includes('modA') && cycle.includes('modB'));

  console.log('✓ Test 7 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 8: Standalone Single-Module Backward Compatibility
// --------------------------------------------------------------------------
console.log('Running Test 8: Standalone Single-Module Backward Compatibility...');
{
  const files: Record<string, string> = {
    'src/com/acme/App.java': `
      package com.acme;
      public class App {}
    `
  };

  const snapshot = createSnapshot(files);
  const host = new JavaMultiModuleCompilerHost(snapshot);

  assert.strictEqual(host.getReactorGraph().buildSystem, 'STANDALONE');
  assert.strictEqual(host.getReactorGraph().isMultiModule, false);

  const res = host.resolveCrossModuleSymbol('App', 'src/com/acme/App.java');
  assert.strictEqual(res.status, 'RESOLVED');
  assert.strictEqual(res.fqcn, 'com.acme.App');
  assert.strictEqual(res.isCrossModule, false);

  console.log('✓ Test 8 passed cleanly');
}

console.log('--- ALL JAVA PHASE J-8 MULTI-MODULE TESTS PASSED ---');
