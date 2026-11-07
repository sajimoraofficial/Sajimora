/**
 * @file coverage_tier4_queries.ts
 * Tier 4: Framework & Modern TS (90 queries)
 * Covers: T4-JSX (40), T4-ASYNC (25), T4-CALLBACK (15), T4-ENUM (10)
 */

import { CoverageQuery } from './coverage_types';

export function getTier4Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T4-JSX: React & TSX Components (40 queries)
  // =========================================================================
  let jsxIndex = 1;
  while (jsxIndex <= 40) {
    const qid = `T4-JSX-${String(jsxIndex++).padStart(3, '0')}`;
    const idx = jsxIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 4,
      level: 'L3_THREE_WAY',
      family: 'IF-08',
      features: [isViolated ? 'M74' : 'M73', 'D36', 'C20', 'X01'],
      description: `React JSX component prop contract #${idx} (${isViolated ? 'added required prop breaks JSX call' : 'optional prop added preserves JSX call'})`,
      parentFiles: {
        'src/Button.tsx': `export interface ButtonProps { label: string; } export function Button(props: ButtonProps) { return null; }`,
        'src/App.tsx': `import { Button } from "./Button"; export function App() { return <Button label="Click" />; }`
      },
      candidateFiles: {
        'src/Button.tsx': `export interface ButtonProps { label: string; ${isViolated ? 'onClick: () => void;' : 'disabled?: boolean;'} } export function Button(props: ButtonProps) { return null; }`,
        'src/App.tsx': `import { Button } from "./Button"; export function App() { return <Button label="Click" />; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2741 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 2. T4-ASYNC: Promises & Async/Await Flow (25 queries)
  // =========================================================================
  let asyncIndex = 1;
  while (asyncIndex <= 25) {
    const qid = `T4-ASYNC-${String(asyncIndex++).padStart(3, '0')}`;
    const idx = asyncIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 4,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M02', 'D01', 'C01', 'A01'],
      description: `Async function return contract #${idx} (${isViolated ? 'resolved Promise payload narrowed/changed' : 'Promise payload widened safely'})`,
      parentFiles: {
        'src/provider.ts': `export async function loadData_${idx}(): Promise<{ code: number }> { return { code: 200 }; }`,
        'src/consumer.ts': `import { loadData_${idx} } from "./provider";\nasync function test() { const res = await loadData_${idx}(); const n: number = res.code; }`
      },
      candidateFiles: {
        'src/provider.ts': `export async function loadData_${idx}(): Promise<{ code: ${isViolated ? 'string' : 'number'} }> { return { code: ${isViolated ? '"200"' : '200'} }; }`,
        'src/consumer.ts': `import { loadData_${idx} } from "./provider";\nasync function test() { const res = await loadData_${idx}(); const n: number = res.code; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 3. T4-CALLBACK: Callback Signatures & Event Patterns (15 queries)
  // =========================================================================
  let cbIndex = 1;
  while (cbIndex <= 15) {
    const qid = `T4-CB-${String(cbIndex++).padStart(3, '0')}`;
    const idx = cbIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 4,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M01', 'D01', 'C14', 'A03'],
      description: `Callback parameter position #${idx} (${isViolated ? 'callback expected argument type changed' : 'callback optional param'})`,
      parentFiles: {
        'src/provider.ts': `export function onMessage_${idx}(handler: (msg: string) => void): void {}`,
        'src/consumer.ts': `import { onMessage_${idx} } from "./provider";\nonMessage_${idx}((m: string) => console.log(m.toUpperCase()));`
      },
      candidateFiles: {
        'src/provider.ts': `export function onMessage_${idx}(handler: (msg: ${isViolated ? 'number' : 'string'}) => void): void {}`,
        'src/consumer.ts': `import { onMessage_${idx} } from "./provider";\nonMessage_${idx}((m: string) => console.log(m.toUpperCase()));`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 4. T4-ENUM: Enums & Literal Sets (10 queries)
  // =========================================================================
  let enumIndex = 1;
  while (enumIndex <= 10) {
    const qid = `T4-ENUM-${String(enumIndex++).padStart(3, '0')}`;
    const idx = enumIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 4,
      level: 'L2_PAIRWISE',
      family: 'IF-01',
      features: [isViolated ? 'M48' : 'M47', 'D08', 'C33'],
      description: `Enum member mutation #${idx} (${isViolated ? 'removed enum member breaks reference' : 'added enum member preserved'})`,
      parentFiles: {
        'src/provider.ts': `export enum Status_${idx} { Active = "ACTIVE", Pending = "PENDING" }`,
        'src/consumer.ts': `import { Status_${idx} } from "./provider";\nconst s = Status_${idx}.Pending;`
      },
      candidateFiles: {
        'src/provider.ts': isViolated 
          ? `export enum Status_${idx} { Active = "ACTIVE" }`
          : `export enum Status_${idx} { Active = "ACTIVE", Pending = "PENDING", Closed = "CLOSED" }`,
        'src/consumer.ts': `import { Status_${idx} } from "./provider";\nconst s = Status_${idx}.Pending;`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  return queries;
}
