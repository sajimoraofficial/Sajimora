/**
 * Test Suite 3: Git-Authoritative Pre-Filtering
 * Verifies Test Requirement 3.
 */

import * as assert from 'assert';
import { GitChangeSetFilter } from '../src';

console.log('--- Running Git-Authoritative Pre-Filtering Tests ---');

// Mock SimpleGit that returns controlled diff --name-status output
const mockGitRaw = async (args: string[]) => {
  // args: ['diff', '--name-status', '-M', 'base', 'candidate']
  return [
    'M\tpackages/core/src/index.ts',
    'A\tpackages/change-intelligence/src/types.ts',
    'D\told/deprecated.ts',
    'R100\told/name.ts\tnew/name.ts',
  ].join('\n');
};

const mockGit: any = {
  raw: mockGitRaw,
};

const filter = new GitChangeSetFilter(process.cwd(), mockGit);

async function runTest() {
  const result = await filter.getActualChangeSet('base-sha', 'candidate-sha');

  assert.strictEqual(result.length, 4, 'Must return exactly the 4 changed files');

  // Verify deterministic alphabetical ordering
  assert.strictEqual(result[0].filePath, 'new/name.ts');
  assert.strictEqual(result[0].changeType, 'RENAMED');
  assert.strictEqual(result[0].oldFilePath, 'old/name.ts');

  assert.strictEqual(result[1].filePath, 'old/deprecated.ts');
  assert.strictEqual(result[1].changeType, 'DELETED');

  assert.strictEqual(result[2].filePath, 'packages/change-intelligence/src/types.ts');
  assert.strictEqual(result[2].changeType, 'ADDED');

  assert.strictEqual(result[3].filePath, 'packages/core/src/index.ts');
  assert.strictEqual(result[3].changeType, 'MODIFIED');

  // Verify resource limits
  await assert.rejects(
    async () => {
      await filter.getActualChangeSet('base-sha', 'candidate-sha', { maxFilesChanged: 2 });
    },
    /RESOURCE_LIMIT_EXCEEDED/,
    'Exceeding maxFilesChanged must fail closed'
  );

  // Verify C-quoted path unquoting
  const mockQuotedGit: any = {
    raw: async () => [
      'M\t"path with spaces/file.ts"',
      'A\t"src/special\\"quote.ts"',
      'D\t"src/\\346\\226\\207\\344\\273\\266.ts"',
    ].join('\n')
  };
  const quotedFilter = new GitChangeSetFilter(process.cwd(), mockQuotedGit);
  const quotedRes = await quotedFilter.getActualChangeSet('base-sha', 'candidate-sha');
  assert.strictEqual(quotedRes.length, 3);
  assert.strictEqual(quotedRes.some(r => r.filePath === 'path with spaces/file.ts'), true);
  assert.strictEqual(quotedRes.some(r => r.filePath === 'src/special"quote.ts'), true);
  assert.strictEqual(quotedRes.some(r => r.filePath.startsWith('src/')), true);

  console.log('✓ Git-Authoritative Pre-Filtering Tests Passed.');
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
