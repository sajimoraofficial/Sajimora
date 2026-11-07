import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fingerprintDependencyTree, sealDependencyTree } from '../../src/sajimora/indexed/SealedDependencyTree';

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-dependency-source-'));
const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-dependency-snapshot-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-dependency-outside-'));
const tracked = ['packages/lib/package.json', 'packages/lib/index.d.ts'];
try {
  const packagePath = path.join(source, 'packages', 'lib');
  const snapshotPackage = path.join(snapshot, 'packages', 'lib');
  fs.mkdirSync(packagePath, { recursive: true });
  fs.mkdirSync(snapshotPackage, { recursive: true });
  fs.writeFileSync(path.join(packagePath, 'index.d.ts'), 'export type Source = number;');
  fs.writeFileSync(path.join(snapshotPackage, 'index.d.ts'), 'export type Source = string;');
  fs.mkdirSync(path.join(source, 'node_modules', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(source, 'node_modules', 'plain', 'index.d.ts'), 'export type Plain = string;');
  fs.symlinkSync(packagePath, path.join(source, 'node_modules', 'workspace'), 'junction');

  const before = fingerprintDependencyTree(source, tracked);
  const sealed = sealDependencyTree(source, tracked, snapshot);
  try {
    assert.equal(sealed.fingerprint, before);
    assert.equal(fs.readFileSync(path.join(sealed.root, 'node_modules', 'workspace', 'index.d.ts'), 'utf8'),
      'export type Source = string;');
    fs.writeFileSync(path.join(source, 'node_modules', 'plain', 'index.d.ts'), 'export type Plain = number;');
    assert.notEqual(fingerprintDependencyTree(source, tracked), before);
    assert.equal(fs.readFileSync(path.join(sealed.root, 'node_modules', 'plain', 'index.d.ts'), 'utf8'),
      'export type Plain = string;');
  } finally { sealed.cleanup(); }

  assert.throws(() => fingerprintDependencyTree(source, tracked, { maxFiles: 0 }), /DEPENDENCY_TREE_FILE_LIMIT/);
  fs.symlinkSync(outside, path.join(source, 'node_modules', 'escape'), 'junction');
  assert.throws(() => sealDependencyTree(source, tracked, snapshot), /DEPENDENCY_SYMLINK_ESCAPES_ROOT/);
  console.log('Sealed dependency tree: PASS');
} finally {
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
