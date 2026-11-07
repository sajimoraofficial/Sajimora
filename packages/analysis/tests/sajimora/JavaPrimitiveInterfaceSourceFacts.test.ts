import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GenericRepositorySnapshot } from '@sajimora/core';
import { JavaPrimitiveInterfaceFacts, JavaPrimitiveInterfaceSourceFacts } from '../../src/sajimora/languages/java/certified/JavaPrimitiveInterfaceSourceFacts';

function snapshot(source: string, snapshotId = 'revision'): GenericRepositorySnapshot {
  return { snapshotId, rootIdentifier: '/', files: [{ path: 'src/Api.java', byteLength: Buffer.byteLength(source),
    hash: createHash('sha256').update(source).digest('hex') }],
    readTextFile: path => path === 'src/Api.java' ? source : undefined,
    readBinaryFile: path => path === 'src/Api.java' ? Buffer.from(source) : undefined };
}
const source = 'package example; /* source, not producer metadata */ public interface Api {\n public abstract long convert(int value);\n void reset();\n}';
const sealed = snapshot(source);
const checked = JavaPrimitiveInterfaceSourceFacts.read(sealed, 'src/Api.java');
assert.equal(checked.status, 'SOURCE_FACTS_CHECKED');
if (checked.status !== 'SOURCE_FACTS_CHECKED') throw new Error('Source facts unavailable');
assert.equal(checked.facts.fqcn, 'example.Api');
assert.deepEqual(checked.facts.methods, [
  { name: 'convert', parameters: ['int'], result: 'long' },
  { name: 'reset', parameters: [], result: 'void' }
]);
assert.equal(JavaPrimitiveInterfaceSourceFacts.verify(sealed, checked.facts), true);
for (const mutate of [
  (facts: any) => { facts.fqcn = 'other.Api'; },
  (facts: any) => { facts.snapshotId = 'other-revision'; },
  (facts: any) => { facts.methods[0].parameters[0] = 'long'; },
  (facts: any) => { facts.methods[0].result = 'int'; },
  (facts: any) => { facts.methods.pop(); },
  (facts: any) => { facts.sha256 = '0'.repeat(64); }
]) {
  const proposal: JavaPrimitiveInterfaceFacts = structuredClone(checked.facts); mutate(proposal);
  assert.equal(JavaPrimitiveInterfaceSourceFacts.verify(sealed, proposal), false);
}
assert.equal(JavaPrimitiveInterfaceSourceFacts.verify(snapshot(source.replace('long convert', 'int convert')), checked.facts), false);
const unsafeSources = [
  '', 'public interface Api {}', 'public interface Wrong { int value(); }',
  'public class Api { public int value() { return 1; } }',
  'public interface Api extends Other { int value(); }',
  'public interface Api<T> { int value(); }',
  'import java.util.List; public interface Api { int value(); }',
  'public interface Api { String value(); }',
  'public interface Api { int[] value(); }',
  'public interface Api { int value(int... args); }',
  'public interface Api { int value(void arg); }',
  'public interface Api { int value(int x, int x); }',
  'public interface Api { int value(int x,); }',
  'public interface Api { int value(); int value(int arg); }',
  'public interface Api { int value() throws Exception; }',
  'public interface Api { default int value() { return 1; } }',
  'public interface Api { static int value() { return 1; } }',
  'public interface Api { @Deprecated int value(); }',
  'public interface Api { int value = 1; }',
  'public interface Api { int wait(); }',
  'public interface Api { int class(); }',
  'public interface Api { int value(); } trailing',
  'public interface Api { int value(); } /* unterminated',
  'public interface Api { int value(); ',
  'public interface Api { int valué(); }',
  'public interface Api { int value(); } // \\u000a hidden-code',
  'public interface Api { int value(); } /* \\u002a/ hidden-code */'
];
for (const text of unsafeSources) {
  assert.equal(JavaPrimitiveInterfaceSourceFacts.read(snapshot(text), 'src/Api.java').status, 'UNSUPPORTED', text);
}
for (const primitive of ['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']) {
  assert.equal(JavaPrimitiveInterfaceSourceFacts.read(snapshot(`public interface Api { ${primitive} echo(${primitive} x); }`), 'src/Api.java').status, 'SOURCE_FACTS_CHECKED');
}
const stale = snapshot(source);
stale.readTextFile = () => source.replace('int value', 'long value');
assert.equal(JavaPrimitiveInterfaceSourceFacts.read(stale, 'src/Api.java').status, 'UNSUPPORTED');
const duplicate = snapshot(source);
(duplicate.files as any[]).push(duplicate.files[0]);
assert.equal(JavaPrimitiveInterfaceSourceFacts.read(duplicate, 'src/Api.java').status, 'UNSUPPORTED');
const mismatched = snapshot(source);
mismatched.readBinaryFile = () => Buffer.from('different');
assert.equal(JavaPrimitiveInterfaceSourceFacts.read(mismatched, 'src/Api.java').status, 'UNSUPPORTED');
assert.equal(JavaPrimitiveInterfaceSourceFacts.read(snapshot(source), '../Api.java').status, 'UNSUPPORTED');
assert.equal(JavaPrimitiveInterfaceSourceFacts.read(snapshot(' '.repeat(256_001)), 'src/Api.java').status, 'UNSUPPORTED');
console.log(`Java primitive interface source facts PASSED (${unsafeSources.length} grammar attacks, source binding and fact tampering). No F0 verdict issued.`);
