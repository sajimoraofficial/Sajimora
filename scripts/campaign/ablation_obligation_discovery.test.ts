import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runAblationProducers } from './run_ablation_producers';

test('ablation fixtures reach obligation discovery without bypassing fail-closed checks', () => {
  const input = path.resolve('scripts/campaign/fixtures/ablation_8_cases_sealed.json');
  const results = runAblationProducers(input) as Array<any>;
  assert.equal(results.length, 8);
  for (const result of results) {
    if (['CASE-1A', 'CASE-1B', 'CASE-2A', 'CASE-2B', 'CASE-3A', 'CASE-3B', 'CASE-4A', 'CASE-4B'].includes(result.id)) {
      assert.equal(result.status, 'PRODUCED');
      assert.equal(result.obligations, 1);
      assert.equal(result.parent.reached, 2);
      assert.equal(result.candidate.reached, 2);
      assert.ok(result.identity?.certified);
    } else {
      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.reason, 'no historical call-site obligations discovered');
      assert.equal(result.occurrences, 0);
      assert.ok(result.bindingDiagnostics.every((diagnostic: any) => diagnostic.valid), result.id);
      assert.deepEqual(result.bindingDiagnostics.map((diagnostic: any) => diagnostic.imports), [['target'], []]);
    }
  }
});
