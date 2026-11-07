/**
 * @file JavaBuildFallback.test.ts
 * Tests for Step 5: Namespace Fallback for Incomplete Builds (§5.3) & Pillar 2 Violation Precedence.
 *
 * Verifies:
 *   1. Dynamic / incomplete build descriptors trigger symbolResolutionQuality === 'NAMESPACE_FALLBACK'
 *      and emit ABST_BUILD_INCOMPLETE without crashing.
 *   2. Pillar 2: Proven breaking violations (LIKELY_BROKEN impacts) outrank fallback unknown
 *      verdicts, resulting in LIKELY_VIOLATED even under incomplete builds.
 *   3. Fail-closed safety: In the absence of proven violations, incomplete builds fail closed
 *      to INCONCLUSIVE (never falsely claiming LIKELY_PRESERVED).
 *   4. Fully declarative builds report symbolResolutionQuality === 'FULL_BUILD_MODEL'.
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JavaSealedRevision
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Build Fallback & Pillar 2 Test Suite ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// Dynamic Gradle script that causes build qualification to reject as UNSUPPORTED_DYNAMIC
const dynamicGradle = `
  plugins {
    id 'java'
  }
  def customLibs = fileTree('libs')
`;

// ============================================================================
// Test 1: Incomplete Build with Broken Call Site -> LIKELY_VIOLATED (Pillar 2)
// ============================================================================
{
  const parent: JavaSealedRevision = {
    commitSha: 'p-fallback-1',
    files: {
      'build.gradle': dynamicGradle,
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public void placeOrder(String id) {}
        }
      `,
      'src/main/java/com/acme/CheckoutController.java': `
        package com.acme;
        public class CheckoutController {
          public void checkout() {
            OrderService svc = new OrderService();
            svc.placeOrder("ORD-123");
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c-fallback-1',
    files: {
      'build.gradle': dynamicGradle,
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {}
      `,
      'src/main/java/com/acme/CheckoutController.java': parent.files['src/main/java/com/acme/CheckoutController.java']
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  // Pillar 2: High-confidence violations outrank build incompleteness
  assert.equal(result.verdict, 'LIKELY_VIOLATED', 'Violation must outrank incomplete build fallback');
  assert.equal(result.completeness.symbolResolutionQuality, 'NAMESPACE_FALLBACK', 'Must flag namespace fallback');
  console.log('✓ Test 1 PASS (Pillar 2: LIKELY_VIOLATED outranks NAMESPACE_FALLBACK incomplete build)');
}

// ============================================================================
// Test 2: Incomplete Build with No Violations -> INCONCLUSIVE (Fail-Closed)
// ============================================================================
{
  const parent: JavaSealedRevision = {
    commitSha: 'p-fallback-2',
    files: {
      'build.gradle': dynamicGradle,
      'src/main/java/com/acme/Worker.java': `
        package com.acme;
        public class Worker {
          public void doWork() {}
        }
      `,
      'src/main/java/com/acme/Manager.java': `
        package com.acme;
        public class Manager {
          public void manage() {}
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c-fallback-2',
    files: {
      'build.gradle': dynamicGradle,
      'src/main/java/com/acme/Worker.java': `
        package com.acme;
        public class Worker {
          public void doWork() {}
          public void doExtraWork() {}
        }
      `,
      'src/main/java/com/acme/Manager.java': parent.files['src/main/java/com/acme/Manager.java']
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  // Fail-closed honesty: Incomplete build cannot guarantee preservation without declarative model
  assert.equal(result.verdict, 'INCONCLUSIVE', 'Incomplete build must fail closed to INCONCLUSIVE when no violation');
  assert.equal(result.completeness.symbolResolutionQuality, 'NAMESPACE_FALLBACK');
  assert.ok(result.abstentionCodes.includes('ABST_BUILD_INCOMPLETE'));
  console.log('✓ Test 2 PASS (Fail-Closed: Incomplete build demotes non-breaking changes to INCONCLUSIVE)');
}

// ============================================================================
// Test 3: Fully Qualified Build Model -> FULL_BUILD_MODEL
// ============================================================================
{
  const pomXml = `
    <project xmlns="http://maven.apache.org/POM/4.0.0">
      <modelVersion>4.0.0</modelVersion>
      <groupId>com.acme</groupId>
      <artifactId>app</artifactId>
      <version>1.0.0</version>
    </project>
  `;

  const parent: JavaSealedRevision = {
    commitSha: 'p-full-1',
    files: {
      'pom.xml': pomXml,
      'src/main/java/com/acme/Calculator.java': `
        package com.acme;
        public class Calculator {
          public int add(int a, int b) { return a + b; }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c-full-1',
    files: {
      'pom.xml': pomXml,
      'src/main/java/com/acme/Calculator.java': `
        package com.acme;
        public class Calculator {
          public int add(int a, int b) { return a + b; }
          public int multiply(int a, int b) { return a * b; }
        }
      `
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.completeness.symbolResolutionQuality, 'FULL_BUILD_MODEL', 'Valid pom must report FULL_BUILD_MODEL');
  assert.equal(result.verdict, 'LIKELY_PRESERVED', 'Additive change under full build model resolves LIKELY_PRESERVED');
  console.log('✓ Test 3 PASS (FULL_BUILD_MODEL: Valid declarative build produces LIKELY_PRESERVED on additive change)');
}

console.log('--- ALL JAVA BUILD FALLBACK & PILLAR 2 TESTS PASSED (3/3) ---');
