import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProductionAnalyzeCommand } from './productionCommand';

const workspace = path.resolve(process.cwd());
const repository = mkdtempSync(path.join(workspace, '.finite-boolean-cli-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const source = (body: string) =>
  `export function gate(x: boolean, y: boolean): boolean { return ${body}; }\n`;
async function run(): Promise<void> {
  try {
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(path.join(repository, 'gate.ts'), source('x && y'));
    writeFileSync(path.join(repository, 'use.ts'),
      "import { gate } from './gate';\nexport const answer = gate(true, false);\n");
    git('add', '.'); git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repository, 'gate.ts'), source('y && x'));
    git('add', '.'); git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');
    let output = '';
    await runProductionAnalyzeCommand({ repo: repository, parent, candidate,
      language: 'typescript', engine: 'production' },
    { stdout: text => { output += text; }, stderr: () => undefined });
    const artifact = JSON.parse(output);
    assert.equal(artifact.productionCertification.status, 'CERTIFIED_PRESERVED');
    assert.equal(artifact.productionCertification.verdict, 'PRESERVED');
    assert.equal(artifact.productionCertification.scope.inputDomain, 'ALL_BOOLEAN_TUPLES_ONLY');
    assert.equal(artifact.productionCertification.scope.coverageProfileId, 'TS_BOOLEAN_IMPORT_AND_CALL_COVERAGE_V1');
    assert.equal(artifact.productionCertification.testDeferral.authorized, false);
    // Assert 100% byte-identical reproducibility across independent runs
    let rerunOutput = '';
    await runProductionAnalyzeCommand({ repo: repository, parent, candidate,
      language: 'typescript', engine: 'production' },
    { stdout: text => { rerunOutput += text; }, stderr: () => undefined });
    assert.equal(output, rerunOutput, 'Production artifact must be 100% byte-identical across runs');
    writeFileSync(path.join(repository, 'gate.ts'), source('x || y'));
    git('add', '.'); git('commit', '-qm', 'violation');
    const violation = git('rev-parse', 'HEAD');
    output = '';
    await runProductionAnalyzeCommand({ repo: repository, parent: candidate, candidate: violation,
      language: 'typescript', engine: 'production' },
    { stdout: text => { output += text; }, stderr: () => undefined });
    const broken = JSON.parse(output);
    assert.equal(broken.productionCertification.status, 'CERTIFIED_VIOLATED');
    assert.equal(broken.productionCertification.verdict, 'VIOLATED');
    assert.equal(broken.productionCertification.testDeferral.authorized, false);
    console.log('Production CLI finite Boolean preservation and violation PASSED.');
  } finally {
    const resolved = path.resolve(repository);
    if (!resolved.startsWith(workspace + path.sep)) throw new Error('Unsafe fixture cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
