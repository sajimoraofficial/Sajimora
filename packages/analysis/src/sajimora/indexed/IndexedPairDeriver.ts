import { ProofObligation, SymbolKind, SymbolRef } from '@sajimora/core';
import { CommitManifest, GenerationIndexDatabase } from './GenerationIndexDatabase';
import { IndexedConsumerFact, IndexedDeclarationFact, IndexedFileFact } from './IndexedFacts';
import { hashCanonical } from './IndexIdentity';

export interface IndexedDeclarationMapping {
  readonly parentDeclarationId: string;
  readonly candidateDeclarationId?: string;
  readonly status: 'SAME_DECLARATION' | 'REMOVED' | 'IDENTITY_UNPROVEN';
  readonly evidence: 'EXACT_PERSISTENT_ID' | 'UNIQUE_EXPORT_LOCATOR' | 'AMBIGUOUS_EXPORT_LOCATOR' | 'ABSENT_EXPORT_LOCATOR';
}

export interface DerivedIndexedObligation {
  readonly obligation: ProofObligation;
  readonly parentDeclaration: IndexedDeclarationFact;
  readonly candidateDeclaration?: IndexedDeclarationFact;
  readonly parentConsumers: readonly IndexedConsumerFact[];
  readonly mapping: IndexedDeclarationMapping;
}

export class IndexedPairDeriver {
  public derive(database: GenerationIndexDatabase, parent: CommitManifest, candidate: CommitManifest): DerivedIndexedObligation[] {
    if (parent.identity.repositoryId !== candidate.identity.repositoryId) throw new Error('INDEX_IDENTITY_REPOSITORY_MISMATCH');
    if (parent.identity.schemaVersion !== candidate.identity.schemaVersion ||
        parent.identity.extractorVersion !== candidate.identity.extractorVersion ||
        parent.identity.proofRulesVersion !== candidate.identity.proofRulesVersion) {
      throw new Error('INDEX_IDENTITY_VERSION_MISMATCH');
    }

    const candidateFiles = new Map<string, string>();
    for (const project of database.getProjectManifests(candidate.generationId)) {
      for (const row of database.getArtifacts<IndexedFileFact>(candidate.generationId, project.identity.projectId, 'FILE')) {
        candidateFiles.set(`${project.identity.projectId}:${row.payload.normalizedPath}`, row.payload.sourceHash);
      }
    }
    const parentFiles = new Map<string, string>();
    for (const project of database.getProjectManifests(parent.generationId)) {
      for (const row of database.getArtifacts<IndexedFileFact>(parent.generationId, project.identity.projectId, 'FILE')) {
        parentFiles.set(`${project.identity.projectId}:${row.payload.normalizedPath}`, row.payload.sourceHash);
      }
    }

    const candidateById = new Map<string, IndexedDeclarationFact>();
    const exportLocator = (fact: IndexedDeclarationFact) =>
      `${fact.projectId}\0${fact.filePath}\0${fact.localName}\0${fact.kind}`;
    const candidateByLocator = new Map<string, IndexedDeclarationFact[]>();
    for (const project of database.getProjectManifests(candidate.generationId)) {
      for (const row of database.getArtifacts<IndexedDeclarationFact>(candidate.generationId, project.identity.projectId, 'DECLARATION')) {
        candidateById.set(row.payload.declarationId, row.payload);
        if (row.payload.exported) {
          const key = exportLocator(row.payload);
          candidateByLocator.set(key, [...(candidateByLocator.get(key) ?? []), row.payload]);
        }
      }
    }
    const parentExportCounts = new Map<string, number>();
    for (const project of database.getProjectManifests(parent.generationId)) {
      for (const row of database.getArtifacts<IndexedDeclarationFact>(parent.generationId, project.identity.projectId, 'DECLARATION')) {
        if (!row.payload.exported) continue;
        const key = exportLocator(row.payload);
        parentExportCounts.set(key, (parentExportCounts.get(key) ?? 0) + 1);
      }
    }
    const consumersByTarget = new Map<string, IndexedConsumerFact[]>();
    for (const project of database.getProjectManifests(parent.generationId)) {
      for (const row of database.getArtifacts<IndexedConsumerFact>(parent.generationId, project.identity.projectId, 'CONSUMER')) {
        const existing = consumersByTarget.get(row.payload.targetDeclarationId) ?? [];
        existing.push(row.payload);
        consumersByTarget.set(row.payload.targetDeclarationId, existing);
      }
    }

    const results: DerivedIndexedObligation[] = [];
    for (const project of database.getProjectManifests(parent.generationId)) {
      const parents = database.getArtifacts<IndexedDeclarationFact>(parent.generationId, project.identity.projectId, 'DECLARATION')
        .map(row => row.payload).filter(declaration => declaration.exported);
      for (const before of parents) {
        const locator = exportLocator(before);
        const locatorCandidates = candidateByLocator.get(locator) ?? [];
        const exactCandidate = candidateById.get(before.declarationId);
        const uniqueLocator = locatorCandidates.length === 1 && parentExportCounts.get(locator) === 1;
        const structuralCandidate = exactCandidate?.exported ? exactCandidate :
          uniqueLocator ? locatorCandidates[0] : undefined;
        let after: IndexedDeclarationFact | undefined;
        let mappingStatus: 'SAME_DECLARATION' | 'IDENTITY_UNPROVEN' | 'REMOVED' = 'REMOVED';

        if (structuralCandidate) {
          const parentHash = parentFiles.get(`${before.projectId}:${before.filePath}`);
          const candidateHash = candidateFiles.get(`${structuralCandidate.projectId}:${structuralCandidate.filePath}`);
          if (parentHash && candidateHash && parentHash === candidateHash) {
            after = structuralCandidate;
            mappingStatus = 'SAME_DECLARATION';
          } else {
            after = undefined;
            mappingStatus = 'IDENTITY_UNPROVEN';
          }
        } else if (locatorCandidates.length > 0 ||
          parentFiles.get(`${before.projectId}:${before.filePath}`) !==
            candidateFiles.get(`${before.projectId}:${before.filePath}`)) {
          // A changed or absent source may have renamed, moved, or replaced
          // the export. Absence of an exact id is not a deletion proof.
          mappingStatus = 'IDENTITY_UNPROVEN';
        }

        if (after && after.contractHash === before.contractHash) continue;
        const kind = this.toSymbolKind(before.kind);
        if (!kind) throw new Error(`INDEX_UNSUPPORTED_DECLARATION_KIND: ${before.kind}`);
        const symbol: SymbolRef = {
          persistentSymbolId: before.persistentSymbolId,
          symbolId: before.persistentSymbolId,
          fingerprint: {
            value: hashCanonical('INDEXED_SYMBOL_FINGERPRINT', [before.projectId, before.filePath, before.localName, before.kind]),
            components: {
              globallyQualifiedOwner: `${before.projectId}:${before.filePath}`,
              symbolLocalName: before.localName,
              kind,
              parameterTypeFingerprint: before.contract.contractType.irContentHash
            }
          },
          qualifiedName: before.qualifiedName,
          kind,
          ownerId: null,
          declarationLocation: { filePath: before.filePath, line: before.line }
        };
        const classification = mappingStatus === 'REMOVED' ? 'SYMBOL_DELETED'
          : before.kind === 'TYPE_ALIAS' || before.kind === 'INTERFACE' ? 'TYPE_DEF_MUTATED' : 'EXPORTED_SIGNATURE_MUTATED';
        const obligation: ProofObligation = {
          invariantId: hashCanonical('INDEXED_OBLIGATION_V1', [parent.manifestHash, candidate.manifestHash, before.declarationId, classification]),
          relation: before.kind === 'INTERFACE' || before.kind === 'TYPE_ALIAS' ? 'INTERFACE_PRESERVATION' : 'STRUCTURAL_CO_EVOLUTION',
          mutatedSymbol: symbol,
          providerMutation: {
            targetSymbolId: before.persistentSymbolId,
            beforeExists: true,
            afterExists: mappingStatus !== 'REMOVED',
            classification,
            isAstDiffDerived: true,
            beforeParsed: true,
            afterParsed: mappingStatus !== 'REMOVED'
          }
        };
        results.push({
          obligation, parentDeclaration: before, candidateDeclaration: after,
          parentConsumers: [...(consumersByTarget.get(before.declarationId) ?? [])].sort((a, b) => (a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0)),
          mapping: { parentDeclarationId: before.declarationId, candidateDeclarationId: structuralCandidate?.declarationId,
            status: mappingStatus, evidence: exactCandidate?.exported ? 'EXACT_PERSISTENT_ID'
              : uniqueLocator ? 'UNIQUE_EXPORT_LOCATOR' : locatorCandidates.length ? 'AMBIGUOUS_EXPORT_LOCATOR'
                : 'ABSENT_EXPORT_LOCATOR' }
        });
      }
    }
    return results.sort((a, b) => (a.parentDeclaration.declarationId < b.parentDeclaration.declarationId ? -1 : a.parentDeclaration.declarationId > b.parentDeclaration.declarationId ? 1 : 0));
  }

  private toSymbolKind(kind: string): SymbolKind | undefined {
    return ['FUNCTION', 'CLASS', 'INTERFACE', 'TYPE_ALIAS', 'ENUM', 'METHOD', 'FIELD', 'VARIABLE'].includes(kind) ? kind as SymbolKind : undefined;
  }
}
