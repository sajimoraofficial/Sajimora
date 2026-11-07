import { ProofObligation } from '../types/obligation';
import { ClosureResult, ClosureEvidence } from '../types/closure';
import { UsageSite } from '../types/usage';
import { AuthoritativeVerdict, ProofResult, AuthoritativeAuditTrace, AuthorityDecisionReason } from '../types/verdict';
import { ObligationSemanticScope } from '../types/obligation';
import { CompatibilityResult } from '../types/compatibility';

export interface CompleteProofEvidence<S> {
  triggerData: any;
  obligation: ProofObligation;
  analysisUniverse: any; // RepositoryAnalysisUniverse
  closures: {
    valueReference: ClosureResult<S> | ClosureEvidence;
    typeReference: ClosureResult<S> | ClosureEvidence;
    inheritance: ClosureResult<S> | ClosureEvidence;
    interfaceImpl: ClosureResult<S> | ClosureEvidence;
    override: ClosureResult<S> | ClosureEvidence;
    reExport: ClosureResult<S> | ClosureEvidence;
    ambientReference: ClosureResult<S> | ClosureEvidence;
  };
  canonicalOccurrences: UsageSite[];
  identityResults: any[];
  compatibilityResults: Map<string, CompatibilityResult>;
  semanticScope: ObligationSemanticScope;
}

function isClosureComplete(closure: ClosureResult<any> | ClosureEvidence | undefined): boolean {
  // A missing closure is never evidence of a complete enumeration.
  if (!closure) return false;
  if ('completeness' in closure && closure.completeness !== undefined) {
    const evidence = closure as ClosureEvidence;
    const hasFailures = (evidence.failures?.length ?? 0) > 0;
    const hasAmbiguities = (evidence.ambiguities?.length ?? 0) > 0;
    const hasTargetRelevantUnrecognized = (evidence.unrecognizedForms?.filter(f => f.isTargetRelevant)?.length ?? 0) > 0;
    return (
      evidence.completeness === 'COMPLETE' &&
      !hasFailures &&
      !hasAmbiguities &&
      !hasTargetRelevantUnrecognized
    );
  }
  const result = closure as ClosureResult<any>;
  return result.status === 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE' &&
    (result.unresolved?.length ?? 0) === 0 && (result.unsupported?.length ?? 0) === 0 &&
    (result.unscannedFiles?.length ?? 0) === 0;
}

export class VerdictAuthority {
  public static evaluatePreflight(
    verdict: 'NOT_APPLICABLE' | 'UNKNOWN',
    gate: string,
    reason: AuthorityDecisionReason,
    internalReason?: ProofResult['internalReason'],
    runtimeFailure?: { name: string; message: string }
  ): ProofResult {
    return {
      verdict,
      ...(internalReason ? { internalReason } : {}),
      auditTrace: {
        authorityDecision: { source: 'VERDICT_AUTHORITY', gate, reason, stage: gate },
        ...(runtimeFailure ? { runtimeFailure } : {})
      }
    };
  }

  private static result<S>(
    evidence: CompleteProofEvidence<S>, verdict: AuthoritativeVerdict,
    gate: string, reason: AuthorityDecisionReason, internalReason?: ProofResult['internalReason']
  ): ProofResult {
    const universe = evidence.analysisUniverse;
    const closures = Object.fromEntries(Object.entries(evidence.closures).map(([name, closure]) => [name, closure]));
    const auditTrace: AuthoritativeAuditTrace = {
      authorityDecision: { source: 'VERDICT_AUTHORITY', gate, reason, stage: gate },
      discovery: universe ? {
        status: universe.discoveryStatus,
        parseFailures: Array.from(universe.parseFailures?.entries?.() ?? []),
        unreadableFiles: universe.unreadableFiles ?? [],
        excludedFiles: Array.from(universe.excludedFiles?.entries?.() ?? [])
      } : undefined,
      target: evidence.obligation.mutatedSymbol ?? undefined,
      mutation: evidence.obligation.providerMutation ? {
        characterization: evidence.obligation.providerMutation,
        contracts: evidence.obligation.providerContracts
      } : undefined,
      consumers: evidence.canonicalOccurrences,
      closures,
      identity: evidence.identityResults,
      compatibility: Array.from(evidence.compatibilityResults.entries()).map(([usageSiteId, result]) => ({ usageSiteId, result })),
      semanticScope: evidence.semanticScope
    };
    return { verdict, ...(internalReason ? { internalReason } : {}), auditTrace };
  }
  
  /**
   * Constructs an authoritative verdict ONLY if the provided evidence 
   * satisfies all algebraic requirements of Sajimora V32.9.
   */
  public static evaluateProof<S>(evidence: CompleteProofEvidence<S>): ProofResult {
    const { closures, canonicalOccurrences, compatibilityResults, semanticScope, analysisUniverse } = evidence;
    
    // 1. §1.1 & §1.5 Normative VIOLATED Check:
    // If any relevant evaluable usage site is proven INCOMPATIBLE, the verdict is VIOLATED,
    // regardless of closure completeness, discovery status, or uncertainty elsewhere.
    for (const site of canonicalOccurrences) {
      if (site.evaluationStatus === 'EVALUABLE') {
        const compResult = compatibilityResults.get(site.usageSiteId);
        if (compResult && compResult.status === 'INCOMPATIBLE') {
          return this.result(evidence, 'VIOLATED', 'VIOLATED_CHECK', 'INCOMPATIBLE_CONSUMER');
        }
      }
    }

    // 2. Check repository analysis universe completeness
    if (analysisUniverse) {
      if (analysisUniverse.discoveryStatus !== 'DISCOVERY_COMPLETE') {
        return this.result(evidence, 'UNKNOWN', 'UNIVERSE_DISCOVERY', 'DISCOVERY_FAILURE');
      }
      if (analysisUniverse.parseFailures && analysisUniverse.parseFailures.size > 0) {
        return this.result(evidence, 'UNKNOWN', 'UNIVERSE_PARSE', 'PARSE_FAILURE');
      }
      if (analysisUniverse.unreadableFiles && analysisUniverse.unreadableFiles.length > 0) {
        return this.result(evidence, 'UNKNOWN', 'UNIVERSE_READABILITY', 'UNREADABLE_INPUT');
      }

    } else {
      return this.result(evidence, 'UNKNOWN', 'ANALYSIS_UNIVERSE', 'MISSING_ANALYSIS_UNIVERSE');
    }
    
    // 3. Check enumeration completeness
    const allClosuresComplete = 
      isClosureComplete(closures.valueReference) &&
      isClosureComplete(closures.typeReference) &&
      isClosureComplete(closures.inheritance) &&
      isClosureComplete(closures.interfaceImpl) &&
      isClosureComplete(closures.override) &&
      isClosureComplete(closures.reExport) &&
      isClosureComplete(closures.ambientReference);

    if (!allClosuresComplete) {
      return this.result(evidence, 'UNKNOWN', 'CLOSURE_COMPLETENESS', 'INCOMPLETE_CLOSURE');
    }

    // 4. Check semantic scope
    if (semanticScope.unsupportedRelationshipPossible) {
      return this.result(evidence, 'UNKNOWN', 'SEMANTIC_SCOPE', 'UNSUPPORTED_SEMANTIC_SCOPE');
    }

    let allCompatible = true;
    let emptyClosure = true;

    for (const site of canonicalOccurrences) {
      if (site.evaluationStatus === 'EXCLUDED_RE_EXPORTER' || site.evaluationStatus === 'EXCLUDED_REMOVED_VIA_BINDING') {
        continue;
      }

      if (site.evaluationStatus !== 'EVALUABLE' || site.identityResult === 'IDENTITY_UNCERTAIN') {
        return this.result(evidence, 'UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY');
      }

      emptyClosure = false;

      const compResult = compatibilityResults.get(site.usageSiteId);
      if (!compResult || compResult.status === 'UNDECIDABLE') {
        return this.result(evidence, 'UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY');
      }

      if (compResult.status !== 'COMPATIBLE') {
        allCompatible = false;
      }
    }

    if (emptyClosure) {
      return this.result(evidence, 'NOT_APPLICABLE', 'EMPTY_CLOSURE', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'STRUCTURAL_TRIGGER_NO_CONSUMERS');
    }

    if (allCompatible) {
      return this.result(evidence, 'PRESERVED', 'PRESERVED_CHECK', 'ALL_EVALUABLE_COMPATIBLE');
    }

    return this.result(evidence, 'UNKNOWN', 'FALLTHROUGH', 'UNKNOWN_FALLTHROUGH');
  }
}
