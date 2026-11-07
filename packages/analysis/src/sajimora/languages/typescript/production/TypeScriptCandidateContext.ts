import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import { GenericRepository, GenericRepositorySnapshot, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { ProgramSetManager } from './ProgramSetManager';
import { TypeScriptProjectGraphBuilder } from './TypeScriptProjectGraphBuilder';
import { canonicalRepositoryPath, readSnapshotText } from './CanonicalRepositoryPath';

const norm = (p: string) => canonicalRepositoryPath(p);
type DiagnosticReceipt = { code: number; message: string; file?: string; line?: number; character?: number };
type Check = { parent: DiagnosticReceipt[]; candidate: DiagnosticReceipt[]; boundary?: string; libraryDigest?: string };

/** Recompile historical consumer bytes against the candidate provider. Compiler
 * diagnostics are receipts for S-level support, never formal behavior proofs. */
export class TypeScriptCandidateContext {
  private static readonly checks = new WeakMap<GenericRepository, Map<string, Check>>();

  public static unknown(obligation: VerificationObligation, repository: GenericRepository, reason: string): VerificationVerdict {
    const base = this.base(obligation, repository);
    return { ...base, outcome: 'UNKNOWN', assurance: 'UNRESOLVED', evidence: {
      evidenceId: base.provenance.evidenceId, assurance: 'UNRESOLVED', property: base.property,
      metadata: this.location(obligation),
      unresolvedBoundary: { taxonomyCode: reason, description: 'The sealed historical consumer context could not be completely checked.',
        remediation: { code: 'PROVIDE_SUPPORTED_SEALED_CONTEXT', suggestion: 'Resolve the reported source/environment boundary and retain existing checks.' } }
    } };
  }

  public static evaluate(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict {
    const reference = obligation.reference;
    if (!reference) return this.unknown(obligation, repository, 'API_RELATION_NOT_CERTIFIED');
    const target = obligation.change.identity.parentEntity;
    if (!target || !repository?.parentSnapshot || !repository.candidateSnapshot || readSnapshotText(repository.parentSnapshot, target.filePath) === undefined ||
        readSnapshotText(repository.parentSnapshot, reference.location.filePath) === undefined) {
      return this.unknown(obligation, repository, 'MISSING_SEALED_CONSUMER_SOURCE');
    }
    if (reference.isUnresolvedBoundary) return this.unknown(obligation, repository, reference.boundaryTaxonomyReason ?? 'UNRESOLVED_REFERENCE');
    // Bound the cache to diagnostic receipts only; no ts.Program/AST is retained.
    let cache = this.checks.get(repository);
    if (!cache) { cache = new Map(); this.checks.set(repository, cache); }
    const key = `${reference.projectId}\0${norm(target.filePath)}\0${norm(reference.location.filePath)}`;
    let check = cache.get(key);
    if (!check) {
      check = this.check(obligation, repository);
      if (cache.size >= 128) cache.clear();
      cache.set(key, check);
    }
    if (check.boundary) return this.unknown(obligation, repository, check.boundary);
    if (check.parent.length) return this.unknown(obligation, repository, 'BASELINE_INVALID');
    const consumerPath = norm(reference.location.filePath);
    const relevant = check.candidate.filter(d => d.file === consumerPath);
    // Missing dependencies, options and provider errors are not consumer breaks.
    if (check.candidate.some(d => d.file !== consumerPath || [2307, 2688, 6053, 6305].includes(d.code))) {
      return this.unknown(obligation, repository, 'CANDIDATE_ENVIRONMENT_INVALID');
    }
    const base = this.base(obligation, repository);
    return { ...base, outcome: relevant.length ? 'VIOLATED' : 'PRESERVED', assurance: 'COMPILER_STATIC', evidence: {
      evidenceId: base.provenance.evidenceId, assurance: 'COMPILER_STATIC', property: base.property,
      compilerStatic: { diagnosticDelta: relevant.length, parentDiagnosticCount: 0, candidateDiagnosticCount: relevant.length,
        introducedDiagnostics: relevant.map(d => ({ code: d.code, message: d.message,
          location: { filePath: d.file!, line: d.line!, character: d.character! } })) },
      metadata: { ...this.location(obligation), route: 'SEALED_HISTORICAL_CONSUMER_COMPILER_V1', diagnosticScope: 'CONSUMER_FILE',
        parentSnapshot: repository.parentSnapshot.snapshotId, candidateSnapshot: repository.candidateSnapshot.snapshotId,
        compilerVersion: ts.version, compilerLibraryDigest: check.libraryDigest,
        consumerHash: crypto.createHash('sha256').update(readSnapshotText(repository.parentSnapshot, reference.location.filePath)!).digest('hex') }
    } };
  }

  private static base(obligation: VerificationObligation, repository: GenericRepository) {
    const verdictId = `verd_${obligation.obligationId}`, evidenceId = `ev_${obligation.obligationId}`;
    return { verdictId, obligationId: obligation.obligationId,
      targetEntityId: obligation.reference?.targetEntityId ?? obligation.change.identity.parentEntity?.entityId ?? obligation.change.identity.candidateEntity?.entityId ?? 'unresolved',
      property: (obligation.reference?.isUnresolvedBoundary ? 'RESOLUTION' : obligation.question === 'API_COMPATIBILITY' ? 'API_TYPE' : 'CONSUMER_TYPE') as 'RESOLUTION' | 'API_TYPE' | 'CONSUMER_TYPE', scope: obligation.scope,
      provenance: { repositoryId: repository.repositoryId, projectId: obligation.projectId, resolutionId: obligation.resolutionId,
        identityId: obligation.change.identity.identityId, referenceId: obligation.reference?.referenceId,
        obligationId: obligation.obligationId, evidenceId, verdictId }, timestamp: new Date().toISOString() };
  }

  private static location(obligation: VerificationObligation): Record<string, unknown> {
    const entity = obligation.change.identity.parentEntity ?? obligation.change.identity.candidateEntity;
    return { sourceFile: obligation.reference?.location.filePath ?? entity?.filePath,
      sourceLine: obligation.reference?.location.line ?? entity?.metadata?.['declarationLine'] };
  }

  private static check(obligation: VerificationObligation, repository: GenericRepository): Check {
    const parent = repository.parentSnapshot, candidate = repository.candidateSnapshot;
    const provider = norm(obligation.change.identity.parentEntity!.filePath);
    const consumer = norm(obligation.reference!.location.filePath);
    const contents = new Map<string, string>();
    // Compose one provider change and exact historical consumer. Other changed
    // source files may be dependencies; do not silently substitute parent code.
    const paths = new Set([...parent.files, ...candidate.files].map(f => norm(f.path)));
    for (const file of paths) {
      const before = readSnapshotText(parent, file), after = readSnapshotText(candidate, file);
      const text = (file === consumer && consumer !== provider) ? before : after;
      if (text !== undefined) contents.set(file, text);
    }
    const snapshot: GenericRepositorySnapshot = { snapshotId: candidate.snapshotId, rootIdentifier: '/',
      files: [...contents].map(([path, text]) => ({ path, byteLength: Buffer.byteLength(text), hash: crypto.createHash('sha256').update(text).digest('hex') })),
      readTextFile: p => contents.get(norm(p)), readBinaryFile: p => { const text = contents.get(norm(p)); return text === undefined ? undefined : Buffer.from(text); } };
    const collect = (snap: GenericRepositorySnapshot, expectedConfig?: string) => {
      const graph = TypeScriptProjectGraphBuilder.buildProjectGraph(snap);
      const project = expectedConfig === undefined
        ? graph.projects.find(p => p.projectId === obligation.projectId) ?? graph.projects.find(p => p.sourceFiles.includes(consumer))
        : graph.projects.find(p => (p.configFile ?? '') === expectedConfig);
      if (!project || !project.sourceFiles.includes(consumer)) return undefined;
      const manager = new ProgramSetManager(snap, { ...graph, projects: [project] });
      const instance = manager.getAllInstances()[0];
      if (!instance || instance.configurationErrors.length) return undefined;
      const diagnostics = ts.getPreEmitDiagnostics(instance.program).filter(d => d.category === ts.DiagnosticCategory.Error);
      return { config: project.configFile ?? '', libraryDigest: instance.host.getCompilerLibraryDigest(), diagnostics: diagnostics.map(d => {
        const loc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        return { code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' '), file: d.file ? norm(d.file.fileName) : undefined,
          line: loc ? loc.line + 1 : undefined, character: loc ? loc.character + 1 : undefined };
      }) };
    };
    const before = collect(parent);
    const after = before && collect(snapshot, before.config);
    if (!before || !after) return { parent: [], candidate: [], boundary: 'SEALED_PROJECT_CONFIGURATION_INVALID' };
    return { parent: before.diagnostics, candidate: after.diagnostics, libraryDigest: after.libraryDigest };
  }
}
