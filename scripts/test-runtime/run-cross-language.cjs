const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'packages/analysis/tests/sajimora/cross-language');
const suites = fs.readdirSync(directory).filter(file => file.endsWith('.test.ts')).sort().map(file => path.join(directory, file));
const vitest = suites.filter(file => /from\s+['"]vitest['"]/.test(fs.readFileSync(file, 'utf8')));
const standalone = suites.filter(file => !vitest.includes(file));
standalone.push(path.join(root, 'packages/analysis/tests/sajimora/TypeScriptContractParserFixes.test.ts'));
for (const args of [
  [path.join(__dirname, 'run-tsx.cjs'), ...standalone],
  [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...vitest],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
