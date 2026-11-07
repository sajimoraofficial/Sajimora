/**
 * Test Suite 1: Expected Change Model (ECM)
 * Verifies Test Requirement 1, ECM-R1 through ECM-R8.
 */

import * as assert from 'assert';
import {
  computeChangeId,
  normalizePosixPath,
  isPathBoundaryViolated,
  validateAndBuildEcm,
  EcmBuilder,
  extractExpectationsFromText,
} from '../src';

console.log('--- Running ECM Tests ---');

// 1. Deterministic changeId (ECM-R1)
const ws = 'ws-test-123';
const baseSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const candSha = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';
const changeId1 = computeChangeId(ws, baseSha, candSha);
const changeId2 = computeChangeId(ws, baseSha, candSha);
assert.strictEqual(changeId1.length, 64, 'changeId must be 64-character SHA-256 hex');
assert.strictEqual(changeId1, changeId2, 'changeId derivation must be fully deterministic');

// 2. Candidate commit SHA required (OQ-4)
assert.throws(
  () => {
    validateAndBuildEcm({
      workspaceId: ws,
      baseCommitSha: baseSha,
      candidateCommitSha: '', // missing
    });
  },
  /candidateCommitSha is mandatory/,
  'Missing candidateCommitSha must throw hard validation error'
);

// 3. Path normalization & traversal rejection (ECM-R2)
assert.strictEqual(normalizePosixPath('src\\parser\\file.ts'), 'src/parser/file.ts');
assert.strictEqual(normalizePosixPath('/src/parser/file.ts'), 'src/parser/file.ts');
assert.strictEqual(normalizePosixPath('src/../etc/passwd'), null, 'Traversal must return null');
assert.strictEqual(normalizePosixPath('..\\secret.key'), null, 'Windows traversal must return null');

// 4. ChangeBoundary exact prefix match (ECM-R5)
assert.strictEqual(isPathBoundaryViolated('packages/core/secret.ts', 'packages/core'), true);
assert.strictEqual(isPathBoundaryViolated('packages/core', 'packages/core'), true);
assert.strictEqual(isPathBoundaryViolated('packages/core-extra/file.ts', 'packages/core'), false);
assert.strictEqual(isPathBoundaryViolated('other/file.ts', 'packages/core'), false);

// 5. Empty expectations -> PARTIAL with overallConfidence = 0.0 (ECM-R4)
const emptyEcm = validateAndBuildEcm({
  workspaceId: ws,
  baseCommitSha: baseSha,
  candidateCommitSha: candSha,
});
assert.strictEqual(emptyEcm.validationStatus, 'PARTIAL');
assert.strictEqual(emptyEcm.overallConfidence, 0.0);
assert.ok(emptyEcm.validationErrors.some((e) => e.includes('zero expectations')));

// 6. UNKNOWN provenance confidence cap at 0.3 (ECM-R6)
const builder = new EcmBuilder(ws, baseSha, candSha);
builder.expectFile({
  filePath: 'src/index.ts',
  changeType: 'MODIFIED',
  provenance: 'UNKNOWN',
  confidence: 0.9, // must be clamped to 0.3
});
const ecmWithUnknown = builder.build();
assert.strictEqual(ecmWithUnknown.expectedFiles[0].confidence, 0.3);
assert.strictEqual(ecmWithUnknown.validationStatus, 'VALID');

// 7. Commit extractor deterministic parsing (ECM-R7)
const commitMsg = `feat(parser): update AstExtractor
modified: packages/ingestion/src/parser/AstExtractor.ts
function \`parseFile\` signature changed
Closes #42`;
const extracted = extractExpectationsFromText(commitMsg);
assert.strictEqual(extracted.expectedFiles.length, 1);
assert.strictEqual(extracted.expectedFiles[0].filePath, 'packages/ingestion/src/parser/AstExtractor.ts');
assert.strictEqual(extracted.expectedSymbols.length, 1);
assert.strictEqual(extracted.expectedSymbols[0].symbolName, 'parseFile');
assert.strictEqual(extracted.expectedBehavioralObligations.length, 1);
assert.strictEqual(extracted.expectedBehavioralObligations[0].obligationId, '#42');

console.log('✓ All ECM Tests Passed.');
