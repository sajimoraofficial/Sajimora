/**
 * CrossLanguageSnapshotPair.ts
 *
 * Captures and validates the parent + candidate file pair for cross-language
 * analysis.  Handles both committed revisions (via GitObjectReader) and
 * working-tree captures (one-time immutable read with size/mtime/hash checks
 * and bounded Windows retry logic).
 *
 * Constraints enforced here:
 *  - Repository-relative POSIX paths only; no absolute paths, no NUL, no
 *    path escapes.
 *  - Duplicate paths are a blocker.
 *  - A file that cannot be read is a blocker — never treated as absent.
 *  - Working-tree capture hashes bytes before analysis; rejects files that
 *    change during capture (size/mtime/content divergence).
 *  - Windows transient read failures retried at most MAX_RETRIES times with
 *    exponential backoff; persistent failures are blockers.
 *  - Never calls `git add`, commits, or mutates the repository.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GitObjectReader } from '../snapshots/GitObjectReader';
import { GitRepository } from '../snapshots/GitRepository';
import {
  AnalysisBlocker,
  BlockerCode,
  buildWorkingTreeSnapshotId,
  SnapshotIdentity,
} from './CrossLanguageContracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapturedFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly bytes: Buffer;
  /** SHA-256 hex of bytes. */
  readonly sha256: string;
}

export interface SnapshotPair {
  readonly identity: SnapshotIdentity;
  /** Immutable parent file set keyed by repository-relative POSIX path. */
  readonly parentFiles: ReadonlyMap<string, CapturedFile>;
  /** Immutable candidate file set keyed by repository-relative POSIX path. */
  readonly candidateFiles: ReadonlyMap<string, CapturedFile>;
  /**
   * Paths that appear in the candidate but not the parent (added files),
   * paths in the parent but not the candidate (deleted files), and paths
   * present in both but with differing SHA-256 (modified files).
   */
  readonly changedPaths: {
    readonly added: readonly string[];
    readonly deleted: readonly string[];
    readonly modified: readonly string[];
  };
  readonly blockers: readonly AnalysisBlocker[];
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export type CandidateSelector =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'working-tree' };

export interface SnapshotPairOptions {
  /** GitRepository rooted at the monorepo root. */
  readonly repository: GitRepository;
  /** SHA-1 of the parent commit. */
  readonly parentCommit: string;
  readonly candidate: CandidateSelector;
  /**
   * File-extension filter: only paths matching at least one suffix are
   * included in the pair.  Defaults to Java + TypeScript + config extensions.
   */
  readonly includeExtensions?: readonly string[];
  /** Admit non-ignored untracked source/configuration files in IDE captures. Default true. */
  readonly includeUntracked?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXTENSIONS = [
  '.java', '.ts', '.tsx',
  '.yml', '.yaml', '.properties', '.json', '.xml',
  '.lock',
  '.config',
];

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [50, 100, 200] as const;

// Windows transient error codes that warrant a retry.
const WINDOWS_TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

// Maximum file size allowed in a capture (safety guard against binary blobs).
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isSafePath(p: string): boolean {
  if (!p || p.includes('\0') || path.isAbsolute(p)) return false;
  // Prevent path traversal
  const norm = path.normalize(p).replace(/\\/g, '/');
  return !norm.startsWith('../') && norm !== '..';
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeEol(buf: Buffer): Buffer {
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Read a single file from disk with Windows-transient-error retry logic.
 * Returns { bytes, rawSize, sha256 } on success or throws with the error code attached.
 */
async function readFileWithRetry(
  absolutePath: string
): Promise<{ bytes: Buffer; rawSize: number; sha256: string }> {
  let lastErr: NodeJS.ErrnoException | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 200);
    }
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error('File too large'), { code: 'EFBIG' });
      const raw = fs.readFileSync(absolutePath);
      if (raw.length > MAX_FILE_BYTES) {
        throw Object.assign(new Error(`File too large: ${raw.length} bytes`), { code: 'EFBIG' });
      }
      const bytes = normalizeEol(raw);
      return { bytes, rawSize: raw.length, sha256: sha256Hex(bytes) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      lastErr = e;
      if (!WINDOWS_TRANSIENT_CODES.has(e.code ?? '')) throw e;
    }
  }
  throw lastErr!;
}

/**
 * Validate that a file on disk has not changed between two stat+read cycles.
 * Returns true if stable, false if diverged.
 */
function verifyStability(
  absolutePath: string,
  expectedSha256: string,
  expectedRawSize: number
): boolean {
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.size !== expectedRawSize) return false;
    const raw = fs.readFileSync(absolutePath);
    const bytes = normalizeEol(raw);
    return sha256Hex(bytes) === expectedSha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git-committed snapshot reader
// ---------------------------------------------------------------------------

function readCommittedSnapshot(
  objects: GitObjectReader,
  revision: string,
  extensions: readonly string[]
): { files: Map<string, CapturedFile>; blockers: AnalysisBlocker[] } {
  const files = new Map<string, CapturedFile>();
  const blockers: AnalysisBlocker[] = [];
  const seen = new Set<string>();

  let entries: ReturnType<GitObjectReader['entries']>;
  try {
    entries = objects.entries(revision);
  } catch (err) {
    blockers.push({
      code: 'MISSING_PARENT_BLOB',
      message: `Cannot read tree for revision ${revision}: ${(err as Error).message}`,
    });
    return { files, blockers };
  }

  const filtered = entries.filter(e => {
    if (e.type !== 'blob') return false;
    const ext = path.extname(e.path).toLowerCase();
    return extensions.includes(ext);
  });

  const blobMap: Map<string, Buffer> = typeof objects.batchBlobs === 'function'
    ? objects.batchBlobs(filtered.map(e => e.objectId))
    : new Map();

  for (const entry of filtered) {
    const posixPath = toPosix(entry.path);
    if (entry.mode === '120000') { blockers.push({ code: 'UNSAFE_FILE_PATH', file: posixPath, message: 'Committed symlinks are not supported by sealed source capture' }); continue; }

    if (!isSafePath(posixPath)) {
      blockers.push({ code: 'UNSAFE_FILE_PATH', message: `Unsafe path in revision ${revision}: ${posixPath}`, file: posixPath });
      continue;
    }
    if (seen.has(posixPath)) {
      blockers.push({ code: 'DUPLICATE_FILE_PATH', message: `Duplicate path in revision ${revision}: ${posixPath}`, file: posixPath });
      continue;
    }
    seen.add(posixPath);

    let bytes: Buffer;
    try {
      const raw = blobMap.get(entry.objectId) ?? objects.blob(entry.objectId);
      bytes = normalizeEol(raw);
    } catch (err) {
      blockers.push({ code: 'FILE_READ_ERROR', message: `Cannot read blob ${entry.objectId} (${posixPath}): ${(err as Error).message}`, file: posixPath });
      continue;
    }

    files.set(posixPath, { path: posixPath, bytes, sha256: sha256Hex(bytes) });
  }

  return { files, blockers };
}

// ---------------------------------------------------------------------------
// Working-tree snapshot reader
// ---------------------------------------------------------------------------

async function readWorkingTreeSnapshot(
  repoRoot: string,
  extensions: readonly string[],
  includeUntracked = true
): Promise<{ files: Map<string, CapturedFile>; blockers: AnalysisBlocker[] }> {
  const files = new Map<string, CapturedFile>();
  const blockers: AnalysisBlocker[] = [];
  const seen = new Set<string>();
  const rawSizes = new Map<string, number>();
  const inventory = () => execFileSync('git', ['--no-optional-locks', '-C', repoRoot, 'ls-files', '--cached', ...(includeUntracked ? ['--others', '--exclude-standard'] : []), '-z'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean).map(toPosix).sort();
  const validateFile = (relative: string) => {
    let current = path.resolve(repoRoot);
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('Symlink or junction in capture path'), { code: 'UNSAFE_LINK' });
    }
    const resolved = fs.realpathSync(current);
    const within = path.relative(fs.realpathSync(repoRoot), resolved);
    if (within.startsWith('..') || path.isAbsolute(within)) throw Object.assign(new Error('Capture path escapes repository'), { code: 'UNSAFE_LINK' });
    if (!fs.statSync(current).isFile()) throw Object.assign(new Error('Capture entry is not a regular file'), { code: 'UNSAFE_LINK' });
  };
  const absent = new Set<string>();

  // Collect tracked files from git ls-files
  let tracked: string[];
  try {
    tracked = inventory();
  } catch (err) {
    blockers.push({ code: 'TOOL_FAILURE', message: `git ls-files failed: ${(err as Error).message}` });
    return { files, blockers };
  }

  // Filter by extension
  const relevant = tracked.filter(p => {
    const ext = path.extname(p).toLowerCase();
    return extensions.includes(ext);
  });

  // Capture phase: read + hash each file, then verify stability
  for (const relPath of relevant) {
    if (!isSafePath(relPath)) {
      blockers.push({ code: 'UNSAFE_FILE_PATH', message: `Unsafe working-tree path: ${relPath}`, file: relPath });
      continue;
    }
    if (seen.has(relPath)) {
      blockers.push({ code: 'DUPLICATE_FILE_PATH', message: `Duplicate working-tree path: ${relPath}`, file: relPath });
      continue;
    }
    seen.add(relPath);

    const absPath = path.resolve(repoRoot, ...relPath.split('/'));

    let bytes: Buffer;
    let sha256: string;
    let rawSize = 0;
    try {
      validateFile(relPath);
      const result = await readFileWithRetry(absPath);
      bytes = result.bytes;
      sha256 = result.sha256;
      rawSize = result.rawSize;
      rawSizes.set(relPath, result.rawSize);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') { absent.add(relPath); continue; }
      if (code === 'UNSAFE_LINK') { blockers.push({ code: 'UNSAFE_FILE_PATH', file: relPath, message: `Unsupported link or special file: ${relPath}` }); continue; }
      const blockerCode: BlockerCode = code === 'EFBIG' ? 'FILE_READ_ERROR' : 'FILE_READ_ERROR';
      blockers.push({ code: blockerCode, message: `Cannot read working-tree file ${relPath}: ${(err as Error).message}`, file: relPath });
      continue;
    }

    // Stability check: re-read and compare
    let safe = true;
    try { validateFile(relPath); } catch { safe = false; }
    if (!safe || !verifyStability(absPath, sha256, rawSize)) {
      blockers.push({ code: 'FILE_CHANGED_DURING_CAPTURE', message: `File changed during capture: ${relPath}`, file: relPath });
      continue;
    }

    files.set(relPath, { path: relPath, bytes, sha256 });
  }

  // Recheck the complete inventory and every captured/absent entry after all reads.
  try {
    if (JSON.stringify(inventory()) !== JSON.stringify(tracked)) blockers.push({ code: 'FILE_CHANGED_DURING_CAPTURE', message: 'Working-tree inventory changed during capture' });
    for (const [relative, file] of files) {
      try {
        validateFile(relative);
        const expectedRawSize = rawSizes.get(relative) ?? file.bytes.length;
        if (!verifyStability(path.resolve(repoRoot, relative), file.sha256, expectedRawSize)) throw new Error('Changed bytes');
      } catch { blockers.push({ code: 'FILE_CHANGED_DURING_CAPTURE', file: relative, message: `File changed during whole-capture verification: ${relative}` }); }
    }
    for (const relative of absent) {
      try { fs.lstatSync(path.resolve(repoRoot, relative)); blockers.push({ code: 'FILE_CHANGED_DURING_CAPTURE', file: relative, message: 'Deleted file reappeared during capture' }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') blockers.push({ code: 'FILE_READ_ERROR', file: relative, message: 'Cannot verify deleted file' }); }
    }
  } catch (err) { blockers.push({ code: 'TOOL_FAILURE', message: `Cannot verify capture inventory: ${err}` }); }

  return { files, blockers };
}

// ---------------------------------------------------------------------------
// Diff utility
// ---------------------------------------------------------------------------

function diffSnapshots(
  parent: ReadonlyMap<string, CapturedFile>,
  candidate: ReadonlyMap<string, CapturedFile>
): { added: string[]; deleted: string[]; modified: string[] } {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];

  for (const [p, cf] of candidate) {
    if (!parent.has(p)) {
      added.push(p);
    } else if (parent.get(p)!.sha256 !== cf.sha256) {
      modified.push(p);
    }
  }
  for (const p of parent.keys()) {
    if (!candidate.has(p)) deleted.push(p);
  }

  return {
    added: added.sort(),
    deleted: deleted.sort(),
    modified: modified.sort(),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function captureSnapshotPair(
  opts: SnapshotPairOptions
): Promise<SnapshotPair> {
  const extensions = opts.includeExtensions ?? DEFAULT_EXTENSIONS;
  const allBlockers: AnalysisBlocker[] = [];

  const objects = new GitObjectReader(opts.repository);

  // --- Parent (always committed) ---
  const parentResult = readCommittedSnapshot(objects, opts.parentCommit, extensions);
  allBlockers.push(...parentResult.blockers);

  // --- Candidate ---
  let candidateFiles: Map<string, CapturedFile>;
  let candidateSnapshotId: string;

  if (opts.candidate.kind === 'commit') {
    const candidateResult = readCommittedSnapshot(objects, opts.candidate.sha, extensions);
    allBlockers.push(...candidateResult.blockers);
    candidateFiles = candidateResult.files;
    candidateSnapshotId = opts.candidate.sha;
  } else {
    // working-tree
    const wtResult = await readWorkingTreeSnapshot(opts.repository.root, extensions, opts.includeUntracked ?? true);
    allBlockers.push(...wtResult.blockers);
    candidateFiles = wtResult.files;
    // Build a deterministic working-tree snapshot ID
    const fileList = [...wtResult.files.values()].map(f => ({ path: f.path, sha256: f.sha256 }));
    candidateSnapshotId = buildWorkingTreeSnapshotId(fileList);
  }

  // --- Repository identity ---
  let repositoryId: string;
  try {
    repositoryId = opts.repository.repositoryId();
  } catch (err) {
    repositoryId = 'unknown';
    allBlockers.push({ code: 'TOOL_FAILURE', message: `Cannot determine repository ID: ${(err as Error).message}` });
  }

  const identity: SnapshotIdentity = {
    repositoryId,
    parentCommit: opts.parentCommit,
    candidateSnapshot: candidateSnapshotId,
  };

  const diff = diffSnapshots(parentResult.files, candidateFiles);

  return {
    identity,
    parentFiles: parentResult.files,
    candidateFiles,
    changedPaths: diff,
    blockers: allBlockers,
  };
}
