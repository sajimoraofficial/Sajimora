import { CanonicalReferenceOccurrence, ProvenanceHop } from './usage';
import { UnrecognizedBindingForm } from './binding';

export type EnumerationStatus =
  | 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE'
  | 'RESOLUTION_COMPLETE'
  | 'INCOMPLETE'
  | 'UNDECIDABLE';

export type UniverseDiscoveryStatus =
  | 'DISCOVERY_COMPLETE'
  | 'DISCOVERY_INCOMPLETE'
  | 'DISCOVERY_FAILED';

export type ClosureCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'FAILED';

export type ClosureName =
  | 'ValueReferenceClosure'
  | 'TypeReferenceClosure'
  | 'InheritanceClosure'
  | 'InterfaceImplClosure'
  | 'OverrideClosure'
  | 'ReExportClosure'
  | 'AmbientReferenceClosure';

export interface RepositoryAnalysisUniverse {
  rootPath: string;                      // Normalized absolute workspace root (POSIX slashes)
  discoveredFiles: string[];             // Normalized absolute file paths (ordered)
  discoveredFileSet: Set<string>;        // O(1) authoritative membership index
  excludedFiles: Map<string, string>;    // filePath -> explicit, auditable exclusion reason
  unsupportedFiles: string[];
  unreadableFiles: string[];
  parseFailures: Map<string, string>;    // filePath -> parser diagnostic
  discoveryStatus: UniverseDiscoveryStatus;
  discoveryEvidence: string;
  /** Compiler options resolved from the authoritative tsconfig graph. */
  compilerOptions?: Record<string, unknown>;
}

import * as path from 'path';

/**
 * Authoritative cross-platform path normalization.
 *
 * Contract (all callers must rely on this invariant):
 *   • Input may be absolute or relative; output is ALWAYS absolute (resolved
 *     against process.cwd() for relative inputs — callers must pass absolute paths
 *     when the intended root differs from CWD).
 *   • All path separators are forward POSIX slashes.
 *   • Windows drive letters are lowercase (c:/ not C:/).
 *   • No redundant separators (// collapsed) and no . / .. components.
 *   • Leading BOM is stripped before processing.
 *   • fs.realpathSync is NOT used — symlinks are not resolved so the normalised
 *     form is always lexically deterministic regardless of filesystem state.
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return '';
  // Strip BOM (U+FEFF) that some editors prepend to UTF-8 files.
  let clean = filePath.charCodeAt(0) === 0xfeff ? filePath.slice(1) : filePath;
  // If it is a Windows absolute path (e.g. C:/ or c:\) on POSIX, do not path.resolve against POSIX CWD
  if (/^[a-zA-Z]:[/\\]/.test(clean)) {
    clean = clean.replace(/\\/g, '/');
    clean = clean.replace(/\/+/g, '/');
    clean = clean.charAt(0).toLowerCase() + clean.slice(1);
    return clean;
  }
  try {
    // path.resolve: makes absolute (if relative, uses CWD), resolves .., normalises.
    // path.normalize: collapses redundant separators (// → /) after resolve in case
    // the platform or the caller produced doubled slashes.
    clean = path.normalize(path.resolve(clean));
  } catch {
    // Fallback: manual normalisation for edge-case inputs that confuse path.resolve.
    clean = path.normalize(clean);
  }
  // Canonicalize to POSIX slashes regardless of OS.
  clean = clean.replace(/\\/g, '/');
  // Lowercase Windows drive letter for deterministic cross-session comparison.
  if (/^[a-zA-Z]:\//.test(clean)) {
    clean = clean.charAt(0).toLowerCase() + clean.slice(1);
  }
  return clean;
}

interface CaseInsensitiveMembershipIndex {
  readonly lowercasedEntries: Set<string>;
}

const caseInsensitiveMembershipIndexes = new WeakMap<Set<string>, CaseInsensitiveMembershipIndex>();

/**
 * Builds a case-folded companion index for the authoritative membership set.
 *
 * `RepositoryAnalysisUniverse` sets are normally immutable after discovery, but
 * a few fail-closed paths deliberately remove a file after construction.  The
 * instance-level mutator wrappers keep the companion index synchronized for
 * those normal Set mutations without changing the Set's public behavior.
 */
function getCaseInsensitiveMembershipIndex(entries: Set<string>): CaseInsensitiveMembershipIndex {
  const cached = caseInsensitiveMembershipIndexes.get(entries);
  if (cached) return cached;

  const index: CaseInsensitiveMembershipIndex = {
    lowercasedEntries: new Set([...entries].map(entry => entry.toLowerCase()))
  };
  caseInsensitiveMembershipIndexes.set(entries, index);

  const originalAdd = entries.add;
  const originalDelete = entries.delete;
  const originalClear = entries.clear;

  Object.defineProperties(entries, {
    add: {
      configurable: true,
      writable: true,
      value(value: string): Set<string> {
        const existed = entries.has(value);
        const result = originalAdd.call(entries, value);
        if (!existed) index.lowercasedEntries.add(value.toLowerCase());
        return result;
      }
    },
    delete: {
      configurable: true,
      writable: true,
      value(value: string): boolean {
        const existed = entries.has(value);
        const result = originalDelete.call(entries, value);
        if (existed && !entries.has(value)) {
          const lower = value.toLowerCase();
          for (const entry of entries) {
            if (entry.toLowerCase() === lower) return result;
          }
          index.lowercasedEntries.delete(lower);
        }
        return result;
      }
    },
    clear: {
      configurable: true,
      writable: true,
      value(): void {
        originalClear.call(entries);
        index.lowercasedEntries.clear();
      }
    }
  });

  return index;
}

export function isSourceInUniverse(
  universe: RepositoryAnalysisUniverse,
  sourcePath: string
): boolean {
  if (!universe || !universe.discoveredFileSet) return false;
  const norm = normalizePath(sourcePath);
  if (universe.discoveredFileSet.has(norm)) return true;

  // Case-insensitive fallback for Windows environments
  return getCaseInsensitiveMembershipIndex(universe.discoveredFileSet)
    .lowercasedEntries.has(norm.toLowerCase());
}

export interface UnresolvedBinding {
  file: string;
  astNodeContext: string;
}

export interface VerificationTrace {
  repositoryFilesScanned: number;
  totalRepositoryFiles: number;
  reExporterDownstreamVerified: boolean;
  enumerationInconsistencies: { file: string; cause: string }[];
}

export interface ClosureEvidence {
  closureName: ClosureName;
  occurrences: CanonicalReferenceOccurrence[];
  completeness: ClosureCompleteness;
  failures: { file: string; cause: string }[];
  ambiguities: { location: string; description: string }[];
  unrecognizedForms: UnrecognizedBindingForm[];
  provenance: ProvenanceHop[];
  status?: EnumerationStatus; // backwards compatibility
}

// Backwards-compatible interface for existing tests
export interface ClosureResult<S> {
  occurrences: CanonicalReferenceOccurrence[];
  unresolved: UnresolvedBinding[];
  unsupported: UnrecognizedBindingForm[];
  unscannedFiles: string[];
  scannedFiles: string[];
  status: EnumerationStatus;
  completenessProof: VerificationTrace;
}
