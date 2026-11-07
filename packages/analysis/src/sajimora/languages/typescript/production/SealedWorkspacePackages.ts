import { GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';

export interface WorkspacePackage {
  readonly name: string;
  readonly manifestPath: string;
  readonly sourceFiles: readonly string[];
}

export interface WorkspacePackageIndex {
  readonly packages: readonly WorkspacePackage[];
  readonly blockers: readonly string[];
  resolve(specifier: string): WorkspacePackage | undefined;
  resolveEntry(specifier: string, conditions?: readonly string[]):
    { readonly files: readonly string[]; readonly blockers: readonly string[] };
}

const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
const isSource = (value: string) => /\.(?:[cm]?[jt]sx?)$/i.test(value);

/** A sealed inventory of package names and their possible source universe.
 * A package import conservatively reaches every source beneath its manifest.
 * External imports remain unresolved to the caller; absence from this index
 * is never evidence that an external dependency is safe. */
export function buildSealedWorkspacePackageIndex(snapshot: GenericRepositorySnapshot): WorkspacePackageIndex {
  const paths = snapshot.files.map(file => norm(file.path));
  const blockers = new Set<string>();
  const packages: WorkspacePackage[] = [];
  const manifests = new Map<string, Record<string, unknown>>();
  const names = new Set<string>();
  for (const manifestPath of paths.filter(file => file === 'package.json' ||
    (file.endsWith('/package.json') && !file.split('/').includes('node_modules'))).sort()) {
    const text = snapshot.readTextFile(manifestPath);
    if (text === undefined) { blockers.add(`UNREADABLE_PACKAGE_MANIFEST:${manifestPath}`); continue; }
    let manifest: unknown;
    try { manifest = JSON.parse(text); }
    catch { blockers.add(`INVALID_PACKAGE_MANIFEST:${manifestPath}`); continue; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      blockers.add(`INVALID_PACKAGE_MANIFEST:${manifestPath}`); continue;
    }
    const record = manifest as Record<string, unknown>;
    if (record['name'] === undefined) continue;
    const name = record['name'];
    if (typeof name !== 'string' || !/^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/.test(name)) {
      blockers.add(`INVALID_PACKAGE_NAME:${manifestPath}`); continue;
    }
    if (names.has(name)) { blockers.add(`DUPLICATE_PACKAGE_NAME:${name}`); continue; }
    names.add(name);
    manifests.set(name, record);
    const directory = manifestPath === 'package.json' ? '' : manifestPath.slice(0, -'/package.json'.length);
    const sourceFiles = paths.filter(file => isSource(file) &&
      (directory === '' || file.startsWith(`${directory}/`))).sort();
    packages.push({ name, manifestPath, sourceFiles });
  }
  const ordered = packages.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const resolve = (specifier: string) => ordered.find(pkg => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));
  return { packages: ordered, blockers: [...blockers].sort(),
    resolve,
    resolveEntry: (specifier, conditions) => {
      const pkg = resolve(specifier);
      if (!pkg) return { files: [], blockers: [`NOT_A_WORKSPACE_PACKAGE:${specifier}`] };
      const manifest = manifests.get(pkg.name)!;
      const directory = pkg.manifestPath === 'package.json' ? '' : pkg.manifestPath.slice(0, -'/package.json'.length);
      const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
      const entryBlockers: string[] = [];
      let entry: unknown;
      let wildcard = '';
      if (manifest['exports'] !== undefined) {
        const exports = manifest['exports'];
        if (typeof exports === 'string' || Array.isArray(exports)) entry = subpath === '.' ? exports : undefined;
        else if (exports && typeof exports === 'object') {
          const map = exports as Record<string, unknown>;
          if (Object.keys(map).some(key => key.startsWith('.'))) {
            if (Object.keys(map).some(key => !key.startsWith('.'))) {
              entryBlockers.push(`MIXED_WORKSPACE_EXPORT_MAP:${specifier}`);
            }
            entry = map[subpath];
            const matches: Array<{ value: unknown; wildcard: string }> = [];
            if (entry === undefined) for (const key of Object.keys(map)) {
              if (!key.includes('*')) continue;
              if (key.split('*').length !== 2) {
                entryBlockers.push(`UNSUPPORTED_WORKSPACE_EXPORT_PATTERN:${specifier}:${key}`);
                continue;
              }
              const [prefix, suffix] = key.split('*');
              if (subpath.startsWith(prefix) && subpath.endsWith(suffix) &&
                subpath.length >= prefix.length + suffix.length) {
                matches.push({ value: map[key], wildcard: subpath.slice(prefix.length, subpath.length - suffix.length) });
              }
            }
            if (matches.length > 1) entryBlockers.push(`AMBIGUOUS_WORKSPACE_EXPORT_PATTERN:${specifier}`);
            if (matches.length) { entry = matches[0].value; wildcard = matches[0].wildcard; }
          } else entry = subpath === '.' ? exports : undefined;
        }
      } else if (subpath === '.') {
        entry = [manifest['types'], manifest['module'], manifest['main']].filter(value => value !== undefined);
        if (!(entry as unknown[]).length) entry = './index';
      } else entry = subpath;
      if (entry === undefined) return { files: [], blockers: [`UNEXPORTED_WORKSPACE_SUBPATH:${specifier}`] };
      const leaves: string[] = [];
      const visit = (value: unknown): void => {
        if (typeof value === 'string') leaves.push(value.replace(/\*/g, wildcard));
        else if (value === null) return;
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          const branches = Object.entries(value as Record<string, unknown>);
          if (conditions) {
            if (branches.some(([key]) => key.startsWith('types@'))) {
              entryBlockers.push(`VERSIONED_WORKSPACE_EXPORT_CONDITION:${specifier}`);
            }
            const selected = branches.find(([key]) => key === 'default' || conditions.includes(key));
            if (!selected) entryBlockers.push(`NO_MATCHING_WORKSPACE_EXPORT_CONDITION:${specifier}`);
            else visit(selected[1]);
          } else branches.forEach(([, branch]) => visit(branch));
        }
        else entryBlockers.push(`INVALID_WORKSPACE_EXPORT_TARGET:${specifier}`);
      };
      visit(entry);
      const found = new Set<string>();
      for (const leaf of leaves) {
        if (!leaf.startsWith('./')) { entryBlockers.push(`NON_RELATIVE_WORKSPACE_EXPORT:${specifier}:${leaf}`); continue; }
        const parts: string[] = [];
        for (const part of leaf.slice(2).split('/')) {
          if (part === '..') { if (!parts.length) { entryBlockers.push(`ESCAPING_WORKSPACE_EXPORT:${specifier}:${leaf}`); break; } parts.pop(); }
          else if (part && part !== '.') parts.push(part);
        }
        const base = [directory, ...parts].filter(Boolean).join('/');
        const alternatives = /\.mjs$/i.test(base) ? [base.replace(/\.mjs$/i, '.mts'), base.replace(/\.mjs$/i, '.d.mts'), base]
          : /\.cjs$/i.test(base) ? [base.replace(/\.cjs$/i, '.cts'), base.replace(/\.cjs$/i, '.d.cts'), base]
            : /\.jsx?$/i.test(base) ? [base.replace(/\.jsx?$/i, '.ts'),
              base.replace(/\.jsx?$/i, '.tsx'), base.replace(/\.jsx?$/i, '.d.ts'), base]
              : [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}/index.ts`];
        const matches = alternatives.filter(file => pkg.sourceFiles.includes(file));
        if (!matches.length && !base.endsWith('/package.json')) {
          entryBlockers.push(`MISSING_WORKSPACE_EXPORT_SOURCE:${specifier}:${leaf}`);
        }
        matches.forEach(file => found.add(file));
      }
      if (!leaves.length) entryBlockers.push(`EMPTY_WORKSPACE_EXPORT:${specifier}`);
      return { files: [...found].sort(), blockers: [...new Set(entryBlockers)].sort() };
    } };
}
