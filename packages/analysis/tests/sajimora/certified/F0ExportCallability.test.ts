import * as assert from 'node:assert';
import { classifyF0DirectExportCallability } from '../../../src/sajimora/certified/identity/F0ExportCallability';
const c = (text: string) => classifyF0DirectExportCallability('p.ts', Buffer.from(text), 'f');
assert.equal(c('export function f(): number { return 1; }').status, 'CALLABLE_FUNCTION');
assert.equal(c('export const f = 1;').status, 'NONCALLABLE_VALUE');
assert.equal(c('const f = 1;').status, 'ABSENT');
assert.equal(c('export function f(){}\nexport const f = 1;').status, 'AMBIGUOUS');
console.log('F0ExportCallability passed');
