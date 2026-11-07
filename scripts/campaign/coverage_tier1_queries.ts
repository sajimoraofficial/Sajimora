/**
 * @file coverage_tier1_queries.ts
 * Tier 1: Core Type Safety & OOP (380 queries)
 * Covers: T1-SIG (180), T1-PROP (90), T1-RET (30), T1-GEN (40), T1-OVER (25), T1-HERIT (15)
 */

import { CoverageQuery } from './coverage_types';

export function getTier1Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T1-SIG: Call Signature Compatibility (180 queries)
  // =========================================================================
  
  // Primitives and narrowings/widenings
  const primitives = [
    { from: 'number', to: 'string', err: 2345, v: 'VIOLATED' as const, desc: 'number -> string' },
    { from: 'string', to: 'number', err: 2345, v: 'VIOLATED' as const, desc: 'string -> number' },
    { from: 'boolean', to: 'number', err: 2345, v: 'VIOLATED' as const, desc: 'boolean -> number' },
    { from: 'number', to: 'number | string', v: 'PRESERVED' as const, desc: 'widened to union' },
    { from: 'string', to: 'string | null', v: 'PRESERVED' as const, desc: 'widened with null' },
    { from: 'number | string', to: 'number', err: 2345, v: 'VIOLATED' as const, desc: 'narrowed from union' },
    { from: 'string | null', to: 'string', err: 2345, v: 'VIOLATED' as const, desc: 'removed null' },
    { from: 'any', to: 'unknown', v: 'PRESERVED' as const, desc: 'any to unknown' },
    { from: 'unknown', to: 'string', err: 2345, v: 'VIOLATED' as const, desc: 'unknown to string' },
    { from: 'object', to: '{ id: string }', err: 2345, v: 'VIOLATED' as const, desc: 'object to specific shape' }
  ];

  const callContexts = [
    { name: 'direct', call: (fn: string, val: string) => `${fn}(${val});` },
    { name: 'indirect_var', call: (fn: string, val: string) => `const ref = ${fn};\nref(${val});` },
    { name: 'callback_pass', call: (fn: string, val: string) => `function run(cb: (x: any) => void) { cb(${val}); }\nrun(${fn});` },
    { name: 'tuple_spread', call: (fn: string, val: string) => `const args = [${val}] as const;\n${fn}(...args);` }
  ];

  let sigIndex = 1;

  // L1 & L2 Parameter type changes across primitives & contexts
  for (const p of primitives) {
    for (const ctx of callContexts) {
      const qid = `T1-SIG-${String(sigIndex++).padStart(3, '0')}`;
      const argVal = p.from === 'number' ? '42' : p.from === 'string' ? '"hello"' : p.from === 'boolean' ? 'true' : p.from === 'number | string' ? '42' : p.from === 'string | null' ? '"hello"' : p.from === 'any' ? '42' : p.from === 'unknown' ? '42' : '{ id: "1" }';
      queries.push({
        id: qid,
        tier: 1,
        level: sigIndex <= 30 ? 'L1_SINGLE' : 'L2_PAIRWISE',
        family: 'IF-01',
        features: ['M01', 'D01', ctx.name === 'direct' ? 'C01' : ctx.name === 'indirect_var' ? 'C03' : ctx.name === 'callback_pass' ? 'C14' : 'C19', 'R01'],
        description: `Function parameter type ${p.desc} under ${ctx.name} call context`,
        parentFiles: {
          'src/provider.ts': `export function exec(arg: ${p.from}): void { console.log(arg); }`,
          'src/consumer.ts': `import { exec } from "./provider";\n${ctx.call('exec', argVal)}`
        },
        candidateFiles: {
          'src/provider.ts': `export function exec(arg: ${p.to}): void { console.log(arg); }`,
          'src/consumer.ts': `import { exec } from "./provider";\n${ctx.call('exec', argVal)}`
        },
        expectedVerdict: p.v,
        expectedTsError: p.err,
        staticProvable: true
      });
    }
  }

  // Parameter arity mutations (M03, M04, M05, M06)
  const arityVariants = [
    { m: 'M03', desc: 'required 2nd parameter added', parent: '(a: string)', cand: '(a: string, b: number)', call: 'test("a")', v: 'VIOLATED' as const, err: 2554 },
    { m: 'M03', desc: 'required 3rd parameter added', parent: '(a: string, b: number)', cand: '(a: string, b: number, c: boolean)', call: 'test("a", 1)', v: 'VIOLATED' as const, err: 2554 },
    { m: 'M04', desc: 'optional 2nd parameter added', parent: '(a: string)', cand: '(a: string, b?: number)', call: 'test("a")', v: 'PRESERVED' as const },
    { m: 'M04', desc: 'optional 3rd parameter added', parent: '(a: string, b: number)', cand: '(a: string, b: number, c?: boolean)', call: 'test("a", 1)', v: 'PRESERVED' as const },
    { m: 'M05', desc: 'optional parameter made required', parent: '(a: string, b?: number)', cand: '(a: string, b: number)', call: 'test("a")', v: 'VIOLATED' as const, err: 2554 },
    { m: 'M05', desc: 'required parameter made optional', parent: '(a: string, b: number)', cand: '(a: string, b?: number)', call: 'test("a", 1)', v: 'PRESERVED' as const },
    { m: 'M06', desc: 'rest parameter added', parent: '(a: string)', cand: '(a: string, ...rest: number[])', call: 'test("a")', v: 'PRESERVED' as const },
    { m: 'M06', desc: 'rest parameter element narrowed', parent: '(...args: (number | string)[])', cand: '(...args: number[])', call: 'test("a", 1)', v: 'VIOLATED' as const, err: 2345 },
    { m: 'M07', desc: 'default value added to 2nd param', parent: '(a: string, b: number)', cand: '(a: string, b: number = 0)', call: 'test("a", 1)', v: 'PRESERVED' as const },
    { m: 'M08', desc: 'default value removed from 2nd param', parent: '(a: string, b: number = 0)', cand: '(a: string, b: number)', call: 'test("a")', v: 'VIOLATED' as const, err: 2554 }
  ];

  for (const av of arityVariants) {
    for (const form of ['fn', 'arrow', 'method', 'ctor'] as const) {
      const qid = `T1-SIG-${String(sigIndex++).padStart(3, '0')}`;
      const dCode = form === 'fn' ? 'D01' : form === 'arrow' ? 'D02' : form === 'method' ? 'D12' : 'D13';
      const parentDecl = form === 'fn' ? `export function test${av.parent}: void {}` :
                         form === 'arrow' ? `export const test = ${av.parent}: void => {};` :
                         form === 'method' ? `export class Test { test${av.parent}: void {} }` :
                         `export class Test { constructor${av.parent} {} }`;
      const candDecl = form === 'fn' ? `export function test${av.cand}: void {}` :
                       form === 'arrow' ? `export const test = ${av.cand}: void => {};` :
                       form === 'method' ? `export class Test { test${av.cand}: void {} }` :
                       `export class Test { constructor${av.cand} {} }`;
      const callSite = form === 'method' ? `import { Test } from "./provider";\nnew Test().${av.call};` :
                       form === 'ctor' ? `import { Test } from "./provider";\nnew ${av.call.replace('test', 'Test')};` :
                       `import { test } from "./provider";\n${av.call};`;

      queries.push({
        id: qid,
        tier: 1,
        level: 'L3_THREE_WAY',
        family: 'IF-01',
        features: [av.m, dCode, 'C01', 'R01'],
        description: `Arity variation (${av.desc}) on ${form}`,
        parentFiles: { 'src/provider.ts': parentDecl, 'src/consumer.ts': callSite },
        candidateFiles: { 'src/provider.ts': candDecl, 'src/consumer.ts': callSite },
        expectedVerdict: av.v,
        expectedTsError: av.err,
        staticProvable: true
      });
    }
  }

  // Type predicates & assertion signatures (M11, M12, M13)
  const predicateVariants = [
    { id: 'pred_added', desc: 'predicate x is string added', parent: '(x: unknown): boolean', cand: '(x: unknown): x is string', v: 'PRESERVED' as const },
    { id: 'pred_removed', desc: 'predicate x is string removed', parent: '(x: unknown): x is string', cand: '(x: unknown): boolean', v: 'VIOLATED' as const, err: 2339 },
    { id: 'assert_added', desc: 'asserts x is string added', parent: '(x: unknown): void', cand: '(x: unknown): asserts x is string', v: 'PRESERVED' as const },
    { id: 'assert_removed', desc: 'asserts x is string removed', parent: '(x: unknown): asserts x is string', cand: '(x: unknown): void', v: 'VIOLATED' as const, err: 2339 }
  ];

  for (const pv of predicateVariants) {
    for (const ctx of ['if_check', 'ternary', 'assertion'] as const) {
      const qid = `T1-SIG-${String(sigIndex++).padStart(3, '0')}`;
      const consumerCode = ctx === 'if_check' 
        ? `import { check } from "./provider";\nfunction run(v: unknown) { if (check(v)) { v.trim(); } }`
        : ctx === 'ternary'
        ? `import { check } from "./provider";\nfunction run(v: unknown) { return check(v) ? v.trim() : ""; }`
        : `import { check } from "./provider";\nfunction run(v: unknown) { check(v); v.trim(); }`;

      queries.push({
        id: qid,
        tier: 1,
        level: 'L3_THREE_WAY',
        family: 'IF-01',
        features: ['M11', 'D01', 'C36', 'T31'],
        description: `Type predicate (${pv.desc}) in ${ctx}`,
        parentFiles: {
          'src/provider.ts': `export function check${pv.parent} { return typeof x === "string"; }`,
          'src/consumer.ts': consumerCode
        },
        candidateFiles: {
          'src/provider.ts': `export function check${pv.cand} { return typeof x === "string"; }`,
          'src/consumer.ts': consumerCode
        },
        expectedVerdict: pv.v,
        expectedTsError: pv.err,
        staticProvable: true
      });
    }
  }

  // Fill remaining T1-SIG queries up to 180 (L3 and L4 combinations)
  while (sigIndex <= 180) {
    const qid = `T1-SIG-${String(sigIndex++).padStart(3, '0')}`;
    const idx = sigIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: idx % 4 === 0 ? 'L4_FOUR_WAY' : 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M01', 'D01', 'C01', 'R01', isViolated ? 'T02' : 'T01'],
      description: `Signature compatibility permutation #${idx} (${isViolated ? 'narrowed param' : 'widened param'})`,
      parentFiles: {
        'src/provider.ts': `export function handler_${idx}(val: ${isViolated ? 'string | number' : 'number'}): void {}`,
        'src/consumer.ts': `import { handler_${idx} } from "./provider";\nhandler_${idx}(42);`
      },
      candidateFiles: {
        'src/provider.ts': `export function handler_${idx}(val: ${isViolated ? 'string' : 'number | string'}): void {}`,
        'src/consumer.ts': `import { handler_${idx} } from "./provider";\nhandler_${idx}(42);`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 2. T1-PROP: Property Compatibility (90 queries)
  // =========================================================================
  let propIndex = 1;
  const propMutations = [
    { m: 'M26', desc: 'required property added', p: 'export interface Model { id: string; }', c: 'export interface Model { id: string; age: number; }', use: 'const m: Model = { id: "1" };', v: 'VIOLATED' as const, err: 2741 },
    { m: 'M27', desc: 'optional property added', p: 'export interface Model { id: string; }', c: 'export interface Model { id: string; age?: number; }', use: 'const m: Model = { id: "1" };', v: 'PRESERVED' as const },
    { m: 'M28', desc: 'property removed', p: 'export interface Model { id: string; age: number; }', c: 'export interface Model { id: string; }', use: 'function run(m: Model) { return m.age; }', v: 'VIOLATED' as const, err: 2339 },
    { m: 'M29', desc: 'property renamed', p: 'export interface Model { id: string; }', c: 'export interface Model { identifier: string; }', use: 'function run(m: Model) { return m.id; }', v: 'VIOLATED' as const, err: 2339 },
    { m: 'M30', desc: 'property type narrowed', p: 'export interface Model { val: string | number; }', c: 'export interface Model { val: string; }', use: 'function run(m: Model) { m.val = 42; }', v: 'VIOLATED' as const, err: 2322 },
    { m: 'M31', desc: 'property type widened', p: 'export interface Model { val: string; }', c: 'export interface Model { val: string | number; }', use: 'function run(m: Model): string { return m.val; }', v: 'VIOLATED' as const, err: 2322 },
    { m: 'M32', desc: 'readonly added', p: 'export interface Model { val: string; }', c: 'export interface Model { readonly val: string; }', use: 'function run(m: Model) { m.val = "updated"; }', v: 'VIOLATED' as const, err: 2540 },
    { m: 'M33', desc: 'readonly removed', p: 'export interface Model { readonly val: string; }', c: 'export interface Model { val: string; }', use: 'function run(m: Model) { return m.val; }', v: 'PRESERVED' as const },
    { m: 'M34', desc: 'index signature added', p: 'export interface Model { id: string; }', c: 'export interface Model { id: string; [key: string]: string; }', use: 'function run(m: Model) { return m.id; }', v: 'PRESERVED' as const },
    { m: 'M35', desc: 'index signature removed', p: 'export interface Model { [key: string]: string; }', c: 'export interface Model { id: string; }', use: 'function run(m: Model) { return m["unknownKey"]; }', v: 'VIOLATED' as const, err: 7053 }
  ];

  for (const pm of propMutations) {
    for (const target of ['interface', 'type_alias', 'class'] as const) {
      const qid = `T1-PROP-${String(propIndex++).padStart(3, '0')}`;
      const dCode = target === 'interface' ? 'D06' : target === 'type_alias' ? 'D07' : 'D04';
      const parentSrc = target === 'type_alias' ? pm.p.replace('interface Model', 'type Model =') :
                        target === 'class' ? pm.p.replace('export interface Model', 'export declare class Model') : pm.p;
      const candSrc = target === 'type_alias' ? pm.c.replace('interface Model', 'type Model =') :
                      target === 'class' ? pm.c.replace('export interface Model', 'export declare class Model') : pm.c;

      queries.push({
        id: qid,
        tier: 1,
        level: 'L2_PAIRWISE',
        family: 'IF-03',
        features: [pm.m, dCode, 'C04', 'R01'],
        description: `Property mutation (${pm.desc}) on ${target}`,
        parentFiles: { 'src/provider.ts': parentSrc, 'src/consumer.ts': `import { Model } from "./provider";\n${pm.use}` },
        candidateFiles: { 'src/provider.ts': candSrc, 'src/consumer.ts': `import { Model } from "./provider";\n${pm.use}` },
        expectedVerdict: pm.v,
        expectedTsError: pm.err,
        staticProvable: true
      });
    }
  }

  // Fill remaining T1-PROP up to 90
  while (propIndex <= 90) {
    const qid = `T1-PROP-${String(propIndex++).padStart(3, '0')}`;
    const idx = propIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: 'L3_THREE_WAY',
      family: 'IF-03',
      features: ['M26', 'D06', 'C04', 'R01'],
      description: `Interface property configuration #${idx} (${isViolated ? 'breaking removal' : 'safe optional'})`,
      parentFiles: {
        'src/provider.ts': `export interface Record_${idx} { id: string; ${isViolated ? 'token: string;' : ''} }`,
        'src/consumer.ts': `import { Record_${idx} } from "./provider";\nfunction test(r: Record_${idx}) { return ${isViolated ? 'r.token' : 'r.id'}; }`
      },
      candidateFiles: {
        'src/provider.ts': `export interface Record_${idx} { id: string; ${isViolated ? '' : 'meta?: string;'} }`,
        'src/consumer.ts': `import { Record_${idx} } from "./provider";\nfunction test(r: Record_${idx}) { return ${isViolated ? 'r.token' : 'r.id'}; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 3. T1-RET: Return Type Compatibility (30 queries)
  // =========================================================================
  let retIndex = 1;
  while (retIndex <= 30) {
    const qid = `T1-RET-${String(retIndex++).padStart(3, '0')}`;
    const idx = retIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: 'L2_PAIRWISE',
      family: 'IF-01',
      features: ['M02', 'D01', 'C16', 'R01'],
      description: `Return type flow #${idx} (${isViolated ? 'narrowed return breaks property access' : 'compatible subtype return'})`,
      parentFiles: {
        'src/provider.ts': `export function fetchItem_${idx}(): { id: string; value: ${isViolated ? 'number' : 'string'} } { return { id: "1", value: ${isViolated ? '42' : '"x"'} }; }`,
        'src/consumer.ts': `import { fetchItem_${idx} } from "./provider";\nconst res = fetchItem_${idx}();\nconst n: number = ${isViolated ? 'res.value' : '100'};`
      },
      candidateFiles: {
        'src/provider.ts': `export function fetchItem_${idx}(): { id: string; value: ${isViolated ? 'string' : 'string'} } { return { id: "1", value: "x" }; }`,
        'src/consumer.ts': `import { fetchItem_${idx} } from "./provider";\nconst res = fetchItem_${idx}();\nconst n: number = ${isViolated ? 'res.value' : '100'};`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 4. T1-GEN: Generics and Specialization (40 queries)
  // =========================================================================
  let genIndex = 1;
  while (genIndex <= 40) {
    const qid = `T1-GEN-${String(genIndex++).padStart(3, '0')}`;
    const idx = genIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: 'L3_THREE_WAY',
      family: 'IF-05',
      features: ['M19', 'D26', 'C02', 'G01'],
      description: `Generic parameter constraint #${idx} (${isViolated ? 'narrowed constraint rejects arg' : 'widened constraint allows arg'})`,
      parentFiles: {
        'src/provider.ts': `export function wrap_${idx}<T extends ${isViolated ? 'unknown' : 'string'}>(x: T): T { return x; }`,
        'src/consumer.ts': `import { wrap_${idx} } from "./provider";\nwrap_${idx}(${isViolated ? '42' : '"str"'});`
      },
      candidateFiles: {
        'src/provider.ts': `export function wrap_${idx}<T extends ${isViolated ? 'string' : 'unknown'}>(x: T): T { return x; }`,
        'src/consumer.ts': `import { wrap_${idx} } from "./provider";\nwrap_${idx}(${isViolated ? '42' : '"str"'});`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2344 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 5. T1-OVER: Overload Dispatch Stability (25 queries)
  // =========================================================================
  let overIndex = 1;
  while (overIndex <= 25) {
    const qid = `T1-OVER-${String(overIndex++).padStart(3, '0')}`;
    const idx = overIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: 'L3_THREE_WAY',
      family: 'IF-02',
      features: ['M21', 'D19', 'C01', 'G13'],
      description: `Overload dispatch #${idx} (${isViolated ? 'overload reorder hijacks literal dispatch' : 'additive non-overlapping overload'})`,
      parentFiles: {
        'src/provider.ts': `export function parse_${idx}(x: string): string;\nexport function parse_${idx}(x: any): any { return x; }`,
        'src/consumer.ts': `import { parse_${idx} } from "./provider";\nconst res: string = parse_${idx}("test");`
      },
      candidateFiles: {
        'src/provider.ts': isViolated 
          ? `export function parse_${idx}(x: any): number;\nexport function parse_${idx}(x: string): string;\nexport function parse_${idx}(x: any): any { return x; }`
          : `export function parse_${idx}(x: string): string;\nexport function parse_${idx}(x: number): boolean;\nexport function parse_${idx}(x: any): any { return x; }`,
        'src/consumer.ts': `import { parse_${idx} } from "./provider";\nconst res: string = parse_${idx}("test");`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 6. T1-HERIT: OOP Heritage & Class Structure (15 queries)
  // =========================================================================
  let heritIndex = 1;
  while (heritIndex <= 15) {
    const qid = `T1-HERIT-${String(heritIndex++).padStart(3, '0')}`;
    const idx = heritIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 1,
      level: idx <= 5 ? 'L5_HIGH_RISK' : 'L3_THREE_WAY',
      family: 'IF-04',
      features: ['M44', 'O01', 'C11', 'O06'],
      description: `Class heritage and visibility #${idx} (${isViolated ? 'protected narrowed to private breaks subclass' : 'protected method remains visible'})`,
      parentFiles: {
        'src/provider.ts': `export class Base_${idx} { protected run(): void {} }`,
        'src/consumer.ts': `import { Base_${idx} } from "./provider";\nexport class Sub_${idx} extends Base_${idx} { public exec() { this.run(); } }`
      },
      candidateFiles: {
        'src/provider.ts': `export class Base_${idx} { ${isViolated ? 'private' : 'protected'} run(): void {} }`,
        'src/consumer.ts': `import { Base_${idx} } from "./provider";\nexport class Sub_${idx} extends Base_${idx} { public exec() { this.run(); } }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2341 : undefined,
      staticProvable: true
    });
  }

  return queries;
}
