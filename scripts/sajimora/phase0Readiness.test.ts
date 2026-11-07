import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), 'utf8'));
}

const baseline = readJson('tests/sajimora/phase0/baseline.json');
assert.match(baseline.implementationSha, /^[0-9a-f]{40}$/);
assert.equal(baseline.worktreeAtCapture, 'CLEAN');
assert.equal(baseline.cliSchemaVersion, 'V32.9-TS-cli-v1');

const legacy = readJson('scripts/campaign/legacy_39_status.json');
assert.equal(legacy.correctness_labels, false);
assert.equal(legacy.release_gate, false);

const diagnostics = readJson('tests/sajimora/fixtures/diagnostics/zod-observations.json');
assert.equal(diagnostics.kind, 'DIAGNOSTIC');
assert.equal(diagnostics.evidence.authority, 'NON_AUTHORITATIVE_DIAGNOSTIC_ONLY');
assert.equal('correctnessLabel' in diagnostics, false);
assert.deepEqual(
  diagnostics.evidence.observations.map((item: any) => item.stoppingPoint),
  ['SEMANTIC_SCOPE', 'COMPATIBILITY']
);

console.log('BASELINE_SHA_RECORDED: YES');
console.log('LEGACY_39_USED_AS_TRUTH: NO');
console.log('PHASE_0_STATIC_READINESS: PASS');
