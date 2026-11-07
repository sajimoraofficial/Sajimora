import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, Reference, SemanticChange, SemanticEntity } from '../../../core/src/sajimora/verification';
import { TypeScriptDirectCallCoverageChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptDirectCallCoverageChecker';

const sources = new Map([
  ['api.ts', 'export function foo(x: number) { return x; }\n'],
  ['util.ts', 'export function bar(x: number) { return x; }\n'],
  ['use.ts', "import { foo as f } from './api';\nimport { bar } from './util';\nf(1);\nbar(2);\n"]
]);
const snapshot = (id: string) => ({ snapshotId: id, rootIdentifier: '/',
  files: [...sources].map(([path, content]) => ({ path, byteLength: Buffer.byteLength(content),
    hash: createHash('sha256').update(content).digest('hex') })),
  readTextFile: (path: string) => sources.get(path),
  readBinaryFile: (path: string) => { const value = sources.get(path); return value === undefined ? undefined : Buffer.from(value); }
});
const repository: GenericRepository = { repositoryId: 'r', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') };
const target = (name: string, filePath: string): SemanticEntity => ({ entityId: `id-${name}`, projectId: 'project',
  name, filePath, kind: 'FUNCTION', qualifiedName: name, signatureFingerprint: 'sig', isExported: true });
const foo = target('foo', 'api.ts');
const bar = target('bar', 'util.ts');
const change = (entity: SemanticEntity): SemanticChange => ({ changeId: `change-${entity.name}`, changeKind: 'BODY_MUTATED',
  description: 'test', identity: { identityId: `identity-${entity.name}`, status: 'CONFIRMED_IDENTITY',
    confidence: 'CERTAIN', parentEntity: entity, candidateEntity: entity } });
const reference = (entity: SemanticEntity, line: number, length: number): Reference => ({
  referenceId: `ref-${entity.name}`, projectId: 'project', targetEntityId: entity.entityId,
  kind: 'STATIC_CALL', location: { filePath: 'use.ts', line, character: 1, length }, isUnresolvedBoundary: false
});
const fooRef = reference(foo, 3, 4);
const barRef = reference(bar, 4, 6);
const graph = { graphId: 'graph', projects: [{ projectId: 'project', rootDirectory: '/',
  sourceFiles: ['api.ts', 'util.ts', 'use.ts'], projectReferences: [] }], edges: [] };
const input = { repository, parentGraph: graph, candidateGraph: graph,
  projectMapping: { matched: [{ parentProjectId: 'project', candidateProjectId: 'project' }], added: [], deleted: [] },
  changes: [change(foo), change(bar)], targetEntities: [foo, bar], references: [fooRef, barRef] };
const checker = new TypeScriptDirectCallCoverageChecker();
assert.equal(checker.check(input), true, 'both target domains are complete');
assert.equal(checker.check({ ...input, references: [fooRef] }), false, 'omitting one target call rejects the whole domain');
assert.equal(checker.check({ ...input, references: [barRef, fooRef] }), true, 'reference order is irrelevant');
assert.equal(checker.check({ ...input, references: [fooRef, { ...barRef, targetEntityId: foo.entityId }] }), false,
  'call cannot be assigned to another changed target');
sources.set('use.ts', "import { foo as f } from './api';\nimport { bar } from './util';\nconst escaped = f;\nbar(2);\n");
assert.equal(checker.check(input), false, 'escaping a target function leaves the admitted call profile');
console.log('TypeScript multi-target direct-call coverage PASSED.');
