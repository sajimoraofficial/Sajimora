import { 
  EnvironmentManifest,
  OpaqueF0Payload
} from '../../../../../core/src/sajimora/certified/contracts';
import { 
  VerificationResult, 
  BlockerCode
} from '../../../../../core/src/sajimora/certified/blockers';
import { VerificationBudget, VerificationBudgetExhaustedError } from '../proof/VerificationBudget';
import { SealedFilesystem } from './SealedFilesystem';
import { computeDomainSeparatedHash, hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, RootPolicyId, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../../core/src/sajimora/certified/protocol';

function isOpaque(obj: any): obj is OpaqueF0Payload {
  return obj && typeof obj === 'object' && obj._opaqueF0Semantics === 'UNRESOLVED';
}

export class EnvironmentVerifier {
  constructor(
    private readonly manifest: EnvironmentManifest,
    private readonly dataEntries: { digest: string; data: Buffer }[],
    private readonly budget: VerificationBudget,
    private readonly expectedManifestDigest: string
  ) {}

  public verify(): VerificationResult {
    try {
      this.budget.allocate('WORK_UNITS', 1);

      // Verify protocol version
      if (this.manifest.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
        return this.reject(BlockerCode.UNSUPPORTED_PROTOCOL, `Unsupported protocol version: ${this.manifest.schemaVersion}`);
      }

      // Verify root policy
      if (this.manifest.rootSelectionPolicyId !== RootPolicyId.F0_ENV_GIT_SEALED_V1) {
        return this.reject(BlockerCode.UNSUPPORTED_CONFIGURATION, `Unsupported root policy: ${this.manifest.rootSelectionPolicyId}`);
      }

      // 1. Verify Manifest Trust Root
      const computedManifestDigest = hashContract(ArtifactDomain.MANIFEST, this.manifest.schemaVersion, this.manifest);
      if (computedManifestDigest !== this.expectedManifestDigest) {
        return this.reject(BlockerCode.HASH_MISMATCH, `Manifest trust-root mismatch. Expected: ${this.expectedManifestDigest}, Actual: ${computedManifestDigest}`);
      }

      // 2. Reject unsupported/opaque semantics
      for (const item of this.manifest.namespace.directoryInventory) {
        if (isOpaque(item)) {
          return this.reject(BlockerCode.UNSUPPORTED_CONFIGURATION, 'Unresolved directory inventory semantics');
        }
      }
      for (const proj of this.manifest.projects) {
        if (isOpaque(proj.effectiveOptions)) {
          return this.reject(BlockerCode.UNSUPPORTED_CONFIGURATION, 'Unresolved effectiveOptions semantics');
        }
      }

      // 3. Delegate namespace validation entirely to SealedFilesystem
      let sealedFs: SealedFilesystem;
      try {
        sealedFs = new SealedFilesystem(this.manifest.namespace.files, this.dataEntries, this.manifest.namespace.caseSensitivity);
      } catch (err: any) {
        return this.reject(BlockerCode.NAMESPACE_INCOMPLETE, err.message);
      }

      // 4. Verify all byte hashes domain-separated
      const dataMap = new Map<string, Buffer>();
      for (const entry of this.dataEntries) {
        this.budget.allocate('INPUT_BYTES', entry.data.length);
        this.budget.allocate('WORK_UNITS', Math.ceil(entry.data.length / 1024));
        
        const hash = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, entry.data);
        if (hash !== entry.digest) {
          return this.reject(BlockerCode.HASH_MISMATCH, `Hash mismatch for supplied bytes. Expected: ${entry.digest}, Actual: ${hash}`);
        }
        dataMap.set(entry.digest, entry.data);
      }

      // 5. Verify all manifest files against dataMap
      for (const file of this.manifest.namespace.files) {
        this.budget.allocate('VERTICES', 1);
        const data = dataMap.get(file.bytesRef.digest);
        if (!data) {
          return this.reject(BlockerCode.ENVIRONMENT_INPUT_MISSING, `Missing byte data for file: ${file.logicalPath}, digest: ${file.bytesRef.digest}`);
        }
        if (data.length !== file.byteLength) {
          return this.reject(BlockerCode.HASH_MISMATCH, `Byte length mismatch for file: ${file.logicalPath}. Expected: ${file.byteLength}, Actual: ${data.length}`);
        }
      }

      // 6. Verify historical basis
      if (this.manifest.environmentBasis !== 'RECORDED_BUILD') {
        return this.reject(BlockerCode.UNSUPPORTED_CONFIGURATION, `Unsupported environment basis: ${this.manifest.environmentBasis}`);
      }

      // 7. Sealed input consistency checks
      if (this.manifest.projects.length === 0) {
        return this.reject(BlockerCode.MISSING_PROJECT_ROOT, `No projects defined in manifest.`);
      }

      for (const proj of this.manifest.projects) {
        for (const root of proj.roots) {
           this.budget.allocate('VERTICES', 1);
        }
      }
      
      return {
        status: 'VERIFIED',
        bundleDigest: computedManifestDigest,
        verifiedClaim: 'ENVIRONMENT_SEALED_AND_CONSISTENT',
        verifiedAuthorityInputDigest: this.expectedManifestDigest,
        replayProfileId: this.manifest.compiler.semanticProfileId
      };
    } catch (e) {
      if (e instanceof VerificationBudgetExhaustedError) {
        return {
          status: 'RESOURCE_EXHAUSTED',
          detail: e.detail
        };
      }
      throw e;
    }
  }

  private reject(code: BlockerCode, message: string): VerificationResult {
    return {
      status: 'REJECTED',
      blockerCode: code,
      detail: { code, message }
    };
  }

  public getSealedFilesystem(): SealedFilesystem {
    return new SealedFilesystem(this.manifest.namespace.files, this.dataEntries, this.manifest.namespace.caseSensitivity);
  }
}

