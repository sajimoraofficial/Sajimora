/**
 * @file ProgramSetManager.ts
 * Manages dual sets of ts.Program instances over sealed repository snapshots.
 * 
 * Supports:
 * - Multi-project compilation sets
 * - Project references and composite projects
 * - In-memory SealedCompilerHost for zero filesystem leakage
 * - Automatic tsconfig JSON option conversion to TypeScript compiler enums
 */

import * as ts from 'typescript';
import {
  GenericRepositorySnapshot,
  GenericProject,
  GenericProjectGraph
} from '../../../../../../core/src/sajimora/verification';
import { SealedCompilerHost } from './SealedCompilerHost';

export interface ProjectProgramInstance {
  project: GenericProject;
  host: SealedCompilerHost;
  program: ts.Program;
  typeChecker: ts.TypeChecker;
  configurationErrors: readonly string[];
}

export class ProgramSetManager {
  private readonly instances = new Map<string, ProjectProgramInstance>();

  constructor(
    private readonly snapshot: GenericRepositorySnapshot,
    private readonly projectGraph: GenericProjectGraph
  ) {
    this.buildPrograms();
  }

  public getInstance(projectId: string): ProjectProgramInstance | undefined {
    return this.instances.get(projectId);
  }

  public getAllInstances(): readonly ProjectProgramInstance[] {
    return Array.from(this.instances.values());
  }

  /** Visit one project at a time without retaining Programs or TypeCheckers
   * across project boundaries. The caller must not keep an instance. */
  public static visitProjects(snapshot: GenericRepositorySnapshot, graph: GenericProjectGraph,
    visit: (instance: ProjectProgramInstance) => void): void {
    for (const project of graph.projects) {
      const one = new ProgramSetManager(snapshot, { ...graph, projects: [project], edges: [] });
      try {
        const instance = one.getAllInstances()[0];
        if (instance) visit(instance);
      } finally { one.instances.clear(); }
    }
  }

  private buildPrograms(): void {
    for (const project of this.projectGraph.projects) {
      const rawOptions = (project.options as Record<string, unknown>) ?? {};
      const converted = rawOptions['_sajimoraParsedOptions']
        ? { options: rawOptions as ts.CompilerOptions, errors: [] as ts.Diagnostic[] }
        : ts.convertCompilerOptionsFromJson(rawOptions, project.rootDirectory);
      const configurationErrors = [
        ...((rawOptions['_sajimoraConfigErrors'] as string[] | undefined) ?? []),
        ...converted.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
      ];

      const hasJsx = project.sourceFiles.some(f => /\.tsx$/i.test(f) || /\.jsx$/i.test(f));
      const options: ts.CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: false,
        types: [],
        ...(hasJsx ? { jsx: ts.JsxEmit.Preserve } : {}),
        ...converted.options
      };
      if (hasJsx && options.jsx === undefined) {
        options.jsx = ts.JsxEmit.Preserve;
      }

      const host = new SealedCompilerHost(this.snapshot, project.projectId, options);
      
      const projectReferences: ts.ProjectReference[] = project.projectReferences.map(p => ({
        path: p
      }));

      const program = ts.createProgram({
        rootNames: [...project.sourceFiles],
        options,
        host,
        projectReferences: projectReferences.length > 0 ? projectReferences : undefined
      });

      const typeChecker = program.getTypeChecker();

      this.instances.set(project.projectId, {
        project,
        host,
        program,
        typeChecker,
        configurationErrors
      });
    }
  }
}
