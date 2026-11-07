import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { binaryCompare, canonicalJson } from '@sajimora/core';
import { hashCanonical } from './IndexIdentity';

type ProbeKind = 'FILE_EXISTS' | 'DIRECTORY_EXISTS' | 'READ_FILE' | 'GET_DIRECTORIES' | 'READ_DIRECTORY';
interface Route { readonly path: string; readonly targetKind: 'DEPENDENCY' | 'WORKSPACE'; readonly target: string }
interface Probe { readonly kind: ProbeKind; readonly path: string; readonly args: readonly unknown[]; readonly result: unknown }
export interface DependencyLookupReceipt {
  readonly routes: readonly Route[];
  readonly probes: readonly Probe[];
  readonly fingerprint: string;
}

const slash = (value: string) => value.replace(/\\/g, '/');
const inside = (target: string, root: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
const isNodeModules = (relative: string) => slash(relative).split('/').includes('node_modules');
const hashText = (value: string | undefined) => value === undefined ? null
  : createHash('sha256').update(value, 'utf8').digest('hex');

/** Records the finite filesystem oracle actually consulted by TypeScript.
 * Repeated calls return their first observed value; a final replay rejects
 * mutations that remain present at publication. Workspace links read Git
 * snapshot bytes, while dependency probes include both hits and misses. */
export class DependencyLookupRecorder {
  private readonly root: string;
  private readonly routes = new Map<string, Route>();
  private readonly probes = new Map<string, Probe>();
  private readonly values = new Map<string, unknown>();

  public constructor(repositoryOrNodeModulesRoot: string, private readonly snapshotRoot: string,
    private readonly trackedFiles: readonly string[]) {
    const absolute = path.resolve(repositoryOrNodeModulesRoot);
    this.root = path.basename(absolute).toLowerCase() === 'node_modules' ? path.dirname(absolute) : absolute;
  }

  public map(rawPath: string): string {
    const route = this.route(rawPath);
    if (!route) return rawPath;
    return route.targetKind === 'WORKSPACE'
      ? path.join(this.snapshotRoot, ...route.target.split('/')) : rawPath;
  }

  public observe<T>(kind: ProbeKind, rawPath: string, args: readonly unknown[], evaluate: (mapped: string) => T): T {
    const route = this.route(rawPath);
    const mapped = route?.targetKind === 'WORKSPACE'
      ? path.join(this.snapshotRoot, ...route.target.split('/')) : rawPath;
    if (!route || route.targetKind === 'WORKSPACE') return evaluate(mapped);
    const key = canonicalJson([kind, route.path, args]);
    if (this.values.has(key)) return this.values.get(key) as T;
    if (kind === 'READ_FILE' && this.probes.has(key)) {
      const value = evaluate(mapped);
      if (canonicalJson(this.summarize(kind, value)) !== canonicalJson(this.probes.get(key)!.result)) {
        throw new Error(`DEPENDENCY_LOOKUP_CHANGED_DURING_BUILD:${route.path}`);
      }
      return value;
    }
    const value = evaluate(mapped);
    if (kind !== 'READ_FILE') this.values.set(key, value);
    this.probes.set(key, { kind, path: route.path, args, result: this.summarize(kind, value) });
    return value;
  }

  public finish(): DependencyLookupReceipt {
    const content = {
      routes: [...this.routes.values()].sort((a, b) => binaryCompare(a.path, b.path)),
      probes: [...this.probes.values()].sort((a, b) => binaryCompare(canonicalJson(a), canonicalJson(b)))
    };
    const receipt = { ...content, fingerprint: hashCanonical('SAJIMORA_DEPENDENCY_LOOKUPS_V1', content) };
    DependencyLookupRecorder.verify(this.root, receipt);
    return receipt;
  }

  public static verify(repositoryOrNodeModulesRoot: string, receipt: DependencyLookupReceipt): void {
    const absolute = path.resolve(repositoryOrNodeModulesRoot);
    const root = path.basename(absolute).toLowerCase() === 'node_modules' ? path.dirname(absolute) : absolute;
    const content = { routes: receipt.routes, probes: receipt.probes };
    if (receipt.fingerprint !== hashCanonical('SAJIMORA_DEPENDENCY_LOOKUPS_V1', content)) {
      throw new Error('DEPENDENCY_LOOKUP_RECEIPT_CORRUPT');
    }
    const verifier = new DependencyLookupRecorder(root, root, []);
    for (const expected of receipt.routes) {
      const current = verifier.computeRoute(path.join(root, ...expected.path.split('/')));
      if (!current || canonicalJson(current) !== canonicalJson(expected)) {
        throw new Error(`DEPENDENCY_LOOKUP_ROUTE_STALE:${expected.path}`);
      }
    }
    for (const probe of receipt.probes) {
      const physical = path.join(root, ...probe.path.split('/'));
      const current = verifier.directProbe(probe.kind, physical, probe.args);
      if (canonicalJson(verifier.summarize(probe.kind, current)) !== canonicalJson(probe.result)) {
        throw new Error(`DEPENDENCY_LOOKUP_STALE:${probe.kind}:${probe.path}`);
      }
    }
  }

  private route(rawPath: string): Route | undefined {
    if (!inside(rawPath, this.root)) return undefined;
    const relative = slash(path.relative(this.root, rawPath));
    if (!isNodeModules(relative)) return undefined;
    const cached = this.routes.get(relative);
    if (cached) return cached;
    const route = this.computeRoute(rawPath);
    if (route) this.routes.set(relative, route);
    return route;
  }

  private computeRoute(rawPath: string): Route | undefined {
    if (!inside(rawPath, this.root)) return undefined;
    const relative = slash(path.relative(this.root, rawPath));
    if (!isNodeModules(relative)) return undefined;
    let ancestor = path.resolve(rawPath);
    const missing: string[] = [];
    while (!fs.existsSync(ancestor) && ancestor !== this.root) {
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    let real: string;
    try { real = path.resolve(fs.realpathSync(ancestor), ...missing); }
    catch { throw new Error(`DEPENDENCY_LOOKUP_REALPATH_UNREADABLE:${relative}`); }
    if (!inside(real, this.root)) throw new Error(`DEPENDENCY_SYMLINK_ESCAPES_ROOT:${relative}`);
    const target = slash(path.relative(this.root, real));
    return { path: relative, targetKind: isNodeModules(target) ? 'DEPENDENCY' : 'WORKSPACE', target };
  }

  private summarize(kind: ProbeKind, value: unknown): unknown {
    if (kind === 'READ_FILE') return hashText(value as string | undefined);
    if (kind === 'GET_DIRECTORIES' || kind === 'READ_DIRECTORY') {
      return (value as string[]).map(item => slash(path.relative(this.root, item))).sort();
    }
    return value;
  }

  private directProbe(kind: ProbeKind, physical: string, args: readonly unknown[]): unknown {
    switch (kind) {
      case 'FILE_EXISTS': return ts.sys.fileExists(physical);
      case 'DIRECTORY_EXISTS': return Boolean(ts.sys.directoryExists(physical));
      case 'READ_FILE': return ts.sys.readFile(physical);
      case 'GET_DIRECTORIES': return ts.sys.getDirectories(physical);
      case 'READ_DIRECTORY': return ts.sys.readDirectory(physical,
        (args[0] ?? undefined) as readonly string[] | undefined,
        (args[1] ?? undefined) as readonly string[] | undefined,
        (args[2] ?? undefined) as readonly string[] | undefined,
        (args[3] ?? undefined) as number | undefined);
    }
  }
}
