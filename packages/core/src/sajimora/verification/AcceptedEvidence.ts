import { GenericRepository, VerificationObligation, VerificationVerdict } from './contracts';
import { serialize } from 'node:v8';

// Unlike JSON.stringify this preserves -0, NaN and explicit undefined values.
const fingerprint = (value: unknown): string => serialize(value).toString('base64');

/** Installed by the trusted composition root separately from analyzers.
 * Implementations must independently check submitted evidence against source.
 * Registered checker implementations are part of the trusted computing base. */
export interface EvidenceChecker {
  readonly profileId: string;
  check(obligation: VerificationObligation, repository: GenericRepository, verdict: VerificationVerdict): boolean;
}

/** Execution-local acceptance: no public mint function or global attestation. */
export class EvidenceAcceptanceSession {
  readonly #accepted = new WeakMap<VerificationVerdict, { verdict: string; obligation: string; obligationValue: VerificationObligation }>();
  readonly #checkers: ReadonlyMap<string, EvidenceChecker>;
  readonly #repository: GenericRepository;
  readonly #repositoryBinding: string;

  public constructor(repository: GenericRepository, checkers: readonly EvidenceChecker[] = []) {
    this.#repository = repository;
    this.#repositoryBinding = this.repositoryBinding();
    const registered = new Map<string, EvidenceChecker>();
    for (const checker of checkers) {
      if (!checker.profileId || registered.has(checker.profileId)) throw new Error('DUPLICATE_EVIDENCE_CHECKER');
      registered.set(checker.profileId, checker);
    }
    this.#checkers = registered;
  }

  public verifyAndAccept(obligation: VerificationObligation, verdict: VerificationVerdict): boolean {
    this.#accepted.delete(verdict);
    if (verdict.assurance !== 'F0_FORMAL' && verdict.assurance !== 'WITNESS') return false;
    const profileId = verdict.evidence.metadata?.['verificationProfile'];
    const checker = typeof profileId === 'string' ? this.#checkers.get(profileId) : undefined;
    if (!checker || obligation.change.identity.status !== 'CONFIRMED_IDENTITY' || obligation.reference?.isUnresolvedBoundary) return false;
    const target = obligation.reference?.targetEntityId ?? obligation.change.identity.parentEntity?.entityId ?? obligation.change.identity.candidateEntity?.entityId;
    const expectedProperty = obligation.question === 'BEHAVIORAL_COMPATIBILITY' ? 'BEHAVIOR'
      : obligation.question === 'API_COMPATIBILITY' ? 'API_TYPE' : 'CONSUMER_TYPE';
    const p = verdict.provenance;
    if (verdict.obligationId !== obligation.obligationId || verdict.targetEntityId !== target ||
        verdict.scope !== obligation.scope || verdict.property !== expectedProperty ||
        p.repositoryId !== this.#repository.repositoryId || p.projectId !== obligation.projectId ||
        p.identityId !== obligation.change.identity.identityId || p.referenceId !== obligation.reference?.referenceId ||
        p.resolutionId !== obligation.resolutionId || p.obligationId !== verdict.obligationId ||
        p.verdictId !== verdict.verdictId || p.evidenceId !== verdict.evidence.evidenceId ||
        verdict.evidence.assurance !== verdict.assurance || verdict.evidence.property !== verdict.property ||
        (verdict.outcome !== 'PRESERVED' && verdict.outcome !== 'VIOLATED') ||
        (verdict.assurance === 'WITNESS' && verdict.outcome !== 'VIOLATED')) return false;
    try {
      const before = fingerprint(verdict);
      const obligationBefore = fingerprint(obligation);
      if (this.#repositoryBinding !== this.repositoryBinding() || !checker.check(obligation, this.#repository, verdict) ||
          before !== fingerprint(verdict) || obligationBefore !== fingerprint(obligation) ||
          this.#repositoryBinding !== this.repositoryBinding()) return false;
      this.#accepted.set(verdict, { verdict: before, obligation: obligationBefore, obligationValue: obligation });
    } catch { return false; }
    return true;
  }

  public hasVerifiedAttestation(verdict: VerificationVerdict, obligation?: VerificationObligation): boolean {
    const entry = this.#accepted.get(verdict);
    try {
      return !!entry && this.#repositoryBinding === this.repositoryBinding() && entry.verdict === fingerprint(verdict) &&
        entry.obligation === fingerprint(entry.obligationValue) &&
        (obligation === undefined || entry.obligation === fingerprint(obligation));
    } catch { return false; }
  }

  public matchesRepository(repositoryId: string, parentSnapshotId: string, candidateSnapshotId: string): boolean {
    return this.#repositoryBinding === this.repositoryBinding() && repositoryId === this.#repository.repositoryId && parentSnapshotId === this.#repository.parentSnapshot.snapshotId &&
      candidateSnapshotId === this.#repository.candidateSnapshot.snapshotId;
  }

  private repositoryBinding(): string {
    return fingerprint([this.#repository.repositoryId,
      this.#repository.parentSnapshot.snapshotId, this.#repository.parentSnapshot.files,
      this.#repository.candidateSnapshot.snapshotId, this.#repository.candidateSnapshot.files]);
  }
}
