import * as assert from 'node:assert/strict';
import { formatTwoPanelReport, enforceVerdictAuthorityInvariant } from './twoPanelReport';
import { Phase1Artifact } from './artifact';
import { AdvisoryImpactResult } from '../../packages/analysis/src/sajimora/advisory/TypeScriptImpactAnalyzer';

const mockArtifact = (verdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN'): Phase1Artifact => ({
  schemaVersion: 'SAJIMORA_ANALYSIS_ARTIFACT_V2',
  repository: { repositoryId: 'repo-1' },
  revisions: {
    parent: { repositoryId: 'repo-1', commitSha: 'sha-parent' },
    candidate: { repositoryId: 'repo-1', commitSha: 'sha-candidate', parentSelection: { strategy: 'EXPLICIT_PARENT', selectedParentSha: 'sha-parent' } }
  },
  adapter: {
    id: 'ts-v1',
    version: '1.0.0',
    capabilities: ['TYPE_INFERENCE' as any],
    selection: { mode: 'auto', evidence: [] },
    toolchain: { id: 'ts', version: '5.9.3' } as any
  },
  dualProgram: { parentStatus: 'BUILT', candidateStatus: 'BUILT', universe: 'SEALED' as any },
  crossVersionIdentity: { matchedDeclarations: [] } as any,
  analysis: {
    status: 'COMPLETED',
    changedFiles: ['src/provider.ts'],
    results: [
      {
        obligationId: 'obl-1',
        target: { name: 'calc', kind: 'FUNCTION', file: 'src/provider.ts', line: 10 },
        verdict,
        authority: { source: 'VERDICT_AUTHORITY', gate: 'WITNESS_VERIFICATION', reason: 'SOUND_ANALYSIS' }
      }
    ]
  }
} as unknown as Phase1Artifact);

const mockAdvisory = (verdict: 'LIKELY_PRESERVED' | 'LIKELY_VIOLATED' | 'INCONCLUSIVE'): AdvisoryImpactResult => ({
  schemaVersion: 'ADVISORY_TS_IMPACT_V1',
  certificationStatus: 'ADVISORY_ONLY',
  verdict,
  parentCommitSha: 'sha-parent',
  candidateCommitSha: 'sha-candidate',
  compilerVersion: '5.9.3',
  compilerOptions: {},
  providers: [],
  consumers: [
    {
      providerId: 'src/provider.ts#calc',
      consumer: { file: 'src/consumer.ts', line: 5, column: 1 },
      usage: { file: 'src/consumer.ts', line: 5, column: 10 },
      referenceKind: 'CALL',
      directness: 'DIRECT',
      dependencyPath: ['src/provider.ts', 'src/consumer.ts'],
      resolutionStatus: 'COMPLETE'
    }
  ],
  impacts: [],
  traces: [],
  completeness: {
    status: 'COMPLETE',
    consumersAnalyzed: 1,
    unresolvedDependencyCount: 0,
    unresolvedFiles: [],
    resolutionTraces: []
  },
  confidenceRationale: ['ok'],
  evidenceReferences: []
});

console.log('Running Two-Panel Report & Verdict Authority Invariant Tests...');

// Test 1: Invariant - Advisory LIKELY_PRESERVED can NEVER upgrade UNKNOWN to PRESERVED
const invariant1 = enforceVerdictAuthorityInvariant('UNKNOWN', 'LIKELY_PRESERVED');
assert.equal(invariant1, 'UNKNOWN', 'Advisory LIKELY_PRESERVED must never upgrade UNKNOWN to PRESERVED');

// Test 2: Invariant - Certified VIOLATED stays VIOLATED regardless of advisory
const invariant2 = enforceVerdictAuthorityInvariant('VIOLATED', 'LIKELY_PRESERVED');
assert.equal(invariant2, 'VIOLATED', 'Certified VIOLATED must remain VIOLATED');

// Test 3: Invariant - Certified PRESERVED stays PRESERVED
const invariant3 = enforceVerdictAuthorityInvariant('PRESERVED', 'LIKELY_PRESERVED');
assert.equal(invariant3, 'PRESERVED', 'Certified PRESERVED must remain PRESERVED');

// Test 4: Two-panel output rendering when certified UNKNOWN and advisory LIKELY_PRESERVED
const reportUnknown = formatTwoPanelReport(mockArtifact('UNKNOWN'), mockAdvisory('LIKELY_PRESERVED'));
assert.ok(reportUnknown.includes('FINAL RELEASE GATE VERDICT: UNKNOWN'), 'Report must enforce UNKNOWN when certified is UNKNOWN');
assert.ok(reportUnknown.includes('PANEL 1: CERTIFIED VERDICT AUTHORITY'));
assert.ok(reportUnknown.includes('PANEL 2: ADVISORY IMPACT ANALYSIS'));
assert.ok(reportUnknown.includes('Advisory Verdict:      LIKELY_PRESERVED'));
assert.ok(reportUnknown.includes('Consumers Analyzed:    1'));

// Test 5: Two-panel output rendering when certified VIOLATED and advisory LIKELY_VIOLATED
const reportViolated = formatTwoPanelReport(mockArtifact('VIOLATED'), mockAdvisory('LIKELY_VIOLATED'));
assert.ok(reportViolated.includes('FINAL RELEASE GATE VERDICT: VIOLATED'));
assert.ok(reportViolated.includes('Authoritative Verdict: VIOLATED'));

console.log('✅ All Two-Panel Report & Verdict Authority Invariant Tests PASSED cleanly!');
