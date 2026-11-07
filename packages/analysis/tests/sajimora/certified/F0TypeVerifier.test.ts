import { test } from 'node:test';
import * as assert from 'node:assert';
import ts from 'typescript';
import { F0TypeVerifier, F0ScalarType } from '../../../src/sajimora/certified/fragment/F0TypeVerifier';

test('F0TypeVerifier - Comprehensive Semantic & Adversarial Suite', async (t) => {
  await t.test('normalizes scalar unions and absorbs true | false into boolean', () => {
    const unionTrueFalse: F0ScalarType = {
      kind: 'union',
      types: [
        { kind: 'literal', value: true },
        { kind: 'literal', value: false }
      ]
    };
    const norm = F0TypeVerifier.normalizeScalar(unionTrueFalse);
    assert.strictEqual(norm.kind, 'primitive');
    if (norm.kind === 'primitive') {
      assert.strictEqual(norm.name, 'boolean');
    }
  });

  await t.test('absorbs string literal into string primitive', () => {
    const unionStringLit: F0ScalarType = {
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'string' },
        { kind: 'literal', value: 'hello' }
      ]
    };
    const norm = F0TypeVerifier.normalizeScalar(unionStringLit);
    assert.strictEqual(norm.kind, 'primitive');
    if (norm.kind === 'primitive') {
      assert.strictEqual(norm.name, 'string');
    }
  });

  await t.test('absorbs number literal into number primitive', () => {
    const unionNumLit: F0ScalarType = {
      kind: 'union',
      types: [
        { kind: 'literal', value: 42 },
        { kind: 'primitive', name: 'number' }
      ]
    };
    const norm = F0TypeVerifier.normalizeScalar(unionNumLit);
    assert.strictEqual(norm.kind, 'primitive');
    if (norm.kind === 'primitive') {
      assert.strictEqual(norm.name, 'number');
    }
  });

  await t.test('absorbs never in unions', () => {
    const unionWithNever: F0ScalarType = {
      kind: 'union',
      types: [
        { kind: 'never' },
        { kind: 'literal', value: 'foo' }
      ]
    };
    const norm = F0TypeVerifier.normalizeScalar(unionWithNever);
    assert.strictEqual(norm.kind, 'literal');
    if (norm.kind === 'literal') {
      assert.strictEqual(norm.value, 'foo');
    }
  });

  await t.test('preserves -0 as distinct in canonical scalar keys', () => {
    const negZero: F0ScalarType = { kind: 'literal', value: -0 };
    const posZero: F0ScalarType = { kind: 'literal', value: 0 };
    const negKey = F0TypeVerifier.canonicalScalarKey(negZero);
    const posKey = F0TypeVerifier.canonicalScalarKey(posZero);
    assert.notStrictEqual(negKey, posKey);
    assert.strictEqual(negKey, 'lit:num:-0');
    assert.strictEqual(posKey, 'lit:number:0');
  });

  await t.test('flattens nested unions and deduplicates alternatives', () => {
    const nested: F0ScalarType = {
      kind: 'union',
      types: [
        { kind: 'literal', value: 'a' },
        {
          kind: 'union',
          types: [
            { kind: 'literal', value: 'b' },
            { kind: 'literal', value: 'a' }
          ]
        }
      ]
    };
    const norm = F0TypeVerifier.normalizeScalar(nested);
    assert.strictEqual(norm.kind, 'union');
    if (norm.kind === 'union') {
      assert.strictEqual(norm.types.length, 2);
      assert.strictEqual(norm.types[0].kind, 'literal');
      assert.strictEqual(norm.types[1].kind, 'literal');
    }
  });

  await t.test('correctly evaluates scalar subtyping relations', () => {
    const lit42: F0ScalarType = { kind: 'literal', value: 42 };
    const primNum: F0ScalarType = { kind: 'primitive', name: 'number' };
    const primStr: F0ScalarType = { kind: 'primitive', name: 'string' };
    const neverT: F0ScalarType = { kind: 'never' };

    // 42 <= number
    assert.strictEqual(F0TypeVerifier.isScalarSubtype(lit42, primNum), true);
    // number is NOT <= 42
    assert.strictEqual(F0TypeVerifier.isScalarSubtype(primNum, lit42), false);
    // 42 is NOT <= string
    assert.strictEqual(F0TypeVerifier.isScalarSubtype(lit42, primStr), false);
    // never is <= 42 and <= number
    assert.strictEqual(F0TypeVerifier.isScalarSubtype(neverT, lit42), true);
    assert.strictEqual(F0TypeVerifier.isScalarSubtype(neverT, primNum), true);
  });

  await t.test('topologicalSortAliases successfully sorts acyclic alias graph', () => {
    const graph = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', []]
    ]);
    const res = F0TypeVerifier.topologicalSortAliases(graph);
    assert.strictEqual(res.valid, true);
    if (res.valid) {
      assert.strictEqual(res.order.indexOf('D') < res.order.indexOf('B'), true);
      assert.strictEqual(res.order.indexOf('D') < res.order.indexOf('C'), true);
      assert.strictEqual(res.order.indexOf('B') < res.order.indexOf('A'), true);
      assert.strictEqual(res.order.indexOf('C') < res.order.indexOf('A'), true);
    }
  });

  await t.test('topologicalSortAliases detects direct and indirect alias cycles', () => {
    // 2-node cycle: A -> B -> A
    const cycle2 = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']]
    ]);
    const res2 = F0TypeVerifier.topologicalSortAliases(cycle2);
    assert.strictEqual(res2.valid, false);

    // 3-node cycle: X -> Y -> Z -> X
    const cycle3 = new Map<string, string[]>([
      ['X', ['Y']],
      ['Y', ['Z']],
      ['Z', ['X']]
    ]);
    const res3 = F0TypeVerifier.topologicalSortAliases(cycle3);
    assert.strictEqual(res3.valid, false);

    // Self cycle: S -> S
    const cycleSelf = new Map<string, string[]>([
      ['S', ['S']]
    ]);
    const resSelf = F0TypeVerifier.topologicalSortAliases(cycleSelf);
    assert.strictEqual(resSelf.valid, false);
  });

  await t.test('extractScalarType correctly extracts scalar types and rejects arrays / tuples / any', () => {
    const parseType = (src: string): ts.TypeNode => {
      const sf = ts.createSourceFile('test.ts', `type X = ${src};`, ts.ScriptTarget.Latest, true);
      const stmt = sf.statements[0] as ts.TypeAliasDeclaration;
      return stmt.type;
    };

    // Valid string literal
    const tStr = parseType('"hello"');
    const rStr = F0TypeVerifier.extractScalarType(tStr, () => undefined);
    assert.strictEqual(rStr.valid, true);
    if (rStr.valid) {
      assert.strictEqual(rStr.type.kind, 'literal');
      if (rStr.type.kind === 'literal') assert.strictEqual(rStr.type.value, 'hello');
    }

    // Valid union
    const tUnion = parseType('string | number');
    const rUnion = F0TypeVerifier.extractScalarType(tUnion, () => undefined);
    assert.strictEqual(rUnion.valid, true);
    if (rUnion.valid) assert.strictEqual(rUnion.type.kind, 'union');

    // Reject array type
    const tArr = parseType('string[]');
    const rArr = F0TypeVerifier.extractScalarType(tArr, () => undefined);
    assert.strictEqual(rArr.valid, false);

    // Reject tuple type
    const tTup = parseType('[string, number]');
    const rTup = F0TypeVerifier.extractScalarType(tTup, () => undefined);
    assert.strictEqual(rTup.valid, false);

    // Reject any type
    const tAny = parseType('any');
    const rAny = F0TypeVerifier.extractScalarType(tAny, () => undefined);
    assert.strictEqual(rAny.valid, false);
  });

  await t.test('extractType admits deterministic readonly structural type literals', () => {
    const sf = ts.createSourceFile('test.ts', 'type T = { readonly z: number; readonly value: string; };', ts.ScriptTarget.Latest, true);
    const node = (sf.statements[0] as ts.TypeAliasDeclaration).type;
    const result = F0TypeVerifier.extractType(node, () => undefined);
    assert.strictEqual(result.valid, true);
    if (result.valid) {
      assert.strictEqual(result.type.kind, 'record');
      if (result.type.kind === 'record') {
        assert.deepStrictEqual([...result.type.properties.keys()], ['value', 'z']);
        assert.strictEqual(result.type.properties.get('value')?.readonly, true);
        assert.strictEqual(result.type.properties.get('value')?.type.kind, 'primitive');
      }
    }
  });

  await t.test('extractType rejects non-narrow structural members fail closed', () => {
    const rejected = [
      '{ value: string }',
      '{ readonly value?: string }',
      '{ readonly [key: string]: string }',
      '{ readonly value(): string }',
      '{ readonly value: { readonly nested: string } }',
      '{ readonly value: T }'
    ];
    for (const source of rejected) {
      const sf = ts.createSourceFile('test.ts', `type T = ${source};`, ts.ScriptTarget.Latest, true);
      const node = (sf.statements[0] as ts.TypeAliasDeclaration).type;
      const result = F0TypeVerifier.extractType(node, () => undefined);
      assert.strictEqual(result.valid, false, source);
    }
  });

  await t.test('extractSignature admits explicit scalar and certified record types only', () => {
    const sf = ts.createSourceFile('test.ts', 'function f(x: string): number { return 1; }', ts.ScriptTarget.Latest, true);
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    const result = F0TypeVerifier.extractSignature(fn, () => undefined);
    assert.strictEqual(result.valid, true);
    const badSf = ts.createSourceFile('bad.ts', 'function g(x): number { return 1; }', ts.ScriptTarget.Latest, true);
    const bad = F0TypeVerifier.extractSignature(badSf.statements[0] as ts.FunctionDeclaration, () => undefined);
    assert.strictEqual(bad.valid, false);
  });
});
