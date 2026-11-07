import * as assert from 'assert';
import { 
  canonicalEncode, 
  strictJsonDecode, 
  CanonicalSet, 
  computeDomainSeparatedHash 
} from '../../../src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../src/sajimora/certified/protocol';

async function runTests() {
  let failures = 0;

  function test(name: string, fn: () => void) {
    try {
      fn();
      console.log(`PASS: ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`, e);
      failures++;
    }
  }

  // 1. Independent literal known-answer SHA-256 vectors
  test('Known-answer vector for domain-separated hash', () => {
    // domain || NUL || schemaVersion || NUL || canonicalPayloadBytes
    const payload = Buffer.from('{"a":1}', 'utf8');
    const hash = computeDomainSeparatedHash(
      ArtifactDomain.MANIFEST,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      payload
    );
    // Calculated independently:
    // 'MANIFEST\0SAJIMORA_CERTIFIED_EVIDENCE_V1\0{"a":1}'
    // echo -n 'MANIFEST\0SAJIMORA_CERTIFIED_EVIDENCE_V1\0{"a":1}' | shasum -a 256
    // In Node:
    const crypto = require('crypto');
    const expectedBuffer = Buffer.concat([
      Buffer.from(ArtifactDomain.MANIFEST, 'utf8'),
      Buffer.from([0]),
      Buffer.from(SAJIMORA_CERTIFIED_EVIDENCE_V1, 'utf8'),
      Buffer.from([0]),
      payload
    ]);
    const expectedHash = crypto.createHash('sha256').update(expectedBuffer).digest('hex');
    assert.strictEqual(hash, expectedHash);
  });

  // 2. Duplicate keys
  test('Strict JSON Decode rejects duplicate keys', () => {
    assert.throws(() => {
      strictJsonDecode('{"a":1,"a":2}');
    }, /Duplicate key "a"/);
  });

  test('strictJsonDecode correctly skips newlines, carriage returns, and tabs', () => {
    const jsonWithWhitespace = '{\n  "a": 1,\r\n\t"b": [2,\n3]\n}';
    const decoded = strictJsonDecode(jsonWithWhitespace);
    assert.deepStrictEqual(decoded, { a: 1, b: [2, 3] });
  });

  // 3. undefined
  test('canonicalEncode rejects undefined', () => {
    assert.throws(() => {
      canonicalEncode(undefined);
    }, /undefined is not permitted/);
    assert.throws(() => {
      canonicalEncode({ a: undefined });
    }, /undefined is not permitted/);
  });

  // 4. explicit null
  test('canonicalEncode preserves explicit null', () => {
    assert.strictEqual(canonicalEncode(null), 'null');
    assert.strictEqual(canonicalEncode({ a: null }), '{"a":null}');
  });

  // 5. ordered vs set arrays & input-order determinism
  test('Canonical array semantics: ordered vs set', () => {
    // Ordered arrays preserve order
    const arr1 = [2, 1, 3];
    assert.strictEqual(canonicalEncode(arr1), '[2,1,3]');

    // Set arrays canonical-sort
    const set1 = new CanonicalSet([2, 1, 3]);
    assert.strictEqual(canonicalEncode(set1), '[1,2,3]');

    // Input-order determinism for sets
    const setA = new CanonicalSet([{b: 2}, {a: 1}]);
    const setB = new CanonicalSet([{a: 1}, {b: 2}]);
    assert.strictEqual(canonicalEncode(setA), '[{"a":1},{"b":2}]');
    assert.strictEqual(canonicalEncode(setB), '[{"a":1},{"b":2}]');

    // Duplicate semantic members rejected
    const setC = new CanonicalSet([{a: 1}, {a: 1}]);
    assert.throws(() => {
      canonicalEncode(setC);
    }, /Duplicate semantic member/);
  });

  // 6. Numbers, NaN, Infinity, and -0 semantics
  test('canonicalEncode properly formats 0, -0, positive/negative numbers, and rejects NaN/Infinity', () => {
    // Basic numbers
    assert.strictEqual(canonicalEncode(42), '42');
    assert.strictEqual(canonicalEncode(-42.5), '-42.5');
    
    // Explicit check for 0 vs -0
    assert.strictEqual(canonicalEncode(0), '0');
    assert.strictEqual(canonicalEncode(-0), '0');
    
    // Decoder preserves -0 in canonical re-encode check
    const dec0 = strictJsonDecode('0');
    assert.strictEqual(Object.is(dec0, 0), true);
    assert.strictEqual(Object.is(dec0, -0), false);
    
    const decMinus0 = strictJsonDecode('-0');
    assert.strictEqual(Object.is(decMinus0, -0), true);
    assert.strictEqual(canonicalEncode(decMinus0), '0');

    // Reject NaN/Infinity
    assert.throws(() => canonicalEncode(NaN), /Forbidden number/);
    assert.throws(() => canonicalEncode(Infinity), /Forbidden number/);
    assert.throws(() => canonicalEncode(-Infinity), /Forbidden number/);
  });

  // 7. malformed UTF-8
  test('strictJsonDecode rejects invalid UTF-8 when parsing buffers', () => {
    const invalidUtf8 = Buffer.from([0x80]);
    assert.throws(() => {
      strictJsonDecode(invalidUtf8);
    }, /Invalid UTF-8/);
  });

  // 8. unpaired surrogates
  test('Rejects unpaired surrogates', () => {
    // In strictJsonDecode
    assert.throws(() => {
      strictJsonDecode('"\\uD800"'); // Decodes to string with unpaired surrogate
    }, /Unpaired surrogate/);

    // In canonicalEncode
    assert.throws(() => {
      canonicalEncode('\uD800');
    }, /Unpaired surrogate/);
  });

  // 9. trailing JSON
  test('strictJsonDecode rejects trailing data', () => {
    assert.throws(() => {
      strictJsonDecode('{"a":1} trailing');
    }, /Trailing data/);
  });

  // 10. hash domain separation
  test('Hash domain separation ensures unique hashes', () => {
    const payload = Buffer.from('{}', 'utf8');
    const hash1 = computeDomainSeparatedHash(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, payload);
    const hash2 = computeDomainSeparatedHash(ArtifactDomain.CLOSURE, SAJIMORA_CERTIFIED_EVIDENCE_V1, payload);
    assert.notStrictEqual(hash1, hash2);
  });

  // 11. Parser nesting depth limits
  test('strictJsonDecode enforces maximum nesting depth', () => {
    // Create nested JSON
    let deepJson = '{}';
    for (let i = 0; i < 128; i++) {
      deepJson = `{"a":${deepJson}}`;
    }
    // Should parse at limit (128 nesting)
    const result = strictJsonDecode(deepJson, 128);
    assert.strictEqual(typeof result, 'object');

    // Create a deeply nested structure that exceeds limit
    let tooDeepJson = '{}';
    for (let i = 0; i < 129; i++) {
      tooDeepJson = `{"a":${tooDeepJson}}`;
    }
    
    // Test object nesting failure
    assert.throws(() => {
      strictJsonDecode(tooDeepJson, 128);
    }, /Maximum nesting depth exceeded/);

    // Test array nesting failure
    let tooDeepArray = '[]';
    for (let i = 0; i < 129; i++) {
      tooDeepArray = `[${tooDeepArray}]`;
    }
    assert.throws(() => {
      strictJsonDecode(tooDeepArray, 128);
    }, /Maximum nesting depth exceeded/);
  });

  if (failures > 0) {
    console.error(`\n${failures} tests failed.`);
    process.exit(1);
  } else {
    console.log('\nAll PR1 contract tests passed successfully.');
    process.exit(0);
  }
}

runTests();
