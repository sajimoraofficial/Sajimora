const path = require('node:path');
const { spawnSync } = require('node:child_process');

const shim = path.resolve(__dirname, 'windows-userinfo-shim.cjs').replace(/\\/g, '/');
const cli = require.resolve('tsx/cli');
const inheritedOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
const maxOldSpace = inheritedOptions.includes('--max-old-space-size') ? '' : '--max-old-space-size=8192 ';
const nodeOptions = `${maxOldSpace}${inheritedOptions}--require="${shim}"`;

for (const testFile of process.argv.slice(2)) {
  const result = spawnSync(process.execPath, [cli, testFile], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
