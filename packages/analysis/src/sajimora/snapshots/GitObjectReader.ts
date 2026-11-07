import { GitRepository } from './GitRepository';
export interface GitTreeEntry { mode: string; type: string; objectId: string; path: string }
export class GitObjectReader {
  constructor(
    private readonly repository: GitRepository,
    private readonly caches?: {
      blobCache?: Map<string, Buffer>;
      treeCache?: Map<string, GitTreeEntry[]>;
    }
  ) {}
  entries(revision: string): GitTreeEntry[] {
    if (revision.startsWith('-')) {
      throw new Error(`Invalid revision argument: revision must not start with '-'`);
    }
    if (this.caches?.treeCache?.has(revision)) {
      return this.caches.treeCache.get(revision)!;
    }
    const entries = this.repository.buffer(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', revision]).toString('utf8').split('\0').filter(Boolean).map(record => {
      const tab = record.indexOf('\t'); const [mode, type, objectId] = record.slice(0, tab).split(' ');
      return { mode, type, objectId, path: record.slice(tab + 1).replace(/\\/g, '/') };
    }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (this.caches?.treeCache) {
      this.caches.treeCache.set(revision, entries);
    }
    return entries;
  }
  blob(objectId: string): Buffer {
    if (objectId.startsWith('-') || !/^[0-9a-fA-F]{4,64}$/.test(objectId)) {
      throw new Error(`Invalid objectId argument: ${objectId}`);
    }
    if (this.caches?.blobCache?.has(objectId)) {
      return this.caches.blobCache.get(objectId)!;
    }
    const buf = this.repository.buffer(['cat-file', 'blob', '--end-of-options', objectId]);
    if (this.caches?.blobCache) {
      this.caches.blobCache.set(objectId, buf);
    }
    return buf;
  }
  batchBlobs(objectIds: string[]): Map<string, Buffer> {
    if (objectIds.length === 0) return new Map();
    const result = new Map<string, Buffer>();
    const missing: string[] = [];
    const uniqueIds = [...new Set(objectIds)];

    if (this.caches?.blobCache) {
      for (const id of uniqueIds) {
        const cached = this.caches.blobCache.get(id);
        if (cached) {
          result.set(id, cached);
        } else {
          missing.push(id);
        }
      }
    } else {
      missing.push(...uniqueIds);
    }

    if (missing.length === 0) {
      return result;
    }

    const input = missing.join('\n') + '\n';
    const output = this.repository.bufferWithInput(['cat-file', '--batch'], input);
    let offset = 0;
    while (offset < output.length) {
      const newlineIdx = output.indexOf(10, offset);
      if (newlineIdx === -1) break;
      const header = output.toString('utf8', offset, newlineIdx);
      const parts = header.split(' ');
      if (parts.length < 3) break;
      const sha = parts[0];
      const size = parseInt(parts[2], 10);
      const dataStart = newlineIdx + 1;
      const dataEnd = dataStart + size;
      const blobData = output.subarray(dataStart, dataEnd);
      result.set(sha, blobData);
      if (this.caches?.blobCache) {
        this.caches.blobCache.set(sha, blobData);
      }
      offset = dataEnd + 1;
    }
    return result;
  }
}
