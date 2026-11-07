import { CanonicalSet, hashContract } from '../../packages/core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, NormalizationProfileId, RuleSetId, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../packages/core/src/sajimora/certified/protocol';
import { CoverageCertificate, DependencyClosureCertificate, EnvironmentManifest, FragmentAdmissionCertificate, Phase5EvidenceBundle, SemanticObligation, SemanticProof } from '../../packages/core/src/sajimora/certified/contracts';
import { ArtifactRef } from '../../packages/core/src/sajimora/certified/blockers';

const ref = (domain: ArtifactDomain, schemaVersion: string, value: unknown): ArtifactRef => ({
  domain,
  digest: hashContract(domain, schemaVersion as any, value)
});

export function buildAblationEvidenceBundle(input: {
  repositoryId: string;
  parentManifest: EnvironmentManifest;
  candidateManifest: EnvironmentManifest;
  parentClosure: DependencyClosureCertificate;
  candidateClosure: DependencyClosureCertificate;
  parentAdmission: FragmentAdmissionCertificate;
  candidateAdmission: FragmentAdmissionCertificate;
  obligations: SemanticObligation[];
  proofs: SemanticProof[];
  coverage: CoverageCertificate;
  correspondenceDigest: string;
}): Phase5EvidenceBundle {
  if (!input.correspondenceDigest || input.correspondenceDigest.length !== 64) {
    throw new Error('Ablation evidence requires a verified correspondence digest');
  }
  if (input.obligations.length !== input.proofs.length) {
    throw new Error('Ablation evidence requires one proof per obligation');
  }
  const parentEnvironmentRef = ref(ArtifactDomain.MANIFEST, input.parentManifest.schemaVersion, input.parentManifest);
  const candidateEnvironmentRef = ref(ArtifactDomain.MANIFEST, input.candidateManifest.schemaVersion, input.candidateManifest);
  const closureRefs = new CanonicalSet<ArtifactRef>([
    ref(ArtifactDomain.CLOSURE, input.parentClosure.schemaVersion, input.parentClosure),
    ref(ArtifactDomain.CLOSURE, input.candidateClosure.schemaVersion, input.candidateClosure)
  ]);
  const admissionRefs = new CanonicalSet<ArtifactRef>([
    ref(ArtifactDomain.ADMISSION, input.parentAdmission.schemaVersion, input.parentAdmission),
    ref(ArtifactDomain.ADMISSION, input.candidateAdmission.schemaVersion, input.candidateAdmission)
  ]);
  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION',
    repositoryId: input.repositoryId,
    parentEnvironmentRef,
    candidateEnvironmentRef,
    obligationRequestRef: { domain: ArtifactDomain.IDENTITY, digest: input.correspondenceDigest },
    identityEvidenceRef: { domain: ArtifactDomain.IDENTITY, digest: input.correspondenceDigest },
    dependencyClosureRefs: closureRefs,
    fragmentAdmissionRefs: admissionRefs,
    semanticObligationRefs: new CanonicalSet(input.obligations.map(o => ref(ArtifactDomain.OBLIGATION, o.schemaVersion, o))),
    semanticProofRefs: new CanonicalSet(input.proofs.map(p => ref(ArtifactDomain.PROOF, p.schemaVersion, p))),
    coverageRef: ref(ArtifactDomain.COVERAGE, input.coverage.schemaVersion, input.coverage),
    normalizationProfileId: NormalizationProfileId.F0_NORMALIZATION_V1,
    ruleSetId: RuleSetId.F0_RULES_V1,
    resourceProfileId: 'INITIAL'
  };
}
