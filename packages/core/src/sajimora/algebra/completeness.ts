import { ClosureCompleteness, ClosureEvidence } from '../types/closure';
import { ResolutionStatus, DeclarationAnchor } from '../types/usage';

/**
 * Meet operator for the ClosureCompleteness semilattice (L, ^):
 * COMPLETE > INCOMPLETE > FAILED
 * FAILED is the annihilator (bottom element), COMPLETE is the identity (top element).
 */
export function meetCompleteness(
  a: ClosureCompleteness,
  b: ClosureCompleteness
): ClosureCompleteness {
  if (a === 'FAILED' || b === 'FAILED') return 'FAILED';
  if (a === 'INCOMPLETE' || b === 'INCOMPLETE') return 'INCOMPLETE';
  return 'COMPLETE';
}

/**
 * Multi-way meet operator over an iterable of completeness states.
 * Short-circuits immediately to FAILED upon encountering any FAILED state.
 */
export function meetAllCompleteness(
  states: Iterable<ClosureCompleteness>
): ClosureCompleteness {
  let hasStates = false;
  let result: ClosureCompleteness = 'COMPLETE';
  for (const s of states) {
    hasStates = true;
    result = meetCompleteness(result, s);
    if (result === 'FAILED') return 'FAILED';
  }
  return hasStates ? result : 'INCOMPLETE';
}

/**
 * Deterministic conservative aggregation policy for resolution statuses.
 * Uncertainty strictly dominates certainty:
 * UNDECIDABLE > AMBIGUOUS > CYCLIC > UNRESOLVED > RESOLVED
 */
export function combineResolutionStatus(
  statuses: Iterable<ResolutionStatus>
): ResolutionStatus {
  let hasResolved = false;
  let hasAmbiguous = false;
  let hasCyclic = false;
  let hasUndecidable = false;
  let hasUnresolved = false;

  for (const status of statuses) {
    if (status === 'UNDECIDABLE') hasUndecidable = true;
    else if (status === 'AMBIGUOUS') hasAmbiguous = true;
    else if (status === 'CYCLIC') hasCyclic = true;
    else if (status === 'UNRESOLVED') hasUnresolved = true;
    else if (status === 'RESOLVED') hasResolved = true;
  }

  if (hasUndecidable) return 'UNDECIDABLE';
  if (hasAmbiguous) return 'AMBIGUOUS';
  if (hasCyclic) return 'CYCLIC';
  if (hasUnresolved) return 'UNRESOLVED';
  if (hasResolved) return 'RESOLVED';
  return 'UNRESOLVED';
}

/**
 * Formal ambiguity poisoning rule:
 * Any occurrence with resolutionStatus AMBIGUOUS or UNDECIDABLE forces closure completeness to INCOMPLETE.
 */
export function enforceAmbiguityPoisoning(evidence: ClosureEvidence): ClosureEvidence {
  const hasUncertainty = evidence.occurrences.some(
    o => o.resolutionStatus !== 'RESOLVED'
  );
  const hasTargetRelevantUnrecognized = evidence.unrecognizedForms?.some(
    f => f.isTargetRelevant
  );
  const hasAmbiguity = (evidence.ambiguities?.length ?? 0) > 0;
  
  if ((hasUncertainty || hasTargetRelevantUnrecognized || hasAmbiguity) && evidence.completeness === 'COMPLETE') {
    return {
      ...evidence,
      completeness: 'INCOMPLETE',
      failures: [
        ...evidence.failures,
        {
          file: 'MULTIPLE',
          cause: hasTargetRelevantUnrecognized
            ? 'UNRECOGNIZED_TARGET_RELEVANT_BINDING_FORM_POISONING'
            : 'AMBIGUITY_OR_UNDECIDABLE_RELATIONSHIP_POISONING'
        }
      ]
    };
  }
  return evidence;
}

/**
 * Injective module identity normalization:
 * Normalizes absolute path relative to workspace root, maintaining POSIX slashes and extension discriminator.
 */
export function normalizeModuleIdentity(absolutePath: string, workspaceRoot: string): string {
  const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPath = absolutePath.replace(/\\/g, '/');
  let rel = normPath;
  if (normPath.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
    rel = normPath.slice(normRoot.length + 1);
  }
  return rel;
}

/**
 * Computes deterministic canonical declaration identity from sorted declaration anchors.
 * Anchors are sorted lexicographically by:
 * (moduleIdentity, symbolLocalName, kind, declarationOrdinal, syntaxKind)
 */
export function computeDeclarationSetIdentity(declarations: DeclarationAnchor[]): string {
  if (declarations.length === 0) {
    return 'UNKNOWN_DECLARATION::anonymous';
  }

  const sorted = [...declarations].sort((a, b) => {
    if (a.moduleIdentity !== b.moduleIdentity) {
      return a.moduleIdentity < b.moduleIdentity ? -1 : 1;
    }
    if (a.symbolLocalName !== b.symbolLocalName) {
      return a.symbolLocalName < b.symbolLocalName ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    if (a.declarationOrdinal !== b.declarationOrdinal) {
      return a.declarationOrdinal - b.declarationOrdinal;
    }
    return a.syntaxKind - b.syntaxKind;
  });

  const anchorStrings = sorted.map(
    a => `${a.moduleIdentity}:${a.declarationOrdinal}:${a.kind}:${a.syntaxKind}:${a.parameterTypeFingerprint}`
  );
  const localName = declarations[0]?.symbolLocalName ?? 'anonymous';
  return `${anchorStrings.join(';')}::${localName}`;
}
