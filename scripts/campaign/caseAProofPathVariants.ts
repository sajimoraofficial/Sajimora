import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CaseAProofPathVariant = 'violated' | 'not-applicable';

export interface CaseAProofPathVariantFixture {
  repoPath: string;
  parentSha: string;
  candidateSha: string;
  targetFile: string;
  consumerFile: string;
  targetSymbol: string;
}

/** Creates immutable, minimal, Git-backed Case-A fixture revisions. */
export function ensureCaseAProofPathVariant(variant: CaseAProofPathVariant): CaseAProofPathVariantFixture {
  const repoPath = path.resolve(`test/fixtures/case_a_${variant}_proof_path_git_repo`);
  const targetFile = 'provider.ts';
  const consumerFile = 'consumer.ts';
  const targetSymbol = variant === 'violated' ? 'greet' : 'unused';
  const provider = variant === 'violated'
    ? 'export function greet(name: string): string { return name; }\n'
    : 'export function unused(): string { return "unused"; }\n';
  const parentConsumer = variant === 'violated'
    ? 'import { greet } from "./provider";\nexport const message: string = greet("parent");\n'
    : 'export const message: string = "parent";\n';
  const candidateConsumer = variant === 'violated'
    ? 'import { greet } from "./provider";\nexport const message: string = greet("candidate");\n'
    : 'export const message: string = "candidate";\n';
  const refBase = `refs/sajimora-fixtures/case-a-${variant}`;

  fs.mkdirSync(repoPath, { recursive: true });
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Sajimora Fixture'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'fixture@sajimora.test'], { cwd: repoPath });
  }
  try {
    const parentSha = execFileSync('git', ['rev-parse', '--verify', `${refBase}-parent`], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const candidateSha = execFileSync('git', ['rev-parse', '--verify', `${refBase}-candidate`], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { repoPath, parentSha, candidateSha, targetFile, consumerFile, targetSymbol };
  } catch { /* initial creation follows */ }

  fs.writeFileSync(path.join(repoPath, targetFile), provider, 'utf8');
  fs.writeFileSync(path.join(repoPath, consumerFile), parentConsumer, 'utf8');
  execFileSync('git', ['add', targetFile, consumerFile], { cwd: repoPath });
  const parentTree = execFileSync('git', ['write-tree'], { cwd: repoPath }).toString().trim();
  const parentSha = execFileSync('git', ['commit-tree', parentTree, '-m', `Case-A ${variant} parent`], { cwd: repoPath }).toString().trim();
  fs.writeFileSync(path.join(repoPath, consumerFile), candidateConsumer, 'utf8');
  execFileSync('git', ['add', consumerFile], { cwd: repoPath });
  const candidateTree = execFileSync('git', ['write-tree'], { cwd: repoPath }).toString().trim();
  const candidateSha = execFileSync('git', ['commit-tree', candidateTree, '-p', parentSha, '-m', `Case-A ${variant} candidate`], { cwd: repoPath }).toString().trim();
  execFileSync('git', ['update-ref', `${refBase}-parent`, parentSha], { cwd: repoPath });
  execFileSync('git', ['update-ref', `${refBase}-candidate`, candidateSha], { cwd: repoPath });
  return { repoPath, parentSha, candidateSha, targetFile, consumerFile, targetSymbol };
}
