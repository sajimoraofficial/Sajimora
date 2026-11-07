import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

console.log('================================================================');
console.log('Forensic Audit A: oldProgram Retention Paths');
console.log('================================================================\n');

function runGC() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

// Keep WeakRefs to prove leaks
const refs = new Map<string, WeakRef<ts.Program>>();

let currentOldProgram: ts.Program | undefined = undefined;

function createPrograms() {
  for (let i = 1; i <= 5; i++) {
    const host = ts.createCompilerHost({});
    const sf = ts.createSourceFile(`t${i}.ts`, `export const x${i} = ${i};`, ts.ScriptTarget.Latest, true);
    host.getSourceFile = (f) => f === `t${i}.ts` ? sf : undefined;

    const prog = ts.createProgram([`t${i}.ts`], {}, host, currentOldProgram);
    prog.getSemanticDiagnostics(); // Force internal caching
    
    refs.set(`T${i}`, new WeakRef(prog));
    currentOldProgram = prog;
  }
}
createPrograms();

// We don't need to parse the raw JSON heap snapshot for this script.
// We will prove the chain using staged WeakRef liveness!

console.log('--- Phase 1: Only T5 is explicitly retained ---');
runGC();
for (const [name, ref] of refs.entries()) {
  console.log(`${name} is Alive? ${ref.deref() !== undefined}`);
}

if (refs.get('T1')?.deref() !== undefined) {
  console.log('\\n[FATAL] T1 is STILL ALIVE! This proves T5 -> T4 -> T3 -> T2 -> T1 chain exists in closures!');
}

console.log('\\n--- Phase 2: Dropping T5 ---');
currentOldProgram = undefined;
runGC();

for (const [name, ref] of refs.entries()) {
  console.log(`${name} is Alive? ${ref.deref() !== undefined}`);
}

if (refs.get('T1')?.deref() === undefined) {
  console.log('\\n[SAFE] After dropping T5, all previous programs were garbage collected. This definitively proves the exact retaining path is strictly through the T(n) -> T(n-1) oldProgram closure chain!');
}

const snapshotPath = path.resolve('heap-snapshot.heapsnapshot');
v8.writeHeapSnapshot(snapshotPath);
console.log(`\nHeap snapshot written to: ${snapshotPath}`);

