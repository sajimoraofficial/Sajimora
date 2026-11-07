/**
 * @file coverage_tier2_queries.ts
 * Tier 2: Resolution & Topology (225 queries)
 * Covers: T2-BARREL (80), T2-ALIAS (50), T2-WKSP (35), T2-PROJREF (20), T2-EXPORTS (25), T2-ENV (15)
 */

import { CoverageQuery } from './coverage_types';

export function getTier2Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T2-BARREL: Re-exports & Barrels (80 queries)
  // =========================================================================
  let barrelIndex = 1;

  // Star re-exports & named re-exports through barrels
  for (let i = 1; i <= 30; i++) {
    const qid = `T2-BARREL-${String(barrelIndex++).padStart(3, '0')}`;
    const isViolated = i % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L2_PAIRWISE',
      family: 'IF-01',
      features: ['M01', 'D01', 'R13', 'P06'],
      description: `Barrel star re-export #${i} (${isViolated ? 'narrowed parameter breaks call through barrel' : 'widened parameter preserves call through barrel'})`,
      parentFiles: {
        'src/provider.ts': `export function compute_${i}(x: ${isViolated ? 'number | string' : 'number'}): void {}`,
        'src/index.ts': `export * from "./provider";`,
        'src/consumer.ts': `import { compute_${i} } from "./index";\ncompute_${i}(42);`
      },
      candidateFiles: {
        'src/provider.ts': `export function compute_${i}(x: ${isViolated ? 'string' : 'number | string'}): void {}`,
        'src/index.ts': `export * from "./provider";`,
        'src/consumer.ts': `import { compute_${i} } from "./index";\ncompute_${i}(42);`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // Renamed re-exports (`export { a as b }`) and deep barrel pipelines (3 levels)
  for (let i = 1; i <= 25; i++) {
    const qid = `T2-BARREL-${String(barrelIndex++).padStart(3, '0')}`;
    const isViolated = i % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M02', 'D01', 'R12', 'R15'],
      description: `Deep 3-tier barrel pipeline #${i} (${isViolated ? 'removed return field breaks deep consumer' : 'compatible return preserves deep consumer'})`,
      parentFiles: {
        'src/internal/core.ts': `export function getService_${i}(): { id: string; ${isViolated ? 'active: boolean;' : ''} } { return { id: "s", active: true }; }`,
        'src/internal/index.ts': `export { getService_${i} as resolveService_${i} } from "./core";`,
        'src/public/index.ts': `export * from "../internal/index";`,
        'src/consumer.ts': `import { resolveService_${i} } from "./public/index";\nconst s = resolveService_${i}();\nconsole.log(${isViolated ? 's.active' : 's.id'});`
      },
      candidateFiles: {
        'src/internal/core.ts': `export function getService_${i}(): { id: string; } { return { id: "s" }; }`,
        'src/internal/index.ts': `export { getService_${i} as resolveService_${i} } from "./core";`,
        'src/public/index.ts': `export * from "../internal/index";`,
        'src/consumer.ts': `import { resolveService_${i} } from "./public/index";\nconst s = resolveService_${i}();\nconsole.log(${isViolated ? 's.active' : 's.id'});`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  // Diamond re-exports and collision handling
  while (barrelIndex <= 80) {
    const qid = `T2-BARREL-${String(barrelIndex++).padStart(3, '0')}`;
    const idx = barrelIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L4_FOUR_WAY',
      family: 'IF-01',
      features: ['M26', 'D06', 'R14', 'F06'],
      description: `Diamond re-export graph #${idx} (${isViolated ? 'incompatible member via multiple barrels' : 'symmetric diamond preservation'})`,
      parentFiles: {
        'src/leaf.ts': `export interface Config_${idx} { port: number; }`,
        'src/branchA.ts': `export * from "./leaf";`,
        'src/branchB.ts': `export * from "./leaf";`,
        'src/consumer.ts': `import { Config_${idx} as C1 } from "./branchA";\nimport { Config_${idx} as C2 } from "./branchB";\nconst c: C1 = { port: 3000 };\nconst c2: C2 = c;`
      },
      candidateFiles: {
        'src/leaf.ts': `export interface Config_${idx} { port: ${isViolated ? 'string' : 'number'}; }`,
        'src/branchA.ts': `export * from "./leaf";`,
        'src/branchB.ts': `export * from "./leaf";`,
        'src/consumer.ts': `import { Config_${idx} as C1 } from "./branchA";\nimport { Config_${idx} as C2 } from "./branchB";\nconst c: C1 = { port: ${isViolated ? '3000' : '3000'} };\nconst c2: C2 = c;`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 2. T2-ALIAS: Path Aliases & TSConfig Paths (50 queries)
  // =========================================================================
  let aliasIndex = 1;
  while (aliasIndex <= 50) {
    const qid = `T2-ALIAS-${String(aliasIndex++).padStart(3, '0')}`;
    const idx = aliasIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L2_PAIRWISE',
      family: 'IF-01',
      features: ['M01', 'D01', 'R18', 'P02'],
      description: `TSConfig path mapping alias #${idx} (${isViolated ? 'breaking parameter change via @core/*' : 'safe widening via @core/*'})`,
      parentFiles: {
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@core/*': ['./src/core/*'] } } }),
        'src/core/helper.ts': `export function helper_${idx}(val: ${isViolated ? 'string | number' : 'number'}): void {}`,
        'src/app/main.ts': `import { helper_${idx} } from "@core/helper";\nhelper_${idx}(42);`
      },
      candidateFiles: {
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@core/*': ['./src/core/*'] } } }),
        'src/core/helper.ts': `export function helper_${idx}(val: ${isViolated ? 'string' : 'number | string'}): void {}`,
        'src/app/main.ts': `import { helper_${idx} } from "@core/helper";\nhelper_${idx}(42);`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 3. T2-WKSP: Monorepo Workspaces & Cross-Package (35 queries)
  // =========================================================================
  let wkspIndex = 1;
  while (wkspIndex <= 35) {
    const qid = `T2-WKSP-${String(wkspIndex++).padStart(3, '0')}`;
    const idx = wkspIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M03', 'D01', 'W02', 'R01'],
      description: `Cross-workspace package dependency #${idx} (${isViolated ? 'added required param breaks consumer package' : 'added optional param preserves consumer package'})`,
      parentFiles: {
        'packages/pkg-a/package.json': JSON.stringify({ name: '@monorepo/pkg-a', version: '1.0.0' }),
        'packages/pkg-a/src/index.ts': `export function initPkg_${idx}(name: string): void {}`,
        'packages/pkg-b/package.json': JSON.stringify({ name: '@monorepo/pkg-b', version: '1.0.0', dependencies: { '@monorepo/pkg-a': '*' } }),
        'packages/pkg-b/src/main.ts': `import { initPkg_${idx} } from "@monorepo/pkg-a";\ninitPkg_${idx}("test");`
      },
      candidateFiles: {
        'packages/pkg-a/package.json': JSON.stringify({ name: '@monorepo/pkg-a', version: '1.0.0' }),
        'packages/pkg-a/src/index.ts': `export function initPkg_${idx}(name: string${isViolated ? ', version: number' : ', version?: number'}): void {}`,
        'packages/pkg-b/package.json': JSON.stringify({ name: '@monorepo/pkg-b', version: '1.0.0', dependencies: { '@monorepo/pkg-a': '*' } }),
        'packages/pkg-b/src/main.ts': `import { initPkg_${idx} } from "@monorepo/pkg-a";\ninitPkg_${idx}("test");`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2554 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 4. T2-PROJREF: Project References & Composite Builds (20 queries)
  // =========================================================================
  let projRefIndex = 1;
  while (projRefIndex <= 20) {
    const qid = `T2-PROJREF-${String(projRefIndex++).padStart(3, '0')}`;
    const idx = projRefIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['M28', 'D06', 'W03', 'W04'],
      description: `Project references composite build #${idx} (${isViolated ? 'removed interface property across project boundary' : 'preserved interface across project boundary'})`,
      parentFiles: {
        'packages/shared/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, declaration: true } }),
        'packages/shared/src/index.ts': `export interface SharedData_${idx} { id: string; ${isViolated ? 'value: number;' : ''} }`,
        'packages/service/tsconfig.json': JSON.stringify({ references: [{ path: '../shared' }] }),
        'packages/service/src/consumer.ts': `import { SharedData_${idx} } from "../../shared/src";\nfunction read(d: SharedData_${idx}) { return ${isViolated ? 'd.value' : 'd.id'}; }`
      },
      candidateFiles: {
        'packages/shared/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, declaration: true } }),
        'packages/shared/src/index.ts': `export interface SharedData_${idx} { id: string; }`,
        'packages/service/tsconfig.json': JSON.stringify({ references: [{ path: '../shared' }] }),
        'packages/service/src/consumer.ts': `import { SharedData_${idx} } from "../../shared/src";\nfunction read(d: SharedData_${idx}) { return ${isViolated ? 'd.value' : 'd.id'}; }`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 5. T2-EXPORTS: Package Manifest & Conditional Exports (25 queries)
  // =========================================================================
  let expIndex = 1;
  while (expIndex <= 25) {
    const qid = `T2-EXPORTS-${String(expIndex++).padStart(3, '0')}`;
    const idx = expIndex;
    const isViolated = idx % 2 === 0;
    queries.push({
      id: qid,
      tier: 2,
      level: 'L4_FOUR_WAY',
      family: 'IF-01',
      features: ['M71', 'R20', 'R21', 'W07'],
      description: `Package.json exports map subpath resolution #${idx} (${isViolated ? 'removed subpath exports entry breaks consumer' : 'retained valid subpath export'})`,
      parentFiles: {
        'packages/lib/package.json': JSON.stringify({
          name: `@lib/core-${idx}`,
          exports: {
            './feature': './src/feature.ts',
            './utils': './src/utils.ts'
          }
        }),
        'packages/lib/src/feature.ts': `export function doFeature_${idx}(): void {}`,
        'packages/app/src/main.ts': `import { doFeature_${idx} } from "@lib/core-${idx}/feature";\ndoFeature_${idx}();`
      },
      candidateFiles: {
        'packages/lib/package.json': JSON.stringify({
          name: `@lib/core-${idx}`,
          exports: isViolated ? { './utils': './src/utils.ts' } : { './feature': './src/feature.ts', './utils': './src/utils.ts' }
        }),
        'packages/lib/src/feature.ts': `export function doFeature_${idx}(): void {}`,
        'packages/app/src/main.ts': `import { doFeature_${idx} } from "@lib/core-${idx}/feature";\ndoFeature_${idx}();`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2307 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 6. T2-ENV: File Structure & Topology Lifecycle (15 queries)
  // =========================================================================
  let envIndex = 1;
  const envLifecycleCases = [
    { m: 'M64', desc: 'exported entity deleted', p: 'export function target() {}; export const stay = 1;', c: 'export const stay = 1;', use: 'import { target } from "./provider";\ntarget();', v: 'VIOLATED' as const, err: 2305 },
    { m: 'M65', desc: 'new exported entity added (safe)', p: 'export const a = 1;', c: 'export const a = 1;\nexport const b = 2;', use: 'import { a } from "./provider";\nconsole.log(a);', v: 'NOT_APPLICABLE' as const },
    { m: 'M66', desc: 'entity renamed', p: 'export const oldName = 100;', c: 'export const newName = 100;', use: 'import { oldName } from "./provider";\nconsole.log(oldName);', v: 'VIOLATED' as const, err: 2305 },
    { m: 'M67', desc: 'declaration moved to another file with re-export', p: 'export const item = "hello";', c: 'export { item } from "./other";', extraC: { 'src/other.ts': 'export const item = "hello";' }, use: 'import { item } from "./provider";\nconsole.log(item);', v: 'PRESERVED' as const },
    { m: 'M68', desc: 'entire source file deleted', p: 'export const f = 1;', c: '', deletedFile: true, use: 'import { f } from "./provider";\nconsole.log(f);', v: 'VIOLATED' as const, err: 2307 }
  ];

  for (const elc of envLifecycleCases) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const qid = `T2-ENV-${String(envIndex++).padStart(3, '0')}`;
      const parentFiles: Record<string, string> = {
        'src/provider.ts': elc.p,
        'src/consumer.ts': elc.use
      };
      const candidateFiles: Record<string, string> = {
        'src/consumer.ts': elc.use
      };
      if (!elc.deletedFile) {
        candidateFiles['src/provider.ts'] = elc.c;
      }
      if (elc.extraC) {
        Object.assign(candidateFiles, elc.extraC);
      }

      queries.push({
        id: qid,
        tier: 2,
        level: 'L2_PAIRWISE',
        family: 'IF-01',
        features: [elc.m, 'D01', 'C01', 'R01'],
        description: `Lifecycle event (${elc.desc}) #${repeat}`,
        parentFiles,
        candidateFiles,
        expectedVerdict: elc.v,
        expectedTsError: elc.err,
        staticProvable: true
      });
    }
  }

  return queries;
}
