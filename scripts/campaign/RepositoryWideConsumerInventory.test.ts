import * as assert from 'node:assert';
import { inventoryDirectNamedCalls } from './RepositoryWideConsumerInventory';

const result = inventoryDirectNamedCalls({ targetFile: 'src/provider.ts', targetSymbol: 'formatLabel', projectFileIds: ['src/provider.ts', 'src/direct.ts', 'src/other.ts', 'src/shadow.ts', 'src/unused.ts', 'src/barrel.ts', 'src/reexport.ts', 'src/unresolved.ts'], files: [
  { path: 'src/provider.ts', content: 'export function formatLabel(value: string): string { return value; }\n' },
  { path: 'src/direct.ts', content: 'import { formatLabel } from "./provider"; export const x: string = formatLabel("x");\n' },
  { path: 'src/other.ts', content: 'export function formatLabel(value: string): string { return value; }\nimport { formatLabel as local } from "./provider"; export const y: string = local("y");\n' },
  { path: 'src/shadow.ts', content: 'import { formatLabel } from "./provider"; function f(formatLabel: (x: string) => string) { return formatLabel("shadow"); }\n' },
  { path: 'src/unused.ts', content: 'import { formatLabel } from "./provider"; export const unused = true;\n' },
  { path: 'src/barrel.ts', content: 'export { formatLabel } from "./provider";\n' },
  { path: 'src/reexport.ts', content: 'import { formatLabel } from "./barrel"; export const b = formatLabel("barrel");\n' },
  { path: 'src/unresolved.ts', content: 'import { formatLabel } from "./not-present"; export const missing = formatLabel("x");\n' },
  { path: 'outside.ts', content: 'import { formatLabel } from "./src/provider"; export const z = formatLabel("z");\n' }
] });
assert.equal(result.consumerSites.filter(site => site.status === 'DIRECT_CALL').length, 1);
assert.equal(result.consumerSites.filter(site => site.status === 'UNUSED_DIRECT_IMPORT').length, 2, 'shadowed and unused imports are not calls');
assert.ok(result.consumerSites.filter(site => site.status === 'UNRESOLVED_REFERENCE_FORM').length >= 2, 'renamed and barrel candidates fail closed');
assert.equal(result.unresolvedImports.length, 1);
assert.equal(result.excludedFiles.length, 1);
assert.equal(result.completeness, 'INCOMPLETE');
const renamed = inventoryDirectNamedCalls({ targetFile: 'p.ts', targetSymbol: 'f', projectFileIds: ['p.ts', 'c.ts'], allowRenamedNamedImports: true,
  files: [{ path: 'p.ts', content: 'export function f(): number { return 1; }' }, { path: 'c.ts', content: 'import { f as local } from "./p"; local();' }] });
assert.equal(renamed.consumerSites.filter(site => site.status === 'DIRECT_CALL').length, 1, 'F0.3 renamed import has exact checker binding');
console.log('RepositoryWideConsumerInventory passed');
