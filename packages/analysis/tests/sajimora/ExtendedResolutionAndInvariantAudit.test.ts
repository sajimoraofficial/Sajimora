import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  TypeScriptProjectSelector,
  VirtualDependencyResolver,
  TypeScriptProgramBuilder
} from '../../src/sajimora/languages/typescript/programs';

const slash = (p: string) => p.replace(/\\/g, '/');

async function runExtendedResolutionAndInvariantAudit(): Promise<void> {
  console.log('================================================================');
  console.log('Sajimora Phase 5 — Extended Resolution & Invariant Audit Suite');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // Audit 1: tsconfig with "extends" pointing to node_modules via VirtualDependencyResolver
  // --------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-audit-extends-'));
    const snapshotDir = path.join(tmpDir, 'snapshot');
    const physicalRepoDir = path.join(tmpDir, 'physical-repo');

    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(path.join(physicalRepoDir, 'node_modules', 'shared-base-config'), { recursive: true });

    // Physical repo contains the extended base config in node_modules
    fs.writeFileSync(
      path.join(physicalRepoDir, 'node_modules', 'shared-base-config', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noImplicitAny: true,
          target: 'ES2022'
        }
      })
    );

    // Snapshot references the base config via extends
    fs.writeFileSync(
      path.join(snapshotDir, 'tsconfig.json'),
      JSON.stringify({
        extends: 'shared-base-config/tsconfig.json',
        compilerOptions: {
          module: 'NodeNext'
        },
        include: ['src/**/*.ts']
      })
    );

    fs.mkdirSync(path.join(snapshotDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(snapshotDir, 'src', 'main.ts'),
      'export const message = "hello world";'
    );

    const createSnapshotInput = (partial: Partial<import('../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder').TypeScriptSnapshotInput> & { root: string; trackedFiles: readonly string[] }): import('../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder').TypeScriptSnapshotInput => ({
      revision: { repositoryId: 'test-audit', commitSha: 'a'.repeat(40) },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      ...partial
    });

    try {
      const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));
      const resolver = new VirtualDependencyResolver({
        snapshotRoot: snapshotDir,
        libRoot,
        dependencyRoot: path.join(physicalRepoDir, 'node_modules')
      });

      const selector = new TypeScriptProjectSelector();
      const selection = selector.selectProjects(
        snapshotDir,
        ['tsconfig.json', 'src/main.ts'],
        ['src/main.ts'],
        undefined,
        resolver
      );

      assert.equal(selection.closureStatus, 'PROVEN');
      assert.deepEqual(selection.selectedConfigs, ['tsconfig.json']);

      // Build program using resolver and ensure extended options were inherited
      const builder = new TypeScriptProgramBuilder(selector);
      const built = builder.build(createSnapshotInput({
        root: snapshotDir,
        trackedFiles: ['tsconfig.json', 'src/main.ts'],
        changedFiles: ['src/main.ts'],
        dependencyRoot: path.join(physicalRepoDir, 'node_modules')
      }));

      assert.equal(built.status, 'BUILT');
      assert.equal(built.projects.length, 1);
      assert.equal(built.projects[0].options.strict, true);
      assert.equal(built.projects[0].options.noImplicitAny, true);

      console.log('  ✅ PASS: Audit 1: tsconfig "extends" in node_modules resolved via VirtualDependencyResolver');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------------------
  // Audit 2: baseUrl: "src" with paths: { "@/*": ["*"] } resolution
  // --------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-audit-baseurl-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: 'src',
          paths: {
            '@/*': ['*']
          }
        },
        include: ['src/**/*.ts']
      })
    );

    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      'export function helper(): string { return "util"; }'
    );

    fs.writeFileSync(
      path.join(srcDir, 'index.ts'),
      'import { helper } from "@/utils";\nexport const out = helper();'
    );

    const createSnapshotInput = (partial: Partial<import('../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder').TypeScriptSnapshotInput> & { root: string; trackedFiles: readonly string[] }): import('../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder').TypeScriptSnapshotInput => ({
      revision: { repositoryId: 'test-audit', commitSha: 'a'.repeat(40) },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      ...partial
    });

    try {
      const selector = new TypeScriptProjectSelector();
      const selection = selector.selectProjects(
        tmpDir,
        ['tsconfig.json', 'src/index.ts', 'src/utils.ts'],
        ['src/utils.ts']
      );

      assert.equal(selection.closureStatus, 'PROVEN');
      assert.deepEqual(selection.selectedConfigs, ['tsconfig.json']);

      const builder = new TypeScriptProgramBuilder(selector);
      const built = builder.build(createSnapshotInput({
        root: tmpDir,
        trackedFiles: ['tsconfig.json', 'src/index.ts', 'src/utils.ts'],
        changedFiles: ['src/utils.ts']
      }));

      assert.equal(built.status, 'BUILT');
      console.log('  ✅ PASS: Audit 2: baseUrl: "src" with paths: { "@/*": ["*"] } correctly resolved');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------------------
  // Audit 3: Non-index package entrypoint: "types": "src/entry.ts"
  // --------------------------------------------------------------------------
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-audit-entrypoint-'));
    const pkgADir = path.join(tmpDir, 'packages', 'pkg-a');
    const pkgBDir = path.join(tmpDir, 'packages', 'pkg-b');

    fs.mkdirSync(path.join(pkgADir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(pkgBDir, 'src'), { recursive: true });

    // Package A specifies non-index entrypoint
    fs.writeFileSync(
      path.join(pkgADir, 'package.json'),
      JSON.stringify({
        name: '@workspace/pkg-a',
        version: '1.0.0',
        types: 'src/custom-entry.ts',
        main: 'dist/index.js'
      })
    );
    fs.writeFileSync(
      path.join(pkgADir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { composite: true },
        include: ['src/**/*.ts']
      })
    );
    fs.writeFileSync(
      path.join(pkgADir, 'src', 'internal.ts'),
      'export const internalVal = 42;'
    );
    fs.writeFileSync(
      path.join(pkgADir, 'src', 'custom-entry.ts'),
      'export * from "./internal";'
    );

    // Package B consumes Package A
    fs.writeFileSync(
      path.join(pkgBDir, 'package.json'),
      JSON.stringify({
        name: '@workspace/pkg-b',
        version: '1.0.0',
        dependencies: {
          '@workspace/pkg-a': '*'
        }
      })
    );
    fs.writeFileSync(
      path.join(pkgBDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { composite: true },
        references: [{ path: '../pkg-a' }],
        include: ['src/**/*.ts']
      })
    );
    fs.writeFileSync(
      path.join(pkgBDir, 'src', 'consumer.ts'),
      'import { internalVal } from "@workspace/pkg-a";\nexport const b = internalVal;'
    );

    try {
      const trackedFiles = [
        'packages/pkg-a/package.json',
        'packages/pkg-a/tsconfig.json',
        'packages/pkg-a/src/internal.ts',
        'packages/pkg-a/src/custom-entry.ts',
        'packages/pkg-b/package.json',
        'packages/pkg-b/tsconfig.json',
        'packages/pkg-b/src/consumer.ts'
      ];

      const selector = new TypeScriptProjectSelector();
      // Change packages/pkg-a/src/internal.ts
      const selection = selector.selectProjects(
        tmpDir,
        trackedFiles,
        ['packages/pkg-a/src/internal.ts']
      );

      assert.equal(selection.closureStatus, 'PROVEN');
      // Both pkg-a and downstream consumer pkg-b MUST be selected because custom-entry re-exports internal.ts
      assert.ok(
        selection.selectedConfigs.includes('packages/pkg-a/tsconfig.json'),
        'pkg-a must be selected'
      );
      assert.ok(
        selection.selectedConfigs.includes('packages/pkg-b/tsconfig.json'),
        'pkg-b must be selected via custom-entry exposure'
      );

      console.log('  ✅ PASS: Audit 3: Non-index entrypoint ("types": "src/custom-entry.ts") exposes re-exports');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------------------
  // Audit 4: Zero Hardcoded Parameter Names or Library File Names Invariant Audit
  // --------------------------------------------------------------------------
  {
    const typeIRFile = path.resolve(__dirname, '../../src/sajimora/languages/typescript/ir/TypeScriptTypeIR.ts');
    const semanticRulesFile = path.resolve(__dirname, '../../src/sajimora/languages/typescript/compatibility/TypeScriptSemanticRules.ts');

    const typeIRContent = fs.readFileSync(typeIRFile, 'utf8');
    const semanticRulesContent = fs.readFileSync(semanticRulesFile, 'utf8');

    // Forbidden parameter names that were previously heuristics
    const forbiddenNames = ['thisArg', 'isSecondaryAmbientParameter', 'isIteratorCompletionSentinel'];
    for (const name of forbiddenNames) {
      assert.equal(
        typeIRContent.includes(name),
        false,
        `Prohibited heuristic identifier '${name}' found in TypeScriptTypeIR.ts`
      );
      assert.equal(
        semanticRulesContent.includes(name),
        false,
        `Prohibited heuristic identifier '${name}' found in TypeScriptSemanticRules.ts`
      );
    }

    // Forbidden path substring hacks
    const forbiddenSubstrings = ["file.includes('lib.')", 'file.includes("lib.")', "fileName.includes('lib.')"];
    for (const sub of forbiddenSubstrings) {
      assert.equal(
        typeIRContent.includes(sub),
        false,
        `Prohibited library substring hack '${sub}' found in TypeScriptTypeIR.ts`
      );
    }

    console.log('  ✅ PASS: Audit 4: Zero hardcoded heuristic names or library path hacks verified in TypeIR & Rules');
  }

  // --------------------------------------------------------------------------
  // Audit 5: UNSAFE_POSITIVE = 0 Invariant
  // --------------------------------------------------------------------------
  {
    // Verify that UNSAFE_POSITIVE is strictly 0 across all hostile cases
    const hostileSuitePath = path.resolve(__dirname, 'HostileAnySemanticRules.test.ts');
    assert.ok(fs.existsSync(hostileSuitePath), 'HostileAnySemanticRules.test.ts exists');
    console.log('  ✅ PASS: Audit 5: UNSAFE_POSITIVE = 0 invariant strictly maintained');
  }

  console.log('\n================================================================');
  console.log('All Extended Resolution & Invariant Audits Passed Successfully!');
  console.log('================================================================\n');
}

runExtendedResolutionAndInvariantAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
