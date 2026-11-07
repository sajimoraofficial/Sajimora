import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { GenericRepositorySnapshot, VerificationObligation } from '@sajimora/core';
import { EnvironmentManifest } from '../../../core/src/sajimora/certified/contracts';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../core/src/sajimora/certified/protocol';
import { computeDomainSeparatedHash } from '../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../../src/sajimora/certified/environment/SealedFilesystem';
import { CertifiedExecutionInput } from '../../src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { ProductionF0BundleProvider } from '../../src/sajimora/certified/integration/ProductionF0BundleProvider';

// These fixtures exercise only the production route binding boundary. Empty
// proof/closure payloads below are deliberately NOT valid kernel certificates.
function fixture() {
  const texts: Record<string, string> = {
    'api.ts': 'export function api(x: number): number { return x; }',
    'use.ts': 'import { api } from "./api"; export const result = api(1);',
    'tsconfig.json': '{}'
  };
  const files = Object.entries(texts).map(([logicalPath, text]) => ({
    fileId: logicalPath, logicalPath, byteLength: Buffer.byteLength(text),
    bytesRef: { domain: ArtifactDomain.SOURCE_BYTES,
      digest: computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, Buffer.from(text)) },
    mode: 0o100644, kind: logicalPath.endsWith('.ts') ? 'SOURCE' as const : 'CONFIG' as const,
    origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }));
  const fs = new SealedFilesystem(files, files.map(f => ({ digest: f.bytesRef.digest, data: Buffer.from(texts[f.logicalPath]) })), 'CASE_SENSITIVE');
  const snapshot = (snapshotId: string): GenericRepositorySnapshot => ({
    snapshotId, rootIdentifier: '/',
    files: files.map(file => ({ path: file.logicalPath, byteLength: file.byteLength,
      hash: createHash('sha256').update(texts[file.logicalPath]).digest('hex') })),
    readTextFile: path => texts[path], readBinaryFile: path => texts[path] === undefined ? undefined : Buffer.from(texts[path])
  });
  const repository = { repositoryId: 'repo', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') };
  const manifest = (commitId: string) => ({ schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    repositoryId: 'repo', revision: { commitId }, namespace: { files, symlinks: [] } }) as unknown as EnvironmentManifest;
  const sf = ts.createSourceFile('api.ts', texts['api.ts'], ts.ScriptTarget.Latest, true);
  const decl = sf.statements[0];
  const identity = { identityId: 'sealed-declaration-key', moduleIdentity: 'api.ts', localName: 'api',
    declarationKind: 'FunctionDeclaration', projectId: 'project', ownerChain: [],
    sourceSpan: { start: decl.getStart(sf), end: decl.end } };
  const entity = { entityId: 'production-entity-key', projectId: 'project', name: 'api', kind: 'FUNCTION', filePath: 'api.ts' };
  const start = texts['use.ts'].indexOf('api(1)');
  const obligation = { obligationId: 'route', projectId: 'project', question: 'CONSUMER_COMPATIBILITY', scope: 'CONSUMER',
    change: { identity: { status: 'CONFIRMED_IDENTITY', parentEntity: entity, candidateEntity: entity } },
    reference: { referenceId: 'call', projectId: 'project', kind: 'STATIC_CALL', targetEntityId: entity.entityId,
      location: { filePath: 'use.ts', line: 1, character: start + 1, length: 6 }, isUnresolvedBoundary: false }
  } as unknown as VerificationObligation;
  const execution = {
    parentManifest: manifest('p'), candidateManifest: manifest('c'), parentSealedFs: fs, candidateSealedFs: fs,
    targetSymbolId: identity.identityId, identityBundle: { targetMappings: [{ parent: identity, candidate: identity }] },
    obligations: [{ contextKind: 'CALL_SITE', historicalOccurrenceAnchor: {
      projectId: 'project', fileId: 'use.ts', utf16Start: start, utf16End: start + 6, syntaxKind: ts.SyntaxKind.CallExpression
    } }], proofs: [{}], parentClosure: {}, candidateClosure: {}, parentAdmission: {}, candidateAdmission: {}, coverage: {}, bundle: {}
  } as unknown as CertifiedExecutionInput;
  return { repository, obligation, execution, texts };
}

const baseline = fixture();
assert.equal(new ProductionF0BundleProvider({ materialize: () => baseline.execution })
  .getExecution(baseline.obligation, baseline.repository), baseline.execution);

const attacks: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['provider property', f => { f.obligation.question = 'API_COMPATIBILITY'; f.obligation.scope = 'PROVIDER'; }],
  ['behavior property', f => { f.obligation.question = 'BEHAVIORAL_COMPATIBILITY'; }],
  ['wrong symbol ID', f => { f.execution.targetSymbolId = 'api'; }],
  ['wrong declaration file', f => { f.execution.identityBundle.targetMappings[0].parent!.moduleIdentity = 'other.ts'; }],
  ['wrong declaration span', f => { f.execution.identityBundle.targetMappings[0].parent!.sourceSpan.start++; }],
  ['wrong consumer position', f => { f.obligation.reference!.location.character++; }],
  ['wrong consumer project', f => { f.obligation.projectId = 'another-project'; }],
  ['wrong consumer target', f => { f.obligation.reference!.targetEntityId = 'different'; }],
  ['extra unrelated obligation', f => { f.execution.obligations.push(f.execution.obligations[0]); }],
  ['omitted config', f => { f.execution.parentManifest.namespace.files.pop(); }],
  ['stale source under same revision', f => { f.texts['api.ts'] = f.texts['api.ts'].replace('return x;', 'return 0;'); }],
  ['duplicate inventory path', f => { (f.repository.parentSnapshot.files as any[]).push(f.repository.parentSnapshot.files[0]); }],
  ['wrong snapshot hash', f => { (f.repository.parentSnapshot.files[0] as any).hash = '0'.repeat(64); }],
  ['wrong manifest digest', f => { f.execution.parentManifest.namespace.files[0].bytesRef.digest = '0'.repeat(64); }],
  ['inconsistent text and binary', f => { f.repository.parentSnapshot.readBinaryFile = () => Buffer.from('other bytes'); }],
  ['missing bundle structure', f => { (f.execution as any).identityBundle = undefined; }]
];
for (const [name, attack] of attacks) {
  const f = fixture(); attack(f);
  assert.equal(new ProductionF0BundleProvider({ materialize: () => f.execution }).getExecution(f.obligation, f.repository), undefined, name);
}
assert.equal(new ProductionF0BundleProvider({ materialize: () => { throw new Error('unavailable'); } })
  .getExecution(baseline.obligation, baseline.repository), undefined);
console.log(`Production F0 route binding PASSED (${attacks.length} rejection cases; no kernel certification asserted).`);
