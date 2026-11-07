import * as ts from 'typescript';
import {
  GenericRepository,
  SemanticEntity,
  VerificationObligation,
  VerificationVerdict
} from '../../../../../../core/src/sajimora/verification';
import { ProgramSetManager, ProjectProgramInstance } from './ProgramSetManager';
import { TypeScriptProjectGraphBuilder } from './TypeScriptProjectGraphBuilder';
import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
import { TypeScriptCrossVersionTypeComparator } from './TypeScriptCrossVersionTypeComparator';

type ResolvedApi = {
  instance: ProjectProgramInstance;
  symbol: ts.Symbol;
  type: ts.Type;
  display: string;
};

/** Directional, checker-backed compatibility for exported provider contracts.
 * Runtime behavior is deliberately outside this evaluator. */
export class TypeScriptProviderApiEvaluator {
  private static readonly environments = new WeakMap<GenericRepository, {
    parent: ProgramSetManager;
    candidate: ProgramSetManager;
  }>();

  public static evaluate(obligation: VerificationObligation, repository: GenericRepository,
    existing?: { parent?: ProgramSetManager; candidate?: ProgramSetManager }): VerificationVerdict {
    const parentEntity = obligation.change.identity.parentEntity;
    const candidateEntity = obligation.change.identity.candidateEntity;
    if (!parentEntity && candidateEntity) return this.notApplicable(obligation, repository, 'EXPORTED_API_ADDED');
    if (parentEntity && !candidateEntity) return this.result(obligation, repository, false, parentEntity.signatureFingerprint, '<deleted>');
    if (!parentEntity || !candidateEntity) return TypeScriptCandidateContext.unknown(obligation, repository, 'DECLARATION_UNAVAILABLE');

    let environment = this.environments.get(repository);
    if (!environment) {
      environment = {
        parent: existing?.parent ?? new ProgramSetManager(repository.parentSnapshot,
          TypeScriptProjectGraphBuilder.buildProjectGraph(repository.parentSnapshot)),
        candidate: existing?.candidate ?? new ProgramSetManager(repository.candidateSnapshot,
          TypeScriptProjectGraphBuilder.buildProjectGraph(repository.candidateSnapshot))
      };
      this.environments.set(repository, environment);
    }
    const parent = this.resolve(environment.parent, parentEntity);
    const candidate = this.resolve(environment.candidate, candidateEntity);
    if (!parent || !candidate) return TypeScriptCandidateContext.unknown(obligation, repository, 'DECLARATION_UNAVAILABLE');
    if (parent.instance.configurationErrors.length || candidate.instance.configurationErrors.length) {
      return TypeScriptCandidateContext.unknown(obligation, repository, 'PROJECT_ENVIRONMENT_INVALID');
    }
    const environmentCodes = new Set([2307, 2688, 6053, 6305, 7016]);
    const environmentDiagnostics = (instance: ProjectProgramInstance) => [
      ...instance.program.getOptionsDiagnostics(),
      ...instance.program.getGlobalDiagnostics(),
      ...instance.program.getSemanticDiagnostics()
    ].filter(diagnostic => environmentCodes.has(diagnostic.code));
    if (environmentDiagnostics(parent.instance).length || environmentDiagnostics(candidate.instance).length) {
      return TypeScriptCandidateContext.unknown(obligation, repository, 'DEPENDENCY_CLOSURE_UNAVAILABLE');
    }

    try {
      const comparison = TypeScriptCrossVersionTypeComparator.compare(repository, parentEntity, candidateEntity,
        candidate.instance.program.getCompilerOptions());
      if (comparison.status === 'UNKNOWN') return TypeScriptCandidateContext.unknown(obligation, repository, comparison.reason);
      return this.result(obligation, repository, comparison.status === 'COMPATIBLE', comparison.parentType, comparison.candidateType,
        comparison.status === 'INCOMPATIBLE' ? comparison.diagnostics : []);
    } catch (error) {
      return TypeScriptCandidateContext.unknown(obligation, repository,
        error instanceof Error ? 'TYPE_RESOLUTION_FAILURE' : 'COMPILER_INTERNAL_FAILURE');
    }
  }

  private static resolve(manager: ProgramSetManager, entity: SemanticEntity): ResolvedApi | undefined {
    const norm = (file: string) => file.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const instance of manager.getAllInstances()) {
      const source = instance.program.getSourceFiles().find(file => norm(file.fileName) === norm(entity.filePath));
      if (!source) continue;
      const module = instance.typeChecker.getSymbolAtLocation(source);
      const exported = module && instance.typeChecker.getExportsOfModule(module).find(symbol => symbol.name === entity.name);
      if (!exported) continue;
      let symbol = exported;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try { symbol = instance.typeChecker.getAliasedSymbol(symbol); } catch { return undefined; }
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return undefined;
      const type = instance.typeChecker.getTypeOfSymbolAtLocation(symbol, declaration);
      return { instance, symbol, type,
        display: instance.typeChecker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation) };
    }
    return undefined;
  }

  private static result(
    obligation: VerificationObligation,
    repository: GenericRepository,
    compatible: boolean,
    parentType: string,
    candidateType: string,
    diagnostics: Array<{ code: number; message: string }> = []
  ): VerificationVerdict {
    const base = this.base(obligation, repository);
    return { ...base, outcome: compatible ? 'PRESERVED' : 'VIOLATED', assurance: 'COMPILER_STATIC',
      evidence: { evidenceId: base.provenance.evidenceId, assurance: 'COMPILER_STATIC', property: 'API_TYPE',
        compilerStatic: { diagnosticDelta: compatible ? 0 : 1, parentDiagnosticCount: 0,
          candidateDiagnosticCount: compatible ? 0 : 1,
          introducedDiagnostics: compatible ? [] : diagnostics.length ? diagnostics : [{ code: 'API_NOT_ASSIGNABLE',
            message: `Candidate provider type ${candidateType} is not assignable to historical type ${parentType}` }],
          assignabilityWitness: { sourceType: candidateType, targetType: parentType, isAssignable: compatible } },
        metadata: { route: 'TYPESCRIPT_SAME_CHECKER_COMPATIBILITY_WITNESS_V1', compilerVersion: ts.version } } };
  }

  private static notApplicable(obligation: VerificationObligation, repository: GenericRepository, reason: string): VerificationVerdict {
    const base = this.base(obligation, repository);
    return { ...base, outcome: 'NOT_APPLICABLE', assurance: 'COMPILER_STATIC', evidence: {
      evidenceId: base.provenance.evidenceId, assurance: 'COMPILER_STATIC', property: 'API_TYPE', metadata: { reason }
    } };
  }

  private static base(obligation: VerificationObligation, repository: GenericRepository) {
    const verdictId = `verd_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;
    return { verdictId, obligationId: obligation.obligationId,
      targetEntityId: obligation.change.identity.parentEntity?.entityId ?? obligation.change.identity.candidateEntity?.entityId ?? 'unresolved',
      property: 'API_TYPE' as const, scope: obligation.scope,
      provenance: { repositoryId: repository.repositoryId, projectId: obligation.projectId,
        identityId: obligation.change.identity.identityId, obligationId: obligation.obligationId, evidenceId, verdictId },
      timestamp: new Date().toISOString() };
  }
}
