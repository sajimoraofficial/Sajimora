import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTypeScriptReadinessDesign } from './generate_typescript_readiness_campaign';

test('10K TypeScript readiness design meets every declared pair and value requirement reproducibly', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-ts-readiness-'));
  try {
    const firstPath = path.join(temp, 'first.json');
    const secondPath = path.join(temp, 'second.json');
    const first = generateTypeScriptReadinessDesign(undefined, firstPath);
    const second = generateTypeScriptReadinessDesign(undefined, secondPath);
    assert.equal(first.execution.plannedCaseCount, 10000);
    assert.equal(first.status, 'DESIGN_ONLY_FIXTURES_AND_ORACLES_REQUIRED');
    assert.equal(first.coverage.uncoveredPairs.length, 0);
    assert.equal(first.coverage.missingTaxonomyItems.length, 0);
    assert.equal(first.coverage.representedTaxonomyItemCount, first.coverage.taxonomyItemCount);
    assert.equal(first.coverage.p0CertificationStatus, 'NOT_ASSESSED_FIXTURES_AND_VERDICTS_NOT_MATERIALIZED');
    assert.deepEqual(Object.values(first.coverage.missingValues), Object.values(second.coverage.missingValues));
    assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(secondPath));
    assert.equal(first.coverage.highRiskCompositionCounts['unrelated_unsupported_noise'] > 0, true);
    assert.equal(first.cases.filter(row => row.failClosedFamily).length, 14);
    assert.ok(first.cases.every(row => row.materialization === 'NOT_MATERIALIZED' && row.oracle.source === null));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
