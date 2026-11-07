export interface TestSignal {
  type: 'import' | 'call' | 'pattern' | 'path_hint';
  description: string;
  strength: 'STRONG' | 'MODERATE' | 'WEAK';
}

export interface TestSignalResult {
  isTestFile: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  frameworkDetected: string | null;
  signals: TestSignal[];
  pathHintIsTest: boolean;
}

export const TEST_FRAMEWORK_IMPORTS = [
  { pattern: /vitest/, framework: 'vitest' },
  { pattern: /@playwright\/test/, framework: 'playwright' },
  { pattern: /jest/, framework: 'jest' },
  { pattern: /mocha/, framework: 'mocha' },
  { pattern: /jasmine/, framework: 'jasmine' },
  { pattern: /(?:['"]ava['"]|\bfrom\s+['"]ava['"]|\brequire\s*\(\s*['"]ava['"]\s*\))/, framework: 'ava' },
  { pattern: /node:test/, framework: 'node_test' },
];

export const TEST_LIFECYCLE_CALLS = [
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'jest.mock', 'vi.mock', 'sinon.stub',
  'assert.equal', 'assert.deepEqual'
];

export function detectTestSignals(relPath: string, fileContent: string, topologyRole?: string): TestSignalResult {
  const normPath = relPath.replace(/\\/g, '/');

  const signals: TestSignal[] = [];
  let frameworkDetected: string | null = null;
  let hasFrameworkImport = false;
  let hasLifecycleCall = false;

  for (const fw of TEST_FRAMEWORK_IMPORTS) {
    if (fw.pattern.test(fileContent)) {
      hasFrameworkImport = true;
      frameworkDetected = fw.framework;
      signals.push({
        type: 'import',
        description: `Imported test framework ${fw.framework}`,
        strength: 'STRONG'
      });
      break;
    }
  }

  for (const callName of TEST_LIFECYCLE_CALLS) {
    const callRegex = new RegExp(`\\b${callName.replace('.', '\\.')}\\s*\\(`, 'g');
    if (callRegex.test(fileContent)) {
      hasLifecycleCall = true;
      signals.push({
        type: 'call',
        description: `Test lifecycle function call '${callName}'`,
        strength: 'STRONG'
      });
      break;
    }
  }

  const isTopologyTest = topologyRole === 'TEST';
  if (isTopologyTest) {
    signals.push({
      type: 'pattern',
      description: 'Repository topology indicates test role',
      strength: 'STRONG'
    });
  }

  const isPathHintTest =
    normPath.includes('/tests/') ||
    normPath.includes('/__tests__/') ||
    normPath.includes('/src/test/') ||
    normPath.endsWith('.test.ts') ||
    normPath.endsWith('.spec.ts') ||
    normPath.endsWith('.test.js') ||
    normPath.endsWith('.spec.js') ||
    normPath.endsWith('Test.java') ||
    normPath.endsWith('_test.go') ||
    normPath.endsWith('_test.rs') ||
    normPath.endsWith('_test.py');

  const isTestFile = hasFrameworkImport || hasLifecycleCall || isTopologyTest || isPathHintTest;

  return {
    isTestFile,
    confidence: hasFrameworkImport && hasLifecycleCall ? 'HIGH' : isTestFile ? 'MEDIUM' : 'NONE',
    frameworkDetected,
    signals,
    pathHintIsTest: isPathHintTest
  };
}
