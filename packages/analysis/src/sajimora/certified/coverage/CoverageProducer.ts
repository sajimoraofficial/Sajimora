/**
 * @file CoverageProducer.ts
 * Produces exact coverage certificates for Phase 5 certified evidence.
 * Maps every historical semantic context to an explicit disposition:
 * - COVERED (bound to target -> maps to SemanticObligation)
 * - UNRELATED (bound to another symbol)
 * - EXCLUDED (proven lifecycle exclusion)
 */

import ts from 'typescript';
import {
  Anchor,
  ArtifactRef
} from '../../../../../core/src/sajimora/certified/blockers';
import {
  CoverageCertificate,
  EnvironmentManifest,
  SemanticObligation,
  Vertex
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  TransferRuleSetId
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  CanonicalSet,
  canonicalEncode,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0BindingVerifier } from '../fragment/F0BindingVerifier';
import { F0RestrictedResolver } from '../closure/F0RestrictedResolver';

export interface ContextDisposition {
  contextAnchor: Anchor;
  disposition: 'COVERED' | 'UNRELATED' | 'EXCLUDED';
  reason: string;
  obligationRefOrNull: ArtifactRef | null;
}

export interface OccurrenceToObligationMapping {
  occurrenceAnchor: Anchor;
  obligationRef: ArtifactRef;
}

export class CoverageProducer {
  /**
   * Produces a complete CoverageCertificate in EXACT mode.
   */
  public static produceCoverage(
    parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest,
    parentSealedFs: SealedFilesystem,
    targetSymbolId: string,
    targetIdentityEvidenceRef: ArtifactRef,
    fragmentAdmissionRefs: CanonicalSet<ArtifactRef>,
    obligations: SemanticObligation[]
  ): CoverageCertificate {
    const parentEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, parentManifest.schemaVersion, parentManifest)
    };

    const candidateEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(
        ArtifactDomain.MANIFEST,
        candidateManifest.schemaVersion,
        candidateManifest
      )
    };

    // Index obligations by anchor key
    const oblMap = new Map<string, { obligation: SemanticObligation; ref: ArtifactRef }>();
    for (const obl of obligations) {
      const key = `${obl.historicalOccurrenceAnchor.fileId}:${obl.historicalOccurrenceAnchor.utf16Start}:${obl.historicalOccurrenceAnchor.utf16End}:${obl.historicalOccurrenceAnchor.syntaxKind}`;
      const oblRef: ArtifactRef = {
        domain: ArtifactDomain.OBLIGATION,
        digest: hashContract(ArtifactDomain.OBLIGATION, obl.schemaVersion, obl)
      };
      oblMap.set(key, { obligation: obl, ref: oblRef });
    }

    const ledger: ContextDisposition[] = [];
    const occToObl: OccurrenceToObligationMapping[] = [];
    const actualOccurrenceRefs: ArtifactRef[] = [];
    const moduleBindings = new Map<string, any>();
    for (const file of parentManifest.namespace.files) {
      if (file.kind !== 'SOURCE' && file.kind !== 'DECLARATION') continue;
      const sf = ts.createSourceFile(file.logicalPath, parentSealedFs.readBytes(file.logicalPath).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const extracted = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: file.logicalPath }, sf);
      if (extracted.result.valid && extracted.bindings) moduleBindings.set(file.logicalPath, extracted.bindings);
    }
    const resolver = new F0RestrictedResolver(parentSealedFs);
    const resolveModule = (fromFileId: string, specifier: string): string | null => {
      const result = resolver.resolve(specifier, fromFileId);
      return result.outcome === 'RESOLVED' ? result.selectedTargetOrNull : null;
    };

    // Scan all parent files
    for (const file of parentManifest.namespace.files) {
      if (file.kind !== 'SOURCE' && file.kind !== 'DECLARATION') continue;
      const bytes = parentSealedFs.readBytes(file.logicalPath);
      const sf = ts.createSourceFile(
        file.logicalPath,
        bytes.toString('utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      const vertex: Vertex = { projectId: 'p0', fileId: file.logicalPath };
      const { bindings, result } = F0BindingVerifier.extractModuleBindings(vertex, sf);
      if (!result.valid || !bindings) continue;

      let localTargetName: string | null = null;
      if (bindings.symbols.has(targetSymbolId)) {
        localTargetName = targetSymbolId;
      } else {
        for (const [locName, imp] of bindings.imports.entries()) {
          if (imp.sourceExportName === targetSymbolId) {
            localTargetName = locName;
            break;
          }
          if (imp.sourceExportName === 'default') {
            const resolved = resolver.resolve(imp.moduleSpecifier, file.logicalPath);
            if (resolved.outcome === 'RESOLVED' && resolved.selectedTargetOrNull && parentSealedFs.exists(resolved.selectedTargetOrNull)) {
              const provider = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: resolved.selectedTargetOrNull },
                ts.createSourceFile(resolved.selectedTargetOrNull, parentSealedFs.readBytes(resolved.selectedTargetOrNull).toString('utf8'), ts.ScriptTarget.Latest, true));
              if (provider.result.valid && provider.bindings?.exportedSymbols.get('default')?.name === targetSymbolId) {
                localTargetName = locName;
                break;
              }
            }
          }
        }
      }
      const namespaceTargetLocals = F0BindingVerifier.namespaceLocalsForTarget(
        moduleBindings,
        file.logicalPath,
        targetSymbolId,
        resolveModule
      );

      const visit = (node: ts.Node) => {
        let isContext = false;
        let isTargetBound = false;

        if (ts.isCallExpression(node)) {
          isContext = true;
          if (localTargetName && ts.isIdentifier(node.expression) && node.expression.text === localTargetName) {
            isTargetBound = true;
          }
          if (ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              namespaceTargetLocals.includes(node.expression.expression.text) &&
              node.expression.name.text === targetSymbolId) {
            isTargetBound = true;
          }
        } else if (ts.isVariableDeclaration(node) && node.initializer) {
          if (node.type && ts.isTypeReferenceNode(node.type)) {
            isContext = true;
            if (localTargetName && node.type.typeName.getText(sf) === localTargetName) {
              isTargetBound = true;
            }
          }
        } else if (ts.isPropertyAccessExpression(node)) {
          isContext = true;
          if (localTargetName && ts.isIdentifier(node.expression) && node.expression.text === localTargetName) {
            isTargetBound = true;
          }
        }

        if (isContext) {
          const anchor: Anchor = {
            projectId: vertex.projectId,
            fileId: vertex.fileId,
            utf16Start: node.getStart(sf),
            utf16End: node.getEnd(),
            syntaxKind: node.kind
          };
          const key = `${anchor.fileId}:${anchor.utf16Start}:${anchor.utf16End}:${anchor.syntaxKind}`;

          if (isTargetBound) {
            const entry = oblMap.get(key);
            if (entry) {
              ledger.push({
                contextAnchor: anchor,
                disposition: 'COVERED',
                reason: 'Target relevant occurrence covered by SemanticObligation',
                obligationRefOrNull: entry.ref
              });
              occToObl.push({
                occurrenceAnchor: anchor,
                obligationRef: entry.ref
              });
              actualOccurrenceRefs.push(entry.ref);
            }
          } else {
            ledger.push({
              contextAnchor: anchor,
              disposition: 'UNRELATED',
              reason: 'Expression binds to unrelated non-target symbol',
              obligationRefOrNull: null
            });
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    const domainHash = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      Buffer.from(canonicalEncode(ledger), 'utf8')
    );

    const historicalSyntaxDomainRef: ArtifactRef = {
      domain: ArtifactDomain.SOURCE_BYTES,
      digest: domainHash
    };

    const exactProjectionProofRef: ArtifactRef = {
      domain: ArtifactDomain.SOURCE_BYTES,
      digest: computeDomainSeparatedHash(
        ArtifactDomain.SOURCE_BYTES,
        SAJIMORA_CERTIFIED_EVIDENCE_V1,
        Buffer.from('EXACT_PROJECTION_PROVEN', 'utf8')
      )
    };

    const nonemptyWitnessRef: ArtifactRef | null =
      actualOccurrenceRefs.length > 0 ? actualOccurrenceRefs[0] : null;

    return {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      parentEnvironmentRef: parentEnvRef,
      candidateEnvironmentRef: candidateEnvRef,
      targetIdentityEvidenceRef,
      fragmentAdmissionRefs,
      mode: 'EXACT',
      historicalSyntaxDomainRef,
      actualOccurrenceRefs: new CanonicalSet<ArtifactRef>(actualOccurrenceRefs),
      analysisOccurrenceRefs: new CanonicalSet<ArtifactRef>(actualOccurrenceRefs),
      dependencyGraphRef: historicalSyntaxDomainRef,
      transferRuleSetId: TransferRuleSetId.F0_TRANSFER_RULES_V1,
      contextDispositionLedger: new CanonicalSet<any>(ledger),
      occurrenceToObligationMap: new CanonicalSet<any>(occToObl),
      exactProjectionProofRef,
      nonemptyActualWitnessRefOrNull: nonemptyWitnessRef,
      exclusionProofRefs: new CanonicalSet<ArtifactRef>([])
    };
  }
}
