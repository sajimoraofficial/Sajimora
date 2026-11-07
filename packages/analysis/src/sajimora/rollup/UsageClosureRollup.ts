import {
  ClosureEvidence,
  ClosureCompleteness,
  CanonicalReferenceOccurrence,
  ResolutionStatus,
  ProvenanceHop,
  UnrecognizedBindingForm,
  meetAllCompleteness,
  combineResolutionStatus
} from '@sajimora/core';

export interface RollupResult {
  occurrences: CanonicalReferenceOccurrence[];
  completeness: ClosureCompleteness;
  failures: { file: string; cause: string }[];
  ambiguities: { location: string; description: string }[];
  unrecognizedForms: UnrecognizedBindingForm[];
  provenance: ProvenanceHop[];
}

export class UsageClosureRollup {
  /**
   * Aggregates evidence across all semantic closures without ever converting
   * incompleteness into absence or discarding failure provenance.
   */
  public static rollup(closures: ClosureEvidence[]): RollupResult {
    // 1. Compute meet of all completeness states
    const completeness = meetAllCompleteness(closures.map(c => c.completeness));

    // 2. Accumulate all failures, ambiguities, and unrecognized forms
    const failures: { file: string; cause: string }[] = [];
    const ambiguities: { location: string; description: string }[] = [];
    const unrecognizedForms: UnrecognizedBindingForm[] = [];
    const allProvenance: ProvenanceHop[] = [];

    for (const c of closures) {
      failures.push(...c.failures);
      ambiguities.push(...c.ambiguities);
      unrecognizedForms.push(...c.unrecognizedForms);
      allProvenance.push(...c.provenance);
    }

    // 3. Deduplicate occurrences on 6-tuple identity key while preserving union of evidence
    // IdentityKey = (referencedSymbol, declarationSymbol, semanticRole, usageRole, sourceFile, sourceSpan)
    const groupedOccurrences = new Map<string, CanonicalReferenceOccurrence[]>();

    for (const c of closures) {
      for (const occ of c.occurrences) {
        const key = [
          occ.referencedSymbol,
          occ.declarationSymbol,
          occ.semanticRole,
          occ.usageRole,
          occ.sourceFile,
          occ.sourceSpan.start,
          occ.sourceSpan.end
        ].join('|');

        const group = groupedOccurrences.get(key) ?? [];
        group.push(occ);
        groupedOccurrences.set(key, group);
      }
    }

    const deduplicatedOccurrences: CanonicalReferenceOccurrence[] = [];

    for (const [key, group] of groupedOccurrences.entries()) {
      const first = group[0];

      // Conservative resolution aggregation
      const combinedResolution = combineResolutionStatus(group.map(g => g.resolutionStatus));

      // Merge and deduplicate provenance hops
      const mergedProvenance: ProvenanceHop[] = [];
      const seenHops = new Set<string>();

      for (const g of group) {
        for (const hop of g.provenance) {
          const hopKey = `${hop.hopKind}:${hop.fromModuleIdentity}:${hop.toModuleIdentity}:${hop.symbolName}`;
          if (!seenHops.has(hopKey)) {
            seenHops.add(hopKey);
            mergedProvenance.push(hop);
          }
        }
      }

      // Enumeration status: if any group member is INCOMPLETE or FAILED, propagate
      let combinedEnumeration: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE';
      if (group.some(g => g.enumerationStatus === 'FAILED')) {
        combinedEnumeration = 'FAILED';
      } else if (group.some(g => g.enumerationStatus === 'INCOMPLETE')) {
        combinedEnumeration = 'INCOMPLETE';
      }

      deduplicatedOccurrences.push({
        occurrenceId: first.occurrenceId,
        sourceFile: first.sourceFile,
        consumerFile: first.consumerFile,
        sourceSpan: first.sourceSpan,
        location: first.location,
        syntaxKind: first.syntaxKind,
        semanticRole: first.semanticRole,
        usageRole: first.usageRole,
        referencedSymbol: first.referencedSymbol,
        declarationSymbol: first.declarationSymbol,
        resolutionStatus: combinedResolution,
        enumerationStatus: combinedEnumeration,
        provenance: mergedProvenance
      });
    }

    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    deduplicatedOccurrences.sort((a, b) =>
      cmp(a.sourceFile, b.sourceFile) ||
      a.sourceSpan.start - b.sourceSpan.start ||
      a.sourceSpan.end - b.sourceSpan.end ||
      cmp(a.usageRole, b.usageRole)
    );
    failures.sort((a, b) => cmp(a.file, b.file) || cmp(a.cause, b.cause));
    ambiguities.sort((a, b) => cmp(a.location, b.location) || cmp(a.description, b.description));
    unrecognizedForms.sort((a, b) =>
      cmp(a.sourceFile ?? '', b.sourceFile ?? '') ||
      (a.sourceSpan?.start ?? -1) - (b.sourceSpan?.start ?? -1)
    );

    return {
      occurrences: deduplicatedOccurrences,
      completeness,
      failures,
      ambiguities,
      unrecognizedForms,
      provenance: allProvenance
    };
  }
}
