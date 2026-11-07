/**
 * SAJIMORA V32 — Git-Authoritative Change-Set Pre-Filter & Git Repository Provider
 * Subordinate to sajimora_v32_foundation_spec.md §2.3 & VCS-Agnostic Architecture.
 *
 * Implements IRepositoryStateProvider for Git repositories.
 * Derives the exact file change set directly between baseCommitSha and candidateCommitSha
 * via Git. Git is authoritative for file status (ADDED, MODIFIED, DELETED, RENAMED).
 * Unchanged repository files are strictly excluded from subsequent AST parsing.
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizePosixPath } from '../ecm/validator';
import { ChangedFile } from '../types';
import { IRepositoryStateProvider, RepositoryFilterOptions } from './RepositoryStateProvider';

const execFileAsync = promisify(execFile);

export interface IGitRunner {
  raw(args: string[]): Promise<string>;
  show?(args: string[]): Promise<string>;
}

export class NativeGitRunner implements IGitRunner {
  constructor(private workspaceRoot: string) {}

  async raw(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.workspaceRoot,
      maxBuffer: 25 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  }

  async show(args: string[]): Promise<string> {
    return this.raw(['show', ...args]);
  }
}



export function unquoteGitPath(pathStr: string): string {
  let s = pathStr.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
    s = s.replace(/\\([0-7]{1,3}|[\\abfnrtv"'])/g, (_, esc) => {
      if (/^[0-7]+$/.test(esc)) {
        return String.fromCharCode(parseInt(esc, 8));
      }
      switch (esc) {
        case 'a': return '\x07';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'v': return '\v';
        case '\\': return '\\';
        case '"': return '"';
        case '\'': return '\'';
        default: return esc;
      }
    });
  }
  return s;
}

export interface GitFilterOptions extends RepositoryFilterOptions {}

export class GitChangeSetFilter implements IRepositoryStateProvider {
  readonly providerKind = 'git';
  private git: IGitRunner;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, customGit?: IGitRunner) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.git = customGit || new NativeGitRunner(this.workspaceRoot);
  }

  /**
   * Retrieves the raw Git difference between baseCommitSha and candidateCommitSha.
   * Parses git diff --name-status output deterministically.
   */
  async getActualChangeSet(
    baseCommitSha: string,
    candidateCommitSha: string,
    options: GitFilterOptions = {}
  ): Promise<ChangedFile[]> {
    if (!baseCommitSha || !candidateCommitSha) {
      throw new Error('GitChangeSetFilter requires both baseCommitSha and candidateCommitSha.');
    }

    const maxFiles = options.maxFilesChanged ?? 500;

    // Run direct commit diff: git diff --name-status -M base candidate
    // -M enables rename detection directly from git
    const diffRaw = await this.git.raw([
      'diff',
      '--name-status',
      '-M',
      baseCommitSha,
      candidateCommitSha,
    ]);


    const lines = diffRaw.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
    const results: ChangedFile[] = [];

    for (const line of lines) {
      const parts = line.split(/\t+/);
      if (parts.length < 2) continue;

      const statusCode = parts[0].trim();
      const firstPath = unquoteGitPath(parts[1]);

      if (statusCode.startsWith('A')) {
        const p = normalizePosixPath(firstPath);
        if (p) {
          results.push({ filePath: p, changeType: 'ADDED' });
        }
      } else if (statusCode.startsWith('M')) {
        const p = normalizePosixPath(firstPath);
        if (p) {
          results.push({ filePath: p, changeType: 'MODIFIED' });
        }
      } else if (statusCode.startsWith('D')) {
        const p = normalizePosixPath(firstPath);
        if (p) {
          results.push({ filePath: p, changeType: 'DELETED' });
        }
      } else if (statusCode.startsWith('R')) {
        // Renamed format: R<percentage>\t<oldPath>\t<newPath>
        const oldP = normalizePosixPath(firstPath);
        const secondPath = parts.length >= 3 ? unquoteGitPath(parts[2]) : '';
        const newP = secondPath ? normalizePosixPath(secondPath) : null;
        if (newP && oldP) {
          results.push({
            filePath: newP,
            changeType: 'RENAMED',
            oldFilePath: oldP,
          });
        }
      } else {
        // Default to MODIFIED for other git codes (e.g. T = typechange)
        const p = normalizePosixPath(firstPath);
        if (p) {
          results.push({ filePath: p, changeType: 'MODIFIED' });
        }
      }

      if (results.length > maxFiles) {
        throw new Error(
          `RESOURCE_LIMIT_EXCEEDED: Actual Git change set exceeded maxFiles limit of ${maxFiles}.`
        );
      }
    }

    // Deterministic alphabetical sort by filePath (binary UTF-16 code units)
    results.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    return results;
  }

  /**
   * Retrieves raw file content at a historical commit via git show.
   */
  async getFileContentAtRevision(revision: string, filePath: string): Promise<string | null> {
    try {
      const out = this.git.show
        ? await this.git.show([`${revision}:${filePath}`])
        : await this.git.raw(['show', `${revision}:${filePath}`]);
      return typeof out === 'string' ? out : null;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (
        msg.includes('does not exist') ||
        msg.includes('exists on disk, but not in') ||
        msg.includes('fatal: Path') ||
        msg.includes('fatal: bad object')
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Retrieves raw file content at candidate commit via git show.
   */
  async getCandidateFileContent(revision: string, filePath: string): Promise<string | null> {
    return this.getFileContentAtRevision(revision, filePath);
  }
}
