import * as ts from 'typescript';
import { GenericProjectGraph, GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';
import { SealedCompilerHost } from './SealedCompilerHost';

export interface SealedImportConditionCache {
  readonly conditions: Map<string, readonly string[] | null>;
  readonly scopes: Map<string, { host: SealedCompilerHost; packageInfo: unknown }>;
}
export const createSealedImportConditionCache = (): SealedImportConditionCache => ({
  conditions: new Map(), scopes: new Map()
});

/** The pinned compiler supplies the condition vocabulary. Only extensions
 * with an unambiguous module mode are admitted for condition narrowing;
 * ordinary .ts/.tsx needs sealed package-scope mode evidence first. */
export function sealedImportConditions(filePath: string, graph: GenericProjectGraph,
  projectIds: readonly string[], snapshot?: GenericRepositorySnapshot,
  cache?: SealedImportConditionCache): readonly (readonly string[])[] | undefined {
  const extensionMode = /\.(?:mts|mjs)$/i.test(filePath) ? ts.ModuleKind.ESNext
    : /\.(?:cts|cjs)$/i.test(filePath) ? ts.ModuleKind.CommonJS : undefined;
  if (projectIds.length === 0) return undefined;
  const getConditions = (ts as unknown as { getConditions: (
    options: ts.CompilerOptions, mode: ts.ModuleKind) => readonly string[] }).getConditions;
  if (typeof getConditions !== 'function') return undefined;
  const impliedFormat = (ts as unknown as { getImpliedNodeFormatForFile: (
    file: string, cache: unknown, host: ts.ModuleResolutionHost, options: ts.CompilerOptions) =>
      ts.ModuleKind | undefined }).getImpliedNodeFormatForFile;
  const results: string[][] = [];
  for (const id of projectIds) {
    const cacheKey = `${id}\0${filePath}`;
    const cached = cache?.conditions.get(cacheKey);
    if (cached === null) return undefined;
    if (cached) { results.push([...cached]); continue; }
    const project = graph.projects.find(item => item.projectId === id);
    if (!project) { cache?.conditions.set(cacheKey, null); return undefined; }
    const options = project.options as ts.CompilerOptions | undefined;
    if (!options || typeof options.moduleResolution !== 'number') { cache?.conditions.set(cacheKey, null); return undefined; }
    try {
      let scope = cache?.scopes.get(id);
      if (!scope && snapshot) {
        const host = new SealedCompilerHost(snapshot, id, options);
        const resolutionCache = ts.createModuleResolutionCache('/', file => file, options);
        scope = { host, packageInfo: resolutionCache.getPackageJsonInfoCache() };
        cache?.scopes.set(id, scope);
      }
      const mode = extensionMode ?? (snapshot && typeof impliedFormat === 'function'
        ? impliedFormat(`/${filePath.replace(/^\/+/, '')}`, scope?.packageInfo,
          scope?.host ?? new SealedCompilerHost(snapshot, id, options), options) : undefined);
      if (mode === undefined) { cache?.conditions.set(cacheKey, null); return undefined; }
      const conditions = getConditions(options, mode);
      if (!Array.isArray(conditions)) { cache?.conditions.set(cacheKey, null); return undefined; }
      results.push([...conditions]);
      cache?.conditions.set(cacheKey, [...conditions]);
    } catch { cache?.conditions.set(cacheKey, null); return undefined; }
  }
  return results;
}
