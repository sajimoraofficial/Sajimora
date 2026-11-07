import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AdvisoryJavaImpactAnalyzer,
  reconcileJavaAdvisoryResult,
  createJavaAdvisoryReport,
  renderJavaAdvisoryMarkdown,
  runJavaAdvisoryBenchmark,
  JavaRepositoryRevisionAnalyzer,
  JavaAdvisoryBenchmarkCase,
  ADVISORY_JAVA_SCHEMA_VERSION
} from '../../src/sajimora/advisory';
import { JavaBuildModelExtractor } from '../../src/sajimora/languages/java/programs/JavaBuildModelExtractor';

console.log('--- Starting AdvisoryJavaImpactAnalyzer Test Suite (Phase J-4) ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// ---------------------------------------------------------------------------
// Test 1: Basic Breaking Change (Method Removed) -> LIKELY_VIOLATED
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'parent-sha',
    files: {
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String findOrder(String id) { return id; }
          public void cancelOrder(String id) {}
        }
      `,
      'src/main/java/com/acme/OrderController.java': `
        package com.acme;
        import com.acme.OrderService;
        public class OrderController {
          private OrderService service;
        }
      `
    }
  };

  const candidate = {
    commitSha: 'candidate-sha',
    files: {
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String findOrder(String id) { return id; }
        }
      `,
      'src/main/java/com/acme/OrderController.java': `
        package com.acme;
        import com.acme.OrderService;
        public class OrderController {
          private OrderService service;
        }
      `
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  assert.equal(result.schemaVersion, ADVISORY_JAVA_SCHEMA_VERSION);
  assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.parentCommitSha, 'parent-sha');
  assert.equal(result.candidateCommitSha, 'candidate-sha');

  // Verify provider diff
  const removedMethod = result.providers.find(p => p.memberName === 'cancelOrder');
  assert.ok(removedMethod, 'cancelOrder provider must be detected');
  assert.equal(removedMethod.change, 'METHOD_REMOVED');
  assert.equal(removedMethod.identity, 'CASE_B');
  assert.equal(removedMethod.memberKind, 'METHOD');
  assert.equal(removedMethod.fqcn, 'com.acme.OrderService');

  // Verify consumer discovery
  assert.ok(result.consumers.length > 0, 'Consumer must be discovered');
  const controllerConsumer = result.consumers.find(c => c.consumerFqcn === 'com.acme.OrderController');
  assert.ok(controllerConsumer);
  assert.equal(controllerConsumer.referenceKind, 'SINGLE_IMPORT');
  assert.equal(controllerConsumer.bindingKind, 'J-1');

  // Verify impact classification
  const brokenImpact = result.impacts.find(i => i.providerId === removedMethod.id);
  assert.ok(brokenImpact);
  assert.equal(brokenImpact.classification, 'LIKELY_BROKEN');

  // Verify traces
  assert.ok(result.traces.length > 0);
  const trace = result.traces.find(t => t.providerId === removedMethod.id);
  assert.ok(trace);
  assert.equal(trace.completeness, 'COMPLETE');
  assert.ok(trace.steps.some(s => s.kind === 'PROVIDER'));
  assert.ok(trace.steps.some(s => s.kind === 'IMPORT'));
  assert.ok(trace.steps.some(s => s.kind === 'CONSUMER'));

  // Determinism check
  const secondRun = analyzer.analyze({ parent, candidate });
  assert.deepEqual(result, secondRun, 'Analysis must be strictly deterministic');
  console.log('✓ Test 1: Basic Breaking Change passed');
}

// ---------------------------------------------------------------------------
// Test 2: Compatible Additive Change (Method & Field Added) -> LIKELY_PRESERVED
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p1',
    files: {
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          public String findOrder(String id) { return id; }
        }
      `,
      'src/main/java/com/acme/OrderController.java': `
        package com.acme;
        import com.acme.OrderService;
        public class OrderController {}
      `
    }
  };

  const candidate = {
    commitSha: 'c1',
    files: {
      'src/main/java/com/acme/OrderService.java': `
        package com.acme;
        public class OrderService {
          private int timeoutMs;
          public String findOrder(String id) { return id; }
          public void logMetrics() {}
        }
      `,
      'src/main/java/com/acme/OrderController.java': `
        package com.acme;
        import com.acme.OrderService;
        public class OrderController {}
      `
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
  assert.equal(result.verdict, 'LIKELY_PRESERVED');
  assert.ok(result.providers.some(p => p.change === 'METHOD_ADDED'));
  assert.ok(result.providers.some(p => p.change === 'FIELD_ADDED'));
  assert.ok(result.impacts.every(i => i.classification === 'LIKELY_COMPATIBLE' || i.classification === 'UNAFFECTED'));
  console.log('✓ Test 2: Compatible Additive Change passed');
}

// ---------------------------------------------------------------------------
// Test 3: Consumer Bindings Matrix (J-1, J-2, J-3, J-4, J-6, J-7, J-8, J-9)
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p-bindings',
    files: {
      'src/com/base/Provider.java': `
        package com.base;
        public class Provider {
          public static final String CONSTANT = "OK";
          public void execute() {}
        }
      `,
      'src/com/base/IProvider.java': `
        package com.base;
        public interface IProvider {
          void doAction();
        }
      `,
      // J-1: Single import
      'src/com/app/ConsumerJ1.java': `
        package com.app;
        import com.base.Provider;
        public class ConsumerJ1 {}
      `,
      // J-2: Wildcard import
      'src/com/app/ConsumerJ2.java': `
        package com.app;
        import com.base.*;
        public class ConsumerJ2 {}
      `,
      // J-3: Static single import
      'src/com/app/ConsumerJ3.java': `
        package com.app;
        import static com.base.Provider.CONSTANT;
        public class ConsumerJ3 {}
      `,
      // J-4: Static wildcard import
      'src/com/app/ConsumerJ4.java': `
        package com.app;
        import static com.base.Provider.*;
        public class ConsumerJ4 {}
      `,
      // J-6: Same package reference
      'src/com/base/ConsumerJ6.java': `
        package com.base;
        public class ConsumerJ6 {}
      `,
      // J-7: Extends class
      'src/com/app/ConsumerJ7.java': `
        package com.app;
        import com.base.Provider;
        public class ConsumerJ7 extends Provider {}
      `,
      // J-8: Implements interface
      'src/com/app/ConsumerJ8.java': `
        package com.app;
        import com.base.IProvider;
        public class ConsumerJ8 implements IProvider {
          public void doAction() {}
        }
      `,
      // J-9: Interface extends interface
      'src/com/app/ConsumerJ9.java': `
        package com.app;
        import com.base.IProvider;
        public interface ConsumerJ9 extends IProvider {}
      `
    }
  };

  // Mutate Provider (remove execute) and IProvider (change doAction)
  const candidate = {
    commitSha: 'c-bindings',
    files: {
      ...parent.files,
      'src/com/base/Provider.java': `
        package com.base;
        public class Provider {
          public static final String CONSTANT = "MUTATED";
        }
      `,
      'src/com/base/IProvider.java': `
        package com.base;
        public interface IProvider {
          void doAction(String param);
        }
      `
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  const bindingMap = new Map(result.consumers.map(c => [c.consumerFqcn, c.bindingKind]));
  assert.equal(bindingMap.get('com.app.ConsumerJ1'), 'J-1');
  assert.equal(bindingMap.get('com.app.ConsumerJ2'), 'J-2');
  assert.equal(bindingMap.get('com.app.ConsumerJ3'), 'J-3');
  assert.equal(bindingMap.get('com.app.ConsumerJ4'), 'J-4');
  assert.equal(bindingMap.get('com.base.ConsumerJ6'), 'J-6');

  // Inheritance bindings
  const j7Refs = result.consumers.filter(c => c.consumerFqcn === 'com.app.ConsumerJ7');
  assert.ok(j7Refs.some(r => r.bindingKind === 'J-7' && r.referenceKind === 'EXTENDS'));

  const j8Refs = result.consumers.filter(c => c.consumerFqcn === 'com.app.ConsumerJ8');
  assert.ok(j8Refs.some(r => r.bindingKind === 'J-8' && r.referenceKind === 'IMPLEMENTS'));

  const j9Refs = result.consumers.filter(c => c.consumerFqcn === 'com.app.ConsumerJ9');
  assert.ok(j9Refs.some(r => r.bindingKind === 'J-9' && r.referenceKind === 'EXTENDS'));

  console.log('✓ Test 3: Consumer Bindings Matrix (J-1..J-9) passed');
}

// ---------------------------------------------------------------------------
// Test 4: Provider Change Kinds Matrix (Methods, Fields, Classes)
// ---------------------------------------------------------------------------
{
  const checkMutation = (beforeSrc: string, afterSrc: string, expectedChange: string) => {
    const res = analyzer.analyze({
      parent: { commitSha: 'p', files: { 'src/com/acme/TestClass.java': beforeSrc } },
      candidate: { commitSha: 'c', files: { 'src/com/acme/TestClass.java': afterSrc } }
    });
    const matched = res.providers.find(p => p.change === expectedChange);
    assert.ok(matched, `Expected change '${expectedChange}' but got: ${res.providers.map(p => p.change).join(', ')}`);
    return matched;
  };

  // Method mutations
  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String f() { return ""; }\n}',
    'package com.acme;\npublic class TestClass {\n  public int f() { return 0; }\n}',
    'METHOD_RETURN_TYPE_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public void f(String a, int b) {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f(String a) {}\n}',
    'METHOD_PARAMETER_REMOVED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public void f(String a) {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f(String a, int b) {}\n}',
    'METHOD_PARAMETER_ADDED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public void f(String a) {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f(int a) {}\n}',
    'METHOD_PARAMETER_TYPE_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public void f() {}\n}',
    'package com.acme;\npublic class TestClass {\n  private void f() {}\n}',
    'METHOD_VISIBILITY_NARROWED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  private void f() {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f() {}\n}',
    'METHOD_VISIBILITY_WIDENED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public static void f() {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f() {}\n}',
    'METHOD_STATIC_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public void f() throws java.io.IOException {}\n}',
    'package com.acme;\npublic class TestClass {\n  public void f() throws java.sql.SQLException {}\n}',
    'METHOD_THROWS_CHANGED'
  );

  // Field mutations
  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String value;\n}',
    'package com.acme;\npublic class TestClass {\n  public int value;\n}',
    'FIELD_TYPE_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String value;\n}',
    'package com.acme;\npublic class TestClass {\n  private String value;\n}',
    'FIELD_VISIBILITY_NARROWED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String value;\n}',
    'package com.acme;\npublic class TestClass {\n  public static String value;\n}',
    'FIELD_STATIC_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String value;\n}',
    'package com.acme;\npublic class TestClass {\n  public final String value;\n}',
    'FIELD_FINAL_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {\n  public String value;\n}',
    'package com.acme;\npublic class TestClass {}\n',
    'FIELD_REMOVED'
  );

  // Class mutations
  checkMutation(
    'package com.acme;\npublic class TestClass {}\n',
    'package com.acme;\npublic interface TestClass {}\n',
    'CLASS_KIND_CHANGED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass {}\n',
    'package com.acme;\nclass TestClass {}\n',
    'CLASS_VISIBILITY_NARROWED'
  );

  checkMutation(
    'package com.acme;\nclass TestClass {}\n',
    'package com.acme;\npublic class TestClass {}\n',
    'CLASS_VISIBILITY_WIDENED'
  );

  checkMutation(
    'package com.acme;\npublic class TestClass extends java.lang.Object {}\n',
    'package com.acme;\npublic class TestClass extends java.lang.Number {}\n',
    'INHERITANCE_CHANGED'
  );

  console.log('✓ Test 4: Provider Change Kinds Matrix passed');
}

// ---------------------------------------------------------------------------
// Test 5: CASE_A vs CASE_B Identity Verification
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p-ident',
    files: {
      'src/com/acme/A.java': 'package com.acme;\npublic class A {\n  public void m1() {}\n  public void m2() {}\n}',
      'src/com/acme/B.java': 'package com.acme;\npublic class B {}\n'
    }
  };

  const candidate = {
    commitSha: 'c-ident',
    files: {
      // m1 signature changed (CASE_A); m2 removed (CASE_B); m3 added (CASE_B)
      'src/com/acme/A.java': 'package com.acme;\npublic class A {\n  public void m1(int x) {}\n  public void m3() {}\n}',
      // B removed (CASE_B); C added (CASE_B)
      'src/com/acme/C.java': 'package com.acme;\npublic class C {}\n'
    }
  };

  const result = analyzer.analyze({ parent, candidate });

  const m1 = result.providers.find(p => p.memberName === 'm1');
  assert.equal(m1?.identity, 'CASE_A', 'm1 exists in both parent and candidate');

  const m2 = result.providers.find(p => p.memberName === 'm2');
  assert.equal(m2?.identity, 'CASE_B', 'm2 removed exists only in parent');

  const m3 = result.providers.find(p => p.memberName === 'm3');
  assert.equal(m3?.identity, 'CASE_B', 'm3 added exists only in candidate');

  const classB = result.providers.find(p => p.id === 'com.acme.B');
  assert.equal(classB?.identity, 'CASE_B', 'class B removed');

  const classC = result.providers.find(p => p.id === 'com.acme.C');
  assert.equal(classC?.identity, 'CASE_B', 'class C added');

  console.log('✓ Test 5: CASE_A vs CASE_B Identity passed');
}

// ---------------------------------------------------------------------------
// Test 6: Target Scoping Pinning
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p-target',
    files: {
      'src/com/acme/FirstService.java': 'package com.acme;\npublic class FirstService {\n  public void run() {}\n}\n',
      'src/com/acme/SecondService.java': 'package com.acme;\npublic class SecondService {\n  public void run() {}\n}\n'
    }
  };

  const candidate = {
    commitSha: 'c-target',
    files: {
      'src/com/acme/FirstService.java': 'package com.acme;\npublic class FirstService {\n  public void run(int x) {}\n}\n',
      'src/com/acme/SecondService.java': 'package com.acme;\npublic class SecondService {\n  public void run(int x) {}\n}\n'
    }
  };

  // Pin only FirstService
  const targetedClass = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.FirstService' }
  });
  assert.ok(targetedClass.providers.every(p => p.fqcn === 'com.acme.FirstService'));

  // Pin specific member
  const targetedMember = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.FirstService', memberName: 'run' }
  });
  assert.ok(targetedMember.providers.some(p => p.memberName === 'run'));

  // Missing target declaration fails closed to INCONCLUSIVE
  const missingTarget = analyzer.analyze({
    parent,
    candidate,
    target: { fqcn: 'com.acme.NonExistentService' }
  });
  assert.equal(missingTarget.verdict, 'INCONCLUSIVE');
  assert.equal(missingTarget.completeness.status, 'INCOMPLETE');
  assert.ok(missingTarget.completeness.unresolvedFiles.some(f => f.includes('NonExistentService')));

  console.log('✓ Test 6: Target Scoping Pinning passed');
}

// ---------------------------------------------------------------------------
// Test 7: Resource Limits & Incompleteness Handling
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p-res',
    selection: {
      selectedFiles: 1,
      selectedBytes: 100,
      scannedFiles: 2,
      scannedBytes: 200,
      incompleteReasons: ['UNRESOLVED_DEPENDENCY_EXTERNAL_JAR']
    },
    files: {
      'src/com/acme/App.java': 'package com.acme; public class App {}'
    }
  };

  const candidate = {
    commitSha: 'c-res',
    files: {
      'src/com/acme/App.java': 'package com.acme; public class App { public void extra() {} }'
    }
  };

  // Upstream incomplete selection causes analysis to fail closed to INCONCLUSIVE
  const incompleteResult = analyzer.analyze({ parent, candidate });
  assert.equal(incompleteResult.verdict, 'INCONCLUSIVE');
  assert.equal(incompleteResult.completeness.status, 'INCOMPLETE');
  assert.ok(incompleteResult.completeness.unresolvedFiles.includes('UNRESOLVED_DEPENDENCY_EXTERNAL_JAR'));

  // Resource budget exceeded (maxExecutionMs: 0)
  const budgetResult = analyzer.analyze({
    parent: { commitSha: 'p', files: parent.files },
    candidate: { commitSha: 'c', files: candidate.files },
    resourceLimits: { maxExecutionMs: 0 }
  });
  assert.equal(budgetResult.verdict, 'INCONCLUSIVE');
  assert.equal(budgetResult.completeness.status, 'INCOMPLETE');
  assert.ok(budgetResult.completeness.unresolvedFiles.some(f => f.includes('BUDGET')));

  console.log('✓ Test 7: Resource Limits & Incompleteness Handling passed');
}

// ---------------------------------------------------------------------------
// Test 8: Phase 7 Reconciliation Precedence Policy (casebgoal.md §Phase 7)
// ---------------------------------------------------------------------------
{
  const mockAdvisory = (verdict: 'LIKELY_PRESERVED' | 'LIKELY_VIOLATED' | 'INCONCLUSIVE'): any => ({
    schemaVersion: ADVISORY_JAVA_SCHEMA_VERSION,
    certificationStatus: 'ADVISORY_ONLY',
    verdict,
    parentCommitSha: 'p',
    candidateCommitSha: 'c',
    providers: [],
    consumers: [],
    impacts: [],
    traces: [],
    completeness: { status: 'COMPLETE', consumersAnalyzed: 0, unresolvedDependencyCount: 0, unresolvedFiles: [] },
    confidenceRationale: [],
    evidenceReferences: []
  });

  // Rule 1: Certified VIOLATED -> final VIOLATED
  const r1 = reconcileJavaAdvisoryResult(
    { verdict: 'VIOLATED', reason: 'Certified counterexample' },
    mockAdvisory('LIKELY_VIOLATED')
  );
  assert.equal(r1.final.verdict, 'VIOLATED');
  assert.equal(r1.final.conflict, null);

  // Rule 2: Certified PRESERVED -> final PRESERVED
  const r2 = reconcileJavaAdvisoryResult(
    { verdict: 'PRESERVED', reason: 'Certified proof' },
    mockAdvisory('LIKELY_PRESERVED')
  );
  assert.equal(r2.final.verdict, 'PRESERVED');
  assert.equal(r2.final.conflict, null);

  // Rule 3: Certified NOT_APPLICABLE -> final NOT_APPLICABLE
  const r3 = reconcileJavaAdvisoryResult(
    { verdict: 'NOT_APPLICABLE', reason: 'Out of scope' },
    mockAdvisory('LIKELY_PRESERVED')
  );
  assert.equal(r3.final.verdict, 'NOT_APPLICABLE');
  assert.equal(r3.final.conflict, null);

  // Rule 4: Certified UNKNOWN + advisory -> certified UNKNOWN, plus advisory finding (never upgrades UNKNOWN!)
  const r4 = reconcileJavaAdvisoryResult(
    { verdict: 'UNKNOWN', reason: 'F0 unsupported construct' },
    mockAdvisory('LIKELY_VIOLATED')
  );
  assert.equal(r4.final.verdict, 'UNKNOWN');
  assert.equal(r4.final.advisoryFinding, 'LIKELY_VIOLATED');
  assert.equal(r4.final.conflict, null);

  // Rule 5a: Conflict (Certified PRESERVED vs Advisory LIKELY_VIOLATED) -> UNKNOWN + conflict
  const r5a = reconcileJavaAdvisoryResult(
    { verdict: 'PRESERVED', reason: 'Certified proof' },
    mockAdvisory('LIKELY_VIOLATED')
  );
  assert.equal(r5a.final.verdict, 'UNKNOWN');
  assert.ok(r5a.final.conflict);
  assert.equal(r5a.final.conflict.certifiedVerdict, 'PRESERVED');
  assert.equal(r5a.final.conflict.advisoryVerdict, 'LIKELY_VIOLATED');

  // Rule 5b: Conflict (Certified VIOLATED vs Advisory LIKELY_PRESERVED) -> UNKNOWN + conflict
  const r5b = reconcileJavaAdvisoryResult(
    { verdict: 'VIOLATED', reason: 'Certified proof' },
    mockAdvisory('LIKELY_PRESERVED')
  );
  assert.equal(r5b.final.verdict, 'UNKNOWN');
  assert.ok(r5b.final.conflict);
  assert.equal(r5b.final.conflict.certifiedVerdict, 'VIOLATED');
  assert.equal(r5b.final.conflict.advisoryVerdict, 'LIKELY_PRESERVED');

  console.log('✓ Test 8: Phase 7 Reconciliation Precedence Policy passed');
}

// ---------------------------------------------------------------------------
// Test 9: Phase 8 Two-Panel User Report & Markdown Rendering
// ---------------------------------------------------------------------------
{
  const parent = {
    commitSha: 'p-report',
    files: {
      'src/com/acme/Api.java': 'package com.acme;\npublic class Api {\n  public void call() {}\n}\n',
      'src/com/acme/Client.java': 'package com.acme;\nimport com.acme.Api;\npublic class Client {}\n'
    }
  };
  const candidate = {
    commitSha: 'c-report',
    files: {
      'src/com/acme/Api.java': 'package com.acme;\npublic class Api {}\n',
      'src/com/acme/Client.java': 'package com.acme;\nimport com.acme.Api;\npublic class Client {}\n'
    }
  };

  const advisoryRes = analyzer.analyze({ parent, candidate });
  const reconciled = reconcileJavaAdvisoryResult(
    { verdict: 'UNKNOWN', reason: 'Gate 4 unsupported Java bytecode' },
    advisoryRes
  );

  const report = createJavaAdvisoryReport(reconciled);
  assert.equal(report.schemaVersion, 'ADVISORY_JAVA_REPORT_V1');
  assert.equal(report.certifiedPanel.verdict, 'UNKNOWN');
  assert.equal(report.broaderImpactPanel.verdict, 'LIKELY_VIOLATED');
  assert.equal(report.broaderImpactPanel.consumersAffected, 1);
  assert.equal(report.broaderImpactPanel.consumersAnalyzed, 1);

  const markdown = renderJavaAdvisoryMarkdown(report);
  assert.ok(markdown.includes('## Certified result'));
  assert.ok(markdown.includes('Certified verdict: UNKNOWN'));
  assert.ok(markdown.includes('## Broader impact analysis (Java)'));
  assert.ok(markdown.includes('Advisory result: LIKELY_VIOLATED'));
  assert.ok(markdown.includes('Consumers affected: 1'));
  assert.ok(markdown.includes('### Evidence Traces'));

  // Rendering is deterministic
  assert.equal(renderJavaAdvisoryMarkdown(report), markdown);

  console.log('✓ Test 9: Phase 8 Two-Panel Report & Markdown Rendering passed');
}

// ---------------------------------------------------------------------------
// Test 10: Phase 9 Benchmark Validation Execution
// ---------------------------------------------------------------------------
{
  const benchmarkCases: JavaAdvisoryBenchmarkCase[] = [
    {
      name: 'method-removal-breaking',
      tags: ['breaking', 'method'],
      expectedVerdict: 'LIKELY_VIOLATED',
      expectedConsumerCount: 1,
      input: {
        parent: {
          commitSha: 'p1',
          files: {
            'src/com/acme/Service.java': 'package com.acme;\npublic class Service {\n  public void run() {}\n}\n',
            'src/com/acme/App.java': 'package com.acme;\nimport com.acme.Service;\npublic class App {}\n'
          }
        },
        candidate: {
          commitSha: 'c1',
          files: {
            'src/com/acme/Service.java': 'package com.acme;\npublic class Service {}\n',
            'src/com/acme/App.java': 'package com.acme;\nimport com.acme.Service;\npublic class App {}\n'
          }
        }
      }
    },
    {
      name: 'method-addition-compatible',
      tags: ['compatible', 'method'],
      expectedVerdict: 'LIKELY_PRESERVED',
      expectedConsumerCount: 1,
      input: {
        parent: {
          commitSha: 'p2',
          files: {
            'src/com/acme/Service.java': 'package com.acme;\npublic class Service {\n  public void run() {}\n}\n',
            'src/com/acme/App.java': 'package com.acme;\nimport com.acme.Service;\npublic class App {}\n'
          }
        },
        candidate: {
          commitSha: 'c2',
          files: {
            'src/com/acme/Service.java': 'package com.acme;\npublic class Service {\n  public void run() {}\n  public void extra() {}\n}\n',
            'src/com/acme/App.java': 'package com.acme;\nimport com.acme.Service;\npublic class App {}\n'
          }
        }
      }
    }
  ];

  const benchReport = runJavaAdvisoryBenchmark(benchmarkCases, analyzer);
  assert.equal(benchReport.schemaVersion, 'ADVISORY_JAVA_BENCHMARK_V1');
  assert.equal(benchReport.cases.length, 2);
  assert.equal(benchReport.metrics.deterministicRepeatability, 1);
  assert.equal(benchReport.metrics.truePositiveRate, 1);
  assert.equal(benchReport.metrics.falsePositiveRate, 0);
  assert.equal(benchReport.metrics.falseNegativeRate, 0);
  assert.equal(benchReport.metrics.unresolvedRate, 0);
  assert.ok(benchReport.metrics.runtimeMs >= 0);

  console.log('✓ Test 10: Phase 9 Benchmark Validation Execution passed');
}

// ---------------------------------------------------------------------------
// Test 11: Fail-Closed Semantics on Exceptional Input -> ANALYSIS_ERROR
// ---------------------------------------------------------------------------
{
  // Pass an input that causes an exception internally
  const malformedInput: any = {
    parent: null,
    candidate: null
  };

  const errResult = analyzer.analyze(malformedInput);
  assert.equal(errResult.schemaVersion, ADVISORY_JAVA_SCHEMA_VERSION);
  assert.equal(errResult.certificationStatus, 'ADVISORY_ONLY');
  assert.equal(errResult.verdict, 'ANALYSIS_ERROR');
  assert.equal(errResult.completeness.status, 'INCOMPLETE');
  assert.ok(errResult.confidenceRationale.length > 0);

  console.log('✓ Test 11: Fail-Closed Semantics on Exceptional Input passed');
}

// ---------------------------------------------------------------------------
// Test 12: Real Git Commit End-to-End Testing (JavaRepositoryRevisionAnalyzer)
// ---------------------------------------------------------------------------
{
  const gitRoot = mkdtempSync(join(tmpdir(), 'sajimora-java-git-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'JavaTestRunner');

    mkdirSync(join(gitRoot, 'src', 'com', 'acme'), { recursive: true });

    // Parent commit: OrderService with findOrder and cancelOrder, consumed by OrderController
    writeFileSync(
      join(gitRoot, 'src', 'com', 'acme', 'OrderService.java'),
      'package com.acme;\npublic class OrderService {\n  public String findOrder(String id) { return id; }\n  public void cancelOrder(String id) {}\n}\n'
    );
    writeFileSync(
      join(gitRoot, 'src', 'com', 'acme', 'OrderController.java'),
      'package com.acme;\nimport com.acme.OrderService;\npublic class OrderController {\n  private OrderService service;\n}\n'
    );
    writeFileSync(
      join(gitRoot, 'pom.xml'),
      '<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>app</artifactId><version>1.0.0</version></project>'
    );

    git('add', '.');
    git('commit', '-m', 'feat(core): parent revision with cancelOrder');
    const parentSha = git('rev-parse', 'HEAD');

    // Candidate commit: cancelOrder removed (breaking change)
    writeFileSync(
      join(gitRoot, 'src', 'com', 'acme', 'OrderService.java'),
      'package com.acme;\npublic class OrderService {\n  public String findOrder(String id) { return id; }\n}\n'
    );

    git('add', '.');
    git('commit', '-m', 'refactor(core): remove cancelOrder');
    const candidateSha = git('rev-parse', 'HEAD');

    // Execute real Git repository revision analyzer
    const repoAnalyzer = new JavaRepositoryRevisionAnalyzer();
    const gitResult = repoAnalyzer.analyze({
      repositoryPath: gitRoot,
      parentSha,
      candidateSha
    });

    assert.equal(gitResult.schemaVersion, ADVISORY_JAVA_SCHEMA_VERSION);
    assert.equal(gitResult.certificationStatus, 'ADVISORY_ONLY');
    assert.equal(gitResult.verdict, 'LIKELY_VIOLATED');
    assert.equal(gitResult.parentCommitSha, parentSha);
    assert.equal(gitResult.candidateCommitSha, candidateSha);
    assert.equal(gitResult.completeness.status, 'COMPLETE');

    // Verify provider diff from real Git blobs
    const removedProvider = gitResult.providers.find(p => p.memberName === 'cancelOrder');
    assert.ok(removedProvider, 'cancelOrder removal must be discovered from real Git commit blobs');
    assert.equal(removedProvider.change, 'METHOD_REMOVED');
    assert.equal(removedProvider.identity, 'CASE_B');

    // Verify consumer discovered from real Git commit tree
    const controller = gitResult.consumers.find(c => c.consumerFqcn === 'com.acme.OrderController');
    assert.ok(controller, 'OrderController consumer must be discovered');
    assert.equal(controller.bindingKind, 'J-1');

    // Verify reconciliation and report generation on real Git result
    const reconciled = reconcileJavaAdvisoryResult(
      { verdict: 'UNKNOWN', reason: 'Gate 4 Java language adapter advisory track' },
      gitResult
    );
    assert.equal(reconciled.final.verdict, 'UNKNOWN');
    assert.equal(reconciled.final.advisoryFinding, 'LIKELY_VIOLATED');

    const report = createJavaAdvisoryReport(reconciled);
    assert.equal(report.broaderImpactPanel.verdict, 'LIKELY_VIOLATED');
    assert.equal(report.evidence.parentCommitSha, parentSha);
    assert.equal(report.evidence.candidateCommitSha, candidateSha);

    const markdown = renderJavaAdvisoryMarkdown(report);
    assert.ok(markdown.includes('## Broader impact analysis (Java)'));
    assert.ok(markdown.includes('Advisory result: LIKELY_VIOLATED'));

    console.log('✓ Test 12: Real Git Commit End-to-End Testing passed');
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 13: Build model extraction failure must be surfaced as unresolved blocker
// ---------------------------------------------------------------------------
{
  const analyzer = new AdvisoryJavaImpactAnalyzer();
  // Part A: Incomplete build model due to missing declared submodule
  const parentIncomplete = {
    commitSha: 'p13a',
    files: {
      'src/main/java/com/acme/A.java': 'package com.acme; public class A {}',
      'pom.xml': '<project><modules><module>missing-sub</module></modules></project>'
    }
  };
  const candidateIncomplete = {
    commitSha: 'c13a',
    files: {
      'src/main/java/com/acme/A.java': 'package com.acme; public class A { public int x; }',
      'pom.xml': '<project><modules><module>missing-sub</module></modules></project>'
    }
  };
  const resIncomplete = analyzer.analyze({ parent: parentIncomplete, candidate: candidateIncomplete });
  assert.ok(resIncomplete.completeness.unresolvedDependencyCount > 0, 'Must record unresolved dependency on incomplete build model');
  assert.ok(!resIncomplete.confidenceRationale.some(r => r.includes('no unresolved symbols')), 'Must not claim no unresolved symbols');

  // Part B: Throwing build model extraction
  const origExtract = JavaBuildModelExtractor.extractBuildModel;
  (JavaBuildModelExtractor as any).extractBuildModel = () => {
    throw new Error('Simulated build model extraction crash');
  };
  try {
    const resThrowing = analyzer.analyze({ parent: parentIncomplete, candidate: candidateIncomplete });
    assert.ok(resThrowing.completeness.unresolvedDependencyCount > 0, 'Must record unresolved dependency on throwing build model extraction');
    assert.ok(resThrowing.completeness.unresolvedFiles.some(f => f.includes('BUILD_MODEL_EXTRACTION_FAILURE')), 'Must record BUILD_MODEL_EXTRACTION_FAILURE');
    assert.ok(!resThrowing.confidenceRationale.some(r => r.includes('no unresolved symbols')), 'Must not claim no unresolved symbols on throw');
  } finally {
    (JavaBuildModelExtractor as any).extractBuildModel = origExtract;
  }
  console.log('✓ Test 13: Build model extraction failure correctly surfaced as blocker passed');
}

console.log('--- ALL 13 ADVISORY JAVA IMPACT ANALYZER TESTS PASSED ---');
