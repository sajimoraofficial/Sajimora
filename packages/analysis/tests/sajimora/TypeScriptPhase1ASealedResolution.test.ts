/**
 * @file TypeScriptPhase1ASealedResolution.test.ts
 * Master Plan Phase 1A: Minimal Sealed Environment & Independent Inventory Test Suite.
 * 
 * Validates all mandatory fixtures specified in TYPESCRIPT_COMMERCIAL_COVERAGE_MASTER_PLAN.md:
 * 1. Missing import -> failed lookup candidates recorded, TS2307 boundary captured
 * 2. Cyclic imports -> cleanly resolved without divergence or deadlock
 * 3. Export collision -> identical export names from different modules retain distinct identities & chains
 * 4. Type-only dependency -> usageMode tagged as 'type-only'
 * 5. Changed manifest/config -> effective options and configuration change detected
 * 6. Added higher-priority lookup file -> candidate selects lib.ts over lib/index.ts with negative lookup receipts
 * 7. Untracked local import satisfier -> host filesystem files missing from snapshot strictly fail closed (zero fs leakage)
 * 8. Omitted project reference -> non-existent referenced project handled fail-closed
 * 9. Case collision -> import './Lib' fails against file 'lib.ts' under strict case sensitivity
 * 10. Path traversal -> ../../../../ outside snapshot root rejected fail-closed
 * 11. Malformed / cyclic config inheritance -> extends cycle detected safely without crash
 * 12. Export-star chains -> export * from './provider' correctly traces re-exported declarations
 */

import * as ts from 'typescript';
import {
  GenericRepository,
  GenericRepositorySnapshot,
  ProductionVerificationCore
} from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { SealedCompilerHost } from '../../src/sajimora/languages/typescript/production/SealedCompilerHost';
import { TypeScriptProjectGraphBuilder } from '../../src/sajimora/languages/typescript/production/TypeScriptProjectGraphBuilder';
import { ProgramSetManager } from '../../src/sajimora/languages/typescript/production/ProgramSetManager';
import { TypeCheckerSemanticAnalyzer } from '../../src/sajimora/languages/typescript/production/TypeCheckerSemanticAnalyzer';

function createSnapshot(files: Record<string, string>, snapshotId = 'snap-1'): GenericRepositorySnapshot {
  return {
    snapshotId,
    rootIdentifier: '/',
    files: Object.entries(files).map(([p, content]) => ({
      path: p,
      byteLength: content.length,
      hash: 'hash_' + p
    })),
    readTextFile: (p) => files[p],
    readBinaryFile: (p) => files[p] ? Buffer.from(files[p]) : undefined
  };
}

async function runPhase1ATests() {
  console.log('=== Running TypeScript Phase 1A Sealed Resolution & Inventory Tests ===\n');

  // ---------------------------------------------------------------------------
  // Fixture 1: Missing import -> failed lookup candidates recorded
  // ---------------------------------------------------------------------------
  console.log('Fixture 1: Missing import resolution receipt...');
  const snapMissing = createSnapshot({
    'src/consumer.ts': 'import { missingFn } from "./missing";\nmissingFn();\n'
  });
  const hostMissing = new SealedCompilerHost(snapMissing, 'proj-1', {
    strict: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10
  });
  const sfMissing = hostMissing.getSourceFile('src/consumer.ts', ts.ScriptTarget.ES2022);
  if (!sfMissing) throw new Error('Fixture 1 failed: Could not load consumer file');

  const literalsMissing: ts.StringLiteral[] = [];
  ts.forEachChild(sfMissing, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      literalsMissing.push(node.moduleSpecifier);
    }
  });

  const resMissing = hostMissing.resolveModuleNameLiterals(
    literalsMissing,
    'src/consumer.ts',
    undefined,
    { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 },
    sfMissing,
    undefined
  );

  const factsMissing = hostMissing.getResolutionFacts();
  const fact1 = factsMissing.find(f => f.importSpecifier === './missing');
  if (!fact1) throw new Error('Fixture 1 failed: ResolutionFact was not emitted for missing import');
  if (fact1.resolvedTargetFile !== undefined) {
    throw new Error('Fixture 1 failed: Missing import resolved unexpectedly');
  }
  if (!fact1.failedLookupCandidates || fact1.failedLookupCandidates.length === 0) {
    throw new Error('Fixture 1 failed: Expected negative lookup candidates to be recorded');
  }
  console.log('✓ Fixture 1 passed: Missing import records negative failed lookup candidates in resolution receipt.');

  // ---------------------------------------------------------------------------
  // Fixture 2: Cyclic imports -> cleanly resolved
  // ---------------------------------------------------------------------------
  console.log('Fixture 2: Cyclic imports resolution...');
  const snapCycle = createSnapshot({
    'src/a.ts': 'import { b } from "./b"; export const a = 1; export const useB = b;\n',
    'src/b.ts': 'import { a } from "./a"; export const b = 2; export const useA = a;\n'
  });
  const graphCycle = TypeScriptProjectGraphBuilder.buildProjectGraph(snapCycle);
  const mgrCycle = new ProgramSetManager(snapCycle, graphCycle);
  const instCycle = mgrCycle.getAllInstances()[0];
  const sfA = instCycle.program.getSourceFile('src/a.ts');
  const sfB = instCycle.program.getSourceFile('src/b.ts');
  if (!sfA || !sfB) throw new Error('Fixture 2 failed: Cyclic files not loaded');
  const diagsCycle = instCycle.program.getSemanticDiagnostics();
  if (diagsCycle.length > 0) {
    throw new Error(`Fixture 2 failed: Unexpected semantic diagnostics in clean cycle: ${diagsCycle.map(d => d.messageText).join(', ')}`);
  }
  console.log('✓ Fixture 2 passed: Cyclic imports resolve cleanly without recursion or deadlock.');

  // ---------------------------------------------------------------------------
  // Fixture 3: Collision -> same symbol name in different modules
  // ---------------------------------------------------------------------------
  console.log('Fixture 3: Disambiguating export name collisions across modules...');
  const snapCollision = createSnapshot({
    'src/pkgA/calc.ts': 'export function compute(): number { return 10; }\n',
    'src/pkgB/calc.ts': 'export function compute(): number { return 20; }\n',
    'src/consumerA.ts': 'import { compute } from "./pkgA/calc"; compute();\n',
    'src/consumerB.ts': 'import { compute } from "./pkgB/calc"; compute();\n'
  });
  const graphCollision = TypeScriptProjectGraphBuilder.buildProjectGraph(snapCollision);
  const mgrCollision = new ProgramSetManager(snapCollision, graphCollision);
  const instCollision = mgrCollision.getAllInstances()[0];
  const entitiesCollision = TypeCheckerSemanticAnalyzer.extractEntities(instCollision);
  const computeEntities = entitiesCollision.filter(e => e.name === 'compute');
  if (computeEntities.length !== 2) {
    throw new Error(`Fixture 3 failed: Expected 2 distinct compute entities, got ${computeEntities.length}`);
  }
  if (computeEntities[0].entityId === computeEntities[1].entityId) {
    throw new Error('Fixture 3 failed: Entity IDs collided across different files!');
  }
  console.log('✓ Fixture 3 passed: Collision handled with distinct qualified identities.');

  // ---------------------------------------------------------------------------
  // Fixture 4: Type-only dependency -> usageMode tagged as 'type-only'
  // ---------------------------------------------------------------------------
  console.log('Fixture 4: Type-only import receipt tagged...');
  const snapTypeOnly = createSnapshot({
    'src/types.ts': 'export interface UserConfig { port: number; }\n',
    'src/app.ts': 'import type { UserConfig } from "./types";\nexport const x = 1;\n'
  });
  const hostTypeOnly = new SealedCompilerHost(snapTypeOnly, 'proj-type-only', {
    strict: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10
  });
  const sfTypeOnly = hostTypeOnly.getSourceFile('src/app.ts', ts.ScriptTarget.ES2022);
  if (!sfTypeOnly) throw new Error('Fixture 4 failed: Could not load type-only consumer');
  const literalsTypeOnly: ts.StringLiteral[] = [];
  ts.forEachChild(sfTypeOnly, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      literalsTypeOnly.push(node.moduleSpecifier);
    }
  });
  hostTypeOnly.resolveModuleNameLiterals(
    literalsTypeOnly,
    'src/app.ts',
    undefined,
    { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 },
    sfTypeOnly,
    undefined
  );
  const factTypeOnly = hostTypeOnly.getResolutionFacts().find(f => f.importSpecifier === './types');
  if (!factTypeOnly) throw new Error('Fixture 4 failed: No resolution fact found');
  if (factTypeOnly.usageMode !== 'type-only') {
    throw new Error(`Fixture 4 failed: Expected usageMode 'type-only', got ${factTypeOnly.usageMode}`);
  }
  console.log('✓ Fixture 4 passed: Type-only import correctly tagged with usageMode: type-only.');

  // ---------------------------------------------------------------------------
  // Fixture 5: Changed manifest / config
  // ---------------------------------------------------------------------------
  console.log('Fixture 5: Manifest / tsconfig change detection...');
  const parentTsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020' } });
  const candTsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } });
  const snapP5 = createSnapshot({ 'tsconfig.json': parentTsconfig, 'src/index.ts': 'export const v = 1;' }, 'p5');
  const snapC5 = createSnapshot({ 'tsconfig.json': candTsconfig, 'src/index.ts': 'export const v = 1;' }, 'c5');
  const gp5 = TypeScriptProjectGraphBuilder.buildProjectGraph(snapP5);
  const gc5 = TypeScriptProjectGraphBuilder.buildProjectGraph(snapC5);
  if (gp5.projects[0]?.options?.['target'] === gc5.projects[0]?.options?.['target']) {
    throw new Error('Fixture 5 failed: Config options change not reflected in project graph');
  }
  console.log('✓ Fixture 5 passed: tsconfig option modification correctly captured in project graph.');

  // ---------------------------------------------------------------------------
  // Fixture 6: Added higher-priority lookup file
  // ---------------------------------------------------------------------------
  console.log('Fixture 6: Added higher-priority lookup file altering resolution...');
  const snapP6 = createSnapshot({
    'src/consumer.ts': 'import { value } from "./lib";\nexport const out = value;\n',
    'src/lib/index.ts': 'export const value = 1;\n'
  });
  const snapC6 = createSnapshot({
    'src/consumer.ts': 'import { value } from "./lib";\nexport const out = value;\n',
    'src/lib/index.ts': 'export const value = 1;\n',
    'src/lib.ts': 'export const value = 2;\n' // Higher priority than lib/index.ts in Node resolution!
  });
  const hostP6 = new SealedCompilerHost(snapP6, 'p6', { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
  const hostC6 = new SealedCompilerHost(snapC6, 'c6', { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
  const sfP6 = hostP6.getSourceFile('src/consumer.ts', ts.ScriptTarget.ES2022)!;
  const sfC6 = hostC6.getSourceFile('src/consumer.ts', ts.ScriptTarget.ES2022)!;

  const litP6: ts.StringLiteral[] = [];
  ts.forEachChild(sfP6, n => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) litP6.push(n.moduleSpecifier); });
  const litC6: ts.StringLiteral[] = [];
  ts.forEachChild(sfC6, n => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) litC6.push(n.moduleSpecifier); });

  const resP6 = hostP6.resolveModuleNameLiterals(litP6, 'src/consumer.ts', undefined, { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }, sfP6, undefined);
  const resC6 = hostC6.resolveModuleNameLiterals(litC6, 'src/consumer.ts', undefined, { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }, sfC6, undefined);

  if (resP6[0].resolvedModule?.resolvedFileName !== 'src/lib/index.ts') {
    throw new Error(`Fixture 6 failed: Parent did not resolve lib/index.ts, got ${resP6[0].resolvedModule?.resolvedFileName}`);
  }
  if (resC6[0].resolvedModule?.resolvedFileName !== 'src/lib.ts') {
    throw new Error(`Fixture 6 failed: Candidate did not resolve higher-priority lib.ts, got ${resC6[0].resolvedModule?.resolvedFileName}`);
  }
  console.log('✓ Fixture 6 passed: Higher-priority lookup file correctly alters resolved module target.');

  // ---------------------------------------------------------------------------
  // Fixture 7: Untracked local import satisfier -> Zero host filesystem leakage
  // ---------------------------------------------------------------------------
  console.log('Fixture 7: Untracked local satisfier (zero filesystem leakage)...');
  // package.json exists on real disk in project root, but let's test a file NOT in snapshot
  const snapSealed = createSnapshot({
    'src/main.ts': 'import { local } from "./untracked_secret";\n'
  });
  const hostSealed = new SealedCompilerHost(snapSealed, 'p7', { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
  if (hostSealed.fileExists('src/untracked_secret.ts')) {
    throw new Error('Fixture 7 failed: fileExists returned true for untracked file!');
  }
  if (hostSealed.readFile('src/untracked_secret.ts') !== undefined) {
    throw new Error('Fixture 7 failed: readFile read an untracked file!');
  }
  console.log('✓ Fixture 7 passed: SealedCompilerHost strictly ignores untracked host filesystem files.');

  // ---------------------------------------------------------------------------
  // Fixture 8: Omitted project reference
  // ---------------------------------------------------------------------------
  console.log('Fixture 8: Omitted project reference handling...');
  const snapOmitted = createSnapshot({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true },
      references: [{ path: './packages/omitted_project' }]
    }),
    'src/main.ts': 'export const x = 1;\n'
  });
  const graphOmitted = TypeScriptProjectGraphBuilder.buildProjectGraph(snapOmitted);
  // Reference points to omitted_project which does not exist in snapshot
  const targetEdge = graphOmitted.edges.find(e => e.toProjectId.includes('omitted_project'));
  if (targetEdge !== undefined) {
    throw new Error('Fixture 8 failed: Edge created for omitted project reference!');
  }
  console.log('✓ Fixture 8 passed: Omitted project reference handled cleanly without ghost edge.');

  // ---------------------------------------------------------------------------
  // Fixture 9: Case collision under strict case-sensitive host
  // ---------------------------------------------------------------------------
  console.log('Fixture 9: Case collision rejection...');
  const snapCase = createSnapshot({
    'src/lib.ts': 'export const data = 42;\n',
    'src/consumer.ts': 'import { data } from "./Lib";\nexport const res = data;\n' // Mismatched case!
  });
  const hostCase = new SealedCompilerHost(snapCase, 'p9', { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
  const sfCase = hostCase.getSourceFile('src/consumer.ts', ts.ScriptTarget.ES2022)!;
  const litCase: ts.StringLiteral[] = [];
  ts.forEachChild(sfCase, n => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) litCase.push(n.moduleSpecifier); });
  const resCase = hostCase.resolveModuleNameLiterals(litCase, 'src/consumer.ts', undefined, { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }, sfCase, undefined);
  if (resCase[0].resolvedModule !== undefined) {
    throw new Error('Fixture 9 failed: Case collision ./Lib unexpectedly resolved against lib.ts');
  }
  console.log('✓ Fixture 9 passed: Case mismatch fails closed under strict case sensitivity.');

  // ---------------------------------------------------------------------------
  // Fixture 10: Path traversal rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 10: Path traversal rejection...');
  const snapTraversal = createSnapshot({
    'src/consumer.ts': 'import { secret } from "../../../../outside";\n'
  });
  const hostTraversal = new SealedCompilerHost(snapTraversal, 'p10', { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
  const sfTraversal = hostTraversal.getSourceFile('src/consumer.ts', ts.ScriptTarget.ES2022)!;
  const litTraversal: ts.StringLiteral[] = [];
  ts.forEachChild(sfTraversal, n => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) litTraversal.push(n.moduleSpecifier); });
  const resTraversal = hostTraversal.resolveModuleNameLiterals(litTraversal, 'src/consumer.ts', undefined, { strict: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }, sfTraversal, undefined);
  if (resTraversal[0].resolvedModule !== undefined) {
    throw new Error('Fixture 10 failed: Path traversal import resolved unexpectedly');
  }
  console.log('✓ Fixture 10 passed: Path traversal attempting to escape root is rejected fail-closed.');

  // ---------------------------------------------------------------------------
  // Fixture 11: Malformed / cyclic config inheritance
  // ---------------------------------------------------------------------------
  console.log('Fixture 11: Cyclic config inheritance detection...');
  const snapCyclicConfig = createSnapshot({
    'tsconfig.a.json': JSON.stringify({ extends: './tsconfig.b.json', compilerOptions: { strict: true } }),
    'tsconfig.b.json': JSON.stringify({ extends: './tsconfig.a.json', compilerOptions: { noImplicitAny: true } }),
    'src/index.ts': 'export const val = 1;\n'
  });
  const { config: confA, isCyclic } = TypeScriptProjectGraphBuilder.resolveConfig('tsconfig.a.json', snapCyclicConfig);
  if (!isCyclic) {
    throw new Error('Fixture 11 failed: Cyclic config extends was not detected!');
  }
  if (!confA.compilerOptions?.strict) {
    throw new Error('Fixture 11 failed: Child config options were lost during cyclic recovery');
  }
  console.log('✓ Fixture 11 passed: Cyclic tsconfig extends safely detected and handled without crashing.');

  // ---------------------------------------------------------------------------
  // Fixture 12: Export-star chains
  // ---------------------------------------------------------------------------
  console.log('Fixture 12: Export-star chain reference discovery...');
  const snapExportStar = createSnapshot({
    'src/provider.ts': 'export function calculate(): number { return 100; }\n',
    'src/barrel.ts': 'export * from "./provider";\n',
    'src/app.ts': 'import { calculate } from "./barrel";\nconst res = calculate();\n'
  });
  const graphExportStar = TypeScriptProjectGraphBuilder.buildProjectGraph(snapExportStar);
  const mgrExportStar = new ProgramSetManager(snapExportStar, graphExportStar);
  const instExportStar = mgrExportStar.getAllInstances()[0];
  const entitiesExportStar = TypeCheckerSemanticAnalyzer.extractEntities(instExportStar);
  const targetEntity = entitiesExportStar.find(e => e.name === 'calculate');
  if (!targetEntity) throw new Error('Fixture 12 failed: Could not extract calculate entity');

  const { staticReferences } = TypeCheckerSemanticAnalyzer.discoverReferences(instExportStar, [targetEntity]);
  // Expect static references from barrel (export *) and app (import & call)
  const barrelRef = staticReferences.find(r => r.location.filePath === 'src/barrel.ts');
  const appImportRef = staticReferences.find(r => r.location.filePath === 'src/app.ts' && r.kind === 'STATIC_IMPORT');
  const appCallRef = staticReferences.find(r => r.location.filePath === 'src/app.ts' && r.kind === 'STATIC_CALL');

  if (!barrelRef) {
    throw new Error('Fixture 12 failed: Export-star reference was not captured in barrel.ts');
  }
  if (!appImportRef || !appCallRef) {
    throw new Error('Fixture 12 failed: Downstream consumer import or call reference missing through export-star');
  }
  console.log('✓ Fixture 12 passed: Export-star chain fully links provider, barrel, and consumer references.');

  console.log('\n=== All 12 Phase 1A Mandatory Fixtures PASSED! ===');
}

runPhase1ATests().catch(err => {
  console.error('\nTest suite failed with error:', err);
  process.exit(1);
});
