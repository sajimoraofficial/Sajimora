import {
  ClosureEvidence, ClosureName, CompleteProofEvidence, CompatibilityResult, ProofResult,
  SemanticScopeCalculator, UsageSite, VerdictAuthority
} from '@sajimora/core';
import { TypeScriptCompatibility } from '../compatibility/TypeScriptCompatibility';
import { AuthorityIntegrationLayer } from '../compatibility/AuthorityIntegrationLayer';
import { Phase4SemanticProvider, ProviderCandidateContract, ProviderHistoricalObligation } from '../compatibility/Phase4SemanticProvider';
import { CommitManifest, GenerationIndexDatabase } from './GenerationIndexDatabase';
import { DerivedIndexedObligation, IndexedPairDeriver } from './IndexedPairDeriver';
import { IndexedConsumerFact } from './IndexedFacts';
import { INDEX_EXTRACTOR_VERSION, INDEX_PROOF_RULES_VERSION, INDEX_SCHEMA_VERSION } from './IndexIdentity';
import { VerifiedDependencyEnvironment } from './VerifiedDependencyEnvironment';

export type IndexedQueryFailureStatus = 'INDEXING_PENDING' | 'INDEX_INCOMPATIBLE' | 'INDEX_CORRUPT';
export type IndexedQueryV2Result =
  | { readonly status: 'COMPLETED'; readonly parentManifestHash: string; readonly candidateManifestHash: string; readonly results: readonly { obligationId: string; proof: ProofResult }[] }
  | { readonly status: IndexedQueryFailureStatus; readonly blockers: readonly string[] };

class DerivedFactProvider implements Phase4SemanticProvider {
  public constructor(private readonly derived: DerivedIndexedObligation) {}

  public getCandidateContract(targetSymbolId: string, targetName: string): ProviderCandidateContract {
    if (targetSymbolId !== this.derived.parentDeclaration.persistentSymbolId) {
      return { targetSymbolId, targetName, blockerId: 'CANDIDATE_DECLARATION_MISSING', errorDetail: 'Canonical target identity mismatch' };
    }
    if (!this.derived.candidateDeclaration) return { targetSymbolId, targetName, isDeleted: true };
    return { targetSymbolId, targetName, contractIR: this.derived.candidateDeclaration.contract };
  }

  public getHistoricalObligation(site: UsageSite): ProviderHistoricalObligation {
    const fact = this.derived.parentConsumers.find(consumer => consumer.occurrenceId === site.usageSiteId);
    if (!fact) return { usageSiteId: site.usageSiteId, occurrenceId: site.canonicalOccurrence.occurrenceId, blockerId: 'HISTORICAL_EXPECTATION_UNRECOVERABLE', errorDetail: 'Parent occurrence is not present in the manifest-bound consumer index' };
    return { usageSiteId: fact.occurrenceId, occurrenceId: fact.occurrenceId, specializedContract: fact.historicalUsage };
  }
}

export class IndexedQueryEngineV2 {
  private readonly deriver = new IndexedPairDeriver();

  public evaluate(database: GenerationIndexDatabase, repositoryId: string, parentSha: string, candidateSha: string,
    environment?: VerifiedDependencyEnvironment): IndexedQueryV2Result {
    let parent: CommitManifest | undefined;
    let candidate: CommitManifest | undefined;
    try {
      parent = database.getPublishedManifest(repositoryId, parentSha, INDEX_SCHEMA_VERSION);
      candidate = database.getPublishedManifest(repositoryId, candidateSha, INDEX_SCHEMA_VERSION);
    } catch (error) {
      return { status: 'INDEX_CORRUPT', blockers: [error instanceof Error ? error.message : String(error)] };
    }
    if (!parent || !candidate) return { status: 'INDEXING_PENDING', blockers: [!parent ? `MISSING_PARENT_INDEX:${parentSha}` : '', !candidate ? `MISSING_CANDIDATE_INDEX:${candidateSha}` : ''].filter(Boolean) };
    if (parent.identity.repositoryId !== repositoryId || candidate.identity.repositoryId !== repositoryId) return { status: 'INDEX_INCOMPATIBLE', blockers: ['REPOSITORY_IDENTITY_MISMATCH'] };
    for (const manifest of [parent, candidate]) {
      if (manifest.identity.schemaVersion !== INDEX_SCHEMA_VERSION ||
        manifest.identity.extractorVersion !== INDEX_EXTRACTOR_VERSION ||
        manifest.identity.proofRulesVersion !== INDEX_PROOF_RULES_VERSION) {
        return { status: 'INDEX_INCOMPATIBLE', blockers: [`INDEX_RULESET_STALE:${manifest.identity.commitSha}`] };
      }
    }
    if (parent.identity.externalDependencyFingerprint !== 'NONE' ||
      candidate.identity.externalDependencyFingerprint !== 'NONE') {
      if (!environment) return { status: 'INDEX_INCOMPATIBLE', blockers: ['EXTERNAL_DEPENDENCY_ENVIRONMENT_REQUIRED'] };
      if (!VerifiedDependencyEnvironment.consume(environment, parent, candidate)) return { status: 'INDEX_INCOMPATIBLE',
        blockers: ['EXTERNAL_DEPENDENCY_ENVIRONMENT_STALE'] };
    }

    try {
      this.assertCertificates(database, parent);
      this.assertCertificates(database, candidate);
      const derived = this.deriver.derive(database, parent, candidate);
      const results = derived.map(item => ({ obligationId: item.obligation.invariantId, proof: this.evaluateObligation(database, parent!, item) }));
      return { status: 'COMPLETED', parentManifestHash: parent.manifestHash, candidateManifestHash: candidate.manifestHash, results };
    } catch (error) {
      return { status: 'INDEX_INCOMPATIBLE', blockers: [error instanceof Error ? error.message : String(error)] };
    }
  }

  private assertCertificates(database: GenerationIndexDatabase, manifest: CommitManifest): void {
    for (const project of database.getProjectManifests(manifest.generationId)) {
      const certificate = database.getCertificate(manifest.generationId, project.identity.projectId);
      if (!certificate || !certificate.isComplete || certificate.generationContentHash !== manifest.generationContentHash || certificate.certificateHash !== project.certificateHash) {
        throw new Error(`INDEX_CERTIFICATE_INCOMPLETE:${project.identity.projectId}`);
      }
      if (certificate.blockers.length > 0 || certificate.unsupportedRelationshipClasses.length > 0) {
        throw new Error(`INDEX_CERTIFICATE_UNSUPPORTED:${project.identity.projectId}`);
      }
    }
  }

  private evaluateObligation(database: GenerationIndexDatabase, parent: CommitManifest, derived: DerivedIndexedObligation): ProofResult {
    if (derived.mapping.status === 'IDENTITY_UNPROVEN') {
      return { verdict: 'UNKNOWN', auditTrace: { authorityDecision: {
        source: 'PIPELINE_RUNTIME', gate: 'INDEXED_IDENTITY_GATE', reason: 'UNCERTAIN_IDENTITY', stage: 'QUERY'
      } } };
    }
    const provider = new DerivedFactProvider(derived);
    const compatibility = new TypeScriptCompatibility(undefined, derived.obligation, { isPhase4Mode: true, provider });
    const sites = derived.parentConsumers.map(consumer => this.toUsageSite(consumer));
    const compatibilityResults = new Map<string, CompatibilityResult>();
    for (const site of sites) compatibilityResults.set(site.usageSiteId, compatibility.evaluateSite(site));
    const occurrences = sites.map(site => site.canonicalOccurrence);
    const closure = (closureName: ClosureName, selected: UsageSite[]): ClosureEvidence => ({
      closureName, occurrences: selected.map(site => site.canonicalOccurrence), completeness: 'COMPLETE',
      failures: [], ambiguities: [], unrecognizedForms: [], provenance: []
    });
    const files = database.getProjectManifests(parent.generationId).flatMap(project =>
      database.getArtifacts<{ normalizedPath: string }>(parent.generationId, project.identity.projectId, 'FILE').map(row => row.payload.normalizedPath)
    ).sort();
    const evidence: CompleteProofEvidence<any> = {
      triggerData: null,
      obligation: derived.obligation,
      analysisUniverse: {
        rootPath: `index://${parent.identity.repositoryId}/${parent.identity.commitSha}`,
        discoveredFiles: files,
        discoveredFileSet: new Set(files),
        excludedFiles: new Map(), unsupportedFiles: [], unreadableFiles: [], parseFailures: new Map(),
        discoveryStatus: 'DISCOVERY_COMPLETE', discoveryEvidence: `manifest:${parent.manifestHash}`
      },
      closures: {
        valueReference: closure('ValueReferenceClosure', sites.filter(site => !['TYPE_ANNOTATION', 'INHERITANCE', 'INTERFACE_IMPLEMENTATION'].includes(site.canonicalOccurrence.usageRole))),
        typeReference: closure('TypeReferenceClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'TYPE_ANNOTATION')),
        inheritance: closure('InheritanceClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'INHERITANCE')),
        interfaceImpl: closure('InterfaceImplClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'INTERFACE_IMPLEMENTATION')),
        override: closure('OverrideClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'METHOD_OVERRIDE')),
        reExport: closure('ReExportClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'RE_EXPORTER')),
        ambientReference: closure('AmbientReferenceClosure', sites.filter(site => site.canonicalOccurrence.usageRole === 'AMBIENT_AUGMENTATION'))
      },
      canonicalOccurrences: sites,
      identityResults: sites.map(site => ({ usageSiteId: site.usageSiteId, referencedSymbol: site.canonicalOccurrence.referencedSymbol, declarationSymbol: site.canonicalOccurrence.declarationSymbol, resolutionStatus: site.canonicalOccurrence.resolutionStatus, identityResult: site.identityResult, evaluationStatus: site.evaluationStatus })),
      compatibilityResults,
      semanticScope: SemanticScopeCalculator.calculate(derived.obligation, 'typescript', derived.obligation.mutatedSymbol!.kind)
    };
    const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(evidence, {
      isPhase4Mode: true,
      discoveredHistoricalConsumerIds: sites.map(site => site.usageSiteId),
      candidateAddedConsumerIds: [], ambiguousLifecycleConsumerIds: [], mappedHistoricalConsumerIds: new Map()
    });
    return VerdictAuthority.evaluateProof(reconciled);
  }

  private toUsageSite(fact: IndexedConsumerFact): UsageSite {
    return {
      usageSiteId: fact.occurrenceId,
      canonicalOccurrence: {
        occurrenceId: fact.occurrenceId, sourceFile: fact.filePath,
        sourceSpan: { start: fact.start, end: fact.end, line: fact.line, column: fact.column },
        syntaxKind: 0,
        semanticRole: fact.usageRole === 'TYPE_ANNOTATION' ? 'TYPE' : 'VALUE',
        usageRole: fact.usageRole,
        referencedSymbol: fact.targetDeclarationId, declarationSymbol: fact.targetDeclarationId,
        resolutionStatus: 'RESOLVED', enumerationStatus: 'COMPLETE', provenance: []
      },
      existenceAtParent: 'PRESENT', mutationStatus: 'UNCHANGED', bindingPresenceAtCandidate: 'PRESENT',
      bindingState: 'BOUND', evaluationStatus: fact.usageRole === 'RE_EXPORTER' ? 'EXCLUDED_RE_EXPORTER' : 'EVALUABLE',
      identityResult: 'SAME', enumerationInconsistencyCause: null,
      provenance: fact.usageRole === 'RE_EXPORTER' ? 'RE_EXPORTED' : 'UNCHANGED'
    };
  }
}
