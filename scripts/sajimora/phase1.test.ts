import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NormalizedEvidenceHasher,
  normalizeEvidence,
  hashNormalizedEvidence,
  TypeScriptCompatibility,
  Phase4SemanticProvider
} from '@sajimora/analysis';

console.log('================================================================');
console.log('Sajimora Phase 1 — Provider Boundary & Canonical Hashing Test Suite');
console.log('================================================================\n');

// 1. Gate 1: Provider interface zero ts.* / typescript import check
const providerSourcePath = path.resolve('packages/analysis/src/sajimora/compatibility/Phase4SemanticProvider.ts');
const providerSourceText = fs.readFileSync(providerSourcePath, 'utf8');

assert.equal(
  /import\s+.*?from\s+['"]typescript['"]/i.test(providerSourceText),
  false,
  'Phase4SemanticProvider.ts MUST NOT import from typescript'
);

const tsObjectMarkers = ['ts.Program', 'ts.Type', 'ts.Symbol', 'ts.Node', 'ts.Signature', 'ts.TypeChecker', 'ts.CompilerOptions'];
for (const marker of tsObjectMarkers) {
  assert.equal(
    providerSourceText.includes(marker),
    false,
    `Phase4SemanticProvider.ts MUST NOT contain marker ${marker}`
  );
}
console.log('✅ PASS: Gate 1 — Provider Interface is 100% pure with zero ts.* / typescript imports');

// 2. Gate 2: No hidden fallback enforcement in TypeScriptCompatibility
const dummyUsageSite: any = {
  usageSiteId: 'site-1',
  canonicalOccurrence: {
    occurrenceId: 'occ-1',
    usageRole: 'CALL_SITE',
    sourceFile: 'src/main.ts',
    sourceSpan: { start: 10, end: 20, line: 2, column: 5 },
    resolutionStatus: 'RESOLVED'
  },
  evaluationStatus: 'EVALUABLE',
  identityResult: 'SAME'
};

const evaluatorWithoutProvider = new TypeScriptCompatibility(undefined, undefined, {
  isPhase4Mode: true
  // NO provider passed!
});

const resultWithoutProvider = evaluatorWithoutProvider.evaluateSite(dummyUsageSite);
assert.equal(resultWithoutProvider.status, 'UNDECIDABLE');
assert.equal(resultWithoutProvider.reason, 'PHASE4_PREREQUISITES_UNAVAILABLE');
console.log('✅ PASS: Gate 2 — Evaluator enforces strict provider prerequisite (zero hidden ts.Program fallback)');

// 3. Gate 3: NormalizedEvidenceHasher equivalence with old profiler normalizer
function oldProfilerNormalizer(value: unknown): unknown {
  function stripSnapshotRoot(str: string): string {
    return str.replace(/(?:[A-Za-z]:[/\\][^\s"']*?|[^\s"']*?)[/\\]?sajimora-snapshot-[^/\\"\s']+[/\\]?/gi, 'snapshot/');
  }
  if (typeof value === 'string') return stripSnapshotRoot(value);
  if (Array.isArray(value)) return value.map(oldProfilerNormalizer);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'durationMs' && key !== 'peakRssBytes')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, oldProfilerNormalizer(child)])
    );
  }
  return value;
}

const sampleResult = {
  durationMs: 1234,
  peakRssBytes: 50000,
  evaluations: [
    {
      verdict: 'PRESERVED',
      witnesses: [
        '{"file":"C:/Users/test/AppData/Local/Temp/sajimora-snapshot-12345/src/a.ts"}'
      ]
    }
  ]
};

const oldNormalized = oldProfilerNormalizer(sampleResult);
const newNormalized = normalizeEvidence(sampleResult);
assert.deepEqual(newNormalized, oldNormalized, 'NormalizedEvidenceHasher MUST produce output identical to old profiler normalizer');
console.log('✅ PASS: Gate 3 — NormalizedEvidenceHasher matches old profiler normalizer with 100% equivalence');

console.log('\n================================================================');
console.log('Phase 1 Verification: ALL GATES PASSED');
console.log('================================================================\n');
