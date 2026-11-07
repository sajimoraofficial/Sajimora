/**
 * @file JavaTwoPanelReport.ts
 * Two-panel user-facing report and serialization engine for Java analysis (Phase J-9).
 *
 * Implements the two-panel representation:
 * - Panel 1: Java proof verification status and blockers.
 * - Panel 2: Advisory Impact Analysis (Multi-module consumer blast radius, AST call sites).
 *
 * Safety Invariant:
 * Advisory findings can NEVER upgrade an uncertified or INCONCLUSIVE result to PRESERVED.
 */

import { JavaAdvisoryImpactResult, JavaAdvisoryVerdict } from './JavaImpactAnalyzer';
import { JavaProofVerificationResult } from '../languages/java/certified/JavaProofChecker';
import { JavaRepositoryQualificationReport } from '../languages/java/programs/JavaRepositoryQualifier';
import { JavaConsumerCertificate } from '../languages/java/certified/JavaPerConsumerCertification';

export interface JavaTwoPanelReportInput {
  readonly repositoryId: string;
  readonly targetSymbol?: string;
  readonly qualification?: JavaRepositoryQualificationReport;
  readonly certifiedProofResult?: JavaProofVerificationResult & {
    readonly obligationDigest?: string;
    readonly ruleDerivations?: readonly string[];
  };
  readonly advisoryResult?: JavaAdvisoryImpactResult;
  readonly consumerCertificates?: readonly JavaConsumerCertificate[];
  readonly options?: {
    readonly color?: boolean;
    readonly showAllConsumers?: boolean;
  };
}

export interface JavaAnalysisJsonV1 {
  readonly schemaVersion: 'SAJIMORA_JAVA_ANALYSIS_V1';
  readonly timestamp: string;
  readonly repositoryId: string;
  readonly targetSymbol: string;
  readonly qualification: {
    readonly status: string;
    readonly buildSystem: string;
    readonly isMultiModule: boolean;
    readonly blockers: readonly any[];
  };
  readonly certifiedPanel: {
    readonly admittedProfile: string | null;
    readonly verifiedConclusion: string;
    readonly obligationDigest: string | null;
    readonly ruleDerivations: readonly string[];
  };
  readonly advisoryPanel: {
    readonly verdict: string;
    readonly consumerCount: number;
    readonly impactedSiteCount: number;
    readonly brokenCount: number;
    readonly compatibleCount: number;
    readonly unaffectedCount: number;
    readonly inconclusiveCount: number;
  };
  readonly consumerCertificates?: readonly any[];
  readonly effectiveVerdict: string;
}

export class JavaTwoPanelReport {
  /**
   * Formats terminal text representation of the two-panel Java report.
   */
  public static formatText(input: JavaTwoPanelReportInput): string {
    const lines: string[] = [];
    const target = input.targetSymbol ?? 'REPOSITORY_WIDE';
    const qual = input.qualification;
    const cert = input.certifiedProofResult;
    const adv = input.advisoryResult;

    // Invariant: Qualification alone can NEVER produce a certified compatibility verdict.
    // Panel 1 verifiedConclusion requires a verified proof (valid: true).
    const certVerdict = (cert && cert.valid && cert.verifiedConclusion) ? cert.verifiedConclusion : 'UNCERTIFIED';
    const advVerdict = adv?.verdict ?? 'NOT_EVALUATED';

    // Enforce safety invariant
    let effectiveVerdict = certVerdict;
    if (certVerdict === 'UNCERTIFIED') {
      if (advVerdict === 'LIKELY_VIOLATED') {
        effectiveVerdict = 'LIKELY_VIOLATED (ADVISORY)';
      } else if (advVerdict === 'LIKELY_PRESERVED') {
        effectiveVerdict = 'LIKELY_PRESERVED (ADVISORY)';
      } else {
        effectiveVerdict = 'INCONCLUSIVE (ADVISORY)';
      }
    }

    lines.push('================================================================');
    lines.push('                 SAJIMORA JAVA TWO-PANEL REPORT                 ');
    lines.push('================================================================');
    lines.push(` Target Repository: ${input.repositoryId}`);
    lines.push(` Target Scope:      ${target}`);
    lines.push(` Build System:      ${qual?.buildSystem ?? 'STANDALONE'} (Multi-Module: ${qual?.isMultiModule ?? false})`);
    lines.push('');

    // PANEL 1
    lines.push('----------------------------------------------------------------');
    lines.push(' [PANEL 1: JAVA PROOF VERIFICATION STATUS]');
    lines.push('----------------------------------------------------------------');
    lines.push(` Profile Admission:    ${qual?.admittedProfile ?? 'DISQUALIFIED (Advisory Fallback)'}`);
    lines.push(` Verified Conclusion:  ${certVerdict}`);
    if (cert && !cert.valid) lines.push(` Proof Blocker:        ${cert.blockerCode ?? 'UNVERIFIED'}: ${cert.reason ?? 'No accepted proof.'}`);
    if (cert?.obligationDigest) {
      lines.push(` Obligation Digest:    ${cert.obligationDigest.slice(0, 16)}...`);
    }
    if (cert?.ruleDerivations && cert.ruleDerivations.length > 0) {
      lines.push(` Applied Proof Rules:  ${cert.ruleDerivations.join(', ')}`);
    }
    if (qual?.blockers && qual.blockers.length > 0) {
      lines.push(` Qualification Blockers (${qual.blockers.length}):`);
      for (const b of qual.blockers.slice(0, 3)) {
        lines.push(`   • [${b.code}] ${b.reason}`);
      }
      if (qual.blockers.length > 3) {
        lines.push(`   • ... and ${qual.blockers.length - 3} more`);
      }
    }

    lines.push('');

    // PANEL 2
    lines.push('----------------------------------------------------------------');
    lines.push(' [PANEL 2: ADVISORY IMPACT ANALYSIS (MULTI-MODULE BLAST RADIUS)]');
    lines.push('----------------------------------------------------------------');
    if (adv) {
      const broken = adv.impacts.filter(i => i.classification === 'LIKELY_BROKEN');
      const compatible = adv.impacts.filter(i => i.classification === 'LIKELY_COMPATIBLE');
      const unaffected = adv.impacts.filter(i => i.classification === 'UNAFFECTED');
      const inconclusive = adv.impacts.filter(i => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT');
      const callSitesCount = adv.consumers.filter(c => c.callSite !== undefined).length;

      lines.push(` Advisory Verdict:     ${adv.verdict}`);
      lines.push(` Certification Status: ADVISORY_ONLY (Never overrides Certified Panel)`);
      lines.push(` Consumers Discovered: ${adv.consumers.length} file(s) across workspace`);
      lines.push(` Consumer Breakdown:   ${broken.length} Broken | ${compatible.length} Compatible | ${unaffected.length} Unaffected | ${inconclusive.length} Inconclusive`);
      lines.push(` Call-Site Tracing:    ${callSitesCount} AST call site(s) inspected`);

      if (broken.length > 0) {
        lines.push(` Breaking Consumers (${broken.length}):`);
        for (const c of broken.slice(0, 5)) {
          const loc = c.line ? `${c.consumerFile}:${c.line}` : c.consumerFile;
          lines.push(`   ❌ ${loc} (${c.referenceKind}): ${c.rationale}`);
        }
        if (broken.length > 5) {
          lines.push(`   • ... and ${broken.length - 5} more broken consumer(s)`);
        }
      }

      if (adv.verdict === 'INCONCLUSIVE') {
        const inconclusiveSites = adv.impacts.filter(i => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT');
        if (adv.abstentionCodes && adv.abstentionCodes.length > 0) {
          lines.push(` Attributed Codes:     ${adv.abstentionCodes.join(', ')}`);
        }
        if (inconclusiveSites.length > 0) {
          lines.push(` Attributed Reasons (${inconclusiveSites.length} sites):`);
          for (const s of inconclusiveSites.slice(0, 5)) {
            const loc = s.line ? `${s.consumerFile}:${s.line}` : s.consumerFile;
            lines.push(`   • ${loc} -> ${s.rationale}`);
          }
          if (inconclusiveSites.length > 5) {
            lines.push(`   • ... and ${inconclusiveSites.length - 5} more site(s)`);
          }
        }
      }
    } else {
      lines.push(' Advisory Status:      NOT_EVALUATED');
    }

    lines.push('');
    lines.push('----------------------------------------------------------------');
    lines.push(` FINAL RELEASE GATE VERDICT: ${effectiveVerdict}`);
    lines.push('================================================================');

    return lines.join('\n');
  }

  /**
   * Formats Markdown representation of the two-panel report.
   */
  public static formatMarkdown(input: JavaTwoPanelReportInput): string {
    const qual = input.qualification;
    const cert = input.certifiedProofResult;
    const adv = input.advisoryResult;

    // Invariant: Qualification alone can NEVER produce a certified compatibility verdict.
    const certVerdict = (cert && cert.valid && cert.verifiedConclusion) ? cert.verifiedConclusion : 'UNCERTIFIED';
    const advVerdict = adv?.verdict ?? 'NOT_EVALUATED';

    let effectiveVerdict = certVerdict;
    if (certVerdict === 'UNCERTIFIED') {
      if (advVerdict === 'LIKELY_VIOLATED') {
        effectiveVerdict = 'LIKELY_VIOLATED (ADVISORY)';
      } else if (advVerdict === 'LIKELY_PRESERVED') {
        effectiveVerdict = 'LIKELY_PRESERVED (ADVISORY)';
      } else {
        effectiveVerdict = 'INCONCLUSIVE (ADVISORY)';
      }
    }

    return `
# Sajimora Java Two-Panel Analysis Report
**Repository:** \`${input.repositoryId}\`  
**Target Scope:** \`${input.targetSymbol ?? 'REPOSITORY_WIDE'}\`  
**Build System:** \`${qual?.buildSystem ?? 'STANDALONE'}\` (Multi-Module: \`${qual?.isMultiModule ?? false}\`)  
**Effective Verdict:** **\`${effectiveVerdict}\`**

---

### Panel 1: Java Proof Verification Status

| Metric | Value | Detail |
|---|---|---|
| **F0 Qualification** | \`${qual?.qualificationStatus ?? 'NOT_QUALIFIED'}\` | Profile: \`${qual?.admittedProfile ?? 'None (Advisory Fallback)'}\` |
| **Verified Conclusion** | **\`${certVerdict}\`** | Subject to source, profile and proof verification |
| **Proof Blocker** | \`${cert?.blockerCode ?? (cert?.valid ? 'None reported' : 'PROOF_UNAVAILABLE')}\` | Qualification alone is not a proof |
| **Obligation Digest** | \`${cert?.obligationDigest?.slice(0, 16) ?? 'N/A'}\` | Content-addressed SHA-256 |
| **Applied Rules** | \`${cert?.ruleDerivations?.join(', ') ?? 'None'}\` | Closed rule registry |

---

### Panel 2: Advisory Impact Analysis (Multi-Module Blast Radius)
| Metric | Value |
|---|---|
| **Advisory Verdict** | **\`${advVerdict}\`** *(Advisory-only; never overrides Certified Panel)* |
| **Consumers Discovered** | **${adv?.consumers.length ?? 0}** file(s) across workspace |
| **Call Sites Analyzed** | **${adv?.consumers.filter(c => c.callSite !== undefined).length ?? 0}** AST body call site(s) |
| **Broken Consumers** | **${adv?.impacts.filter(i => i.classification === 'LIKELY_BROKEN').length ?? 0}** |
| **Compatible Consumers** | **${adv?.impacts.filter(i => i.classification === 'LIKELY_COMPATIBLE').length ?? 0}** |
| **Unaffected Consumers** | **${adv?.impacts.filter(i => i.classification === 'UNAFFECTED').length ?? 0}** |

${adv?.impacts && adv.impacts.filter(i => i.classification === 'LIKELY_BROKEN').length > 0 ? `
#### Breaking Consumer Sites
${adv.impacts.filter(i => i.classification === 'LIKELY_BROKEN').map(c => `- ❌ \`${c.line ? `${c.consumerFile}:${c.line}` : c.consumerFile}\` (\`${c.referenceKind}\`): ${c.rationale}`).join('\n')}
` : ''}

${adv?.verdict === 'INCONCLUSIVE' && adv?.abstentionCodes && adv.abstentionCodes.length > 0 ? `
#### Attributed Reasons (${adv.impacts.filter(i => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT').length} sites)
${adv.abstentionCodes.map(c => `- **Reason Code**: \`${c}\``).join('\n')}
${adv.impacts.filter(i => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT').slice(0, 5).map(s => `- • \`${s.line ? `${s.consumerFile}:${s.line}` : s.consumerFile}\`: ${s.rationale}`).join('\n')}
` : ''}
`.trim();
  }

  /**
   * Serializes analysis into machine-readable JSON matching SAJIMORA_JAVA_ANALYSIS_V1.
   */
  public static toJSON(input: JavaTwoPanelReportInput): JavaAnalysisJsonV1 {
    const qual = input.qualification;
    const cert = input.certifiedProofResult;
    const adv = input.advisoryResult;

    // Invariant: Qualification alone can NEVER produce a certified compatibility verdict.
    const certVerdict = (cert && cert.valid && cert.verifiedConclusion) ? cert.verifiedConclusion : 'UNCERTIFIED';
    const advVerdict = adv?.verdict ?? 'NOT_EVALUATED';

    let effectiveVerdict = certVerdict;
    if (certVerdict === 'UNCERTIFIED') {
      if (advVerdict === 'LIKELY_VIOLATED') {
        effectiveVerdict = 'LIKELY_VIOLATED';
      } else if (advVerdict === 'LIKELY_PRESERVED') {
        effectiveVerdict = 'LIKELY_PRESERVED';
      } else {
        effectiveVerdict = 'INCONCLUSIVE';
      }
    }

    const broken = adv?.impacts.filter(i => i.classification === 'LIKELY_BROKEN').length ?? 0;
    const compatible = adv?.impacts.filter(i => i.classification === 'LIKELY_COMPATIBLE').length ?? 0;
    const unaffected = adv?.impacts.filter(i => i.classification === 'UNAFFECTED').length ?? 0;
    const inconclusive = adv?.impacts.filter(i => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT').length ?? 0;

    return {
      schemaVersion: 'SAJIMORA_JAVA_ANALYSIS_V1',
      timestamp: new Date().toISOString(),
      repositoryId: input.repositoryId,
      targetSymbol: input.targetSymbol ?? 'REPOSITORY_WIDE',
      qualification: {
        status: qual?.qualificationStatus ?? 'UNKNOWN',
        buildSystem: qual?.buildSystem ?? 'STANDALONE',
        isMultiModule: qual?.isMultiModule ?? false,
        blockers: qual?.blockers ?? []
      },
      certifiedPanel: {
        admittedProfile: qual?.admittedProfile ?? null,
        verifiedConclusion: certVerdict,
        obligationDigest: cert?.obligationDigest ?? null,
        ruleDerivations: cert?.ruleDerivations ?? []
      },
      advisoryPanel: {
        verdict: advVerdict,
        consumerCount: adv?.consumers.length ?? 0,
        impactedSiteCount: broken + compatible,
        brokenCount: broken,
        compatibleCount: compatible,
        unaffectedCount: unaffected,
        inconclusiveCount: inconclusive
      },
      consumerCertificates: input.consumerCertificates ?? [],
      effectiveVerdict
    };
  }
}
