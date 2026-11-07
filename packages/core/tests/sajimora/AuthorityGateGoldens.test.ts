import * as assert from 'node:assert/strict';
import { VerdictAuthority, CompleteProofEvidence } from '../../src/sajimora/authority/VerdictAuthority';
import { ClosureEvidence } from '../../src/sajimora/types/closure';
import { UsageSite } from '../../src/sajimora/types/usage';

const completeClosure: ClosureEvidence = {
  closureName: 'ValueReferenceClosure', occurrences: [], completeness: 'COMPLETE', failures: [], ambiguities: [],
  unrecognizedForms: [], provenance: [], status: 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE'
};

function site(status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNDECIDABLE' | 'MISSING'): UsageSite {
  return {
    usageSiteId: 'site-1', canonicalOccurrence: {
      occurrenceId: 'occ-1', sourceFile: 'consumer.ts', sourceSpan: { start: 0, end: 1, line: 1, column: 1 },
      syntaxKind: 1, semanticRole: 'VALUE', usageRole: 'CALL_SITE', referencedSymbol: 'target',
      declarationSymbol: 'target', resolutionStatus: status === 'MISSING' ? 'UNRESOLVED' : 'RESOLVED',
      enumerationStatus: 'COMPLETE', provenance: []
    }, existenceAtParent: 'PRESENT', mutationStatus: 'UNCHANGED', bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND', evaluationStatus: status === 'MISSING' ? 'UNCERTAIN_IDENTITY' : 'EVALUABLE',
    identityResult: status === 'MISSING' ? 'IDENTITY_UNCERTAIN' : 'SAME', enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };
}

function evidence(compatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNDECIDABLE' | 'MISSING' | 'EMPTY' = 'COMPATIBLE'): CompleteProofEvidence<unknown> {
  const occurrence = compatibility === 'EMPTY' ? [] : [site(compatibility)];
  const results = new Map();
  if (!['EMPTY', 'MISSING'].includes(compatibility)) results.set('site-1', { status: compatibility, reason: null });
  return {
    triggerData: {}, obligation: { invariantId: 'golden', relation: 'STRUCTURAL_CO_EVOLUTION', mutatedSymbol: null },
    analysisUniverse: { discoveryStatus: 'DISCOVERY_COMPLETE', parseFailures: new Map(), unreadableFiles: [], excludedFiles: new Map() },
    closures: {
      valueReference: { ...completeClosure }, typeReference: { ...completeClosure }, inheritance: { ...completeClosure },
      interfaceImpl: { ...completeClosure }, override: { ...completeClosure }, reExport: { ...completeClosure },
      ambientReference: { ...completeClosure }
    }, canonicalOccurrences: occurrence, identityResults: [], compatibilityResults: results,
    semanticScope: { unsupportedRelationshipPossible: false, reason: 'TS_VALUE_LEVEL_NO_IMPLICIT' }
  };
}

const cases = [
  ['incompatible consumer', () => evidence('INCOMPATIBLE'), 'VIOLATED', 'VIOLATED_CHECK', 'INCOMPATIBLE_CONSUMER'],
  ['discovery failure', () => { const e = evidence(); e.analysisUniverse.discoveryStatus = 'DISCOVERY_INCOMPLETE'; return e; }, 'UNKNOWN', 'UNIVERSE_DISCOVERY', 'DISCOVERY_FAILURE'],
  ['parse failure', () => { const e = evidence(); e.analysisUniverse.parseFailures.set('bad.ts', 'syntax'); return e; }, 'UNKNOWN', 'UNIVERSE_PARSE', 'PARSE_FAILURE'],
  ['unreadable input', () => { const e = evidence(); e.analysisUniverse.unreadableFiles.push('locked.ts'); return e; }, 'UNKNOWN', 'UNIVERSE_READABILITY', 'UNREADABLE_INPUT'],
  ['missing universe', () => { const e = evidence(); e.analysisUniverse = undefined as any; return e; }, 'UNKNOWN', 'ANALYSIS_UNIVERSE', 'MISSING_ANALYSIS_UNIVERSE'],
  ['incomplete closure', () => { const e = evidence(); (e.closures.override as ClosureEvidence).completeness = 'INCOMPLETE'; return e; }, 'UNKNOWN', 'CLOSURE_COMPLETENESS', 'INCOMPLETE_CLOSURE'],
  ['unsupported semantics', () => { const e = evidence(); e.semanticScope.unsupportedRelationshipPossible = true; return e; }, 'UNKNOWN', 'SEMANTIC_SCOPE', 'UNSUPPORTED_SEMANTIC_SCOPE'],
  ['uncertain identity', () => evidence('MISSING'), 'UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY'],
  ['undecidable relation', () => evidence('UNDECIDABLE'), 'UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'],
  ['empty closure', () => evidence('EMPTY'), 'NOT_APPLICABLE', 'EMPTY_CLOSURE', 'STRUCTURAL_TRIGGER_NO_CONSUMERS'],
  ['all compatible', () => evidence('COMPATIBLE'), 'PRESERVED', 'PRESERVED_CHECK', 'ALL_EVALUABLE_COMPATIBLE']
] as const;

for (const [name, create, verdict, gate, reason] of cases) {
  const result = VerdictAuthority.evaluateProof(create());
  assert.equal(result.verdict, verdict, `${name}: verdict`);
  assert.equal(result.auditTrace?.authorityDecision.gate, gate, `${name}: gate`);
  assert.equal(result.auditTrace?.authorityDecision.reason, reason, `${name}: reason`);
}

// Frozen precedence: a proven incompatible consumer wins even when other evidence is incomplete.
{
  const e = evidence('INCOMPATIBLE');
  e.analysisUniverse.discoveryStatus = 'DISCOVERY_INCOMPLETE';
  (e.closures.override as ClosureEvidence).completeness = 'INCOMPLETE';
  assert.equal(VerdictAuthority.evaluateProof(e).verdict, 'VIOLATED');
}

// Audit content is observational: varying diagnostic-only input cannot change the decision tuple.
{
  const a = evidence();
  const b = evidence();
  a.triggerData = { diagnostic: 'one' };
  b.triggerData = { diagnostic: 'two', nested: { arbitrary: true } };
  b.identityResults = [{ diagnosticOnly: 'different' }];
  const decision = (e: CompleteProofEvidence<unknown>) => {
    const r = VerdictAuthority.evaluateProof(e);
    return [r.verdict, r.internalReason, r.auditTrace?.authorityDecision.gate, r.auditTrace?.authorityDecision.reason];
  };
  assert.deepEqual(decision(a), decision(b));
}

console.log(`Authority gate goldens: ${cases.length} gates plus precedence and audit isolation passed.`);
