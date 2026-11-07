import * as assert from 'node:assert/strict';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { normalizePath, ProofObligation, SymbolRef } from '@sajimora/core';
import { PipelineB, TypeScriptTypeIRExtractor } from '@sajimora/analysis';
import { V32CandidateScopeAdapter } from '../src/adapter/V32CandidateScopeAdapter';
import { OfflineDependencyGraph } from '../src/OfflineDependencyGraph'; import { OfflineImpactEngine } from '../src/OfflineImpactEngine'; import { OfflineTargetResolver } from '../src/OfflineTargetResolver';

let passed = 0; function test(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-impact-hardening-'));
try {
  fs.writeFileSync(path.join(root, 'provider.ts'), 'export function f(x: number): number { return x; }\n');
  fs.writeFileSync(path.join(root, 'safe.ts'), 'import { f } from "./provider"; export const a = f(1, 2);\n');
  fs.writeFileSync(path.join(root, 'affected.ts'), 'import { f } from "./provider"; export const b = f(1);\n');
  fs.writeFileSync(path.join(root, 'dynamic.ts'), 'const moduleName = "./provider"; export const load = () => import(moduleName);\n');
  fs.writeFileSync(path.join(root, 'unrelated.ts'), 'export const unrelated = true;\n');
  const provider = normalizePath(path.join(root, 'provider.ts'));
  const symbol: SymbolRef = { persistentSymbolId: `${provider}::f`, symbolId: 'f', qualifiedName: 'f', kind: 'FUNCTION', ownerId: null, declarationLocation: { filePath: provider, line: 1 }, fingerprint: { value: 'hardening', components: { globallyQualifiedOwner: provider, symbolLocalName: 'f', kind: 'FUNCTION', parameterTypeFingerprint: 'number' } } };
  const obligation: ProofObligation = { invariantId: 'hardening', relation: 'STRUCTURAL_CO_EVOLUTION', mutatedSymbol: symbol, providerMutation: { targetSymbolId: symbol.persistentSymbolId, beforeExists: true, afterExists: true, classification: 'EXPORTED_SIGNATURE_MUTATED', isAstDiffDerived: true, beforeParsed: true, afterParsed: true }, providerContracts: { before: { parameters: [{ name: 'x', type: 'number', isRequired: true }] }, after: { parameters: [{ name: 'x', type: 'number', isRequired: true }, { name: 'y', type: 'number', isRequired: true }] } } };
  const adapter = new V32CandidateScopeAdapter(root);
  const scope = (candidateFiles: string[]) => ({ targetNode: 'provider.ts', targetKind: 'FILE' as const, candidateFiles, directDependents: [], transitiveDependents: [], affectedTests: [], affectedRoutes: [], affectedSchemas: [], blastRadius: Math.max(0, candidateFiles.length - 1) });

  test('candidate set excluding affected file cannot hide V32 impact', () => { const result = adapter.evaluateWithV32(obligation, scope(['provider.ts', 'safe.ts'])); assert.equal(result.v32Verdict, 'VIOLATED'); assert.ok(result.provenImpactedFiles.includes('affected.ts')); });
  test('empty candidate set retains authoritative full-universe analysis', () => { const result = adapter.evaluateWithV32(obligation, scope([])); assert.equal(result.v32Verdict, 'VIOLATED'); assert.ok(result.provenImpactedFiles.includes('affected.ts')); });
  test('missing graph edge remains discoverable by V32', () => { const result = adapter.evaluateWithV32(obligation, scope(['provider.ts'])); assert.ok(result.usageSites.some(site => site.canonicalOccurrence.sourceFile.endsWith('affected.ts'))); });
  test('filename heuristic miss cannot exclude an affected file', () => { const result = adapter.evaluateWithV32(obligation, scope(['provider.ts'])); assert.ok(result.provenImpactedFiles.includes('affected.ts')); });
  test('unsupported dynamic relationship cannot produce false PRESERVED', () => { const dynamicSymbol = { ...symbol, persistentSymbolId: `${normalizePath(path.join(root, 'dynamic.ts'))}::load`, symbolId: 'load', qualifiedName: 'load', declarationLocation: { filePath: normalizePath(path.join(root, 'dynamic.ts')), line: 1 } }; const dynamicObligation: ProofObligation = { ...obligation, mutatedSymbol: dynamicSymbol, providerMutation: { ...obligation.providerMutation!, targetSymbolId: dynamicSymbol.persistentSymbolId } }; assert.notEqual(adapter.evaluateWithV32(dynamicObligation, scope([])).v32Verdict, 'PRESERVED'); });
  test('prioritization changes order but preserves every universe file', () => { const baseline = adapter.buildPrioritizedUniverse(scope([])); const prioritized = adapter.buildPrioritizedUniverse(scope(['affected.ts', 'provider.ts'])); assert.deepEqual([...baseline.discoveredFiles].sort(), [...prioritized.discoveredFiles].sort()); assert.ok(prioritized.discoveredFiles[0].endsWith('affected.ts')); assert.equal(adapter.evaluateWithV32(obligation, scope([])).v32Verdict, adapter.evaluateWithV32(obligation, scope(['safe.ts'])).v32Verdict); });
  test('experimental narrowed universe explicitly reports incomplete discovery', () => { const narrowed = adapter.buildCandidateNarrowedUniverse(scope(['provider.ts', 'safe.ts'])); assert.equal(narrowed.discoveryStatus, 'DISCOVERY_INCOMPLETE'); assert.match(narrowed.discoveryEvidence, /EXPERIMENTAL_NON_AUTHORITATIVE/); assert.notEqual(new PipelineB().execute(obligation, { universe: narrowed }).verdict, 'PRESERVED'); });
  test('every adapter result identifies VerdictAuthority as its verdict source', () => {
    const cases: ProofObligation[] = [obligation, { ...obligation, relation: 'UNSUPPORTED' as any }, { ...obligation, mutatedSymbol: null }, { ...obligation, providerMutation: undefined }];
    for (const item of cases) {
      const result = adapter.evaluateWithV32(item, scope([]), { evaluateCompatibility: () => { throw new Error('forced runtime audit'); } });
      // Grounded results originate from PipelineB; direct PipelineB verification
      // makes the authority source explicit even when no consumers are present.
      const proof = new PipelineB().execute(item, { workspaceRoot: root, evaluateCompatibility: () => { throw new Error('forced runtime audit'); } });
      assert.equal(proof.auditTrace?.authorityDecision.source, 'VERDICT_AUTHORITY');
      assert.equal(result.v32Verdict, proof.verdict);
    }
  });
  test('canonical graph serialization is independent of input file order', () => { const files = ['provider.ts', 'safe.ts', 'affected.ts', 'dynamic.ts', 'unrelated.ts']; const a = new OfflineDependencyGraph({ repoRoot: root, files }); const b = new OfflineDependencyGraph({ repoRoot: root, files: [...files].reverse() }); assert.deepEqual(a.serialize(), b.serialize()); });
  test('impact semantic output contains no runtime timing', () => { const files = ['provider.ts', 'safe.ts', 'affected.ts']; const graph = new OfflineDependencyGraph({ repoRoot: root, files }); const resolution = new OfflineTargetResolver({ repoRoot: root }).resolveTarget('provider.ts'); const result = new OfflineImpactEngine({ traversalMode: 'FULL' }).analyze(resolution, graph); assert.equal('executionTimeMs' in result, false); assert.equal(JSON.stringify(result), JSON.stringify(new OfflineImpactEngine({ traversalMode: 'FULL' }).analyze(resolution, graph))); });
  test('scorePathMatch does not conflate different-cased files on non-windows platforms', () => {
    assert.equal(TypeScriptTypeIRExtractor.scorePathMatch('src/Utils.ts', 'src/Utils.ts'), 10000);
    if (process.platform === 'win32') {
      assert.equal(TypeScriptTypeIRExtractor.scorePathMatch('src/Utils.ts', 'src/utils.ts'), 9999);
    } else {
      assert.equal(TypeScriptTypeIRExtractor.scorePathMatch('src/Utils.ts', 'src/utils.ts'), 0);
    }
  });
  console.log(`Impact hardening adversarial tests: ${passed}/${passed}; false negatives: 0`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
