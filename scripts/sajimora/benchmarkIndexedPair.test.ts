import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-benchmark-fixture-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
try {
  git('init'); git('config', 'user.email', 'benchmark@example.invalid'); git('config', 'user.name', 'Benchmark');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true },
    include: ['src/**/*.ts'] }));
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export function api(value: string) { return value; }\n');
  git('add', '.'); git('commit', '-m', 'parent'); const parent = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export function api(value: string | number) { return value; }\n');
  git('add', '.'); git('commit', '-m', 'candidate'); const candidate = git('rev-parse', 'HEAD');
  const output = execFileSync(process.execPath,
    ['scripts/test-runtime/run-tsx-command.cjs', 'scripts/sajimora/benchmarkIndexedPair.ts', root, parent, candidate],
    { cwd: path.resolve('.'), encoding: 'utf8', timeout: 45_000 });
  const result = JSON.parse(output) as { status: string; queryStatus: string;
    stages: Array<{ stage: string; status: string }> };
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.queryStatus, 'COMPLETED');
  assert.deepEqual(result.stages.map(stage => [stage.stage, stage.status]), [
    ['COLD_PARENT', 'PUBLISHED'], ['COLD_CANDIDATE', 'PUBLISHED'],
    ['WARM_PARENT', 'REUSED'], ['WARM_QUERY', 'COMPLETED']
  ]);
  console.log('Indexed pair benchmark harness: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
