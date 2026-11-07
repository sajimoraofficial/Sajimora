import * as assert from 'node:assert/strict';
import {
  INDEX_SCHEMA_VERSION,
  createGenerationIdentity,
  sameCommitIdentity,
  type CommitIndexIdentity
} from '../../src';

const identity: CommitIndexIdentity = {
  schemaVersion: INDEX_SCHEMA_VERSION,
  extractorVersion: 'extractor',
  proofRulesVersion: 'frozen-rules',
  repositoryId: 'repo-a',
  commitSha: 'a'.repeat(40),
  toolchainFingerprint: 'toolchain',
  configFingerprint: 'config',
  dependencyFingerprint: 'deps', externalDependencyFingerprint: 'NONE'
};

const first = createGenerationIdentity(identity, 'attempt-1');
const repeat = createGenerationIdentity(identity, 'attempt-1');
const second = createGenerationIdentity(identity, 'attempt-2');
assert.deepEqual(first, repeat);
assert.notEqual(first.generationId, second.generationId);
assert.equal(sameCommitIdentity(identity, { ...identity }), true);
assert.equal(sameCommitIdentity(identity, { ...identity, repositoryId: 'repo-b' }), false);
console.log('Index identity V2: PASS');
