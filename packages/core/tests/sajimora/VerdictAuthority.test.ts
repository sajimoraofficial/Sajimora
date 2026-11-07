import { VerdictAuthority, CompleteProofEvidence } from '../../src/sajimora/authority/VerdictAuthority';
import { ClosureEvidence } from '../../src/sajimora/types/closure';
import { ProofObligation } from '../../src/sajimora/types/obligation';
import { UsageSite } from '../../src/sajimora/types/usage';
import { CompatibilityResult } from '../../src/sajimora/types/compatibility';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const dummyObligation: ProofObligation = {
  invariantId: 'inv-1',
  relation: 'STRUCTURAL_CO_EVOLUTION',
  mutatedSymbol: null
};

const completeClosureEvidence: ClosureEvidence = {
  closureName: 'ValueReferenceClosure',
  occurrences: [],
  completeness: 'COMPLETE',
  failures: [],
  ambiguities: [],
  unrecognizedForms: [],
  provenance: [],
  status: 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE'
};

const incompleteClosureEvidence: ClosureEvidence = {
  ...completeClosureEvidence,
  completeness: 'INCOMPLETE',
  failures: [{ file: 'foo.ts', cause: 'UNKNOWN_FAILURE' }],
  status: 'INCOMPLETE'
};

const validUniverse = {
  discoveryStatus: 'DISCOVERY_COMPLETE',
  parseFailures: new Map(),
  unreadableFiles: [],
  excludedFiles: new Map()
};

function createBaseEvidence(): CompleteProofEvidence<any> {
  return {
    triggerData: {},
    obligation: dummyObligation,
    analysisUniverse: validUniverse,
    closures: {
      valueReference: { ...completeClosureEvidence },
      typeReference: { ...completeClosureEvidence },
      inheritance: { ...completeClosureEvidence },
      interfaceImpl: { ...completeClosureEvidence },
      override: { ...completeClosureEvidence },
      reExport: { ...completeClosureEvidence },
      ambientReference: { ...completeClosureEvidence }
    },
    canonicalOccurrences: [],
    identityResults: [],
    compatibilityResults: new Map(),
    semanticScope: { unsupportedRelationshipPossible: false, reason: 'TS_VALUE_LEVEL_NO_IMPLICIT' }
  };
}

function createUsageSite(id: string, evaluable = true, status: any = 'RESOLVED'): UsageSite {
  return {
    usageSiteId: id,
    canonicalOccurrence: {
      occurrenceId: id,
      sourceFile: 'consumer.ts',
      sourceSpan: { start: 0, end: 10, line: 1, column: 1 },
      syntaxKind: 100,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'target',
      declarationSymbol: 'target',
      resolutionStatus: status,
      enumerationStatus: 'COMPLETE',
      provenance: []
    },
    existenceAtParent: 'PRESENT',
    mutationStatus: 'UNCHANGED',
    bindingPresenceAtCandidate: 'PRESENT',
    bindingState: 'BOUND',
    evaluationStatus: evaluable ? 'EVALUABLE' : 'UNCERTAIN_IDENTITY',
    identityResult: evaluable ? 'SAME' : 'IDENTITY_UNCERTAIN',
    enumerationInconsistencyCause: null,
    provenance: 'UNCHANGED'
  };
}

console.log('Testing VerdictAuthority Fail-Closed Invariants...');

// 1. Incomplete closure produces UNKNOWN (never PRESERVED)
{
  const evidence = createBaseEvidence();
  evidence.closures.override = incompleteClosureEvidence;
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '1. Incomplete closure MUST yield UNKNOWN');
  assert(res.auditTrace?.authorityDecision.reason === 'INCOMPLETE_CLOSURE', '1. Authority MUST record incomplete closure reason');
}

// 2. All consumers resolved + compatible -> PRESERVED
{
  const evidence = createBaseEvidence();
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'PRESERVED', '2. All consumers resolved + compatible MUST yield PRESERVED');
  assert(res.auditTrace?.authorityDecision.reason === 'ALL_EVALUABLE_COMPATIBLE', '2. Authority MUST record preserved branch');
}

// 3. One unresolved consumer -> UNKNOWN (never PRESERVED)
{
  const evidence = createBaseEvidence();
  const unresolvedSite = createUsageSite('site-unresolved', false, 'UNRESOLVED');
  evidence.canonicalOccurrences = [unresolvedSite];

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '3. Unresolved consumer MUST yield UNKNOWN');
  assert(res.auditTrace?.authorityDecision.reason === 'UNCERTAIN_IDENTITY', '3. Authority MUST record identity reason');
}

// 4. Mixed: 1 compatible consumer + 1 unresolved consumer -> UNKNOWN (never PRESERVED)
{
  const evidence = createBaseEvidence();
  const compatibleSite = createUsageSite('site-compat');
  const unresolvedSite = createUsageSite('site-unresolved', false, 'UNRESOLVED');
  evidence.canonicalOccurrences = [compatibleSite, unresolvedSite];
  evidence.compatibilityResults.set('site-compat', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '4. Compatible + unresolved consumer MUST yield UNKNOWN');
}

// 5. Mixed: 1 compatible consumer + 1 ambiguous consumer -> UNKNOWN
{
  const evidence = createBaseEvidence();
  const compatibleSite = createUsageSite('site-compat');
  const ambiguousSite = createUsageSite('site-ambiguous', false, 'AMBIGUOUS');
  evidence.canonicalOccurrences = [compatibleSite, ambiguousSite];
  evidence.compatibilityResults.set('site-compat', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '5. Compatible + ambiguous consumer MUST yield UNKNOWN');
}

// 6. Mixed: 1 compatible consumer + 1 incomplete closure -> UNKNOWN
{
  const evidence = createBaseEvidence();
  const compatibleSite = createUsageSite('site-compat');
  evidence.canonicalOccurrences = [compatibleSite];
  evidence.compatibilityResults.set('site-compat', { status: 'COMPATIBLE', reason: null });
  evidence.closures.reExport = incompleteClosureEvidence;

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '6. Compatible + incomplete closure MUST yield UNKNOWN');
}

// 7. One undecidable compatibility result -> UNKNOWN
{
  const evidence = createBaseEvidence();
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'UNDECIDABLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '7. Undecidable compatibility result MUST yield UNKNOWN');
  assert(res.auditTrace?.authorityDecision.reason === 'UNDECIDABLE_COMPATIBILITY', '7. Authority MUST record compatibility reason');
}

// 8. One incompatible consumer -> VIOLATED
{
  const evidence = createBaseEvidence();
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'INCOMPATIBLE', reason: 'REQUIRED_PARAMETER_ADDED' });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'VIOLATED', '8. Incompatible consumer MUST yield VIOLATED');
  assert(res.auditTrace?.authorityDecision.reason === 'INCOMPATIBLE_CONSUMER', '8. Authority MUST record violated branch');
}

// Authority branch order remains observable: parse failure wins before closure completeness.
{
  const evidence = createBaseEvidence();
  evidence.analysisUniverse.parseFailures = new Map([['broken.ts', 'syntax error']]);
  evidence.closures.valueReference = incompleteClosureEvidence;
  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', 'parse failure MUST remain UNKNOWN');
  assert(res.auditTrace?.authorityDecision.reason === 'PARSE_FAILURE', 'parse failure MUST retain its existing precedence');
}

// 9. Target-relevant unrecognized form -> isClosureComplete fails -> UNKNOWN
{
  const evidence = createBaseEvidence();
  evidence.closures.valueReference = {
    ...completeClosureEvidence,
    unrecognizedForms: [{
      sourceFile: 'foo.ts',
      sourceSpan: { start: 0, end: 5, line: 1, column: 1 },
      syntaxKind: 999,
      attemptedClassification: 'UNKNOWN',
      cause: 'UNSUPPORTED_AST_FORM',
      isTargetRelevant: true
    }]
  };
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '9. Target-relevant unrecognized form MUST yield UNKNOWN');
}

// 10. Ambiguities present in closure -> isClosureComplete fails -> UNKNOWN
{
  const evidence = createBaseEvidence();
  evidence.closures.reExport = {
    ...completeClosureEvidence,
    ambiguities: [{ location: 'foo.ts', description: 'CYCLIC_REEXPORT' }]
  };
  const site = createUsageSite('site-1');
  evidence.canonicalOccurrences = [site];
  evidence.compatibilityResults.set('site-1', { status: 'COMPATIBLE', reason: null });

  const res = VerdictAuthority.evaluateProof(evidence);
  assert(res.verdict === 'UNKNOWN', '10. Ambiguity in closure MUST yield UNKNOWN');
}

console.log('All VerdictAuthority tests passed successfully!');
