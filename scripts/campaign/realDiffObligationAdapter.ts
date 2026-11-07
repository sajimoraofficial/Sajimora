import { execFileSync } from 'child_process';
import * as path from 'path';
import * as ts from 'typescript';
import { ProofObligation, SymbolKind, SymbolRef } from '@sajimora/core';
import { ContractSignature } from '@sajimora/core';

export type ObligationDerivation =
  | { status: 'DERIVED'; changedFiles: string[]; actualDiff: string; obligations: ProofObligation[] }
  | { status: 'OBLIGATION_DERIVATION_UNCERTAIN'; changedFiles: string[]; actualDiff: string; reason: string };

type Declaration = {
  name: string; kind: SymbolKind; file: string; line: number; text: string; contract: ContractSignature;
};

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sourceAt(root: string, revision: string, file: string): string | undefined {
  try { return git(root, ['show', `${revision}:${file}`]); } catch { return undefined; }
}

function contract(node: ts.SignatureDeclarationBase): ContractSignature {
  return {
    parameters: node.parameters.map(parameter => ({
      name: parameter.name.getText(),
      type: parameter.type?.getText() ?? 'unknown',
      isRequired: !parameter.questionToken && !parameter.initializer
    })),
    returnType: node.type?.getText()
  };
}

function declarations(file: string, text: string | undefined): Declaration[] {
  if (text === undefined) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result: Declaration[] = [];
  const add = (name: ts.Identifier | undefined, kind: SymbolKind, node: ts.Declaration, signature?: ts.SignatureDeclarationBase) => {
    if (!name) return;
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    result.push({ name: name.text, kind, file, line: pos.line + 1, text: node.getText(source), contract: signature ? contract(signature) : {} });
  };
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node)) add(node.name, 'FUNCTION', node, node);
    else if (ts.isClassDeclaration(node)) {
      add(node.name, 'CLASS', node);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) add(member.name, 'METHOD', member, member);
        else if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) add(member.name, 'METHOD', member, member);
        else if (ts.isSetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) add(member.name, 'METHOD', member, member);
      }
    }
    else if (ts.isInterfaceDeclaration(node)) add(node.name, 'INTERFACE', node);
    else if (ts.isTypeAliasDeclaration(node)) add(node.name, 'TYPE_ALIAS', node);
    else if (ts.isEnumDeclaration(node)) add(node.name, 'ENUM', node);
    else if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) add(declaration.name, 'FIELD', declaration);
    }
  }
  return result;
}

function key(declaration: Declaration): string { return `${declaration.file}::${declaration.kind}::${declaration.name}`; }

function makeObligation(repositoryRoot: string, before: Declaration, after: Declaration | undefined): ProofObligation {
  const current = after ?? before;
  const absoluteFile = path.resolve(repositoryRoot, current.file).replace(/\\/g, '/');
  const persistentSymbolId = `${absoluteFile}::${current.kind}::${current.name}`;
  const symbol: SymbolRef = {
    persistentSymbolId,
    symbolId: current.name,
    fingerprint: {
      value: `${persistentSymbolId}:${current.contract.parameters?.map(p => p.type).join(',') ?? ''}`,
      components: { globallyQualifiedOwner: absoluteFile, symbolLocalName: current.name, kind: current.kind, parameterTypeFingerprint: current.contract.parameters?.map(p => p.type).join(',') ?? '' }
    },
    qualifiedName: current.name,
    kind: current.kind,
    ownerId: null,
    declarationLocation: { filePath: absoluteFile, line: current.line }
  };
  const classification = !after ? 'SYMBOL_DELETED' : (current.kind === 'INTERFACE' || current.kind === 'TYPE_ALIAS' ? 'TYPE_DEF_MUTATED' : 'EXPORTED_SIGNATURE_MUTATED');
  return {
    invariantId: `DIFF:${persistentSymbolId}`,
    relation: 'STRUCTURAL_CO_EVOLUTION',
    mutatedSymbol: symbol,
    providerMutation: {
      targetSymbolId: persistentSymbolId, beforeExists: true, afterExists: Boolean(after), classification,
      isAstDiffDerived: true, beforeParsed: true, afterParsed: Boolean(after)
    },
    providerContracts: { before: before.contract, after: after?.contract ?? {} }
  };
}

/** Derives only unambiguous changed top-level declarations from real git blobs. */
export function deriveRealDiffObligations(repositoryRoot: string, parentSha: string, candidateSha: string, analysisRoot = repositoryRoot): ObligationDerivation {
  let files: string[];
  let actualDiff: string;
  try {
    files = git(repositoryRoot, ['diff', '--name-only', parentSha, candidateSha]).split(/\r?\n/).filter(Boolean);
    actualDiff = git(repositoryRoot, ['diff', '--no-ext-diff', '--unified=0', parentSha, candidateSha]);
  } catch (error) {
    return { status: 'OBLIGATION_DERIVATION_UNCERTAIN', changedFiles: [], actualDiff: '', reason: error instanceof Error ? error.message : String(error) };
  }
  const sourceFiles = files.filter(file => /\.(?:ts|tsx|js|jsx)$/.test(file));
  const before = sourceFiles.flatMap(file => declarations(file, sourceAt(repositoryRoot, parentSha, file)));
  const after = sourceFiles.flatMap(file => declarations(file, sourceAt(repositoryRoot, candidateSha, file)));
  const beforeByKey = new Map(before.map(item => [key(item), item]));
  const afterByKey = new Map(after.map(item => [key(item), item]));
  const obligations: ProofObligation[] = [];
  for (const [declarationKey, oldDeclaration] of beforeByKey) {
    const newDeclaration = afterByKey.get(declarationKey);
    if (!newDeclaration || oldDeclaration.text !== newDeclaration.text) obligations.push(makeObligation(analysisRoot, oldDeclaration, newDeclaration));
  }
  if (obligations.length === 0) return { status: 'OBLIGATION_DERIVATION_UNCERTAIN', changedFiles: files, actualDiff, reason: 'No changed top-level declaration could be derived unambiguously from the diff.' };
  return { status: 'DERIVED', changedFiles: files, actualDiff, obligations };
}
