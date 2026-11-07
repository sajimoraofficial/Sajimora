import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  GenericRepository,
  GenericRepositorySnapshot,
  ProductionVerificationCore
} from '@sajimora/core';
import {
  GitObjectReader,
  GitRepository,
  RevisionResolver,
  SnapshotFilesystem,
  TypeScriptProductionAdapter,
  TypeScriptPilotQualifier,
  TypeScriptV1Adapter
} from '@sajimora/analysis';
import { AnalyzeArguments } from './arguments';
import type { CommandIO } from './command';
import { Phase1Artifact, serializePhase1Artifact, writeArtifactAtomically } from './artifact';
import { SajimoraExecutionError } from './errors';
import { verifyProductionInWorker } from './productionExecution';

export function toGenericSnapshot(objects: GitObjectReader, snapshotId: string): GenericRepositorySnapshot {
  const entries = objects.entries(snapshotId).filter(entry => entry.type === 'blob');
  const blobs = objects.batchBlobs(entries.map(entry => entry.objectId));
  const contents = new Map<string, string>();
  const omittedBinaryPaths: string[] = [];
  const files = entries.flatMap(entry => {
    const bytes = blobs.get(entry.objectId);
    if (!bytes) throw new Error(`MISSING_GIT_BLOB:${entry.path}`);
    const content = bytes.toString('utf8');
    // Binary assets are not TypeScript source. Never reinterpret replacement
    // characters as original Git bytes or charge their inflated UTF-8 size.
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      omittedBinaryPaths.push(entry.path);
      return [];
    }
    contents.set(entry.path, content);
    return [{ path: entry.path, byteLength: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      ...(entry.mode === '120000' ? { isSymlink: true } : {}) }];
  });
  return {
    snapshotId,
    rootIdentifier: '/', files, omittedBinaryPaths,
    readTextFile: file => contents.get(file),
    readBinaryFile: file => {
      const content = contents.get(file);
      return content === undefined ? undefined : Buffer.from(content);
    }
  };
}

/** The public production CLI path.  F0 authority remains the final verdict gate. */
export async function runProductionAnalyzeCommand(args: AnalyzeArguments, io: CommandIO): Promise<void> {
  const started = Date.now();
  let parentSnapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined;
  let candidateSnapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined;
  try {
    const repository = new GitRepository(args.repo);
    repository.validate();
    const before = repository.statusFingerprint();
    const revisions = new RevisionResolver(repository).resolve(args.parent, args.candidate);
    const objects = new GitObjectReader(repository);
    const snapshots = new SnapshotFilesystem(objects);
    parentSnapshot = snapshots.materialize(revisions.parentSha);
    candidateSnapshot = snapshots.materialize(revisions.candidateSha);

    const genericRepository: GenericRepository = {
      repositoryId: repository.repositoryId(),
      parentSnapshot: toGenericSnapshot(objects, revisions.parentSha),
      candidateSnapshot: toGenericSnapshot(objects, revisions.candidateSha)
    };
    const adapter = new TypeScriptProductionAdapter();
    if (!adapter.canHandle(genericRepository)) {
      throw new SajimoraExecutionError('Production TypeScript adapter found no supported TypeScript input.', 3, 'REPOSITORY_CONFIGURATION_LIMITATION');
    }
    const result = await verifyProductionInWorker(genericRepository);
    const testDeferral = { authorized: false, reasonCode: 'TEST_DEFERRAL_NOT_QUALIFIED',
      description: 'Keep all tests enabled; no scope-bound test deferral profile is qualified.' };
    const detected = new TypeScriptV1Adapter().canAnalyze({
      trackedFiles: candidateSnapshot.trackedFiles,
      readTextFile: file => candidateSnapshot!.readTextFile(file)
    });
    const parentFiles = new Map(genericRepository.parentSnapshot.files.map(file => [file.path, file.hash]));
    const candidateFiles = new Map(genericRepository.candidateSnapshot.files.map(file => [file.path, file.hash]));
    const changedFiles = [...new Set([...parentFiles.keys(), ...candidateFiles.keys()])]
      .filter(file => parentFiles.get(file) !== candidateFiles.get(file))
      .sort();
    const targetFile = (targetEntityId: string): string =>
      candidateSnapshot!.trackedFiles.find(file => targetEntityId.includes(`::${file}::`)) ??
      changedFiles[0] ??
      'unknown';
    const knownPaths = new Set([...parentFiles.keys(), ...candidateFiles.keys()]);
    const resultFile = (sourceFile: unknown, targetEntityId: string): string => {
      if (typeof sourceFile === 'string') {
        const normalized = sourceFile.replace(/\\/g, '/').replace(/^\/+/, '');
        if (knownPaths.has(normalized)) return normalized;
      }
      return targetFile(targetEntityId);
    };
    const artifact: Phase1Artifact = {
      schemaVersion: 'SAJIMORA_ANALYSIS_ARTIFACT_V2',
      repository: { repositoryId: repository.repositoryId() },
      revisions: {
        parent: { repositoryId: repository.repositoryId(), commitSha: revisions.parentSha },
        candidate: { repositoryId: repository.repositoryId(), commitSha: revisions.candidateSha, parentSelection: revisions.parentSelection }
      },
      adapter: {
        id: 'typescript-production-v2',
        version: adapter.adapterVersion,
        capabilities: ['DECLARATION_DIFF', 'VALUE_REFERENCE_DISCOVERY', 'TYPE_REFERENCE_DISCOVERY', 'SOURCE_COMPATIBILITY'],
        selection: { mode: args.language === 'auto' ? 'auto' : 'explicit', evidence: detected.evidence },
        toolchain: new TypeScriptV1Adapter().toolchain({ trackedFiles: candidateSnapshot.trackedFiles, readTextFile: file => candidateSnapshot!.readTextFile(file) })
      },
      analysis: {
        status: 'COMPLETED',
        changedFiles,
        results: result.ledger.verdicts.map(verdict => ({
          obligationId: verdict.obligationId,
          target: { name: verdict.targetEntityId, kind: verdict.property,
            file: resultFile(verdict.evidence.metadata?.['sourceFile'], verdict.targetEntityId),
            line: Math.max(1, Number(verdict.evidence.metadata?.['sourceLine'] ?? 1) || 1) },
          verdict: verdict.outcome,
          assurance: verdict.assurance,
          evidence: verdict.evidence,
          provenance: verdict.provenance,
          authority: result.authoritativeVerdict.auditTrace ? {
            source: result.authoritativeVerdict.auditTrace.authorityDecision.source,
            gate: result.authoritativeVerdict.auditTrace.authorityDecision.gate,
            reason: result.authoritativeVerdict.auditTrace.authorityDecision.reason
          } : null
        }))
      },
      productionCertification: {
        status: result.ledger.certificationStatus,
        verdict: result.authoritativeVerdict.verdict,
        conservation: result.ledger.conservationReport,
        scope: {
          inputDomain: (() => {
            const domains = [...new Set(result.ledger.verdicts.map(verdict =>
              verdict.evidence.metadata?.['inputDomain']).filter((domain): domain is string => typeof domain === 'string'))];
            return domains.length === 1 && result.ledger.verdicts.every(verdict =>
              verdict.assurance === 'F0_FORMAL' && verdict.evidence.metadata?.['inputDomain'] === domains[0])
              ? domains[0] : 'MIXED_OR_UNSPECIFIED';
          })(),
          coverageProfileId: result.ledger.discoveryAccounting?.coverageProfileId ?? null,
          properties: [...new Set(result.ledger.verdicts.map(verdict => verdict.property))].sort()
        },
        testDeferral
      }
    };
    const serialized = serializePhase1Artifact(artifact, { snapshotRoots: [parentSnapshot.root, candidateSnapshot.root] });
    if (args.output) writeArtifactAtomically(args.output, serialized); else io.stdout(serialized);
    if (before !== repository.statusFingerprint()) throw new SajimoraExecutionError('Target repository changed during analysis.', 6, 'ENGINE_RUNTIME_FAILURE');
    io.stderr(`Sajimora production analysis completed in ${Date.now() - started} ms.\n`);
    if (args.failOnViolation || args.strict) {
      const v = result.authoritativeVerdict.verdict;
      if (v === 'VIOLATED') {
        throw new SajimoraExecutionError('Contract compatibility check failed with violations.', 1, 'CONTRACT_VIOLATION');
      }
      if (args.strict && (v === 'UNKNOWN' || v === 'INSUFFICIENT_EVIDENCE')) {
        throw new SajimoraExecutionError('Contract compatibility check inconclusive in strict mode.', 3, 'VERDICT_INCONCLUSIVE');
      }
    }
  } catch (error) {
    if (error instanceof SajimoraExecutionError) throw error;
    throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 6, 'ENGINE_RUNTIME_FAILURE', { cause: error });
  } finally {
    candidateSnapshot?.cleanup();
    parentSnapshot?.cleanup();
  }
}
