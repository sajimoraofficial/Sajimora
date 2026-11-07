/**
 * smoke-test.cjs — Gate R5: Standalone installation smoke test.
 *
 * Verifies that the native Rust release binaries (sajimora.exe, sajimora-mcp.exe):
 *  1. Execute cleanly with PATH="" (zero Node.js or external tool dependencies)
 *  2. Display accurate version and help text
 *  3. Perform artifact checks on real envelopes with atomic output file replacement
 *  4. Output strictly valid JSON conforming to SAJIMORA_CONTRACT_REPORT_V1
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const workspaceRoot = path.resolve(__dirname, '../..');
const releaseDir = path.join(workspaceRoot, 'rust/target/release');
const sajimoraBin = path.join(releaseDir, 'sajimora.exe');
const sajimoraMcpBin = path.join(releaseDir, 'sajimora-mcp.exe');
const fixturesDir = path.join(workspaceRoot, 'rust/fixtures/envelopes');

function runCleanEnv(bin, args) {
  // Execute with minimal environment — PATH is empty so Node cannot be reached
  const env = {
    SYSTEMROOT: process.env.SYSTEMROOT || 'C:\\Windows',
    WINDIR: process.env.WINDIR || 'C:\\Windows',
    PATH: '', // Purposely empty to guarantee Node is absent
  };
  return execFileSync(bin, args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

console.log('=== Sajimora Gate R5 Installation Smoke Test ===\n');

// 1. Verify binaries exist
console.log('1. Checking release binary existence...');
if (!fs.existsSync(sajimoraBin)) throw new Error(`Missing ${sajimoraBin}`);
if (!fs.existsSync(sajimoraMcpBin)) throw new Error(`Missing ${sajimoraMcpBin}`);
const cliSize = fs.statSync(sajimoraBin).size;
const mcpSize = fs.statSync(sajimoraMcpBin).size;
console.log(`   sajimora.exe:     ${(cliSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`   sajimora-mcp.exe: ${(mcpSize / 1024 / 1024).toFixed(2)} MB`);

// 2. Test Node-absent execution for --version and --help
console.log('\n2. Testing execution without Node on PATH (PATH="")...');
const cliVersion = runCleanEnv(sajimoraBin, ['--version']);
console.log(`   sajimora --version: ${cliVersion.trim()}`);
if (!cliVersion.includes('sajimora')) throw new Error('Invalid CLI version output');

const cliHelp = runCleanEnv(sajimoraBin, ['--help']);
if (!cliHelp.includes('Usage:')) throw new Error('Invalid CLI help output');
console.log('   sajimora --help: OK');

const mcpVersion = runCleanEnv(sajimoraMcpBin, ['--version']);
console.log(`   sajimora-mcp --version: ${mcpVersion.trim()}`);
if (!mcpVersion.includes('sajimora-mcp')) throw new Error('Invalid MCP version output');

const mcpHelp = runCleanEnv(sajimoraMcpBin, ['--help']);
if (!mcpHelp.includes('Usage:')) throw new Error('Invalid MCP help output');
console.log('   sajimora-mcp --help: OK');

// 3. Test check-contract execution with Node absent
console.log('\n3. Testing check-contract execution with Node absent...');
const baseFile = path.join(fixturesDir, 'backend_complete.json');
const sameFile = path.join(fixturesDir, 'backend_same.json');
const feFile = path.join(fixturesDir, 'frontend_complete.json');

const stdout = runCleanEnv(sajimoraBin, [
  'check-contract',
  '--base', baseFile,
  '--candidate', sameFile,
  '--target', feFile,
  '--trusted-local',
]);

const report = JSON.parse(stdout);
console.log(`   Verdict: ${report.verdict}`);
console.log(`   Property: ${report.property}`);
if (report.verdict !== 'LIKELY_PRESERVED') {
  throw new Error(`Unexpected verdict: ${report.verdict}`);
}
console.log('   Direct stdout check: OK');

// 4. Test atomic output file writing in temp folder
console.log('\n4. Testing atomic --out writing and replacement in temp directory...');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-smoke-'));
const outFile = path.join(tempDir, 'report.json');

try {
  // First write
  runCleanEnv(sajimoraBin, [
    'check-contract',
    '--base', baseFile,
    '--candidate', sameFile,
    '--target', feFile,
    '--trusted-local',
    '--out', outFile,
  ]);
  if (!fs.existsSync(outFile)) throw new Error('Output file was not created');
  const fileReport1 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (fileReport1.verdict !== 'LIKELY_PRESERVED') throw new Error('Invalid report in out file');

  // Second write (tests Windows atomic replacement over existing file)
  const candFile = path.join(fixturesDir, 'backend_candidate.json');
  runCleanEnv(sajimoraBin, [
    'check-contract',
    '--base', baseFile,
    '--candidate', candFile,
    '--target', feFile,
    '--trusted-local',
    '--out', outFile,
  ]);
  const fileReport2 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (fileReport2.verdict !== 'LIKELY_VIOLATED') throw new Error('Atomic replacement did not update report');
  console.log('   Atomic file write & replacement: OK');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('\n✓ Gate R5 installation smoke test PASSED successfully!');
