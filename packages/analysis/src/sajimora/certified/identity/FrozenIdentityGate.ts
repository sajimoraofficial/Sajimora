import {
  CrossVersionIdentityBundle,
  CrossVersionSymbolMapping,
  CrossVersionConsumerMapping
} from '../../../../../core/src/sajimora/types/identity';
import { EnvironmentManifest } from '../../../../../core/src/sajimora/certified/contracts';
import { BlockerCode } from '../../../../../core/src/sajimora/certified/blockers';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { CertifiedCorrespondence } from './CertifiedCorrespondence';
import { canonicalEncode } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { classifyF0DirectExportCallability } from './F0ExportCallability';

export interface FrozenIdentityGateResult {
  status: 'PROVEN' | 'UNRESOLVED' | 'REJECTED';
  targetMapping?: CrossVersionSymbolMapping;
  isCaseB?: boolean;
  certifiedCorrespondenceDigest?: string;
  blockerCode?: BlockerCode;
  reason: string;
}

export interface DiffEvidence {
  parentPath: string;
  candidatePath?: string;
}

export class FrozenIdentityGate {
  /**
   * Evaluates and enforces strict frozen identity invariants on the CrossVersionIdentityBundle.
   * Enforces:
   * 1. Target declaration in a modified file (Case-B) MUST remain UNRESOLVED.
   *    Any claim of SAME_DECLARATION for a modified file is rejected fail-closed with IDENTITY_MISMATCH.
   * 2. Absence of a candidate declaration cannot be inferred as deletion without candidate absence proof.
   *    Promoting UNRESOLVED to REMOVED_DECLARATION without proof is rejected with IDENTITY_MISMATCH.
   * 3. Case-A (unmodified file) requires byte-identical verification in SealedFilesystem.
   * 4. Consumer lifecycle claims must be consistent with file modification evidence.
   */
  public static evaluateTarget(
    parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest,
    targetSymbolId: string,
    bundle: CrossVersionIdentityBundle,
    parentSealedFs: SealedFilesystem,
    candidateSealedFs: SealedFilesystem,
    diffs?: DiffEvidence[]
  ): FrozenIdentityGateResult {
    // 1. Locate target mapping
    const targetMappings = bundle.targetMappings.filter(
      m => m.parent?.identityId === targetSymbolId || m.candidate?.identityId === targetSymbolId
    );
    const mapping = targetMappings[0];

    if (targetMappings.length > 1) {
      return { status: 'REJECTED', blockerCode: BlockerCode.IDENTITY_MISMATCH,
        reason: `Duplicate target mappings for '${targetSymbolId}'` };
    }

    if (!mapping) {
      return {
        status: 'REJECTED',
        blockerCode: BlockerCode.IDENTITY_MISMATCH,
        reason: `Target symbol '${targetSymbolId}' not found in CrossVersionIdentityBundle targetMappings`
      };
    }

    if (!mapping.parent) {
      // Added declaration in candidate, not an existing historical target
      return {
        status: 'REJECTED',
        blockerCode: BlockerCode.IDENTITY_MISMATCH,
        reason: `Target symbol '${targetSymbolId}' has no parent declaration in identity mapping`
      };
    }

    const parentModule = mapping.parent.moduleIdentity;

    // 2. Check if parent module was modified in candidate
    let isModified = false;

    if (diffs && diffs.length > 0) {
      isModified = diffs.some(
        d =>
          d.parentPath.toLowerCase().replace(/\\/g, '/') ===
          parentModule.toLowerCase().replace(/\\/g, '/')
      );
    } else {
      // Check byte identity across sealed filesystems
      if (!parentSealedFs.exists(parentModule) || !candidateSealedFs.exists(parentModule)) {
        isModified = true;
      } else {
        const parentBytes = parentSealedFs.readBytes(parentModule);
        const candidateBytes = candidateSealedFs.readBytes(parentModule);
        if (parentBytes.compare(candidateBytes) !== 0) {
          isModified = true;
        }
      }
    }

    // 3. Case-B Verification
    if (isModified) {
      if (mapping.status === 'AMBIGUOUS') {
        return { status: 'UNRESOLVED', blockerCode: BlockerCode.IDENTITY_MISMATCH, isCaseB: true,
          reason: 'Ambiguous Case-B declaration correspondence' };
      }
      // Per strict identity constraints: declarations in modified files MUST NOT produce SAME_DECLARATION
      if (mapping.status === 'SAME_DECLARATION') {
        return {
          status: 'REJECTED',
          blockerCode: BlockerCode.IDENTITY_MISMATCH,
          targetMapping: mapping,
          isCaseB: true,
          reason: `Illegal upgrade of Case-B identity: target '${targetSymbolId}' resides in modified file '${parentModule}' but was claimed SAME_DECLARATION`
        };
      }

      const records = bundle.certifiedCorrespondences ?? [];
      const matching = records.filter(r => r.parent.identityId === mapping.parent!.identityId);
      if (matching.length > 1 || records.length !== matching.length) {
        return { status: 'REJECTED', blockerCode: BlockerCode.IDENTITY_MISMATCH, isCaseB: true,
          reason: 'Duplicate or unrelated certified declaration correspondence' };
      }
      if (matching.length === 1) {
        const record = matching[0];
        if (mapping.status !== 'UNRESOLVED' || !mapping.candidate || canonicalEncode(record.parent) !== canonicalEncode(mapping.parent) ||
            canonicalEncode(record.candidate) !== canonicalEncode(mapping.candidate) ||
            !CertifiedCorrespondence.verify(record, parentManifest, candidateManifest,
              parentSealedFs, candidateSealedFs, mapping.parent.identityId)) {
          return { status: 'REJECTED', blockerCode: BlockerCode.IDENTITY_MISMATCH, isCaseB: true,
            reason: 'Certified declaration correspondence does not replay from sealed revisions' };
        }
        return { status: 'PROVEN', targetMapping: mapping, isCaseB: true,
          certifiedCorrespondenceDigest: record.digest,
          reason: 'Unique Case-B declaration correspondence verified from sealed revisions' };
      }

      // Deletion cannot be inferred from a missing candidate alone
      if (!mapping.candidate && mapping.status === 'REMOVED_DECLARATION') {
        const hasDeletionEvidence = mapping.evidence.some(e =>
          e.detail.includes('DECLARATION_DELETED_IN_DIFF_HUNK')
        );
        if (!hasDeletionEvidence) {
          return {
            status: 'REJECTED',
            blockerCode: BlockerCode.IDENTITY_MISMATCH,
            targetMapping: mapping,
            isCaseB: true,
            reason: `Unproven deletion: target '${targetSymbolId}' absent candidate cannot be inferred as REMOVED_DECLARATION without deletion evidence`
          };
        }
        // F0.3 is deliberately narrower than generic deletion: the exact
        // sealed direct export must have changed from a function to one
        // non-callable value.  This establishes deletion of the historical
        // function declaration, not identity of the replacement value.
        const parentCallability = parentSealedFs.exists(parentModule)
          ? classifyF0DirectExportCallability(parentModule, parentSealedFs.readBytes(parentModule), mapping.parent.localName)
          : { status: 'UNSUPPORTED' as const, reason: 'Parent module absent' };
        const candidateCallability = candidateSealedFs.exists(parentModule)
          ? classifyF0DirectExportCallability(parentModule, candidateSealedFs.readBytes(parentModule), mapping.parent.localName)
          : { status: 'UNSUPPORTED' as const, reason: 'Candidate module absent' };
        const witness = mapping.evidence.find(e => e.detail === 'F0_EXPORT_CALLABILITY_FUNCTION_TO_NONCALLABLE');
        if (parentCallability.status !== 'CALLABLE_FUNCTION' ||
            candidateCallability.status !== 'NONCALLABLE_VALUE' || !witness) {
          return { status: 'REJECTED', blockerCode: BlockerCode.IDENTITY_MISMATCH, targetMapping: mapping, isCaseB: true,
            reason: 'Removed declaration lacks a sealed function-to-non-callable export witness' };
        }
        return { status: 'PROVEN', targetMapping: mapping, isCaseB: true,
          certifiedCorrespondenceDigest: witness.evidenceId,
          reason: 'Sealed F0 function declaration removal and non-callable export replacement verified' };
      }

      // Valid Case-B remains UNRESOLVED fail-closed
      if (mapping.status === 'UNRESOLVED') {
        return {
          status: 'UNRESOLVED',
          targetMapping: mapping,
          isCaseB: true,
          reason: `Target declaration '${targetSymbolId}' in modified file '${parentModule}' has UNRESOLVED identity (Case-B)`
        };
      }

      return {
        status: 'UNRESOLVED',
        targetMapping: mapping,
        isCaseB: true,
        reason: `Target declaration '${targetSymbolId}' in modified file '${parentModule}' status is ${mapping.status}`
      };
    }

    // 4. Case-A Verification (Unmodified file)
    if (!parentSealedFs.exists(parentModule) || !candidateSealedFs.exists(parentModule)) {
      return {
        status: 'REJECTED',
        blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        reason: `Module '${parentModule}' missing in SealedFilesystem`
      };
    }

    const pBytes = parentSealedFs.readBytes(parentModule);
    const cBytes = candidateSealedFs.readBytes(parentModule);
    if (pBytes.compare(cBytes) !== 0) {
      return {
        status: 'REJECTED',
        blockerCode: BlockerCode.IDENTITY_MISMATCH,
        reason: `Module '${parentModule}' bytes differ between parent and candidate; Case-A assumption violated`
      };
    }

    if (mapping.status === 'SAME_DECLARATION') {
      return {
        status: 'PROVEN',
        targetMapping: mapping,
        isCaseB: false,
        reason: `Target declaration '${targetSymbolId}' in unmodified file '${parentModule}' proven SAME_DECLARATION (Case-A)`
      };
    }

    return {
      status: 'UNRESOLVED',
      targetMapping: mapping,
      isCaseB: false,
      reason: `Target declaration '${targetSymbolId}' in unmodified file '${parentModule}' has status ${mapping.status}`
    };
  }

  /**
   * Verifies consumer mappings in the bundle to ensure no invalid identity or lifecycle claims.
   */
  public static evaluateConsumers(
    targetResult: FrozenIdentityGateResult,
    bundle: CrossVersionIdentityBundle,
    diffs?: DiffEvidence[]
  ): { valid: boolean; blockerCode?: BlockerCode; reason?: string } {
    for (const cm of bundle.consumerMappings) {
      // If target is Case-B, consumer mapping targetIdentity cannot be claimed SAME
      if (targetResult.isCaseB && targetResult.status !== 'PROVEN' && cm.targetIdentity === 'SAME') {
        return {
          valid: false,
          blockerCode: BlockerCode.IDENTITY_MISMATCH,
          reason: `Consumer mapping '${cm.mappingId}' claims targetIdentity SAME, but target is Case-B UNRESOLVED`
        };
      }

      // If consumer parent occurrence is in a modified file, it cannot be STABLE_UNCHANGED
      if (cm.lifecycle === 'STABLE_UNCHANGED' && diffs && diffs.length > 0) {
        // If evidence shows modified file
        const occFile = cm.evidence.find(e => e.parentLocation)?.parentLocation?.file;
        if (occFile) {
          const isMod = diffs.some(
            d => d.parentPath.toLowerCase().replace(/\\/g, '/') === occFile.toLowerCase().replace(/\\/g, '/')
          );
          if (isMod) {
            return {
              valid: false,
              blockerCode: BlockerCode.LIFECYCLE_RULE_VIOLATION,
              reason: `Consumer mapping '${cm.mappingId}' in modified file '${occFile}' cannot be marked STABLE_UNCHANGED`
            };
          }
        }
      }
    }

    return { valid: true };
  }
}
