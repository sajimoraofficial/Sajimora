/**
 * @file coverage_tier3_queries.ts
 * Tier 3: Type System Depth (125 queries)
 * Covers: T3-COND (30), T3-MAPPED (25), T3-UTIL (25), T3-UNION (25), T3-TUPLE (10), T3-TMPLIT (10)
 */

import { CoverageQuery } from './coverage_types';

export function getTier3Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T3-COND: Conditional Types & Inference (30 queries)
  // =========================================================================
  let condIndex = 1;
  while (condIndex <= 30) {
    const qid = `T3-COND-${String(condIndex++).padStart(3, '0')}`;
    const idx = condIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 3,
      level: 'L3_THREE_WAY',
      family: 'IF-06',
      features: ['M52', 'D30', 'C09', 'T06'],
      description: `Conditional type resolution #${idx} (${isViolated ? 'conditional true branch flipped to incompatible type' : 'conditional type preserved'})`,
      parentFiles: {
        'src/provider.ts': `export type IsNumber_${idx}<T> = T extends number ? { val: number } : { val: string };`,
        'src/consumer.ts': `import { IsNumber_${idx} } from "./provider";\nconst x: IsNumber_${idx}<42> = { val: 42 };`
      },
      candidateFiles: {
        'src/provider.ts': `export type IsNumber_${idx}<T> = T extends number ? { val: ${isViolated ? 'boolean' : 'number'} } : { val: string };`,
        'src/consumer.ts': `import { IsNumber_${idx} } from "./provider";\nconst x: IsNumber_${idx}<42> = { val: 42 };`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 2. T3-MAPPED: Mapped Types & Key Modifiers (25 queries)
  // =========================================================================
  let mappedIndex = 1;
  while (mappedIndex <= 25) {
    const qid = `T3-MAPPED-${String(mappedIndex++).padStart(3, '0')}`;
    const idx = mappedIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 3,
      level: 'L3_THREE_WAY',
      family: 'IF-06',
      features: ['M51', 'D31', 'C05', 'T07'],
      description: `Mapped type modifier change #${idx} (${isViolated ? 'added readonly modifier prevents property assignment' : 'retained mutable property'})`,
      parentFiles: {
        'src/provider.ts': `export type MutObj_${idx}<T> = { [K in keyof T]: T[K] };`,
        'src/consumer.ts': `import { MutObj_${idx} } from "./provider";\nconst o: MutObj_${idx}<{ count: number }> = { count: 1 };\no.count = 2;`
      },
      candidateFiles: {
        'src/provider.ts': `export type MutObj_${idx}<T> = { ${isViolated ? 'readonly ' : ''}[K in keyof T]: T[K] };`,
        'src/consumer.ts': `import { MutObj_${idx} } from "./provider";\nconst o: MutObj_${idx}<{ count: number }> = { count: 1 };\no.count = 2;`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2540 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 3. T3-UTIL: Built-in Utility Types (25 queries)
  // =========================================================================
  let utilIndex = 1;
  const utilities = ['Partial', 'Required', 'Readonly', 'Pick', 'Omit'] as const;
  for (const u of utilities) {
    for (let i = 1; i <= 5; i++) {
      const qid = `T3-UTIL-${String(utilIndex++).padStart(3, '0')}`;
      const isViolated = i % 2 === 0;
      queries.push({
        id: qid,
        tier: 3,
        level: 'L3_THREE_WAY',
        family: 'IF-06',
        features: ['M26', 'D06', 'C09', 'T11'],
        description: `Utility type ${u} composition #${i} (${isViolated ? 'underlying type modification breaks utility consumer' : 'compatible utility structure'})`,
        parentFiles: {
          'src/provider.ts': `export interface Source_${utilIndex} { id: string; name${u === 'Required' ? '?' : ''}: string; }`,
          'src/consumer.ts': `import { Source_${utilIndex} } from "./provider";\ntype Target = ${u}<Source_${utilIndex}${u === 'Pick' ? ', "id"' : u === 'Omit' ? ', "name"' : ''}>;\nconst t: Target = { id: "1"${u === 'Required' ? ', name: "n"' : ''} };`
        },
        candidateFiles: {
          'src/provider.ts': `export interface Source_${utilIndex} { id: ${isViolated ? 'number' : 'string'}; name${u === 'Required' ? '?' : ''}: string; }`,
          'src/consumer.ts': `import { Source_${utilIndex} } from "./provider";\ntype Target = ${u}<Source_${utilIndex}${u === 'Pick' ? ', "id"' : u === 'Omit' ? ', "name"' : ''}>;\nconst t: Target = { id: ${isViolated ? '"1"' : '"1"'}${u === 'Required' ? ', name: "n"' : ''} };`
        },
        expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
        expectedTsError: isViolated ? 2322 : undefined,
        staticProvable: true
      });
    }
  }

  // =========================================================================
  // 4. T3-UNION: Union & Intersection Mutations (25 queries)
  // =========================================================================
  let unionIndex = 1;
  while (unionIndex <= 25) {
    const qid = `T3-UNION-${String(unionIndex++).padStart(3, '0')}`;
    const idx = unionIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 3,
      level: 'L2_PAIRWISE',
      family: 'IF-06',
      features: [isViolated ? 'M55' : 'M54', 'D07', 'C30', 'T02'],
      description: `Discriminated union change #${idx} (${isViolated ? 'removed union variant breaks consumer switch' : 'added variant with open consumer'})`,
      parentFiles: {
        'src/provider.ts': `export type Action_${idx} = { type: "ADD"; amount: number } | { type: "RESET" };`,
        'src/consumer.ts': `import { Action_${idx} } from "./provider";\nfunction handle(a: Action_${idx}) { if (a.type === "RESET") { return 0; } return a.amount; }`
      },
      candidateFiles: {
        'src/provider.ts': isViolated 
          ? `export type Action_${idx} = { type: "ADD"; amount: number };`
          : `export type Action_${idx} = { type: "ADD"; amount: number } | { type: "RESET" } | { type: "NOOP" };`,
        'src/consumer.ts': `import { Action_${idx} } from "./provider";\nfunction handle(a: Action_${idx}) { if (a.type === "RESET") { return 0; } return a.amount; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2367 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 5. T3-TUPLE: Tuple Mutations & Variadics (10 queries)
  // =========================================================================
  let tupleIndex = 1;
  while (tupleIndex <= 10) {
    const qid = `T3-TUPLE-${String(tupleIndex++).padStart(3, '0')}`;
    const idx = tupleIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 3,
      level: 'L3_THREE_WAY',
      family: 'IF-06',
      features: [isViolated ? 'M58' : 'M57', 'D37', 'C38', 'T37'],
      description: `Tuple mutation #${idx} (${isViolated ? 'element removed causes out-of-bounds destructuring' : 'element added preserves prefix'})`,
      parentFiles: {
        'src/provider.ts': `export type Coords_${idx} = [number, number];`,
        'src/consumer.ts': `import { Coords_${idx} } from "./provider";\nfunction render(c: Coords_${idx}) { const [x, y] = c; return x + y; }`
      },
      candidateFiles: {
        'src/provider.ts': `export type Coords_${idx} = [number${isViolated ? '' : ', number, number'}];`,
        'src/consumer.ts': `import { Coords_${idx} } from "./provider";\nfunction render(c: Coords_${idx}) { const [x, y] = c; return x + y; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2493 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 6. T3-TMPLIT: Template Literal Types (10 queries)
  // =========================================================================
  let tmplitIndex = 1;
  while (tmplitIndex <= 10) {
    const qid = `T3-TMPLIT-${String(tmplitIndex++).padStart(3, '0')}`;
    const idx = tmplitIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 3,
      level: 'L3_THREE_WAY',
      family: 'IF-06',
      features: ['M53', 'D32', 'C09', 'T32'],
      description: `Template literal type pattern #${idx} (${isViolated ? 'pattern prefix change rejects old strings' : 'pattern widening preserves old strings'})`,
      parentFiles: {
        'src/provider.ts': 'export type EventName_' + idx + ' = `on:${string}`;',
        'src/consumer.ts': 'import { EventName_' + idx + ' } from "./provider";\nconst ev: EventName_' + idx + ' = "on:click";'
      },
      candidateFiles: {
        'src/provider.ts': 'export type EventName_' + idx + ' = `' + (isViolated ? 'handle:' : 'on:') + '${string}`;',
        'src/consumer.ts': 'import { EventName_' + idx + ' } from "./provider";\nconst ev: EventName_' + idx + ' = "on:click";'
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  return queries;
}
