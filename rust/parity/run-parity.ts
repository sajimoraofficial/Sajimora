import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const workspaceRoot = path.resolve(__dirname, '../..');
const fixturesDir = path.join(workspaceRoot, 'rust/fixtures/envelopes');

function findRustBinary(): string {
  const releaseBin = path.join(workspaceRoot, 'rust/target/release/sajimora.exe');
  if (fs.existsSync(releaseBin)) return releaseBin;
  const debugBin = path.join(workspaceRoot, 'rust/target/debug/sajimora.exe');
  if (fs.existsSync(debugBin)) return debugBin;
  throw new Error('Rust sajimora binary not found in release or debug target directories.');
}

interface ParityCase {
  name: string;
  base: string;
  candidate: string;
  targets: string[];
}

const cases: ParityCase[] = [
  {
    name: 'Identical backend (candidate preserves contract)',
    base: path.join(fixturesDir, 'backend_complete.json'),
    candidate: path.join(fixturesDir, 'backend_same.json'),
    targets: [path.join(fixturesDir, 'frontend_complete.json')],
  },
  {
    name: 'Breaking change (removed endpoint -> LIKELY_VIOLATED)',
    base: path.join(fixturesDir, 'backend_complete.json'),
    candidate: path.join(fixturesDir, 'backend_candidate.json'),
    targets: [path.join(fixturesDir, 'frontend_complete.json')],
  },
  {
    name: 'Incomplete candidate (upgrades to INCONCLUSIVE)',
    base: path.join(fixturesDir, 'backend_complete.json'),
    candidate: path.join(fixturesDir, 'backend_incomplete.json'),
    targets: [path.join(fixturesDir, 'frontend_complete.json')],
  },
];

function runParity(): void {
  const rustBin = findRustBinary();
  console.log(`Running parity suite between TypeScript reference and Rust native checker...`);
  console.log(`Rust binary: ${rustBin}\n`);

  let allPassed = true;

  for (const c of cases) {
    console.log(`Test case: ${c.name}`);

    // 1. Run Rust CLI
    const rustArgs = [
      'check-contract',
      '--base', c.base,
      '--candidate', c.candidate,
      ...c.targets.flatMap(t => ['--target', t]),
      '--trusted-local',
    ];
    let rustStdout = '';
    try {
      rustStdout = execFileSync(rustBin, rustArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      console.error(`  Rust execution failed: ${e.message}`);
      allPassed = false;
      continue;
    }

    const rustReport = JSON.parse(rustStdout);

    // 2. Run TypeScript reference
    const tsRunner = path.join(workspaceRoot, 'scripts/test-runtime/run-tsx-command.cjs');
    const tsScript = path.join(workspaceRoot, 'scripts/sajimora/checkContract.ts');
    const tsArgs = [
      tsRunner,
      tsScript,
      '--base', c.base,
      '--candidate', c.candidate,
      ...c.targets.flatMap(t => ['--target', t]),
      '--trusted-local',
    ];

    let tsStdout = '';
    try {
      tsStdout = execFileSync(process.execPath, tsArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      console.error(`  TypeScript reference execution failed: ${e.message}`);
      allPassed = false;
      continue;
    }

    const tsReport = JSON.parse(tsStdout);

    // 3. Compare reports
    const verdictMatch = rustReport.verdict === tsReport.verdict;
    const propertyMatch = rustReport.property === tsReport.property;
    const schemaMatch = rustReport.schemaVersion === tsReport.schemaVersion;
    const findingsMatch = (rustReport.findings?.length ?? 0) === (tsReport.findings?.length ?? 0);

    console.log(`  Verdict:    Rust=${rustReport.verdict} | TS=${tsReport.verdict} [${verdictMatch ? 'MATCH' : 'MISMATCH'}]`);
    console.log(`  Property:   Rust=${rustReport.property} | TS=${tsReport.property} [${propertyMatch ? 'MATCH' : 'MISMATCH'}]`);
    console.log(`  Findings:   Rust=${rustReport.findings?.length ?? 0} | TS=${tsReport.findings?.length ?? 0} [${findingsMatch ? 'MATCH' : 'MISMATCH'}]`);

    if (!verdictMatch || !propertyMatch || !schemaMatch || !findingsMatch) {
      console.error(`  FAIL: Parity mismatch in test case '${c.name}'`);
      allPassed = false;
    } else {
      console.log(`  PASS\n`);
    }
  }

  if (allPassed) {
    console.log('✓ All parity cases verified successfully!');
    process.exit(0);
  } else {
    console.error('✗ Parity verification failed!');
    process.exit(1);
  }
}

runParity();
