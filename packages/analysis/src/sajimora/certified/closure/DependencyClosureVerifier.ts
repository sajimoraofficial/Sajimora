import { 
  DependencyClosureCertificate, 
  Vertex,
  DependencyEdge,
  ResolutionFact,
  AmbientRoot,
  EnvironmentManifest
} from '../../../../../core/src/sajimora/certified/contracts';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { ASTAnchorExtractor, ExtractedAnchor } from './ASTExtractor';
import { F0RestrictedResolver } from './F0RestrictedResolver';
import { VerificationResult, BlockerCode } from '../../../../../core/src/sajimora/certified/blockers';
import { VerificationBudget, VerificationBudgetExhaustedError } from '../proof/VerificationBudget';
import { ArtifactDomain, RootPolicyId, ResolverProfileId, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../../core/src/sajimora/certified/protocol';
import { hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';

export interface BoundaryDischarge {
  anchor: ExtractedAnchor;
  targetVertex: Vertex;
  ambientRoot: AmbientRoot;
  justification: string;
}

export interface ClosureEvidenceStore {
  getFact?(digest: string): ResolutionFact | undefined;
  getEdge?(digest: string): DependencyEdge | undefined;
  getManifest?(digest: string): EnvironmentManifest | undefined;
}

export interface VerificationContext {
  manifest?: EnvironmentManifest;
  facts?: ResolutionFact[];
  edges?: DependencyEdge[];
  discharges?: BoundaryDischarge[];
  evidenceStore?: ClosureEvidenceStore;
}

export class DependencyClosureVerifier {
  constructor(
    private readonly sealedFs: SealedFilesystem,
    private readonly extractor: ASTAnchorExtractor,
    private readonly resolver: F0RestrictedResolver,
    private readonly budget: VerificationBudget,
    private readonly defaultManifest?: EnvironmentManifest,
    private readonly defaultEvidenceStore?: ClosureEvidenceStore
  ) {}

  /**
   * Independently verifies the entire DependencyClosureCertificate.
   * Does NOT trust producer evidence.
   * Performs:
   * SealedFilesystem source bytes
   * -> independent pinned AST parse
   * -> exhaustive anchor extraction
   * -> canonical anchor representation
   * -> domain-separated syntax digest
   * -> comparison against certificate
   * -> exact anchor identity verification
   * -> independent resolution / ambient root discharge verification
   * -> fixed-point closure reachability
   */
  public verify(
    cert: DependencyClosureCertificate,
    context?: VerificationContext
  ): VerificationResult {
    try {
      this.budget.allocate('WORK_UNITS', 1);

      // 1. Validate protocol & root policy
      if (cert.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
        return this.reject(
          BlockerCode.UNSUPPORTED_PROTOCOL,
          `Unsupported protocol version: ${cert.schemaVersion}`
        );
      }

      if (cert.rootPolicyId !== RootPolicyId.F0_ENV_GIT_SEALED_V1) {
        return this.reject(
          BlockerCode.UNSUPPORTED_CONFIGURATION,
          `Unsupported root selection policy: ${cert.rootPolicyId}`
        );
      }

      // 2. Validate EnvironmentManifest if provided
      const manifest = context?.manifest || this.defaultManifest;
      if (manifest) {
        const expectedManifestDigest = hashContract(
          ArtifactDomain.MANIFEST,
          cert.schemaVersion,
          manifest
        );
        if (expectedManifestDigest !== cert.environmentRef.digest) {
          return this.reject(
            BlockerCode.HASH_MISMATCH,
            `EnvironmentManifest digest mismatch. Expected: ${cert.environmentRef.digest}, Actual: ${expectedManifestDigest}`
          );
        }
      }

      // 3. Roots verification: root vertices must belong to reached vertices
      for (const root of cert.rootVertices) {
        let rootReached = false;
        for (const reached of cert.reachedVertices) {
          if (reached.projectId === root.projectId && reached.fileId === root.fileId) {
            rootReached = true;
            break;
          }
        }
        if (!rootReached) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Root vertex omitted from reachedVertices: ${root.fileId}`
          );
        }
      }

      // 4. Traversal coverage bijection: every reached vertex must have coverage, and vice versa
      const reachedMap = new Map<string, Vertex>();
      for (const v of cert.reachedVertices) {
        const key = `${v.projectId}:${v.fileId}`;
        reachedMap.set(key, v);
      }

      const coverageMap = new Map<string, { vertex: Vertex; parsedSyntaxDigest: string; dependencyAnchorIds: string[] }>();
      for (const cov of cert.traversalCoverage) {
        const key = `${cov.vertex.projectId}:${cov.vertex.fileId}`;
        if (coverageMap.has(key)) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Duplicate traversal coverage entry for vertex: ${cov.vertex.fileId}`
          );
        }
        coverageMap.set(key, cov);
      }

      for (const [key, v] of reachedMap) {
        if (!coverageMap.has(key)) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Vertex in reachedVertices lacks traversal coverage: ${v.fileId}`
          );
        }
      }

      for (const [key, cov] of coverageMap) {
        if (!reachedMap.has(key)) {
          return this.reject(
            BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION,
            `Vertex in traversal coverage not in reachedVertices: ${cov.vertex.fileId}`
          );
        }
      }

      // Collect all independently extracted anchors per vertex
      const vertexAnchorsMap = new Map<string, ExtractedAnchor[]>();

      // 5. Independent AST parsing, syntax digest, and canonical anchor identity validation
      for (const cov of cert.traversalCoverage) {
        this.budget.allocate('VERTICES', 1);

        if (!this.sealedFs.exists(cov.vertex.fileId)) {
          return this.reject(
            BlockerCode.RESOLUTION_TARGET_UNPROVEN,
            `Vertex missing in sealed fs: ${cov.vertex.fileId}`
          );
        }

        const sourceBytes = this.sealedFs.readBytes(cov.vertex.fileId);
        const independentAnchors = this.extractor.extractAnchors(cov.vertex, sourceBytes);

        // Check for unsupported syntax
        for (const a of independentAnchors) {
          if (a.syntaxKind === 'UNSUPPORTED_SYNTAX') {
            return this.reject(
              BlockerCode.UNSUPPORTED_SYNTAX,
              `Unsupported syntax encountered in ${cov.vertex.fileId}: ${a.specifier}`
            );
          }
        }

        const independentDigest = this.extractor.computeSyntaxDigest(cov.vertex, independentAnchors);
        if (independentDigest !== cov.parsedSyntaxDigest) {
          return this.reject(
            BlockerCode.HASH_MISMATCH,
            `Syntax digest mismatch for ${cov.vertex.fileId}. Expected: ${cov.parsedSyntaxDigest}, Actual: ${independentDigest}`
          );
        }

        // Exact canonical anchor identity checks (no count-only checks)
        const certAnchorIds = cov.dependencyAnchorIds;
        const certAnchorSet = new Set(certAnchorIds);
        if (certAnchorSet.size !== certAnchorIds.length) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Duplicate anchor ID in coverage for ${cov.vertex.fileId}`
          );
        }

        const independentAnchorIds = independentAnchors.map(a => this.extractor.canonicalAnchorId(a));
        const indAnchorSet = new Set(independentAnchorIds);

        if (certAnchorIds.length !== independentAnchorIds.length) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Anchor count mismatch for ${cov.vertex.fileId}. Claimed: ${certAnchorIds.length}, Independent: ${independentAnchorIds.length}`
          );
        }

        for (const id of independentAnchorIds) {
          if (!certAnchorSet.has(id)) {
            return this.reject(
              BlockerCode.EDGE_OMISSION,
              `Omitted anchor in certificate: ${id}`
            );
          }
        }

        for (const id of certAnchorIds) {
          if (!indAnchorSet.has(id)) {
            return this.reject(
              BlockerCode.EDGE_OMISSION,
              `Forged or unknown anchor in certificate: ${id}`
            );
          }
        }

        const key = `${cov.vertex.projectId}:${cov.vertex.fileId}`;
        vertexAnchorsMap.set(key, independentAnchors);
      }

      // 6. Build evidence resolution maps
      const factsMap = new Map<string, ResolutionFact>(); // key: containingFile + '::' + specifier
      const dischargesMap = new Map<string, BoundaryDischarge>(); // key: anchor canonical ID

      if (context?.facts) {
        for (const f of context.facts) {
          const reqObj = f.request as { payload?: unknown };
          const p = reqObj?.payload as { containingFile?: unknown; specifier?: unknown } | undefined;
          if (p && typeof p.containingFile === 'string' && typeof p.specifier === 'string') {
            factsMap.set(`${p.containingFile}::${p.specifier}`, f);
          }
        }
      }

      if (context?.discharges) {
        for (const d of context.discharges) {
          const id = this.extractor.canonicalAnchorId(d.anchor);
          dischargesMap.set(id, d);
        }
      }

      // 7. Verify every extracted dependency anchor
      for (const [key, anchors] of vertexAnchorsMap) {
        const [projectId, fileId] = key.split(':');
        const vertex: Vertex = { projectId, fileId };

        for (const anchor of anchors) {
          this.budget.allocate('EDGES', 1);

          const anchorId = this.extractor.canonicalAnchorId(anchor);
          const fact = factsMap.get(`${fileId}::${anchor.specifier}`);
          const discharge = dischargesMap.get(anchorId);

          // Rule: Exactly one applicable ResolutionFact OR valid AmbientRoot discharge
          if (!fact && !discharge) {
            if (anchor.syntaxKind === 'TRIPLE_SLASH_TYPES' || anchor.syntaxKind === 'TRIPLE_SLASH_LIB') {
              return this.reject(
                BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION,
                `Missing AmbientRoot discharge for ${anchorId}`
              );
            }
            return this.reject(
              BlockerCode.MISSING_EVIDENCE,
              `Missing ResolutionFact for anchor ${anchorId}`
            );
          }

          if (fact && discharge) {
            return this.reject(
              BlockerCode.AMBIGUOUS_DECLARATION_GROUP,
              `Conflicting ResolutionFact and AmbientRoot discharge for anchor ${anchorId}`
            );
          }

          if (fact) {
            // Independently verify resolution fact
            const factVerification = this.resolver.verifyFact(fact);
            if (factVerification.status !== 'VERIFIED') {
              return factVerification;
            }

            // If resolved, verify target membership in reachedVertices
            if (fact.outcome === 'RESOLVED') {
              if (!fact.selectedTargetOrNull) {
                return this.reject(
                  BlockerCode.HASH_MISMATCH,
                  `Fact outcome is RESOLVED but selectedTargetOrNull is null for ${anchorId}`
                );
              }

              if (!this.sealedFs.exists(fact.selectedTargetOrNull)) {
                return this.reject(
                  BlockerCode.RESOLUTION_TARGET_UNPROVEN,
                  `Resolved target missing in sealed fs: ${fact.selectedTargetOrNull}`
                );
              }

              const targetKey = `${projectId}:${fact.selectedTargetOrNull}`;
              if (!reachedMap.has(targetKey)) {
                return this.reject(
                  BlockerCode.EDGE_OMISSION,
                  `Resolved target vertex omitted from reachedVertices: ${targetKey}`
                );
              }
            }
          }

          if (discharge) {
            // Independently verify AmbientRoot discharge
            if (!manifest) {
              return this.reject(
                BlockerCode.MISSING_EVIDENCE,
                `EnvironmentManifest required to independently verify AmbientRoot discharge for ${anchorId}`
              );
            }

            // Validate root identity against sealed environment manifest
            let foundInManifest = false;
            for (const root of manifest.ambientRoots) {
              if (
                root.vertex.projectId === discharge.ambientRoot.vertex.projectId &&
                root.vertex.fileId === discharge.ambientRoot.vertex.fileId &&
                root.originKind === discharge.ambientRoot.originKind &&
                root.rootSelectionEvidenceRef.digest === discharge.ambientRoot.rootSelectionEvidenceRef.digest
              ) {
                foundInManifest = true;
                break;
              }
            }

            if (!foundInManifest) {
              return this.reject(
                BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION,
                `Discharged AmbientRoot not found in sealed EnvironmentManifest: ${discharge.ambientRoot.vertex.fileId}`
              );
            }

            // Validate discharged target
            if (
              discharge.targetVertex.projectId !== discharge.ambientRoot.vertex.projectId ||
              discharge.targetVertex.fileId !== discharge.ambientRoot.vertex.fileId
            ) {
              return this.reject(
                BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION,
                `Discharge target vertex mismatch with AmbientRoot: ${discharge.targetVertex.fileId} vs ${discharge.ambientRoot.vertex.fileId}`
              );
            }

            if (!this.sealedFs.exists(discharge.targetVertex.fileId)) {
              return this.reject(
                BlockerCode.RESOLUTION_TARGET_UNPROVEN,
                `AmbientRoot target missing in sealed fs: ${discharge.targetVertex.fileId}`
              );
            }

            const ambientTargetKey = `${discharge.targetVertex.projectId}:${discharge.targetVertex.fileId}`;
            if (!reachedMap.has(ambientTargetKey)) {
              return this.reject(
                BlockerCode.EDGE_OMISSION,
                `AmbientRoot target vertex omitted from reachedVertices: ${ambientTargetKey}`
              );
            }
          }
        }
      }

      // 8. Compute certificate bundle digest
      const bundleDigest = hashContract(
        ArtifactDomain.CLOSURE,
        cert.schemaVersion,
        cert
      );

      return {
        status: 'VERIFIED',
        bundleDigest,
        verifiedClaim: 'CLOSURE_COMPLETED',
        verifiedAuthorityInputDigest: cert.environmentRef.digest,
        replayProfileId: ResolverProfileId.F0_NODE10_STATIC_V1
      };
    } catch (e) {
      if (e instanceof VerificationBudgetExhaustedError) {
        return { status: 'RESOURCE_EXHAUSTED', detail: e.detail };
      }
      throw e;
    }
  }

  private reject(code: BlockerCode, message: string): VerificationResult {
    return {
      status: 'REJECTED',
      blockerCode: code,
      detail: { code, message }
    };
  }
}
