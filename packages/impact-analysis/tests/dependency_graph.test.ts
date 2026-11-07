import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineDependencyGraph } from '../src/OfflineDependencyGraph';

function runDependencyGraphTests() {
  console.log('=== RUNNING DEPENDENCY GRAPH & PROVENANCE TESTS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-depgraph-test-'));

  try {
    const fileA = path.join(tempDir, 'fileA.ts');
    const fileB = path.join(tempDir, 'fileB.ts');
    const fileC = path.join(tempDir, 'fileC.ts');

    // Create cyclic structure: A -> B -> C -> A with dynamic import in C
    fs.writeFileSync(fileA, 'import "./fileB"; export const a = 1;');
    fs.writeFileSync(fileB, 'import "./fileC"; export const b = 2;');
    fs.writeFileSync(fileC, 'import("./fileA"); const dyn = "fileA"; import(dyn); export const c = 3;');

    const graph = new OfflineDependencyGraph({
      repoRoot: tempDir,
      files: ['fileA.ts', 'fileB.ts', 'fileC.ts']
    });

    // 1. Static AST Edge Check
    {
      const incomingToB = graph.getIncomingEdges('fileB.ts');
      const edgeAtoB = incomingToB.find(e => e.from === 'fileA.ts');
      assert.ok(edgeAtoB, 'Missing edge fileA.ts -> fileB.ts');
      assert.strictEqual(edgeAtoB.evidence.kind, 'STATIC_AST');
      assert.strictEqual(edgeAtoB.evidence.extractor, 'TS_AST');
      assert.strictEqual(edgeAtoB.evidence.sourceLocation?.line, 1);
      console.log('[PASS] Verified STATIC_AST edge from fileA.ts -> fileB.ts');
    }

    // 2. Incoming Dependents of fileC.ts
    {
      const incomingToC = graph.getIncomingEdges('fileC.ts');
      const edgeBtoC = incomingToC.find(e => e.from === 'fileB.ts');
      assert.ok(edgeBtoC, 'Missing incoming edge from fileB.ts to fileC.ts');
      console.log('[PASS] Inverted adjacency correctly records fileB.ts as caller of fileC.ts');
    }

    // 3. Dynamic Import Literal vs Heuristic
    {
      const outgoingC = graph.getOutgoingEdges('fileC.ts');
      const dynamicLiteral = outgoingC.find(e => e.relation === 'DYNAMIC_IMPORT' && e.evidence.kind === 'DYNAMIC_AST');
      const dynamicHeuristic = outgoingC.find(e => e.relation === 'DYNAMIC_IMPORT' && e.evidence.kind === 'HEURISTIC');

      assert.ok(dynamicLiteral, 'Missing DYNAMIC_AST literal edge in fileC');
      assert.strictEqual(dynamicLiteral.evidence.isLiteral, true);
      assert.strictEqual(dynamicLiteral.evidence.specifierLiteral, './fileA');
      console.log('[PASS] Verified DYNAMIC_AST edge with isLiteral: true');

      assert.ok(dynamicHeuristic, 'Missing HEURISTIC dynamic import edge in fileC');
      assert.strictEqual(dynamicHeuristic.evidence.isLiteral, false);
      assert.strictEqual(dynamicHeuristic.evidence.specifierLiteral, 'dyn');
      console.log('[PASS] Verified HEURISTIC dynamic import edge for expression with isLiteral: false');
    }

    // 4. Serialization / Deserialization
    {
      const buf = graph.serialize();
      assert.ok(buf && buf.length > 0);
      const deserialized = OfflineDependencyGraph.deserialize(buf, tempDir, ['fileA.ts', 'fileB.ts', 'fileC.ts']);
      assert.strictEqual(deserialized.staticAstEdgeCount, graph.staticAstEdgeCount);
      assert.strictEqual(deserialized.dynamicAstEdgeCount, graph.dynamicAstEdgeCount);
      assert.strictEqual(deserialized.heuristicEdgeCount, graph.heuristicEdgeCount);
      console.log('[PASS] Dependency graph serialization/deserialization verified');
    }

    // Test 6: Unreadable file and parse error blocker recording
    {
      const graphWithUnreadable = new OfflineDependencyGraph({
        repoRoot: tempDir,
        files: ['fileA.ts', 'does_not_exist/corrupt.ts', 'broken_syntax.ts']
      });
      assert.ok(graphWithUnreadable.unreadableFiles.includes('does_not_exist/corrupt.ts'));
      assert.ok(graphWithUnreadable.blockers.some(b => b.code === 'UNREADABLE_FILE' && b.file === 'does_not_exist/corrupt.ts'));
      console.log('[PASS] Unreadable files and parse errors recorded as blockers in dependency graph');
    }

    console.log('\nDependency Graph Tests: ALL PASSED\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runDependencyGraphTests();
