import { test } from 'node:test';
import * as assert from 'node:assert';
import ts from 'typescript';
import { F0BindingVerifier } from '../../../src/sajimora/certified/fragment/F0BindingVerifier';
import { BlockerCode } from '../../../../core/src/sajimora/certified/blockers';
import { Vertex } from '../../../../core/src/sajimora/certified/contracts';

test('F0BindingVerifier - Comprehensive Semantic & Adversarial Suite', async (t) => {
  const v1: Vertex = { projectId: 'p1', fileId: 'src/a.ts' };

  await t.test('successfully extracts valid top-level module bindings', () => {
    const src = `
      export const x: number = 42;
      export function foo(a: string): string { return a; }
      export type MyType = string | number;
      export interface MyInterface { readonly prop: string; }
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, true);
    assert.ok(res.bindings);
    assert.strictEqual(res.bindings.symbols.size, 4);
    assert.strictEqual(res.bindings.exportedSymbols.size, 4);
    assert.ok(res.bindings.symbols.has('x'));
    assert.ok(res.bindings.symbols.has('foo'));
    assert.ok(res.bindings.symbols.has('MyType'));
    assert.ok(res.bindings.symbols.has('MyInterface'));
  });

  await t.test('rejects duplicate declarations with AMBIGUOUS_DECLARATION_GROUP', () => {
    const src = `
      const x: number = 1;
      const x: string = "hello";
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
  });

  await t.test('rejects function overloading / duplicate function declaration with AMBIGUOUS_DECLARATION_GROUP', () => {
    const src = `
      function fn(x: number): number { return x; }
      function fn(x: string): string { return x; }
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
  });

  await t.test('rejects interface merging with AMBIGUOUS_DECLARATION_GROUP', () => {
    const src = `
      interface I { readonly a: string; }
      interface I { readonly b: number; }
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
  });

  await t.test('rejects symbol name collision between variable and type with AMBIGUOUS_DECLARATION_GROUP', () => {
    const src = `
      const T: number = 10;
      type T = string;
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
  });

  await t.test('rejects wildcard exports with UNSUPPORTED_SYNTAX', () => {
    const src = `
      export * from './b';
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
  });

  await t.test('rejects export of undeclared symbol with UNSUPPORTED_BINDING', () => {
    const src = `
      export { nonExistent };
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.UNSUPPORTED_BINDING);
  });

  await t.test('rejects duplicate exported name with AMBIGUOUS_DECLARATION_GROUP', () => {
    const src = `
      const a: number = 1;
      const b: number = 2;
      export { a as out, b as out };
    `;
    const sf = ts.createSourceFile(v1.fileId, src, ts.ScriptTarget.Latest, true);
    const res = F0BindingVerifier.extractModuleBindings(v1, sf);
    assert.strictEqual(res.result.valid, false);
    assert.strictEqual(res.result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
  });

  await t.test('verifyCrossModuleBindings successfully verifies valid import-export wiring', () => {
    const srcA = `
      export const exportedVal: number = 100;
    `;
    const srcB = `
      import { exportedVal } from './a';
      export const derived: number = exportedVal;
    `;
    const sfA = ts.createSourceFile('src/a.ts', srcA, ts.ScriptTarget.Latest, true);
    const sfB = ts.createSourceFile('src/b.ts', srcB, ts.ScriptTarget.Latest, true);

    const bA = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'src/a.ts' }, sfA);
    const bB = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'src/b.ts' }, sfB);

    assert.strictEqual(bA.result.valid, true);
    assert.strictEqual(bB.result.valid, true);

    const moduleMap = new Map([
      ['src/a.ts', bA.bindings!],
      ['src/b.ts', bB.bindings!]
    ]);

    const resolver = (from: string, spec: string) => {
      if (from === 'src/b.ts' && spec === './a') return 'src/a.ts';
      return null;
    };

    const crossRes = F0BindingVerifier.verifyCrossModuleBindings(moduleMap, resolver);
    assert.strictEqual(crossRes.valid, true);
  });

  await t.test('verifyCrossModuleBindings rejects import of non-existent export with UNSUPPORTED_BINDING', () => {
    const srcA = `
      export const otherVal: number = 100;
    `;
    const srcB = `
      import { missingVal } from './a';
    `;
    const sfA = ts.createSourceFile('src/a.ts', srcA, ts.ScriptTarget.Latest, true);
    const sfB = ts.createSourceFile('src/b.ts', srcB, ts.ScriptTarget.Latest, true);

    const bA = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'src/a.ts' }, sfA);
    const bB = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'src/b.ts' }, sfB);

    const moduleMap = new Map([
      ['src/a.ts', bA.bindings!],
      ['src/b.ts', bB.bindings!]
    ]);

    const resolver = (from: string, spec: string) => {
      if (from === 'src/b.ts' && spec === './a') return 'src/a.ts';
      return null;
    };

    const crossRes = F0BindingVerifier.verifyCrossModuleBindings(moduleMap, resolver);
    assert.strictEqual(crossRes.valid, false);
    assert.strictEqual(crossRes.blockerCode, BlockerCode.UNSUPPORTED_BINDING);
  });

  await t.test('default import produces the canonical default binding and replays against an explicit default export', () => {
    const provider = `const impl: string = "ok"; export { impl as default };`;
    const defaultConsumer = `import value from './provider'; export const result: string = value;`;
    const explicitConsumer = `import { default as value } from './provider'; export const result: string = value;`;
    const p = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'provider.ts' }, ts.createSourceFile('provider.ts', provider, ts.ScriptTarget.Latest, true));
    const d = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'default.ts' }, ts.createSourceFile('default.ts', defaultConsumer, ts.ScriptTarget.Latest, true));
    const e = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'explicit.ts' }, ts.createSourceFile('explicit.ts', explicitConsumer, ts.ScriptTarget.Latest, true));
    assert.deepStrictEqual(d.bindings!.imports.get('value')!.sourceExportName, 'default');
    assert.deepStrictEqual(e.bindings!.imports.get('value')!.sourceExportName, 'default');
    assert.equal(F0BindingVerifier.verifyCrossModuleBindings(new Map([['provider.ts', p.bindings!], ['default.ts', d.bindings!]]), (_from, spec) => spec === './provider' ? 'provider.ts' : null).valid, true);
  });

  await t.test('rejects mixed default and named import in binding verification', () => {
    const source = `import value, { named } from './provider';`;
    const res = F0BindingVerifier.extractModuleBindings(v1, ts.createSourceFile(v1.fileId, source, ts.ScriptTarget.Latest, true));
    assert.equal(res.result.valid, false);
    assert.equal(res.result.blockerCode, BlockerCode.UNSUPPORTED_BINDING);
  });

  await t.test('replays a namespace member only to a direct sealed export', () => {
    const provider = `const value: string = "ok"; export { value };`;
    const consumer = `import * as ns from './provider'; export const result: string = ns.value;`;
    const p = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'provider.ts' }, ts.createSourceFile('provider.ts', provider, ts.ScriptTarget.Latest, true));
    const c = F0BindingVerifier.extractModuleBindings({ projectId: 'p1', fileId: 'consumer.ts' }, ts.createSourceFile('consumer.ts', consumer, ts.ScriptTarget.Latest, true));
    const modules = new Map([['provider.ts', p.bindings!], ['consumer.ts', c.bindings!]]);
    assert.equal(c.result.valid, true);
    assert.deepEqual(c.bindings!.namespaceImports.get('ns')?.moduleSpecifier, './provider');
    assert.equal(F0BindingVerifier.verifyCrossModuleBindings(modules, (_from, spec) => spec === './provider' ? 'provider.ts' : null).valid, true);
    assert.equal(F0BindingVerifier.resolveNamespaceMember(modules, 'consumer.ts', 'ns', 'value', (_from, spec) => spec === './provider' ? 'provider.ts' : null).symbol?.name, 'value');
  });

  await t.test('rejects missing namespace member, package namespace imports, and nested namespace access', () => {
    const provider = F0BindingVerifier.extractModuleBindings(v1, ts.createSourceFile('provider.ts', `export const value: string = "ok";`, ts.ScriptTarget.Latest, true));
    const missing = F0BindingVerifier.extractModuleBindings(v1, ts.createSourceFile('consumer.ts', `import * as ns from './provider'; ns.missing;`, ts.ScriptTarget.Latest, true));
    assert.equal(F0BindingVerifier.verifyCrossModuleBindings(new Map([['provider.ts', provider.bindings!], ['consumer.ts', missing.bindings!]]), (_from, spec) => spec === './provider' ? 'provider.ts' : null).valid, false);
    const pkg = F0BindingVerifier.extractModuleBindings(v1, ts.createSourceFile('consumer.ts', `import * as ns from 'pkg';`, ts.ScriptTarget.Latest, true));
    assert.equal(pkg.result.valid, false);
    const nested = F0BindingVerifier.extractModuleBindings(v1, ts.createSourceFile('consumer.ts', `import * as ns from './provider'; function f(ns: { readonly value: string }): string { return ns.value; }`, ts.ScriptTarget.Latest, true));
    assert.equal(nested.result.valid, false);
  });
});
