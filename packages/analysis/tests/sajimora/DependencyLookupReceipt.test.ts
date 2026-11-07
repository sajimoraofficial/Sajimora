import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DependencyLookupRecorder } from '../../src/sajimora/indexed/DependencyLookupReceipt';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-lookup-source-'));
const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-lookup-snapshot-'));
try {
  const sourcePackage = path.join(root, 'packages', 'one');
  const alternatePackage = path.join(root, 'packages', 'two');
  const snapshotPackage = path.join(snapshot, 'packages', 'one');
  for (const directory of [sourcePackage, alternatePackage, snapshotPackage,
    path.join(root, 'node_modules', 'plain')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(sourcePackage, 'index.d.ts'), 'export type Value = number;');
  fs.writeFileSync(path.join(snapshotPackage, 'index.d.ts'), 'export type Value = string;');
  fs.writeFileSync(path.join(root, 'node_modules', 'plain', 'index.d.ts'), 'export type Plain = boolean;');
  const link = path.join(root, 'node_modules', 'workspace');
  fs.symlinkSync(sourcePackage, link, 'junction');
  const recorder = new DependencyLookupRecorder(root, snapshot, ['packages/one/index.d.ts']);
  const workspaceFile = path.join(link, 'index.d.ts');
  assert.equal(fs.readFileSync(recorder.map(workspaceFile), 'utf8'), 'export type Value = string;');
  const missing = path.join(root, 'node_modules', 'plain', 'index.ts');
  assert.equal(recorder.observe('FILE_EXISTS', missing, [], mapped => fs.existsSync(mapped)), false);
  const present = path.join(root, 'node_modules', 'plain', 'index.d.ts');
  assert.equal(recorder.observe('READ_FILE', present, [], mapped => fs.readFileSync(mapped, 'utf8')),
    'export type Plain = boolean;');
  const receipt = recorder.finish();
  DependencyLookupRecorder.verify(root, receipt);
  fs.writeFileSync(missing, 'export type Plain = number;');
  assert.throws(() => DependencyLookupRecorder.verify(root, receipt), /DEPENDENCY_LOOKUP_STALE/);
  fs.unlinkSync(missing);
  fs.rmSync(link);
  fs.symlinkSync(alternatePackage, link, 'junction');
  assert.throws(() => DependencyLookupRecorder.verify(root, receipt), /DEPENDENCY_LOOKUP_ROUTE_STALE/);
  console.log('Dependency lookup receipt: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
}
