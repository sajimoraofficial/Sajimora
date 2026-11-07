import { MaterializedSnapshot } from '@sajimora/analysis';

interface CacheEntry {
  snapshot: MaterializedSnapshot;
  pinned: boolean;
  lastUsed: number;
}

export class SnapshotSessionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 3) {
    this.maxEntries = maxEntries;
  }

  /**
   * Acquire a cached snapshot if present, marking it as pinned (in active use).
   * Returns undefined on cache miss.
   */
  acquire(sha: string): MaterializedSnapshot | undefined {
    const entry = this.entries.get(sha);
    if (!entry) return undefined;
    entry.pinned = true;
    entry.lastUsed = Date.now();
    return entry.snapshot;
  }

  /**
   * Store a newly materialized snapshot in the session cache, marked as pinned.
   * Evicts the oldest unpinned entry if cache capacity is exceeded.
   */
  store(sha: string, snapshot: MaterializedSnapshot): void {
    if (this.entries.has(sha)) {
      const existing = this.entries.get(sha)!;
      existing.pinned = true;
      existing.lastUsed = Date.now();
      return;
    }

    this.evictIfNecessary();

    this.entries.set(sha, {
      snapshot,
      pinned: true,
      lastUsed: Date.now()
    });
  }

  /**
   * Mark the snapshot as no longer pinned by the current caller.
   * Retains the snapshot in cache for subsequent pairs until evicted or released.
   */
  release(sha: string): void {
    const entry = this.entries.get(sha);
    if (!entry) return;
    entry.pinned = false;
  }

  /**
   * Evict the oldest unpinned snapshot if the cache exceeds maxEntries.
   */
  private evictIfNecessary(): void {
    if (this.entries.size < this.maxEntries) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries.entries()) {
      if (!entry.pinned && entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      try {
        entry?.snapshot.cleanup();
      } catch {
        // Ignore filesystem cleanup errors
      }
    }
  }

  /**
   * Unconditionally clean up and evict all cached snapshots.
   * Must be called when finished evaluating a repository.
   */
  releaseAll(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.snapshot.cleanup();
      } catch {
        // Ignore filesystem cleanup errors
      }
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
