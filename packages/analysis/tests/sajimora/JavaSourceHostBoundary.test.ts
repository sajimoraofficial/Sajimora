import * as assert from 'node:assert/strict';
import { JavaSealedCompilerHost } from '../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';

let source = 'package example;\npublic class Api {\n  public int value() { return 1; }\n}\n';
const original = source;
let reads = 0;
const trackedFiles = ['src\\Api.java'];
const host = new JavaSealedCompilerHost({ trackedFiles, readTextFile: path => {
  reads++;
  return path === 'src\\Api.java' ? source : 'untracked content';
} });
source = 'package example; public class Changed {}';
trackedFiles.push('outside.java');
assert.equal(host.getFileContent('src/Api.java'), original);
assert.equal(host.getFileContent('outside.java'), undefined);
assert.equal(reads, 1, 'Source must be captured once; later lookups cannot call a changing source provider');
const files = host.getTrackedJavaFiles() as string[];
files.push('forged.java');
assert.deepEqual(host.getTrackedJavaFiles(), ['src/Api.java']);
for (const declaration of [host.getClassByFQCN('example.Api'), host.getAllClasses()[0], host.getFileClasses('src/Api.java')[0]]) {
  assert.ok(declaration);
  (declaration as any).fqcn = 'forged.Name';
  (declaration as any).methods.length = 0;
  assert.equal(host.getClassByFQCN('example.Api')!.fqcn, 'example.Api');
  assert.ok(host.getClassByFQCN('example.Api')!.methods.length > 0);
}
const resolved = host.resolveClass('example.Api');
assert.equal(resolved.status, 'RESOLVED');
if (resolved.status === 'RESOLVED') (resolved.declaration as any).fqcn = 'forged.Resolution';
assert.equal(host.getClassByFQCN('example.Api')!.fqcn, 'example.Api');
for (const paths of [['../Api.java'], ['/Api.java'], ['C:/Api.java'], ['src/Api.java', 'src\\Api.java']]) {
  assert.throws(() => new JavaSealedCompilerHost({ trackedFiles: paths, readTextFile: () => original }), /INVALID_SEALED_JAVA_PATH_INVENTORY/);
}
console.log('Java source host boundary PASSED (stable source, isolated records, canonical inventory).');
