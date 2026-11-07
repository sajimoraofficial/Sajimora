import * as path from 'node:path';
import * as fs from 'node:fs';
import { CommandIO } from './command';
import { SajimoraExecutionError } from './errors';

export interface InitHookOptions {
  repo?: string;
}

export function runInitHookCommand(
  options: InitHookOptions = {},
  io: CommandIO = { stdout: (t: string) => process.stdout.write(t), stderr: (t: string) => process.stderr.write(t) }
): void {
  const repoRoot = path.resolve(options.repo ?? process.cwd());
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new SajimoraExecutionError(`Not a git repository: ${repoRoot}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }

  const huskyDir = path.join(repoRoot, '.husky');
  let targetHookPath: string;
  let manager: 'husky' | 'git';

  if (fs.existsSync(huskyDir) && fs.statSync(huskyDir).isDirectory()) {
    targetHookPath = path.join(huskyDir, 'pre-push');
    manager = 'husky';
  } else {
    const gitHooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(gitHooksDir)) {
      fs.mkdirSync(gitHooksDir, { recursive: true });
    }
    targetHookPath = path.join(gitHooksDir, 'pre-push');
    manager = 'git';
  }

  const hookContent = `#!/bin/sh
# Sajimora Pre-Push Guard: In-Repo Breaking Change Interception
# Offline safe: uses local node_modules/.bin/sajimora, never network npx.
# To evaluate cross-language downstream impact, configure contracts.frontend in sajimora.config.json.

if [ -f "./node_modules/.bin/sajimora" ]; then
  ./node_modules/.bin/sajimora analyze || exit 1
elif command -v sajimora >/dev/null 2>&1; then
  sajimora analyze || exit 1
else
  echo "[sajimora] Warning: sajimora binary not found in node_modules or PATH. Skipping pre-push check." >&2
fi
`;

  if (fs.existsSync(targetHookPath)) {
    const existing = fs.readFileSync(targetHookPath, 'utf8');
    if (existing.includes('sajimora analyze')) {
      io.stdout(`Sajimora pre-push hook is already installed at ${targetHookPath}\n`);
      return;
    }
    fs.appendFileSync(targetHookPath, '\n' + hookContent);
  } else {
    fs.writeFileSync(targetHookPath, hookContent, { mode: 0o755 });
  }

  try {
    fs.chmodSync(targetHookPath, 0o755);
  } catch {
    // Ignore chmod errors on Windows
  }

  io.stdout(`Installed Sajimora pre-push hook (${manager}) at ${targetHookPath}\n`);
}
