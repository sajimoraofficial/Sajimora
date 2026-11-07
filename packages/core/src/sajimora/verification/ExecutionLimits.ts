import { GenericProjectGraph, GenericRepository } from './contracts';

// Product limits, not fixture-dependent decisions. Checked from actual bytes.
export const PRODUCTION_LIMITS = Object.freeze({ files: 10000, fileBytes: 5 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024, projects: 64, projectSourceMemberships: 20000,
  obligations: 50000, timeoutMs: 120000, maxProcessRssBytes: 3 * 1024 * 1024 * 1024 });

/** Bound compiler graph fan-out before any ts.Program is constructed. */
export function validateProjectGraphBudget(graph: GenericProjectGraph): void {
  if (graph.projects.length > PRODUCTION_LIMITS.projects) throw new Error('RESOURCE_LIMIT_PROJECT_COUNT');
  let memberships = 0;
  for (const project of graph.projects) {
    memberships += project.sourceFiles.length;
    if (memberships > PRODUCTION_LIMITS.projectSourceMemberships) {
      throw new Error('RESOURCE_LIMIT_PROJECT_SOURCE_MEMBERSHIPS');
    }
  }
}

export function validateRepositoryBudget(repository: GenericRepository): void {
  let total = 0;
  for (const snapshot of [repository.parentSnapshot, repository.candidateSnapshot]) {
    if (snapshot.files.length > PRODUCTION_LIMITS.files) throw new Error('RESOURCE_LIMIT_FILE_COUNT');
    const seen = new Set<string>();
    for (const file of snapshot.files) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized.split('/').includes('..') || normalized.startsWith('__sajimora_typescript_libs__/') || seen.has(normalized)) {
        throw new Error('INVALID_SEALED_INVENTORY');
      }
      seen.add(normalized);
      const source = snapshot.readTextFile(file.path);
      if (source === undefined) throw new Error('MISSING_SEALED_FILE');
      const bytes = Buffer.byteLength(source);
      total += bytes;
      if (bytes > PRODUCTION_LIMITS.fileBytes || total > PRODUCTION_LIMITS.totalBytes) throw new Error('RESOURCE_LIMIT_SOURCE_BYTES');
    }
  }
}
