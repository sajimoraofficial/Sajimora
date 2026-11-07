import * as ts from 'typescript';

console.log('================================================================');
console.log('Forensic Audit B: SharedImmutableLibCache Contamination');
console.log('================================================================\n');

// 1. Create a "cached" shared library SourceFile
const libCode = `
declare var console: { log(msg: string): void; };
declare function parseInt(s: string): number;
`;
// setParentNodes = true is what SharedImmutableLibCache does implicitly by ts.createSourceFile with true
const sharedLib = ts.createSourceFile('lib.d.ts', libCode, ts.ScriptTarget.Latest, true);

console.log('--- Before Any Binding ---');
console.log('sharedLib.symbol:', !!(sharedLib as any).symbol);
console.log('sharedLib.locals:', !!(sharedLib as any).locals);
console.log('sharedLib.bindDiagnostics:', !!(sharedLib as any).bindDiagnostics);

// 2. Program 1 (T1)
const host1 = ts.createCompilerHost({});
host1.getSourceFile = (fileName) => {
  if (fileName === 'lib.d.ts') return sharedLib;
  if (fileName === 't1.ts') return ts.createSourceFile('t1.ts', 'parseInt("1");', ts.ScriptTarget.Latest, true);
  return undefined;
};
const p1 = ts.createProgram(['lib.d.ts', 't1.ts'], {}, host1);
p1.getTypeChecker(); // Force binding and type checking

console.log('\n--- After Program 1 Binding ---');
console.log('sharedLib.symbol:', !!(sharedLib as any).symbol);
console.log('sharedLib.locals:', !!(sharedLib as any).locals);
console.log('sharedLib.bindDiagnostics:', !!(sharedLib as any).bindDiagnostics);

const t1ConsoleSymbol = (sharedLib as any).locals?.get('console' as ts.__String);
console.log('T1 Console Symbol ID:', (t1ConsoleSymbol as any)?.id);

// 3. Program 2 (T2)
const host2 = ts.createCompilerHost({});
host2.getSourceFile = (fileName) => {
  if (fileName === 'lib.d.ts') return sharedLib;
  if (fileName === 't2.ts') return ts.createSourceFile('t2.ts', 'console.log("hello");', ts.ScriptTarget.Latest, true);
  return undefined;
};
const p2 = ts.createProgram(['lib.d.ts', 't2.ts'], {}, host2);
p2.getTypeChecker();

console.log('\n--- After Program 2 Binding ---');
const t2ConsoleSymbol = (sharedLib as any).locals?.get('console' as ts.__String);
console.log('T2 Console Symbol ID:', (t2ConsoleSymbol as any)?.id);

if (t1ConsoleSymbol && t1ConsoleSymbol === t2ConsoleSymbol) {
  console.log('\n[FATAL] Cross-Revision Contamination PROVEN: T2 reused T1\'s mutated Symbol inside the shared SourceFile!');
} else {
  console.log('\n[SAFE] Symbols are distinct.');
}
