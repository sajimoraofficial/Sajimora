/**
 * @file JavaCertificationEvaluator.ts
 * Rigorous evaluator assessing repositories, compilation units, and capabilities
 * for promotion into the Java Certified F0 profile per casebgoal.md §Phase 10
 * and java_language_track_architecture.md §8 & §11.
 *
 * Seven Mandatory Promotion Prerequisites:
 * 1. Sealed Evidence: Repository snapshot filesystem with zero host I/O leakage.
 * 2. Deterministic Replay: Bit-for-bit repeatability across repeated runs.
 * 3. Independently Verifiable Resolution: Explicit FQCN resolution without wildcard heuristics.
 * 4. Complete Consumer Coverage: All consumers accounted for in the compilation unit.
 * 5. Explicit Proof Rules: Closed JAVA_F0_RULES_V1 derivations checked by zero-trust verifier.
 * 6. Adversarial Tests: Verified against hostile traps (ADV-01..ADV-10).
 * 7. Stable Benchmark: 100% precision, 0% FPR/FNR.
 */

import {
  JavaSemanticProfileId,
  JavaRuleSetId,
  JavaF0CandidateFile,
  evaluateJavaF0Admission
} from './JavaCertifiedProfile';
import {
  JavaProofChecker,
  JavaSemanticObligation,
  JavaSemanticProof,
  JavaProofVerificationResult
} from './JavaProofChecker';
import {
  JavaProofProducer,
  JavaProofProductionResult
} from './JavaProofProducer';
import { JavaClassDeclIR } from '../ir';
import { JavaSealedCompilerHost } from '../programs/JavaSealedCompilerHost';

export interface JavaPrerequisiteStatus {
  readonly name: string;
  readonly satisfied: boolean;
  readonly evidence: string;
}

export interface JavaCertificationAuditReport {
  readonly evaluationId: string;
  readonly timestamp: string;
  readonly candidateScope: string;
  readonly certificationOutcome: 'PROMOTED_TO_CERTIFIED_F0' | 'RETAINED_IN_ADVISORY' | 'FAIL_CLOSED';
  readonly admittedProfileId: JavaSemanticProfileId | null;
  readonly prerequisites: {
    readonly sealedEvidence: JavaPrerequisiteStatus;
    readonly deterministicReplay: JavaPrerequisiteStatus;
    readonly independentlyVerifiableResolution: JavaPrerequisiteStatus;
    readonly completeConsumerCoverage: JavaPrerequisiteStatus;
    readonly explicitProofRules: JavaPrerequisiteStatus;
    readonly adversarialTests: JavaPrerequisiteStatus;
    readonly stableBenchmark: JavaPrerequisiteStatus;
  };
  readonly fileAdmissions: ReadonlyArray<{
    readonly path: string;
    readonly status: 'ADMITTED_F0' | 'DISQUALIFIED_ADVISORY_ONLY';
    readonly reasons: readonly string[];
  }>;
  readonly proofAuditTrail: ReadonlyArray<{
    readonly obligationId: string;
    readonly relationKind: string;
    readonly proofGenerated: boolean;
    readonly proofVerified: boolean;
    readonly conclusion?: 'COMPATIBLE' | 'INCOMPATIBLE';
    readonly blockerCode?: string;
  }>;
  readonly admittedCapabilities: readonly string[];
  readonly retainedAdvisoryCapabilities: readonly string[];
}

export interface JavaCertificationEvaluationInput {
  readonly candidateId: string;
  readonly files: readonly JavaF0CandidateFile[];
  readonly host?: JavaSealedCompilerHost;
  readonly historicalClasses?: readonly JavaClassDeclIR[];
  readonly candidateClasses?: readonly JavaClassDeclIR[];
  readonly obligations?: readonly JavaSemanticObligation[];
  readonly benchmarkMetrics?: {
    readonly consumerDiscoveryRecall: number;
    readonly falsePositiveRate: number;
    readonly falseNegativeRate: number;
    readonly deterministicRepeatability: number;
  };
  readonly adversarialSuitePassed?: boolean;
}

export class JavaCertificationEvaluator {
  /**
   * Evaluates candidate inputs against all 7 prerequisites for certified promotion.
   */
  public static evaluate(input: JavaCertificationEvaluationInput): JavaCertificationAuditReport {
    const {
      candidateId,
      files,
      historicalClasses = [],
      candidateClasses = [],
      obligations = [],
      benchmarkMetrics,
      adversarialSuitePassed = false
    } = input;

    // 1. File Admissions Evaluation
    const fileAdmissions = files.map(file => {
      const admission = evaluateJavaF0Admission(file);
      return {
        path: file.path,
        status: admission.status,
        reasons: admission.disqualificationReasons
      };
    });

    const anyFileDisqualified = fileAdmissions.some(f => f.status === 'DISQUALIFIED_ADVISORY_ONLY');
    const allFilesAdmitted = files.length > 0 && !anyFileDisqualified;

    // 2. Proof Generation & Zero-Trust Verification for Obligations
    const proofAuditTrail: Array<{
      obligationId: string;
      relationKind: string;
      proofGenerated: boolean;
      proofVerified: boolean;
      conclusion?: 'COMPATIBLE' | 'INCOMPATIBLE';
      blockerCode?: string;
    }> = [];

    let allProofsValid = obligations.length > 0;
    const histClassMap = new Map(historicalClasses.map(c => [c.fqcn, c]));
    const candClassMap = new Map(candidateClasses.map(c => [c.fqcn, c]));

    for (const ob of obligations) {
      const histClass = histClassMap.get(ob.targetFqcn) ?? histClassMap.get(ob.sourceFqcn);
      const candClass = candClassMap.get(ob.targetFqcn) ?? candClassMap.get(ob.sourceFqcn);

      const hasWildcards = files.some(f => f.imports.some(i => i.endsWith('.*') || i.includes('*')));
      const hasReflection = files.some(f => (f.content ?? '').includes('java.lang.reflect'));

      const prodResult = JavaProofProducer.produceProof({
        obligation: ob,
        historicalClass: histClass,
        candidateClass: candClass,
        hasWildcardImports: hasWildcards,
        hasDynamicReflection: hasReflection
      });

      if (!prodResult.success || !prodResult.proof) {
        proofAuditTrail.push({
          obligationId: ob.obligationId,
          relationKind: ob.relationKind,
          proofGenerated: false,
          proofVerified: false,
          blockerCode: prodResult.refused ? 'BOUNDARY_VIOLATION' : 'GENERATION_FAILED'
        });
        allProofsValid = false;
        continue;
      }

      const verifResult = JavaProofChecker.verify(ob, prodResult.proof);
      if (!verifResult.valid) {
        proofAuditTrail.push({
          obligationId: ob.obligationId,
          relationKind: ob.relationKind,
          proofGenerated: true,
          proofVerified: false,
          blockerCode: verifResult.blockerCode
        });
        allProofsValid = false;
      } else {
        proofAuditTrail.push({
          obligationId: ob.obligationId,
          relationKind: ob.relationKind,
          proofGenerated: true,
          proofVerified: true,
          conclusion: verifResult.verifiedConclusion
        });
      }
    }

    // 3. Assess Seven Prerequisites
    const sealedEvidence: JavaPrerequisiteStatus = {
      name: 'Sealed Evidence',
      satisfied: false,
      evidence: 'No independently verified source/environment certificate is supplied by this legacy qualification API.'
    };

    const detRepeat = benchmarkMetrics?.deterministicRepeatability;
    const deterministicReplay: JavaPrerequisiteStatus = {
      name: 'Deterministic Replay',
      satisfied: detRepeat === 100.0,
      evidence: detRepeat === undefined ? 'Repeatability evidence missing.' : `Reported repeatability: ${detRepeat}%; this is qualification data, not a semantic proof.`
    };

    const independentlyVerifiableResolution: JavaPrerequisiteStatus = {
      name: 'Independently Verifiable Resolution',
      satisfied: allFilesAdmitted,
      evidence: allFilesAdmitted
        ? 'All files use explicit single-type imports; zero wildcard or heuristic ambiguity.'
        : 'Disqualified: Wildcard imports or dynamic reflection detected in candidate files.'
    };

    const completeConsumerCoverage: JavaPrerequisiteStatus = {
      name: 'Complete Consumer Coverage',
      satisfied: false,
      evidence: 'No independently checked consumer coverage certificate was supplied.'
    };

    const explicitProofRules: JavaPrerequisiteStatus = {
      name: 'Explicit Proof Rules',
      satisfied: obligations.length > 0 && allProofsValid,
      evidence: allProofsValid
        ? `All ${obligations.length} obligation(s) mathematically proven via JAVA_F0_RULES_V1.`
        : 'One or more obligations failed formal proof verification or boundary check.'
    };

    const adversarialTests: JavaPrerequisiteStatus = {
      name: 'Adversarial Tests',
      satisfied: adversarialSuitePassed,
      evidence: adversarialSuitePassed
        ? 'Verified against 10/10 hostile scenarios in JavaAdversarialMatrix.'
        : 'Adversarial matrix validation incomplete or failed.'
    };

    const fpr = benchmarkMetrics?.falsePositiveRate;
    const fnr = benchmarkMetrics?.falseNegativeRate;
    const stableBenchmark: JavaPrerequisiteStatus = {
      name: 'Stable Benchmark',
      satisfied: fpr === 0.0 && fnr === 0.0,
      evidence: benchmarkMetrics ? `Reported benchmark FPR=${fpr}%, FNR=${fnr}%; not a per-query proof.` : 'Benchmark evidence missing.'
    };

    const allPrerequisitesSatisfied =
      sealedEvidence.satisfied &&
      deterministicReplay.satisfied &&
      independentlyVerifiableResolution.satisfied &&
      completeConsumerCoverage.satisfied &&
      explicitProofRules.satisfied &&
      adversarialTests.satisfied &&
      stableBenchmark.satisfied;

    let certificationOutcome: 'PROMOTED_TO_CERTIFIED_F0' | 'RETAINED_IN_ADVISORY' | 'FAIL_CLOSED';
    let admittedProfileId: JavaSemanticProfileId | null = null;

    if (allPrerequisitesSatisfied && allFilesAdmitted && obligations.length > 0 && allProofsValid) {
      certificationOutcome = 'PROMOTED_TO_CERTIFIED_F0';
      admittedProfileId = JavaSemanticProfileId.JAVA_PUBLIC_API_F0;
    } else {
      certificationOutcome = 'RETAINED_IN_ADVISORY';
    }

    const admittedCapabilities: string[] = [];
    const retainedAdvisoryCapabilities: string[] = [
      'JAVA_METHOD_CALL_SITES',
      'JAVA_WILDCARD_IMPORTS',
      'JAVA_DYNAMIC_REFLECTION_J_X1_X3',
      'JAVA_SPRING_JAKARTA_RUNTIME_DI',
      'JAVA_BYTECODE_TRANSFORMATIONS'
    ];

    if (certificationOutcome === 'PROMOTED_TO_CERTIFIED_F0') {
      admittedCapabilities.push(
        'JAVA_PUBLIC_API_DECLARATION_EXTRACTION',
        'JAVA_NOMINAL_INHERITANCE_PROOF',
        'JAVA_EXPLICIT_FQCN_SYMBOL_RESOLUTION',
        'JAVA_METHOD_SIGNATURE_PRESERVATION_PROOF',
        'JAVA_FIELD_SIGNATURE_PRESERVATION_PROOF',
        'JAVA_CLASS_VISIBILITY_PRESERVATION_PROOF'
      );
    } else {
      retainedAdvisoryCapabilities.push(
        'JAVA_PUBLIC_API_DECLARATION_EXTRACTION',
        'JAVA_NOMINAL_INHERITANCE_PROOF'
      );
    }

    return {
      evaluationId: `cert_eval_${candidateId}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      candidateScope: candidateId,
      certificationOutcome,
      admittedProfileId,
      prerequisites: {
        sealedEvidence,
        deterministicReplay,
        independentlyVerifiableResolution,
        completeConsumerCoverage,
        explicitProofRules,
        adversarialTests,
        stableBenchmark
      },
      fileAdmissions,
      proofAuditTrail,
      admittedCapabilities: Object.freeze(admittedCapabilities),
      retainedAdvisoryCapabilities: Object.freeze(retainedAdvisoryCapabilities)
    };
  }

  /**
   * Renders a human-readable Markdown summary of the certification audit report.
   */
  public static renderMarkdownSummary(report: JavaCertificationAuditReport): string {
    const p = report.prerequisites;
    return `
# Sajimora Java Certification Audit Report (Phase J-7)
**Scope:** \`${report.candidateScope}\`
**Outcome:** \`${report.certificationOutcome}\`
**Admitted Profile:** \`${report.admittedProfileId ?? 'NONE (Advisory Only)'}\`
**Audit Timestamp:** \`${report.timestamp}\`

## Seven Certification Prerequisites Assessment
| Prerequisite | Status | Evidence |
|---|---|---|
| Sealed Evidence | ${p.sealedEvidence.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.sealedEvidence.evidence} |
| Deterministic Replay | ${p.deterministicReplay.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.deterministicReplay.evidence} |
| Independently Verifiable Resolution | ${p.independentlyVerifiableResolution.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.independentlyVerifiableResolution.evidence} |
| Complete Consumer Coverage | ${p.completeConsumerCoverage.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.completeConsumerCoverage.evidence} |
| Explicit Proof Rules | ${p.explicitProofRules.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.explicitProofRules.evidence} |
| Adversarial Tests | ${p.adversarialTests.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.adversarialTests.evidence} |
| Stable Benchmark | ${p.stableBenchmark.satisfied ? '✅ PASS' : '❌ FAIL'} | ${p.stableBenchmark.evidence} |

## Capability Partitioning
- **Admitted Certified F0 Capabilities:**
${report.admittedCapabilities.map(c => `  - \`${c}\``).join('\n') || '  *(None)*'}

- **Retained Advisory-Only Capabilities:**
${report.retainedAdvisoryCapabilities.map(c => `  - \`${c}\``).join('\n')}

## Proof Derivation Audit Trail
**Total Obligations Evaluated:** ${report.proofAuditTrail.length}
${report.proofAuditTrail.map(t => `- Obligation \`${t.obligationId}\` (${t.relationKind}): Generated=${t.proofGenerated}, Verified=${t.proofVerified}, Conclusion=${t.conclusion ?? 'BLOCKED'}`).join('\n') || '*(No formal obligations evaluated)*'}
`.trim();
  }
}
