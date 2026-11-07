import { isDeepStrictEqual } from 'node:util';
/**
 * @file TypeScriptProductionAdapter.ts
 * Production-hardened TypeScript Language Adapter.
 * 
 * Enforces:
 * 1. Project graph & tsconfig discovery (multi-project monorepos, project references).
 * 2. Asymmetric Parent/Candidate project mapping (project moves, additions, deletions).
 * 3. TypeChecker-backed symbol extraction, overload set resolution, and declaration merging.
 * 4. TypeScript-native module resolution via sealed in-memory compiler hosts.
 * 5. Full reference discovery with explicit dynamic boundaries (dynamic index, eval, dynamic import, unresolved modules).
 * 6. Lexical shadowing protection (local declarations never confused with target symbols).
 * 7. Stable provenance chain emitted at every stage.
 * 8. Required vs optional parameter distinction (optional params never treated as breaking additions).
 * 9. Zero hardcoding of fixtures, repositories, or corpus cases.
 */

import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
import {
  GenericLanguageAdapter,
  GenericRepository,
  GenericRepositorySnapshot,
  GenericProjectGraph,
  AsymmetricProjectMapping,
  SemanticEntity,
  SemanticChange,
  Reference,
  DiscoveredReferencesResult,
  ResolutionFact,
  VerificationObligation,
  VerificationVerdict,
  ProvenanceChain
} from '../../../../../../core/src/sajimora/verification';
import { TypeScriptProjectGraphBuilder } from './TypeScriptProjectGraphBuilder';
import { AsymmetricProjectMapper } from './AsymmetricProjectMapper';
import { ProgramSetManager, ProjectProgramInstance } from './ProgramSetManager';
import { TypeCheckerSemanticAnalyzer } from './TypeCheckerSemanticAnalyzer';
import { TypeScriptOperationalEvaluator } from './TypeScriptOperationalEvaluator';
import { TypeScriptFiniteBooleanProof } from './TypeScriptFiniteBooleanProof';
import { TypeScriptFiniteBooleanTypeProof } from './TypeScriptFiniteBooleanTypeProof';
import { tryFiniteBooleanFastPath } from './TypeScriptFiniteBooleanFastPath';
import { ScopeIsolationEngine } from './ScopeIsolationEngine';
import { TypeScriptProviderApiEvaluator } from './TypeScriptProviderApiEvaluator';
import { readSnapshotText } from './CanonicalRepositoryPath';
import { buildSealedChangeInventory } from './SealedChangeInventory';
import { buildSealedProjectClosure } from './SealedProjectClosure';
import { verifySealedProjectClosure } from './SealedProjectClosureVerifier';

const MAX_EAGER_PROJECTS = 4;

export class TypeScriptProductionAdapter implements GenericLanguageAdapter {
  public readonly languageId = 'typescript';
  public readonly adapterVersion = '2.1.0';

  private readonly scopeBoundaries = new WeakMap<GenericRepositorySnapshot, readonly Reference[]>();
  private readonly fastReferences = new WeakMap<GenericRepositorySnapshot, readonly Reference[]>();
  private readonly programSets = new WeakMap<GenericRepositorySnapshot, ProgramSetManager>();
  private readonly selectedProjects = new WeakMap<GenericRepositorySnapshot, ReadonlySet<string>>();
  private readonly boundedSnapshots = new WeakSet<GenericRepositorySnapshot>();
  private readonly unprovenBoundedSnapshots = new WeakSet<GenericRepositorySnapshot>();
  private readonly closureBoundaries = new WeakMap<GenericRepositorySnapshot, readonly Reference[]>();

  private admittedGraph(snapshot: GenericRepositorySnapshot, graph: GenericProjectGraph): GenericProjectGraph {
    const selected = this.selectedProjects.get(snapshot);
    return selected ? {
      ...graph, projects: graph.projects.filter(project => selected.has(project.projectId)),
      edges: graph.edges.filter(edge => selected.has(edge.fromProjectId) && selected.has(edge.toProjectId))
    } : graph;
  }

  private visitInstances(snapshot: GenericRepositorySnapshot, graph: GenericProjectGraph,
    visit: (instance: ProjectProgramInstance) => void): void {
    if (this.boundedSnapshots.has(snapshot)) {
      ProgramSetManager.visitProjects(snapshot, this.admittedGraph(snapshot, graph), visit);
    } else {
      for (const instance of this.programSet(snapshot, graph).getAllInstances()) visit(instance);
    }
  }

  private programSet(snapshot: GenericRepositorySnapshot, graph: GenericProjectGraph): ProgramSetManager {
    let manager = this.programSets.get(snapshot);
    if (!manager) {
      manager = new ProgramSetManager(snapshot, this.admittedGraph(snapshot, graph));
      this.programSets.set(snapshot, manager);
    }
    return manager;
  }

  public canHandle(repository: GenericRepository): boolean {
    const isTS = (f: { path: string }) =>
      f.path.endsWith('.ts') ||
      f.path.endsWith('.tsx') ||
      f.path.endsWith('.d.ts') ||
      f.path.endsWith('tsconfig.json') ||
      f.path.includes('tsconfig.');
    return repository.parentSnapshot.files.some(isTS) || repository.candidateSnapshot.files.some(isTS);
  }

  public async discoverProjectGraph(snapshot: GenericRepositorySnapshot): Promise<GenericProjectGraph> {
    return TypeScriptProjectGraphBuilder.buildProjectGraph(snapshot);
  }

  public async mapProjectGraphs(
    parentGraph: GenericProjectGraph,
    candidateGraph: GenericProjectGraph
  ): Promise<AsymmetricProjectMapping> {
    return AsymmetricProjectMapper.mapGraphs(parentGraph, candidateGraph);
  }

  public async identifyEntitiesAndChanges(
    repository: GenericRepository,
    projectMapping: AsymmetricProjectMapping
  ): Promise<{
    entities: readonly SemanticEntity[];
    changes: readonly SemanticChange[];
  }> {
    const parentGraph = await this.discoverProjectGraph(repository.parentSnapshot);
    const candidateGraph = await this.discoverProjectGraph(repository.candidateSnapshot);
    // Establish the complete path/mode/hash diff and direct project owners
    // before any compiler Program is allocated. Consumer closure is still
    // unverified, so this inventory must not prune projects yet.
    const inventory = buildSealedChangeInventory(repository, parentGraph, candidateGraph);
    const invalidInventory = inventory.blockers.find(blocker =>
      blocker.startsWith('DUPLICATE_SNAPSHOT_PATH:') || blocker.startsWith('OMITTED_RELEVANT_INPUT:'));
    if (invalidInventory) throw new Error(`SEALED_CHANGE_INVENTORY_INCOMPLETE:${invalidInventory}`);
    const selectable = inventory.changedSourcePaths.length > 0 &&
      inventory.changedFiles.length === inventory.changedSourcePaths.length &&
      inventory.changedEnvironmentPaths.length === 0 && inventory.blockers.length === 0 &&
      inventory.changedFiles.every(file => file.parent && file.candidate &&
        !file.parent.isSymlink && !file.candidate.isSymlink);
    if (selectable) {
      const parentProposal = buildSealedProjectClosure(repository.parentSnapshot, parentGraph,
        inventory.changedSourcePaths);
      const candidateProposal = buildSealedProjectClosure(repository.candidateSnapshot, candidateGraph,
        inventory.changedSourcePaths);
      const parentChecked = verifySealedProjectClosure(repository.parentSnapshot, parentGraph,
        inventory.changedSourcePaths, parentProposal);
      const candidateChecked = verifySealedProjectClosure(repository.candidateSnapshot, candidateGraph,
        inventory.changedSourcePaths, candidateProposal);
      if (parentChecked.status === 'PROVEN' && candidateChecked.status === 'PROVEN' &&
        parentChecked.selectedProjectIds.length > 0 && candidateChecked.selectedProjectIds.length > 0) {
        this.selectedProjects.set(repository.parentSnapshot, new Set(parentChecked.selectedProjectIds));
        this.selectedProjects.set(repository.candidateSnapshot, new Set(candidateChecked.selectedProjectIds));
        if (Math.max(parentChecked.selectedProjectIds.length, candidateChecked.selectedProjectIds.length) > MAX_EAGER_PROJECTS) {
          this.boundedSnapshots.add(repository.parentSnapshot);
          this.boundedSnapshots.add(repository.candidateSnapshot);
        }
      }
    }
    // A large, unproven closure must not force every tsconfig into memory or
    // quietly omit consumers. Compile only direct owners and attach an explicit
    // unresolved boundary, which prevents aggregate F0 preservation.
    if (!this.selectedProjects.has(repository.parentSnapshot) &&
      Math.max(parentGraph.projects.length, candidateGraph.projects.length) > MAX_EAGER_PROJECTS) {
      this.selectedProjects.set(repository.parentSnapshot, new Set(inventory.directlyAffectedParentProjects));
      this.selectedProjects.set(repository.candidateSnapshot, new Set(inventory.directlyAffectedCandidateProjects));
      this.boundedSnapshots.add(repository.parentSnapshot);
      this.boundedSnapshots.add(repository.candidateSnapshot);
      this.unprovenBoundedSnapshots.add(repository.parentSnapshot);
      this.unprovenBoundedSnapshots.add(repository.candidateSnapshot);
      const owner = inventory.directlyAffectedParentProjects[0] ?? parentGraph.projects[0]?.projectId ?? 'environment';
      const changed = inventory.changedFiles[0]?.path ?? 'tsconfig.json';
      this.closureBoundaries.set(repository.parentSnapshot, [{
        referenceId: `project_closure_unproven_${repository.parentSnapshot.snapshotId}`,
        projectId: owner, kind: 'UNRESOLVED_BOUNDARY', targetEntityId: 'ENVIRONMENT',
        location: { filePath: changed, line: 1, character: 1 }, isUnresolvedBoundary: true,
        boundaryTaxonomyReason: 'PROJECT_CONSUMER_CLOSURE_UNPROVEN'
      }]);
    }
    const fast = tryFiniteBooleanFastPath(repository, parentGraph, candidateGraph);
    if (fast) {
      this.fastReferences.set(repository.parentSnapshot, fast.references);
      return { entities: fast.entities, changes: fast.changes };
    }
    if (this.unprovenBoundedSnapshots.has(repository.parentSnapshot)) {
      // Compiler work cannot upgrade an unproven consumer closure to F0. Keep
      // every changed Git input visible as an unresolved obligation and avoid
      // constructing even the directly owning Programs in this branch.
      this.scopeBoundaries.set(repository.parentSnapshot,
        this.closureBoundaries.get(repository.parentSnapshot) ?? []);
      const entities: SemanticEntity[] = [];
      const changes: SemanticChange[] = [];
      for (const file of inventory.changedFiles) {
        const projectId = file.parentProjectIds[0] ?? file.candidateProjectIds[0] ??
          parentGraph.projects[0]?.projectId ?? candidateGraph.projects[0]?.projectId ?? 'environment';
        const entity: SemanticEntity = {
          entityId: `unproven-change::${file.path}`, projectId, name: file.path,
          kind: 'MODULE', qualifiedName: `unproven-change::${file.path}`, filePath: file.path,
          signatureFingerprint: 'UNPROVEN_PROJECT_CONSUMER_CLOSURE', isExported: false,
          metadata: { boundaryTaxonomyReason: 'PROJECT_CONSUMER_CLOSURE_UNPROVEN' }
        };
        entities.push(entity);
        changes.push({ changeId: `change_unproven_${file.path}`, changeKind: 'METADATA_CHANGED',
          identity: { identityId: `identity_unproven_${file.path}`, status: 'UNRESOLVED_IDENTITY',
            confidence: 'NONE', parentEntity: entity, candidateEntity: entity,
            ambiguityReasons: ['PROJECT_CONSUMER_CLOSURE_UNPROVEN'] },
          description: `Changed sealed input ${file.path} cannot be certified without consumer closure.` });
      }
      return { entities, changes };
    }

    const parentEntities: SemanticEntity[] = [];
    const changedSources = new Set(inventory.changedSourcePaths.map(file => file.replace(/\\/g, '/').replace(/^\/+/, '')));
    const admittedEntity = (snapshot: GenericRepositorySnapshot, entity: SemanticEntity) =>
      !this.unprovenBoundedSnapshots.has(snapshot) || changedSources.has(entity.filePath.replace(/\\/g, '/').replace(/^\/+/, ''));
    this.visitInstances(repository.parentSnapshot, parentGraph, inst => {
      parentEntities.push(...TypeCheckerSemanticAnalyzer.extractEntities(inst,
        this.unprovenBoundedSnapshots.has(repository.parentSnapshot) ? changedSources : undefined).filter(entity =>
        admittedEntity(repository.parentSnapshot, entity)));
    });

    const candidateEntities: SemanticEntity[] = [];
    this.visitInstances(repository.candidateSnapshot, candidateGraph, inst => {
      candidateEntities.push(...TypeCheckerSemanticAnalyzer.extractEntities(inst,
        this.unprovenBoundedSnapshots.has(repository.candidateSnapshot) ? changedSources : undefined).filter(entity =>
        admittedEntity(repository.candidateSnapshot, entity)));
    });

    // Cross-revision identity must not be keyed by a local name: two modules
    // routinely export the same name.  The declaration locator is stable over
    // ordinary edits and deliberately excludes the revision-specific project id.
    const identityKey = (entity: SemanticEntity) => `${entity.projectId.split("::").slice(1).join("::")}::${entity.filePath}::${entity.kind}::${entity.name}`;
    const candidateMap = new Map<string, SemanticEntity[]>();
    for (const ce of candidateEntities) {
      const group = candidateMap.get(identityKey(ce)) ?? [];
      group.push(ce);
      candidateMap.set(identityKey(ce), group);
    }

    const changes: SemanticChange[] = [];
    const allEntitiesMap = new Map<string, SemanticEntity>();
    const matchedCandidateIds = new Set<string>();

    for (const pe of parentEntities) {
      allEntitiesMap.set(pe.entityId, pe);
      const directCandidates = candidateMap.get(identityKey(pe)) ?? [];
      let ce = directCandidates.length === 1 ? directCandidates[0] : undefined;

      if (directCandidates.length > 1) {
        changes.push({ changeId: `change_ambiguous_${pe.entityId}`, changeKind: 'METADATA_CHANGED',
          identity: { identityId: `id_${pe.entityId}`, status: 'AMBIGUOUS_IDENTITY', parentEntity: pe,
            confidence: 'NONE', ambiguityReasons: ['MULTIPLE_CANDIDATE_DECLARATIONS_FOR_STABLE_LOCATOR'] },
          description: `Multiple candidate declarations match ${pe.qualifiedName}.` });
        continue;
      }

      if (!ce) {
        const relocationCandidates = candidateEntities.filter(candidate => !matchedCandidateIds.has(candidate.entityId) &&
          candidate.kind === pe.kind && candidate.signatureFingerprint === pe.signatureFingerprint &&
          (candidate.name === pe.name || candidate.filePath === pe.filePath));
        if (relocationCandidates.length === 1) {
          ce = relocationCandidates[0];
          matchedCandidateIds.add(ce.entityId);
          changes.push({ changeId: `change_relocated_${pe.entityId}`, changeKind: 'METADATA_CHANGED',
            identity: { identityId: `id_${pe.entityId}`, status: 'AMBIGUOUS_IDENTITY', parentEntity: pe, candidateEntity: ce,
              confidence: 'HEURISTIC', ambiguityReasons: ['DECLARATION_RENAMED_OR_RELOCATED_WITHOUT_STABLE_EXPORT_IDENTITY'] },
            description: `A structurally plausible declaration relocation for ${pe.name} cannot establish semantic identity.` });
          continue;
        }
      }

      if (!ce) {
        const extractionBoundary = pe.metadata?.['extractionBoundary'];
        changes.push({
          changeId: `change_del_${pe.entityId}`,
          identity: {
            identityId: `id_${pe.entityId}`,
            status: extractionBoundary ? 'UNRESOLVED_IDENTITY' : 'CONFIRMED_IDENTITY',
            parentEntity: pe,
            candidateEntity: undefined,
            confidence: extractionBoundary ? 'NONE' : 'CERTAIN',
            ambiguityReasons: extractionBoundary ? [String(extractionBoundary)] : undefined
          },
          changeKind: 'DELETED',
          description: `Entity ${pe.name} deleted in candidate`
        });
      } else {
        matchedCandidateIds.add(ce.entityId);
        const extractionBoundary = pe.metadata?.['extractionBoundary'] ?? ce.metadata?.['extractionBoundary'];
        const sigMatches = pe.signatureFingerprint === ce.signatureFingerprint;
        const bodyMatches = pe.metadata?.['bodyHash'] === ce.metadata?.['bodyHash'];

        const identityStatus: SemanticChange['identity']['status'] = extractionBoundary ? 'UNRESOLVED_IDENTITY' : 'CONFIRMED_IDENTITY';
        let changeKind: SemanticChange['changeKind'] = 'UNCHANGED';
        let description = `Entity ${pe.name} unchanged`;

        if (extractionBoundary) {
          const sourceChanged = readSnapshotText(repository.parentSnapshot, pe.filePath) !== readSnapshotText(repository.candidateSnapshot, ce.filePath);
          changeKind = sourceChanged ? 'METADATA_CHANGED' : 'UNCHANGED';
          description = `Entity ${pe.name} has unresolved AST extraction boundary ${String(extractionBoundary)}`;
        } else if (sigMatches && bodyMatches) {
          // Repository-level byte changes are not entity-level metadata.
          changeKind = 'UNCHANGED';
          description = `Entity ${pe.name} unchanged`;
        } else if (!sigMatches) {
          const parentRequired = Number(pe.metadata?.['requiredParamsCount']);
          const candidateRequired = Number(ce.metadata?.['requiredParamsCount']);
          changeKind = Number.isFinite(parentRequired) && Number.isFinite(candidateRequired)
            ? candidateRequired > parentRequired ? 'SIGNATURE_NARROWED'
              : candidateRequired < parentRequired ? 'SIGNATURE_EXPANDED'
                : 'TYPE_DEFINITION_CHANGED'
            : 'TYPE_DEFINITION_CHANGED';
          description = `Entity ${pe.name} signature modified: ${pe.signatureFingerprint} -> ${ce.signatureFingerprint}`;
        } else if (!bodyMatches) {
          changeKind = 'BODY_MUTATED';
          description = `Entity ${pe.name} body implementation modified`;
        }

        changes.push({
          changeId: `change_${pe.entityId}`,
          identity: {
            identityId: `id_${pe.entityId}`,
            status: identityStatus,
            parentEntity: pe,
            candidateEntity: ce,
            confidence: 'CERTAIN',
            lineageEvidence: {
              parentSignature: pe.signatureFingerprint,
              candidateSignature: ce.signatureFingerprint,
              parentBodyHash: pe.metadata?.['bodyHash'],
              candidateBodyHash: ce.metadata?.['bodyHash'],
              parentDependencyHash: pe.metadata?.['dependencyHash'],
              candidateDependencyHash: ce.metadata?.['dependencyHash']
            },
            ambiguityReasons: extractionBoundary ? [String(extractionBoundary)] : undefined
          },
          changeKind,
          description,
          deltaDescriptor: {
            parentParamsCount: pe.metadata?.['paramsCount'],
            candidateParamsCount: ce.metadata?.['paramsCount'],
            parentRequiredParams: pe.metadata?.['requiredParamsCount'] ?? pe.metadata?.['paramsCount'] ?? 0,
            candidateRequiredParams: ce.metadata?.['requiredParamsCount'] ?? ce.metadata?.['paramsCount'] ?? 0,
            dependencyChanged: pe.metadata?.['dependencyHash'] !== ce.metadata?.['dependencyHash'],
            sourceChanged: readSnapshotText(repository.parentSnapshot, pe.filePath) !== readSnapshotText(repository.candidateSnapshot, ce.filePath)
          }
        });
      }
    }

    const changedTargetFiles = [...new Set(changes
      .filter(change => change.changeKind !== 'UNCHANGED' || Boolean(change.deltaDescriptor?.['sourceChanged']))
      .flatMap(change => [change.identity.parentEntity?.filePath, change.identity.candidateEntity?.filePath])
      .filter((file): file is string => Boolean(file)))];
    if (changedTargetFiles.length > 0) {
      const scope = ScopeIsolationEngine.verifyScopeIsolation({
        parentSnapshot: repository.parentSnapshot, candidateSnapshot: repository.candidateSnapshot,
        parentProjectGraph: parentGraph, candidateProjectGraph: candidateGraph,
        targetProjectId: parentGraph.projects[0]?.projectId ?? candidateGraph.projects[0]?.projectId ?? 'environment',
        targetFiles: changedTargetFiles, claimedExcludedFiles: []
      });
      const verifiedFiles = new Set(scope.verifiedScope.map(file => file.replace(/\\/g, '/').replace(/^\/+/, '')));
      this.scopeBoundaries.set(repository.parentSnapshot, [...(this.closureBoundaries.get(repository.parentSnapshot) ?? []),
        ...(scope.unresolvedBoundaries ?? []).filter(boundary =>
          verifiedFiles.has(boundary.location.filePath.replace(/\\/g, '/').replace(/^\/+/, '')))]);
    } else {
      this.scopeBoundaries.set(repository.parentSnapshot, this.closureBoundaries.get(repository.parentSnapshot) ?? []);
    }

    const parentMap = new Map<string, SemanticEntity>();
    for (const pe of parentEntities) {
      parentMap.set(identityKey(pe), pe);
    }

    for (const ce of candidateEntities) {
      if (!allEntitiesMap.has(ce.entityId)) {
        allEntitiesMap.set(ce.entityId, ce);
      }
      if (!parentMap.has(identityKey(ce)) && !matchedCandidateIds.has(ce.entityId)) {
        const extractionBoundary = ce.metadata?.['extractionBoundary'];
        changes.push({
          changeId: `change_add_${ce.entityId}`,
          identity: {
            identityId: `id_${ce.entityId}`,
            status: extractionBoundary ? 'UNRESOLVED_IDENTITY' : 'CONFIRMED_IDENTITY',
            parentEntity: undefined,
            candidateEntity: ce,
            confidence: extractionBoundary ? 'NONE' : 'CERTAIN',
            ambiguityReasons: extractionBoundary ? [String(extractionBoundary)] : undefined
          },
          changeKind: 'ADDED',
          description: `Entity ${ce.name} added in candidate`
        });
      }
    }

    // Compiler/project inputs are their own verification boundary.  A config,
    // package manifest, or lockfile mutation must neither relabel every source
    // entity nor disappear as an unchanged program.
    for (const filePath of inventory.changedEnvironmentPaths) {
      const projectId = parentGraph.projects.find(project => project.configFile === filePath)?.projectId ??
        candidateGraph.projects.find(project => project.configFile === filePath)?.projectId ??
        parentGraph.projects[0]?.projectId ?? candidateGraph.projects[0]?.projectId ?? 'environment';
      const entity: SemanticEntity = { entityId: `environment::${filePath}`, projectId, name: filePath,
        kind: 'MODULE', qualifiedName: `environment::${filePath}`, filePath,
        signatureFingerprint: 'UNRESOLVED_ENVIRONMENT_INPUT', isExported: false,
        metadata: { boundaryTaxonomyReason: 'PROJECT_ENVIRONMENT_CHANGED' } };
      changes.push({ changeId: `change_environment_${filePath}`, changeKind: 'METADATA_CHANGED',
        identity: { identityId: `identity_environment_${filePath}`, status: 'UNRESOLVED_IDENTITY', confidence: 'NONE',
          parentEntity: entity, candidateEntity: entity, ambiguityReasons: ['PROJECT_ENVIRONMENT_CHANGED'] },
        description: `Project environment input ${filePath} changed and requires reconstruction.` });
      allEntitiesMap.set(entity.entityId, entity);
    }

    // A changed source excluded from all admitted project root files must not
    // disappear merely because entity extraction skips imported/non-exported files.
    const normalize = (file: string) => file.replace(/\\/g, '/').replace(/^\/+/, '');
    const represented = new Set([...parentEntities, ...candidateEntities].map(entity => normalize(entity.filePath)));
    for (const filePath of inventory.changedSourcePaths) {
      if (represented.has(normalize(filePath))) continue;
      const projectId = parentGraph.projects.find(project => project.sourceFiles.some(file => normalize(file) === normalize(filePath)))?.projectId ??
        candidateGraph.projects.find(project => project.sourceFiles.some(file => normalize(file) === normalize(filePath)))?.projectId ??
        parentGraph.projects[0]?.projectId ?? candidateGraph.projects[0]?.projectId ?? 'environment';
      const entity: SemanticEntity = { entityId: `unextracted::${filePath}`, projectId, name: filePath,
        kind: 'MODULE', qualifiedName: `unextracted::${filePath}`, filePath,
        signatureFingerprint: 'UNEXTRACTED_CHANGED_SOURCE', isExported: false,
        metadata: { boundaryTaxonomyReason: 'CHANGED_SOURCE_NOT_EXTRACTED' } };
      changes.push({ changeId: `change_unextracted_${filePath}`, changeKind: 'METADATA_CHANGED',
        identity: { identityId: `identity_unextracted_${filePath}`, status: 'UNRESOLVED_IDENTITY', confidence: 'NONE',
          parentEntity: entity, candidateEntity: entity, ambiguityReasons: ['CHANGED_SOURCE_NOT_EXTRACTED'] },
        description: `Changed source ${filePath} has no extracted project entity.` });
    }

    return {
      entities: [...parentEntities, ...candidateEntities.filter(e => !parentMap.has(identityKey(e)))],
      changes
    };
  }

  public async discoverReferences(
    snapshot: GenericRepositorySnapshot,
    projectGraph: GenericProjectGraph,
    targetEntities: readonly SemanticEntity[]
  ): Promise<DiscoveredReferencesResult> {
    const fast = this.fastReferences.get(snapshot);
    if (fast) return { staticReferences: fast, unresolvedBoundaries: [], resolutionFacts: [] };
    if (this.unprovenBoundedSnapshots.has(snapshot)) {
      return { staticReferences: [], unresolvedBoundaries: this.scopeBoundaries.get(snapshot) ?? [],
        resolutionFacts: [] };
    }
    if (targetEntities.length === 0) {
      return { staticReferences: [], unresolvedBoundaries: this.scopeBoundaries.get(snapshot) ?? [], resolutionFacts: [] };
    }
    const staticReferences: Reference[] = [];
    const unresolvedBoundaries: Reference[] = [...(this.scopeBoundaries.get(snapshot) ?? [])];
    const resolutionFacts: ResolutionFact[] = [];
    const targetFilePaths = [...new Set(targetEntities.map(e => e.filePath).filter(Boolean))];
    const targetScope = ScopeIsolationEngine.computeTargetScope(snapshot, projectGraph, targetFilePaths);
    const inScope = new Set(targetScope.allScopeFiles.map(file => file.replace(/\\/g, '/').replace(/^\/+/, '')));
    const isInScope = (file: string) => inScope.has(file.replace(/\\/g, '/').replace(/^\/+/, ''));

    this.visitInstances(snapshot, projectGraph, inst => {
      if (inst.configurationErrors.length) unresolvedBoundaries.push({
        referenceId: 'configuration_' + inst.project.projectId, projectId: inst.project.projectId,
        kind: 'UNRESOLVED_BOUNDARY', targetEntityId: 'ENVIRONMENT',
        location: { filePath: inst.project.configFile ?? 'tsconfig.json', line: 1, character: 1 },
        isUnresolvedBoundary: true, boundaryTaxonomyReason: 'SEALED_PROJECT_CONFIGURATION_INVALID'
      });
      const res = TypeCheckerSemanticAnalyzer.discoverReferences(inst, targetEntities);
      staticReferences.push(...res.staticReferences.filter(reference => isInScope(reference.location.filePath)));
      unresolvedBoundaries.push(...res.unresolvedBoundaries.filter(reference => isInScope(reference.location.filePath)));
      resolutionFacts.push(...inst.host.getResolutionFacts());
      if (res.resolutionFacts) {
        resolutionFacts.push(...res.resolutionFacts);
      }
    });

    // Phase 1B: Verify Scope Isolation and Non-Interference
    if (targetFilePaths.length > 0) {
      for (const boundary of targetScope.dynamicBoundaries) {
        if (isInScope(boundary.location.filePath) && !unresolvedBoundaries.some(b => b.referenceId === boundary.referenceId)) {
          unresolvedBoundaries.push(boundary);
        }
      }
    }

    const uniqueReferences = (references: Reference[]): Reference[] => {
      const unique = new Map<string, Reference>();
      for (const reference of references) {
        const existing = unique.get(reference.referenceId);
        if (existing && !isDeepStrictEqual(existing, reference)) {
          throw new Error(`CONFLICTING_DISCOVERY_REFERENCE: ${reference.referenceId}`);
        }
        unique.set(reference.referenceId, reference);
      }
      return [...unique.values()];
    };
    return {
      staticReferences: uniqueReferences(staticReferences),
      unresolvedBoundaries: uniqueReferences(unresolvedBoundaries),
      resolutionFacts
    };
  }

  public async generateObligations(
    changes: readonly SemanticChange[],
    references: readonly Reference[]
  ): Promise<readonly VerificationObligation[]> {
    const obligations: VerificationObligation[] = [];
    let obCounter = 0;

    for (const change of changes) {
      if (change.changeKind === 'UNCHANGED') continue;

      const entity = change.identity.parentEntity ?? change.identity.candidateEntity;
      if (!entity) continue;

      const projectId = entity.projectId;

      // 1. Provider API obligations apply only to externally visible contracts.
      if (entity.isExported || change.identity.status !== 'CONFIRMED_IDENTITY') {
        obligations.push({
          obligationId: `ob_${++obCounter}_api_${entity.name}`,
          projectId,
          question: 'API_COMPATIBILITY',
          change,
          scope: 'PROVIDER',
          createdAt: new Date().toISOString()
        });
      }

      // 2. Behavioral obligations require an actual implementation change.
      if (change.changeKind === 'BODY_MUTATED') {
        obligations.push({
          obligationId: `ob_${++obCounter}_behavior_${entity.name}`,
          projectId,
          question: 'BEHAVIORAL_COMPATIBILITY',
          change,
          scope: 'PROVIDER',
          createdAt: new Date().toISOString()
        });
      }

      // 3. Consumer obligations for references targeting this entity
      const matchingRefs = references.filter(r => r.targetEntityId === entity.entityId || r.targetEntityId === 'GLOBAL_AUGMENTATION');
      for (const ref of matchingRefs) {
        obligations.push({
          obligationId: `ob_${++obCounter}_consumer_${entity.name}_${ref.referenceId}`,
          projectId: ref.projectId,
          resolutionId: ref.resolutionId,
          question: 'CONSUMER_COMPATIBILITY',
          change,
          reference: ref,
          scope: 'CONSUMER',
          createdAt: new Date().toISOString()
        });
      }
    }

    // 4. Obligations for unresolved dynamic boundaries
    const unresolvedBoundaries = references.filter(r => r.isUnresolvedBoundary);
    const activeChanges = changes.filter(change => change.changeKind !== 'UNCHANGED');
    for (const unres of unresolvedBoundaries) {
      const matchedChange = activeChanges.find(c => c.identity.parentEntity?.entityId === unres.targetEntityId ||
        c.identity.candidateEntity?.entityId === unres.targetEntityId) ?? activeChanges[0] ?? {
        changeId: 'environment_' + unres.referenceId, changeKind: 'METADATA_CHANGED' as const,
        identity: { identityId: 'environment_' + unres.referenceId, status: 'UNRESOLVED_IDENTITY' as const,
          confidence: 'NONE' as const, ambiguityReasons: ['UNRESOLVED_REFERENCE_WITHOUT_ACTIVE_CHANGE'] },
        description: 'Unresolved sealed environment'
      };
      if (matchedChange) {
        obligations.push({
          obligationId: `ob_${++obCounter}_unresolved_${unres.referenceId}`,
          projectId: unres.projectId,
          resolutionId: unres.resolutionId,
          question: 'CONSUMER_COMPATIBILITY',
          change: matchedChange,
          reference: unres,
          scope: 'CONSUMER',
          createdAt: new Date().toISOString()
        });
      }
    }

    return obligations;
  }

  public async evaluateObligation(
    obligation: VerificationObligation,
    repository: GenericRepository
  ): Promise<VerificationVerdict> {
    const targetEntityId = obligation.change.identity.parentEntity?.entityId ??
      obligation.change.identity.candidateEntity?.entityId ??
      'unknown_target';

    const verdictId = `verd_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;

    const provenance: ProvenanceChain = {
      repositoryId: repository.repositoryId,
      projectId: obligation.projectId,
      resolutionId: obligation.resolutionId,
      identityId: obligation.change.identity.identityId,
      referenceId: obligation.reference?.referenceId,
      obligationId: obligation.obligationId,
      evidenceId,
      verdictId
    };

    if (obligation.change.identity.status !== 'CONFIRMED_IDENTITY') {
      return TypeScriptCandidateContext.unknown(obligation, repository,
        obligation.change.identity.status === 'UNRESOLVED_IDENTITY'
          ? String(obligation.change.identity.ambiguityReasons?.[0] ?? 'UNRESOLVED_IDENTITY')
          : 'AMBIGUOUS_IDENTITY');
    }
    if (obligation.reference?.isUnresolvedBoundary) {
      return TypeScriptCandidateContext.unknown(obligation, repository, obligation.reference.boundaryTaxonomyReason ?? 'UNRESOLVED_REFERENCE');
    }
    const sourceChanged = Boolean(obligation.change.deltaDescriptor?.['sourceChanged']);
    if (obligation.change.changeKind === 'UNCHANGED' && !sourceChanged && obligation.question !== 'BEHAVIORAL_COMPATIBILITY') {
      return { verdictId, obligationId: obligation.obligationId, targetEntityId: obligation.reference?.targetEntityId ?? targetEntityId,
        outcome: 'NOT_APPLICABLE', assurance: 'COMPILER_STATIC', property: 'CONSUMER_TYPE', scope: obligation.scope, provenance,
        evidence: { evidenceId, assurance: 'COMPILER_STATIC', property: 'CONSUMER_TYPE', metadata: { reason: 'IDENTICAL_SEALED_INPUTS' } }, timestamp: new Date().toISOString() };
    }
    if (obligation.question === 'API_COMPATIBILITY') {
      const finiteBooleanType = TypeScriptFiniteBooleanTypeProof.propose(obligation, repository);
      if (finiteBooleanType) return finiteBooleanType;
      if (this.boundedSnapshots.has(repository.parentSnapshot)) {
        return TypeScriptCandidateContext.unknown(obligation, repository, 'BOUNDED_PROJECT_COMPILER_CONTEXT_RELEASED');
      }
      return TypeScriptProviderApiEvaluator.evaluate(obligation, repository,
        { parent: this.programSets.get(repository.parentSnapshot),
          candidate: this.programSets.get(repository.candidateSnapshot) });
    }
    if (obligation.question === 'BEHAVIORAL_COMPATIBILITY') {
      const finiteBoolean = TypeScriptFiniteBooleanProof.propose(obligation, repository);
      if (finiteBoolean) return finiteBoolean;
      return TypeScriptOperationalEvaluator.evaluateOperationalBehavior(obligation, repository);
    }
    const finiteBooleanType = TypeScriptFiniteBooleanTypeProof.propose(obligation, repository);
    if (finiteBooleanType) return finiteBooleanType;
    if (this.boundedSnapshots.has(repository.parentSnapshot)) {
      return TypeScriptCandidateContext.unknown(obligation, repository, 'BOUNDED_PROJECT_COMPILER_CONTEXT_RELEASED');
    }
    return TypeScriptCandidateContext.evaluate(obligation, repository);
  }
}

