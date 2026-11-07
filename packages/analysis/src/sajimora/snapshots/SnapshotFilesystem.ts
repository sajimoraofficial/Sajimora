import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitObjectReader } from './GitObjectReader';
export interface MaterializedSnapshot { root: string; trackedFiles: string[]; readTextFile(relativePath: string): string | undefined; cleanup(): void }
export class SnapshotFilesystem {
  constructor(private readonly objects: GitObjectReader) {}
  materialize(revision: string): MaterializedSnapshot {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-snapshot-')); const rootPath = path.resolve(root); const rootWithSep = rootPath + path.sep; const trackedFiles: string[] = [];
    try {
      const symlinks: Array<{ destination: string; target: string; entryPath: string }> = [];
      const symlinkContents = new Map<string, string>();
      const entries = this.objects.entries(revision).filter(e => e.type === 'blob');
      const blobMap = typeof this.objects.batchBlobs === 'function' ? this.objects.batchBlobs(entries.map(e => e.objectId)) : new Map<string, Buffer>();
      for (const entry of entries) {
        if (entry.path.includes('\0') || path.isAbsolute(entry.path)) throw new Error(`Unsafe Git path: ${entry.path}`);
        const destination = path.resolve(root, ...entry.path.split('/'));
        if (!destination.startsWith(rootWithSep)) throw new Error(`Git path escapes snapshot: ${entry.path}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const data = blobMap.get(entry.objectId) ?? this.objects.blob(entry.objectId);
        if (entry.mode === '120000') {
          const target = data.toString('utf8'); const resolvedTarget = path.resolve(path.dirname(destination), target);
          if (path.isAbsolute(target) || (resolvedTarget !== rootPath && !resolvedTarget.startsWith(rootWithSep))) throw new Error(`Symlink escapes snapshot: ${entry.path}`);
          symlinks.push({ destination, target, entryPath: entry.path });
          symlinkContents.set(entry.path, target);
        } else fs.writeFileSync(destination, data, { flag: 'wx' });
        trackedFiles.push(entry.path);
      }
      // Symlink contents are stored in symlinkContents for readTextFile.
      // Do not copy files on Windows or create divergent symlinks on POSIX;
      // disk materialization remains 100% platform-independent.
      return { root, trackedFiles, readTextFile: relativePath => trackedFiles.includes(relativePath)
        ? symlinkContents.get(relativePath) ?? fs.readFileSync(path.resolve(root, ...relativePath.split('/')), 'utf8')
        : undefined, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  }
}
