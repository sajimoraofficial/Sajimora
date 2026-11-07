import { 
  DependencyClosureCertificate, 
  Vertex,
  DependencyEdge,
  ResolutionFact,
  EnvironmentManifest
} from '../../../../../core/src/sajimora/certified/contracts';
import { CanonicalSet, hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SAJIMORA_CERTIFIED_EVIDENCE_V1, ArtifactDomain, ResolverProfileId } from '../../../../../core/src/sajimora/certified/protocol';
import { ArtifactRef } from '../../../../../core/src/sajimora/certified/blockers';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { ASTAnchorExtractor } from './ASTExtractor';
import { F0RestrictedResolver } from './F0RestrictedResolver';
import { BoundaryDischarge } from './DependencyClosureVerifier';

const anchorSyntaxKindCode = (syntaxKind: string): number => {
  const codes: Record<string, number> = {
    IMPORT_DECLARATION: 1,
    EXPORT_DECLARATION: 2,
    IMPORT_EQUALS_DECLARATION: 3,
    TRIPLE_SLASH_PATH: 4,
    TRIPLE_SLASH_TYPES: 5,
    TRIPLE_SLASH_LIB: 6,
    DYNAMIC_IMPORT: 7,
    REQUIRE_CALL: 8,
    UNSUPPORTED_SYNTAX: 9
  };
  const code = codes[syntaxKind];
  if (code === undefined) throw new Error(`Unknown dependency anchor syntax kind: ${syntaxKind}`);
  return code;
};

export class DependencyClosureProducer {
  constructor(
    private readonly sealedFs: SealedFilesystem,
    private readonly extractor: ASTAnchorExtractor,
    private readonly resolver: F0RestrictedResolver
  ) {}

  public produceClosure(
    environmentRef: ArtifactRef,
    rootPolicyId: string,
    rootVertices: CanonicalSet<Vertex>,
    options?: {
      manifest?: EnvironmentManifest;
      compilerOptions?: any;
    }
  ): DependencyClosureCertificate & {
    facts: ResolutionFact[];
    edges: DependencyEdge[];
    discharges: BoundaryDischarge[];
  } {
    const reachedVertices = new CanonicalSet<Vertex>();
    const dependencyEdgeRefs = new CanonicalSet<ArtifactRef>();
    const resolutionFactRefs = new CanonicalSet<ArtifactRef>();
    const augmentationFactRefs = new CanonicalSet<ArtifactRef>();
    const declarationGroups = new CanonicalSet<any>();
    const traversalCoverage = new CanonicalSet<{ vertex: Vertex; parsedSyntaxDigest: string; dependencyAnchorIds: string[] }>();
    const boundaryDischarges = new CanonicalSet<any>();

    const facts: ResolutionFact[] = [];
    const edges: DependencyEdge[] = [];
    const discharges: BoundaryDischarge[] = [];
    const seenResolutionFactDigests = new Set<string>();

    const worklist: Vertex[] = [];
    const visited = new Set<string>();

    for (const root of rootVertices) {
      reachedVertices.add(root);
      worklist.push(root);
    }

    while (worklist.length > 0) {
      const v = worklist.shift()!;
      const key = `${v.projectId}:${v.fileId}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (!this.sealedFs.exists(v.fileId)) {
        continue;
      }

      const sourceBytes = this.sealedFs.readBytes(v.fileId);
      const anchors = this.extractor.extractAnchors(v, sourceBytes);
      const digest = this.extractor.computeSyntaxDigest(v, anchors);
      const dependencyAnchorIds = anchors.map(a => this.extractor.canonicalAnchorId(a));

      traversalCoverage.add({
        vertex: v,
        parsedSyntaxDigest: digest,
        dependencyAnchorIds
      });

      for (const anchor of anchors) {
        if (anchor.syntaxKind === 'TRIPLE_SLASH_TYPES' || anchor.syntaxKind === 'TRIPLE_SLASH_LIB') {
          // Look up matching ambient root from manifest if available
          if (options?.manifest) {
            for (const root of options.manifest.ambientRoots) {
              if (
                root.vertex.fileId === anchor.specifier ||
                root.vertex.fileId.includes(anchor.specifier)
              ) {
                const discharge: BoundaryDischarge = {
                  anchor,
                  targetVertex: root.vertex,
                  ambientRoot: root,
                  justification: `Discharged via manifest AmbientRoot ${root.vertex.fileId}`
                };
                discharges.push(discharge);
                boundaryDischarges.add(discharge);

                const rootKey = `${root.vertex.projectId}:${root.vertex.fileId}`;
                if (!visited.has(rootKey)) {
                  reachedVertices.add(root.vertex);
                  worklist.push(root.vertex);
                }
                break;
              }
            }
          }
        } else if (
          anchor.syntaxKind === 'IMPORT_DECLARATION' ||
          anchor.syntaxKind === 'EXPORT_DECLARATION' ||
          anchor.syntaxKind === 'IMPORT_EQUALS_DECLARATION' ||
          anchor.syntaxKind === 'DYNAMIC_IMPORT' ||
          anchor.syntaxKind === 'REQUIRE_CALL'
        ) {
          const res = this.resolver.resolve(
            anchor.specifier,
            v.fileId,
            options?.compilerOptions
          );

          const fact: ResolutionFact = {
            request: {
              _opaqueF0Semantics: 'UNRESOLVED',
              payload: {
                specifier: anchor.specifier,
                containingFile: v.fileId,
                compilerOptions: options?.compilerOptions ?? null
              }
            },
            resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
            orderedProbes: res.orderedProbes,
            metadataFileIds: res.metadataFileIds,
            selectedTargetOrNull: res.selectedTargetOrNull ?? null,
            outcome: res.outcome
          };

          const factDigest = hashContract(ArtifactDomain.CLOSURE, SAJIMORA_CERTIFIED_EVIDENCE_V1, fact);
          if (!seenResolutionFactDigests.has(factDigest)) {
            seenResolutionFactDigests.add(factDigest);
            resolutionFactRefs.add({ domain: ArtifactDomain.CLOSURE, digest: factDigest });
            facts.push(fact);
          }

          if (res.selectedTargetOrNull) {
            const targetVertex: Vertex = {
              projectId: v.projectId,
              fileId: res.selectedTargetOrNull
            };

            const edge: DependencyEdge = {
              edgeKind: anchor.syntaxKind,
              from: v,
              anchorOrNull: {
                projectId: anchor.projectId,
                fileId: anchor.fileId,
                utf16Start: anchor.utf16Start,
                utf16End: anchor.utf16End,
                syntaxKind: anchorSyntaxKindCode(anchor.syntaxKind)
              },
              resolutionFactRefOrNull: { domain: ArtifactDomain.CLOSURE, digest: factDigest },
              targetVertices: [targetVertex],
              metadataFileIds: res.metadataFileIds
            };

            const edgeDigest = hashContract(ArtifactDomain.CLOSURE, SAJIMORA_CERTIFIED_EVIDENCE_V1, edge);
            dependencyEdgeRefs.add({ domain: ArtifactDomain.CLOSURE, digest: edgeDigest });
            edges.push(edge);

            const targetKey = `${targetVertex.projectId}:${targetVertex.fileId}`;
            if (!visited.has(targetKey)) {
              reachedVertices.add(targetVertex);
              worklist.push(targetVertex);
            }
          }
        }
      }
    }

    const cert: DependencyClosureCertificate = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      environmentRef,
      rootPolicyId,
      rootVertices,
      reachedVertices,
      dependencyEdgeRefs,
      resolutionFactRefs,
      augmentationFactRefs,
      declarationGroups,
      traversalCoverage,
      boundaryDischarges,
      ruleSetId: 'F0_RULES_V1'
    };

    return Object.assign(cert, { facts, edges, discharges });
  }
}
