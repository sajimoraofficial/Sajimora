/**
 * SAJIMORA V32 — Repository State Provider Interface
 * Subordinate to sajimora_v32_foundation_spec.md §2 & VCS-Agnostic Architecture.
 *
 * Decouples V32 Change Intelligence Core from specific Version Control Systems.
 * Allows pluggable providers (Git, SVN, Mercurial, Perforce, in-memory test doubles)
 * without modifying ECM, AST Diff Engine, Evidence Ledger, Reconciliation, or Verdict logic.
 */

import { ChangedFile } from '../types';

export interface RepositoryFilterOptions {
  maxFilesChanged?: number;
}

export interface IRepositoryStateProvider {
  /** The identifier for this provider implementation (e.g. 'git', 'svn', 'in-memory'). */
  readonly providerKind: string;

  /**
   * Retrieves the authoritative set of changed files between baseRevision and candidateRevision.
   * Status must be normalized to: ADDED, MODIFIED, DELETED, RENAMED.
   * Deterministically sorted by filePath.
   */
  getActualChangeSet(
    baseRevision: string,
    candidateRevision: string,
    options?: RepositoryFilterOptions
  ): Promise<ChangedFile[]>;

  /**
   * Retrieves raw file content at a historical base revision (e.g. git show, svn cat).
   * Returns null if file did not exist in the base revision.
   */
  getFileContentAtRevision(
    revision: string,
    filePath: string
  ): Promise<string | null>;

  /**
   * Retrieves raw file content at the candidate revision or working copy.
   * Returns null if file does not exist.
   */
  getCandidateFileContent?(
    revision: string,
    filePath: string
  ): Promise<string | null>;
}
