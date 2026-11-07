import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCertifiedCampaign, type CertifiedCampaignOutputItem, type QueryItem } from './run_campaign_50';

const query = (id: string): QueryItem => ({ queryId: id, repository: 'fixture', parentSha: `${id}-parent`, candidateSha: `${id}-candidate`, targetSymbol: 'target', targetFile: 'provider.ts', queryDescription: 'fixture', expectedSemanticCategory: 'fixture', caseType: 'Case-B', classification: 'fixture' });
const output = (q: QueryItem): CertifiedCampaignOutputItem => ({ queryId: q.queryId, repository: q.repository, parentSha: q.parentSha, candidateSha: q.candidateSha, caseType: q.caseType, passedGates: [], failedGate: 'SEMANTIC_SCOPE', authoritativeVerdict: 'UNKNOWN', blockerCode: 'UNSUPPORTED_SYNTAX', authorityGate: 'SEMANTIC_SCOPE', identityStatus: 'UNRESOLVED', reachedEvaluateProof: false, runtimeMs: 1, peakMemoryBytes: 12, deterministicArtifactDigest: q.queryId, isUnsafePositive: false, targetSymbol: q.targetSymbol, targetFile: q.targetFile, expectedSemanticCategory: q.expectedSemanticCategory, classification: q.classification });

test('campaign checkpoints terminal cases and resumes without re-executing them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-checkpoint-'));
  try {
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify([query('Q01'), query('Q02')]), 'utf8');
    const options = { manifestPath, checkpointDir: path.join(root, 'checkpoints'), outputPath: path.join(root, 'results.json') };
    let executions = 0;
    const executeCase = async (q: QueryItem) => { executions++; return output(q); };
    const first = await runCertifiedCampaign({ ...options, executeCase });
    assert.equal(executions, 2);
    assert.equal(first.results.length, 2);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(options.checkpointDir, 'Q01.checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.status, 'COMPLETED');
    assert.equal(checkpoint.case.parentSha, 'Q01-parent');
    assert.equal(checkpoint.firstFailingGate, 'SEMANTIC_SCOPE');
    const second = await runCertifiedCampaign({ ...options, executeCase });
    assert.equal(executions, 2);
    assert.deepEqual(second.results.map(r => r.queryId), ['Q01', 'Q02']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
