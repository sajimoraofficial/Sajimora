import * as assert from 'node:assert';
import ts from 'typescript';
import { extractF0BodyOutcome } from '../../../src/sajimora/certified/fragment/F0BodyOutcome';

const fn = (text: string) => ts.createSourceFile('provider.ts', text, ts.ScriptTarget.Latest, true)
  .statements.find(ts.isFunctionDeclaration)!;

assert.deepEqual(extractF0BodyOutcome(fn('export function f(): number { return 1; }')), { kind: 'VALUE' });
assert.deepEqual(extractF0BodyOutcome(fn('export function f(): never { throw new Error("x"); }')), { kind: 'TERMINAL_THROW' });
assert.equal(extractF0BodyOutcome(fn('export function f(): number { if (true) return 1; return 2; }')).kind, 'UNKNOWN');
console.log('F0BodyOutcome passed');
