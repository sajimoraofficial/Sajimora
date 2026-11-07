/**
 * CrossLanguageSnapshotPair.test.ts
 *
 * PR 1 acceptance tests: snapshot identity, bytes, JSON schema, and CLI skeleton.
 *
 * Run with:
 *   node scripts/test-runtime/run-tsx.cjs \
 *     packages/analysis/tests/sajimora/cross-language/CrossLanguageSnapshotPair.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  ASSURANCE,
  isCrossLanguageImpactReport,
  makeInconclusiveReport,
  makeErrorReport,
  buildFindingId,
  buildWorkingTreeSnapshotId,
  CrossLanguageImpactReport,
  SnapshotIdentity,
} from '../../../src/sajimora/cross-language/CrossLanguageContracts';

import {
  serializeReport,
  parseReport,
  reportFingerprint,
} from '../../../src/sajimora/cross-language/AgentImpactJson';

import {
  captureSnapshotPair,
} from '../../../src/sajimora/cross-language/CrossLanguageSnapshotPair';

import { GitRepository } from '../../../src/sajimora/snapshots/GitRepository';

// ---------------------------------------------------------------------------
// Helper: create a minimal in-memory Git repository for snapshot tests
// ---------------------------------------------------------------------------

function initBareTestRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sajimora-cl-test-'));
  try {
    execFileSync('git', ['-C', root, 'init', '--initial-branch=main'], { stdio: 'pipe' });
  } catch {
    execFileSync('git', ['-C', root, 'init'], { stdio: 'pipe' });
  }
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function commitFiles(root: string, files: Record<string, string>): string {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
  }
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'test'], { stdio: 'pipe' });
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

console.log('=== CrossLanguageSnapshotPair PR-1 tests ===\n');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Run all tests inside a single async IIFE
// ---------------------------------------------------------------------------

void (async () => {

// ---------------------------------------------------------------------------
// 1. CrossLanguageContracts unit tests
// ---------------------------------------------------------------------------

await test('SCHEMA_VERSION is the canonical string', () => {
  assert.equal(SCHEMA_VERSION, 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1');
});

await test('ASSURANCE is ADVISORY_ONLY', () => {
  assert.equal(ASSURANCE, 'ADVISORY_ONLY');
});

await test('isCrossLanguageImpactReport rejects a plain object', () => {
  assert.equal(isCrossLanguageImpactReport({}), false);
  assert.equal(isCrossLanguageImpactReport(null), false);
  assert.equal(isCrossLanguageImpactReport('string'), false);
});

await test('makeInconclusiveReport produces a valid INCONCLUSIVE report', () => {
  const identity: SnapshotIdentity = {
    repositoryId: 'git-root:abc',
    parentCommit: 'aaaaaa',
    candidateSnapshot: 'bbbbbb',
  };
  const report = makeInconclusiveReport({
    repository: identity,
    blockers: [{ code: 'UNRESOLVED_ROUTE', message: 'no route found' }],
  });
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.assurance, ASSURANCE);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.property, 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY');
  assert.equal(report.findings.length, 0);
  assert.equal(report.blockers.length, 1);
  assert.equal(report.blockers[0].code, 'UNRESOLVED_ROUTE');
  assert.equal(report.scope.complete, false);
  assert.ok(isCrossLanguageImpactReport(report));
});

await test('makeErrorReport produces an ANALYSIS_ERROR report', () => {
  const identity: SnapshotIdentity = {
    repositoryId: 'git-root:abc',
    parentCommit: 'aaaaaa',
    candidateSnapshot: 'bbbbbb',
  };
  const report = makeErrorReport({
    repository: identity,
    blockerCode: 'TOOL_FAILURE',
    message: 'Something broke',
  });
  assert.equal(report.verdict, 'ANALYSIS_ERROR');
  assert.equal(report.blockers[0].code, 'TOOL_FAILURE');
  assert.ok(isCrossLanguageImpactReport(report));
});

await test('buildFindingId is deterministic', () => {
  const parts = { method: 'GET', path: '/api/users/{id}', javaFile: 'src/UserController.java', wirePath: '$.displayName' };
  const id1 = buildFindingId(parts);
  const id2 = buildFindingId(parts);
  assert.equal(id1, id2);
  assert.equal(typeof id1, 'string');
  assert.equal(id1.length, 16);
});

await test('buildFindingId differs for different wire paths', () => {
  const base = { method: 'GET', path: '/api/users/{id}', javaFile: 'src/UserController.java' };
  const id1 = buildFindingId({ ...base, wirePath: '$.displayName' });
  const id2 = buildFindingId({ ...base, wirePath: '$.name' });
  assert.notEqual(id1, id2);
});

await test('buildWorkingTreeSnapshotId is deterministic and order-independent', () => {
  const files = [
    { path: 'src/A.java', sha256: 'aaa' },
    { path: 'src/B.ts', sha256: 'bbb' },
  ];
  const id1 = buildWorkingTreeSnapshotId(files);
  const id2 = buildWorkingTreeSnapshotId([...files].reverse());
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('working-tree:'));
});

// ---------------------------------------------------------------------------
// 2. AgentImpactJson tests
// ---------------------------------------------------------------------------

await test('serializeReport produces valid JSON with stable schema fields', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report = makeInconclusiveReport({ repository: identity, blockers: [] });
  const json = serializeReport(report);
  const parsed = JSON.parse(json) as CrossLanguageImpactReport;
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.assurance, ASSURANCE);
  assert.equal(parsed.verdict, 'INCONCLUSIVE');
});

await test('serializeReport is byte-identical for identical reports (determinism)', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report = makeInconclusiveReport({
    repository: identity,
    blockers: [
      { code: 'UNRESOLVED_ROUTE', message: 'z' },
      { code: 'TOOL_FAILURE', message: 'a' },
    ],
  });
  const json1 = serializeReport(report);
  const json2 = serializeReport(report);
  assert.equal(json1, json2, 'Serialization must be deterministic');
});

await test('serializeReport sorts blockers deterministically', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report1 = makeInconclusiveReport({
    repository: identity,
    blockers: [
      { code: 'UNRESOLVED_ROUTE', message: 'a' },
      { code: 'TOOL_FAILURE', message: 'b' },
    ],
  });
  const report2 = makeInconclusiveReport({
    repository: identity,
    blockers: [
      { code: 'TOOL_FAILURE', message: 'b' },
      { code: 'UNRESOLVED_ROUTE', message: 'a' },
    ],
  });
  assert.equal(serializeReport(report1), serializeReport(report2), 'Blocker order must not matter');
});

await test('parseReport round-trips correctly', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report = makeInconclusiveReport({ repository: identity, blockers: [] });
  const json = serializeReport(report);
  const parsed = parseReport(json);
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.verdict, 'INCONCLUSIVE');
});

await test('parseReport throws on malformed JSON', () => {
  assert.throws(() => parseReport('not json'), /JSON parse error/);
});

await test('parseReport throws on wrong schema version', () => {
  const bad = JSON.stringify({
    schemaVersion: 'WRONG',
    assurance: 'ADVISORY_ONLY',
    verdict: 'INCONCLUSIVE',
    property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
    repository: {},
    scope: {},
    findings: [],
    blockers: [],
    counts: {},
  });
  assert.throws(() => parseReport(bad), /does not match expected schema/);
});

await test('reportFingerprint is identical for identical reports', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report = makeInconclusiveReport({ repository: identity, blockers: [] });
  assert.equal(reportFingerprint(report), reportFingerprint(report));
});

await test('reportFingerprint differs for different verdicts', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const r1 = makeInconclusiveReport({ repository: identity, blockers: [] });
  const r2 = makeErrorReport({ repository: identity, blockerCode: 'TOOL_FAILURE', message: 'x' });
  assert.notEqual(reportFingerprint(r1), reportFingerprint(r2));
});

await test('serializeReport redacts Bearer tokens in repair hints and usages', () => {
  const identity: SnapshotIdentity = { repositoryId: 'r', parentCommit: 'p', candidateSnapshot: 'c' };
  const report: CrossLanguageImpactReport = {
    schemaVersion: SCHEMA_VERSION,
    assurance: ASSURANCE,
    verdict: 'LIKELY_VIOLATED',
    property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
    repository: identity,
    scope: { framework: 'SPRING_MVC', codec: 'JACKSON_DEFAULT_V1', client: 'STATIC_FETCH_V1', complete: false },
    findings: [{
      id: 'abc123',
      endpoint: { method: 'GET', path: '/api/users/{id}', javaFile: 'src/UserController.java', line: 10 },
      wirePath: '$.displayName',
      change: { before: 'required string', after: 'missing' },
      typescriptClient: { file: 'src/api.ts', line: 5, expectation: 'string', expectationKind: 'TYPE_ASSERTION' },
      consumers: [{ file: 'src/comp.tsx', line: 12, usage: 'user.displayName Bearer abc123secret' }],
      evidence: [],
      repairHint: 'Fix the field Bearer xyz987secret here',
    }],
    blockers: [],
    counts: { changedEndpoints: 1, linkedEndpoints: 1, affectedConsumers: 1, unresolvedLinks: 0 },
  };
  const json = serializeReport(report);
  assert.ok(!json.includes('abc123secret'), 'Bearer token in usage should be redacted');
  assert.ok(!json.includes('xyz987secret'), 'Bearer token in hint should be redacted');
  assert.ok(json.includes('[REDACTED]'), 'Redacted placeholder must appear');
});

// ---------------------------------------------------------------------------
// 3. Snapshot pair tests using a real temporary Git repository
// ---------------------------------------------------------------------------

await test('captureSnapshotPair (committed candidate): identity and changed paths', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, {
      'backend/UserController.java': 'public class UserController { public String displayName; }',
      'frontend/api.ts': "export async function getUser() { return fetch('/api/users/1').then(r => r.json()); }",
    });

    writeFileSync(join(root, 'backend/UserController.java'), 'public class UserController { public String name; }', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '-m', 'rename field'], { stdio: 'pipe' });
    const candidateSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();

    const repo = new GitRepository(root);
    const pair = await captureSnapshotPair({
      repository: repo,
      parentCommit: parentSha,
      candidate: { kind: 'commit', sha: candidateSha },
    });

    assert.equal(pair.identity.parentCommit, parentSha);
    assert.equal(pair.identity.candidateSnapshot, candidateSha);
    assert.ok(pair.identity.repositoryId.startsWith('git-root:'), 'Repository ID must be stable');
    assert.ok(pair.changedPaths.modified.includes('backend/UserController.java'), 'Java file must be in modified list');
    assert.equal(pair.changedPaths.modified.length, 1, 'Only the Java file changed');
    assert.equal(pair.blockers.length, 0, 'No blockers for a clean pair');

    const parentFile = pair.parentFiles.get('backend/UserController.java');
    const candidateFile = pair.candidateFiles.get('backend/UserController.java');
    assert.ok(parentFile, 'Parent Java file must be captured');
    assert.ok(candidateFile, 'Candidate Java file must be captured');
    assert.ok(parentFile.bytes.toString('utf8').includes('displayName'));
    assert.ok(candidateFile.bytes.toString('utf8').includes('public String name'));
    assert.notEqual(parentFile.sha256, candidateFile.sha256, 'SHA-256 must differ after edit');
  } finally {
    cleanup();
  }
});

await test('captureSnapshotPair: identical reruns produce identical identity', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, { 'A.java': 'class A {}' });
    const candidateSha = commitFiles(root, { 'A.java': 'class A { int x; }' });

    const repo = new GitRepository(root);
    const pair1 = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'commit', sha: candidateSha } });
    const pair2 = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'commit', sha: candidateSha } });

    assert.equal(pair1.identity.repositoryId, pair2.identity.repositoryId);
    assert.equal(pair1.identity.parentCommit, pair2.identity.parentCommit);
    assert.equal(pair1.identity.candidateSnapshot, pair2.identity.candidateSnapshot);
    assert.deepEqual(pair1.changedPaths, pair2.changedPaths);
  } finally {
    cleanup();
  }
});

await test('captureSnapshotPair: added and deleted files are tracked', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, {
      'keep.java': 'class Keep {}',
      'delete.java': 'class Delete {}',
    });
    writeFileSync(join(root, 'new.ts'), 'export const x = 1;', 'utf8');
    rmSync(join(root, 'delete.java'));
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '-m', 'add and delete'], { stdio: 'pipe' });
    const candidateSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();

    const repo = new GitRepository(root);
    const pair = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'commit', sha: candidateSha } });

    assert.ok(pair.changedPaths.added.includes('new.ts'), 'Added TS file must be tracked');
    assert.ok(pair.changedPaths.deleted.includes('delete.java'), 'Deleted Java file must be tracked');
    assert.equal(pair.changedPaths.modified.length, 0, 'No modified files');
  } finally {
    cleanup();
  }
});

await test('captureSnapshotPair: working-tree capture has deterministic ID', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, { 'A.java': 'class A {}' });
    // Modify without committing
    writeFileSync(join(root, 'A.java'), 'class A { int x; }', 'utf8');

    const repo = new GitRepository(root);
    const pair = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'working-tree' } });

    assert.ok(pair.identity.candidateSnapshot.startsWith('working-tree:'), 'Working-tree ID must have prefix');
    assert.ok(pair.changedPaths.modified.includes('A.java'), 'Modified file must be tracked');
    assert.equal(pair.blockers.length, 0, 'No blockers for a clean working-tree capture');
  } finally {
    cleanup();
  }
});

await test('captureSnapshotPair (no changes): changedPaths are all empty', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, { 'A.java': 'class A {}' });
    // Same commit for both parent and candidate
    const repo = new GitRepository(root);
    const pair = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'commit', sha: parentSha } });

    assert.equal(pair.changedPaths.added.length, 0);
    assert.equal(pair.changedPaths.deleted.length, 0);
    assert.equal(pair.changedPaths.modified.length, 0);
  } finally {
    cleanup();
  }
});

await test('captureSnapshotPair: CRLF working-tree checkout does not trigger false modified', async () => {
  const { root, cleanup } = initBareTestRepo();
  try {
    const parentSha = commitFiles(root, { 'A.java': 'class A {\n  int x;\n}\n' });
    // Write working tree file with CRLF
    writeFileSync(join(root, 'A.java'), 'class A {\r\n  int x;\r\n}\r\n', 'utf8');

    const repo = new GitRepository(root);
    const pair = await captureSnapshotPair({ repository: repo, parentCommit: parentSha, candidate: { kind: 'working-tree' } });

    assert.equal(pair.changedPaths.modified.length, 0, 'CRLF checkout must not be marked as modified');
    assert.equal(pair.blockers.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

})();
