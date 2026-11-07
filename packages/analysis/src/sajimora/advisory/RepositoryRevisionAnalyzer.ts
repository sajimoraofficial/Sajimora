import * as ts from 'typescript';
import { GitObjectReader, GitRepository, GitTreeEntry } from '../snapshots';
import { AdvisoryImpactResult, AdvisoryResourceLimits, AdvisoryTargetDeclaration, AdvisoryTypeScriptImpactAnalyzer, SealedRevision } from './TypeScriptImpactAnalyzer';

export interface RepositoryRevisionInput { repositoryPath: string; parentSha: string; candidateSha: string; target: AdvisoryTargetDeclaration; resourceLimits?: Partial<AdvisoryResourceLimits>; }
export interface ValidatedRepositoryRevisionInput extends RepositoryRevisionInput { repositoryId: string; parentCommitSha: string; candidateCommitSha: string; }
export interface SealedRevisionPair { validated: ValidatedRepositoryRevisionInput; parent: SealedRevision; candidate: SealedRevision; }

const defaults: AdvisoryResourceLimits = Object.freeze({ maxSelectedFiles: 256, maxSelectedBytes: 16 * 1024 * 1024, maxDependencyDepth: 32, maxScanFiles: 20_000, maxScanBytes: 32 * 1024 * 1024, maxExecutionMs: 15_000, maxRssBytes: 1024 * 1024 * 1024 });
const sourceFile = (file: string) => /\.[cm]?[jt]sx?$/i.test(file);
const textFile = (file: string) => sourceFile(file) || /\.json$/i.test(file);
const slash = (file: string) => file.replace(/\\/g, '/').replace(/^\.\//, '');
const safeTargetFile = (file: string) => { const normalized = slash(file); if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`Unsafe target file: ${file}`); return normalized; };

/** Trusted Git ingestion performs bounded selection; the analyzer receives only sealed bytes. */
export class RepositoryRevisionAnalyzer {
  validate(input: RepositoryRevisionInput): ValidatedRepositoryRevisionInput {
    if (!input.target?.symbol?.trim()) throw new Error('Target symbol is required.');
    const repository = new GitRepository(input.repositoryPath); repository.validate();
    const commit = (sha: string) => repository.text(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    return { ...input, target: { file: safeTargetFile(input.target.file), symbol: input.target.symbol.trim() }, repositoryId: repository.repositoryId(), parentCommitSha: commit(input.parentSha), candidateCommitSha: commit(input.candidateSha) };
  }

  materialize(input: RepositoryRevisionInput): SealedRevisionPair {
    const validated = this.validate(input); const objects = new GitObjectReader(new GitRepository(validated.repositoryPath)); const limits = { ...defaults, ...input.resourceLimits };
    return { validated, parent: this.selectRevision(objects, validated.parentCommitSha, validated.target, limits), candidate: this.selectRevision(objects, validated.candidateCommitSha, validated.target, limits) };
  }

  analyze(input: RepositoryRevisionInput): AdvisoryImpactResult {
    const pair = this.materialize(input); const limits = { ...defaults, ...input.resourceLimits };
    return new AdvisoryTypeScriptImpactAnalyzer().analyze({ parent: pair.parent, candidate: pair.candidate, target: pair.validated.target, resourceLimits: { maxExecutionMs: limits.maxExecutionMs, maxRssBytes: limits.maxRssBytes } });
  }

  private selectRevision(objects: GitObjectReader, commitSha: string, target: AdvisoryTargetDeclaration, limits: AdvisoryResourceLimits): SealedRevision {
    const entries = objects.entries(commitSha).filter(entry => entry.type === 'blob' && textFile(entry.path));
    const byPath = new Map(entries.map(entry => [slash(entry.path), entry])); const allSources = [...byPath.keys()].filter(sourceFile).sort();
    const selected = new Set<string>(), retained = new Map<string, string>(), imports = new Map<string, string[]>(), reasons = new Set<string>();
    let selectedBytes = 0, scannedFiles = 0, scannedBytes = 0; const started = performance.now(); const root = '/sealed';
    const exhausted = (stage: string) => { const timeExceeded = performance.now() - started > limits.maxExecutionMs; const rssExceeded = process.memoryUsage().rss > limits.maxRssBytes; if (timeExceeded) reasons.add(`BUDGET -> ${stage}:TIME`); if (rssExceeded) reasons.add(`BUDGET -> ${stage}:RSS`); return timeExceeded || rssExceeded; };
    const load = (file: string, retain: boolean): string | undefined => {
      const entry = byPath.get(slash(file)); if (!entry) return undefined; const text = objects.blob(entry.objectId).toString('utf8');
      if (retain) { if (!selected.has(file) && (selected.size >= limits.maxSelectedFiles || selectedBytes + Buffer.byteLength(text) > limits.maxSelectedBytes)) { reasons.add('BUDGET -> SELECTED_FILES_OR_BYTES'); return undefined; } if (!selected.has(file)) { selected.add(file); selectedBytes += Buffer.byteLength(text); } retained.set(file, text); }
      return text;
    };
    const configPath = this.nearestConfig(target.file, byPath); let options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Node10, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve };
    if (configPath) { const text = load(configPath, true); if (text !== undefined) { const parsed = ts.parseConfigFileTextToJson(configPath, text); if (parsed.error) reasons.add(`CONFIG -> ${configPath}:INVALID`); else options = { ...options, ...ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions ?? {}, root, configPath).options }; } }
    const relative = (file: string) => file === root ? '' : slash(file.startsWith(root + '/') ? file.slice(root.length + 1) : file);
    const host: ts.ModuleResolutionHost = { fileExists: file => byPath.has(relative(file)), readFile: file => load(relative(file), false), directoryExists: dir => dir === root || (() => { const prefix = relative(dir).replace(/\/$/, '') + '/'; return [...byPath.keys()].some(file => file.startsWith(prefix)); })(), getDirectories: () => [], realpath: file => file, getCurrentDirectory: () => root };
    const cache = ts.createModuleResolutionCache(root, value => value, options);
    const resolve = (specifier: string, from: string) => { const hit = ts.resolveModuleName(specifier, `${root}/${from}`, options, host, cache).resolvedModule; return hit && byPath.has(relative(hit.resolvedFileName)) ? relative(hit.resolvedFileName) : undefined; };
    const scan = (file: string): string[] => {
      if (imports.has(file)) return imports.get(file)!; if (++scannedFiles > limits.maxScanFiles) { reasons.add('BUDGET -> SCAN_FILES'); return []; }
      const text = load(file, false); if (text === undefined) { reasons.add(`RESOLUTION -> ${file}:MISSING`); return []; } scannedBytes += Buffer.byteLength(text); if (scannedBytes > limits.maxScanBytes) { reasons.add('BUDGET -> SCAN_BYTES'); return []; }
      const dependencies: string[] = [];
      for (const item of ts.preProcessFile(text, true, true).importedFiles) { const resolved = resolve(item.fileName, file); if (resolved) dependencies.push(resolved); else reasons.add(`RESOLUTION -> ${file} -> ${item.fileName}`); }
      dependencies.sort(); imports.set(file, dependencies); return dependencies;
    };
    const addClosure = (seed: string) => {
      const queue: Array<{ file: string; depth: number }> = [{ file: seed, depth: 0 }], seen = new Set<string>();
      while (queue.length && !exhausted('SELECTION')) { const current = queue.shift()!; if (seen.has(current.file)) continue; seen.add(current.file); if (load(current.file, true) === undefined) continue; const deps = scan(current.file); if (current.depth >= limits.maxDependencyDepth && deps.length) { reasons.add('BUDGET -> DEPENDENCY_DEPTH'); continue; } for (const dependency of deps) queue.push({ file: dependency, depth: current.depth + 1 }); }
    };
    if (!byPath.has(target.file)) reasons.add(`TARGET -> ${target.file}:MISSING`); else addClosure(target.file);
    // Stream all source files to build reverse edges. Their bytes are discarded unless selected.
    for (const file of allSources) { if (exhausted('SCAN')) break; scan(file); }
    let changed = true;
    while (changed && !exhausted('CLOSURE')) { changed = false; const selectedNow = new Set([...selected].filter(sourceFile)); for (const [consumer, dependencies] of [...imports].sort(([a],[b]) => (a < b ? -1 : a > b ? 1 : 0))) if (!selected.has(consumer) && dependencies.some(dependency => selectedNow.has(dependency))) { const before = selected.size; addClosure(consumer); changed ||= selected.size > before; } }
    const files = Object.fromEntries([...retained.entries()].sort(([a],[b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return { commitSha, files, tsconfigPath: configPath && files[configPath] !== undefined ? configPath : undefined, selection: { selectedFiles: selected.size, selectedBytes, scannedFiles, scannedBytes, excludedFiles: Math.max(0, entries.length - selected.size), incompleteReasons: [...reasons].sort() } };
  }

  private nearestConfig(targetFile: string, files: ReadonlyMap<string, GitTreeEntry>): string | undefined {
    const parts = targetFile.split('/'); parts.pop(); for (let i = parts.length; i >= 0; i--) { const candidate = [...parts.slice(0, i), 'tsconfig.json'].filter(Boolean).join('/'); if (files.has(candidate)) return candidate; } return undefined;
  }
}
