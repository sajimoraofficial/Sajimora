import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { TypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/TypeScriptProgramBuilder';
import { DualTypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/DualTypeScriptProgramBuilder';
import { TypeScriptCrossVersionIdentityAnalyzer } from '../../src/sajimora/languages/typescript/identity/TypeScriptCrossVersionIdentity';
import { PipelineB } from '../../src/sajimora/pipelines/PipelineB';
import { AnalysisContext } from '../../src/sajimora/context/AnalysisContext';

const slash = (v: string) => v.replace(/\\/g, '/');

console.log('Running Universal Pipeline Fixes Regression Test Suite...\n');

function createTempWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-test-fixes-'));
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

// ============================================================================
// FIX 1: Closure-Scoped Diagnostic Completeness Tests
// ============================================================================
console.log('=== Test Group 1: Closure-Scoped Diagnostic Completeness ===');

// 1.1: TS2307 in unrelated disjoint file must NOT make discovery incomplete
{
  console.log('  1.1 TS2307 in unrelated file outside closure leaves discovery COMPLETE...');
  const ws = createTempWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'commonjs', strict: true },
      include: ['src/**/*']
    }),
    'src/target.ts': 'export type Config = { id: string; name: string };\n',
    'src/consumer.ts': 'import { Config } from "./target";\nexport function use(c: Config) { return c.id; }\n',
    'src/unrelated.ts': 'import { missing } from "non-existent-module-xyz";\nexport const u = 1;\n'
  });

  try {
    const trackedFiles = ['tsconfig.json', 'src/target.ts', 'src/consumer.ts', 'src/unrelated.ts'];
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/target.ts']
    });

    assert.equal(build.status, 'BUILT');
    assert.equal(build.universe.discoveryStatus, 'DISCOVERY_COMPLETE', 'Discovery must be complete because TS2307 is in unrelated file');
    assert.equal(build.selection?.closureBlockers.length, 0, 'No blockers should be generated for TS2307 outside closure');
    console.log('    -> PASS: Discovery is COMPLETE with 0 blockers.');
  } finally {
    ws.cleanup();
  }
}

// 1.2: TS2307 in direct upstream dependency MUST fail closed to DISCOVERY_INCOMPLETE
{
  console.log('  1.2 TS2307 in upstream dependency must fail closed to DISCOVERY_INCOMPLETE...');
  const ws = createTempWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'commonjs', strict: true },
      include: ['src/**/*']
    }),
    'src/upstream.ts': 'import { missing } from "non-existent-upstream-pkg";\nexport const BASE = 1;\n',
    'src/target.ts': 'import { BASE } from "./upstream";\nexport type Config = { id: number };\n'
  });

  try {
    const trackedFiles = ['tsconfig.json', 'src/upstream.ts', 'src/target.ts'];
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/target.ts']
    });

    assert.equal(build.status, 'PARTIAL');
    assert.equal(build.universe.discoveryStatus, 'DISCOVERY_INCOMPLETE', 'Discovery must fail closed because TS2307 is in upstream dependency');
    assert.ok(build.universe.parseFailures.some(f => f.code === 2307), 'Must include TS2307 parse failure');
    console.log('    -> PASS: Failed closed with DISCOVERY_INCOMPLETE and TS2307 failure.');
  } finally {
    ws.cleanup();
  }
}

// 1.3: TS2307 in downstream consumer MUST fail closed to DISCOVERY_INCOMPLETE
{
  console.log('  1.3 TS2307 in downstream consumer must fail closed to DISCOVERY_INCOMPLETE...');
  const ws = createTempWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'commonjs', strict: true },
      include: ['src/**/*']
    }),
    'src/target.ts': 'export type Config = { id: string };\n',
    'src/consumer.ts': 'import { Config } from "./target";\nimport { bad } from "non-existent-dep";\nexport function f(c: Config) {}\n'
  });

  try {
    const trackedFiles = ['tsconfig.json', 'src/target.ts', 'src/consumer.ts'];
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/target.ts']
    });

    assert.equal(build.status, 'PARTIAL');
    assert.equal(build.universe.discoveryStatus, 'DISCOVERY_INCOMPLETE', 'Discovery must fail closed because TS2307 is in downstream consumer');
    assert.ok(build.universe.parseFailures.some(f => f.code === 2307), 'Must include TS2307 parse failure');
    console.log('    -> PASS: Failed closed with DISCOVERY_INCOMPLETE for downstream consumer.');
  } finally {
    ws.cleanup();
  }
}

// 1.4: Obligation-seeded closure scoping when changedFiles is absent
{
  console.log('  1.4 Obligation-seeded closure correctly scopes diagnostics...');
  const ws = createTempWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'commonjs', strict: true },
      include: ['src/**/*']
    }),
    'src/util.ts': 'export type MyUtil = string;\n',
    'src/broken.ts': 'import { foo } from "broken-dep";\n'
  });

  try {
    const trackedFiles = ['tsconfig.json', 'src/util.ts', 'src/broken.ts'];
    const builder = new TypeScriptProgramBuilder();
    const build = builder.build({
      root: ws.root,
      trackedFiles,
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      obligations: [
        {
          obligationId: 'obl-1',
          mutatedSymbol: {
            symbolId: 'sym-1',
            qualifiedName: 'MyUtil',
            declarationLocation: { filePath: 'src/util.ts', line: 1, column: 13 }
          }
        } as any
      ]
    });

    assert.equal(build.status, 'BUILT');
    assert.equal(build.universe.discoveryStatus, 'DISCOVERY_COMPLETE');
    assert.equal(build.selection?.closureBlockers.length, 0);
    console.log('    -> PASS: Obligation seed successfully limits closure scope.');
  } finally {
    ws.cleanup();
  }
}

// ============================================================================
// FIX 2: Target-Scoped Identity Validation in PipelineB Tests
// ============================================================================
console.log('\n=== Test Group 2: Target-Scoped Identity Validation in PipelineB ===');

// 2.1: Sibling symbol with blocker does NOT poison unaffected target obligation
{
  console.log('  2.1 Sibling identity blocker does not poison target obligation proof...');
  const pipeline = new PipelineB();

  const targetObligation: any = {
    obligationId: 'obl-target',
    classification: 'SUBTYPING',
    relation: 'INTERFACE_PRESERVATION',
    providerMutation: {
      targetSymbolId: 'TargetSymbol',
      beforeExists: true,
      afterExists: true,
      classification: 'TYPE_DEF_MUTATED',
      isAstDiffDerived: true,
      beforeParsed: true,
      afterParsed: true
    },
    sourceType: { kind: 'PRIMITIVE', name: 'string' },
    targetType: { kind: 'PRIMITIVE', name: 'string' },
    mutatedSymbol: {
      symbolId: 'TargetSymbol',
      name: 'TargetSymbol',
      localName: 'TargetSymbol',
      qualifiedName: 'TargetSymbol',
      declarationLocation: { filePath: 'src/target.ts', line: 1, column: 1 }
    }
  };

  // CrossVersionIdentityBundle with a sibling blocker for "SiblingSymbol"
  const crossVersionIdentity: any = {
    status: 'INCOMPLETE',
    targetMappings: [
      {
        parent: {
          identityId: 'sym-target-parent-id',
          symbolId: 'sym-target-parent-id',
          canonicalId: 'canonical-target-id',
          name: 'TargetSymbol',
          localName: 'TargetSymbol',
          moduleIdentity: 'src/target.ts',
          declarationLocation: { filePath: 'src/target.ts', line: 1, column: 1 }
        },
        candidate: {
          identityId: 'sym-target-candidate-id',
          symbolId: 'sym-target-candidate-id',
          canonicalId: 'canonical-target-id',
          name: 'TargetSymbol',
          localName: 'TargetSymbol',
          moduleIdentity: 'src/target.ts',
          declarationLocation: { filePath: 'src/target.ts', line: 1, column: 1 }
        },
        status: 'SAME_DECLARATION'
      },
      {
        parent: {
          identityId: 'sym-sibling-parent-id',
          symbolId: 'sym-sibling-parent-id',
          canonicalId: 'canonical-sibling-id',
          name: 'SiblingSymbol',
          localName: 'SiblingSymbol',
          moduleIdentity: 'src/target.ts',
          declarationLocation: { filePath: 'src/target.ts', line: 5, column: 1 }
        },
        candidate: undefined,
        status: 'UNRESOLVED'
      }
    ],
    consumerMappings: [],
    blockers: ['UNRESOLVED:sym-sibling-parent-id']
  };

  const dummyProgram: any = {
    getSourceFiles: () => [],
    getTypeChecker: () => ({})
  };

  const result = pipeline.execute(targetObligation, {
    workspaceRoot: '/test',
    parentProgram: dummyProgram,
    candidateProgram: dummyProgram,
    crossVersionIdentity,
    isPhase4Mode: true
  });

  console.log('2.1 authorityDecision:', result.auditTrace?.authorityDecision);
  assert.notEqual(result.auditTrace?.authorityDecision?.gate, 'COVERAGE', 'Must not fail coverage due to sibling blocker');
  assert.notEqual(result.auditTrace?.authorityDecision?.reason, 'DISCOVERY_FAILURE');
  console.log('    -> PASS: Sibling blocker did not poison target obligation at COVERAGE gate.');
}

// 2.2: Negative test: Target symbol itself having identity blocker fails closed to UNKNOWN
{
  console.log('  2.2 Target symbol itself having blocker fails closed to UNKNOWN...');
  const pipeline = new PipelineB();

  const targetObligation: any = {
    obligationId: 'obl-target',
    classification: 'SUBTYPING',
    relation: 'INTERFACE_PRESERVATION',
    providerMutation: {
      targetSymbolId: 'TargetSymbol',
      beforeExists: true,
      afterExists: true,
      classification: 'TYPE_DEF_MUTATED',
      isAstDiffDerived: true,
      beforeParsed: true,
      afterParsed: true
    },
    sourceType: { kind: 'PRIMITIVE', name: 'string' },
    targetType: { kind: 'PRIMITIVE', name: 'string' },
    mutatedSymbol: {
      symbolId: 'TargetSymbol',
      name: 'TargetSymbol',
      localName: 'TargetSymbol',
      qualifiedName: 'TargetSymbol',
      declarationLocation: { filePath: 'src/target.ts', line: 1, column: 1 }
    }
  };

  const crossVersionIdentity: any = {
    status: 'INCOMPLETE',
    targetMappings: [
      {
        parent: {
          identityId: 'sym-target-parent-id',
          symbolId: 'sym-target-parent-id',
          canonicalId: 'canonical-target-id',
          name: 'TargetSymbol',
          localName: 'TargetSymbol',
          moduleIdentity: 'src/target.ts',
          declarationLocation: { filePath: 'src/target.ts', line: 1, column: 1 }
        },
        candidate: undefined,
        status: 'UNRESOLVED'
      }
    ],
    consumerMappings: [],
    blockers: ['UNRESOLVED:sym-target-parent-id']
  };

  const dummyProgram: any = {
    getSourceFiles: () => [],
    getTypeChecker: () => ({})
  };

  const result = pipeline.execute(targetObligation, {
    workspaceRoot: '/test',
    parentProgram: dummyProgram,
    candidateProgram: dummyProgram,
    crossVersionIdentity,
    isPhase4Mode: true
  });

  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.auditTrace?.authorityDecision?.gate, 'COVERAGE');
  assert.equal(result.auditTrace?.authorityDecision?.reason, 'DISCOVERY_FAILURE');
  console.log('    -> PASS: Target with own blocker correctly fails closed to UNKNOWN at COVERAGE gate.');
}

// ============================================================================
// FIX 3: Intra-File Deletion Classification Tests
// ============================================================================
console.log('\n=== Test Group 3: Intra-File Deletion Classification ===');

// 3.1: Declaration covered by deleted diff hunk with no candidate classified as REMOVED_DECLARATION
{
  console.log('  3.1 Deleted declaration covered by diff hunk maps to REMOVED_DECLARATION with no blocker...');
  const ws = createTempWorkspace({
    'parent/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2020' }, include: ['src/**/*'] }),
    'parent/src/util.ts': 'export enum OldEnum { A = "A" }\nexport type KeepType = string;\n',
    'candidate/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2020' }, include: ['src/**/*'] }),
    'candidate/src/util.ts': 'export type KeepType = string;\n'
  });

  try {
    const builder = new TypeScriptProgramBuilder();
    const parentBuild = builder.build({
      root: path.join(ws.root, 'parent'),
      trackedFiles: ['tsconfig.json', 'src/util.ts'],
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/util.ts']
    });

    const candidateBuild = builder.build({
      root: path.join(ws.root, 'candidate'),
      trackedFiles: ['tsconfig.json', 'src/util.ts'],
      revision: { repositoryId: 'test', commitSha: '2222' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/util.ts']
    });

    // Simulate git diff with a deleted hunk covering lines 1-1
    const diffs: any[] = [
      {
        parentPath: 'src/util.ts',
        candidatePath: 'src/util.ts',
        status: 'MODIFIED',
        hunks: [
          {
            parentStart: 1,
            parentLines: 1,
            candidateStart: 1,
            candidateLines: 0,
            lines: ['-export enum OldEnum { A = "A" }']
          }
        ]
      }
    ];

    const analyzer = new TypeScriptCrossVersionIdentityAnalyzer();
    const bundle = analyzer.analyze(
      parentBuild,
      candidateBuild,
      path.join(ws.root, 'parent'),
      path.join(ws.root, 'candidate'),
      diffs
    );

    const enumMapping = bundle.targetMappings.find(m => m.parent?.localName === 'OldEnum');
    assert.ok(enumMapping, 'OldEnum target mapping must exist');
    assert.equal(enumMapping.status, 'REMOVED_DECLARATION', 'OldEnum must be REMOVED_DECLARATION');
    assert.equal(enumMapping.candidate, undefined);
    assert.ok(enumMapping.parent);

    assert.equal(bundle.status, 'COMPLETE');
    assert.deepEqual(bundle.blockers, [], 'Blockers must be empty');
    console.log('    -> PASS: OldEnum classified as REMOVED_DECLARATION, bundle is COMPLETE with 0 blockers.');
  } finally {
    ws.cleanup();
  }
}

// 3.2: Negative test: Deleted line replaces with same kind does not create false REMOVED_DECLARATION
{
  console.log('  3.2 Replacement with another enum declaration does not blindly classify as REMOVED...');
  const ws = createTempWorkspace({
    'parent/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2020' }, include: ['src/**/*'] }),
    'parent/src/util.ts': 'export enum EnumA { X = 1 }\n',
    'candidate/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2020' }, include: ['src/**/*'] }),
    'candidate/src/util.ts': 'export enum EnumB { X = 1 }\n'
  });

  try {
    const builder = new TypeScriptProgramBuilder();
    const parentBuild = builder.build({
      root: path.join(ws.root, 'parent'),
      trackedFiles: ['tsconfig.json', 'src/util.ts'],
      revision: { repositoryId: 'test', commitSha: '1111' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/util.ts']
    });

    const candidateBuild = builder.build({
      root: path.join(ws.root, 'candidate'),
      trackedFiles: ['tsconfig.json', 'src/util.ts'],
      revision: { repositoryId: 'test', commitSha: '2222' },
      toolchain: { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' },
      adapterId: 'typescript-v1',
      adapterVersion: '1.0.0',
      changedFiles: ['src/util.ts']
    });

    // The hunk replaces EnumA with EnumB (both enums in the replacement lines)
    const diffs: any[] = [
      {
        parentPath: 'src/util.ts',
        candidatePath: 'src/util.ts',
        status: 'MODIFIED',
        hunks: [
          {
            parentStart: 1,
            parentLines: 1,
            candidateStart: 1,
            candidateLines: 1,
            lines: ['-export enum EnumA { X = 1 }', '+export enum EnumB { X = 1 }']
          }
        ]
      }
    ];

    const analyzer = new TypeScriptCrossVersionIdentityAnalyzer();
    const bundle = analyzer.analyze(
      parentBuild,
      candidateBuild,
      path.join(ws.root, 'parent'),
      path.join(ws.root, 'candidate'),
      diffs
    );

    const mappingA = bundle.targetMappings.find(m => m.parent?.localName === 'EnumA');
    assert.ok(mappingA, 'EnumA mapping must exist');
    assert.notEqual(mappingA.status, 'REMOVED_DECLARATION', 'Must not blindly classify as REMOVED_DECLARATION when candidate declaration exists in hunk');
    console.log('    -> PASS: Safe guard against false REMOVED_DECLARATION verified.');
  } finally {
    ws.cleanup();
  }
}

console.log('\nALL UNIVERSAL PIPELINE FIXES REGRESSION TESTS PASSED!\n');
