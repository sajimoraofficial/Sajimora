import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  prepareCaseBInput,
  selectTargetDeclaration,
  resolveRelativeImport,
  normalizeGrepFilePath
} from './CaseBInputPreparation';

const variable = selectTargetDeclaration('provider.ts', 'export const value = 1;', 'value');
assert.deepEqual(variable, { declarationKind: 'VariableDeclaration', ownerChain: [], declarationOrdinal: 0, exported: true });
const iface = selectTargetDeclaration('provider.ts', 'export interface Contract { value: string }', 'Contract');
assert.deepEqual(iface, { declarationKind: 'InterfaceDeclaration', ownerChain: [], declarationOrdinal: 0, exported: true });
const type = selectTargetDeclaration('provider.ts', 'export type Result = string;', 'Result');
assert.deepEqual(type, { declarationKind: 'TypeAliasDeclaration', ownerChain: [], declarationOrdinal: 0, exported: true });
assert.equal(selectTargetDeclaration('provider.ts', 'const unrelated = 1;', 'missing'), undefined);

// 1. Module resolution shape tests
const files = new Set([
  'src/provider.ts',
  'src/component.tsx',
  'src/legacy.js',
  'src/nested/index.ts',
  'src/nestedTsx/index.tsx'
]);

// ./provider -> src/provider.ts
assert.equal(resolveRelativeImport('src/consumer.ts', './provider', files), 'src/provider.ts');
// ./provider.ts -> src/provider.ts
assert.equal(resolveRelativeImport('src/consumer.ts', './provider.ts', files), 'src/provider.ts');
// ./component.tsx -> src/component.tsx
assert.equal(resolveRelativeImport('src/consumer.ts', './component.tsx', files), 'src/component.tsx');
// ./component -> src/component.tsx
assert.equal(resolveRelativeImport('src/consumer.ts', './component', files), 'src/component.tsx');
// ./legacy.js -> src/legacy.js
assert.equal(resolveRelativeImport('src/consumer.ts', './legacy.js', files), 'src/legacy.js');
// ./provider.js -> src/provider.ts (ESM .js extension targeting .ts file)
assert.equal(resolveRelativeImport('src/consumer.ts', './provider.js', files), 'src/provider.ts');
// ./component.js -> src/component.tsx (ESM .js extension targeting .tsx file)
assert.equal(resolveRelativeImport('src/consumer.ts', './component.js', files), 'src/component.tsx');
// ./nested/index.ts -> src/nested/index.ts
assert.equal(resolveRelativeImport('src/consumer.ts', './nested/index.ts', files), 'src/nested/index.ts');
// ./nested -> src/nested/index.ts (directory index)
assert.equal(resolveRelativeImport('src/consumer.ts', './nested', files), 'src/nested/index.ts');
// ./nestedTsx/index.tsx -> src/nestedTsx/index.tsx
assert.equal(resolveRelativeImport('src/consumer.ts', './nestedTsx/index.tsx', files), 'src/nestedTsx/index.tsx');
// ./nestedTsx -> src/nestedTsx/index.tsx (directory index)
assert.equal(resolveRelativeImport('src/consumer.ts', './nestedTsx', files), 'src/nestedTsx/index.tsx');

// Non-relative import must be rejected fail-closed
assert.equal(resolveRelativeImport('src/consumer.ts', 'external-pkg', files), undefined);
assert.equal(resolveRelativeImport('src/consumer.ts', '@org/pkg', files), undefined);

// 2. Grep normalization tests
assert.equal(
  normalizeGrepFilePath('43b9bfc5a59167b42c897eb9c74129fc8b4c31e4:packages/zod/src/v4/core/schemas.ts', '43b9bfc5a59167b42c897eb9c74129fc8b4c31e4'),
  'packages/zod/src/v4/core/schemas.ts'
);
assert.equal(
  normalizeGrepFilePath('43b9bfc5:packages/zod/src/v4/core/schemas.ts'),
  'packages/zod/src/v4/core/schemas.ts'
);
assert.equal(
  normalizeGrepFilePath('packages/zod/src/v4/core/schemas.ts'),
  'packages/zod/src/v4/core/schemas.ts'
);

// Real sealed evidence: this campaign target is a supported function declaration but has
// no direct named-import consumer in either frozen revision. The preparer must not invent one.
const q03 = prepareCaseBInput(path.resolve('scripts/campaign/repos/zod'),
  '43b9bfc5a59167b42c897eb9c74129fc8b4c31e4', 'cd4f9a679238a5470620f74c2cc568e8865b3f01',
  'packages/zod/src/v4/core/schemas.ts', 'standardProps');
assert.equal(q03.target?.declarationKind, 'FunctionDeclaration');
assert.equal(q03.consumerFile, undefined);

// Git failure / invalid revision must return empty object (omission), never claiming zero consumers
const brokenGitResult = prepareCaseBInput(path.resolve('scripts/campaign/repos/zod'),
  '0000000000000000000000000000000000000000', 'cd4f9a679238a5470620f74c2cc568e8865b3f01',
  'packages/zod/src/v4/core/schemas.ts', 'standardProps');
assert.deepEqual(brokenGitResult, {});

console.log('CaseBInputPreparation tests passed');
