/** Source-backed Phase 2A acceptance. Compiler receipts carry COMPILER_STATIC assurance. */
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, GenericRepositorySnapshot, SemanticEntity, VerificationObligation } from '../../../core/src/sajimora/verification';
import { TypeScriptCallCompatibilityEvaluator } from '../../src/sajimora/languages/typescript/production/TypeScriptCallCompatibilityEvaluator';

export function snapshot(id: string, contents: Record<string, string>): GenericRepositorySnapshot {
  return { snapshotId: id, rootIdentifier: '/',
    files: Object.entries(contents).map(([path, text]) => ({ path, byteLength: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex') })),
    readTextFile: p => contents[p.replace(/^\//, '')],
    readBinaryFile: p => { const text = contents[p.replace(/^\//, '')]; return text === undefined ? undefined : Buffer.from(text); } };
}
export function fixture(before: string, after: string, consumer: string) {
  const config = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', types: [] }, include: ['*.ts'] });
  const files = { 'tsconfig.json': config, 'target.ts': before, 'consumer.ts': consumer };
  const repository: GenericRepository = { repositoryId: 'phase2a', parentSnapshot: snapshot('parent', files),
    candidateSnapshot: snapshot('candidate', { ...files, 'target.ts': after, 'consumer.ts': 'export {};' }) };
  const entity: SemanticEntity = { entityId: 'fn', projectId: 'proj_0', name: 'fn', kind: 'FUNCTION', qualifiedName: 'target.ts::fn', filePath: 'target.ts', signatureFingerprint: before, isExported: true };
  const obligation: VerificationObligation = { obligationId: 'call', projectId: 'proj_0', question: 'CONSUMER_COMPATIBILITY', scope: 'CONSUMER', createdAt: new Date().toISOString(),
    change: { changeId: 'change', changeKind: 'SIGNATURE_EXPANDED', description: 'Provider changed', identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN', parentEntity: entity, candidateEntity: { ...entity, signatureFingerprint: after } } },
    reference: { referenceId: 'ref', projectId: 'proj_0', kind: 'STATIC_CALL', targetEntityId: entity.entityId, location: { filePath: 'consumer.ts', line: 2, character: 1 }, isUnresolvedBoundary: false } };
  return { repository, obligation };
}
export function check(name: string, before: string, after: string, consumer: string, outcome: 'PRESERVED' | 'VIOLATED', code?: number) {
  const { repository, obligation } = fixture(before, after, `import { fn } from './target';\n${consumer}`);
  const verdict = TypeScriptCallCompatibilityEvaluator.evaluateCall(obligation, repository);
  assert.equal(verdict.outcome, outcome, `${name}: ${JSON.stringify(verdict.evidence)}`);
  assert.equal(verdict.assurance, 'COMPILER_STATIC', name);
  if (code) assert.ok(verdict.evidence.compilerStatic?.introducedDiagnostics.some(d => d.code === code), `${name}: expected TS${code}`);
  assert.equal(verdict.evidence.metadata?.consumerHash, createHash('sha256').update(repository.parentSnapshot.readTextFile('consumer.ts')!).digest('hex'));
  console.log(`Passed: ${name}`);
}

