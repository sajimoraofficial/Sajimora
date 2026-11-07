import { GenericProjectGraph, GenericRepository, GenericRepositorySnapshot,
  VirtualFileDescriptor } from '../../../../../../core/src/sajimora/verification';

export interface SealedChangedFile {
  readonly path: string;
  readonly parent?: VirtualFileDescriptor;
  readonly candidate?: VirtualFileDescriptor;
  readonly parentProjectIds: readonly string[];
  readonly candidateProjectIds: readonly string[];
}

export interface SealedChangeInventory {
  readonly changedFiles: readonly SealedChangedFile[];
  readonly changedSourcePaths: readonly string[];
  readonly changedEnvironmentPaths: readonly string[];
  readonly directlyAffectedParentProjects: readonly string[];
  readonly directlyAffectedCandidateProjects: readonly string[];
  readonly blockers: readonly string[];
  /** Direct ownership is not a consumer-closure proof. */
  readonly consumerClosure: 'UNVERIFIED';
}

const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
const isSource = (value: string) => /\.(?:[cm]?[jt]sx?)$/i.test(value);
const isEnvironment = (value: string) => /(^|\/)(?:tsconfig(?:\.[^/]*)?\.json|package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(value);

function descriptors(snapshot: GenericRepositorySnapshot, blockers: string[]): Map<string, VirtualFileDescriptor> {
  const result = new Map<string, VirtualFileDescriptor>();
  for (const file of snapshot.files) {
    const path = norm(file.path);
    if (result.has(path)) blockers.push(`DUPLICATE_SNAPSHOT_PATH:${snapshot.snapshotId}:${path}`);
    result.set(path, file);
  }
  return result;
}

function owners(graph: GenericProjectGraph, path: string): string[] {
  return graph.projects.filter(project => project.sourceFiles.some(file => norm(file) === path) ||
    (project.configFile !== undefined && norm(project.configFile) === path))
    .map(project => project.projectId).sort();
}

/** Complete sealed path/mode/hash diff before allocating TypeScript Programs. */
export function buildSealedChangeInventory(repository: GenericRepository,
  parentGraph: GenericProjectGraph, candidateGraph: GenericProjectGraph): SealedChangeInventory {
  const blockers: string[] = [];
  const parent = descriptors(repository.parentSnapshot, blockers);
  const candidate = descriptors(repository.candidateSnapshot, blockers);
  const changedFiles: SealedChangedFile[] = [];
  const parentProjects = new Set<string>();
  const candidateProjects = new Set<string>();
  for (const path of [...new Set([...parent.keys(), ...candidate.keys()])].sort()) {
    const before = parent.get(path);
    const after = candidate.get(path);
    if (before && after && before.hash === after.hash && before.byteLength === after.byteLength &&
      Boolean(before.isSymlink) === Boolean(after.isSymlink) &&
      Boolean(before.isExecutable) === Boolean(after.isExecutable)) continue;
    const parentProjectIds = owners(parentGraph, path);
    const candidateProjectIds = owners(candidateGraph, path);
    changedFiles.push({ path, parent: before, candidate: after, parentProjectIds, candidateProjectIds });
    parentProjectIds.forEach(id => parentProjects.add(id));
    candidateProjectIds.forEach(id => candidateProjects.add(id));
    if (isSource(path) && parentProjectIds.length === 0 && candidateProjectIds.length === 0) {
      blockers.push(`CHANGED_SOURCE_OUTSIDE_PROJECTS:${path}`);
    }
  }
  for (const path of [...(repository.parentSnapshot.omittedBinaryPaths ?? []),
    ...(repository.candidateSnapshot.omittedBinaryPaths ?? [])]) {
    if (isSource(norm(path)) || isEnvironment(norm(path))) blockers.push(`OMITTED_RELEVANT_INPUT:${norm(path)}`);
  }
  const paths = changedFiles.map(file => file.path);
  return {
    changedFiles,
    changedSourcePaths: paths.filter(isSource),
    changedEnvironmentPaths: paths.filter(isEnvironment),
    directlyAffectedParentProjects: [...parentProjects].sort(),
    directlyAffectedCandidateProjects: [...candidateProjects].sort(),
    blockers: [...new Set(blockers)].sort(),
    consumerClosure: 'UNVERIFIED'
  };
}
