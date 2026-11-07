import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  SemanticIndexDatabase,
  PersistentSemanticProvider,
  SemanticIngestionWorker
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from '../campaign/realDiffObligationAdapter';
import { evaluateCommitPair } from '../campaign/campaign_runner';

console.log('================================================================');
console.log('Sajimora Phase 4 — Compiler-Isolated Semantic Ingestion Tests');
console.log('================================================================\n');

const repoName = 'zod';
const repoPath = path.resolve(`scripts/campaign/repos/${repoName}`);
const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
const candidateSha = '2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
const dependencyRoot = path.resolve(path.join(repoPath, 'node_modules'));

// ----------------------------------------------------------------------------
// Test 1: Ingestion Boundary Isolation (Single Commit)
// ----------------------------------------------------------------------------
console.log('--- Test 1: Ingestion Boundary Isolation (Single Commit) ---');
const dbMem = new SemanticIndexDatabase({ location: ':memory:' });
const worker = new SemanticIngestionWorker();

const singleCommitReport = worker.ingestCommit({
  repoName,
  repoPath,
  commitSha: parentSha,
  db: dbMem,
  dependencyRoot
});

assert.equal(singleCommitReport.repoName, repoName);
assert.equal(singleCommitReport.commitSha, parentSha);
assert.equal(singleCommitReport.certificatesCount, 1);
assert.ok(singleCommitReport.durationMs >= 0);

const cert = dbMem.getCompletenessCertificate(repoName, parentSha, 'root', 'COMMIT_INGESTION_UNIVERSE');
assert.ok(cert, 'Universe completeness certificate must exist');
assert.equal(cert.isComplete, true);
assert.equal(cert.failureCount, 0);

console.log('✅ PASS: Test 1 — Ingestion worker isolated single commit extraction and persisted certificate\n');

// ----------------------------------------------------------------------------
// Test 2: Full Commit Pair Ingestion & Compiler Leak Verification
// ----------------------------------------------------------------------------
console.log('--- Test 2: Full Commit Pair Ingestion & Compiler Leak Verification ---');
const pairDb = new SemanticIndexDatabase({ location: ':memory:' });

const derivation = deriveRealDiffObligations(repoPath, parentSha, candidateSha);
assert.equal(derivation.status, 'DERIVED', 'Obligations must be successfully derived');
assert.ok(derivation.obligations.length > 0, 'Must have at least one obligation');

const pairReport = worker.ingestCommitPair({
  repoName,
  repoPath,
  parentSha,
  candidateSha,
  db: pairDb,
  dependencyRoot,
  obligations: derivation.obligations
});

assert.equal(pairReport.repoName, repoName);
assert.equal(pairReport.parentSha, parentSha);
assert.equal(pairReport.candidateSha, candidateSha);
assert.equal(pairReport.proofObligationsCount, derivation.obligations.length);
assert.ok(pairReport.candidateContractsCount > 0, 'Candidate contracts must be ingested');
assert.ok(pairReport.historicalObligationsCount > 0, 'Historical obligations must be ingested');
assert.ok(pairReport.certificatesCount > 0, 'Completeness certificates must be ingested');
assert.ok(pairReport.identityMappingsCount > 0, 'Identity mappings must be ingested');

// Verify zero compiler objects leaked into any SQLite table
const allTables = [
  'type_ir_artifacts',
  'language_contract_artifacts',
  'candidate_contract_artifacts',
  'usage_contract_artifacts',
  'obligation_artifacts',
  'identity_mapping_artifacts',
  'completeness_certificates'
];

const rawDb = (pairDb as any).db;
for (const table of allTables) {
  const rows = rawDb.prepare(`SELECT payload_json FROM ${table}`).all() as Array<{ payload_json: string }>;
  assert.ok(rows.length > 0, `Table ${table} must contain ingested records`);
  for (const row of rows) {
    const parsed = JSON.parse(row.payload_json);
    // Recursively assert no compiler objects exist in persisted payloads
    SemanticIndexDatabase.assertNoCompilerObjects(parsed);
  }
}

console.log(`✅ PASS: Test 2 — Pair ingested (${pairReport.candidateContractsCount} contracts, ${pairReport.historicalObligationsCount} historical, ${pairReport.certificatesCount} certs). Zero compiler objects leaked.\n`);

// ----------------------------------------------------------------------------
// Test 3: Provider Parity Verification (SQLite Persistent Provider vs Extracted DTOs)
// ----------------------------------------------------------------------------
console.log('--- Test 3: Provider Parity Verification ---');
const persistentProvider = new PersistentSemanticProvider({
  db: pairDb,
  repoName,
  parentSha,
  candidateSha,
  projectKey: 'root'
});

for (const obligation of derivation.obligations) {
  const targetId = obligation.mutatedSymbol?.symbolId ?? obligation.mutatedSymbol?.persistentSymbolId;
  assert.ok(targetId, 'Target symbol must have an identifier');

  const contract = persistentProvider.getCandidateContract(targetId, obligation.mutatedSymbol?.qualifiedName ?? targetId);
  assert.ok(contract, `Candidate contract for ${targetId} must be resolvable via persistent provider`);
  assert.equal(contract.targetSymbolId, targetId);
  SemanticIndexDatabase.assertNoCompilerObjects(contract);

  const storedObligation = pairDb.getObligation(repoName, parentSha, candidateSha, targetId);
  assert.ok(storedObligation, `Stored obligation for ${targetId} must exist`);
  assert.equal(storedObligation.invariantId, obligation.invariantId);
}

console.log('✅ PASS: Test 3 — Persistent provider reconstructs exact DTOs without compiler runtime\n');

// ----------------------------------------------------------------------------
// Test 4: Authoritative Completeness Certificates
// ----------------------------------------------------------------------------
console.log('--- Test 4: Authoritative Completeness Certificates ---');
const expectedClosures = [
  'ValueReferenceClosure',
  'TypeReferenceClosure',
  'InheritanceClosure',
  'InterfaceImplClosure',
  'OverrideClosure',
  'ReExportClosure',
  'AmbientReferenceClosure'
];

for (const closureKind of expectedClosures) {
  const cert = pairDb.getCompletenessCertificate(repoName, parentSha, 'root', closureKind);
  assert.ok(cert, `Completeness certificate for ${closureKind} must exist`);
  assert.equal(cert.repoName, repoName);
  assert.equal(cert.commitSha, parentSha);
  assert.equal(cert.closureKind, closureKind);
  // assertCompleteness passes when complete
  assert.ok(pairDb.assertCompleteness(repoName, parentSha, 'root', closureKind));
}

// Assert fail-closed behavior on missing closure
assert.throws(
  () => pairDb.assertCompleteness(repoName, parentSha, 'root', 'NON_EXISTENT_CLOSURE'),
  /COMPLETENESS_CERTIFICATE_MISSING/,
  'Must fail closed when completeness certificate is missing'
);

console.log('✅ PASS: Test 4 — All 7 closure completeness certificates verified and fail-closed enforced\n');

// ----------------------------------------------------------------------------
// Test 5: Golden Evidence SHA-256 Parity Gate
// ----------------------------------------------------------------------------
console.log('--- Test 5: Golden Evidence SHA-256 Parity Gate ---');

function stripSnapshotRoot(str: string): string {
  return str.replace(/(?:[A-Za-z]:[/\\][^\s"']*?|[^\s"']*?)[/\\]?sajimora-snapshot-[^/\\"\s']+[/\\]?/gi, 'snapshot/');
}

function canonical(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripSnapshotRoot(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'durationMs' && key !== 'peakRssBytes')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function firstDifference(expected: unknown, actual: unknown, at = '$'): { path: string; expected: unknown; actual: unknown } | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return { path: `${at}.length`, expected: expected.length, actual: actual.length };
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${at}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
    for (const key of keys) {
      if (!(key in expectedRecord)) return { path: `${at}.${key}`, expected: undefined, actual: actualRecord[key] };
      if (!(key in actualRecord)) return { path: `${at}.${key}`, expected: expectedRecord[key], actual: undefined };
      const difference = firstDifference(expectedRecord[key], actualRecord[key], `${at}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return { path: at, expected, actual };
}

const EXPECTED_GOLDEN_SHA256 = '15bd6680c7d505f73bceaa56403a8c9c101de20fa69b46f5d0678d153558f255';

// Run evaluation using PersistentSemanticProvider with the exact baseline subject
const evalResult = evaluateCommitPair(
  repoName,
  repoPath,
  parentSha,
  candidateSha,
  'Phase-4 controlled memory profile',
  dependencyRoot,
  {
    provider: persistentProvider
  }
);

const normalized = canonical(evalResult);
const actualHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

console.log(`Golden Expected SHA-256 : ${EXPECTED_GOLDEN_SHA256}`);
console.log(`Actual Evaluated SHA-256: ${actualHash}`);

if (actualHash !== EXPECTED_GOLDEN_SHA256) {
  // Run baseline for comparison
  const baselineResult = evaluateCommitPair(
    repoName,
    repoPath,
    parentSha,
    candidateSha,
    'Phase-4 controlled memory profile',
    dependencyRoot
  );
  const normalizedBaseline = canonical(baselineResult);
  const diff = firstDifference(normalizedBaseline, normalized);
  console.error('Difference between baseline and persistent provider:', JSON.stringify(diff, null, 2));
}

assert.equal(
  actualHash,
  EXPECTED_GOLDEN_SHA256,
  `EVIDENCE_PARITY_MISMATCH: Ingestion-backed persistent provider produced hash ${actualHash}, expected ${EXPECTED_GOLDEN_SHA256}`
);

console.log('\n================================================================');
console.log('🎉 ALL 5 PHASE 4 INGESTION TESTS PASSED — BIT-EXACT GOLDEN PARITY CERTIFIED');
console.log('================================================================\n');
