const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repos = ['turborepo', 'TypeScript-Website', 'express', 'zod'];
const rootDir = process.cwd();

const candidatePool = {};
const selectedCases = {};

for (const repo of repos) {
  const repoDir = path.join(rootDir, 'scripts/campaign/repos', repo);
  console.log(`\n--- Candidate Pool Selection for ${repo} ---`);
  
  // Get recent 80 non-merge commit SHAs
  const rawLog = execSync('git log -n 80 --pretty=format:"%H" --no-merges', { cwd: repoDir, encoding: 'utf8' });
  const shas = rawLog.trim().split('\n').filter(Boolean);
  
  const pool = [];
  
  for (const sha of shas) {
    try {
      const parentSha = execSync(`git rev-parse ${sha}^`, { cwd: repoDir, encoding: 'utf8' }).trim();
      const filesOutput = execSync(`git diff-tree --no-commit-id --name-only -r ${sha}`, { cwd: repoDir, encoding: 'utf8' });
      const files = filesOutput.trim().split('\n').filter(Boolean);
      
      const sourceFiles = files.filter(f => {
        const isCode = f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js');
        const isTest = f.includes('/test/') || f.includes('.test.') || f.includes('.spec.') || f.includes('/__tests__/');
        const isDocs = f.startsWith('docs/') || f.endsWith('.md');
        return isCode && !isTest && !isDocs;
      });
      
      if (sourceFiles.length === 0) continue;
      const diff = execSync(`git show ${sha} -- ${sourceFiles.join(' ')}`, { cwd: repoDir, encoding: 'utf8' });
      const addedOrRemovedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'));
      
      pool.push({
        commitSha: sha,
        parentSha,
        sourceFiles,
        fileCount: sourceFiles.length,
        patchSize: addedOrRemovedLines.length
      });
    } catch (err) {
      // Ignore root or invalid commits
    }
  }
  
  console.log(`Eligible candidates found: ${pool.length}`);
  candidatePool[repo] = pool;
  
  const sorted = [...pool].sort((a, b) => a.commitSha.localeCompare(b.commitSha));
  const selected = sorted.slice(0, 10);
  
  selectedCases[repo] = selected;
  console.log(`Selected top ${selected.length} candidates for ${repo}`);
}

const candPath = path.join(rootDir, 'scripts/campaign/candidate_pool.json');
fs.writeFileSync(
  candPath,
  JSON.stringify({ selectionMethod: "Deterministic SHA-based ordering (lexicographical)", candidatePool, selectedCases }, null, 2)
);

console.log('\nCandidate pool saved to ' + candPath);
