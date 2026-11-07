import { GitRepository } from '../snapshots/GitRepository';
import { DependencyLookupRecorder, DependencyLookupReceipt } from './DependencyLookupReceipt';
import { CommitManifest } from './GenerationIndexDatabase';

const issueToken = Symbol('SAJIMORA_VERIFIED_DEPENDENCY_ENVIRONMENT');

/** The query engine consumes this receipt without opening Git or compiling.
 * Only this factory can issue a receipt, after checking both immutable Git
 * trees and the current external dependency bytes/links. */
export class VerifiedDependencyEnvironment {
  private static readonly issued = new WeakSet<VerifiedDependencyEnvironment>();

  private constructor(
    token: typeof issueToken,
    private readonly repositoryId: string,
    private readonly parentSha: string,
    private readonly candidateSha: string,
    private readonly parentManifestHash: string,
    private readonly candidateManifestHash: string,
    private readonly parentFingerprint: string,
    private readonly candidateFingerprint: string,
    private readonly dependencyRoot: string,
    private readonly parentReceipt: DependencyLookupReceipt,
    private readonly candidateReceipt: DependencyLookupReceipt
  ) {
    if (token !== issueToken) throw new Error('UNVERIFIED_DEPENDENCY_ENVIRONMENT');
    VerifiedDependencyEnvironment.issued.add(this);
  }

  public static verify(repositoryPath: string, dependencyRoot: string,
    parent: CommitManifest, candidate: CommitManifest): VerifiedDependencyEnvironment {
    const repo = new GitRepository(repositoryPath);
    repo.validate();
    if (!parent.dependencyLookupReceipt || !candidate.dependencyLookupReceipt) {
      throw new Error('DEPENDENCY_LOOKUP_RECEIPT_MISSING');
    }
    DependencyLookupRecorder.verify(dependencyRoot, parent.dependencyLookupReceipt);
    if (candidate.manifestHash !== parent.manifestHash) {
      DependencyLookupRecorder.verify(dependencyRoot, candidate.dependencyLookupReceipt);
    }
    return new VerifiedDependencyEnvironment(issueToken, repo.repositoryId(),
      parent.identity.commitSha, candidate.identity.commitSha,
      parent.manifestHash, candidate.manifestHash,
      parent.dependencyLookupReceipt.fingerprint, candidate.dependencyLookupReceipt.fingerprint,
      dependencyRoot, parent.dependencyLookupReceipt, candidate.dependencyLookupReceipt);
  }

  public static consume(witness: unknown, parent: CommitManifest, candidate: CommitManifest): boolean {
    if (!(witness instanceof VerifiedDependencyEnvironment) || !this.issued.has(witness)) return false;
    this.issued.delete(witness);
    if (parent.identity.repositoryId !== witness.repositoryId || candidate.identity.repositoryId !== witness.repositoryId ||
      parent.identity.commitSha !== witness.parentSha || candidate.identity.commitSha !== witness.candidateSha ||
      parent.manifestHash !== witness.parentManifestHash || candidate.manifestHash !== witness.candidateManifestHash ||
      parent.identity.externalDependencyFingerprint !== witness.parentFingerprint ||
      candidate.identity.externalDependencyFingerprint !== witness.candidateFingerprint) return false;
    try {
      DependencyLookupRecorder.verify(witness.dependencyRoot, witness.parentReceipt);
      if (candidate.manifestHash !== parent.manifestHash) {
        DependencyLookupRecorder.verify(witness.dependencyRoot, witness.candidateReceipt);
      }
      return true;
    } catch { return false; }
  }
}
