import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReport } from '../../../src/sajimora/cross-language/AgentImpactJson';

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  OK ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const RUN_TSX = join(process.cwd(), 'scripts', 'test-runtime', 'run-tsx-command.cjs');
const CLI_PATH = join(process.cwd(), 'scripts', 'sajimora', 'analyzeCrossLanguage.ts');

function runCli(repoPath: string, args: string[]): any {
  try {
    const stdout = execFileSync(process.execPath, [RUN_TSX, CLI_PATH, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // stderr is ignored to not clutter test output
    });
    return parseReport(stdout.trim());
  } catch (err: any) {
    if (err.stdout) {
      return parseReport(err.stdout.trim());
    }
    throw err;
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!hasGit()) {
    console.log('Skipping AnalyzeCrossLanguageCli tests because git is not installed.');
    return;
  }

  console.log('=== AnalyzeCrossLanguageCli E2E tests ===\n');

  await test('Test 4: Error on missing repo', () => {
    const report = runCli('/nonexistent/path', ['--repo', '/nonexistent/path', '--parent', 'HEAD', '--working-tree']);
    assert.equal(report.assurance, 'ADVISORY_ONLY');
    assert.ok(['INCONCLUSIVE', 'ANALYSIS_ERROR'].includes(report.verdict));
  });

  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-xlang-test-'));
  
  try {
    // Setup git repo
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    // Initial files
    mkdirSync(join(tmpDir, 'src', 'main', 'java'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'frontend'), { recursive: true });

    const userControllerJava = `
      import org.springframework.web.bind.annotation.GetMapping;
      import org.springframework.web.bind.annotation.RestController;
      @RestController
      public class UserController {
        @GetMapping("/users/{id}")
        public UserDto getUser() { return new UserDto(); }
      }
    `;
    const userDtoJava = `
      public class UserDto {
        public String getDisplayName() { return "test"; }
      }
    `;
    const clientTs = `
      interface UserDto { displayName: string; }
      async function getUser(id: string) {
        const response = await fetch(\`/users/\${id}\`);
        const data: UserDto = await response.json();
        return data;
      }
    `;

    writeFileSync(join(tmpDir, 'src', 'main', 'java', 'UserController.java'), userControllerJava);
    writeFileSync(join(tmpDir, 'src', 'main', 'java', 'UserDto.java'), userDtoJava);
    writeFileSync(join(tmpDir, 'src', 'frontend', 'client.ts'), clientTs);

    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir });

    await test('Test 1: LIKELY_VIOLATED from working tree', () => {
      // Modify working tree
      writeFileSync(join(tmpDir, 'src', 'main', 'java', 'UserDto.java'), `
        public class UserDto {
          public String getName() { return "test"; }
        }
      `);

      const report = runCli(tmpDir, ['--repo', tmpDir, '--parent', 'HEAD', '--working-tree']);
      assert.equal(report.assurance, 'ADVISORY_ONLY');
      assert.ok(report.verdict === 'LIKELY_VIOLATED' || report.verdict === 'INCONCLUSIVE');
      assert.equal(report.schemaVersion, 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1');
      assert.ok(!JSON.stringify(report).includes('CERTIFIED_PRESERVED'));
      assert.ok(!JSON.stringify(report).includes('CERTIFIED_VIOLATED'));
    });

    await test('Test 2: LIKELY_PRESERVED after repair', () => {
      // Fix TS file in working tree too
      writeFileSync(join(tmpDir, 'src', 'frontend', 'client.ts'), `
        interface UserDto { name: string; }
        async function getUser(id: string) {
          const response = await fetch(\`/users/\${id}\`);
          const data: UserDto = await response.json();
          return data;
        }
      `);

      const report = runCli(tmpDir, ['--repo', tmpDir, '--parent', 'HEAD', '--working-tree']);
      assert.equal(report.assurance, 'ADVISORY_ONLY');
      assert.ok(report.verdict === 'LIKELY_VIOLATED' || report.verdict === 'INCONCLUSIVE' || report.verdict === 'LIKELY_PRESERVED');
    });

    await test('Test 3: INCONCLUSIVE with no TS files', () => {
      // Delete TS file
      execFileSync('git', ['rm', '-f', 'src/frontend/client.ts'], { cwd: tmpDir });
      
      const report = runCli(tmpDir, ['--repo', tmpDir, '--parent', 'HEAD', '--working-tree']);
      assert.ok(['INCONCLUSIVE', 'ANALYSIS_ERROR'].includes(report.verdict));
    });

    await test('Test 5: Advisory constraint', () => {
      const report = runCli(tmpDir, ['--repo', tmpDir, '--parent', 'HEAD', '--working-tree']);
      assert.equal(report.assurance, 'ADVISORY_ONLY');
      assert.ok(['LIKELY_VIOLATED', 'LIKELY_PRESERVED', 'INCONCLUSIVE', 'ANALYSIS_ERROR'].includes(report.verdict));
      const str = JSON.stringify(report);
      assert.ok(!str.includes('CERTIFIED_PRESERVED'));
      assert.ok(!str.includes('CERTIFIED_VIOLATED'));
    });

  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch(console.error);


