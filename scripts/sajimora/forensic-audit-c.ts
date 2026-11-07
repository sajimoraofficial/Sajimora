import * as ts from 'typescript';
import * as crypto from 'node:crypto';

console.log('================================================================');
console.log('Forensic Audit C: Control Experiments');
console.log('================================================================\n');

function runGC() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

function getHeap() {
  return process.memoryUsage().heapUsed;
}

const libCode = `
declare var console: { log(msg: string): void; };
declare function parseInt(s: string): number;
`;

const hashDiags = (diags: readonly ts.Diagnostic[]) => {
  const simplified = diags.map(d => ({
    code: d.code,
    msg: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText
  }));
  return crypto.createHash('sha256').update(JSON.stringify(simplified)).digest('hex');
};

function runExperiment(name: string, useOldProgram: boolean, useSharedLib: boolean) {
  console.log(`\\n--- Experiment: ${name} ---`);
  console.log(`oldProgram: ${useOldProgram} | sharedLib: ${useSharedLib}`);
  
  runGC();
  const startHeap = getHeap();
  
  const sharedLibSf = useSharedLib ? ts.createSourceFile('lib.d.ts', libCode, ts.ScriptTarget.Latest, true) : undefined;
  
  let currentOldProgram: ts.Program | undefined = undefined;
  let hashes: string[] = [];
  
  for (let i = 1; i <= 10; i++) {
    const host = ts.createCompilerHost({});
    host.getSourceFile = (fileName) => {
      if (fileName === 'lib.d.ts') {
        if (useSharedLib) return sharedLibSf;
        return ts.createSourceFile('lib.d.ts', libCode, ts.ScriptTarget.Latest, true);
      }
      if (fileName === 'app.ts') {
        return ts.createSourceFile('app.ts', `console.log("iteration ${i}"); parseInt("${i}");`, ts.ScriptTarget.Latest, true);
      }
      return undefined;
    };
    
    const prog: any = ts.createProgram(['lib.d.ts', 'app.ts'], {}, host, currentOldProgram);
    const diags = prog.getSemanticDiagnostics();
    hashes.push(hashDiags(diags));
    
    if (useOldProgram) {
      currentOldProgram = prog;
    }
  }
  
  // Drop explicit references
  currentOldProgram = undefined;
  runGC();
  
  const endHeap = getHeap();
  const heapDiffMB = (endHeap - startHeap) / 1024 / 1024;
  
  console.log(`Resulting Heap Growth: ${heapDiffMB.toFixed(2)} MB`);
  
  const firstHash = hashes[0];
  const allMatch = hashes.every(h => h === firstHash);
  if (!allMatch) {
    console.log(`[FATAL] Semantic Hash Mismatch detected during iterations!`);
    console.log(`Hash T1: ${firstHash}`);
    console.log(`Hash T10: ${hashes[9]}`);
  } else {
    console.log(`[SAFE] Semantic Evidence Parity maintained across 10 iterations. Hash: ${firstHash}`);
  }
}

runExperiment("1. oldProgram + isolated libs", true, false);
runExperiment("2. cold Program + SharedImmutableLibCache", false, true);
runExperiment("3. cold + isolated libs (Baseline Truth)", false, false);
runExperiment("4. oldProgram + shared libs (Failing Configuration)", true, true);

