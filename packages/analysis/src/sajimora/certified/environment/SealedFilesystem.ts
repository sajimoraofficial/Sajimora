import { FileEntry } from '../../../../../core/src/sajimora/certified/contracts';

/**
 * Provides a logical immutable namespace over the sealed inputs.
 * Never resolves through the host/live filesystem.
 * Acts as the SINGLE canonical namespace validation boundary.
 */
export class SealedFilesystem {
  readonly #fileMap = new Map<string, FileEntry>();
  readonly #dataMap = new Map<string, Buffer>();

  constructor(
    files: FileEntry[],
    dataEntries: { digest: string; data: Buffer }[],
    caseSensitivity: string
  ) {
    const canonicalPaths = new Set<string>();

    for (const file of files) {
      const p = file.logicalPath;
      
      // Reject absolute POSIX and Windows drive paths
      if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) {
        throw new Error(`SealedFilesystem rejected absolute/drive/UNC path: ${p}`);
      }
      
      // Reject traversal and invalid segments
      const segments = p.split(/[/\\]/);
      for (const seg of segments) {
        if (seg === '..') {
          throw new Error(`SealedFilesystem rejected path traversal: ${p}`);
        }
      }
      
      // Reject mixed/invalid separators (enforce forward slash only for logical namespace)
      if (p.includes('\\')) {
        throw new Error(`SealedFilesystem rejected invalid separator: ${p}`);
      }

      // Exact logical path uniqueness
      if (this.#fileMap.has(p)) {
        throw new Error(`SealedFilesystem rejected duplicate logical path: ${p}`);
      }
      this.#fileMap.set(p, structuredClone(file));

      // Canonical uniqueness (Unicode + Case sensitivity)
      let canonical = p.normalize('NFC');
      if (canonical !== p) {
        // Must already be normalized
        throw new Error(`SealedFilesystem rejected unnormalized unicode path: ${p}`);
      }
      
      if (caseSensitivity === 'CASE_INSENSITIVE') {
        canonical = canonical.toLowerCase();
      }
      
      if (canonicalPaths.has(canonical)) {
        throw new Error(`SealedFilesystem rejected canonical collision: ${p}`);
      }
      canonicalPaths.add(canonical);
    }

    for (const entry of dataEntries) {
      const existing = this.#dataMap.get(entry.digest);
      if (existing && !existing.equals(entry.data)) {
        throw new Error(`SealedFilesystem rejected conflicting byte data for digest: ${entry.digest}`);
      }
      this.#dataMap.set(entry.digest, Buffer.from(entry.data));
    }
  }

  public exists(logicalPath: string): boolean {
    return this.#fileMap.has(logicalPath);
  }

  public getEntry(logicalPath: string): FileEntry | undefined {
    const entry = this.#fileMap.get(logicalPath);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  public readBytes(logicalPath: string): Buffer {
    const entry = this.#fileMap.get(logicalPath);
    if (!entry) {
      throw new Error(`File not found in sealed namespace: ${logicalPath}`);
    }
    const data = this.#dataMap.get(entry.bytesRef.digest);
    if (!data) {
      throw new Error(`Missing byte data for digest: ${entry.bytesRef.digest}`);
    }
    return Buffer.from(data);
  }
}
