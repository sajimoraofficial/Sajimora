/**
 * Test Suite 4: AST Structural Diff Engine
 * Verifies Test Requirements 4, 5, 6, 15.
 */

import * as assert from 'assert';
import { AstStructuralDiffEngine, LazyBeforeStateProvider, ParseResult } from '../src';

console.log('--- Running AST Structural Diff Engine Tests ---');

// Mock LazyBeforeStateProvider
class MockBeforeStateProvider extends LazyBeforeStateProvider {
  public beforeMap: Map<string, ParseResult | null> = new Map();
  public afterMap: Map<string, ParseResult | null> = new Map();

  constructor() {
    super(process.cwd());
  }

  override async getBeforeParseResult(
    _workspaceId: string,
    _baseCommitSha: string,
    filePath: string
  ): Promise<ParseResult | null> {
    return this.beforeMap.has(filePath) ? this.beforeMap.get(filePath)! : null;
  }

  override async getAfterParseResult(
    filePath: string,
    _candidateCommitSha?: string
  ): Promise<ParseResult | null> {
    return this.afterMap.has(filePath) ? this.afterMap.get(filePath)! : null;
  }
}

const mockProvider = new MockBeforeStateProvider();
const diffEngine = new AstStructuralDiffEngine(mockProvider);

// Fixture 1: Function signature changed
const beforeParse1: ParseResult = {
  filePath: 'src/math.ts',
  functions: [
    {
      name: 'calculateTotal',
      signature: 'calculateTotal(price: number): number',
      parameters: ['price'],
      returnType: 'number',
      startLine: 1,
      endLine: 5,
    },
    {
      name: 'unchangedFunc',
      signature: 'unchangedFunc(): void',
      parameters: [],
      returnType: 'void',
      startLine: 6,
      endLine: 10,
    },
  ],
  classes: [],
  imports: ['./utils'],
  exports: ['calculateTotal', 'unchangedFunc'],
  endpoints: [],
  databaseModels: [],
  commentsSanitized: true,
  parserType: 'native',
  completeness: 'full',
};

const afterParse1: ParseResult = {
  filePath: 'src/math.ts',
  functions: [
    {
      name: 'calculateTotal',
      signature: 'calculateTotal(price: number, taxRate: number): number', // Signature mutated
      parameters: ['price', 'taxRate'],
      returnType: 'number',
      startLine: 1,
      endLine: 6,
    },
    {
      name: 'unchangedFunc',
      signature: 'unchangedFunc(): void', // Identical
      parameters: [],
      returnType: 'void',
      startLine: 7,
      endLine: 11,
    },
  ],
  classes: [],
  imports: ['./utils', './tax'], // Added import
  exports: ['calculateTotal', 'unchangedFunc'],
  endpoints: [],
  databaseModels: [],
  commentsSanitized: true,
  parserType: 'native',
  completeness: 'full',
};

mockProvider.beforeMap.set('src/math.ts', beforeParse1);
mockProvider.afterMap.set('src/math.ts', afterParse1);

// Fixture 2: Missing signature (must NOT fabricate SIGNATURE_CHANGED)
const beforeParseMissingSig: ParseResult = {
  filePath: 'src/nosig.ts',
  functions: [
    {
      name: 'someFunc',
      signature: '', // Missing signature
      parameters: [],
      returnType: '',
      startLine: 1,
      endLine: 5,
    },
  ],
  classes: [],
  imports: [],
  exports: [],
  endpoints: [],
  databaseModels: [],
  commentsSanitized: true,
  parserType: 'fallback',
  completeness: 'partial',
};

const afterParseMissingSig: ParseResult = {
  filePath: 'src/nosig.ts',
  functions: [
    {
      name: 'someFunc',
      signature: '', // Still missing
      parameters: [],
      returnType: '',
      startLine: 1,
      endLine: 7,
    },
  ],
  classes: [],
  imports: [],
  exports: [],
  endpoints: [],
  databaseModels: [],
  commentsSanitized: true,
  parserType: 'fallback',
  completeness: 'partial',
};

mockProvider.beforeMap.set('src/nosig.ts', beforeParseMissingSig);
mockProvider.afterMap.set('src/nosig.ts', afterParseMissingSig);

async function runTest() {
  const delta = await diffEngine.computeDiff(
    'change-1',
    'ws-1',
    'sha-base',
    'sha-cand',
    [
      { filePath: 'src/math.ts', changeType: 'MODIFIED' },
      { filePath: 'src/nosig.ts', changeType: 'MODIFIED' },
    ]
  );

  assert.strictEqual(delta.fileDeltas.length, 2);

  // File 1: src/math.ts
  const mathDelta = delta.fileDeltas.find((f) => f.filePath === 'src/math.ts')!;
  assert.strictEqual(mathDelta.diffConfidence, 'DETERMINISTIC');
  assert.strictEqual(mathDelta.symbolDeltas.length, 1);
  assert.strictEqual(mathDelta.symbolDeltas[0].symbolName, 'calculateTotal');
  assert.strictEqual(mathDelta.symbolDeltas[0].changeType, 'SIGNATURE_CHANGED');
  assert.strictEqual(mathDelta.symbolDeltas[0].oldSignature, 'calculateTotal(price: number): number');
  assert.strictEqual(mathDelta.symbolDeltas[0].newSignature, 'calculateTotal(price: number, taxRate: number): number');

  // Verify unchangedFunc had no delta
  assert.strictEqual(
    mathDelta.symbolDeltas.some((s) => s.symbolName === 'unchangedFunc'),
    false,
    'Unchanged function must produce zero symbol deltas'
  );

  // Verify import delta
  assert.strictEqual(mathDelta.importDeltas.length, 1);
  assert.strictEqual(mathDelta.importDeltas[0].moduleSpecifier, './tax');
  assert.strictEqual(mathDelta.importDeltas[0].changeType, 'ADDED');

  // File 2: src/nosig.ts (Missing signature)
  const nosigDelta = delta.fileDeltas.find((f) => f.filePath === 'src/nosig.ts')!;
  assert.strictEqual(nosigDelta.diffConfidence, 'PARTIAL');
  assert.strictEqual(
    nosigDelta.symbolDeltas.length,
    0,
    'Missing signatures must NEVER fabricate SIGNATURE_CHANGED or BODY_CHANGED'
  );

  // Verify summary counts
  assert.strictEqual(delta.summary.symbolsSignatureChanged, 1);
  assert.strictEqual(delta.summary.importsAdded, 1);
  assert.strictEqual(delta.summary.deterministicFileCount, 1);
  assert.strictEqual(delta.summary.partialFileCount, 1);

  console.log('✓ AST Structural Diff Engine Tests Passed.');
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
