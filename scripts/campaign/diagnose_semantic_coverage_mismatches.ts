import * as fs from 'node:fs';
import * as path from 'node:path';
import { TypeScriptProductionAdapter } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { buildRepository } from './semantic_coverage_campaign_support';
import { getAllCoverageQueries } from './coverage_query_registry_v1';

interface FrozenResult { id: string; expectedVerdict: string; actualVerdict: string; match: boolean }

function latestFrozenLedger(): string {
  const explicit = process.argv.find(arg => arg.startsWith('--results='))?.slice('--results='.length);
  if (explicit) return path.resolve(explicit);
  const candidates = fs.readdirSync(process.cwd())
    .filter(name => /^semantic_coverage_results_v1\.all-911\..+\.json$/.test(name))
    .map(name => ({ name, mtime: fs.statSync(name).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error('No frozen all-911 result ledger found');
  return path.resolve(candidates[0].name);
}

function evidenceReason(evidence: any): string | undefined {
  return evidence?.unresolvedBoundary?.taxonomyCode ?? evidence?.metadata?.reason ??
    evidence?.metadata?.taxonomyCode ?? evidence?.metadata?.compatibilityReason;
}

async function main(): Promise<void> {
  const sourcePath = latestFrozenLedger();
  const frozen = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { querySetDigest: string; results: FrozenResult[] };
  const failures = frozen.results.filter(result => !result.match);
  const queryMap = new Map(getAllCoverageQueries().map(query => [query.id, query]));
  const outputPath = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ??
    'semantic_coverage_mismatch_diagnostic_v1.json');
  const records: any[] = [];

  for (let index = 0; index < failures.length; index++) {
    const failed = failures[index];
    const query = queryMap.get(failed.id);
    if (!query) throw new Error(`Frozen query ${failed.id} is absent from registry`);
    const repository = buildRepository(query.id, query.parentFiles, query.candidateFiles);
    const adapter = new TypeScriptProductionAdapter();
    const started = Date.now();
    try {
      const parentGraph = await adapter.discoverProjectGraph(repository.parentSnapshot);
      const candidateGraph = await adapter.discoverProjectGraph(repository.candidateSnapshot);
      const mapping = await adapter.mapProjectGraphs(parentGraph, candidateGraph);
      const identified = await adapter.identifyEntitiesAndChanges(repository, mapping);
      const changedEntities = identified.changes.filter(change => change.changeKind !== 'UNCHANGED')
        .flatMap(change => change.identity.parentEntity ? [change.identity.parentEntity] : change.identity.candidateEntity ? [change.identity.candidateEntity] : []);
      const discovered = await adapter.discoverReferences(repository.parentSnapshot, parentGraph, changedEntities);
      const references = [...discovered.staticReferences, ...discovered.unresolvedBoundaries];
      const obligations = await adapter.generateObligations(identified.changes, references);
      const verdicts = [];
      for (const obligation of obligations) verdicts.push(await adapter.evaluateObligation(obligation, repository));

      records.push({
        id: query.id, tier: query.tier, level: query.level, family: query.family, features: query.features,
        expectedVerdict: failed.expectedVerdict, actualVerdict: failed.actualVerdict,
        pipeline: {
          parentProjects: parentGraph.projects.map(project => ({ projectId: project.projectId, configFile: project.configFile, sourceFileCount: project.sourceFiles.length, projectReferences: project.projectReferences })),
          candidateProjects: candidateGraph.projects.map(project => ({ projectId: project.projectId, configFile: project.configFile, sourceFileCount: project.sourceFiles.length, projectReferences: project.projectReferences })),
          projectMapping: { matched: mapping.matched.length, added: mapping.added.length, deleted: mapping.deleted.length },
          entityCount: identified.entities.length,
          changes: identified.changes.map(change => ({
            changeId: change.changeId, changeKind: change.changeKind, description: change.description,
            identityStatus: change.identity.status, identityConfidence: change.identity.confidence,
            ambiguityReasons: change.identity.ambiguityReasons ?? [],
            parent: change.identity.parentEntity && { entityId: change.identity.parentEntity.entityId, name: change.identity.parentEntity.name, kind: change.identity.parentEntity.kind, filePath: change.identity.parentEntity.filePath, isExported: change.identity.parentEntity.isExported, signatureFingerprint: change.identity.parentEntity.signatureFingerprint, metadata: change.identity.parentEntity.metadata },
            candidate: change.identity.candidateEntity && { entityId: change.identity.candidateEntity.entityId, name: change.identity.candidateEntity.name, kind: change.identity.candidateEntity.kind, filePath: change.identity.candidateEntity.filePath, isExported: change.identity.candidateEntity.isExported, signatureFingerprint: change.identity.candidateEntity.signatureFingerprint, metadata: change.identity.candidateEntity.metadata },
            deltaDescriptor: change.deltaDescriptor
          })),
          changedEntityCount: changedEntities.length,
          references: references.map(reference => ({ referenceId: reference.referenceId, kind: reference.kind, targetEntityId: reference.targetEntityId, location: reference.location, resolutionId: reference.resolutionId, unresolved: reference.isUnresolvedBoundary, reason: reference.boundaryTaxonomyReason, consumerContext: reference.consumerContext })),
          staticReferenceCount: discovered.staticReferences.length,
          unresolvedReferenceCount: discovered.unresolvedBoundaries.length,
          resolutionFacts: (discovered.resolutionFacts ?? []).map(fact => ({ resolutionId: fact.resolutionId, importerFile: fact.importerFile, importSpecifier: fact.importSpecifier, resolvedTargetFile: fact.resolvedTargetFile, isExternal: fact.isExternal, isDynamic: fact.isDynamic, usageMode: fact.usageMode, failedLookupCandidates: fact.failedLookupCandidates, successfulLookupCandidate: fact.successfulLookupCandidate })),
          obligations: obligations.map(obligation => ({ obligationId: obligation.obligationId, question: obligation.question, scope: obligation.scope, changeId: obligation.change.changeId, changeKind: obligation.change.changeKind, identityStatus: obligation.change.identity.status, referenceId: obligation.reference?.referenceId, referenceKind: obligation.reference?.kind, unresolvedReference: obligation.reference?.isUnresolvedBoundary, boundaryReason: obligation.reference?.boundaryTaxonomyReason })),
          verdicts: verdicts.map(verdict => ({ obligationId: verdict.obligationId, outcome: verdict.outcome, assurance: verdict.assurance, property: verdict.property, scope: verdict.scope, evidenceReason: evidenceReason(verdict.evidence), evidence: verdict.evidence }))
        },
        replayDurationMs: Date.now() - started
      });
    } catch (error) {
      records.push({ id: query.id, tier: query.tier, level: query.level, family: query.family, features: query.features,
        expectedVerdict: failed.expectedVerdict, actualVerdict: failed.actualVerdict,
        diagnosticError: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), replayDurationMs: Date.now() - started });
    }

    if ((index + 1) % 10 === 0 || index + 1 === failures.length) {
      fs.writeFileSync(outputPath, JSON.stringify({ version: '1.0.0', sourceResultLedger: sourcePath,
        sourceQuerySetDigest: frozen.querySetDigest, expectedMismatchCount: failures.length,
        completed: records.length, records }, null, 2));
      console.log(`[${index + 1}/${failures.length}] checkpointed ${failed.id}`);
    }
  }
  console.log(`Diagnostic ledger written to ${outputPath}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
