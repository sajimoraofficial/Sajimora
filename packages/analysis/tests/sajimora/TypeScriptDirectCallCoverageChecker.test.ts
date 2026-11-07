import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepository, Reference, SemanticChange, SemanticEntity } from '../../../core/src/sajimora/verification';
import { TypeScriptDirectCallCoverageChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptDirectCallCoverageChecker';

const provider = 'export function foo(x: number): number { return x; }\n';
const consumer = "import { foo } from './api';\nfoo(1);\n";
const source = new Map([['api.ts', provider], ['use.ts', consumer]]);
const snapshot = (id: string) => ({ snapshotId: id, rootIdentifier: '/',
  files: [...source].map(([path, text]) => ({ path, byteLength: Buffer.byteLength(text),
    hash: createHash('sha256').update(text).digest('hex') })),
  readTextFile: (path: string) => source.get(path),
  readBinaryFile: (path: string) => { const text = source.get(path); return text === undefined ? undefined : Buffer.from(text); }
});
const repository: GenericRepository = { repositoryId: 'r', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') };
const target: SemanticEntity = { entityId: 'foo-id', projectId: 'project', kind: 'FUNCTION', name: 'foo',
  qualifiedName: 'foo', filePath: 'api.ts', signatureFingerprint: 'sig', isExported: true };
const change: SemanticChange = { changeId: 'change', changeKind: 'BODY_MUTATED',
  identity: { identityId: 'identity', status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
    parentEntity: target, candidateEntity: target }, description: 'test' };
const reference: Reference = { referenceId: 'call', projectId: 'project', kind: 'STATIC_CALL',
  targetEntityId: 'foo-id', isUnresolvedBoundary: false,
  location: { filePath: 'use.ts', line: 2, character: 1, length: 6 } };
const graph = { graphId: 'graph', projects: [{ projectId: 'project', rootDirectory: '/',
  sourceFiles: ['api.ts', 'use.ts'], projectReferences: [] }], edges: [] };
const input = { repository, parentGraph: graph, candidateGraph: graph,
  projectMapping: { matched: [{ parentProjectId: 'project', candidateProjectId: 'project' }], added: [], deleted: [] },
  changes: [change], targetEntities: [target], references: [reference] };
const checker = new TypeScriptDirectCallCoverageChecker();
assert.equal(checker.check(input), true);
assert.equal(checker.check({ ...input, references: [] }), false, 'omitted call must fail coverage');
assert.equal(checker.check({ ...input, references: [{ ...reference, location: { ...reference.location, character: 2 } }] }), false);
source.set('use.ts', "import { foo } from './api';\nfoo(1);\nfoo(2);\n");
assert.equal(checker.check(input), false, 'added call must fail stale reference list');
source.set('use.ts', "import { foo as bar } from './api';\nbar(1);\n");
assert.equal(checker.check(input), true, 'named alias should be tracked to the same call');
assert.equal(checker.check({ ...input, references: [] }), false, 'aliased call omission must fail');
source.set('use.ts', "import type { foo as bar } from './api';\nbar(1);\n");
assert.equal(checker.check(input), false, 'type-only import cannot support a value call');
source.set('use.ts', "import { foo as bar } from './api';\nfunction other(bar: () => void) { bar(); }\n");
assert.equal(checker.check(input), false, 'shadowed alias is outside the admitted grammar');
source.set('use.ts', "const api = require('./api');\napi['foo'](1);\n");
assert.equal(checker.check(input), false, 'dynamic access is outside the admitted grammar');
source.set('use.ts', consumer);
source.set('tsconfig.json', '{"compilerOptions":{"strict":true}}');
source.set('package.json', '{"private":true}');
const configRepository: GenericRepository = { repositoryId: 'r', parentSnapshot: snapshot('p-config'),
  candidateSnapshot: snapshot('c-config') };
assert.equal(checker.check({ ...input, repository: configRepository }), true,
  'ordinary configuration files do not hide source calls');
source.set('tsconfig.json', '{"compilerOptions":{"moduleSuffixes":[".native",""]}}');
assert.equal(checker.check({ ...input, repository: { ...configRepository, parentSnapshot: snapshot('p-resolution') } }), false,
  'unreconstructed module resolution options fail closed');
source.set('tsconfig.json', '{"compilerOptions":{"strict":true}}');
source.set('assets/data.json', '{}');
assert.equal(checker.check({ ...input, repository: { ...configRepository, parentSnapshot: snapshot('p-extra') } }), false,
  'unadmitted inventory file fails closed');
source.clear();
source.set('src/api.ts', provider);
source.set('app/use.ts', "import { foo as bar } from '../src/api';\nbar(1);\n");
const nestedTarget = { ...target, filePath: 'src/api.ts' };
const nestedInput = { ...input,
  repository: { repositoryId: 'r', parentSnapshot: snapshot('p-nested'), candidateSnapshot: snapshot('c-nested') },
  parentGraph: { ...graph, projects: [{ ...graph.projects[0], sourceFiles: ['src/api.ts', 'app/use.ts'] }] },
  changes: [{ ...change, identity: { ...change.identity, parentEntity: nestedTarget, candidateEntity: nestedTarget } }],
  targetEntities: [nestedTarget],
  references: [{ ...reference, location: { ...reference.location, filePath: 'app/use.ts' } }] };
assert.equal(checker.check(nestedInput), true, 'relative parent-directory import resolves within the sealed snapshot');
console.log('TypeScript closed-snapshot direct-call coverage checker PASSED.');
