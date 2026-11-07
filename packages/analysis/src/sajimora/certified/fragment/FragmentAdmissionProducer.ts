import ts from 'typescript';
import {
  FragmentAdmissionCertificate,
  Vertex,
  DependencyClosureCertificate
} from '../../../../../core/src/sajimora/certified/contracts';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0Grammar } from './F0Grammar';
import { F0TypeVerifier } from './F0TypeVerifier';
import { ArtifactRef, Anchor } from '../../../../../core/src/sajimora/certified/blockers';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  SemanticProfileId
} from '../../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { TargetScopedEnvelope } from './TargetScopedEnvelope';
import { shouldTraverseTargetScopedNode } from './TargetScopedEnvelope';

export class FragmentAdmissionProducer {
  constructor(private readonly sealedFs: SealedFilesystem) {}

  public produceAdmission(
    environmentRef: ArtifactRef,
    closureRef: ArtifactRef,
    reachedVertices: Vertex[],
    consumerContextAnchors: Anchor[] = [],
    targetScopedEnvelope?: TargetScopedEnvelope
  ): FragmentAdmissionCertificate {
    const syntaxCoverage = new CanonicalSet<{ vertex: Vertex; syntaxNodeId: string; admittedProductionId: string }>();
    const bindingProofRefs = new CanonicalSet<ArtifactRef>();
    const typeDerivationRefs = new CanonicalSet<ArtifactRef>();
    const consumerAnchorsSet = new CanonicalSet<Anchor>();
    for (const a of consumerContextAnchors) {
      consumerAnchorsSet.add(a);
    }

    const allAliasDeps = new Map<string, string[]>();

    for (const vertex of reachedVertices) {
      if (!this.sealedFs.exists(vertex.fileId)) {
        continue;
      }

      const sourceBytes = this.sealedFs.readBytes(vertex.fileId);
      const sourceText = sourceBytes.toString('utf8');
      const sourceFile = ts.createSourceFile(
        vertex.fileId,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        vertex.fileId.endsWith('.tsx')
          ? ts.ScriptKind.TSX
          : vertex.fileId.endsWith('.js')
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
      );

      const visit = (node: ts.Node) => {
        if (targetScopedEnvelope && !shouldTraverseTargetScopedNode(node, sourceFile, targetScopedEnvelope)) return;
        const classification = F0Grammar.classifyNode(node);
        if (classification.admitted) {
          const syntaxNodeId = `${node.kind}:${node.getStart(sourceFile)}:${node.getEnd()}`;
          syntaxCoverage.add({
            vertex,
            syntaxNodeId,
            admittedProductionId: classification.productionId
          });
        }

        if (ts.isTypeAliasDeclaration(node)) {
          const aliasName = node.name.text;
          const deps: string[] = [];
          const collectTypeRefs = (typeNode: ts.Node) => {
            if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
              deps.push(typeNode.typeName.text);
            }
            ts.forEachChild(typeNode, collectTypeRefs);
          };
          collectTypeRefs(node.type);
          allAliasDeps.set(aliasName, deps);
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    const topoRes = F0TypeVerifier.topologicalSortAliases(allAliasDeps);
    const aliasTopologicalOrder = topoRes.valid ? topoRes.order : [];

    const declarationTableRef: ArtifactRef = {
      domain: ArtifactDomain.ADMISSION,
      digest: '0000000000000000000000000000000000000000000000000000000000000000'
    };

    return {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      environmentRef,
      closureRef,
      profileId: SemanticProfileId.TS_FINITE_CONTRACTS_F0,
      syntaxCoverage,
      declarationTableRef,
      bindingProofRefs,
      typeDerivationRefs,
      aliasTopologicalOrder,
      consumerContextAnchors: consumerAnchorsSet,
      ...(targetScopedEnvelope ? { targetScopedEnvelope } : {})
    };
  }
}
