import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { hashCanonical } from './IndexIdentity';

/** A bounded, private copy of external node_modules inputs. No compiler read is
 * allowed to depend on the mutable source tree after this copy is made. */
export interface SealedDependencyTree {
  readonly root: string;
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly byteCount: number;
  cleanup(): void;
}

export interface DependencyTreeLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
}

const slash = (value: string) => value.replace(/\\/g, '/');
const inside = (target: string, root: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

/** dependencyRoot is a repository root or its node_modules directory. Only
 * node_modules at the root and beside tracked package.json files are admitted.
 * This excludes untracked source/build output from the proof environment. */
export function dependencyDirectories(dependencyRoot: string, trackedFiles: readonly string[]): Array<{ source: string; relative: string }> {
  const absolute = path.resolve(dependencyRoot);
  if (path.basename(absolute).toLowerCase() === 'node_modules') {
    return [{ source: absolute, relative: 'node_modules' }];
  }
  const dirs = new Set<string>(['node_modules']);
  for (const file of trackedFiles) {
    if (path.posix.basename(slash(file)) === 'package.json') {
      const dir = path.posix.dirname(slash(file));
      if (dir !== '.') dirs.add(`${dir}/node_modules`);
    }
  }
  return [...dirs].sort().map(relative => ({ source: path.join(absolute, ...relative.split('/')), relative }))
    .filter(entry => fs.existsSync(entry.source));
}

function scan(root: string, trackedFiles: readonly string[], limits: DependencyTreeLimits,
  destination?: string, workspaceSnapshotRoot?: string): { fingerprint: string; fileCount: number; byteCount: number } {
  const started = performance.now();
  const maxFiles = limits.maxFiles ?? 200_000;
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const maxDurationMs = limits.maxDurationMs ?? 25_000;
  const entries: Array<readonly [string, string, string?]> = [];
  let fileCount = 0;
  let byteCount = 0;
  const check = () => {
    if (performance.now() - started > maxDurationMs) throw new Error('DEPENDENCY_TREE_TIME_LIMIT');
    if (fileCount > maxFiles) throw new Error('DEPENDENCY_TREE_FILE_LIMIT');
    if (byteCount > maxBytes) throw new Error('DEPENDENCY_TREE_BYTE_LIMIT');
  };
  const roots = dependencyDirectories(root, trackedFiles);
  if (!roots.length) throw new Error('DEPENDENCY_TREE_MISSING_NODE_MODULES');
  const repositoryRoot = path.basename(path.resolve(root)).toLowerCase() === 'node_modules'
    ? path.dirname(path.resolve(root)) : path.resolve(root);
  const links: Array<{ destination: string; target: string; kind: 'file' | 'dir' }> = [];
  const walk = (source: string, relative: string, allowedRoot: string): void => {
    check();
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(source);
      const kind = fs.statSync(source).isDirectory() ? 'dir' : 'file';
      let target: string;
      if (inside(resolved, repositoryRoot) && slash(path.relative(repositoryRoot, resolved)).split('/').includes('node_modules')) {
        const rel = slash(path.relative(repositoryRoot, resolved));
        entries.push([relative, 'DEPENDENCY_LINK', rel]);
        target = destination ? path.join(destination, ...rel.split('/')) : resolved;
      } else {
        const workspaceBase = workspaceSnapshotRoot && inside(resolved, workspaceSnapshotRoot)
          ? workspaceSnapshotRoot : repositoryRoot;
        if (!inside(resolved, workspaceBase)) throw new Error(`DEPENDENCY_SYMLINK_ESCAPES_ROOT:${relative}`);
        const rel = slash(path.relative(workspaceBase, resolved));
        if (!rel || !trackedFiles.some(file => file === rel || file.startsWith(rel + '/'))) {
          throw new Error(`DEPENDENCY_SYMLINK_UNTRACKED_TARGET:${relative}`);
        }
        entries.push([relative, 'WORKSPACE_LINK', rel]);
        if (destination && !workspaceSnapshotRoot) throw new Error('DEPENDENCY_WORKSPACE_SNAPSHOT_REQUIRED');
        target = destination ? path.join(workspaceSnapshotRoot!, ...rel.split('/')) : resolved;
      }
      if (destination) links.push({ destination: path.join(destination, ...relative.split('/')), target, kind });
      return;
    }
    if (stat.isDirectory()) {
      entries.push([relative, 'DIR']);
      if (destination) fs.mkdirSync(path.join(destination, ...relative.split('/')), { recursive: true });
      for (const child of fs.readdirSync(source).sort()) {
        walk(path.join(source, child), `${relative}/${child}`, allowedRoot);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`DEPENDENCY_UNSUPPORTED_ENTRY:${relative}`);
    fileCount++;
    byteCount += stat.size;
    check();
    const bytes = fs.readFileSync(source);
    if (bytes.length !== stat.size) throw new Error(`DEPENDENCY_FILE_CHANGED_DURING_SCAN:${relative}`);
    entries.push([relative, 'FILE', createHash('sha256').update(bytes).digest('hex')]);
    if (destination) fs.writeFileSync(path.join(destination, ...relative.split('/')), bytes, { flag: 'wx' });
  };
  for (const entry of roots) walk(entry.source, entry.relative, entry.source);
  if (destination) for (const link of links) {
    fs.symlinkSync(link.target, link.destination, link.kind === 'dir' ? 'junction' : 'file');
  }
  return { fingerprint: hashCanonical('SAJIMORA_SEALED_DEPENDENCY_TREE_V1', entries), fileCount, byteCount };
}

export function fingerprintDependencyTree(root: string, trackedFiles: readonly string[],
  limits: DependencyTreeLimits = {}): string {
  return scan(root, trackedFiles, limits).fingerprint;
}

export function sealDependencyTree(root: string, trackedFiles: readonly string[], workspaceSnapshotRoot: string,
  limits: DependencyTreeLimits = {}): SealedDependencyTree {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-dependencies-'));
  try {
    const result = scan(root, trackedFiles, limits, destination, workspaceSnapshotRoot);
    // Verify that all bytes and links the compiler will see match the receipt.
    if (scan(destination, trackedFiles, limits, undefined, workspaceSnapshotRoot).fingerprint !== result.fingerprint) {
      throw new Error('DEPENDENCY_COPY_RECEIPT_MISMATCH');
    }
    return { root: destination, ...result, cleanup: () => fs.rmSync(destination, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
