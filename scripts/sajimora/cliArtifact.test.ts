import * as assert from 'node:assert/strict';
import { CLI_SCHEMA_VERSION, cliArtifactSchema, serializeCliArtifact } from './cliArtifact';

const success = {
  schemaVersion: CLI_SCHEMA_VERSION,
  repository: '/fixture', parentSha: 'parent', candidateSha: 'candidate',
  derivation: { changedFiles: ['src/provider.ts'], actualDiff: 'diff --git a/src/provider.ts b/src/provider.ts' },
  results: [{ target: null, mutation: null, contracts: null, verdict: 'UNKNOWN', auditTrace: null }]
};
const failure = { schemaVersion: CLI_SCHEMA_VERSION, status: 'NO_SUPPORTED_MUTATION', derivation: { reason: 'golden' } };

assert.equal(cliArtifactSchema.safeParse(success).success, true);
assert.equal(cliArtifactSchema.safeParse(failure).success, true);
assert.equal(cliArtifactSchema.safeParse({ ...success, schemaVersion: 'future' }).success, false);
assert.equal(serializeCliArtifact(success), serializeCliArtifact(success), 'serialization must be byte-stable');
assert.ok(serializeCliArtifact(success).indexOf('"candidateSha"') < serializeCliArtifact(success).indexOf('"parentSha"'));
assert.equal(JSON.parse(serializeCliArtifact(success)).results[0].verdict, 'UNKNOWN', 'serializer must preserve authority verdict');

console.log('CLI artifact schema and canonical serialization goldens passed.');
