import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface ColdStartArgs {
  outputDir: string;
}

function parseArgs(): ColdStartArgs {
  const args = process.argv.slice(2);
  let outputDir = 'scripts/campaign/results_cold';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-dir' && i + 1 < args.length) {
      outputDir = args[i + 1];
      i++;
    }
  }
  return { outputDir };
}

async function runColdStartCampaign() {
  const { outputDir } = parseArgs();
  const repos = ['turborepo', 'TypeScript-Website', 'express', 'zod'];
  const rootDir = process.cwd();
  const targetOutputDir = path.resolve(rootDir, outputDir);

  if (!fs.existsSync(targetOutputDir)) {
    fs.mkdirSync(targetOutputDir, { recursive: true });
  }

  let totalCasesRun = 0;
  const campaignStartTime = Date.now();

  for (const repo of repos) {
    const labelsFile = path.resolve(rootDir, 'scripts/campaign/labels', `${repo}.json`);
    const labels: any[] = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    const repoResults: any[] = [];

    console.log(`\n=== Starting Cold-Start Campaign for ${repo} (${labels.length} cases) ===`);

    for (let idx = 0; idx < labels.length; idx++) {
      const caseStartTime = Date.now();
      totalCasesRun++;

      // Launch a FRESH OS PROCESS per case
      // Use the same Windows sandbox user-info shim as the test runners.
      // Direct tsx startup calls os.userInfo(), which libuv can reject for the
      // sandbox token even when system memory is available.
      const cmd = `node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/runner_single_case.ts --repo ${repo} --case-index ${idx} --labels ${labelsFile}`;
      
      let rawResult = '';
      try {
        rawResult = execSync(cmd, { cwd: rootDir, encoding: 'utf8', shell: process.env.ComSpec ?? 'cmd.exe', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch (err: any) {
        console.error(`Error running case ${idx} for ${repo}:`, err.message);
      }

      // Parse JSON row output from spawned single-case process
      const lines = rawResult.split('\n').filter(Boolean);
      const jsonLine = lines[lines.length - 1]; // Last line contains JSON row
      let row: any;

      try {
        row = JSON.parse(jsonLine);
      } catch {
        row = {
          repo,
          caseId: `${repo}:case_${idx}`,
          commitSha: labels[idx].commitSha,
          parentSha: labels[idx].parentSha,
          targetSymbol: labels[idx].targetSymbol,
          targetFile: labels[idx].targetFile,
          expectedVerdict: labels[idx].expectedVerdict,
          actualVerdict: 'CRASH',
          match: false,
          completeness: 'FAILED',
          failureCause: 'Failed to parse single-case child process output',
          occurrenceCount: 0,
          durationMs: Date.now() - caseStartTime
        };
      }

      repoResults.push(row);
      console.log(
        `  [Cold-Start Process #${totalCasesRun}] ${repo} #${idx + 1}/${labels.length} | SHA: ${row.commitSha.slice(0, 7)} | Target: ${row.targetSymbol} | Expected: ${row.expectedVerdict} | Actual: ${row.actualVerdict} | Time: ${row.durationMs}ms`
      );
    }

    const repoOutPath = path.join(targetOutputDir, `${repo}.json`);
    fs.writeFileSync(repoOutPath, JSON.stringify(repoResults, null, 2));
    console.log(`Wrote cold-start results to ${repoOutPath}`);
  }

  const totalTimeMs = Date.now() - campaignStartTime;
  console.log(`\n================================================================`);
  console.log(`Cold-Start Campaign Execution Complete!`);
  console.log(`Total Cases Executed: ${totalCasesRun}`);
  console.log(`Total Elapsed Time: ${(totalTimeMs / 1000).toFixed(2)}s`);
  console.log(`================================================================`);
}

runColdStartCampaign().catch(err => {
  console.error('Fatal cold start campaign error:', err);
  process.exit(1);
});
