import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SemanticIndexDatabase,
  PersistentSemanticProvider,
  CURRENT_SCHEMA_VERSION,
  TypeScriptTypeIR,
  TypeScriptTypeIRExtractor,
  LanguageContractIR,
  ProviderCandidateContract,
  ProviderHistoricalObligation,
  TypeScriptCompatibility
} from '@sajimora/analysis';

console.log('================================================================');
console.log('Sajimora Phase 3 — Embedded Persistent Semantic Index Test Suite');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// Test 1: DB / Schema / PRAGMA / Version Gates
// ----------------------------------------------------------------------------
const db = new SemanticIndexDatabase({ location: ':memory:' });

// Test schema version record
const rawDb = (db as any).db;
const versionRow = rawDb.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get();
assert.equal(versionRow.value, CURRENT_SCHEMA_VERSION, 'Schema version must match CURRENT_SCHEMA_VERSION');

// Test foreign key pragma
const fkRow = rawDb.prepare('PRAGMA foreign_keys;').get();
assert.equal(Number(fkRow.foreign_keys), 1, 'Foreign keys must be enabled in SQLite');

console.log('✅ PASS: Test 1 — DB initialization, PRAGMAs, and schema versioning validated');

// ----------------------------------------------------------------------------
// Test 2: TypeIR Round-Trip + Exact irContentHash
// ----------------------------------------------------------------------------
const primitiveIR: TypeScriptTypeIR = TypeScriptTypeIRExtractor.createPrimitiveIR('string', 'PARENT');
const numberIR: TypeScriptTypeIR = TypeScriptTypeIRExtractor.createPrimitiveIR('number', 'PARENT');
const callableIR: TypeScriptTypeIR = {
  schemaVersion: 'SAJIMORA_TYPE_IR_V1',
  kind: 'CALLABLE',
  display: '(x: string) => number',
  irContentHash: 'hash-callable-storage-test',
  signatures: [
    {
      parameters: [
        {
          name: 'x',
          type: primitiveIR,
          isRequired: true,
          isRest: false,
          isOptional: false
        }
      ],
      returnType: numberIR,
      declarationOrdinal: 0
    }
  ]
};

db.putTypeIR(primitiveIR);
db.putTypeIR(callableIR);

const retrievedPrimitive = db.getTypeIR(primitiveIR.irContentHash);
assert.ok(retrievedPrimitive, 'Primitive TypeIR must be retrievable');
assert.equal(retrievedPrimitive.irContentHash, primitiveIR.irContentHash, 'Primitive TypeIR hash must match');
assert.equal(retrievedPrimitive.kind, primitiveIR.kind, 'Primitive TypeIR kind must match');

const retrievedCallable = db.getTypeIR(callableIR.irContentHash);
assert.ok(retrievedCallable, 'Callable TypeIR must be retrievable');
assert.equal(retrievedCallable.irContentHash, callableIR.irContentHash, 'Callable TypeIR hash must match');
assert.equal(retrievedCallable.kind, callableIR.kind, 'Callable TypeIR kind must match');
assert.equal(retrievedCallable.signatures?.length, 1, 'Callable TypeIR signatures preserved');

console.log('✅ PASS: Test 2 — TypeIR persistence preserves exact irContentHash and structure');

// ----------------------------------------------------------------------------
// Test 3: LanguageContractIR Round-Trip Parity
// ----------------------------------------------------------------------------
const contractIR: LanguageContractIR<TypeScriptTypeIR> = {
  schemaVersion: 'SAJIMORA_LANGUAGE_CONTRACT_V1',
  languageId: 'typescript',
  symbolId: 'src/math.ts.FUNCTION:add@0',
  qualifiedName: 'src/math.ts#add',
  declarationKind: 'FUNCTION',
  contractType: callableIR,
  contractHash: 'contract-hash-storage-test'
};

db.putLanguageContract('test-repo', 'commit-1', 'root', contractIR);
const retrievedContract = db.getLanguageContract('test-repo', 'commit-1', 'root', contractIR.symbolId);

assert.ok(retrievedContract, 'LanguageContractIR must be retrievable');
assert.equal(retrievedContract.symbolId, contractIR.symbolId);
assert.equal(retrievedContract.qualifiedName, contractIR.qualifiedName);
assert.equal(retrievedContract.declarationKind, contractIR.declarationKind);
assert.equal(retrievedContract.contractType.irContentHash, callableIR.irContentHash);

console.log('✅ PASS: Test 3 — LanguageContractIR persistence preserves exact contract structure');

// ----------------------------------------------------------------------------
// Test 4: ProviderCandidateContract Round-Trip (including deleted state)
// ----------------------------------------------------------------------------
const candContract: ProviderCandidateContract = {
  targetSymbolId: 'src/math.ts.FUNCTION:add@0',
  targetName: 'add',
  declarationLocation: { filePath: 'src/math.ts', line: 10, column: 5 },
  contractIR
};

db.putCandidateContract('test-repo', 'commit-1', 'root', candContract);
const retrievedCand = db.getCandidateContract('test-repo', 'commit-1', 'root', candContract.targetSymbolId);

assert.ok(retrievedCand, 'Candidate contract must be retrievable');
assert.equal(retrievedCand.targetSymbolId, candContract.targetSymbolId);
assert.equal(retrievedCand.targetName, candContract.targetName);
assert.equal(retrievedCand.contractIR?.symbolId, contractIR.symbolId);

// Deleted symbol candidate contract
const deletedCandContract: ProviderCandidateContract = {
  targetSymbolId: 'src/legacy.ts.VARIABLE:oldValue@0',
  targetName: 'oldValue',
  isDeleted: true,
  blockerId: undefined
};

db.putCandidateContract('test-repo', 'commit-1', 'root', deletedCandContract);
const retrievedDeleted = db.getCandidateContract('test-repo', 'commit-1', 'root', deletedCandContract.targetSymbolId);

assert.ok(retrievedDeleted, 'Deleted candidate contract must be retrievable');
assert.equal(retrievedDeleted.isDeleted, true, 'isDeleted state must be preserved as true');

console.log('✅ PASS: Test 4 — ProviderCandidateContract preserves candidate and deleted-symbol state');

// ----------------------------------------------------------------------------
// Test 5: ProviderHistoricalObligation Round-Trip (including selectedSignatureIndex)
// ----------------------------------------------------------------------------
const histObligation: ProviderHistoricalObligation = {
  usageSiteId: 'site-call-storage-test-1',
  occurrenceId: 'occ-call-storage-test-1',
  selectedSignatureIndex: 0,
  specializedContract: {
    schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
    languageId: 'typescript',
    usageRole: 'CALL_SITE',
    expectedType: numberIR,
    arguments: [
      {
        position: 0,
        type: primitiveIR,
        isFreshLiteral: false,
        argumentName: 'x'
      }
    ],
    isDiscardedReturn: false,
    hasCompleteSpecializationEvidence: true,
    usageHash: 'usage-hash-storage-test-1'
  }
};

db.putHistoricalObligation('test-repo', 'commit-1', 'root', histObligation);
const retrievedHist = db.getHistoricalObligation(histObligation.usageSiteId);

assert.ok(retrievedHist, 'Historical obligation must be retrievable');
assert.equal(retrievedHist.usageSiteId, histObligation.usageSiteId);
assert.equal(retrievedHist.selectedSignatureIndex, 0, 'selectedSignatureIndex must be preserved');
assert.equal(retrievedHist.specializedContract?.expectedType.irContentHash, numberIR.irContentHash);
assert.equal(retrievedHist.specializedContract?.arguments?.[0].type.irContentHash, primitiveIR.irContentHash);

console.log('✅ PASS: Test 5 — ProviderHistoricalObligation preserves overload index and argument expectations');

// ----------------------------------------------------------------------------
// Test 6: Corruption / Checksum / Missing-Artifact Fail-Closed Tests
// ----------------------------------------------------------------------------
// Tamper with language contract payload
rawDb.prepare(
  "UPDATE language_contract_artifacts SET payload_json = 'corrupted {json}' WHERE contract_id = ?"
).run(`test-repo:commit-1:root:${contractIR.symbolId}`);

assert.throws(
  () => db.getLanguageContract('test-repo', 'commit-1', 'root', contractIR.symbolId),
  /STORAGE_INTEGRITY_FAILURE/,
  'Database must fail closed with STORAGE_INTEGRITY_FAILURE on corrupted JSON'
);

// Conflict on immutable overwrite
assert.throws(
  () => {
    db.putTypeIR({
      ...primitiveIR,
      display: 'conflicting_display'
    });
  },
  /IMMUTABLE_ARTIFACT_CONFLICT/,
  'Database must reject conflicting overwrite of an existing TypeIR artifact'
);

console.log('✅ PASS: Test 6 — Corruption detection and immutability conflict guards fail closed');

// ----------------------------------------------------------------------------
// Test 7: Completeness Certificate Enforcement
// ----------------------------------------------------------------------------
assert.throws(
  () => db.assertCompleteness('test-repo', 'commit-1', 'root', 'VALUE_REFERENCE'),
  /COMPLETENESS_CERTIFICATE_MISSING/,
  'assertCompleteness must fail closed when certificate is missing'
);

// Store incomplete certificate
db.putCompletenessCertificate({
  repoName: 'test-repo',
  commitSha: 'commit-1',
  projectKey: 'root',
  closureKind: 'VALUE_REFERENCE',
  isComplete: false,
  failureCount: 2,
  timestamp: Date.now()
});

assert.throws(
  () => db.assertCompleteness('test-repo', 'commit-1', 'root', 'VALUE_REFERENCE'),
  /COMPLETENESS_CERTIFICATE_INCOMPLETE/,
  'assertCompleteness must fail closed when certificate indicates incomplete traversal'
);

// Store complete certificate
db.putCompletenessCertificate({
  repoName: 'test-repo',
  commitSha: 'commit-1',
  projectKey: 'root',
  closureKind: 'INHERITANCE',
  isComplete: true,
  failureCount: 0,
  timestamp: Date.now()
});

assert.equal(
  db.assertCompleteness('test-repo', 'commit-1', 'root', 'INHERITANCE'),
  true,
  'assertCompleteness must pass when authoritative certificate verifies completeness'
);

console.log('✅ PASS: Test 7 — Authoritative completeness certificate enforcement validated');

// ----------------------------------------------------------------------------
// Test 8: SQLite-backed PersistentSemanticProvider Proof Parity
// ----------------------------------------------------------------------------
const persistentProvider = new PersistentSemanticProvider({
  db,
  repoName: 'test-repo',
  parentSha: 'commit-parent',
  candidateSha: 'commit-1',
  projectKey: 'root'
});

const evaluator = new TypeScriptCompatibility(
  undefined,
  { mutatedSymbol: { symbolId: 'src/math.ts.FUNCTION:add@0', qualifiedName: 'add' } } as any,
  {
    isPhase4Mode: true,
    provider: persistentProvider
  }
);

const callSite: any = {
  usageSiteId: 'site-call-storage-test-1',
  canonicalOccurrence: {
    occurrenceId: 'occ-call-storage-test-1',
    usageRole: 'CALL_SITE',
    sourceFile: 'src/consumer.ts',
    sourceSpan: { start: 10, end: 25, line: 1, column: 1 },
    resolutionStatus: 'RESOLVED'
  },
  evaluationStatus: 'EVALUABLE',
  identityResult: 'SAME'
};

const result = evaluator.evaluateSite(callSite);
assert.equal(result.status, 'COMPATIBLE', 'Persistent provider must evaluate CALL_SITE to COMPATIBLE');
assert.ok(result.phase4Evidence, 'Phase 4 proof evidence must be generated from persistent provider DTOs');

console.log('✅ PASS: Test 8 — PersistentSemanticProvider executes compiler-free evaluation against SQLite');

console.log('\n================================================================');
console.log('Phase 3 Storage Verification: ALL GATES PASSED');
console.log('================================================================\n');
