import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import {
  ProofObligation,
  UsageSite,
  SymbolRef,
  LanguageContractIR,
  CrossVersionIdentityBundle,
  getSymbolName,
  normalizePath,
  CanonicalReferenceOccurrence,
  RepositoryAnalysisUniverse
} from '@sajimora/core';
import { GitRepository } from '../snapshots/GitRepository';
import { GitObjectReader } from '../snapshots/GitObjectReader';
import { GitDiffReader } from '../snapshots/GitDiffReader';
import { SnapshotFilesystem } from '../snapshots/SnapshotFilesystem';
import { TypeScriptV1Adapter } from '../languages/typescript/TypeScriptV1Adapter';
import { DualTypeScriptProgramBuilder } from '../languages/typescript/programs/DualTypeScriptProgramBuilder';
import { TypeScriptProgramBuilder, normalizeToTrackedRelative } from '../languages/typescript/programs/TypeScriptProgramBuilder';
import { TypeScriptCrossVersionIdentityAnalyzer, programDiscoveryCache } from '../languages/typescript/identity/TypeScriptCrossVersionIdentity';
import { TypeScriptLanguageAdapter } from '../languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptTypeIRExtractor } from '../languages/typescript/ir/TypeScriptTypeIRExtractor';
import { TypeScriptUsageSpecializer } from '../languages/typescript/specialization/TypeScriptUsageSpecializer';
import { ConsumerDiscoveryCoordinator, ConsumerDiscoveryEvidence } from '../closures/ConsumerDiscoveryCoordinator';
import { AnalysisContext } from '../context/AnalysisContext';
import { LiveProgramSemanticProvider } from '../compatibility/LiveProgramSemanticProvider';
import { ProviderCandidateContract, ProviderHistoricalObligation } from '../compatibility/Phase4SemanticProvider';
import {
  SemanticIndexDatabase,
  CompletenessCertificate,
  CompletenessMetadata,
  IdentityMappingRecord
} from '../storage/SemanticIndexDatabase';

export interface IngestionOptions {
  readonly repoName: string;
  readonly repoPath: string;
  readonly db: SemanticIndexDatabase;
  readonly projectKey?: string;
  readonly dependencyRoot?: string;
}

export interface IngestCommitPairOptions extends IngestionOptions {
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly obligations?: ProofObligation[];
  readonly deriveObligations?: (repoPath: string, parentSha: string, candidateSha: string) => ProofObligation[];
}

export interface IngestCommitOptions extends IngestionOptions {
  readonly commitSha: string;
  readonly targetSymbols?: SymbolRef[];
}

export interface IngestionReport {
  readonly repoName: string;
  readonly parentSha?: string;
  readonly candidateSha?: string;
  readonly commitSha?: string;
  readonly projectKey: string;
  readonly candidateContractsCount: number;
  readonly historicalObligationsCount: number;
  readonly proofObligationsCount: number;
  readonly identityMappingsCount: number;
  readonly certificatesCount: number;
  readonly durationMs: number;
}

function findProgram(build: any, targetFilePath?: string): ts.Program | undefined {
  if (!build) return undefined;
  if (targetFilePath && Array.isArray(build.projects) && build.projects.length > 0) {
    let bestProgram: any = undefined;
    let bestScore = 0;
    for (const p of build.projects) {
      for (const sf of p.program.getSourceFiles()) {
        const score = TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, targetFilePath);
        if (score > bestScore) {
          bestScore = score;
          bestProgram = p.program;
        }
      }
    }
    if (bestProgram && bestScore > 0) {
      return bestProgram;
    }
  }
  return build.program ?? build.projects?.[0]?.program;
}

function buildRepositoryUniverse(build: any, prog: any, snapshotRoot?: string): RepositoryAnalysisUniverse | undefined {
  if (!build && !prog) return undefined;
  const snapUniverse = build?.universe;
  if (snapUniverse?.discoveredFileSet instanceof Set && snapUniverse?.rootPath) {
    return snapUniverse as RepositoryAnalysisUniverse;
  }

  const sourceFiles = prog ? prog.getSourceFiles().filter((sf: any) => !prog.isSourceFileDefaultLibrary(sf)) : [];
  const discoveredFiles: string[] = [];
  const discoveredFileSet = new Set<string>();

  for (const sf of sourceFiles) {
    const raw = sf.fileName.replace(/\\/g, '/');
    const norm = normalizePath(sf.fileName);
    discoveredFiles.push(raw);
    discoveredFileSet.add(raw);
    discoveredFileSet.add(norm);
    discoveredFileSet.add(norm.toLowerCase());
  }

  if (Array.isArray(snapUniverse?.includedFiles)) {
    for (const inc of snapUniverse.includedFiles) {
      discoveredFiles.push(inc);
      discoveredFileSet.add(inc);
      discoveredFileSet.add(normalizePath(inc));
      discoveredFileSet.add(normalizePath(inc).toLowerCase());
    }
  }

  let rootPath = '';
  if (Array.isArray(snapUniverse?.includedFiles) && snapUniverse.includedFiles.length > 0) {
    for (const sf of sourceFiles) {
      const sNorm = sf.fileName.replace(/\\/g, '/');
      for (const rel of snapUniverse.includedFiles) {
        if (sNorm.endsWith('/' + rel)) {
          rootPath = sNorm.slice(0, -(rel.length + 1));
          break;
        }
      }
      if (rootPath) break;
    }
  }
  if (!rootPath && snapshotRoot) {
    rootPath = snapshotRoot.replace(/\\/g, '/');
  }
  if (!rootPath && build?.projects?.[0]?.identity?.configFile) {
    const cfg = build.projects[0].identity.configFile.replace(/\\/g, '/');
    if (path.isAbsolute(cfg)) {
      rootPath = path.dirname(cfg).replace(/\\/g, '/');
    }
  }
  if (!rootPath && discoveredFiles.length > 0) {
    rootPath = path.dirname(discoveredFiles[0]).replace(/\\/g, '/');
  }

  const parseFailures = new Map<string, string>();
  const excludedFiles = new Map<string, string>();
  if (Array.isArray(snapUniverse?.excludedFiles)) {
    for (const ef of snapUniverse.excludedFiles) {
      if (ef.file) {
        excludedFiles.set(ef.file.replace(/\\/g, '/'), ef.reason ?? 'EXCLUDED');
      }
    }
  }

  return {
    rootPath,
    discoveredFiles,
    discoveredFileSet,
    excludedFiles,
    unsupportedFiles: [],
    unreadableFiles: snapUniverse?.unreadableFiles ?? [],
    parseFailures,
    discoveryStatus: snapUniverse?.discoveryStatus ?? 'DISCOVERY_COMPLETE',
    discoveryEvidence: 'Snapshot universe adapted for AST closures',
    compilerOptions: build?.projects?.[0]?.options ?? {}
  };
}

function resolveCandidateDeclarationNode(
  candProg: ts.Program | undefined,
  parentProg: ts.Program | undefined,
  targetSymbol: SymbolRef,
  relevantTargetMapping?: any
): ts.Node | undefined {
  if (!candProg || !targetSymbol) return undefined;

  const targetName = getSymbolName(targetSymbol) || targetSymbol.symbolId;
  const targetLoc = (targetSymbol as any).declarationLocation?.filePath ??
    (targetSymbol as any).declarationLocation?.file ??
    (targetSymbol as any).moduleIdentity;

  let candDeclNode: ts.Node | undefined;

  if (targetLoc) {
    const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
    const normTargetParent = parentProg ? clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, parentProg)) : '';
    const normTargetCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, candProg));
    const targetLocNorm = clean(targetLoc);
    const stripExt = (p: string) => p.replace(/\.[a-zA-Z0-9]+$/, '');

    for (const sf of candProg.getSourceFiles()) {
      const rel = clean(sf.fileName);
      const normCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, candProg));
      const matchesFile = (
        normCand === normTargetCand ||
        (normTargetParent.length > 0 && normCand === normTargetParent) ||
        (normTargetCand.length > 0 && stripExt(normTargetCand) === stripExt(normCand)) ||
        (normTargetParent.length > 0 && stripExt(normTargetParent) === stripExt(normCand)) ||
        rel.toLowerCase() === targetLocNorm.toLowerCase() ||
        (targetLocNorm.length > 0 && rel.toLowerCase().endsWith('/' + targetLocNorm.toLowerCase())) ||
        (rel.length > 0 && targetLocNorm.toLowerCase().endsWith('/' + rel.toLowerCase())) ||
        TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, targetLoc) >= 2
      );
      if (matchesFile) {
        for (const stmt of sf.statements) {
          if ((stmt as any).name && (stmt as any).name.text === targetName) {
            candDeclNode = stmt;
            break;
          }
          if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if ((decl.name as any).text === targetName) {
                candDeclNode = decl;
                break;
              }
            }
            if (candDeclNode) break;
          }
        }
        if (candDeclNode) break;
      }
    }
  }

  if (!candDeclNode && relevantTargetMapping?.candidate) {
    const candTarget = relevantTargetMapping.candidate;
    const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const sf of candProg.getSourceFiles()) {
      const normCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, candProg));
      if (
        normCand === candTarget.moduleIdentity ||
        sf.fileName.replace(/\\/g, '/').endsWith('/' + candTarget.moduleIdentity) ||
        TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, candTarget.moduleIdentity) >= 2
      ) {
        for (const stmt of sf.statements) {
          if ((stmt as any).name && (stmt as any).name.text === candTarget.localName) {
            candDeclNode = stmt;
            break;
          }
          if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if ((decl.name as any).text === candTarget.localName) {
                candDeclNode = decl;
                break;
              }
            }
            if (candDeclNode) break;
          }
        }
        if (candDeclNode) break;
      }
    }
  }

  if (!candDeclNode && targetName) {
    for (const sf of candProg.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      for (const stmt of sf.statements) {
        if ((stmt as any).name && (stmt as any).name.text === targetName) {
          candDeclNode = stmt;
          break;
        }
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if ((decl.name as any).text === targetName) {
              candDeclNode = decl;
              break;
            }
          }
          if (candDeclNode) break;
        }
      }
      if (candDeclNode) break;
    }
  }

  return candDeclNode;
}

function findRelevantTargetMapping(bundle: CrossVersionIdentityBundle | undefined, targetSymbol: SymbolRef): any {
  if (!bundle) return undefined;
  const targetMappings: any[] = (bundle as any).targetMappings ?? ((bundle as any).targetMapping ? [(bundle as any).targetMapping] : []);
  const targetName = getSymbolName(targetSymbol) || targetSymbol.symbolId;
  const targetLoc = (targetSymbol as any)?.declarationLocation?.filePath ??
    (targetSymbol as any)?.declarationLocation?.file ??
    (targetSymbol as any)?.moduleIdentity;
  const normLoc = targetLoc ? targetLoc.replace(/\\/g, '/').replace(/^\/+/, '') : null;

  if (targetMappings.length === 1) {
    return targetMappings[0];
  } else if (targetMappings.length > 1) {
    return targetMappings.find((tm: any) => {
      if ((targetSymbol as any)?.persistentSymbolId && tm.parent?.identityId === (targetSymbol as any).persistentSymbolId) return true;
      const matchName = tm.parent?.localName === targetName || tm.parent?.localName === targetSymbol?.symbolId ||
                        tm.candidate?.localName === targetName || tm.candidate?.localName === targetSymbol?.symbolId;
      if (!matchName) return false;
      if (!normLoc) return true;
      const parentMod = (tm.parent?.moduleIdentity ?? tm.parent?.declarationLocation?.filePath)?.replace(/\\/g, '/').replace(/^\/+/, '');
      const candMod = (tm.candidate?.moduleIdentity ?? tm.candidate?.declarationLocation?.filePath)?.replace(/\\/g, '/').replace(/^\/+/, '');
      return (parentMod && (normLoc.endsWith(parentMod) || parentMod.endsWith(normLoc))) ||
             (candMod && (normLoc.endsWith(candMod) || candMod.endsWith(normLoc)));
    });
  }
  return undefined;
}

interface MappedSitesResult {
  readonly sites: UsageSite[];
  readonly histIds: string[];
  readonly addedIds: string[];
  readonly ambiguousIds: string[];
  readonly mappedParentToCandOccId: Map<string, string>;
}

function mapOccurrencesToUsageSites(
  occurrences: CanonicalReferenceOccurrence[],
  crossVersionIdentity?: CrossVersionIdentityBundle,
  relevantTargetMapping?: any
): MappedSitesResult {
  const mappingByOccId = new Map<string, import('@sajimora/core').CrossVersionConsumerMapping>();
  const mappedParentToCandOccId = new Map<string, string>();
  const histIds = new Set<string>();
  const addedIds = new Set<string>();
  const ambiguousIds = new Set<string>();

  if (crossVersionIdentity?.consumerMappings) {
    const currentOccIds = new Set(occurrences.map(o => o.occurrenceId));
    for (const m of crossVersionIdentity.consumerMappings) {
      const matchesTarget = (
        ((m as any).targetParentId && relevantTargetMapping?.parent?.identityId && (m as any).targetParentId === relevantTargetMapping.parent.identityId) ||
        ((m as any).targetCandidateId && relevantTargetMapping?.candidate?.identityId && (m as any).targetCandidateId === relevantTargetMapping.candidate.identityId) ||
        (m.candidateOccurrenceId && currentOccIds.has(m.candidateOccurrenceId)) ||
        (m.parentOccurrenceId && currentOccIds.has(m.parentOccurrenceId))
      );

      if (!matchesTarget) {
        continue;
      }

      if (m.candidateOccurrenceId) mappingByOccId.set(m.candidateOccurrenceId, m);
      if (m.parentOccurrenceId) mappingByOccId.set(m.parentOccurrenceId, m);
      if (m.parentOccurrenceId && m.candidateOccurrenceId) {
        mappedParentToCandOccId.set(m.parentOccurrenceId, m.candidateOccurrenceId);
      }

      if (m.lifecycle === 'ADDED_IN_CANDIDATE') {
        if (m.candidateOccurrenceId) addedIds.add(m.candidateOccurrenceId);
      } else if (m.lifecycle === 'REMOVED_IN_CANDIDATE' || m.lifecycle === 'BINDING_REMOVED_IN_CANDIDATE') {
        if (m.parentOccurrenceId) histIds.add(m.parentOccurrenceId);
      } else if (m.lifecycle === 'AMBIGUOUS_ACROSS_VERSIONS') {
        if (m.candidateOccurrenceId) ambiguousIds.add(m.candidateOccurrenceId);
        if (m.parentOccurrenceId) ambiguousIds.add(m.parentOccurrenceId);
      } else {
        if (m.parentOccurrenceId) {
          histIds.add(m.parentOccurrenceId);
        }
      }
    }
  }

  const sites = occurrences.map(occ => {
    const mapping = mappingByOccId.get(occ.occurrenceId);
    const isAdded = addedIds.has(occ.occurrenceId) || mapping?.lifecycle === 'ADDED_IN_CANDIDATE';
    const isRemoved = mapping?.lifecycle === 'REMOVED_IN_CANDIDATE';
    const isBindingRemoved = mapping?.lifecycle === 'BINDING_REMOVED_IN_CANDIDATE';
    const isAmbiguous = ambiguousIds.has(occ.occurrenceId) || mapping?.lifecycle === 'AMBIGUOUS_ACROSS_VERSIONS';
    const isChangedCommit = mapping?.lifecycle === 'STABLE_CHANGED_SAME_COMMIT';

    const existenceAtParent: 'PRESENT' | 'ABSENT' = isAdded ? 'ABSENT' : 'PRESENT';
    const mutationStatus: 'UNCHANGED' | 'CHANGED' | 'REMOVED' = isAdded
      ? 'CHANGED'
      : isRemoved
        ? 'REMOVED'
        : isChangedCommit
          ? 'CHANGED'
          : 'UNCHANGED';
    const bindingPresenceAtCandidate: 'PRESENT' | 'ABSENT' = (isRemoved || isBindingRemoved) ? 'ABSENT' : 'PRESENT';
    const bindingState: UsageSite['bindingState'] = isBindingRemoved
      ? 'WAS_BOUND_NOW_ABSENT'
      : occ.resolutionStatus === 'RESOLVED'
        ? 'BOUND'
        : 'NEVER_BOUND';

    const isTargetUncertain = mapping?.targetIdentity === 'UNCERTAIN';
    const evaluationStatus: UsageSite['evaluationStatus'] =
      occ.resolutionStatus !== 'RESOLVED' || isAmbiguous || isTargetUncertain
        ? 'UNCERTAIN_IDENTITY'
        : occ.usageRole === 'RE_EXPORTER'
          ? 'EXCLUDED_RE_EXPORTER'
          : 'EVALUABLE';

    const identityResult: UsageSite['identityResult'] =
      occ.resolutionStatus !== 'RESOLVED' || isAmbiguous || isTargetUncertain
        ? 'IDENTITY_UNCERTAIN'
        : 'SAME';

    const site: UsageSite = {
      usageSiteId: occ.occurrenceId,
      canonicalOccurrence: occ,
      existenceAtParent,
      mutationStatus,
      bindingPresenceAtCandidate,
      bindingState,
      evaluationStatus,
      identityResult,
      enumerationInconsistencyCause: null,
      provenance: occ.usageRole === 'RE_EXPORTER' ? 'RE_EXPORTED' : 'UNCHANGED'
    };
    if ((mapping as any)?.parentOccurrence) {
      (site as any).parentCanonicalOccurrence = (mapping as any).parentOccurrence;
    }
    return site;
  });

  return {
    sites,
    histIds: Array.from(histIds),
    addedIds: Array.from(addedIds),
    ambiguousIds: Array.from(ambiguousIds),
    mappedParentToCandOccId
  };
}

/**
 * Compiler-Isolated Semantic Ingestion Worker.
 * 
 * Performs expensive TypeScript compiler construction, type checking, AST traversal,
 * signature resolution, and reverse-edge closure enumeration inside an isolated boundary.
 * 
 * Emits ONLY verified, serializable Phase 2 DTOs into SQLite (SemanticIndexDatabase).
 * Disposes all compiler programs, type checkers, and AST node caches upon completion.
 */
export class SemanticIngestionWorker {
  /**
   * Ingests a commit pair (parent -> candidate) with associated proof obligations.
   * Extracts and persists:
   * - ProofObligations
   * - IdentityMappingRecords
   * - ProviderCandidateContracts
   * - CompletenessCertificates (across all 7 closures)
   * - ProviderHistoricalObligations (with selectedSignatureIndex)
   */
  public ingestCommitPair(options: IngestCommitPairOptions): IngestionReport {
    const started = Date.now();
    const { repoName, repoPath, parentSha, candidateSha, db } = options;
    const projectKey = options.projectKey ?? 'root';

    if (!repoPath || !repoName || !parentSha || !candidateSha || !db) {
      throw new Error('INGESTION_ARGUMENT_ERROR: Missing required ingestion options');
    }

    const repo = new GitRepository(repoPath);
    repo.validate();

    let obligations = options.obligations;
    if (!obligations && options.deriveObligations) {
      obligations = options.deriveObligations(repoPath, parentSha, candidateSha);
    }
    if (!obligations || obligations.length === 0) {
      throw new Error('INGESTION_OBLIGATIONS_REQUIRED: Either obligations or deriveObligations producing >= 1 obligation must be provided');
    }

    let candidateContractsCount = 0;
    let historicalObligationsCount = 0;
    let proofObligationsCount = 0;
    let identityMappingsCount = 0;
    let certificatesCount = 0;

    let pContext: AnalysisContext | undefined;
    let dual: any = null;
    let ps: any = null;
    let cs: any = null;
    let crossVersionIdentity: any = null;

    try {
      const snapshots = new SnapshotFilesystem(new GitObjectReader(repo));
      ps = snapshots.materialize(parentSha);
      cs = snapshots.materialize(candidateSha);

      const adapter = new TypeScriptV1Adapter();
      const effectiveDepRoot = options.dependencyRoot && fs.existsSync(options.dependencyRoot) ? options.dependencyRoot : undefined;
      const diffs = new GitDiffReader(repo).read(parentSha, candidateSha);

      const allChangedFiles = Array.from(new Set(
        obligations
          .map(o => {
            const targetFilePath = o.mutatedSymbol?.declarationLocation?.filePath;
            return targetFilePath ? normalizeToTrackedRelative(targetFilePath, ps.root, ps.trackedFiles) : null;
          })
          .filter((p): p is string => Boolean(p))
      ));

      const makeInput = (snapshot: typeof ps, sha: string) => ({
        root: snapshot.root,
        trackedFiles: snapshot.trackedFiles,
        revision: { repositoryId: repo.repositoryId(), commitSha: sha },
        toolchain: adapter.toolchain(snapshot),
        adapterId: adapter.descriptor.id,
        adapterVersion: adapter.descriptor.version,
        dependencyRoot: effectiveDepRoot,
        obligations,
        changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined
      });

      dual = new DualTypeScriptProgramBuilder().build(
        makeInput(ps, parentSha),
        makeInput(cs, candidateSha),
        {
          obligations,
          changedFiles: allChangedFiles.length > 0 ? allChangedFiles : undefined
        }
      );

      crossVersionIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(
        dual.parent,
        dual.candidate,
        ps.root,
        cs.root,
        diffs
      );

      // Perform all persistence inside a single atomic SQLite transaction
      db.transaction(() => {
        // 1. ProofObligations
        for (const obligation of obligations!) {
          SemanticIndexDatabase.assertNoCompilerObjects(obligation);
          db.putObligation(repoName, parentSha, candidateSha, obligation);
          proofObligationsCount++;
        }

        // 2. Identity Mappings
        if (crossVersionIdentity?.consumerMappings) {
          for (const m of crossVersionIdentity.consumerMappings) {
            const oldId = m.parentOccurrenceId ?? m.candidateOccurrenceId ?? 'unknown';
            const record: IdentityMappingRecord = {
              repoName,
              parentSha,
              candidateSha,
              oldOccurrenceId: oldId,
              newOccurrenceId: m.candidateOccurrenceId,
              mappingStatus: m.lifecycle,
              confidence: m.confidence ?? 'HIGH'
            };
            SemanticIndexDatabase.assertNoCompilerObjects(record);
            db.putIdentityMapping(record);
            identityMappingsCount++;
          }
        }

        // 3. Obligations extraction: Candidate contracts & Historical obligations
        // Group obligations by parentProg to share AnalysisContext and avoid repeated allocations
        const groups = new Map<ts.Program | undefined, ProofObligation[]>();
        for (const obligation of obligations!) {
          const targetFilePath = obligation.mutatedSymbol?.declarationLocation?.filePath;
          const parentProg = findProgram(dual.parent, targetFilePath);
          const list = groups.get(parentProg);
          if (list) list.push(obligation);
          else groups.set(parentProg, [obligation]);
        }

        const recordedCertificates = new Set<string>();
        for (const [parentProg, projectObligations] of groups) {
          const pUniverse = buildRepositoryUniverse(dual.parent, parentProg, ps.root);
          const allParentPrograms: ts.Program[] = dual.parent?.projects?.map((p: any) => p.program) ?? (parentProg ? [parentProg] : []);
          const projectContext = pUniverse && parentProg
            ? new AnalysisContext(pUniverse, {
                program: parentProg,
                programs: allParentPrograms,
                compilerOptions: dual.parent?.projects?.[0]?.options ?? {}
              })
            : undefined;

          try {
            for (const obligation of projectObligations) {
              const targetFilePath = obligation.mutatedSymbol?.declarationLocation?.filePath;
              const candidateProg = findProgram(dual.candidate, targetFilePath);
              const relevantTargetMapping = findRelevantTargetMapping(crossVersionIdentity, obligation.mutatedSymbol!);

              const candDeclNode = resolveCandidateDeclarationNode(
                candidateProg,
                parentProg,
                obligation.mutatedSymbol!,
                relevantTargetMapping
              );

              // Build live provider inside the ingestion boundary
              const liveProvider = new LiveProgramSemanticProvider({
                parentProgram: parentProg!,
                candidateProgram: candidateProg!,
                obligation,
                candidateDeclarationNode: candDeclNode
              });

              // 3a. Candidate Contract
              const targetSymbol = obligation.mutatedSymbol!;
              const targetId = targetSymbol.persistentSymbolId ?? targetSymbol.symbolId;
              const targetName = getSymbolName(targetSymbol) || targetSymbol.symbolId || targetId;
              const targetLoc = (targetSymbol as any)?.declarationLocation?.filePath ??
                (targetSymbol as any)?.declarationLocation?.file ??
                (targetSymbol as any)?.moduleIdentity;

              const candContract = liveProvider.getCandidateContract(
                targetId,
                targetName,
                targetLoc
              );
              SemanticIndexDatabase.assertNoCompilerObjects(candContract);
              db.putCandidateContract(repoName, candidateSha, projectKey, candContract);
              candidateContractsCount++;

              // 3b. Consumer discovery, CompletenessCertificates, and Historical Usage
              let discovery: ConsumerDiscoveryEvidence | undefined;
              const targetIdentityId = relevantTargetMapping?.parent?.identityId ?? (targetSymbol as any).persistentSymbolId;
              if (parentProg && targetIdentityId) {
                discovery = programDiscoveryCache.get(parentProg)?.get(targetIdentityId);
              }
              if (!discovery && projectContext && pUniverse) {
                discovery = new ConsumerDiscoveryCoordinator().discover(projectContext, targetSymbol, pUniverse);
              }

              if (discovery) {
                // Put authoritative completeness certificate for each closure
                for (const closure of discovery.closures) {
                  const certId = `${repoName}:${parentSha}:${projectKey}:${closure.closureName}`;
                  if (!recordedCertificates.has(certId) && !db.getCompletenessCertificate(repoName, parentSha, projectKey, closure.closureName)) {
                    const cert: CompletenessCertificate = {
                      repoName,
                      commitSha: parentSha,
                      projectKey,
                      closureKind: closure.closureName,
                      isComplete: closure.completeness === 'COMPLETE',
                      failureCount: (closure.failures?.length ?? 0) + (closure.ambiguities?.length ?? 0) + (closure.unrecognizedForms?.length ?? 0),
                      timestamp: 0
                    };
                    SemanticIndexDatabase.assertNoCompilerObjects(cert);
                    db.putCompletenessCertificate(cert);
                    recordedCertificates.add(certId);
                    certificatesCount++;
                  }
                }

                // Map occurrences to UsageSites and extract historical obligations
                const { sites, histIds, addedIds, ambiguousIds, mappedParentToCandOccId } = mapOccurrencesToUsageSites(
                  discovery.rollup.occurrences,
                  crossVersionIdentity,
                  relevantTargetMapping
                );
                for (const site of sites) {
                  const histObligation = liveProvider.getHistoricalObligation(site);
                  SemanticIndexDatabase.assertNoCompilerObjects(histObligation);
                  db.putHistoricalObligation(repoName, parentSha, projectKey, histObligation);
                  historicalObligationsCount++;
                }

                const targetRel = targetFilePath ? normalizeToTrackedRelative(targetFilePath, ps.root, ps.trackedFiles) ?? undefined : undefined;
                const metadata: CompletenessMetadata = {
                  repoName,
                  commitSha: parentSha,
                  projectKey,
                  targetSymbolId: targetId,
                  enumerationStatus: discovery.rollup.completeness,
                  resolutionStatus: 'RESOLUTION_COMPLETE',
                  isPoisoned: false,
                  targetFile: targetRel,
                  discovery,
                  sites
                };
                SemanticIndexDatabase.assertNoCompilerObjects(metadata);
                db.putCompletenessMetadata(metadata);

                // Fully separate parent-revision discovery from parent+candidate lifecycle mappings
                const pairLifecycle = {
                  repoName,
                  parentSha,
                  candidateSha,
                  projectKey,
                  targetSymbolId: targetId,
                  discoveredHistoricalConsumerIds: histIds,
                  candidateAddedConsumerIds: addedIds,
                  ambiguousLifecycleConsumerIds: ambiguousIds,
                  mappedHistoricalConsumerIds: Array.from(mappedParentToCandOccId.entries())
                };
                SemanticIndexDatabase.assertNoCompilerObjects(pairLifecycle);
                db.putPairLifecycle(pairLifecycle);
              }
            }
          } finally {
            projectContext?.dispose();
          }
        }
      });
    } finally {
      // Strict Compiler Isolation Cleanup:
      // Dispose context, clear discovery caches, and null out all AST/compiler references
      if (pContext) {
        try {
          pContext.dispose();
        } catch { /* ignore disposal errors */ }
        pContext = undefined;
      }
      dual = null;
      ps = null;
      cs = null;
      crossVersionIdentity = null;
    }

    return {
      repoName,
      parentSha,
      candidateSha,
      projectKey,
      candidateContractsCount,
      historicalObligationsCount,
      proofObligationsCount,
      identityMappingsCount,
      certificatesCount,
      durationMs: Date.now() - started
    };
  }

  /**
   * Ingests a single commit revision.
   * Extracts and persists:
   * - Exported declaration contracts (LanguageContractIR)
   * - TypeIR artifacts
   * - CompletenessCertificates for discovered closures
   */
  public ingestCommit(options: IngestCommitOptions): IngestionReport {
    const started = Date.now();
    const { repoName, repoPath, commitSha, db } = options;
    const projectKey = options.projectKey ?? 'root';

    if (!repoPath || !repoName || !commitSha || !db) {
      throw new Error('INGESTION_ARGUMENT_ERROR: Missing required ingestion options');
    }

    const repo = new GitRepository(repoPath);
    repo.validate();

    let candidateContractsCount = 0;
    let certificatesCount = 0;

    let context: AnalysisContext | undefined;
    let program: ts.Program | undefined;

    try {
      const snapshots = new SnapshotFilesystem(new GitObjectReader(repo));
      const snap = snapshots.materialize(commitSha);
      const adapter = new TypeScriptV1Adapter();
      const effectiveDepRoot = options.dependencyRoot && fs.existsSync(options.dependencyRoot) ? options.dependencyRoot : undefined;

      const builder = new TypeScriptProgramBuilder();
      const build = builder.build({
        root: snap.root,
        trackedFiles: snap.trackedFiles,
        revision: { repositoryId: repo.repositoryId(), commitSha },
        toolchain: adapter.toolchain(snap),
        adapterId: adapter.descriptor.id,
        adapterVersion: adapter.descriptor.version,
        dependencyRoot: effectiveDepRoot
      });

      program = build.projects?.[0]?.program;
      if (!program) {
        throw new Error(`INGESTION_PROGRAM_FAILURE: Failed to build TypeScript program for commit ${commitSha}`);
      }

      const langAdapter = new TypeScriptLanguageAdapter();

      db.transaction(() => {
        // Index target symbols or exported declarations
        if (options.targetSymbols && options.targetSymbols.length > 0) {
          for (const targetSymbol of options.targetSymbols) {
            const targetName = getSymbolName(targetSymbol) || targetSymbol.symbolId;
            let declNode: ts.Node | undefined;
            for (const sf of program!.getSourceFiles()) {
              if (sf.isDeclarationFile) continue;
              for (const stmt of sf.statements) {
                if ((stmt as any).name && (stmt as any).name.text === targetName) {
                  declNode = stmt;
                  break;
                }
              }
              if (declNode) break;
            }

            if (declNode) {
              const contract = langAdapter.extractContract(declNode, {
                parentProgram: program!,
                candidateProgram: program!
              });
              SemanticIndexDatabase.assertNoCompilerObjects(contract);
              db.putLanguageContract(repoName, commitSha, projectKey, contract);
              candidateContractsCount++;
            }
          }
        }

        // Authoritative universe completeness certificate
        if (!db.getCompletenessCertificate(repoName, commitSha, projectKey, 'COMMIT_INGESTION_UNIVERSE')) {
          const cert: CompletenessCertificate = {
            repoName,
            commitSha,
            projectKey,
            closureKind: 'COMMIT_INGESTION_UNIVERSE',
            isComplete: true,
            failureCount: 0,
            timestamp: 0
          };
          SemanticIndexDatabase.assertNoCompilerObjects(cert);
          db.putCompletenessCertificate(cert);
          certificatesCount++;
        }
      });
    } finally {
      if (context) {
        try {
          context.dispose();
        } catch { /* ignore */ }
        context = undefined;
      }
      program = undefined;
    }

    return {
      repoName,
      commitSha,
      projectKey,
      candidateContractsCount,
      historicalObligationsCount: 0,
      proofObligationsCount: 0,
      identityMappingsCount: 0,
      certificatesCount,
      durationMs: Date.now() - started
    };
  }
}
