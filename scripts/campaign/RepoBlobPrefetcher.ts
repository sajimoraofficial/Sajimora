import { GitRepository, GitObjectReader, GitTreeEntry } from '@sajimora/analysis';

export interface PrefetchedRepoData {
  blobCache: Map<string, Buffer>;
  treeCache: Map<string, GitTreeEntry[]>;
}

export class RepoBlobPrefetcher {
  /**
   * Pre-fetches git trees and blobs for all specified revisions in a single pass.
   * Runs `git ls-tree` once per unique revision and then a chunked `git cat-file --batch`
   * to populate in-memory maps for zero-cost subsequent reads.
   */
  static prefetch(repoPath: string, revisions: string[]): PrefetchedRepoData {
    const repo = new GitRepository(repoPath);
    const treeCache = new Map<string, GitTreeEntry[]>();
    const blobCache = new Map<string, Buffer>();
    const reader = new GitObjectReader(repo, { blobCache, treeCache });

    const uniqueRevs = [...new Set(revisions)];
    const allObjectIds = new Set<string>();

    for (const rev of uniqueRevs) {
      const entries = reader.entries(rev);
      for (const entry of entries) {
        if (entry.type === 'blob') {
          allObjectIds.add(entry.objectId);
        }
      }
    }

    const CHUNK_SIZE = 5000;
    const ids = [...allObjectIds];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      reader.batchBlobs(chunk);
    }

    return { blobCache, treeCache };
  }
}
