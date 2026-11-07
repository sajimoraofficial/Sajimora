import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CertifiedCampaignAdapter } from '../../../../../scripts/campaign/CertifiedCampaignAdapter';

test('controlled sealed Case B reaches certified proof', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-b-e2e-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'provider.ts'), 'export function calc(): number { return 1; }\n');
    fs.writeFileSync(path.join(root, 'consumer.ts'), 'import { calc } from "./provider";\nconst result: number = calc();\n');
    git('add', '.'); git('commit', '-m', 'parent');
    const parentSha = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'provider.ts'), 'export function calc(): number { return 2; }\n');
    git('commit', '-am', 'candidate');
    const candidateSha = git('rev-parse', 'HEAD');
    const result = CertifiedCampaignAdapter.evaluateRealCaseB({ repoPath: root, repoId: 'case-b-e2e',
      parentSha, candidateSha, targetSymbol: 'calc', targetFile: 'provider.ts', consumerFile: 'consumer.ts' });
    assert.equal(result.failedGate, undefined, JSON.stringify(result));
    assert.equal(result.verdictResult.verdict, 'PRESERVED');
    for (const gate of ['BUNDLE_INTEGRITY', 'SEALED_ENVIRONMENT', 'DEPENDENCY_CLOSURE',
      'FRAGMENT_ADMISSION', 'FROZEN_IDENTITY', 'OBLIGATION_VERIFICATION',
      'PROOF_VERIFICATION', 'COVERAGE_VERIFICATION', 'NORMALIZATION', 'VERDICT_AUTHORITY']) {
      assert.ok(result.passedGates.includes(gate), `Missing gate ${gate}: ${JSON.stringify(result)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controlled sealed Case B reaches certified proof with a genuine violated arity obligation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-b-e2e-violated-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'provider.ts'), 'export function calc(): number { return 1; }\n');
    fs.writeFileSync(path.join(root, 'consumer.ts'), 'import { calc } from "./provider";\nconst result: number = calc();\n');
    git('add', '.'); git('commit', '-m', 'parent');
    const parentSha = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'provider.ts'), 'export function calc(required: number): number { return required; }\n');
    git('commit', '-am', 'candidate');
    const candidateSha = git('rev-parse', 'HEAD');
    const result = CertifiedCampaignAdapter.evaluateRealCaseB({ repoPath: root, repoId: 'case-b-e2e-violated',
      parentSha, candidateSha, targetSymbol: 'calc', targetFile: 'provider.ts', consumerFile: 'consumer.ts' });
    assert.equal(result.failedGate, undefined, JSON.stringify(result));
    assert.equal(result.verdictResult.verdict, 'VIOLATED');
    assert.ok(result.passedGates.includes('VERDICT_AUTHORITY'), JSON.stringify(result));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
