import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalSet, hashContract } from '../../packages/core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1, RootPolicyId } from '../../packages/core/src/sajimora/certified/protocol';
import { EnvironmentManifest, ProjectEntry, Vertex } from '../../packages/core/src/sajimora/certified/contracts';
import { SealedFilesystem } from '../../packages/analysis/src/sajimora/certified/environment/SealedFilesystem';
import { ASTAnchorExtractor } from '../../packages/analysis/src/sajimora/certified/closure/ASTExtractor';
import { DependencyClosureProducer } from '../../packages/analysis/src/sajimora/certified/closure/DependencyClosureProducer';
import { FragmentAdmissionProducer } from '../../packages/analysis/src/sajimora/certified/fragment/FragmentAdmissionProducer';
import { CertifiedCorrespondence } from '../../packages/analysis/src/sajimora/certified/identity/CertifiedCorrespondence';
import { HistoricalObligationGenerator } from '../../packages/analysis/src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ProofProducer } from '../../packages/analysis/src/sajimora/certified/proof/ProofProducer';
import { CoverageProducer } from '../../packages/analysis/src/sajimora/certified/coverage/CoverageProducer';
import { F0BindingVerifier } from '../../packages/analysis/src/sajimora/certified/fragment/F0BindingVerifier';
import { F0RestrictedResolver } from '../../packages/analysis/src/sajimora/certified/closure/F0RestrictedResolver';
import { loadAblationSealedFilesystems } from './load_ablation_sealed_filesystem';
import { buildAblationEvidenceBundle } from './AblationEvidenceBundleBuilder';
import { produceTargetScopedEnvelope } from '../../packages/analysis/src/sajimora/certified/fragment/TargetScopedEnvelope';
import { CertifiedEvaluationOrchestrator } from '../../packages/analysis/src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { INITIAL_RESOURCE_PROFILE } from '../../packages/core/src/sajimora/certified/protocol';
import { VerificationBudget } from '../../packages/analysis/src/sajimora/certified/proof/VerificationBudget';
import * as crypto from 'node:crypto';

function manifest(id: string, fs: SealedFilesystem): EnvironmentManifest {
  const files = ['provider.ts', 'consumer.ts'].map(file => fs.getEntry(file)!);
  const project: ProjectEntry = {
    projectId: 'p0', configFileIds: [], effectiveOptions: { strict: true, target: 'ES2020', module: 'CommonJS', noEmit: true } as any,
    optionsDerivationRef: { domain: ArtifactDomain.MANIFEST, digest: '0'.repeat(64) },
    roots: files.map(file => ({ projectId: 'p0', fileId: file.logicalPath })), references: [], referenceMode: 'SOURCE'
  };
  const treeId = hashContract(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, files.map(file => ({ path: file.logicalPath, digest: file.bytesRef.digest })));
  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1, repositoryId: `ablation-${id}`,
    revision: { commitId: `${id}-revision`, treeId, parentSelection: 'NONE' }, environmentBasis: 'RECORDED_BUILD',
    historicalBindingEvidenceRefs: [], namespace: { pathPolicyId: 'POSIX', caseSensitivity: 'CASE_SENSITIVE', unicodePolicy: 'NFC', files, symlinks: [], directoryInventory: [], completenessEvidenceRefs: new CanonicalSet() },
    compiler: { packageVersion: '5.9.3', distributionDigest: '0'.repeat(64), parserProfileId: 'TS_5_9_3_STRICT', semanticProfileId: 'TS_FINITE_CONTRACTS_F0' },
    projects: [project], packages: [], rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
    admittedRoots: new CanonicalSet<Vertex>(project.roots), ambientRoots: new CanonicalSet(), generatedArtifacts: new CanonicalSet(), boundaryPolicyId: 'F0_STRICT_BOUNDARY_V1', inputEvidenceRefs: new CanonicalSet()
  };
}

function targetIdentityId(manifestValue: EnvironmentManifest, sealed: SealedFilesystem): string {
  const source = sealed.readBytes('provider.ts').toString('utf8');
  const sf = require('typescript').createSourceFile('provider.ts', source, require('typescript').ScriptTarget.Latest, true);
  const fn = sf.statements.find((statement: any) => require('typescript').isFunctionDeclaration(statement) && statement.name?.text === 'target');
  if (!fn) throw new Error('target declaration not found');
  const projectId = manifestValue.projects[0].projectId;
  return crypto.createHash('sha256').update(`${projectId}|provider.ts||FunctionDeclaration|target|0`).digest('hex');
}

function envelopeFor(id: string, manifestValue: EnvironmentManifest, sealed: SealedFilesystem, closureRef: any, identityDigest: string) {
  const ts = require('typescript');
  const provider = ts.createSourceFile('provider.ts', sealed.readBytes('provider.ts').toString('utf8'), ts.ScriptTarget.Latest, true);
  const consumer = ts.createSourceFile('consumer.ts', sealed.readBytes('consumer.ts').toString('utf8'), ts.ScriptTarget.Latest, true);
  const target = provider.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === 'target');
  let call: any;
  const visit = (node: any) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'target') call = node; ts.forEachChild(node, visit); };
  visit(consumer);
  if (!target || !call) throw new Error(`${id}: target declaration or call site missing`);
  return produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: identityDigest }, targetLocalName: 'target',
    targetDeclaration: { projectId: 'p0', fileId: 'provider.ts', utf16Start: target.getStart(provider), utf16End: target.getEnd(), syntaxKind: target.kind },
    signatureDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: 'provider.ts' }]),
    implementationDependencyVertices: new CanonicalSet([{ projectId: 'p0', fileId: 'provider.ts' }]),
    consumerCallSiteAnchors: new CanonicalSet([{ projectId: 'p0', fileId: 'consumer.ts', utf16Start: call.getStart(consumer), utf16End: call.getEnd(), syntaxKind: call.kind }]),
    closureRef
  });
}

export function runAblationProducers(inputPath: string, scopedAdmission = true) {
  const loaded = loadAblationSealedFilesystems(inputPath);
  return [...loaded].map(([id, revisions]) => {
    try {
      const parentManifest = manifest(id, revisions.parent);
      const candidateManifest = manifest(id, revisions.candidate);
      const budget = new VerificationBudget({ maxWorkUnits: 100000, maxBytes: 10000000, maxNodes: 100000 } as any);
      const targetId = targetIdentityId(parentManifest, revisions.parent);
      const correspondence = CertifiedCorrespondence.produce(parentManifest, candidateManifest, revisions.parent, revisions.candidate, 'provider.ts', targetId);
      if (!correspondence) return { id, status: 'UNKNOWN', reason: 'identity correspondence could not be produced' };
      const produce = (sealed: SealedFilesystem, env: EnvironmentManifest, identityDigest: string) => {
        const envRef = { domain: ArtifactDomain.MANIFEST, digest: hashContract(ArtifactDomain.MANIFEST, env.schemaVersion, env) };
        // Start from the consumer only; the provider must be reached through
        // the direct relative import so closure completeness is exercised.
        const roots = new CanonicalSet<Vertex>([{ projectId: 'p0', fileId: 'consumer.ts' }]);
        const closure = new DependencyClosureProducer(sealed, new ASTAnchorExtractor(), new F0RestrictedResolver(sealed, budget)).produceClosure(envRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, roots, { manifest: env });
        const closureRef = { domain: ArtifactDomain.CLOSURE, digest: hashContract(ArtifactDomain.CLOSURE, closure.schemaVersion, closure) };
        const envelope = envelopeFor(id, env, sealed, closureRef, identityDigest);
        const admission = new FragmentAdmissionProducer(sealed).produceAdmission(envRef, closureRef, Array.from(closure.reachedVertices), [], envelope);
        return { reached: closure.reachedVertices.size, admissionStatus: (admission as any).status ?? admission.profileId, admission, closure, envRef, closureRef, envelope };
      };
      const parent = produce(revisions.parent, parentManifest, correspondence.digest);
      const candidate = produce(revisions.candidate, candidateManifest, correspondence.digest);
      const identityRef = { domain: ArtifactDomain.IDENTITY, digest: correspondence.digest };
      const correspondenceVerified = CertifiedCorrespondence.verify(correspondence, parentManifest, candidateManifest, revisions.parent, revisions.candidate, targetId);
      const bindingDiagnostics = ['consumer.ts', 'provider.ts'].map(file => {
        const ts = require('typescript');
        const sf = ts.createSourceFile(file, revisions.parent.readBytes(file).toString('utf8'), ts.ScriptTarget.Latest, true);
        const extracted = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: file }, sf);
        return { file, valid: extracted.result.valid, detail: extracted.result.reason, imports: extracted.bindings ? [...extracted.bindings.imports.keys()] : [], exports: extracted.bindings ? [...extracted.bindings.exportedSymbols.keys()] : [] };
      });
      const resolver = new F0RestrictedResolver(revisions.parent);
      const moduleResolution = resolver.resolve('./provider.ts', 'consumer.ts');
      // Obligation discovery matches the local symbol name; identity remains
      // separately bound through targetIdentityId and the correspondence ref.
      const obligations = HistoricalObligationGenerator.generateObligations(parentManifest, candidateManifest, revisions.parent, revisions.candidate, 'target', identityRef, identityRef, correspondence);
      if (obligations.obligations.length === 0) return { id, status: 'UNKNOWN', reason: 'no historical call-site obligations discovered', occurrences: obligations.occurrences.length, bindingDiagnostics, moduleResolution, correspondenceVerified, identity: { certified: true }, parent: { reached: parent.reached }, candidate: { reached: candidate.reached } };
      const proofs = obligations.obligations.map(obligation => ProofProducer.produceProof(obligation));
      if (proofs.length !== obligations.obligations.length) return { id, status: 'UNKNOWN', reason: 'proof production did not cover every obligation' };
      const admissionRefs = new CanonicalSet<any>([
        { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, parent.admission.schemaVersion, parent.admission) },
        { domain: ArtifactDomain.ADMISSION, digest: hashContract(ArtifactDomain.ADMISSION, candidate.admission.schemaVersion, candidate.admission) }
      ]);
      const coverage = CoverageProducer.produceCoverage(parentManifest, candidateManifest, revisions.parent, 'target', identityRef, admissionRefs, obligations.obligations);
      const bundle = buildAblationEvidenceBundle({
        repositoryId: `ablation-${id}`,
        parentManifest,
        candidateManifest,
        parentClosure: parent.closure,
        candidateClosure: candidate.closure,
        parentAdmission: parent.admission,
        candidateAdmission: candidate.admission,
        obligations: obligations.obligations,
        proofs,
        coverage,
        correspondenceDigest: correspondence.digest
      });
      const identityBundle: any = {
        targetMappings: [{ parent: correspondence.parent, candidate: correspondence.candidate, status: 'UNRESOLVED', evidence: [], plausibleCandidateIds: [correspondence.candidate.identityId] }],
        certifiedCorrespondences: [correspondence], consumerMappings: [], status: 'INCOMPLETE', blockers: [],
        phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
        boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
      };
      const orchestrated = CertifiedEvaluationOrchestrator.evaluate({
        parentManifest, candidateManifest,
        parentClosure: parent.closure, candidateClosure: candidate.closure,
        parentClosureFacts: parent.closure.facts, candidateClosureFacts: candidate.closure.facts,
        parentAdmission: parent.admission, candidateAdmission: candidate.admission,
        identityBundle, targetSymbolId: targetId, invariantId: 'INV_F0',
        obligations: obligations.obligations, proofs, coverage, bundle,
        parentSealedFs: revisions.parent, candidateSealedFs: revisions.candidate,
        parentTargetScopedEnvelope: parent.envelope,
        candidateTargetScopedEnvelope: candidate.envelope,
        budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE),
        featureFlags: { ENABLE_TARGET_SCOPED_ADMISSION: scopedAdmission }
      });
      return { id, status: 'EVALUATED', verdict: orchestrated.verdictResult.verdict, passedGates: orchestrated.passedGates, failedGate: orchestrated.failedGate, blockerCode: orchestrated.blockerCode, detailMessage: orchestrated.detailMessage, obligations: obligations.obligations.length, proofs: proofs.length, coverage: true, coverageEntries: coverage.contextDispositionLedger.size, bundleBound: true };
    } catch (error) {
      return { id, status: 'UNKNOWN', reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

if (require.main === module) {
  const input = path.resolve(process.argv[2] ?? 'scripts/campaign/fixtures/ablation_8_cases_sealed.json');
  console.log(JSON.stringify({ schemaVersion: 'V33_ABLATION_PRODUCER_RUN_V1', scopedAdmission: !process.argv.includes('--flag-off'), results: runAblationProducers(input, !process.argv.includes('--flag-off')) }, null, 2));
}
