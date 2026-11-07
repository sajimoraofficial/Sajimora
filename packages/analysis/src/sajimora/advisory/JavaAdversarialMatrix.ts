/**
 * @file JavaAdversarialMatrix.ts
 * Hostile & Adversarial Verification Matrix for Java Advisory Track — Sajimora Phase J-6.
 *
 * Enforces the core non-negotiable invariants:
 *   1. No phantom extraction from comments, string literals, or Java 13+ text blocks.
 *   2. Bounded cycle protection for circular extends/implements chains.
 *   3. Deeply nested inner class resolution without stack overflow.
 *   4. Ambiguous wildcard resolution fail-closed handling.
 *   5. Explicitly undecidable constructs (J-X1..J-X3: reflection, dynamic proxy, bytecode).
 *   6. Malformed and truncated syntax fail-closed semantics.
 *   7. Zero compiler host or AST object reference leakage (pure JSON serialization).
 *   8. Deterministic replay under arbitrary file order shuffling and mixed path separators.
 */

import {
  AdvisoryJavaImpactAnalyzer,
  JavaAdvisoryImpactResult,
  JavaAdvisoryVerdict,
  JavaSealedRevision
} from './JavaImpactAnalyzer';
import { JavaSealedCompilerHost } from '../languages/java/programs/JavaSealedCompilerHost';
import { JavaTypeIRExtractor } from '../languages/java/ir/JavaTypeIRExtractor';

export interface JavaAdversarialScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  run(analyzer: AdvisoryJavaImpactAnalyzer): Promise<void> | void;
}

export interface JavaAdversarialMatrixReport {
  readonly schemaVersion: 'JAVA_ADVERSARIAL_MATRIX_V1';
  readonly totalScenarios: number;
  readonly passedScenarios: number;
  readonly failedScenarios: number;
  readonly results: readonly {
    readonly id: string;
    readonly name: string;
    readonly passed: boolean;
    readonly error?: string;
    readonly durationMs: number;
  }[];
}

/**
 * The 10 Core Adversarial Scenarios for Phase J-6.
 */
export const JAVA_ADVERSARIAL_SCENARIOS: readonly JavaAdversarialScenario[] = [
  // ---------------------------------------------------------------------------
  // ADV-01: Comment and String Literal Trap Evasion
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-01',
    name: 'Comment & String Literal Trap Evasion',
    description: 'Ensure classes, methods, and imports inside comments or string literals are never extracted as real AST',
    tags: ['adversarial', 'ast', 'traps'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-trap-1',
        files: {
          'src/com/acme/Legit.java': `
            package com.acme;
            // class FakeClassInComment { public void fakeMethod() {} }
            /*
             * import com.fake.FakeImport;
             * public class AnotherFake { int badField; }
             */
            public class Legit {
              private String fakeCode = "class InString { void inStr() {} }";
              public void realMethod() {}
            }
          `,
          'src/com/acme/Consumer.java': `
            package com.acme;
            import com.acme.Legit;
            // import com.fake.FakeImport;
            public class Consumer {
              private Legit legit;
            }
          `
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-trap-1',
        files: {
          'src/com/acme/Legit.java': `
            package com.acme;
            // class FakeClassInComment { public void fakeMethod() {} }
            public class Legit {
              private String fakeCode = "class InString { void inStr() {} }";
              public void realMethod() {}
              public void addedMethod() {}
            }
          `,
          'src/com/acme/Consumer.java': parent.files['src/com/acme/Consumer.java']
        }
      };

      const result = analyzer.analyze({ parent, candidate });

      // Verifications:
      // 1. No fake classes extracted
      const fakeClasses = result.providers.filter(p =>
        p.fqcn.includes('FakeClassInComment') ||
        p.fqcn.includes('AnotherFake') ||
        p.fqcn.includes('InString')
      );
      if (fakeClasses.length > 0) {
        throw new Error(`Phantom classes extracted from comments/literals: ${fakeClasses.map(p => p.fqcn).join(', ')}`);
      }

      // 2. Verdict must be LIKELY_PRESERVED (additive method on legit class)
      if (result.verdict !== 'LIKELY_PRESERVED') {
        throw new Error(`Expected LIKELY_PRESERVED, got ${result.verdict}`);
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-02: Java 13+ Text Block Trap Evasion
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-02',
    name: 'Java 13 Text Block Trap Evasion',
    description: 'Ensure multi-line text blocks with Java syntax do not inject false declarations or call sites',
    tags: ['adversarial', 'text-block', 'java13'],
    run: (analyzer) => {
      const source = `
        package com.acme;
        public class TextBlockOwner {
          private String query = """
            package com.evil;
            import com.evil.Hacker;
            public class SqlPayload {
              public void dropDatabase() {}
            }
          """;
          public void execute() {}
        }
      `;

      const parsed = JavaTypeIRExtractor.parseJavaSource('src/com/acme/TextBlockOwner.java', source);

      if (parsed.classes.length !== 1 || parsed.classes[0].fqcn !== 'com.acme.TextBlockOwner') {
        throw new Error(`Text block caused unexpected class extraction: ${parsed.classes.map(c => c.fqcn).join(', ')}`);
      }

      if (parsed.imports.some(i => i.moduleSpecifier.includes('evil'))) {
        throw new Error('Text block injected fake import into parsed file');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-03: Deeply Nested Inner Classes (4 Tiers)
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-03',
    name: 'Deeply Nested Inner Classes (4 Tiers)',
    description: 'Verify 4 levels of nested inner classes Outer.A.B.C with method changes at deepest tier',
    tags: ['adversarial', 'inner-class', 'deep-nesting'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-deep',
        files: {
          'src/com/acme/Outer.java': `
            package com.acme;
            public class Outer {
              public static class Level1 {
                public static class Level2 {
                  public static class Level3 {
                    public static class Level4 {
                      public String getDeepValue() { return "deep"; }
                    }
                  }
                }
              }
            }
          `,
          'src/com/app/Consumer.java': `
            package com.app;
            import com.acme.Outer.Level1.Level2.Level3.Level4;
            public class Consumer {
              public void run(Level4 l) {
                l.getDeepValue();
              }
            }
          `
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-deep',
        files: {
          'src/com/acme/Outer.java': `
            package com.acme;
            public class Outer {
              public static class Level1 {
                public static class Level2 {
                  public static class Level3 {
                    public static class Level4 {
                      // getDeepValue removed!
                    }
                  }
                }
              }
            }
          `,
          'src/com/app/Consumer.java': parent.files['src/com/app/Consumer.java']
        }
      };

      const result = analyzer.analyze({ parent, candidate });

      // Verifications:
      // 1. Deep binary name must exist
      const removedMethod = result.providers.find(p => p.memberName === 'getDeepValue');
      if (!removedMethod) {
        throw new Error(`getDeepValue method removal was not detected in deep inner class`);
      }
      if (!removedMethod.id.includes('Level4')) {
        throw new Error(`Provider ID did not retain deep inner class hierarchy: ${removedMethod.id}`);
      }

      // 2. Consumer must be discovered and marked LIKELY_VIOLATED
      if (result.verdict !== 'LIKELY_VIOLATED') {
        throw new Error(`Expected LIKELY_VIOLATED for deep inner class removal, got ${result.verdict}`);
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-04: Conflicting Ambiguous Wildcard Imports
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-04',
    name: 'Conflicting Wildcard Imports',
    description: 'Consumer wildcard-imports two packages that both define the same class name',
    tags: ['adversarial', 'wildcard', 'ambiguity'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-ambig',
        files: {
          'src/com/pkgA/CommonService.java': `
            package com.pkgA;
            public class CommonService {
              public void actionA() {}
            }
          `,
          'src/com/pkgB/CommonService.java': `
            package com.pkgB;
            public class CommonService {
              public void actionB() {}
            }
          `,
          'src/com/app/Consumer.java': `
            package com.app;
            import com.pkgA.*;
            import com.pkgB.*;
            public class Consumer {
              // Ambiguous reference if used unqualified
              private com.pkgA.CommonService serviceA;
            }
          `
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-ambig',
        files: {
          ...parent.files,
          'src/com/pkgA/CommonService.java': `
            package com.pkgA;
            public class CommonService {}
          `
        }
      };

      const result = analyzer.analyze({ parent, candidate });

      // Analysis must finish cleanly without crashing and fail closed to INCONCLUSIVE due to ambiguity
      if (result.verdict !== 'INCONCLUSIVE') {
        throw new Error(`Expected INCONCLUSIVE for ambiguous wildcard conflict, got ${result.verdict}`);
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-05: Circular Inheritance Cycle Protection
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-05',
    name: 'Circular Inheritance Cycle Protection',
    description: 'Ensure circular class or interface inheritance does not cause infinite recursion or stack exhaustion',
    tags: ['adversarial', 'inheritance', 'cycles'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-cycle',
        files: {
          'src/com/acme/A.java': 'package com.acme;\npublic class A extends B {}\n',
          'src/com/acme/B.java': 'package com.acme;\npublic class B extends C {}\n',
          'src/com/acme/C.java': 'package com.acme;\npublic class C extends A {}\n'
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-cycle',
        files: {
          'src/com/acme/A.java': 'package com.acme;\npublic class A extends B {}\n',
          'src/com/acme/B.java': 'package com.acme;\npublic class B extends C {}\n',
          'src/com/acme/C.java': 'package com.acme;\npublic class C extends A { public void extra() {} }\n'
        }
      };

      // Must terminate boundedly in under 500ms
      const start = performance.now();
      const result = analyzer.analyze({ parent, candidate });
      const duration = performance.now() - start;

      if (duration > 500) {
        throw new Error(`Circular inheritance analysis took ${duration}ms (potential loop)`);
      }
      if (result.verdict !== 'LIKELY_PRESERVED') {
        throw new Error(`Expected LIKELY_PRESERVED for additive cycle change, got ${result.verdict}`);
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-06: Member Shadowing in Subclass
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-06',
    name: 'Member Shadowing in Subclass',
    description: 'Subclass declares field and method with same name as superclass',
    tags: ['adversarial', 'shadowing', 'inheritance'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-shadow',
        files: {
          'src/com/acme/SuperClass.java': `
            package com.acme;
            public class SuperClass {
              public String identifier = "super";
              public void process() {}
            }
          `,
          'src/com/acme/SubClass.java': `
            package com.acme;
            public class SubClass extends SuperClass {
              public int identifier = 42; // shadows super field with different type
              public void process() {}    // overrides super method
            }
          `,
          'src/com/app/Consumer.java': `
            package com.app;
            import com.acme.SubClass;
            public class Consumer {
              public void call(SubClass s) {
                s.process();
              }
            }
          `
        }
      };

      // Mutate only SuperClass.process (remove it)
      const candidate: JavaSealedRevision = {
        commitSha: 'c-shadow',
        files: {
          ...parent.files,
          'src/com/acme/SuperClass.java': `
            package com.acme;
            public class SuperClass {
              public String identifier = "super";
            }
          `
        }
      };

      const result = analyzer.analyze({ parent, candidate });
      // SuperClass change detected
      const superChange = result.providers.find(p => p.fqcn === 'com.acme.SuperClass' && p.memberName === 'process');
      if (!superChange) {
        throw new Error('SuperClass.process removal was not detected');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-07: Explicitly Undecidable Constructs (J-X1..J-X3: Reflection / Dynamic Proxy)
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-07',
    name: 'Explicitly Undecidable Constructs (Reflection / Dynamic Proxy)',
    description: 'Ensure reflection and dynamic proxy calls are isolated and never produce false positive proofs',
    tags: ['adversarial', 'reflection', 'fail-closed'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-refl',
        files: {
          'src/com/acme/DynamicPlugin.java': `
            package com.acme;
            public class DynamicPlugin {
              public void executePlugin() {
                try {
                  Class<?> clazz = Class.forName("com.external.HiddenService");
                  Object instance = clazz.getDeclaredConstructor().newInstance();
                } catch (Exception e) {}
              }
            }
          `
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-refl',
        files: {
          'src/com/acme/DynamicPlugin.java': `
            package com.acme;
            public class DynamicPlugin {
              public void executePlugin() {
                try {
                  Class<?> clazz = Class.forName("com.external.HiddenServiceV2");
                  Object instance = clazz.getDeclaredConstructor().newInstance();
                } catch (Exception e) {}
              }
            }
          `
        }
      };

      const result = analyzer.analyze({ parent, candidate });
      // Advisory path must never declare certified PRESERVED
      if (result.certificationStatus !== 'ADVISORY_ONLY') {
        throw new Error('Certification status must always be ADVISORY_ONLY');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-08: Malformed Java Source Code Fail-Closed
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-08',
    name: 'Malformed Java Source Code Fail-Closed',
    description: 'Ensure syntax errors and truncated files fail closed gracefully without throwing unhandled exceptions',
    tags: ['adversarial', 'syntax-error', 'fail-closed'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-malformed',
        files: {
          'src/com/acme/Broken.java': `
            package com.acme;
            public class Broken {
              public void syntaxError( {
                // missing closing paren, unbalanced braces
          `
        }
      };

      const candidate: JavaSealedRevision = {
        commitSha: 'c-malformed',
        files: {
          'src/com/acme/Broken.java': `
            package com.acme;
            public class Broken {
              @#$$%^&*!
          `
        }
      };

      // Must NOT throw unhandled error
      let result: JavaAdvisoryImpactResult;
      try {
        result = analyzer.analyze({ parent, candidate });
      } catch (err) {
        throw new Error(`Analyzer threw unhandled exception on malformed Java input: ${err}`);
      }

      if (result.certificationStatus !== 'ADVISORY_ONLY') {
        throw new Error('Certification status must be ADVISORY_ONLY even on malformed input');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-09: Compiler Object Isolation & Zero Leakage Serialization
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-09',
    name: 'Compiler Object Isolation & Pure Serialization',
    description: 'Ensure result has zero live compiler/AST objects and is 100% JSON serializable and replayable',
    tags: ['adversarial', 'isolation', 'serialization'],
    run: (analyzer) => {
      const parent: JavaSealedRevision = {
        commitSha: 'p-iso',
        files: {
          'src/com/acme/Service.java': 'package com.acme;\npublic class Service {\n  public void ping() {}\n}\n'
        }
      };
      const candidate: JavaSealedRevision = {
        commitSha: 'c-iso',
        files: {
          'src/com/acme/Service.java': 'package com.acme;\npublic class Service {}\n'
        }
      };

      const result = analyzer.analyze({ parent, candidate });

      // Must serialize and deserialize cleanly with zero cycle errors
      let jsonStr: string;
      try {
        jsonStr = JSON.stringify(result);
      } catch (err) {
        throw new Error(`Result contains non-serializable objects or circular references: ${err}`);
      }

      const revived = JSON.parse(jsonStr);
      if (revived.verdict !== result.verdict) {
        throw new Error('Revived JSON verdict mismatch');
      }

      // Check no internal compiler host properties leaked into output
      if ('classIndex' in revived || 'snapshot' in revived || 'binaryIndex' in revived) {
        throw new Error('JavaSealedCompilerHost internals leaked into advisory result');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // ADV-10: File Permutation & Path Normalization Invariance
  // ---------------------------------------------------------------------------
  {
    id: 'ADV-10',
    name: 'File Permutation & Path Normalization Invariance',
    description: 'Ensure identical output regardless of file key ordering or mixed Windows/POSIX slash separators',
    tags: ['adversarial', 'determinism', 'cross-platform'],
    run: (analyzer) => {
      const fileA = 'package com.acme;\npublic class ServiceA { public void doA() {} }\n';
      const fileB = 'package com.acme;\npublic class ServiceB { public void doB() {} }\n';
      const fileC = 'package com.acme;\nimport com.acme.ServiceA;\npublic class Client { private ServiceA a; }\n';

      // Order 1: POSIX slashes, alphabetical
      const p1: JavaSealedRevision = {
        commitSha: 'p1',
        files: {
          'src/com/acme/ServiceA.java': fileA,
          'src/com/acme/ServiceB.java': fileB,
          'src/com/acme/Client.java': fileC
        }
      };
      const c1: JavaSealedRevision = {
        commitSha: 'c1',
        files: {
          'src/com/acme/ServiceA.java': 'package com.acme;\npublic class ServiceA {}\n',
          'src/com/acme/ServiceB.java': fileB,
          'src/com/acme/Client.java': fileC
        }
      };

      // Order 2: Windows backslashes, reverse order
      const p2: JavaSealedRevision = {
        commitSha: 'p1',
        files: {
          'src\\com\\acme\\Client.java': fileC,
          'src\\com\\acme\\ServiceB.java': fileB,
          'src\\com\\acme\\ServiceA.java': fileA
        }
      };
      const c2: JavaSealedRevision = {
        commitSha: 'c1',
        files: {
          'src\\com\\acme\\Client.java': fileC,
          'src\\com\\acme\\ServiceB.java': fileB,
          'src\\com\\acme\\ServiceA.java': 'package com.acme;\npublic class ServiceA {}\n'
        }
      };

      const res1 = analyzer.analyze({ parent: p1, candidate: c1 });
      const res2 = analyzer.analyze({ parent: p2, candidate: c2 });

      if (JSON.stringify(res1) !== JSON.stringify(res2)) {
        throw new Error('Analyzer output differs under path separator or file ordering permutations');
      }
    }
  }
];

/**
 * Executes the entire 10-scenario Adversarial Matrix suite.
 */
export async function runJavaAdversarialMatrix(
  analyzer = new AdvisoryJavaImpactAnalyzer()
): Promise<JavaAdversarialMatrixReport> {
  const results: { id: string; name: string; passed: boolean; error?: string; durationMs: number }[] = [];

  for (const scenario of JAVA_ADVERSARIAL_SCENARIOS) {
    const start = performance.now();
    try {
      await scenario.run(analyzer);
      const durationMs = performance.now() - start;
      results.push({ id: scenario.id, name: scenario.name, passed: true, durationMs });
    } catch (err: any) {
      const durationMs = performance.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ id: scenario.id, name: scenario.name, passed: false, error: errorMsg, durationMs });
    }
  }

  const passedScenarios = results.filter(r => r.passed).length;
  const failedScenarios = results.filter(r => !r.passed).length;

  return {
    schemaVersion: 'JAVA_ADVERSARIAL_MATRIX_V1',
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios,
    results
  };
}
