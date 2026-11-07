/**
 * @file TypeScriptProjectGraphBuilder.ts
 * Discovers TypeScript projects from sealed snapshots with support for
 * tsconfig inheritance (extends), cyclic config detection, and path traversal guards.
 */

import * as ts from 'typescript';
import { SealedCompilerHost } from './SealedCompilerHost';
import { GenericRepositorySnapshot, GenericProject, GenericProjectGraph } from '../../../../../../core/src/sajimora/verification';

export class TypeScriptProjectGraphBuilder {
  public static buildProjectGraph(snapshot: GenericRepositorySnapshot): GenericProjectGraph {
    const tsconfigFiles = snapshot.files.filter(file =>
      file.path === 'tsconfig.json' ||
      file.path.endsWith('/tsconfig.json') ||
      file.path.includes('tsconfig.')
    );
    const projects: GenericProject[] = [];
    const edges: Array<{ fromProjectId: string; toProjectId: string }> = [];

    if (!tsconfigFiles.length) {
      const sourceFiles = snapshot.files
        .filter(file => file.path.endsWith('.ts') || file.path.endsWith('.tsx') || file.path.endsWith('.d.ts') || file.path.endsWith('.jsx') || file.path.endsWith('.js'))
        .map(file => file.path);
      const hasJsx = sourceFiles.some(f => /\.tsx$/i.test(f) || /\.jsx$/i.test(f));
      return {
        graphId: `graph_${snapshot.snapshotId}`,
        projects: [
          {
            projectId: `${snapshot.snapshotId}::project_default`,
            rootDirectory: '/',
            sourceFiles,
            projectReferences: [],
            options: {
              strict: true,
              target: 'ES2022',
              module: 'CommonJS',
              moduleResolution: 'Node10',
              ...(hasJsx ? { jsx: 'preserve' } : {})
            }
          }
        ],
        edges
      };
    }

    for (const configFile of tsconfigFiles) {
      const configDir = configFile.path.includes('/')
        ? configFile.path.slice(0, configFile.path.lastIndexOf('/'))
        : '/';
      const projectId = `${snapshot.snapshotId}::${configFile.path}`;
      const host = new SealedCompilerHost(snapshot, projectId, {});
      const errors: ts.Diagnostic[] = [];
      const parsed = ts.getParsedCommandLineOfConfigFile('/' + configFile.path, {}, {
        useCaseSensitiveFileNames: true,
        readDirectory: host.readDirectory.bind(host), fileExists: host.fileExists.bind(host),
        readFile: host.readFile.bind(host), getCurrentDirectory: () => '/',
        onUnRecoverableConfigFileDiagnostic: diagnostic => errors.push(diagnostic)
      });
      errors.push(...(parsed?.errors ?? []));
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');

      projects.push({
        projectId,
        rootDirectory: configDir,
        configFile: configFile.path,
        sourceFiles: (parsed?.fileNames ?? []).map(norm),
        projectReferences: (parsed?.projectReferences ?? []).map(ref => norm(ref.path)),
        options: {
          ...(parsed?.options ?? {}),
          _sajimoraParsedOptions: true,
          _sajimoraConfigErrors: errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
        }
      });
    }

    for (const project of projects) {
      for (const reference of project.projectReferences) {
        const target = projects.find(candidate =>
          candidate.rootDirectory === reference ||
          candidate.configFile === reference ||
          candidate.configFile === `${reference}/tsconfig.json`
        );
        if (target) {
          edges.push({ fromProjectId: project.projectId, toProjectId: target.projectId });
        }
      }
    }

    return { graphId: `graph_${snapshot.snapshotId}`, projects, edges };
  }

  public static resolveConfig(
    configPath: string,
    snapshot: GenericRepositorySnapshot,
    visited = new Set<string>()
  ): { config: any; isCyclic: boolean } {
    const normPath = this.normalize(configPath);
    if (visited.has(normPath)) {
      return { config: {}, isCyclic: true };
    }
    visited.add(normPath);

    const raw = snapshot.readTextFile(normPath);
    if (!raw) return { config: {}, isCyclic: false };

    let parsed: any = {};
    try {
      parsed = ts.parseConfigFileTextToJson(normPath, raw).config ?? {};
    } catch {
      return { config: {}, isCyclic: false };
    }

    if (parsed.extends && typeof parsed.extends === 'string') {
      const dir = normPath.includes('/') ? normPath.slice(0, normPath.lastIndexOf('/')) : '';
      const baseRelative = parsed.extends.startsWith('.')
        ? this.normalize(`${dir}/${parsed.extends}`)
        : this.normalize(parsed.extends);
      const basePath = baseRelative.endsWith('.json') ? baseRelative : `${baseRelative}.json`;

      const baseResult = this.resolveConfig(basePath, snapshot, new Set(visited));
      if (baseResult.isCyclic) {
        return { config: parsed, isCyclic: true };
      }

      parsed.compilerOptions = {
        ...(baseResult.config.compilerOptions ?? {}),
        ...(parsed.compilerOptions ?? {})
      };
    }

    return { config: parsed, isCyclic: false };
  }

  private static normalize(path: string): string {
    const posix = path.replace(/\\/g, '/');
    const parts = posix.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (resolved.length > 0) {
          resolved.pop();
        } else {
          return '__ESCAPE_ROOT__';
        }
      } else {
        resolved.push(part);
      }
    }
    return resolved.join('/');
  }
}
