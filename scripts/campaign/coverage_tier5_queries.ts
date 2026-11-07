/**
 * @file coverage_tier5_queries.ts
 * Tier 5: Behavioral & Dynamic Boundaries (70 queries)
 * Covers: T5-BODY (25), T5-DYN (25), T5-AMBIENT (10), T5-MERGE (10)
 */

import { CoverageQuery } from './coverage_types';

export function getTier5Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T5-BODY: Behavioral Mutations & Closures (25 queries)
  // =========================================================================
  let bodyIndex = 1;
  while (bodyIndex <= 25) {
    const qid = `T5-BODY-${String(bodyIndex++).padStart(3, '0')}`;
    const idx = bodyIndex;
    const isShorthandTrap = idx % 3 === 0;
    const isScalarChange = idx % 3 === 1;

    if (isShorthandTrap) {
      queries.push({
        id: qid,
        tier: 5,
        level: 'L5_HIGH_RISK',
        family: 'IF-09',
        features: ['M62', 'M63', 'C15', 'T04'],
        description: `Body change with shorthand property rename trap #${idx}`,
        parentFiles: {
          'src/provider.ts': `export function compute_${idx}() { const result = 42; return { result }; }`,
          'src/consumer.ts': `import { compute_${idx} } from "./provider";\nconst { result } = compute_${idx}();\nconsole.log(result);`
        },
        candidateFiles: {
          'src/provider.ts': `export function compute_${idx}() { const output = 42; return { output }; }`,
          'src/consumer.ts': `import { compute_${idx} } from "./provider";\nconst { result } = compute_${idx}();\nconsole.log(result);`
        },
        expectedVerdict: 'VIOLATED',
        staticProvable: false
      });
    } else if (isScalarChange) {
      queries.push({
        id: qid,
        tier: 5,
        level: 'L2_PAIRWISE',
        family: 'IF-09',
        features: ['M62', 'D01', 'C01'],
        description: `Scalar arithmetic mutation in body #${idx}`,
        parentFiles: {
          'src/provider.ts': `export function calc_${idx}(x: number): number { return x * 2; }`,
          'src/consumer.ts': `import { calc_${idx} } from "./provider";\nconst val = calc_${idx}(5);`
        },
        candidateFiles: {
          'src/provider.ts': `export function calc_${idx}(x: number): number { return x * 3; }`,
          'src/consumer.ts': `import { calc_${idx} } from "./provider";\nconst val = calc_${idx}(5);`
        },
        expectedVerdict: 'VIOLATED',
        staticProvable: false
      });
    } else {
      queries.push({
        id: qid,
        tier: 5,
        level: 'L1_SINGLE',
        family: 'IF-09',
        features: ['M62', 'D01', 'C01'],
        description: `Alpha-equivalent variable rename in body #${idx}`,
        parentFiles: {
          'src/provider.ts': `export function id_${idx}(x: number): number { const a = x; return a; }`,
          'src/consumer.ts': `import { id_${idx} } from "./provider";\nconst val = id_${idx}(5);`
        },
        candidateFiles: {
          'src/provider.ts': `export function id_${idx}(x: number): number { const b = x; return b; }`,
          'src/consumer.ts': `import { id_${idx} } from "./provider";\nconst val = id_${idx}(5);`
        },
        expectedVerdict: 'PRESERVED',
        staticProvable: false
      });
    }
  }

  // =========================================================================
  // 2. T5-DYN: Dynamic & Unresolved Boundaries (25 queries)
  // =========================================================================
  let dynIndex = 1;
  while (dynIndex <= 25) {
    const qid = `T5-DYN-${String(dynIndex++).padStart(3, '0')}`;
    const idx = dynIndex;
    const isVariableImport = idx % 2 === 0;

    queries.push({
      id: qid,
      tier: 5,
      level: 'L1_SINGLE',
      family: 'IF-07',
      features: ['B01', 'R09', 'C01'],
      description: `Dynamic boundary #${idx} (${isVariableImport ? 'variable import path returns UNKNOWN' : 'eval invocation'})`,
      parentFiles: {
        'src/provider.ts': `export function helper_${idx}() { return "active"; }`,
        'src/consumer.ts': isVariableImport
          ? `declare function getPath(): string;\nasync function run() { const mod = await import(getPath()); mod.helper_${idx}(); }`
          : `import { helper_${idx} } from "./provider";\neval("helper_${idx}()");`
      },
      candidateFiles: {
        'src/provider.ts': `export function helper_${idx}() { return "modified"; }`,
        'src/consumer.ts': isVariableImport
          ? `declare function getPath(): string;\nasync function run() { const mod = await import(getPath()); mod.helper_${idx}(); }`
          : `import { helper_${idx} } from "./provider";\neval("helper_${idx}()");`
      },
      expectedVerdict: 'UNKNOWN',
      staticProvable: false
    });
  }

  // =========================================================================
  // 3. T5-AMBIENT: Ambient Declarations & .d.ts Divergence (10 queries)
  // =========================================================================
  let ambIndex = 1;
  while (ambIndex <= 10) {
    const qid = `T5-AMBIENT-${String(ambIndex++).padStart(3, '0')}`;
    const idx = ambIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 5,
      level: 'L2_PAIRWISE',
      family: 'IF-01',
      features: ['E01', 'D35', 'R01'],
      description: `Ambient declaration file divergence #${idx} (${isViolated ? 'ambient d.ts signature narrowed' : 'ambient d.ts signature widened'})`,
      parentFiles: {
        'src/provider.d.ts': `export declare function ext_${idx}(val: ${isViolated ? 'string | number' : 'number'}): void;`,
        'src/consumer.ts': `import { ext_${idx} } from "./provider";\next_${idx}(42);`
      },
      candidateFiles: {
        'src/provider.d.ts': `export declare function ext_${idx}(val: ${isViolated ? 'string' : 'number | string'}): void;`,
        'src/consumer.ts': `import { ext_${idx} } from "./provider";\next_${idx}(42);`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 4. T5-MERGE: Declaration Merging (10 queries)
  // =========================================================================
  let mergeIndex = 1;
  while (mergeIndex <= 10) {
    const qid = `T5-MERGE-${String(mergeIndex++).padStart(3, '0')}`;
    const idx = mergeIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 5,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M61', 'D21', 'D06', 'C04'],
      description: `Declaration merging contract #${idx} (${isViolated ? 'second merged block removed required property' : 'merged block preserves additions'})`,
      parentFiles: {
        'src/provider.ts': `export interface Merged_${idx} { a: string; }\nexport interface Merged_${idx} { b: number; }`,
        'src/consumer.ts': `import { Merged_${idx} } from "./provider";\nfunction read(m: Merged_${idx}) { return ${isViolated ? 'm.b' : 'm.a'}; }`
      },
      candidateFiles: {
        'src/provider.ts': isViolated 
          ? `export interface Merged_${idx} { a: string; }`
          : `export interface Merged_${idx} { a: string; }\nexport interface Merged_${idx} { b: number; c?: boolean; }`,
        'src/consumer.ts': `import { Merged_${idx} } from "./provider";\nfunction read(m: Merged_${idx}) { return ${isViolated ? 'm.b' : 'm.a'}; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  return queries;
}
