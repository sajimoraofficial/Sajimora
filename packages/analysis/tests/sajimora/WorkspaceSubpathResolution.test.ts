import * as assert from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import { TypeScriptProgramBuilder, TypeScriptSnapshotInput } from '../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder';

let passed = 0;
let failed = 0;

function runCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('================================================================');
console.log('WorkspaceSubpathResolution (Category A Recovery) Suite');
console.log('================================================================\n');

let tmpDir: string = '';

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-test-ws-subpath-'));
}

function cleanup() {
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function writeFiles(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function getResolvedModuleFromSf(sf: ts.SourceFile, moduleText: string): ts.ResolvedModuleFull | undefined {
  if (!sf) return undefined;
  if (typeof (ts as any).getResolvedModule === 'function') {
    return (ts as any).getResolvedModule(sf, moduleText, undefined);
  }
  const resMap = (sf as any).resolvedModules;
  if (resMap && typeof resMap.get === 'function') {
    return resMap.get(moduleText);
  }
  return undefined;
}

runCase('Case 1: Redirects @workspace/pkg/dist/foo to tracked pkg/src/foo.ts', () => {
  setup();
  try {
    writeFiles({
      'packages/pkg/package.json': JSON.stringify({ name: '@workspace/pkg', main: 'dist/index.js' }),
      'packages/pkg/src/foo.ts': 'export const foo = "hello";',
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }),
      'consumer/index.ts': 'import { foo } from "@workspace/pkg/dist/foo"; console.log(foo);'
    });

    const trackedFiles = [
      'packages/pkg/package.json',
      'packages/pkg/src/foo.ts',
      'consumer/tsconfig.json',
      'consumer/index.ts'
    ];

    const input: TypeScriptSnapshotInput = {
      root: tmpDir,
      trackedFiles,
      revision: { repositoryId: 'test-repo', commitSha: '1111111111111111111111111111111111111111' },
      toolchain: { compiler: { name: 'typescript', version: '1.0' }, repositoryDeclaredVersion: '1.0', mismatch: 'MATCH' },
      adapterId: 'ts-adapter',
      adapterVersion: '1.0'
    };

    const builder = new TypeScriptProgramBuilder();
    const result = builder.build(input);

    const consumerProg = result.projects.find(p => p.identity.configFile === 'consumer/tsconfig.json')?.program;
    assert.ok(consumerProg, 'Consumer program must build');

    const sf = consumerProg.getSourceFile(path.join(tmpDir, 'consumer/index.ts'));
    assert.ok(sf, 'Source file consumer/index.ts must exist');

    const targetSf = consumerProg.getSourceFiles().find(s => s.fileName.replace(/\\/g, '/').endsWith('packages/pkg/src/foo.ts'));
    assert.ok(targetSf, 'Target source file packages/pkg/src/foo.ts must be included in program via module resolution');

    const resolved = getResolvedModuleFromSf(sf, '@workspace/pkg/dist/foo');
    if (resolved) {
      assert.strictEqual(
        resolved.resolvedFileName.replace(/\\/g, '/'),
        path.join(tmpDir, 'packages/pkg/src/foo.ts').replace(/\\/g, '/')
      );
    }
  } finally {
    cleanup();
  }
});

runCase('Case 2: Redirects @workspace/pkg/lib/bar to tracked pkg/src/bar.ts when valid', () => {
  setup();
  try {
    writeFiles({
      'packages/pkg/package.json': JSON.stringify({ name: '@workspace/pkg', main: 'lib/index.js' }),
      'packages/pkg/src/bar.ts': 'export const bar = 123;',
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }),
      'consumer/index.ts': 'import { bar } from "@workspace/pkg/lib/bar";'
    });

    const trackedFiles = [
      'packages/pkg/package.json',
      'packages/pkg/src/bar.ts',
      'consumer/tsconfig.json',
      'consumer/index.ts'
    ];

    const input: TypeScriptSnapshotInput = {
      root: tmpDir,
      trackedFiles,
      revision: { repositoryId: 'test-repo', commitSha: '1111111111111111111111111111111111111111' },
      toolchain: { compiler: { name: 'typescript', version: '1.0' }, repositoryDeclaredVersion: '1.0', mismatch: 'MATCH' },
      adapterId: 'ts-adapter',
      adapterVersion: '1.0'
    };

    const builder = new TypeScriptProgramBuilder();
    const result = builder.build(input);

    const consumerProg = result.projects.find(p => p.identity.configFile === 'consumer/tsconfig.json')?.program;
    assert.ok(consumerProg);

    const sf = consumerProg.getSourceFile(path.join(tmpDir, 'consumer/index.ts'));
    assert.ok(sf);

    const targetSf = consumerProg.getSourceFiles().find(s => s.fileName.replace(/\\/g, '/').endsWith('packages/pkg/src/bar.ts'));
    assert.ok(targetSf, 'Target source file packages/pkg/src/bar.ts must be included in program via module resolution');

    const resolved = getResolvedModuleFromSf(sf, '@workspace/pkg/lib/bar');
    if (resolved) {
      assert.strictEqual(
        resolved.resolvedFileName.replace(/\\/g, '/'),
        path.join(tmpDir, 'packages/pkg/src/bar.ts').replace(/\\/g, '/')
      );
    }
  } finally {
    cleanup();
  }
});

runCase('Case 3: Leaves missing source unresolved (fails closed)', () => {
  setup();
  try {
    writeFiles({
      'packages/pkg/package.json': JSON.stringify({ name: '@workspace/pkg' }),
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }),
      'consumer/index.ts': 'import { missing } from "@workspace/pkg/dist/missing";'
    });

    const trackedFiles = [
      'packages/pkg/package.json',
      'consumer/tsconfig.json',
      'consumer/index.ts'
    ];

    const input: TypeScriptSnapshotInput = {
      root: tmpDir,
      trackedFiles,
      revision: { repositoryId: 'test-repo', commitSha: '1111111111111111111111111111111111111111' },
      toolchain: { compiler: { name: 'typescript', version: '1.0' }, repositoryDeclaredVersion: '1.0', mismatch: 'MATCH' },
      adapterId: 'ts-adapter',
      adapterVersion: '1.0'
    };

    const builder = new TypeScriptProgramBuilder();
    const result = builder.build(input);

    const consumerProg = result.projects.find(p => p.identity.configFile === 'consumer/tsconfig.json')?.program;
    assert.ok(consumerProg);

    const targetSf = consumerProg.getSourceFiles().find(s => s.fileName.replace(/\\/g, '/').endsWith('missing.ts'));
    assert.strictEqual(targetSf, undefined, 'Missing source must NOT be included in program');
  } finally {
    cleanup();
  }
});

runCase('Case 4: Never redirects external npm packages (monaco-editor, react)', () => {
  setup();
  try {
    writeFiles({
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }),
      'consumer/index.ts': 'import { editor } from "monaco-editor/dist/editor";'
    });

    const trackedFiles = [
      'consumer/tsconfig.json',
      'consumer/index.ts'
    ];

    const input: TypeScriptSnapshotInput = {
      root: tmpDir,
      trackedFiles,
      revision: { repositoryId: 'test-repo', commitSha: '1111111111111111111111111111111111111111' },
      toolchain: { compiler: { name: 'typescript', version: '1.0' }, repositoryDeclaredVersion: '1.0', mismatch: 'MATCH' },
      adapterId: 'ts-adapter',
      adapterVersion: '1.0'
    };

    const builder = new TypeScriptProgramBuilder();
    const result = builder.build(input);

    const consumerProg = result.projects.find(p => p.identity.configFile === 'consumer/tsconfig.json')?.program;
    assert.ok(consumerProg);

    const targetSf = consumerProg.getSourceFiles().find(s => s.fileName.includes('monaco-editor'));
    assert.strictEqual(targetSf, undefined, 'External npm package must NOT be redirected');
  } finally {
    cleanup();
  }
});

runCase('Case 5: Leaves unrelated package paths unchanged', () => {
  setup();
  try {
    writeFiles({
      'packages/pkg/package.json': JSON.stringify({ name: '@workspace/pkg' }),
      'packages/pkg/src/other.ts': 'export const other = 1;',
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }),
      'consumer/index.ts': 'import { x } from "@workspace/pkg/unrelated/path";'
    });

    const trackedFiles = [
      'packages/pkg/package.json',
      'packages/pkg/src/other.ts',
      'consumer/tsconfig.json',
      'consumer/index.ts'
    ];

    const input: TypeScriptSnapshotInput = {
      root: tmpDir,
      trackedFiles,
      revision: { repositoryId: 'test-repo', commitSha: '1111111111111111111111111111111111111111' },
      toolchain: { compiler: { name: 'typescript', version: '1.0' }, repositoryDeclaredVersion: '1.0', mismatch: 'MATCH' },
      adapterId: 'ts-adapter',
      adapterVersion: '1.0'
    };

    const builder = new TypeScriptProgramBuilder();
    const result = builder.build(input);

    const consumerProg = result.projects.find(p => p.identity.configFile === 'consumer/tsconfig.json')?.program;
    assert.ok(consumerProg);

    const targetSf = consumerProg.getSourceFiles().find(s => s.fileName.replace(/\\/g, '/').endsWith('unrelated/path.ts'));
    assert.strictEqual(targetSf, undefined, 'Unrelated path must remain unresolved');
  } finally {
    cleanup();
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
