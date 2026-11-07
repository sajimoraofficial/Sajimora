import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import ts from 'typescript';

export interface CaseBTargetSelection {
  declarationKind: string;
  ownerChain: string[];
  declarationOrdinal: number;
  exported: boolean;
}

export interface PreparedCaseBInput {
  target?: CaseBTargetSelection;
  /** Present only when both sealed revisions prove the same direct named import. */
  consumerFile?: string;
}

const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx'];

function readBlob(repoPath: string, sha: string, file: string): string | undefined {
  try {
    return childProcess.execFileSync('git', ['-C', repoPath, 'show', `${sha}:${file}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024
    });
  } catch { return undefined; }
}

function kindAndName(node: ts.Node): { kind: string; name: string; owner: boolean } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return { kind: 'FunctionDeclaration', name: node.name.text, owner: false };
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return { kind: 'MethodDeclaration', name: node.name.text, owner: false };
  if (ts.isConstructorDeclaration(node)) return { kind: 'Constructor', name: 'constructor', owner: false };
  if (ts.isClassDeclaration(node) && node.name) return { kind: 'ClassDeclaration', name: node.name.text, owner: true };
  if (ts.isInterfaceDeclaration(node) && node.name) return { kind: 'InterfaceDeclaration', name: node.name.text, owner: true };
  if (ts.isTypeAliasDeclaration(node) && node.name) return { kind: 'TypeAliasDeclaration', name: node.name.text, owner: false };
  if (ts.isEnumDeclaration(node) && node.name) return { kind: 'EnumDeclaration', name: node.name.text, owner: false };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
    return { kind: 'VariableDeclaration', name: node.name.text, owner: false };
  }
  return undefined;
}

/** Mirrors CertifiedCorrespondence's sealed declaration indexing; it does not infer identity. */
export function selectTargetDeclaration(file: string, text: string, targetSymbol: string): CaseBTargetSelection | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length) return undefined;
  const ordinals = new Map<string, number>();
  let selected: CaseBTargetSelection | undefined;
  const visit = (node: ts.Node, owners: string[]) => {
    const record = kindAndName(node);
    const nextOwners = record?.owner ? [...owners, record.name] : owners;
    if (record) {
      const key = `${owners.join('.')}:${record.kind}:${record.name}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const exported = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ??
        (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) &&
          !!node.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      if (record.name === targetSymbol && !selected) selected = {
        declarationKind: record.kind, ownerChain: owners, declarationOrdinal: ordinal, exported
      };
    }
    // Match CertifiedCorrespondence: function-like declarations do not contribute nested declarations.
    if (!['FunctionDeclaration', 'MethodDeclaration', 'Constructor'].includes(record?.kind ?? '')) ts.forEachChild(node, child => visit(child, nextOwners));
  };
  visit(source, []);
  return selected;
}

export function resolveRelativeImport(fromFile: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates: string[] = [base];

  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (!base.endsWith('.ts') && !base.endsWith('.tsx')) {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}/index.ts`,
      `${base}/index.tsx`
    );
  }

  return candidates.find(candidate => files.has(candidate));
}

export function normalizeGrepFilePath(line: string, sha?: string): string {
  if (sha && line.startsWith(`${sha}:`)) {
    return line.slice(sha.length + 1);
  }
  return line.replace(/^[0-9a-fA-F]+:/, '');
}

function namedImportConsumers(repoPath: string, sha: string, targetFile: string, targetSymbol: string): Set<string> {
  const files = childProcess.execFileSync('git', ['-C', repoPath, 'ls-tree', '-r', '--name-only', sha],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(file => sourceExtensions.some(ext => file.endsWith(ext)));

  let mentions: string[];
  try {
    // Narrow the sealed-tree parse set before reading blobs. git grep is exact repository evidence,
    // not an identity heuristic: TypeScript parsing below still validates the import relation.
    mentions = childProcess.execFileSync('git', ['-C', repoPath, 'grep', '-l', '-F', targetSymbol, sha, '--'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => normalizeGrepFilePath(line, sha));
  } catch (error: any) {
    // git grep exits with status 1 when zero matches are found, which represents an empty mention set.
    // Status !== 1 or missing status indicates an actual git failure.
    if (error && typeof error === 'object' && error.status === 1) {
      mentions = [];
    } else {
      throw error;
    }
  }

  const fileSet = new Set(files), consumers = new Set<string>();
  for (const file of mentions) {
    if (!fileSet.has(file) || file === targetFile) continue;
    const text = readBlob(repoPath, sha, file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    source.forEachChild(node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) ||
          resolveRelativeImport(file, node.moduleSpecifier.text, fileSet) !== targetFile) return;
      const bindings = node.importClause?.namedBindings;
      // Corpus scope is deliberately narrower than the evaluator: direct, non-aliased
      // named ESM imports only. Aliases and namespace imports are reserved for later families.
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(e =>
        !e.propertyName && e.name.text === targetSymbol)) consumers.add(file);
    });
  }
  return consumers;
}

/**
 * Produces only sealed, revision-paired campaign inputs. Missing evidence is represented by omission.
 */
export function prepareCaseBInput(repoPath: string, parentSha: string, candidateSha: string,
  targetFile: string, targetSymbol: string): PreparedCaseBInput {
  const parentText = readBlob(repoPath, parentSha, targetFile);
  const candidateText = readBlob(repoPath, candidateSha, targetFile);
  if (parentText === undefined || candidateText === undefined) return {};
  const target = selectTargetDeclaration(targetFile, parentText, targetSymbol);
  if (!target) return {};
  const candidate = selectTargetDeclaration(targetFile, candidateText, targetSymbol);
  if (!candidate) return { target };
  // A direct named import is evidence only when the exported declaration and selected declaration shape persist.
  if (!target.exported || !candidate.exported || target.declarationKind !== candidate.declarationKind ||
      target.declarationOrdinal !== candidate.declarationOrdinal || target.ownerChain.join('\0') !== candidate.ownerChain.join('\0')) return { target };
  let parentConsumers: Set<string>;
  let candidateConsumers: Set<string>;
  try {
    parentConsumers = namedImportConsumers(repoPath, parentSha, targetFile, targetSymbol);
    candidateConsumers = namedImportConsumers(repoPath, candidateSha, targetFile, targetSymbol);
  } catch {
    // Missing or failed git revision evidence is represented by omission, never by claiming zero consumers
    return {};
  }
  const consumerFile = [...parentConsumers].filter(file => candidateConsumers.has(file)).sort()[0];
  return { target, consumerFile };
}
