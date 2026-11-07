import { createHash } from 'node:crypto';

/**
 * Replaces absolute temporary snapshot directory roots with a deterministic relative placeholder.
 * Handles Windows and POSIX path separators, escaped JSON strings, and drive letters.
 */
export function stripSnapshotRoot(str: string): string {
  return str.replace(/(?:[A-Za-z]:[/\\][^\s"']*?|[^\s"']*?)[/\\]?sajimora-snapshot-[^/\\"\s']+[/\\]?/gi, 'snapshot/');
}

/**
 * Canonicalizes evidence objects for deterministic comparison and SHA-256 hashing.
 * - Sorts object keys lexicographically
 * - Maps arrays deterministically
 * - Strips non-deterministic operational metrics (durationMs, peakRssBytes)
 * - Normalizes snapshot roots in strings
 */
export function normalizeEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripSnapshotRoot(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeEvidence);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'durationMs' && key !== 'peakRssBytes')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, normalizeEvidence(child)])
    );
  }
  return value;
}

/**
 * Calculates SHA-256 hash over canonical serialized evidence.
 */
export function hashNormalizedEvidence(value: unknown): string {
  const normalized = normalizeEvidence(value);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Backwards-compatible namespace-style API used by the phase verification tools. */
export class NormalizedEvidenceHasher {
  public static normalize(value: unknown): unknown {
    return normalizeEvidence(value);
  }

  public static hash(value: unknown): string {
    return hashNormalizedEvidence(value);
  }
}
