import {
  ArtifactDomain,
  BoundaryPolicyId,
  INITIAL_RESOURCE_PROFILE,
  NormalizationProfileId,
  ParserProfileId,
  RootPolicyId,
  RuleSetId,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  SemanticProfileId
} from '../../packages/core/src/sajimora/certified/protocol';
import {
  ArtifactRef,
  BlockerCode
} from '../../packages/core/src/sajimora/certified/blockers';
import {
  DependencyClosureCertificate,
  EnvironmentManifest,
  FileEntry,
  Phase5EvidenceBundle,
  ResolutionFact,
  DependencyEdge,
  SemanticObligation,
  Vertex
} from '../../packages/core/src/sajimora/certified/contracts';
import {
  CanonicalSet,
  canonicalEncode,
  computeDomainSeparatedHash,
  hashContract
} from '../../packages/core/src/sajimora/certified/canonicalEncoding';
import { CrossVersionIdentityBundle } from '../../packages/core/src/sajimora/types/identity';
import { GitRepository, GitObjectReader } from '@sajimora/analysis';
import { SealedFilesystem } from '../../packages/analysis/src/sajimora/certified/environment/SealedFilesystem';
import { ASTAnchorExtractor } from '../../packages/analysis/src/sajimora/certified/closure/ASTExtractor';
import { F0RestrictedResolver } from '../../packages/analysis/src/sajimora/certified/closure/F0RestrictedResolver';
import { DependencyClosureProducer } from '../../packages/analysis/src/sajimora/certified/closure/DependencyClosureProducer';
import { FragmentAdmissionProducer } from '../../packages/analysis/src/sajimora/certified/fragment/FragmentAdmissionProducer';
import { HistoricalObligationGenerator } from '../../packages/analysis/src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ProofProducer } from '../../packages/analysis/src/sajimora/certified/proof/ProofProducer';
import { CoverageProducer } from '../../packages/analysis/src/sajimora/certified/coverage/CoverageProducer';
import {
  CertifiedEvaluationOrchestrator,
  CertifiedExecutionInput,
  CertifiedExecutionResult
} from '../../packages/analysis/src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { VerificationBudget } from '../../packages/analysis/src/sajimora/certified/proof/VerificationBudget';
import { GitTreeSealedEnvironmentMaterializer } from './GitTreeSealedEnvironmentMaterializer';
import { VerdictAuthority } from '../../packages/core/src/sajimora/authority/VerdictAuthority';
import { CertifiedCorrespondence } from '../../packages/analysis/src/sajimora/certified/identity/CertifiedCorrespondence';
import { classifyF0DirectExportCallability } from '../../packages/analysis/src/sajimora/certified/identity/F0ExportCallability';
import { F0BindingVerifier } from '../../packages/analysis/src/sajimora/certified/fragment/F0BindingVerifier';
import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import { produceTargetScopedEnvelope, TargetScopedEnvelope } from '../../packages/analysis/src/sajimora/certified/fragment/TargetScopedEnvelope';

export interface PilotSourceFile {
  path: string;
  content: string;
}

export interface CaseAInput {
  parentFiles: PilotSourceFile[];
  candidateFiles: PilotSourceFile[];
  targetSymbol: string;
  isCompatibleProof?: boolean;
  omitCoverage?: boolean;
}

export interface CaseBRealGitInput {
  repoPath: string;
  repoId?: string;
  parentSha: string;
  candidateSha: string;
  targetSymbol: string;
  targetFile: string;
  /** Explicit sealed consumer for the controlled two-file experiment. */
  consumerFile?: string;
  /** Derived from sealed parent source by the campaign input preparer. */
  targetDeclarationKind?: string;
  targetOwnerChain?: string[];
  targetDeclarationOrdinal?: number;
  /** Compiler-validated local name of the target in the explicit consumer. */
  consumerLocalName?: string;
  /**
   * Exact, pre-sealed project file set for a repository-wide inventory run.
   * Roots alone are not a project boundary: without this list a file outside
   * the selected tsconfig remains in the environment and can correctly make
   * an EXACT coverage certificate incomplete.
   */
  projectFileIds?: string[];
  experimentalScopedAdmission?: boolean;
}

function deduplicateArtifactRefs(refs: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const result: ArtifactRef[] = [];
  for (const ref of refs) {
    const key = `${ref.domain}:${ref.digest}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ref);
    }
  }
  return result;
}

/**
 * Deduplicates a CanonicalSet by canonical encoding of its members.
 * Preserves insertion order among first-seen members.
 * Does NOT modify CanonicalSet itself — builds a new CanonicalSet from unique elements.
 */
function deduplicateCanonicalSet<T>(set: CanonicalSet<T>): CanonicalSet<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of set) {
    const key = canonicalEncode(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return new CanonicalSet<T>(unique);
}

/**
 * Returns a shallow copy of the DependencyClosureCertificate with all
 * CanonicalSet fields deduplicated by canonical (semantic) identity.
 * Applied at the adapter level after produceClosure — does NOT modify
 * DependencyClosureProducer, CanonicalSet, or any PR0–PR5 contract.
 */
function deduplicateClosure(
  closure: DependencyClosureCertificate & { facts: ResolutionFact[]; edges: DependencyEdge[]; discharges: any[] }
): DependencyClosureCertificate & { facts: ResolutionFact[]; edges: DependencyEdge[]; discharges: any[] } {
  return Object.assign({}, closure, {
    rootVertices: deduplicateCanonicalSet(closure.rootVertices),
    reachedVertices: deduplicateCanonicalSet(closure.reachedVertices),
    dependencyEdgeRefs: deduplicateCanonicalSet(closure.dependencyEdgeRefs),
    resolutionFactRefs: deduplicateCanonicalSet(closure.resolutionFactRefs),
    augmentationFactRefs: deduplicateCanonicalSet(closure.augmentationFactRefs),
    declarationGroups: deduplicateCanonicalSet(closure.declarationGroups),
    traversalCoverage: deduplicateCanonicalSet(closure.traversalCoverage),
    boundaryDischarges: deduplicateCanonicalSet(closure.boundaryDischarges)
  });
}

export class CertifiedCampaignAdapter {
  /**
   * Builds an in-memory SealedFilesystem and canonical EnvironmentManifest
   * from virtual source files.
   */
  public static createVirtualEnvironment(
    files: PilotSourceFile[],
    revisionSha: string = 'rev1',
    repoId: string = 'pilot-repo',
    rootPaths: string[] = files.map(file => file.path),
    treeId: string = `tree-${revisionSha.slice(0, 8)}`
  ): { manifest: EnvironmentManifest; sealedFs: SealedFilesystem } {
    const fileEntries: FileEntry[] = files.map(f => {
      const buf = Buffer.from(f.content, 'utf8');
      const digest = computeDomainSeparatedHash(
        ArtifactDomain.SOURCE_BYTES,
        SAJIMORA_CERTIFIED_EVIDENCE_V1,
        buf
      );
      return {
        fileId: f.path,
        logicalPath: f.path,
        byteLength: buf.length,
        bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest },
        mode: 0o644,
        kind: 'SOURCE',
        origin: 'GIT_OBJECT',
        provenanceRefs: []
      };
    });

    const dataEntries = files.map(f => {
      const buf = Buffer.from(f.content, 'utf8');
      const digest = computeDomainSeparatedHash(
        ArtifactDomain.SOURCE_BYTES,
        SAJIMORA_CERTIFIED_EVIDENCE_V1,
        buf
      );
      return { digest, data: buf };
    });

    const sealedFs = new SealedFilesystem(fileEntries, dataEntries, 'CASE_SENSITIVE');

    const manifest: EnvironmentManifest = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      repositoryId: repoId,
      revision: { commitId: revisionSha, treeId, parentSelection: 'p1' },
      environmentBasis: 'RECORDED_BUILD',
      historicalBindingEvidenceRefs: [],
      namespace: {
        pathPolicyId: 'POLICY_V1',
        caseSensitivity: 'CASE_SENSITIVE',
        unicodePolicy: 'NFC',
        files: fileEntries,
        symlinks: [],
        directoryInventory: [],
        completenessEvidenceRefs: new CanonicalSet<ArtifactRef>([])
      },
      compiler: {
        packageVersion: '5.9.3',
        distributionDigest: '0'.repeat(64),
        parserProfileId: ParserProfileId.TS_5_9_3_STRICT,
        semanticProfileId: SemanticProfileId.TS_FINITE_CONTRACTS_F0
      },
      projects: [
        {
          projectId: 'p0',
          configFileIds: ['tsconfig.json'],
          effectiveOptions: {} as any,
          optionsDerivationRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: '1'.repeat(64) },
          roots: rootPaths.map(fileId => ({ projectId: 'p0', fileId })),
          references: [],
          referenceMode: 'SOURCE'
        }
      ],
      packages: [],
      rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
      admittedRoots: new CanonicalSet<Vertex>(files.map(f => ({ projectId: 'p0', fileId: f.path }))),
      ambientRoots: new CanonicalSet<any>([]),
      generatedArtifacts: new CanonicalSet<any>([]),
      boundaryPolicyId: BoundaryPolicyId.F0_STRICT_BOUNDARY_V1,
      inputEvidenceRefs: new CanonicalSet<ArtifactRef>([])
    };

    return { manifest, sealedFs };
  }

  /**
   * Evaluates a Case-A pilot scenario through the certified PR0-PR5 pipeline.
   */
  public static evaluateCaseA(input: CaseAInput): CertifiedExecutionResult {
    const { manifest: pManifest, sealedFs: pFs } = this.createVirtualEnvironment(
      input.parentFiles,
      'parentRevSha'
    );
    const { manifest: cManifest, sealedFs: cFs } = this.createVirtualEnvironment(
      input.candidateFiles,
      'candidateRevSha'
    );

    const pEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest)
    };
    const cEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest)
    };

    const pRoots = input.parentFiles.map(f => ({ projectId: 'p0', fileId: f.path }));
    const cRoots = input.candidateFiles.map(f => ({ projectId: 'p0', fileId: f.path }));

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const pExtractor = new ASTAnchorExtractor();
    const pResolver = new F0RestrictedResolver(pFs, budget);
    const pClosureProducer = new DependencyClosureProducer(pFs, pExtractor, pResolver);
    const pClosureRaw = pClosureProducer.produceClosure(
      pEnvRef,
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      new CanonicalSet<Vertex>(pRoots)
    );
    const pClosure = deduplicateClosure(pClosureRaw);

    const cExtractor = new ASTAnchorExtractor();
    const cResolver = new F0RestrictedResolver(cFs, budget);
    const cClosureProducer = new DependencyClosureProducer(cFs, cExtractor, cResolver);
    const cClosureRaw = cClosureProducer.produceClosure(
      cEnvRef,
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      new CanonicalSet<Vertex>(cRoots)
    );
    const cClosure = deduplicateClosure(cClosureRaw);

    const pClosureRef: ArtifactRef = {
      domain: ArtifactDomain.CLOSURE,
      digest: hashContract(ArtifactDomain.CLOSURE, pClosure.schemaVersion, pClosure)
    };
    const cClosureRef: ArtifactRef = {
      domain: ArtifactDomain.CLOSURE,
      digest: hashContract(ArtifactDomain.CLOSURE, cClosure.schemaVersion, cClosure)
    };

    const pAdmissionProducer = new FragmentAdmissionProducer(pFs);
    const pAdmission = pAdmissionProducer.produceAdmission(pEnvRef, pClosureRef, Array.from(pClosure.reachedVertices));

    const cAdmissionProducer = new FragmentAdmissionProducer(cFs);
    const cAdmission = cAdmissionProducer.produceAdmission(cEnvRef, cClosureRef, Array.from(cClosure.reachedVertices));

    const pAdmissionRef: ArtifactRef = {
      domain: ArtifactDomain.ADMISSION,
      digest: hashContract(ArtifactDomain.ADMISSION, pAdmission.schemaVersion, pAdmission)
    };
    const cAdmissionRef: ArtifactRef = {
      domain: ArtifactDomain.ADMISSION,
      digest: hashContract(ArtifactDomain.ADMISSION, cAdmission.schemaVersion, cAdmission)
    };

    const targetIdRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: '1'.repeat(64) };
    const lifecycleRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: '2'.repeat(64) };

    const makeSym = (file: string, name: string) => ({
      identityId: name,
      projectId: 'p0',
      moduleIdentity: file,
      ownerChain: [],
      localName: name,
      declarationKind: 'FunctionDeclaration',
      declarationOrdinal: 0,
      sourceSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 11 },
      exportPaths: [file],
      parameterShape: '()',
      astFingerprint: 'fp-pilot'
    });

    const identityBundle: CrossVersionIdentityBundle = {
      targetMappings: [
        {
          parent: makeSym('provider.ts', input.targetSymbol),
          candidate: makeSym('provider.ts', input.targetSymbol),
          status: 'SAME_DECLARATION',
          evidence: [],
          plausibleCandidateIds: [input.targetSymbol]
        }
      ],
      consumerMappings: [],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      cFs,
      input.targetSymbol,
      targetIdRef,
      lifecycleRef
    );

    const proofs = obligations.map(obl =>
      ProofProducer.produceProof(obl, {
        sourceScalar: { kind: 'literal', value: 'valid' },
        targetScalar: input.isCompatibleProof !== false
          ? { kind: 'primitive', name: 'string' }
          : { kind: 'primitive', name: 'number' }
      })
    );

    let coverage = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      input.targetSymbol,
      targetIdRef,
      new CanonicalSet<ArtifactRef>([pAdmissionRef]),
      obligations
    );

    // Pilot 5: Deliberately construct an incomplete coverage certificate
    if (input.omitCoverage) {
      const ledgerArray = Array.from(coverage.contextDispositionLedger);
      // Remove an entry if any exists to produce an incomplete disposition ledger
      const truncatedLedger = ledgerArray.slice(1);
      coverage = {
        ...coverage,
        contextDispositionLedger: new CanonicalSet<any>(truncatedLedger)
      };
    }

    const covRef: ArtifactRef = {
      domain: ArtifactDomain.COVERAGE,
      digest: hashContract(ArtifactDomain.COVERAGE, coverage.schemaVersion, coverage)
    };

    const oblRefs = obligations.map(o => ({
      domain: ArtifactDomain.OBLIGATION,
      digest: hashContract(ArtifactDomain.OBLIGATION, o.schemaVersion, o)
    }));
    const proofRefs = proofs.map(p => ({
      domain: ArtifactDomain.PROOF,
      digest: hashContract(ArtifactDomain.PROOF, p.schemaVersion, p)
    }));

    const bundle: Phase5EvidenceBundle = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION',
      repositoryId: 'pilot-repo',
      parentEnvironmentRef: pEnvRef,
      candidateEnvironmentRef: cEnvRef,
      obligationRequestRef: targetIdRef,
      identityEvidenceRef: targetIdRef,
      dependencyClosureRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs([pClosureRef, cClosureRef])),
      fragmentAdmissionRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs([pAdmissionRef, cAdmissionRef])),
      semanticObligationRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs(oblRefs)),
      semanticProofRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs(proofRefs)),
      coverageRef: covRef,
      normalizationProfileId: NormalizationProfileId.F0_NORMALIZATION_V1,
      ruleSetId: RuleSetId.F0_RULES_V1,
      resourceProfileId: 'INITIAL'
    };

    const executionInput: CertifiedExecutionInput = {
      parentManifest: pManifest,
      candidateManifest: cManifest,
      parentClosure: pClosure,
      candidateClosure: cClosure,
      parentClosureFacts: pClosure.facts,
      candidateClosureFacts: cClosure.facts,
      parentAdmission: pAdmission,
      candidateAdmission: cAdmission,
      identityBundle,
      targetSymbolId: input.targetSymbol,
      invariantId: 'INV_F0',
      obligations,
      proofs,
      coverage,
      bundle,
      parentSealedFs: pFs,
      candidateSealedFs: cFs,
      budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE),
      featureFlags: { ENABLE_TARGET_SCOPED_ADMISSION: false }
    };

    return CertifiedEvaluationOrchestrator.evaluate(executionInput);
  }

  /**
   * Evaluates a real Case-B commit pair through the certified PR0-PR5 pipeline.
   * Reads git objects directly via GitObjectReader without touching the working tree.
   * Preserves UNRESOLVED identity on modified file.
   * Enforces Gate 5 fail-closed behavior: FrozenIdentityGate -> UNKNOWN -> STOP.
   */
  public static evaluateRealCaseB(input: CaseBRealGitInput): CertifiedExecutionResult {
    const repo = new GitRepository(input.repoPath);
    repo.validate();
    const reader = new GitObjectReader(repo);

    // Read the target file content directly from git revisions.
    // Fix B: Catch git cat-file failures (file absent in commit, invalid SHA) and return
    // a structured ENVIRONMENT_INPUT_MISSING result instead of propagating the raw exception.
    let parentFileBuf: Buffer;
    let candidateFileBuf: Buffer;
    try {
      parentFileBuf = repo.buffer(['cat-file', 'blob', `${input.parentSha}:${input.targetFile}`]);
    } catch (e: any) {
      return {
        verdictResult: {
          verdict: 'UNKNOWN',
          auditTrace: {
            authorityDecision: {
              source: 'PIPELINE_RUNTIME',
              gate: 'BUNDLE_INTEGRITY',
              reason: 'ENGINE_RUNTIME_FAILURE',
              stage: 'GIT_OBJECT_READ'
            },
            runtimeFailure: { name: 'GitReadError', message: e.message }
          }
        },
        passedGates: [],
        failedGate: 'BUNDLE_INTEGRITY',
        blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        detailMessage: `Parent blob not found: ${input.parentSha}:${input.targetFile} — ${e.message}`
      };
    }
    try {
      candidateFileBuf = repo.buffer(['cat-file', 'blob', `${input.candidateSha}:${input.targetFile}`]);
    } catch (e: any) {
      return {
        verdictResult: {
          verdict: 'UNKNOWN',
          auditTrace: {
            authorityDecision: {
              source: 'PIPELINE_RUNTIME',
              gate: 'BUNDLE_INTEGRITY',
              reason: 'ENGINE_RUNTIME_FAILURE',
              stage: 'GIT_OBJECT_READ'
            },
            runtimeFailure: { name: 'GitReadError', message: e.message }
          }
        },
        passedGates: [],
        failedGate: 'BUNDLE_INTEGRITY',
        blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        detailMessage: `Candidate blob not found: ${input.candidateSha}:${input.targetFile} — ${e.message}`
      };
    }

    const materializer = new GitTreeSealedEnvironmentMaterializer(repo, reader);
    let parentMaterialized;
    let candidateMaterialized;
    try {
      parentMaterialized = materializer.materialize(input.parentSha);
      candidateMaterialized = materializer.materialize(input.candidateSha);
    } catch (e: any) {
      return {
        verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'ENVIRONMENT', 'DISCOVERY_FAILURE'),
        passedGates: [], failedGate: 'ENVIRONMENT', blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        detailMessage: `Git-tree materialization failed: ${e.message}`
      };
    }
    const selectedProjectFiles = input.projectFileIds ? new Set(input.projectFileIds) : undefined;
    const parentFiles = selectedProjectFiles
      ? parentMaterialized.files.filter(file => selectedProjectFiles.has(file.path) || file.path === 'tsconfig.json' || file.path.endsWith('/tsconfig.json'))
      : parentMaterialized.files;
    const candidateFiles = selectedProjectFiles
      ? candidateMaterialized.files.filter(file => selectedProjectFiles.has(file.path) || file.path === 'tsconfig.json' || file.path.endsWith('/tsconfig.json'))
      : candidateMaterialized.files;
    if (selectedProjectFiles && (!selectedProjectFiles.has(input.targetFile) ||
        (input.consumerFile && !selectedProjectFiles.has(input.consumerFile)))) {
      return { verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'ENVIRONMENT', 'DISCOVERY_FAILURE'),
        passedGates: [], failedGate: 'ENVIRONMENT', blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        detailMessage: 'Selected project file set must include the target and explicit consumer' };
    }

    // Fix C: Wrap the entire pipeline body in a try/catch so that CanonicalSet
    // duplicate-member errors (and any other engine errors) produce a structured
    // CertifiedExecutionResult instead of propagating as uncaught exceptions.
    // Does NOT modify CanonicalSet or any PR0-PR5 contract.
    try {
    const repoId = input.repoId || 'repo';
    const { manifest: pManifest, sealedFs: pFs } = this.createVirtualEnvironment(
      parentFiles,
      input.parentSha,
      repoId,
      input.consumerFile ? [input.targetFile, input.consumerFile] : [input.targetFile],
      parentMaterialized.treeId
    );
    const { manifest: cManifest, sealedFs: cFs } = this.createVirtualEnvironment(
      candidateFiles,
      input.candidateSha,
      repoId,
      input.consumerFile ? [input.targetFile, input.consumerFile] : [input.targetFile],
      candidateMaterialized.treeId
    );

    const pEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest)
    };
    const cEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest)
    };

    const pRoots = (input.consumerFile ? [input.targetFile, input.consumerFile] : [input.targetFile])
      .map(fileId => ({ projectId: 'p0', fileId }));
    const cRoots = (input.consumerFile ? [input.targetFile, input.consumerFile] : [input.targetFile])
      .map(fileId => ({ projectId: 'p0', fileId }));

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const pExtractor = new ASTAnchorExtractor();
    const pResolver = new F0RestrictedResolver(pFs, budget);
    const pClosureProducer = new DependencyClosureProducer(pFs, pExtractor, pResolver);
    const pClosureRaw = pClosureProducer.produceClosure(
      pEnvRef,
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      new CanonicalSet<Vertex>(pRoots)
    );
    const pClosure = deduplicateClosure(pClosureRaw);

    const cExtractor = new ASTAnchorExtractor();
    const cResolver = new F0RestrictedResolver(cFs, budget);
    const cClosureProducer = new DependencyClosureProducer(cFs, cExtractor, cResolver);
    const cClosureRaw = cClosureProducer.produceClosure(
      cEnvRef,
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      new CanonicalSet<Vertex>(cRoots)
    );
    const cClosure = deduplicateClosure(cClosureRaw);

    const pClosureRef: ArtifactRef = {
      domain: ArtifactDomain.CLOSURE,
      digest: hashContract(ArtifactDomain.CLOSURE, pClosure.schemaVersion, pClosure)
    };
    const cClosureRef: ArtifactRef = {
      domain: ArtifactDomain.CLOSURE,
      digest: hashContract(ArtifactDomain.CLOSURE, cClosure.schemaVersion, cClosure)
    };

    // The campaign supplies this only from sealed parent source.  It is a declaration key,
    // not a similarity or name-based identity decision.
    const declarationId = crypto.createHash('sha256')
      .update(`p0|${input.targetFile}|${(input.targetOwnerChain ?? []).join('.')}|${input.targetDeclarationKind ?? 'FunctionDeclaration'}|${input.targetSymbol}|${input.targetDeclarationOrdinal ?? 0}`).digest('hex');
    const correspondence = CertifiedCorrespondence.produce(
      pManifest, cManifest, pFs, cFs, input.targetFile, declarationId);
    const parentIdentity = CertifiedCorrespondence.parentIdentity(pManifest, pFs, input.targetFile, declarationId);
    const parentCallability = classifyF0DirectExportCallability(input.targetFile, parentFileBuf, input.targetSymbol);
    const candidateCallability = classifyF0DirectExportCallability(input.targetFile, candidateFileBuf, input.targetSymbol);
    const isF0NoncallableReplacement = !correspondence && !!parentIdentity &&
      parentCallability.status === 'CALLABLE_FUNCTION' && candidateCallability.status === 'NONCALLABLE_VALUE';
    if ((!correspondence && !isF0NoncallableReplacement) || !input.consumerFile) {
      return { verdictResult: VerdictAuthority.evaluatePreflight('UNKNOWN', 'IDENTITY', 'UNCERTAIN_IDENTITY'),
        passedGates: [], failedGate: 'IDENTITY', blockerCode: BlockerCode.IDENTITY_MISMATCH,
        detailMessage: 'Controlled Case B requires unique sealed correspondence and explicit consumer' };
    }
    const deletionWitnessDigest = isF0NoncallableReplacement
      ? hashContract(ArtifactDomain.IDENTITY, SAJIMORA_CERTIFIED_EVIDENCE_V1, {
          parentIdentity, parentCallability, candidateCallability,
          rule: 'F0_EXPORT_CALLABILITY_FUNCTION_TO_NONCALLABLE'
        }) : undefined;
    const targetIdRef: ArtifactRef = { domain: ArtifactDomain.IDENTITY, digest: correspondence?.digest ?? deletionWitnessDigest! };

    // A separate, explicit consumer file that has no declaration or import
    // binding for the target has a sealed empty controlled closure.  This is
    // NOT_APPLICABLE, not an envelope-construction runtime failure.  Do not
    // generalize this to unresolved/unsupported bindings: those remain
    // fail-closed elsewhere in the pipeline.
    const parentConsumerSource = ts.createSourceFile(input.consumerFile, pFs.readBytes(input.consumerFile).toString('utf8'), ts.ScriptTarget.Latest, true);
    const parentConsumerBindings = F0BindingVerifier.extractModuleBindings(
      { projectId: 'p0', fileId: input.consumerFile }, parentConsumerSource);
    const hasTargetBinding = parentConsumerBindings.result.valid && !!parentConsumerBindings.bindings &&
      (parentConsumerBindings.bindings.symbols.has(input.targetSymbol) ||
       Array.from(parentConsumerBindings.bindings.imports.values()).some(binding => binding.sourceExportName === input.targetSymbol) ||
       parentConsumerBindings.bindings.namespaceImports.size > 0);
    if (!hasTargetBinding) {
      return {
        verdictResult: VerdictAuthority.evaluatePreflight('NOT_APPLICABLE', 'EMPTY_CLOSURE', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'STRUCTURAL_TRIGGER_NO_CONSUMERS'),
        passedGates: ['BUNDLE_INTEGRITY', 'SEALED_ENVIRONMENT', 'DEPENDENCY_CLOSURE', 'VERDICT_AUTHORITY']
      };
    }
    const makeEnvelope = (sealed: SealedFilesystem, closureRef: ArtifactRef): TargetScopedEnvelope => {
      const provider = ts.createSourceFile(input.targetFile, sealed.readBytes(input.targetFile).toString('utf8'), ts.ScriptTarget.Latest, true);
      const consumer = ts.createSourceFile(input.consumerFile!, sealed.readBytes(input.consumerFile!).toString('utf8'), ts.ScriptTarget.Latest, true);
      // The ordinary F0 profile anchors exported functions and direct calls.
      // The only additional controlled profile is an exported type alias used
      // as the annotation of an initialized variable.  It produces the same
      // sealed envelope shape but is not admitted through scoped admission.
      const target = provider.statements.find((node): node is ts.FunctionDeclaration | ts.TypeAliasDeclaration =>
        (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name?.text === input.targetSymbol);
      let consumerAnchor: ts.CallExpression | ts.VariableDeclaration | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) &&
            ((ts.isIdentifier(node.expression) && node.expression.text === (input.consumerLocalName ?? input.targetSymbol)) ||
             (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.name.text === input.targetSymbol))) consumerAnchor = node;
        if (ts.isVariableDeclaration(node) && node.initializer && node.type && ts.isTypeReferenceNode(node.type) &&
            node.type.typeName.getText(consumer) === (input.consumerLocalName ?? input.targetSymbol)) consumerAnchor = node;
        ts.forEachChild(node, visit);
      };
      visit(consumer);
      if (!target || !consumerAnchor) throw new Error('Target declaration or controlled consumer anchor missing');
      return produceTargetScopedEnvelope({
        targetIdentityRef: targetIdRef,
        targetLocalName: input.targetSymbol,
        targetDeclaration: { projectId: 'p0', fileId: input.targetFile, utf16Start: target.getStart(provider), utf16End: target.getEnd(), syntaxKind: target.kind },
        signatureDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: input.targetFile }]),
        implementationDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: input.targetFile }]),
        consumerCallSiteAnchors: new CanonicalSet([{ projectId: 'p0', fileId: input.consumerFile!, utf16Start: consumerAnchor.getStart(consumer), utf16End: consumerAnchor.getEnd(), syntaxKind: consumerAnchor.kind }]),
        closureRef
      });
    };
    const pEnvelope = makeEnvelope(pFs, pClosureRef);
    // A non-callable replacement intentionally has no candidate function
    // anchor.  Scoped admission is therefore unavailable for this narrow
    // deletion branch; exhaustive admission remains sealed and sufficient.
    const cEnvelope = isF0NoncallableReplacement ? pEnvelope : makeEnvelope(cFs, cClosureRef);

    // The default public Case-B path verifies exhaustive F0 admission.  Do not
    // construct a scoped certificate unless the corresponding scoped verifier
    // mode is enabled, otherwise an omitted node is (correctly) rejected as
    // EDGE_OMISSION by the exhaustive verifier.
    const admissionEnvelope = input.experimentalScopedAdmission ? pEnvelope : undefined;
    const candidateAdmissionEnvelope = input.experimentalScopedAdmission ? cEnvelope : undefined;
    const pAdmissionProducer = new FragmentAdmissionProducer(pFs);
    // Admission must cover the complete verified closure, not merely the
    // target/consumer roots.  Otherwise a resolved one-hop re-export is an
    // unrepresented syntax edge and the coverage verifier correctly rejects
    // the Case-B result with EDGE_OMISSION.
    const pAdmission = pAdmissionProducer.produceAdmission(pEnvRef, pClosureRef, Array.from(pClosure.reachedVertices), [], admissionEnvelope);
    const cAdmissionProducer = new FragmentAdmissionProducer(cFs);
    const cAdmission = cAdmissionProducer.produceAdmission(cEnvRef, cClosureRef, Array.from(cClosure.reachedVertices), [], candidateAdmissionEnvelope);

    const pAdmissionRef: ArtifactRef = { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, pAdmission.schemaVersion, pAdmission) };
    const cAdmissionRef: ArtifactRef = { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, cAdmission.schemaVersion, cAdmission) };

    const identityBundle: CrossVersionIdentityBundle = {
      targetMappings: [
        {
          parent: correspondence?.parent ?? parentIdentity!,
          candidate: correspondence?.candidate,
          status: correspondence ? 'UNRESOLVED' : 'REMOVED_DECLARATION',
          evidence: correspondence ? [] : [{ evidenceId: deletionWitnessDigest!, kind: 'DIFF_CORRESPONDENCE',
            detail: 'DECLARATION_DELETED_IN_DIFF_HUNK' }, { evidenceId: deletionWitnessDigest!, kind: 'DECLARATION_KIND',
            detail: 'F0_EXPORT_CALLABILITY_FUNCTION_TO_NONCALLABLE' }],
          plausibleCandidateIds: correspondence ? [correspondence.candidate.identityId] : []
        }
      ],
      certifiedCorrespondences: correspondence ? [correspondence] : [],
      consumerMappings: [],
      status: 'INCOMPLETE',
      blockers: [`UNRESOLVED:${input.targetSymbol}`],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest, cManifest, pFs, cFs, input.targetSymbol, targetIdRef, targetIdRef, correspondence ?? undefined);
    const proofs = obligations.map(obligation => ProofProducer.produceProof(obligation));
    const coverage = CoverageProducer.produceCoverage(
      pManifest, cManifest, pFs, input.targetSymbol, targetIdRef,
      new CanonicalSet<ArtifactRef>([pAdmissionRef]), obligations);

    const covRef: ArtifactRef = {
      domain: ArtifactDomain.COVERAGE,
      digest: hashContract(ArtifactDomain.COVERAGE, coverage.schemaVersion, coverage)
    };
    const oblRefs = obligations.map(o => ({ domain: ArtifactDomain.OBLIGATION,
      digest: hashContract(ArtifactDomain.OBLIGATION, o.schemaVersion, o) }));
    const proofRefs = proofs.map(p => ({ domain: ArtifactDomain.PROOF,
      digest: hashContract(ArtifactDomain.PROOF, p.schemaVersion, p) }));

    const closureRefs = pClosureRef.digest === cClosureRef.digest ? [pClosureRef] : [pClosureRef, cClosureRef];
    const admissionRefs = pAdmissionRef.digest === cAdmissionRef.digest ? [pAdmissionRef] : [pAdmissionRef, cAdmissionRef];

    const bundle: Phase5EvidenceBundle = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION',
      repositoryId: repoId,
      parentEnvironmentRef: pEnvRef,
      candidateEnvironmentRef: cEnvRef,
      obligationRequestRef: targetIdRef,
      identityEvidenceRef: targetIdRef,
      dependencyClosureRefs: new CanonicalSet<ArtifactRef>(closureRefs),
      fragmentAdmissionRefs: new CanonicalSet<ArtifactRef>(admissionRefs),
      semanticObligationRefs: new CanonicalSet<ArtifactRef>(oblRefs),
      semanticProofRefs: new CanonicalSet<ArtifactRef>(proofRefs),
      coverageRef: covRef,
      normalizationProfileId: NormalizationProfileId.F0_NORMALIZATION_V1,
      ruleSetId: RuleSetId.F0_RULES_V1,
      resourceProfileId: 'INITIAL'
    };

    const executionInput: CertifiedExecutionInput = {
      parentManifest: pManifest,
      candidateManifest: cManifest,
      parentClosure: pClosure,
      candidateClosure: cClosure,
      parentClosureFacts: pClosure.facts,
      candidateClosureFacts: cClosure.facts,
      parentAdmission: pAdmission,
      candidateAdmission: cAdmission,
      identityBundle,
      targetSymbolId: declarationId,
      invariantId: 'INV_F0',
      obligations,
      proofs,
      coverage,
      bundle,
      parentSealedFs: pFs,
      candidateSealedFs: cFs,
      budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE),
      featureFlags: { ENABLE_TARGET_SCOPED_ADMISSION: input.experimentalScopedAdmission === true },
      parentTargetScopedEnvelope: pEnvelope,
      candidateTargetScopedEnvelope: cEnvelope
    };

    return CertifiedEvaluationOrchestrator.evaluate(executionInput);
    } catch (e: any) {
      // Structured engine-runtime failure — preserves fail-closed semantics.
      // Used for CanonicalSet duplicate-member and other unexpected pipeline errors.
      return {
        verdictResult: {
          verdict: 'UNKNOWN',
          auditTrace: {
            authorityDecision: {
              source: 'PIPELINE_RUNTIME',
              gate: 'ENGINE_RUNTIME',
              reason: 'ENGINE_RUNTIME_FAILURE',
              stage: 'PIPELINE_BODY'
            },
            runtimeFailure: { name: e.name || 'Error', message: e.message }
          }
        },
        passedGates: [],
        failedGate: 'ENGINE_RUNTIME',
        blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING,
        detailMessage: `Engine runtime error: ${e.message}`
      };
    }
  }

  public static evaluateRealCaseA(input: {
    repoPath: string;
    repoId: string;
    parentSha: string;
    candidateSha: string;
    targetSymbol: string;
    targetFile: string;
    consumerFile: string;
    /** Fixture-only witness selection; defaults to the compatible real Case-A path. */
    isCompatibleProof?: boolean;
    targetOwnerChain?: string[];
    targetDeclarationKind?: string;
    targetDeclarationOrdinal?: number;
    experimentalScopedAdmission?: boolean;
  }): CertifiedExecutionResult {
    const repo = new GitRepository(input.repoPath);
    repo.validate();

    let pTargetBuf: Buffer, pConsumerBuf: Buffer, cTargetBuf: Buffer, cConsumerBuf: Buffer;
    try {
      pTargetBuf = repo.buffer(['cat-file', 'blob', `${input.parentSha}:${input.targetFile}`]);
      pConsumerBuf = repo.buffer(['cat-file', 'blob', `${input.parentSha}:${input.consumerFile}`]);
      cTargetBuf = repo.buffer(['cat-file', 'blob', `${input.candidateSha}:${input.targetFile}`]);
      cConsumerBuf = repo.buffer(['cat-file', 'blob', `${input.candidateSha}:${input.consumerFile}`]);
    } catch (e: any) {
      return {
        verdictResult: {
          verdict: 'UNKNOWN',
          auditTrace: {
            authorityDecision: { source: 'PIPELINE_RUNTIME', gate: 'BUNDLE_INTEGRITY', reason: 'ENGINE_RUNTIME_FAILURE', stage: 'GIT_OBJECT_READ' },
            runtimeFailure: { name: 'GitReadError', message: e.message }
          }
        },
        passedGates: [], failedGate: 'BUNDLE_INTEGRITY', blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING, detailMessage: e.message
      };
    }

    const reader = new GitObjectReader(repo);
    const materializer = new GitTreeSealedEnvironmentMaterializer(repo, reader);

    try {
      const repoId = input.repoId || 'repo';
      const parentMaterialized = materializer.materialize(input.parentSha);
      const candidateMaterialized = materializer.materialize(input.candidateSha);
      const parentFiles = parentMaterialized.files;
      const candidateFiles = candidateMaterialized.files;
      const roots = [input.targetFile, input.consumerFile];
      const { manifest: pManifest, sealedFs: pFs } = this.createVirtualEnvironment(parentFiles, input.parentSha, repoId, roots, parentMaterialized.treeId);
      const { manifest: cManifest, sealedFs: cFs } = this.createVirtualEnvironment(candidateFiles, input.candidateSha, repoId, roots, candidateMaterialized.treeId);

      const pEnvRef: ArtifactRef = { domain: ArtifactDomain.MANIFEST, digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest) };
      const cEnvRef: ArtifactRef = { domain: ArtifactDomain.MANIFEST, digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest) };

      const pRoots = roots.map(fileId => ({ projectId: 'p0', fileId }));
      const cRoots = roots.map(fileId => ({ projectId: 'p0', fileId }));

      const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
      const pExtractor = new ASTAnchorExtractor();
      const pResolver = new F0RestrictedResolver(pFs, budget);
      const pClosureProducer = new DependencyClosureProducer(pFs, pExtractor, pResolver);
      const pClosureRaw = pClosureProducer.produceClosure(pEnvRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet<Vertex>(pRoots));
      const pClosure = deduplicateClosure(pClosureRaw);

      const cExtractor = new ASTAnchorExtractor();
      const cResolver = new F0RestrictedResolver(cFs, budget);
      const cClosureProducer = new DependencyClosureProducer(cFs, cExtractor, cResolver);
      const cClosureRaw = cClosureProducer.produceClosure(cEnvRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet<Vertex>(cRoots));
      const cClosure = deduplicateClosure(cClosureRaw);

      const pClosureRef: ArtifactRef = { domain: ArtifactDomain.CLOSURE, digest: hashContract(ArtifactDomain.CLOSURE, pClosure.schemaVersion, pClosure) };
      const cClosureRef: ArtifactRef = { domain: ArtifactDomain.CLOSURE, digest: hashContract(ArtifactDomain.CLOSURE, cClosure.schemaVersion, cClosure) };

      const targetIdentityId = crypto.createHash('sha256').update(
        `p0|${input.targetFile}|${(input.targetOwnerChain ?? []).join('.')}|${input.targetDeclarationKind ?? 'FunctionDeclaration'}|${input.targetSymbol}|${input.targetDeclarationOrdinal ?? 0}`
      ).digest('hex');
      if (!pTargetBuf.equals(cTargetBuf)) throw new Error('Case-A requires byte-identical provider source');
      const parentIdentity = CertifiedCorrespondence.parentIdentity(pManifest, pFs, input.targetFile, targetIdentityId);
      const candidateIdentity = CertifiedCorrespondence.parentIdentity(cManifest, cFs, input.targetFile, targetIdentityId);
      if (!parentIdentity || !candidateIdentity) throw new Error('Sealed target declaration could not be reconstructed');
      const targetIdRef: ArtifactRef = { domain: ArtifactDomain.IDENTITY,
        digest: hashContract(ArtifactDomain.IDENTITY, SAJIMORA_CERTIFIED_EVIDENCE_V1,
          { parentEnvironment: pEnvRef, candidateEnvironment: cEnvRef, parentIdentity, candidateIdentity }) };
      const lifecycleRef = targetIdRef;

      const makeEnvelope = (sealed: SealedFilesystem, closureRef: ArtifactRef) => {
        const ts = require('typescript');
        const provider = ts.createSourceFile(input.targetFile, sealed.readBytes(input.targetFile).toString('utf8'), ts.ScriptTarget.Latest, true);
        const consumer = ts.createSourceFile(input.consumerFile, sealed.readBytes(input.consumerFile).toString('utf8'), ts.ScriptTarget.Latest, true);
        const target = provider.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === input.targetSymbol);
        let call: any;
        const visit = (node: any) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === input.targetSymbol) call = node; ts.forEachChild(node, visit); };
        visit(consumer);
        if (!target || !call) throw new Error('Target declaration or consumer call-site anchor missing');
        return produceTargetScopedEnvelope({
          targetIdentityRef: targetIdRef,
          targetLocalName: input.targetSymbol,
          targetDeclaration: { projectId: 'p0', fileId: input.targetFile, utf16Start: target.getStart(provider), utf16End: target.getEnd(), syntaxKind: target.kind },
          signatureDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: input.targetFile }]),
          implementationDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: input.targetFile }]),
          consumerCallSiteAnchors: new CanonicalSet([{ projectId: 'p0', fileId: input.consumerFile, utf16Start: call.getStart(consumer), utf16End: call.getEnd(), syntaxKind: call.kind }]),
          closureRef
        });
      };
      const pEnvelope = input.experimentalScopedAdmission ? makeEnvelope(pFs, pClosureRef) : undefined;
      const cEnvelope = input.experimentalScopedAdmission ? makeEnvelope(cFs, cClosureRef) : undefined;

      const pAdmissionProducer = new FragmentAdmissionProducer(pFs);
      const pAdmission = pAdmissionProducer.produceAdmission(pEnvRef, pClosureRef, Array.from(pClosure.reachedVertices), [], pEnvelope);
      const cAdmissionProducer = new FragmentAdmissionProducer(cFs);
      const cAdmission = cAdmissionProducer.produceAdmission(cEnvRef, cClosureRef, Array.from(cClosure.reachedVertices), [], cEnvelope);

      const identityBundle: CrossVersionIdentityBundle = {
        targetMappings: [{ parent: parentIdentity, candidate: candidateIdentity, status: 'SAME_DECLARATION', evidence: [], plausibleCandidateIds: [candidateIdentity.identityId] }],
        certifiedCorrespondences: [], consumerMappings: [], status: 'COMPLETE',
        blockers: [],
        phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
        boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
      };

      const { obligations } = HistoricalObligationGenerator.generateObligations(
        pManifest,
        cManifest,
        pFs,
        cFs,
        input.targetSymbol,
        targetIdRef,
        lifecycleRef
      );

      const proofs = obligations.map(obligation => ProofProducer.produceProof(obligation));

      const pAdmissionRef: ArtifactRef = { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, pAdmission.schemaVersion, pAdmission) };
      const cAdmissionRef: ArtifactRef = { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, cAdmission.schemaVersion, cAdmission) };

      const coverage = CoverageProducer.produceCoverage(
        pManifest,
        cManifest,
        pFs,
        input.targetSymbol,
        targetIdRef,
        new CanonicalSet<ArtifactRef>([pAdmissionRef]),
        obligations
      );

      const covRef: ArtifactRef = {
        domain: ArtifactDomain.COVERAGE,
        digest: hashContract(ArtifactDomain.COVERAGE, coverage.schemaVersion, coverage)
      };

      const oblRefs = obligations.map(o => ({
        domain: ArtifactDomain.OBLIGATION,
        digest: hashContract(ArtifactDomain.OBLIGATION, o.schemaVersion, o)
      }));
      const proofRefs = proofs.map(p => ({
        domain: ArtifactDomain.PROOF,
        digest: hashContract(ArtifactDomain.PROOF, p.schemaVersion, p)
      }));

      const bundle: Phase5EvidenceBundle = {
        schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
        claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION',
        repositoryId: repoId,
        parentEnvironmentRef: pEnvRef,
        candidateEnvironmentRef: cEnvRef,
        obligationRequestRef: targetIdRef,
        identityEvidenceRef: targetIdRef,
        dependencyClosureRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs([pClosureRef, cClosureRef])),
        fragmentAdmissionRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs([pAdmissionRef, cAdmissionRef])),
        semanticObligationRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs(oblRefs)),
        semanticProofRefs: new CanonicalSet<ArtifactRef>(deduplicateArtifactRefs(proofRefs)),
        coverageRef: covRef,
        normalizationProfileId: NormalizationProfileId.F0_NORMALIZATION_V1,
        ruleSetId: RuleSetId.F0_RULES_V1,
        resourceProfileId: 'INITIAL'
      };

      const executionInput: CertifiedExecutionInput = {
        parentManifest: pManifest,
        candidateManifest: cManifest,
        parentClosure: pClosure,
        candidateClosure: cClosure,
        parentClosureFacts: pClosure.facts,
        candidateClosureFacts: cClosure.facts,
        parentAdmission: pAdmission,
        candidateAdmission: cAdmission,
        identityBundle,
        targetSymbolId: targetIdentityId,
        invariantId: 'INV_F0',
        obligations,
        proofs,
        coverage,
        bundle,
        parentSealedFs: pFs,
        candidateSealedFs: cFs,
        budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE),
        featureFlags: { ENABLE_TARGET_SCOPED_ADMISSION: input.experimentalScopedAdmission === true },
        parentTargetScopedEnvelope: pEnvelope,
        candidateTargetScopedEnvelope: cEnvelope
      };

      return CertifiedEvaluationOrchestrator.evaluate(executionInput);
    } catch (e: any) {
      return {
        verdictResult: { verdict: 'UNKNOWN', auditTrace: { authorityDecision: { source: 'PIPELINE_RUNTIME', gate: 'ENGINE_RUNTIME', reason: 'ENGINE_RUNTIME_FAILURE', stage: 'PIPELINE_BODY' }, runtimeFailure: { name: e.name || 'Error', message: e.message } } },
        passedGates: [], failedGate: 'ENGINE_RUNTIME', blockerCode: BlockerCode.ENVIRONMENT_INPUT_MISSING, detailMessage: `Engine error: ${e.message}`
      };
    }
  }
}
