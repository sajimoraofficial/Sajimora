/**
 * @file CertifiedEvaluationOrchestrator.ts
 * End-to-end certification pipeline orchestrating PR1 through PR5 into VerdictAuthority.
 * Guarantees zero-trust:
 * PRODUCER CLAIM != VERIFIED FACT
 * INSUFFICIENT PROOF -> UNKNOWN
 * Never weakens earlier proof, never bypasses VerdictAuthority.
 */

import {
  ProofResult
} from '../../../../../core/src/sajimora/types/verdict';
import {
  CrossVersionIdentityBundle
} from '../../../../../core/src/sajimora/types/identity';
import {
  BlockerCode
} from '../../../../../core/src/sajimora/certified/blockers';
import {
  EnvironmentManifest,
  DependencyClosureCertificate,
  FragmentAdmissionCertificate,
  SemanticObligation,
  SemanticProof,
  CoverageCertificate,
  Phase5EvidenceBundle,
  ResolutionFact
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { VerdictAuthority } from '../../../../../core/src/sajimora/authority/VerdictAuthority';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { EnvironmentVerifier } from '../environment/EnvironmentVerifier';
import { ASTAnchorExtractor } from '../closure/ASTExtractor';
import { F0RestrictedResolver } from '../closure/F0RestrictedResolver';
import { DependencyClosureVerifier } from '../closure/DependencyClosureVerifier';
import { FragmentAdmissionVerifier } from '../fragment/FragmentAdmissionVerifier';
import { FrozenIdentityGate } from '../identity/FrozenIdentityGate';
import { VerificationBudget } from '../proof/VerificationBudget';
import { ObligationVerifier } from '../obligations/ObligationVerifier';
import { ProofChecker } from '../proof/ProofChecker';
import { CoverageVerifier } from '../coverage/CoverageVerifier';
import { CertifiedEvidenceNormalizer } from './CertifiedEvidenceNormalizer';
import { PipelineFeatureFlags, normalizePipelineFeatureFlags } from './PipelineFeatureFlags';
import { TargetScopedEnvelope } from '../fragment/TargetScopedEnvelope';

export interface CertifiedExecutionInput {
  parentManifest: EnvironmentManifest;
  candidateManifest: EnvironmentManifest;
  parentClosure: DependencyClosureCertificate;
  candidateClosure: DependencyClosureCertificate;
  parentClosureFacts?: ResolutionFact[];
  candidateClosureFacts?: ResolutionFact[];
  parentAdmission: FragmentAdmissionCertificate;
  candidateAdmission: FragmentAdmissionCertificate;
  identityBundle: CrossVersionIdentityBundle;
  targetSymbolId: string;
  invariantId: string;
  obligations: SemanticObligation[];
  proofs: SemanticProof[];
  coverage: CoverageCertificate;
  bundle: Phase5EvidenceBundle;
  parentSealedFs: SealedFilesystem;
  candidateSealedFs: SealedFilesystem;
  budget: VerificationBudget;
  /** Experimental admission behavior is opt-in; subsequent certification gates still apply. */
  featureFlags?: Partial<PipelineFeatureFlags>;
  parentTargetScopedEnvelope?: TargetScopedEnvelope;
  candidateTargetScopedEnvelope?: TargetScopedEnvelope;
}

export interface CertifiedExecutionResult {
  verdictResult: ProofResult;
  passedGates: string[];
  failedGate?: string;
  blockerCode?: BlockerCode;
  detailMessage?: string;
}

export class CertifiedEvaluationOrchestrator {
  /**
   * Executes the complete zero-trust Phase 5 certification pipeline leading to VerdictAuthority.
   */
  public static evaluate(input: CertifiedExecutionInput): CertifiedExecutionResult {
    const passedGates: string[] = [];
    // Normalize at the trust boundary. Target-scoped fragment admission is
    // available only through this explicit experimental flag; all later
    // certification gates remain required.
    const featureFlags = normalizePipelineFeatureFlags(input.featureFlags);
    const {
      parentManifest,
      candidateManifest,
      parentClosure,
      candidateClosure,
      parentAdmission,
      candidateAdmission,
      identityBundle,
      targetSymbolId,
      invariantId,
      obligations,
      proofs,
      coverage,
      bundle,
      parentSealedFs,
      candidateSealedFs,
      budget
    } = input;

    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 1: BUNDLE INTEGRITY & PROTOCOL COMPLIANCE
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      budget.checkCancellation();
      budget.allocate('WORK_UNITS', 10);

      if (bundle.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'BUNDLE_INTEGRITY', 'DISCOVERY_FAILURE'),
          passedGates,
          failedGate: 'BUNDLE_INTEGRITY',
          blockerCode: BlockerCode.INVALID_SCHEMA,
          detailMessage: `Bundle has invalid schemaVersion: ${bundle.schemaVersion}`
        };
      }

      const expectedParentDigest = hashContract(
        ArtifactDomain.MANIFEST,
        parentManifest.schemaVersion,
        parentManifest
      );
      const expectedCandidateDigest = hashContract(
        ArtifactDomain.MANIFEST,
        candidateManifest.schemaVersion,
        candidateManifest
      );

      if (
        bundle.parentEnvironmentRef.digest !== expectedParentDigest ||
        bundle.candidateEnvironmentRef.digest !== expectedCandidateDigest
      ) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'BUNDLE_INTEGRITY', 'DISCOVERY_FAILURE'),
          passedGates,
          failedGate: 'BUNDLE_INTEGRITY',
          blockerCode: BlockerCode.HASH_MISMATCH,
          detailMessage: 'Bundle environment reference digest mismatch'
        };
      }

      passedGates.push('BUNDLE_INTEGRITY');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 2: SEALED ENVIRONMENT (PR2)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const parentDataEntries = parentManifest.namespace.files.map(f => ({
        digest: f.bytesRef.digest,
        data: parentSealedFs.readBytes(f.logicalPath)
      }));
      const parentEnvVerifier = new EnvironmentVerifier(
        parentManifest,
        parentDataEntries,
        budget,
        expectedParentDigest
      );
      const parentEnvRes = parentEnvVerifier.verify();
      if (parentEnvRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'ENVIRONMENT', 'DISCOVERY_FAILURE'),
          passedGates,
          failedGate: 'ENVIRONMENT',
          blockerCode: parentEnvRes.status === 'REJECTED' ? parentEnvRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: parentEnvRes.status === 'REJECTED' ? parentEnvRes.detail.message : 'Resource exhausted'
        };
      }

      const candDataEntries = candidateManifest.namespace.files.map(f => ({
        digest: f.bytesRef.digest,
        data: candidateSealedFs.readBytes(f.logicalPath)
      }));
      const candEnvVerifier = new EnvironmentVerifier(
        candidateManifest,
        candDataEntries,
        budget,
        expectedCandidateDigest
      );
      const candEnvRes = candEnvVerifier.verify();
      if (candEnvRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'ENVIRONMENT', 'DISCOVERY_FAILURE'),
          passedGates,
          failedGate: 'ENVIRONMENT',
          blockerCode: candEnvRes.status === 'REJECTED' ? candEnvRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: candEnvRes.status === 'REJECTED' ? candEnvRes.detail.message : 'Resource exhausted'
        };
      }

      passedGates.push('SEALED_ENVIRONMENT');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 3: DEPENDENCY CLOSURE FIXED POINT (PR3)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const parentExtractor = new ASTAnchorExtractor();
      const parentResolver = new F0RestrictedResolver(parentSealedFs, budget);
      const parentClosureVerifier = new DependencyClosureVerifier(
        parentSealedFs,
        parentExtractor,
        parentResolver,
        budget,
        parentManifest
      );
      const parentClosureRes = parentClosureVerifier.verify(parentClosure, {
        manifest: parentManifest,
        facts: input.parentClosureFacts
      });
      if (parentClosureRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'CLOSURE_COMPLETENESS', 'INCOMPLETE_CLOSURE'),
          passedGates,
          failedGate: 'CLOSURE_COMPLETENESS',
          blockerCode: parentClosureRes.status === 'REJECTED' ? parentClosureRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: parentClosureRes.status === 'REJECTED' ? parentClosureRes.detail.message : 'Resource exhausted'
        };
      }

      const candExtractor = new ASTAnchorExtractor();
      const candResolver = new F0RestrictedResolver(candidateSealedFs, budget);
      const candClosureVerifier = new DependencyClosureVerifier(
        candidateSealedFs,
        candExtractor,
        candResolver,
        budget,
        candidateManifest
      );
      const candClosureRes = candClosureVerifier.verify(candidateClosure, {
        manifest: candidateManifest,
        facts: input.candidateClosureFacts
      });
      if (candClosureRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'CLOSURE_COMPLETENESS', 'INCOMPLETE_CLOSURE'),
          passedGates,
          failedGate: 'CLOSURE_COMPLETENESS',
          blockerCode: candClosureRes.status === 'REJECTED' ? candClosureRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: candClosureRes.status === 'REJECTED' ? candClosureRes.detail.message : 'Resource exhausted'
        };
      }

      passedGates.push('DEPENDENCY_CLOSURE');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 4: FRAGMENT ADMISSION & SYNTAX PURITY (PR4)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const parentAdmissionVerifier = new FragmentAdmissionVerifier(parentSealedFs, budget, {
        manifest: parentManifest,
        closureCert: parentClosure,
        enableTargetScopedAdmission: featureFlags.ENABLE_TARGET_SCOPED_ADMISSION,
        targetScopedEnvelope: input.parentTargetScopedEnvelope
      });
      const parentAdmissionRes = parentAdmissionVerifier.verify(parentAdmission);
      if (parentAdmissionRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'SEMANTIC_SCOPE', 'UNSUPPORTED_SEMANTIC_SCOPE'),
          passedGates,
          failedGate: 'SEMANTIC_SCOPE',
          blockerCode: parentAdmissionRes.status === 'REJECTED' ? parentAdmissionRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: parentAdmissionRes.status === 'REJECTED' ? parentAdmissionRes.detail.message : 'Resource exhausted'
        };
      }

      const candAdmissionVerifier = new FragmentAdmissionVerifier(candidateSealedFs, budget, {
        manifest: candidateManifest,
        closureCert: candidateClosure,
        enableTargetScopedAdmission: featureFlags.ENABLE_TARGET_SCOPED_ADMISSION,
        targetScopedEnvelope: input.candidateTargetScopedEnvelope
      });
      const candAdmissionRes = candAdmissionVerifier.verify(candidateAdmission);
      if (candAdmissionRes.status !== 'VERIFIED') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'SEMANTIC_SCOPE', 'UNSUPPORTED_SEMANTIC_SCOPE'),
          passedGates,
          failedGate: 'SEMANTIC_SCOPE',
          blockerCode: candAdmissionRes.status === 'REJECTED' ? candAdmissionRes.blockerCode : BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: candAdmissionRes.status === 'REJECTED' ? candAdmissionRes.detail.message : 'Resource exhausted'
        };
      }

      passedGates.push('FRAGMENT_ADMISSION');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 5: FROZEN IDENTITY GATE & CASE-B PRESERVATION (PR4)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const identityRes = FrozenIdentityGate.evaluateTarget(
        parentManifest,
        candidateManifest,
        targetSymbolId,
        identityBundle,
        parentSealedFs,
        candidateSealedFs
      );

      if (identityRes.status !== 'PROVEN') {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY'),
          passedGates,
          failedGate: 'IDENTITY',
          blockerCode: identityRes.blockerCode || BlockerCode.IDENTITY_MISMATCH,
          detailMessage: identityRes.reason
        };
      }
      if (identityRes.isCaseB &&
          (bundle.identityEvidenceRef.domain !== ArtifactDomain.IDENTITY ||
           bundle.identityEvidenceRef.digest !== identityRes.certifiedCorrespondenceDigest)) {
        return { verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY'),
          passedGates, failedGate: 'IDENTITY', blockerCode: BlockerCode.HASH_MISMATCH,
          detailMessage: 'Case-B identity evidence reference does not bind the verified correspondence' };
      }

      passedGates.push('FROZEN_IDENTITY');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 6: HISTORICAL OBLIGATION INTEGRITY (PR5)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const targetIdentRef = bundle.identityEvidenceRef;
      const lifecycleRef = bundle.identityEvidenceRef;
      const targetLookupName = identityRes.targetMapping?.parent?.localName ?? targetSymbolId;

      const oblRes = ObligationVerifier.verify(
        parentManifest,
        candidateManifest,
        parentSealedFs,
        candidateSealedFs,
        targetLookupName,
        targetIdentRef,
        lifecycleRef,
        obligations,
        budget,
        identityRes.isCaseB ? identityBundle.certifiedCorrespondences?.find(
          record => record.digest === identityRes.certifiedCorrespondenceDigest) : undefined
      );

      if (!oblRes.valid) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'OBLIGATION', 'UNDECIDABLE_COMPATIBILITY'),
          passedGates,
          failedGate: 'OBLIGATION',
          blockerCode: oblRes.blockerCode,
          detailMessage: oblRes.detail?.message
        };
      }

      passedGates.push('OBLIGATION_VERIFICATION');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 7: PROOF DAG REPLAY & REFUTATION (PR5)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 1. Verify every requested obligation has exactly one matching proof
      // 2. Verify every supplied proof corresponds to exactly one requested obligation
      // 3. Reject duplicate, extra, unrelated, or unverified proofs
      // 4. Pass only the verified obligation-bound proof set to downstream gates
      const oblDigests = new Set<string>();
      const verifiedProofs: SemanticProof[] = [];
      const seenProofDigests = new Set<string>();

      for (const obl of obligations) {
        const oblDigest = hashContract(ArtifactDomain.OBLIGATION, obl.schemaVersion, obl);
        oblDigests.add(oblDigest);

        const matchingProofs = proofs.filter(
          p => p.obligationRef.digest === oblDigest
        );

        if (matchingProofs.length === 0) {
          return {
            verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'),
            passedGates,
            failedGate: 'PROOF_VERIFICATION',
            blockerCode: BlockerCode.MISSING_EVIDENCE,
            detailMessage: 'SemanticProof missing for required SemanticObligation'
          };
        }

        if (matchingProofs.length > 1) {
          return {
            verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'),
            passedGates,
            failedGate: 'PROOF_VERIFICATION',
            blockerCode: BlockerCode.INVALID_SCHEMA,
            detailMessage: 'Multiple SemanticProofs supplied for a single SemanticObligation'
          };
        }

        const matchingProof = matchingProofs[0];
        const proofRes = ProofChecker.verify(obl, matchingProof, budget);
        if (!proofRes.valid) {
          return {
            verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'),
            passedGates,
            failedGate: 'PROOF_VERIFICATION',
            blockerCode: proofRes.blockerCode,
            detailMessage: proofRes.detail?.message
          };
        }

        verifiedProofs.push(matchingProof);
        seenProofDigests.add(matchingProof.obligationRef.digest);
      }

      // Verify no extra, duplicate, or unrelated proofs exist in the supplied set
      if (proofs.length !== verifiedProofs.length) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'),
          passedGates,
          failedGate: 'PROOF_VERIFICATION',
          blockerCode: BlockerCode.INVALID_SCHEMA,
          detailMessage: 'Supplied proofs contain extra, duplicate, or unverified proofs not matching requested obligations 1-to-1'
        };
      }

      for (const p of proofs) {
        if (!oblDigests.has(p.obligationRef.digest)) {
          return {
            verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COMPATIBILITY', 'UNDECIDABLE_COMPATIBILITY'),
            passedGates,
            failedGate: 'PROOF_VERIFICATION',
            blockerCode: BlockerCode.INVALID_SCHEMA,
            detailMessage: 'Supplied proof references an unknown or unrequested obligation'
          };
        }
      }

      passedGates.push('PROOF_VERIFICATION');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 8: EXACT COVERAGE & OMISSION TOTALITY (PR5)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const covRes = CoverageVerifier.verify(
        parentManifest,
        candidateManifest,
        parentSealedFs,
        targetLookupName,
        obligations,
        coverage,
        budget
      );

      if (!covRes.valid) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'COVERAGE', 'DISCOVERY_FAILURE'),
          passedGates,
          failedGate: 'COVERAGE',
          blockerCode: covRes.blockerCode,
          detailMessage: covRes.detail?.message
        };
      }

      passedGates.push('COVERAGE_VERIFICATION');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GATE 9: NORMALIZATION & FROZEN VERDICT AUTHORITY
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const unchangedConsumerFiles = new Set<string>();
      for (const obl of obligations) {
        const file = obl.historicalOccurrenceAnchor.fileId;
        if (!parentSealedFs.exists(file) || !candidateSealedFs.exists(file) ||
            !parentSealedFs.readBytes(file).equals(candidateSealedFs.readBytes(file))) {
          return { verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY'),
            passedGates, failedGate: 'IDENTITY', blockerCode: BlockerCode.LIFECYCLE_RULE_VIOLATION,
            detailMessage: `Consumer lifecycle is not verified unchanged: ${file}` };
        }
        unchangedConsumerFiles.add(file);
      }
      const evidence = CertifiedEvidenceNormalizer.normalize(
        bundle,
        targetSymbolId,
        invariantId,
        obligations,
        verifiedProofs,
        coverage,
        { identityProven: true, parentClosureVerified: true, candidateClosureVerified: true,
          parentAdmissionVerified: true, candidateAdmissionVerified: true, coverageVerified: true,
          unchangedConsumerFiles }
      );

      passedGates.push('NORMALIZATION');

      const authoritativeVerdict = VerdictAuthority.evaluateProof(evidence);
      passedGates.push('VERDICT_AUTHORITY');

      return {
        verdictResult: authoritativeVerdict,
        passedGates
      };
    } catch (err: unknown) {
      const isError = err instanceof Error;
      const name = isError ? err.name : (typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : undefined);
      const message = isError ? err.message : (typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err));
      const code = typeof err === 'object' && err !== null && 'detail' in err && typeof (err as any).detail === 'object' && (err as any).detail !== null && 'code' in (err as any).detail ? String((err as any).detail.code) : undefined;

      if (name === 'VerificationBudgetExhaustedError' || code === BlockerCode.RESOURCE_EXHAUSTED) {
        return {
          verdictResult: VerdictAuthority.evaluatePreflight(
            'UNKNOWN',
            'RESOURCE_BUDGET',
            'ENGINE_RUNTIME_FAILURE',
            undefined,
            { name: 'VerificationBudgetExhaustedError', message: message }
          ),
          passedGates,
          failedGate: 'RESOURCE_BUDGET',
          blockerCode: BlockerCode.RESOURCE_EXHAUSTED,
          detailMessage: message
        };
      }

      return {
        verdictResult: VerdictAuthority.evaluatePreflight(
          'UNKNOWN',
          'ENGINE_ERROR',
          'ENGINE_RUNTIME_FAILURE',
          undefined,
          { name: 'CertifiedPipelineError', message: message }
        ),
        passedGates,
        failedGate: 'ENGINE_ERROR',
        detailMessage: message
      };
    }
  }
}
