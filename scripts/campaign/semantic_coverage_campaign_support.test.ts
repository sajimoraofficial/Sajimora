import assert from 'node:assert/strict';
import { buildRepository, exactVerdictMatch, validateQueries } from './semantic_coverage_campaign_support';
import { CoverageQuery } from './coverage_types';

const query: CoverageQuery = {
  id: 'GENERIC-001', tier: 1, level: 'L1_SINGLE', family: 'TEST', features: ['signature'],
  description: 'generic validation fixture', parentFiles: { 'src/a.ts': 'export const a = 1;' },
  candidateFiles: { 'src/a.ts': 'export const a = 2;' }, expectedVerdict: 'PRESERVED', staticProvable: true
};

assert.equal(exactVerdictMatch('PRESERVED', 'PRESERVED'), true);
assert.equal(exactVerdictMatch('PRESERVED', 'NOT_APPLICABLE'), false);
assert.equal(exactVerdictMatch('UNKNOWN', 'VIOLATED'), false);

const valid = validateQueries([query], 1);
assert.equal(valid.valid, true, valid.errors.join('\n'));
assert.equal(valid.uniqueIds, 1);
assert.equal(valid.querySetDigest.length, 64);

const duplicate = validateQueries([query, query]);
assert.equal(duplicate.valid, false);
assert.ok(duplicate.errors.some(error => error.includes('Duplicate query id')));

const syntaxError = validateQueries([{ ...query, id: 'GENERIC-002', candidateFiles: { 'src/a.ts': 'export const = ;' } }]);
assert.equal(syntaxError.valid, false);
assert.ok(syntaxError.errors.some(error => error.includes('TS')));

const repo = buildRepository(query.id, query.parentFiles, query.candidateFiles);
assert.notEqual(repo.parentSnapshot.snapshotId, repo.candidateSnapshot.snapshotId);
assert.equal(repo.parentSnapshot.files[0].hash.length, 64);
assert.notEqual(repo.parentSnapshot.files[0].hash, repo.candidateSnapshot.files[0].hash);
assert.deepEqual(repo.parentSnapshot.readBinaryFile('src/a.ts'), Buffer.from(query.parentFiles['src/a.ts'], 'utf8'));

console.log('semantic coverage campaign support tests passed');
