import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineTargetResolver } from '../src/OfflineTargetResolver';
import { resolveCanonicalRepositoryPath } from '../src/pathResolver';

function runTargetResolverTests() {
  console.log('=== RUNNING TARGET RESOLVER TESTS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-resolver-test-'));

  try {
    fs.mkdirSync(path.join(tempDir, 'src/sub1'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/sub2'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages/core/src'), { recursive: true });

    // Fixtures: note file name service_a.ts with exported class ServiceA and CustomWorker
    fs.writeFileSync(path.join(tempDir, 'src/sub1/service_a.ts'), 'export class CustomWorker {}');
    fs.writeFileSync(path.join(tempDir, 'src/sub2/Helper.ts'), 'export function helperUtil() {}');
    fs.writeFileSync(path.join(tempDir, 'src/sub1/types.ts'), 'export interface SharedType {}');
    fs.writeFileSync(path.join(tempDir, 'src/sub2/types.ts'), 'export type AnotherType = string;');
    fs.writeFileSync(path.join(tempDir, 'packages/core/src/index.ts'), 'export const CORE_VERSION = "1.0.0";');

    const resolver = new OfflineTargetResolver({ repoRoot: tempDir });

    // Test 1: Exact Relative Path
    {
      const res = resolver.resolveTarget('src/sub1/service_a.ts');
      assert.strictEqual(res.status, 'RESOLVED');
      assert.strictEqual(res.targetKind, 'FILE');
      assert.strictEqual(res.node, 'src/sub1/service_a.ts');
      console.log('[PASS] Exact path resolved ->', res.node);
    }

    // Test 2: Unique Basename Resolution
    {
      const res = resolver.resolveTarget('Helper.ts');
      assert.strictEqual(res.status, 'RESOLVED');
      assert.strictEqual(res.targetKind, 'FILE');
      assert.strictEqual(res.node, 'src/sub2/Helper.ts');
      console.log('[PASS] Unique basename resolved ->', res.node);
    }

    // Test 3: Package Identifier Resolution
    {
      const res = resolver.resolveTarget('@sajimora/core');
      assert.strictEqual(res.status, 'RESOLVED');
      assert.strictEqual(res.targetKind, 'PACKAGE');
      assert.strictEqual(res.node, 'packages/core/src/index.ts');
      console.log('[PASS] Package identifier resolved ->', res.node);
    }

    // Test 4: Unique Exported Symbol Resolution
    {
      const res = resolver.resolveTarget('CustomWorker');
      assert.strictEqual(res.status, 'RESOLVED');
      assert.strictEqual(res.targetKind, 'SYMBOL');
      assert.strictEqual(res.node, 'src/sub1/service_a.ts');
      assert.strictEqual(res.symbol, 'CustomWorker');
      console.log('[PASS] Unique symbol resolved ->', res.node, '(Symbol: CustomWorker)');
    }

    // Test 5: Ambiguity Surfacing (Zero-Trust Invariant)
    {
      const res = resolver.resolveTarget('types.ts');
      assert.strictEqual(res.status, 'AMBIGUOUS');
      assert.ok(res.candidates && res.candidates.length === 2);
      console.log('[PASS] Ambiguity correctly surfaced for types.ts with 2 candidates (no silent winner)');
    }

    // Test 6: Target Not Found Handling
    {
      const res = resolver.resolveTarget('NonExistentEntityXYZ');
      assert.strictEqual(res.status, 'NOT_FOUND');
      assert.ok(res.closestMatches);
      console.log('[PASS] Non-existent target correctly returned NOT_FOUND');
    }

    // Test 7: Unreadable declaring files must surface blocker and not permanently assert non-existence
    {
      const unreadableResolver = new OfflineTargetResolver({ repoRoot: tempDir });
      // Inject a file path that cannot be read
      (unreadableResolver as any).allRepoFiles.push('non_existent/ghost.ts');
      const res = unreadableResolver.resolveTarget('GhostSymbol');
      assert.strictEqual(res.status, 'NOT_FOUND');
      assert.ok(res.blockers && res.blockers.length > 0, 'Must surface UNREADABLE_FILES_DURING_RESOLUTION blocker');
      assert.strictEqual(res.blockers[0].code, 'UNREADABLE_FILES_DURING_RESOLUTION');
      assert.ok(unreadableResolver.unreadableFiles.includes('non_existent/ghost.ts'));
      console.log('[PASS] Unreadable file surfaced blocker during target resolution');
    }

    // Test 8: Path containment boundary checks (Prefix collisions like app vs app-shared)
    {
      const fakeAppRoot = path.join(tempDir, 'app');
      const fakeAppShared = path.join(tempDir, 'app-shared');
      fs.mkdirSync(fakeAppRoot, { recursive: true });
      fs.mkdirSync(fakeAppShared, { recursive: true });
      const insideFile = path.join(fakeAppRoot, 'inside.ts');
      const outsideFile = path.join(fakeAppShared, 'outside.ts');
      fs.writeFileSync(insideFile, 'export const x = 1;');
      fs.writeFileSync(outsideFile, 'export const y = 2;');

      const insideRes = resolveCanonicalRepositoryPath(insideFile, fakeAppRoot);
      assert.strictEqual(insideRes.accepted, true);
      assert.strictEqual(insideRes.normalizedRelativePath, 'inside.ts');

      const prefixCollisionRes = resolveCanonicalRepositoryPath(outsideFile, fakeAppRoot);
      assert.strictEqual(prefixCollisionRes.accepted, false);
      assert.strictEqual(prefixCollisionRes.rejectionReason, 'Path escapes repository boundary');

      const traversalRes = resolveCanonicalRepositoryPath('../outside.ts', fakeAppRoot);
      assert.strictEqual(traversalRes.accepted, false);
      assert.strictEqual(traversalRes.rejectionReason, 'Path escapes repository boundary');
      console.log('[PASS] Path containment correctly isolates repository boundaries without prefix leakage');
    }

    console.log('\nTarget Resolver Tests: ALL PASSED\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runTargetResolverTests();
