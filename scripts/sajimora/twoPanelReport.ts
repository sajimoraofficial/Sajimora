import { Phase1Artifact } from './artifact';
import { AdvisoryImpactResult, AdvisoryVerdict } from '../../packages/analysis/src/sajimora/advisory/TypeScriptImpactAnalyzer';

export interface TwoPanelReportOptions {
  color?: boolean;
}

/**
 * Formats a clear two-panel user-facing report:
 *  - Panel 1: Certified Verdict Authority (100% sound proof tree, Gate precedence, SHA-256 witnesses)
 *  - Panel 2: Advisory Impact Analysis (Heuristic blast radius, consumer diagnostic diffs)
 *
 * CRITICAL SAFETY INVARIANT:
 * Advisory analysis findings can NEVER upgrade a Certified UNKNOWN to PRESERVED.
 */
export function formatTwoPanelReport(
  artifact: Phase1Artifact,
  advisory?: AdvisoryImpactResult,
  _options: TwoPanelReportOptions = {}
): string {
  const lines: string[] = [];
  const primaryResult = artifact.analysis.results[0];
  const certifiedVerdict = primaryResult?.verdict ?? 'UNKNOWN';
  const gate = primaryResult?.authority?.gate ?? 'PREFLIGHT_GATE';
  const reason = primaryResult?.authority?.reason ?? 'UNKNOWN_REASON';
  const target = primaryResult?.target ? `${primaryResult.target.name} (${primaryResult.target.file}:${primaryResult.target.line})` : 'REPOSITORY_WIDE';

  // Certified panel witnesses
  const witnesses = artifact.semanticCompatibility?.witnesses ?? [];
  const blockers = artifact.semanticCompatibility?.blockerSummary ?? [];

  // Final routing enforcement
  let effectiveVerdict = certifiedVerdict;
  if (certifiedVerdict === 'UNKNOWN' && advisory?.verdict === 'LIKELY_PRESERVED') {
    // Non-negotiable invariant: Advisory findings CANNOT upgrade UNKNOWN to PRESERVED
    effectiveVerdict = 'UNKNOWN';
  }

  lines.push('================================================================');
  lines.push('                      SAJIMORA VERDICT REPORT                   ');
  lines.push('================================================================');
  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push(' [PANEL 1: CERTIFIED VERDICT AUTHORITY (ADMITTED PROFILE AND ASSUMPTIONS)]');
  lines.push('----------------------------------------------------------------');
  lines.push(` Authoritative Verdict: ${certifiedVerdict}`);
  lines.push(` Precedence Gate:       ${gate}`);
  lines.push(` Decision Reason:       ${reason}`);
  lines.push(` Target Symbol:         ${target}`);
  if (witnesses.length > 0) {
    lines.push(` Incompatibility Witnesses (${witnesses.length}):`);
    for (const w of witnesses.slice(0, 3)) {
      lines.push(`   • [${w.witnessId}] ${w.failedRelation}: ${w.parentType.display} -> ${w.candidateType.display}`);
    }
    if (witnesses.length > 3) lines.push(`   • ... and ${witnesses.length - 3} more`);
  }
  if (blockers.length > 0) {
    lines.push(` Soundness Blockers (${blockers.length}):`);
    for (const b of blockers.slice(0, 3)) {
      lines.push(`   • [${b.blockerId}] (${b.snapshot}): ${b.detail}`);
    }
  }

  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push(' [PANEL 2: ADVISORY IMPACT ANALYSIS (HEURISTIC BLAST RADIUS)]   ');
  lines.push('----------------------------------------------------------------');

  if (advisory) {
    lines.push(` Advisory Verdict:      ${advisory.verdict}`);
    lines.push(` Certification Status:  ADVISORY_ONLY (Never overrides Certified Panel)`);
    lines.push(` Consumers Analyzed:    ${advisory.consumers.length}`);
    lines.push(` Impacted Sites:        ${advisory.impacts.length}`);
    lines.push(` Compiler Version:      TypeScript ${advisory.compilerVersion}`);
    lines.push(` Completeness:          ${advisory.completeness.status}`);
    if (advisory.completeness.unresolvedFiles.length > 0) {
      lines.push(` Unresolved Modules:    ${advisory.completeness.unresolvedFiles.slice(0, 3).join(', ')}${advisory.completeness.unresolvedFiles.length > 3 ? ' ...' : ''}`);
    }
    const newlyFailing = advisory.impacts.filter(i => i.classification === 'NEWLY_FAILING');
    if (newlyFailing.length > 0) {
      lines.push(` Fresh Compiler Errors: ${newlyFailing.length} breaking consumer sites`);
    }
  } else {
    lines.push(' Advisory Status:       NOT_EVALUATED (Certified execution only)');
  }

  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push(` FINAL RELEASE GATE VERDICT: ${effectiveVerdict}`);
  lines.push('================================================================');

  return lines.join('\n');
}

/**
 * Asserts the safety invariant that advisory findings cannot upgrade UNKNOWN to PRESERVED.
 */
export function enforceVerdictAuthorityInvariant(
  certified: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE',
  advisory: AdvisoryVerdict
): 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE' {
  if (certified === 'UNKNOWN' && advisory === 'LIKELY_PRESERVED') {
    return 'UNKNOWN';
  }
  if (certified === 'PRESERVED' && advisory === 'LIKELY_VIOLATED') {
    // If certified proven preserved, authority rules.
    return 'PRESERVED';
  }
  return certified;
}
