/**
 * @file JavaPhase1AAliasFixtures.test.ts
 * T1 Alias Fixture Suite for Java Phase 1A (§4 WS1 Core: High-Yield Core References).
 *
 * Enforces ≥2 unit fixtures (one MATCH, one non-MATCH) for every form in §4 Phase 1A:
 *   Form 1: Implicit & Explicit Self/Super Calls (bare m(), this.m(), super.m())
 *   Form 2: Static Invocations & Static Imports (Foo.m(), import static Foo.m)
 *   Form 3: Known Receiver Variables (local variables, parameters, fields)
 *   Form 4: Direct Class Inheritance (subVar.m() where subVar statically extends changed provider)
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JavaSealedRevision
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Phase 1A T1 Alias Fixture Test Suite ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// ============================================================================
// Form 1: Implicit & Explicit Self/Super Calls
// ============================================================================

// Fixture 1A-1 (MATCH): super.calculate(x) broken when Base.calculate signature changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p1',
    files: {
      'src/com/acme/Base.java': `
        package com.acme;
        public class Base {
          public int calculate(int x) { return x * 2; }
        }
      `,
      'src/com/acme/Sub.java': `
        package com.acme;
        public class Sub extends Base {
          public int run() {
            return super.calculate(10);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c1',
    files: {
      'src/com/acme/Base.java': `
        package com.acme;
        public class Base {
          public int calculate() { return 0; }
        }
      `,
      'src/com/acme/Sub.java': `
        package com.acme;
        public class Sub extends Base {
          public int run() {
            return super.calculate(10);
          }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'super.calculate change must be detected as LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Must have a LIKELY_BROKEN impact for super call');
  console.log('✓ Form 1 Fixture A (MATCH: super call) passed');
}

// Fixture 1A-2 (non-MATCH): super.calculate(x) unaffected when unrelated Base.log() changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p2',
    files: {
      'src/com/acme/Base.java': `
        package com.acme;
        public class Base {
          public int calculate(int x) { return x * 2; }
          public void log() {}
        }
      `,
      'src/com/acme/Sub.java': `
        package com.acme;
        public class Sub extends Base {
          public int run() {
            return super.calculate(10);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c2',
    files: {
      'src/com/acme/Base.java': `
        package com.acme;
        public class Base {
          public int calculate(int x) { return x * 2; }
          public void log(String msg) {}
        }
      `,
      'src/com/acme/Sub.java': `
        package com.acme;
        public class Sub extends Base {
          public int run() {
            return super.calculate(10);
          }
        }
      `
    }
  };

  // Targeting calculate specifically
  const res = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.Base', memberName: 'calculate' }
  });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Unchanged calculate must be LIKELY_PRESERVED');
  assert.ok(res.impacts.every(i => i.classification !== 'LIKELY_BROKEN'), 'No impact should be broken');
  console.log('✓ Form 1 Fixture B (non-MATCH: super call) passed');
}

// ============================================================================
// Form 2: Static Invocations & Imports
// ============================================================================

// Fixture 1A-3 (MATCH): Static Helper.format(x) broken when parameter removed
{
  const parent: JavaSealedRevision = {
    commitSha: 'p3',
    files: {
      'src/com/util/Helper.java': `
        package com.util;
        public class Helper {
          public static String format(int val) { return "" + val; }
        }
      `,
      'src/com/app/Consumer.java': `
        package com.app;
        import com.util.Helper;
        public class Consumer {
          public void print() {
            Helper.format(42);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c3',
    files: {
      'src/com/util/Helper.java': `
        package com.util;
        public class Helper {
          public static String format() { return ""; }
        }
      `,
      'src/com/app/Consumer.java': `
        package com.app;
        import com.util.Helper;
        public class Consumer {
          public void print() {
            Helper.format(42);
          }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Static method signature break must be LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Static call site must be LIKELY_BROKEN');
  console.log('✓ Form 2 Fixture A (MATCH: static invocation) passed');
}

// Fixture 1A-4 (non-MATCH): Static Helper.format(x) unaffected when Helper.reset() changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p4',
    files: {
      'src/com/util/Helper.java': `
        package com.util;
        public class Helper {
          public static String format(int val) { return "" + val; }
          public static void reset() {}
        }
      `,
      'src/com/app/Consumer.java': `
        package com.app;
        import com.util.Helper;
        public class Consumer {
          public void print() {
            Helper.format(42);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c4',
    files: {
      'src/com/util/Helper.java': `
        package com.util;
        public class Helper {
          public static String format(int val) { return "" + val; }
          public static void reset(int code) {}
        }
      `,
      'src/com/app/Consumer.java': `
        package com.app;
        import com.util.Helper;
        public class Consumer {
          public void print() {
            Helper.format(42);
          }
        }
      `
    }
  };

  const res = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.util.Helper', memberName: 'format' }
  });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Unchanged static format must be LIKELY_PRESERVED');
  console.log('✓ Form 2 Fixture B (non-MATCH: static invocation) passed');
}

// ============================================================================
// Form 3: Known Receiver Variables (Local variables, parameters, fields)
// ============================================================================

// Fixture 1A-5 (MATCH): Local variable svc.process(id) broken when OrderService.process return type changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p5',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String process(String id) { return id; }
        }
      `,
      'src/com/acme/OrderHandler.java': `
        package com.acme;
        public class OrderHandler {
          public void handle(String id) {
            OrderService svc = new OrderService();
            svc.process(id);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c5',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public int process(String id) { return 0; }
        }
      `,
      'src/com/acme/OrderHandler.java': `
        package com.acme;
        public class OrderHandler {
          public void handle(String id) {
            OrderService svc = new OrderService();
            svc.process(id);
          }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Local variable method call break must be LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Local variable call site must be LIKELY_BROKEN');
  console.log('✓ Form 3 Fixture A (MATCH: local variable receiver) passed');
}

// Fixture 1A-6 (non-MATCH): Local variable svc.process(id) unaffected when OrderService.shutdown() changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p6',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String process(String id) { return id; }
          public void shutdown() {}
        }
      `,
      'src/com/acme/OrderHandler.java': `
        package com.acme;
        public class OrderHandler {
          public void handle(String id) {
            OrderService svc = new OrderService();
            svc.process(id);
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c6',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String process(String id) { return id; }
          public void shutdown(int timeout) {}
        }
      `,
      'src/com/acme/OrderHandler.java': `
        package com.acme;
        public class OrderHandler {
          public void handle(String id) {
            OrderService svc = new OrderService();
            svc.process(id);
          }
        }
      `
    }
  };

  const res = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.OrderService', memberName: 'process' }
  });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Unchanged process method on local variable must be LIKELY_PRESERVED');
  console.log('✓ Form 3 Fixture B (non-MATCH: local variable receiver) passed');
}

// ============================================================================
// Form 4: Direct Class Inheritance
// ============================================================================

// Fixture 1A-7 (MATCH): sub.execute() broken when BaseService.execute parameter added
{
  const parent: JavaSealedRevision = {
    commitSha: 'p7',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void execute() {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {}
      `,
      'src/com/acme/Client.java': `
        package com.acme;
        public class Client {
          public void run() {
            SubService sub = new SubService();
            sub.execute();
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c7',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void execute(int mode) {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {}
      `,
      'src/com/acme/Client.java': `
        package com.acme;
        public class Client {
          public void run() {
            SubService sub = new SubService();
            sub.execute();
          }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Inherited call break on subtype variable must be LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Inherited call site must be LIKELY_BROKEN');
  console.log('✓ Form 4 Fixture A (MATCH: direct class inheritance) passed');
}

// Fixture 1A-8 (non-MATCH): sub.execute() unaffected when unrelated BaseService.cleanup() changes
{
  const parent: JavaSealedRevision = {
    commitSha: 'p8',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void execute() {}
          public void cleanup() {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {}
      `,
      'src/com/acme/Client.java': `
        package com.acme;
        public class Client {
          public void run() {
            SubService sub = new SubService();
            sub.execute();
          }
        }
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c8',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void execute() {}
          public void cleanup(boolean force) {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {}
      `,
      'src/com/acme/Client.java': `
        package com.acme;
        public class Client {
          public void run() {
            SubService sub = new SubService();
            sub.execute();
          }
        }
      `
    }
  };

  const res = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.BaseService', memberName: 'execute' }
  });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Unchanged inherited method on subtype variable must be LIKELY_PRESERVED');
  console.log('✓ Form 4 Fixture B (non-MATCH: direct class inheritance) passed');
}

console.log('\n--- ALL 8 PHASE 1A T1 ALIAS FIXTURES PASSED ---');
