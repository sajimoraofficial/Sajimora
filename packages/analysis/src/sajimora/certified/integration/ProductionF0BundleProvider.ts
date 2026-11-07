/**
 * Production bridge for the sealed F0 kernel.
 *
 * This intentionally does not synthesize a proof from TypeScript compiler
 * results.  A materializer must provide the whole PR0–PR5 execution bundle;
 * anything partial, stale, or bound to another route is declined and the
 * production adapter continues through its non-formal evidence lanes.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { GenericRepository, GenericRepositorySnapshot, SemanticEntity, VerificationObligation } from '../../../../../core/src/sajimora/verification';
import { CanonicalSymbolIdentity } from '../../../../../core/src/sajimora/types/identity';
import { EnvironmentManifest } from '../../../../../core/src/sajimora/certified/contracts';
import { ArtifactDomain } from '../../../../../core/src/sajimora/certified/protocol';
import { computeDomainSeparatedHash } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { CertifiedExecutionInput } from './CertifiedEvaluationOrchestrator';
import { F0RouteBundleProvider } from './F0ProofLane';

export interface ProductionF0RouteMaterializer {
  /** Build all sealed manifests, closure/admission evidence, identity,
   * obligations, proofs, and coverage for exactly this route. */
  materialize(
    obligation: VerificationObligation,
    repository: GenericRepository
  ): CertifiedExecutionInput | undefined;
}

export class ProductionF0BundleProvider implements F0RouteBundleProvider {
  public constructor(private readonly materializer: ProductionF0RouteMaterializer) {}

  public getExecution(
    obligation: VerificationObligation,
    repository: GenericRepository
  ): CertifiedExecutionInput | undefined {
    // F0 is a route proof, never a substitute for unresolved or ambiguous
    // production discovery.
    if (obligation.change.identity.status !== 'CONFIRMED_IDENTITY' ||
        obligation.reference?.isUnresolvedBoundary) return undefined;

    let execution: CertifiedExecutionInput | undefined;
    try {
      execution = this.materializer.materialize(obligation, repository);
      if (!execution || !this.isExactlyBound(execution, obligation, repository)) return undefined;
    } catch {
      // Materialization failures are admission failures, not formal verdicts.
      return undefined;
    }
    return execution;
  }

  private isExactlyBound(
    execution: CertifiedExecutionInput,
    obligation: VerificationObligation,
    repository: GenericRepository
  ): boolean {
    // The kernel's historical consumer proposition cannot establish universal
    // provider API compatibility or behavioral equivalence.
    const reference = obligation.reference;
    const parent = obligation.change.identity.parentEntity;
    const candidate = obligation.change.identity.candidateEntity;
    if (obligation.question !== 'CONSUMER_COMPATIBILITY' || obligation.scope !== 'CONSUMER' ||
        reference?.kind !== 'STATIC_CALL' || !parent || !candidate ||
        reference.targetEntityId !== parent.entityId) return false;

    // The manifests are the trust boundary.  Binding their revision identity to
    // the production snapshots prevents a cached/campaign bundle being reused
    // for a different comparison.
    if (execution.parentManifest.repositoryId !== repository.repositoryId ||
        execution.candidateManifest.repositoryId !== repository.repositoryId ||
        execution.parentManifest.revision.commitId !== repository.parentSnapshot.snapshotId ||
        execution.candidateManifest.revision.commitId !== repository.candidateSnapshot.snapshotId) return false;

    if (!this.matchesSnapshot(execution.parentManifest, execution.parentSealedFs, repository.parentSnapshot) ||
        !this.matchesSnapshot(execution.candidateManifest, execution.candidateSealedFs, repository.candidateSnapshot)) return false;

    const mappings = execution.identityBundle.targetMappings.filter(mapping =>
      mapping.parent?.identityId === execution.targetSymbolId);
    if (mappings.length !== 1 || !mappings[0].parent || !mappings[0].candidate ||
        !this.matchesDeclaration(mappings[0].parent, parent, execution.parentSealedFs) ||
        !this.matchesDeclaration(mappings[0].candidate, candidate, execution.candidateSealedFs)) return false;

    // An aggregate violation elsewhere must not be attributed to this route.
    // Multi-consumer bundles need per-obligation checked results before this
    // bridge can admit them. The kernel still checks omission/completeness.
    if (execution.obligations.length !== 1) return false;
    const semantic = execution.obligations[0];
    const anchor = semantic.historicalOccurrenceAnchor;
    const file = execution.parentManifest.namespace.files.find(f => f.fileId === anchor.fileId);
    if (!file || file.logicalPath !== reference.location.filePath ||
        anchor.projectId !== obligation.projectId || reference.projectId !== obligation.projectId ||
        semantic.contextKind !== 'CALL_SITE' || anchor.syntaxKind !== ts.SyntaxKind.CallExpression) return false;
    const sf = ts.createSourceFile(file.logicalPath, execution.parentSealedFs.readBytes(file.logicalPath).toString('utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let exactCall = false;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.getStart(sf) === anchor.utf16Start && node.end === anchor.utf16End) {
        const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        exactCall = loc.line + 1 === reference.location.line && loc.character + 1 === reference.location.character &&
          node.getWidth(sf) === reference.location.length;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!exactCall) return false;

    // A complete PR0–PR5 submission is required before the F0 kernel is even
    // invoked.  The kernel independently replays and verifies these objects.
    return execution.obligations.length > 0 && execution.proofs.length > 0 &&
      !!execution.parentClosure && !!execution.candidateClosure &&
      !!execution.parentAdmission && !!execution.candidateAdmission &&
      !!execution.identityBundle && !!execution.coverage && !!execution.bundle;
  }

  private matchesSnapshot(manifest: EnvironmentManifest, fs: SealedFilesystem, snapshot: GenericRepositorySnapshot): boolean {
    // A subset seal requires a separately verified exclusion certificate. Until
    // then require the entire recorded inventory, including config/package data.
    if (manifest.namespace.symlinks.length !== 0 || manifest.namespace.files.length !== snapshot.files.length) return false;
    const paths = new Set<string>();
    for (const entry of manifest.namespace.files) {
      if (paths.has(entry.logicalPath)) return false;
      paths.add(entry.logicalPath);
      const matches = snapshot.files.filter(file => file.path === entry.logicalPath);
      if (matches.length !== 1) return false;
      const text = snapshot.readTextFile(entry.logicalPath);
      const binary = snapshot.readBinaryFile(entry.logicalPath);
      const bytes = binary === undefined ? (text === undefined ? undefined : Buffer.from(text, 'utf8')) : Buffer.from(binary);
      if (!bytes || (text !== undefined && !Buffer.from(text, 'utf8').equals(bytes)) ||
          bytes.length !== matches[0].byteLength || bytes.length !== entry.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== matches[0].hash ||
          entry.bytesRef.domain !== ArtifactDomain.SOURCE_BYTES ||
          computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, manifest.schemaVersion, bytes) !== entry.bytesRef.digest ||
          !bytes.equals(fs.readBytes(entry.logicalPath))) return false;
    }
    return true;
  }

  private matchesDeclaration(identity: CanonicalSymbolIdentity, entity: SemanticEntity, fs: SealedFilesystem): boolean {
    if (entity.kind !== 'FUNCTION' || identity.declarationKind !== 'FunctionDeclaration' ||
        identity.localName !== entity.name || identity.moduleIdentity !== entity.filePath ||
        identity.projectId !== entity.projectId || identity.ownerChain.length !== 0) return false;
    const sf = ts.createSourceFile(entity.filePath, fs.readBytes(entity.filePath).toString('utf8'), ts.ScriptTarget.Latest, true);
    const declarations = sf.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === entity.name);
    return declarations.length === 1 && declarations[0].getStart(sf) === identity.sourceSpan.start &&
      declarations[0].end === identity.sourceSpan.end;
  }
}
