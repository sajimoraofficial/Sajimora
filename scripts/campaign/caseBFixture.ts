import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CaseBFixtureResult {
  repoPath: string;
  parentSha: string;
  candidateSha: string;
  targetFile: string;
  targetSymbol: string;
}

/**
 * Deterministically creates or ensures the existence of a minimal synthetic Git repository
 * using Git plumbing objects, containing an F0-valid provider file across two commits where
 * the provider file is modified between parent and candidate (genuine Case-B).
 */
export function ensureCaseBGitFixture(): CaseBFixtureResult {
  const targetDir = path.resolve('test/fixtures/case_b_git_repo');
  const targetFile = 'provider.ts';
  const targetSymbol = 'calc';

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    execFileSync('git', ['init'], { cwd: targetDir });
    execFileSync('git', ['config', 'user.name', 'Pilot Author'], { cwd: targetDir });
    execFileSync('git', ['config', 'user.email', 'pilot@sajimora.test'], { cwd: targetDir });
  }

  // Generate parent blob using git plumbing: hash-object
  const parentContent = Buffer.from('export function calc(): number { return 1; }\n', 'utf8');
  const parentBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: targetDir,
    input: parentContent
  }).toString().trim();

  // Generate parent tree using git plumbing: mktree
  const parentTreeEntry = `100644 blob ${parentBlob}\t${targetFile}\n`;
  const parentTree = execFileSync('git', ['mktree'], {
    cwd: targetDir,
    input: Buffer.from(parentTreeEntry, 'utf8')
  }).toString().trim();

  // Generate parent commit using git plumbing: commit-tree
  const parentCommit = execFileSync('git', ['commit-tree', parentTree, '-m', 'Parent F0 provider'], {
    cwd: targetDir
  }).toString().trim();

  // Generate candidate blob using git plumbing: hash-object (modified provider file, F0-valid)
  const candidateContent = Buffer.from('export function calc(): number { return 2; }\n', 'utf8');
  const candidateBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: targetDir,
    input: candidateContent
  }).toString().trim();

  // Generate candidate tree using git plumbing: mktree
  const candidateTreeEntry = `100644 blob ${candidateBlob}\t${targetFile}\n`;
  const candidateTree = execFileSync('git', ['mktree'], {
    cwd: targetDir,
    input: Buffer.from(candidateTreeEntry, 'utf8')
  }).toString().trim();

  // Generate candidate commit pointing to parentCommit as parent
  const candidateCommit = execFileSync('git', ['commit-tree', candidateTree, '-p', parentCommit, '-m', 'Candidate F0 provider modified'], {
    cwd: targetDir
  }).toString().trim();

  // Update HEAD ref
  execFileSync('git', ['update-ref', 'refs/heads/main', candidateCommit], { cwd: targetDir });

  return {
    repoPath: targetDir,
    parentSha: parentCommit,
    candidateSha: candidateCommit,
    targetFile,
    targetSymbol
  };
}
