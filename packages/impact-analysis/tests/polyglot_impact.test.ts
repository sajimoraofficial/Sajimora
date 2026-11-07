import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineDependencyGraph } from '../src/OfflineDependencyGraph';
import { OfflineImpactEngine } from '../src/OfflineImpactEngine';
import { OfflineTargetResolver } from '../src/OfflineTargetResolver';

function runPolyglotSuite() {
  console.log('=== RUNNING POLYGLOT IMPACT ENGINE & PRECISION TESTS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-polyglot-test-'));

  try {
    // 1. SETUP JAVA SPRING BOOT FIXTURES
    const javaPkgDir = path.join(tempDir, 'src/main/java/com/acme/service');
    const javaModelDir = path.join(tempDir, 'src/main/java/com/acme/model');
    const javaTestDir = path.join(tempDir, 'src/test/java/com/acme/service');
    fs.mkdirSync(javaPkgDir, { recursive: true });
    fs.mkdirSync(javaModelDir, { recursive: true });
    fs.mkdirSync(javaTestDir, { recursive: true });

    // Target Service
    const orderServicePath = path.join(javaPkgDir, 'OrderService.java');
    fs.writeFileSync(
      orderServicePath,
      `package com.acme.service;\n\nimport com.acme.model.Order;\nimport org.springframework.stereotype.Service;\n\n@Service\npublic class OrderService {\n    public Order createOrder(String id) {\n        return new Order(id);\n    }\n}`
    );

    // Target Model
    const orderModelPath = path.join(javaModelDir, 'Order.java');
    fs.writeFileSync(
      orderModelPath,
      `package com.acme.model;\n\nimport javax.persistence.Entity;\n\n@Entity\npublic class Order {\n    private String id;\n    public Order(String id) { this.id = id; }\n}`
    );

    // Unrelated Model in same package
    const paymentModelPath = path.join(javaModelDir, 'Payment.java');
    fs.writeFileSync(
      paymentModelPath,
      `package com.acme.model;\n\npublic class Payment {\n    private double amount;\n}`
    );

    // Dependent Controller
    const orderControllerPath = path.join(javaPkgDir, 'OrderController.java');
    fs.writeFileSync(
      orderControllerPath,
      `package com.acme.service;\n\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class OrderController {\n    private final OrderService orderService;\n    public OrderController(OrderService orderService) {\n        this.orderService = orderService;\n    }\n}`
    );

    // Same-Package Neighbor that DOES NOT reference OrderService (Negative Test!)
    const unreferencedNeighborPath = path.join(javaPkgDir, 'UnreferencedNeighbor.java');
    fs.writeFileSync(
      unreferencedNeighborPath,
      `package com.acme.service;\n\npublic class UnreferencedNeighbor {\n    public void doSomethingElse() {\n        System.out.println("No mention of OrderService anywhere");\n    }\n}`
    );

    // Consumer with Wildcard Import (import com.acme.model.*)
    const wildcardConsumerPath = path.join(javaPkgDir, 'WildcardConsumer.java');
    fs.writeFileSync(
      wildcardConsumerPath,
      `package com.acme.service;\n\nimport com.acme.model.*;\n\npublic class WildcardConsumer {\n    private Order cachedOrder;\n}`
    );

    // Test Suite
    const orderServiceTestPath = path.join(javaTestDir, 'OrderServiceTest.java');
    fs.writeFileSync(
      orderServiceTestPath,
      `package com.acme.service;\n\nimport org.junit.jupiter.api.Test;\n\npublic class OrderServiceTest {\n    @Test\n    public void testCreate() {\n        OrderService service = new OrderService();\n    }\n}`
    );

    // 2. SETUP GO FIXTURES
    const goModPath = path.join(tempDir, 'go.mod');
    fs.writeFileSync(goModPath, 'module github.com/acme/project\n\ngo 1.22\n');

    const goServiceDir = path.join(tempDir, 'pkg/service');
    fs.mkdirSync(goServiceDir, { recursive: true });
    const goServicePath = path.join(goServiceDir, 'service.go');
    fs.writeFileSync(
      goServicePath,
      `package service\n\ntype OrderService struct {}\n\nfunc NewOrderService() *OrderService {\n    return &OrderService{}\n}`
    );

    const goHandlerPath = path.join(tempDir, 'cmd/server/handler.go');
    fs.mkdirSync(path.dirname(goHandlerPath), { recursive: true });
    fs.writeFileSync(
      goHandlerPath,
      `package server\n\nimport (\n    "fmt"\n    "net/http"\n    "github.com/acme/project/pkg/service"\n)\n\nfunc handleOrders() {\n    fmt.Println("Handling orders")\n    svc := service.NewOrderService()\n}`
    );

    // 3. SETUP RUST FIXTURES
    const rustSrcDir = path.join(tempDir, 'src/rust_app');
    fs.mkdirSync(rustSrcDir, { recursive: true });

    const rustModulePath = path.join(rustSrcDir, 'service.rs');
    fs.writeFileSync(
      rustModulePath,
      `pub struct OrderProcessor;\n\nimpl OrderProcessor {\n    pub fn process(&self) {}\n}`
    );

    const rustLibPath = path.join(rustSrcDir, 'lib.rs');
    fs.writeFileSync(
      rustLibPath,
      `pub mod service;\npub use service::OrderProcessor;`
    );

    // 4. CROSS-LANGUAGE DISAMBIGUATION FIXTURE
    const tsServicePath = path.join(tempDir, 'src/ts_app/OrderService.ts');
    fs.mkdirSync(path.dirname(tsServicePath), { recursive: true });
    fs.writeFileSync(
      tsServicePath,
      `export class OrderService {\n    public id: string = "ts-service";\n}`
    );

    const allFiles = [
      'src/main/java/com/acme/service/OrderService.java',
      'src/main/java/com/acme/model/Order.java',
      'src/main/java/com/acme/model/Payment.java',
      'src/main/java/com/acme/service/OrderController.java',
      'src/main/java/com/acme/service/UnreferencedNeighbor.java',
      'src/main/java/com/acme/service/WildcardConsumer.java',
      'src/test/java/com/acme/service/OrderServiceTest.java',
      'go.mod',
      'pkg/service/service.go',
      'cmd/server/handler.go',
      'src/rust_app/service.rs',
      'src/rust_app/lib.rs',
      'src/ts_app/OrderService.ts'
    ];

    const graph = new OfflineDependencyGraph({
      repoRoot: tempDir,
      files: allFiles
    });

    const impactEngine = new OfflineImpactEngine();

    // TEST 1: Java Negative Edge Control
    const incomingToOrderService = graph.getIncomingEdges('src/main/java/com/acme/service/OrderService.java');
    const incomingFromUnreferenced = incomingToOrderService.filter(
      e => e.from === 'src/main/java/com/acme/service/UnreferencedNeighbor.java'
    );
    assert.strictEqual(
      incomingFromUnreferenced.length,
      0,
      'FAILED: Unreferenced same-package class must NOT have a dependency edge'
    );
    console.log('[PASS] Java Negative Edge Control: Unreferenced same-package class has 0 edges');

    // TEST 2: Java Wildcard Scope Containment
    const incomingToOrder = graph.getIncomingEdges('src/main/java/com/acme/model/Order.java');
    const incomingToPayment = graph.getIncomingEdges('src/main/java/com/acme/model/Payment.java');

    const wildcardToOrder = incomingToOrder.find(
      e => e.from === 'src/main/java/com/acme/service/WildcardConsumer.java'
    );
    const wildcardToPayment = incomingToPayment.find(
      e => e.from === 'src/main/java/com/acme/service/WildcardConsumer.java'
    );

    assert.ok(wildcardToOrder, 'FAILED: WildcardConsumer uses Order and must have edge to Order.java');
    assert.strictEqual(
      wildcardToPayment,
      undefined,
      'FAILED: WildcardConsumer does NOT use Payment and MUST NOT have edge to Payment.java'
    );
    console.log('[PASS] Java Wildcard Scope: Only referenced class receives edge from import com.acme.model.*');

    // TEST 3: Java Blast Radius & Role Classification
    const javaResolution = {
      status: 'RESOLVED' as const,
      targetKind: 'FILE' as const,
      node: 'src/main/java/com/acme/service/OrderService.java'
    };
    const javaImpact = impactEngine.analyze(javaResolution, graph);

    assert.ok(
      javaImpact.directDependents.includes('src/main/java/com/acme/service/OrderController.java'),
      'FAILED: OrderController must be a direct dependent of OrderService'
    );
    assert.ok(
      javaImpact.affectedTests.includes('src/test/java/com/acme/service/OrderServiceTest.java'),
      'FAILED: OrderServiceTest must be classified as an affected test suite'
    );
    assert.ok(
      javaImpact.affectedRoutes.includes('src/main/java/com/acme/service/OrderController.java'),
      'FAILED: OrderController must be classified as an affected API route'
    );
    assert.strictEqual(
      javaImpact.directDependents.includes('src/main/java/com/acme/service/UnreferencedNeighbor.java'),
      false,
      'FAILED: UnreferencedNeighbor must NOT be in blast radius'
    );
    console.log('[PASS] Java Impact Analysis: OrderController & OrderServiceTest discovered; false positive excluded');

    // TEST 4: Go Module Resolution & Stdlib Filtering
    const incomingToGoService = graph.getIncomingEdges('pkg/service/service.go');
    const goCaller = incomingToGoService.find(e => e.from === 'cmd/server/handler.go');
    assert.ok(goCaller, 'FAILED: Go internal module import must link handler.go -> service.go');

    const outgoingFromHandler = graph.getOutgoingEdges('cmd/server/handler.go');
    const stdlibEdges = outgoingFromHandler.filter(
      e => e.to.includes('fmt') || e.to.includes('net/http')
    );
    assert.strictEqual(
      stdlibEdges.length,
      0,
      'FAILED: Go standard library imports must NOT enter the repository dependency graph'
    );
    console.log('[PASS] Go Module Resolution: Internal package linked; stdlib "fmt" and "net/http" filtered out');

    // TEST 5: Rust Facade Re-Export Typing
    const incomingToRustService = graph.getIncomingEdges('src/rust_app/service.rs');
    const reexportEdge = incomingToRustService.find(e => e.from === 'src/rust_app/lib.rs');

    assert.ok(reexportEdge, 'FAILED: lib.rs pub use must link to service.rs');
    assert.strictEqual(
      reexportEdge?.relation,
      'REEXPORT',
      'FAILED: pub use statement must be typed as REEXPORT'
    );
    console.log('[PASS] Rust Facade Re-Export: pub use service::* strictly tagged as relation: REEXPORT');

    // TEST 6: Cross-Language Ambiguity in Target Resolver
    const resolver = new OfflineTargetResolver({ repoRoot: tempDir });
    const crossLangRes = resolver.resolveTarget('OrderService');

    assert.strictEqual(
      crossLangRes.status,
      'AMBIGUOUS',
      'FAILED: Symbol OrderService exists in both Java and TS, must produce AMBIGUOUS'
    );
    assert.ok(
      crossLangRes.candidates && crossLangRes.candidates.length >= 2,
      'FAILED: Ambiguous resolution must list candidate files'
    );
    console.log('[PASS] Cross-Language Ambiguity: "OrderService" detected in both Java and TS -> AMBIGUOUS surfaced');

    console.log('\nPolyglot Impact Engine Summary: ALL 6 TESTS PASSED\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runPolyglotSuite();
