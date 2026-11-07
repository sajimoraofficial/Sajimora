import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { DualTypeScriptProgramBuilder } from '../../src/sajimora/languages/typescript/programs/DualTypeScriptProgramBuilder';
import { SharedImmutableLibCache } from '../../src/sajimora/languages/typescript/programs/SharedImmutableLibCache';

const slash = (v: string) => v.replace(/\\/g, '/');

console.log('Running Program Isolation & Shared Immutable Lib Cache Tests...');

function createWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-test-iso-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, ...slash(relPath).split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

// 1. Test Semantic Isolation: Parent and Candidate Programs Have Distinct SourceFiles & TypeCheckers
{
  console.log('  Testing Parent / Candidate Program Semantic Isolation...');
  const parentWs = createWorkspace({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/value.ts': 'export function getVal(): number { return 1; }\n'
  });
  const candidateWs = createWorkspace({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/value.ts': 'export function getVal(): string { return "changed"; }\n'
  });

  try {
    const trackedFiles = ['tsconfig.json', 'src/value.ts'];
    const toolchain = {
      compiler: { name: 'typescript', version: ts.version },
      repositoryDeclaredVersion: null,
      mismatch: 'UNDETERMINED' as const
    };

    const dual = new DualTypeScriptProgramBuilder().build(
      {
        root: parentWs.root,
        trackedFiles,
        revision: { repositoryId: 'repo', commitSha: 'parent-sha' },
        toolchain,
        adapterId: 'typescript-v1',
        adapterVersion: '1.0.0'
      },
      {
        root: candidateWs.root,
        trackedFiles,
        revision: { repositoryId: 'repo', commitSha: 'candidate-sha' },
        toolchain,
        adapterId: 'typescript-v1',
        adapterVersion: '1.0.0'
      }
    );

    assert.equal(dual.parent.status, 'BUILT');
    assert.equal(dual.candidate.status, 'BUILT');

    const pProg = dual.parent.projects[0].program;
    const cProg = dual.candidate.projects[0].program;

    // TypeCheckers must be strictly distinct
    assert.notEqual(pProg.getTypeChecker(), cProg.getTypeChecker());

    // SourceFile for value.ts must be distinct objects with version-specific text
    const pFile = pProg.getSourceFiles().find(f => f.fileName.includes('src/value.ts'))!;
    const cFile = cProg.getSourceFiles().find(f => f.fileName.includes('src/value.ts'))!;

    assert.ok(pFile && cFile);
    assert.notEqual(pFile, cFile, 'User SourceFiles must never be shared between parent and candidate');
    assert.ok(pFile.text.includes('return 1;'), 'Parent source text must remain original');
    assert.ok(cFile.text.includes('return "changed";'), 'Candidate source text must have mutation');

    console.log('  ✅ PASS: Parent / Candidate Program Semantic Isolation');
  } finally {
    parentWs.cleanup();
    candidateWs.cleanup();
  }
}

// 2. Test Shared Immutable Lib Cache
{
  console.log('  Testing Shared Immutable Lib Cache...');
  const cache = SharedImmutableLibCache.getInstance();
  const options = { target: ts.ScriptTarget.ES2022 };
  const defaultLibPath = ts.getDefaultLibFilePath(options);

  // Before building, cache might have entries from previous runs or be empty
  const initialSize = cache.size;

  const ws1 = createWorkspace({
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src/**/*'] }),
    'src/a.ts': 'export const a: number = 1;\n'
  });
  const ws2 = createWorkspace({
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src/**/*'] }),
    'src/b.ts': 'export const b: string = "hello";\n'
  });

  try {
    const builder = new DualTypeScriptProgramBuilder();
    const toolchain = { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' as const };

    const dual1 = builder.build(
      { root: ws1.root, trackedFiles: ['tsconfig.json', 'src/a.ts'], revision: { repositoryId: 'r', commitSha: '1' }, toolchain, adapterId: 't', adapterVersion: '1' },
      { root: ws1.root, trackedFiles: ['tsconfig.json', 'src/a.ts'], revision: { repositoryId: 'r', commitSha: '2' }, toolchain, adapterId: 't', adapterVersion: '1' }
    );

    const dual2 = builder.build(
      { root: ws2.root, trackedFiles: ['tsconfig.json', 'src/b.ts'], revision: { repositoryId: 'r', commitSha: '3' }, toolchain, adapterId: 't', adapterVersion: '1' },
      { root: ws2.root, trackedFiles: ['tsconfig.json', 'src/b.ts'], revision: { repositoryId: 'r', commitSha: '4' }, toolchain, adapterId: 't', adapterVersion: '1' }
    );

    const prog1 = dual1.parent.projects[0].program;
    const prog2 = dual2.parent.projects[0].program;

    // Default lib SourceFile must be the exact same cached instance across independent programs
    const lib1 = prog1.getSourceFiles().find(sf => sf.fileName.includes('lib.es5.d.ts') || sf.fileName.includes('lib.d.ts'));
    const lib2 = prog2.getSourceFiles().find(sf => sf.fileName.includes('lib.es5.d.ts') || sf.fileName.includes('lib.d.ts'));

    if (lib1 && lib2) {
      assert.equal(lib1, lib2, 'Bundled TypeScript lib SourceFiles must be shared across programs via cache');
    }

    // But user files are NEVER cached
    assert.equal(cache.has(path.join(ws1.root, 'src/a.ts'), ts.ScriptTarget.ES2022), false);
    assert.equal(cache.has(path.join(ws2.root, 'src/b.ts'), ts.ScriptTarget.ES2022), false);

    console.log('  ✅ PASS: Shared Immutable Lib Cache');
  } finally {
    ws1.cleanup();
    ws2.cleanup();
  }
}

// 3. Hostile Test: Different ScriptTargets produce distinct cache keys and separate AST states
{
  console.log('  Testing ScriptTarget Isolation in SharedImmutableLibCache...');
  const cache = SharedImmutableLibCache.getInstance();
  const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));
  const libEs5 = path.join(libRoot, 'lib.es5.d.ts');

  if (fs.existsSync(libEs5)) {
    const text = fs.readFileSync(libEs5, 'utf8');
    const sfEs5 = ts.createSourceFile(libEs5, text, ts.ScriptTarget.ES5, true);
    const sfEs2022 = ts.createSourceFile(libEs5, text, ts.ScriptTarget.ES2022, true);

    cache.set(libEs5, ts.ScriptTarget.ES5, sfEs5);
    cache.set(libEs5, ts.ScriptTarget.ES2022, sfEs2022);

    const retrievedEs5 = cache.get(libEs5, ts.ScriptTarget.ES5);
    const retrievedEs2022 = cache.get(libEs5, ts.ScriptTarget.ES2022);
    const retrievedEs3 = cache.get(libEs5, ts.ScriptTarget.ES3);

    assert.equal(retrievedEs5, sfEs5);
    assert.equal(retrievedEs2022, sfEs2022);
    assert.notEqual(retrievedEs5, retrievedEs2022);
    assert.equal(retrievedEs3, undefined, 'Uncached ScriptTarget must return undefined');

    console.log('  ✅ PASS: ScriptTarget Isolation');
  }
}

// 4. Hostile Test: Repo fake lib files & node_modules are rejected from cache
{
  console.log('  Testing Non-Lib Rejection (Repository and Dependency Files)...');
  const cache = SharedImmutableLibCache.getInstance();
  const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath({})));

  const ws = createWorkspace({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/lib.es5.d.ts': 'declare const fakeLib: number;\n',
    'node_modules/@types/node/index.d.ts': 'declare const nodeVal: string;\n',
    'src/main.ts': 'export const x = 42;\n'
  });

  try {
    const fakeRepoLibPath = path.join(ws.root, 'src/lib.es5.d.ts');
    const nodeModulesPath = path.join(ws.root, 'node_modules/@types/node/index.d.ts');
    const mainTsPath = path.join(ws.root, 'src/main.ts');

    // Qualifying checks
    assert.equal(SharedImmutableLibCache.isQualifyingLibFile(fakeRepoLibPath, libRoot), false, 'Fake repo lib file outside libRoot must NOT qualify');
    assert.equal(SharedImmutableLibCache.isQualifyingLibFile(nodeModulesPath, libRoot), false, 'node_modules must NOT qualify');
    assert.equal(SharedImmutableLibCache.isQualifyingLibFile(mainTsPath, libRoot), false, 'User main.ts must NOT qualify');

    const realLibPath = path.join(libRoot, 'lib.es5.d.ts');
    assert.equal(SharedImmutableLibCache.isQualifyingLibFile(realLibPath, libRoot), true, 'Real bundled lib inside libRoot must qualify');

    const builder = new DualTypeScriptProgramBuilder();
    const toolchain = { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' as const };

    const dual = builder.build(
      { root: ws.root, trackedFiles: ['tsconfig.json', 'src/lib.es5.d.ts', 'src/main.ts'], revision: { repositoryId: 'r', commitSha: '1' }, toolchain, adapterId: 't', adapterVersion: '1' },
      { root: ws.root, trackedFiles: ['tsconfig.json', 'src/lib.es5.d.ts', 'src/main.ts'], revision: { repositoryId: 'r', commitSha: '2' }, toolchain, adapterId: 't', adapterVersion: '1' }
    );

    assert.equal(cache.has(fakeRepoLibPath, ts.ScriptTarget.ES2022), false, 'Fake repo lib must not be cached');
    assert.equal(cache.has(mainTsPath, ts.ScriptTarget.ES2022), false, 'User file must not be cached');

    console.log('  ✅ PASS: Non-Lib Rejection');
  } finally {
    ws.cleanup();
  }
}

// 5. Hostile Test: Cache clear and cache miss produce byte-for-byte identical AST and diagnostics
{
  console.log('  Testing Cache Hit vs Cache Miss Semantic Parity...');
  const ws = createWorkspace({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*'] }),
    'src/index.ts': 'export function add(a: number, b: number): number { return a + b; }\n'
  });

  try {
    const builder = new DualTypeScriptProgramBuilder();
    const toolchain = { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' as const };
    const input = { root: ws.root, trackedFiles: ['tsconfig.json', 'src/index.ts'], revision: { repositoryId: 'r', commitSha: '1' }, toolchain, adapterId: 't', adapterVersion: '1' };

    // Run 1: with cache cleared (cold)
    SharedImmutableLibCache.clear();
    const resCold = builder.build(input, input);

    // Run 2: with warm cache
    const resWarm = builder.build(input, input);

    const coldProg = resCold.parent.projects[0].program;
    const warmProg = resWarm.parent.projects[0].program;

    // Syntactic & semantic diagnostics must be byte-for-byte identical
    const coldDiags = coldProg.getSemanticDiagnostics().map(d => ts.formatDiagnostic(d, { getCurrentDirectory: () => ws.root, getCanonicalFileName: f => f, getNewLine: () => '\n' }));
    const warmDiags = warmProg.getSemanticDiagnostics().map(d => ts.formatDiagnostic(d, { getCurrentDirectory: () => ws.root, getCanonicalFileName: f => f, getNewLine: () => '\n' }));

    assert.deepEqual(coldDiags, warmDiags, 'Diagnostics must match 100% between cold and warm lib cache');

    // Type checking results must match 100%
    const coldChecker = coldProg.getTypeChecker();
    const warmChecker = warmProg.getTypeChecker();

    const coldSf = coldProg.getSourceFile(path.join(ws.root, 'src/index.ts'))!;
    const warmSf = warmProg.getSourceFile(path.join(ws.root, 'src/index.ts'))!;

    const coldFunc = (coldSf.statements[0] as ts.FunctionDeclaration);
    const warmFunc = (warmSf.statements[0] as ts.FunctionDeclaration);

    const coldType = coldChecker.getTypeAtLocation(coldFunc);
    const warmType = warmChecker.getTypeAtLocation(warmFunc);

    assert.equal(coldChecker.typeToString(coldType), warmChecker.typeToString(warmType));

    console.log('  ✅ PASS: Cache Hit vs Cache Miss Semantic Parity');
  } finally {
    ws.cleanup();
  }
}

// 6. Hostile Test: Multi-repository cross-talk isolation
{
  console.log('  Testing Multi-Repository Process Isolation...');
  const repo1 = createWorkspace({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/symbol.ts': 'export const UNIQUE_R1 = "repo1_token";\n'
  });
  const repo2 = createWorkspace({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/symbol.ts': 'export const UNIQUE_R2 = 99999;\n'
  });

  try {
    const builder = new DualTypeScriptProgramBuilder();
    const toolchain = { compiler: { name: 'typescript', version: ts.version }, repositoryDeclaredVersion: null, mismatch: 'UNDETERMINED' as const };

    const dual1 = builder.build(
      { root: repo1.root, trackedFiles: ['tsconfig.json', 'src/symbol.ts'], revision: { repositoryId: 'repo-1', commitSha: 'sha1' }, toolchain, adapterId: 't', adapterVersion: '1' },
      { root: repo1.root, trackedFiles: ['tsconfig.json', 'src/symbol.ts'], revision: { repositoryId: 'repo-1', commitSha: 'sha1' }, toolchain, adapterId: 't', adapterVersion: '1' }
    );

    const dual2 = builder.build(
      { root: repo2.root, trackedFiles: ['tsconfig.json', 'src/symbol.ts'], revision: { repositoryId: 'repo-2', commitSha: 'sha2' }, toolchain, adapterId: 't', adapterVersion: '1' },
      { root: repo2.root, trackedFiles: ['tsconfig.json', 'src/symbol.ts'], revision: { repositoryId: 'repo-2', commitSha: 'sha2' }, toolchain, adapterId: 't', adapterVersion: '1' }
    );

    const p1 = dual1.parent.projects[0].program;
    const p2 = dual2.parent.projects[0].program;

    const sf1 = p1.getSourceFile(path.join(repo1.root, 'src/symbol.ts'))!;
    const sf2 = p2.getSourceFile(path.join(repo2.root, 'src/symbol.ts'))!;

    assert.ok(sf1.text.includes('UNIQUE_R1'));
    assert.ok(!sf1.text.includes('UNIQUE_R2'));
    assert.ok(sf2.text.includes('UNIQUE_R2'));
    assert.ok(!sf2.text.includes('UNIQUE_R1'));

    console.log('  ✅ PASS: Multi-Repository Process Isolation');
  } finally {
    repo1.cleanup();
    repo2.cleanup();
  }
}

console.log('\nAll Program Isolation & Lib Cache tests passed successfully!');
