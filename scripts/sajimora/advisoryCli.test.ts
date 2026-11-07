import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArguments } from './arguments';
import { executeCli } from './cli';
import {
  sealEnvelope,
  ARTIFACT_ENVELOPE_VERSION,
  SCHEMA_VERSION,
  FrontendContractPayload
} from '@sajimora/analysis';

const workspace = path.resolve(process.cwd());

function safeCleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
}

async function testArgumentsDefault() {
  const parsed = parseArguments(['--repo', workspace, '--parent', 'HEAD~1', '--candidate', 'HEAD']);
  assert.equal(parsed.engine, 'advisory', 'Default engine must be advisory');
  assert.equal(parsed.language, 'auto', 'Default language must be auto');
  assert.equal(parsed.format, 'json', 'Default format must be json');

  const withProd = parseArguments(['--repo', workspace, '--parent', 'HEAD~1', '--candidate', 'HEAD', '--engine', 'production']);
  assert.equal(withProd.engine, 'production', '--engine production must be respected');

  const withJava = parseArguments(['--repo', workspace, '--parent', 'HEAD~1', '--candidate', 'HEAD', '--language', 'java']);
  assert.equal(withJava.language, 'java', '--language java must be respected');

  const withFail = parseArguments(['--repo', workspace, '--fail-on-violation']);
  assert.equal(withFail.failOnViolation, true, '--fail-on-violation must be true');

  const withStrict = parseArguments(['--repo', workspace, '--strict']);
  assert.equal(withStrict.strict, true, '--strict must set strict: true');
  assert.equal(withStrict.failOnViolation, true, '--strict must set failOnViolation: true');

  const withTrust = parseArguments(['--repo', workspace, '--trust-policy', 'trust.json']);
  assert.equal(withTrust.trustPolicy, path.resolve('trust.json'), '--trust-policy must resolve file path');
}

async function testTypeScriptAdvisoryCli() {
  const repository = mkdtempSync(path.join(workspace, '.ts-advisory-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    // Parent revision: export getUser returning User
    writeFileSync(
      path.join(repository, 'api.ts'),
      'export interface User { id: string; name: string; }\nexport function getUser(id: string): User { return { id, name: "Alice" }; }\n'
    );
    writeFileSync(
      path.join(repository, 'consumer.ts'),
      'import { getUser, User } from "./api";\nexport const u: User = getUser("1");\n'
    );
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');

    // Candidate revision: breaking change - getUser returns User | undefined
    writeFileSync(
      path.join(repository, 'api.ts'),
      'export interface User { id: string; name: string; }\nexport function getUser(id: string): User | undefined { return undefined; }\n'
    );
    git('add', '.');
    git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');

    // 1. Run default CLI (Advisory engine)
    let output = '';
    const exitCode = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0, 'CLI must exit with code 0 by default');

    // 1b. Run with --fail-on-violation -> must exit with code 1
    const failExitCode = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate, '--fail-on-violation'],
      { stdout: () => undefined, stderr: () => undefined }
    );
    assert.equal(failExitCode, 1, 'CLI with --fail-on-violation must exit with code 1 on LIKELY_VIOLATED');

    // 1c. Run with --strict -> must exit with code 1 on LIKELY_VIOLATED
    const strictExitCode = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate, '--strict'],
      { stdout: () => undefined, stderr: () => undefined }
    );
    assert.equal(strictExitCode, 1, 'CLI with --strict must exit with code 1 on LIKELY_VIOLATED');

    const result = JSON.parse(output);
    assert.equal(result.schemaVersion, 'ADVISORY_TS_IMPACT_V1');
    assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
    assert.equal(result.verdict, 'LIKELY_VIOLATED', 'Breaking return type change must be LIKELY_VIOLATED');
    assert.ok(result.consumers.length > 0, 'Must detect downstream consumer');
    assert.ok(result.impacts.some((i: any) => i.classification === 'NEWLY_FAILING'), 'Must classify consumer as NEWLY_FAILING');

    // 2. Run with --format text
    let textOutput = '';
    const textExit = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate, '--format', 'text'],
      { stdout: text => { textOutput += text; }, stderr: () => undefined }
    );
    assert.equal(textExit, 0);
    assert.ok(textOutput.includes('SAJIMORA TYPESCRIPT ADVISORY IMPACT REPORT'));
    assert.ok(textOutput.includes('Advisory Verdict:      LIKELY_VIOLATED'));

  } finally {
    safeCleanup(repository);
  }

  // Test compatible preservation in a clean repo
  const repoPreserved = mkdtempSync(path.join(workspace, '.ts-advisory-pres-'));
  const gitP = (...args: string[]) => execFileSync('git', args, { cwd: repoPreserved, encoding: 'utf8' }).trim();
  try {
    gitP('init', '-q');
    gitP('config', 'user.email', 'test@example.com');
    gitP('config', 'user.name', 'Tester');

    writeFileSync(
      path.join(repoPreserved, 'api.ts'),
      'export interface User { id: string; name: string; }\nexport function getUser(id: string): User { return { id, name: "Alice" }; }\n'
    );
    writeFileSync(
      path.join(repoPreserved, 'consumer.ts'),
      'import { getUser, User } from "./api";\nexport const u: User = getUser("1");\n'
    );
    gitP('add', '.');
    gitP('commit', '-qm', 'parent');
    const p1 = gitP('rev-parse', 'HEAD');

    // Candidate: widen parameter id to string | number (compatible)
    writeFileSync(
      path.join(repoPreserved, 'api.ts'),
      'export interface User { id: string; name: string; }\nexport function getUser(id: string | number): User { return { id: String(id), name: "Alice" }; }\n'
    );
    gitP('add', '.');
    gitP('commit', '-qm', 'candidate');
    const c1 = gitP('rev-parse', 'HEAD');

    let output = '';
    const code = await executeCli(
      ['--repo', repoPreserved, '--parent', p1, '--candidate', c1],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(code, 0);
    const compatResult = JSON.parse(output);
    assert.equal(compatResult.verdict, 'LIKELY_PRESERVED', 'Additive widening change must be LIKELY_PRESERVED');
  } finally {
    safeCleanup(repoPreserved);
  }
}

async function testJavaAdvisoryCli() {
  const repository = mkdtempSync(path.join(workspace, '.java-advisory-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(
      path.join(repository, 'Service.java'),
      'package com.example;\npublic class Service {\n  public String greet(String name) { return "Hello " + name; }\n}\n'
    );
    writeFileSync(
      path.join(repository, 'Consumer.java'),
      'package com.example;\npublic class Consumer extends Service {\n  public void run() {\n    System.out.println("run");\n  }\n}\n'
    );
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');

    // Candidate: remove greet method
    writeFileSync(
      path.join(repository, 'Service.java'),
      'package com.example;\npublic class Service {\n  public String hello() { return "Hello"; }\n}\n'
    );
    git('add', '.');
    git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');

    let output = '';
    const exitCode = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate, '--language', 'java'],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.schemaVersion, 'ADVISORY_JAVA_IMPACT_V1');
    assert.equal(result.certificationStatus, 'ADVISORY_ONLY');
    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.ok(result.providers.some((p: any) => p.change === 'METHOD_REMOVED'));
  } finally {
    safeCleanup(repository);
  }
}

async function testProductionEngineCertification() {
  const repository = mkdtempSync(path.join(workspace, '.f0-prod-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(path.join(repository, 'gate.ts'), 'export function gate(x: boolean, y: boolean): boolean { return x && y; }\n');
    writeFileSync(path.join(repository, 'use.ts'), "import { gate } from './gate';\nexport const answer = gate(true, false);\n");
    git('add', '.'); git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');

    writeFileSync(path.join(repository, 'gate.ts'), 'export function gate(x: boolean, y: boolean): boolean { return y && x; }\n');
    git('add', '.'); git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');

    let output = '';
    const exitCode = await executeCli(
      ['--repo', repository, '--parent', parent, '--candidate', candidate, '--engine', 'production', '--language', 'typescript'],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.productionCertification.status, 'CERTIFIED_PRESERVED');
    assert.equal(result.productionCertification.verdict, 'PRESERVED');
  } finally {
    safeCleanup(repository);
  }
}

async function testZeroArgInvocation() {
  const repository = mkdtempSync(path.join(workspace, '.zero-arg-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(path.join(repository, 'index.ts'), 'export const version = "1.0.0";\n');
    git('add', '.'); git('commit', '-qm', 'initial');

    writeFileSync(path.join(repository, 'index.ts'), 'export const version = "2.0.0";\n');
    git('add', '.'); git('commit', '-qm', 'update');

    // Test: user runs "sajimora analyze" (passing 'analyze' as argv[0], and no --parent or --candidate)
    let output = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0, 'Zero-arg analyze command must succeed with exit code 0');
    const result = JSON.parse(output);
    assert.ok(result.verdict, 'Must produce a verdict');
  } finally {
    safeCleanup(repository);
  }
}

async function testFrontendJsonDownstreamImpact() {
  const repository = mkdtempSync(path.join(workspace, '.frontend-json-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    // Parent revision: User with string id
    writeFileSync(
      path.join(repository, 'User.java'),
      'package com.example;\npublic class User {\n  public String id;\n  public String name;\n}\n'
    );
    writeFileSync(
      path.join(repository, 'UserController.java'),
      'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class UserController {\n  @GetMapping("/api/users/{id}")\n  public User getUser(@PathVariable("id") String id) {\n    return new User();\n  }\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'parent');

    // Candidate revision: User with Long id (breaking wire type change for frontend expecting string)
    writeFileSync(
      path.join(repository, 'User.java'),
      'package com.example;\npublic class User {\n  public Long id;\n  public String name;\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'candidate');

    // Create and properly seal frontend.json contract file in repository root
    const frontendPayload = {
      clientContracts: [
        {
          httpMethod: 'GET',
          normalizedRoute: '/api/users/{id}',
          requestBody: null,
          expectedResponse: {
            kind: 'OBJECT',
            properties: [
              { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }
            ]
          },
          decoderKind: 'INFERRED_TYPE',
          sourceFile: 'src/api/users.ts',
          sourceLine: 42,
          consumers: [{ file: 'src/api/users.ts', line: 42, usage: 'fetchUser' }],
          unresolvedEvidence: []
        }
      ]
    };
    const sealedEnvelope = sealEnvelope({
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: {
        repositoryId: 'web-portal',
        serviceId: 'ui',
        apiVersion: 'v1',
        parentCommit: 'base',
        candidateSnapshot: 'candidate'
      },
      profile: {
        toolVersion: '0.1.0',
        clientProfile: 'MULTI_CLIENT_V1',
        configFingerprint: null
      },
      completeness: { complete: true, unresolvedEndpoints: [], blockers: [] },
      payload: frontendPayload as unknown as FrontendContractPayload
    });
    writeFileSync(path.join(repository, 'frontend.json'), JSON.stringify(sealedEnvelope, null, 2));

    // Run simple command: sajimora analyze (auto-discovers frontend.json and defaults to candidate=HEAD, parent=HEAD~1)
    let output = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository],
      { stdout: text => { output += text; }, stderr: text => console.error('STDERR:', text) }
    );
    assert.equal(exitCode, 0, 'CLI must exit with code 0');
    const result = JSON.parse(output);
    assert.equal(result.verdict, 'LIKELY_VIOLATED', 'Wire type change on endpoint must be LIKELY_VIOLATED against frontend.json');
    assert.ok(result.frontendFindings.length > 0, 'Must report frontend breaking findings');
    assert.equal(result.frontendFindings[0].typescriptClient.file, 'src/api/users.ts');
    assert.equal(result.frontendFindings[0].typescriptClient.line, 42);

    // Also verify text format output includes frontend impacts
    let textOutput = '';
    const textExit = await executeCli(
      ['analyze', '--repo', repository, '--format', 'text'],
      { stdout: text => { textOutput += text; }, stderr: () => undefined }
    );
    assert.equal(textExit, 0);
    assert.ok(textOutput.includes('SAJIMORA JAVA ADVISORY IMPACT REPORT'));
    assert.ok(textOutput.includes('Downstream Frontend Impacts (from frontend contract)'));
    assert.ok(textOutput.includes('src/api/users.ts:42'));
    assert.ok(textOutput.includes('LIKELY_VIOLATED'));
  } finally {
    safeCleanup(repository);
  }
}

async function testOmittedFrontendNeverYieldsCrossLanguagePreserved() {
  const repository = mkdtempSync(path.join(workspace, '.omitted-fe-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(
      path.join(repository, 'User.java'),
      'package com.example;\npublic class User { public String id; }\n'
    );
    git('add', '.'); git('commit', '-qm', 'parent');

    writeFileSync(
      path.join(repository, 'User.java'),
      'package com.example;\npublic class User { public String id; public String extra; }\n'
    );
    git('add', '.'); git('commit', '-qm', 'candidate');

    // Run without --frontend (no frontend.json present)
    let output = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.frontendContract, undefined, 'Must not claim frontend contract was evaluated');
    assert.equal(result.frontendFindings, undefined, 'Must not report frontend findings');
    assert.ok(result.verdict, 'Must report an in-repo verdict');
  } finally {
    safeCleanup(repository);
  }
}

async function testUnsealedEnvelopeRejection() {
  const repository = mkdtempSync(path.join(workspace, '.unsealed-fe-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(path.join(repository, 'A.java'), 'package com.example; public class A {}\n');
    git('add', '.'); git('commit', '-qm', 'parent');
    writeFileSync(path.join(repository, 'A.java'), 'package com.example; public class A { int x; }\n');
    git('add', '.'); git('commit', '-qm', 'candidate');

    // Write unsealed, raw JSON without envelope or integrity
    writeFileSync(path.join(repository, 'frontend.json'), '{"random": "unsealed data"}');

    let errorOutput = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository, '--frontend', path.join(repository, 'frontend.json')],
      { stdout: () => undefined, stderr: text => { errorOutput += text; } }
    );
    assert.equal(exitCode, 2, 'Unsealed or invalid envelope must exit with code 2 (ANALYSIS_INPUT_FAILURE)');
    assert.ok(errorOutput.includes('ANALYSIS_INPUT_FAILURE'));
  } finally {
    safeCleanup(repository);
  }
}

async function testUnlinkedChangedEndpointFailsClosed() {
  const repository = mkdtempSync(path.join(workspace, '.unlinked-ep-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    // Controller with /api/orders
    writeFileSync(
      path.join(repository, 'OrderController.java'),
      'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class OrderController {\n  @GetMapping("/api/orders/{id}")\n  public String getOrder(@PathVariable("id") String id) {\n    return "order";\n  }\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'parent');

    // Candidate changes endpoint to return int
    writeFileSync(
      path.join(repository, 'OrderController.java'),
      'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class OrderController {\n  @GetMapping("/api/orders/{id}")\n  public int getOrder(@PathVariable("id") String id) {\n    return 42;\n  }\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'candidate');

    // Frontend contract ONLY covers /api/users, zero coverage of changed /api/orders
    const frontendPayload = {
      clientContracts: [
        {
          httpMethod: 'GET',
          normalizedRoute: '/api/users/{id}',
          requestBody: null,
          expectedResponse: { kind: 'PRIMITIVE', scalar: 'string' },
          decoderKind: 'INFERRED_TYPE',
          sourceFile: 'src/api/users.ts',
          sourceLine: 10,
          consumers: [{ file: 'src/api/users.ts', line: 10, usage: 'fetchUser' }],
          unresolvedEvidence: []
        }
      ]
    };
    const sealed = sealEnvelope({
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: { repositoryId: 'web', serviceId: 'api', apiVersion: 'v1', parentCommit: 'base', candidateSnapshot: 'candidate' },
      profile: { toolVersion: '0.1.0', clientProfile: 'MULTI_CLIENT_V1', configFingerprint: null },
      completeness: { complete: true, unresolvedEndpoints: [], blockers: [] },
      payload: frontendPayload as unknown as FrontendContractPayload
    });
    writeFileSync(path.join(repository, 'frontend.json'), JSON.stringify(sealed, null, 2));

    let output = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.verdict, 'INCONCLUSIVE', 'Changed backend endpoint with 0 frontend coverage must fail closed to INCONCLUSIVE');
  } finally {
    safeCleanup(repository);
  }
}

async function testSajimoraConfigFileResolution() {
  const repository = mkdtempSync(path.join(workspace, '.cfg-resolution-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Tester');

    writeFileSync(
      path.join(repository, 'UserController.java'),
      'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class UserController {\n  @GetMapping("/api/users/{id}")\n  public String getUser(@PathVariable("id") String id) {\n    return "user";\n  }\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'parent');
    writeFileSync(
      path.join(repository, 'UserController.java'),
      'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class UserController {\n  @GetMapping("/api/users/{id}")\n  public int getUser(@PathVariable("id") String id) {\n    return 1;\n  }\n}\n'
    );
    git('add', '.'); git('commit', '-qm', 'candidate');

    // Create custom contract directory contracts/custom-client.json
    mkdirSync(path.join(repository, 'contracts'), { recursive: true });
    const sealed = sealEnvelope({
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: { repositoryId: 'web', serviceId: 'api', apiVersion: 'v1', parentCommit: 'base', candidateSnapshot: 'candidate' },
      profile: { toolVersion: '0.1.0', clientProfile: 'MULTI_CLIENT_V1', configFingerprint: null },
      completeness: { complete: true, unresolvedEndpoints: [], blockers: [] },
      payload: {
        clientContracts: [
          {
            httpMethod: 'GET',
            normalizedRoute: '/api/users/{id}',
            requestBody: null,
            expectedResponse: { kind: 'PRIMITIVE', scalar: 'string' },
            decoderKind: 'INFERRED_TYPE',
            sourceFile: 'src/api/users.ts',
            sourceLine: 10,
            consumers: [{ file: 'src/api/users.ts', line: 10, usage: 'fetchUser' }],
            unresolvedEvidence: []
          }
        ]
      } as unknown as FrontendContractPayload
    });
    writeFileSync(path.join(repository, 'contracts', 'custom-client.json'), JSON.stringify(sealed, null, 2));

    // Write sajimora.config.json pointing to contracts/custom-client.json
    writeFileSync(
      path.join(repository, 'sajimora.config.json'),
      JSON.stringify({ version: '1', contracts: { frontend: 'contracts/custom-client.json' } }, null, 2)
    );

    let output = '';
    const exitCode = await executeCli(
      ['analyze', '--repo', repository],
      { stdout: text => { output += text; }, stderr: () => undefined }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.verdict, 'LIKELY_VIOLATED', 'Breaking change must be detected via contract configured in sajimora.config.json');
    assert.ok(result.frontendContract.endsWith('contracts\\custom-client.json') || result.frontendContract.endsWith('contracts/custom-client.json'));
  } finally {
    safeCleanup(repository);
  }
}

async function testInitHookGitAndHusky() {
  const repository = mkdtempSync(path.join(tmpdir(), 'sajimora-hook-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repository });

    // 1. Git hooks fallback
    let out = '';
    let code = await executeCli(['init-hook', '--repo', repository], { stdout: t => { out += t; }, stderr: () => undefined });
    assert.equal(code, 0);
    const gitHook = path.join(repository, '.git', 'hooks', 'pre-push');
    assert.ok(existsSync(gitHook), 'Git pre-push hook must be created');
    const content = readFileSync(gitHook, 'utf8');
    assert.ok(content.includes('./node_modules/.bin/sajimora analyze'), 'Hook must use local node_modules binary');
    assert.ok(content.includes('In-Repo Breaking Change Interception'), 'Hook must claim In-Repo scope');

    // 2. Husky directory detection
    const huskyDir = path.join(repository, '.husky');
    mkdirSync(huskyDir, { recursive: true });
    out = '';
    code = await executeCli(['init-hook', '--repo', repository], { stdout: t => { out += t; }, stderr: () => undefined });
    assert.equal(code, 0);
    const huskyHook = path.join(huskyDir, 'pre-push');
    assert.ok(existsSync(huskyHook), 'Husky pre-push hook must be created');
    const huskyContent = readFileSync(huskyHook, 'utf8');
    assert.ok(huskyContent.includes('./node_modules/.bin/sajimora analyze'));

    // 3. Idempotent install
    out = '';
    code = await executeCli(['init-hook', '--repo', repository], { stdout: t => { out += t; }, stderr: () => undefined });
    assert.equal(code, 0);
    assert.ok(out.includes('already installed'));
  } finally {
    safeCleanup(repository);
  }
}

async function testKeygenCommand() {
  let stdout = '';
  const code = await executeCli(['keygen'], { stdout: t => { stdout += t; }, stderr: () => undefined });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  assert.ok(parsed.privateKeyPem.includes('BEGIN PRIVATE KEY'));
  assert.equal(parsed.trustPolicy.requireSignatures, true);
  assert.equal(parsed.trustPolicy.producers.length, 1);
  assert.equal(parsed.trustPolicy.producers[0].publicKeyPem, parsed.publicKeyPem);

  const tempDir = mkdtempSync(path.join(tmpdir(), 'sajimora-keygen-test-'));
  try {
    let out = '';
    const code2 = await executeCli(['keygen', '--out-dir', tempDir, '--repo-id', 'my-org/my-repo', '--service-id', 'my-api'], { stdout: t => { out += t; }, stderr: () => undefined });
    assert.equal(code2, 0);
    assert.ok(existsSync(path.join(tempDir, 'sajimora-private.pem')));
    assert.ok(existsSync(path.join(tempDir, 'sajimora-public.pem')));
    assert.ok(existsSync(path.join(tempDir, 'trust-policy.json')));
    const policy = JSON.parse(readFileSync(path.join(tempDir, 'trust-policy.json'), 'utf8'));
    assert.equal(policy.producers[0].repositoryId, 'my-org/my-repo');
    assert.equal(policy.producers[0].serviceId, 'my-api');
  } finally {
    safeCleanup(tempDir);
  }
}

async function testHelpCommand() {
  let stdout = '';
  const code = await executeCli(['--help'], { stdout: t => { stdout += t; }, stderr: () => undefined });
  assert.equal(code, 0);
  assert.ok(stdout.includes('sajimora'));
  assert.ok(stdout.includes('--fail-on-violation'));
  assert.ok(stdout.includes('--trust-policy'));
  assert.ok(stdout.includes('keygen'));
}

async function testWritePathArtifactSizeGuard() {
  const { writeArtifactAtomically } = await import('./artifact');
  const tempDir = mkdtempSync(path.join(workspace, '.size-guard-test-'));
  try {
    const oversized = 'x'.repeat(21 * 1024 * 1024); // 21 MiB
    assert.throws(
      () => writeArtifactAtomically(path.join(tempDir, 'oversized.json'), oversized),
      /exceeds maximum allowed write size of 20 MiB/
    );
  } finally {
    safeCleanup(tempDir);
  }
}

async function run() {
  console.log('Testing arguments default...');
  await testArgumentsDefault();
  console.log('Testing help command...');
  await testHelpCommand();
  console.log('Testing write-path artifact size guard (Blocker C2)...');
  await testWritePathArtifactSizeGuard();
  console.log('Testing keygen command...');
  await testKeygenCommand();
  console.log('Testing TypeScript advisory CLI execution...');
  await testTypeScriptAdvisoryCli();
  console.log('Testing Java advisory CLI execution...');
  await testJavaAdvisoryCli();
  console.log('Testing zero-argument / single-command analyze invocation...');
  await testZeroArgInvocation();
  console.log('Testing frontend.json auto-discovery and downstream consumer impact check...');
  await testFrontendJsonDownstreamImpact();
  console.log('Testing omitted frontend behavior...');
  await testOmittedFrontendNeverYieldsCrossLanguagePreserved();
  console.log('Testing unsealed envelope rejection...');
  await testUnsealedEnvelopeRejection();
  console.log('Testing unlinked changed endpoint fail-closed behavior...');
  await testUnlinkedChangedEndpointFailsClosed();
  console.log('Testing sajimora.config.json resolution...');
  await testSajimoraConfigFileResolution();
  console.log('Testing init-hook Git and Husky support...');
  await testInitHookGitAndHusky();
  console.log('Testing F0 production certification retention with --engine production...');
  await testProductionEngineCertification();
  console.log('All Advisory CLI and Certification retention tests passed successfully!');
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

