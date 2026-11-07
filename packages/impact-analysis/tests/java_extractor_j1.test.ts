/**
 * J-1 test suite for the enhanced JavaRoleExtractor.
 *
 * Coverage:
 *   - Field extraction: visibility, modifiers, type, name, annotations
 *   - Method parameter extraction: simple types, generics, varargs, annotations
 *   - Return type extraction (including void, generics, arrays)
 *   - @Override detection (isDeclaredOverride)
 *   - Constructor detection
 *   - Adversarial cases:
 *       - Symbol names inside string literals must NOT produce false fields/methods
 *       - Symbol names inside comments must NOT produce false fields/methods
 *       - Java text blocks (""") must not pollute extraction
 *       - Field with initialiser containing type-like tokens
 *       - Multi-line parameter lists
 *       - Inner class members
 *       - Enum with methods
 *       - Interface default/static methods
 *       - Abstract methods (no body)
 *       - Generic type parameters on methods
 *   - Determinism: two calls with same input produce byte-identical output
 *   - Backward-compatible: existing fields on JavaParseDetails still present
 */

import * as assert from 'node:assert/strict';
import {
  JavaRoleExtractor,
  type JavaFieldDecl,
  type JavaMethodDecl,
  type JavaParameterDecl
} from '../src/extractors/javaRoleExtractor';

const extractor = new JavaRoleExtractor();

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err: any) {
    console.error(`FAIL  ${name}`);
    console.error('      ' + err.message);
    process.exitCode = 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function field(details: ReturnType<typeof extractor.parseStructure>, name: string): JavaFieldDecl | undefined {
  return details.fields.find(f => f.name === name);
}

function method(details: ReturnType<typeof extractor.parseStructure>, name: string): JavaMethodDecl | undefined {
  return details.methods.find(m => m.name === name);
}

function param(m: JavaMethodDecl, idx: number): JavaParameterDecl | undefined {
  return m.parameters[idx];
}

// ─── Fixture sources ──────────────────────────────────────────────────────────

const SIMPLE_CLASS = `
package com.acme;

import java.util.List;

public class UserService {
    private String userId;
    protected int retryCount;
    public static final String DEFAULT_ROLE = "admin";
    private volatile boolean running;
    private transient List<String> cache;

    public UserService(String userId) {
        this.userId = userId;
    }

    public String getUserId() {
        return userId;
    }

    protected List<String> findAll(String prefix, int limit) {
        return cache;
    }

    void packagePrivateHelper() {}

    private static int computeHash(String input) {
        return input.hashCode();
    }
}
`;

const OVERRIDE_CLASS = `
package com.acme;

public class ConcreteImpl extends AbstractBase implements Runnable {
    private String state;

    @Override
    public void run() {
        // running
    }

    @Override
    public String toString() {
        return state;
    }

    public void notOverridden() {}
}
`;

const GENERIC_METHODS = `
package com.acme;

import java.util.Map;
import java.util.Optional;

public class Repository<T> {
    private Map<String, T> store;

    public <K, V extends T> Optional<V> findById(K key, Class<V> type) {
        return Optional.empty();
    }

    public Map<String, List<T>> groupBy(List<T> items, String... keys) {
        return null;
    }
}
`;

const ABSTRACT_INTERFACE = `
package com.acme.api;

public interface PaymentGateway {
    void process(String txId, double amount);
    boolean verify(String txId);
    default String describe() { return "gateway"; }
    static PaymentGateway noOp() { return (txId, amount) -> {}; }
}
`;

const ENUM_WITH_METHODS = `
package com.acme;

public enum Status {
    ACTIVE, INACTIVE, PENDING;

    public boolean isTerminal() {
        return this == INACTIVE;
    }

    @Override
    public String toString() {
        return name().toLowerCase();
    }
}
`;

// Adversarial: symbol names appear inside string literals and comments
const ADVERSARIAL_LITERALS = `
package com.acme;

public class Tricky {
    // private String fakeField = "not a real field";
    /* private int anotherFake; */
    private String realField;

    public void method() {
        String s = "private int x = 5; return x;";
        String tb = """
            private int y = 10;
            """;
        char c = ';';
    }
}
`;

// Adversarial: field with complex initialisers
const ADVERSARIAL_INITIALISER = `
package com.acme;

import java.util.Arrays;
import java.util.List;

public class Config {
    private static final List<String> ALLOWED = Arrays.asList("a", "b", "c");
    private final int[] SIZES = {1, 2, 3};
    private Map<String, Integer> counts = new HashMap<>();
}
`;

// Multi-line parameter list
const MULTILINE_PARAMS = `
package com.acme;

public class Builder {
    public void configure(
        String name,
        int timeout,
        List<String> options
    ) {}
}
`;

// Inner class
const INNER_CLASS = `
package com.acme;

public class Outer {
    private int outerField;

    public static class Inner {
        private String innerField;

        public String getInnerField() {
            return innerField;
        }
    }

    public int getOuterField() {
        return outerField;
    }
}
`;

// Annotation type
const ANNOTATION_TYPE = `
package com.acme;

public @interface MyAnnotation {
    String value() default "";
    int order() default 0;
}
`;

// ─── Test: simple field extraction ───────────────────────────────────────────

test('simple field: private String userId extracted', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const f = field(d, 'userId');
  assert.ok(f, 'userId field must be extracted');
  assert.equal(f!.type, 'String');
  assert.equal(f!.visibility, 'private');
  assert.equal(f!.isStatic, false);
  assert.equal(f!.isFinal, false);
});

test('simple field: protected int retryCount extracted', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const f = field(d, 'retryCount');
  assert.ok(f, 'retryCount field must be extracted');
  assert.equal(f!.type, 'int');
  assert.equal(f!.visibility, 'protected');
});

test('static final field: DEFAULT_ROLE extracted with correct modifiers', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const f = field(d, 'DEFAULT_ROLE');
  assert.ok(f, 'DEFAULT_ROLE must be extracted');
  assert.equal(f!.type, 'String');
  assert.equal(f!.visibility, 'public');
  assert.equal(f!.isStatic, true);
  assert.equal(f!.isFinal, true);
});

test('volatile field: running extracted with isVolatile=true', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const f = field(d, 'running');
  assert.ok(f, 'running field must be extracted');
  assert.equal(f!.isVolatile, true);
  assert.equal(f!.type, 'boolean');
});

test('transient field: cache extracted with isTransient=true', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const f = field(d, 'cache');
  assert.ok(f, 'cache field must be extracted');
  assert.equal(f!.isTransient, true);
  assert.equal(f!.type, 'List<String>');
});

// ─── Test: method return type and parameters ──────────────────────────────────

test('method getUserId: return type is String', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const m = method(d, 'getUserId');
  assert.ok(m, 'getUserId must be extracted');
  assert.equal(m!.returnType, 'String');
  assert.equal(m!.visibility, 'public');
  assert.equal(m!.parameters.length, 0);
});

test('method findAll: two parameters with correct types and names', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const m = method(d, 'findAll');
  assert.ok(m, 'findAll must be extracted');
  assert.equal(m!.returnType, 'List<String>');
  assert.equal(m!.parameters.length, 2);
  assert.equal(param(m!, 0)!.type, 'String');
  assert.equal(param(m!, 0)!.name, 'prefix');
  assert.equal(param(m!, 1)!.type, 'int');
  assert.equal(param(m!, 1)!.name, 'limit');
});

test('method packagePrivateHelper: package-private visibility', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const m = method(d, 'packagePrivateHelper');
  assert.ok(m, 'packagePrivateHelper must be extracted');
  assert.equal(m!.visibility, 'package-private');
});

test('static method computeHash: single String parameter', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const m = method(d, 'computeHash');
  assert.ok(m, 'computeHash must be extracted');
  assert.equal(m!.returnType, 'int');
  assert.equal(m!.parameters.length, 1);
  assert.equal(param(m!, 0)!.type, 'String');
  assert.equal(param(m!, 0)!.name, 'input');
});

// ─── Test: constructor detection ─────────────────────────────────────────────

test('constructor UserService detected as constructor', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const ctors = d.methods.filter(m => m.isConstructor);
  assert.ok(ctors.length >= 1, 'At least one constructor must be extracted');
  const ctor = ctors.find(c => c.name === 'UserService');
  assert.ok(ctor, 'Constructor named UserService must be present');
  assert.equal(ctor!.returnType, '');
  assert.equal(ctor!.parameters.length, 1);
  assert.equal(param(ctor!, 0)!.type, 'String');
  assert.equal(param(ctor!, 0)!.name, 'userId');
});

// ─── Test: @Override detection ────────────────────────────────────────────────

test('@Override: run() has isDeclaredOverride=true', () => {
  const d = extractor.parseStructure('ConcreteImpl.java', OVERRIDE_CLASS);
  const m = method(d, 'run');
  assert.ok(m, 'run() must be extracted');
  assert.equal(m!.isDeclaredOverride, true);
});

test('@Override: toString() has isDeclaredOverride=true', () => {
  const d = extractor.parseStructure('ConcreteImpl.java', OVERRIDE_CLASS);
  const m = method(d, 'toString');
  assert.ok(m, 'toString() must be extracted');
  assert.equal(m!.isDeclaredOverride, true);
});

test('notOverridden: isDeclaredOverride=false', () => {
  const d = extractor.parseStructure('ConcreteImpl.java', OVERRIDE_CLASS);
  const m = method(d, 'notOverridden');
  assert.ok(m, 'notOverridden() must be extracted');
  assert.equal(m!.isDeclaredOverride, false);
});

test('ConcreteImpl: state field extracted', () => {
  const d = extractor.parseStructure('ConcreteImpl.java', OVERRIDE_CLASS);
  const f = field(d, 'state');
  assert.ok(f, 'state field must be extracted');
  assert.equal(f!.type, 'String');
  assert.equal(f!.visibility, 'private');
});

// ─── Test: generic methods and varargs ───────────────────────────────────────

test('generic method findById: two parameters including Class<V>', () => {
  const d = extractor.parseStructure('Repository.java', GENERIC_METHODS);
  const m = method(d, 'findById');
  assert.ok(m, 'findById must be extracted');
  assert.equal(m!.parameters.length, 2);
  assert.equal(param(m!, 0)!.name, 'key');
  assert.equal(param(m!, 1)!.type, 'Class<V>');
  assert.equal(param(m!, 1)!.name, 'type');
});

test('varargs method groupBy: String... keys detected as vararg', () => {
  const d = extractor.parseStructure('Repository.java', GENERIC_METHODS);
  const m = method(d, 'groupBy');
  assert.ok(m, 'groupBy must be extracted');
  const keysParam = m!.parameters.find(p => p.name === 'keys');
  assert.ok(keysParam, 'keys parameter must be present');
  assert.equal(keysParam!.isVararg, true);
});

test('generic field store: Map<String, T> type preserved', () => {
  const d = extractor.parseStructure('Repository.java', GENERIC_METHODS);
  const f = field(d, 'store');
  assert.ok(f, 'store field must be extracted');
  assert.equal(f!.type, 'Map<String, T>');
});

// ─── Test: interface methods ──────────────────────────────────────────────────

test('interface: process method extracted with two parameters', () => {
  const d = extractor.parseStructure('PaymentGateway.java', ABSTRACT_INTERFACE);
  const m = method(d, 'process');
  assert.ok(m, 'process must be extracted from interface');
  assert.equal(m!.parameters.length, 2);
  assert.equal(param(m!, 0)!.type, 'String');
  assert.equal(param(m!, 1)!.type, 'double');
});

test('interface: default method describe extracted', () => {
  const d = extractor.parseStructure('PaymentGateway.java', ABSTRACT_INTERFACE);
  const m = method(d, 'describe');
  assert.ok(m, 'default method describe must be extracted');
  assert.equal(m!.returnType, 'String');
});

// ─── Test: enum with methods ──────────────────────────────────────────────────

test('enum Status: isTerminal method extracted', () => {
  const d = extractor.parseStructure('Status.java', ENUM_WITH_METHODS);
  const m = method(d, 'isTerminal');
  assert.ok(m, 'isTerminal must be extracted from enum');
  assert.equal(m!.returnType, 'boolean');
});

test('enum Status: toString @Override detected', () => {
  const d = extractor.parseStructure('Status.java', ENUM_WITH_METHODS);
  const m = method(d, 'toString');
  assert.ok(m, 'toString must be extracted from enum');
  assert.equal(m!.isDeclaredOverride, true);
});

// ─── Adversarial: symbol names in literals and comments ──────────────────────

test('ADVERSARIAL: symbol in single-line comment must not produce field', () => {
  const d = extractor.parseStructure('Tricky.java', ADVERSARIAL_LITERALS);
  const fake = field(d, 'fakeField');
  assert.equal(fake, undefined, 'fakeField from comment must NOT be extracted');
});

test('ADVERSARIAL: symbol in block comment must not produce field', () => {
  const d = extractor.parseStructure('Tricky.java', ADVERSARIAL_LITERALS);
  const fake = field(d, 'anotherFake');
  assert.equal(fake, undefined, 'anotherFake from block comment must NOT be extracted');
});

test('ADVERSARIAL: realField is still extracted despite surrounding adversarial content', () => {
  const d = extractor.parseStructure('Tricky.java', ADVERSARIAL_LITERALS);
  const f = field(d, 'realField');
  assert.ok(f, 'realField must still be extracted');
  assert.equal(f!.type, 'String');
});

test('ADVERSARIAL: Java text block content must not produce field', () => {
  const d = extractor.parseStructure('Tricky.java', ADVERSARIAL_LITERALS);
  // The text block contains "private int y = 10;" — must NOT produce a field 'y'
  const fake = field(d, 'y');
  assert.equal(fake, undefined, 'field y from text block must NOT be extracted');
});

test('ADVERSARIAL: string literal content must not produce field', () => {
  const d = extractor.parseStructure('Tricky.java', ADVERSARIAL_LITERALS);
  // String contains "private int x = 5; return x;" — must NOT produce field 'x'
  const fake = field(d, 'x');
  assert.equal(fake, undefined, 'field x from string literal must NOT be extracted');
});

// ─── Adversarial: complex initialisers ───────────────────────────────────────

test('ADVERSARIAL: static final List field with complex initialiser extracted', () => {
  const d = extractor.parseStructure('Config.java', ADVERSARIAL_INITIALISER);
  const f = field(d, 'ALLOWED');
  assert.ok(f, 'ALLOWED must be extracted despite complex initialiser');
  assert.equal(f!.isStatic, true);
  assert.equal(f!.isFinal, true);
});

test('ADVERSARIAL: int[] field SIZES extracted', () => {
  const d = extractor.parseStructure('Config.java', ADVERSARIAL_INITIALISER);
  // int[] SIZES — type should contain bracket notation
  const f = field(d, 'SIZES');
  assert.ok(f, 'SIZES must be extracted');
});

// ─── Multi-line parameters ────────────────────────────────────────────────────

test('multi-line parameter list: configure() has 3 parameters', () => {
  const d = extractor.parseStructure('Builder.java', MULTILINE_PARAMS);
  const m = method(d, 'configure');
  assert.ok(m, 'configure() must be extracted');
  assert.equal(m!.parameters.length, 3, `Expected 3 params, got ${m!.parameters.length}`);
  assert.equal(param(m!, 0)!.name, 'name');
  assert.equal(param(m!, 1)!.name, 'timeout');
  assert.equal(param(m!, 2)!.name, 'options');
});

// ─── Inner classes ────────────────────────────────────────────────────────────

test('inner class: innerField extracted', () => {
  const d = extractor.parseStructure('Outer.java', INNER_CLASS);
  const f = field(d, 'innerField');
  assert.ok(f, 'innerField of Inner class must be extracted');
});

test('inner class: outerField extracted', () => {
  const d = extractor.parseStructure('Outer.java', INNER_CLASS);
  const f = field(d, 'outerField');
  assert.ok(f, 'outerField of Outer class must be extracted');
});

test('inner class: getInnerField() method extracted', () => {
  const d = extractor.parseStructure('Outer.java', INNER_CLASS);
  const m = method(d, 'getInnerField');
  assert.ok(m, 'getInnerField() must be extracted');
  assert.equal(m!.returnType, 'String');
});

// ─── Backward compatibility ───────────────────────────────────────────────────

test('backward compat: packageName still extracted', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  assert.equal(d.packageName, 'com.acme');
});

test('backward compat: imports still extracted', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  assert.ok(d.imports.some(imp => imp.moduleSpecifier === 'java.util.List'));
});

test('backward compat: declarations still extracted', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  assert.ok(d.declarations.some(decl => decl.name === 'UserService'));
});

test('backward compat: annotations still extracted', () => {
  const d = extractor.parseStructure('Status.java', ENUM_WITH_METHODS);
  // Override annotation collected
  assert.ok(d.annotations.includes('Override'));
});

test('backward compat: isTestFile still works for JUnit', () => {
  const src = `
package com.acme;
import org.junit.jupiter.api.Test;
public class FooTest {
    @Test
    public void testSomething() {}
}
`;
  const d = extractor.parseStructure('FooTest.java', src);
  assert.equal(d.isTestFile, true);
});

// ─── Determinism ──────────────────────────────────────────────────────────────

test('determinism: two calls produce identical JSON output', () => {
  const run1 = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const run2 = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  assert.deepEqual(run1, run2, 'Extractor must be deterministic');
  assert.equal(JSON.stringify(run1), JSON.stringify(run2));
});

test('determinism: field order is insertion-order (line order)', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const names = d.fields.map(f => f.name);
  // Fields in source order: userId, retryCount, DEFAULT_ROLE, running, cache
  const idx = (n: string) => names.indexOf(n);
  assert.ok(idx('userId') < idx('retryCount'), 'userId must come before retryCount');
  assert.ok(idx('retryCount') < idx('DEFAULT_ROLE'), 'retryCount before DEFAULT_ROLE');
  assert.ok(idx('DEFAULT_ROLE') < idx('running'), 'DEFAULT_ROLE before running');
  assert.ok(idx('running') < idx('cache'), 'running before cache');
});

test('determinism: method order is insertion-order (line order)', () => {
  const d = extractor.parseStructure('UserService.java', SIMPLE_CLASS);
  const names = d.methods.map(m => m.name);
  const idx = (n: string) => names.indexOf(n);
  // Methods in source order: UserService (ctor), getUserId, findAll, packagePrivateHelper, computeHash
  assert.ok(idx('getUserId') < idx('findAll'), 'getUserId before findAll');
  assert.ok(idx('findAll') < idx('computeHash'), 'findAll before computeHash');
});

// ─── Adversarial: no false method match on control flow ──────────────────────

test('ADVERSARIAL: if/for/while/switch not extracted as methods', () => {
  const src = `
package com.acme;
public class Flow {
    public void run() {
        if (true) {}
        for (int i = 0; i < 10; i++) {}
        while (false) {}
        switch (x) { case 1: break; }
    }
}
`;
  const d = extractor.parseStructure('Flow.java', src);
  const names = d.methods.map(m => m.name);
  for (const kw of ['if', 'for', 'while', 'switch']) {
    assert.ok(!names.includes(kw), `"${kw}" must not appear as a method name`);
  }
});

// ─── Final report ─────────────────────────────────────────────────────────────

const total = `${passed}${process.exitCode === 1 ? '?fails' : ''}`;
console.log(`\nJ-1 JavaRoleExtractor: ${passed} tests passed`);
if (process.exitCode !== 1) {
  console.log('ALL PASSED');
}
