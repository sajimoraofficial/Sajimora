import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RepositoryRevisionAnalyzer } from '../../src/sajimora/advisory';

type Fixture = Readonly<Record<string, string>>;

function runFixture(
  name: string,
  files: Fixture,
  targetFile: string,
  resourceLimits: Readonly<Record<string, number>> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'sajimora-closure-audit-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init');
    git('config', 'user.email', 'audit@example.invalid');
    git('config', 'user.name', 'Audit');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    git('add', '.');
    git('commit', '-m', 'audit fixture');
    const sha = git('rev-parse', 'HEAD');
    const result = new RepositoryRevisionAnalyzer().analyze({
      repositoryPath: root,
      parentSha: sha,
      candidateSha: sha,
      target: { file: targetFile, symbol: 'target' },
      resourceLimits,
    });
    return {
      name,
      verdict: result.verdict,
      incomplete: result.completeness.status === 'INCOMPLETE',
      reasons: result.completeness.unresolvedFiles,
      selected: result.completeness.selection,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [
  runFixture('missing direct dependency', {
    'api.ts': "import './missing'; export const target = (): string => 'ok';",
  }, 'api.ts'),
  runFixture('missing transitive dependency', {
    'api.ts': "import './dep'; export const target = (): string => 'ok';",
    'dep.ts': "import './missing'; export {};",
  }, 'api.ts'),
  runFixture('missing barrel/index dependency', {
    'api.ts': "import { value } from './barrel'; export const target = (): number => value;",
    'barrel.ts': "export { value } from './missing';",
  }, 'api.ts'),
  runFixture('missing path-alias target', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } } }),
    'api.ts': "import { value } from '@lib/missing'; export const target = (): number => value;",
  }, 'api.ts'),
  runFixture('missing declaration dependency', {
    'api.ts': "import type { Missing } from './types'; export const target = (): Missing => null as never;",
  }, 'api.ts'),
  runFixture('missing triple-slash declaration dependency', {
    'api.ts': '/// <reference path="./ambient.d.ts" />\nexport const target = (): string => ambient;',
  }, 'api.ts'),
  runFixture('missing ambient type dependency', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: ['missing-ambient-package'] } }),
    'api.ts': "export const target = (): string => 'ok';",
  }, 'api.ts'),
  runFixture('reverse consumer outside selected closure', {
    'api.ts': "export const target = (): string => 'ok';",
    'consumer.ts': "import { target } from './api'; export const consumer = target();",
  }, 'api.ts', { maxScanFiles: 1 }),
  runFixture('reverse-scan truncation', {
    'api.ts': "export const target = (): string => 'ok';",
    'consumer.ts': "import { target } from './api'; export const consumer = target();",
  }, 'api.ts', { maxScanBytes: 1 }),
  runFixture('reverse consumer excluded by nearest tsconfig', {
    'tsconfig.json': JSON.stringify({ files: ['api.ts'] }),
    'api.ts': "export const target = (): string => 'ok';",
    'consumer.ts': "import { target } from './api'; export const consumer = target();",
  }, 'api.ts'),
  runFixture('dependency-depth truncation', {
    'api.ts': "import './a'; export const target = (): string => 'ok';",
    'a.ts': "import './b'; export {};",
    'b.ts': 'export {};',
  }, 'api.ts', { maxDependencyDepth: 0 }),
  runFixture('selected-file budget exhaustion', {
    'tsconfig.json': '{}',
    'api.ts': "export const target = (): string => 'ok';",
  }, 'api.ts', { maxSelectedFiles: 1 }),
  runFixture('selected-byte budget exhaustion', {
    'tsconfig.json': '{}',
    'api.ts': "export const target = (): string => 'ok';",
  }, 'api.ts', { maxSelectedBytes: 1 }),
  runFixture('selection execution-time budget exhaustion', {
    'api.ts': "export const target = (): string => 'ok';",
  }, 'api.ts', { maxExecutionMs: 0 }),
  runFixture('selection RSS budget exhaustion', {
    'api.ts': "export const target = (): string => 'ok';",
  }, 'api.ts', { maxRssBytes: 1 }),
  runFixture('unresolved package module', {
    'api.ts': "import { value } from 'not-present'; export const target = (): number => value;",
  }, 'api.ts'),
  runFixture('computed dynamic import dependency', {
    'api.ts': "declare const moduleName: string; export async function load() { return import(moduleName); } export const target = (): string => 'ok';",
  }, 'api.ts'),
  runFixture('project-reference dependency omission', {
    'tsconfig.json': JSON.stringify({ references: [{ path: './lib' }] }),
    'api.ts': "export const target = (): string => 'ok';",
    'lib/tsconfig.json': '{}',
    'lib/index.ts': 'export const referenced = 1;',
  }, 'api.ts'),
  runFixture('compiler-lib omission', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { lib: ['ES2022'] } }),
    'api.ts': "export const target = (): Promise<string> => Promise.resolve('ok');",
  }, 'api.ts'),
];

console.log(JSON.stringify({ closureForensicAudit: results }, null, 2));
const unsafe = results.filter(result => result.verdict === 'LIKELY_PRESERVED' || result.verdict === 'LIKELY_VIOLATED');
assert.deepEqual(unsafe, [], `Fail-closed violation(s): ${unsafe.map(result => result.name).join(', ')}`);
