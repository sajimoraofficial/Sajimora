/**
 * @file TypeScriptPhase1BScopeIsolation.test.ts
 * Phase 1B Mandatory Acceptance Test Suite: Scope Isolation & Non-Interference Proofs.
 * 
 * Verifies all 11 mandatory fixtures from Section 6 of TYPESCRIPT_COMMERCIAL_COVERAGE_MASTER_PLAN.md:
 * 1. Unimported entry-point consumer (file with 0 incoming imports cannot be pruned).
 * 2. Parse-failed potential consumer (syntax errors cannot be excluded; retained as UNKNOWN boundary).
 * 3. Ambient augmentation outside target directory (global / module augmentations retained).
 * 4. Unresolved alias (unresolvable path alias cannot be assumed disjoint; retained as UNKNOWN).
 * 5. Dynamic consumer (dynamic import or index access cannot be proven non-interfering).
 * 6. Barrel cycle (re-export cycles in barrel files traversed safely without dropping edges).
 * 7. Rename/move (file moved between parent and candidate tracked across revisions).
 * 8. Added/removed project (added project consuming target detected in candidate graph).
 * 9. Candidate-only new edge (new consumer edge in candidate blocks exclusion).
 * 10. Malformed file provably outside an isolated sealed root (isolated root cleanly excluded).
 * 11. Tampered exclusion evidence (digest mismatch, inventory tampering, false claims fail closed).
 */

import * as assert from 'node:assert/strict';
import {
  GenericRepository,
  GenericRepositorySnapshot,
  GenericProjectGraph
} from '../../../core/src/sajimora/verification';
import { ScopeIsolationEngine } from '../../src/sajimora/languages/typescript/production/ScopeIsolationEngine';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { ProductionVerificationCore } from '../../../core/src/sajimora/verification/ProductionVerificationCore';

function makeSnapshot(id: string, files: Array<{ path: string; content: string }>): GenericRepositorySnapshot {
  const fileMap = new Map(files.map(f => [f.path, f.content]));
  return {
    snapshotId: id,
    rootIdentifier: '/repo',
    files: files.map(f => ({
      path: f.path,
      byteLength: f.content.length,
      hash: 'mock_' + f.path
    })),
    readTextFile(p: string) { return fileMap.get(p); },
    readBinaryFile(p: string) { return undefined; }
  };
}

function makeGraph(projectDirs: string[]): GenericProjectGraph {
  return {
    graphId: 'graph_0',
    projects: projectDirs.map((dir, idx) => ({
      projectId: `proj_${idx}`,
      rootDirectory: dir,
      configFile: `${dir}/tsconfig.json`,
      sourceFiles: [],
      projectReferences: []
    })),
    edges: []
  };
}

async function runPhase1BTests() {
  console.log('=== Running TypeScript Phase 1B Scope Isolation & Non-Interference Tests ===\n');

  // =========================================================================
  // Fixture 1: Unimported entry-point consumer
  // =========================================================================
  console.log('Fixture 1: Unimported entry-point consumer...');
  {
    // target.ts provides price
    // entry.ts imports target.ts and calls price(10).
    // NO OTHER FILE imports entry.ts (incoming import count = 0).
    const parentSnap = makeSnapshot('snap_p_1', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function price(x: number): number { return x * 2; }' },
      { path: 'src/entry.ts', content: "import { price } from './target'; const res = price(10);" }
    ]);
    const candSnap = makeSnapshot('snap_c_1', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function price(x: number): number { return x * 4; }' },
      { path: 'src/entry.ts', content: "import { price } from './target'; const res = price(10);" }
    ]);
    const graph = makeGraph(['.']);

    // Attempting to exclude entry.ts from scope must be REJECTED
    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/entry.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of unimported entry-point must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'UNJUSTIFIED_BOUNDARY_EXCLUSION'),
      'Blocker code must be UNJUSTIFIED_BOUNDARY_EXCLUSION'
    );
    assert.ok(
      res.verifiedScope.includes('src/entry.ts'),
      'Verified scope must include unimported entry-point consumer'
    );
    console.log('✓ Fixture 1 passed: Unimported entry-point consumer cannot be unlawfully pruned from scope.');
  }

  // =========================================================================
  // Fixture 2: Parse-failed potential consumer
  // =========================================================================
  console.log('Fixture 2: Parse-failed potential consumer...');
  {
    // src/broken.ts contains invalid syntax that cannot parse into a clean AST.
    // Uncertainty is not absence: it cannot be assumed disjoint.
    const parentSnap = makeSnapshot('snap_p_2', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): string { return "ok"; }' },
      { path: 'src/broken.ts', content: 'const broken = ;;; function ( { return' }
    ]);
    const candSnap = makeSnapshot('snap_c_2', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): string { return "mod"; }' },
      { path: 'src/broken.ts', content: 'const broken = ;;; function ( { return' }
    ]);
    const graph = makeGraph(['.']);

    // Claiming broken.ts is non-interfering must be REJECTED
    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/broken.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of parse-failed potential consumer must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'PARSE_FAILED_CANNOT_PROVE_NON_INTERFERENCE'),
      'Blocker code must be PARSE_FAILED_CANNOT_PROVE_NON_INTERFERENCE'
    );
    assert.ok(
      res.unresolvedBoundaries?.some(b => b.boundaryTaxonomyReason === 'PARSE_FAILED_POTENTIAL_CONSUMER'),
      'Parse failure must emit an UNRESOLVED_BOUNDARY'
    );
    console.log('✓ Fixture 2 passed: Parse-failed file retained as unresolved boundary fail-closed.');
  }

  // =========================================================================
  // Fixture 3: Ambient augmentation outside target directory
  // =========================================================================
  console.log('Fixture 3: Ambient augmentation outside target directory...');
  {
    // types/ambient.d.ts is outside src/feature/target.ts, but augments the target module
    const parentSnap = makeSnapshot('snap_p_3', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/feature/target.ts', content: 'export interface Config { timeout: number; }' },
      { path: 'types/ambient.d.ts', content: "declare module '../src/feature/target' { interface Config { retries: number; } }" }
    ]);
    const candSnap = makeSnapshot('snap_c_3', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/feature/target.ts', content: 'export interface Config { timeout: number; debug: boolean; }' },
      { path: 'types/ambient.d.ts', content: "declare module '../src/feature/target' { interface Config { retries: number; } }" }
    ]);
    const graph = makeGraph(['.']);

    // Claiming types/ambient.d.ts can be excluded because of directory distance must be REJECTED
    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/feature/target.ts'],
      claimedExcludedFiles: ['types/ambient.d.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of ambient augmentation outside directory must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'AMBIENT_AUGMENTATION_OUTSIDE_TARGET_DIR'),
      'Blocker code must be AMBIENT_AUGMENTATION_OUTSIDE_TARGET_DIR'
    );
    console.log('✓ Fixture 3 passed: Ambient augmentation outside target directory correctly retained.');
  }

  // =========================================================================
  // Fixture 4: Unresolved alias
  // =========================================================================
  console.log('Fixture 4: Unresolved alias...');
  {
    // src/consumer.ts imports from an unresolvable path alias '@/unresolved-alias/target'
    const parentSnap = makeSnapshot('snap_p_4', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 1; }' },
      { path: 'src/consumer.ts', content: "import { target } from '@/unresolved-alias/target';" }
    ]);
    const candSnap = makeSnapshot('snap_c_4', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 2; }' },
      { path: 'src/consumer.ts', content: "import { target } from '@/unresolved-alias/target';" }
    ]);
    const graph = makeGraph(['.']);

    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/consumer.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of unresolved alias file must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'UNRESOLVED_ALIAS_CANNOT_PROVE_DISJOINT'),
      'Blocker code must be UNRESOLVED_ALIAS_CANNOT_PROVE_DISJOINT'
    );
    console.log('✓ Fixture 4 passed: Unresolved path alias cannot be assumed disjoint; retained fail-closed.');
  }

  // =========================================================================
  // Fixture 5: Dynamic consumer
  // =========================================================================
  console.log('Fixture 5: Dynamic consumer...');
  {
    // File with dynamic import import(name) cannot be proven non-interfering
    const parentSnap = makeSnapshot('snap_p_5', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): string { return "v1"; }' },
      { path: 'src/dynamic.ts', content: 'export async function load(name: string) { return await import(name); }' }
    ]);
    const candSnap = makeSnapshot('snap_c_5', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): string { return "v2"; }' },
      { path: 'src/dynamic.ts', content: 'export async function load(name: string) { return await import(name); }' }
    ]);
    const graph = makeGraph(['.']);

    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/dynamic.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of dynamic consumer must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'DYNAMIC_CONSUMER_UNRESOLVED'),
      'Blocker code must be DYNAMIC_CONSUMER_UNRESOLVED'
    );
    console.log('✓ Fixture 5 passed: Dynamic consumer cannot be excluded without dynamic discharge proof.');
  }

  // =========================================================================
  // Fixture 6: Barrel cycle
  // =========================================================================
  console.log('Fixture 6: Barrel cycle...');
  {
    // barrelA <-> barrelB re-export cycle exposing target.ts to consumer.ts
    const parentSnap = makeSnapshot('snap_p_6', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 100; }' },
      { path: 'src/barrelA.ts', content: "export * from './barrelB'; export * from './target';" },
      { path: 'src/barrelB.ts', content: "export * from './barrelA';" },
      { path: 'src/consumer.ts', content: "import { target } from './barrelA'; const x = target();" }
    ]);
    const candSnap = makeSnapshot('snap_c_6', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 200; }' },
      { path: 'src/barrelA.ts', content: "export * from './barrelB'; export * from './target';" },
      { path: 'src/barrelB.ts', content: "export * from './barrelA';" },
      { path: 'src/consumer.ts', content: "import { target } from './barrelA'; const x = target();" }
    ]);
    const graph = makeGraph(['.']);

    const scope = ScopeIsolationEngine.computeTargetScope(candSnap, graph, ['src/target.ts']);
    assert.ok(scope.reverseConsumers.includes('src/consumer.ts'), 'Consumer reached through cyclic barrels');
    assert.ok(scope.allScopeFiles.includes('src/barrelA.ts'), 'BarrelA in scope');
    assert.ok(scope.allScopeFiles.includes('src/barrelB.ts'), 'BarrelB in scope');

    // Claiming consumer.ts can be excluded must be REJECTED
    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/consumer.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of cyclic barrel consumer must be REJECTED');
    console.log('✓ Fixture 6 passed: Barrel cycle safely traversed with complete consumer discovery.');
  }

  // =========================================================================
  // Fixture 7: Rename/move
  // =========================================================================
  console.log('Fixture 7: Rename/move...');
  {
    // target file is moved from src/legacy/calc.ts to src/modern/calc.ts
    const parentSnap = makeSnapshot('snap_p_7', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/legacy/calc.ts', content: 'export function calc(n: number): number { return n * 2; }' },
      { path: 'src/consumer.ts', content: "import { calc } from './legacy/calc'; const res = calc(5);" }
    ]);
    const candSnap = makeSnapshot('snap_c_7', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/modern/calc.ts', content: 'export function calc(n: number): number { return n * 2; }' },
      { path: 'src/consumer.ts', content: "import { calc } from './modern/calc'; const res = calc(5);" }
    ]);
    const graph = makeGraph(['.']);

    const parentScope = ScopeIsolationEngine.computeTargetScope(parentSnap, graph, ['src/legacy/calc.ts']);
    const candScope = ScopeIsolationEngine.computeTargetScope(candSnap, graph, ['src/modern/calc.ts']);

    assert.ok(parentScope.reverseConsumers.includes('src/consumer.ts'), 'Parent consumer recognized');
    assert.ok(candScope.reverseConsumers.includes('src/consumer.ts'), 'Candidate consumer recognized at new path');
    console.log('✓ Fixture 7 passed: File move tracked across revisions without losing consumer edge.');
  }

  // =========================================================================
  // Fixture 8: Added/removed project
  // =========================================================================
  console.log('Fixture 8: Added/removed project...');
  {
    // Candidate introduces packages/web project which imports packages/core/src/target.ts
    const parentSnap = makeSnapshot('snap_p_8', [
      { path: 'packages/core/tsconfig.json', content: '{}' },
      { path: 'packages/core/src/target.ts', content: 'export function ping(): string { return "pong"; }' }
    ]);
    const candSnap = makeSnapshot('snap_c_8', [
      { path: 'packages/core/tsconfig.json', content: '{}' },
      { path: 'packages/core/src/target.ts', content: 'export function ping(): string { return "pong"; }' },
      { path: 'packages/web/tsconfig.json', content: '{}' },
      { path: 'packages/web/src/app.ts', content: "import { ping } from '../../core/src/target'; const p = ping();" }
    ]);

    const parentGraph = makeGraph(['packages/core']);
    const candGraph = makeGraph(['packages/core', 'packages/web']);

    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: parentGraph,
      candidateProjectGraph: candGraph,
      targetProjectId: 'proj_0',
      targetFiles: ['packages/core/src/target.ts'],
      claimedExcludedFiles: ['packages/web/src/app.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Exclusion of newly added project consumer must be REJECTED');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'UNJUSTIFIED_BOUNDARY_EXCLUSION'),
      'Must reject with UNJUSTIFIED_BOUNDARY_EXCLUSION'
    );
    console.log('✓ Fixture 8 passed: Newly added project consumer detected and preserved in candidate scope.');
  }

  // =========================================================================
  // Fixture 9: Candidate-only new edge
  // =========================================================================
  console.log('Fixture 9: Candidate-only new edge...');
  {
    // In parent, worker.ts did NOT import target. In candidate, worker.ts acquires an import of target.
    const parentSnap = makeSnapshot('snap_p_9', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 1; }' },
      { path: 'src/worker.ts', content: 'export function work(): string { return "idle"; }' }
    ]);
    const candSnap = makeSnapshot('snap_c_9', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 1; }' },
      { path: 'src/worker.ts', content: "import { target } from './target'; export function work() { return target(); }" }
    ]);
    const graph = makeGraph(['.']);

    // Attempting to exclude worker.ts claiming it was disjoint in parent must be REJECTED
    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      claimedExcludedFiles: ['src/worker.ts']
    });

    assert.equal(res.status, 'REJECTED', 'Candidate-only new edge must block exclusion');
    assert.ok(
      res.rejectedExclusions?.some(r => r.blockerCode === 'CANDIDATE_NEW_EDGE_DETECTED'),
      'Blocker code must be CANDIDATE_NEW_EDGE_DETECTED'
    );
    console.log('✓ Fixture 9 passed: Candidate-only new edge blocks exclusion with dual-revision proof.');
  }

  // =========================================================================
  // Fixture 10: Malformed file provably outside an isolated sealed root
  // =========================================================================
  console.log('Fixture 10: Malformed file provably outside an isolated sealed root...');
  {
    // packages/app (clean target & consumer) vs packages/isolated-tool (contains broken syntax file)
    // Non-interference proof: independent tsconfig root, mutually disjoint roots, zero references.
    const parentSnap = makeSnapshot('snap_p_10', [
      { path: 'packages/app/tsconfig.json', content: '{}' },
      { path: 'packages/app/src/target.ts', content: 'export function run(): string { return "ok"; }' },
      { path: 'packages/app/src/consumer.ts', content: "import { run } from './target'; const res = run();" },
      { path: 'packages/isolated-tool/tsconfig.json', content: '{}' },
      { path: 'packages/isolated-tool/src/broken.ts', content: 'const broken = ;;; function ( { return' }
    ]);
    const candSnap = makeSnapshot('snap_c_10', [
      { path: 'packages/app/tsconfig.json', content: '{}' },
      { path: 'packages/app/src/target.ts', content: 'export function run(): string { return "ok"; }' },
      { path: 'packages/app/src/consumer.ts', content: "import { run } from './target'; const res = run();" },
      { path: 'packages/isolated-tool/tsconfig.json', content: '{}' },
      { path: 'packages/isolated-tool/src/broken.ts', content: 'const broken = ;;; function ( { return' }
    ]);

    const graph = makeGraph(['packages/app', 'packages/isolated-tool']);

    const cert = ScopeIsolationEngine.createExclusionCertificate({
      parentSnapshotId: parentSnap.snapshotId,
      candidateSnapshotId: candSnap.snapshotId,
      targetProjectId: 'proj_0',
      targetFiles: ['packages/app/src/target.ts'],
      declaredInventory: candSnap.files.map(f => f.path),
      includedScopeFiles: ['packages/app/src/target.ts', 'packages/app/src/consumer.ts'],
      excludedFiles: ['packages/isolated-tool/src/broken.ts'],
      forwardDependencies: [],
      reverseConsumers: ['packages/app/src/consumer.ts'],
      ambientAugmentations: [],
      isolationModel: 'INDEPENDENT_PROJECT_ROOT',
      exclusionJustifications: {
        'packages/isolated-tool/src/broken.ts': 'Provably isolated independent project root with zero cross-project imports'
      }
    });

    const res = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['packages/app/src/target.ts'],
      certificate: cert,
      isolationContract: {
        model: 'INDEPENDENT_PROJECT_ROOT',
        isolatedRoot: 'packages/isolated-tool'
      }
    });

    assert.equal(res.status, 'VERIFIED', 'Provably isolated root exclusion must be VERIFIED');
    assert.ok(
      !res.verifiedScope.includes('packages/isolated-tool/src/broken.ts'),
      'Isolated malformed file cleanly excluded from verified scope'
    );
    console.log('✓ Fixture 10 passed: Provably isolated root cleanly excluded without poisoning target scope.');
  }

  // =========================================================================
  // Fixture 11: Tampered exclusion evidence
  // =========================================================================
  console.log('Fixture 11: Tampered exclusion evidence...');
  {
    const parentSnap = makeSnapshot('snap_p_11', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 10; }' },
      { path: 'src/consumer.ts', content: "import { target } from './target'; target();" },
      { path: 'src/unrelated.ts', content: 'export const unrelated = 42;' }
    ]);
    const candSnap = makeSnapshot('snap_c_11', [
      { path: 'tsconfig.json', content: '{}' },
      { path: 'src/target.ts', content: 'export function target(): number { return 20; }' },
      { path: 'src/consumer.ts', content: "import { target } from './target'; target();" },
      { path: 'src/unrelated.ts', content: 'export const unrelated = 42;' }
    ]);
    const graph = makeGraph(['.']);

    // Subcase 11A: Forged certificate digest
    const validCert = ScopeIsolationEngine.createExclusionCertificate({
      parentSnapshotId: parentSnap.snapshotId,
      candidateSnapshotId: candSnap.snapshotId,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      declaredInventory: candSnap.files.map(f => f.path),
      includedScopeFiles: ['src/target.ts', 'src/consumer.ts'],
      excludedFiles: ['src/unrelated.ts'],
      forwardDependencies: [],
      reverseConsumers: ['src/consumer.ts'],
      ambientAugmentations: [],
      isolationModel: 'SEALED_CONTAINMENT',
      exclusionJustifications: { 'src/unrelated.ts': 'Zero imports or references' }
    });

    const forgedCert = {
      ...validCert,
      certificateDigest: '0'.repeat(64) // Forged hash
    };

    const resA = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      certificate: forgedCert
    });

    assert.equal(resA.status, 'REJECTED', 'Forged digest must be REJECTED');
    assert.ok(
      resA.rejectedExclusions?.some(r => r.blockerCode === 'HASH_MISMATCH'),
      'Blocker code must be HASH_MISMATCH'
    );

    // Subcase 11B: Tampered inventory (hiding consumer.ts from inventory)
    const tamperedInventoryCert = ScopeIsolationEngine.createExclusionCertificate({
      parentSnapshotId: parentSnap.snapshotId,
      candidateSnapshotId: candSnap.snapshotId,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      declaredInventory: ['tsconfig.json', 'src/target.ts', 'src/unrelated.ts'], // Omitted src/consumer.ts!
      includedScopeFiles: ['src/target.ts'],
      excludedFiles: ['src/unrelated.ts'],
      forwardDependencies: [],
      reverseConsumers: [],
      ambientAugmentations: [],
      isolationModel: 'SEALED_CONTAINMENT',
      exclusionJustifications: { 'src/unrelated.ts': 'Zero imports' }
    });

    const resB = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      certificate: tamperedInventoryCert
    });

    assert.equal(resB.status, 'REJECTED', 'Tampered inventory must be REJECTED');
    assert.ok(
      resB.rejectedExclusions?.some(r => r.blockerCode === 'INVENTORY_TAMPERED'),
      'Blocker code must be INVENTORY_TAMPERED'
    );

    // Subcase 11C: False non-interference claim (claiming consumer.ts is excluded)
    const falseClaimCert = ScopeIsolationEngine.createExclusionCertificate({
      parentSnapshotId: parentSnap.snapshotId,
      candidateSnapshotId: candSnap.snapshotId,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      declaredInventory: candSnap.files.map(f => f.path),
      includedScopeFiles: ['src/target.ts'],
      excludedFiles: ['src/consumer.ts'], // Actively imports target!
      forwardDependencies: [],
      reverseConsumers: [],
      ambientAugmentations: [],
      isolationModel: 'SEALED_CONTAINMENT',
      exclusionJustifications: { 'src/consumer.ts': 'Falsely claimed disjoint' }
    });

    const resC = ScopeIsolationEngine.verifyScopeIsolation({
      parentSnapshot: parentSnap,
      candidateSnapshot: candSnap,
      parentProjectGraph: graph,
      candidateProjectGraph: graph,
      targetProjectId: 'proj_0',
      targetFiles: ['src/target.ts'],
      certificate: falseClaimCert
    });

    assert.equal(resC.status, 'REJECTED', 'False exclusion claim must be REJECTED');
    assert.ok(
      resC.rejectedExclusions?.some(r => r.blockerCode === 'UNJUSTIFIED_BOUNDARY_EXCLUSION'),
      'Blocker code must be UNJUSTIFIED_BOUNDARY_EXCLUSION'
    );

    console.log('✓ Fixture 11 passed: Tampered exclusion evidence fail-closed across hash, inventory, and false claims.');
  }

  console.log('\n=== All 11 Phase 1B Mandatory Fixtures PASSED! ===');
}

runPhase1BTests().catch(err => {
  console.error('Phase 1B Test Failed:', err);
  process.exit(1);
});
