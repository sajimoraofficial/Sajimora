/**
 * Advisory-only, in-memory TypeScript impact slice.  It intentionally has no
 * dependency on the certified pipeline or its verdict authority.
 */
import * as path from 'node:path';
import * as ts from 'typescript';

/** The advisory contract is replayable only with this installed compiler. */
export const ADVISORY_TYPESCRIPT_VERSION = '5.9.3';

export type AdvisoryVerdict = 'LIKELY_PRESERVED' | 'LIKELY_VIOLATED' | 'INCONCLUSIVE' | 'ANALYSIS_ERROR';
export type CompletenessStatus = 'COMPLETE' | 'INCOMPLETE';
/** `files` is the complete sealed project tree; tsconfigPath is also sealed bytes in `files`. */
export interface AdvisoryResourceLimits { maxSelectedFiles: number; maxSelectedBytes: number; maxDependencyDepth: number; maxScanFiles: number; maxScanBytes: number; maxExecutionMs: number; maxRssBytes: number; }
export interface SealedSelection { selectedFiles: number; selectedBytes: number; scannedFiles: number; scannedBytes: number; excludedFiles: number; incompleteReasons: readonly string[]; }
export interface SealedRevision { commitSha: string; files: Readonly<Record<string, string>>; tsconfigPath?: string; selection?: SealedSelection; }
export interface AdvisoryTargetDeclaration { file: string; symbol: string; }
export interface AdvisoryInput { parent: SealedRevision; candidate: SealedRevision; target?: AdvisoryTargetDeclaration; resourceLimits?: Pick<AdvisoryResourceLimits, 'maxExecutionMs' | 'maxRssBytes'>; }
export interface AdvisorySpan { file: string; line: number; column: number; }
export interface AdvisoryDiagnostic { code: number; message: string; span: AdvisorySpan | null; }
export type ProviderChangeKind = 'EXPORT_ADDED' | 'EXPORT_REMOVED' | 'PARAMETER_REMOVED' | 'PARAMETER_ADDED' | 'RETURN_TYPE_CHANGED' | 'PROPERTY_REMOVED' | 'PROPERTY_MADE_OPTIONAL' | 'OVERLOAD_CHANGED' | 'DECLARATION_CHANGED';
export interface ProviderSignature { declarationKind: string; parameters: readonly { name: string; type: string | null; optional: boolean }[]; returnType: string | null; members: readonly { name: string; type: string | null; optional: boolean }[]; overloadCount: number; }
export interface ProviderDeclaration { id: string; file: string; name: string; span: AdvisorySpan; before: string | null; after: string | null; beforeSignature: ProviderSignature | null; afterSignature: ProviderSignature | null; change: ProviderChangeKind; identity: 'CASE_A' | 'CASE_B'; }
export type ConsumerReferenceKind = 'IMPORT' | 'RE_EXPORT' | 'CALL' | 'PROPERTY_ACCESS' | 'ASSIGNMENT' | 'ARGUMENT' | 'RETURN' | 'TYPE_ANNOTATION' | 'JSX' | 'VALUE_REFERENCE';
export interface ConsumerReference { providerId: string; consumer: AdvisorySpan; usage: AdvisorySpan; referenceKind: ConsumerReferenceKind; directness: 'DIRECT' | 'TRANSITIVE'; dependencyPath: string[]; resolutionStatus: 'COMPLETE' | 'INCOMPLETE'; }
export type ConsumerImpactClassification = 'UNAFFECTED' | 'NEWLY_FAILING' | 'NEWLY_WIDENED_SAFE' | 'NEWLY_NARROWED' | 'UNRESOLVED' | 'CONFIGURATION_DEPENDENT';
export interface ConsumerImpact { providerId: string; consumer: AdvisorySpan; usage: AdvisorySpan; dependencyPath: string[]; parentDiagnostics: AdvisoryDiagnostic[]; candidateDiagnostics: AdvisoryDiagnostic[]; parentInferredType: string | null; candidateInferredType: string | null; diagnostics: AdvisoryDiagnostic[]; classification: ConsumerImpactClassification; }
export interface AdvisoryTraceStep { kind: 'PROVIDER' | 'IMPORT' | 'RE_EXPORT' | 'CONSUMER' | 'USAGE' | 'DIAGNOSTIC'; file: string; span: AdvisorySpan | null; detail: string; }
export interface AdvisoryImpactTrace { providerId: string; classification: ConsumerImpactClassification; completeness: 'COMPLETE' | 'INCONCLUSIVE'; dependencyPath: string[]; steps: AdvisoryTraceStep[]; diagnostics: AdvisoryDiagnostic[]; }
export interface AdvisoryImpactResult {
  schemaVersion: 'ADVISORY_TS_IMPACT_V1'; certificationStatus: 'ADVISORY_ONLY'; verdict: AdvisoryVerdict;
  parentCommitSha: string; candidateCommitSha: string; compilerVersion: string; compilerOptions: Record<string, unknown>;
  providers: ProviderDeclaration[]; consumers: ConsumerReference[]; impacts: ConsumerImpact[]; traces: AdvisoryImpactTrace[]; completeness: { status: CompletenessStatus; consumersAnalyzed: number; unresolvedDependencyCount: number; unresolvedFiles: string[]; resolutionTraces: string[]; selection?: { parent: SealedSelection | null; candidate: SealedSelection | null; } };
  confidenceRationale: string[]; evidenceReferences: string[];
}

const defaultOptions: ts.CompilerOptions = Object.freeze({ noEmit: true, noLib: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.Preserve });
const options: ts.CompilerOptions = defaultOptions;
const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\/sealed(?:\/|$)/, '').replace(/^\.\//, '');
const extensions = ['.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts'];
const key = (d: AdvisoryDiagnostic) => `${d.code}:${d.span?.file ?? ''}:${d.span?.line ?? ''}:${d.span?.column ?? ''}:${d.message}`;

interface WorkspacePackageInfo { name: string; dir: string; packageJson: Record<string, unknown>; }
interface World { program: ts.Program; checker: ts.TypeChecker; diagnostics: AdvisoryDiagnostic[]; unresolved: string[]; traces: string[]; edges: readonly [string, string][]; files: Record<string, string>; compilerOptions: ts.CompilerOptions; selection?: SealedSelection; }
function point(sf: ts.SourceFile, pos: number): AdvisorySpan { const p = sf.getLineAndCharacterOfPosition(pos); return { file: slash(sf.fileName), line: p.line + 1, column: p.character + 1 }; }
function diagnostic(d: ts.Diagnostic): AdvisoryDiagnostic { return { code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), span: d.file && d.start !== undefined ? point(d.file, d.start) : null }; }

const MINIMAL_LIB_DTS = `
interface Boolean {}
interface Function {}
interface IArguments {}
interface Number { toFixed(digits?: number): string; }
interface Object {}
interface RegExp {}
interface String { readonly length: number; }
interface Array<T> { readonly length: number; [n: number]: T; }
declare var Error: { new(message?: string): any; (message?: string): any; };
declare var Number: { new(value?: any): any; (value?: any): number; isNaN(number: unknown): boolean; };
declare var String: { new(value?: any): any; (value?: any): string; };
declare var Boolean: { new(value?: any): any; (value?: any): boolean; };
declare var console: { log(...data: any[]): void; error(...data: any[]): void; warn(...data: any[]): void; };
`;

/** A compiler host whose only readable files are the supplied sealed record. */
function world(revision: SealedRevision): World {
  const sealed: Record<string, string> = Object.fromEntries(Object.entries(revision.files).map(([f, text]) => [slash(f), text]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (!('__sajimora_lib.d.ts' in sealed)) {
    sealed['__sajimora_lib.d.ts'] = MINIMAL_LIB_DTS;
  }
  const files = Object.fromEntries(Object.entries(sealed).filter(([f]) => /\.tsx?$/.test(f)));
  const unresolved = new Set(revision.selection?.incompleteReasons ?? []); const traces: string[] = []; const edges = new Set<string>(); const root = '/sealed';
  const absolute = (f: string) => `${root}/${slash(f)}`;
  const relative = (f: string) => {
    const s = f.replace(/\\/g, '/');
    if (s === root || s === `${root}/`) return '';
    if (s.startsWith(`${root}/`)) return s.slice(root.length + 1);
    return slash(s);
  };

  // Discover monorepo workspace packages
  const workspacePackages = new Map<string, WorkspacePackageInfo>();
  for (const [filePath, content] of Object.entries(sealed)) {
    if (filePath === 'package.json' || filePath.endsWith('/package.json')) {
      if (!filePath.startsWith('node_modules/') && !filePath.includes('/node_modules/')) {
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
            const pkgDir = filePath === 'package.json' ? '' : filePath.slice(0, -'/package.json'.length);
            workspacePackages.set(parsed.name, { name: parsed.name, dir: pkgDir, packageJson: parsed });
          }
        } catch {}
      }
    }
  }

  // Precompute directory set
  const directorySet = new Set<string>(['']);
  for (const f of Object.keys(sealed)) {
    const parts = f.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      directorySet.add(cur);
    }
  }

  function resolveVirtualPath(rel: string): string {
    if (rel in sealed || directorySet.has(rel)) return rel;
    const nmIndex = rel.lastIndexOf('node_modules/');
    if (nmIndex !== -1) {
      const afterNm = rel.slice(nmIndex + 'node_modules/'.length);
      for (const [pkgName, pkgInfo] of workspacePackages) {
        if (afterNm === pkgName || afterNm.startsWith(`${pkgName}/`)) {
          const sub = afterNm.slice(pkgName.length).replace(/^\//, '');
          const targetRel = pkgInfo.dir ? (sub ? `${pkgInfo.dir}/${sub}` : pkgInfo.dir) : sub;
          if (targetRel in sealed || directorySet.has(targetRel)) return targetRel;
        }
      }
    }
    return rel;
  }

  const allFiles = () => Object.keys(sealed).sort();
  const exists = (f: string) => { const rel = relative(f); return rel in sealed || resolveVirtualPath(rel) in sealed; };
  const read = (f: string) => { const rel = relative(f); return sealed[rel] ?? sealed[resolveVirtualPath(rel)]; };
  const dirExists = (d: string) => { const rel = relative(d); return directorySet.has(rel) || directorySet.has(resolveVirtualPath(rel)); };
  const dirs = (d: string) => {
    const rel = resolveVirtualPath(relative(d));
    const prefix = rel ? `${rel}/` : '';
    const subdirs = new Set<string>();
    for (const dir of directorySet) {
      if (dir && dir.startsWith(prefix) && dir !== rel) {
        const rest = dir.slice(prefix.length);
        const child = rest.split('/')[0];
        if (child) subdirs.add(child);
      }
    }
    if (!rel && workspacePackages.size > 0) subdirs.add('node_modules');
    return [...subdirs].sort();
  };

  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: (rootDir, exts) => allFiles().filter(f => !exts || exts.some(e => f.endsWith(e))).map(f => `${root}/${f}`),
    fileExists: exists,
    readFile: read,
    trace: () => {},
    directoryExists: dirExists,
    getCurrentDirectory: () => root
  };

  let compilerOptions: ts.CompilerOptions = { ...options };
  let rootNames = Object.keys(files).sort().map(absolute);
  const configDiagnostics: AdvisoryDiagnostic[] = [];
  const configPath = revision.tsconfigPath ? slash(revision.tsconfigPath) : ('tsconfig.json' in sealed ? 'tsconfig.json' : undefined);

  if (configPath) {
    const configText = sealed[configPath];
    if (configText === undefined) {
      unresolved.add(`CONFIG -> ${configPath}`);
      traces.push(`CONFIG -> ${configPath}: UNRESOLVED`);
    } else {
      const parsedJson = ts.parseConfigFileTextToJson(configPath, configText);
      if (parsedJson.error) configDiagnostics.push(diagnostic(parsedJson.error));
      else {
        const parsed = ts.parseJsonConfigFileContent(parsedJson.config, parseHost, root, undefined, absolute(configPath));
        compilerOptions = { ...options, ...parsed.options, noEmit: true, noLib: true };
        if (!parsed.options.moduleResolution) {
          if (parsed.options.module === ts.ModuleKind.NodeNext) compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeNext;
          else if (parsed.options.module === ts.ModuleKind.Node16) compilerOptions.moduleResolution = ts.ModuleResolutionKind.Node16;
        }
        const filteredNames = parsed.fileNames.filter(f => /\.tsx?$/.test(f)).map(f => absolute(relative(f)));
        if (filteredNames.length > 0) rootNames = [...new Set(filteredNames)].sort();
        configDiagnostics.push(...parsed.errors.map(diagnostic));
      }
    }
  }

  function resolveWorkspacePackageEntry(pkgInfo: WorkspacePackageInfo, subpath: string): string | undefined {
    const pkgDir = pkgInfo.dir;
    const pkgJson = pkgInfo.packageJson;
    const tryCandidates = (target: string): string | undefined => {
      const normalized = target.replace(/^\.\//, '');
      const full = pkgDir ? `${pkgDir}/${normalized}` : normalized;
      if (full in sealed) return full;
      for (const ext of extensions) if (`${full}${ext}` in sealed) return `${full}${ext}`;
      return undefined;
    };
    if (pkgJson.exports && typeof pkgJson.exports === 'object') {
      const exportsObj = pkgJson.exports as Record<string, unknown>;
      const target = exportsObj[subpath];
      if (typeof target === 'string') {
        const match = tryCandidates(target);
        if (match) return match;
      } else if (target && typeof target === 'object') {
        const cond = target as Record<string, unknown>;
        const cand = (cond.types ?? cond.import ?? cond.default ?? cond.require) as string | undefined;
        if (typeof cand === 'string') {
          const match = tryCandidates(cand);
          if (match) return match;
        }
      }
    }
    if (subpath === '.') {
      const mainFields = [pkgJson.types, pkgJson.typings, pkgJson.module, pkgJson.main];
      for (const field of mainFields) if (typeof field === 'string') { const match = tryCandidates(field); if (match) return match; }
      const match = tryCandidates('./index');
      if (match) return match;
    } else {
      const match = tryCandidates(subpath);
      if (match) return match;
    }
    return undefined;
  }

  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: exists,
    readFile: read,
    directoryExists: dirExists,
    getDirectories: dirs,
    realpath: f => absolute(resolveVirtualPath(relative(f))),
    getCurrentDirectory: () => root
  };

  const cache = ts.createModuleResolutionCache(root, f => f, compilerOptions);

  const resolveModule = (name: string, containing: string): ts.ResolvedModuleFull | undefined => {
    let resolvedResult = ts.resolveModuleName(name, containing, compilerOptions, resolutionHost, cache).resolvedModule;

    if (!resolvedResult && (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs') || name.endsWith('.cjs'))) {
      const withoutExt = name.replace(/\.[mc]?[jt]sx?$/, '');
      for (const altExt of ['.ts', '.tsx', '.d.ts']) {
        const candidateResult = ts.resolveModuleName(withoutExt + altExt, containing, compilerOptions, resolutionHost, cache).resolvedModule;
        if (candidateResult && exists(candidateResult.resolvedFileName)) { resolvedResult = candidateResult; break; }
      }
    }

    if (!resolvedResult) {
      for (const [pkgName, pkgInfo] of workspacePackages) {
        if (name === pkgName || name.startsWith(`${pkgName}/`)) {
          const sub = name === pkgName ? '.' : '.' + name.slice(pkgName.length);
          const resolvedPath = resolveWorkspacePackageEntry(pkgInfo, sub);
          if (resolvedPath && exists(resolvedPath)) {
            const isTsx = resolvedPath.endsWith('.tsx');
            const isDts = resolvedPath.endsWith('.d.ts');
            resolvedResult = {
              resolvedFileName: absolute(resolvedPath),
              isExternalLibraryImport: false,
              extension: isTsx ? ts.Extension.Tsx : isDts ? ts.Extension.Dts : ts.Extension.Ts
            };
            break;
          }
        }
      }
    }

    if (!resolvedResult) {
      for (const [file, content] of Object.entries(sealed)) {
        if (content.includes(`declare module "${name}"`) || content.includes(`declare module '${name}'`)) {
          resolvedResult = {
            resolvedFileName: absolute(file),
            isExternalLibraryImport: false,
            extension: file.endsWith('.d.ts') ? ts.Extension.Dts : file.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts
          };
          break;
        }
      }
    }

    if (resolvedResult && exists(resolvedResult.resolvedFileName)) {
      const target = slash(resolvedResult.resolvedFileName);
      traces.push(`${slash(containing)} -> ${name}: ${target}`);
      edges.add(`${slash(containing)}\0${target}`);
      return resolvedResult;
    }

    unresolved.add(`${slash(containing)} -> ${name}`);
    traces.push(`${slash(containing)} -> ${name}: UNRESOLVED`);
    return undefined;
  };

  const host: ts.CompilerHost = {
    getSourceFile: (f, lang) => { const text = read(f); return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true); },
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => root,
    getDirectories: dirs,
    directoryExists: dirExists,
    fileExists: exists,
    readFile: read,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: f => f,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(n => resolveModule(n, containing))
  };

  const program = ts.createProgram({ rootNames, options: compilerOptions, host });
  const diagnostics = [...configDiagnostics, ...ts.getPreEmitDiagnostics(program).map(diagnostic)].sort((a, b) => { const ka = key(a); const kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  return { program, checker: program.getTypeChecker(), diagnostics, unresolved: [...unresolved].sort(), traces: [...new Set(traces)].sort(), edges: [...edges].sort().map(edge => { const [from, to] = edge.split('\0'); return [from, to]; }), files, compilerOptions, selection: revision.selection };
}
interface ProviderSymbol { declaration: ts.Declaration; declarations: readonly ts.Declaration[]; }
function exportedDeclarations(w: World): Map<string, ProviderSymbol> {
  const out = new Map<string, ProviderSymbol>();
  for (const sf of [...w.program.getSourceFiles()].sort((a,b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))) {
    const relFile = slash(sf.fileName);
    if (sf.isDeclarationFile && !w.files[relFile]) continue;
    const module = w.checker.getSymbolAtLocation(sf);
    if (module) {
      for (const symbol of [...w.checker.getExportsOfModule(module)].sort((a,b) => { const na = a.getName(); const nb = b.getName(); return na < nb ? -1 : na > nb ? 1 : 0; })) {
        const declarations = (symbol.declarations ?? []).filter(d => d.getSourceFile() === sf).sort((a,b) => a.getStart() - b.getStart());
        if (declarations.length) out.set(`${slash(sf.fileName)}#${symbol.getName()}`, { declaration: declarations[0], declarations });
      }
    }
    // Also discover exports inside ambient modules declared in this source file
    for (const statement of sf.statements) {
      if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
        const modName = ts.isStringLiteral(statement.name) ? statement.name.text : statement.name.getText(sf);
        for (const modStmt of statement.body.statements) {
          if (ts.isVariableStatement(modStmt)) {
            for (const decl of modStmt.declarationList.declarations) {
              const name = decl.name.getText(sf);
              out.set(`${slash(sf.fileName)}#${name}`, { declaration: decl, declarations: [decl] });
              out.set(`${modName}#${name}`, { declaration: decl, declarations: [decl] });
            }
          }
        }
      }
    }
    // Alias exports have their declaration in another module; retain the sealed
    // export-site span as this module's provider contract.
    for (const statement of sf.statements) if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const name = element.name.text; const id = `${slash(sf.fileName)}#${name}`;
        if (!out.has(id)) out.set(id, { declaration: element, declarations: [element] });
      }
    }
  } return out;
}
function declarationText(provider: ProviderSymbol | undefined): string | null { return provider ? provider.declarations.map(d => d.getText(d.getSourceFile()).replace(/\s+/g, ' ').trim()).join('\n') : null; }
function signature(provider: ProviderSymbol | undefined): ProviderSignature | null {
  if (!provider) return null; const d = provider.declaration; const named = d as ts.NamedDeclaration;
  const parameters = ts.isFunctionLike(d) ? d.parameters.map(p => ({ name: p.name.getText(), type: p.type?.getText() ?? null, optional: Boolean(p.questionToken || p.initializer) })) : [];
  const returnType = ts.isFunctionLike(d) ? d.type?.getText() ?? null : null;
  const members = ts.isInterfaceDeclaration(d) || ts.isTypeLiteralNode(d) || ts.isClassDeclaration(d) ? d.members.filter(ts.isPropertySignature).map(m => ({ name: m.name.getText(), type: m.type?.getText() ?? null, optional: Boolean(m.questionToken) })).sort((a,b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [];
  return { declarationKind: ts.SyntaxKind[d.kind], parameters, returnType, members, overloadCount: provider.declarations.filter(ts.isFunctionLike).length };
}
function classify(before: ProviderSignature | null, after: ProviderSignature | null): ProviderChangeKind {
  if (!before) return 'EXPORT_ADDED'; if (!after) return 'EXPORT_REMOVED';
  if (before.overloadCount !== after.overloadCount) return 'OVERLOAD_CHANGED';
  if (before.parameters.length > after.parameters.length) return 'PARAMETER_REMOVED';
  if (before.parameters.length < after.parameters.length) return 'PARAMETER_ADDED';
  if (before.returnType !== after.returnType) return 'RETURN_TYPE_CHANGED';
  const afterMembers = new Map(after.members.map(m => [m.name, m]));
  for (const member of before.members) { const now = afterMembers.get(member.name); if (!now) return 'PROPERTY_REMOVED'; if (!member.optional && now.optional) return 'PROPERTY_MADE_OPTIONAL'; }
  return 'DECLARATION_CHANGED';
}
function useSite(n: ts.Node): ts.Node { let x = n; while (x.parent && !ts.isCallExpression(x.parent) && !ts.isPropertyAccessExpression(x.parent) && !ts.isVariableDeclaration(x.parent) && !ts.isBinaryExpression(x.parent) && !ts.isReturnStatement(x.parent)) x = x.parent; return x; }
function referenceKind(node: ts.Identifier): ConsumerReferenceKind {
  const p = node.parent;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return 'IMPORT';
  if (ts.isExportSpecifier(p)) return 'RE_EXPORT';
  if (ts.isCallExpression(p) && p.expression === node) return 'CALL';
  if (ts.isPropertyAccessExpression(p) && p.expression === node) return 'PROPERTY_ACCESS';
  if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) return 'JSX';
  let n: ts.Node | undefined = node;
  while (n?.parent) { const enclosing: ts.Node = n.parent; if (ts.isReturnStatement(enclosing)) return 'RETURN'; if (ts.isVariableDeclaration(enclosing) && enclosing.type) return 'TYPE_ANNOTATION'; if (ts.isBinaryExpression(enclosing) && enclosing.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'ASSIGNMENT'; if (ts.isCallExpression(enclosing) && enclosing.arguments.includes(n as ts.Expression)) return 'ARGUMENT'; n = enclosing; }
  return 'VALUE_REFERENCE';
}
function dependencyPath(edges: readonly [string, string][], provider: string, consumer: string): string[] {
  if (provider === consumer) return [provider]; const reverse = new Map<string, string[]>();
  for (const [from, to] of edges) { const list = reverse.get(to) ?? []; list.push(from); reverse.set(to, list); }
  const queue: string[][] = [[provider]]; const seen = new Set<string>([provider]);
  while (queue.length) { const current = queue.shift()!; const tail = current[current.length - 1]; for (const next of (reverse.get(tail) ?? []).sort()) { if (seen.has(next)) continue; const path = [...current, next]; if (next === consumer) return path; seen.add(next); queue.push(path); } }
  return [provider, consumer];
}
function typeAt(world: World, span: AdvisorySpan): string | null {
  const source = world.program.getSourceFiles().find(sf => slash(sf.fileName) === span.file); if (!source) return null;
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node) => { if (!found && ts.isIdentifier(node)) { const here = point(source, node.getStart()); if (here.line === span.line && here.column === span.column) found = node; } ts.forEachChild(node, visit); };
  visit(source); return found ? world.checker.typeToString(world.checker.getTypeAtLocation(found)) : null;
}
function typeChange(parent: string | null, candidate: string | null): 'WIDENED' | 'NARROWED' | 'UNCHANGED' | 'UNKNOWN' {
  if (parent === candidate) return 'UNCHANGED'; if (!parent || !candidate) return 'UNKNOWN';
  // Conservative textual-union containment: this never claims a relationship that
  // is not explicitly represented by the compiler's normalized type display.
  if (candidate.split(' | ').includes(parent)) return 'WIDENED';
  if (parent.split(' | ').includes(candidate)) return 'NARROWED';
  return 'UNKNOWN';
}
function sameOptions(parent: ts.CompilerOptions, candidate: ts.CompilerOptions): boolean {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k,v]) => [k, normalize(v)])) : value;
  return JSON.stringify(normalize(parent)) === JSON.stringify(normalize(candidate));
}
function makeTrace(provider: ProviderDeclaration, impact: ConsumerImpact, consumers: readonly ConsumerReference[], incomplete: boolean): AdvisoryImpactTrace {
  const steps: AdvisoryTraceStep[] = [{ kind: 'PROVIDER', file: provider.file, span: provider.span, detail: `${provider.name} (${provider.change})` }];
  for (const file of impact.dependencyPath.slice(1)) {
    const hop = consumers.find(c => c.providerId === provider.id && c.consumer.file === file && (c.referenceKind === 'IMPORT' || c.referenceKind === 'RE_EXPORT'));
    steps.push({ kind: hop?.referenceKind === 'RE_EXPORT' ? 'RE_EXPORT' : 'IMPORT', file, span: hop?.consumer ?? null, detail: hop?.referenceKind === 'RE_EXPORT' ? 're-exported provider symbol' : 'imports provider symbol' });
  }
  steps.push({ kind: 'CONSUMER', file: impact.consumer.file, span: impact.consumer, detail: 'resolved consumer reference' });
  steps.push({ kind: 'USAGE', file: impact.usage.file, span: impact.usage, detail: 'consumer usage site' });
  for (const diagnostic of impact.diagnostics) steps.push({ kind: 'DIAGNOSTIC', file: diagnostic.span?.file ?? impact.usage.file, span: diagnostic.span, detail: `TS${diagnostic.code}: ${diagnostic.message}` });
  return { providerId: provider.id, classification: impact.classification, completeness: incomplete ? 'INCONCLUSIVE' : 'COMPLETE', dependencyPath: impact.dependencyPath, steps, diagnostics: impact.diagnostics };
}

export class AdvisoryTypeScriptImpactAnalyzer {
  analyze(input: AdvisoryInput): AdvisoryImpactResult {
    try {
      if (ts.version !== ADVISORY_TYPESCRIPT_VERSION) throw new Error(`Pinned TypeScript ${ADVISORY_TYPESCRIPT_VERSION} required; installed ${ts.version}`);
      const started = performance.now();
      // Each call constructs separate programs and hosts; no compiler object crosses worlds.
      const parent = world(input.parent); const candidate = world(input.candidate);
      const p = exportedDeclarations(parent); const c = exportedDeclarations(candidate); const ids = [...new Set([...p.keys(), ...c.keys()])].sort();
      const requestedTargetId = input.target ? `${slash(input.target.file)}#${input.target.symbol}` : null;
      const providers: ProviderDeclaration[] = ids.filter(id => (!requestedTargetId || id === requestedTargetId) && declarationText(p.get(id)) !== declarationText(c.get(id))).map(id => {
        const before = declarationText(p.get(id)), after = declarationText(c.get(id)); const beforeSignature = signature(p.get(id)), afterSignature = signature(c.get(id)); const d = (c.get(id) ?? p.get(id)!).declaration; const [file, name] = id.split('#');
        return { id, file, name, span: point(d.getSourceFile(), d.getStart()), before, after, beforeSignature, afterSignature, change: classify(beforeSignature, afterSignature), identity: p.has(id) && c.has(id) ? 'CASE_A' : 'CASE_B' };
      });
      const consumers: ConsumerReference[] = []; const impacts: ConsumerImpact[] = [];
      for (const provider of providers) {
        const target = c.get(provider.id)?.declaration;
        if (!target) {
          if (provider.change === 'EXPORT_REMOVED') {
            const [provFile, provName] = provider.id.split('#');
            for (const sf of candidate.program.getSourceFiles().filter(s => !s.isDeclarationFile).sort((a,b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))) {
              const fileSlash = slash(sf.fileName);
              if (fileSlash === provFile) continue;
              const importsProvider = candidate.edges.some(([from, to]) => from === fileSlash && to === provFile) || sf.text.includes(provFile.replace(/\.tsx?$/, ''));
              if (importsProvider) {
                const fileDiags = candidate.diagnostics.filter(d => d.span?.file === fileSlash);
                const parentDiags = parent.diagnostics.filter(d => d.span?.file === fileSlash);
                const parentKeys = new Set(parentDiags.map(key));
                const fresh = fileDiags.filter(d => !parentKeys.has(key(d)));
                const usagePoint = fresh[0]?.span ?? { file: fileSlash, line: 1, column: 1 };
                consumers.push({ providerId: provider.id, consumer: usagePoint, usage: usagePoint, referenceKind: 'IMPORT', directness: 'DIRECT', dependencyPath: [provFile, fileSlash], resolutionStatus: 'COMPLETE' });
                impacts.push({ providerId: provider.id, consumer: usagePoint, usage: usagePoint, dependencyPath: [provFile, fileSlash], parentDiagnostics: parentDiags, candidateDiagnostics: fileDiags, parentInferredType: null, candidateInferredType: null, diagnostics: fresh, classification: 'NEWLY_FAILING' });
              }
            }
          }
          continue;
        }
        const targetDeclarations = c.get(provider.id)?.declarations ?? [target];
        const declarationNames = new Set(targetDeclarations.map(d => (d as any).name).filter(Boolean));
        const rawTargetSymbol = candidate.checker.getSymbolAtLocation((target as any).name ?? target);
        const targetSymbol = rawTargetSymbol && (rawTargetSymbol.flags & ts.SymbolFlags.Alias) ? candidate.checker.getAliasedSymbol(rawTargetSymbol) : rawTargetSymbol;
        if (!targetSymbol) continue;
        for (const sf of candidate.program.getSourceFiles().filter(s => !s.isDeclarationFile).sort((a,b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))) {
          const visit = (n: ts.Node) => { const raw = ts.isIdentifier(n) ? candidate.checker.getSymbolAtLocation(n) : undefined; const symbol = raw && (raw.flags & ts.SymbolFlags.Alias) ? candidate.checker.getAliasedSymbol(raw) : raw; if (ts.isIdentifier(n) && symbol === targetSymbol && !declarationNames.has(n)) {
            const usage = useSite(n); const consumer = point(sf, n.getStart()); const usagePoint = point(sf, usage.getStart());
            const kind = referenceKind(n); const path = dependencyPath(candidate.edges, provider.file, consumer.file);
            consumers.push({ providerId: provider.id, consumer, usage: usagePoint, referenceKind: kind, directness: path.length <= 2 ? 'DIRECT' : 'TRANSITIVE', dependencyPath: path, resolutionStatus: candidate.unresolved.length ? 'INCOMPLETE' : 'COMPLETE' });
            if (kind === 'IMPORT' || kind === 'RE_EXPORT') { ts.forEachChild(n, visit); return; }
            const candidateDiagnostics = candidate.diagnostics.filter(d => d.span?.file === consumer.file && d.span.line === usagePoint.line);
            const parentDiagnostics = parent.diagnostics.filter(d => d.span?.file === consumer.file && d.span.line === usagePoint.line);
            const parentKeys = new Set(parentDiagnostics.map(key)); const fresh = candidateDiagnostics.filter(d => !parentKeys.has(key(d)));
            const parentType = typeAt(parent, consumer); const candidateType = candidate.checker.typeToString(candidate.checker.getTypeAtLocation(n));
            const relation = typeChange(parentType, candidateType);
            const classification: ConsumerImpactClassification = parent.unresolved.length || candidate.unresolved.length ? 'UNRESOLVED' : !sameOptions(parent.compilerOptions, candidate.compilerOptions) ? 'CONFIGURATION_DEPENDENT' : fresh.length ? 'NEWLY_FAILING' : relation === 'WIDENED' ? 'NEWLY_WIDENED_SAFE' : relation === 'NARROWED' ? 'NEWLY_NARROWED' : 'UNAFFECTED';
            impacts.push({ providerId: provider.id, consumer, usage: usagePoint, dependencyPath: path, parentDiagnostics, candidateDiagnostics, parentInferredType: parentType, candidateInferredType: candidateType, diagnostics: fresh, classification });
          } ts.forEachChild(n, visit); }; visit(sf);
        }
      }
      const targetMissing = requestedTargetId !== null && !p.has(requestedTargetId) && !c.has(requestedTargetId);
      const executionBudgetExceeded = (input.resourceLimits?.maxExecutionMs !== undefined && performance.now() - started > input.resourceLimits.maxExecutionMs) || (input.resourceLimits?.maxRssBytes !== undefined && process.memoryUsage().rss > input.resourceLimits.maxRssBytes);

      const targetFiles = new Set<string>();
      if (input.target) targetFiles.add(slash(input.target.file));
      for (const pr of providers) targetFiles.add(slash(pr.file));

      const downstreamFiles = new Set<string>(targetFiles);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [from, to] of [...parent.edges, ...candidate.edges]) {
          if (downstreamFiles.has(to) && !downstreamFiles.has(from)) {
            downstreamFiles.add(from);
            changed = true;
          }
        }
      }

      for (const file of downstreamFiles) {
        if (targetFiles.has(file)) continue;
        const fileDiags = candidate.diagnostics.filter(d => d.span?.file === file);
        const parentDiags = parent.diagnostics.filter(d => d.span?.file === file);
        const parentKeys = new Set(parentDiags.map(key));
        const fresh = fileDiags.filter(d => !parentKeys.has(key(d)));
        if (fresh.length > 0 && !impacts.some(i => i.consumer.file === file)) {
          const usagePoint = fresh[0]?.span ?? { file, line: 1, column: 1 };
          const provId = providers[0]?.id ?? (input.target ? `${slash(input.target.file)}#${input.target.symbol}` : `${file}#unknown`);
          consumers.push({ providerId: provId, consumer: usagePoint, usage: usagePoint, referenceKind: 'IMPORT', directness: 'DIRECT', dependencyPath: [slash(providers[0]?.file ?? input.target?.file ?? file), file], resolutionStatus: 'COMPLETE' });
          impacts.push({ providerId: provId, consumer: usagePoint, usage: usagePoint, dependencyPath: [slash(providers[0]?.file ?? input.target?.file ?? file), file], parentDiagnostics: parentDiags, candidateDiagnostics: fileDiags, parentInferredType: null, candidateInferredType: null, diagnostics: fresh, classification: 'NEWLY_FAILING' });
        }
      }

      const corruptParent = parent.diagnostics.some(d => d.span !== null && d.code !== 2318 && (downstreamFiles.has(d.span.file) || impacts.some(i => i.consumer.file === d.span?.file)));
      const hasRemovedExportWithoutImpacts = providers.some(p => p.change === 'EXPORT_REMOVED') && impacts.length === 0;
      const incomplete = executionBudgetExceeded || targetMissing || parent.unresolved.length > 0 || candidate.unresolved.length > 0 || corruptParent || hasRemovedExportWithoutImpacts || impacts.some(i => i.classification === 'UNRESOLVED' || i.classification === 'CONFIGURATION_DEPENDENT');
      const verdict: AdvisoryVerdict = incomplete ? 'INCONCLUSIVE' : impacts.some(i => i.classification === 'NEWLY_FAILING') ? 'LIKELY_VIOLATED' : 'LIKELY_PRESERVED';
      const uniqueConsumers = [...new Map(consumers.map(c => [JSON.stringify(c), c])).values()].sort((a,b) => { const ja = JSON.stringify(a); const jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0; });
      const orderedImpacts = impacts.sort((a,b) => { const ja = JSON.stringify(a); const jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0; });
      const traces = orderedImpacts.map(impact => makeTrace(providers.find(provider => provider.id === impact.providerId)!, impact, uniqueConsumers, incomplete)).sort((a,b) => { const ja = JSON.stringify(a); const jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0; });
      const unresolvedFiles = [...new Set([...parent.unresolved, ...candidate.unresolved, ...(targetMissing ? [`TARGET -> ${requestedTargetId}`] : []), ...(executionBudgetExceeded ? ['BUDGET -> EXECUTION_OR_RSS'] : [])])].sort();
      return { schemaVersion: 'ADVISORY_TS_IMPACT_V1', certificationStatus: 'ADVISORY_ONLY', verdict, parentCommitSha: input.parent.commitSha, candidateCommitSha: input.candidate.commitSha, compilerVersion: ts.version, compilerOptions: { ...candidate.compilerOptions }, providers, consumers: uniqueConsumers, impacts: orderedImpacts, traces, completeness: { status: incomplete ? 'INCOMPLETE' : 'COMPLETE', consumersAnalyzed: uniqueConsumers.length, unresolvedDependencyCount: unresolvedFiles.length, unresolvedFiles, resolutionTraces: [...new Set([...parent.traces, ...candidate.traces])].sort(), selection: { parent: parent.selection ?? null, candidate: candidate.selection ?? null } }, confidenceRationale: incomplete ? ['Module resolution or resource budget is incomplete; result cannot be treated as preserved.'] : ['Independent sealed parent/candidate compiler diagnostics were compared.'], evidenceReferences: providers.map(x => x.id) };
    } catch (error) { return { schemaVersion: 'ADVISORY_TS_IMPACT_V1', certificationStatus: 'ADVISORY_ONLY', verdict: 'ANALYSIS_ERROR', parentCommitSha: input.parent.commitSha, candidateCommitSha: input.candidate.commitSha, compilerVersion: ts.version, compilerOptions: { ...options }, providers: [], consumers: [], impacts: [], traces: [], completeness: { status: 'INCOMPLETE', consumersAnalyzed: 0, unresolvedDependencyCount: 0, unresolvedFiles: [], resolutionTraces: [], selection: { parent: input.parent.selection ?? null, candidate: input.candidate.selection ?? null } }, confidenceRationale: [error instanceof Error ? error.message : String(error)], evidenceReferences: [] }; }
  }
}
