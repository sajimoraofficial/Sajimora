import assert from 'node:assert/strict';
import {
  JavaTypeIRExtractor,
  JavaSealedCompilerHost
} from '../../src/sajimora/languages/java';
import {
  AdvisoryJavaImpactAnalyzer,
  ADVISORY_JAVA_SCHEMA_VERSION
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Phase J-5 Test Suite (Body-Level Call Sites) ---');

// ---------------------------------------------------------------------------
// Test 1: Direct Method Invocation & Constructor Extraction via Tree-sitter
// ---------------------------------------------------------------------------
{
  const source = `
    package com.acme;
    import com.util.Helper;
    import com.data.Order;

    public class OrderController {
      private OrderService service;

      public void handle(String id) {
        service.process(id, 42);
        Helper.log("processed " + id);
        doLocal();
        Order order = new Order(id);
        int max = Math.max(10, 20);
        this.ping();
      }

      private void doLocal() {}
      private void ping() {}
    }
  `;

  const parsed = JavaTypeIRExtractor.parseJavaSource('src/com/acme/OrderController.java', source);

  assert.ok(parsed.callSites, 'callSites must be extracted');
  assert.ok(parsed.callSites.length >= 6, `Expected at least 6 call sites, got ${parsed.callSites.length}`);

  // 1. Variable call: service.process(id, 42) -> HEURISTIC
  const serviceCall = parsed.callSites.find(cs => cs.calleeName === 'process');
  assert.ok(serviceCall, 'service.process call must be found');
  assert.equal(serviceCall.callKind, 'METHOD_CALL');
  assert.equal(serviceCall.evidenceKind, 'HEURISTIC');
  assert.equal(serviceCall.receiverText, 'service');
  assert.equal(serviceCall.argumentCount, 2);
  assert.equal(serviceCall.enclosingMethodName, 'handle');
  assert.equal(serviceCall.enclosingClassFqcn, 'com.acme.OrderController');

  // 2. Class static call: Helper.log(...) -> STATIC_AST
  const helperCall = parsed.callSites.find(cs => cs.calleeName === 'log');
  assert.ok(helperCall, 'Helper.log call must be found');
  assert.equal(helperCall.callKind, 'METHOD_CALL');
  assert.equal(helperCall.evidenceKind, 'STATIC_AST');
  assert.equal(helperCall.receiverText, 'Helper');
  assert.equal(helperCall.resolvedTargetFqcn, 'com.util.Helper');
  assert.equal(helperCall.argumentCount, 1);

  // 3. Local call: doLocal() -> STATIC_AST
  const localCall = parsed.callSites.find(cs => cs.calleeName === 'doLocal');
  assert.ok(localCall, 'doLocal call must be found');
  assert.equal(localCall.evidenceKind, 'STATIC_AST');
  assert.equal(localCall.argumentCount, 0);

  // 4. Constructor call: new Order(id) -> STATIC_AST
  const newOrderCall = parsed.callSites.find(cs => cs.callKind === 'CONSTRUCTOR_CALL');
  assert.ok(newOrderCall, 'new Order constructor call must be found');
  assert.equal(newOrderCall.evidenceKind, 'STATIC_AST');
  assert.equal(newOrderCall.receiverText, 'Order');
  assert.equal(newOrderCall.resolvedTargetFqcn, 'com.data.Order');
  assert.equal(newOrderCall.argumentCount, 1);

  // 5. Math.max -> STATIC_AST
  const mathCall = parsed.callSites.find(cs => cs.calleeName === 'max');
  assert.ok(mathCall, 'Math.max call must be found');
  assert.equal(mathCall.evidenceKind, 'STATIC_AST');
  assert.equal(mathCall.receiverText, 'Math');

  // 6. this.ping() -> STATIC_AST
  const thisCall = parsed.callSites.find(cs => cs.calleeName === 'ping');
  assert.ok(thisCall, 'this.ping call must be found');
  assert.equal(thisCall.evidenceKind, 'STATIC_AST');

  // Check method-level call site attachment
  const controllerClass = parsed.classes[0];
  assert.ok(controllerClass);
  const handleMethod = controllerClass.methods.find(m => m.name === 'handle');
  assert.ok(handleMethod);
  assert.ok(handleMethod.callSites && handleMethod.callSites.length >= 6);

  console.log('✓ Test 1: Direct Method Invocation & Constructor Extraction passed');
}

// ---------------------------------------------------------------------------
// Test 2: Method References (ClassName::method and ClassName::new)
// ---------------------------------------------------------------------------
{
  const source = `
    package com.acme;
    import com.data.Order;

    public class ReferenceDemo {
      public void setup() {
        Runnable r1 = Order::new;
        Consumer<Order> c1 = Order::process;
        Order myOrder = new Order();
        Runnable r2 = myOrder::cancel;
      }
    }
  `;

  const parsed = JavaTypeIRExtractor.parseJavaSource('src/com/acme/ReferenceDemo.java', source);
  assert.ok(parsed.callSites);

  // Constructor reference: Order::new
  const ctorRef = parsed.callSites.find(cs => cs.callKind === 'CONSTRUCTOR_REFERENCE');
  assert.ok(ctorRef, 'Constructor reference must be found');
  assert.equal(ctorRef.evidenceKind, 'STATIC_AST');
  assert.equal(ctorRef.receiverText, 'Order');
  assert.equal(ctorRef.resolvedTargetFqcn, 'com.data.Order');

  // Static/Type method reference: Order::process
  const typeMethodRef = parsed.callSites.find(cs => cs.callKind === 'METHOD_REFERENCE' && cs.receiverText === 'Order');
  assert.ok(typeMethodRef, 'Order::process must be found');
  assert.equal(typeMethodRef.evidenceKind, 'STATIC_AST');
  assert.equal(typeMethodRef.calleeName, 'process');

  // Instance method reference: myOrder::cancel
  const instanceMethodRef = parsed.callSites.find(cs => cs.callKind === 'METHOD_REFERENCE' && cs.receiverText === 'myOrder');
  assert.ok(instanceMethodRef, 'myOrder::cancel must be found');
  assert.equal(instanceMethodRef.evidenceKind, 'HEURISTIC');
  assert.equal(instanceMethodRef.calleeName, 'cancel');

  console.log('✓ Test 2: Method References passed');
}

// ---------------------------------------------------------------------------
// Test 3: Field Access Expressions (Constants.FIELD)
// ---------------------------------------------------------------------------
{
  const source = `
    package com.acme;
    import com.util.Config;

    public class FieldDemo {
      public int getTimeout() {
        return Config.DEFAULT_TIMEOUT;
      }
    }
  `;

  const parsed = JavaTypeIRExtractor.parseJavaSource('src/com/acme/FieldDemo.java', source);
  assert.ok(parsed.callSites);

  const fieldAccess = parsed.callSites.find(cs => cs.callKind === 'FIELD_ACCESS');
  assert.ok(fieldAccess, 'Field access must be extracted');
  assert.equal(fieldAccess.calleeName, 'DEFAULT_TIMEOUT');
  assert.equal(fieldAccess.receiverText, 'Config');
  assert.equal(fieldAccess.evidenceKind, 'STATIC_AST');
  assert.equal(fieldAccess.resolvedTargetFqcn, 'com.util.Config');

  console.log('✓ Test 3: Field Access Expressions passed');
}

// ---------------------------------------------------------------------------
// Test 4: Host-Level Call Site Querying via JavaSealedCompilerHost
// ---------------------------------------------------------------------------
{
  const files: Record<string, string> = {
    'src/com/acme/A.java': `
      package com.acme;
      public class A {
        public void execute() {
          B b = new B();
          b.run();
        }
      }
    `,
    'src/com/acme/B.java': `
      package com.acme;
      public class B {
        public void run() {}
      }
    `
  };

  const host = new JavaSealedCompilerHost({
    trackedFiles: Object.keys(files),
    readTextFile: path => files[path]
  });

  const aCallSites = host.getFileCallSites('src/com/acme/A.java');
  assert.ok(aCallSites.length >= 2, 'File A must have at least 2 call sites');

  const allCallSites = host.getAllCallSites();
  assert.ok(allCallSites.length >= 2, 'All call sites must be accessible');

  const bClass = host.getClassByFQCN('com.acme.B');
  assert.ok(bClass);

  console.log('✓ Test 4: JavaSealedCompilerHost Call Site Querying passed');
}

// ---------------------------------------------------------------------------
// Test 5: End-to-End Advisory Impact with Call Sites (J-5 Integration)
// ---------------------------------------------------------------------------
{
  const analyzer = new AdvisoryJavaImpactAnalyzer();

  const parent = {
    commitSha: 'parent-sha',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public void cancelOrder(String id) {}
          public void queryOrder(String id) {}
        }
      `,
      'src/com/acme/CancelConsumer.java': `
        package com.acme;
        import com.acme.OrderService;
        public class CancelConsumer {
          private OrderService service;
          public void doCancel(String id) {
            service.cancelOrder(id);
          }
        }
      `,
      'src/com/acme/QueryConsumer.java': `
        package com.acme;
        import com.acme.OrderService;
        public class QueryConsumer {
          private OrderService service;
          public void doQuery(String id) {
            service.queryOrder(id);
          }
        }
      `
    }
  };

  // Candidate removes cancelOrder, but keeps queryOrder
  const candidate = {
    commitSha: 'candidate-sha',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public void queryOrder(String id) {}
        }
      `,
      'src/com/acme/CancelConsumer.java': `
        package com.acme;
        import com.acme.OrderService;
        public class CancelConsumer {
          private OrderService service;
          public void doCancel(String id) {
            service.cancelOrder(id);
          }
        }
      `,
      'src/com/acme/QueryConsumer.java': `
        package com.acme;
        import com.acme.OrderService;
        public class QueryConsumer {
          private OrderService service;
          public void doQuery(String id) {
            service.queryOrder(id);
          }
        }
      `
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  assert.equal(result.schemaVersion, ADVISORY_JAVA_SCHEMA_VERSION);
  assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
  assert.equal(result.verdict, 'LIKELY_VIOLATED');

  // Verify that CancelConsumer has a CALL_SITE reference (J-5)
  const cancelCallSiteRef = result.consumers.find(
    c => c.consumerFqcn === 'com.acme.CancelConsumer' && c.referenceKind === 'CALL_SITE'
  );
  assert.ok(cancelCallSiteRef, 'CancelConsumer must have a CALL_SITE reference');
  assert.equal(cancelCallSiteRef.bindingKind, 'J-5');
  assert.ok(cancelCallSiteRef.callSite);
  assert.equal(cancelCallSiteRef.callSite.calleeName, 'cancelOrder');

  const cancelMethod = result.providers.find(p => p.memberName === 'cancelOrder');
  assert.ok(cancelMethod, 'cancelOrder provider must be detected');

  // Verify that CancelConsumer's call-site impact for cancelOrder is LIKELY_BROKEN
  const cancelCallSiteImpact = result.impacts.find(
    i => i.providerId === cancelMethod.id && i.consumerFqcn === 'com.acme.CancelConsumer' && i.referenceKind === 'CALL_SITE'
  );
  assert.ok(cancelCallSiteImpact, 'CancelConsumer call-site impact must be found');
  assert.equal(cancelCallSiteImpact.classification, 'LIKELY_BROKEN');

  // Verify that QueryConsumer's call-site (queryOrder) is UNAFFECTED by cancelOrder removal!
  const queryCallSiteImpact = result.impacts.find(
    i => i.providerId === cancelMethod.id && i.consumerFqcn === 'com.acme.QueryConsumer' && i.referenceKind === 'CALL_SITE'
  );
  assert.ok(queryCallSiteImpact, 'QueryConsumer call-site impact must be found');
  assert.equal(queryCallSiteImpact.classification, 'UNAFFECTED');

  // Verify traces include the call-site step with evidence kind
  const trace = result.traces.find(
    t => t.providerId === cancelMethod.id && t.steps.some(s => s.detail.includes('invokes') || s.detail.includes('calls'))
  );
  assert.ok(trace, 'Trace step with call-site detail must exist');

  console.log('✓ Test 5: End-to-End Advisory Impact with Call Sites (J-5 Integration) passed');
}

// ---------------------------------------------------------------------------
// Test 6: Determinism Verification
// ---------------------------------------------------------------------------
{
  const source = `
    package com.acme;
    public class DeterminismTest {
      public void run() {
        System.out.println("hello");
        new Object().toString();
      }
    }
  `;

  const run1 = JavaTypeIRExtractor.parseJavaSource('src/com/acme/DeterminismTest.java', source);
  const run2 = JavaTypeIRExtractor.parseJavaSource('src/com/acme/DeterminismTest.java', source);

  assert.deepEqual(run1, run2, 'parseJavaSource must be strictly deterministic');
  console.log('✓ Test 6: Determinism Verification passed');
}

console.log('--- ALL 6 JAVA PHASE J-5 TESTS PASSED ---');
