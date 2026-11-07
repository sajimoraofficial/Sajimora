import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const statusPath = path.resolve('scripts/campaign/legacy_39_status.json');
const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
assert.equal(status.legacy_39_status, 'HISTORICAL_DEBUG_DATA_ONLY');
assert.equal(status.performance_benchmark, false);
assert.equal(status.correctness_labels, false);
assert.equal(status.release_gate, false);
console.log('Legacy 39 retirement enforcement passed.');
