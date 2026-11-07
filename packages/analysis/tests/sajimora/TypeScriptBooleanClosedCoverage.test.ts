import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, Reference, SemanticChange, SemanticEntity } from '../../../core/src/sajimora/verification';
import { TypeScriptBooleanClosedCoverageChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptBooleanClosedCoverageChecker';

const sources = new Map([
  ['gate.ts', 'export function gate(x: boolean): boolean { return x; }\n'],
  ['use.ts', "import { gate } from './gate';\nexport const answer = gate(true);\n"]
]);
const snapshot = (id: string) => ({ snapshotId: id, rootIdentifier: '/',
  files: [...sources].map(([path, text]) => ({ path, byteLength: Buffer.byteLength(text),
    hash: createHash('sha256').update(text).digest('hex') })),
  readTextFile: (path: string) => sources.get(path),
  readBinaryFile: (path: string) => { const text = sources.get(path); return text === undefined ? undefined : Buffer.from(text); } });
const repository: GenericRepository = { repositoryId: 'repo', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') };
const target: SemanticEntity = { entityId: 'gate-id', projectId: 'project', name: 'gate',
  kind: 'FUNCTION', qualifiedName: 'gate', filePath: 'gate.ts', signatureFingerprint: 'sig', isExported: true };
const changed: SemanticChange = { changeId: 'changed', changeKind: 'BODY_MUTATED', description: 'changed',
  identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
    parentEntity: target, candidateEntity: target } };
const unchanged: SemanticChange = { ...changed, changeId: 'unchanged', changeKind: 'UNCHANGED',
  identity: { ...changed.identity, parentEntity: { ...target, entityId: 'other-id', name: 'answer', filePath: 'use.ts' } } };
const importRef: Reference = { referenceId: 'import', projectId: 'project', kind: 'STATIC_IMPORT', targetEntityId: 'gate-id',
  location: { filePath: 'use.ts', line: 1, character: 10, length: 4 }, isUnresolvedBoundary: false };
const callRef: Reference = { referenceId: 'call', projectId: 'project', kind: 'STATIC_CALL', targetEntityId: 'gate-id',
  location: { filePath: 'use.ts', line: 2, character: 23, length: 10 }, isUnresolvedBoundary: false };
const graph = { graphId: 'graph', projects: [{ projectId: 'project', rootDirectory: '/',
  sourceFiles: ['gate.ts', 'use.ts'], projectReferences: [] }], edges: [] };
const input = { repository, parentGraph: graph, candidateGraph: graph,
  projectMapping: { matched: [{ parentProjectId: 'project', candidateProjectId: 'project' }], added: [], deleted: [] },
  changes: [changed, unchanged], targetEntities: [target], references: [importRef, callRef] };
const checker = new TypeScriptBooleanClosedCoverageChecker();
assert.equal(checker.check(input), true);
assert.equal(checker.check({ ...input, references: [callRef] }), false, 'omitted import rejects coverage');
assert.equal(checker.check({ ...input, references: [importRef] }), false, 'omitted call rejects coverage');
assert.equal(checker.check({ ...input, references: [importRef, { ...callRef, targetEntityId: 'other-id' }] }), false);
sources.set('use.ts', "import { gate } from './gate';\nexport const answer = gate(true);\nexport const escaped = gate;\n");
assert.equal(checker.check(input), false, 'escaped target is outside the admitted direct-call profile');
console.log('TypeScript Boolean import-and-call coverage PASSED.');
