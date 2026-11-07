import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { VirtualDependencyResolver } from '../../src/sajimora/languages/typescript/programs/VirtualDependencyResolver';

function runTests() {
  console.log('================================================================');
  console.log('Testing VirtualDependencyResolver & Symlink Sandbox Boundary');
  console.log('================================================================');

  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-vdep-test-'));
  const realRepo = path.join(testTmp, 'repo');
  const snapshot = path.join(testTmp, 'snapshot');
  const outsideDir = path.join(testTmp, 'outside-sandbox');

  const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));

  try {
    fs.mkdirSync(realRepo, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // 1. Setup real repository workspace structure
    // packages/core
    const coreDir = path.join(realRepo, 'packages', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'index.d.ts'), 'export declare const coreVal: number;', 'utf8');

    // packages/client with local node_modules
    const clientDir = path.join(realRepo, 'packages', 'client');
    const clientNodeModules = path.join(clientDir, 'node_modules');
    fs.mkdirSync(clientNodeModules, { recursive: true });

    // External dependency: lodash in client node_modules
    const lodashDir = path.join(clientNodeModules, 'lodash');
    fs.mkdirSync(lodashDir, { recursive: true });
    fs.writeFileSync(path.join(lodashDir, 'index.d.ts'), 'export declare function get(): void;', 'utf8');

    // Shared tsconfig in root node_modules
    const rootNodeModules = path.join(realRepo, 'node_modules', '@repo', 'tsconfig');
    fs.mkdirSync(rootNodeModules, { recursive: true });
    fs.writeFileSync(path.join(rootNodeModules, 'base.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');

    // 2. Setup internal workspace symlink: client/node_modules/@internal/core -> packages/core
    const internalScopeDir = path.join(clientNodeModules, '@internal');
    fs.mkdirSync(internalScopeDir, { recursive: true });
    const coreSymlink = path.join(internalScopeDir, 'core');
    try {
      fs.symlinkSync(coreDir, coreSymlink, 'junction');
    } catch {
      // If junction/symlink fails on Windows without elevation, directory junction works
      fs.symlinkSync(coreDir, coreSymlink, 'dir');
    }

    // 3. Setup hostile symlink pointing outside realRepoRoot: client/node_modules/escape -> outsideDir
    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_OUTSIDE_DATA', 'utf8');
    const hostileSymlink = path.join(clientNodeModules, 'escape');
    try {
      fs.symlinkSync(outsideDir, hostileSymlink, 'junction');
    } catch {
      fs.symlinkSync(outsideDir, hostileSymlink, 'dir');
    }

    // 4. Instantiate VirtualDependencyResolver
    const resolver = new VirtualDependencyResolver({
      snapshotRoot: snapshot,
      libRoot,
      dependencyRoot: path.join(realRepo, 'node_modules')
    });

    // TEST 1: Workspace-local nested node_modules mapping
    const virtualLodash = path.join(snapshot, 'packages', 'client', 'node_modules', 'lodash', 'index.d.ts');
    assert.strictEqual(resolver.isAllowed(virtualLodash), true, 'Local workspace dependency must be allowed');
    assert.strictEqual(resolver.fileExists(virtualLodash), true, 'Local workspace dependency must exist');
    assert.strictEqual(resolver.readFile(virtualLodash), 'export declare function get(): void;', 'Must read local dependency');
    console.log('  ✅ PASS: Workspace-local nested node_modules mapped and readable');

    // TEST 2: Internal workspace symlink within realRepoRoot
    const virtualInternalCore = path.join(snapshot, 'packages', 'client', 'node_modules', '@internal', 'core', 'index.d.ts');
    assert.strictEqual(resolver.isAllowed(virtualInternalCore), true, 'Internal workspace symlink must be allowed');
    assert.strictEqual(resolver.fileExists(virtualInternalCore), true, 'Internal workspace symlink target must exist');
    assert.strictEqual(resolver.readFile(virtualInternalCore), 'export declare const coreVal: number;', 'Must read through internal workspace symlink');
    console.log('  ✅ PASS: Internal workspace symlink permitted and verified');

    // TEST 3 (CRITICAL): Hostile Sandbox Boundary Enforcement
    const virtualEscape = path.join(snapshot, 'packages', 'client', 'node_modules', 'escape', 'secret.txt');
    const isEscapeAllowed = resolver.isAllowed(virtualEscape);
    assert.strictEqual(isEscapeAllowed, false, 'Symlink escaping realRepoRoot MUST be blocked');
    const escapeContent = resolver.readFile(virtualEscape);
    assert.strictEqual(escapeContent, undefined, 'Reading through escaping symlink must return undefined');
    assert.strictEqual(resolver.fileExists(virtualEscape), false, 'Escaping symlink must report non-existent to host');
    console.log('  ✅ PASS: Hostile symlink escaping realRepoRoot strictly blocked');

    // TEST 4: parseHost tsconfig extends resolution
    const parseHost = resolver.createParseConfigHost();
    const virtualBaseConfig = path.join(snapshot, 'node_modules', '@repo', 'tsconfig', 'base.json');
    assert.strictEqual(parseHost.fileExists(virtualBaseConfig), true, 'parseHost must resolve shared tsconfig');
    const configContent = parseHost.readFile(virtualBaseConfig);
    assert.ok(configContent && configContent.includes('compilerOptions'), 'parseHost must read shared tsconfig');
    console.log('  ✅ PASS: parseHost resolves shared tsconfig in node_modules');

    // TEST 5: Provenance recording
    const provenance = new Map<string, string>();
    resolver.recordProvenance(virtualLodash, provenance);
    assert.strictEqual(provenance.get('<dependency-store>/packages/client/node_modules/lodash/index.d.ts'), 'EXTERNAL_DECLARATION');
    console.log('  ✅ PASS: External dependency provenance recorded correctly');

    console.log('\nAll VirtualDependencyResolver tests passed successfully!');
  } finally {
    fs.rmSync(testTmp, { recursive: true, force: true });
  }
}

runTests();
