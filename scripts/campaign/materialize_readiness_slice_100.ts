import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as ts from 'typescript';

export interface SliceCaseFixture {
  caseId: string;
  category: string;
  description: string;
  target: { file: string; symbol: string };
  expectedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN';
  parent: {
    commitSha: string;
    tsconfigPath?: string;
    files: Record<string, string>;
  };
  candidate: {
    commitSha: string;
    tsconfigPath?: string;
    files: Record<string, string>;
  };
}

export interface Slice100Manifest {
  schemaVersion: 'TYPESCRIPT_READINESS_100_SLICE_V1';
  totalCases: number;
  distribution: {
    PRESERVED: number;
    VIOLATED: number;
    UNKNOWN: number;
  };
  generatedAt: string;
  cases: SliceCaseFixture[];
}

function buildCase(
  caseId: string,
  category: string,
  description: string,
  target: { file: string; symbol: string },
  expectedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN',
  parentFiles: Record<string, string>,
  candidateFiles: Record<string, string>,
  tsconfigPath?: string
): SliceCaseFixture {
  return {
    caseId,
    category,
    description,
    target,
    expectedVerdict,
    parent: {
      commitSha: `${caseId}-parent`,
      tsconfigPath,
      files: parentFiles
    },
    candidate: {
      commitSha: `${caseId}-candidate`,
      tsconfigPath,
      files: candidateFiles
    }
  };
}

export function generate100Slice(): Slice100Manifest {
  const cases: SliceCaseFixture[] = [];
  let index = 1;
  const id = () => `TSR-SL-${String(index++).padStart(3, '0')}`;

  // -------------------------------------------------------------
  // Section A: Module / Import Resolution (10 cases)
  // -------------------------------------------------------------
  // 1. A1 Relative named import - preserved
  cases.push(buildCase(
    id(), 'A1', 'Relative named import function widening',
    { file: 'provider.ts', symbol: 'greet' }, 'PRESERVED',
    { 'provider.ts': 'export function greet(name: string): string { return "Hello " + name; }', 'consumer.ts': 'import { greet } from "./provider"; export const msg = greet("Alice");' },
    { 'provider.ts': 'export function greet(name: string, title?: string): string { return "Hello " + (title ? title + " " : "") + name; }', 'consumer.ts': 'import { greet } from "./provider"; export const msg = greet("Alice");' }
  ));

  // 2. A1 Relative named import - violated
  cases.push(buildCase(
    id(), 'A1', 'Relative named import parameter removal breaks argument',
    { file: 'provider.ts', symbol: 'sum' }, 'VIOLATED',
    { 'provider.ts': 'export function sum(a: number, b: number): number { return a + b; }', 'consumer.ts': 'import { sum } from "./provider"; export const total = sum(1, 2);' },
    { 'provider.ts': 'export function sum(a: number): number { return a; }', 'consumer.ts': 'import { sum } from "./provider"; export const total = sum(1, 2);' }
  ));

  // 3. A2 Extensionless directory import (/index.ts) - preserved
  cases.push(buildCase(
    id(), 'A2', 'Directory index import preserved',
    { file: 'math/index.ts', symbol: 'PI' }, 'PRESERVED',
    { 'math/index.ts': 'export const PI = 3.14;', 'consumer.ts': 'import { PI } from "./math"; export const piVal = PI;' },
    { 'math/index.ts': 'export const PI = 3.14159;', 'consumer.ts': 'import { PI } from "./math"; export const piVal = PI;' }
  ));

  // 4. A2 Directory index import - violated
  cases.push(buildCase(
    id(), 'A2', 'Directory index import type mismatch',
    { file: 'math/index.ts', symbol: 'PI' }, 'VIOLATED',
    { 'math/index.ts': 'export const PI: number = 3.14;', 'consumer.ts': 'import { PI } from "./math"; export const piVal: number = PI;' },
    { 'math/index.ts': 'export const PI: string = "3.14";', 'consumer.ts': 'import { PI } from "./math"; export const piVal: number = PI;' }
  ));

  // 5. A3 Default import - preserved
  cases.push(buildCase(
    id(), 'A3', 'Default import return widening preserved',
    { file: 'logger.ts', symbol: 'default' }, 'PRESERVED',
    { 'logger.ts': 'export default function log(m: string): void {}', 'consumer.ts': 'import log from "./logger"; log("test");' },
    { 'logger.ts': 'export default function log(m: string | number): void {}', 'consumer.ts': 'import log from "./logger"; log("test");' }
  ));

  // 6. A3 Default import - violated
  cases.push(buildCase(
    id(), 'A3', 'Default import converted to named export breaks default import',
    { file: 'logger.ts', symbol: 'default' }, 'VIOLATED',
    { 'logger.ts': 'export default function log(m: string): void {}', 'consumer.ts': 'import log from "./logger"; log("test");' },
    { 'logger.ts': 'export function log(m: string): void {}', 'consumer.ts': 'import log from "./logger"; log("test");' }
  ));

  // 7. A4 Namespace import (import * as M) - preserved
  cases.push(buildCase(
    id(), 'A4', 'Namespace import member access preserved',
    { file: 'api.ts', symbol: 'version' }, 'PRESERVED',
    { 'api.ts': 'export const version = "1.0"; export const ping = () => true;', 'consumer.ts': 'import * as Api from "./api"; export const v: string = Api.version;' },
    { 'api.ts': 'export const version = "1.1"; export const ping = () => true;', 'consumer.ts': 'import * as Api from "./api"; export const v: string = Api.version;' }
  ));

  // 8. A4 Namespace import - violated
  cases.push(buildCase(
    id(), 'A4', 'Namespace import member removal breaks access',
    { file: 'api.ts', symbol: 'ping' }, 'VIOLATED',
    { 'api.ts': 'export const version = "1.0"; export const ping = () => true;', 'consumer.ts': 'import * as Api from "./api"; export const ok: boolean = Api.ping();' },
    { 'api.ts': 'export const version = "1.0";', 'consumer.ts': 'import * as Api from "./api"; export const ok: boolean = Api.ping();' }
  ));

  // 9. A5 Type-only import (import type { T }) - preserved
  cases.push(buildCase(
    id(), 'A5', 'Type-only import widening preserved',
    { file: 'types.ts', symbol: 'Config' }, 'PRESERVED',
    { 'types.ts': 'export interface Config { port: number; }', 'consumer.ts': 'import type { Config } from "./types"; export const c: Config = { port: 8080 };' },
    { 'types.ts': 'export interface Config { port: number; host?: string; }', 'consumer.ts': 'import type { Config } from "./types"; export const c: Config = { port: 8080 };' }
  ));

  // 10. A5 Type-only import - violated
  cases.push(buildCase(
    id(), 'A5', 'Type-only import required property addition breaks consumer',
    { file: 'types.ts', symbol: 'Config' }, 'VIOLATED',
    { 'types.ts': 'export interface Config { port: number; }', 'consumer.ts': 'import type { Config } from "./types"; export const c: Config = { port: 8080 };' },
    { 'types.ts': 'export interface Config { port: number; host: string; }', 'consumer.ts': 'import type { Config } from "./types"; export const c: Config = { port: 8080 };' }
  ));

  // -------------------------------------------------------------
  // Section B: Re-exports and Barrels (10 cases)
  // -------------------------------------------------------------
  // 11. B1 Named re-export (export { x } from './b') - preserved
  cases.push(buildCase(
    id(), 'B1', 'Named re-export through barrel preserved',
    { file: 'source.ts', symbol: 'val' }, 'PRESERVED',
    { 'source.ts': 'export const val: number = 42;', 'barrel.ts': 'export { val } from "./source";', 'consumer.ts': 'import { val } from "./barrel"; export const num: number = val;' },
    { 'source.ts': 'export const val: number = 100;', 'barrel.ts': 'export { val } from "./source";', 'consumer.ts': 'import { val } from "./barrel"; export const num: number = val;' }
  ));

  // 12. B1 Named re-export - violated
  cases.push(buildCase(
    id(), 'B1', 'Named re-export through barrel broken by type change',
    { file: 'source.ts', symbol: 'val' }, 'VIOLATED',
    { 'source.ts': 'export const val: number = 42;', 'barrel.ts': 'export { val } from "./source";', 'consumer.ts': 'import { val } from "./barrel"; export const num: number = val;' },
    { 'source.ts': 'export const val: string = "42";', 'barrel.ts': 'export { val } from "./source";', 'consumer.ts': 'import { val } from "./barrel"; export const num: number = val;' }
  ));

  // 13. B2 Star re-export (export * from './b') - preserved
  cases.push(buildCase(
    id(), 'B2', 'Star re-export through barrel preserved',
    { file: 'source.ts', symbol: 'action' }, 'PRESERVED',
    { 'source.ts': 'export function action(): string { return "go"; }', 'barrel.ts': 'export * from "./source";', 'consumer.ts': 'import { action } from "./barrel"; export const res: string = action();' },
    { 'source.ts': 'export function action(): string { return "proceed"; }', 'barrel.ts': 'export * from "./source";', 'consumer.ts': 'import { action } from "./barrel"; export const res: string = action();' }
  ));

  // 14. B2 Star re-export - violated
  cases.push(buildCase(
    id(), 'B2', 'Star re-export broken by parameter addition',
    { file: 'source.ts', symbol: 'action' }, 'VIOLATED',
    { 'source.ts': 'export function action(): string { return "go"; }', 'barrel.ts': 'export * from "./source";', 'consumer.ts': 'import { action } from "./barrel"; export const res: string = action();' },
    { 'source.ts': 'export function action(flag: boolean): string { return flag ? "go" : "stop"; }', 'barrel.ts': 'export * from "./source";', 'consumer.ts': 'import { action } from "./barrel"; export const res: string = action();' }
  ));

  // 15. B3 Renamed re-export (export { x as y }) - preserved
  cases.push(buildCase(
    id(), 'B3', 'Renamed re-export preserved',
    { file: 'source.ts', symbol: 'orig' }, 'PRESERVED',
    { 'source.ts': 'export const orig = 10;', 'barrel.ts': 'export { orig as aliased } from "./source";', 'consumer.ts': 'import { aliased } from "./barrel"; export const a: number = aliased;' },
    { 'source.ts': 'export const orig = 20;', 'barrel.ts': 'export { orig as aliased } from "./source";', 'consumer.ts': 'import { aliased } from "./barrel"; export const a: number = aliased;' }
  ));

  // 16. B3 Renamed re-export - violated
  cases.push(buildCase(
    id(), 'B3', 'Renamed re-export broken by type narrowing/change',
    { file: 'source.ts', symbol: 'orig' }, 'VIOLATED',
    { 'source.ts': 'export const orig: number = 10;', 'barrel.ts': 'export { orig as aliased } from "./source";', 'consumer.ts': 'import { aliased } from "./barrel"; export const a: number = aliased;' },
    { 'source.ts': 'export const orig: boolean = true;', 'barrel.ts': 'export { orig as aliased } from "./source";', 'consumer.ts': 'import { aliased } from "./barrel"; export const a: number = aliased;' }
  ));

  // 17. B6 Multi-hop re-export (A -> B -> C -> D) - preserved
  cases.push(buildCase(
    id(), 'B6', 'Multi-hop 3-step re-export preserved',
    { file: 'step1.ts', symbol: 'core' }, 'PRESERVED',
    { 'step1.ts': 'export const core = "sajimora";', 'step2.ts': 'export { core } from "./step1";', 'step3.ts': 'export { core } from "./step2";', 'consumer.ts': 'import { core } from "./step3"; export const name: string = core;' },
    { 'step1.ts': 'export const core = "sajimora-v32";', 'step2.ts': 'export { core } from "./step1";', 'step3.ts': 'export { core } from "./step2";', 'consumer.ts': 'import { core } from "./step3"; export const name: string = core;' }
  ));

  // 18. B6 Multi-hop re-export - violated
  cases.push(buildCase(
    id(), 'B6', 'Multi-hop 3-step re-export broken at source',
    { file: 'step1.ts', symbol: 'core' }, 'VIOLATED',
    { 'step1.ts': 'export const core: string = "sajimora";', 'step2.ts': 'export { core } from "./step1";', 'step3.ts': 'export { core } from "./step2";', 'consumer.ts': 'import { core } from "./step3"; export const name: string = core;' },
    { 'step1.ts': 'export const core: number = 32;', 'step2.ts': 'export { core } from "./step1";', 'step3.ts': 'export { core } from "./step2";', 'consumer.ts': 'import { core } from "./step3"; export const name: string = core;' }
  ));

  // 19. B7 Barrel export collision - fail-closed UNKNOWN
  cases.push(buildCase(
    id(), 'B7', 'Barrel export collision fails closed as UNKNOWN',
    { file: 'b1.ts', symbol: 'item' }, 'UNKNOWN',
    { 'b1.ts': 'export const item = 1;', 'b2.ts': 'export const item = 2;', 'barrel.ts': 'export * from "./b1"; export * from "./b2";', 'consumer.ts': 'import { item } from "./barrel"; export const x = item;' },
    { 'b1.ts': 'export const item = 10;', 'b2.ts': 'export const item = 20;', 'barrel.ts': 'export * from "./b1"; export * from "./b2";', 'consumer.ts': 'import { item } from "./barrel"; export const x = item;' }
  ));

  // 20. B8 Circular barrel dependency - fail-closed UNKNOWN
  cases.push(buildCase(
    id(), 'B8', 'Circular barrel cycle fails closed',
    { file: 'cycleA.ts', symbol: 'cA' }, 'UNKNOWN',
    { 'cycleA.ts': 'export { cB } from "./cycleB"; export const cA = 1;', 'cycleB.ts': 'export { cA } from "./cycleA"; export const cB = 2;', 'consumer.ts': 'import { missingSym } from "./cycleA"; export const m = missingSym;' },
    { 'cycleA.ts': 'export { cB } from "./cycleB"; export const cA = 1;', 'cycleB.ts': 'export { cA } from "./cycleA"; export const cB = 2;', 'consumer.ts': 'import { missingSym } from "./cycleA"; export const m = missingSym;' }
  ));

  // -------------------------------------------------------------
  // Section C: TypeScript Paths and Aliases (8 cases)
  // -------------------------------------------------------------
  // 21. C1 baseUrl resolution - preserved
  cases.push(buildCase(
    id(), 'C1', 'baseUrl absolute path resolution preserved',
    { file: 'src/services/auth.ts', symbol: 'isAuthed' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src', strict: true } }), 'src/services/auth.ts': 'export const isAuthed = (): boolean => true;', 'src/app.ts': 'import { isAuthed } from "services/auth"; export const authed = isAuthed();' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src', strict: true } }), 'src/services/auth.ts': 'export const isAuthed = (): boolean => false;', 'src/app.ts': 'import { isAuthed } from "services/auth"; export const authed = isAuthed();' },
    'tsconfig.json'
  ));

  // 22. C1 baseUrl resolution - violated
  cases.push(buildCase(
    id(), 'C1', 'baseUrl resolution broken by return type change',
    { file: 'src/services/auth.ts', symbol: 'isAuthed' }, 'VIOLATED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src', strict: true } }), 'src/services/auth.ts': 'export const isAuthed = (): boolean => true;', 'src/app.ts': 'import { isAuthed } from "services/auth"; export const authed: boolean = isAuthed();' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src', strict: true } }), 'src/services/auth.ts': 'export const isAuthed = (): string => "yes";', 'src/app.ts': 'import { isAuthed } from "services/auth"; export const authed: boolean = isAuthed();' },
    'tsconfig.json'
  ));

  // 23. C2 paths alias wildcard mapping - preserved
  cases.push(buildCase(
    id(), 'C2', 'paths wildcard @app/* preserved',
    { file: 'src/lib/calc.ts', symbol: 'multiply' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] }, strict: true } }), 'src/lib/calc.ts': 'export const multiply = (x: number, y: number) => x * y;', 'src/main.ts': 'import { multiply } from "@app/lib/calc"; export const prod: number = multiply(2, 4);' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] }, strict: true } }), 'src/lib/calc.ts': 'export const multiply = (x: number, y: number, z = 1) => x * y * z;', 'src/main.ts': 'import { multiply } from "@app/lib/calc"; export const prod: number = multiply(2, 4);' },
    'tsconfig.json'
  ));

  // 24. C2 paths alias wildcard mapping - violated
  cases.push(buildCase(
    id(), 'C2', 'paths wildcard broken by required param addition',
    { file: 'src/lib/calc.ts', symbol: 'multiply' }, 'VIOLATED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] }, strict: true } }), 'src/lib/calc.ts': 'export const multiply = (x: number, y: number) => x * y;', 'src/main.ts': 'import { multiply } from "@app/lib/calc"; export const prod: number = multiply(2, 4);' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] }, strict: true } }), 'src/lib/calc.ts': 'export const multiply = (x: number, y: number, z: number) => x * y * z;', 'src/main.ts': 'import { multiply } from "@app/lib/calc"; export const prod: number = multiply(2, 4);' },
    'tsconfig.json'
  ));

  // 25. C3 Unresolvable path alias - fail-closed UNKNOWN
  cases.push(buildCase(
    id(), 'C3', 'Unresolvable path alias fails closed',
    { file: 'src/missing.ts', symbol: 'data' }, 'UNKNOWN',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@unknown/*': ['nonexistent/*'] }, strict: true } }), 'src/app.ts': 'import { data } from "@unknown/missing"; export const d = data;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@unknown/*': ['nonexistent/*'] }, strict: true } }), 'src/app.ts': 'import { data } from "@unknown/missing"; export const d = data;' },
    'tsconfig.json'
  ));

  // 26. C4 Multiple paths fallbacks - preserved
  cases.push(buildCase(
    id(), 'C4', 'Multiple paths fallback resolution preserved',
    { file: 'fallbacks/feature.ts', symbol: 'feat' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@feat': ['primary/feature', 'fallbacks/feature'] }, strict: true } }), 'fallbacks/feature.ts': 'export const feat = "active";', 'app.ts': 'import { feat } from "@feat"; export const f: string = feat;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@feat': ['primary/feature', 'fallbacks/feature'] }, strict: true } }), 'fallbacks/feature.ts': 'export const feat = "still active";', 'app.ts': 'import { feat } from "@feat"; export const f: string = feat;' },
    'tsconfig.json'
  ));

  // 27. C5 rootDirs mapping - preserved
  cases.push(buildCase(
    id(), 'C5', 'rootDirs virtual merged tree preserved',
    { file: 'generated/views/card.ts', symbol: 'CardView' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDirs: ['src/views', 'generated/views'], strict: true } }), 'generated/views/card.ts': 'export const CardView = "card";', 'src/views/main.ts': 'import { CardView } from "./card"; export const cv: string = CardView;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDirs: ['src/views', 'generated/views'], strict: true } }), 'generated/views/card.ts': 'export const CardView = "card-v2";', 'src/views/main.ts': 'import { CardView } from "./card"; export const cv: string = CardView;' },
    'tsconfig.json'
  ));

  // 28. C5 rootDirs mapping - violated
  cases.push(buildCase(
    id(), 'C5', 'rootDirs virtual merged tree broken by type change',
    { file: 'generated/views/card.ts', symbol: 'CardView' }, 'VIOLATED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDirs: ['src/views', 'generated/views'], strict: true } }), 'generated/views/card.ts': 'export const CardView: string = "card";', 'src/views/main.ts': 'import { CardView } from "./card"; export const cv: string = CardView;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDirs: ['src/views', 'generated/views'], strict: true } }), 'generated/views/card.ts': 'export const CardView: number = 42;', 'src/views/main.ts': 'import { CardView } from "./card"; export const cv: string = CardView;' },
    'tsconfig.json'
  ));

  // -------------------------------------------------------------
  // Section D: Modern Node / Bundler Resolution & Conditional Exports (8 cases)
  // -------------------------------------------------------------
  // 29. D1 Package conditional exports "import" - preserved
  cases.push(buildCase(
    id(), 'D1', 'Conditional exports import condition preserved',
    { file: 'node_modules/pkg/esm/index.ts', symbol: 'run' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { import: './esm/index.ts' } } }), 'node_modules/pkg/esm/index.ts': 'export const run = () => 1;', 'app.ts': 'import { run } from "pkg"; export const r: number = run();' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { import: './esm/index.ts' } } }), 'node_modules/pkg/esm/index.ts': 'export const run = () => 2;', 'app.ts': 'import { run } from "pkg"; export const r: number = run();' },
    'tsconfig.json'
  ));

  // 30. D1 Package conditional exports "import" - violated
  cases.push(buildCase(
    id(), 'D1', 'Conditional exports import broken by return type',
    { file: 'node_modules/pkg/esm/index.ts', symbol: 'run' }, 'VIOLATED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { import: './esm/index.ts' } } }), 'node_modules/pkg/esm/index.ts': 'export const run = (): number => 1;', 'app.ts': 'import { run } from "pkg"; export const r: number = run();' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { import: './esm/index.ts' } } }), 'node_modules/pkg/esm/index.ts': 'export const run = (): string => "1";', 'app.ts': 'import { run } from "pkg"; export const r: number = run();' },
    'tsconfig.json'
  ));

  // 31. D2 Subpath export (pkg/sub) - preserved
  cases.push(buildCase(
    id(), 'D2', 'Subpath export pkg/sub preserved',
    { file: 'node_modules/pkg/sub.ts', symbol: 'subVal' }, 'PRESERVED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { './sub': './sub.ts' } }), 'node_modules/pkg/sub.ts': 'export const subVal = 42;', 'app.ts': 'import { subVal } from "pkg/sub"; export const sv = subVal;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { './sub': './sub.ts' } }), 'node_modules/pkg/sub.ts': 'export const subVal = 84;', 'app.ts': 'import { subVal } from "pkg/sub"; export const sv = subVal;' },
    'tsconfig.json'
  ));

  // 32. D2 Subpath export (pkg/sub) - violated
  cases.push(buildCase(
    id(), 'D2', 'Subpath export pkg/sub broken by type mismatch',
    { file: 'node_modules/pkg/sub.ts', symbol: 'subVal' }, 'VIOLATED',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { './sub': './sub.ts' } }), 'node_modules/pkg/sub.ts': 'export const subVal: number = 42;', 'app.ts': 'import { subVal } from "pkg/sub"; export const sv: number = subVal;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }), 'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { './sub': './sub.ts' } }), 'node_modules/pkg/sub.ts': 'export const subVal: boolean = true;', 'app.ts': 'import { subVal } from "pkg/sub"; export const sv: number = subVal;' },
    'tsconfig.json'
  ));

  // 33. D3 Missing package in node_modules - fail-closed UNKNOWN
  cases.push(buildCase(
    id(), 'D3', 'Missing package fails closed as UNKNOWN',
    { file: 'missing-pkg', symbol: 'fn' }, 'UNKNOWN',
    { 'app.ts': 'import { fn } from "uninstalled-pkg"; export const res = fn();' },
    { 'app.ts': 'import { fn } from "uninstalled-pkg"; export const res = fn();' }
  ));

  // 34. D4 In-memory virtual monorepo workspace package - preserved
  cases.push(buildCase(
    id(), 'D4', 'In-memory virtual monorepo workspace package preserved',
    { file: 'packages/ui/src/button.ts', symbol: 'Button' }, 'PRESERVED',
    { 'packages/ui/package.json': JSON.stringify({ name: '@corp/ui', exports: { '.': './src/button.ts' } }), 'packages/ui/src/button.ts': 'export const Button = () => "btn";', 'apps/web/src/index.ts': 'import { Button } from "@corp/ui"; export const b = Button();' },
    { 'packages/ui/package.json': JSON.stringify({ name: '@corp/ui', exports: { '.': './src/button.ts' } }), 'packages/ui/src/button.ts': 'export const Button = (t?: string) => t ?? "btn";', 'apps/web/src/index.ts': 'import { Button } from "@corp/ui"; export const b = Button();' }
  ));

  // 35. D4 In-memory virtual monorepo workspace package - violated
  cases.push(buildCase(
    id(), 'D4', 'In-memory virtual monorepo workspace package broken by required param',
    { file: 'packages/ui/src/button.ts', symbol: 'Button' }, 'VIOLATED',
    { 'packages/ui/package.json': JSON.stringify({ name: '@corp/ui', exports: { '.': './src/button.ts' } }), 'packages/ui/src/button.ts': 'export const Button = () => "btn";', 'apps/web/src/index.ts': 'import { Button } from "@corp/ui"; export const b = Button();' },
    { 'packages/ui/package.json': JSON.stringify({ name: '@corp/ui', exports: { '.': './src/button.ts' } }), 'packages/ui/src/button.ts': 'export const Button = (label: string) => label;', 'apps/web/src/index.ts': 'import { Button } from "@corp/ui"; export const b = Button();' }
  ));

  // 36. D5 Monorepo subpath package import - preserved
  cases.push(buildCase(
    id(), 'D5', 'Monorepo workspace subpath export @corp/utils/math preserved',
    { file: 'packages/utils/src/math.ts', symbol: 'add' }, 'PRESERVED',
    { 'packages/utils/package.json': JSON.stringify({ name: '@corp/utils', exports: { './math': './src/math.ts' } }), 'packages/utils/src/math.ts': 'export const add = (a: number, b: number) => a + b;', 'apps/web/src/index.ts': 'import { add } from "@corp/utils/math"; export const sum: number = add(1, 2);' },
    { 'packages/utils/package.json': JSON.stringify({ name: '@corp/utils', exports: { './math': './src/math.ts' } }), 'packages/utils/src/math.ts': 'export const add = (a: number, b: number, c = 0) => a + b + c;', 'apps/web/src/index.ts': 'import { add } from "@corp/utils/math"; export const sum: number = add(1, 2);' }
  ));

  // -------------------------------------------------------------
  // Section G: Provider Function Signatures (12 cases)
  // -------------------------------------------------------------
  // 37. G1 Parameter optionality widening - preserved
  cases.push(buildCase(
    id(), 'G1', 'Adding optional parameter preserves zero-arg call',
    { file: 'fn.ts', symbol: 'execute' }, 'PRESERVED',
    { 'fn.ts': 'export function execute(): void {}', 'app.ts': 'import { execute } from "./fn"; execute();' },
    { 'fn.ts': 'export function execute(opt?: boolean): void {}', 'app.ts': 'import { execute } from "./fn"; execute();' }
  ));

  // 38. G1 Parameter requiredness narrowing - violated
  cases.push(buildCase(
    id(), 'G1', 'Adding required parameter rejects zero-arg call',
    { file: 'fn.ts', symbol: 'execute' }, 'VIOLATED',
    { 'fn.ts': 'export function execute(): void {}', 'app.ts': 'import { execute } from "./fn"; execute();' },
    { 'fn.ts': 'export function execute(req: boolean): void {}', 'app.ts': 'import { execute } from "./fn"; execute();' }
  ));

  // 39. G2 Rest parameters addition - preserved
  cases.push(buildCase(
    id(), 'G2', 'Adding rest parameters preserves existing arity',
    { file: 'fn.ts', symbol: 'combine' }, 'PRESERVED',
    { 'fn.ts': 'export function combine(a: string): string { return a; }', 'app.ts': 'import { combine } from "./fn"; export const r = combine("x");' },
    { 'fn.ts': 'export function combine(a: string, ...rest: string[]): string { return [a, ...rest].join(""); }', 'app.ts': 'import { combine } from "./fn"; export const r = combine("x");' }
  ));

  // 40. G2 Parameter type contravariance (widening) - preserved
  cases.push(buildCase(
    id(), 'G2', 'Parameter type widening (string -> string | number) is compatible for callers',
    { file: 'fn.ts', symbol: 'processItem' }, 'PRESERVED',
    { 'fn.ts': 'export function processItem(val: string): void {}', 'app.ts': 'import { processItem } from "./fn"; processItem("data");' },
    { 'fn.ts': 'export function processItem(val: string | number): void {}', 'app.ts': 'import { processItem } from "./fn"; processItem("data");' }
  ));

  // 41. G2 Parameter type narrowing - violated
  cases.push(buildCase(
    id(), 'G2', 'Parameter type narrowing (string | number -> string) rejects number call',
    { file: 'fn.ts', symbol: 'processItem' }, 'VIOLATED',
    { 'fn.ts': 'export function processItem(val: string | number): void {}', 'app.ts': 'import { processItem } from "./fn"; processItem(42);' },
    { 'fn.ts': 'export function processItem(val: string): void {}', 'app.ts': 'import { processItem } from "./fn"; processItem(42);' }
  ));

  // 42. G3 Return type covariance (narrowing) - preserved
  cases.push(buildCase(
    id(), 'G3', 'Return type narrowing (string | undefined -> string) preserves string read',
    { file: 'fn.ts', symbol: 'fetchConfig' }, 'PRESERVED',
    { 'fn.ts': 'export function fetchConfig(): string | undefined { return "cfg"; }', 'app.ts': 'import { fetchConfig } from "./fn"; export const res: string | undefined = fetchConfig();' },
    { 'fn.ts': 'export function fetchConfig(): string { return "cfg"; }', 'app.ts': 'import { fetchConfig } from "./fn"; export const res: string | undefined = fetchConfig();' }
  ));

  // 43. G3 Return type widening - violated
  cases.push(buildCase(
    id(), 'G3', 'Return type widening (string -> string | undefined) breaks annotated consumer',
    { file: 'fn.ts', symbol: 'fetchConfig' }, 'VIOLATED',
    { 'fn.ts': 'export function fetchConfig(): string { return "cfg"; }', 'app.ts': 'import { fetchConfig } from "./fn"; export const res: string = fetchConfig();' },
    { 'fn.ts': 'export function fetchConfig(): string | undefined { return undefined; }', 'app.ts': 'import { fetchConfig } from "./fn"; export const res: string = fetchConfig();' }
  ));

  // 44. G4 Void return widening - preserved
  cases.push(buildCase(
    id(), 'G4', 'Function return widening to void is compatible for discard callers',
    { file: 'fn.ts', symbol: 'noop' }, 'PRESERVED',
    { 'fn.ts': 'export function noop(): number { return 1; }', 'app.ts': 'import { noop } from "./fn"; noop();' },
    { 'fn.ts': 'export function noop(): void {}', 'app.ts': 'import { noop } from "./fn"; noop();' }
  ));

  // 45. G5 This parameter addition - violated
  cases.push(buildCase(
    id(), 'G5', 'Adding explicit this parameter rejects caller without receiver',
    { file: 'fn.ts', symbol: 'action' }, 'VIOLATED',
    { 'fn.ts': 'export function action(): string { return "ok"; }', 'app.ts': 'import { action } from "./fn"; export const a = action();' },
    { 'fn.ts': 'export function action(this: { ctx: string }): string { return this.ctx; }', 'app.ts': 'import { action } from "./fn"; export const a = action();' }
  ));

  // 46. G6 Inferred return preservation - preserved
  cases.push(buildCase(
    id(), 'G6', 'Inferred literal return preservation',
    { file: 'fn.ts', symbol: 'status' }, 'PRESERVED',
    { 'fn.ts': 'export const status = () => "active";', 'app.ts': 'import { status } from "./fn"; export const s: string = status();' },
    { 'fn.ts': 'export const status = () => "active" as const;', 'app.ts': 'import { status } from "./fn"; export const s: string = status();' }
  ));

  // 47. G7 Type predicate (x is string) replacement with boolean - violated
  cases.push(buildCase(
    id(), 'G7', 'Replacing type predicate with boolean drops narrowing effect',
    { file: 'fn.ts', symbol: 'isStr' }, 'VIOLATED',
    { 'fn.ts': 'export function isStr(x: unknown): x is string { return typeof x === "string"; }', 'app.ts': 'import { isStr } from "./fn"; const v: unknown = "hello"; if (isStr(v)) { const s: string = v; }' },
    { 'fn.ts': 'export function isStr(x: unknown): boolean { return typeof x === "string"; }', 'app.ts': 'import { isStr } from "./fn"; const v: unknown = "hello"; if (isStr(v)) { const s: string = v; }' }
  ));

  // 48. G8 Assertion function (asserts x is T) replacement with void - violated
  cases.push(buildCase(
    id(), 'G8', 'Replacing assertion function with void drops assertion effect',
    { file: 'fn.ts', symbol: 'assertDefined' }, 'VIOLATED',
    { 'fn.ts': 'export function assertDefined<T>(x: T | undefined): asserts x is T { if (x === undefined) throw new Error(); }', 'app.ts': 'import { assertDefined } from "./fn"; export function check(u: number | undefined): number { assertDefined(u); return u; }' },
    { 'fn.ts': 'export function assertDefined<T>(x: T | undefined): void { if (x === undefined) throw new Error(); }', 'app.ts': 'import { assertDefined } from "./fn"; export function check(u: number | undefined): number { assertDefined(u); return u; }' }
  ));

  // -------------------------------------------------------------
  // Section J & K: Classes and Interfaces (12 cases)
  // -------------------------------------------------------------
  // 49. J1 Class method addition - preserved
  cases.push(buildCase(
    id(), 'J1', 'Class method addition preserves existing call sites',
    { file: 'cls.ts', symbol: 'Service' }, 'PRESERVED',
    { 'cls.ts': 'export class Service { run(): string { return "ok"; } }', 'app.ts': 'import { Service } from "./cls"; const s = new Service(); export const r = s.run();' },
    { 'cls.ts': 'export class Service { run(): string { return "ok"; } stop(): void {} }', 'app.ts': 'import { Service } from "./cls"; const s = new Service(); export const r = s.run();' }
  ));

  // 50. J1 Class method removal - violated
  cases.push(buildCase(
    id(), 'J1', 'Class method removal breaks consumer calling that method',
    { file: 'cls.ts', symbol: 'Service' }, 'VIOLATED',
    { 'cls.ts': 'export class Service { run(): string { return "ok"; } stop(): void {} }', 'app.ts': 'import { Service } from "./cls"; const s = new Service(); s.stop();' },
    { 'cls.ts': 'export class Service { run(): string { return "ok"; } }', 'app.ts': 'import { Service } from "./cls"; const s = new Service(); s.stop();' }
  ));

  // 51. J2 Class constructor parameter addition - violated
  cases.push(buildCase(
    id(), 'J2', 'Class constructor adding required parameter breaks zero-arg construction',
    { file: 'cls.ts', symbol: 'Client' }, 'VIOLATED',
    { 'cls.ts': 'export class Client { constructor() {} }', 'app.ts': 'import { Client } from "./cls"; export const c = new Client();' },
    { 'cls.ts': 'export class Client { constructor(public token: string) {} }', 'app.ts': 'import { Client } from "./cls"; export const c = new Client();' }
  ));

  // 52. J3 Class member made private - violated
  cases.push(buildCase(
    id(), 'J3', 'Class member made private breaks external consumer property access',
    { file: 'cls.ts', symbol: 'Store' }, 'VIOLATED',
    { 'cls.ts': 'export class Store { public state = 1; }', 'app.ts': 'import { Store } from "./cls"; const s = new Store(); export const v: number = s.state;' },
    { 'cls.ts': 'export class Store { private state = 1; }', 'app.ts': 'import { Store } from "./cls"; const s = new Store(); export const v: number = s.state;' }
  ));

  // 53. K1 Interface optional property addition - preserved
  cases.push(buildCase(
    id(), 'K1', 'Interface optional property addition preserves implementations',
    { file: 'iface.ts', symbol: 'Model' }, 'PRESERVED',
    { 'iface.ts': 'export interface Model { id: string; }', 'app.ts': 'import { Model } from "./iface"; export const m: Model = { id: "1" };' },
    { 'iface.ts': 'export interface Model { id: string; name?: string; }', 'app.ts': 'import { Model } from "./iface"; export const m: Model = { id: "1" };' }
  ));

  // 54. K1 Interface required property addition - violated
  cases.push(buildCase(
    id(), 'K1', 'Interface required property addition breaks existing object literals',
    { file: 'iface.ts', symbol: 'Model' }, 'VIOLATED',
    { 'iface.ts': 'export interface Model { id: string; }', 'app.ts': 'import { Model } from "./iface"; export const m: Model = { id: "1" };' },
    { 'iface.ts': 'export interface Model { id: string; name: string; }', 'app.ts': 'import { Model } from "./iface"; export const m: Model = { id: "1" };' }
  ));

  // 55. K2 Interface property removal - violated
  cases.push(buildCase(
    id(), 'K2', 'Interface property removal breaks consumer reading that property',
    { file: 'iface.ts', symbol: 'User' }, 'VIOLATED',
    { 'iface.ts': 'export interface User { id: string; role: string; }', 'app.ts': 'import { User } from "./iface"; export function getRole(u: User): string { return u.role; }' },
    { 'iface.ts': 'export interface User { id: string; }', 'app.ts': 'import { User } from "./iface"; export function getRole(u: User): string { return u.role; }' }
  ));

  // 56. K3 Readonly to mutable property in object parameter - preserved
  cases.push(buildCase(
    id(), 'K3', 'Consumer reading readonly property preserved when provider relaxes it',
    { file: 'iface.ts', symbol: 'Item' }, 'PRESERVED',
    { 'iface.ts': 'export interface Item { readonly id: number; }', 'app.ts': 'import { Item } from "./iface"; export const readId = (it: Item): number => it.id;' },
    { 'iface.ts': 'export interface Item { id: number; }', 'app.ts': 'import { Item } from "./iface"; export const readId = (it: Item): number => it.id;' }
  ));

  // 57. K4 Mutable property with downstream write breaks when made readonly - violated
  cases.push(buildCase(
    id(), 'K4', 'Downstream consumer write rejected when property becomes readonly',
    { file: 'iface.ts', symbol: 'Item' }, 'VIOLATED',
    { 'iface.ts': 'export interface Item { id: number; }', 'app.ts': 'import { Item } from "./iface"; export function mutate(it: Item) { it.id = 2; }' },
    { 'iface.ts': 'export interface Item { readonly id: number; }', 'app.ts': 'import { Item } from "./iface"; export function mutate(it: Item) { it.id = 2; }' }
  ));

  // 58. K5 Interface method signature parameter widening - preserved
  cases.push(buildCase(
    id(), 'K5', 'Interface method parameter widening preserved',
    { file: 'iface.ts', symbol: 'Handler' }, 'PRESERVED',
    { 'iface.ts': 'export interface Handler { handle(event: string): void; }', 'app.ts': 'import { Handler } from "./iface"; export function invoke(h: Handler) { h.handle("click"); }' },
    { 'iface.ts': 'export interface Handler { handle(event: string | number): void; }', 'app.ts': 'import { Handler } from "./iface"; export function invoke(h: Handler) { h.handle("click"); }' }
  ));

  // 59. K6 Nested interface anonymous structural compatibility - preserved
  cases.push(buildCase(
    id(), 'K6', 'Nested anonymous object property widening preserved',
    { file: 'iface.ts', symbol: 'Payload' }, 'PRESERVED',
    { 'iface.ts': 'export interface Payload { meta: { tag: string; }; }', 'app.ts': 'import { Payload } from "./iface"; export const getTag = (p: Payload): string => p.meta.tag;' },
    { 'iface.ts': 'export interface Payload { meta: { tag: string; timestamp?: number; }; }', 'app.ts': 'import { Payload } from "./iface"; export const getTag = (p: Payload): string => p.meta.tag;' }
  ));

  // 60. K6 Nested interface anonymous property removal - violated
  cases.push(buildCase(
    id(), 'K6', 'Nested anonymous object property removal breaks access',
    { file: 'iface.ts', symbol: 'Payload' }, 'VIOLATED',
    { 'iface.ts': 'export interface Payload { meta: { tag: string; }; }', 'app.ts': 'import { Payload } from "./iface"; export const getTag = (p: Payload): string => p.meta.tag;' },
    { 'iface.ts': 'export interface Payload { meta: { other: number; }; }', 'app.ts': 'import { Payload } from "./iface"; export const getTag = (p: Payload): string => p.meta.tag;' }
  ));

  // -------------------------------------------------------------
  // Section M & N: Generics and Overloads (12 cases)
  // -------------------------------------------------------------
  // 61. M1 Generic identity function preserved
  cases.push(buildCase(
    id(), 'M1', 'Generic identity function preserved across callers',
    { file: 'gen.ts', symbol: 'identity' }, 'PRESERVED',
    { 'gen.ts': 'export function identity<T>(arg: T): T { return arg; }', 'app.ts': 'import { identity } from "./gen"; export const num: number = identity(42);' },
    { 'gen.ts': 'export function identity<T>(arg: T): T { return arg; }', 'app.ts': 'import { identity } from "./gen"; export const num: number = identity(42);' }
  ));

  // 62. M2 Generic constraint tightening - violated
  cases.push(buildCase(
    id(), 'M2', 'Generic constraint tightening (T to T extends string) rejects number instantiation',
    { file: 'gen.ts', symbol: 'wrap' }, 'VIOLATED',
    { 'gen.ts': 'export function wrap<T>(val: T): { value: T } { return { value: val }; }', 'app.ts': 'import { wrap } from "./gen"; export const w = wrap<number>(123);' },
    { 'gen.ts': 'export function wrap<T extends string>(val: T): { value: T } { return { value: val }; }', 'app.ts': 'import { wrap } from "./gen"; export const w = wrap<number>(123);' }
  ));

  // 63. M3 Generic arity mismatch - violated
  cases.push(buildCase(
    id(), 'M3', 'Generic arity mismatch (adding required type parameter) breaks single-arg caller',
    { file: 'gen.ts', symbol: 'Pair' }, 'VIOLATED',
    { 'gen.ts': 'export interface Pair<T> { first: T; }', 'app.ts': 'import { Pair } from "./gen"; export const p: Pair<string> = { first: "a" };' },
    { 'gen.ts': 'export interface Pair<T, U> { first: T; second: U; }', 'app.ts': 'import { Pair } from "./gen"; export const p: Pair<string> = { first: "a" };' }
  ));

  // 64. M4 Generic default type parameter addition - preserved
  cases.push(buildCase(
    id(), 'M4', 'Adding default type parameter preserves single-arg instantiation',
    { file: 'gen.ts', symbol: 'Container' }, 'PRESERVED',
    { 'gen.ts': 'export interface Container<T> { item: T; }', 'app.ts': 'import { Container } from "./gen"; export const c: Container<number> = { item: 1 };' },
    { 'gen.ts': 'export interface Container<T, M = string> { item: T; meta?: M; }', 'app.ts': 'import { Container } from "./gen"; export const c: Container<number> = { item: 1 };' }
  ));

  // 65. N1 Overload addition preserving historical resolution - preserved
  cases.push(buildCase(
    id(), 'N1', 'Adding new overload variant preserves historical string caller',
    { file: 'ovl.ts', symbol: 'format' }, 'PRESERVED',
    { 'ovl.ts': 'export function format(val: string): string; export function format(val: string): string { return val; }', 'app.ts': 'import { format } from "./ovl"; export const s: string = format("hello");' },
    { 'ovl.ts': 'export function format(val: string): string; export function format(val: number): string; export function format(val: any): string { return String(val); }', 'app.ts': 'import { format } from "./ovl"; export const s: string = format("hello");' }
  ));

  // 66. N2 Overload order conflict / deletion - violated
  cases.push(buildCase(
    id(), 'N2', 'Removing string overload breaks string caller',
    { file: 'ovl.ts', symbol: 'parse' }, 'VIOLATED',
    { 'ovl.ts': 'export function parse(val: string): number; export function parse(val: number): number; export function parse(val: any): number { return Number(val); }', 'app.ts': 'import { parse } from "./ovl"; export const p = parse("123");' },
    { 'ovl.ts': 'export function parse(val: number): number; export function parse(val: any): number { return Number(val); }', 'app.ts': 'import { parse } from "./ovl"; export const p = parse("123");' }
  ));

  // 67. N3 Overload resolution obeying TypeScript declaration order - preserved
  cases.push(buildCase(
    id(), 'N3', 'Consistent overload resolution under ES declaration order',
    { file: 'ovl.ts', symbol: 'dispatch' }, 'PRESERVED',
    { 'ovl.ts': 'export function dispatch(a: string): "str"; export function dispatch(a: any): "any"; export function dispatch(a: any): any { return "str"; }', 'app.ts': 'import { dispatch } from "./ovl"; export const r: "str" = dispatch("test");' },
    { 'ovl.ts': 'export function dispatch(a: string): "str"; export function dispatch(a: any): "any"; export function dispatch(a: any): any { return "str"; }', 'app.ts': 'import { dispatch } from "./ovl"; export const r: "str" = dispatch("test");' }
  ));

  // 68. N4 Overload return type change on matched overload - violated
  cases.push(buildCase(
    id(), 'N4', 'Overload return type changed from number to string on matched overload',
    { file: 'ovl.ts', symbol: 'calc' }, 'VIOLATED',
    { 'ovl.ts': 'export function calc(x: number): number; export function calc(x: any): any { return x; }', 'app.ts': 'import { calc } from "./ovl"; export const res: number = calc(10);' },
    { 'ovl.ts': 'export function calc(x: number): string; export function calc(x: any): any { return String(x); }', 'app.ts': 'import { calc } from "./ovl"; export const res: number = calc(10);' }
  ));

  // 69. O1 Callback parameter arity compatibility - preserved
  cases.push(buildCase(
    id(), 'O1', 'Callback widening callback parameter provides more info to caller',
    { file: 'cb.ts', symbol: 'each' }, 'PRESERVED',
    { 'cb.ts': 'export function each(fn: (item: string) => void): void { fn("x"); }', 'app.ts': 'import { each } from "./cb"; let sink = ""; each((it) => { sink = it; });' },
    { 'cb.ts': 'export function each(fn: (item: string, index?: number) => void): void { fn("x", 0); }', 'app.ts': 'import { each } from "./cb"; let sink = ""; each((it) => { sink = it; });' }
  ));

  // 70. O2 Callback return type widening to void - preserved
  cases.push(buildCase(
    id(), 'O2', 'Callback return widening to void allows callback to return anything',
    { file: 'cb.ts', symbol: 'runCb' }, 'PRESERVED',
    { 'cb.ts': 'export function runCb(cb: () => void): void { cb(); }', 'app.ts': 'import { runCb } from "./cb"; runCb(() => 123);' },
    { 'cb.ts': 'export function runCb(cb: () => void): void { cb(); }', 'app.ts': 'import { runCb } from "./cb"; runCb(() => 123);' }
  ));

  // 71. O3 Higher order function returned signature broken - violated
  cases.push(buildCase(
    id(), 'O3', 'Higher order function returning changed signature breaks consumer',
    { file: 'hof.ts', symbol: 'createAdder' }, 'VIOLATED',
    { 'hof.ts': 'export function createAdder(base: number): (x: number) => number { return (x) => base + x; }', 'app.ts': 'import { createAdder } from "./hof"; const adder = createAdder(5); export const val: number = adder(10);' },
    { 'hof.ts': 'export function createAdder(base: number): (x: string) => string { return (x) => String(base) + x; }', 'app.ts': 'import { createAdder } from "./hof"; const adder = createAdder(5); export const val: number = adder(10);' }
  ));

  // 72. O4 Higher order function returned signature preserved - preserved
  cases.push(buildCase(
    id(), 'O4', 'Higher order function returned signature preserved',
    { file: 'hof.ts', symbol: 'createGreeter' }, 'PRESERVED',
    { 'hof.ts': 'export function createGreeter(): (name: string) => string { return (n) => "Hi " + n; }', 'app.ts': 'import { createGreeter } from "./hof"; const g = createGreeter(); export const m: string = g("Bob");' },
    { 'hof.ts': 'export function createGreeter(): (name: string, p?: string) => string { return (n) => "Hi " + n; }', 'app.ts': 'import { createGreeter } from "./hof"; const g = createGreeter(); export const m: string = g("Bob");' }
  ));

  // -------------------------------------------------------------
  // Section Q, R, S, T: Literals, Enums, Tuples, Predicates (16 cases)
  // -------------------------------------------------------------
  // 73. Q1 Distinct enums with same numeric value fail compatibility - violated
  cases.push(buildCase(
    id(), 'Q1', 'Distinct enums with identical numeric values are incompatible',
    { file: 'enums.ts', symbol: 'Status' }, 'VIOLATED',
    { 'enums.ts': 'export enum Status { Ok = 1, Err = 2 }', 'app.ts': 'import { Status } from "./enums"; export const s: Status = Status.Ok;' },
    { 'enums.ts': 'export enum OtherStatus { Ok = 1, Err = 2 } export type Status = OtherStatus;', 'app.ts': 'import { Status } from "./enums"; export const s: Status = Status.Ok;' }
  ));

  // 74. Q2 Enum member addition preserved for existing consumer reading Ok - preserved
  cases.push(buildCase(
    id(), 'Q2', 'Enum member addition preserves existing members',
    { file: 'enums.ts', symbol: 'Color' }, 'PRESERVED',
    { 'enums.ts': 'export enum Color { Red = "RED", Blue = "BLUE" }', 'app.ts': 'import { Color } from "./enums"; export const c: Color = Color.Red;' },
    { 'enums.ts': 'export enum Color { Red = "RED", Blue = "BLUE", Green = "GREEN" }', 'app.ts': 'import { Color } from "./enums"; export const c: Color = Color.Red;' }
  ));

  // 75. Q3 Enum member removal breaks consumer reading removed member - violated
  cases.push(buildCase(
    id(), 'Q3', 'Enum member removal breaks consumer reading that member',
    { file: 'enums.ts', symbol: 'Mode' }, 'VIOLATED',
    { 'enums.ts': 'export enum Mode { Fast = 1, Safe = 2 }', 'app.ts': 'import { Mode } from "./enums"; export const m: Mode = Mode.Safe;' },
    { 'enums.ts': 'export enum Mode { Fast = 1 }', 'app.ts': 'import { Mode } from "./enums"; export const m: Mode = Mode.Safe;' }
  ));

  // 76. R1 Discriminated union addition preserved for narrowing consumer - preserved
  cases.push(buildCase(
    id(), 'R1', 'Discriminated union member addition preserved for specific tag check',
    { file: 'union.ts', symbol: 'Shape' }, 'PRESERVED',
    { 'union.ts': 'export type Shape = { kind: "circle"; radius: number } | { kind: "square"; size: number };', 'app.ts': 'import { Shape } from "./union"; export function getRadius(s: Shape): number | null { return s.kind === "circle" ? s.radius : null; }' },
    { 'union.ts': 'export type Shape = { kind: "circle"; radius: number } | { kind: "square"; size: number } | { kind: "rect"; w: number; h: number };', 'app.ts': 'import { Shape } from "./union"; export function getRadius(s: Shape): number | null { return s.kind === "circle" ? s.radius : null; }' }
  ));

  // 77. R2 Discriminated union member removal breaks consumer handling that member - violated
  cases.push(buildCase(
    id(), 'R2', 'Discriminated union member removal breaks consumer assigning that member',
    { file: 'union.ts', symbol: 'Event' }, 'VIOLATED',
    { 'union.ts': 'export type Event = { type: "login"; user: string } | { type: "logout" };', 'app.ts': 'import { Event } from "./union"; export const e: Event = { type: "logout" };' },
    { 'union.ts': 'export type Event = { type: "login"; user: string };', 'app.ts': 'import { Event } from "./union"; export const e: Event = { type: "logout" };' }
  ));

  // 78. R3 Discriminated union tag type change - violated
  cases.push(buildCase(
    id(), 'R3', 'Discriminated union tag value change breaks consumer matching old tag',
    { file: 'union.ts', symbol: 'Action' }, 'VIOLATED',
    { 'union.ts': 'export type Action = { type: "START" } | { type: "STOP" };', 'app.ts': 'import { Action } from "./union"; export const a: Action = { type: "START" };' },
    { 'union.ts': 'export type Action = { type: "BEGIN" } | { type: "STOP" };', 'app.ts': 'import { Action } from "./union"; export const a: Action = { type: "START" };' }
  ));

  // 79. S1 Tuple element preservation - preserved
  cases.push(buildCase(
    id(), 'S1', 'Tuple type preserved',
    { file: 'tuple.ts', symbol: 'Point' }, 'PRESERVED',
    { 'tuple.ts': 'export type Point = [number, number];', 'app.ts': 'import { Point } from "./tuple"; export const pt: Point = [10, 20];' },
    { 'tuple.ts': 'export type Point = [number, number];', 'app.ts': 'import { Point } from "./tuple"; export const pt: Point = [10, 20];' }
  ));

  // 80. S1 Tuple cardinality mismatch - violated
  cases.push(buildCase(
    id(), 'S1', 'Tuple cardinality mismatch (adding required 3rd element) breaks 2-tuple',
    { file: 'tuple.ts', symbol: 'Point' }, 'VIOLATED',
    { 'tuple.ts': 'export type Point = [number, number];', 'app.ts': 'import { Point } from "./tuple"; export const pt: Point = [10, 20];' },
    { 'tuple.ts': 'export type Point = [number, number, number];', 'app.ts': 'import { Point } from "./tuple"; export const pt: Point = [10, 20];' }
  ));

  // 81. S2 Tuple optional element addition - preserved
  cases.push(buildCase(
    id(), 'S2', 'Tuple optional element addition preserves 2-tuple instantiation',
    { file: 'tuple.ts', symbol: 'Coord' }, 'PRESERVED',
    { 'tuple.ts': 'export type Coord = [number, number];', 'app.ts': 'import { Coord } from "./tuple"; export const c: Coord = [1, 2];' },
    { 'tuple.ts': 'export type Coord = [number, number, number?];', 'app.ts': 'import { Coord } from "./tuple"; export const c: Coord = [1, 2];' }
  ));

  // 82. S3 Readonly tuple enforcement - violated
  cases.push(buildCase(
    id(), 'S3', 'Readonly tuple rejects mutation by index write',
    { file: 'tuple.ts', symbol: 'Vec' }, 'VIOLATED',
    { 'tuple.ts': 'export type Vec = [number, number];', 'app.ts': 'import { Vec } from "./tuple"; export function update(v: Vec) { v[0] = 99; }' },
    { 'tuple.ts': 'export type Vec = readonly [number, number];', 'app.ts': 'import { Vec } from "./tuple"; export function update(v: Vec) { v[0] = 99; }' }
  ));

  // 83. T1 Type predicate preservation - preserved
  cases.push(buildCase(
    id(), 'T1', 'Type predicate (x is number) preserved',
    { file: 'pred.ts', symbol: 'isNum' }, 'PRESERVED',
    { 'pred.ts': 'export function isNum(x: unknown): x is number { return typeof x === "number"; }', 'app.ts': 'import { isNum } from "./pred"; const v: unknown = 42; if (isNum(v)) { const n: number = v; }' },
    { 'pred.ts': 'export function isNum(x: unknown): x is number { return typeof x === "number" && !Number.isNaN(x); }', 'app.ts': 'import { isNum } from "./pred"; const v: unknown = 42; if (isNum(v)) { const n: number = v; }' }
  ));

  // 84. T2 Assertion function preservation - preserved
  cases.push(buildCase(
    id(), 'T2', 'Assertion function (asserts x is string) preserved',
    { file: 'pred.ts', symbol: 'checkStr' }, 'PRESERVED',
    { 'pred.ts': 'export function checkStr(x: unknown): asserts x is string { if (typeof x !== "string") throw new Error(); }', 'app.ts': 'import { checkStr } from "./pred"; const v: unknown = "hello"; checkStr(v); const s: string = v;' },
    { 'pred.ts': 'export function checkStr(x: unknown): asserts x is string { if (typeof x !== "string" || x.length === 0) throw new Error(); }', 'app.ts': 'import { checkStr } from "./pred"; const v: unknown = "hello"; checkStr(v); const s: string = v;' }
  ));

  // 85. L1 Union alias widening - preserved
  cases.push(buildCase(
    id(), 'L1', 'Union type alias widening ("a" -> "a" | "b") preserved for "a" assignment',
    { file: 'types.ts', symbol: 'Choice' }, 'PRESERVED',
    { 'types.ts': 'export type Choice = "a";', 'app.ts': 'import { Choice } from "./types"; export const c: Choice = "a";' },
    { 'types.ts': 'export type Choice = "a" | "b";', 'app.ts': 'import { Choice } from "./types"; export const c: Choice = "a";' }
  ));

  // 86. L2 Union alias narrowing - violated
  cases.push(buildCase(
    id(), 'L2', 'Union type alias narrowing ("a" | "b" -> "a") breaks "b" assignment',
    { file: 'types.ts', symbol: 'Choice' }, 'VIOLATED',
    { 'types.ts': 'export type Choice = "a" | "b";', 'app.ts': 'import { Choice } from "./types"; export const c: Choice = "b";' },
    { 'types.ts': 'export type Choice = "a";', 'app.ts': 'import { Choice } from "./types"; export const c: Choice = "b";' }
  ));

  // 87. L3 Intersection alias required property addition - violated
  cases.push(buildCase(
    id(), 'L3', 'Intersection alias required property addition breaks consumer object literal',
    { file: 'types.ts', symbol: 'Combined' }, 'VIOLATED',
    { 'types.ts': 'export type Combined = { a: number } & { b: string };', 'app.ts': 'import { Combined } from "./types"; export const c: Combined = { a: 1, b: "x" };' },
    { 'types.ts': 'export type Combined = { a: number } & { b: string; c: boolean };', 'app.ts': 'import { Combined } from "./types"; export const c: Combined = { a: 1, b: "x" };' }
  ));

  // 88. L4 Recursive type alias preservation - preserved
  cases.push(buildCase(
    id(), 'L4', 'Recursive tree node type alias preserved',
    { file: 'tree.ts', symbol: 'TreeNode' }, 'PRESERVED',
    { 'tree.ts': 'export interface TreeNode { val: number; children?: TreeNode[]; }', 'app.ts': 'import { TreeNode } from "./tree"; export const t: TreeNode = { val: 1, children: [{ val: 2 }] };' },
    { 'tree.ts': 'export interface TreeNode { val: number; name?: string; children?: TreeNode[]; }', 'app.ts': 'import { TreeNode } from "./tree"; export const t: TreeNode = { val: 1, children: [{ val: 2 }] };' }
  ));

  // -------------------------------------------------------------
  // Section U, V, W, X, Y, Z: JSX, Namespaces, References, Monorepo (12 cases)
  // -------------------------------------------------------------
  // 89. U1 JSX component optional prop addition - preserved
  cases.push(buildCase(
    id(), 'U1', 'JSX component optional prop addition preserved',
    { file: 'Button.tsx', symbol: 'Button' }, 'PRESERVED',
    { 'Button.tsx': 'export const Button = (props: { label: string }): string => props.label;', 'App.tsx': 'import { Button } from "./Button"; export const b = Button({ label: "Click" });' },
    { 'Button.tsx': 'export const Button = (props: { label: string; primary?: boolean }): string => props.label;', 'App.tsx': 'import { Button } from "./Button"; export const b = Button({ label: "Click" });' }
  ));

  // 90. U1 JSX component required prop addition - violated
  cases.push(buildCase(
    id(), 'U1', 'JSX component required prop addition breaks caller missing that prop',
    { file: 'Button.tsx', symbol: 'Button' }, 'VIOLATED',
    { 'Button.tsx': 'export const Button = (props: { label: string }): string => props.label;', 'App.tsx': 'import { Button } from "./Button"; export const b = Button({ label: "Click" });' },
    { 'Button.tsx': 'export const Button = (props: { label: string; onClick: () => void }): string => props.label;', 'App.tsx': 'import { Button } from "./Button"; export const b = Button({ label: "Click" });' }
  ));

  // 91. V1 Namespace exported member preservation - preserved
  cases.push(buildCase(
    id(), 'V1', 'Namespace member function preserved',
    { file: 'ns.ts', symbol: 'Tools' }, 'PRESERVED',
    { 'ns.ts': 'export namespace Tools { export function run(): string { return "ok"; } }', 'app.ts': 'import { Tools } from "./ns"; export const r: string = Tools.run();' },
    { 'ns.ts': 'export namespace Tools { export function run(): string { return "ok"; } export const v = 2; }', 'app.ts': 'import { Tools } from "./ns"; export const r: string = Tools.run();' }
  ));

  // 92. V1 Namespace exported member removal - violated
  cases.push(buildCase(
    id(), 'V1', 'Namespace member removal breaks caller',
    { file: 'ns.ts', symbol: 'Tools' }, 'VIOLATED',
    { 'ns.ts': 'export namespace Tools { export function run(): string { return "ok"; } }', 'app.ts': 'import { Tools } from "./ns"; export const r: string = Tools.run();' },
    { 'ns.ts': 'export namespace Tools { export const v = 2; }', 'app.ts': 'import { Tools } from "./ns"; export const r: string = Tools.run();' }
  ));

  // 93. W1 Ambient module declaration preservation - preserved
  cases.push(buildCase(
    id(), 'W1', 'Ambient module declaration preserved',
    { file: 'declarations.d.ts', symbol: 'id' }, 'PRESERVED',
    { 'declarations.d.ts': 'declare module "virtual-mod" { export const id: number; }', 'app.ts': 'import { id } from "virtual-mod"; export const myId: number = id;' },
    { 'declarations.d.ts': 'declare module "virtual-mod" { export const id: number; export const name: string; }', 'app.ts': 'import { id } from "virtual-mod"; export const myId: number = id;' }
  ));

  // 94. W1 Ambient module declaration member removal - violated
  cases.push(buildCase(
    id(), 'W1', 'Ambient module member removal breaks consumer',
    { file: 'declarations.d.ts', symbol: 'id' }, 'VIOLATED',
    { 'declarations.d.ts': 'declare module "virtual-mod" { export const id: number; }', 'app.ts': 'import { id } from "virtual-mod"; export const myId: number = id;' },
    { 'declarations.d.ts': 'declare module "virtual-mod" { export const tag: string; }', 'app.ts': 'import { id } from "virtual-mod"; export const myId: number = id;' }
  ));

  // 95. X1 Project reference composite module preserved - preserved
  cases.push(buildCase(
    id(), 'X1', 'Project reference source consumption preserved',
    { file: 'packages/core/src/index.ts', symbol: 'CORE_VAL' }, 'PRESERVED',
    { 'packages/core/package.json': JSON.stringify({ name: '@proj/core', exports: { '.': './src/index.ts' } }), 'packages/core/src/index.ts': 'export const CORE_VAL = "active";', 'packages/app/src/main.ts': 'import { CORE_VAL } from "@proj/core"; export const cv: string = CORE_VAL;' },
    { 'packages/core/package.json': JSON.stringify({ name: '@proj/core', exports: { '.': './src/index.ts' } }), 'packages/core/src/index.ts': 'export const CORE_VAL = "active-v2";', 'packages/app/src/main.ts': 'import { CORE_VAL } from "@proj/core"; export const cv: string = CORE_VAL;' }
  ));

  // 96. X1 Project reference composite module broken - violated
  cases.push(buildCase(
    id(), 'X1', 'Project reference source type change breaks consumer',
    { file: 'packages/core/src/index.ts', symbol: 'CORE_VAL' }, 'VIOLATED',
    { 'packages/core/package.json': JSON.stringify({ name: '@proj/core', exports: { '.': './src/index.ts' } }), 'packages/core/src/index.ts': 'export const CORE_VAL: string = "active";', 'packages/app/src/main.ts': 'import { CORE_VAL } from "@proj/core"; export const cv: string = CORE_VAL;' },
    { 'packages/core/package.json': JSON.stringify({ name: '@proj/core', exports: { '.': './src/index.ts' } }), 'packages/core/src/index.ts': 'export const CORE_VAL: number = 999;', 'packages/app/src/main.ts': 'import { CORE_VAL } from "@proj/core"; export const cv: string = CORE_VAL;' }
  ));

  // 97. Y1 StrictNullChecks configuration dependency - fail-closed UNKNOWN on config delta
  cases.push(buildCase(
    id(), 'Y1', 'Configuration delta (strict: false -> strict: true) fails closed as CONFIGURATION_DEPENDENT',
    { file: 'val.ts', symbol: 'v' }, 'UNKNOWN',
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }), 'val.ts': 'export const v: string = null as any;', 'app.ts': 'import { v } from "./val"; export const x: string = v;' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }), 'val.ts': 'export const v: string | null = null;', 'app.ts': 'import { v } from "./val"; export const x: string = v;' },
    'tsconfig.json'
  ));

  // 98. Z1 Diamond dependency graph preserved - preserved
  cases.push(buildCase(
    id(), 'Z1', 'Diamond dependency graph preserved across multiple paths',
    { file: 'root.ts', symbol: 'shared' }, 'PRESERVED',
    { 'root.ts': 'export const shared = "common";', 'branchA.ts': 'export { shared } from "./root";', 'branchB.ts': 'export { shared } from "./root";', 'join.ts': 'import { shared as sA } from "./branchA"; import { shared as sB } from "./branchB"; export const match = sA === sB;' },
    { 'root.ts': 'export const shared = "common-v2";', 'branchA.ts': 'export { shared } from "./root";', 'branchB.ts': 'export { shared } from "./root";', 'join.ts': 'import { shared as sA } from "./branchA"; import { shared as sB } from "./branchB"; export const match = sA === sB;' }
  ));

  // 99. Z2 Provider and consumer simultaneous change - preserved
  cases.push(buildCase(
    id(), 'Z2', 'Same-commit provider and consumer simultaneous adaptation preserved',
    { file: 'math.ts', symbol: 'divide' }, 'PRESERVED',
    { 'math.ts': 'export function divide(a: number, b: number): number { return a / b; }', 'app.ts': 'import { divide } from "./math"; export const res = divide(10, 2);' },
    { 'math.ts': 'export function divide(a: number, b: number): { quotient: number } { return { quotient: a / b }; }', 'app.ts': 'import { divide } from "./math"; export const res = divide(10, 2).quotient;' }
  ));

  // 100. FC1 Missing declaration in candidate - fail-closed UNKNOWN
  cases.push(buildCase(
    id(), 'FC1', 'Missing provider declaration in candidate strictly fails closed',
    { file: 'missing.ts', symbol: 'unresolvedSym' }, 'UNKNOWN',
    { 'app.ts': 'import { unresolvedSym } from "./missing"; export const u = unresolvedSym;' },
    { 'app.ts': 'import { unresolvedSym } from "./missing"; export const u = unresolvedSym;' }
  ));

  const preserved = cases.filter(c => c.expectedVerdict === 'PRESERVED').length;
  const violated = cases.filter(c => c.expectedVerdict === 'VIOLATED').length;
  const unknown = cases.filter(c => c.expectedVerdict === 'UNKNOWN').length;

  return {
    schemaVersion: 'TYPESCRIPT_READINESS_100_SLICE_V1',
    totalCases: cases.length,
    distribution: { PRESERVED: preserved, VIOLATED: violated, UNKNOWN: unknown },
    generatedAt: new Date().toISOString(),
    cases
  };
}

if (require.main === module) {
  const manifest = generate100Slice();
  const outPath = path.resolve('scripts/campaign/fixtures/typescript_readiness_100_slice.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Generated 100-slice manifest at ${outPath}`);
  console.log(`Total: ${manifest.totalCases} | PRESERVED: ${manifest.distribution.PRESERVED} | VIOLATED: ${manifest.distribution.VIOLATED} | UNKNOWN: ${manifest.distribution.UNKNOWN}`);
}
