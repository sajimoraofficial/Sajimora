import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { AsymmetricProjectMapping, CertificationLedger, GenericProjectGraph,
  GenericRepository, GenericRepositorySnapshot, Reference, SemanticChange,
  SemanticEntity } from './contracts';

/** The checker is installed by the composition root, never by the adapter.
 * A true result means its documented profile independently reconstructed the
 * complete consumer domain for these exact targets and snapshots. */
export interface DiscoveryCoverageChecker {
  readonly profileId: string;
  check(input: {
    readonly repository: GenericRepository;
    readonly parentGraph: GenericProjectGraph;
    readonly candidateGraph: GenericProjectGraph;
    readonly projectMapping: AsymmetricProjectMapping;
    readonly changes: readonly SemanticChange[];
    readonly targetEntities: readonly SemanticEntity[];
    readonly references: readonly Reference[];
  }): boolean | Promise<boolean>;
}

const fingerprint = (value: unknown): string => serialize(value).toString('base64');

function snapshotBinding(snapshot: GenericRepositorySnapshot): readonly unknown[] {
  const seen = new Set<string>();
  const files = snapshot.files.map(file => {
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.hash) ||
        !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) throw new Error('INVALID_SNAPSHOT_INVENTORY');
    seen.add(file.path);
    const text = snapshot.readTextFile(file.path);
    const binary = snapshot.readBinaryFile(file.path);
    const bytes = binary === undefined ? (text === undefined ? undefined : Buffer.from(text, 'utf8')) : Buffer.from(binary);
    if (!bytes || (text !== undefined && !Buffer.from(text, 'utf8').equals(bytes)) ||
        bytes.length !== file.byteLength || createHash('sha256').update(bytes).digest('hex') !== file.hash) {
      throw new Error('SNAPSHOT_BYTES_MISMATCH');
    }
    return [file.path, file.byteLength, file.hash, file.isSymlink === true];
  });
  return [snapshot.snapshotId, snapshot.rootIdentifier, files, snapshot.omittedBinaryPaths ?? []];
}

/** An execution-local receipt. A serialized ledger cannot mint coverage. */
export class DiscoveryCoverageSession {
  #accepted?: { binding: string; targets: string; references: string; inputs: string;
    inputValue: Parameters<DiscoveryCoverageChecker['check']>[0]; profileId: string };
  public constructor(private readonly repository: GenericRepository,
    private readonly checker?: DiscoveryCoverageChecker) {}

  public async verifyAndAccept(input: {
    readonly parentGraph: GenericProjectGraph;
    readonly candidateGraph: GenericProjectGraph;
    readonly projectMapping: AsymmetricProjectMapping;
    readonly changes: readonly SemanticChange[];
    readonly targetEntities: readonly SemanticEntity[];
    readonly references: readonly Reference[];
  }): Promise<boolean> {
    this.#accepted = undefined;
    if (!this.checker?.profileId) return false;
    try {
      const binding = this.binding();
      const targets = fingerprint(input.targetEntities);
      const references = fingerprint(input.references);
      const inputs = fingerprint([input.parentGraph, input.candidateGraph, input.projectMapping,
        input.changes, input.targetEntities, input.references]);
      if (!await this.checker.check({ ...input, repository: this.repository }) ||
          binding !== this.binding() || inputs !== fingerprint([input.parentGraph, input.candidateGraph,
            input.projectMapping, input.changes, input.targetEntities, input.references])) return false;
      this.#accepted = { binding, targets, references, inputs,
        inputValue: { ...input, repository: this.repository }, profileId: this.checker.profileId };
      return true;
    } catch { return false; }
  }

  public matchesLedger(ledger: CertificationLedger, targets: readonly SemanticEntity[],
    references: readonly Reference[]): boolean {
    const accepted = this.#accepted;
    if (!accepted || !ledger.discoveryAccounting) return false;
    try {
      return accepted.binding === this.binding() &&
        accepted.inputs === fingerprint([accepted.inputValue.parentGraph, accepted.inputValue.candidateGraph,
          accepted.inputValue.projectMapping, accepted.inputValue.changes,
          accepted.inputValue.targetEntities, accepted.inputValue.references]) &&
        ledger.repositoryId === this.repository.repositoryId &&
        ledger.parentSnapshotId === this.repository.parentSnapshot.snapshotId &&
        ledger.candidateSnapshotId === this.repository.candidateSnapshot.snapshotId &&
        accepted.targets === fingerprint(targets) &&
        accepted.references === fingerprint(references) &&
        ledger.discoveryAccounting.coverageProfileId === accepted.profileId &&
        ledger.discoveryAccounting.candidateReferencesDiscovered === references.length &&
        ledger.discoveryAccounting.confirmedConsumers === references.filter(reference => !reference.isUnresolvedBoundary).length &&
        ledger.discoveryAccounting.unresolvedPotentialConsumers === references.filter(reference => reference.isUnresolvedBoundary).length &&
        isDeepStrictEqual(ledger.discoveryAccounting.targetEntityIds, targets.map(entity => entity.entityId)) &&
        isDeepStrictEqual(ledger.discoveryAccounting.consumerLocations, references.map(reference => ({
          referenceId: reference.referenceId, targetEntityId: reference.targetEntityId,
          relationshipType: reference.kind, location: reference.location,
          resolutionId: reference.resolutionId,
          status: reference.isUnresolvedBoundary ? 'UNRESOLVED_POTENTIAL' : 'CONFIRMED'
        })));
    } catch { return false; }
  }

  public get acceptedProfileId(): string | undefined { return this.#accepted?.profileId; }

  private binding(): string {
    return fingerprint([this.repository.repositoryId,
      snapshotBinding(this.repository.parentSnapshot), snapshotBinding(this.repository.candidateSnapshot)]);
  }
}
