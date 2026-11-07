import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { TypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder';
import { TypeScriptProjectSelector } from '../../src/sajimora/languages/typescript/programs/TypeScriptProjectSelector';
import { DualTypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/DualTypeScriptProgramBuilder';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';
import { AnalysisContext } from '../../src/sajimora/context/AnalysisContext';

const slash = (v: string) => v.replace(/\\/g, '/');

console.log('Running Universal Project Selection & Subsumption Matrix Tests...');

function createTempWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-test-sel-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, ...slash(relPath).split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

// 1. Test Scenario 1: Subsumption Deduplication
// Root tsconfig duplicates leaf package projects. When diff is in leaf, root must be subsumed and leaf built.
{
  console.log('  Testing Scenario 1: Root Solution Subsumption...');
  const ws = createTempWorkspace({
    'tsconfig.json': JSON.stringify({
      include: ['packages/core/**/*', 'packages/unrelated/**/*']
    }),
    'packages/core/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/core/src/index.ts': 'export const x = 1;\n',
    'packages/unrelated/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/unrelated/src/other.ts': 'export const y = 2;\n'
  });

  try {
    const trackedFiles = [
      'tsconfig.json',
      'packages/core/tsconfig.json',
      'packages/core/src/index.ts',
      'packages/unrelated/tsconfig.json',
      'packages/unrelated/src/other.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(
      ws.root,
      trackedFiles,
      ['packages/core/src/index.ts']
    );

    assert.equal(result.closureStatus, 'PROVEN');
    assert.deepEqual(result.selectedConfigs, ['packages/core/tsconfig.json']);
    assert.deepEqual(result.subsumedConfigs, ['tsconfig.json']);
    assert.ok(!result.selectedConfigs.includes('packages/unrelated/tsconfig.json'), 'Unrelated package must be skipped');

    // Build program through builder and verify only 1 project is materialized
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['packages/core/src/index.ts']
    });

    assert.equal(build.status, 'BUILT');
    assert.equal(build.projects.length, 1);
    assert.equal(build.projects[0].identity.projectId, 'packages/core/tsconfig.json');
    console.log('  ✅ PASS: Scenario 1 — Root Solution Subsumption');
  } finally {
    ws.cleanup();
  }
}

// 2. Test Scenario 2: Diamond Project References Topology
// Core -> LeftConsumer, RightConsumer -> AppConsumer, plus UnrelatedPackage.
// Change in Core must pull in LeftConsumer, RightConsumer, AppConsumer, but NOT UnrelatedPackage.
{
  console.log('  Testing Scenario 2: Diamond Project References Topology...');
  const ws = createTempWorkspace({
    'packages/core/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true },
      include: ['src/**/*']
    }),
    'packages/core/src/core.ts': 'export function coreFn(): number { return 42; }\n',
    'packages/left/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true },
      references: [{ path: '../core' }],
      include: ['src/**/*']
    }),
    'packages/left/src/left.ts': 'import { coreFn } from "../../core/src/core"; export const l = coreFn();\n',
    'packages/right/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true },
      references: [{ path: '../core' }],
      include: ['src/**/*']
    }),
    'packages/right/src/right.ts': 'import { coreFn } from "../../core/src/core"; export const r = coreFn();\n',
    'packages/app/tsconfig.json': JSON.stringify({
      references: [{ path: '../left' }, { path: '../right' }],
      include: ['src/**/*']
    }),
    'packages/app/src/app.ts': 'import { l } from "../../left/src/left"; import { r } from "../../right/src/right"; export const total = l + r;\n',
    'packages/unrelated/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/unrelated/src/other.ts': 'export const isolated = true;\n'
  });

  try {
    const trackedFiles = [
      'packages/core/tsconfig.json', 'packages/core/src/core.ts',
      'packages/left/tsconfig.json', 'packages/left/src/left.ts',
      'packages/right/tsconfig.json', 'packages/right/src/right.ts',
      'packages/app/tsconfig.json', 'packages/app/src/app.ts',
      'packages/unrelated/tsconfig.json', 'packages/unrelated/src/other.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(
      ws.root,
      trackedFiles,
      ['packages/core/src/core.ts']
    );

    assert.equal(result.closureStatus, 'PROVEN');
    assert.deepEqual(
      result.selectedConfigs.sort(),
      ['packages/app/tsconfig.json', 'packages/core/tsconfig.json', 'packages/left/tsconfig.json', 'packages/right/tsconfig.json'].sort()
    );
    assert.ok(!result.selectedConfigs.includes('packages/unrelated/tsconfig.json'), 'Unrelated package must not be in diamond closure');
    console.log('  ✅ PASS: Scenario 2 — Diamond Project References Topology');
  } finally {
    ws.cleanup();
  }
}

// 3. Test Scenario 3: Leaf Consumer Change skips Core & Siblings
// When diff is only in a leaf consumer, core package and sibling consumers must NOT be materialized.
{
  console.log('  Testing Scenario 3: Leaf Consumer Change Isolation...');
  const ws = createTempWorkspace({
    'packages/core/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/core/src/core.ts': 'export const x = 1;\n',
    'packages/leaf/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/leaf/src/leaf.ts': 'export const l = 2;\n'
  });

  try {
    const trackedFiles = [
      'packages/core/tsconfig.json', 'packages/core/src/core.ts',
      'packages/leaf/tsconfig.json', 'packages/leaf/src/leaf.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(
      ws.root,
      trackedFiles,
      ['packages/leaf/src/leaf.ts']
    );

    assert.equal(result.closureStatus, 'PROVEN');
    assert.deepEqual(result.selectedConfigs, ['packages/leaf/tsconfig.json']);
    assert.ok(!result.selectedConfigs.includes('packages/core/tsconfig.json'));
    console.log('  ✅ PASS: Scenario 3 — Leaf Consumer Change Isolation');
  } finally {
    ws.cleanup();
  }
}

// 4. Test Scenario 4: Path Mapping Cross-Package Dependency
{
  console.log('  Testing Scenario 4: Path Mapping Cross-Package Dependency...');
  const ws = createTempWorkspace({
    'packages/shared/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/shared/src/util.ts': 'export const utilVal = 99;\n',
    'packages/web/tsconfig.json': JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@shared/*': ['../shared/src/*'] }
      },
      include: ['src/**/*']
    }),
    'packages/web/src/main.ts': 'import { utilVal } from "@shared/util"; export const w = utilVal;\n'
  });

  try {
    const trackedFiles = [
      'packages/shared/tsconfig.json', 'packages/shared/src/util.ts',
      'packages/web/tsconfig.json', 'packages/web/src/main.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(
      ws.root,
      trackedFiles,
      ['packages/shared/src/util.ts']
    );

    assert.equal(result.closureStatus, 'PROVEN');
    assert.deepEqual(
      result.selectedConfigs.sort(),
      ['packages/shared/tsconfig.json', 'packages/web/tsconfig.json'].sort()
    );
    console.log('  ✅ PASS: Scenario 4 — Path Mapping Cross-Package Dependency');
  } finally {
    ws.cleanup();
  }
}

// 5. Test Scenario 5: Unproven Consumer Closure Fails Closed to UNKNOWN
// When an unselected project has an unresolvable wildcard export, closure is unproven.
// The system must set discoveryStatus = 'DISCOVERY_INCOMPLETE' and fail closed to UNKNOWN, never PRESERVED.
{
  console.log('  Testing Scenario 5: Unproven Consumer Closure Fails Closed...');
  const ws = createTempWorkspace({
    'packages/core/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/core/src/api.ts': 'export function apiFn(): number { return 1; }\n',
    'packages/ambiguous/tsconfig.json': JSON.stringify({
      include: ['src/**/*']
    }),
    'packages/ambiguous/src/wildcard.ts': 'export * from "dynamic-*";\n'
  });

  try {
    const trackedFiles = [
      'packages/core/tsconfig.json', 'packages/core/src/api.ts',
      'packages/ambiguous/tsconfig.json', 'packages/ambiguous/src/wildcard.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(
      ws.root,
      trackedFiles,
      ['packages/core/src/api.ts']
    );

    assert.equal(result.closureStatus, 'UNPROVEN');
    assert.ok(result.closureBlockers.some(b => b.includes('UNRESOLVABLE_WILDCARD_EXPORT')));

    // Build with TypeScriptProgramBuilder and assert DISCOVERY_INCOMPLETE
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['packages/core/src/api.ts']
    });

    assert.equal(build.universe.discoveryStatus, 'DISCOVERY_INCOMPLETE');
    assert.equal(build.status, 'PARTIAL');

    // Verify Pipeline B fails closed to UNKNOWN at COVERAGE gate
    const pipeline = new PipelineB();
    const proof = pipeline.execute({
      invariantId: 'ob-closure',
      relation: 'STRUCTURAL_CO_EVOLUTION',
      mutatedSymbol: {
        symbolId: 'apiFn',
        qualifiedName: 'apiFn',
        kind: 'FUNCTION',
        declarationLocation: { filePath: `${ws.root}/packages/core/src/api.ts`, line: 1 }
      } as any,
      providerMutation: {
        targetSymbolId: 'apiFn',
        beforeExists: true,
        afterExists: true,
        beforeParsed: true,
        afterParsed: true,
        isAstDiffDerived: true,
        classification: 'EXPORTED_SIGNATURE_MUTATED',
        beforeSnippet: 'export function apiFn(): number',
        afterSnippet: 'export function apiFn(): string',
        targetSymbol: {
          symbolId: 'apiFn',
          qualifiedName: 'apiFn',
          kind: 'FUNCTION'
        }
      } as any
    }, {
      workspaceRoot: ws.root,
      parentProgram: build.projects[0].program,
      candidateProgram: build.projects[0].program,
      isPhase4Mode: true,
      crossVersionIdentity: {
        status: 'INCOMPLETE',
        blockers: ['PROGRAM_DISCOVERY_INCOMPLETE'],
        targetMappings: [],
        consumerMappings: []
      } as any
    });

    assert.equal(proof.verdict, 'UNKNOWN');
    assert.equal(proof.auditTrace?.authorityDecision?.gate, 'COVERAGE');
    assert.equal(proof.auditTrace?.authorityDecision?.reason, 'DISCOVERY_FAILURE');
    console.log('  ✅ PASS: Scenario 5 — Unproven Consumer Closure Fails Closed');
  } finally {
    ws.cleanup();
  }
}

// 6. Test Scenario 6: Backward Compatibility — No Changed Files Specified Builds All Projects
{
  console.log('  Testing Scenario 6: Full Workspace Backward Compatibility...');
  const ws = createTempWorkspace({
    'packages/a/tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'packages/a/src/a.ts': 'export const a = 1;\n',
    'packages/b/tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'packages/b/src/b.ts': 'export const b = 2;\n'
  });

  try {
    const trackedFiles = [
      'packages/a/tsconfig.json', 'packages/a/src/a.ts',
      'packages/b/tsconfig.json', 'packages/b/src/b.ts'
    ];

    const selector = new TypeScriptProjectSelector();
    const result = selector.selectProjects(ws.root, trackedFiles, undefined);

    assert.equal(result.closureStatus, 'PROVEN');
    assert.deepEqual(result.selectedConfigs.sort(), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'].sort());
    console.log('  ✅ PASS: Scenario 6 — Full Workspace Backward Compatibility');
  } finally {
    ws.cleanup();
  }
}

console.log('All ProjectSelectionMatrix tests passed successfully!');
