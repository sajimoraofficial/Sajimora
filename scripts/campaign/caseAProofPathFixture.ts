import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CaseAProofPathFixture {
  repoPath: string;
  parentSha: string;
  candidateSha: string;
  targetFile: string;
  consumerFile: string;
  targetSymbol: string;
}

/**
 * A deliberately tiny Git-backed Case-A fixture.  The production provider is
 * byte-identical in both commits; only the F0 consumer call literal changes.
 */
export function ensureCaseAProofPathFixture(): CaseAProofPathFixture {
  const repoPath = path.resolve('test/fixtures/case_a_proof_path_git_repo');
  const targetFile = 'provider.ts';
  const consumerFile = 'consumer.ts';
  const targetSymbol = 'greet';
  const provider = 'export function greet(name: string): string { return name; }\n';
  const parentConsumer = 'import { greet } from "./provider";\nexport const message: string = greet("parent");\n';
  const candidateConsumer = 'import { greet } from "./provider";\nexport const message: string = greet("candidate");\n';

  fs.mkdirSync(repoPath, { recursive: true });
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Sajimora Fixture'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'fixture@sajimora.test'], { cwd: repoPath });
  }

  try {
    const parentSha = execFileSync('git', ['rev-parse', '--verify', 'refs/sajimora-fixtures/case-a-parent'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const candidateSha = execFileSync('git', ['rev-parse', '--verify', 'refs/sajimora-fixtures/case-a-candidate'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { repoPath, parentSha, candidateSha, targetFile, consumerFile, targetSymbol };
  } catch {
    // First creation continues below. Subsequent calls reuse these immutable refs.
  }

  fs.writeFileSync(path.join(repoPath, targetFile), provider, 'utf8');
  fs.writeFileSync(path.join(repoPath, consumerFile), parentConsumer, 'utf8');
  execFileSync('git', ['add', targetFile, consumerFile], { cwd: repoPath });
  const parentTree = execFileSync('git', ['write-tree'], { cwd: repoPath }).toString().trim();
  const parentSha = execFileSync('git', ['commit-tree', parentTree, '-m', 'Case-A parent'], { cwd: repoPath }).toString().trim();

  fs.writeFileSync(path.join(repoPath, consumerFile), candidateConsumer, 'utf8');
  execFileSync('git', ['add', consumerFile], { cwd: repoPath });
  const candidateTree = execFileSync('git', ['write-tree'], { cwd: repoPath }).toString().trim();
  const candidateSha = execFileSync('git', ['commit-tree', candidateTree, '-p', parentSha, '-m', 'Case-A consumer change'], { cwd: repoPath }).toString().trim();
  execFileSync('git', ['update-ref', 'refs/sajimora-fixtures/case-a-parent', parentSha], { cwd: repoPath });
  execFileSync('git', ['update-ref', 'refs/sajimora-fixtures/case-a-candidate', candidateSha], { cwd: repoPath });
  execFileSync('git', ['update-ref', 'refs/heads/main', candidateSha], { cwd: repoPath });

  return { repoPath, parentSha, candidateSha, targetFile, consumerFile, targetSymbol };
}
