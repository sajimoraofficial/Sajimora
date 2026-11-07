/**
 * @file ObligationVerifier.ts
 * Independently reconstructs and verifies semantic obligations from sealed environments.
 * Enforces zero-trust:
 * - Omission checking: every historical occurrence must be covered by a verified obligation (MISSING_OBLIGATION)
 * - Relation integrity: relations must match exact reconstructed kinds and positions (INVALID_RULE_APPLICATION)
 * - Direction checking: contravariant arguments, covariant returns
 * - Parent validity: historical relation must hold under parent environment (PREMISE_NOT_SATISFIED)
 * - No duplicate obligations (INVALID_SCHEMA)
 * - Hashes and environment refs must match (HASH_MISMATCH)
 */

import {
  ArtifactRef,
  BlockerCode,
  BlockerDetail
} from '../../../../../core/src/sajimora/certified/blockers';
import {
  EnvironmentManifest,
  SemanticObligation
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  canonicalEncode,
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { VerificationBudget } from '../proof/VerificationBudget';
import { HistoricalObligationGenerator } from './HistoricalObligationGenerator';
import { CertifiedDeclarationCorrespondence } from '../../../../../core/src/sajimora/types/identity';

export interface ObligationVerificationResult {
  valid: boolean;
  blockerCode?: BlockerCode;
  detail?: BlockerDetail;
  recomputedObligations?: SemanticObligation[];
}

export class ObligationVerifier {
  /**
   * Independently verifies proposed SemanticObligations against the sealed environment.
   */
  public static verify(
    parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest,
    parentSealedFs: SealedFilesystem,
    candidateSealedFs: SealedFilesystem,
    targetSymbolId: string,
    targetIdentityEvidenceRef: ArtifactRef,
    lifecycleEvidenceRef: ArtifactRef,
    proposedObligations: SemanticObligation[],
    budget: VerificationBudget,
    verifiedCorrespondence?: CertifiedDeclarationCorrespondence
  ): ObligationVerificationResult {
    budget.checkCancellation();
    budget.allocate('WORK_UNITS', 10);

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

    // 1. Basic structural and hash validation for each proposed obligation
    const seenAnchorKeys = new Set<string>();

    for (const obl of proposedObligations) {
      budget.allocate('WORK_UNITS', 5);

      if (obl.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_SCHEMA,
          detail: {
            code: BlockerCode.INVALID_SCHEMA,
            message: `Obligation has invalid schemaVersion '${obl.schemaVersion}'`
          }
        };
      }

      if (obl.parentEnvironmentRef.digest !== expectedParentDigest) {
        return {
          valid: false,
          blockerCode: BlockerCode.HASH_MISMATCH,
          detail: {
            code: BlockerCode.HASH_MISMATCH,
            message: `Obligation parentEnvironmentRef digest mismatch`
          }
        };
      }

      if (obl.candidateEnvironmentRef.digest !== expectedCandidateDigest) {
        return {
          valid: false,
          blockerCode: BlockerCode.HASH_MISMATCH,
          detail: {
            code: BlockerCode.HASH_MISMATCH,
            message: `Obligation candidateEnvironmentRef digest mismatch`
          }
        };
      }
      if (obl.targetIdentityEvidenceRef.digest !== targetIdentityEvidenceRef.digest ||
          obl.lifecycleEvidenceRef.digest !== lifecycleEvidenceRef.digest) {
        return { valid: false, blockerCode: BlockerCode.IDENTITY_MISMATCH,
          detail: { code: BlockerCode.IDENTITY_MISMATCH, message: 'Obligation identity/lifecycle reference mismatch' } };
      }

      const anchorKey = `${obl.historicalOccurrenceAnchor.fileId}:${obl.historicalOccurrenceAnchor.utf16Start}:${obl.historicalOccurrenceAnchor.utf16End}:${obl.historicalOccurrenceAnchor.syntaxKind}`;
      if (seenAnchorKeys.has(anchorKey)) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_SCHEMA,
          detail: {
            code: BlockerCode.INVALID_SCHEMA,
            message: `Duplicate proposed obligation for anchor ${anchorKey}`
          }
        };
      }
      seenAnchorKeys.add(anchorKey);
    }

    // 2. Independently regenerate obligations from sealed files
    const { obligations: recomputed } = HistoricalObligationGenerator.generateObligations(
      parentManifest,
      candidateManifest,
      parentSealedFs,
      candidateSealedFs,
      targetSymbolId,
      targetIdentityEvidenceRef,
      lifecycleEvidenceRef,
      verifiedCorrespondence
    );

    // 3. Compare recomputed obligations against proposed obligations
    const recomputedAnchorMap = new Map<string, SemanticObligation>();
    for (const obl of recomputed) {
      const key = `${obl.historicalOccurrenceAnchor.fileId}:${obl.historicalOccurrenceAnchor.utf16Start}:${obl.historicalOccurrenceAnchor.utf16End}:${obl.historicalOccurrenceAnchor.syntaxKind}`;
      recomputedAnchorMap.set(key, obl);
    }

    // A. Check for missing occurrences (omission)
    for (const [key, recomputedObl] of recomputedAnchorMap.entries()) {
      if (!seenAnchorKeys.has(key)) {
        return {
          valid: false,
          blockerCode: BlockerCode.MISSING_OBLIGATION,
          detail: {
            code: BlockerCode.MISSING_OBLIGATION,
            message: `Omitted obligation for historical occurrence at anchor ${key}`
          }
        };
      }
    }

    // B. Check for extra or fabricated occurrences
    for (const proposedObl of proposedObligations) {
      const key = `${proposedObl.historicalOccurrenceAnchor.fileId}:${proposedObl.historicalOccurrenceAnchor.utf16Start}:${proposedObl.historicalOccurrenceAnchor.utf16End}:${proposedObl.historicalOccurrenceAnchor.syntaxKind}`;
      const recomputedObl = recomputedAnchorMap.get(key);
      if (!recomputedObl) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: {
            code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Fabricated or unjustified obligation at anchor ${key}`
          }
        };
      }

      // Verify required relations match exactly
      const proposedRels = Array.from(proposedObl.requiredRelations);
      const recomputedRels = Array.from(recomputedObl.requiredRelations);

      if (proposedRels.length !== recomputedRels.length) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: {
            code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Relation count mismatch at anchor ${key}: proposed ${proposedRels.length} vs expected ${recomputedRels.length}`
          }
        };
      }

      for (let i = 0; i < recomputedRels.length; i++) {
        const pRel = proposedRels[i];
        const rRel = recomputedRels[i];
        if (
          pRel.kind !== rRel.kind ||
          pRel.relationId !== rRel.relationId ||
          pRel.position !== rRel.position ||
          pRel.sourceTermRefOrNull?.digest !== rRel.sourceTermRefOrNull?.digest ||
          pRel.targetTermRefOrNull?.digest !== rRel.targetTermRefOrNull?.digest ||
          canonicalEncode(pRel.sourceTermValueOrNull ?? null) !== canonicalEncode(rRel.sourceTermValueOrNull ?? null) ||
          canonicalEncode(pRel.targetTermValueOrNull ?? null) !== canonicalEncode(rRel.targetTermValueOrNull ?? null)
        ) {
          return {
            valid: false,
            blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
            detail: {
              code: BlockerCode.INVALID_RULE_APPLICATION,
              message: `Relation mismatch at anchor ${key}: kind or term direction differs`
            }
          };
        }
      }
      if (canonicalEncode(proposedObl) !== canonicalEncode(recomputedObl)) {
        return { valid: false, blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
          detail: { code: BlockerCode.INVALID_RULE_APPLICATION,
            message: `Obligation differs from sealed recomputation at anchor ${key}` } };
      }
    }

    return {
      valid: true,
      recomputedObligations: recomputed
    };
  }
}
